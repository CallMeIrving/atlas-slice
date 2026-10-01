/**
 * 处理链、导出设置与平台规范预设的类型和内置值。
 *
 * 处理链按固定顺序作用，界面只控制「是否启用」与参数，不暴露顺序，
 * 避免出现「先归一化后变速」这类会改变结果语义的自由组合。
 */

import type { AudioFormat } from './encode'
import type { WavEncoding } from './wav'

/** 归一化方式：响度（EBU R128）或峰值 */
export type NormalizeMode = 'lufs' | 'peak'

export interface AudioChain {
  crop: { enabled: boolean; startSec: number; endSec: number }
  trimSilence: { enabled: boolean; thresholdDb: number; headSec: number; tailSec: number }
  speed: { enabled: boolean; factor: number }
  fade: { enabled: boolean; inSec: number; outSec: number }
  channels: { enabled: boolean; target: 1 | 2 }
  resample: { enabled: boolean; targetRate: number }
  normalize: {
    enabled: boolean
    mode: NormalizeMode
    targetLufs: number
    targetPeakDb: number
    maxTruePeakDb: number
  }
  limiter: { enabled: boolean; ceilingDb: number }
}

export interface ExportSettings {
  format: AudioFormat
  wavEncoding: WavEncoding
  mp3Bitrate: number
  oggQuality: number
  /** 命名模板：{name} / {preset} / {variant} / {index} / {ext} */
  nameTemplate: string
  /** 素材名冲突时是否追加序号 */
  ensureUnique: boolean
}

/** 只影响编码的参数：批量的命名模板对单文件导出没有意义，故单独拆出来 */
export type EncodeSettings = Pick<ExportSettings, 'format' | 'wavEncoding' | 'mp3Bitrate' | 'oggQuality'>

/** 合成导出的默认编码参数 */
export const DEFAULT_MIX_EXPORT: EncodeSettings = {
  format: 'wav',
  wavEncoding: 'pcm16',
  mp3Bitrate: 192,
  oggQuality: 5,
}

/** 处理链执行顺序，界面按此顺序展示步骤 */
export const CHAIN_ORDER: { key: keyof AudioChain; label: string }[] = [
  { key: 'crop', label: '精确裁剪' },
  { key: 'trimSilence', label: '静音头尾裁剪' },
  { key: 'speed', label: '变速' },
  { key: 'fade', label: '淡入淡出' },
  { key: 'channels', label: '声道转换' },
  { key: 'resample', label: '重采样' },
  { key: 'normalize', label: '响度 / 峰值标准化' },
  { key: 'limiter', label: '限幅' },
]

export const SAMPLE_RATES = [22050, 32000, 44100, 48000, 96000]

export const DEFAULT_CHAIN: AudioChain = {
  crop: { enabled: false, startSec: 0, endSec: 0 },
  trimSilence: { enabled: false, thresholdDb: -60, headSec: 0.01, tailSec: 0.05 },
  speed: { enabled: false, factor: 1 },
  fade: { enabled: false, inSec: 0.01, outSec: 0.05 },
  channels: { enabled: false, target: 2 },
  resample: { enabled: false, targetRate: 48000 },
  normalize: { enabled: false, mode: 'lufs', targetLufs: -16, targetPeakDb: -1, maxTruePeakDb: -1 },
  limiter: { enabled: false, ceilingDb: -1 },
}

export const DEFAULT_EXPORT: ExportSettings = {
  format: 'wav',
  wavEncoding: 'pcm16',
  mp3Bitrate: 192,
  oggQuality: 5,
  nameTemplate: '{name}',
  ensureUnique: true,
}

export interface PlatformPreset {
  id: string
  label: string
  description: string
  /** 应用后覆盖的处理链字段 */
  chain: Partial<AudioChain>
  /** 应用后覆盖的导出设置 */
  export: Partial<ExportSettings>
}

