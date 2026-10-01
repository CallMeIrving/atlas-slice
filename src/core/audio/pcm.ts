/**
 * 音频 PCM 数据模型。
 *
 * 全链路统一使用「每声道一个 Float32Array、样本范围 -1..1」的内存表示：
 * 解码、处理链、响度分析、导出编码都围绕它做纯函数式变换，不依赖 AudioContext，
 * 便于分片批处理与离线测试。
 */

export interface AudioPcm {
  sampleRate: number
  /** 每个声道一条等长样本序列 */
  channels: Float32Array[]
  /** 单声道样本数（等于 channels[i].length） */
  length: number
}

/** 字节整数样本格式 */
export type PcmBitDepth = 16 | 24 | 32

/** 静音判定与峰值计算用不到 EPS 级精度，统一按 dBFS 阈值换算 */
export const SILENCE_FLOOR_DB = -100

export function createPcm(sampleRate: number, channelCount: number, length: number): AudioPcm {
  const size = Math.max(0, Math.floor(length))
  const channels: Float32Array[] = []
  for (let i = 0; i < Math.max(1, channelCount); i++) channels.push(new Float32Array(size))
  return { sampleRate, channels, length: size }
}

export function clonePcm(pcm: AudioPcm): AudioPcm {
  return { sampleRate: pcm.sampleRate, length: pcm.length, channels: pcm.channels.map((c) => c.slice()) }
}

/** 时长（秒） */
export function pcmDuration(pcm: AudioPcm): number {
  return pcm.sampleRate > 0 ? pcm.length / pcm.sampleRate : 0
}

export function pcmChannelCount(pcm: AudioPcm): number {
  return pcm.channels.length
}

/** 全部声道中的样本绝对值峰值；空数据返回 0 */
export function samplePeak(pcm: AudioPcm): number {
  let peak = 0
  for (const channel of pcm.channels) {
    for (let i = 0; i < channel.length; i++) {
      const value = Math.abs(channel[i])
      if (value > peak) peak = value
    }
  }
  return peak
}

/** 样本峰值 dBFS；全静音返回 -Infinity（调用方负责显示层兜底） */
export function peakDb(pcm: AudioPcm): number {
  const peak = samplePeak(pcm)
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY
}

/** 按线性增益缩放，返回新对象 */
export function gainPcm(pcm: AudioPcm, factor: number): AudioPcm {
  const out = createPcm(pcm.sampleRate, pcm.channels.length, pcm.length)
  for (let c = 0; c < pcm.channels.length; c++) {
    const src = pcm.channels[c]
    const dst = out.channels[c]
    for (let i = 0; i < src.length; i++) dst[i] = src[i] * factor
  }
  return out
}

/** 按秒裁剪片段，起止越界或顺序颠倒时自动收敛 */
export function slicePcm(pcm: AudioPcm, startSec: number, endSec: number): AudioPcm {
  const start = clampIndex(Math.round(startSec * pcm.sampleRate), pcm.length)
  const end = clampIndex(Math.round(endSec * pcm.sampleRate), pcm.length)
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  return slicePcmByIndex(pcm, from, to)
}

/** 按下标裁剪片段（左闭右开） */
export function slicePcmByIndex(pcm: AudioPcm, from: number, to: number): AudioPcm {
  const start = clampIndex(from, pcm.length)
  const end = clampIndex(Math.max(from, to), pcm.length)
  const out = createPcm(pcm.sampleRate, pcm.channels.length, end - start)
  for (let c = 0; c < pcm.channels.length; c++) {
    out.channels[c].set(pcm.channels[c].subarray(start, end))
  }
  return out
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(length, Math.max(0, value))
}

/** dBFS → 线性幅度 */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** 线性幅度 → dBFS，0 返回 -Infinity */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY
}

/** 一帧跨所有声道的绝对峰值（多声道取最大） */
export function framePeak(pcm: AudioPcm, index: number): number {
  let peak = 0
  for (const channel of pcm.channels) {
    const value = Math.abs(channel[index] ?? 0)
    if (value > peak) peak = value
  }
  return peak
}

/**
 * 降采样波形包络：把整段音频压成固定数量的「每格峰值」，
 * 供界面绘制波形图使用，避免把上千万个样本直接交给渲染层。
 */
export function buildWaveformPeaks(pcm: AudioPcm, buckets: number): Float32Array {
  const count = Math.max(1, Math.floor(buckets))
  const peaks = new Float32Array(count)
  if (pcm.length === 0) return peaks
  const step = pcm.length / count
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * step)
    const to = Math.min(pcm.length, Math.max(from + 1, Math.floor((b + 1) * step)))
    let peak = 0
    for (const channel of pcm.channels) {
      for (let i = from; i < to; i++) {
        const value = Math.abs(channel[i])
        if (value > peak) peak = value
      }
    }
    peaks[b] = peak
  }
  return peaks
}
