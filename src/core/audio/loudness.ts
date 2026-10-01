/**
 * 响度与峰值分析（ITU-R BS.1770-4 / EBU R128）。
 *
 * 与 Web Audio 的 `AudioBuffer` 无关，纯样本运算，可在任意线程或离线环境复用。
 * 精度取舍：True Peak 只对「接近全局峰值」的分块做 4 倍过采样，
 * 既满足工程精度（差值通常 < 0.3 dB），又避免整段 128 抽头乘加带来的卡顿。
 */

import { buildInterpolationKernel, kernelPhaseOffset } from './kernel'
import { samplePeak, type AudioPcm } from './pcm'

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** BS.1770 的 K 加权：高架滤波 + RLB 高通，系数按采样率推导 */
function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533
  let q = 0.7071752369554196
  let k = Math.tan((Math.PI * f0) / sampleRate)
  const vh = Math.pow(10, 3.999843853973347 / 20)
  const vb = Math.pow(vh, 0.4996667741545416)
  const denominator = 1 + k / q + k * k
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / denominator,
    b1: (2 * (k * k - vh)) / denominator,
    b2: (vh - (vb * k) / q + k * k) / denominator,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  }

  f0 = 38.13547087602444
  q = 0.5003270373238773
  k = Math.tan((Math.PI * f0) / sampleRate)
  const hpDenominator = 1 + k / q + k * k
  const highpass: Biquad = {
    b0: 1 / hpDenominator,
    b1: -2 / hpDenominator,
    b2: 1 / hpDenominator,
    a1: (2 * (k * k - 1)) / hpDenominator,
    a2: (1 - k / q + k * k) / hpDenominator,
  }
  return [shelf, highpass]
}

function applyBiquad(input: Float32Array, filter: Biquad): Float32Array {
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]
    const y0 = filter.b0 * x0 + filter.b1 * x1 + filter.b2 * x2 - filter.a1 * y1 - filter.a2 * y2
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    out[i] = y0
  }
  return out
}

/** 声道权重：前两个声道按 1，其余（中置/环绕）按 BS.1770 取 1.41 */
function channelWeight(index: number): number {
  return index < 2 ? 1 : 1.41
}

export interface LoudnessResult {
  /** 积分响度（LUFS）；无法测量时为 -Infinity */
  integratedLufs: number
  /** 采样峰值 dBFS */
  samplePeakDb: number
  /** 真峰值 dBTP（4 倍过采样） */
  truePeakDb: number
}

export function analyzeLoudness(pcm: AudioPcm): LoudnessResult {
  return {
    integratedLufs: integratedLoudness(pcm),
    samplePeakDb: toDb(samplePeak(pcm)),
    truePeakDb: truePeakDb(pcm),
  }
}

function toDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY
}

/** 积分响度（含 -70 LUFS 绝对门限与 -10 LU 相对门限） */
export function integratedLoudness(pcm: AudioPcm): number {
  if (pcm.length === 0 || pcm.sampleRate <= 0) return Number.NEGATIVE_INFINITY
  const [shelf, highpass] = kWeightingFilters(pcm.sampleRate)
  const weighted = pcm.channels.map((channel) => applyBiquad(applyBiquad(channel, shelf), highpass))

  const blockSize = Math.max(1, Math.round(0.4 * pcm.sampleRate))
  const step = Math.max(1, Math.round(0.1 * pcm.sampleRate))
  const blocks: number[] = []
  for (let start = 0; start + blockSize <= pcm.length; start += step) {
    blocks.push(blockMeanSquare(weighted, start, blockSize))
  }
  // 比 400ms 还短的素材退化为单块，避免返回 -Infinity
  if (blocks.length === 0) blocks.push(blockMeanSquare(weighted, 0, pcm.length))

  const loudnessOf = (z: number): number => (z > 0 ? -0.691 + 10 * Math.log10(z) : Number.NEGATIVE_INFINITY)

  const gatePass = (threshold: number): number[] =>
    blocks.filter((z) => loudnessOf(z) > threshold)

  const absoluteGated = gatePass(-70)
  if (absoluteGated.length === 0) return Number.NEGATIVE_INFINITY

  const absoluteMean = mean(absoluteGated)
  const relativeThreshold = loudnessOf(absoluteMean) - 10
  const relativeGated = absoluteGated.filter((z) => loudnessOf(z) > relativeThreshold)
  const finalSet = relativeGated.length > 0 ? relativeGated : absoluteGated
  return loudnessOf(mean(finalSet))
}

function blockMeanSquare(channels: Float32Array[], start: number, size: number): number {
  let sum = 0
  for (let c = 0; c < channels.length; c++) {
    const data = channels[c]
    const end = Math.min(data.length, start + size)
    let acc = 0
    for (let i = start; i < end; i++) acc += data[i] * data[i]
    const count = end - start
    if (count > 0) sum += channelWeight(c) * (acc / count)
  }
  return sum
}

function mean(values: number[]): number {
  let sum = 0
  for (const value of values) sum += value
  return values.length > 0 ? sum / values.length : 0
}

const OVERSAMPLE_PHASES = 4
const OVERSAMPLE_TAPS = 24
/** 只对峰值高于全局峰值此倍数的分块做过采样 */
const REFINE_RATIO = 0.35
const BLOCK = 2048

/** 真峰值：对高幅值分块做 4 倍过采样后取最大绝对值 */
export function truePeakDb(pcm: AudioPcm): number {
  if (pcm.length === 0) return Number.NEGATIVE_INFINITY
  const peak = samplePeak(pcm)
  if (peak === 0) return Number.NEGATIVE_INFINITY

  const threshold = peak * REFINE_RATIO
  const kernel = buildInterpolationKernel(OVERSAMPLE_PHASES, OVERSAMPLE_TAPS, 1)
  const half = OVERSAMPLE_TAPS / 2
  // 分块边界的抽头需要上下文样本，向外扩张 half 个样本
  const pad = half
  let result = peak

  for (let blockStart = 0; blockStart < pcm.length; blockStart += BLOCK) {
    const blockEnd = Math.min(pcm.length, blockStart + BLOCK)
    let blockPeak = 0
    for (const channel of pcm.channels) {
      for (let i = blockStart; i < blockEnd; i++) {
        const value = Math.abs(channel[i])
        if (value > blockPeak) blockPeak = value
      }
    }
    if (blockPeak < threshold) continue

    const from = Math.max(0, blockStart - pad)
    const to = Math.min(pcm.length, blockEnd + pad)
    for (const channel of pcm.channels) {
      for (let i = from; i < to; i++) {
        for (let phase = 1; phase < OVERSAMPLE_PHASES; phase++) {
          const frac = phase / OVERSAMPLE_PHASES
          const offset = kernelPhaseOffset(OVERSAMPLE_PHASES, OVERSAMPLE_TAPS, frac)
          const base = i - half + 1
          let acc = 0
          for (let t = 0; t < OVERSAMPLE_TAPS; t++) {
            const index = base + t
            if (index >= 0 && index < channel.length) acc += channel[index] * kernel[offset + t]
          }
          const value = Math.abs(acc)
          if (value > result) result = value
        }
      }
    }
  }
  return toDb(result)
}

/** 供界面展示的 LUFS 文本；-Infinity 显示为占位符 */
export function formatLufs(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)} LUFS` : '—'
}

/** 供界面展示的 dB 文本 */
export function formatDb(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)} dB` : '—'
}
