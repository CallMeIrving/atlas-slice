import { reactive, computed } from 'vue'
import type { AtlasFrame, FrameRect } from '@/types/atlas'
import { parseAtlasFile, type AtlasFormat } from '@/core/parsers'
import { detectSprites, MIN_FRAME_SIZE } from '@/core/trim'
import { naturalCompare } from '@/core/sort'
import { exportFrames, exportSpriteSheet, type ExportOptions, type ExportProgress, type SpriteSheetOptions } from '@/core/export'
import type { CropMode } from '@/core/crop'

export type ViewMode = 'view' | 'box'
export type ExportTarget = 'all' | 'selected' | 'spritesheet'

export interface Preset {
  name: string
  mode: CropMode
  padding: number
  pattern: string
  folder: string
}

interface PersistedExport {
  mode: CropMode
  padding: number
  pattern: string
  folder: string
  withMetaJson: boolean
  withMetaPlist: boolean
  exportTarget?: ExportTarget
}

const PRESETS_KEY = 'atlas-slice:presets'
const LAST_KEY = 'atlas-slice:last-export'

function loadJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

interface State {
  // 输入
  imageName: string
  source: HTMLCanvasElement | null
  frames: AtlasFrame[]
  metaFormat: AtlasFormat | null
  selectedId: string | null
  selectedIds: string[]
  // 导出设置
  mode: CropMode
  padding: number
  pattern: string
  folder: string
  /** 导出时附带元数据 JSON */
  withMetaJson: boolean
  /** 导出时附带元数据 plist */
  withMetaPlist: boolean
  exportTarget: ExportTarget
  presets: Preset[]
  // 画布交互
  viewMode: ViewMode
  zoom: number
  panX: number
  panY: number
  hover: { x: number; y: number } | null
  /** 框选中的候选矩形（画布坐标），拖拽中实时更新 */
  draftBox: FrameRect | null
  // 预览
  orderIds: string[] | null
  // 状态反馈
  error: string | null
  notice: string | null
  busy: boolean
  progress: ExportProgress | null
}

const last = loadJSON<PersistedExport>(LAST_KEY)

export const store = reactive<State>({
  imageName: '',
  source: null,
  frames: [],
  metaFormat: null,
  selectedId: null,
  selectedIds: [],
  mode: last?.mode ?? 'content',
  padding: last?.padding ?? 0,
  pattern: last?.pattern ?? '{name}',
  folder: last?.folder ?? '',
  withMetaJson: last?.withMetaJson ?? true,
  withMetaPlist: last?.withMetaPlist ?? false,
  exportTarget: last?.exportTarget ?? 'all',
  presets: loadJSON<Preset[]>(PRESETS_KEY) ?? [],
  viewMode: 'view',
  zoom: 1,
  panX: 0,
  panY: 0,
  hover: null,
  draftBox: null,
  orderIds: null,
  error: null,
  notice: null,
  busy: false,
  progress: null,
})

/** 帧的展示顺序：手动排序优先，否则按自然数字排序 */
export const orderedFrames = computed<AtlasFrame[]>(() => {
  if (store.orderIds && store.orderIds.length === store.frames.length) {
    const byId = new Map(store.frames.map((f) => [f.id, f]))
    const list = store.orderIds.map((id) => byId.get(id)).filter((f): f is AtlasFrame => Boolean(f))
    if (list.length === store.frames.length) return list
  }
  return [...store.frames].sort((a, b) => naturalCompare(a.name, b.name))
})

export const selectedFrame = computed(() =>
  store.frames.find((f) => f.id === store.selectedId) ?? null,
)

const cropCache = new Map<string, HTMLCanvasElement>()
let frameSeq = 0

export function getCropCanvas(frame: AtlasFrame): HTMLCanvasElement {
  const cached = cropCache.get(frame.id)
  if (cached) return cached
  const source = store.source
  if (!source) throw new Error('尚未导入图集图片')
  const canvas = document.createElement('canvas')
  const raw = document.createElement('canvas')
  raw.width = Math.max(1, Math.round(frame.rect.w))
  raw.height = Math.max(1, Math.round(frame.rect.h))
  const rctx = raw.getContext('2d')!
  rctx.imageSmoothingEnabled = false
  rctx.drawImage(source, frame.rect.x, frame.rect.y, frame.rect.w, frame.rect.h, 0, 0, raw.width, raw.height)
  canvas.width = raw.width
  canvas.height = raw.height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  if (frame.rotated) {
    canvas.width = raw.height
    canvas.height = raw.width
    ctx.translate(0, canvas.height)
    ctx.rotate(-Math.PI / 2)
    ctx.drawImage(raw, 0, 0)
  } else {
    ctx.drawImage(raw, 0, 0)
  }
  cropCache.set(frame.id, canvas)
  return canvas
}

