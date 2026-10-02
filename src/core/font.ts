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

/** 字形表示方式：位图覆盖度 / 单通道距离场 / MSDF(RGB) / MTSDF(RGBA) */
export type FontRenderMode = 'bitmap' | 'sdf' | 'msdf' | 'mtsdf'

/** 距离场类模式（sdf/msdf/mtsdf）统一按距离场流程处理 */
export function isDistanceFieldMode(mode: FontRenderMode): boolean {
  return mode !== 'bitmap'
}

/** MSDF / MTSDF 的通道数：3 = RGB，4 = RGBA（附加单通道 SDF 存 alpha） */
export function sdfChannelCount(mode: FontRenderMode): number {
  return mode === 'mtsdf' ? 4 : 3
}

/** 字距调整对：first / second 为字符码点，amount 为叠加在步进上的调整量（通常为负） */
export interface FontKerningPair {
  first: number
  second: number
  amount: number
}

/** 场景预览模板 */
export type FontSceneTemplate = 'none' | 'hp' | 'coins' | 'level' | 'damage' | 'dialog' | 'button'

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

/** 字形像素缓冲：bitmap/sdf 为单通道，msdf 为 3 通道、mtsdf 为 4 通道（长度 width×height×channels） */
export interface GlyphBitmap {
  w: number
  h: number
  /** 每像素通道数：1 = 覆盖度 / 距离场，3 = MSDF，4 = MTSDF */
  channels: number
  data: Uint8Array | Uint8ClampedArray
}

export interface FontBuildResult {
  pages: FontAtlasPage[]
  glyphs: FontGlyph[]
  /** 按码点索引的字形像素缓冲，导出时按图集落位拼页 */
  pixels: Map<number, GlyphBitmap>
  /** 行高与基线（相对行顶，已含行间距与字间距的实际生效值） */
  lineHeight: number
  base: number
  /** 字体原始度量（相对行顶），用于「重置为字体原始 Metrics」 */
  ascent: number
  descent: number
  /** 生效的字间距 / 行间距 */
  letterSpacing: number
  lineSpacing: number
  sizePx: number
  mode: FontRenderMode
  sdfSpread: number
  /** 距离场着色阈值（0–1），随 JSON 元数据导出 */
  sdfThreshold: number
  /** 图集内相邻字形的留白 */
  padding: number
  /** 字距调整表（自动计算 + 手动覆盖合并后的结果） */
  kerning: FontKerningPair[]
  /** 因排除而跳过的字符数 */
  excludedCount: number
  /** 整体装箱占用率（字形外框面积 / 全部图集像素），0–1 */
  occupancy: number
  /** 每页装箱占用率，下标与 pages 对应 */
  pageOccupancy: number[]
  /** 生成耗时（毫秒，含逐字栅格化、距离场与装箱） */
  buildMs: number
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
  /** 距离场着色阈值（0–1），仅写进 JSON 元数据供 shader 参考，不参与栅格化 */
  sdfThreshold?: number
  maxAtlasSize: number
  powerOfTwo: boolean
  /** 需要跳过的字符码点（手动排除 + 自动排除缺失） */
  excludeChars?: number[]
  /** 字间距（px），叠加在每个字形的步进上 */
  letterSpacing?: number
  /** 行间距（px），叠加在行高上 */
  lineSpacing?: number
  /** 是否生成字距调整表 */
  kerning?: boolean
  /** 手动字距对，优先于自动计算结果 */
  kerningPairs?: FontKerningPair[]
  /** 描边宽度（px），0 表示不描边；描边在图集生成前完成 */
  strokeWidth?: number
  strokeColor?: string
  /** 阴影偏移与颜色，在图集生成前完成 */
  shadowEnabled?: boolean
  shadowX?: number
  shadowY?: number
  shadowColor?: string
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

/**
 * 常用 CJK / 全角字符集预设。
 * heavy 标记的预设字符量很大（会触及单次上限），提示改用「文本扫描」，但不做特殊配色；
 * 预设一律没有默认选中态——选中态只反映「Unicode 范围」里是否真的填了它。
 */
export interface CharsetPreset {
  id: string
  label: string
  /** 追加到「Unicode 范围」输入框的内容 */
  ranges: string
  /** 是否为大字符集（悬浮提示里提醒会被上限截断） */
  heavy?: boolean
}

export const CHARSET_PRESETS: CharsetPreset[] = [
  { id: 'cjk-punc', label: '中文标点', ranges: '3000-303F' },
  { id: 'fullwidth', label: '全角字母数字与标点', ranges: 'FF01-FF5E, FF65' },
  { id: 'hiragana', label: '日文平假名', ranges: '3041-3096' },
  { id: 'katakana', label: '日文片假名', ranges: '30A1-30FA' },
  { id: 'hangul', label: '韩文音节', ranges: 'AC00-D7A3', heavy: true },
  { id: 'cjk-ideograph', label: 'CJK 基本汉字', ranges: '4E00-9FFF', heavy: true },
]

/** 从文本（TXT / JSON / CSV 原文）中提取实际使用的字符：去重、按码点升序 */
export function extractCharsFromText(text: string): string {
  const codes = new Set<number>()
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === undefined || code < 32) continue
    codes.add(code)
  }
  return Array.from(codes).sort((a, b) => a - b).map((code) => String.fromCodePoint(code)).join('')
}

