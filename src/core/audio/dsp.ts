/**
 * 音频 DSP 全为纯样本运算，不依赖 AudioContext。
 *
 * 这样做的收益：处理结果可复现、可离线测试，且不会因为上下文采样率把素材隐式重采样。
 * 重采样与变速共用同一套窗函数 sinc 插值核（见 kernel.ts）。
 */

import { buildInterpolationKernel, kernelPhaseOffset } from './kernel'
import {
  createPcm,
  dbToGain,
  gainToDb,
  slicePcm,
  slicePcmByIndex,
  type AudioPcm,
} from './pcm'

/** 重采样相位与抽头数：128 相位足以让 1 秒内的插值误差落在噪声底之下 */
const RESAMPLE_PHASES = 128
const RESAMPLE_TAPS = 32
/** 长音频每处理这么多输出样本让出一次主线程，避免界面假死 */
const YIELD_CHUNK = 262144

export interface ProcessContext {
  onProgress?: (value: number) => void
  isCancelled?: () => boolean
}

export class CancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CancelledError'
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function checkpoint(ctx: ProcessContext | undefined): Promise<void> {
  if (ctx?.isCancelled?.()) throw new CancelledError()
  await yieldToEventLoop()
}

export function resamplePcm(pcm: AudioPcm, targetRate: number, ctx?: ProcessContext): Promise<AudioPcm> {
  if (targetRate === pcm.sampleRate || pcm.length === 0) return Promise.resolve(pcm)
  return resampleCore(pcm, targetRate / pcm.sampleRate, targetRate, ctx)
}

/**
 * 变速：改变时长与音高（磁带式联动），采样率保持不变。
 * factor > 1 更快更短，< 1 更慢更长。
 */
export function stretchPcm(pcm: AudioPcm, factor: number, ctx?: ProcessContext): Promise<AudioPcm> {
  if (factor === 1 || pcm.length === 0 || factor <= 0) return Promise.resolve(pcm)
  return resampleCore(pcm, 1 / factor, pcm.sampleRate, ctx)
}

async function resampleCore(
  pcm: AudioPcm,
  ratio: number,
  outRate: number,
  ctx?: ProcessContext,
): Promise<AudioPcm> {
  // 降采样时把截止频率压到目标 Nyquist，避免镜像频率折返成混叠
  const cutoff = Math.min(1, ratio)
  const kernel = buildInterpolationKernel(RESAMPLE_PHASES, RESAMPLE_TAPS, cutoff)
  const half = RESAMPLE_TAPS / 2
  const outLength = Math.max(1, Math.round(pcm.length * ratio))
  const out = createPcm(outRate, pcm.channels.length, outLength)

  for (let c = 0; c < pcm.channels.length; c++) {
    const src = pcm.channels[c]
    const dst = out.channels[c]
    for (let i = 0; i < outLength; i++) {
      const position = i / ratio
      const base = Math.floor(position)
      const offset = kernelPhaseOffset(RESAMPLE_PHASES, RESAMPLE_TAPS, position - base)
      const start = base - half + 1
      let acc = 0
      for (let t = 0; t < RESAMPLE_TAPS; t++) {
        const index = start + t
        if (index >= 0 && index < src.length) acc += src[index] * kernel[offset + t]
      }
      dst[i] = acc
      if ((i + 1) % YIELD_CHUNK === 0) {
        ctx?.onProgress?.((i + 1) / outLength)
        await checkpoint(ctx)
      }
    }
  }
  ctx?.onProgress?.(1)
  return out
}

/**
 * 声道转换。
 * 降混单声道按各声道等权平均；升为立体声时单声道复制到两个声道，多声道只取前两条。
 */
export function convertChannels(pcm: AudioPcm, target: 1 | 2): AudioPcm {
  if (pcm.channels.length === target) return pcm
  const out = createPcm(pcm.sampleRate, target, pcm.length)
  if (target === 1) {
    if (pcm.channels.length === 1) return pcm
    const count = pcm.channels.length
    const dst = out.channels[0]
    for (let i = 0; i < pcm.length; i++) {
      let sum = 0
      for (let c = 0; c < count; c++) sum += pcm.channels[c][i]
      dst[i] = sum / count
    }
    return out
  }
  out.channels[0].set(pcm.channels[0])
  out.channels[1].set(pcm.channels.length > 1 ? pcm.channels[1] : pcm.channels[0])
  return out
}

