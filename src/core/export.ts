import JSZip from 'jszip'
import type { AtlasFrame } from '@/types/atlas'
import { cropFrame, type CropMode } from './crop'

export interface ExportOptions {
  mode: CropMode
  padding: number
  /** 命名模板：{name} 帧名（去扩展名）、{index} 零填充序号、{seq} 序号 */
  pattern: string
  /** 输出目录（zip 内层级），空则不建目录 */
  folder: string
  /** 是否同时导出元数据 JSON */
  withMetaJson: boolean
  /** 是否同时导出元数据 plist */
  withMetaPlist: boolean
}

/** 应用命名模板 */
export function applyNaming(pattern: string, name: string, index: number): string {
  const base = name.replace(/\.[^.]+$/, '')
  return pattern
    .replace(/\{name\}/g, base)
    .replace(/\{index\}/g, String(index).padStart(4, '0'))
    .replace(/\{seq\}/g, String(index))
}

function ensurePng(name: string): string {
  return /\.png$/i.test(name) ? name : `${name}.png`
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export interface ExportProgress {
  done: number
  total: number
}

/**
 * 已导出帧的元数据描述。
 * 几何字段一律以「原始图集坐标」记录（而非裁切后 PNG 的坐标），
 * 这样重新导入元数据时能还原出与导出前一致的帧。
 */
interface FrameMeta {
  /** 帧在图集中的打包矩形（raw，未处理旋转） */
  frame: { x: number; y: number; w: number; h: number }
  rotated: boolean
  trimmed: boolean
  /** 内容矩形，相对原始源帧坐标 */
  spriteSourceSize: { x: number; y: number; w: number; h: number }
  /** 原始帧尺寸（未旋转） */
  sourceSize: { w: number; h: number }
  /** 工具私有字段：是否为手动框选创建的帧 */
  manual: boolean
}

/** plist 矩形字符串 {{x,y},{w,h}} */
function plistRect(r: { x: number; y: number; w: number; h: number }): string {
  return `{{${r.x},${r.y}},{${r.w},${r.h}}}`
}

/** 生成 cocos2d 格式 3 的 plist 元数据 */
function buildPlist(meta: Record<string, FrameMeta>, atlas: { w: number; h: number }): string {
  const entries = Object.entries(meta)
    .map(([name, m]) => {
      return `    <key>${name}</key>
    <dict>
      <key>frame</key><string>${plistRect(m.frame)}</string>
      <key>offset</key><string>{0,0}</string>
      <key>rotated</key>${m.rotated ? '<true/>' : '<false/>'}
      <key>trimmed</key>${m.trimmed ? '<true/>' : '<false/>'}
      <key>sourceColorRect</key><string>${plistRect(m.spriteSourceSize)}</string>
      <key>sourceSize</key><string>{${m.sourceSize.w},${m.sourceSize.h}}</string>
      <key>manual</key>${m.manual ? '<true/>' : '<false/>'}
    </dict>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>frames</key>
  <dict>
${entries}
  </dict>
  <key>metadata</key>
  <dict>
    <key>format</key><integer>3</integer>
    <key>size</key><string>{${atlas.w},${atlas.h}}</string>
    <key>textureFileName</key><string>atlas.png</string>
  </dict>
</dict>
</plist>
`
}

/** 批量裁切导出：单帧且不需要元数据时直接下载 PNG，其余情况打包 ZIP（可选附元数据 JSON / plist） */
export async function exportFrames(
  source: HTMLCanvasElement,
  frames: AtlasFrame[],
  opts: ExportOptions,
  onProgress?: (p: ExportProgress) => void,
): Promise<void> {
  const zip = new JSZip()
  const folder = opts.folder.replace(/^\/+|\/+$/g, '')
  const path = folder ? `${folder}/` : ''
  const meta: Record<string, FrameMeta> = {}
  const total = frames.length

  const blobs: { name: string; blob: Blob }[] = []
  for (let i = 0; i < total; i++) {
    const frame = frames[i]
    const canvas = cropFrame(source, frame, { mode: opts.mode, padding: opts.padding })
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!blob) continue
    const name = ensurePng(applyNaming(opts.pattern, frame.name, i))
    blobs.push({ name, blob })
    meta[name] = {
      frame: { x: frame.rect.x, y: frame.rect.y, w: frame.rect.w, h: frame.rect.h },
      rotated: frame.rotated,
      trimmed: frame.trimmed,
      spriteSourceSize: {
        x: frame.contentInOriginal.x,
        y: frame.contentInOriginal.y,
        w: frame.contentInOriginal.w,
        h: frame.contentInOriginal.h,
      },
      sourceSize: { w: frame.sourceSize.w, h: frame.sourceSize.h },
      manual: frame.manual,
    }
    onProgress?.({ done: i + 1, total })
    // 每 20 帧让出主线程，更新进度 UI
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0))
  }

  if (blobs.length === 0) {
    throw new Error('没有可导出的帧')
  }

  // 单帧且未勾选任何元数据时才直接下载 PNG；否则统一打包 ZIP，避免元数据无处安放
  if (blobs.length === 1 && !opts.withMetaJson && !opts.withMetaPlist) {
    downloadBlob(blobs[0].blob, blobs[0].name)
    return
  }

  for (const { name, blob } of blobs) zip.file(path + name, blob)
  const atlasSize = { w: source.width, h: source.height }
  if (opts.withMetaJson) {
    zip.file(
      `${path}atlas.json`,
      JSON.stringify(
        {
          frames: meta,
          meta: { app: 'atlas-slice', format: 'RGBA8888', size: atlasSize },
        },
        null,
        2,
      ),
    )
  }
  if (opts.withMetaPlist) {
    zip.file(`${path}atlas.plist`, buildPlist(meta, atlasSize))
  }
  const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  downloadBlob(content, `${folder || 'atlas'}-export.zip`)
}
