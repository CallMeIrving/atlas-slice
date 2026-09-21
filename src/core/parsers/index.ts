import type { ParsedAtlas } from '@/types/atlas'
import { parseJsonAtlas } from './json'
import { parsePlistAtlas } from './plist'
import { parseXmlAtlas } from './xml'

export type AtlasFormat = 'json' | 'plist' | 'xml'

/** 根据文件内容自动识别格式并解析 */
export function parseAtlasFile(name: string, text: string): ParsedAtlas {
  const lower = name.toLowerCase()
  const trimmed = text.trimStart()

  if (lower.endsWith('.plist') || trimmed.startsWith('<plist')) {
    return parsePlistAtlas(text)
  }
  if (lower.endsWith('.xml') || trimmed.startsWith('<?xml') || trimmed.startsWith('<textureatlas')) {
    return parseXmlAtlas(text)
  }
  // 默认按 JSON 处理
  return parseJsonAtlas(text)
}

export function detectFormat(name: string, text: string): AtlasFormat {
  const lower = name.toLowerCase()
  const trimmed = text.trimStart()
  if (lower.endsWith('.plist') || trimmed.startsWith('<plist')) return 'plist'
  if (lower.endsWith('.xml') || trimmed.startsWith('<?xml') || trimmed.startsWith('<textureatlas')) return 'xml'
  return 'json'
}
