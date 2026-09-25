import type { VideoFrame } from '@/store/workspace'

/**
 * 视频抽帧核心逻辑。
 * 从 VideoPage 迁移而来，一键处理流水线（frame-pipeline）与视频帧页共用同一份实现。
 */

/** 抽帧参数：与 workspace.video 的抽帧字段一一对应，显式传入便于纯函数化 */
export interface ExtractOptions {
  mode: 'count' | 'fps'
  count: number
  targetFps: number
  start: number
  end: number
  flipX: boolean
  rotation: 0 | 90 | 180 | 270
}

/** 取消令牌：流水线各步骤通过轮询 cancelled 提前退出，保留已完成的结果 */
export interface CancelToken {
  cancelled: boolean
}

/** 从任意包含抽帧字段的对象（如 workspace.video）中提取抽帧参数，避免各调用点重复拼装 */
export function extractOptionsFrom(source: ExtractOptions): ExtractOptions {
  return {
    mode: source.mode,
    count: source.count,
    targetFps: source.targetFps,
    start: source.start,
    end: source.end,
    flipX: source.flipX,
    rotation: source.rotation,
  }
}

/** 创建取消令牌 */
export function createCancelToken(): CancelToken {
  return { cancelled: false }
}

/** 按抽帧参数推算实际抽取的帧数 */
export function expectedFrameCount(options: ExtractOptions): number {
  if (options.mode === 'count') return options.count
  return Math.max(1, Math.floor((options.end - options.start) * options.targetFps) + 1)
}

/** 校验抽帧参数，返回错误提示（空串表示参数合法；未导入视频时不提示） */
export function extractRangeError(options: ExtractOptions, duration: number, hasSource: boolean): string {
  if (!hasSource) return ''
  if (options.start < 0 || options.end < 0) return '时间不能小于 0'
  if (options.start > options.end) return '开始时间不能大于结束时间'
  if (options.end > duration) return '结束时间不能超过视频时长'
  if (options.mode === 'count' && (!Number.isInteger(options.count) || options.count < 1)) return '目标帧数必须为正整数'
  return ''
}

/** 把视频当前画面按翻转/旋转绘制为一帧，尺寸保持视频原始分辨率 */
export function captureFrame(element: HTMLVideoElement, timestamp: number, options: ExtractOptions): VideoFrame {
  const sourceW = element.videoWidth
  const sourceH = element.videoHeight
  const rotated = options.rotation === 90 || options.rotation === 270
  const canvas = document.createElement('canvas')
  canvas.width = rotated ? sourceH : sourceW
  canvas.height = rotated ? sourceW : sourceH
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.save()
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(options.rotation * Math.PI / 180)
  ctx.scale(options.flipX ? -1 : 1, 1)
  ctx.drawImage(element, -sourceW / 2, -sourceH / 2, sourceW, sourceH)
  ctx.restore()
  return { id: `${timestamp}-${Math.random()}`, url: canvas.toDataURL('image/png'), timestamp, selected: true }
}

/**
 * 跳转到指定时间点并等待该帧解码完成。
 * 注意：设置 currentTime 后立即读取该属性会直接返回目标值，
 * 轮询 currentTime 无法判断跳转是否完成，必须在 seeked 事件后再绘制，
 * 否则 canvas 会取到上一帧，导致抽出的所有帧完全相同。
 */
export function seekTo(element: HTMLVideoElement, timestamp: number): Promise<void> {
  if (Math.abs(element.currentTime - timestamp) < 0.001) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    let timer = 0
    const finish = (): void => {
      if (settled) return
      settled = true
      element.removeEventListener('seeked', finish)
      window.clearTimeout(timer)
      // 再等一帧渲染，确保 canvas 绘制到跳转后的画面
      window.requestAnimationFrame(() => resolve())
    }
    element.addEventListener('seeked', finish)
    timer = window.setTimeout(finish, 5000)
    element.currentTime = timestamp
  })
}

/**
 * 按参数逐帧抽取并返回帧列表。
 * 每抽完一帧回调一次进度；token.cancelled 为 true 时提前结束并返回已抽出的帧。
 */
export async function extractFrames(
  element: HTMLVideoElement,
  options: ExtractOptions,
  onProgress?: (done: number, total: number) => void,
  token?: CancelToken,
): Promise<VideoFrame[]> {
  // 暂停播放，避免播放进度与跳转时间相互干扰导致取到错误的帧
  element.pause()
  const total = expectedFrameCount(options)
  const step = total > 1 ? (options.end - options.start) / (total - 1) : 0
  const frames: VideoFrame[] = []
  for (let index = 0; index < total; index += 1) {
    if (token?.cancelled) break
    const timestamp = Math.min(options.end, options.start + step * index)
    await seekTo(element, timestamp)
    frames.push(captureFrame(element, timestamp, options))
    onProgress?.(frames.length, total)
  }
  return frames
}