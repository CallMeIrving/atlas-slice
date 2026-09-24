import { nextTick } from 'vue'
import { clampCropRect, cropImageToDataUrl, type ImageCropRect } from '@/core/crop'
import { loadImage } from '@/core/image'
import { frameBaseUrl, type VideoFrame } from '@/store/workspace'
import type { CancelToken } from '@/core/frame-extract'

/**
 * 视频帧裁切核心逻辑。
 * 批量裁切弹窗与一键处理流水线共用；`recropFrame` 是「抠图结果变化后重算裁切」的唯一实现。
 */

/** 裁切矩形是否覆盖整帧（整帧范围等价于未裁切） */
export function isFullFrameRect(rect: ImageCropRect, width: number, height: number): boolean {
  return rect.x === 0 && rect.y === 0 && rect.width === width && rect.height === height
}

/**
 * 按 frame.crop 重算裁切结果。
 * 裁切叠加在抠图结果之上，抠图结果变化后必须用新画面重算，
 * 否则帧列表与导出仍会显示上一次裁切出的旧图像。
 */
export async function recropFrame(frame: VideoFrame): Promise<void> {
  if (!frame.crop) {
    frame.cropUrl = undefined
    return
  }
  const image = await loadImage(frameBaseUrl(frame))
  frame.cropUrl = cropImageToDataUrl(image, clampCropRect(frame.crop, image.naturalWidth, image.naturalHeight))
}

/** 清除全部帧的裁切结果，恢复为裁切前的画面 */
export function clearFrameCrop(frames: VideoFrame[]): void {
  frames.forEach((frame) => {
    frame.crop = undefined
    frame.cropUrl = undefined
  })
}

/**
 * 把同一裁切区域应用到全部帧（带进度、可取消）。
 * rect 为空时等价于清除裁切；矩形收敛后覆盖整帧时也按清除处理，
 * 这样调用方无需知道每帧的实际像素尺寸。
 * @returns 实际处理完成的帧数
 */
export async function applyCropToFrames(
  frames: VideoFrame[],
  rect: ImageCropRect | null,
  onProgress?: (done: number, total: number) => void,
  token?: CancelToken,
): Promise<number> {
  if (!rect) {
    clearFrameCrop(frames)
    return 0
  }
  let done = 0
  for (const frame of frames) {
    if (token?.cancelled) break
    const image = await loadImage(frameBaseUrl(frame))
    const area = clampCropRect(rect, image.naturalWidth, image.naturalHeight)
    if (isFullFrameRect(area, image.naturalWidth, image.naturalHeight)) {
      frame.crop = undefined
      frame.cropUrl = undefined
    } else {
      frame.crop = area
      frame.cropUrl = cropImageToDataUrl(image, area)
    }
    done += 1
    onProgress?.(done, frames.length)
    // 让出主线程，保证进度显示与取消按钮始终可响应
    await nextTick()
  }
  return done
}