function clearCropCache(): void {
  cropCache.clear()
}

function setNotice(msg: string | null): void {
  store.notice = msg
  if (msg) setTimeout(() => store.notice === msg && (store.notice = null), 3000)
}

/** 载入图集图片；无元数据时自动识别透明边缘生成帧 */
export async function loadImage(file: File): Promise<void> {
  if (file.size > 10 * 1024 * 1024) {
    store.error = '图片超过 10MB 限制，无法载入'
    return
  }
  store.busy = true
  store.error = null
  try {
    const img = await loadImageElement(file)
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 0, 0)
    store.imageName = file.name
    const hadSource = Boolean(store.source)
    store.source = canvas
    if (!hadSource && store.frames.length > 0) {
      // 先导入元数据、后导入图片：保留刚解析出的帧
      clearCropCache()
      setNotice(`已载入图片，应用 ${store.frames.length} 帧元数据`)
    } else {
      // 首次载入或更换图片：清空旧帧数据后重新识别
      clearFrames()
      autoDetectFrames()
    }
    store.selectedIds = []
    fitView()
  } catch (e) {
    store.error = e instanceof Error ? e.message : '图片解析失败'
  } finally {
    store.busy = false
  }
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法解码该图片，请确认是 PNG / WebP / JPEG'))
    }
    img.src = url
  })
}

/** 载入并解析元数据（JSON / plist / XML 自动识别） */
export async function loadMetaFile(file: File): Promise<void> {
  if (file.size > 10 * 1024 * 1024) {
    store.error = '元数据超过 10MB 限制，无法解析'
    return
  }
  store.busy = true
  store.error = null
  try {
    const text = await file.text()
    const parsed = parseAtlasFile(file.name, text)
    if (parsed.frames.length === 0) throw new Error('元数据中没有解析出任何帧')
    const fmt: AtlasFormat =
      parsed.format === 'json-hash' || parsed.format === 'json-array' ? 'json' : parsed.format
    // 若图片尚未载入，只记录元数据，等待图片载入后生效
    if (store.source) {
      store.frames = parsed.frames
      store.metaFormat = fmt
      store.selectedId = parsed.frames[0]?.id ?? null
      store.selectedIds = []
      clearCropCache()
      setNotice(`已解析 ${parsed.frames.length} 帧（${fmt}）`)
    } else {
      store.metaFormat = fmt
      store.frames = parsed.frames
      store.selectedId = parsed.frames[0]?.id ?? null
      store.selectedIds = []
    }
  } catch (e) {
    store.error = e instanceof Error ? e.message : '元数据解析失败'
  } finally {
    store.busy = false
  }
}

/** 清空全部帧（保留已导入的图片，可重新识别或手动框选） */
export function clearFrames(): void {
  store.frames = []
  store.selectedId = null
  store.selectedIds = []
  store.orderIds = null
  store.draftBox = null
  store.metaFormat = null
  clearCropCache()
}

/** 自动识别透明边缘：整图不透明包围盒 或 连通域拆分（忽略小于最小边长的碎片） */
export function autoDetectFrames(): void {
  const source = store.source
  if (!source) return
  const ctx = source.getContext('2d')!
  const imageData = ctx.getImageData(0, 0, source.width, source.height)
  const all = detectSprites(imageData)
  const boxes = all.filter((b) => b.w >= MIN_FRAME_SIZE && b.h >= MIN_FRAME_SIZE)
  const skipped = all.length - boxes.length
  if (boxes.length === 0) {
    store.error =
      all.length === 0
        ? '未在图片中识别到不透明内容'
        : `识别到的内容块都小于 ${MIN_FRAME_SIZE}×${MIN_FRAME_SIZE} 像素，已全部忽略`
    return
  }
  const frames: AtlasFrame[] = boxes.map((b) => makeManualFrame(b, `frame_${frameSeq++}.png`))
  store.frames = frames
  store.metaFormat = null
  store.selectedId = frames[0]?.id ?? null
  store.selectedIds = []
  store.orderIds = null
  clearCropCache()
  setNotice(
    skipped > 0
      ? `自动识别出 ${frames.length} 个内容块（已忽略 ${skipped} 个小于 ${MIN_FRAME_SIZE}px 的碎片）`
      : `自动识别出 ${frames.length} 个内容块`,
  )
}

