import { applyPalette, GIFEncoder, quantize } from 'gifenc'
import { releaseCanvas, loadImage } from '@/core/image'
import { createCancelToken, type CancelToken } from '@/core/frame-extract'
import { frameImageUrl, type VideoFrame } from '@/store/workspace'

/**
 * 视频帧 GIF 编码。
 * 逐帧读取 frameImageUrl（裁切 > 抠图 > 去水印 > 原图）的像素，
 * 每帧独立量化调色板；含透明像素的帧（抠图结果）保留透明并设置 dispose，避免残影。
 */

/** GIF 帧延迟下限（毫秒）；低于 20ms 会被浏览器按 100ms 处理，不如显式兜底 */
const MIN_DELAY_MS = 20
/** GIF 帧延迟上限（毫秒），防止异常时间戳导致播放停滞 */
const MAX_DELAY_MS = 10_000
/** 单帧调色板最大颜色数（GIF 规范上限） */
const MAX_COLORS = 256
/** 透明判定阈值：alpha 低于该值视为透明像素（与 oneBitAlpha 的取值保持一致） */
const ALPHA_THRESHOLD = 128

export interface GifEncodeOptions {
  /** 固定帧间隔（毫秒）；缺省时按相邻帧时间戳差推算 */
  delayMs?: number
  /** 取消令牌：置位后在下一帧编码前退出并抛出取消错误 */
  cancelToken?: CancelToken
  /** 编码进度回调（已完成帧数 / 总帧数） */
  onProgress?: (done: number, total: number) => void
}

/** 把帧延迟收敛到浏览器可靠播放的区间 */
function clampDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return MIN_DELAY_MS
  return Math.min(Math.max(ms, MIN_DELAY_MS), MAX_DELAY_MS)
}

/**
 * 推算每帧显示时长（毫秒）。
 * 优先使用固定值；否则取相邻帧时间戳差，末帧沿用前一间隔，单帧回落到 100ms。
 */
function computeDelays(frames: VideoFrame[], fixedDelay?: number): number[] {
  if (fixedDelay && fixedDelay > 0) return frames.map(() => clampDelay(fixedDelay))
  const lastGap = frames.length > 1
    ? (frames[frames.length - 1].timestamp - frames[frames.length - 2].timestamp) * 1000
    : 100
  return frames.map((frame, i) => {
    const next = frames[i + 1]
    const gap = next ? (next.timestamp - frame.timestamp) * 1000 : lastGap
    return clampDelay(gap)
  })
}

/** 把图像元素绘制到统一尺寸画布并取出 RGBA 像素，同时检测是否存在透明像素 */
function grabPixelsFromImage(image: HTMLImageElement, width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  const rgba = ctx.getImageData(0, 0, width, height).data
  releaseCanvas(canvas)
  let transparent = false
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < ALPHA_THRESHOLD) { transparent = true; break }
  }
  return { rgba, transparent }
}

/** 加载帧图像地址后取出像素 */
async function grabPixels(url: string, width: number, height: number) {
  const image = await loadImage(url, 'GIF 帧图像读取失败')
  return grabPixelsFromImage(image, width, height)
}

/** 编码单帧：按是否含透明选择量化格式，写入编码器 */
function encodeFrame(
  encoder: ReturnType<typeof GIFEncoder>,
  rgba: Uint8ClampedArray,
  transparent: boolean,
  width: number,
  height: number,
  delay: number,
): void {
  const palette = transparent
    ? quantize(rgba, MAX_COLORS, { format: 'rgba4444', oneBitAlpha: true })
    : quantize(rgba, MAX_COLORS)
  const index = applyPalette(rgba, palette, transparent ? 'rgba4444' : 'rgb565')
  const transparentIndex = transparent ? palette.findIndex((color) => (color[3] ?? 255) < ALPHA_THRESHOLD) : -1
  encoder.writeFrame(index, width, height, {
    palette,
    delay,
    transparent: transparentIndex >= 0,
    transparentIndex: Math.max(transparentIndex, 0),
    // 透明帧用 dispose=2（恢复背景）清除上一帧，不透明帧整幅覆盖无需清除
    dispose: transparentIndex >= 0 ? 2 : 1,
  })
}

/**
 * 把帧序列编码为 GIF Blob（无限循环播放）。
 * 尺寸以首帧为准，后续帧尺寸不一致时等比对齐；逐帧编码间让出主线程以便界面刷新进度。
 */
export async function framesToGifBlob(frames: VideoFrame[], options: GifEncodeOptions = {}): Promise<Blob> {
  if (!frames.length) throw new Error('没有可导出的帧')
  const token = options.cancelToken ?? createCancelToken()
  const first = await loadImage(frameImageUrl(frames[0]), 'GIF 帧图像读取失败')
  const width = first.naturalWidth
  const height = first.naturalHeight
  const delays = computeDelays(frames, options.delayMs)
  const encoder = GIFEncoder()
  for (let i = 0; i < frames.length; i++) {
    if (token.cancelled) throw new Error('已取消 GIF 导出')
    const { rgba, transparent } = i === 0
      ? await grabPixelsFromImage(first, width, height)
      : await grabPixels(frameImageUrl(frames[i]), width, height)
    encodeFrame(encoder, rgba, transparent, width, height, delays[i])
    options.onProgress?.(i + 1, frames.length)
    // 让出一次事件循环，避免大序列编码长时间阻塞界面
    await new Promise((resolve) => setTimeout(resolve))
  }
  encoder.finish()
  return new Blob([encoder.bytes()], { type: 'image/gif' })
}