/** 字符覆盖率报告 */
export interface CoverageReport {
  /** 字体缺失（会回落到系统字体）的字符 */
  missing: string[]
  /** 支持 / 目标 / 覆盖率 */
  supported: number
  total: number
  ratio: number
}

/**
 * 生成前探测字体是否包含目标字符。
 *
 * 做法：把同一字符分别用「目标字体 + sans-serif 兜底」与「仅 sans-serif」测量，
 * 若前进宽度与墨迹外接框完全一致，说明目标字体没有该字形、整串回落到了兜底字体。
 * 空白类字符没有墨迹，无法用度量判断，按存在处理。
 */
export function inspectCoverage(family: string, chars: string, sizePx: number): CoverageReport {
  const list = Array.from(chars)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const missing: string[] = []
  const readMetrics = (font: string, char: string): number[] => {
    ctx.font = font
    const m = ctx.measureText(char)
    return [m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent]
  }
  const withFamily = `${sizePx}px ${quoteFamily(family)}, sans-serif`
  const sentinel = `${sizePx}px sans-serif`
  for (const char of list) {
    if (/\s/.test(char)) continue
    const a = readMetrics(withFamily, char)
    const b = readMetrics(sentinel, char)
    // NaN 表示该度量不适用，视作「有差异」，避免把正常字形误判为缺失
    const same = a.every((value, index) => Number.isFinite(b[index]) && Math.abs(value - b[index]) < 0.01)
    if (same) missing.push(char)
  }
  releaseCanvas(canvas)
  const total = list.length
  return {
    missing,
    total,
    supported: total - missing.length,
    ratio: total ? (total - missing.length) / total : 1,
  }
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

/** 字体效果（描边 / 阴影）：在图集栅格化时一并绘制，仅位图模式支持 */
interface FontEffects {
  /** 描边宽度（1x 尺度 px），0 表示不描边 */
  strokeWidth: number
  strokeColor: string
  shadow: boolean
  shadowX: number
  shadowY: number
  shadowColor: string
}

/** 栅格化中间结果：超采样像素 + 相对笔位 / 基线的偏移 */
interface RasterGlyph {
  code: number
  char: string
  /** 超采样后的 RGBA 像素（含描边 / 阴影），尺寸 sw×sh */
  image: ImageData
  sw: number
  sh: number
  /** 画布左缘相对笔位的偏移（1x，可为小数） */
  xoffsetBase: number
  /** 画布上缘相对「行顶（基线 - ascent）」多留出的高度（1x），位图模式的 yoffset 需补回 */
  topPadPx: number
  advance: number
}

/**
 * 覆盖度降采样（距离场系列用）。
 * 直接聚合 alpha：字形以白字绘制，alpha 即覆盖度，等价于旧实现里「红通道 × alpha / 255」。
 */
function downsampleAlpha(src: Uint8ClampedArray, sw: number, sh: number, ss: number): { data: Uint8Array; w: number; h: number } {
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
          sum += src[(py * sw + px) * 4 + 3]
        }
      }
      // 除以块面积而非实际像素数：边缘不足一块的部分按透明处理，避免边缘亮度被抬高
      out[y * w + x] = Math.round(Math.min(255, sum / area))
    }
  }
  return { data: out, w, h }
}

/**
 * RGBA 降采样（位图模式用，保留描边 / 阴影颜色）。
 * 颜色按 alpha 加权求平均再除以总 alpha，避免与透明黑混出暗边。
 */
function downsampleRgba(src: Uint8ClampedArray, sw: number, sh: number, ss: number): { data: Uint8ClampedArray; w: number; h: number } {
  const w = Math.max(1, Math.ceil(sw / ss))
  const h = Math.max(1, Math.ceil(sh / ss))
  const out = new Uint8ClampedArray(w * h * 4)
  const area = ss * ss
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        const py = y * ss + sy
        if (py >= sh) break
        for (let sx = 0; sx < ss; sx++) {
          const px = x * ss + sx
          if (px >= sw) break
          const index = (py * sw + px) * 4
          const alpha = src[index + 3]
          r += src[index] * alpha
          g += src[index + 1] * alpha
          b += src[index + 2] * alpha
          a += alpha
        }
      }
      const target = (y * w + x) * 4
      out[target] = a ? Math.round(r / a) : 0
      out[target + 1] = a ? Math.round(g / a) : 0
      out[target + 2] = a ? Math.round(b / a) : 0
      out[target + 3] = Math.round(Math.min(255, a / area))
    }
  }
  return { data: out, w, h }
}

