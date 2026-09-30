/**
 * 多方向精灵合成。
 *
 * 导入一组或多组「单方向」动画帧（如正面组 + 背面组），每个方向从某个帧组
 * 按配置（镜像 / 旋转派生）取帧，合成为「方向 × 帧」的方向图集。
 * 诚实边界：镜像/旋转只能改写现有美术，不能凭空伪造画风；
 * 若某方向没有可用来源（source 为 null），一律视为「未生成」。
 */
import { releaseCanvas } from '@/core/image'
import type { FrameMeta } from '@/core/atlas-meta'

/** 方向标识 */
export type DirectionKey =
  | 'down' | 'left' | 'right' | 'up'
  | 'downLeft' | 'downRight' | 'upLeft' | 'upRight'

/** 方向派生变换：镜像补左右，旋转类便于投射物/箭头派生多方向 */
export type DirectionTransform = 'none' | 'mirrorX' | 'mirrorY' | 'rot180' | 'rot90' | 'rot270'

/** 基准方向的一帧 */
export interface DirectionFrame {
  id: string
  name: string
  url: string
}

/** 基准帧组：一组同方向、同动作的动画帧（如正面组、背面组） */
export interface FrameGroup {
  id: string
  name: string
  frames: DirectionFrame[]
}

/** 页面侧已解码的帧组：images 与 group.frames 一一对应 */
export interface ResolvedFrameGroup {
  group: FrameGroup
  images: HTMLImageElement[]
}

/** 一个目标方向的配置：source 为 null 表示未生成，否则为来源帧组 id */
export interface DirectionSlot {
  key: DirectionKey
  label: string
  source: string | null
  transform: DirectionTransform
}

/** 支持的方向集：2 向（左右）/ 4 向 / 8 向 */
export const DIRECTION_SETS: Record<2 | 4 | 8, DirectionKey[]> = {
  2: ['right', 'left'],
  4: ['down', 'left', 'right', 'up'],
  8: ['down', 'downLeft', 'left', 'upLeft', 'up', 'upRight', 'right', 'downRight'],
}

export const DIRECTION_LABELS: Record<DirectionKey, string> = {
  down: '下', left: '左', right: '右', up: '上',
  downLeft: '左下', downRight: '右下', upLeft: '左上', upRight: '右上',
}

/** 变换的中文说明，界面上直接展示 */
export const TRANSFORM_LABELS: Record<DirectionTransform, string> = {
  none: '原样',
  mirrorX: '水平镜像',
  mirrorY: '垂直镜像',
  rot180: '旋转 180°',
  rot90: '旋转 90°',
  rot270: '旋转 -90°',
}

/**
 * 生成一组方向的默认配置。
 * 指定基准帧组时：右向为基准原样、左向由水平镜像派生，其余方向「未生成」；
 * 未指定时全部「未生成」，由用户在界面上逐个指定来源帧组与变换。
 */
export function defaultSlots(set: 2 | 4 | 8, baseGroupId: string | null = null): DirectionSlot[] {
  return DIRECTION_SETS[set].map((key) => {
    const label = DIRECTION_LABELS[key]
    if (baseGroupId && key === 'right') return { key, label, source: baseGroupId, transform: 'none' }
    if (baseGroupId && key === 'left') return { key, label, source: baseGroupId, transform: 'mirrorX' }
    return { key, label, source: null, transform: 'none' }
  })
}

/** 从帧文件名派生基准名：去掉扩展名与尾部的帧号后缀（walk_00.png → walk） */
export function deriveBaseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]?\d+$/, '') || 'sprite'
}

/** 变换后的帧尺寸（90° / -90° 会交换宽高） */
export function transformedSize(width: number, height: number, transform: DirectionTransform): { w: number; h: number } {
  return transform === 'rot90' || transform === 'rot270' ? { w: height, h: width } : { w: width, h: height }
}

/**
 * 按变换生成一帧的新画布（含四周留白）。
 * 图像始终画在画布中心，旋转后画布尺寸随之交换，保证内容不被裁掉。
 */
