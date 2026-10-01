/**
 * 处理链执行。
 *
 * 顺序固定为：裁剪 → 静音裁剪 → 变速 → 淡入淡出 → 声道 → 重采样 → 标准化 → 限幅。
 * 标准化放在重采样之后，保证按最终输出的响度和真峰值来定增益。
 */

import {
  convertChannels,
  cropPcm,
  fadePcm,
  limiterPcm,
  planLoudnessNormalize,
  planPeakNormalize,
  resamplePcm,
  stretchPcm,
  trimSilence,
  type ProcessContext,
} from './dsp'
import { analyzeLoudness, formatDb } from './loudness'
import { clonePcm, dbToGain, gainPcm, peakDb, type AudioPcm } from './pcm'
import type { AudioChain } from './presets'

export interface ChainStepReport {
  key: keyof AudioChain
  label: string
  detail: string
}

export interface ChainResult {
  pcm: AudioPcm
  steps: ChainStepReport[]
}

function seconds(value: number): string {
  return `${value.toFixed(3)} s`
}

export async function applyChain(
  input: AudioPcm,
  chain: AudioChain,
  ctx?: ProcessContext,
): Promise<ChainResult> {
  const steps: ChainStepReport[] = []
  let pcm = input

  if (chain.crop.enabled && chain.crop.endSec > chain.crop.startSec) {
    const before = pcm.length
    pcm = cropPcm(pcm, chain.crop.startSec, chain.crop.endSec)
    steps.push({
      key: 'crop',
      label: '精确裁剪',
      detail: `${seconds(chain.crop.startSec)} → ${seconds(chain.crop.endSec)}（${before} → ${pcm.length} 采样）`,
    })
  }

  if (chain.trimSilence.enabled) {
    const before = pcm.length
    pcm = trimSilence(pcm, {
      thresholdDb: chain.trimSilence.thresholdDb,
      headSec: chain.trimSilence.headSec,
      tailSec: chain.trimSilence.tailSec,
    })
    steps.push({
      key: 'trimSilence',
      label: '静音头尾裁剪',
      detail: before === pcm.length
        ? `未检测到低于 ${chain.trimSilence.thresholdDb} dBFS 的静音段`
        : `${before} → ${pcm.length} 采样`,
    })
  }

  if (chain.speed.enabled && chain.speed.factor > 0 && chain.speed.factor !== 1) {
    pcm = clonePcm(await stretchPcm(pcm, chain.speed.factor, ctx))
    steps.push({
      key: 'speed',
      label: '变速',
      detail: `×${chain.speed.factor.toFixed(3)}（音高联动）`,
    })
  }

  if (chain.fade.enabled && (chain.fade.inSec > 0 || chain.fade.outSec > 0)) {
    pcm = clonePcm(fadePcm(pcm, chain.fade.inSec, chain.fade.outSec))
    steps.push({
      key: 'fade',
      label: '淡入淡出',
      detail: `淡入 ${seconds(chain.fade.inSec)} / 淡出 ${seconds(chain.fade.outSec)}`,
    })
  }

  if (chain.channels.enabled && pcm.channels.length !== chain.channels.target) {
    const before = pcm.channels.length
    pcm = convertChannels(pcm, chain.channels.target)
    steps.push({
      key: 'channels',
      label: '声道转换',
      detail: `${before} → ${pcm.channels.length} 声道`,
    })
  }

  if (chain.resample.enabled && chain.resample.targetRate !== pcm.sampleRate) {
    const before = pcm.sampleRate
    pcm = await resamplePcm(pcm, chain.resample.targetRate, ctx)
    steps.push({
      key: 'resample',
      label: '重采样',
      detail: `${before} → ${pcm.sampleRate} Hz`,
    })
  }

  if (chain.normalize.enabled) {
    const analysis = analyzeLoudness(pcm)
    const plan = chain.normalize.mode === 'lufs'
      ? planLoudnessNormalize(analysis.integratedLufs, analysis.truePeakDb, chain.normalize.targetLufs, chain.normalize.maxTruePeakDb)
      : planPeakNormalize(analysis.samplePeakDb, chain.normalize.targetPeakDb)
    pcm = clonePcm(gainPcm(pcm, dbToGain(plan.gainDb)))
    const target = chain.normalize.mode === 'lufs'
      ? `${chain.normalize.targetLufs} LUFS（上限 ${chain.normalize.maxTruePeakDb} dBTP）`
      : `${chain.normalize.targetPeakDb} dBFS`
    const measured = chain.normalize.mode === 'lufs'
      ? `${analysis.integratedLufs.toFixed(1)} LUFS`
      : formatDb(analysis.samplePeakDb)
    steps.push({
      key: 'normalize',
      label: '响度 / 峰值标准化',
      detail: `测量 ${measured} → 目标 ${target}，增益 ${plan.gainDb >= 0 ? '+' : ''}${plan.gainDb.toFixed(2)} dB`
        + (plan.limitedByPeak ? '（受真峰值上限限制）' : ''),
    })
  }

  if (chain.limiter.enabled) {
    const before = peakDb(pcm)
    pcm = clonePcm(limiterPcm(pcm, chain.limiter.ceilingDb))
    const after = peakDb(pcm)
    steps.push({
      key: 'limiter',
      label: '限幅',
      detail: `上限 ${chain.limiter.ceilingDb} dBFS，峰值 ${formatDb(before)} → ${formatDb(after)}`,
    })
  }

  return { pcm, steps }
}

/** 命名模板替换 */
export function applyNameTemplate(
  template: string,
  vars: { name: string; preset: string; variant: string; index: number; ext: string },
): string {
  const rendered = template
    .replace(/\{name\}/g, vars.name)
    .replace(/\{preset\}/g, vars.preset)
    .replace(/\{variant\}/g, vars.variant)
    .replace(/\{index\}/g, String(vars.index).padStart(3, '0'))
    .replace(/\{ext\}/g, vars.ext)
  return rendered.trim() || vars.name
}