/**
 * 栅格化单个字形（超采样绘制后再降采样）。
 * 画布范围覆盖字形外接框，并向外留出 margin、描边宽度与阴影偏移，保证不被裁掉；
 * 描边 / 阴影在此阶段绘制完成，后续装箱只处理成品像素。
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
  effects: FontEffects,
): RasterGlyph {
  const font = `${sizePx * ss}px ${quoteFamily(family)}, sans-serif`
  ctx.font = font
  // measureText 的度量是按超采样字号（sizePx × ss）给出的，这里统一除回 1× 尺度，
  // 下面的画布范围再乘 ss 变回超采样像素；漏除会让 advance 与画布宽度整体放大 ss 倍
  const metrics = ctx.measureText(char)
  const inkLeft = (Number.isFinite(metrics.actualBoundingBoxLeft) ? -metrics.actualBoundingBoxLeft : 0) / ss
  const inkRight = (Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width) / ss
  const advance = Number.isFinite(metrics.width) ? metrics.width / ss : 0

  const strokeHi = effects.strokeWidth * ss
  const shadowXHi = effects.shadow ? effects.shadowX * ss : 0
  const shadowYHi = effects.shadow ? effects.shadowY * ss : 0
  const marginHi = marginPx * ss
  const x0 = Math.floor(inkLeft * ss) - marginHi - strokeHi - Math.max(0, -shadowXHi)
  const x1 = Math.ceil(inkRight * ss) + marginHi + strokeHi + Math.max(0, shadowXHi)
  const y0 = -Math.ceil(ascent * ss) - marginHi - strokeHi - Math.max(0, -shadowYHi)
  const y1 = Math.ceil(descent * ss) + marginHi + strokeHi + Math.max(0, shadowYHi)
  const canvasW = Math.max(1, x1 - x0)
  const canvasH = Math.max(1, y1 - y0)

  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  const gctx = canvas.getContext('2d')!
  gctx.font = font
  gctx.textAlign = 'left'
  gctx.textBaseline = 'alphabetic'
  // 笔位在画布中的位置：横向 -x0，纵向 -y0（画布上缘到基线的距离）
  const penX = -x0
  const baselineY = -y0
  if (effects.shadow) {
    gctx.shadowColor = effects.shadowColor
    gctx.shadowOffsetX = shadowXHi
    gctx.shadowOffsetY = shadowYHi
    gctx.fillStyle = effects.shadowColor
    gctx.fillText(char, penX, baselineY)
    gctx.shadowColor = 'transparent'
    gctx.shadowOffsetX = 0
    gctx.shadowOffsetY = 0
  }
  if (strokeHi > 0) {
    gctx.lineWidth = strokeHi * 2
    gctx.strokeStyle = effects.strokeColor
    gctx.lineJoin = 'round'
    gctx.strokeText(char, penX, baselineY)
  }
  gctx.fillStyle = '#ffffff'
  gctx.fillText(char, penX, baselineY)
  const image = gctx.getImageData(0, 0, canvasW, canvasH)
  releaseCanvas(canvas)

  return {
    code,
    char,
    image,
    sw: canvasW,
    sh: canvasH,
    xoffsetBase: x0 / ss,
    topPadPx: effects.strokeWidth + (effects.shadow ? Math.max(0, -effects.shadowY) : 0),
    advance,
  }
}

/** 外接框 */
interface BBox {
  x: number
  y: number
  w: number
  h: number
}

/** 求 RGBA 像素按 alpha 的非空外接框；全透明返回 null */
function inkBBoxAlpha(data: Uint8ClampedArray, w: number, h: number): BBox | null {
  return scanBBox(w, h, (x, y) => data[(y * w + x) * 4 + 3] > 0)
}

/** 从多通道缓冲里裁出指定窗口（宽按 w 为原始行宽，channels 为每像素通道数） */
function cropChannels(data: Uint8Array, w: number, channels: number, crop: BBox): Uint8Array {
  const out = new Uint8Array(crop.w * crop.h * channels)
  for (let y = 0; y < crop.h; y++) {
    const from = ((crop.y + y) * w + crop.x) * channels
    out.set(data.subarray(from, from + crop.w * channels), y * crop.w * channels)
  }
  return out
}

/** 按像素判据扫出最小外接框 */
function scanBBox(w: number, h: number, isInk: (x: number, y: number) => boolean): BBox | null {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isInk(x, y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
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
 * 再按 spread 归一化到 0–255：0.5 为边界，字形内部为白、外部为黑，spread 像素外饱和。
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
    // 内部为正、外部为负，保证与主流 SDF / MSDF shader 的「内部亮、外部暗」一致
    const signed = inside[i] ? distToOutside[i] : -distToInside[i]
    const value = Math.round(Math.min(1, Math.max(0, 0.5 + signed * scale)) * 255)
    out[i] = value
  }
  return out
}

