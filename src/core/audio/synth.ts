/**
 * 游戏音效合成。
 *
 * 与 dsp.ts 同属纯样本运算，不经过 AudioContext：结果可复现、可离线测试，
 * Web 与 Electron 行为一致。周期波形一律用加法合成按 Nyquist 截断谐波，
 * 天然抗混叠——朴素方波 / 锯齿在高频会产生刺耳镜像，游戏音效里尤其明显。
 *
 * 只覆盖程序化合成擅长的部分（UI 反馈 / 8-bit / 扫频 / 噪声打击），
 * 拟真类（脚步、材质碰撞、角色语音）不在范围内。
 */

import { createPcm, dbToGain, gainPcm, peakDb, type AudioPcm } from './pcm'
import { createRng } from './variants'

export type Waveform = 'sine' | 'triangle' | 'square' | 'saw'

/** 谐波截断上限：兼顾亮度与渲染耗时（每个谐波每样本一次 sin） */
const HARMONIC_LIMIT = 32
/** 指数衰减的时间常数：包络在 decaySec 内衰减到约 -43dB */
const DECAY_CURVE = 5
/** 层结尾的强制淡出，保证任意参数组合下收尾都不爆音 */
const TAIL_FADE_SEC = 0.006
/** 合成结果统一留的峰值余量（dBFS），避免入库时已削波，后续可再走响度标准化 */
const SYNTH_PEAK_DB = -3
/** 变体去重：抖动向量的最小归一化距离 */
const VARIANT_MIN_DISTANCE = 0.5
const VARIANT_RETRY = 6
/** 音高变化量的变体抖动（半音），不做界面参数，保持「少量参数」 */
const GLIDE_JITTER_SEMITONES = 0.8

// ---------------------------------------------------------------- 参数与预设

/** 每个预设对外暴露的全部参数：基频 / 时长 / 包络 / 音高变化量 / 亮度 */
export interface SynthParams {
  /** 基频（Hz）；噪声类预设用它作低通扫频的基准截止频率 */
  baseFreq: number
  /** 总时长（秒） */
  durationSec: number
  /** 包络起音（秒） */
  attackSec: number
  /** 包络衰减到静音的时间（秒） */
  decaySec: number
  /** 音高变化量（半音）：正数上扬、负数下沉，也决定多音预设的音程 */
  pitchSemitones: number
  /** 亮度 0-1：周期波形映射到谐波数量，噪声映射到截止频率高低 */
  tone: number
}

export interface SynthRange {
  min: number
  max: number
  step: number
}

export interface SynthRanges {
  baseFreq: SynthRange
  durationSec: SynthRange
  attackSec: SynthRange
  decaySec: SynthRange
  pitchSemitones: SynthRange
  tone: SynthRange
}

export interface SynthPreset {
  id: string
  label: string
  group: string
  description: string
  defaults: SynthParams
  ranges: SynthRanges
  /** rate 在前、rng 在后：不需要随机数的预设直接不声明最后一个参数 */
  render: (out: Float32Array, params: SynthParams, rate: number, rng: () => number) => void
}

const BASE_RANGES: SynthRanges = {
  baseFreq: { min: 40, max: 6000, step: 1 },
  durationSec: { min: 0.03, max: 2, step: 0.01 },
  attackSec: { min: 0, max: 0.3, step: 0.001 },
  decaySec: { min: 0.01, max: 2, step: 0.01 },
  pitchSemitones: { min: -24, max: 24, step: 0.5 },
  tone: { min: 0, max: 1, step: 0.01 },
}

