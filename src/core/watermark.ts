import { nextTick } from 'vue'
import { medianOf, sampleEdgeColor } from '@/core/color-key'
import { clampCropRect, type ImageCropRect } from '@/core/crop'
import { hexToRgb } from '@/core/frame-matte'
import { recropFrame } from '@/core/frame-crop'
import { imageDataToUrl, imageToImageData, loadImage, releaseCanvas } from '@/core/image'
import type { CancelToken } from '@/core/frame-extract'
import type { VideoFrame, WatermarkMode, WatermarkSettings } from '@/store/workspace'

/**
 * 去水印核心算法（零模型、全本地）。
 *
 * 纯色背景 + 角落水印是主场景，走「逆向 Alpha 解算」而不是 inpainting 模型：
 * 混色方程 C_comp = α·C_wm + (1-α)·C_bg 里的 C_bg 可直接从 ROI 外圈环带中位采样得到，
 * α 由向量投影在最小二乘意义下解出，还原值恒为 C_bg，属于数学精确复原而非猜测；
 * 角落水印外侧本身是确定可采样的纯色背景，模型反而会引入纹理幻觉。
 *
 * 时域一致性：底色、水印色、ROI 在样板帧求一次后全部帧共用，运算对同一坐标完全确定
 * （噪点用坐标哈希伪随机数，禁止 Math.random），因此逐帧结果一致、不会闪烁。
 */

/** RGB 三元组（0-255） */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** 水印所在角落，决定自动定位的搜索窗方位 */
export type WatermarkCorner = 'nw' | 'ne' | 'sw' | 'se'

/** 单帧去水印的完整参数：全帧共用同一份，保证时域一致 */
export interface WatermarkPlan {
  rect: ImageCropRect
  /** 实际执行的修复方式（alpha 退化后即 patch） */
  mode: WatermarkMode
  /** 底色（环带中位采样或手动指定） */
  base: Rgb
  /** 水印本色，仅 alpha 模式使用 */
  watermark: Rgb
  /** 水印置信度阈值，仅 patch 模式使用 */
  threshold: number
  /** 是否叠加底色噪点，仅 patch 模式使用 */
  keepNoise: boolean
  /** 底色噪声幅度（0-255 通道值） */
  noise: number
}

export interface WatermarkResult {
  url: string
  plan: WatermarkPlan
  /** alpha 模式因水印色与底色过于接近而退化为蒙版填充 */
  degraded: boolean
}

/** 自动定位的搜索窗占图像长边比例 */
const DETECT_WINDOW_RATIO = 0.4
/** 自动定位前降采样到的长边像素（抑噪 + 限制 flood fill 规模） */
const DETECT_MAX_SIDE = 256
/** 连通域至少占搜索窗该比例才当作水印，滤掉孤立噪点 */
const DETECT_MIN_AREA_RATIO = 0.002
/** 退化为蒙版填充的判据：投影方向长度的平方下限（|V| < 3） */
const MIN_PROJECTION_LENGTH = 9

/** ROI 外圈环带宽度：随 ROI 尺寸自适应，至少 4px */
function ringBand(rect: ImageCropRect): number {
  return Math.max(4, Math.round(Math.min(rect.width, rect.height) * 0.35))
}

/**
 * 遍历 ROI 外圈环带（不含 ROI 自身）内的像素，坐标收敛到图像范围内。
 * 水印贴住图像边时该侧自然没有像素，因此不需要额外的边界判断。
 */
function forEachRingPixel(data: ImageData, rect: ImageCropRect, band: number, visit: (offset: number) => void): void {
  const x0 = Math.max(0, rect.x - band)
  const y0 = Math.max(0, rect.y - band)
  const x1 = Math.min(data.width, rect.x + rect.width + band)
  const y1 = Math.min(data.height, rect.y + rect.height + band)
  for (let y = y0; y < y1; y += 1) {
    const inRow = y >= rect.y && y < rect.y + rect.height
    for (let x = x0; x < x1; x += 1) {
      if (inRow && x >= rect.x && x < rect.x + rect.width) {
        // 跳过 ROI 本体，直接落到 ROI 右侧继续扫描
        x = rect.x + rect.width - 1
        continue
      }
      visit((y * data.width + x) * 4)
    }
  }
}

