/**
 * 帧间补间：相邻动画帧的像素混合生成中间过渡帧。
 * 与洋葱皮同属 4.7.5 的动画预览增强；补间产物作为新帧素材导出。
 *
 * blendFrames 为纯函数（预乘 alpha 逐像素线性混合，等价于画布 globalAlpha 叠绘），
 * 可用 node 直接验证；generateTweens 负责浏览器侧的加载/栅格化/编码编排。
 */
import { loadImage, imageDataToUrl, releaseCanvas } from '@/core/image'

export interface ImageDataLike {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** 逐像素预乘混合：t=0 完全取 a，t=1 完全取 b；尺寸不同时按左上角对齐、缺省区域视为透明 */
export function blendFrames(a: ImageDataLike, b: ImageDataLike, t: number): ImageDataLike {
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inA = (x < a.width && y < a.height) ? (y * a.width + x) * 4 : -1
      const inB = (x < b.width && y < b.height) ? (y * b.width + x) * 4 : -1
      const oi = (y * width + x) * 4
      const alphaA = inA >= 0 ? a.data[inA + 3] / 255 : 0
      const alphaB = inB >= 0 ? b.data[inB + 3] / 255 : 0
      const outAlpha = alphaA * (1 - t) + alphaB * t
      out[oi + 3] = Math.round(outAlpha * 255)
      if (outAlpha > 0) {
        for (let c = 0; c < 3; c++) {
          const pa = inA >= 0 ? a.data[inA + c] * alphaA : 0
          const pb = inB >= 0 ? b.data[inB + c] * alphaB : 0
          out[oi + c] = Math.round((pa * (1 - t) + pb * t) / outAlpha)
        }
      }
    }
  }
  return { width, height, data: out }
}

export interface TweenSource {
  name: string
  url: string
}

export interface TweenResult {
  name: string
  url: string
  /** 所属相邻帧对的下标（frames[pairIndex] 与 frames[pairIndex+1] 之间），用于插回合并序列 */
  pairIndex: number
  /** 帧对内的步进（1..count），合并时按此排序 */
  step: number
}

/** 去掉扩展名并截断过长的文件名，避免导出名冗长 */
function baseName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim() || 'frame'
  return base.length > 24 ? base.slice(0, 24) : base
}

/** 把图像栅格化到统一画布并取回像素（用于对齐不同尺寸的源帧） */
function rasterize(img: HTMLImageElement, width: number, height: number): ImageDataLike {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, width, height)
  releaseCanvas(canvas)
  return data
}

function toImageData(like: ImageDataLike): ImageData {
  return new ImageData(like.data, like.width, like.height)
}

/** 补间权重曲线：linear 匀速；ease 两端慢中间快（smoothstep），缓动可减轻大位移的鬼影感 */
export function tweenCurve(easing: 'linear' | 'ease', t: number): number {
  return easing === 'ease' ? t * t * (3 - 2 * t) : t
}

export interface TweenOptions {
  /** 权重曲线，默认 linear */
  easing?: 'linear' | 'ease'
  /** 是否为「末帧→首帧」也生成中间帧（循环动画补全最后一跳） */
  loop?: boolean
}

/**
 * 对相邻帧对生成中间过渡帧。
 * count 为每对之间生成的中间帧数；loop 时额外补上末帧→首帧一对（pairIndex = 帧数-1）。
 */
export async function generateTweens(frames: TweenSource[], count: number, options: TweenOptions = {}): Promise<TweenResult[]> {
  if (frames.length < 2) throw new Error('至少需要 2 帧才能生成补间')
  const easing = options.easing ?? 'linear'
  const loop = options.loop ?? false
  const imgs = await Promise.all(frames.map((frame) => loadImage(frame.url)))
  const width = Math.max(...imgs.map((img) => img.naturalWidth))
  const height = Math.max(...imgs.map((img) => img.naturalHeight))
  const results: TweenResult[] = []
  const pairCount = loop ? imgs.length : imgs.length - 1
  for (let i = 0; i < pairCount; i++) {
    const next = (i + 1) % imgs.length
    const a = rasterize(imgs[i], width, height)
    const b = rasterize(imgs[next], width, height)
    const from = baseName(frames[i].name)
    const to = baseName(frames[next].name)
    for (let step = 1; step <= count; step++) {
      const t = tweenCurve(easing, step / (count + 1))
      const blended = blendFrames(a, b, t)
      const url = imageDataToUrl(toImageData(blended))
      results.push({ name: `${from}-${to}_t${step}.png`, url, pairIndex: i, step })
    }
  }
  return results
}

/** 导出前对同名文件追加序号（baseName 截断后相邻帧对可能撞名，ZIP 内会互相覆盖） */
export function dedupeNames(entries: { name: string }[]): string[] {
  const seen = new Map<string, number>()
  return entries.map((entry) => {
    const count = seen.get(entry.name) ?? 0
    seen.set(entry.name, count + 1)
    if (!count) return entry.name
    return entry.name.replace(/\.png$/, `_${count + 1}.png`)
  })
}