/** 只覆盖需要收窄的字段，其余沿用通用范围 */
function ranges(overrides: Partial<SynthRanges>): SynthRanges {
  return { ...BASE_RANGES, ...overrides }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 亮度 → 谐波数量 */
function harmonicsFor(tone: number): number {
  return Math.max(1, Math.min(HARMONIC_LIMIT, Math.round(1 + clamp01(tone) * (HARMONIC_LIMIT - 1))))
}

/** 亮度 → 截止频率倍率，0.5 为基准，约 ±1.5 个八度 */
function brightnessScale(tone: number): number {
  return Math.pow(2, (clamp01(tone) - 0.5) * 3)
}

/** 从起始频率按半音数滑到终点频率 */
function glideTo(fromHz: number, semitones: number): number {
  return fromHz * Math.pow(2, semitones / 12)
}

// ---------------------------------------------------------------- 合成基元

/** 各波形的谐波幅度衰减方式；sine 只保留基波 */
function harmonicAmp(wave: Waveform, harmonic: number): number {
  switch (wave) {
    case 'sine':
      return harmonic === 1 ? 1 : 0
    case 'triangle':
      return harmonic % 2 === 1 ? 1 / (harmonic * harmonic) : 0
    case 'square':
      return harmonic % 2 === 1 ? 1 / harmonic : 0
    case 'saw':
      return 1 / harmonic
  }
}

/** 打击型 AD 包络：起音线性上升，其后指数衰减 */
function envelopeAt(t: number, attackSec: number, decaySec: number, durationSec: number): number {
  if (t < 0 || t >= durationSec) return 0
  const rise = attackSec > 0 ? Math.min(1, t / attackSec) : 1
  const fall = Math.exp((-DECAY_CURVE * Math.max(0, t - attackSec)) / decaySec)
  return rise * fall
}

interface ToneSegment {
  startSec: number
  durationSec: number
  freqFrom: number
  freqTo: number
  wave: Waveform
  /** 谐波数量，1 即纯正弦 */
  harmonics: number
  attackSec: number
  decaySec: number
  amp: number
  /** 颤音：频率（Hz）与深度（音分），缺省或为 0 表示不启用 */
  vibratoHz?: number
  vibratoCents?: number
}

/**
 * 叠加一段周期波形：频率按指数从 freqFrom 滑到 freqTo，各谐波相位独立累加，
 * 保证滑音过程中谐波关系不漂移（共用相位会听成错误的滑音）。
 */
function addToneSegment(out: Float32Array, rate: number, segment: ToneSegment): void {
  const from = Math.max(0, Math.round(segment.startSec * rate))
  const to = Math.min(out.length, Math.round((segment.startSec + segment.durationSec) * rate))
  const span = to - from
  if (span <= 0) return

  const duration = Math.min(segment.durationSec, span / rate)
  const attack = Math.min(Math.max(0, segment.attackSec), duration)
  const decay = Math.max(1e-3, segment.decaySec)
  const harmonics = Math.max(1, Math.min(HARMONIC_LIMIT, Math.round(segment.harmonics)))
  const fadeSamples = Math.min(Math.round(TAIL_FADE_SEC * rate), Math.floor(span * 0.25))

  const amplitudes = new Float64Array(harmonics)
  let sum = 0
  for (let h = 0; h < harmonics; h++) {
    const amp = harmonicAmp(segment.wave, h + 1)
    amplitudes[h] = amp
    sum += amp
  }
  const scale = sum > 0 ? 1 / sum : 1
  const phases = new Float64Array(harmonics)
  const phaseStep = (2 * Math.PI) / rate
  const vibratoHz = segment.vibratoHz ?? 0
  const vibratoCents = segment.vibratoCents ?? 0

  for (let i = from; i < to; i++) {
    const local = (i - from) / rate
    const progress = duration > 0 ? local / duration : 0
    let freq = segment.freqFrom * Math.pow(segment.freqTo / segment.freqFrom, progress)
    if (vibratoHz > 0 && vibratoCents !== 0) {
      freq *= Math.pow(2, (Math.sin(2 * Math.PI * vibratoHz * local) * vibratoCents) / 1200)
    }
    let sample = 0
    for (let h = 0; h < harmonics; h++) {
      const amp = amplitudes[h]
      if (amp === 0) continue
      phases[h] += phaseStep * freq * (h + 1)
      sample += amp * Math.sin(phases[h])
    }
    let gain = envelopeAt(local, attack, decay, duration)
    const remaining = to - i
    if (fadeSamples > 0 && remaining <= fadeSamples) gain *= remaining / fadeSamples
    out[i] += sample * scale * gain * segment.amp
  }
}

interface NoiseLayer {
  amp: number
  /** 低通截止从 fromHz 指数扫到 toHz */
  cutoffFrom: number
  cutoffTo: number
  /** 谐振品质因数：越大扫频越"哨" */
  q: number
  attackSec: number
  decaySec: number
  durationSec: number
}

/** TPT 状态变量低通：系数逐样本更新，扫频过程中依然稳定 */
function sweepLowpass(samples: Float32Array, rate: number, cutoffFrom: number, cutoffTo: number, q: number): void {
  const length = samples.length
  if (length === 0) return
  const damping = 1 / Math.max(0.5, q)
  const maxCutoff = rate * 0.45
  let ic1 = 0
  let ic2 = 0
  for (let i = 0; i < length; i++) {
    const progress = length > 1 ? i / (length - 1) : 0
    const cutoff = Math.min(maxCutoff, Math.max(10, cutoffFrom * Math.pow(cutoffTo / cutoffFrom, progress)))
    const g = Math.tan((Math.PI * cutoff) / rate)
    const a1 = 1 / (1 + g * (g + damping))
    const a2 = g * a1
    const a3 = g * a2
    const v3 = samples[i] - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    samples[i] = v2
  }
}

/** 叠加一层带扫频低通的噪声 */
function addNoiseLayer(out: Float32Array, rate: number, rng: () => number, layer: NoiseLayer): void {
  const temp = new Float32Array(out.length)
  for (let i = 0; i < temp.length; i++) temp[i] = rng() * 2 - 1
  sweepLowpass(temp, rate, layer.cutoffFrom, layer.cutoffTo, layer.q)

  const attack = Math.max(0, layer.attackSec)
  const decay = Math.max(1e-3, layer.decaySec)
  const fadeSamples = Math.min(Math.round(TAIL_FADE_SEC * rate), Math.floor(out.length * 0.25))
  for (let i = 0; i < temp.length; i++) {
    let gain = envelopeAt(i / rate, attack, decay, layer.durationSec)
    const remaining = temp.length - i
    if (fadeSamples > 0 && remaining <= fadeSamples) gain *= remaining / fadeSamples
    out[i] += temp[i] * gain * layer.amp
  }
}

// ---------------------------------------------------------------- 预设音效

export const SYNTH_PRESETS: SynthPreset[] = [
  {
    id: 'ui-click',
    label: '界面点击',
    group: '界面 UI',
    description: '极短的高频短促音，带一点噪声瞬态，适合按钮 / 开关',
    defaults: { baseFreq: 1600, durationSec: 0.07, attackSec: 0.001, decaySec: 0.05, pitchSemitones: -6, tone: 0.5 },
    ranges: ranges({
      baseFreq: { min: 600, max: 5000, step: 10 },
      durationSec: { min: 0.03, max: 0.3, step: 0.005 },
      attackSec: { min: 0, max: 0.02, step: 0.001 },
      decaySec: { min: 0.01, max: 0.3, step: 0.005 },
    }),
    render(out, params, rate, rng) {
      addToneSegment(out, rate, {
        startSec: 0,
        durationSec: params.durationSec,
        freqFrom: params.baseFreq,
        freqTo: glideTo(params.baseFreq, params.pitchSemitones),
        wave: 'triangle',
        harmonics: harmonicsFor(params.tone),
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        amp: 1,
      })
      addNoiseLayer(out, rate, rng, {
        amp: 0.4,
        cutoffFrom: params.baseFreq * 4 * brightnessScale(params.tone),
        cutoffTo: params.baseFreq * 2 * brightnessScale(params.tone),
        q: 1,
        attackSec: params.attackSec,
        decaySec: params.decaySec * 0.5,
        durationSec: params.durationSec,
      })
    },
  },
  {
    id: 'ui-confirm',
    label: '界面确认',
    group: '界面 UI',
    description: '两音上行（音程由音高变化量决定），适合确定 / 成功',
    defaults: { baseFreq: 880, durationSec: 0.22, attackSec: 0.004, decaySec: 0.12, pitchSemitones: 7, tone: 0.3 },
    ranges: ranges({
      baseFreq: { min: 300, max: 2000, step: 5 },
      durationSec: { min: 0.1, max: 0.8, step: 0.01 },
      pitchSemitones: { min: 0, max: 24, step: 0.5 },
    }),
    render(out, params, rate) {
      const split = params.durationSec * 0.45
      const second = glideTo(params.baseFreq, params.pitchSemitones)
      const shape = { wave: 'triangle' as Waveform, harmonics: harmonicsFor(params.tone), attackSec: params.attackSec, decaySec: params.decaySec, amp: 1 }
      addToneSegment(out, rate, { ...shape, startSec: 0, durationSec: split, freqFrom: params.baseFreq, freqTo: params.baseFreq })
      addToneSegment(out, rate, { ...shape, startSec: split, durationSec: params.durationSec - split, freqFrom: second, freqTo: second })
    },
  },
  {
    id: 'ui-cancel',
    label: '界面取消',
    group: '界面 UI',
    description: '两音下行，适合取消 / 返回 / 失败提示',
    defaults: { baseFreq: 880, durationSec: 0.22, attackSec: 0.004, decaySec: 0.12, pitchSemitones: -5, tone: 0.3 },
    ranges: ranges({
      baseFreq: { min: 300, max: 2000, step: 5 },
      durationSec: { min: 0.1, max: 0.8, step: 0.01 },
      pitchSemitones: { min: -24, max: 0, step: 0.5 },
    }),
    render(out, params, rate) {
      const split = params.durationSec * 0.45
      const second = glideTo(params.baseFreq, params.pitchSemitones)
      const shape = { wave: 'triangle' as Waveform, harmonics: harmonicsFor(params.tone), attackSec: params.attackSec, decaySec: params.decaySec, amp: 1 }
      addToneSegment(out, rate, { ...shape, startSec: 0, durationSec: split, freqFrom: params.baseFreq, freqTo: params.baseFreq })
      addToneSegment(out, rate, { ...shape, startSec: split, durationSec: params.durationSec - split, freqFrom: second, freqTo: second })
    },
  },
  {
    id: 'coin',
    label: '金币拾取',
    group: '8-bit',
    description: '两音上行的方波琶音，经典拾取 / 奖励音',
    defaults: { baseFreq: 988, durationSec: 0.18, attackSec: 0.002, decaySec: 0.1, pitchSemitones: 5, tone: 0.45 },
    ranges: ranges({
      baseFreq: { min: 200, max: 2000, step: 5 },
      durationSec: { min: 0.06, max: 0.6, step: 0.01 },
      pitchSemitones: { min: 0, max: 24, step: 0.5 },
    }),
    render(out, params, rate) {
      const split = params.durationSec * 0.35
      const second = glideTo(params.baseFreq, params.pitchSemitones)
      const shape = { wave: 'square' as Waveform, harmonics: harmonicsFor(params.tone), attackSec: params.attackSec, decaySec: params.decaySec, amp: 1 }
      addToneSegment(out, rate, { ...shape, startSec: 0, durationSec: split, freqFrom: params.baseFreq, freqTo: params.baseFreq })
      addToneSegment(out, rate, { ...shape, startSec: split, durationSec: params.durationSec - split, freqFrom: second, freqTo: second })
    },
  },
  {
    id: 'jump',
    label: '跳跃',
    group: '8-bit',
    description: '方波持续上扬滑音，适合跳跃 / 起跳',
    defaults: { baseFreq: 300, durationSec: 0.28, attackSec: 0.004, decaySec: 0.28, pitchSemitones: 12, tone: 0.35 },
    ranges: ranges({
      baseFreq: { min: 120, max: 900, step: 5 },
      durationSec: { min: 0.1, max: 0.8, step: 0.01 },
      pitchSemitones: { min: 0, max: 24, step: 0.5 },
    }),
    render(out, params, rate) {
      addToneSegment(out, rate, {
        startSec: 0,
        durationSec: params.durationSec,
        freqFrom: params.baseFreq,
        freqTo: glideTo(params.baseFreq, params.pitchSemitones),
        wave: 'square',
        harmonics: harmonicsFor(params.tone),
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        amp: 1,
      })
    },
  },
  {
    id: 'powerup',
    label: '升级',
    group: '8-bit',
    description: '四音上行琶音，适合升级 / 强化 / 通关',
    defaults: { baseFreq: 523, durationSec: 0.5, attackSec: 0.003, decaySec: 0.16, pitchSemitones: 12, tone: 0.45 },
    ranges: ranges({
      baseFreq: { min: 200, max: 1200, step: 5 },
      durationSec: { min: 0.2, max: 1.5, step: 0.01 },
      pitchSemitones: { min: 4, max: 24, step: 0.5 },
    }),
    render(out, params, rate) {
      const notes = 4
      const step = params.durationSec / notes
      const shape = { wave: 'square' as Waveform, harmonics: harmonicsFor(params.tone), attackSec: params.attackSec, decaySec: params.decaySec, amp: 1 }
      for (let i = 0; i < notes; i++) {
        const freq = glideTo(params.baseFreq, (params.pitchSemitones * i) / (notes - 1))
        addToneSegment(out, rate, { ...shape, startSec: i * step, durationSec: step, freqFrom: freq, freqTo: freq })
      }
    },
  },
  {
    id: 'hurt',
    label: '受伤',
    group: '8-bit',
    description: '锯齿下行滑音，适合受伤 / 扣血 / 失败',
    defaults: { baseFreq: 420, durationSec: 0.3, attackSec: 0.003, decaySec: 0.3, pitchSemitones: -14, tone: 0.5 },
    ranges: ranges({
      baseFreq: { min: 150, max: 1200, step: 5 },
      durationSec: { min: 0.1, max: 0.9, step: 0.01 },
      pitchSemitones: { min: -24, max: 0, step: 0.5 },
    }),
    render(out, params, rate) {
      addToneSegment(out, rate, {
        startSec: 0,
        durationSec: params.durationSec,
        freqFrom: params.baseFreq,
        freqTo: glideTo(params.baseFreq, params.pitchSemitones),
        wave: 'saw',
        harmonics: harmonicsFor(params.tone),
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        amp: 1,
      })
    },
  },
  {
    id: 'laser',
    label: '激光',
    group: '特效',
    description: '高速下行滑音叠加强谐振噪声，科幻射击 / 光枪',
    defaults: { baseFreq: 1800, durationSec: 0.35, attackSec: 0.002, decaySec: 0.3, pitchSemitones: -24, tone: 0.8 },
    ranges: ranges({
      baseFreq: { min: 400, max: 6000, step: 10 },
      durationSec: { min: 0.1, max: 1, step: 0.01 },
      pitchSemitones: { min: -24, max: 0, step: 0.5 },
    }),
    render(out, params, rate, rng) {
      addToneSegment(out, rate, {
        startSec: 0,
        durationSec: params.durationSec,
        freqFrom: params.baseFreq,
        freqTo: glideTo(params.baseFreq, params.pitchSemitones),
        wave: 'saw',
        harmonics: harmonicsFor(params.tone),
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        amp: 0.8,
      })
      addNoiseLayer(out, rate, rng, {
        amp: 0.5,
        cutoffFrom: params.baseFreq * 3 * brightnessScale(params.tone),
        cutoffTo: params.baseFreq * 0.2,
        q: 8,
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        durationSec: params.durationSec,
      })
    },
  },
  {
    id: 'whoosh',
    label: '冲刺 / 风切',
    group: '特效',
    description: '噪声低通由暗扫到亮再落回，适合冲刺 / 挥砍 / 转场',
    defaults: { baseFreq: 400, durationSec: 0.5, attackSec: 0.12, decaySec: 0.5, pitchSemitones: 18, tone: 0.55 },
    ranges: ranges({
      baseFreq: { min: 150, max: 2000, step: 5 },
      durationSec: { min: 0.15, max: 1.5, step: 0.01 },
      attackSec: { min: 0, max: 0.3, step: 0.005 },
    }),
    render(out, params, rate, rng) {
      const bright = brightnessScale(params.tone)
      addNoiseLayer(out, rate, rng, {
        amp: 1,
        cutoffFrom: params.baseFreq * bright,
        cutoffTo: glideTo(params.baseFreq, params.pitchSemitones) * bright * 2,
        q: 2,
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        durationSec: params.durationSec,
      })
    },
  },
  {
    id: 'teleport',
    label: '传送',
    group: '特效',
    description: '带颤音的滑音叠加噪声微光，适合传送 / 魔法 / 变形',
    defaults: { baseFreq: 900, durationSec: 0.6, attackSec: 0.02, decaySec: 0.6, pitchSemitones: 7, tone: 0.35 },
    ranges: ranges({
      baseFreq: { min: 200, max: 3000, step: 10 },
      durationSec: { min: 0.2, max: 1.5, step: 0.01 },
    }),
    render(out, params, rate, rng) {
      addToneSegment(out, rate, {
        startSec: 0,
        durationSec: params.durationSec,
        freqFrom: params.baseFreq,
        freqTo: glideTo(params.baseFreq, params.pitchSemitones),
        wave: 'sine',
        harmonics: 1,
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        amp: 1,
        vibratoHz: 28,
        vibratoCents: 400,
      })
      addNoiseLayer(out, rate, rng, {
        amp: 0.18,
        cutoffFrom: params.baseFreq * 2 * brightnessScale(params.tone),
        cutoffTo: params.baseFreq * 6 * brightnessScale(params.tone),
        q: 4,
        attackSec: params.attackSec,
        decaySec: params.decaySec * 0.6,
        durationSec: params.durationSec,
      })
    },
  },
  {
    id: 'explosion',
    label: '爆炸',
    group: '打击',
    description: '低频轰鸣 + 噪声下扫，写实度有限但冲击力足够',
    defaults: { baseFreq: 120, durationSec: 1.1, attackSec: 0.002, decaySec: 1.1, pitchSemitones: -12, tone: 0.5 },
    ranges: ranges({
      baseFreq: { min: 40, max: 400, step: 1 },
      durationSec: { min: 0.3, max: 2, step: 0.02 },
    }),
    render(out, params, rate, rng) {
      addToneSegment(out, rate, {
        startSec: 0,
        durationSec: params.durationSec,
        freqFrom: params.baseFreq * 2,
        freqTo: glideTo(params.baseFreq * 2, params.pitchSemitones),
        wave: 'sine',
        harmonics: 1,
        attackSec: params.attackSec,
        decaySec: params.decaySec * 0.45,
        amp: 1,
      })
      addNoiseLayer(out, rate, rng, {
        amp: 0.9,
        cutoffFrom: 9000 * brightnessScale(params.tone),
        cutoffTo: params.baseFreq * 2,
        q: 1,
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        durationSec: params.durationSec,
      })
    },
  },
  {
    id: 'hit',
    label: '命中打击',
    group: '打击',
    description: '短促噪声瞬态 + 中频闷响，适合命中 / 拳击 / 撞击',
    defaults: { baseFreq: 200, durationSec: 0.18, attackSec: 0.001, decaySec: 0.12, pitchSemitones: -10, tone: 0.55 },
    ranges: ranges({
      baseFreq: { min: 60, max: 800, step: 1 },
      durationSec: { min: 0.05, max: 0.6, step: 0.005 },
    }),
    render(out, params, rate, rng) {
      addToneSegment(out, rate, {
        startSec: 0,
        durationSec: params.durationSec,
        freqFrom: params.baseFreq * 1.8,
        freqTo: glideTo(params.baseFreq * 1.8, params.pitchSemitones),
        wave: 'sine',
        harmonics: 1,
        attackSec: params.attackSec,
        decaySec: params.decaySec,
        amp: 1,
      })
      addNoiseLayer(out, rate, rng, {
        amp: 0.7,
        cutoffFrom: 6000 * brightnessScale(params.tone),
        cutoffTo: params.baseFreq * 2,
        q: 1.5,
        attackSec: params.attackSec,
        decaySec: params.decaySec * 0.4,
        durationSec: params.durationSec,
      })
    },
  },
]

export function findSynthPreset(id: string): SynthPreset | null {
  return SYNTH_PRESETS.find((item) => item.id === id) ?? null
}

/** 预设分组，界面按此顺序铺开 */
export const SYNTH_GROUPS: string[] = Array.from(new Set(SYNTH_PRESETS.map((item) => item.group)))

// ---------------------------------------------------------------- 渲染

/**
 * 按参数渲染一条音效，输出单声道 PCM。
 * 游戏引擎通常自己做 3D 空间化，单声道既省体积也避免引擎重复处理。
 */
export function renderSynth(preset: SynthPreset, params: SynthParams, rate: number, seed: number): AudioPcm {
  const length = Math.max(1, Math.round(params.durationSec * rate))
  const out = new Float32Array(length)
  preset.render(out, params, rate, createRng(seed))

  // 收尾兜底：噪声层与多音预设可能停在任意位置，统一再淡出一次
  const fadeSamples = Math.min(Math.round(TAIL_FADE_SEC * rate), Math.floor(length * 0.25))
  for (let i = 0; i < fadeSamples; i++) out[length - 1 - i] *= i / fadeSamples

  const pcm = createPcm(rate, 1, length)
  pcm.channels[0].set(out)
  return normalizePeak(pcm)
}

/** 把峰值推到统一余量，避免不同预设之间音量差太大或入库即削波 */
function normalizePeak(pcm: AudioPcm, targetDb = SYNTH_PEAK_DB): AudioPcm {
  const db = peakDb(pcm)
  if (!Number.isFinite(db)) return pcm
  return gainPcm(pcm, dbToGain(targetDb - db))
}

// ---------------------------------------------------------------- 变体

export interface SynthVariantSettings {
  /** 生成数量 */
  count: number
  /** 基频随机范围（±音分） */
  pitchCents: number
  /** 时长随机范围（±占比 0-0.5） */
  durationRatio: number
  /** 包络随机范围（±占比 0-0.5） */
  envelopeRatio: number
  /** 亮度随机范围（± 0-0.5） */
  tone: number
  seed: number
  dedupe: boolean
}

export const DEFAULT_SYNTH_VARIANTS: SynthVariantSettings = {
  count: 6,
  pitchCents: 45,
  durationRatio: 0.12,
  envelopeRatio: 0.25,
  tone: 0.1,
  seed: 2026,
  dedupe: true,
}

export interface SynthCandidate {
  index: number
  /** 变体标识，用于文件命名，如 v1_+42ct_-8% */
  tag: string
  params: SynthParams
  pcm: AudioPcm
}

function signed(rng: () => number, range: number): number {
  return (rng() * 2 - 1) * range
}

function clampValue(value: number, range: SynthRange): number {
  if (!Number.isFinite(value)) return range.min
  return Math.min(range.max, Math.max(range.min, value))
}

interface Jitter {
  /** 各维度的归一化偏移（-1..1），用于判断两个变体是否过于接近 */
  vector: number[]
  params: SynthParams
}

function makeJitter(preset: SynthPreset, base: SynthParams, settings: SynthVariantSettings, rng: () => number): Jitter {
  const drift = {
    pitch: signed(rng, 1),
    duration: signed(rng, 1),
    envelope: signed(rng, 1),
    tone: signed(rng, 1),
  }
  const freq = base.baseFreq * Math.pow(2, (drift.pitch * settings.pitchCents) / 1200)
  const duration = base.durationSec * (1 + drift.duration * settings.durationRatio)
  const envelopeScale = 1 + drift.envelope * settings.envelopeRatio
  const tone = clamp01(base.tone + drift.tone * settings.tone)
  const rangesOf = preset.ranges

  return {
    vector: [drift.pitch, drift.duration, drift.envelope, drift.tone],
    params: {
      baseFreq: clampValue(freq, rangesOf.baseFreq),
      durationSec: clampValue(duration, rangesOf.durationSec),
      attackSec: clampValue(base.attackSec * envelopeScale, rangesOf.attackSec),
      decaySec: clampValue(base.decaySec * envelopeScale, rangesOf.decaySec),
      pitchSemitones: clampValue(
        base.pitchSemitones + signed(rng, GLIDE_JITTER_SEMITONES),
        rangesOf.pitchSemitones,
      ),
      tone,
    },
  }
}

function distance(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum)
}