export function transformFrame(
  image: HTMLImageElement,
  transform: DirectionTransform,
  padding: number,
): HTMLCanvasElement {
  const srcW = image.naturalWidth
  const srcH = image.naturalHeight
  const pad = Math.max(0, Math.round(padding))
  const size = transformedSize(srcW, srcH, transform)
  const canvas = document.createElement('canvas')
  canvas.width = size.w + pad * 2
  canvas.height = size.h + pad * 2
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.save()
  ctx.translate(canvas.width / 2, canvas.height / 2)
  if (transform === 'mirrorX') ctx.scale(-1, 1)
  else if (transform === 'mirrorY') ctx.scale(1, -1)
  else if (transform === 'rot180') ctx.rotate(Math.PI)
  else if (transform === 'rot90') ctx.rotate(Math.PI / 2)
  else if (transform === 'rot270') ctx.rotate(-Math.PI / 2)
  ctx.drawImage(image, -srcW / 2, -srcH / 2)
  ctx.restore()
  return canvas
}

export interface DirectionAtlasOptions {
  /** 单元格留白（已含在变换后的帧内，这里仅作为单元格下限参考） */
  padding: number
  /** 单元格边长（0 表示按最大帧自动） */
  cellSize: number
}

/**
 * 按方向配置渲染方向图集，并产出 TexturePacker 兼容元数据。
 * 每个已启用的方向从其来源帧组取帧；不同组帧数可以不同，
 * 图集列数取各有效方向帧数的最大值，缺帧的单元格留空（不产出元数据）。
 * resolved 与页面侧已解码图像按组一一对应。
 */
export function renderDirectionAtlas(
  baseName: string,
  resolved: ResolvedFrameGroup[],
  slots: DirectionSlot[],
  opts: DirectionAtlasOptions,
): { url: string; meta: Record<string, FrameMeta>; columns: number; rows: number; cellSize: number } {
  const byId = new Map(resolved.map((item) => [item.group.id, item]))
  const active = slots
    .filter((slot) => Boolean(slot.source))
    .map((slot) => ({ slot, item: byId.get(slot.source!) }))
  const columns = active.reduce((max, entry) => Math.max(max, entry.item?.group.frames.length ?? 0), 0)
  if (!active.length || !columns) throw new Error('没有可合成的方向，请至少为一个方向指定来源帧组')

  // 按方向逐组变换出全部帧画布，量出真实尺寸后确定统一的单元格边长
  const entries = active.map(({ slot, item }) => {
    if (!item) throw new Error(`方向「${slot.label}」指定的帧组已被删除，请重新指定来源`)
    const { group, images } = item
    const groupBase = group.frames.length ? deriveBaseName(group.frames[0].name) : baseName
    const canvases = group.frames.map((_, index) => {
      const image = images[index]
      if (!image) throw new Error(`「${group.name}」第 ${index + 1} 帧尚未解码完成`)
      return transformFrame(image, slot.transform, opts.padding)
    })
    return { slot, group, groupBase, canvases }
  })

  const naturalSide = entries.reduce(
    (max, entry) => entry.canvases.reduce((m, c) => Math.max(m, c.width, c.height), max),
    1,
  )
  const cellSize = Math.max(Math.round(opts.cellSize) || 0, naturalSide)
  const rows = entries.length
  const width = columns * cellSize
  const height = rows * cellSize

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  const meta: Record<string, FrameMeta> = {}

  entries.forEach((entry, row) => {
    entry.canvases.forEach((sprite, column) => {
      const x = column * cellSize + Math.floor((cellSize - sprite.width) / 2)
      const y = row * cellSize + Math.floor((cellSize - sprite.height) / 2)
      ctx.drawImage(sprite, x, y)
      const name = `${entry.groupBase}_${entry.slot.key}_${String(column).padStart(2, '0')}.png`
      meta[name] = {
        frame: { x, y, w: sprite.width, h: sprite.height },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: sprite.width, h: sprite.height },
        sourceSize: { w: sprite.width, h: sprite.height },
        manual: false,
      }
      releaseCanvas(sprite)
    })
  })

  const url = canvas.toDataURL('image/png')
  releaseCanvas(canvas)
  return { url, meta, columns, rows, cellSize }
}