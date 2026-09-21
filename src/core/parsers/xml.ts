import { XMLParser } from 'fast-xml-parser'
import type { AtlasFrame, FrameRect, ParsedAtlas } from '@/types/atlas'
import { makeFrame } from './json'

interface SpriteAttrs {
  n?: string
  name?: string
  x?: string
  y?: string
  w?: string
  width?: string
  h?: string
  height?: string
  oX?: string
  oY?: string
  oW?: string
  oH?: string
  r?: string
  rotated?: string
}

function num(v: string | undefined, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function numAny(v: unknown, fallback = 0): number {
  return typeof v === 'string' ? num(v, fallback) : fallback
}

/** 解析 TexturePacker XML（<sprite> / <subTexture> 两种节点） */
export function parseXmlAtlas(text: string): ParsedAtlas {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    trimValues: true,
  })
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('XML 解析失败：文件不合法')
  }

  const atlasNode = doc.TextureAtlas as Record<string, unknown> | undefined
  if (!atlasNode || typeof atlasNode !== 'object') {
    throw new Error('XML 结构无效：未找到 <TextureAtlas> 根节点')
  }

  const spriteNodes = (atlasNode.sprite ??
    atlasNode.subTexture ??
    atlasNode.frame ??
    []) as Array<Record<string, unknown> | string>

  const frames: AtlasFrame[] = []
  for (const raw of Array.isArray(spriteNodes) ? spriteNodes : [spriteNodes]) {
    if (typeof raw === 'string') continue
    const a = raw as SpriteAttrs
    const name = a.n ?? a.name ?? ''
    if (!name) continue

    const rect: FrameRect = {
      x: num(a.x),
      y: num(a.y),
      w: num(a.w, num(a.width)),
      h: num(a.h, num(a.height)),
    }
    const rotated = a.r === 'y' || a.r === 'true' || a.rotated === 'true'

    // oX/oY/oW/oH：原始帧的裁剪偏移与原始帧尺寸
    const oW = num(a.oW, rect.w)
    const oH = num(a.oH, rect.h)
    const oX = num(a.oX, 0)
    const oY = num(a.oY, 0)
    const hasTrim = a.oW !== undefined || a.oH !== undefined
    // 旋转还原后的内容尺寸（TexturePacker XML 中 w/h 为打包方向，旋转时互换）
    const restoredW = rotated ? rect.h : rect.w
    const restoredH = rotated ? rect.w : rect.h

    frames.push(
      makeFrame(
        name,
        rect,
        rotated,
        hasTrim,
        { w: oW, h: oH },
        { x: 0, y: 0, w: restoredW, h: restoredH },
        { x: Math.max(0, oX), y: Math.max(0, oY), w: restoredW, h: restoredH },
      ),
    )
  }

  return {
    format: 'xml',
    frames,
    meta: {
      imagePath: typeof atlasNode.imagePath === 'string' ? atlasNode.imagePath : undefined,
      size:
        numAny(atlasNode.width) && numAny(atlasNode.height)
          ? { w: numAny(atlasNode.width), h: numAny(atlasNode.height) }
          : undefined,
    },
  }
}
