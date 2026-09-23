export interface ColorKeyOptions {
  /** 背景基准色（0-255） */
  r: number
  g: number
  b: number
  /** 颜色容差，映射为三通道平均色差 */
  tolerance: number
  /** 额外把接近纯白的像素判为背景 */
  removeWhite?: boolean
}

/**
 * 按背景色做软阈值抠图：
 * 1. 色差 ≤ tolerance*3 的像素完全透明；
 * 2. 再向外一个渐变带按色差给出半透明 alpha，避免硬切后残留一圈背景色；
 * 3. 对半透明边缘像素抑制背景主色通道的色溢（despill），消除彩边。
 */
export function applyColorKey(data: ImageData, options: ColorKeyOptions): void {
  const pixels = data.data
  const { r: baseR, g: baseG, b: baseB, tolerance } = options
  const solid = tolerance * 3
  const band = solid * 1.2 + 1

  // 背景主色通道（红底取红通道），中性色背景不做色溢抑制
  const maxChannel = Math.max(baseR, baseG, baseB)
  const minChannel = Math.min(baseR, baseG, baseB)
  const spillChannel = maxChannel - minChannel > 24 ? [baseR, baseG, baseB].indexOf(maxChannel) : -1

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
 * 纯色背景抠图：自动从图像四边采样边缘主色作为背景基准色，
 * 再走软阈值 + 色溢抑制。适合纯色/接近纯色背景的批量抠图。
 * 返回采样到的基准色，便于调用方展示。
 */
export function solidColorKey(data: ImageData, tolerance: number): { r: number; g: number; b: number } {
  const pixels = data.data
  const width = data.width
  const height = data.height
  // 采样四边（不含四角的中间段），避免角落的物体边缘污染基准色
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
  if (samples.length === 0) return { r: pixels[0], g: pixels[1], b: pixels[2] }
  // 逐通道取中位数，抗噪点
  const median = (channelOffset: number): number => {
    const channel: number[] = []
    for (let i = channelOffset; i < samples.length; i += 3) channel.push(samples[i])
    channel.sort((a, b) => a - b)
    return channel[Math.floor(channel.length / 2)]
  }
  const base = { r: median(0), g: median(1), b: median(2) }
  applyColorKey(data, { ...base, tolerance, removeWhite: true })
  return base
}