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
  /** true 表示源文件是视频，当前 PCM 是从中提取的音轨 */
  extracted: boolean
}

const DEFAULT_RATE = 48000
const MIN_RATE = 8000
const MAX_RATE = 96000

/** 读取文件头用于探测（ID3 等标签可能很长，留 256KB 余量） */
const PROBE_BYTES = 256 * 1024

export async function decodeAudioFile(file: File | Blob, fileName = ''): Promise<DecodeResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('文件为空')

  // 准入判定用完整字节：moov 可能在文件尾部，只看探测窗口会漏判（文件已全量读入，遍历盒头开销可忽略）
  const media = assertImportableMedia(bytes, file, fileName)
  const probe = bytes.subarray(0, Math.min(PROBE_BYTES, bytes.byteLength))
  const probeResult = detectFormat(probe)
  let container = probeResult?.container ?? guessContainer(fileName)
  if (media.extracted) container = media.containerKey

  if (probeResult?.container === 'wav') {
    return { pcm: decodeWav(bytes), detectedRate: true, container, extracted: media.extracted }
  }

  const rate = sanitizeRate(probeResult?.sampleRate ?? 0)
  const pcm = await decodeWithBrowser(bytes, rate)
  if (pcm.length === 0) throw new Error('解码结果为空')
  return { pcm, detectedRate: rate > 0, container, extracted: media.extracted }
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

  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i]
    try {
      // decodeAudioData 会转移（detach）传入的 ArrayBuffer，每次尝试都必须给一份全新副本，
      // 否则首个上下文解码失败后，后续重试会在 slice 时抛「detached ArrayBuffer」
      const copy = payload.slice(0)
      const audioBuffer = await ctx.decodeAudioData(copy)
      return fromAudioBuffer(audioBuffer)
    } catch {
      // 继续尝试下一个上下文，全部失败再给简短错误
    } finally {
      if (ctx instanceof AudioContext) void ctx.close()
    }
  }
  throw new Error('无法解码，请转成 MP4 / WAV / MP3 等常见格式')
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

/**
 * 导入准入。
 *
 * 音频文件直接放行；浏览器能从容器里解出音轨的视频（MP4 / MOV / WebM）也放行，
 * 后续链路只使用提取出的 PCM。浏览器无法解码的视频容器（AVI / FLV / WMV /
 * MPEG-PS / MPEG-TS）在这里提前给出简短错误。MP4 若只有视频轨没有音轨同样拒绝。
 * macOS 的 .m4a 与 .mp4 共用同一个 UTI，文件选择器靠 accept 分不开，所以按文件头判断。
 */
function assertImportableMedia(
  bytes: Uint8Array,
  file: File | Blob,
  fileName: string,
): { extracted: boolean; containerKey: string } {
  const unsupported = detectUnsupportedVideo(bytes)
  if (unsupported) throw new Error(`格式不支持（${unsupported}），请转为 MP4 或 WebM`)

  if (isMatroska(bytes)) {
    // Chromium 可直接解出 WebM 里的 Opus/Vorbis 音轨；是否真有音轨交给解码器验证
    const looksVideo = file.type.startsWith('video/') || /\.(webm|mkv)$/i.test(fileName)
    return { extracted: looksVideo, containerKey: 'webm-track' }
  }

  if (!matchAscii(bytes, 4, 'ftyp')) return { extracted: false, containerKey: '' }

  // MP4 / MOV 家族：moov 里同时有 vide / soun 轨时按「视频提取音轨」处理
  const tracks = inspectMp4Tracks(bytes)
  if (tracks && tracks.hasVideo && !tracks.hasAudio) throw new Error('没有音轨')
  const extracted = tracks ? tracks.hasVideo : file.type.startsWith('video/')
  return { extracted, containerKey: 'mp4-track' }
}

