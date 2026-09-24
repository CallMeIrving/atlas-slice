/* ===== 背景抠图（色键 / chroma key）核心算法 =====
 *
 * 按基准色是否「有彩色」自动选择判据：
 *
 * 1. 有彩色背景（绿幕、蓝幕等）：走**色相判据**。
 *    关键认知：地面影子与光照不均的本质都是「背景色被压暗」——色相几乎不变、
 *    饱和度基本持平、只有明度下降。因此判背景时只看色相与饱和度、不看明度，
 *    才能同时吃掉纯色背景、光照不均和地面影子，这是 RGB 距离判据做不到的
 *    （RGB 距离对明度变化极其敏感，影子会被判成前景而残留成一块脏色）。
 *
 * 2. 中性色背景（白/灰/黑）：色相无意义，退回 RGB 距离判据。
 */

/** 影子处理方式 */
export type ShadowMode =
  /** 保留原样（不做处理，影子会保留背景色） */
  | 'ignore'
  /** 连影子一起抠掉 */
  | 'remove'
  /** 保留影子，但去色成中性半透明（贴到任意背景都不偏色） */
  | 'neutral'

export interface ColorKeyOptions {
  /** 背景基准色（0-255） */
  r: number
  g: number
  b: number
  /** 颜色容差，色相判据下换算为色相窗口（度）与饱和度窗口 */
  tolerance: number
  /** 额外把接近纯白的像素判为背景（仅中性色背景生效） */
  removeWhite?: boolean
  /** 影子处理方式，默认保留原样 */
  shadow?: ShadowMode
}

/** 基准色通道极差超过该值即视为有彩色背景，走色相判据 */
const CHROMATIC_MIN_CHROMA = 24
/** 容差 → 色相窗口（度）的换算系数：tolerance=24 时约 ±14.4° */
const HUE_WINDOW_RATIO = 0.6
/** 容差 → 饱和度窗口的换算系数：tolerance=24 时约 ±0.14 */
const SAT_WINDOW_RATIO = 0.006
/** 软过渡带宽度（相对判据窗口的倍数），用于保留抗锯齿边缘 */
const SOFT_BAND_RATIO = 0.5
/** 明度低于基准明度该比例即视为影子（否则算背景本身） */
const SHADOW_VALUE_DROP = 0.06
/** 明度低于基准明度该比例即视为前景，避免吃掉黑色线稿 */
const SHADOW_VALUE_FLOOR = 0.25

/** RGB → HSV（h 为 0-360 度，s/v 为 0-1） */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
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
  return [hue, max === 0 ? 0 : delta / max, max]
}

/** 环形色相差（0-180 度） */
function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * 有彩色背景的色相判据抠图。
 * 判据：色相与饱和度都落在基准色窗口内即属于「背景族」，再按明度区分
 *      背景本体（完全透明）与影子（按 shadow 处理）；窗口外侧走软过渡带。
 */
function applyHueKey(data: ImageData, options: ColorKeyOptions): void {
  const pixels = data.data
  const { r: baseR, g: baseG, b: baseB, tolerance } = options
  const shadow = options.shadow ?? 'ignore'
  const [baseHue, baseSat, baseValue] = rgbToHsv(baseR, baseG, baseB)
  const hueWindow = Math.max(1, tolerance * HUE_WINDOW_RATIO)
  const satWindow = Math.max(0.02, tolerance * SAT_WINDOW_RATIO)
  const valueFloor = baseValue * SHADOW_VALUE_FLOOR
  const valueDrop = baseValue * SHADOW_VALUE_DROP
  // 中性色背景不做色溢抑制；有彩色背景把主色通道压到其他通道的水平，消除彩边
  const spillChannel = [baseR, baseG, baseB].indexOf(Math.max(baseR, baseG, baseB))

  for (let i = 0; i < pixels.length; i += 4) {
    const [hue, sat, value] = rgbToHsv(pixels[i], pixels[i + 1], pixels[i + 2])
    const score = Math.max(hueDelta(hue, baseHue) / hueWindow, Math.abs(sat - baseSat) / satWindow)

    if (score <= 1) {
      // 背景族：色相与饱和度都对得上
      if (value >= baseValue - valueDrop) { pixels[i + 3] = 0; continue }
      if (value >= valueFloor) {
        if (shadow === 'remove') { pixels[i + 3] = 0; continue }
        if (shadow === 'neutral') {
          // 影子浓度 = 明度衰减比例；输出中性黑 + 半透明，贴任意背景都自然
          const concentration = Math.min(1, Math.max(0, 1 - value / baseValue))
          pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0
          pixels[i + 3] = Math.round(concentration * 255)
          continue
        }
        // shadow === 'ignore'：影子原样保留
        pixels[i + 3] = 255
        continue
      }
      // 明度太低（黑色线稿等）→ 按前景处理，继续走下方软过渡判断
    }

    const softness = Math.min(1, Math.max(0, (score - 1) / SOFT_BAND_RATIO))
    const alpha = Math.round(softness * 255)
    if (alpha >= pixels[i + 3]) continue
    if (alpha > 0) {
      const other = spillChannel === 0
        ? Math.max(pixels[i + 1], pixels[i + 2])
        : spillChannel === 1
          ? Math.max(pixels[i], pixels[i + 2])
          : Math.max(pixels[i], pixels[i + 1])
      if (pixels[i + spillChannel] > other) pixels[i + spillChannel] = other
    }
    pixels[i + 3] = alpha
  }
}