/**
 * 覆盖度 → MSDF / MTSDF 多通道距离场。
 *
 * 真实 MSDF 需要字形轮廓数据，而浏览器端只能拿到栅格化结果；这里按边界像素的梯度方向
 * 把它们分成 R/G/B 三组，每个通道只求到本组边沿的距离，shader 取三通道中位数即可在放大时保住尖角。
 * 梯度接近 0（角点）时三组都参与。mtsdf 额外把整体距离场写进 alpha，方便只支持单通道的着色器直接使用。
 */
function coverageToMsdf(coverage: Uint8Array, w: number, h: number, spread: number, withAlpha: boolean): Uint8Array {
  const channels = withAlpha ? 4 : 3
  const out = new Uint8Array(w * h * channels)
  const inside = new Uint8Array(w * h)
  for (let i = 0; i < coverage.length; i++) inside[i] = coverage[i] >= 128 ? 1 : 0

  const edgeMasks = [new Uint8Array(w * h), new Uint8Array(w * h), new Uint8Array(w * h)]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = y * w + x
      const value = inside[index]
      let boundary = false
      for (let oy = -1; oy <= 1 && !boundary; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox
          const ny = y + oy
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          if (inside[ny * w + nx] !== value) { boundary = true; break }
        }
      }
      if (!boundary) continue
      const gx = (x + 1 < w ? coverage[index + 1] : coverage[index]) - (x > 0 ? coverage[index - 1] : coverage[index])
      const gy = (y + 1 < h ? coverage[index + w] : coverage[index]) - (y > 0 ? coverage[index - w] : coverage[index])
      if (Math.abs(gx) < 1 && Math.abs(gy) < 1) {
        edgeMasks[0][index] = 1
        edgeMasks[1][index] = 1
        edgeMasks[2][index] = 1
        continue
      }
      // 梯度方向：竖直边归 R、水平边归 G、斜边归 B
      const angle = Math.atan2(Math.abs(gy), Math.abs(gx))
      edgeMasks[angle < Math.PI / 6 ? 0 : angle < Math.PI / 3 ? 2 : 1][index] = 1
    }
  }

  const scale = 1 / (2 * spread)
  const distances = edgeMasks.map((mask) => distanceTransform(mask, w, h))
  for (let i = 0; i < w * h; i++) {
    for (let channel = 0; channel < 3; channel++) {
      const signed = inside[i] ? distances[channel][i] : -distances[channel][i]
      out[i * channels + channel] = Math.round(Math.min(1, Math.max(0, 0.5 + signed * scale)) * 255)
    }
  }
  if (withAlpha) {
    const single = coverageToSdf(coverage, w, h, spread)
    for (let i = 0; i < w * h; i++) out[i * channels + 3] = single[i]
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
  /** 每页装箱占用率：该页字形外框面积之和 / 页像素面积 */
  pageOccupancy: number[]
}

/**
 * 在若干 2 的幂候选宽度里挑最合适的一种，多页时页尺寸保持一致。
 *
 * 打分以总像素面积为主，但只比面积会出问题：窄页把字形拆到更多页后，
 * 2 的幂补高让它的面积反而更小，于是选出 64×2048 这类极端长条图集。
 * 因此对宽高比超过 2 的候选按超出比例加价，长条页即使面积略小也不会胜出。
 */