/**
 * 采样底色：ROI 外圈环带逐通道取中位数，中位数可抗噪点与少量杂散像素；
 * 手动底色优先。ROI 覆盖整幅图（没有环带）时退回图像四边采样。
 */
export function sampleRingColor(data: ImageData, rect: ImageCropRect, band: number, manual?: Rgb | null): Rgb {
  if (manual) return manual
  const samples: number[] = []
  forEachRingPixel(data, rect, band, (offset) => {
    samples.push(data.data[offset], data.data[offset + 1], data.data[offset + 2])
  })
  if (!samples.length) {
    const edge = sampleEdgeColor(data)
    return { r: edge.r, g: edge.g, b: edge.b }
  }
  return { r: medianOf(samples, 0), g: medianOf(samples, 1), b: medianOf(samples, 2) }
}

/** 环带像素相对底色的平均绝对偏差，作为底色噪声幅度 */
export function ringDeviation(data: ImageData, rect: ImageCropRect, band: number, base: Rgb): number {
  let sum = 0
  let count = 0
  forEachRingPixel(data, rect, band, (offset) => {
    sum += Math.abs(data.data[offset] - base.r) + Math.abs(data.data[offset + 1] - base.g) + Math.abs(data.data[offset + 2] - base.b)
    count += 3
  })
  return count ? sum / count : 0
}

/**
 * 曼哈顿色差 → 水印置信度（0-255）。
 * 阈值以上再加半个阈值的软过渡带，水印抗锯齿边缘自然落在中间值，不需要额外的羽化参数。
 */
export function buildMask(data: ImageData, rect: ImageCropRect, base: Rgb, threshold: number): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(rect.width * rect.height)
  const pixels = data.data
  const soft = Math.max(1, threshold * 0.5)
  for (let y = 0; y < rect.height; y += 1) {
    const rowOffset = ((rect.y + y) * data.width + rect.x) * 4
    for (let x = 0; x < rect.width; x += 1) {
      const offset = rowOffset + x * 4
      const distance = Math.abs(pixels[offset] - base.r) + Math.abs(pixels[offset + 1] - base.g) + Math.abs(pixels[offset + 2] - base.b)
      mask[y * rect.width + x] = Math.min(1, Math.max(0, (distance - threshold) / soft)) * 255
    }
  }
  return mask
}

/**
 * 按蒙版把判定为水印的像素替换为底色（Telea 类扩散的替代：整块重建走 fillByEdges）。
 * keepNoise 时叠加坐标哈希的确定性噪声，避免出现一块过于平滑的补丁；
 * 噪声取绝对像素坐标，因此同一水印在每一帧得到同一份纹理，不会闪烁。
 */
function fillByMask(data: ImageData, rect: ImageCropRect, base: Rgb, mask: Uint8ClampedArray, noise: number): void {
  const pixels = data.data
  const width = data.width
  for (let y = 0; y < rect.height; y += 1) {
    const rowOffset = ((rect.y + y) * width + rect.x) * 4
    for (let x = 0; x < rect.width; x += 1) {
      const confidence = mask[y * rect.width + x] / 255
      if (confidence <= 0) continue
      const offset = rowOffset + x * 4
      const sx = rect.x + x
      const sy = rect.y + y
      const targetR = base.r + (noise ? (hashNoise(sx, sy, 0) * 2 - 1) * noise : 0)
      const targetG = base.g + (noise ? (hashNoise(sx, sy, 1) * 2 - 1) * noise : 0)
      const targetB = base.b + (noise ? (hashNoise(sx, sy, 2) * 2 - 1) * noise : 0)
      pixels[offset] += (targetR - pixels[offset]) * confidence
      pixels[offset + 1] += (targetG - pixels[offset + 1]) * confidence
      pixels[offset + 2] += (targetB - pixels[offset + 2]) * confidence
    }
  }
}

/** 整数坐标哈希 → [0,1)，确定性伪随机数（同一坐标永远得到同一个值） */
function hashNoise(x: number, y: number, channel: number): number {
  let hash = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(channel + 1, 2246822519)) >>> 0
  hash = (hash ^ (hash >>> 13)) >>> 0
  hash = Math.imul(hash, 1274126177) >>> 0
  hash = (hash ^ (hash >>> 16)) >>> 0
  return hash / 4294967296
}

