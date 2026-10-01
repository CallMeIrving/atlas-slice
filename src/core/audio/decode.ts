/**
 * 音频解码入口。
 *
 * 压缩格式交给浏览器 `decodeAudioData`；WAV 走本地解析，避免被上下文采样率隐式重采样。
 * 关键点：`decodeAudioData` 会把结果重采样到上下文采样率，因此先用文件头探测原始采样率，
 * 再用同采样率的 `OfflineAudioContext` 解码，尽量不做无谓的重采样。
 */

import { createPcm, type AudioPcm } from './pcm'
import { decodeWav } from './wav'

export interface DecodeResult {
  pcm: AudioPcm
  /** 是否从文件头成功探测到原始采样率；false 表示按浏览器默认采样率解码 */
  detectedRate: boolean
  /** 探测到的容器/编码名称，供界面展示 */
  container: string
}

const DEFAULT_RATE = 48000
const MIN_RATE = 8000
const MAX_RATE = 96000

/** 读取文件头用于探测（ID3 等标签可能很长，留 256KB 余量） */
const PROBE_BYTES = 256 * 1024

export async function decodeAudioFile(file: File | Blob, fileName = ''): Promise<DecodeResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('音频文件为空')

  const probe = bytes.subarray(0, Math.min(PROBE_BYTES, bytes.byteLength))
  const probeResult = detectFormat(probe)
  const container = probeResult?.container ?? guessContainer(fileName)

  if (probeResult?.container === 'wav') {
    return { pcm: decodeWav(bytes), detectedRate: true, container }
  }

  const rate = sanitizeRate(probeResult?.sampleRate ?? 0)
  const pcm = await decodeWithBrowser(bytes, rate)
  if (pcm.length === 0) throw new Error('解码结果为空，可能是浏览器不支持的音频格式')
  return { pcm, detectedRate: rate > 0, container }
}

function sanitizeRate(rate: number): number {
  if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) return 0
  return Math.round(rate)
}

/** 优先用离线上下文（不受自动播放策略影响）；不支持时退回普通 AudioContext */
async function decodeWithBrowser(bytes: Uint8Array, rate: number): Promise<AudioPcm> {
  const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const contexts: BaseAudioContext[] = []
  if (rate > 0) {
    try {
      contexts.push(new OfflineAudioContext(1, 1, rate))
    } catch {
      /* 采样率不被支持时走默认上下文 */
    }
  }
  try {
    contexts.push(new AudioContext())
  } catch {
    /* 忽略：没有可用上下文时直接报错 */
  }
  if (contexts.length === 0) throw new Error('当前浏览器不支持音频解码')

  let lastError: unknown = null
  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i]
    try {
      // 每个上下文只能消费一次 ArrayBuffer，后续尝试需要新的副本
      const copy = i === 0 ? payload : payload.slice(0)
      const audioBuffer = await ctx.decodeAudioData(copy)
      return fromAudioBuffer(audioBuffer)
    } catch (error) {
      lastError = error
    } finally {
      if (ctx instanceof AudioContext) void ctx.close()
    }
  }
  throw new Error(`浏览器无法解码该音频（${lastError instanceof Error ? lastError.message : '未知原因'}）`)
}

function fromAudioBuffer(buffer: AudioBuffer): AudioPcm {
  const pcm = createPcm(buffer.sampleRate, buffer.numberOfChannels, buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    buffer.copyFromChannel(pcm.channels[c], c)
  }
  return pcm
}

interface FormatProbe {
  container: string
  sampleRate: number
}

/** 按文件头字节识别容器并尽量取出原始采样率 */
export function detectFormat(bytes: Uint8Array): FormatProbe | null {
  if (matchAscii(bytes, 0, 'RIFF') && matchAscii(bytes, 8, 'WAVE')) {
    return { container: 'wav', sampleRate: readWavRate(bytes) }
  }
  if (matchAscii(bytes, 0, 'OggS')) return readOggHeader(bytes)
  if (matchAscii(bytes, 0, 'fLaC')) return { container: 'flac', sampleRate: readFlacRate(bytes) }
  if (matchAscii(bytes, 0, 'FORM') && (matchAscii(bytes, 8, 'AIFF') || matchAscii(bytes, 8, 'AIFC'))) {
    return { container: 'aiff', sampleRate: readAiffRate(bytes) }
  }
  if (matchAscii(bytes, 4, 'ftyp')) return { container: 'm4a', sampleRate: readMp4Rate(bytes) }

  // MP3 可能带 ID3v2 标签，也可能裸帧起始，放在最后按帧同步字识别
  const mp3Rate = readMp3Rate(bytes)
  if (mp3Rate > 0) return { container: 'mp3', sampleRate: mp3Rate }
  return null
}

function readWavRate(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
    )
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ' && offset + 8 + 16 <= view.byteLength) return view.getUint32(offset + 12, true)
    offset += 8 + size + (size % 2)
  }
  return 0
}