/** 头部魔数就能断定、且浏览器解不出音轨的视频容器 */
function detectUnsupportedVideo(bytes: Uint8Array): string {
  if (matchAscii(bytes, 0, 'RIFF') && matchAscii(bytes, 8, 'AVI ')) return 'AVI'
  if (matchAscii(bytes, 0, 'FLV')) return 'FLV'
  if (bytes.length >= 4 && bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75) {
    return 'WMV'
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0xba) {
    return 'MPEG 视频'
  }
  // 传输流：每 188 字节一个同步字节
  if (bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) return 'MPEG-TS'
  return ''
}

function isMatroska(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
}

/** 可继续向下递归的 MP4 容器盒 */
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia'])

/**
 * 解析 MP4 / MOV 的轨道类型。
 * 返回 null 表示整份字节里都没有 moov（分片 mp4），无法判断。
 */
function inspectMp4Tracks(bytes: Uint8Array): { hasVideo: boolean; hasAudio: boolean } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset, false)
    let headerSize = 8
    if (size === 1 && offset + 16 <= bytes.length) {
      // 64 位 largesize
      size = view.getUint32(offset + 8, false) * 2 ** 32 + view.getUint32(offset + 12, false)
      headerSize = 16
    }
    const bodyEnd = size === 0 ? bytes.length : Math.min(bytes.length, offset + size)
    if (bodyEnd <= offset + headerSize) break
    if (ascii4(view, offset + 4) === 'moov') {
      const handlers: string[] = []
      collectMp4Handlers(bytes, offset + headerSize, bodyEnd, handlers)
      return { hasVideo: handlers.includes('vide'), hasAudio: handlers.includes('soun') }
    }
    offset = bodyEnd
  }
  return null
}

/** 收集容器盒内所有 hdlr 的 handler_type（audio / vide / …） */
function collectMp4Handlers(bytes: Uint8Array, start: number, end: number, out: string[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = start
  while (offset + 8 <= end) {
    const size = view.getUint32(offset, false)
    const type = ascii4(view, offset + 4)
    const bodyStart = offset + 8
    const bodyEnd = size === 0 ? end : Math.min(end, offset + size)
    if (bodyEnd <= bodyStart) return
    if (type === 'hdlr') {
      // version+flags(4) + pre_defined(4) 之后是 handler_type
      if (bodyStart + 12 <= bodyEnd) out.push(ascii4(view, bodyStart + 8))
    } else if (MP4_CONTAINERS.has(type)) {
      collectMp4Handlers(bytes, bodyStart, bodyEnd, out)
    }
    offset = bodyEnd
  }
}

function ascii4(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  )
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
  // mdhd 只可能在 moov/trak/mdia 容器里，从根递归找即可
  return findMp4Box(bytes, 0, bytes.length, 'mdhd') ?? 0
}

/** 在 [start,end) 内递归查找目标 box，命中 mdhd 时取 timescale 作为采样率 */
function findMp4Box(bytes: Uint8Array, start: number, end: number, target: string): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = start
  while (offset + 8 <= end) {
    let size = view.getUint32(offset, false)
    let headerSize = 8
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7),
    )
    // size===1 表示实际长度在 64 位 largesize 里；size===0 表示 box 一直延伸到文件尾
    if (size === 1 && offset + 16 <= end) {
      const high = view.getUint32(offset + 8, false)
      const low = view.getUint32(offset + 12, false)
      size = high * 2 ** 32 + low
      headerSize = 16
    }
    const bodyStart = offset + headerSize
    const bodyEnd = size === 0 ? end : Math.min(end, offset + size)
    if (!Number.isFinite(size) || bodyEnd <= bodyStart) return null
    if (type === target) {
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
  if (ext === 'm4a' || ext === 'aac' || ext === 'mp4' || ext === 'mov') return 'm4a'
  if (ext === 'aiff' || ext === 'aif') return 'aiff'
  if (ext === 'wav') return 'wav'
  if (ext === 'webm' || ext === 'mkv') return 'webm'
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
  webm: 'WEBM',
  'mp4-track': 'MP4 视频音轨',
  'webm-track': 'WebM 视频音轨',
}

export { DEFAULT_RATE }