/**
 * 四边界逆向距离加权插值：C = (Σ Ci/distᵢ) / Σ(1/distᵢ)。
 * 参考色取自 ROI 外侧 1px 处（不取 ROI 自身，避免被水印污染），因此能跟上底色渐变；
 * 贴住图像边界的边权重置 0 并在权重和上重新归一化，可用边 ≤1 时直接以底色平填
 * ——水印贴角时该区域本就该是纯底色，平填即最优。
 */
export function fillByEdges(data: ImageData, rect: ImageCropRect, base: Rgb): void {
  const pixels = data.data
  const width = data.width
  const height = data.height
  const left = rect.x - 1
  const right = rect.x + rect.width
  const top = rect.y - 1
  const bottom = rect.y + rect.height
  const hasLeft = left >= 0
  const hasRight = right < width
  const hasTop = top >= 0
  const hasBottom = bottom < height
  const edges = Number(hasLeft) + Number(hasRight) + Number(hasTop) + Number(hasBottom)

  if (edges <= 1) {
    for (let y = 0; y < rect.height; y += 1) {
      const rowOffset = ((rect.y + y) * width + rect.x) * 4
      for (let x = 0; x < rect.width; x += 1) {
        const offset = rowOffset + x * 4
        pixels[offset] = base.r
        pixels[offset + 1] = base.g
        pixels[offset + 2] = base.b
      }
    }
    return
  }

  for (let y = 0; y < rect.height; y += 1) {
    const imageRow = rect.y + y
    const rowOffset = (imageRow * width + rect.x) * 4
    for (let x = 0; x < rect.width; x += 1) {
      const offset = rowOffset + x * 4
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let weight = 0
      if (hasLeft) {
        const w = 1 / (x + 1)
        const s = (imageRow * width + left) * 4
        sumR += pixels[s] * w; sumG += pixels[s + 1] * w; sumB += pixels[s + 2] * w; weight += w
      }
      if (hasRight) {
        const w = 1 / (rect.width - x)
        const s = (imageRow * width + right) * 4
        sumR += pixels[s] * w; sumG += pixels[s + 1] * w; sumB += pixels[s + 2] * w; weight += w
      }
      if (hasTop) {
        const w = 1 / (y + 1)
        const s = (top * width + rect.x + x) * 4
        sumR += pixels[s] * w; sumG += pixels[s + 1] * w; sumB += pixels[s + 2] * w; weight += w
      }
      if (hasBottom) {
        const w = 1 / (rect.height - y)
        const s = (bottom * width + rect.x + x) * 4
        sumR += pixels[s] * w; sumG += pixels[s + 1] * w; sumB += pixels[s + 2] * w; weight += w
      }
      pixels[offset] = sumR / weight
      pixels[offset + 1] = sumG / weight
      pixels[offset + 2] = sumB / weight
    }
  }
}

/**
 * 逆向 Alpha 解算：由混色方程得 α = clamp((D · V) / (V · V), 0, 1)，其中
 * D = C_comp - C_bg、V = C_wm - C_bg；再按 out = orig + (C_bg - orig) · α 回写。
 * α 本身就是混合权重，不需要额外阈值与羽化：底色像素 α≈0 保持不变，
 * 被水印完全覆盖处 α≈1 精确还原为底色，抗锯齿边缘自动得到中间值。
 * V·V 过小（水印色与底色几乎相同、水印本身不可见）时返回 false，交调用方退化为蒙版填充。
 */
export function recoverAlpha(data: ImageData, rect: ImageCropRect, base: Rgb, watermark: Rgb): boolean {
  const vr = watermark.r - base.r
  const vg = watermark.g - base.g
  const vb = watermark.b - base.b
  const vv = vr * vr + vg * vg + vb * vb
  if (vv < MIN_PROJECTION_LENGTH) return false
  const pixels = data.data
  const width = data.width
  for (let y = 0; y < rect.height; y += 1) {
    const rowOffset = ((rect.y + y) * width + rect.x) * 4
    for (let x = 0; x < rect.width; x += 1) {
      const offset = rowOffset + x * 4
      const dr = pixels[offset] - base.r
      const dg = pixels[offset + 1] - base.g
      const db = pixels[offset + 2] - base.b
      const alpha = Math.min(1, Math.max(0, (dr * vr + dg * vg + db * vb) / vv))
      if (alpha <= 0) continue
      pixels[offset] += (base.r - pixels[offset]) * alpha
      pixels[offset + 1] += (base.g - pixels[offset + 1]) * alpha
      pixels[offset + 2] += (base.b - pixels[offset + 2]) * alpha
    }
  }
  return true
}