/** 线性淡入淡出；两段重叠时按比例压缩，避免叠加增益 */
export function fadePcm(pcm: AudioPcm, fadeInSec: number, fadeOutSec: number): AudioPcm {
  if (pcm.length === 0) return pcm
  const inSamples = Math.max(0, Math.round(fadeInSec * pcm.sampleRate))
  const outSamples = Math.max(0, Math.round(fadeOutSec * pcm.sampleRate))
  if (inSamples === 0 && outSamples === 0) return pcm
  const scale = inSamples + outSamples > pcm.length && inSamples + outSamples > 0
    ? pcm.length / (inSamples + outSamples)
    : 1
  const fadeIn = Math.round(inSamples * scale)
  const fadeOut = Math.round(outSamples * scale)

  const out = createPcm(pcm.sampleRate, pcm.channels.length, pcm.length)
  for (let c = 0; c < pcm.channels.length; c++) {
    const src = pcm.channels[c]
    const dst = out.channels[c]
    dst.set(src)
    for (let i = 0; i < fadeIn && i < pcm.length; i++) dst[i] *= i / fadeIn
    for (let i = 0; i < fadeOut && i < pcm.length; i++) {
      dst[pcm.length - 1 - i] *= i / fadeOut
    }
  }
  return out
}

export interface ConcatOptions {
  /** 段与段之间插入的静音间隔（秒） */
  gapSec?: number
  /** 每段首尾的淡入淡出（秒），用于消除拼接处的爆音 */
  fadeSec?: number
  ctx?: ProcessContext
}

/**
 * 首尾拼接多条音频为一条。
 *
 * 以第一段的采样率与声道数为基准，其余段先重采样 / 转声道再拼接，
 * 因此不会出现「采样率不一致导致后半段变速变调」的问题。
 * 拼接不是混音：各段在时间轴上依次排列，不做叠加。
 */
export async function concatPcm(segments: AudioPcm[], options: ConcatOptions = {}): Promise<AudioPcm> {
  const ctx = options.ctx
  const parts = segments.filter((item) => item.length > 0)
  if (parts.length === 0) return createPcm(44100, 1, 0)

  const rate = parts[0].sampleRate
  const targetChannels: 1 | 2 = parts[0].channels.length >= 2 ? 2 : 1
  const gapSamples = Math.round(Math.max(0, options.gapSec ?? 0) * rate)
  const fadeSec = Math.max(0, options.fadeSec ?? 0)

  const prepared: AudioPcm[] = []
  for (const part of parts) {
    let current = part
    if (current.sampleRate !== rate) current = await resamplePcm(current, rate, ctx)
    if (current.channels.length !== targetChannels) current = convertChannels(current, targetChannels)
    if (fadeSec > 0) current = fadePcm(current, fadeSec, fadeSec)
    prepared.push(current)
    await checkpoint(ctx)
  }

  const total = prepared.reduce((sum, item) => sum + item.length, 0) + gapSamples * (prepared.length - 1)
  const out = createPcm(rate, targetChannels, total)
  let cursor = 0
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i]
    for (let c = 0; c < targetChannels; c++) out.channels[c].set(item.channels[c], cursor)
    cursor += item.length + (i < prepared.length - 1 ? gapSamples : 0)
    ctx?.onProgress?.((i + 1) / prepared.length)
    await checkpoint(ctx)
  }
  return out
}

export interface TrimSilenceOptions {
  /** 静音判定阈值（dBFS），低于该值的帧视为静音 */
  thresholdDb: number
  /** 头部保留余量（秒） */
  headSec: number
  /** 尾部保留余量（秒） */
  tailSec: number
}

/** 裁掉首尾静音，可按需保留一段余量；整段静音时原样返回，避免裁剪成 0 长度 */
export function trimSilence(pcm: AudioPcm, options: TrimSilenceOptions): AudioPcm {
  if (pcm.length === 0) return pcm
  const threshold = dbToGain(options.thresholdDb)
  let first = -1
  let last = -1
  for (let i = 0; i < pcm.length; i++) {
    let peak = 0
    for (const channel of pcm.channels) {
      const value = Math.abs(channel[i])
      if (value > peak) peak = value
    }
    if (peak > threshold) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0) return pcm

  const head = Math.round(options.headSec * pcm.sampleRate)
  const tail = Math.round(options.tailSec * pcm.sampleRate)
  return slicePcmByIndex(pcm, Math.max(0, first - head), Math.min(pcm.length, last + 1 + tail))
}

/** 按时间区间裁剪；起止顺序颠倒时自动交换 */
export function cropPcm(pcm: AudioPcm, startSec: number, endSec: number): AudioPcm {
  return slicePcm(pcm, startSec, endSec)
}

