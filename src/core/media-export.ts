import JSZip from 'jszip'

export interface ZipEntry { name: string; blob: Blob | string }

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 3000)
}

/**
 * dataURL 字符串 → Blob。
 * JSZip 会把普通字符串按文本写入，若直接塞 dataURL，解包得到的是 base64 文本而不是图片；
 * 这里统一在打包前转换，JSON 等非 dataURL 字符串仍按文本保存。
 */
function toZipValue(value: Blob | string): Blob | string {
  if (typeof value !== 'string' || !value.startsWith('data:')) return value
  const comma = value.indexOf(',')
  const mime = /^data:(.*?);/.exec(value.slice(0, comma))?.[1] ?? 'application/octet-stream'
  const binary = atob(value.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export async function downloadZip(entries: ZipEntry[], filename: string): Promise<void> {
  if (!entries.length) throw new Error('没有可导出的内容')
  const zip = new JSZip()
  entries.forEach((entry) => zip.file(entry.name, toZipValue(entry.blob)))
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  download(blob, filename)
}

export function downloadBlob(blob: Blob, filename: string): void { download(blob, filename) }

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败')), 'image/png'))
}
