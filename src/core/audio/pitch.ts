/**
 * 时域变调（保持时长）。
 *
 * 用同步颗粒叠加：每个颗粒以 `ratio` 的速率读取源样本，颗粒之间按 hop 步进并按 50% 重叠做汉宁窗叠加，
 * 平均读取速率仍为 1，因此时长不变、音高改变。末尾按窗和归一化，避免首尾出现淡入淡出。
 * 音质属于「音效随机变体」量级，不做相位声码器级别的要求。
 */

import { createPcm, type AudioPcm } from './pcm'
import { CancelledError, type ProcessContext } from './dsp'

/** 颗粒 hop（毫秒）；50% 重叠后窗长为 2 倍 hop */
const HOP_MS = 25

export function pitchShiftPcm(pcm: AudioPcm, ratio: number, ctx?: ProcessContext): AudioPcm {
  if (ratio === 1 || pcm.length === 0 || ratio <= 0) return pcm
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * pcm.sampleRate))
  const windowLength = hop * 2
  const window = new Float32Array(windowLength)
  for (let k = 0; k < windowLength; k++) {
    window[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / windowLength)
  }

  const out = createPcm(pcm.sampleRate, pcm.channels.length, pcm.length)
  const gainSum = new Float32Array(pcm.length)
  const grainCount = Math.ceil(pcm.length / hop) + 1

  for (let c = 0; c < pcm.channels.length; c++) {
    const src = pcm.channels[c]
    const dst = out.channels[c]
    for (let g = 0; g < grainCount; g++) {
      if (ctx?.isCancelled?.()) throw new CancelledError()
      const outStart = g * hop
      if (outStart >= pcm.length) break
      const srcStart = g * hop
      for (let k = 0; k < windowLength; k++) {
        const outIndex = outStart + k
        if (outIndex >= pcm.length) break
        const position = srcStart + k * ratio
        const base = Math.min(src.length - 1, Math.max(0, Math.floor(position)))
        const next = Math.min(src.length - 1, base + 1)
        const frac = position - base
        const sample = src[base] * (1 - frac) + src[next] * frac
        dst[outIndex] += sample * window[k]
        // 窗和只需按声道累加一次
        if (c === 0) gainSum[outIndex] += window[k]
      }
    }
  }

  for (let i = 0; i < pcm.length; i++) {
    const sum = gainSum[i]
    if (sum > 1e-6) {
      for (let c = 0; c < pcm.channels.length; c++) out.channels[c][i] /= sum
    }
  }
  return out
}

/** 半音 / 音分换算：cents > 0 音高更高 */
export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200)
}