/**
 * 自动估算水印本色。
 * 投影方向 V 本身未知，因此先用「ROI 内离底色最远的像素」作为初值得到 V，
 * 再挑出沿 V 投影 α ≥ 0.75 的像素取逐通道中位数（抗噪且抗孤立杂点）。
 * 整块 ROI 与底色几乎一致（水印不可见）时直接返回底色。
 */
export function estimateWatermarkColor(data: ImageData, rect: ImageCropRect, base: Rgb): Rgb {
  const pixels = data.data
  const width = data.width
  let farR = base.r
  let farG = base.g
  let farB = base.b
  let farDistance = -1
  for (let y = 0; y < rect.height; y += 1) {
    const rowOffset = ((rect.y + y) * width + rect.x) * 4
    for (let x = 0; x < rect.width; x += 1) {
      const offset = rowOffset + x * 4
      const distance = Math.abs(pixels[offset] - base.r) + Math.abs(pixels[offset + 1] - base.g) + Math.abs(pixels[offset + 2] - base.b)
      if (distance > farDistance) {
        farDistance = distance
        farR = pixels[offset]
        farG = pixels[offset + 1]
        farB = pixels[offset + 2]
      }
    }
  }
  const vr = farR - base.r
  const vg = farG - base.g
  const vb = farB - base.b
  const vv = vr * vr + vg * vg + vb * vb
  if (farDistance < 8 || vv < MIN_PROJECTION_LENGTH) return { ...base }

  const samples: number[] = []
  for (let y = 0; y < rect.height; y += 1) {
    const rowOffset = ((rect.y + y) * width + rect.x) * 4
    for (let x = 0; x < rect.width; x += 1) {
      const offset = rowOffset + x * 4
      const alpha = ((pixels[offset] - base.r) * vr + (pixels[offset + 1] - base.g) * vg + (pixels[offset + 2] - base.b) * vb) / vv
      if (alpha >= 0.75) samples.push(pixels[offset], pixels[offset + 1], pixels[offset + 2])
    }
  }
  if (!samples.length) return { r: farR, g: farG, b: farB }
  return { r: medianOf(samples, 0), g: medianOf(samples, 1), b: medianOf(samples, 2) }
}

/** 降采样到长边不超过 maxSide，长边已足够小时直接复用原数据 */
function downsample(data: ImageData, maxSide: number): { data: ImageData; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(data.width, data.height))
  if (scale >= 1) return { data, scale: 1 }
  const width = Math.max(1, Math.round(data.width * scale))
  const height = Math.max(1, Math.round(data.height * scale))
  const source = document.createElement('canvas')
  source.width = data.width
  source.height = data.height
  source.getContext('2d')!.putImageData(data, 0, 0)
  const target = document.createElement('canvas')
  target.width = width
  target.height = height
  const ctx = target.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)
  const result = ctx.getImageData(0, 0, width, height)
  releaseCanvas(source)
  releaseCanvas(target)
  return { data: result, scale }
}

/**
 * 在指定角落的搜索窗内找水印连通域。
 * 栈式 4 邻域 flood fill 累计包围盒与面积；贴住搜索窗「内侧边」的连通域通常是主体
 * 而非水印（水印贴的是图像边，即搜索窗的外侧），因此直接排除。
 */