export function makeManualFrame(rect: FrameRect, name?: string): AtlasFrame {
  const w = Math.max(1, Math.round(rect.w))
  const h = Math.max(1, Math.round(rect.h))
  return {
    id: `m${frameSeq++}`,
    name: name ?? `frame_${frameSeq}.png`,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w, h },
    rotated: false,
    trimmed: true,
    sourceSize: { w, h },
    contentInFrame: { x: 0, y: 0, w, h },
    contentInOriginal: { x: 0, y: 0, w, h },
    manual: true,
  }
}

/** 手动框选确认：加入帧列表并选中 */
export function addManualFrame(rect: FrameRect): void {
  const source = store.source
  if (!source) return
  const x = Math.max(0, Math.min(source.width, Math.round(rect.x)))
  const y = Math.max(0, Math.min(source.height, Math.round(rect.y)))
  const x2 = Math.max(0, Math.min(source.width, Math.round(rect.x + rect.w)))
  const y2 = Math.max(0, Math.min(source.height, Math.round(rect.y + rect.h)))
  if (x2 - x < MIN_FRAME_SIZE || y2 - y < MIN_FRAME_SIZE) {
    setNotice(`框选尺寸需不小于 ${MIN_FRAME_SIZE}×${MIN_FRAME_SIZE} 像素`)
    return
  }
  const frame = makeManualFrame({ x, y, w: x2 - x, h: y2 - y })
  store.frames = [...store.frames, frame]
  store.selectedId = frame.id
  store.selectedIds = []
  store.orderIds = null
  clearCropCache()
}

export function deleteFrame(id: string): void {
  store.frames = store.frames.filter((f) => f.id !== id)
  if (store.selectedId === id) store.selectedId = store.frames[0]?.id ?? null
  store.selectedIds = store.selectedIds.filter((selectedId) => selectedId !== id)
  store.orderIds = store.orderIds?.filter((oid) => oid !== id) ?? null
  clearCropCache()
}

export function toggleFrameSelection(id: string): void {
  store.selectedIds = store.selectedIds.includes(id)
    ? store.selectedIds.filter((selectedId) => selectedId !== id)
    : [...store.selectedIds, id]
}

export function selectAllFrames(): void {
  store.selectedIds = store.frames.map((frame) => frame.id)
}

export function clearFrameSelection(): void {
  store.selectedIds = []
}

/** 将选中帧调整为统一的输出尺寸，保持每帧中心位置并限制在图集范围内。 */
export function normalizeSelectedFrames(targetW: number, targetH: number): boolean {
  const source = store.source
  const ids = new Set(store.selectedIds)
  if (!source || ids.size === 0) return false

  const w = Math.round(targetW)
  const h = Math.round(targetH)
  if (w < MIN_FRAME_SIZE || h < MIN_FRAME_SIZE) return false

  const selected = store.frames.filter((frame) => ids.has(frame.id))
  const canFit = selected.every((frame) => {
    const rawW = frame.rotated ? h : w
    const rawH = frame.rotated ? w : h
    return rawW <= source.width && rawH <= source.height
  })
  if (!canFit) return false

  store.frames = store.frames.map((frame) => {
    if (!ids.has(frame.id)) return frame
    const rawW = frame.rotated ? h : w
    const rawH = frame.rotated ? w : h
    const centerX = frame.rect.x + frame.rect.w / 2
    const centerY = frame.rect.y + frame.rect.h / 2
    const x = Math.max(0, Math.min(source.width - rawW, Math.round(centerX - rawW / 2)))
    const y = Math.max(0, Math.min(source.height - rawH, Math.round(centerY - rawH / 2)))
    return {
      ...frame,
      rect: { x, y, w: rawW, h: rawH },
      sourceSize: { w, h },
      contentInFrame: { x: 0, y: 0, w, h },
      contentInOriginal: { x: 0, y: 0, w, h },
    }
  })
  clearCropCache()
  setNotice(`已将 ${ids.size} 帧统一为 ${w}×${h}`)
  return true
}

/** 微调选中帧矩形（键盘像素级调整），shift 为 10px 步进 */
export function nudgeSelectedFrame(dx: number, dy: number): void {
  const f = selectedFrame.value
  const source = store.source
  if (!f || !source) return
  const nf: AtlasFrame = {
    ...f,
    rect: { x: f.rect.x + dx, y: f.rect.y + dy, w: f.rect.w, h: f.rect.h },
    contentInFrame: { ...f.contentInFrame },
    contentInOriginal: { ...f.contentInOriginal },
  }
  store.frames = store.frames.map((it) => (it.id === f.id ? nf : it))
  clearCropCache()
}

