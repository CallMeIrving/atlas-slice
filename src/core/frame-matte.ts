import { nextTick } from 'vue'
import { applyColorKey, colorKeyBase, sampleEdgeColor, type ColorKeyBase } from '@/core/color-key'
import { removeWithImgly, removeWithTransformers, resolveInferenceMaxSide, type MatteProgress } from '@/core/ai-matting'
import { fitResultToSize, imageDataToUrl, imageToImageData, loadImage } from '@/core/image'
import { recropFrame } from '@/core/frame-crop'
import type { VideoFrame, VideoMatteSettings } from '@/store/workspace'
import type { CancelToken } from '@/core/frame-extract'

/**
 * 视频帧抠图核心逻辑。
 * 单帧抠图弹窗与一键处理流水线共用；始终从原始抽帧画面出发，保证反复执行不叠加误差。
 */

/** 帧抠图用到的 AI 偏好（与 workspace.matte 的 AI 字段结构一致） */
export interface AiMattePrefs {
  aiMaxSide: number
  imglyModel: 'isnet' | 'isnet_fp16' | 'isnet_quint8'
  imglyPublicPath: string
  aiDevice: 'cpu' | 'gpu'
  aiDtype: 'q8' | 'fp16' | 'fp32'
  aiModelHost: 'huggingface.co' | 'hf-mirror.com'
  birefnetModelId: string
  rmbgModelId: string
}

/** 帧抠图上下文：抠图方式设置 + AI 偏好 */
export interface FrameMatteContext {
  settings: VideoMatteSettings
  ai: AiMattePrefs
}

/** #rrggbb → RGB，非法输入返回 null */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/** RGB → #rrggbb */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * 纯色背景抠图：手动基准色优先，否则从图像四边采样；始终在像素副本上运算，
 * 因此可以反复调参而不会叠加误差。
 * @param source 可选的原始像素数据（调用方按帧缓存，避免调参时重复解码）
 */
export function matteSolidData(
  image: HTMLImageElement,
  settings: VideoMatteSettings,
  source?: ImageData,
): { url: string; base: ColorKeyBase } {
  const origin = source ?? imageToImageData(image)
  const work = new ImageData(new Uint8ClampedArray(origin.data), origin.width, origin.height)
  const manual = hexToRgb(settings.baseColor)
  const base = manual ? colorKeyBase(manual.r, manual.g, manual.b) : sampleEdgeColor(origin)
  applyColorKey(work, {
    r: base.r,
    g: base.g,
    b: base.b,
    tolerance: settings.tolerance,
    shadow: settings.shadow,
    // 仅中性色背景需要额外去除近白像素；有彩色背景下白色饱和度接近 0，天然不匹配
    removeWhite: !base.chromatic,
  })
  return { url: imageDataToUrl(work), base }
}

/**
 * 按当前设置对单帧图像执行抠图，返回结果 dataURL。
 * 始终从原始帧出发，保证反复调整参数时结果稳定、不叠加误差。
 */
export async function matteFrameImage(
  image: HTMLImageElement,
  context: FrameMatteContext,
  onProgress?: (progress: MatteProgress) => void,
  source?: ImageData,
): Promise<string> {
  const settings = context.settings
  if (settings.mode === 'solid') return matteSolidData(image, settings, source).url
  // 分辨率上限统一由 ai-matting 收敛（0 = 自动），这里不再各写一份
  const maxSide = resolveInferenceMaxSide(context.ai.aiMaxSide)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (settings.mode === 'imgly') {
    const { blob } = await removeWithImgly(image, {
      model: context.ai.imglyModel,
      device: context.ai.aiDevice,
      maxSide,
      publicPath: context.ai.imglyPublicPath || undefined,
      onProgress,
    })
    return fitResultToSize(blob, width, height)
  }
  const { blob } = await removeWithTransformers(image, {
    modelId: settings.mode === 'birefnet' ? context.ai.birefnetModelId : context.ai.rmbgModelId,
    dtype: context.ai.aiDtype,
    device: context.ai.aiDevice,
    modelHost: context.ai.aiModelHost,
    maxSide,
    onProgress,
  })
  return fitResultToSize(blob, width, height)
}

export interface MatteBatchOptions {
  /** 每帧处理完成的进度回调：done/total 为整体进度，text 为当前帧状态说明 */
  onProgress?: (done: number, total: number, text: string) => void
  token?: CancelToken
  /** 已生成的样板帧结果（帧 id + 结果 dataURL），批量时直接复用可省一次推理 */
  reuse?: { id: string; url: string } | null
}

/**
 * 用当前设置批量抠图全部帧（带进度、可取消）。
 * 每帧写入 matteUrl 后立即按 frame.crop 重算裁切，保证裁切结果不会过期。
 * @returns 实际处理完成的帧数
 */
export async function applyMatteToFrames(
  frames: VideoFrame[],
  context: FrameMatteContext,
  options: MatteBatchOptions = {},
): Promise<number> {
  let done = 0
  for (const frame of frames) {
    if (options.token?.cancelled) break
    if (options.reuse && options.reuse.id === frame.id) {
      frame.matteUrl = options.reuse.url
    } else {
      const image = await loadImage(frame.url)
      frame.matteUrl = await matteFrameImage(image, context, undefined)
    }
    await recropFrame(frame)
    done += 1
    options.onProgress?.(done, frames.length, `${done}/${frames.length} 已完成`)
    await nextTick()
  }
  return done
}