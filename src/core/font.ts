/**
 * 位图字体（Bitmap Font）生成。
 *
 * 输入一份字体文件（或系统字体名）与一份字符集，把每个字形的覆盖度栅格化成小位图，
 * 再按货架装箱排进一张（或多张）PNG 图集，最后产出 BMFont 文本 / XML / JSON 元数据。
 *
 * 两种字形表示：
 * - bitmap：输出覆盖度 alpha，图集是「白字 + alpha」，适合像素风与固定字号的 UI 文本；
 * - sdf：对栅格化结果做欧氏距离变换（8SSEDT），输出单通道距离场，放大缩小都保持边缘平滑。
 *
 * 全程使用 Canvas 2D，不依赖后端，`pnpm dev` 与 Electron 下行为一致。
 */
import { releaseCanvas } from '@/core/image'

/** 字形表示方式：位图覆盖度 / 单通道距离场 */
export type FontRenderMode = 'bitmap' | 'sdf'

/** 单个字符的图集落位与排版度量（字段语义对齐 BMFont 的 char 行） */
export interface FontGlyph {
  char: string
  /** 码点，BMFont 的 id */
  code: number
  /** 所在图集页下标 */
  page: number
  /** 图集中的矩形（图像像素坐标） */
  x: number
  y: number
  width: number
  height: number
  /** 从笔位到字形位图左缘的偏移 */
  xoffset: number
  /** 从行顶到字形位图上缘的偏移 */
  yoffset: number
  /** 步进宽度 */
  xadvance: number
}

/** 一页图集的尺寸 */
export interface FontAtlasPage {
  width: number
  height: number
}

/** 字形像素缓冲：bitmap 为覆盖度，sdf 为归一化距离（均为单通道，长度 width×height） */
export interface GlyphBitmap {
  w: number
  h: number
  data: Uint8Array
}

export interface FontBuildResult {
  pages: FontAtlasPage[]
  glyphs: FontGlyph[]
  /** 按码点索引的字形像素缓冲，导出时按图集落位拼页 */
  pixels: Map<number, GlyphBitmap>
  /** 行高与基线（相对行顶） */
  lineHeight: number
  base: number
  sizePx: number
  mode: FontRenderMode
  sdfSpread: number
  /** 图集内相邻字形的留白 */
  padding: number
  warnings: string[]
}

export interface CharsetOptions {
  /** ASCII 可打印字符 32–126 */
  ascii: boolean
  /** Latin-1 补充 160–255 */
  latin1: boolean
  /** 数字与常用标点 */
  digits: boolean
  /** 自定义字符（可直接粘贴中文） */
  custom: string
  /** Unicode 范围，如 "4E00-4E20, 3000-303F" */
  ranges: string
}

export interface FontBuildOptions extends CharsetOptions {
  family: string
  /** 字体名，写入元数据 */
  name: string
  sizePx: number
  padding: number
  mode: FontRenderMode
  sdfSpread: number
  maxAtlasSize: number
  powerOfTwo: boolean
  onProgress?: (done: number, total: number) => void
}

/** 单次生成的字形数上限：超过后截断并提示，避免长时间占用主线程 */
export const MAX_GLYPHS = 6000

/** 字符集常量：数字 + 高频英文标点，游戏 UI 里基本够用 */
const PUNCTUATION = '+-*/=%:.,;!?()[]{}<>#@&$_|\\"\'`~^'

/** 解析 Unicode 范围表达式，支持 "4E00-4E20"、"U+4E00-U+4E20" 与单点 "2603" */
export function parseUnicodeRanges(input: string): number[] {
  const codes: number[] = []
  for (const raw of input.split(/[,\s;]+/)) {
    const token = raw.trim().replace(/^u\+/i, '')
    if (!token) continue
    const [rawStart, rawEnd] = token.split(/[-–~]/)
    const start = Number.parseInt(rawStart, 16)
    if (!Number.isFinite(start)) continue
    const end = rawEnd ? Number.parseInt(rawEnd, 16) : start
    if (!Number.isFinite(end) || end < start) continue
    // 单个范围硬上限，防止误输入 "0-10FFFF" 直接把主线程拖死
    for (let code = start; code <= Math.min(end, start + 20000); code++) codes.push(code)
  }
  return codes
}

