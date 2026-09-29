/**
 * Tilemap 切片。
 *
 * 把一张 tileset 图按 tile 宽高 + 外边距（margin）+ 间距（spacing）+ 左上偏移切分成单块，
 * 并输出 Tiled 兼容的 tileset 描述；网格几何由 enumerateTiles 统一提供，预览与导出共用。
 */
import { releaseCanvas } from '@/core/image'

export interface TilemapOptions {
  tileW: number
  tileH: number
  /** 图集外边距（四周跳过的像素） */
  margin: number
  /** 单块之间的间距 */
  spacing: number
  /** 额外跳过的左上偏移 */
  offsetX: number
  offsetY: number
  /** 是否跳过全透明 tile */
  skipEmpty: boolean
  alphaThreshold: number
  /** 单块命名模板 */
  pattern: string
}

/** 单块 tile 的图像像素矩形 */
export interface TileRect {
  col: number
  row: number
  /** 网格中的稳定序号（行优先，跳过空白也不改变） */
  index: number
  x: number
  y: number
  w: number
  h: number
}

/** 按可用宽度推算列数：n 列需 margin*2 + offsetX + n*tileW + (n-1)*spacing ≤ imageW */
export function tileColumns(imageWidth: number, opts: TilemapOptions): number {
  const usable = imageWidth - opts.margin * 2 - opts.offsetX
  if (usable < opts.tileW) return 0
  return Math.floor((usable + opts.spacing) / (opts.tileW + opts.spacing))
}

/** 按可用高度推算行数，规则同 tileColumns */
export function tileRows(imageHeight: number, opts: TilemapOptions): number {
  const usable = imageHeight - opts.margin * 2 - opts.offsetY
  if (usable < opts.tileH) return 0
  return Math.floor((usable + opts.spacing) / (opts.tileH + opts.spacing))
}

/** 枚举所有 tile 的矩形（行优先），供网格预览与导出共用 */
export function enumerateTiles(imageWidth: number, imageHeight: number, opts: TilemapOptions): TileRect[] {
  const columns = tileColumns(imageWidth, opts)
  const rows = tileRows(imageHeight, opts)
  const tiles: TileRect[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      tiles.push({
        col,
        row,
        index: row * columns + col,
        x: opts.margin + opts.offsetX + col * (opts.tileW + opts.spacing),
        y: opts.margin + opts.offsetY + row * (opts.tileH + opts.spacing),
        w: opts.tileW,
        h: opts.tileH,
      })
    }
  }
  return tiles
}

/** 判断一块 tile 是否全透明（跳过空白 tile 用） */
export function isEmptyTile(data: ImageData, rect: TileRect, alphaThreshold: number): boolean {
  const { x, y, w, h } = rect
  const maxX = Math.min(data.width, x + w)
  const maxY = Math.min(data.height, y + h)
  for (let yy = y; yy < maxY; yy++) {
    for (let xx = x; xx < maxX; xx++) {
      if (data.data[(yy * data.width + xx) * 4 + 3] > alphaThreshold) return false
    }
  }
  return true
}

/** 单块 tile → PNG dataURL */
export function sliceTile(image: HTMLImageElement, rect: TileRect): string {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, rect.w)
  canvas.height = Math.max(1, rect.h)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  const url = canvas.toDataURL('image/png')
  releaseCanvas(canvas)
  return url
}

/** 按模板渲染单块文件名；模板非法（缺序号占位符）时交由调用方去重 */
export function renderTileName(pattern: string, base: string, tile: TileRect): string {
  return pattern
    .replace(/\{name\}/g, base)
    .replace(/\{index\}/g, String(tile.index).padStart(3, '0'))
    .replace(/\{seq\}/g, String(tile.index))
    .replace(/\{col\}/g, String(tile.col))
    .replace(/\{row\}/g, String(tile.row))
}

/** 生成 Tiled 兼容的 tileset 描述（描述源 tileset 的几何信息） */
export function buildTiledJson(
  name: string,
  imageName: string,
  imageWidth: number,
  imageHeight: number,
  columns: number,
  rows: number,
  opts: TilemapOptions,
): string {
  return JSON.stringify(
    {
      type: 'tileset',
      name,
      image: imageName,
      imagewidth: imageWidth,
      imageheight: imageHeight,
      tilewidth: opts.tileW,
      tileheight: opts.tileH,
      margin: opts.margin,
      spacing: opts.spacing,
      columns,
      tilecount: columns * rows,
      offsetX: opts.offsetX,
      offsetY: opts.offsetY,
    },
    null,
    2,
  )
}