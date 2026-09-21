import type { AtlasFrame } from '@/types/atlas'

export type CropMode = 'content' | 'frame'

export interface CropOptions {
  /** content：只裁实际内容；frame：还原原始帧尺寸 */
  mode: CropMode
  /** 统一留边（像素） */
  padding: number
}

/** 将源图集中一帧裁切为独立画布 */
export function cropFrame(
  source: HTMLCanvasElement,
  frame: AtlasFrame,
  opts: CropOptions,
): HTMLCanvasElement {
  const { rect } = frame

  // 1. 抽取打包矩形
  const raw = document.createElement('canvas')
  raw.width = Math.max(1, Math.round(rect.w))
  raw.height = Math.max(1, Math.round(rect.h))
  const rctx = raw.getContext('2d')!
  rctx.imageSmoothingEnabled = false
  rctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)

  // 2. 旋转还原（TexturePacker 顺时针 90° 打包 → 逆时针还原）
  let restored: HTMLCanvasElement
  if (frame.rotated) {
    restored = document.createElement('canvas')
    restored.width = Math.max(1, Math.round(rect.h))
    restored.height = Math.max(1, Math.round(rect.w))
    const c = restored.getContext('2d')!
    c.imageSmoothingEnabled = false
    c.translate(0, restored.height)
    c.rotate(-Math.PI / 2)
    c.drawImage(raw, 0, 0)
  } else {
    restored = raw
  }

  const pad = Math.max(0, Math.round(opts.padding))
  const ci = frame.contentInFrame
  const out = document.createElement('canvas')
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  if (opts.mode === 'content') {
    const w = Math.max(1, Math.round(ci.w))
    const h = Math.max(1, Math.round(ci.h))
    out.width = w + pad * 2
    out.height = h + pad * 2
    ctx.drawImage(restored, Math.round(ci.x), Math.round(ci.y), w, h, pad, pad, w, h)
  } else {
    // 原始帧尺寸：以 sourceSize 为画布，内容按原始坐标摆放
    const w = Math.max(1, Math.round(frame.sourceSize.w || ci.w))
    const h = Math.max(1, Math.round(frame.sourceSize.h || ci.h))
    out.width = w + pad * 2
    out.height = h + pad * 2
    const dw = Math.max(1, Math.round(ci.w))
    const dh = Math.max(1, Math.round(ci.h))
    ctx.drawImage(
      restored,
      Math.round(ci.x),
      Math.round(ci.y),
      dw,
      dh,
      pad + Math.round(frame.contentInOriginal.x),
      pad + Math.round(frame.contentInOriginal.y),
      dw,
      dh,
    )
  }
  return out
}