/**
 * 前视限幅器。
 *
 * 先求每个样本跨声道的「达标所需增益」，再取其前视窗最小值（保证窗内任何一点都不会过冲），
 * 最后按释放时间做单极点平滑：增益可瞬降、缓升，因此不会引入削波。
 */
export function limiterPcm(pcm: AudioPcm, ceilingDb: number, releaseMs = 80, lookaheadMs = 5): AudioPcm {
  if (pcm.length === 0) return pcm
  const ceiling = dbToGain(ceilingDb)
  if (ceiling <= 0) return pcm

  const required = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    let peak = 0
    for (const channel of pcm.channels) {
      const value = Math.abs(channel[i])
      if (value > peak) peak = value
    }
    required[i] = peak > ceiling ? ceiling / peak : 1
  }

  const window = Math.max(1, Math.round((lookaheadMs / 1000) * pcm.sampleRate))
  const smoothed = slidingMinimum(required, window)

  const releaseSamples = Math.max(1, Math.round((releaseMs / 1000) * pcm.sampleRate))
  const coefficient = 1 - Math.exp(-1 / releaseSamples)
  let current = 1
  for (let i = 0; i < smoothed.length; i++) {
    const target = smoothed[i]
    current = target < current ? target : Math.min(target, current + (1 - current) * coefficient)
    smoothed[i] = current
  }

  const out = createPcm(pcm.sampleRate, pcm.channels.length, pcm.length)
  for (let c = 0; c < pcm.channels.length; c++) {
    const src = pcm.channels[c]
    const dst = out.channels[c]
    for (let i = 0; i < src.length; i++) dst[i] = src[i] * smoothed[i]
  }
  return out
}

/** 滑动窗口最小值（单调队列，O(n)） */
function slidingMinimum(values: Float32Array, window: number): Float32Array {
  const out = new Float32Array(values.length)
  const deque = new Int32Array(values.length)
  let head = 0
  let tail = 0
  for (let i = 0; i < values.length; i++) {
    while (tail > head && values[deque[tail - 1]] >= values[i]) tail--
    deque[tail++] = i
    const expired = i - window
    while (tail > head && deque[head] <= expired) head++
    out[i] = values[deque[head]]
  }
  return out
}

/** 峰值 EQ（RBJ peaking），用于变体生成的音色微调 */
export function peakingEqPcm(pcm: AudioPcm, freq: number, gainDb: number, q = 1): AudioPcm {
  if (gainDb === 0 || pcm.length === 0) return pcm
  const rate = pcm.sampleRate
  const a = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * Math.min(freq, rate / 2 - 1)) / rate
  const alpha = Math.sin(w0) / (2 * q)
  const cos = Math.cos(w0)
  const a0 = 1 + alpha / a
  const b0 = (1 + alpha * a) / a0
  const b1 = (-2 * cos) / a0
  const b2 = (1 - alpha * a) / a0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha / a) / a0

  const out = createPcm(rate, pcm.channels.length, pcm.length)
  for (let c = 0; c < pcm.channels.length; c++) {
    const src = pcm.channels[c]
    const dst = out.channels[c]
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < src.length; i++) {
      const x0 = src[i]
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x0
      y2 = y1
      y1 = y0
      dst[i] = y0
    }
  }
  return out
}

export interface NormalizePlan {
  /** 需要施加的增益（dB） */
  gainDb: number
  /** 是否因为峰值上限而被压低（未达到目标响度） */
  limitedByPeak: boolean
}

/** 峰值归一化：把当前峰值推到目标 dBFS */
export function planPeakNormalize(currentPeakDb: number, targetDb: number): NormalizePlan {
  if (!Number.isFinite(currentPeakDb)) return { gainDb: 0, limitedByPeak: false }
  return { gainDb: targetDb - currentPeakDb, limitedByPeak: false }
}

/**
 * 响度标准化（EBU R128）：先按目标 LUFS 求增益，再用真峰值上限兜底。
 * 峰值受限时以「不超上限」优先，宁可响度不达标也不产生削波。
 */
export function planLoudnessNormalize(
  integratedLufs: number,
  truePeakDbValue: number,
  targetLufs: number,
  maxTruePeakDb: number,
): NormalizePlan {
  if (!Number.isFinite(integratedLufs)) return { gainDb: 0, limitedByPeak: false }
  let gainDb = targetLufs - integratedLufs
  let limitedByPeak = false
  if (Number.isFinite(truePeakDbValue) && truePeakDbValue + gainDb > maxTruePeakDb) {
    gainDb = maxTruePeakDb - truePeakDbValue
    limitedByPeak = true
  }
  return { gainDb, limitedByPeak }
}

export { gainToDb }