function formatTag(index: number, params: SynthParams, base: SynthParams): string {
  const cents = Math.round(1200 * Math.log2(params.baseFreq / base.baseFreq))
  const pitchTag = `${cents >= 0 ? '+' : ''}${cents}ct`
  const ratio = Math.round((params.durationSec / base.durationSec - 1) * 100)
  const durationTag = `${ratio >= 0 ? '+' : ''}${ratio}%`
  return `v${index + 1}_${pitchTag}_${durationTag}`
}

/**
 * 生成 N 个变体。
 *
 * 抖动作用在**合成参数**上（而不是像批量变体那样后处理已有音频），
 * 这样每个变体是独立合成出来的，音色差异比后期微调明显得多。
 * 去重按抖动向量的距离判断：波形指纹对同源变体几乎恒等，用它去重会把变体全部误杀。
 * 重掷仍找不到足够差异时也照常产出，保证数量恒等于 N。
 */
export function generateSynthCandidates(
  preset: SynthPreset,
  base: SynthParams,
  settings: SynthVariantSettings,
  rate: number,
): SynthCandidate[] {
  const count = Math.max(1, Math.min(24, Math.round(settings.count)))
  const rng = createRng(settings.seed + 1)
  const accepted: number[][] = []
  const candidates: SynthCandidate[] = []

  for (let index = 0; index < count; index++) {
    let jitter = makeJitter(preset, base, settings, rng)
    if (settings.dedupe) {
      for (let attempt = 0; attempt < VARIANT_RETRY; attempt++) {
        const tooClose = accepted.some((item) => distance(item, jitter.vector) < VARIANT_MIN_DISTANCE)
        if (!tooClose) break
        jitter = makeJitter(preset, base, settings, rng)
      }
    }
    accepted.push(jitter.vector)
    candidates.push({
      index,
      tag: formatTag(index, jitter.params, base),
      params: jitter.params,
      pcm: renderSynth(preset, jitter.params, rate, settings.seed + index * 131 + 1),
    })
  }
  return candidates
}