function packGlyphBoxes(boxes: GlyphBox[], maxSize: number, powerOfTwo: boolean): PackedAtlas {
  const candidates: number[] = []
  for (let width = 64; width <= maxSize; width *= 2) candidates.push(width)
  if (candidates[candidates.length - 1] !== maxSize) candidates.push(maxSize)

  const areaByCode = new Map<number, number>()
  for (const box of boxes) areaByCode.set(box.code, box.w * box.h)

  let best: { width: number; height: number; layout: ShelfLayout } | null = null
  let bestScore = Infinity
  for (const width of candidates) {
    const layout = shelfPack(boxes, width, maxSize)
    const usedW = Math.max(...layout.used.map((u) => u.w), 1)
    const usedH = Math.max(...layout.used.map((u) => u.h), 1)
    const pageW = powerOfTwo ? width : Math.min(width, usedW)
    const pageH = powerOfTwo ? nextPowerOfTwo(usedH) : usedH
    const aspect = Math.max(pageW, pageH) / Math.min(pageW, pageH)
    // 丢字形的候选必须重罚，否则「窄页跳过放不下的字形」会因面积更小而胜出
    const score = layout.skipped * 1e9
      + pageW * pageH * layout.pages.length * (1 + 0.06 * Math.max(0, aspect - 2))
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
  const pageArea = Math.max(1, chosen.width * chosen.height)
  const pageOccupancy = chosen.layout.pages.map((page) => {
    let sum = 0
    for (const placement of page) sum += areaByCode.get(placement.code) ?? 0
    return Math.min(1, sum / pageArea)
  })
  return {
    pages: chosen.layout.pages.map(() => ({ width: chosen.width, height: chosen.height })),
    placements,
    indexByCode,
    pageOccupancy,
  }
}

/* ------------------------------------------------------------------ */
/* 字距（Kerning）                                                      */
/* ------------------------------------------------------------------ */

/** 逐行墨迹范围：用于按行计算字距（列坐标相对笔位） */
interface KerningSource {
  code: number
  advance: number
  /** 每行墨迹的首 / 末列（相对笔位），无墨迹为 -1 */
  first: Int16Array
  last: Int16Array
}

/**
 * 取一个字形的逐行墨迹范围。
 * 行坐标用「画布行」，各字形的画布上下界只由 ascent / descent / margin / 效果决定，
 * 因此不同字形的同一行号对齐，可以直接逐行比较。
 */
function buildKerningRows(
  code: number,
  advance: number,
  w: number,
  h: number,
  xoffsetBase: number,
  isInk: (x: number, y: number) => boolean,
): KerningSource {
  const first = new Int16Array(h).fill(-1)
  const last = new Int16Array(h).fill(-1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isInk(x, y)) continue
      const column = Math.round(xoffsetBase + x)
      if (first[y] < 0) first[y] = column
      last[y] = column
    }
  }
  return { code, advance, first, last }
}

/** 自动字距的字符数上限：逐对比较是 O(n²)，太多会拖慢生成 */
const MAX_KERNING_GLYPHS = 512
/** 自动字距表条数上限，避免大字符集导出元数据膨胀 */
const MAX_KERNING_PAIRS = 4000

/**
 * 按墨迹几何自动计算字距表。
 *
 * 先逐对求两字形墨迹的逐行最小水平间隙，再取全体间隙的 60 分位作为「典型间隙」：
 * 字体自带的左右边距本来就是这个量级，把它们一律收掉等于压缩字间距，并不是 kerning。
 * 只有比典型间隙还紧、且差值达到容差（约字号的 6%）的字符对，才算真正需要互相靠近的组合
 * （如 AV / To / r.），按差值收紧；调整量取整后不足 1px 的丢弃。
 */
function computeKerning(sources: KerningSource[], letterSpacing: number, sizePx: number): FontKerningPair[] {
  const measured: Array<{ first: number; second: number; gap: number }> = []
  for (const a of sources) {
    for (const b of sources) {
      let minGap = Infinity
      const rows = Math.min(a.first.length, b.first.length)
      for (let y = 0; y < rows; y++) {
        if (a.last[y] < 0 || b.first[y] < 0) continue
        const gap = a.advance + letterSpacing - a.last[y] + b.first[y]
        if (gap < minGap) minGap = gap
      }
      if (Number.isFinite(minGap)) measured.push({ first: a.code, second: b.code, gap: minGap })
    }
  }
  if (!measured.length) return []
  const sorted = measured.map((item) => item.gap).sort((x, y) => x - y)
  const typical = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.6))]
  const tolerance = Math.max(1, Math.round(sizePx * 0.06))
  const pairs: FontKerningPair[] = []
  for (const item of measured) {
    if (item.gap > typical - tolerance) continue
    const amount = Math.round(Math.min(0, -(item.gap - typical)))
    if (amount > -1) continue
    pairs.push({ first: item.first, second: item.second, amount })
  }
  pairs.sort((x, y) => x.amount - y.amount)
  return pairs.slice(0, MAX_KERNING_PAIRS)
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成字体图集与字形度量。
 * 步骤：合成字符集 → 逐字栅格化（带超采样）→ 按需转距离场 → 货架装箱 → 组装 BMFont 度量。
 */
