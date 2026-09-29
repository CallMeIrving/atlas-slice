/**
 * gifenc 的类型声明。
 * 该包为纯 JS 实现、未自带 .d.ts，这里只声明项目实际用到的 API，
 * 签名与 gifenc@1.0.3 的 dist/gifenc.esm.js 保持一致。
 */
declare module 'gifenc' {
  /** 调色板条目：rgb565 为 [r,g,b]，rgba4444 为 [r,g,b,a] */
  export type PaletteEntry = number[]
  export type Palette = PaletteEntry[]

  export interface QuantizeOptions {
    /** 量化格式，含透明通道时使用 rgba4444 */
    format?: 'rgb565' | 'rgb444' | 'rgba4444'
    /** 是否把 alpha 压缩为一位（<=阈值视为全透明） */
    oneBitAlpha?: boolean | number
    /** 是否把透明像素的颜色清零 */
    clearAlpha?: boolean
    clearAlphaColor?: number
    clearAlphaThreshold?: number
    useSqrt?: boolean
  }

  export interface WriteFrameOptions {
    /** 当前帧是否包含透明像素 */
    transparent?: boolean
    /** 透明像素对应的调色板索引 */
    transparentIndex?: number
    /** 帧延迟（毫秒），内部换算为 GIF 的百分之一秒 */
    delay?: number
    /** 帧间调色板 */
    palette?: Palette
    /** 循环次数，0 为无限循环（仅首帧生效） */
    repeat?: number
    /**  disposal 方式：-1 默认 / 1 保留 / 2 恢复背景 */
    dispose?: number
    colorDepth?: number
    first?: boolean
  }

  export interface GIFEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void
    finish(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
    reset(): void
  }

  export interface GIFEncoderOptions {
    initialCapacity?: number
    auto?: boolean
  }

  /** 创建 GIF 编码器；auto 模式下首帧自动写入头部与全局调色板 */
  export function GIFEncoder(options?: GIFEncoderOptions): GIFEncoderInstance

  /** 对 RGBA 像素数据做八叉树量化，生成不超过 maxColors 色的调色板 */
  export function quantize(data: Uint8Array | Uint8ClampedArray, maxColors: number, options?: QuantizeOptions): Palette

  /** 把 RGBA 像素数据映射到调色板索引序列 */
  export function applyPalette(
    data: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array

  const gifenc: {
    GIFEncoder: typeof GIFEncoder
    quantize: typeof quantize
    applyPalette: typeof applyPalette
  }
  export default gifenc
}
