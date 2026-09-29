/**
 * 九宫格（9-slice）切分与导出。
 *
 * 输入一张 UI 图与四边距离（left/top/right/bottom，图像像素坐标），
 * 切出 9 块带 alpha 的 PNG，并输出 TexturePacker 兼容的 `border` 元数据，
 * 供游戏引擎（Unity / Cocos / Phaser 等）按九宫格方式拉伸复用。
 */
import { loadImage, releaseCanvas } from '@/core/image'

/** 四边距离：竖直分割线到左/右边缘、水平分割线到上/下边缘的像素距离 */
export interface NineSliceBorder {
  left: number
  top: number
  right: number
  bottom: number
}

/** 单块切片的矩形（图像像素坐标） */
export interface NineSlicePart {
  /** 稳定标识，如 'topLeft' / 'center' */
  key: string
  /** 导出文件名，如 'panel_tl.png' */
  name: string
  x: number
  y: number
  width: number
  height: number
}

/** 九宫格 9 块的 key，按阅读顺序（上排→中排→下排） */
export const NINE_SLICE_KEYS = [
  'topLeft', 'top', 'topRight',
  'left', 'center', 'right',
  'bottomLeft', 'bottom', 'bottomRight',
] as const

export type NineSliceKey = (typeof NINE_SLICE_KEYS)[number]

const FILE_SUFFIX: Record<NineSliceKey, string> = {
  topLeft: 'tl', top: 't', topRight: 'tr',
  left: 'l', center: 'c', right: 'r',
  bottomLeft: 'bl', bottom: 'b', bottomRight: 'br',
}

/**
 * 收敛四边距离到合法范围。
 * 约束：每条边至少 1px，且 left + right ≤ width、top + bottom ≤ height，
 * 保证中心块宽度/高度不为 0；非法输入（NaN、负数）回落到 0。
 */
export function clampBorder(border: NineSliceBorder, width: number, height: number): NineSliceBorder {
  const safe = (v: number) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  const left = Math.min(safe(border.left), Math.max(0, width - 1))
  const right = Math.min(safe(border.right), Math.max(0, width - 1 - left))
  const top = Math.min(safe(border.top), Math.max(0, height - 1))
  const bottom = Math.min(safe(border.bottom), Math.max(0, height - 1 - top))
  return { left, top, right, bottom }
}

/**
 * 按四边距离计算 9 块的矩形。
 * 分割线坐标：x1 = left、x2 = width - right、y1 = top、y2 = height - bottom。
 */
export function sliceParts(width: number, height: number, border: NineSliceBorder): NineSlicePart[] {
  const x1 = border.left
  const x2 = width - border.right
  const y1 = border.top
  const y2 = height - border.bottom
  const colX = [0, x1, x2]
  const colW = [x1, x2 - x1, width - x2]
  const rowY = [0, y1, y2]
  const rowH = [y1, y2 - y1, height - y2]
  const parts: NineSlicePart[] = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const key = NINE_SLICE_KEYS[r * 3 + c]
      parts.push({
        key,
        name: FILE_SUFFIX[key],
        x: colX[c],
        y: rowY[r],
        width: colW[c],
        height: rowH[r],
      })
    }
  }
  return parts
}

/** 把单块矩形裁出来转成 PNG dataURL（源可以是图像元素或已放大的画布） */
export function slicePartToDataUrl(source: HTMLImageElement | HTMLCanvasElement, part: NineSlicePart): string {
  if (part.width <= 0 || part.height <= 0) return ''
  const canvas = document.createElement('canvas')
  canvas.width = part.width
  canvas.height = part.height
  canvas.getContext('2d')!.drawImage(source, part.x, part.y, part.width, part.height, 0, 0, part.width, part.height)
  const url = canvas.toDataURL('image/png')
  releaseCanvas(canvas)
  return url
}

/**
 * 切分整张图：返回 key → PNG dataURL 的映射（空块不产出）。
 * 供预览与导出共用；source 可传 URL 或已解码的图像元素（拖拽调线时复用同一次解码）。
 */
export async function sliceNineSlice(source: string | HTMLImageElement, border: NineSliceBorder): Promise<Record<NineSliceKey, string>> {
  const image = typeof source === 'string' ? await loadImage(source, '九宫格源图加载失败') : source
  const width = image.naturalWidth
  const height = image.naturalHeight
  const parts = sliceParts(width, height, clampBorder(border, width, height))
  const result = {} as Record<NineSliceKey, string>
  parts.forEach((part) => {
    const url = slicePartToDataUrl(image, part)
    if (url) result[part.key as NineSliceKey] = url
  })
  return result
}