/**
 * 平台规范预设。
 * 目标是「一次点击即满足发布要求」：格式 + 采样率 + 声道 + 响度一并设置。
 */
export const PLATFORM_PRESETS: PlatformPreset[] = [
  {
    id: 'engine',
    label: '引擎通用',
    description: 'Unity / Godot 常用组合：OGG Vorbis、44.1kHz 立体声、-18 LUFS',
    chain: {
      channels: { enabled: true, target: 2 },
      resample: { enabled: true, targetRate: 44100 },
      normalize: { enabled: true, mode: 'lufs', targetLufs: -18, targetPeakDb: -1, maxTruePeakDb: -1 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
    export: { format: 'ogg', oggQuality: 5 },
  },
  {
    id: 'web',
    label: 'Web 网页',
    description: '浏览器兼容优先：MP3 192kbps、44.1kHz 立体声、-16 LUFS',
    chain: {
      channels: { enabled: true, target: 2 },
      resample: { enabled: true, targetRate: 44100 },
      normalize: { enabled: true, mode: 'lufs', targetLufs: -16, targetPeakDb: -1, maxTruePeakDb: -1 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
    export: { format: 'mp3', mp3Bitrate: 192 },
  },
  {
    id: 'android',
    label: 'Android',
    description: 'OGG Vorbis、48kHz 立体声、-16 LUFS；Android 原生支持 OGG',
    chain: {
      channels: { enabled: true, target: 2 },
      resample: { enabled: true, targetRate: 48000 },
      normalize: { enabled: true, mode: 'lufs', targetLufs: -16, targetPeakDb: -1, maxTruePeakDb: -1 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
    export: { format: 'ogg', oggQuality: 5 },
  },
  {
    id: 'ios',
    label: 'iOS',
    description: 'iOS 原生解码 MP3 / WAV：MP3 192kbps、44.1kHz 立体声、-16 LUFS',
    chain: {
      channels: { enabled: true, target: 2 },
      resample: { enabled: true, targetRate: 44100 },
      normalize: { enabled: true, mode: 'lufs', targetLufs: -16, targetPeakDb: -1, maxTruePeakDb: -1 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
    export: { format: 'mp3', mp3Bitrate: 192 },
  },
  {
    id: 'console',
    label: '主机 / 母版',
    description: '无损归档：WAV 24bit、48kHz 立体声、-23 LUFS（接近 EBU R128 广播标准）',
    chain: {
      channels: { enabled: true, target: 2 },
      resample: { enabled: true, targetRate: 48000 },
      normalize: { enabled: true, mode: 'lufs', targetLufs: -23, targetPeakDb: -1, maxTruePeakDb: -1 },
      limiter: { enabled: false, ceilingDb: -1 },
    },
    export: { format: 'wav', wavEncoding: 'pcm24' },
  },
  {
    id: 'ui-sfx',
    label: 'UI 音效',
    description: '轻量单声道：OGG Vorbis、44.1kHz 单声道、-20 LUFS、真峰值 -3 dBTP',
    chain: {
      channels: { enabled: true, target: 1 },
      resample: { enabled: true, targetRate: 44100 },
      normalize: { enabled: true, mode: 'lufs', targetLufs: -20, targetPeakDb: -3, maxTruePeakDb: -3 },
      limiter: { enabled: true, ceilingDb: -3 },
    },
    export: { format: 'ogg', oggQuality: 4 },
  },
]

export function cloneChain(chain: AudioChain): AudioChain {
  return {
    crop: { ...chain.crop },
    trimSilence: { ...chain.trimSilence },
    speed: { ...chain.speed },
    fade: { ...chain.fade },
    channels: { ...chain.channels },
    resample: { ...chain.resample },
    normalize: { ...chain.normalize },
    limiter: { ...chain.limiter },
  }
}

export function cloneExport(settings: ExportSettings): ExportSettings {
  return { ...settings }
}
