/**
 * 通用图像工具。
 *
 * 帧裁切、帧抠图与一键处理流水线都需要「加载图像 / Blob 与 dataURL 互转 / 结果尺寸对齐」，
 * 这些逻辑此前在多个组件里各写一份，统一收敛到这里，保证只维护一份实现。
 */

/** 加载图片元素（dataURL / blob URL / 普通 URL 通用） */
export function loadImage(url: string, errorMessage = '图像加载失败'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(errorMessage))
    image.src = url
  })
}

/** Blob → dataURL，用于把处理结果持久保存到帧数据里 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图像结果失败'))
    reader.readAsDataURL(blob)
  })
}

/** 取出图片的像素数据（保留原始分辨率） */
export function imageToImageData(image: HTMLImageElement): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/** ImageData → dataURL PNG */
export function imageDataToUrl(data: ImageData): string {
  const canvas = document.createElement('canvas')
  canvas.width = data.width
  canvas.height = data.height
  canvas.getContext('2d')!.putImageData(data, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * 把处理结果统一到目标尺寸。
 * AI 抠图在受限分辨率（不超过 1024）上推理，结果会小于原帧；若直接采用，
 * 各帧尺寸会不一致，导出序列帧/雪碧图就会错位，因此统一放大回原帧尺寸。
 */
export async function fitResultToSize(blob: Blob, width: number, height: number): Promise<string> {
  const url = await blobToDataUrl(blob)
  const image = await loadImage(url)
  if (image.naturalWidth === width && image.naturalHeight === height) return url
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}