/** 按勾选项与自定义输入合成字符集：去重后按码点升序拼接 */
export function buildCharset(opts: CharsetOptions): string {
  const codes = new Set<number>()
  if (opts.ascii) for (let code = 32; code <= 126; code++) codes.add(code)
  if (opts.latin1) for (let code = 160; code <= 255; code++) codes.add(code)
  if (opts.digits) {
    for (let code = 48; code <= 57; code++) codes.add(code)
    for (const ch of PUNCTUATION) codes.add(ch.codePointAt(0)!)
  }
  for (const ch of Array.from(opts.custom)) {
    const code = ch.codePointAt(0)
    if (code !== undefined && code >= 32) codes.add(code)
  }
  for (const code of parseUnicodeRanges(opts.ranges)) {
    if (code >= 32) codes.add(code)
  }
  return Array.from(codes).sort((a, b) => a - b).map((code) => String.fromCodePoint(code)).join('')
}

/** 向上取整到 2 的幂 */
function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) size *= 2
  return size
}

/** 让出主线程一次，保证长任务的进度 UI 能刷新 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 探测系统字体是否可用：用待测字体与哨兵字体分别测量同一串字符宽度，
 * 宽度完全一致说明待测字体没有生效（回落到了哨兵字体）。
 */
export function isFontAvailable(family: string): boolean {
  if (!family.trim()) return false
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const sample = 'mmmmmmmmmmlliWW不可见'
  const sentinel = 'monospace'
  ctx.font = `72px ${sentinel}`
  const baseWidth = ctx.measureText(sample).width
  ctx.font = `72px "${family}", ${sentinel}`
  const testWidth = ctx.measureText(sample).width
  releaseCanvas(canvas)
  return Math.abs(testWidth - baseWidth) > 0.5
}

/** 已注册的 FontFace 集合：重置时按 family 反查并移除，避免 document.fonts 里越堆越多 */
const registeredFaces = new Map<string, FontFace>()

/** 字体名可能自带引号或反斜杠，拼进 CSS font 简写前先剥掉，避免整条简写语法失效 */
export function quoteFamily(family: string): string {
  return `"${family.replace(/["\\]/g, '')}"`
}

/** 上传字体文件的家族名计数器，避免同名字体互相覆盖 */
let familySeq = 0

/** 从 Blob URL 注册 FontFace，返回可用的字体家族名；family 已存在时直接复用 */
export async function registerFontFace(url: string, family?: string): Promise<string> {
  const name = family?.trim() || `atlas-slice-font-${++familySeq}`
  if (registeredFaces.has(name)) await document.fonts.load(`16px ${quoteFamily(name)}`, 'A')
  else {
    const face = new FontFace(name, `url(${url})`)
    await face.load()
    document.fonts.add(face)
    registeredFaces.set(name, face)
  }
  return name
}

/** 注销上传字体的 FontFace（重置页面时调用） */
export function unregisterFontFace(family: string): void {
  const face = registeredFaces.get(family)
  if (!face) return
  document.fonts.delete(face)
  registeredFaces.delete(family)
}

/** 输入字体文件的大小上限：字体动辄十几 MB，超过就拦在解码之前 */
export const MAX_FONT_FILE_SIZE = 24 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* 字形栅格化                                                          */
/* ------------------------------------------------------------------ */

/** 栅格化中间结果：1x 尺度下的覆盖度与相对笔位的偏移 */
interface RasterGlyph {
  code: number
  char: string
  /** 覆盖度数据（长度 w×h），空格等无形字形 w=h=0 */
  data: Uint8Array
  w: number
  h: number
  /** 位图左缘 / 上缘相对笔位与行顶的偏移（1x，可为小数） */
  xoffsetBase: number
  yoffsetBase: number
  advance: number
}

