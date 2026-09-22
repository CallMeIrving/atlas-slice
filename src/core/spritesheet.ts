import type { AtlasFrame } from '@/types/atlas'
import type { CropMode } from './crop'

export type SpriteSheetLayout = 'compact' | 'grid'

export interface SpriteSheetLayoutOptions {
  layout: SpriteSheetLayout
  mode: CropMode
  padding: number
  cellW: number
  cellH: number
  columns: number
  gap: number
  margin: number
}

export interface SpritePlacement {
  frame: AtlasFrame
  index: number
  x: number
  y: number
  w: number
  h: number
  spriteW: number
  spriteH: number
}

export interface SpriteSheetLayoutResult {
  width: number
  height: number
  placements: SpritePlacement[]
}

export function spriteSize(frame: AtlasFrame, mode: CropMode, padding: number): { w: number; h: number } {
  const pad = Math.max(0, Math.round(padding))
  if (mode === 'content') {
    return { w: Math.max(1, Math.round(frame.contentInFrame.w) + pad * 2), h: Math.max(1, Math.round(frame.contentInFrame.h) + pad * 2) }
  }
  return { w: Math.max(1, Math.round(frame.sourceSize.w) + pad * 2), h: Math.max(1, Math.round(frame.sourceSize.h) + pad * 2) }
}

export function layoutSpriteFrames(
  frames: AtlasFrame[],
  opts: SpriteSheetLayoutOptions,
): SpriteSheetLayoutResult {
  const columns = Math.max(1, Math.round(opts.columns))
  const gap = Math.max(0, Math.round(opts.gap))
  const margin = Math.max(0, Math.round(opts.margin))
  const sizes = frames.map((frame) => spriteSize(frame, opts.mode, opts.padding))
  const placements: SpritePlacement[] = []

  if (opts.layout === 'grid') {
    const cellW = Math.max(1, Math.round(opts.cellW))
    const cellH = Math.max(1, Math.round(opts.cellH))
    const rows = Math.ceil(frames.length / columns)
    frames.forEach((frame, index) => {
      const col = index % columns
      const row = Math.floor(index / columns)
      placements.push({
        frame,
        index,
        x: margin + col * (cellW + gap),
        y: margin + row * (cellH + gap),
        w: cellW,
        h: cellH,
        spriteW: sizes[index].w,
        spriteH: sizes[index].h,
      })
    })
    return {
      width: margin * 2 + columns * cellW + Math.max(0, columns - 1) * gap,
      height: margin * 2 + rows * cellH + Math.max(0, rows - 1) * gap,
      placements,
    }
  }

  let x = margin
  let y = margin
  let rowHeight = 0
  let rowCount = 0
  let contentWidth = 0
  for (let index = 0; index < frames.length; index++) {
    const size = sizes[index]
    const isNewRow = rowCount > 0 && index % columns === 0
    if (isNewRow) {
      y += rowHeight + gap
      x = margin
      rowHeight = 0
    }
    placements.push({ frame: frames[index], index, x, y, w: size.w, h: size.h, spriteW: size.w, spriteH: size.h })
    x += size.w + gap
    rowHeight = Math.max(rowHeight, size.h)
    contentWidth = Math.max(contentWidth, x - margin - gap)
    rowCount++
  }
  return {
    width: margin * 2 + contentWidth,
    height: frames.length ? y + rowHeight + margin : margin * 2,
    placements,
  }
}