function detectInCorner(data: ImageData, corner: WatermarkCorner, threshold: number, base: Rgb): { area: number; rect: ImageCropRect } | null {
  const width = data.width
  const height = data.height
  const windowWidth = Math.max(4, Math.round(width * DETECT_WINDOW_RATIO))
  const windowHeight = Math.max(4, Math.round(height * DETECT_WINDOW_RATIO))
  const x0 = corner === 'ne' || corner === 'se' ? width - windowWidth : 0
  const y0 = corner === 'sw' || corner === 'se' ? height - windowHeight : 0
  const interiorLeft = corner === 'ne' || corner === 'se'
  const interiorTop = corner === 'sw' || corner === 'se'
  const pixels = data.data
  const visited = new Uint8Array(windowWidth * windowHeight)
  const minArea = windowWidth * windowHeight * DETECT_MIN_AREA_RATIO
  let best: { area: number; rect: ImageCropRect } | null = null

  /** 降采样后仍与底色差异明显的像素才作为候选 */
  const isCandidate = (lx: number, ly: number): boolean => {
    const offset = ((y0 + ly) * width + x0 + lx) * 4
    return Math.abs(pixels[offset] - base.r) + Math.abs(pixels[offset + 1] - base.g) + Math.abs(pixels[offset + 2] - base.b) > threshold
  }

  for (let sy = 0; sy < windowHeight; sy += 1) {
    for (let sx = 0; sx < windowWidth; sx += 1) {
      const start = sy * windowWidth + sx
      if (visited[start] || !isCandidate(sx, sy)) continue
      const stack: number[] = [start]
      visited[start] = 1
      let area = 0
      let minX = sx
      let maxX = sx
      let minY = sy
      let maxY = sy
      let touchesInterior = false
      const push = (lx: number, ly: number): void => {
        const index = ly * windowWidth + lx
        if (visited[index] || !isCandidate(lx, ly)) return
        visited[index] = 1
        stack.push(index)
      }
      while (stack.length) {
        const index = stack.pop()!
        const lx = index % windowWidth
        const ly = (index - lx) / windowWidth
        area += 1
        if (lx < minX) minX = lx
        if (lx > maxX) maxX = lx
        if (ly < minY) minY = ly
        if (ly > maxY) maxY = ly
        if ((interiorLeft && lx === 0) || (interiorTop && ly === 0)) touchesInterior = true
        if (lx > 0) push(lx - 1, ly)
        if (lx < windowWidth - 1) push(lx + 1, ly)
        if (ly > 0) push(lx, ly - 1)
        if (ly < windowHeight - 1) push(lx, ly + 1)
      }
      if (touchesInterior || area < minArea) continue
      if (!best || area > best.area) {
        best = { area, rect: { x: x0 + minX, y: y0 + minY, width: maxX - minX + 1, height: maxY - minY + 1 } }
      }
    }
  }
  return best
}

export interface DetectOptions {
  /** 目标角落；auto（默认）时四个角各扫一次取面积最大者 */
  corner?: WatermarkCorner | 'auto'
  /** 色差阈值（曼哈顿距离），低于该值的像素视为背景 */
  threshold?: number
}

/**
 * 自动定位角落水印：长边降采样到 ~256px（已足够抑噪，无需再做形态学膨胀）
 * → 逐角在搜索窗内 flood fill 取连通域 → 选面积最大者取包围盒 + padding 映射回图像坐标。
 * 定位不到（水印过淡、无角落水印）时返回 null，由调用方提示手动框选。
 */
export function detectWatermarkRect(data: ImageData, options: DetectOptions = {}): { rect: ImageCropRect; corner: WatermarkCorner } | null {
  const threshold = options.threshold ?? 48
  const { data: small, scale } = downsample(data, DETECT_MAX_SIDE)
  const edge = sampleEdgeColor(small)
  const base: Rgb = { r: edge.r, g: edge.g, b: edge.b }
  const corners: WatermarkCorner[] = options.corner && options.corner !== 'auto' ? [options.corner] : ['se', 'sw', 'ne', 'nw']
  let best: { area: number; rect: ImageCropRect; corner: WatermarkCorner } | null = null
  for (const corner of corners) {
    const found = detectInCorner(small, corner, threshold, base)
    if (found && (!best || found.area > best.area)) best = { area: found.area, rect: found.rect, corner }
  }
  if (!best) return null
  // 映射回原图坐标并留出余量，保证水印抗锯齿边缘也被 ROI 覆盖
  const padding = Math.max(2, Math.round(Math.min(data.width, data.height) * 0.01))
  return {
    corner: best.corner,
    rect: clampCropRect({
      x: best.rect.x / scale - padding,
      y: best.rect.y / scale - padding,
      width: best.rect.width / scale + padding * 2,
      height: best.rect.height / scale + padding * 2,
    }, data.width, data.height),
  }
}

/**
 * 在样板帧上解析出完整参数：底色（手动优先，否则环带中位采样）、水印色（手动优先，否则投影估算）。
 * alpha 模式在投影方向过短时自动退化为蒙版填充，返回的 plan.mode 即实际执行方式。
 */
