/**
 * 雪碧图打包。
 *
 * 输入多张图片，用 MaxRects 装箱算法把它们紧凑排进一张（或多张）图集，
 * 支持透明边裁剪（trim）、90° 旋转、素材留白（padding）、边缘外扩（extrude）、
 * 网格布局与三种装箱启发式；「智能」体现在自动搜索尽量小的图集边长，
 * 素材放不下时自动溢出到下一页（多页打包）。
 */
import { imageToImageData, releaseCanvas } from '@/core/image'
import { trimBBox } from '@/core/trim'
import type { FrameMeta } from '@/core/atlas-meta'

/** 参与打包的素材（含已解码图像，便于裁剪与绘制） */
export interface PackItem {
  id: string
  /** 原始文件名，用于导出命名 */
  name: string
  image: HTMLImageElement
}

/** 布局方式：compact = MaxRects 紧凑装箱；grid = 固定网格；strip-h/v = 按导入顺序单行/单列条带 */
export type PackLayout = 'compact' | 'grid' | 'strip-h' | 'strip-v'

/** 紧凑布局的装箱启发式：bssf 残留最短边 / bl 底左 / contact 接触周长 */
export type PackHeuristic = 'bssf' | 'bl' | 'contact'

export interface PackOptions {
  /** 每个素材四周留白（像素），避免采样时相邻素材渗色 */
  padding: number
  /** 图集四周外边距（像素） */
  margin: number
  /** 图集最大边长上限 */
  maxSize: number
  /** 是否允许把素材旋转 90° 以提升紧凑度（网格布局下不生效） */
  allowRotate: boolean
  /** 图集宽高是否为 2 的幂（部分旧引擎的纹理要求） */
  powerOfTwo: boolean
  /** 是否裁掉透明边，只打包实际内容 */
  trim: boolean
  /** 裁剪时的 alpha 阈值 */
  alphaThreshold: number
  /** 布局方式 */
  layout: PackLayout
  /** 紧凑布局的装箱启发式 */
  heuristic: PackHeuristic
  /** 网格列数（0 = 按 ceil(sqrt(n)) 自动） */
  gridColumns: number
  /** 网格单元格边长（0 = 按最大素材自动） */
  gridCell: number
  /** 内容边缘向外复制的像素数（0/1/2），防止渲染时边缘渗色 */
  extrude: 0 | 1 | 2
  /** 内容完全相同的帧只存一份纹理，其余帧名指向同一区域（alias 机制） */
  mergeDuplicate: boolean
}

export interface PackPlacement {
  id: string
  name: string
  /** 纹理中的实际打包矩形（含留白与 extrude；旋转帧为旋转后的宽高） */
  x: number
  y: number
  w: number
  h: number
  rotated: boolean
  trimmed: boolean
  /** 原帧尺寸（未旋转） */
  sourceSize: { w: number; h: number }
  /** 内容在原帧中的偏移（未裁剪时为 0,0） */
  contentOffset: { x: number; y: number }
  /** 内容尺寸（未旋转） */
  contentSize: { w: number; h: number }
  /** 别名帧：内容与 id 所指帧完全相同，绘制时跳过（仅渲染层使用） */
  aliasOfId?: string
}

/** 多页打包中的单张图集 */
export interface PackPage {
  width: number
  height: number
  placements: PackPlacement[]
  fillRatio: number
}

/** 多页打包结果；errors 收集无法打包的素材及原因 */
export interface PackMultiResult {
  pages: PackPage[]
  errors: string[]
}

/** 内部准备数据：把素材收敛成「内容尺寸 + 偏移」 */
interface PreparedItem {
  id: string
  name: string
  image: HTMLImageElement
  sourceSize: { w: number; h: number }
  contentOffset: { x: number; y: number }
  contentSize: { w: number; h: number }
  trimmed: boolean
  /** 内容区域像素哈希（mergeDuplicate 用），空串表示未计算 */
  contentHash: string
}

