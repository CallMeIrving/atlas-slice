import JSZip from 'jszip'

export interface ZipEntry { name: string; blob: Blob | string }

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 3000)
}

export async function downloadZip(entries: ZipEntry[], filename: string): Promise<void> {
  if (!entries.length) throw new Error('没有可导出的内容')
  const zip = new JSZip()
  entries.forEach((entry) => zip.file(entry.name, entry.blob))
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  download(blob, filename)
}

export function downloadBlob(blob: Blob, filename: string): void { download(blob, filename) }

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败')), 'image/png'))
}
