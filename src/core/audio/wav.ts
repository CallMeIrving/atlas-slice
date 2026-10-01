/**
 * WAV 容器编解码。
 *
 * 编码：把内存 PCM 写成 RIFF/WAVE，支持 16 / 24 位整数与 32 位浮点。
 * 解码：作为浏览器 `decodeAudioData` 的兜底与无依赖测试入口，覆盖 PCM 与 IEEE float 两种 fmt。
 */

import { createPcm, type AudioPcm, type PcmBitDepth } from './pcm'

export type WavEncoding = 'pcm16' | 'pcm24' | 'float32'

/** 编码格式对应的位深，供界面展示与元数据使用 */
export const WAV_BIT_DEPTH: Record<WavEncoding, PcmBitDepth> = {
  pcm16: 16,
  pcm24: 24,
  float32: 32,
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/**
 * 把 PCM 编码为 WAV 字节流。
 * 整数格式按 [-1,1) 映射到满量程并做上下限钳制，避免浮点越界回绕成反相信号。
 */
export function encodeWav(pcm: AudioPcm, encoding: WavEncoding): Uint8Array {
  const channelCount = pcm.channels.length
  const isFloat = encoding === 'float32'
  const bytesPerSample = encoding === 'pcm16' ? 2 : encoding === 'pcm24' ? 3 : 4
  const blockAlign = channelCount * bytesPerSample
  const dataBytes = pcm.length * blockAlign
  // 浮点格式需要 fact chunk（8 字节头 + 4 字节采样数），整数格式不需要
  const factBytes = isFloat ? 12 : 0
  const headerBytes = 44 + factBytes
  const buffer = new ArrayBuffer(headerBytes + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, headerBytes + dataBytes - 8, true)
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, isFloat ? 3 : 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, pcm.sampleRate, true)
  view.setUint32(28, pcm.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)

  let dataOffset = 36
  if (isFloat) {
    writeAscii(view, 36, 'fact')
    view.setUint32(40, 4, true)
    view.setUint32(44, pcm.length, true)
    dataOffset = 48
  }
  writeAscii(view, dataOffset, 'data')
  view.setUint32(dataOffset + 4, dataBytes, true)

  const sampleOffset = dataOffset + 8
  const { channels, length } = pcm
  if (encoding === 'pcm16') {
    let offset = sampleOffset
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channelCount; c++) {
        view.setInt16(offset, floatToInt(channels[c][i], 32767, -32768), true)
        offset += 2
      }
    }
  } else if (encoding === 'pcm24') {
    let offset = sampleOffset
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channelCount; c++) {
        const value = floatToInt(channels[c][i], 8388607, -8388608)
        view.setUint8(offset, value & 0xff)
        view.setUint8(offset + 1, (value >> 8) & 0xff)
        view.setUint8(offset + 2, (value >> 16) & 0xff)
        offset += 3
      }
    }
  } else {
    let offset = sampleOffset
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channelCount; c++) {
        view.setFloat32(offset, channels[c][i], true)
        offset += 4
      }
    }
  }
  return new Uint8Array(buffer)
}

function floatToInt(value: number, max: number, min: number): number {
  const scaled = value < 0 ? value * -min : value * max
  const rounded = Math.round(scaled)
  return Math.min(max, Math.max(min, rounded))
}

/**
 * 解析 WAV 字节流。
 * 只在浏览器解码失败时作为兜底，因此对未知 chunk 采取「跳过」策略而非报错。
 */
export function decodeWav(bytes: Uint8Array): AudioPcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('不是合法的 WAV 文件')
  }
  let format = 1
  let channelCount = 1
  let sampleRate = 44100
  let bitsPerSample = 16
  let dataOffset = -1
  let dataLength = 0

  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channelCount = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE：真实格式藏在 SubFormat 的前两个字节
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataOffset = body
      dataLength = Math.min(size, view.byteLength - body)
    }
    offset = body + size + (size % 2)
  }

  if (dataOffset < 0) throw new Error('WAV 缺少 data 块')
  if (channelCount < 1) throw new Error('WAV 声道数非法')

  const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8))
  const frames = Math.floor(dataLength / (bytesPerSample * channelCount))
  const pcm = createPcm(sampleRate, channelCount, frames)
  const isFloat = format === 3

  for (let c = 0; c < channelCount; c++) {
    const dst = pcm.channels[c]
    let cursor = dataOffset + c * bytesPerSample
    const stride = bytesPerSample * channelCount
    for (let i = 0; i < frames; i++) {
      dst[i] = readSample(view, cursor, bytesPerSample, isFloat)
      cursor += stride
    }
  }
  return pcm
}

function readSample(view: DataView, offset: number, bytesPerSample: number, isFloat: boolean): number {
  if (isFloat) {
    return bytesPerSample === 8 ? view.getFloat64(offset, true) : view.getFloat32(offset, true)
  }
  if (bytesPerSample === 1) return (view.getUint8(offset) - 128) / 128
  if (bytesPerSample === 2) return view.getInt16(offset, true) / 32768
  if (bytesPerSample === 3) {
    const raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
    const signed = raw & 0x800000 ? raw - 0x1000000 : raw
    return signed / 8388608
  }
  return view.getInt32(offset, true) / 2147483648
}

function readAscii(view: DataView, offset: number, size: number): string {
  let text = ''
  for (let i = 0; i < size; i++) text += String.fromCharCode(view.getUint8(offset + i))
  return text
}