export async function buildFont(options: FontBuildOptions): Promise<FontBuildResult> {
  const startedAt = performance.now()
  const warnings: string[] = []
  const exclude = new Set(options.excludeChars ?? [])
  const all = Array.from(buildCharset(options))
  const target = all.filter((char) => !exclude.has(char.codePointAt(0)!))
  const excludedCount = all.length - target.length
  const chars = target.slice(0, MAX_GLYPHS)
  if (target.length > chars.length) warnings.push(`字符数 ${target.length} 超过上限 ${MAX_GLYPHS}，已截断`)
  if (excludedCount) warnings.push(`已排除 ${excludedCount} 个字符`)
  if (!chars.length) throw new Error('字符集为空，请至少勾选一个预设或填写自定义字符')

  const sizePx = Math.max(6, Math.round(options.sizePx))
  const padding = Math.max(0, Math.round(options.padding))
  const letterSpacing = Math.round(options.letterSpacing ?? 0)
  const lineSpacing = Math.round(options.lineSpacing ?? 0)
  const distanceField = isDistanceFieldMode(options.mode)
  const spread = distanceField ? Math.max(1, Math.round(options.sdfSpread)) : 0
  const sdfThreshold = Math.min(1, Math.max(0, options.sdfThreshold ?? 0.5))
  const ss = sizePx <= 32 ? 4 : sizePx <= 64 ? 2 : 1
  // 描边 / 阴影只对位图模式生效：距离场本身是单色场，轮廓与投影交给引擎 shader
  const effects: FontEffects = {
    strokeWidth: distanceField ? 0 : Math.max(0, Math.round(options.strokeWidth ?? 0)),
    strokeColor: options.strokeColor || '#000000',
    shadow: !distanceField && Boolean(options.shadowEnabled),
    shadowX: options.shadowX ?? 0,
    shadowY: options.shadowY ?? 0,
    shadowColor: options.shadowColor || '#000000',
  }

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
  const kernSources: KerningSource[] = []
  const placed: Array<{ code: number; bitmap: GlyphBitmap; xoffset: number; yoffset: number; advance: number }> = []

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    const code = char.codePointAt(0)!
    const raster = rasterizeGlyph(ctx, options.family, char, code, sizePx, ascent, descent, marginPx, ss, effects)
    let bitmap: GlyphBitmap
    let xoffset: number
    let yoffset: number
    if (options.mode === 'bitmap') {
      const small = downsampleRgba(raster.image.data, raster.sw, raster.sh, ss)
      kernSources.push(buildKerningRows(code, raster.advance, small.w, small.h, raster.xoffsetBase, (x, y) => small.data[(y * small.w + x) * 4 + 3] > 0))
      const bbox = inkBBoxAlpha(small.data, small.w, small.h)
      if (!bbox) {
        // 空格类字形没有墨迹：只保留步进宽度
        bitmap = { w: 0, h: 0, channels: 4, data: new Uint8ClampedArray(0) }
        xoffset = 0
        yoffset = 0
        boxes.push({ code, w: 0, h: 0 })
      } else {
        const trimmed = new Uint8ClampedArray(bbox.w * bbox.h * 4)
        for (let y = 0; y < bbox.h; y++) {
          const from = ((bbox.y + y) * small.w + bbox.x) * 4
          trimmed.set(small.data.subarray(from, from + bbox.w * 4), y * bbox.w * 4)
        }
        bitmap = { w: bbox.w, h: bbox.h, channels: 4, data: trimmed }
        xoffset = Math.round(raster.xoffsetBase + bbox.x)
        // BMFont 的 yoffset 相对行顶（基线 - ascent），故从 bbox 位置换算回行顶
        yoffset = Math.round(bbox.y - marginPx - raster.topPadPx)
        boxes.push({ code, w: bbox.w + padding * 2, h: bbox.h + padding * 2 })
      }
    } else {
      const coverage = downsampleAlpha(raster.image.data, raster.sw, raster.sh, ss)
      kernSources.push(buildKerningRows(code, raster.advance, coverage.w, coverage.h, raster.xoffsetBase, (x, y) => coverage.data[y * coverage.w + x] >= 128))
      const channels = options.mode === 'sdf' ? 1 : options.mode === 'mtsdf' ? 4 : 3
      const field = options.mode === 'sdf'
        ? coverageToSdf(coverage.data, coverage.w, coverage.h, spread)
        : coverageToMsdf(coverage.data, coverage.w, coverage.h, spread, options.mode === 'mtsdf')
      // 距离场裁到「墨迹外扩 spread」：既留足过渡带，又不用让每个字形都占满 ascent+descent 的整行高
      const ink = scanBBox(coverage.w, coverage.h, (x, y) => coverage.data[y * coverage.w + x] > 0)
      if (!ink) {
        bitmap = { w: 0, h: 0, channels, data: new Uint8Array(0) }
        xoffset = 0
        yoffset = 0
        boxes.push({ code, w: 0, h: 0 })
      } else {
        const crop: BBox = {
          x: Math.max(0, ink.x - spread),
          y: Math.max(0, ink.y - spread),
          w: 0,
          h: 0,
        }
        crop.w = Math.min(coverage.w, ink.x + ink.w + spread) - crop.x
        crop.h = Math.min(coverage.h, ink.y + ink.h + spread) - crop.y
        bitmap = { w: crop.w, h: crop.h, channels, data: cropChannels(field, coverage.w, channels, crop) }
        xoffset = Math.round(raster.xoffsetBase + crop.x)
        // 与位图模式同构：行顶到裁剪框上缘的距离（距离场模式没有描边 / 阴影的额外上边距）
        yoffset = crop.y - marginPx
        boxes.push({ code, w: crop.w + padding * 2, h: crop.h + padding * 2 })
      }
    }
    pixels.set(code, bitmap)
    placed.push({ code, bitmap, xoffset, yoffset, advance: raster.advance })

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

  for (const item of placed) {
    const index = packed.indexByCode.get(item.code)
    const metrics = index === undefined ? null : packed.placements[index]
    glyphs.push({
      char: String.fromCodePoint(item.code),
      code: item.code,
      page: metrics ? metrics.page : 0,
      x: metrics ? metrics.x + padding : 0,
      y: metrics ? metrics.y + padding : 0,
      width: item.bitmap.w,
      height: item.bitmap.h,
      xoffset: item.xoffset,
      yoffset: item.yoffset,
      xadvance: Math.max(0, Math.round(item.advance) + letterSpacing),
    })
  }

  // 自动字距 + 手动覆盖：手动优先，只保留两端字符都在本次字符集里的条目
  const merged = new Map<string, FontKerningPair>()
  if (options.kerning) {
    let sources = kernSources
    if (sources.length > MAX_KERNING_GLYPHS) {
      sources = sources.slice(0, MAX_KERNING_GLYPHS)
      warnings.push(`字符数超过 ${MAX_KERNING_GLYPHS}，自动字距只对前 ${MAX_KERNING_GLYPHS} 个字符计算`)
    }
    for (const pair of computeKerning(sources, letterSpacing, sizePx)) {
      merged.set(`${pair.first},${pair.second}`, pair)
    }
  }
  for (const pair of options.kerningPairs ?? []) {
    merged.set(`${pair.first},${pair.second}`, { ...pair })
  }
  const kerning = Array.from(merged.values()).filter((pair) => pixels.has(pair.first) && pixels.has(pair.second))

  return {
    pages: packed.pages,
    glyphs,
    pixels,
    lineHeight: Math.round(ascent + descent) + lineSpacing,
    base: Math.round(ascent),
    ascent: Math.round(ascent),
    descent: Math.round(descent),
    letterSpacing,
    lineSpacing,
    sizePx,
    mode: options.mode,
    sdfSpread: spread,
    sdfThreshold,
    padding,
    kerning,
    excludedCount,
    occupancy: packed.pageOccupancy.length
      ? packed.pageOccupancy.reduce((sum, value) => sum + value, 0) / packed.pageOccupancy.length
      : 0,
    pageOccupancy: packed.pageOccupancy,
    buildMs: Math.round(performance.now() - startedAt),
    warnings,
  }
}