function readMp3Rate(bytes: Uint8Array): number {
  let offset = 0
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
    offset = 10 + size
  }
  for (let i = offset; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue
    const versionBits = (bytes[i + 1] >> 3) & 0x03
    const layerBits = (bytes[i + 1] >> 1) & 0x03
    const rateIndex = (bytes[i + 2] >> 2) & 0x03
    // version 01 与 layer 00 是保留值，rateIndex 11 非法
    if (versionBits === 1 || layerBits === 0 || rateIndex === 3) continue
    const table = versionBits === 3 ? [44100, 48000, 32000] : versionBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000]
    return table[rateIndex]
  }
  return 0
}

function readOggHeader(bytes: Uint8Array): FormatProbe {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 识别头紧跟在第一个 OggS 页头（27 字节）与其段表之后
  for (let i = 0; i + 16 < bytes.length; i++) {
    if (bytes[i] === 0x01 && matchAscii(bytes, i + 1, 'vorbis')) {
      // \x01vorbis + version(4) + channels(1) + sampleRate(4)
      return { container: 'ogg', sampleRate: i + 12 <= view.byteLength - 4 ? view.getUint32(i + 12, true) : 0 }
    }
    if (matchAscii(bytes, i, 'OpusHead')) {
      // OpusHead + version(1) + channels(1) + preskip(2) + inputSampleRate(4)
      const rate = i + 12 <= view.byteLength - 4 ? view.getUint32(i + 12, true) : 0
      return { container: 'opus', sampleRate: rate > 0 ? rate : 48000 }
    }
  }
  return { container: 'ogg', sampleRate: 0 }
}

function readFlacRate(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 4 + 4 + 18) return 0
  // "fLaC" 后是元数据块头；STREAMINFO 固定为第一个块（type 0）
  const header = bytes[4]
  if ((header & 0x7f) !== 0) return 0
  const body = 8
  const b0 = view.getUint8(body + 10)
  const b1 = view.getUint8(body + 11)
  const b2 = view.getUint8(body + 12)
  return (b0 << 12) | (b1 << 4) | (b2 >> 4)
}

function readAiffRate(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
    )
    const size = view.getUint32(offset + 4, false)
    if (id === 'COMM' && offset + 8 + 18 <= view.byteLength) return readExtendedFloat(view, offset + 8 + 8)
    offset += 8 + size + (size % 2)
  }
  return 0
}

/** AIFF 采样率是 80 位扩展浮点 */
function readExtendedFloat(view: DataView, offset: number): number {
  const exponent = view.getUint16(offset, false) & 0x7fff
  const high = view.getUint32(offset + 2, false)
  const low = view.getUint32(offset + 6, false)
  if (exponent === 0 && high === 0 && low === 0) return 0
  const mantissa = high * 4294967296 + low
  return mantissa * Math.pow(2, exponent - 16383 - 63)
}

function readMp4Rate(bytes: Uint8Array): number {
  return findMp4Box(bytes, 0, bytes.length, 'moov') ?? 0
}

/** 在 [start,end) 内递归查找目标 box，命中 mdhd 时取 timescale 作为采样率 */
function findMp4Box(bytes: Uint8Array, start: number, end: number, target: string): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = start
  while (offset + 8 <= end) {
    const size = view.getUint32(offset, false)
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7),
    )
    const bodyStart = offset + 8
    const bodyEnd = size === 0 ? end : Math.min(end, offset + size)
    if (!Number.isFinite(size) || bodyEnd <= bodyStart) return null
    if (type === target && target === 'mdhd') {
      const version = view.getUint8(bodyStart)
      // version 0：creation(4)+modification(4)+timescale(4)；version 1 各为 8 字节
      return version === 1 ? view.getUint32(bodyStart + 4 + 8 + 8, false) : view.getUint32(bodyStart + 4 + 4 + 4, false)
    }
    if (type === 'moov' || type === 'trak' || type === 'mdia') {
      const nested = findMp4Box(bytes, bodyStart, bodyEnd, target)
      if (nested !== null) return nested
    }
    offset = bodyEnd
  }
  return null
}

function matchAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

function guessContainer(fileName: string): string {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (ext === 'mp3') return 'mp3'
  if (ext === 'ogg' || ext === 'oga') return 'ogg'
  if (ext === 'opus') return 'opus'
  if (ext === 'flac') return 'flac'
  if (ext === 'm4a' || ext === 'aac' || ext === 'mp4') return 'm4a'
  if (ext === 'aiff' || ext === 'aif') return 'aiff'
  if (ext === 'wav') return 'wav'
  return ext || '未知'
}

/** 界面展示用的容器名（大写更接近用户认知） */
export const CONTAINER_LABEL: Record<string, string> = {
  wav: 'WAV',
  mp3: 'MP3',
  ogg: 'OGG',
  opus: 'OPUS',
  flac: 'FLAC',
  m4a: 'M4A',
  aiff: 'AIFF',
}

export { DEFAULT_RATE }