/**
 * 中性色背景（白/灰/黑）的 RGB 距离判据抠图：
 * 1. 色差 ≤ tolerance*3 的像素完全透明；
 * 2. 再向外一个渐变带按色差给出半透明 alpha，避免硬切后残留一圈背景色；
 * 3. 对半透明边缘像素抑制背景主色通道的色溢（despill），消除彩边。
 */
function applyDistanceKey(data: ImageData, options: ColorKeyOptions): void {
  const pixels = data.data
  const { r: baseR, g: baseG, b: baseB, tolerance } = options
  const solid = tolerance * 3
  const band = solid * 1.2 + 1

  const maxChannel = Math.max(baseR, baseG, baseB)
  const minChannel = Math.min(baseR, baseG, baseB)
  const spillChannel = maxChannel - minChannel > CHROMATIC_MIN_CHROMA ? [baseR, baseG, baseB].indexOf(maxChannel) : -1

  for (let i = 0; i < pixels.length; i += 4) {
    const distance = Math.abs(pixels[i] - baseR) + Math.abs(pixels[i + 1] - baseG) + Math.abs(pixels[i + 2] - baseB)
    const matchesWhite = options.removeWhite === true && pixels[i] > 255 - tolerance && pixels[i + 1] > 255 - tolerance && pixels[i + 2] > 255 - tolerance
    const softness = Math.min(1, Math.max(0, (distance - solid) / band))
    const alpha = matchesWhite ? 0 : Math.round(softness * 255)
    if (alpha >= pixels[i + 3]) continue
    if (spillChannel >= 0 && alpha > 0) {
      const other = spillChannel === 0
        ? Math.max(pixels[i + 1], pixels[i + 2])
        : spillChannel === 1
          ? Math.max(pixels[i], pixels[i + 2])
          : Math.max(pixels[i], pixels[i + 1])
      if (pixels[i + spillChannel] > other) pixels[i + spillChannel] = other
    }
    pixels[i + 3] = alpha
  }
}

/**
 * 抠图入口：按基准色是否「有彩色」自动选择色相判据或 RGB 距离判据。
 * 注意：色相判据下 removeWhite 不生效——白色像素饱和度接近 0，与有彩色基准色
 * 的饱和度窗口天然不符，会被判为前景，因此不会再误伤白色衣物。
 */
export function applyColorKey(data: ImageData, options: ColorKeyOptions): void {
  const chroma = Math.max(options.r, options.g, options.b) - Math.min(options.r, options.g, options.b)
  if (chroma > CHROMATIC_MIN_CHROMA) applyHueKey(data, options)
  else applyDistanceKey(data, options)
}

export interface ColorKeyBase {
  r: number
  g: number
  b: number
  /** 是否为有彩色背景（true = 走色相判据） */
  chromatic: boolean
}

/** 由指定 RGB 构造抠图基准色（手动取色/边缘采样共用） */
export function colorKeyBase(r: number, g: number, b: number): ColorKeyBase {
  return { r, g, b, chromatic: Math.max(r, g, b) - Math.min(r, g, b) > CHROMATIC_MIN_CHROMA }
}

/**
 * 从图像四边（不含四角的中间段）逐通道取中位数采样背景基准色，
 * 中位数可抗噪点，避开四角可避免物体边缘污染基准色。
 */
export function sampleEdgeColor(data: ImageData): ColorKeyBase {
  const pixels = data.data
  const width = data.width
  const height = data.height
  const samples: number[] = []
  const sampleStep = 8
  const inset = Math.max(2, Math.floor(Math.min(width, height) / 32))
  const push = (index: number): void => {
    const offset = index * 4
    samples.push(pixels[offset], pixels[offset + 1], pixels[offset + 2])
  }
  for (let x = inset; x < width - inset; x += sampleStep) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = inset; y < height - inset; y += sampleStep) {
    push(y * width)
    push(y * width + width - 1)
  }
  const base = samples.length === 0
    ? { r: pixels[0], g: pixels[1], b: pixels[2] }
    : {
        r: medianOf(samples, 0),
        g: medianOf(samples, 1),
        b: medianOf(samples, 2),
      }
  return colorKeyBase(base.r, base.g, base.b)
}

/** 取指定通道偏移的中位数 */
function medianOf(samples: number[], channelOffset: number): number {
  const channel: number[] = []
  for (let i = channelOffset; i < samples.length; i += 3) channel.push(samples[i])
  channel.sort((a, b) => a - b)
  return channel[Math.floor(channel.length / 2)]
}

/**
 * 纯色背景抠图：自动从图像四边采样边缘主色作为背景基准色，再走色相判据 + 色溢抑制。
 * 适合纯色/接近纯色背景的批量抠图（绿幕、蓝幕、纯色渲染背景）。
 * 返回采样到的基准色，便于调用方展示与手动覆盖。
 */
export function solidColorKey(data: ImageData, tolerance: number, shadow: ShadowMode = 'ignore'): ColorKeyBase {
  const base = sampleEdgeColor(data)
  // removeWhite 只在中性色背景下才有意义，避免把白色衣物/高光误判为背景
  applyColorKey(data, { r: base.r, g: base.g, b: base.b, tolerance, shadow, removeWhite: !base.chromatic })
  return base
}