export function resolveWatermarkPlan(settings: WatermarkSettings, rect: ImageCropRect, source: ImageData): { plan: WatermarkPlan; degraded: boolean } {
  const area = clampCropRect(rect, source.width, source.height)
  const band = ringBand(area)
  const base = sampleRingColor(source, area, band, hexToRgb(settings.baseColor))
  let mode: WatermarkMode = settings.mode
  let watermark: Rgb = base
  let degraded = false
  if (mode === 'alpha') {
    watermark = hexToRgb(settings.watermarkColor) ?? estimateWatermarkColor(source, area, base)
    const vr = watermark.r - base.r
    const vg = watermark.g - base.g
    const vb = watermark.b - base.b
    if (vr * vr + vg * vg + vb * vb < MIN_PROJECTION_LENGTH) {
      mode = 'patch'
      watermark = base
      degraded = true
    }
  }
  const plan: WatermarkPlan = {
    rect: area,
    mode,
    base,
    watermark,
    threshold: settings.threshold,
    keepNoise: settings.keepNoise && mode === 'patch',
    noise: 0,
  }
  // 噪声幅度只在需要时统计；噪声取坐标哈希值，全帧一致，不引入时域抖动
  if (plan.keepNoise) plan.noise = Math.min(24, ringDeviation(source, area, band, base))
  return { plan, degraded }
}

/** 按已解析的参数处理一帧画面，返回结果 dataURL；同一份 plan 对同一输入永远得到同一结果 */
export function applyWatermarkPlan(plan: WatermarkPlan, source: ImageData): string {
  const work = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
  const area = clampCropRect(plan.rect, work.width, work.height)
  if (plan.mode === 'region') {
    fillByEdges(work, area, plan.base)
  } else if (plan.mode === 'alpha') {
    if (!recoverAlpha(work, area, plan.base, plan.watermark)) {
      fillByMask(work, area, plan.base, buildMask(source, area, plan.base, plan.threshold), plan.noise)
    }
  } else {
    fillByMask(work, area, plan.base, buildMask(source, area, plan.base, plan.threshold), plan.noise)
  }
  return imageDataToUrl(work)
}

/**
 * 单帧/单图入口：解析参数并处理，返回结果与本次实际使用的参数。
 * @param source 原始像素数据（页面按来源缓存，调参时避免重复解码）
 */
export function watermarkImageData(settings: WatermarkSettings, rect: ImageCropRect, source: ImageData): WatermarkResult {
  const { plan, degraded } = resolveWatermarkPlan(settings, rect, source)
  return { url: applyWatermarkPlan(plan, source), plan, degraded }
}

export interface WatermarkBatchOptions {
  /** 每帧处理完成的进度回调：done/total 为整体进度，text 为状态说明 */
  onProgress?: (done: number, total: number, text: string) => void
  token?: CancelToken
  /** 样板帧已算好的结果（帧 id + dataURL），批量时直接复用，省一次处理 */
  reuse?: { id: string; url: string } | null
}

/**
 * 用同一份参数批量去水印（带进度、可取消）。
 * 输入固定为原始抽帧画面 frame.url，反复调参不会叠加误差；
 * 画面已变，旧抠图结果随之失效，因此写入后清 matteUrl 并按 frame.crop 重算裁切
 * （不自动重跑抠图，避免在 AI 模式下静默触发模型加载与逐帧推理）。
 * @returns 实际处理完成的帧数
 */
export async function applyWatermarkToFrames(frames: VideoFrame[], plan: WatermarkPlan, options: WatermarkBatchOptions = {}): Promise<number> {
  let done = 0
  for (const frame of frames) {
    if (options.token?.cancelled) break
    if (options.reuse && options.reuse.id === frame.id) {
      frame.watermarkUrl = options.reuse.url
    } else {
      const image = await loadImage(frame.url)
      frame.watermarkUrl = applyWatermarkPlan(plan, imageToImageData(image))
    }
    frame.matteUrl = undefined
    await recropFrame(frame)
    done += 1
    options.onProgress?.(done, frames.length, `${done}/${frames.length} 已完成`)
    // 让出主线程，保证进度显示与取消按钮始终可响应
    await nextTick()
  }
  return done
}

/** 清除全部帧的去水印结果并重算裁切，恢复为原始抽帧画面 */
export async function clearWatermarkFromFrames(frames: VideoFrame[]): Promise<void> {
  for (const frame of frames) {
    if (!frame.watermarkUrl) continue
    frame.watermarkUrl = undefined
    await recropFrame(frame)
    await nextTick()
  }
}