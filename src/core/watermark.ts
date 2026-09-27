import { nextTick } from 'vue'
import { medianOf, sampleEdgeColor } from '@/core/color-key'
import { clampCropRect, type ImageCropRect } from '@/core/crop'
import { patchMatchInpaint } from '@/core/inpaint'
import { hexToRgb } from '@/core/frame-matte'
import { recropFrame } from '@/core/frame-crop'
import { imageDataToUrl, imageToImageData, loadImage } from '@/core/image'
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
 *
 * 底色是有纹理/颗粒的照片（而非纯色）时，alpha 解算与平填都只能给出「干净但发糊」的结果：
 * 水印之下的原始纹理已经不可逆丢失，此时唯一的出路是**重建**而不是还原，因此有 `texture` 模式：
 * 用 core/inpaint 的多尺度 PatchMatch 从 ROI 外圈环带复制真实纹理，环带与 ROI 同材质，
 * 搬过来的颗粒/渐变就是原图本身的细节，不是伪造的白噪声。
 *
 * 关于梯度域（泊松）融合：不在这里使用。core/inpaint 的 seamlessFuse 以 target 在 ROI 外侧
 * 1px 的像素为 Dirichlet 边界、以 guidance 的梯度为引导场解 ∇²f = ∇²g；而本流程里取出的
 * guidance（patchMatchInpaint 的输出）保持 ROI 外像素与输入逐字节相同，
 * 于是 guidance 的边界值与 target 的边界值恒等，色差项为 0、f ≡ g 本身就是精确解，
 * 迭代一步都不会移动——属于该方程组的性质，不是参数问题。融合真正有价值的前提是
 * 「引导场与目标边界来自不同图像」，本流程没有这样的引导场，故不保留该开关。
 */

/** RGB 三元组（0-255） */
export interface Rgb {
  r: number
  g: number
  b: number
}

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
  /** 重建精细度（0 快速 / 1 标准 / 2 精细），仅 texture 模式使用 */
  quality: number
}

export interface WatermarkResult {
  url: string
  plan: WatermarkPlan
  /** alpha 模式因水印色与底色过于接近而退化为蒙版填充 */
  degraded: boolean
}

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

/** 把 value 钳制在 a、b 两点构成的闭区间内（不要求 a ≤ b） */
function clampSegment(value: number, a: number, b: number): number {
  return a < b ? (value < a ? a : value > b ? b : value) : (value < b ? b : value > a ? a : value)
}

/**
 * 逆向 Alpha 解算：由混色方程得 α = clamp((D · V) / (V · V), 0, 1)，其中
 * D = C_comp - base、V = C_wm - base；再按 out = C_comp - α · V 回写。
 * α 本身就是混合权重，不需要额外阈值与羽化：底色像素 α≈0 保持不变，
 * 被水印完全覆盖处 α≈1 精确还原为底色，抗锯齿边缘自动得到中间值。
 * V·V 过小（水印色与底色几乎相同、水印本身不可见）时返回 false，交调用方退化为蒙版填充。
 *
 * 为什么回写项是 α·V 而不是 α·D（former 写法 out = orig + (base - orig)·α）：
 * 后者等价于减去 α·D，代入模型 D = α·V 立即得到 out = base + α(1-α)·V，
 * 残差 α(1-α)(C_wm - base) 在 0 < α < 1 时**恒不为 0**（α=0.5 时高达 0.25|V|），
 * 半透明水印只会被压淡、永远压不干净——α 越小残差越大，这正是「水印去不掉」的根因。
 * 减去 α·V 等于扣掉水印自身那一份估计贡献：纯色底上 out 恒等于 base，属数学精确复原；
 * 且 α→1 时无需除以 (1-α) 放大噪声，比精确反解 (C_comp - α·C_wm)/(1-α) 更稳。
 * 与 V 正交的残余分量被保留，因此 ROI 内沿其它方向的真实结构不会被抹掉。
 *
 * 为什么要再钳回「原像素 ↔ base」区间：α 是用环带采样出来的**单一**底色估的，
 * 底色不是纯色时（水印压在草地、布料这类纹理上）水印正下方的真实底色与 base 有偏差，
 * α 会被高估，直接相减会把浅色水印**反向压成深色鬼影**——比原来的「压不干净」更难看。
 * 钳制后修正幅度恒不超过该像素原本偏离 base 的幅度，于是：底色准确时仍精确落在 base；
 * 底色不准时最多停在 base，不会越过它继续下沉。即新公式在任何输入下都不会比旧公式
 * 更偏离底色，只会在旧公式的基础上把残差抹平，属于单调改进而非换一种失败方式。
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
      const r0 = pixels[offset]
      const g0 = pixels[offset + 1]
      const b0 = pixels[offset + 2]
      pixels[offset] = clampSegment(r0 - alpha * vr, r0, base.r)
      pixels[offset + 1] = clampSegment(g0 - alpha * vg, g0, base.g)
      pixels[offset + 2] = clampSegment(b0 - alpha * vb, b0, base.b)
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
    quality: settings.quality,
  }
  // 噪声幅度只在需要时统计；噪声取坐标哈希值，全帧一致，不引入时域抖动
  if (plan.keepNoise) plan.noise = Math.min(24, ringDeviation(source, area, band, base))
  return { plan, degraded }
}

/** 把 guidance 的 ROI 区域整块复制进 target（texture 模式的落地步骤） */
function copyRegion(target: ImageData, guidance: ImageData, rect: ImageCropRect): void {
  for (let y = 0; y < rect.height; y += 1) {
    const rowOffset = ((rect.y + y) * target.width + rect.x) * 4
    const rowEnd = rowOffset + rect.width * 4
    target.data.set(guidance.data.subarray(rowOffset, rowEnd), rowOffset)
  }
}

/**
 * 按已解析的参数处理一帧画面，返回结果 dataURL；同一份 plan 对同一输入永远得到同一结果。
 * texture 模式用 PatchMatch 重建 ROI 后整块替换；其余模式在原位修复。
 */
export function applyWatermarkPlan(plan: WatermarkPlan, source: ImageData): string {
  const work = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
  const area = clampCropRect(plan.rect, work.width, work.height)
  if (area.width <= 0 || area.height <= 0) return imageDataToUrl(work)
  if (plan.mode === 'texture') {
    copyRegion(work, patchMatchInpaint(source, area, { quality: plan.quality }), area)
  } else if (plan.mode === 'region') {
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