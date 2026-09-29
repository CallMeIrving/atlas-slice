/**
 * 智能图集打包。
 *
 * 输入多张图片，用 MaxRects（BSSF：Best Short Side Fit）装箱算法把它们紧凑排进一张图集，
 * 支持透明边裁剪（trim）、90° 旋转、素材留白（padding）与图集外边距（margin）；
 * 「智能」体现在自动搜索尽量小的图集边长，而不是固定用最大尺寸。
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

export interface PackOptions {
  /** 每个素材四周留白（像素），避免采样时相邻素材渗色 */
  padding: number
  /** 图集四周外边距（像素） */
  margin: number
  /** 图集最大边长上限 */
  maxSize: number
  /** 是否允许把素材旋转 90° 以提升紧凑度 */
  allowRotate: boolean
  /** 图集宽高是否为 2 的幂（部分旧引擎的纹理要求） */
  powerOfTwo: boolean
  /** 是否裁掉透明边，只打包实际内容 */
  trim: boolean
  /** 裁剪时的 alpha 阈值 */
  alphaThreshold: number
}

export interface PackPlacement {
  id: string
  name: string
  /** 纹理中的实际打包矩形（含留白；旋转帧为旋转后的宽高） */
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
}

export interface PackResult {
  width: number
  height: number
  placements: PackPlacement[]
  /** 内容面积 / 图集面积，用于展示紧凑度 */
  fillRatio: number
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
}

interface Box {
  id: string
  /** 含留白的打包尺寸 */
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
 * 预处理素材：按需裁剪透明边，算出内容尺寸与原帧偏移。
 * 全透明素材在裁剪模式下直接跳过（没有可打包的内容）。
 */
function prepareItems(items: PackItem[], opts: PackOptions): PreparedItem[] {
  const prepared: PreparedItem[] = []
  for (const item of items) {
    const sourceSize = { w: item.image.naturalWidth, h: item.image.naturalHeight }
    if (!opts.trim) {
      prepared.push({
        id: item.id, name: item.name, image: item.image,
        sourceSize, contentOffset: { x: 0, y: 0 }, contentSize: { ...sourceSize }, trimmed: false,
      })
      continue
    }
    const bbox = trimBBox(imageToImageData(item.image), opts.alphaThreshold)
    if (!bbox) continue
    prepared.push({
      id: item.id, name: item.name, image: item.image,
      sourceSize,
      contentOffset: { x: bbox.x, y: bbox.y },
      contentSize: { w: bbox.w, h: bbox.h },
      trimmed: bbox.x > 0 || bbox.y > 0 || bbox.w < sourceSize.w || bbox.h < sourceSize.h,
    })
  }
  return prepared
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

/** 把一组盒子打进指定尺寸的箱子；放不下返回 null */
function packIntoBin(
  boxes: Box[],
  binW: number,
  binH: number,
  allowRotate: boolean,
): { placements: Array<{ id: string; x: number; y: number; w: number; h: number; rotated: boolean }>; usedW: number; usedH: number } | null {
  const free: Rect[] = [{ x: 0, y: 0, w: binW, h: binH }]
  const placements: Array<{ id: string; x: number; y: number; w: number; h: number; rotated: boolean }> = []
  let usedW = 0
  let usedH = 0

  for (const box of boxes) {
    let bestX = 0
    let bestY = 0
    let bestW = 0
    let bestH = 0
    let bestRotated = false
    let bestShort = Infinity
    let bestLong = Infinity
    let found = false

    for (const fr of free) {
      // 两种朝向：原样 / 旋转 90°
      const orientations: Array<{ w: number; h: number; rotated: boolean }> = [{ w: box.w, h: box.h, rotated: false }]
      if (allowRotate && box.canRotate && box.w !== box.h) orientations.push({ w: box.h, h: box.w, rotated: true })
      for (const o of orientations) {
        if (o.w > fr.w || o.h > fr.h) continue
        const leftoverH = Math.abs(fr.w - o.w)
        const leftoverV = Math.abs(fr.h - o.h)
        const shortSide = Math.min(leftoverH, leftoverV)
        const longSide = Math.max(leftoverH, leftoverV)
        if (shortSide < bestShort || (shortSide === bestShort && longSide < bestLong)) {
          bestX = fr.x; bestY = fr.y; bestW = o.w; bestH = o.h
          bestRotated = o.rotated; bestShort = shortSide; bestLong = longSide; found = true
        }
      }
    }

    if (!found) return null
    placements.push({ id: box.id, x: bestX, y: bestY, w: bestW, h: bestH, rotated: bestRotated })
    usedW = Math.max(usedW, bestX + bestW)
    usedH = Math.max(usedH, bestY + bestH)
    splitFreeRects(free, { x: bestX, y: bestY, w: bestW, h: bestH })
  }

  return { placements, usedW, usedH }
}

/** 向上取整到 2 的幂 */
function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) size *= 2
  return size
}

/**
 * 生成图集候选边长（升序）。
 * 从面积下界起步按 1.25 倍增长，最多 24 个候选，覆盖到 maxSize；
 * 限制候选数是为了避免对同一批素材反复全量装箱造成明显卡顿。
 */
function candidateSizes(lowerBound: number, maxSize: number, powerOfTwo: boolean): number[] {
  const sizes: number[] = []
  if (powerOfTwo) {
    for (let size = 1; size <= maxSize; size *= 2) if (size >= lowerBound) sizes.push(size)
    if (!sizes.length) sizes.push(maxSize)
    return sizes
  }
  let size = Math.ceil(lowerBound / 16) * 16
  while (size < maxSize && sizes.length < 24) {
    sizes.push(size)
    size = Math.ceil((size * 1.25) / 16) * 16
  }
  if (sizes[sizes.length - 1] !== maxSize) sizes.push(maxSize)
  return sizes
}

