import { XMLParser } from 'fast-xml-parser'
import type { AtlasFrame, FrameRect, ParsedAtlas } from '@/types/atlas'
import { makeFrame } from './json'

/** 解析 plist dict：{{x,y},{w,h}} / {x,y} */
function parsePlistRect(raw: string): FrameRect {
  const m = raw.match(/\{\{([-\d.]+),([-\d.]+)\},\{([-\d.]+),([-\d.]+)\}\}/)
  if (m) return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] }
  const m2 = raw.match(/\{([-\d.]+),([-\d.]+)\}/)
  if (m2) return { x: +m2[1], y: +m2[2], w: 0, h: 0 }
  return { x: 0, y: 0, w: 0, h: 0 }
}

function parsePlistSize(raw: string): { w: number; h: number } {
  const m = raw.match(/\{([-\d.]+),([-\d.]+)\}/)
  return m ? { w: +m[1], h: +m[2] } : { w: 0, h: 0 }
}

type PNode = Record<string, unknown> & { '#text'?: string }

/** preserveOrder 模式下提取标签文本：<key>frames</key> → { key: [{ '#text': 'frames' }] } */
function textOf(node: PNode, tag: string): string {
  const v = node[tag]
  if (Array.isArray(v)) {
    const first = v[0]
    if (first && typeof first === 'object' && '#text' in first) {
      return String((first as PNode)['#text'] ?? '')
    }
    return ''
  }
  return typeof v === 'string' ? v : ''
}

function hasTag(node: PNode, tag: string): boolean {
  return tag in node
}

/** 将 fast-xml-parser 的 preserveOrder 单节点解析为 JS 值 */
function plistValue(node: PNode | undefined): unknown {
  if (!node) return undefined
  if (hasTag(node, 'dict')) return parseDict(node.dict as unknown as PNode[])
  if (hasTag(node, 'array')) {
    const arr = node.array as unknown as Array<PNode | PNode[]>
    return arr.map((n) => plistValue(Array.isArray(n) ? n[0] : n))
  }
  if (hasTag(node, 'string')) return textOf(node, 'string')
  if (hasTag(node, 'integer')) return Number(textOf(node, 'integer'))
  if (hasTag(node, 'real')) return Number(textOf(node, 'real'))
  if (hasTag(node, 'true')) return true
  if (hasTag(node, 'false')) return false
  if (hasTag(node, 'data')) return textOf(node, 'data')
  if ('#text' in node) return node['#text']
  return undefined
}

function parseDict(nodes: PNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n && hasTag(n, 'key')) {
      const key = textOf(n, 'key')
      const valueNode = nodes[i + 1]
      out[key] = valueNode ? plistValue(valueNode) : undefined
      i++
    }
  }
  return out
}

/** 解析 plist 元数据（Cocos2d-x / SpriteKit 图集） */
export function parsePlistAtlas(text: string): ParsedAtlas {
  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    trimValues: true,
  })
  let doc: PNode[]
  try {
    doc = parser.parse(text) as unknown as PNode[]
  } catch {
    throw new Error('plist 解析失败：XML 不合法')
  }

  // 定位最外层 plist → dict
  let top: Record<string, unknown> | undefined
  for (const n of doc) {
    if ('plist' in n) {
      const plistNode = n.plist as unknown as PNode[]
      for (const c of plistNode) {
        if ('dict' in c) {
          top = parseDict(c.dict as unknown as PNode[])
          break
        }
      }
      if (top) break
    }
  }
  if (!top) throw new Error('plist 结构无效：未找到顶层 dict')

  const framesRaw = top.frames as Record<string, unknown> | undefined
  if (!framesRaw || typeof framesRaw !== 'object') {
    throw new Error('plist 结构无效：缺少 frames 字典')
  }

  const frames: AtlasFrame[] = []
  for (const [name, val] of Object.entries(framesRaw)) {
    const f = (val ?? {}) as Record<string, unknown>
    const frameStr = typeof f.frame === 'string' ? f.frame : ''
    const rect = parsePlistRect(frameStr)
    const sourceSize = typeof f.sourceSize === 'string' ? parsePlistSize(f.sourceSize) : { w: rect.w, h: rect.h }
    const colorRect = typeof f.sourceColorRect === 'string' ? parsePlistRect(f.sourceColorRect) : rect
    const offset = typeof f.offset === 'string' ? parsePlistSize(f.offset) : { w: 0, h: 0 }

    const trimmed = Boolean(f.trimmed)
    const rotated = Boolean(f.rotated)
    // 旋转还原后的打包帧尺寸
    const uprightW = rotated ? rect.h : rect.w
    const uprightH = rotated ? rect.w : rect.h

    // 内容在"还原后的打包帧"内的位置：中心对齐 + offset
    const contentW = trimmed ? colorRect.w : uprightW
    const contentH = trimmed ? colorRect.h : uprightH
    const contentInFrame: FrameRect = trimmed
      ? {
          x: Math.max(0, Math.round((uprightW - contentW) / 2 + (offset.w || 0))),
          y: Math.max(0, Math.round((uprightH - contentH) / 2 + (offset.h || 0))),
          w: Math.min(contentW, uprightW),
          h: Math.min(contentH, uprightH),
        }
      : { x: 0, y: 0, w: uprightW, h: uprightH }

    // 内容在"原始源帧"坐标中的位置（用于还原完整帧）
    const contentInOriginal: FrameRect = trimmed
      ? {
          x: Math.max(0, Math.round(colorRect.x - (offset.w || 0))),
          y: Math.max(0, Math.round(colorRect.y - (offset.h || 0))),
          w: colorRect.w,
          h: colorRect.h,
        }
      : { x: 0, y: 0, w: sourceSize.w || uprightW, h: sourceSize.h || uprightH }

    frames.push(
      makeFrame(name, rect, rotated, trimmed, sourceSize, contentInFrame, contentInOriginal, Boolean(f.manual)),
    )
  }

  const metaRaw = (top.metadata ?? {}) as Record<string, unknown>
  const metaSize = typeof metaRaw.size === 'string' ? parsePlistSize(metaRaw.size) : undefined

  return {
    format: 'plist',
    frames,
    meta: {
      imagePath: typeof metaRaw.imagePath === 'string' ? metaRaw.imagePath : undefined,
      size: metaSize,
    },
  }
}