/** 由高分辨率覆盖度做 ss×ss 盒式降采样，得到 1x 尺度的抗锯齿覆盖度 */
function downsample(src: Uint8ClampedArray, sw: number, sh: number, ss: number): { data: Uint8Array; w: number; h: number } {
  const w = Math.max(1, Math.ceil(sw / ss))
  const h = Math.max(1, Math.ceil(sh / ss))
  const out = new Uint8Array(w * h)
  const area = ss * ss
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let sy = 0; sy < ss; sy++) {
        const py = y * ss + sy
        if (py >= sh) break
        for (let sx = 0; sx < ss; sx++) {
          const px = x * ss + sx
          if (px >= sw) break
          // 画布用白字 + 透明底绘制，红通道即覆盖度，再乘 alpha 处理半透明边缘
          sum += src[(py * sw + px) * 4] * (src[(py * sw + px) * 4 + 3] / 255)
        }
      }
      // 除以块面积而非实际像素数：边缘不足一块的部分按透明处理，避免边缘亮度被抬高
      out[y * w + x] = Math.round(Math.min(255, sum / area))
    }
  }
  return { data: out, w, h }
}

/**
 * 栅格化单个字形。
 * 先按超采样倍率绘制（边缘更干净），再盒式降采样回目标字号；
 * 画布范围覆盖字形外接框并向外留出 margin，保证斜体/悬垂笔画不被裁掉。
 */
function rasterizeGlyph(
  ctx: CanvasRenderingContext2D,
  family: string,
  char: string,
  code: number,
  sizePx: number,
  ascent: number,
  descent: number,
  marginPx: number,
  ss: number,
): RasterGlyph {
  const font = `${sizePx * ss}px ${quoteFamily(family)}, sans-serif`
  ctx.font = font
  const metrics = ctx.measureText(char)
  const inkLeft = Number.isFinite(metrics.actualBoundingBoxLeft) ? -metrics.actualBoundingBoxLeft : 0
  const inkRight = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width
  const advance = Number.isFinite(metrics.width) ? metrics.width : 0

  const marginHi = marginPx * ss
  const x0 = Math.floor(inkLeft * ss) - marginHi
  const x1 = Math.ceil(inkRight * ss) + marginHi
  const y0 = -Math.ceil(ascent * ss) - marginHi
  const y1 = Math.ceil(descent * ss) + marginHi
  const canvasW = Math.max(1, x1 - x0)
  const canvasH = Math.max(1, y1 - y0)

  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  const gctx = canvas.getContext('2d')!
  gctx.font = font
  gctx.textAlign = 'left'
  gctx.textBaseline = 'alphabetic'
  gctx.fillStyle = '#ffffff'
  // 笔位在画布中的位置：横向 -x0，纵向 marginHi + ascent（基线）
  gctx.fillText(char, -x0, marginHi + Math.ceil(ascent * ss))
  const image = gctx.getImageData(0, 0, canvasW, canvasH)
  releaseCanvas(canvas)

  const small = downsample(image.data, canvasW, canvasH, ss)
  return {
    code,
    char,
    data: small.data,
    w: small.w,
    h: small.h,
    xoffsetBase: x0 / ss,
    yoffsetBase: y0 / ss,
    advance,
  }
}

/** 求覆盖度数据的非空外接框；全空返回 null */
function inkBBox(data: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/* ------------------------------------------------------------------ */
/* 距离场（8SSEDT）                                                     */
/* ------------------------------------------------------------------ */

/** 距离场中间网格：每格记录到最近种子像素的向量 */
interface SdfGrid {
  dx: Float32Array
  dy: Float32Array
}

const SDF_FAR = 1e9

function gridDist(grid: SdfGrid, index: number): number {
  const dx = grid.dx[index]
  const dy = grid.dy[index]
  return dx * dx + dy * dy
}

/** 用邻居格子里已有的向量 + 位移，更新当前格子的最近种子（8SSEDT 的 Compare） */
function compareCell(
  grid: SdfGrid,
  w: number,
  h: number,
  x: number,
  y: number,
  ox: number,
  oy: number,
): void {
  const nx = x + ox
  const ny = y + oy
  if (nx < 0 || nx >= w || ny < 0 || ny >= h) return
  const index = y * w + x
  const otherIndex = ny * w + nx
  const dx = grid.dx[otherIndex] + ox
  const dy = grid.dy[otherIndex] + oy
  if (dx * dx + dy * dy < gridDist(grid, index)) {
    grid.dx[index] = dx
    grid.dy[index] = dy
  }
}

/** 生成种子为 1 的像素到最近 0 像素之外的欧氏距离场（迭代两遍扫描，结果精确） */
function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const grid: SdfGrid = { dx: new Float32Array(w * h), dy: new Float32Array(w * h) }
  for (let i = 0; i < mask.length; i++) {
    grid.dx[i] = mask[i] ? 0 : SDF_FAR
    grid.dy[i] = mask[i] ? 0 : SDF_FAR
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      compareCell(grid, w, h, x, y, -1, 0)
      compareCell(grid, w, h, x, y, 0, -1)
      compareCell(grid, w, h, x, y, -1, -1)
      compareCell(grid, w, h, x, y, 1, -1)
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      compareCell(grid, w, h, x, y, 1, 0)
      compareCell(grid, w, h, x, y, 0, 1)
      compareCell(grid, w, h, x, y, -1, 1)
      compareCell(grid, w, h, x, y, 1, 1)
    }
  }
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(gridDist(grid, i))
  return out
}

