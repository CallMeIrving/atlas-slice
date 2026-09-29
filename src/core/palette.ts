/**
 * 调色板换色（Team Color / 皮肤系统）核心算法。
 *
 * 三步流程：
 * 1. 提取主色板：把图像像素量化分桶，按「色相族 + 饱和度 + 明度」贪心聚类成可编辑色槽；
 * 2. 建立映射：每个色槽指定一个目标色，判据沿用抠图页的色相/饱和度窗口（不看明度），
 *    因此同一色槽的阴影、高光与渐变会整体迁移，不会只换掉纯色块；
 * 3. 渲染变体：按「色相替换 + 饱和度缩放 + 明度保留」重映射像素，
 *    这是 Team Color 的标准做法——阵营色互换时材质明暗关系保持不变。
 *
 * 中性色槽（低饱和的黑/灰/白）默认不参与色相旋转，避免把线稿和金属灰染上阵营色；
 * 若显式给它指定有彩色目标，则按「保留明度、注入目标色相与饱和度」着色，
 * 可用于白色铠甲染阵营色这类皮肤需求。
 */
import { colorMatchWindows, hueDelta, rgbToHsv } from '@/core/color-key'
import { hexToRgb, rgbToHex } from '@/core/frame-matte'
import { imageToImageData, imageDataToUrl, loadImage } from '@/core/image'

/** 饱和度低于该值视为中性色（黑/灰/白），色相判据对它无意义 */
const NEUTRAL_SAT = 0.15
/** 容差 → 明度窗口的换算系数（仅中性色槽分层用） */
const VALUE_WINDOW_RATIO = 0.004
/** 软过渡带宽度（相对判据窗口的倍数），边缘像素按强度衰减混合，避免色块硬切 */
const SOFT_BAND_RATIO = 0.5
/** 量化精度：每通道 32 级，抗噪声又能区分相近色 */
const QUANT_LEVELS = 32
/** 参与聚类的候选桶上限 */
const CANDIDATE_LIMIT = 240
/** 单个色槽最少占总像素的比例，低于该值视为噪声不列入色板 */
const MIN_SLOT_RATIO = 0.004

/** 一个可编辑色槽 */
export interface PaletteSlot {
  id: string
  /** 提取到的原始主色 #rrggbb，作为映射基准（不随用户编辑变化） */
  source: string
  /** 目标色 #rrggbb，与 source 相同表示保持原样 */
  target: string
  /** 开关：false 时该槽不参与换色 */
  enabled: boolean
  /**
   * 阵营色标记：只有被标记的槽会被「阵营色预设」写入目标色。
   * Team Color 的语义是「只换阵营色区域」，若不区分就会把白色底、绿色植被等一起染掉。
   */
  team: boolean
  /** 命中像素数 */
  pixels: number
  /** 占总不透明像素的比例（0-1） */
  ratio: number
}

/** 提取参数 */
export interface ExtractOptions {
  /** 期望的色槽数量上限 */
  maxSlots: number
  /** 颜色容差，决定色相/饱和度窗口宽度 */
  tolerance: number
  /** 是否把中性色（黑/灰/白）分层列入色板 */
  includeNeutrals: boolean
}

/** Team Color 预设阵营色组：名称 + 目标色序列 */
export interface PalettePreset {
  key: string
  label: string
  colors: string[]
}

/** 常用阵营色预设（红 / 蓝 / 绿 / 紫 / 黄 / 青 / 橙） */
export const TEAM_COLOR_PRESETS: PalettePreset[] = [
  { key: 'red', label: '红方', colors: ['#d13b3b', '#f0645e', '#8f1f24'] },
  { key: 'blue', label: '蓝方', colors: ['#3b6fd1', '#6aa0f0', '#1f3f8f'] },
  { key: 'green', label: '绿方', colors: ['#3ba85a', '#6fd18f', '#1f6b38'] },
  { key: 'purple', label: '紫方', colors: ['#8b46c9', '#b98af0', '#5b2688'] },
  { key: 'yellow', label: '黄方', colors: ['#e0b23a', '#f5d873', '#a37a17'] },
  { key: 'cyan', label: '青方', colors: ['#2fa8b8', '#6fd4e0', '#166b78'] },
  { key: 'orange', label: '橙方', colors: ['#e0762f', '#f5a86a', '#a34a14'] },
]

/** 变体：一组「槽 → 目标色」的映射 */
export interface PaletteVariant {
  id: string
  /** 变体名（同时作为导出文件名的一部分） */
  name: string
  /** slotId → 目标色 #rrggbb */
  mapping: Record<string, string>
}

