/**
 * 导出编码。
 *
 * WAV 由本项目自带实现（无依赖、可控位深）；MP3 与 OGG(Vorbis) 走 `wasm-media-encoders`
 * 的 WASM 编码器，采用动态 import，未选择对应格式时不会进入首屏包。
 */

import { type AudioPcm } from './pcm'
import { encodeWav, type WavEncoding } from './wav'
import type { ProcessContext } from './dsp'

export type AudioFormat = 'wav' | 'mp3' | 'ogg'

export interface FormatInfo {
  format: AudioFormat
  label: string
  extension: string
  mimeType: string
  available: boolean
  /** 不可用时的说明 */
  hint?: string
}

/**
 * 可用格式清单。
 * 只保留游戏引擎可导入的格式：wav / mp3 / ogg(vorbis) 是 Unity、Unreal、Godot 的共同交集。
 * opus 仅 Unreal 支持导入，aac(M4A) 三大引擎均不支持，对游戏工具没有交付价值，已从清单移除。
 */
export const AUDIO_FORMATS: FormatInfo[] = [
  { format: 'wav', label: 'WAV', extension: 'wav', mimeType: 'audio/wav', available: true },
  { format: 'ogg', label: 'OGG (Vorbis)', extension: 'ogg', mimeType: 'audio/ogg', available: true },
  { format: 'mp3', label: 'MP3', extension: 'mp3', mimeType: 'audio/mpeg', available: true },
]

/** MP3 支持的码率档位 */
export const MP3_BITRATES = [128, 192, 256, 320]

/** MP3 编码器支持的采样率，其余需先重采样 */
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]

export interface EncodeOptions {
  format: AudioFormat
  /** WAV 位深与样本格式 */
  wavEncoding: WavEncoding
  /** MP3 CBR 码率（kbps） */
  mp3Bitrate: number
  /** OGG Vorbis 质量（0-10，越大越好） */
  oggQuality: number
}

export interface EncodeResult {
  bytes: Uint8Array
  extension: string
  mimeType: string
}

/** 每次送入编码器的样本数：分片既能推进进度，也避免一次性长任务卡住主线程 */
const ENCODE_CHUNK = 1 << 18

export async function encodeAudio(
  pcm: AudioPcm,
  options: EncodeOptions,
  ctx?: ProcessContext,
): Promise<EncodeResult> {
  const info = AUDIO_FORMATS.find((item) => item.format === options.format)
  if (!info) throw new Error(`不支持的导出格式：${options.format}`)
  if (!info.available) throw new Error(`${info.label} 暂不可用：${info.hint ?? '无可用编码器'}`)

  if (options.format === 'wav') {
    ctx?.onProgress?.(1)
    return { bytes: encodeWav(pcm, options.wavEncoding), extension: 'wav', mimeType: 'audio/wav' }
  }
  if (pcm.channels.length > 2) {
    throw new Error('MP3 / OGG 仅支持单声道或立体声，请先设置声道转换')
  }

  const module = await loadEncoderModule()
  const encoder = options.format === 'mp3' ? await module.createMp3Encoder() : await module.createOggEncoder()
  if (options.format === 'mp3') {
    if (!MP3_SAMPLE_RATES.includes(pcm.sampleRate)) {
      throw new Error(`MP3 不支持 ${pcm.sampleRate} Hz，请把采样率改为 44100 或 48000`)
    }
    encoder.configure({
      channels: pcm.channels.length as 1 | 2,
      sampleRate: pcm.sampleRate,
      bitrate: options.mp3Bitrate as 128,
    })
  } else {
    encoder.configure({
      channels: pcm.channels.length as 1 | 2,
      sampleRate: pcm.sampleRate,
      vbrQuality: options.oggQuality,
    })
  }

  const parts: Uint8Array[] = []
  let written = 0
  for (let start = 0; start < pcm.length; start += ENCODE_CHUNK) {
    if (ctx?.isCancelled?.()) throw new Error('已取消')
    const end = Math.min(pcm.length, start + ENCODE_CHUNK)
    const chunk = pcm.channels.map((channel) => channel.subarray(start, end))
    // encode() 返回的是编码器内部缓冲区视图，下一次调用会覆盖，必须切片复制后再留存
    const encoded = encoder.encode(chunk)
    if (encoded.length > 0) parts.push(encoded.slice())
    written = end
    ctx?.onProgress?.(written / pcm.length)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const tail = encoder.finalize()
  if (tail.length > 0) parts.push(tail.slice())

  return { bytes: concatBytes(parts), extension: info.extension, mimeType: info.mimeType }
}

type EncoderModule = typeof import('wasm-media-encoders')

let encoderModulePromise: Promise<EncoderModule> | null = null

/**
 * 动态引入编码器包（内含 base64 WASM），只在真正需要压缩格式时加载。
 * 失败时不缓存失败态：dev 下服务重启或依赖重新预构建会让旧 URL 失效，
 * 若把 rejected promise 一直留着，页面此后每次导出都会失败，只能刷新才能恢复。
 */
function loadEncoderModule(): Promise<EncoderModule> {
  encoderModulePromise ??= import('wasm-media-encoders').catch((error: unknown) => {
    encoderModulePromise = null
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`音频编码器加载失败（${detail}）。若页面已长时间未刷新，请刷新页面后重试。`)
  })
  return encoderModulePromise
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
