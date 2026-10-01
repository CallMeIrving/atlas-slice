/**
 * 变体生成。
 *
 * 游戏音效靠「同一条素材的多个微变体」避免听觉疲劳，因此这里用可复现的伪随机
 * 为一源文件生成 N 组参数，并对结果做指纹去重，防止随机出雷同变体。
 */

import { buildWaveformPeaks, createPcm, gainPcm, type AudioPcm } from './pcm'
import { cropPcm, peakingEqPcm, type ProcessContext } from './dsp'
import { centsToRatio, pitchShiftPcm } from './pitch'

export interface VariantSettings {
  enabled: boolean
  /** 每条源文件生成的变体数量 */
  count: number
  /** 音高随机范围（±音分） */
  pitchCents: number
  /** 音量随机范围（±dB） */
  gainDb: number
  /** 最大裁剪起点（占时长比例 0-1） */
  trimRatio: number
  /** 最大时长变化（占比 0-1） */
  durationRatio: number
  /** 音色随机范围（±dB） */
  eqDb: number
  seed: number
  /** 是否对结果做相似度去重 */
  dedupe: boolean
}

export const DEFAULT_VARIANTS: VariantSettings = {
  enabled: false,
  count: 3,
  pitchCents: 40,
  gainDb: 1.5,
  trimRatio: 0.02,
  durationRatio: 0.08,
  eqDb: 3,
  seed: 2026,
  dedupe: true,
}

export interface VariantPlan {
  index: number
  pitchCents: number
  gainDb: number
  /** 裁剪起点占时长比例 */
  trimStartRatio: number
  /** 保留时长比例 */
  keepRatio: number
  eqFreq: number
  eqGainDb: number
}

/** mulberry32：小而稳定的可复现伪随机数发生器 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 在 [-range, range] 内取随机值 */
function signed(rng: () => number, range: number): number {
  return (rng() * 2 - 1) * range
}

export function planVariants(settings: VariantSettings, seedOffset = 0): VariantPlan[] {
  const rng = createRng(settings.seed + seedOffset * 7919 + 1)
  const plans: VariantPlan[] = []
  for (let index = 0; index < settings.count; index++) {
    const keepRatio = 1 - rng() * settings.durationRatio
    const trimStartRatio = rng() * Math.max(0, Math.min(settings.trimRatio, 1 - keepRatio))
    plans.push({
      index,
      pitchCents: signed(rng, settings.pitchCents),
      gainDb: signed(rng, settings.gainDb),
      trimStartRatio,
      keepRatio,
      // 音色微调落在中频与中高频，听感变化明显但不至于改变音效识别度
      eqFreq: 400 + rng() * 2600,
      eqGainDb: signed(rng, settings.eqDb),
    })
  }
  return plans
}

/** 按一组参数渲染变体：裁剪 → 变调 → 音色 → 增益 */
export function renderVariant(pcm: AudioPcm, plan: VariantPlan, ctx?: ProcessContext): AudioPcm {
  const duration = pcm.sampleRate > 0 ? pcm.length / pcm.sampleRate : 0
  const startSec = duration * plan.trimStartRatio
  const endSec = startSec + duration * plan.keepRatio
  let result = cropPcm(pcm, startSec, endSec)
  result = pitchShiftPcm(result, centsToRatio(plan.pitchCents), ctx)
  result = peakingEqPcm(result, plan.eqFreq, plan.eqGainDb, 1)
  return gainPcm(result, Math.pow(10, plan.gainDb / 20))
}

/** 变体标签：用于命名模板 {variant}，例如 +23c / -1.2dB */
export function variantTag(plan: VariantPlan): string {
  const cents = Math.round(plan.pitchCents)
  const centsTag = `${cents >= 0 ? '+' : ''}${cents}c`
  const gainTag = `${plan.gainDb >= 0 ? '+' : ''}${plan.gainDb.toFixed(1)}dB`
  return `v${plan.index + 1}_${centsTag}_${gainTag}`
}

const FINGERPRINT_BANDS = 24

/**
 * 波形指纹：把单声道混合信号压成固定长度的对数能量包络。
 * 比频谱指纹便宜得多，用来判断「两个变体是否几乎一样」已经够用。
 */
export function variantFingerprint(pcm: AudioPcm): Float32Array {
  if (pcm.length === 0) return new Float32Array(FINGERPRINT_BANDS)
  const mono = createPcm(pcm.sampleRate, 1, pcm.length)
  const dst = mono.channels[0]
  const count = pcm.channels.length
  for (let i = 0; i < pcm.length; i++) {
    let sum = 0
    for (let c = 0; c < count; c++) sum += pcm.channels[c][i]
    dst[i] = sum / count
  }
  const peaks = buildWaveformPeaks(mono, FINGERPRINT_BANDS)
  const fingerprint = new Float32Array(FINGERPRINT_BANDS)
  for (let i = 0; i < FINGERPRINT_BANDS; i++) {
    fingerprint[i] = Math.log10(Math.max(peaks[i], 1e-6))
  }
  return fingerprint
}

/** 余弦相似度：1 表示几乎一致 */
export function fingerprintSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const size = Math.min(a.length, b.length)
  for (let i = 0; i < size; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