/** 把字形像素按落位拼成一页的像素缓冲（预览与导出共用同一套拼页逻辑） */
export function renderFontPageImageData(result: FontBuildResult, pageIndex: number): ImageData | null {
  const page = result.pages[pageIndex]
  if (!page) return null
  const buffer = new Uint8ClampedArray(page.width * page.height * 4)
  // sdf / msdf 页必须整页不透明：空白区域代表「远离字形」（外部距离为负 → 黑），
  // 若留成透明像素，解码后 RGB 会被清零且 alpha 为 0，着色器采样就丢了距离信息。
  // mtsdf 的 alpha 本身就是距离值（外部同样为 0），因此不能铺不透明底，保持透明黑即可。
  if (result.mode === 'sdf' || result.mode === 'msdf') {
    for (let i = 3; i < buffer.length; i += 4) buffer[i] = 255
  }
  for (const glyph of result.glyphs) {
    if (glyph.page !== pageIndex || !glyph.width || !glyph.height) continue
    const bitmap = result.pixels.get(glyph.code)
    if (!bitmap) continue
    const { channels } = bitmap
    for (let y = 0; y < glyph.height; y++) {
      for (let x = 0; x < glyph.width; x++) {
        const source = (y * glyph.width + x) * channels
        const target = ((glyph.y + y) * page.width + glyph.x + x) * 4
        if (channels === 1) {
          // 单通道距离场：复制到 RGB，alpha 全不透明，着色交给 shader
          const value = bitmap.data[source]
          buffer[target] = value
          buffer[target + 1] = value
          buffer[target + 2] = value
          buffer[target + 3] = 255
        } else if (channels === 3) {
          // MSDF：RGB 三通道各存一组边沿的距离场
          buffer[target] = bitmap.data[source]
          buffer[target + 1] = bitmap.data[source + 1]
          buffer[target + 2] = bitmap.data[source + 2]
          buffer[target + 3] = 255
        } else {
          // 位图（白字 + 描边/阴影，RGBA）与 MTSDF（RGB 距离场 + alpha 单通道距离场）
          buffer[target] = bitmap.data[source]
          buffer[target + 1] = bitmap.data[source + 1]
          buffer[target + 2] = bitmap.data[source + 2]
          buffer[target + 3] = bitmap.data[source + 3]
        }
      }
    }
  }
  return new ImageData(buffer, page.width, page.height)
}

