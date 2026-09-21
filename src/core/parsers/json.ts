import type { AtlasFrame, FrameRect, ParsedAtlas } from '@/types/atlas'

let seq = 0

function rect(x: number, y: number, w: number, h: number): FrameRect {
  return { x, y, w, h }
}

/** 解析 TexturePacker JSON（哈希表 与 数组 两种结构） */
export function parseJsonAtlas(text: string): ParsedAtlas {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('JSON 解析失败：不是合法的 JSON 文件')
  }
  if (!data || typeof data !== 'object') {
    throw new Error('JSON 结构无效：顶层应为对象')
  }

  const root = data as Record<string, unknown>
  const framesRaw = root.frames
  const metaRaw = (root.meta ?? {}) as Record<string, unknown>

  if (!framesRaw || typeof framesRaw !== 'object') {
    throw new Error('JSON 结构无效：缺少 frames 字段')
  }

  const frames: AtlasFrame[] = []

  if (Array.isArray(framesRaw)) {
    // 数组结构
    for (const item of framesRaw as Array<Record<string, unknown>>) {
      const fr = (item.frame ?? {}) as Record<string, number>
      const src = (item.sourceSize ?? {}) as Record<string, number>
      const sprite = (item.spriteSourceSize ?? {}) as Record<string, number>
      const rotated = Boolean(item.rotated)
      const restoredW = rotated ? (fr.h ?? 0) : (fr.w ?? 0)
      const restoredH = rotated ? (fr.w ?? 0) : (fr.h ?? 0)
      const srcW = src.w ?? restoredW
      const srcH = src.h ?? restoredH
      // JSON 中 frame 矩形即内容包围盒（trimmed），旋转还原后内容占满画布
      const contentInFrame = rect(0, 0, restoredW, restoredH)
      const contentInOriginal = rect(sprite.x ?? 0, sprite.y ?? 0, sprite.w ?? restoredW, sprite.h ?? restoredH)
      frames.push(
        makeFrame(
          String(item.filename ?? `frame_${seq}`),
          rect(fr.x ?? 0, fr.y ?? 0, fr.w ?? 0, fr.h ?? 0),
          rotated,
          Boolean(item.trimmed),
          { w: srcW, h: srcH },
          contentInFrame,
          contentInOriginal,
          Boolean(item.manual),
        ),
      )
    }
  } else {
    // 哈希表结构
    for (const [name, val] of Object.entries(framesRaw as Record<string, unknown>)) {
      const f = (val ?? {}) as Record<string, unknown>
      const fr = (f.frame ?? {}) as Record<string, number>
      const src = (f.sourceSize ?? {}) as Record<string, number>
      const sprite = (f.spriteSourceSize ?? {}) as Record<string, number>
      const rotated = Boolean(f.rotated)
      const restoredW = rotated ? (fr.h ?? 0) : (fr.w ?? 0)
      const restoredH = rotated ? (fr.w ?? 0) : (fr.h ?? 0)
      const srcW = src.w ?? restoredW
      const srcH = src.h ?? restoredH
      // JSON 中 frame 矩形即内容包围盒（trimmed），旋转还原后内容占满画布
      const contentInFrame = rect(0, 0, restoredW, restoredH)
      const contentInOriginal = rect(sprite.x ?? 0, sprite.y ?? 0, sprite.w ?? restoredW, sprite.h ?? restoredH)
      frames.push(
        makeFrame(
          name,
          rect(fr.x ?? 0, fr.y ?? 0, fr.w ?? 0, fr.h ?? 0),
          rotated,
          Boolean(f.trimmed),
          { w: srcW, h: srcH },
          contentInFrame,
          contentInOriginal,
          Boolean(f.manual),
        ),
      )
    }
  }

  const size = (metaRaw.size ?? {}) as Record<string, number>
  return {
    format: Array.isArray(framesRaw) ? 'json-array' : 'json-hash',
    frames,
    meta: {
      imagePath: typeof metaRaw.image === 'string' ? metaRaw.image : undefined,
      format: typeof metaRaw.format === 'string' ? metaRaw.format : undefined,
      size: size.w && size.h ? { w: size.w, h: size.h } : undefined,
    },
  }
}

export function makeFrame(
  name: string,
  frameRect: FrameRect,
  rotated: boolean,
  trimmed: boolean,
  sourceSize: { w: number; h: number },
  contentInFrame: FrameRect,
  contentInOriginal: FrameRect,
  manual = false,
): AtlasFrame {
  return {
    id: `f${seq++}`,
    name,
    rect: frameRect,
    rotated,
    trimmed,
    sourceSize,
    contentInFrame,
    contentInOriginal,
    manual,
  }
}