/**
 * 把四边距离按倍率放大。
 * 倍率导出时中心块不能塌缩为 0，因此 left + right 必须小于放大后的宽度，
 * 这里对「放大后取整」的结果再做一次收敛。
 */
export function scaleBorder(border: NineSliceBorder, scale: number, width: number, height: number): NineSliceBorder {
  return clampBorder(
    {
      left: Math.round(border.left * scale),
      top: Math.round(border.top * scale),
      right: Math.round(border.right * scale),
      bottom: Math.round(border.bottom * scale),
    },
    Math.round(width * scale),
    Math.round(height * scale),
  )
}

/**
 * 按倍率切分整张图（用于 @2x / @3x 多密度资源导出）。
 * 先把源图高质量放大到目标尺寸再切块，这样四块角的边缘过渡与中心块保持一致，
 * 不会出现「逐块放大导致接缝错位」的问题。
 */
export async function sliceNineSliceAtScale(
  source: string | HTMLImageElement,
  border: NineSliceBorder,
  scale: number,
): Promise<Record<NineSliceKey, string>> {
  const image = typeof source === 'string' ? await loadImage(source, '九宫格源图加载失败') : source
  const width = Math.round(image.naturalWidth * scale)
  const height = Math.round(image.naturalHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  const parts = sliceParts(width, height, scaleBorder(border, scale, image.naturalWidth, image.naturalHeight))
  const result = {} as Record<NineSliceKey, string>
  parts.forEach((part) => {
    const url = slicePartToDataUrl(canvas, part)
    if (url) result[part.key as NineSliceKey] = url
  })
  releaseCanvas(canvas)
  return result
}

/**
 * 生成 Android 九宫格补丁（.9.png）。
 *
 * 格式约定：原图四周各加 1px 透明边距，画布尺寸为 (宽+2)×(高+2)；
 * 上边与左边的黑线标记「可拉伸区域」，右边与下边的黑线标记「内容区域」。
 * 这里把两个区域都取为分割线围成的中心块，等价于「装饰边框不参与拉伸、内容不压边框」。
 */
export function buildNinePatch(image: HTMLImageElement, border: NineSliceBorder): string {
  const width = image.naturalWidth
  const height = image.naturalHeight
  const b = clampBorder(border, width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width + 2
  canvas.height = height + 2
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 1, 1)
  const patch = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = patch.data
  /** 写入一个不透明黑色像素 */
  const setBlack = (x: number, y: number) => {
    const i = (y * canvas.width + x) * 4
    px[i] = 0
    px[i + 1] = 0
    px[i + 2] = 0
    px[i + 3] = 255
  }
  // 拉伸区与内容区的起止（含端点），加上 1px 边距偏移
  const x1 = b.left + 1
  const x2 = width - b.right + 1
  const y1 = b.top + 1
  const y2 = height - b.bottom + 1
  for (let x = x1; x <= x2; x++) {
    setBlack(x, 0) // 上边
    setBlack(x, canvas.height - 1) // 下边（内容区）
  }
  for (let y = y1; y <= y2; y++) {
    setBlack(0, y) // 左边
    setBlack(canvas.width - 1, y) // 右边（内容区）
  }
  ctx.putImageData(patch, 0, 0)
  const url = canvas.toDataURL('image/png')
  releaseCanvas(canvas)
  return url
}

/**
 * 生成 TexturePacker 哈希格式的单帧元数据条目。
 * `border` 字段与 TexturePacker 的 {left,top,right,bottom} 约定一致，
 * 可直接导入「精灵图」页或游戏引擎的图集加载器。
 */
export function buildNineSliceMeta(name: string, width: number, height: number, border: NineSliceBorder): Record<string, unknown> {
  return {
    frames: {
      [name]: {
        frame: { x: 0, y: 0, w: width, h: height },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: width, h: height },
        sourceSize: { w: width, h: height },
        border: { left: border.left, top: border.top, right: border.right, bottom: border.bottom },
      },
    },
    meta: {
      app: 'AtlasSlice',
      version: '1.0',
      image: name,
      size: { w: width, h: height },
      format: 'RGBA8888',
      scale: '1',
    },
  }
}