/** 当前选中帧的矩形（调整后的实际矩形） */
export function setFrameRect(id: string, rect: FrameRect): void {
  store.frames = store.frames.map((f) => {
    if (f.id !== id) return f
    const w = Math.max(MIN_FRAME_SIZE, Math.round(rect.w))
    const h = Math.max(MIN_FRAME_SIZE, Math.round(rect.h))
    return {
      ...f,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w, h },
      sourceSize: { w, h },
      contentInFrame: { x: 0, y: 0, w, h },
      contentInOriginal: { x: 0, y: 0, w, h },
    }
  })
  clearCropCache()
}

export function selectFrame(id: string): void {
  store.selectedId = id
}

export function setViewMode(mode: ViewMode): void {
  store.viewMode = mode
  if (mode === 'view') store.draftBox = null
}

/** 按画布内容适配视口 */
export function fitView(): void {
  const source = store.source
  if (!source) return
  store.zoom = 1
  store.panX = 0
  store.panY = 0
}

export function setZoom(zoom: number): void {
  store.zoom = Math.min(16, Math.max(0.02, zoom))
}

// ---------- 导出与预设 ----------

export function persistExportSettings(): void {
  try {
    localStorage.setItem(
      LAST_KEY,
      JSON.stringify({
        mode: store.mode,
        padding: store.padding,
        pattern: store.pattern,
        folder: store.folder,
        withMetaJson: store.withMetaJson,
        withMetaPlist: store.withMetaPlist,
        exportTarget: store.exportTarget,
      } satisfies PersistedExport),
    )
  } catch {
    /* localStorage 不可用时静默 */
  }
}

export async function runExport(spriteOptions?: SpriteSheetOptions): Promise<void> {
  const source = store.source
  const frames =
    store.exportTarget === 'selected' || (store.exportTarget === 'spritesheet' && spriteOptions?.scope === 'selected')
      ? orderedFrames.value.filter((frame) => store.selectedIds.includes(frame.id))
      : orderedFrames.value
  if (!source || frames.length === 0) {
    store.error = '请先导入图集图片并载入帧'
    return
  }
  store.busy = true
  store.progress = { done: 0, total: frames.length }
  store.error = null
  persistExportSettings()
  try {
    if (store.exportTarget === 'spritesheet') {
      if (!spriteOptions) throw new Error('请先设置雪碧图布局')
      await exportSpriteSheet(source, frames, spriteOptions)
      setNotice(`已导出雪碧图（${frames.length} 帧）`)
      return
    }
    const opts: ExportOptions = {
      mode: store.mode,
      padding: store.padding,
      pattern: store.pattern,
      folder: store.folder,
      withMetaJson: store.withMetaJson,
      withMetaPlist: store.withMetaPlist,
    }
    await exportFrames(source, frames, opts, (p) => (store.progress = p))
    const zipped = frames.length > 1 || store.withMetaJson || store.withMetaPlist
    setNotice(zipped ? `已导出 ${frames.length} 帧 ZIP` : '已导出 PNG')
  } catch (e) {
    store.error = e instanceof Error ? e.message : '导出失败'
  } finally {
    store.busy = false
    store.progress = null
  }
}

function persistPresets(): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(store.presets))
  } catch {
    /* 忽略 */
  }
}

export function savePreset(name: string): void {
  const preset: Preset = {
    name,
    mode: store.mode,
    padding: store.padding,
    pattern: store.pattern,
    folder: store.folder,
  }
  const idx = store.presets.findIndex((p) => p.name === name)
  if (idx >= 0) store.presets[idx] = preset
  else store.presets = [...store.presets, preset]
  persistPresets()
  setNotice(`预设「${name}」已保存`)
}

export function loadPreset(name: string): void {
  const preset = store.presets.find((p) => p.name === name)
  if (!preset) return
  store.mode = preset.mode
  store.padding = preset.padding
  store.pattern = preset.pattern
  store.folder = preset.folder
  setNotice(`已载入预设「${name}」`)
}

export function deletePreset(name: string): void {
  store.presets = store.presets.filter((p) => p.name !== name)
  persistPresets()
}

// ---------- 预览排序 ----------

export function enableManualOrder(): void {
  store.orderIds = orderedFrames.value.map((f) => f.id)
}

export function setOrder(ids: string[]): void {
  store.orderIds = ids
}

export function resetOrder(): void {
  store.orderIds = null
}

// ---------- 状态 ----------

export function dismissError(): void {
  store.error = null
}