/**
 * 主入口：把素材打包成一张图集的排布结果。
 * 尺寸搜索策略：先按面积下界与最大边长生成候选边长，从小到大逐个尝试装箱，命中即停；
 * 非 2 的幂场景下会把结果收敛到实际占用尺寸，进一步减少空白。
 */
export function packItems(items: PackItem[], opts: PackOptions): PackResult {
  const prepared = prepareItems(items, opts)
  if (!prepared.length) throw new Error('没有可打包的素材（可能全为透明图）')

  const padding = Math.max(0, Math.round(opts.padding))
  const margin = Math.max(0, Math.round(opts.margin))
  const maxSize = Math.max(16, Math.round(opts.maxSize))

  // 盒子按「长边优先」排序，大块先放，MaxRects 的紧凑度更好
  const boxes: Box[] = prepared
    .map((item) => ({
      id: item.id,
      w: item.contentSize.w + padding * 2,
      h: item.contentSize.h + padding * 2,
      canRotate: opts.allowRotate,
    }))
    .sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h)

  const totalArea = boxes.reduce((sum, box) => sum + box.w * box.h, 0)
  const lowerBound = Math.ceil(Math.sqrt(totalArea * 1.05))
  if (lowerBound > maxSize) {
    throw new Error(`素材总面积为 ${totalArea}px²，超出最大尺寸 ${maxSize}px 的限制`)
  }

  const byId = new Map(prepared.map((item) => [item.id, item]))
  let chosen: { placements: Array<{ id: string; x: number; y: number; w: number; h: number; rotated: boolean }>; width: number; height: number } | null = null

  for (const size of candidateSizes(lowerBound, maxSize, opts.powerOfTwo)) {
    const inner = size - margin * 2
    if (inner <= 0) continue
    const packed = packIntoBin(boxes, inner, inner, opts.allowRotate)
    if (!packed) continue
    const rawW = packed.usedW + margin * 2
    const rawH = packed.usedH + margin * 2
    chosen = {
      placements: packed.placements.map((p) => ({ ...p, x: p.x + margin, y: p.y + margin })),
      width: opts.powerOfTwo ? nextPowerOfTwo(rawW) : rawW,
      height: opts.powerOfTwo ? nextPowerOfTwo(rawH) : rawH,
    }
    break
  }

  if (!chosen) {
    throw new Error(`素材无法排进 ${maxSize}×${maxSize} 的图集，请调大最大尺寸或关闭旋转/裁剪`)
  }
  if (chosen.width > maxSize || chosen.height > maxSize) {
    throw new Error(`打包结果 ${chosen.width}×${chosen.height} 超过最大尺寸 ${maxSize}px`)
  }

  const placements: PackPlacement[] = chosen.placements.map((p) => {
    const item = byId.get(p.id)!
    return {
      id: item.id,
      name: item.name,
      x: p.x, y: p.y, w: p.w, h: p.h,
      rotated: p.rotated,
      trimmed: item.trimmed,
      sourceSize: { ...item.sourceSize },
      contentOffset: { ...item.contentOffset },
      contentSize: { ...item.contentSize },
    }
  })

  const contentArea = prepared.reduce((sum, item) => sum + item.contentSize.w * item.contentSize.h, 0)
  return {
    width: chosen.width,
    height: chosen.height,
    placements,
    fillRatio: contentArea / (chosen.width * chosen.height),
  }
}

/**
 * 把单个素材画到图集上下文的目标位置。
 * 旋转帧先把内容画到带留白的中间画布，再整体顺时针 90° 贴入，
 * 与 parsers/json.ts「rotated 时交换宽高还原」的回读逻辑保持一致。
 */
export function drawPlacement(
  ctx: CanvasRenderingContext2D,
  item: PackItem,
  placement: PackPlacement,
  padding: number,
): void {
  const { contentOffset, contentSize } = placement
  if (!placement.rotated) {
    ctx.drawImage(
      item.image,
      contentOffset.x, contentOffset.y, contentSize.w, contentSize.h,
      placement.x + padding, placement.y + padding, contentSize.w, contentSize.h,
    )
    return
  }
  const mid = document.createElement('canvas')
  mid.width = contentSize.w + padding * 2
  mid.height = contentSize.h + padding * 2
  const mctx = mid.getContext('2d')!
  mctx.imageSmoothingEnabled = false
  mctx.drawImage(item.image, contentOffset.x, contentOffset.y, contentSize.w, contentSize.h, padding, padding, contentSize.w, contentSize.h)
  ctx.save()
  ctx.translate(placement.x + mid.height, placement.y)
  ctx.rotate(Math.PI / 2)
  ctx.drawImage(mid, 0, 0)
  ctx.restore()
  releaseCanvas(mid)
}

/**
 * 按打包结果渲染图集图片，并产出 TexturePacker 兼容的帧元数据。
 * 元数据里的 frame 记旋转后的实际矩形，sourceSize 记未旋转原尺寸。
 */
export function renderAtlas(
  items: PackItem[],
  result: PackResult,
  padding: number,
): { url: string; meta: Record<string, FrameMeta> } {
  const byId = new Map(items.map((item) => [item.id, item]))
  const canvas = document.createElement('canvas')
  canvas.width = result.width
  canvas.height = result.height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  const meta: Record<string, FrameMeta> = {}
  const used = new Set<string>()
  result.placements.forEach((placement, index) => {
    const item = byId.get(placement.id)
    if (!item) return
    drawPlacement(ctx, item, placement, padding)
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
    }
  })

  const url = canvas.toDataURL('image/png')
  releaseCanvas(canvas)
  return { url, meta }
}