/** 把字形像素按落位拼进各页画布，返回每页的 PNG dataURL */
export function renderFontPages(result: FontBuildResult): string[] {
  return result.pages.map((page, pageIndex) => {
    const image = renderFontPageImageData(result, pageIndex)!
    const canvas = document.createElement('canvas')
    canvas.width = page.width
    canvas.height = page.height
    canvas.getContext('2d')!.putImageData(image, 0, 0)
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
  // 相邻字形各自带一圈留白，实际间隙是两倍留白；原实现写死 1,1 与用户参数不符
  const spacing = `${result.padding * 2},${result.padding * 2}`
  const sdf = isDistanceFieldMode(result.mode) ? ` distanceField=${result.sdfSpread}` : ''
  lines.push(`info face="${name}" size=${result.sizePx} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=${pad} spacing=${spacing} outline=0${sdf}`)
  lines.push(`common lineHeight=${result.lineHeight} base=${result.base} scaleW=${result.pages[0]?.width ?? 0} scaleH=${result.pages[0]?.height ?? 0} pages=${result.pages.length} packed=0`)
  result.pages.forEach((_, index) => lines.push(`page id=${index} file="${pageFileName(name, index)}"`))
  lines.push(`chars count=${result.glyphs.length}`)
  for (const glyph of result.glyphs) {
    lines.push(`char id=${glyph.code} x=${glyph.x} y=${glyph.y} width=${glyph.width} height=${glyph.height} xoffset=${glyph.xoffset} yoffset=${glyph.yoffset} xadvance=${glyph.xadvance} page=${glyph.page} chnl=15`)
  }
  lines.push(`kernings count=${result.kerning.length}`)
  for (const pair of result.kerning) {
    lines.push(`kerning first=${pair.first} second=${pair.second} amount=${pair.amount}`)
  }
  return `${lines.join('\n')}\n`
}

/** BMFont XML 格式，字段与文本格式一一对应 */
export function buildBmfontXml(result: FontBuildResult, name: string): string {
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const pad = `${result.padding},${result.padding},${result.padding},${result.padding}`
  const spacing = `${result.padding * 2},${result.padding * 2}`
  const sdf = isDistanceFieldMode(result.mode) ? ` distanceField="${result.sdfSpread}"` : ''
  const rows: string[] = []
  rows.push('<?xml version="1.0"?>')
  rows.push('<font>')
  rows.push(`  <info face="${escape(name)}" size="${result.sizePx}" bold="0" italic="0" charset="" unicode="1" stretchH="100" smooth="1" aa="1" padding="${pad}" spacing="${spacing}" outline="0"${sdf}/>`)
  rows.push(`  <common lineHeight="${result.lineHeight}" base="${result.base}" scaleW="${result.pages[0]?.width ?? 0}" scaleH="${result.pages[0]?.height ?? 0}" pages="${result.pages.length}" packed="0"/>`)
  result.pages.forEach((_, index) => rows.push(`  <page id="${index}" file="${escape(pageFileName(name, index))}"/>`))
  rows.push(`  <chars count="${result.glyphs.length}">`)
  for (const glyph of result.glyphs) {
    rows.push(`    <char id="${glyph.code}" x="${glyph.x}" y="${glyph.y}" width="${glyph.width}" height="${glyph.height}" xoffset="${glyph.xoffset}" yoffset="${glyph.yoffset}" xadvance="${glyph.xadvance}" page="${glyph.page}" chnl="15"/>`)
  }
  rows.push('  </chars>')
  rows.push(`  <kernings count="${result.kerning.length}">`)
  for (const pair of result.kerning) {
    rows.push(`    <kerning first="${pair.first}" second="${pair.second}" amount="${pair.amount}"/>`)
  }
  rows.push('  </kernings>')
  rows.push('</font>')
  return `${rows.join('\n')}\n`
}

/** JSON 元数据：保留浮点步进等 BMFont 文本格式装不下的信息，便于脚本侧做二次处理 */
export function buildFontJson(result: FontBuildResult, name: string): string {
  return JSON.stringify({
    name,
    size: result.sizePx,
    mode: result.mode,
    ...(isDistanceFieldMode(result.mode) ? { sdfSpread: result.sdfSpread, sdfThreshold: result.sdfThreshold } : {}),
    padding: result.padding,
    lineHeight: result.lineHeight,
    base: result.base,
    letterSpacing: result.letterSpacing,
    lineSpacing: result.lineSpacing,
    pages: result.pages.map((page, index) => ({
      file: pageFileName(name, index),
      width: page.width,
      height: page.height,
      occupancy: Math.round((result.pageOccupancy[index] ?? 0) * 1000) / 1000,
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
    kerning: result.kerning.map((pair) => ({
      char: String.fromCodePoint(pair.first),
      first: pair.first,
      second: pair.second,
      amount: pair.amount,
    })),
  }, null, 2)
}