/** 生成变体 id */
export function createVariantId(): string {
  return `variant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 校验并规范化 #rrggbb，非法返回 null */
export function normalizeHex(hex: string): string | null {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToHex(rgb.r, rgb.g, rgb.b) : null
}

/**
 * 提取主色板。
 * 先按 32 级量化统计像素桶，再贪心聚类：像素多的桶优先成为色槽，
 * 后续桶若与已有槽的色相族 / 饱和度 / 明度足够接近就并入该槽（加权平均更新主色）。
 */
export async function extractPaletteSlots(
  source: string | HTMLImageElement,
  options: ExtractOptions,
): Promise<PaletteSlot[]> {
  const image = typeof source === 'string' ? await loadImage(source, '图片加载失败') : source
  const data = imageToImageData(image)
  return slotsFromImageData(data, options)
}

/** 从像素数据提取色槽（与图像加载解耦，便于复用已解码的像素） */
export function slotsFromImageData(data: ImageData, options: ExtractOptions): PaletteSlot[] {
  const buckets = quantizeBuckets(data)
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  if (!total) return []
  const candidates = buckets.sort((a, b) => b.count - a.count).slice(0, CANDIDATE_LIMIT)

  const { hue: hueWindow, sat: satWindow } = colorMatchWindows(options.tolerance)
  const valueWindow = Math.max(0.02, options.tolerance * VALUE_WINDOW_RATIO)

  interface Cluster { r: number; g: number; b: number; count: number; hsv: [number, number, number] }
  const clusters: Cluster[] = []
  for (const bucket of candidates) {
    const [hue, sat, value] = rgbToHsv(bucket.r, bucket.g, bucket.b)
    const neutral = sat < NEUTRAL_SAT
    if (neutral && !options.includeNeutrals) continue
    let merged = false
    for (const cluster of clusters) {
      const [ch, cs, cv] = cluster.hsv
      const clusterNeutral = cs < NEUTRAL_SAT
      // 中性与非中性不合并：色相判据对中性无意义
      if (clusterNeutral !== neutral) continue
      const score = neutral
        ? Math.abs(value - cv) / valueWindow
        : Math.max(hueDelta(hue, ch) / hueWindow, Math.abs(sat - cs) / satWindow, Math.abs(value - cv) / (valueWindow * 4))
      if (score > 1) continue
      const count = cluster.count + bucket.count
      cluster.r = Math.round((cluster.r * cluster.count + bucket.r * bucket.count) / count)
      cluster.g = Math.round((cluster.g * cluster.count + bucket.g * bucket.count) / count)
      cluster.b = Math.round((cluster.b * cluster.count + bucket.b * bucket.count) / count)
      cluster.count = count
      cluster.hsv = rgbToHsv(cluster.r, cluster.g, cluster.b)
      merged = true
      break
    }
    if (!merged) clusters.push({ r: bucket.r, g: bucket.g, b: bucket.b, count: bucket.count, hsv: [hue, sat, value] })
    if (clusters.length >= options.maxSlots * 3) break
  }

  // 按占比过滤噪声槽，再按像素数降序取前 maxSlots
  const picked = clusters
    .filter((cluster) => cluster.count / total >= MIN_SLOT_RATIO)
    .sort((a, b) => b.count - a.count)
    .slice(0, options.maxSlots)
    .map((cluster, index) => {
      const hex = rgbToHex(cluster.r, cluster.g, cluster.b)
      const [, sat] = rgbToHsv(cluster.r, cluster.g, cluster.b)
      return {
        id: `slot-${index + 1}`, source: hex, target: hex, enabled: true,
        // 中性色（白/灰/黑底、线稿）永远不是阵营色，否则整张图会被染色
        team: sat >= NEUTRAL_SAT,
        pixels: cluster.count, ratio: cluster.count / total,
      }
    })
  // 默认只把「占比最高的有彩色槽」当作阵营色：图集里往往混有植被、海水等场景色，
  // 全部染色会得到一片通红的结果。其余色槽由用户在界面上逐个勾选加入阵营。
  let teamMarked = false
  picked.forEach((slot) => {
    if (!slot.team || teamMarked) { slot.team = false; return }
    teamMarked = true
  })
  return picked
}

/** 量化桶：每通道 32 级，累加同桶像素的真实 RGB 求均值 */
function quantizeBuckets(data: ImageData): Array<{ r: number; g: number; b: number; count: number }> {
  const pixels = data.data
  const step = 256 / QUANT_LEVELS
  const map = new Map<number, { sumR: number; sumG: number; sumB: number; count: number }>()
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 8) continue
    const key = ((pixels[i] / step) | 0) * QUANT_LEVELS * QUANT_LEVELS + ((pixels[i + 1] / step) | 0) * QUANT_LEVELS + ((pixels[i + 2] / step) | 0)
    const entry = map.get(key)
    if (entry) {
      entry.sumR += pixels[i]; entry.sumG += pixels[i + 1]; entry.sumB += pixels[i + 2]; entry.count += 1
    } else {
      map.set(key, { sumR: pixels[i], sumG: pixels[i + 1], sumB: pixels[i + 2], count: 1 })
    }
  }
  const buckets: Array<{ r: number; g: number; b: number; count: number }> = []
  map.forEach((entry) => {
    buckets.push({
      r: Math.round(entry.sumR / entry.count),
      g: Math.round(entry.sumG / entry.count),
      b: Math.round(entry.sumB / entry.count),
      count: entry.count,
    })
  })
  return buckets
}

/**
 * 渲染一个变体：按色槽映射重映射像素，返回 PNG dataURL。
 * originPixels 由调用方缓存（一次解码，多变体复用），避免每套变体重复读像素。
 */
export async function renderPaletteVariant(
  originPixels: ImageData,
  slots: PaletteSlot[],
  variant: PaletteVariant,
  tolerance: number,
  onProgress?: (ratio: number) => void,
): Promise<string> {
  const work = new ImageData(new Uint8ClampedArray(originPixels.data), originPixels.width, originPixels.height)
  await remapImageData(work, slots, variant, tolerance, onProgress)
  return imageDataToUrl(work)
}

/**
 * 按命名模板生成导出文件名。
 * 支持的占位符：{base} 源图名、{variant} 变体名、{index} 变体序号（从 1 开始）。
 * 模板非法（无扩展名）时回落到 `.png`，并过滤文件名中的非法字符。
 */
export function paletteFileName(template: string, base: string, variant: string, index: number): string {
  const filled = (template || '{base}_{variant}.png')
    .replace(/\{base\}/g, base)
    .replace(/\{variant\}/g, variant)
    .replace(/\{index\}/g, String(index + 1))
  const cleaned = filled.replace(/[\\/:*?"<>|\s]+/g, '_')
  return /\.(png|jpg|jpeg|webp)$/i.test(cleaned) ? cleaned : `${cleaned || 'variant'}.png`
}

/** 把「槽 → 目标色」映射写成 JSON 友好的结构（含原色，便于引擎侧回溯） */
export function buildPaletteMeta(
  sourceName: string,
  slots: PaletteSlot[],
  variants: Array<{ name: string; fileName: string }>,
  tolerance: number,
): Record<string, unknown> {
  return {
    app: 'AtlasSlice',
    version: '1.0',
    image: sourceName,
    tolerance,
    slots: slots.map((slot) => ({ id: slot.id, source: slot.source, team: slot.team, pixels: slot.pixels, ratio: Number(slot.ratio.toFixed(4)) })),
    variants: variants.map((variant) => ({ name: variant.name, file: variant.fileName })),
  }
}

/**
 * 就地重映射像素。
 * 每个像素找「最接近且落在容差窗口内」的启用色槽，按该槽的目标色做 HSV 重映射：
 * 色相平移到目标色（保留槽内色相微差），饱和度按目标/原饱和度比例缩放，明度原样保留。
 * 未命中的像素（背景、线稿等）不动，保证只换阵营色区域。
 */
export async function remapImageData(
  data: ImageData,
  slots: PaletteSlot[],
  variant: PaletteVariant,
  tolerance: number,
  onProgress?: (ratio: number) => void,
): Promise<void> {
  const { hue: hueWindow, sat: satWindow } = colorMatchWindows(tolerance)
  const valueWindow = Math.max(0.02, tolerance * VALUE_WINDOW_RATIO)

  // 预解析启用且确有换色需求的槽：目标色非法或与原色相同则跳过
  const plans: Array<{
    hue: number; sat: number; value: number; neutral: boolean;
    targetHue: number; targetSat: number; targetNeutral: boolean;
  }> = []
  for (const slot of slots) {
    if (!slot.enabled) continue
    const targetHex = variant.mapping[slot.id]
    if (!targetHex || targetHex.toLowerCase() === slot.source.toLowerCase()) continue
    const from = hexToRgb(slot.source)
    const to = hexToRgb(targetHex)
    if (!from || !to) continue
    const [fh, fs, fv] = rgbToHsv(from.r, from.g, from.b)
    const [th, ts] = rgbToHsv(to.r, to.g, to.b)
    plans.push({ hue: fh, sat: fs, value: fv, neutral: fs < NEUTRAL_SAT, targetHue: th, targetSat: ts, targetNeutral: ts < NEUTRAL_SAT })
  }
  if (!plans.length) return

  const pixels = data.data
  const width = data.width
  const height = data.height
  const chunkRows = Math.max(1, Math.floor(2_097_152 / width)) // 每次约处理 2M 像素
  // 热循环内不分配数组/对象，HSV 结果写进这两个复用容器
  const hsv: [number, number, number] = [0, 0, 0]
  const rgb: [number, number, number] = [0, 0, 0]
  for (let start = 0; start < height; start += chunkRows) {
    const end = Math.min(height, start + chunkRows)
    for (let y = start; y < end; y++) {
      const row = y * width * 4
      for (let x = 0; x < width; x++) {
        const i = row + x * 4
        if (pixels[i + 3] < 8) continue
        rgbToHsvInto(pixels[i], pixels[i + 1], pixels[i + 2], hsv)
        const hue = hsv[0]; const sat = hsv[1]; const value = hsv[2]
        const pixelNeutral = sat < NEUTRAL_SAT
        let best = -1
        let bestScore = Infinity
        for (let p = 0; p < plans.length; p++) {
          const plan = plans[p]
          if (plan.neutral !== pixelNeutral) continue
          const score = plan.neutral
            ? Math.abs(value - plan.value) / valueWindow
            : Math.max(hueDelta(hue, plan.hue) / hueWindow, Math.abs(sat - plan.sat) / satWindow)
          if (score < bestScore) { bestScore = score; best = p }
        }
        if (best < 0 || bestScore > 1 + SOFT_BAND_RATIO) continue
        const plan = plans[best]
        // 软过渡：窗口外 0.5 倍带宽内按强度衰减，避免抗锯齿边缘出现硬切色带
        const strength = bestScore <= 1 ? 1 : 1 - (bestScore - 1) / SOFT_BAND_RATIO
        let newHue: number
        let newSat: number
        if (plan.neutral || plan.targetNeutral) {
          // 中性 ↔ 有彩色：目标色相与饱和度直接取目标（明度原样保留，灰阶越深染色越实）
          newHue = plan.targetHue
          newSat = plan.targetNeutral ? sat : plan.targetSat
        } else {
          // 有彩色互换：色相平移（保留槽内色相微差），饱和度按目标/原比例缩放
          newHue = plan.targetHue + (hue - plan.hue)
          newSat = plan.sat > 0 ? Math.min(1, sat * (plan.targetSat / plan.sat)) : plan.targetSat
        }
        hsvToRgbInto(newHue, newSat, value, rgb)
        if (strength < 1) {
          pixels[i] = Math.round(pixels[i] + (rgb[0] - pixels[i]) * strength)
          pixels[i + 1] = Math.round(pixels[i + 1] + (rgb[1] - pixels[i + 1]) * strength)
          pixels[i + 2] = Math.round(pixels[i + 2] + (rgb[2] - pixels[i + 2]) * strength)
        } else {
          pixels[i] = rgb[0]
          pixels[i + 1] = rgb[1]
          pixels[i + 2] = rgb[2]
        }
      }
    }
    if (onProgress) onProgress(end / height)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** HSV → RGB（h 为 0-360 度，s/v 为 0-1），结果写入 out 容器（0-255） */
function hsvToRgbInto(hue: number, sat: number, value: number, out: [number, number, number]): void {
  const h = (((hue % 360) + 360) % 360) / 60
  const c = value * sat
  const x = c * (1 - Math.abs((h % 2) - 1))
  const m = value - c
  let r = 0; let g = 0; let b = 0
  if (h < 1) { r = c; g = x } else if (h < 2) { r = x; g = c } else if (h < 3) { g = c; b = x }
  else if (h < 4) { g = x; b = c } else if (h < 5) { r = x; b = c } else { r = c; b = x }
  out[0] = Math.round((r + m) * 255)
  out[1] = Math.round((g + m) * 255)
  out[2] = Math.round((b + m) * 255)
}

/** RGB → HSV，结果写入 out 容器（h 为 0-360 度，s/v 为 0-1） */
function rgbToHsvInto(r: number, g: number, b: number, out: [number, number, number]): void {
  const rn = r / 255; const gn = g / 255; const bn = b / 255
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn)
  const delta = max - min
  let hue = 0
  if (delta > 0) {
    if (max === rn) hue = 60 * (((gn - bn) / delta) % 6)
    else if (max === gn) hue = 60 * ((bn - rn) / delta + 2)
    else hue = 60 * ((rn - gn) / delta + 4)
  }
  if (hue < 0) hue += 360
  out[0] = hue
  out[1] = max === 0 ? 0 : delta / max
  out[2] = max
}

/** HSV → RGB（h 为 0-360 度，s/v 为 0-1），返回 0-255 三通道 */
export function hsvToRgb(hue: number, sat: number, value: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0]
  hsvToRgbInto(hue, sat, value, out)
  return out
}