/**
 * 覆盖度 → 单通道距离场。
 * 以 0.5 覆盖度为边界把像素分成内外两组，分别求到边界的距离后合成带符号距离，
 * 再按 spread 归一化到 0–255：0.5 为边界，spread 像素外饱和。
 */
function coverageToSdf(coverage: Uint8Array, w: number, h: number, spread: number): Uint8Array {
  const inside = new Uint8Array(w * h)
  for (let i = 0; i < coverage.length; i++) inside[i] = coverage[i] >= 128 ? 1 : 0
  const outside = new Uint8Array(w * h)
  for (let i = 0; i < inside.length; i++) outside[i] = inside[i] ? 0 : 1

  const distToInside = distanceTransform(inside, w, h)
  const distToOutside = distanceTransform(outside, w, h)
  const scale = 1 / (2 * spread)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) {
    const signed = inside[i] ? -distToOutside[i] : distToInside[i]
    const value = Math.round(Math.min(1, Math.max(0, 0.5 + signed * scale)) * 255)
    out[i] = value
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 货架装箱                                                            */
/* ------------------------------------------------------------------ */

interface GlyphBox {
  code: number
  /** 含图集留白的装箱尺寸 */
  w: number
  h: number
}

interface ShelfPlacement {
  code: number
  x: number
  y: number
  page: number
}

interface ShelfLayout {
  pages: ShelfPlacement[][]
  /** 每页实际使用到的宽高 */
  used: Array<{ w: number; h: number }>
  /** 因大于图集最大边长而未能落位的字形数 */
  skipped: number
}

/**
 * 货架装箱：按高度降序把字形排成一行行「货架」，一行放不下就换行，竖向放不下就换页。
 * 字形高度相近，货架法比 MaxRects 更快且浪费更少，因此这里不复用雪碧图的紧凑装箱。
 */
function shelfPack(boxes: GlyphBox[], binW: number, binH: number): ShelfLayout {
  const sorted = [...boxes].sort((a, b) => b.h - a.h || b.w - a.w)
  const pages: ShelfPlacement[][] = [[]]
  const used: Array<{ w: number; h: number }> = [{ w: 0, h: 0 }]
  let cursorX = 0
  let shelfY = 0
  let shelfH = 0
  let skipped = 0

  for (const box of sorted) {
    if (box.w > binW || box.h > binH) {
      skipped++
      continue
    }
    if (cursorX > 0 && cursorX + box.w > binW) {
      shelfY += shelfH
      cursorX = 0
      shelfH = 0
    }
    if (shelfY + box.h > binH) {
      pages.push([])
      used.push({ w: 0, h: 0 })
      shelfY = 0
      cursorX = 0
      shelfH = 0
    }
    const page = pages.length - 1
    pages[page].push({ code: box.code, x: cursorX, y: shelfY, page })
    cursorX += box.w
    shelfH = Math.max(shelfH, box.h)
    used[page] = {
      w: Math.max(used[page].w, cursorX),
      h: Math.max(used[page].h, shelfY + shelfH),
    }
  }
  return { pages, used, skipped }
}

/** 装箱结果：每页尺寸一致（BMFont 的 common 行是整份文件共用的） */
interface PackedAtlas {
  pages: FontAtlasPage[]
  placements: ShelfPlacement[]
  indexByCode: Map<number, number>
}

/** 在若干 2 的幂候选宽度里挑总像素面积最小的一种，多页时页尺寸保持一致 */
function packGlyphBoxes(boxes: GlyphBox[], maxSize: number, powerOfTwo: boolean): PackedAtlas {
  const candidates: number[] = []
  for (let width = 64; width <= maxSize; width *= 2) candidates.push(width)
  if (candidates[candidates.length - 1] !== maxSize) candidates.push(maxSize)

  let best: { width: number; height: number; layout: ShelfLayout } | null = null
  let bestScore = Infinity
  for (const width of candidates) {
    const layout = shelfPack(boxes, width, maxSize)
    const usedW = Math.max(...layout.used.map((u) => u.w), 1)
    const usedH = Math.max(...layout.used.map((u) => u.h), 1)
    const pageW = powerOfTwo ? width : Math.min(width, usedW)
    const pageH = powerOfTwo ? nextPowerOfTwo(usedH) : usedH
    // 丢字形的候选必须重罚，否则「窄页跳过放不下的字形」会因面积更小而胜出
    const score = pageW * pageH * layout.pages.length + layout.skipped * 1e9
    if (score < bestScore) {
      bestScore = score
      best = { width: pageW, height: pageH, layout }
    }
  }

  const chosen = best!
  const placements: ShelfPlacement[] = []
  const indexByCode = new Map<number, number>()
  chosen.layout.pages.forEach((page) => {
    for (const placement of page) {
      indexByCode.set(placement.code, placements.length)
      placements.push(placement)
    }
  })
  return {
    pages: chosen.layout.pages.map(() => ({ width: chosen.width, height: chosen.height })),
    placements,
    indexByCode,
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成字体图集与字形度量。
 * 步骤：合成字符集 → 逐字栅格化（带超采样）→ 按需转距离场 → 货架装箱 → 组装 BMFont 度量。
 */
export async function buildFont(options: FontBuildOptions): Promise<FontBuildResult> {
  const warnings: string[] = []
  const all = Array.from(buildCharset(options))
  const chars = all.slice(0, MAX_GLYPHS)
  if (all.length > chars.length) warnings.push(`字符数 ${all.length} 超过上限 ${MAX_GLYPHS}，已截断`)
  if (!chars.length) throw new Error('字符集为空，请至少勾选一个预设或填写自定义字符')

  const sizePx = Math.max(6, Math.round(options.sizePx))
  const padding = Math.max(0, Math.round(options.padding))
  const spread = options.mode === 'sdf' ? Math.max(1, Math.round(options.sdfSpread)) : 0
  const ss = sizePx <= 32 ? 4 : sizePx <= 64 ? 2 : 1

  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = `${sizePx}px ${quoteFamily(options.family)}, sans-serif`
  const probe = measure.measureText('HXYgjpq')
  const ascent = Number.isFinite(probe.fontBoundingBoxAscent) && probe.fontBoundingBoxAscent > 0
    ? probe.fontBoundingBoxAscent
    : sizePx * 0.8
  const descent = Number.isFinite(probe.fontBoundingBoxDescent) && probe.fontBoundingBoxDescent > 0
    ? probe.fontBoundingBoxDescent
    : sizePx * 0.2
  releaseCanvas(measure.canvas)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const marginPx = padding + spread
  const glyphs: FontGlyph[] = []
  const pixels = new Map<number, GlyphBitmap>()
  const boxes: GlyphBox[] = []
  const luminance: Array<{ code: number; scaled: GlyphBitmap; xoffset: number; yoffset: number; advance: number }> = []

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    const code = char.codePointAt(0)!
    const raster = rasterizeGlyph(ctx, options.family, char, code, sizePx, ascent, descent, marginPx, ss)
    let bitmap: GlyphBitmap
    let xoffset: number
    let yoffset: number
    if (options.mode === 'bitmap') {
      const bbox = inkBBox(raster.data, raster.w, raster.h)
      if (!bbox) {
        // 空格类字形没有墨迹：只保留步进宽度
        bitmap = { w: 0, h: 0, data: new Uint8Array(0) }
        xoffset = 0
        yoffset = 0
        boxes.push({ code, w: 0, h: 0 })
      } else {
        const trimmed = new Uint8Array(bbox.w * bbox.h)
        for (let y = 0; y < bbox.h; y++) {
          trimmed.set(raster.data.subarray((bbox.y + y) * raster.w + bbox.x, (bbox.y + y) * raster.w + bbox.x + bbox.w), y * bbox.w)
        }
        bitmap = { w: bbox.w, h: bbox.h, data: trimmed }
        xoffset = raster.xoffsetBase + bbox.x
        // 栅格化的 yoffsetBase 相对基线，BMFont 的 yoffset 相对行顶（基线 - ascent），故补回 ascent
        yoffset = bbox.y - marginPx
        boxes.push({ code, w: bbox.w + padding * 2, h: bbox.h + padding * 2 })
      }
    } else {
      bitmap = { w: raster.w, h: raster.h, data: coverageToSdf(raster.data, raster.w, raster.h, spread) }
      xoffset = raster.xoffsetBase
      yoffset = -marginPx
      boxes.push({ code, w: bitmap.w + padding * 2, h: bitmap.h + padding * 2 })
    }
    pixels.set(code, bitmap)
    luminance.push({ code, scaled: bitmap, xoffset, yoffset, advance: raster.advance })

    if (i % 24 === 23) {
      options.onProgress?.(i + 1, chars.length)
      await yieldToMain()
    }
  }
  releaseCanvas(canvas)
  options.onProgress?.(chars.length, chars.length)

  const packed = packGlyphBoxes(boxes, Math.max(64, Math.round(options.maxAtlasSize)), options.powerOfTwo)
  if (!packed.pages.length) throw new Error('字形装箱失败，请调大图集最大边长')
  const inked = boxes.filter((box) => box.w > 0)
  const skipped = inked.filter((box) => !packed.indexByCode.has(box.code)).length
  // 有墨迹的字形一个都没放下，说明整套参数不可行（多为扩散半径把字形撑过了最大边长）
  if (inked.length && skipped === inked.length) {
    throw new Error(`所有字形都超出图集最大边长 ${Math.max(64, Math.round(options.maxAtlasSize))}px，请调大最大边长或减小扩散半径`)
  }
  if (skipped) warnings.push(`${skipped} 个字形超出图集最大边长，已跳过`)

  for (const item of luminance) {
    const index = packed.indexByCode.get(item.code)
    const metrics = index === undefined ? null : packed.placements[index]
    glyphs.push({
      char: String.fromCodePoint(item.code),
      code: item.code,
      page: metrics ? metrics.page : 0,
      x: metrics ? metrics.x + padding : 0,
      y: metrics ? metrics.y + padding : 0,
      width: item.scaled.w,
      height: item.scaled.h,
      xoffset: Math.round(item.xoffset),
      yoffset: Math.round(item.yoffset),
      xadvance: Math.max(0, Math.round(item.advance)),
    })
  }

  return {
    pages: packed.pages,
    glyphs,
    pixels,
    lineHeight: Math.round(ascent + descent),
    base: Math.round(ascent),
    sizePx,
    mode: options.mode,
    sdfSpread: spread,
    padding,
    warnings,
  }
}

/** 把字形像素按落位拼进各页画布，返回每页的 PNG dataURL */
export function renderFontPages(result: FontBuildResult): string[] {
  return result.pages.map((page, pageIndex) => {
    const buffer = new Uint8ClampedArray(page.width * page.height * 4)
    // 距离场整页必须不透明：空白区域代表「远离字形」，需填满白（1.0），
    // 否则透明像素解码后为黑，会被着色器当成字形内部
    if (result.mode === 'sdf') buffer.fill(255)
    for (const glyph of result.glyphs) {
      if (glyph.page !== pageIndex || !glyph.width || !glyph.height) continue
      const bitmap = result.pixels.get(glyph.code)
      if (!bitmap) continue
      for (let y = 0; y < glyph.height; y++) {
        for (let x = 0; x < glyph.width; x++) {
          const value = bitmap.data[y * glyph.width + x]
          const target = ((glyph.y + y) * page.width + glyph.x + x) * 4
          if (result.mode === 'bitmap') {
            buffer[target] = 255
            buffer[target + 1] = 255
            buffer[target + 2] = 255
            buffer[target + 3] = value
          } else {
            // 距离场存灰度通道，alpha 全不透明，着色交给 shader
            buffer[target] = value
            buffer[target + 1] = value
            buffer[target + 2] = value
            buffer[target + 3] = 255
          }
        }
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = page.width
    canvas.height = page.height
    canvas.getContext('2d')!.putImageData(new ImageData(buffer, page.width, page.height), 0, 0)
    const url = canvas.toDataURL('image/png')
    releaseCanvas(canvas)
    return url
  })
}

/** 图集页文件名 */
export function pageFileName(name: string, index: number): string {
  return `${name}_${index}.png`
}

/** BMFont 文本格式（.fnt），可被 Cocos / libGDX / Phaser 等直接加载 */
export function buildBmfontText(result: FontBuildResult, name: string): string {
  const lines: string[] = []
  const pad = `${result.padding},${result.padding},${result.padding},${result.padding}`
  const sdf = result.mode === 'sdf' ? ` distanceField=${result.sdfSpread}` : ''
  lines.push(`info face="${name}" size=${result.sizePx} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=${pad} spacing=1,1 outline=0${sdf}`)
  lines.push(`common lineHeight=${result.lineHeight} base=${result.base} scaleW=${result.pages[0]?.width ?? 0} scaleH=${result.pages[0]?.height ?? 0} pages=${result.pages.length} packed=0`)
  result.pages.forEach((_, index) => lines.push(`page id=${index} file="${pageFileName(name, index)}"`))
  lines.push(`chars count=${result.glyphs.length}`)
  for (const glyph of result.glyphs) {
    lines.push(`char id=${glyph.code} x=${glyph.x} y=${glyph.y} width=${glyph.width} height=${glyph.height} xoffset=${glyph.xoffset} yoffset=${glyph.yoffset} xadvance=${glyph.xadvance} page=${glyph.page} chnl=15`)
  }
  return `${lines.join('\n')}\n`
}

/** BMFont XML 格式，字段与文本格式一一对应 */
export function buildBmfontXml(result: FontBuildResult, name: string): string {
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const pad = `${result.padding},${result.padding},${result.padding},${result.padding}`
  const sdf = result.mode === 'sdf' ? ` distanceField="${result.sdfSpread}"` : ''
  const rows: string[] = []
  rows.push('<?xml version="1.0"?>')
  rows.push('<font>')
  rows.push(`  <info face="${escape(name)}" size="${result.sizePx}" bold="0" italic="0" charset="" unicode="1" stretchH="100" smooth="1" aa="1" padding="${pad}" spacing="1,1" outline="0"${sdf}/>`)
  rows.push(`  <common lineHeight="${result.lineHeight}" base="${result.base}" scaleW="${result.pages[0]?.width ?? 0}" scaleH="${result.pages[0]?.height ?? 0}" pages="${result.pages.length}" packed="0"/>`)
  result.pages.forEach((_, index) => rows.push(`  <page id="${index}" file="${escape(pageFileName(name, index))}"/>`))
  rows.push(`  <chars count="${result.glyphs.length}">`)
  for (const glyph of result.glyphs) {
    rows.push(`    <char id="${glyph.code}" x="${glyph.x}" y="${glyph.y}" width="${glyph.width}" height="${glyph.height}" xoffset="${glyph.xoffset}" yoffset="${glyph.yoffset}" xadvance="${glyph.xadvance}" page="${glyph.page}" chnl="15"/>`)
  }
  rows.push('  </chars>')
  rows.push('</font>')
  return `${rows.join('\n')}\n`
}

/** JSON 元数据：保留浮点步进等 BMFont 文本格式装不下的信息，便于脚本侧做二次处理 */
export function buildFontJson(result: FontBuildResult, name: string): string {
  return JSON.stringify({
    name,
    size: result.sizePx,
    mode: result.mode,
    ...(result.mode === 'sdf' ? { sdfSpread: result.sdfSpread } : {}),
    padding: result.padding,
    lineHeight: result.lineHeight,
    base: result.base,
    pages: result.pages.map((page, index) => ({
      file: pageFileName(name, index),
      width: page.width,
      height: page.height,
    })),
    glyphs: result.glyphs.map((glyph) => ({
      char: glyph.char,
      code: glyph.code,
      page: glyph.page,
      x: glyph.x,
      y: glyph.y,
      width: glyph.width,
      height: glyph.height,
      xoffset: glyph.xoffset,
      yoffset: glyph.yoffset,
      xadvance: glyph.xadvance,
    })),
  }, null, 2)
}