interface Box {
  id: string
  /** 含留白与 extrude 的打包尺寸 */
  w: number
  h: number
  canRotate: boolean
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 对指定内容区域做双重像素哈希（FNV-1a + djb2，RGBA 逐字节），用于识别内容完全相同的重复帧。
 * 尺寸字节参与哈希，避免不同尺寸内容碰撞；双哈希把误判率压到可忽略。
 */
function hashPixels(data: ImageData, ox: number, oy: number, w: number, h: number): string {
  const d = data.data
  let h1 = 0x811c9dc5
  let h2 = 5381
  const mix = (byte: number): void => {
    h1 = Math.imul(h1 ^ byte, 0x01000193)
    h2 = Math.imul(h2, 33) ^ byte
  }
  mix(w & 0xff); mix((w >>> 8) & 0xff); mix(h & 0xff); mix((h >>> 8) & 0xff)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((oy + y) * data.width + ox + x) * 4
      mix(d[i]); mix(d[i + 1]); mix(d[i + 2]); mix(d[i + 3])
    }
  }
  return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`
}

/**
 * 预处理素材：按需裁剪透明边，算出内容尺寸与原帧偏移。
 * 全透明素材在裁剪模式下直接跳过（没有可打包的内容）。
 * mergeDuplicate 开启时同步计算内容像素哈希。
 */
function prepareItems(items: PackItem[], opts: PackOptions): PreparedItem[] {
  const prepared: PreparedItem[] = []
  const needPixels = opts.trim || opts.mergeDuplicate
  for (const item of items) {
    const sourceSize = { w: item.image.naturalWidth, h: item.image.naturalHeight }
    const pixels = needPixels ? imageToImageData(item.image) : null
    if (!opts.trim) {
      prepared.push({
        id: item.id, name: item.name, image: item.image,
        sourceSize, contentOffset: { x: 0, y: 0 }, contentSize: { ...sourceSize }, trimmed: false,
        contentHash: pixels ? hashPixels(pixels, 0, 0, sourceSize.w, sourceSize.h) : '',
      })
      continue
    }
    const bbox = trimBBox(pixels!, opts.alphaThreshold)
    if (!bbox) continue
    prepared.push({
      id: item.id, name: item.name, image: item.image,
      sourceSize,
      contentOffset: { x: bbox.x, y: bbox.y },
      contentSize: { w: bbox.w, h: bbox.h },
      trimmed: bbox.x > 0 || bbox.y > 0 || bbox.w < sourceSize.w || bbox.h < sourceSize.h,
      contentHash: hashPixels(pixels!, bbox.x, bbox.y, bbox.w, bbox.h),
    })
  }
  return prepared
}

/** 别名条目：alias 帧的内容与 repId 帧完全相同，装箱只排 rep，渲染/元数据把 alias 指向同一区域 */
interface AliasEntry {
  alias: PreparedItem
  repId: string
}

/** 合并内容完全相同的素材：首个出现者作为代表参与装箱，其余记入别名列表 */
function collectAliases(prepared: PreparedItem[]): { reps: PreparedItem[]; aliases: AliasEntry[] } {
  const seen = new Map<string, PreparedItem>()
  const reps: PreparedItem[] = []
  const aliases: AliasEntry[] = []
  for (const item of prepared) {
    const rep = seen.get(item.contentHash)
    if (rep) aliases.push({ alias: item, repId: rep.id })
    else { seen.set(item.contentHash, item); reps.push(item) }
  }
  return { reps, aliases }
}

/** 把别名帧补进各页落位表：紧跟代表帧之后，几何复用代表帧，绘制与导出时按名字各自成帧 */
function expandAliases(pages: PackPage[], aliases: AliasEntry[]): void {
  if (!aliases.length) return
  for (const page of pages) {
    const expanded: PackPlacement[] = []
    for (const p of page.placements) {
      expanded.push(p)
      for (const { alias, repId } of aliases) {
        if (repId !== p.id) continue
        expanded.push({
          ...p,
          id: alias.id,
          name: alias.name,
          aliasOfId: p.id,
          trimmed: alias.trimmed,
          sourceSize: { ...alias.sourceSize },
          contentOffset: { ...alias.contentOffset },
          contentSize: { ...alias.contentSize },
        })
      }
    }
    page.placements = expanded
  }
}

/** 两个矩形是否相交（边贴边不算相交） */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** 去除被其他空闲矩形完全包含的冗余项，控制空闲列表规模 */
function pruneFreeRects(free: Rect[]): void {
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      const a = free[i]
      const b = free[j]
      const aInB = a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
      const bInA = b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h
      if (aInB) { free.splice(i, 1); i--; break }
      if (bInA) { free.splice(j, 1); j-- }
    }
  }
}

/** 用已放置矩形切分空闲矩形列表（MaxRects 维护策略） */
function splitFreeRects(free: Rect[], placed: Rect): void {
  for (let i = free.length - 1; i >= 0; i--) {
    const fr = free[i]
    if (!intersects(fr, placed)) continue
    free.splice(i, 1)
    // 左 / 右 / 上 / 下四块残余空间
    if (placed.x > fr.x) free.push({ x: fr.x, y: fr.y, w: placed.x - fr.x, h: fr.h })
    if (placed.x + placed.w < fr.x + fr.w) {
      free.push({ x: placed.x + placed.w, y: fr.y, w: fr.x + fr.w - (placed.x + placed.w), h: fr.h })
    }
    if (placed.y > fr.y) free.push({ x: fr.x, y: fr.y, w: fr.w, h: placed.y - fr.y })
    if (placed.y + placed.h < fr.y + fr.h) {
      free.push({ x: fr.x, y: placed.y + placed.h, w: fr.w, h: fr.y + fr.h - (placed.y + placed.h) })
    }
  }
  pruneFreeRects(free)
}

/**
 * 计算候选矩形与已放置矩形及箱子边界的接触周长（contact 启发式，越大越紧凑）。
 * 接触指边贴边（有重叠跨度），重叠部分长度计入周长。
 */
function contactPerimeter(rect: Rect, placed: Rect[], binW: number, binH: number): number {
  let contact = 0
  // 与箱子四边的接触
  if (rect.x === 0) contact += rect.h
  if (rect.y === 0) contact += rect.w
  if (rect.x + rect.w === binW) contact += rect.h
  if (rect.y + rect.h === binH) contact += rect.w
  // 与每个已放置矩形的边贴边接触
  for (const p of placed) {
    const vOverlap = Math.min(rect.y + rect.h, p.y + p.h) - Math.max(rect.y, p.y)
    const hOverlap = Math.min(rect.x + rect.w, p.x + p.w) - Math.max(rect.x, p.x)
    if (hOverlap > 0) {
      if (rect.y === p.y + p.h || p.y === rect.y + rect.h) contact += hOverlap
    }
    if (vOverlap > 0) {
      if (rect.x === p.x + p.w || p.x === rect.x + rect.w) contact += vOverlap
    }
  }
  return contact
}

/**
 * 按启发式给单个候选位置评分，返回「越小越好」的 [主评分, 次评分]。
 * bssf：残留短边优先、长边次之；bl：底边优先（y+h）、左缘次之；contact：取负接触周长。
 */
function scorePlacement(
  heuristic: PackHeuristic,
  fr: Rect,
  o: { w: number; h: number },
  placed: Rect[],
  binW: number,
  binH: number,
): [number, number] {
  if (heuristic === 'bl') return [fr.y + o.h, fr.x + o.w]
  if (heuristic === 'contact') {
    return [-contactPerimeter({ x: fr.x, y: fr.y, w: o.w, h: o.h }, placed, binW, binH), fr.y + o.h]
  }
  const leftoverH = Math.abs(fr.w - o.w)
  const leftoverV = Math.abs(fr.h - o.h)
  return [Math.min(leftoverH, leftoverV), Math.max(leftoverH, leftoverV)]
}

/** 单个装箱动作的产出 */
interface BinPacking {
  placements: Array<{ id: string; x: number; y: number; w: number; h: number; rotated: boolean }>
  usedW: number
  usedH: number
  /** 放不下而被跳过的盒子（多页打包用；全部放下则为空） */
  skipped: Box[]
}

/**
 * 把一组盒子打进指定尺寸的箱子。
 * strict = true（单页模式）：遇到放不下的盒子直接返回 null；
 * strict = false（多页模式）：跳过放不下的盒子继续，skipped 供溢出到下一页。
 */
function packIntoBin(
  boxes: Box[],
  binW: number,
  binH: number,
  allowRotate: boolean,
  heuristic: PackHeuristic,
  strict: boolean,
): BinPacking | null {
  const free: Rect[] = [{ x: 0, y: 0, w: binW, h: binH }]
  const placements: BinPacking['placements'] = []
  const placedRects: Rect[] = []
  const skipped: Box[] = []
  let usedW = 0
  let usedH = 0

  for (const box of boxes) {
    let bestX = 0
    let bestY = 0
    let bestW = 0
    let bestH = 0
    let bestRotated = false
    let bestScore: [number, number] = [Infinity, Infinity]
    let found = false

    for (const fr of free) {
      // 两种朝向：原样 / 旋转 90°
      const orientations: Array<{ w: number; h: number; rotated: boolean }> = [{ w: box.w, h: box.h, rotated: false }]
      if (allowRotate && box.canRotate && box.w !== box.h) orientations.push({ w: box.h, h: box.w, rotated: true })
      for (const o of orientations) {
        if (o.w > fr.w || o.h > fr.h) continue
        const score = scorePlacement(heuristic, fr, o, placedRects, binW, binH)
        if (score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
          bestX = fr.x; bestY = fr.y; bestW = o.w; bestH = o.h
          bestRotated = o.rotated; bestScore = score; found = true
        }
      }
    }

    if (!found) {
      if (strict) return null
      skipped.push(box)
      continue
    }
    placements.push({ id: box.id, x: bestX, y: bestY, w: bestW, h: bestH, rotated: bestRotated })
    placedRects.push({ x: bestX, y: bestY, w: bestW, h: bestH })
    usedW = Math.max(usedW, bestX + bestW)
    usedH = Math.max(usedH, bestY + bestH)
    splitFreeRects(free, { x: bestX, y: bestY, w: bestW, h: bestH })
  }

  return { placements, usedW, usedH, skipped }
}

/** 向上取整到 2 的幂 */
function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) size *= 2
  return size
}

/** 归一化打包选项：收敛取整与默认值 */
function normalizeOptions(opts: PackOptions): PackOptions {
  return {
    ...opts,
    padding: Math.max(0, Math.round(opts.padding)),
    margin: Math.max(0, Math.round(opts.margin)),
    maxSize: Math.max(16, Math.round(opts.maxSize)),
    gridColumns: Math.max(0, Math.round(opts.gridColumns)),
    gridCell: Math.max(0, Math.round(opts.gridCell)),
  }
}

/** 由预处理素材构造装箱盒子：尺寸 = 内容 + 留白×2 + extrude×2，长边优先排序 */
function buildBoxes(prepared: PreparedItem[], opts: PackOptions): Box[] {
  const grow = opts.padding * 2 + opts.extrude * 2
  return prepared
    .map((item) => ({
      id: item.id,
      w: item.contentSize.w + grow,
      h: item.contentSize.h + grow,
      canRotate: opts.allowRotate,
    }))
    .sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h)
}

/** 由盒子列表反查预处理素材（保持盒子的构建映射） */
function mapById<T extends { id: string }>(list: T[]): Map<string, T> {
  return new Map(list.map((item) => [item.id, item]))
}

/**
 * 网格布局：按固定单元格排布（不旋转、格内居中），超出单页容量的素材溢出到后续页。
 * cell = 0 时按最大盒子尺寸自动；columns = 0 时按 ceil(sqrt(n)) 自动。
 */
function layoutGridPages(prepared: PreparedItem[], opts: PackOptions): PackMultiResult {
  const pages: PackPage[] = []
  const errors: string[] = []
  if (!prepared.length) return { pages, errors }

  const grow = opts.padding * 2 + opts.extrude * 2
  const maxBoxW = Math.max(...prepared.map((item) => item.contentSize.w + grow))
  const maxBoxH = Math.max(...prepared.map((item) => item.contentSize.h + grow))
  // 单元格取「用户指定」与「最大盒子」的较大值，保证任何素材都不会溢出格子
  const cellW = Math.max(1, opts.gridCell || maxBoxW, maxBoxW)
  const cellH = Math.max(1, opts.gridCell || maxBoxH, maxBoxH)
  const columns = Math.max(1, opts.gridColumns || Math.ceil(Math.sqrt(prepared.length)))
  const inner = opts.maxSize - opts.margin * 2
  if (cellW > inner || cellH > inner) {
    return { pages, errors: [`网格单元格 ${cellW}×${cellH} 超出最大尺寸 ${opts.maxSize}px（含外边距）`] }
  }
  const colsPerPage = Math.max(1, Math.floor(inner / cellW))
  const rowsPerPage = Math.max(1, Math.floor(inner / cellH))
  // 每页实际使用的列数：用户列数与单页容量的较小值，保证一行不超出页宽
  const effectiveColumns = Math.min(columns, colsPerPage)
  const perPage = colsPerPage * rowsPerPage

  for (let start = 0; start < prepared.length; start += perPage) {
    const chunk = prepared.slice(start, start + perPage)
    const rows = Math.ceil(chunk.length / effectiveColumns)
    const placements: PackPlacement[] = chunk.map((item, index) => {
      const gridCol = index % effectiveColumns
      const gridRow = Math.floor(index / effectiveColumns)
      const boxW = item.contentSize.w + grow
      const boxH = item.contentSize.h + grow
      // 盒子在单元格内居中，placement 记实际盒子矩形（与紧凑布局同构）
      const cellX = opts.margin + gridCol * cellW
      const cellY = opts.margin + gridRow * cellH
      return {
        id: item.id,
        name: item.name,
        x: cellX + Math.floor((cellW - boxW) / 2),
        y: cellY + Math.floor((cellH - boxH) / 2),
        w: boxW,
        h: boxH,
        rotated: false,
        trimmed: item.trimmed,
        sourceSize: { ...item.sourceSize },
        contentOffset: { ...item.contentOffset },
        contentSize: { ...item.contentSize },
      }
    })
    const usedCols = Math.min(chunk.length, effectiveColumns)
    const width = opts.margin * 2 + usedCols * cellW
    const height = opts.margin * 2 + rows * cellH
    const contentArea = chunk.reduce((sum, item) => sum + item.contentSize.w * item.contentSize.h, 0)
    pages.push({ width, height, placements, fillRatio: contentArea / (width * height) })
  }
  return { pages, errors }
}

/**
 * 条带布局：按导入顺序单行（h）或单列（v）排布，不旋转、格内对齐主轴起点，
 * 超出单页容量的素材溢出到下一页；单独放不进的素材记入 errors。
 */
function layoutStripPages(prepared: PreparedItem[], opts: PackOptions, dir: 'h' | 'v'): PackMultiResult {
  const pages: PackPage[] = []
  const errors: string[] = []
  if (!prepared.length) return { pages, errors }
  const grow = opts.padding * 2 + opts.extrude * 2
  const inner = opts.maxSize - opts.margin * 2
  if (inner <= 0) return { pages, errors: [`最大尺寸 ${opts.maxSize}px 不足以容纳外边距 ${opts.margin}px`] }

  const contentAreaById = new Map(prepared.map((item) => [item.id, item.contentSize.w * item.contentSize.h]))
  /** 当前页累积：offset 为主轴已排长度，cross 为交叉轴最大盒子尺寸 */
  let chunk: Array<{ item: PreparedItem; offset: number; boxW: number; boxH: number }> = []
  let cursor = 0
  let cross = 0

  /** 把当前累积的素材固化为一页 */
  const flush = (): void => {
    if (!chunk.length) return
    const usedMain = cursor
    const rawW = dir === 'h' ? opts.margin * 2 + usedMain : opts.margin * 2 + cross
    const rawH = dir === 'h' ? opts.margin * 2 + cross : opts.margin * 2 + usedMain
    const width = opts.powerOfTwo ? nextPowerOfTwo(rawW) : rawW
    const height = opts.powerOfTwo ? nextPowerOfTwo(rawH) : rawH
    const placements: PackPlacement[] = chunk.map(({ item, offset, boxW, boxH }) => ({
      id: item.id,
      name: item.name,
      x: dir === 'h' ? opts.margin + offset : opts.margin + Math.floor((cross - boxW) / 2),
      y: dir === 'h' ? opts.margin + Math.floor((cross - boxH) / 2) : opts.margin + offset,
      w: boxW, h: boxH,
      rotated: false,
      trimmed: item.trimmed,
      sourceSize: { ...item.sourceSize },
      contentOffset: { ...item.contentOffset },
      contentSize: { ...item.contentSize },
    }))
    const contentArea = chunk.reduce((sum, c) => sum + contentAreaById.get(c.item.id)!, 0)
    pages.push({ width, height, placements, fillRatio: contentArea / (width * height) })
    chunk = []
    cursor = 0
    cross = 0
  }

  for (const item of prepared) {
    const boxW = item.contentSize.w + grow
    const boxH = item.contentSize.h + grow
    const main = dir === 'h' ? boxW : boxH
    if (main > inner) {
      flush()
      errors.push(`「${item.name}」(${boxW}×${boxH}) 超出最大尺寸 ${opts.maxSize}px，已跳过`)
      continue
    }
    // 主轴放不下时溢出到下一页（条带保持单行/单列语义，不换行）
    if (cursor + main > inner) flush()
    chunk.push({ item, offset: cursor, boxW, boxH })
    cursor += main
    cross = Math.max(cross, dir === 'h' ? boxH : boxW)
  }
  flush()
  return { pages, errors }
}

/**
 * 紧凑布局多页打包：以 maxSize 为单页尺寸贪心装箱，放不下的盒子溢出到下一页；
 * 单独都放不进的素材记入 errors 并跳过。
 */
function packCompactMultiPage(prepared: PreparedItem[], opts: PackOptions): PackMultiResult {
  const pages: PackPage[] = []
  const errors: string[] = []
  const byId = mapById(prepared)
  const inner = opts.maxSize - opts.margin * 2
  if (inner <= 0) return { pages, errors: [`最大尺寸 ${opts.maxSize}px 不足以容纳外边距 ${opts.margin}px`] }

  let remaining = buildBoxes(prepared, opts)
  // 先剔除单独就放不进的超大素材（旋转后尺寸不变，只需判断两边都 ≤ 内区），避免死循环
  remaining = remaining.filter((box) => {
    const fits = box.w <= inner && box.h <= inner
    if (!fits) {
      const item = byId.get(box.id)!
      errors.push(`「${item.name}」(${box.w}×${box.h}) 超出最大尺寸 ${opts.maxSize}px，已跳过`)
      return false
    }
    return true
  })

  const contentAreaById = new Map(prepared.map((item) => [item.id, item.contentSize.w * item.contentSize.h]))
  while (remaining.length) {
    const packed = packIntoBin(remaining, inner, inner, opts.allowRotate, opts.heuristic, false)
    if (!packed || !packed.placements.length) break
    const rawW = packed.usedW + opts.margin * 2
    const rawH = packed.usedH + opts.margin * 2
    const width = opts.powerOfTwo ? nextPowerOfTwo(rawW) : rawW
    const height = opts.powerOfTwo ? nextPowerOfTwo(rawH) : rawH
    const placements: PackPlacement[] = packed.placements.map((p) => {
      const item = byId.get(p.id)!
      return {
        id: item.id,
        name: item.name,
        x: p.x + opts.margin,
        y: p.y + opts.margin,
        w: p.w, h: p.h,
        rotated: p.rotated,
        trimmed: item.trimmed,
        sourceSize: { ...item.sourceSize },
        contentOffset: { ...item.contentOffset },
        contentSize: { ...item.contentSize },
      }
    })
    const contentArea = placements.reduce((sum, p) => sum + contentAreaById.get(p.id)!, 0)
    pages.push({ width, height, placements, fillRatio: contentArea / (width * height) })
    remaining = packed.skipped
  }
  return { pages, errors }
}

/**
 * 多页打包主入口：素材放不下时自动开新页，返回全部页与错误清单。
 * 网格 / 条带走纯计算分支；紧凑布局走贪心溢出。
 * mergeDuplicate 开启时先按内容哈希去重，装箱只排代表帧，别名帧随后并入各页落位表。
 */
export function packItemsMultiPage(items: PackItem[], opts: PackOptions): PackMultiResult {
  const o = normalizeOptions(opts)
  let prepared = prepareItems(items, o)
  if (!prepared.length) throw new Error('没有可打包的素材（可能全为透明图）')
  let aliases: AliasEntry[] = []
  if (o.mergeDuplicate) {
    const deduped = collectAliases(prepared)
    prepared = deduped.reps
    aliases = deduped.aliases
  }
  const multi = o.layout === 'grid' ? layoutGridPages(prepared, o)
    : o.layout === 'strip-h' || o.layout === 'strip-v'
      ? layoutStripPages(prepared, o, o.layout === 'strip-h' ? 'h' : 'v')
    : packCompactMultiPage(prepared, o)
  expandAliases(multi.pages, aliases)
  return multi
}

/**
 * 把内容连同 extrude 边缘环合成到中间画布（尺寸 = 内容 + extrude×2）。
 * 四边用内容边缘 1px 条拉伸复制，四角用角点像素拉伸，关闭平滑保证像素风不失真。
 */
function composeExtruded(item: PackItem, contentOffset: { x: number; y: number }, contentSize: { w: number; h: number }, extrude: number): HTMLCanvasElement {
  const mid = document.createElement('canvas')
  mid.width = contentSize.w + extrude * 2
  mid.height = contentSize.h + extrude * 2
  const mctx = mid.getContext('2d')!
  mctx.imageSmoothingEnabled = false
  const { x: ox, y: oy } = contentOffset
  const { w, h } = contentSize
  mctx.drawImage(item.image, ox, oy, w, h, extrude, extrude, w, h)
  if (extrude > 0) {
    // 上 / 下 / 左 / 右边缘条：取内容边缘 1px 拉伸 extrude 像素
    mctx.drawImage(item.image, ox, oy, w, 1, extrude, 0, w, extrude)
    mctx.drawImage(item.image, ox, oy + h - 1, w, 1, extrude, extrude + h, w, extrude)
    mctx.drawImage(item.image, ox, oy, 1, h, 0, extrude, extrude, h)
    mctx.drawImage(item.image, ox + w - 1, oy, 1, h, extrude + w, extrude, extrude, h)
    // 四角：取角点 1px 拉伸 extrude×extrude
    mctx.drawImage(item.image, ox, oy, 1, 1, 0, 0, extrude, extrude)
    mctx.drawImage(item.image, ox + w - 1, oy, 1, 1, extrude + w, 0, extrude, extrude)
    mctx.drawImage(item.image, ox, oy + h - 1, 1, 1, 0, extrude + h, extrude, extrude)
    mctx.drawImage(item.image, ox + w - 1, oy + h - 1, 1, 1, extrude + w, extrude + h, extrude, extrude)
  }
  return mid
}

/**
 * 把单个素材画到图集上下文的目标位置。
 * 内容先合成「extrude 边缘环」中间画布，再贴入 placement 的留白内侧；
 * 旋转帧在合成后整体顺时针 90° 贴入，与 parsers/json.ts「rotated 时交换宽高还原」一致。
 */
export function drawPlacement(
  ctx: CanvasRenderingContext2D,
  item: PackItem,
  placement: PackPlacement,
  padding: number,
  extrude: 0 | 1 | 2 = 0,
): void {
  const { contentOffset, contentSize } = placement
  const mid = composeExtruded(item, contentOffset, contentSize, extrude)
  if (!placement.rotated) {
    ctx.drawImage(mid, placement.x + padding, placement.y + padding)
  } else {
    ctx.save()
    ctx.translate(placement.x + padding + mid.height, placement.y + padding)
    ctx.rotate(Math.PI / 2)
    ctx.drawImage(mid, 0, 0)
    ctx.restore()
  }
  releaseCanvas(mid)
}

/**
 * 从图集图像中抠出单帧（含留白与 extrude），rotated 帧逆旋转还原为原始朝向。
 * 供动画预览按帧绘制复用，与 parsers/json.ts 的回读语义同向。
 */
export function drawFrame(
  atlasImage: HTMLImageElement,
  placement: Pick<PackPlacement, 'x' | 'y' | 'w' | 'h' | 'rotated'>,
): HTMLCanvasElement {
  const raw = document.createElement('canvas')
  raw.width = placement.w
  raw.height = placement.h
  const rctx = raw.getContext('2d')!
  rctx.imageSmoothingEnabled = false
  rctx.drawImage(atlasImage, placement.x, placement.y, placement.w, placement.h, 0, 0, placement.w, placement.h)
  if (!placement.rotated) return raw
  const out = document.createElement('canvas')
  out.width = placement.h
  out.height = placement.w
  const octx = out.getContext('2d')!
  octx.imageSmoothingEnabled = false
  octx.translate(0, out.height)
  octx.rotate(-Math.PI / 2)
  octx.drawImage(raw, 0, 0)
  releaseCanvas(raw)
  return out
}

/** renderAtlas 的渲染选项 */
export interface RenderOptions {
  padding: number
  extrude: 0 | 1 | 2
  /** 输出编码格式；浏览器不支持 WebP 编码时抛错 */
  format?: 'png' | 'webp'
  /** WebP 质量 0-1 */
  quality?: number
  /** 每帧锚点（相对原帧的归一化坐标），写入元数据 pivot 字段 */
  pivot?: { x: number; y: number }
}

/**
 * 按单页打包结果渲染图集图片，并产出 TexturePacker 兼容的帧元数据。
 * 元数据里的 frame 记旋转后的实际矩形（含留白与 extrude），sourceSize 记未旋转原尺寸；
 * aliasOfId 别名帧不重复绘制，仅按名字生成指向同一区域的元数据。
 */
export function renderAtlas(
  items: PackItem[],
  result: PackPage,
  options: RenderOptions,
): { url: string; meta: Record<string, FrameMeta> } {
  const { padding, extrude = 0, format = 'png', quality = 0.9, pivot } = options
  const byId = new Map(items.map((item) => [item.id, item]))
  const canvas = document.createElement('canvas')
  canvas.width = result.width
  canvas.height = result.height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  const meta: Record<string, FrameMeta> = {}
  const used = new Set<string>()
  result.placements.forEach((placement, index) => {
    if (placement.aliasOfId) return
    const item = byId.get(placement.id)
    if (!item) return
    drawPlacement(ctx, item, placement, padding, extrude)
    let name = `${placement.name.replace(/\.[^.]+$/, '')}.png`
    if (used.has(name)) name = `${placement.name.replace(/\.[^.]+$/, '')}_${index}.png`
    used.add(name)
    meta[name] = {
      frame: { x: placement.x, y: placement.y, w: placement.w, h: placement.h },
      rotated: placement.rotated,
      trimmed: placement.trimmed,
      spriteSourceSize: {
        x: placement.contentOffset.x,
        y: placement.contentOffset.y,
        w: placement.contentSize.w,
        h: placement.contentSize.h,
      },
      sourceSize: { ...placement.sourceSize },
      manual: false,
      ...(pivot ? { pivot: { ...pivot } } : {}),
    }
  })

  const url = canvas.toDataURL(format === 'webp' ? 'image/webp' : 'image/png', quality)
  if (format === 'webp' && !url.startsWith('data:image/webp')) {
    throw new Error('当前浏览器不支持 WebP 编码，请改用 PNG 格式')
  }
  releaseCanvas(canvas)
  return { url, meta }
}
