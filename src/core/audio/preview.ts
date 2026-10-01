/**
 * 时间轴试听。
 *
 * 不走「编码 WAV → blob URL → <audio>」那条路：一条几分钟的立体声浮点 WAV
 * 动辄上百 MB，编码开销和驻留内存都不划算。这里直接把混音后的 PCM 采样
 * 塞进 AudioBuffer 播放，并复用同一份 Float32Array，不额外复制整段音频。
 */

import type { AudioPcm } from './pcm'

export class PcmPlayer {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private pending: AudioPcm | null = null
  private source: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null
  private raf = 0
  private startCtxTime = 0
  private startOffset = 0
  private stopped = false

  playing = false
  onTick: ((sec: number) => void) | null = null
  onEnd: (() => void) | null = null

  /** 换一份新内容；正在播放的旧内容先停掉 */
  setPcm(pcm: AudioPcm | null): void {
    this.stop()
    this.buffer = null
    this.pending = pcm
  }

  get durationSec(): number {
    if (this.buffer) return this.buffer.duration
    const pcm = this.pending
    return pcm && pcm.sampleRate > 0 ? pcm.length / pcm.sampleRate : 0
  }

  get position(): number {
    if (!this.playing || !this.ctx) return this.startOffset
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime)
  }

  play(fromSec = 0): void {
    if (this.playing) this.teardown()
    const buffer = this.ensureBuffer()
    if (!buffer) return
    const ctx = this.ensureContext()
    void ctx.resume()

    const node = ctx.createBufferSource()
    node.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = 1
    node.connect(gain)
    gain.connect(ctx.destination)

    const offset = Math.max(0, Math.min(fromSec, buffer.duration))
    this.stopped = false
    node.onended = () => {
      // 手动停止时 onended 也会触发，用 stopped 把它和「自然播完」区分开
      if (this.source === node && !this.stopped) this.finish()
    }
    node.start(0, offset)

    this.source = node
    this.gain = gain
    this.startCtxTime = ctx.currentTime
    this.startOffset = offset
    this.playing = true
    this.loop()
  }

  pause(): void {
    if (!this.playing) return
    const at = this.position
    this.teardown()
    this.startOffset = at
    this.onTick?.(at)
  }

  stop(): void {
    this.teardown()
    this.startOffset = 0
    this.onTick?.(0)
  }

  seek(sec: number): void {
    const at = Math.max(0, Math.min(sec, this.durationSec))
    if (this.playing) {
      this.play(at)
      return
    }
    this.startOffset = at
    this.onTick?.(at)
  }

  dispose(): void {
    this.teardown()
    void this.ctx?.close()
    this.ctx = null
    this.buffer = null
    this.pending = null
  }

  private teardown(): void {
    this.stopped = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.playing = false
    const node = this.source
    this.source = null
    if (node) {
      node.onended = null
      try {
        node.stop()
      } catch {
        /* 尚未 start 或已停止时忽略 */
      }
      node.disconnect()
    }
    this.gain?.disconnect()
    this.gain = null
  }

  private finish(): void {
    const total = this.durationSec
    this.teardown()
    this.startOffset = total
    this.onTick?.(total)
    this.onEnd?.()
  }

  private loop = (): void => {
    if (!this.playing) return
    this.onTick?.(this.position)
    this.raf = requestAnimationFrame(this.loop)
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    return this.ctx
  }

  private ensureBuffer(): AudioBuffer | null {
    if (this.buffer) return this.buffer
    const pcm = this.pending
    if (!pcm || pcm.length === 0) return null
    const ctx = this.ensureContext()
    const channels = Math.max(1, pcm.channels.length)
    // AudioBuffer 允许自带采样率，与 AudioContext 不一致时由 Web Audio 自行重采样
    const buffer = ctx.createBuffer(channels, pcm.length, pcm.sampleRate)
    for (let c = 0; c < channels; c++) {
      buffer.copyToChannel(pcm.channels[Math.min(c, pcm.channels.length - 1)], c)
    }
    this.buffer = buffer
    this.pending = null
    return buffer
  }
}
