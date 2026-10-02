<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  CHARSET_PRESETS,
  MAX_FONT_FILE_SIZE,
  buildBmfontText,
  buildBmfontXml,
  buildCharset,
  buildFont,
  buildFontJson,
  extractCharsFromText,
  inspectCoverage,
  isDistanceFieldMode,
  isFontAvailable,
  pageFileName,
  quoteFamily,
  registerFontFace,
  renderFontPageImageData,
  renderFontPages,
  unregisterFontFace,
  type CoverageReport,
  type FontBuildResult,
  type FontGlyph,
  type FontKerningPair,
  type FontSceneTemplate,
} from '@/core/font'
import { releaseCanvas } from '@/core/image'
import { downloadBlob, downloadZip, type ZipEntry } from '@/core/media-export'
import { resetFont, workspace } from '@/store/workspace'

/**
 * 位图字体生成页。
 * 左栏选字体来源与字符集（含 CJK 预设 / 文本扫描 / 覆盖率探测），中间看图集与预览，右栏调参数并导出；
 * 参数变化后自动重新生成（防抖），生成过程用遮罩显示进度。
 */

const state = computed(() => workspace.font)
const input = ref<HTMLInputElement>()
const scanInput = ref<HTMLInputElement>()
const previewCanvas = ref<HTMLCanvasElement>()
const sceneCanvas = ref<HTMLCanvasElement>()
/** 生成结果含像素缓冲，只留在组件内；store 里只存页数 / 字符数 / 预览图 */
const built = shallowRef<FontBuildResult | null>(null)
const generating = ref(false)
const exporting = ref(false)
const progress = ref({ done: 0, total: 0 })
/** 三档反馈：错误（红）/ 警告（黄，生成成功但有字形被截断或跳过）/ 完成提示（灰） */
const errorText = ref('')
const warnText = ref('')
const infoText = ref('')
const systemAvailable = ref<boolean | null>(null)
/** 图集预览缩放：fit 表示按容器宽度自适应，其余为固定倍率 */
const atlasZoom = ref<'fit' | 1 | 2 | 4>('fit')
/** 缩放档位；图集多是几十像素的小图，固定倍率便于逐字形核对 */
const ATLAS_ZOOMS: { value: 'fit' | 1 | 2 | 4; label: string }[] = [
  { value: 'fit', label: '适应' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
]

/** 场景预览模板选项 */
const SCENES: { value: FontSceneTemplate; label: string }[] = [
  { value: 'none', label: '不预览' },
  { value: 'hp', label: '血量条' },
  { value: 'coins', label: '金币计数' },
  { value: 'level', label: '等级徽标' },
  { value: 'damage', label: '伤害数字' },
  { value: 'dialog', label: '对话框' },
  { value: 'button', label: '按钮文字' },
]

/** 当前生效的字体家族名：上传模式用注册名，系统字体模式用用户输入的字体名 */
const activeFamily = computed(() => (
  state.value.source === 'upload' ? state.value.family : state.value.systemFamily.trim()
))
const ready = computed(() => Boolean(activeFamily.value))
const fileName = computed(() => state.value.fileName)

/** 顶栏摘要里的字形表示文案 */
const MODE_LABELS: Record<string, string> = {
  bitmap: '位图',
  sdf: 'SDF 距离场',
  msdf: 'MSDF',
  mtsdf: 'MTSDF',
}
const modeLabel = computed(() => MODE_LABELS[state.value.mode] ?? '位图')

/** 导出文件名只允许常规字符，避免 ZIP 里出现非法路径 */
const exportName = computed(() => {
  const name = state.value.name.trim()
  return /^[\w.-]+$/.test(name) ? name : 'font'
})

/* ---------------- 字符集与覆盖率 ---------------- */

/** 字符集字符数预览：直接复用生成用的合成逻辑，保证计数与结果一致 */
const charsetChars = computed(() => {
  try {
    return Array.from(buildCharset(state.value.charset))
  } catch {
    return []
  }
})
const charCount = computed(() => charsetChars.value.length)

/** 手动排除的字符码点 */
const manualExcludeCodes = computed(() => Array.from(state.value.excluded)
  .map((char) => char.codePointAt(0)!)
  .filter((code) => code >= 32))

/** 覆盖率探测结果与它对应的输入指纹（字体 / 字符集 / 字号任一变化即视为过期） */
const coverage = shallowRef<CoverageReport | null>(null)
const coverageKey = ref('')
const coverageInputKey = computed(() => `${activeFamily.value}|${state.value.sizePx}|${JSON.stringify(state.value.charset)}|${state.value.excluded}`)
const coverageFresh = computed(() => Boolean(coverage.value) && coverageKey.value === coverageInputKey.value)
/** 自动排除缺失字符仅在探测结果仍有效时生效，避免用过期的缺失清单砍掉正常字形 */
const excludeCodes = computed(() => {
  const codes = new Set(manualExcludeCodes.value)
  if (state.value.excludeMissing && coverageFresh.value) {
    for (const char of coverage.value!.missing) codes.add(char.codePointAt(0)!)
  }
  return Array.from(codes)
})

/** 覆盖率探测：逐字对比目标字体与兜底字体的度量，标出实际缺失的字符 */
function runCoverage(): void {
  const family = activeFamily.value
  if (!family || !charsetChars.value.length) return
  errorText.value = ''
  try {
    coverage.value = inspectCoverage(family, charsetChars.value.join(''), state.value.sizePx)
    coverageKey.value = coverageInputKey.value
  } catch (error) {
    coverage.value = null
    errorText.value = error instanceof Error ? error.message : '覆盖率探测失败'
  }
}

/** Unicode 范围输入框当前已填的分段 */
const rangeTokens = computed(() => {
  const raw = state.value.charset.ranges.trim()
  return raw ? raw.split(/[,\n]/).map((part) => part.trim()).filter(Boolean) : []
})

/** 该预设的范围是否已全部出现在输入框里（用于显示选中态与「再次点击取消」） */
function isPresetActive(ranges: string): boolean {
  const tokens = ranges.split(',').map((part) => part.trim()).filter(Boolean)
  return tokens.length > 0 && tokens.every((token) => rangeTokens.value.includes(token))
}

/** CJK 预设：点击把范围追加到 Unicode 输入框，已应用的预设再次点击即取消（移除它的范围） */
function applyPreset(ranges: string): void {
  const tokens = ranges.split(',').map((part) => part.trim()).filter(Boolean)
  const parts = [...rangeTokens.value]
  if (tokens.every((token) => parts.includes(token))) {
    for (const token of tokens) {
      const index = parts.indexOf(token)
      if (index >= 0) parts.splice(index, 1)
    }
  } else {
    for (const token of tokens) {
      if (!parts.includes(token)) parts.push(token)
    }
  }
  state.value.charset.ranges = parts.join(', ')
}

/** 文本扫描：从 TXT / JSON / CSV 原文里取出实际用到的字符，合并进自定义字符 */
async function scanTextFile(file?: File): Promise<void> {
  if (!file) return
  try {
    const text = await file.text()
    const found = Array.from(extractCharsFromText(text))
    const merged = Array.from(new Set([...Array.from(state.value.charset.custom), ...found])).sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)
    state.value.charset.custom = merged.join('')
    infoText.value = `已从 ${file.name} 提取 ${found.length} 个字符，合并后自定义字符共 ${merged.length} 个`
  } catch {
    errorText.value = '文本读取失败，请确认文件为 TXT / JSON / CSV'
  } finally {
    if (scanInput.value) scanInput.value.value = ''
  }
}

/**
 * 图集占位文案：没有图集时要区分「正在生成」「字符集为空」「生成失败」，
 * 否则空字符集或报错后会一直显示「图集生成中…」，让人以为还在跑。
 */
const atlasPlaceholder = computed(() => {
  if (generating.value) return '图集生成中…'
  if (!charCount.value) return '字符集为空：请先在左栏勾选字符或填写 Unicode 范围'
  if (errorText.value) return '生成失败，请查看右栏提示后调整参数'
  return '等待生成…'
})

/** 装箱占用率与生成耗时：由生成结果带出，用于判断图集是否被排得过空 */
const pageOccupancy = computed(() => Math.round((built.value?.pageOccupancy[state.value.activePage] ?? 0) * 100))
const totalOccupancy = computed(() => Math.round((built.value?.occupancy ?? 0) * 100))
const buildMs = computed(() => built.value?.buildMs ?? 0)

/* ---------------- 字形像素与成图缓存 ---------------- */

/**
 * 页画布缓存：预览与场景预览都要反复取同一页，按「结果版本 + 页 + 着色」缓存，
 * 距离场模式在此把距离值按阈值转成覆盖率 alpha 并着色，等价于引擎 shader 的一次近似。
 */
const pageCache = new Map<string, HTMLCanvasElement>()
let cacheToken = 0

function clearPageCache(): void {
  for (const canvas of pageCache.values()) releaseCanvas(canvas)
  pageCache.clear()
  cacheToken++
}

function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return [255, 255, 255]
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
}

/** 取一页的绘制源；tint 为 null 表示直接用图集原色（位图模式自带描边 / 阴影配色） */
function pageCanvas(index: number, tint: string | null): HTMLCanvasElement | null {
  const result = built.value
  const page = result?.pages[index]
  if (!result || !page) return null
  const key = `${cacheToken}|${index}|${tint ?? 'raw'}`
  const cached = pageCache.get(key)
  if (cached) return cached
  const image = renderFontPageImageData(result, index)
  if (!image) return null
  const canvas = document.createElement('canvas')
  canvas.width = page.width
  canvas.height = page.height
  const ctx = canvas.getContext('2d')!
  if (!tint) {
    ctx.putImageData(image, 0, 0)
  } else {
    const [r, g, b] = hexToRgb(tint)
    const out = ctx.createImageData(page.width, page.height)
    const source = image.data
    const distanceField = isDistanceFieldMode(result.mode)
    // 距离值 → 覆盖率：阈值附近给一小段过渡，避免硬边
    const low = (result.sdfThreshold - 0.03) * 255
    const span = Math.max(1, 0.06 * 255)
    const total = page.width * page.height
    for (let i = 0; i < total; i++) {
      const p = i * 4
      let alpha: number
      if (!distanceField) {
        alpha = source[p + 3]
      } else {
        const mask = result.mode === 'mtsdf'
          ? source[p + 3]
          : result.mode === 'msdf'
            ? median3(source[p], source[p + 1], source[p + 2])
            : source[p]
        alpha = Math.round(Math.min(1, Math.max(0, (mask - low) / span)) * 255)
      }
      out.data[p] = r
      out.data[p + 1] = g
      out.data[p + 2] = b
      out.data[p + 3] = alpha
    }
    ctx.putImageData(out, 0, 0)
  }
  pageCache.set(key, canvas)
  return canvas
}

/** 位图模式用图集原色（保留描边 / 阴影配色），距离场模式统一着白色供预览 */
function drawingColor(result: FontBuildResult): string | null {
  return isDistanceFieldMode(result.mode) ? '#f2f6ff' : null
}

const glyphIndex = computed(() => {
  const map = new Map<number, FontGlyph>()
  for (const glyph of built.value?.glyphs ?? []) map.set(glyph.code, glyph)
  return map
})

const kernIndex = computed(() => {
  const map = new Map<string, number>()
  for (const pair of built.value?.kerning ?? []) map.set(`${pair.first},${pair.second}`, pair.amount)
  return map
})

/** 按 BMFont 度量逐字拼绘：xoffset/yoffset 相对笔位与行顶，xadvance 叠加字距调整 */
function drawAtlasLine(
  ctx: CanvasRenderingContext2D,
  result: FontBuildResult,
  line: string,
  x: number,
  lineTop: number,
  tint: string | null,
): number {
  const chars = Array.from(line)
  let penX = x
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].codePointAt(0)!
    const glyph = glyphIndex.value.get(code)
    if (!glyph) {
      penX += result.sizePx * 0.5
      continue
    }
    if (glyph.width && glyph.height) {
      const page = pageCanvas(glyph.page, tint)
      if (page) {
        ctx.drawImage(
          page,
          glyph.x, glyph.y, glyph.width, glyph.height,
          Math.round(penX + glyph.xoffset), Math.round(lineTop + glyph.yoffset), glyph.width, glyph.height,
        )
      }
    }
    penX += glyph.xadvance
    const next = chars[i + 1]?.codePointAt(0)
    if (next !== undefined) penX += kernIndex.value.get(`${code},${next}`) ?? 0
  }
  return penX - x
}

/** 量一行宽度（含字距调整），用于预览画布自适应尺寸与场景内居中 */
function measureAtlasLine(result: FontBuildResult, line: string): number {
  const chars = Array.from(line)
  let width = 0
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].codePointAt(0)!
    const glyph = glyphIndex.value.get(code)
    width += glyph ? glyph.xadvance : result.sizePx * 0.5
    const next = chars[i + 1]?.codePointAt(0)
    if (next !== undefined) width += kernIndex.value.get(`${code},${next}`) ?? 0
  }
  return width
}

/* ---------------- 逐字微调 ---------------- */

interface GlyphOverride {
  xoffset?: number
  yoffset?: number
  xadvance?: number
}

/** 生成结果非响应式，逐字微调后靠 revision 触发列表与预览刷新 */
const revision = ref(0)
const overrides = ref<Record<number, GlyphOverride>>({})
/** 每个字形的原始度量，用于「恢复」与重算基准 */
const baseMetrics = new Map<number, { xoffset: number; yoffset: number; xadvance: number }>()

function captureBase(): void {
  baseMetrics.clear()
  for (const glyph of built.value?.glyphs ?? []) {
    baseMetrics.set(glyph.code, { xoffset: glyph.xoffset, yoffset: glyph.yoffset, xadvance: glyph.xadvance })
  }
}

/** 把微调覆盖写回字形度量；每次重建后都要重放一遍 */
function applyOverrides(): void {
  const result = built.value
  if (!result) return
  for (const glyph of result.glyphs) {
    const base = baseMetrics.get(glyph.code) ?? glyph
    const override = overrides.value[glyph.code]
    glyph.xoffset = override?.xoffset ?? base.xoffset
    glyph.yoffset = override?.yoffset ?? base.yoffset
    glyph.xadvance = override?.xadvance ?? base.xadvance
  }
  revision.value++
}

function inputValue(e: Event): string {
  return (e.target as HTMLInputElement).value
}

function setGlyphMetric(code: number, key: keyof GlyphOverride, raw: string): void {
  const value = Math.round(Number(raw))
  if (!Number.isFinite(value)) return
  overrides.value = { ...overrides.value, [code]: { ...overrides.value[code], [key]: value } }
  applyOverrides()
  refreshVisuals()
}

function resetGlyph(code: number): void {
  const next = { ...overrides.value }
  delete next[code]
  overrides.value = next
  applyOverrides()
  refreshVisuals()
}

function resetAllOverrides(): void {
  overrides.value = {}
  applyOverrides()
  refreshVisuals()
}

function refreshVisuals(): void {
  void nextTick(() => {
    refreshAtlas()
    drawPreview()
    drawScene()
  })
}

const glyphFilter = ref('')
const GLYPH_LIST_LIMIT = 300
const visibleGlyphs = computed(() => {
  revision.value
  const list = built.value?.glyphs ?? []
  const keyword = glyphFilter.value.trim().toLowerCase()
  const matched = keyword
    ? list.filter((glyph) => glyph.char.toLowerCase().includes(keyword)
      || String(glyph.code).includes(keyword)
      || `u+${glyph.code.toString(16)}` === keyword)
    : list
  return { items: matched.slice(0, GLYPH_LIST_LIMIT), total: matched.length }
})
const overrideCount = computed(() => Object.keys(overrides.value).length)

/** 排除某个字形：写进排除字符后自动重建 */
function excludeGlyph(glyph: FontGlyph): void {
  if (state.value.excluded.includes(glyph.char)) return
  state.value.excluded += glyph.char
}

/* ---------------- 字距调整 ---------------- */

const newKern = ref({ first: '', second: '', amount: -2 })

const kernBadge = computed(() => {
  const total = built.value?.kerning.length ?? 0
  const manual = state.value.kerningPairs.filter((pair) => built.value?.pixels.has(pair.first) && built.value.pixels.has(pair.second)).length
  return { total, manual }
})

function addKernPair(): void {
  const first = Array.from(newKern.value.first)[0]
  const second = Array.from(newKern.value.second)[0]
  if (!first || !second) {
    errorText.value = '请各填一个字符再添加字距对'
    return
  }
  const pair: FontKerningPair = {
    first: first.codePointAt(0)!,
    second: second.codePointAt(0)!,
    amount: Math.round(newKern.value.amount),
  }
  const existing = state.value.kerningPairs.findIndex((item) => item.first === pair.first && item.second === pair.second)
  if (existing >= 0) state.value.kerningPairs.splice(existing, 1, pair)
  else state.value.kerningPairs.push(pair)
  newKern.value = { first: '', second: '', amount: -2 }
  errorText.value = ''
}

function removeKernPair(index: number): void {
  state.value.kerningPairs.splice(index, 1)
}

function charOf(code: number): string {
  return String.fromCodePoint(code)
}

/* ---------------- 图集预览（canvas） ---------------- */

/** 图集预览用 canvas 绘制：整页像素一次性画满，缩放交给 canvas，避免 img 被框裁掉 */
const atlasStage = ref<HTMLElement>()
const atlasCanvas = ref<HTMLCanvasElement>()
/** 全分辨率图集页（离屏画布），作为预览的绘制源 */
const atlasSource = shallowRef<HTMLCanvasElement | null>(null)
const hasAtlasPage = computed(() => Boolean(state.value.pageUrls[state.value.activePage]))

/** 用当前结果重建离屏画布（重新生成或切页后调用） */
function rebuildAtlasSource(): void {
  const previous = atlasSource.value
  if (previous) releaseCanvas(previous)
  const result = built.value
  const image = result ? renderFontPageImageData(result, state.value.activePage) : null
  if (!image) {
    atlasSource.value = null
    return
  }
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')!.putImageData(image, 0, 0)
  atlasSource.value = canvas
}

/**
 * 把离屏画布按当前缩放档位画到预览 canvas。
 * 「适应」按预览框内容盒等比缩到完整可见且不放大；1×/2×/4× 按固定倍率，超出部分靠框内滚动。
 */
function drawAtlas(): void {
  const target = atlasCanvas.value
  const stage = atlasStage.value
  if (!target || !stage) return
  const source = atlasSource.value
  if (!source) {
    target.width = 0
    target.height = 0
    target.style.width = '0px'
    target.style.height = '0px'
    return
  }
  const styles = getComputedStyle(stage)
  const availW = Math.max(1, stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight))
  const availH = Math.max(1, stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom))
  const scale = atlasZoom.value === 'fit'
    ? Math.min(1, availW / source.width, availH / source.height)
    : atlasZoom.value
  const displayW = Math.max(1, Math.round(source.width * scale))
  const displayH = Math.max(1, Math.round(source.height * scale))
  const ratio = window.devicePixelRatio || 1
  target.width = Math.round(displayW * ratio)
  target.height = Math.round(displayH * ratio)
  target.style.width = `${displayW}px`
  target.style.height = `${displayH}px`
  const ctx = target.getContext('2d')!
  // 放大用最近邻保住像素锐利；缩小到框内改用平滑插值，避免逐行丢像素把字形切断
  const crisp = scale >= 1
  ctx.imageSmoothingEnabled = !crisp
  if (!crisp) ctx.imageSmoothingQuality = 'high'
  ctx.clearRect(0, 0, target.width, target.height)
  ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, target.width, target.height)
}

function refreshAtlas(): void {
  rebuildAtlasSource()
  drawAtlas()
}

// 生成结果或当前页变化 → 重建绘制源并重绘（画布可能刚挂载，等一拍再量尺寸）
watch([built, () => state.value.activePage], () => void nextTick(refreshAtlas))
watch(atlasZoom, () => drawAtlas())

// 预览框尺寸变化时只需重绘（「适应」档位依赖框的宽高）
let stageObserver: ResizeObserver | undefined
watch(atlasStage, (element) => {
  stageObserver?.disconnect()
  stageObserver = undefined
  if (element) {
    stageObserver = new ResizeObserver(() => drawAtlas())
    stageObserver.observe(element)
  }
  void nextTick(refreshAtlas)
})

/** dataURL → Blob，单页且不附带元数据时直接下载 PNG */
function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(',')
  const mime = /^data:(.*?);/.exec(url.slice(0, comma))?.[1] ?? 'image/png'
  const binary = atob(url.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** 导入字体文件：校验 → 注册 FontFace → 交给 watch 触发生成 */
async function loadFontFile(file?: File): Promise<void> {
  if (!file) return
  errorText.value = ''
  warnText.value = ''
  infoText.value = ''
  if (!/\.(ttf|otf|woff2?|ttc)$/i.test(file.name)) {
    errorText.value = '仅支持 TTF / OTF / WOFF / WOFF2 / TTC 字体文件'
    return
  }
  if (file.size > MAX_FONT_FILE_SIZE) {
    errorText.value = `字体文件超过 ${Math.round(MAX_FONT_FILE_SIZE / 1024 / 1024)}MB 限制`
    return
  }
  const previousFamily = state.value.family
  resetFont()
  built.value = null
  clearPageCache()
  if (previousFamily) unregisterFontFace(previousFamily)
  const url = URL.createObjectURL(file)
  try {
    const family = await registerFontFace(url)
    Object.assign(state.value, {
      fileName: file.name, fontUrl: url, family, source: 'upload', status: 'ready', error: '',
    })
  } catch {
    URL.revokeObjectURL(url)
    errorText.value = '字体文件解析失败，请确认是有效的 TTF / OTF / WOFF / WOFF2 / TTC 字体'
  } finally {
    if (input.value) input.value.value = ''
  }
}

function onFileChange(e: Event): void {
  void loadFontFile((e.target as HTMLInputElement).files?.[0])
}

function onScanChange(e: Event): void {
  void scanTextFile((e.target as HTMLInputElement).files?.[0])
}

/* ---------------- 生成 ---------------- */

let debounceTimer: ReturnType<typeof setTimeout> | undefined
let buildToken = 0

/** 生成输入指纹：任一参数变化都重新生成 */
const buildKey = computed(() => JSON.stringify({
  family: activeFamily.value,
  charset: state.value.charset,
  excluded: excludeCodes.value,
  sizePx: state.value.sizePx,
  padding: state.value.padding,
  mode: state.value.mode,
  sdfSpread: state.value.sdfSpread,
  sdfThreshold: state.value.sdfThreshold,
  letterSpacing: state.value.letterSpacing,
  lineSpacing: state.value.lineSpacing,
  maxAtlasSize: state.value.maxAtlasSize,
  powerOfTwo: state.value.powerOfTwo,
  kerning: state.value.kerning,
  kerningPairs: state.value.kerningPairs,
  strokeWidth: state.value.strokeWidth,
  strokeColor: state.value.strokeColor,
  shadow: [state.value.shadowEnabled, state.value.shadowX, state.value.shadowY, state.value.shadowColor],
}))

function scheduleBuild(): void {
  clearTimeout(debounceTimer)
  // 防抖：连续改数值时只跑最后一次，避免大字符集被反复重算
  debounceTimer = setTimeout(() => void runBuild(), 320)
}

/** 清空生成结果与摘要，避免切到无字体状态后页数与字形数还留在界面上 */
function clearResult(): void {
  built.value = null
  clearPageCache()
  state.value.pageUrls = []
  state.value.pageCount = 0
  state.value.glyphCount = 0
  state.value.activePage = 0
}

async function runBuild(): Promise<void> {
  const family = activeFamily.value
  if (!family) {
    clearResult()
    state.value.status = 'empty'
    warnText.value = ''
    errorText.value = ''
    return
  }
  if (!charCount.value) {
    clearResult()
    state.value.status = 'empty'
    errorText.value = ''
    warnText.value = '字符集为空，未生成图集：请至少勾选一项预设，或填写自定义字符 / Unicode 范围'
    return
  }
  const token = ++buildToken
  generating.value = true
  errorText.value = ''
  warnText.value = ''
  infoText.value = ''
  progress.value = { done: 0, total: charCount.value }
  try {
    // 先确保字体已加载，否则首帧会量到回落字体导致度量错位
    await document.fonts.load(`${state.value.sizePx}px ${quoteFamily(family)}`, 'ABCabc123')
    const result = await buildFont({
      ...state.value.charset,
      family,
      name: exportName.value,
      sizePx: state.value.sizePx,
      padding: state.value.padding,
      mode: state.value.mode,
      sdfSpread: state.value.sdfSpread,
      sdfThreshold: state.value.sdfThreshold,
      maxAtlasSize: state.value.maxAtlasSize,
      powerOfTwo: state.value.powerOfTwo,
      excludeChars: excludeCodes.value,
      letterSpacing: state.value.letterSpacing,
      lineSpacing: state.value.lineSpacing,
      kerning: state.value.kerning,
      kerningPairs: state.value.kerningPairs,
      strokeWidth: state.value.strokeWidth,
      strokeColor: state.value.strokeColor,
      shadowEnabled: state.value.shadowEnabled,
      shadowX: state.value.shadowX,
      shadowY: state.value.shadowY,
      shadowColor: state.value.shadowColor,
      onProgress: (done, total) => {
        if (token === buildToken) progress.value = { done, total }
      },
    })
    if (token !== buildToken) return
    clearPageCache()
    built.value = result
    captureBase()
    applyOverrides()
    state.value.pageUrls = renderFontPages(result)
    state.value.pageCount = result.pages.length
    state.value.glyphCount = result.glyphs.length
    state.value.activePage = 0
    state.value.status = 'done'
    // 截断 / 跳过属于「生成成功但有损」，用警告色而不是错误色
    if (result.warnings.length) warnText.value = result.warnings.join('；')
    refreshVisuals()
  } catch (error) {
    if (token !== buildToken) return
    clearResult()
    state.value.status = 'error'
    errorText.value = error instanceof Error ? error.message : '字体生成失败'
  } finally {
    if (token === buildToken) generating.value = false
  }
}

watch(buildKey, () => scheduleBuild(), { immediate: true })

/** 系统字体名变化后检测一次可用性，给出提示但不阻断生成；逐字输入时防抖，避免每个字符都建一次测量画布 */
let availableTimer: ReturnType<typeof setTimeout> | undefined
watch(() => state.value.systemFamily, (value) => {
  clearTimeout(availableTimer)
  const name = value.trim()
  if (!name) {
    systemAvailable.value = null
    return
  }
  availableTimer = setTimeout(() => {
    if (state.value.systemFamily.trim() === name) systemAvailable.value = isFontAvailable(name)
  }, 220)
})

/* ---------------- 文本效果预览（按 BMFont 度量拼绘 + 基线辅助线） ---------------- */

/** 基线 / 行高辅助线：上升线（蓝虚）· 基线（红实）· 下降线（蓝虚） */
function drawMetricsGuides(ctx: CanvasRenderingContext2D, result: FontBuildResult, x: number, lineTop: number, width: number): void {
  const baseline = lineTop + result.base
  ctx.save()
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.55)'
  ctx.beginPath()
  ctx.moveTo(x, baseline - result.ascent + 0.5)
  ctx.lineTo(x + width, baseline - result.ascent + 0.5)
  ctx.moveTo(x, baseline + result.descent + 0.5)
  ctx.lineTo(x + width, baseline + result.descent + 0.5)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.strokeStyle = 'rgba(248, 113, 113, 0.9)'
  ctx.beginPath()
  ctx.moveTo(x, baseline + 0.5)
  ctx.lineTo(x + width, baseline + 0.5)
  ctx.stroke()
  ctx.restore()
}

function drawPreview(): void {
  const canvas = previewCanvas.value
  const family = activeFamily.value
  if (!canvas || !family) return
  const ctx = canvas.getContext('2d')!
  const size = state.value.sizePx
  const lines = (state.value.previewText || ' ').split('\n')
  const result = built.value
  const pad = Math.ceil(size * 0.7) + 8

  // 尚未生成时先用原始字体兜底，保证预览区不空着
  if (!result) {
    const font = `${size}px ${quoteFamily(family)}, sans-serif`
    ctx.font = font
    const width = Math.ceil(Math.max(1, ...lines.map((line) => ctx.measureText(line || ' ').width)))
    const lineHeight = Math.ceil(size * 1.4)
    canvas.width = Math.max(48, width + pad * 2)
    canvas.height = lines.length * lineHeight + pad * 2
    ctx.font = font
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#e8edf5'
    lines.forEach((line, index) => ctx.fillText(line, pad, pad + index * lineHeight + Math.round(size * 0.9)))
    return
  }

  const tint = drawingColor(result)
  const widths = lines.map((line) => measureAtlasLine(result, line))
  canvas.width = Math.max(48, Math.ceil(Math.max(1, ...widths) + pad * 2))
  canvas.height = lines.length * result.lineHeight + pad * 2
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false
  lines.forEach((line, index) => {
    const lineTop = pad + index * result.lineHeight
    drawAtlasLine(ctx, result, line, pad, lineTop, tint)
    if (state.value.showMetrics) drawMetricsGuides(ctx, result, pad, lineTop, canvas.width - pad * 2)
  })
}

/* ---------------- 游戏场景预览 ---------------- */

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 场景样本文案里缺失的字符：缺字会让预览整行空掉或只剩一半，必须显式提示而不是静默跳过 */
const sceneMissing = ref<string[]>([])

/** 样本文案里不在当前字符集内的字符（空白除外），用于提示预览为何缺字 */
function missingInScene(text: string): string[] {
  return Array.from(text).filter((ch) => !/\s/.test(ch) && !glyphIndex.value.has(ch.codePointAt(0)!))
}

/** 挑一版能画全的样本文案：优先中文，字符集缺字时退回 ASCII 版本，避免预览整行空白 */
function sceneLabel(candidates: string[]): string {
  for (const text of candidates) {
    if (!missingInScene(text).length) return text
  }
  return candidates[candidates.length - 1]
}

/** 由「视觉中心高度」反推基线：按大写字高估算，保证不同 scale 的文字都居中于同一中心线 */
function baselineAt(centerY: number, scale: number): number {
  const result = built.value
  if (!result) return centerY
  return centerY + (result.sizePx * scale * 0.72) / 2
}

/** 在可用宽度内自适应缩小，避免场景文案被画布裁掉 */
function fitScale(text: string, maxWidth: number, scale: number): number {
  const result = built.value
  if (!result) return scale
  const width = measureAtlasLine(result, text) * scale
  return width > maxWidth ? (maxWidth / width) * scale : scale
}

/**
 * 场景内绘制一行字样：距离场模式按场景配色着色，位图模式用图集自带配色。
 * baselineY 是基线位置——按基线而不是行顶定位，不同 scale 的文字才不会上下错位。
 */
function sceneText(ctx: CanvasRenderingContext2D, text: string, x: number, baselineY: number, scale: number, color: string): number {
  const result = built.value
  if (!result) return 0
  const tint = isDistanceFieldMode(result.mode) ? color : null
  ctx.save()
  ctx.translate(x, baselineY)
  ctx.scale(scale, scale)
  ctx.imageSmoothingEnabled = false
  const width = drawAtlasLine(ctx, result, text, 0, -result.base, tint)
  ctx.restore()
  return width * scale
}

function sceneTextCentered(ctx: CanvasRenderingContext2D, text: string, centerX: number, baselineY: number, scale: number, color: string): void {
  const result = built.value
  if (!result) return
  const width = measureAtlasLine(result, text) * scale
  sceneText(ctx, text, centerX - width / 2, baselineY, scale, color)
}

function drawScene(): void {
  const canvas = sceneCanvas.value
  if (!canvas) return
  const W = 380
  const H = 132
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, W, H)
  sceneMissing.value = []
  if (state.value.scene === 'none') return
  ctx.fillStyle = '#141821'
  ctx.fillRect(0, 0, W, H)
  const result = built.value
  if (!result) {
    ctx.fillStyle = 'rgba(232, 237, 245, 0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('生成后显示场景预览', 16, 68)
    return
  }
  const white = '#f4f7ff'
  const usedLabels: string[] = []
  /** 取一版能画全的样本文案，顺带登记它，供缺字提示使用 */
  const label = (candidates: string[]): string => {
    const text = sceneLabel(candidates)
    usedLabels.push(text)
    return text
  }
  switch (state.value.scene) {
    case 'hp': {
      sceneText(ctx, label(['生命 128/150', 'HP 128/150']), 20, baselineAt(24, 1), 1, white)
      ctx.fillStyle = '#2a3140'
      roundRect(ctx, 20, 52, 240, 16, 5)
      ctx.fill()
      ctx.fillStyle = '#e5484d'
      roundRect(ctx, 20, 52, 240 * 0.72, 16, 5)
      ctx.fill()
      const armor = label(['护甲 42', 'ARMOR 42'])
      const armorScale = fitScale(armor, W - 288, 0.85)
      sceneText(ctx, armor, 276, baselineAt(60, armorScale), armorScale, '#9fb0c9')
      break
    }
    case 'coins': {
      ctx.fillStyle = '#f2b21b'
      ctx.beginPath()
      ctx.arc(42, 66, 18, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#8a5c00'
      ctx.font = 'bold 18px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('$', 42, 73)
      ctx.textAlign = 'left'
      sceneText(ctx, label(['1234']), 72, baselineAt(66, 1.2), 1.2, '#ffd76a')
      break
    }
    case 'level': {
      ctx.fillStyle = '#2b3a52'
      roundRect(ctx, 20, 40, 96, 34, 8)
      ctx.fill()
      sceneTextCentered(ctx, 'LV.42', 68, baselineAt(57, 1), 1, '#ffe08a')
      const exp = label(['经验 8,420 / 12,000', 'EXP 8,420 / 12,000'])
      const expScale = fitScale(exp, W - 142, 0.9)
      sceneText(ctx, exp, 130, baselineAt(57, expScale), expScale, white)
      break
    }
    case 'damage': {
      const damage = label(['-9999'])
      const damageScale = fitScale(damage, W - 24, 2)
      sceneTextCentered(ctx, damage, W / 2, baselineAt(46, damageScale), damageScale, '#ff8b3d')
      sceneTextCentered(ctx, label(['暴击！', 'CRIT!']), W / 2, baselineAt(96, 0.9), 0.9, '#ffd166')
      break
    }
    case 'dialog': {
      ctx.fillStyle = 'rgba(20, 26, 38, 0.94)'
      roundRect(ctx, 14, 34, W - 28, 84, 8)
      ctx.fill()
      ctx.strokeStyle = 'rgba(150, 178, 216, 0.5)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = '#8fd0ff'
      roundRect(ctx, 26, 22, 96, 24, 6)
      ctx.fill()
      sceneTextCentered(ctx, label(['勇者', 'HERO']), 74, baselineAt(34, 0.85), 0.85, '#0a1a2a')
      const speech = label(['你好，冒险者！', 'Hello, adventurer!'])
      const speechScale = fitScale(speech, W - 56, 1)
      sceneText(ctx, speech, 28, baselineAt(66, speechScale), speechScale, white)
      break
    }
    case 'button': {
      ctx.fillStyle = '#2f6df6'
      roundRect(ctx, 110, 44, 160, 42, 10)
      ctx.fill()
      const action = label(['开始游戏', 'START'])
      const actionScale = fitScale(action, 136, 1)
      sceneTextCentered(ctx, action, 190, baselineAt(65, actionScale), actionScale, white)
      break
    }
  }
  sceneMissing.value = Array.from(new Set(usedLabels.flatMap(missingInScene)))
}

/** 度量面板：生成结果里可直接读到的排版参数 */
const metrics = computed(() => {
  const result = built.value
  if (!result) return null
  return {
    ascent: result.ascent,
    descent: result.descent,
    base: result.base,
    lineHeight: result.lineHeight,
    letterSpacing: result.letterSpacing,
    lineSpacing: result.lineSpacing,
    excluded: result.excludedCount,
  }
})

watch(
  [previewCanvas, activeFamily, () => state.value.previewText, () => state.value.sizePx, () => state.value.status, built, () => state.value.showMetrics],
  () => void nextTick(drawPreview),
  { immediate: true },
)

watch(
  [sceneCanvas, () => state.value.scene, activeFamily, () => state.value.status, built, revision],
  () => void nextTick(drawScene),
  { immediate: true },
)

/* ---------------- 导出 ---------------- */

async function exportFont(): Promise<void> {
  const result = built.value
  if (!result) return
  exporting.value = true
  errorText.value = ''
  infoText.value = ''
  try {
    const base = exportName.value
    const entries: ZipEntry[] = state.value.pageUrls.map((url, index) => ({
      name: pageFileName(base, index),
      blob: url,
    }))
    if (state.value.withFnt) entries.push({ name: `${base}.fnt`, blob: buildBmfontText(result, base) })
    if (state.value.withXml) entries.push({ name: `${base}.xml`, blob: buildBmfontXml(result, base) })
    if (state.value.withJson) entries.push({ name: `${base}.json`, blob: buildFontJson(result, base) })
    // 只导出一张 PNG 且不带元数据时直接下载，省去解压一步
    if (entries.length === 1) {
      downloadBlob(dataUrlToBlob(state.value.pageUrls[0]), entries[0].name)
      infoText.value = `已导出 ${entries[0].name}`
      return
    }
    const zipName = `${base}-font.zip`
    await downloadZip(entries, zipName)
    infoText.value = `已导出 ${zipName}（${entries.length} 个文件：${entries.map((entry) => entry.name).join('、')}）`
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 重置：注销 FontFace、释放 blob URL 并清空结果（参数保留） */
function resetAll(): void {
  const family = state.value.family
  resetFont()
  if (family) unregisterFontFace(family)
  clearResult()
  clearPageCache()
  overrides.value = {}
  baseMetrics.clear()
  coverage.value = null
  coverageKey.value = ''
  systemAvailable.value = null
  atlasZoom.value = 'fit'
  errorText.value = ''
  warnText.value = ''
  infoText.value = ''
  state.value.error = ''
}

/**
 * 页面重挂载 / 热更新后恢复上传字体：store 里还留着 blob URL 与家族名，
 * 但页面卸载时的 FontFace 引用需要重新确认，这里按保存的家族名重新注册一次。
 */
onMounted(async () => {
  if (state.value.source === 'upload' && state.value.fontUrl && state.value.family) {
    try {
      await registerFontFace(state.value.fontUrl, state.value.family)
      state.value.status = 'ready'
    } catch {
      errorText.value = '字体文件恢复失败，请重新导入'
    }
  }
})

onBeforeUnmount(() => {
  clearTimeout(debounceTimer)
  clearTimeout(availableTimer)
  // 让正在跑的生成结果作废，避免退出后回写已卸载组件的状态
  buildToken++
  stageObserver?.disconnect()
  clearPageCache()
  if (atlasSource.value) releaseCanvas(atlasSource.value)
})
</script>

<template>
  <div class="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)_320px]">
    <!-- 隐藏的文件选择控件放在最外层：空状态下顶部栏的「导入字体」也要能用 -->
    <input ref="input" hidden type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" @change="onFileChange" />
    <input ref="scanInput" hidden type="file" accept=".txt,.json,.csv" @change="onScanChange" />

    <!-- 左栏：字体来源与字符集（始终显示，未就绪时也要能选来源/填系统字体名） -->
    <section class="panel overflow-auto border-r border-line">
      <div class="section">
        <h2 class="section-title">字体来源<span class="ml-1.25 inline-flex size-3.5 flex-none items-center justify-center rounded-full border border-line-strong align-middle text-[10px] leading-none font-normal tracking-normal text-faint hover:border-accent-border hover:bg-hover hover:text-ink" :title="`支持 TTF / OTF / WOFF / WOFF2 / TTC，单文件 ≤ ${Math.round(MAX_FONT_FILE_SIZE / 1024 / 1024)}MB。上传字体跨设备表现一致，推荐优先使用。`">?</span></h2>
        <label class="check-row"><input v-model="state.source" type="radio" value="upload" /> 上传字体文件</label>
        <label class="check-row mt-2"><input v-model="state.source" type="radio" value="system" /> 使用系统字体</label>

        <template v-if="state.source === 'upload'">
          <button class="btn w-full justify-center" @click="input?.click()">{{ fileName ? '更换字体文件' : '选择字体文件' }}</button>
          <p v-if="fileName" class="muted mono overflow-hidden text-ellipsis whitespace-nowrap" :title="fileName">{{ fileName }}</p>
        </template>

        <template v-else>
          <label class="field">
            <span class="field-label">系统字体名<span class="ml-1.25 inline-flex size-3.5 flex-none items-center justify-center rounded-full border border-line-strong align-middle text-[10px] leading-none font-normal tracking-normal text-faint hover:border-accent-border hover:bg-hover hover:text-ink" title="系统字体依赖本机安装，跨设备生成结果可能不一致。">?</span></span>
            <input v-model="state.systemFamily" class="input w-full" type="text" spellcheck="false" placeholder="例如 PingFang SC / Arial" />
          </label>
          <p v-if="systemAvailable === false" class="text-caption text-danger">未检测到该字体，将回落到默认无衬线字体。</p>
          <p v-else-if="systemAvailable" class="muted">已检测到该字体（不同机器安装情况可能不同）。</p>
        </template>
      </div>

      <div class="section">
        <h2 class="section-title">字符集</h2>
        <label class="check-row"><input v-model="state.charset.ascii" type="checkbox" /> ASCII 可打印（32–126）</label>
        <label class="check-row mt-2"><input v-model="state.charset.latin1" type="checkbox" /> Latin-1 补充（160–255）</label>
        <label class="check-row mt-3"><input v-model="state.charset.digits" type="checkbox" /> 数字与常用标点</label>

        <span class="field-label mt-3">CJK / 全角预设<span class="ml-1.25 inline-flex size-3.5 flex-none items-center justify-center rounded-full border border-line-strong align-middle text-[10px] leading-none font-normal tracking-normal text-faint hover:border-accent-border hover:bg-hover hover:text-ink" title="可叠加多个预设；已选中的预设再次点击即取消。">?</span></span>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <button
            v-for="preset in CHARSET_PRESETS"
            :key="preset.id"
            class="btn btn-ghost h-auto min-h-7.5 min-w-0 justify-start px-2 py-1 text-left text-[11px] leading-[1.3] whitespace-normal [word-break:break-word]"
            :class="isPresetActive(preset.ranges) ? 'border-accent-border bg-accent-dim text-accent-strong' : ''"
            :aria-pressed="isPresetActive(preset.ranges)"
            :title="preset.heavy ? `${preset.ranges}；字符量很大，会被 6000 上限截断，建议改用「扫描文本」；再次点击可取消` : `${preset.ranges}；再次点击可取消`"
            @click="applyPreset(preset.ranges)"
          >{{ preset.label }}</button>
        </div>

        <label class="field mt-3">
          <span class="field-label">自定义字符</span>
          <textarea v-model="state.charset.custom" class="input h-auto resize-y p-2 font-mono text-caption leading-normal" spellcheck="false" rows="3" placeholder="可直接粘贴中文或任意字符"></textarea>
        </label>
        <label class="field mt-3">
          <span class="field-label">Unicode 范围<span class="ml-1.25 inline-flex size-3.5 flex-none items-center justify-center rounded-full border border-line-strong align-middle text-[10px] leading-none font-normal tracking-normal text-faint hover:border-accent-border hover:bg-hover hover:text-ink" title="十六进制码点，支持「起-止」与「U+」前缀，逗号或空格分隔；单次生成上限 6000 个字符。">?</span></span>
          <input v-model="state.charset.ranges" class="input mono w-full" type="text" spellcheck="false" placeholder="4E00-4E20, 3000-303F" />
        </label>
        <button class="btn mt-3 w-full justify-center" title="只保留文本里实际出现的字符，适合按项目文案生成最小字符集。" @click="scanInput?.click()">扫描文本提取用字（TXT / JSON / CSV）</button>
        <p v-if="charCount" class="badge badge-accent">当前 {{ charCount }} 个字符</p>
        <p v-else class="text-caption text-danger">当前 0 个字符：请至少勾选一项预设，或填写自定义字符 / Unicode 范围</p>
      </div>

      <div class="section">
        <h2 class="section-title">覆盖率与排除<span class="ml-1.25 inline-flex size-3.5 flex-none items-center justify-center rounded-full border border-line-strong align-middle text-[10px] leading-none font-normal tracking-normal text-faint hover:border-accent-border hover:bg-hover hover:text-ink" title="生成前逐字比对目标字体与兜底字体的度量，标出实际没有字形的字符。">?</span></h2>
        <button class="btn w-full justify-center" :disabled="!ready || !charCount" @click="runCoverage">检测字体覆盖率</button>
        <template v-if="coverage && coverageFresh">
          <p class="badge" :class="{ 'badge-accent': coverage.ratio === 1 }">
            覆盖 {{ coverage.supported }} / {{ coverage.total }}（{{ Math.round(coverage.ratio * 100) }}%）
          </p>
          <p v-if="coverage.missing.length" class="warn">
            缺失 {{ coverage.missing.length }} 个字符，将由系统字体兜底：
            <span class="mono break-all">{{ coverage.missing.join('') }}</span>
          </p>
          <p v-else class="muted">全部字符都有对应字形。</p>
          <label class="check-row mt-3"><input v-model="state.excludeMissing" type="checkbox" /> 生成时自动排除缺失字符</label>
        </template>
        <p v-else-if="coverage" class="muted">字符集或字号已改变，请重新检测。</p>

        <label class="field mt-3">
          <span class="field-label">手动排除的字符<span class="ml-1.25 inline-flex size-3.5 flex-none items-center justify-center rounded-full border border-line-strong align-middle text-[10px] leading-none font-normal tracking-normal text-faint hover:border-accent-border hover:bg-hover hover:text-ink" title="排除的字符不进入图集，也不会影响其它字形的度量。">?</span></span>
          <textarea v-model="state.excluded" class="input h-auto resize-y p-2 font-mono text-caption leading-normal" spellcheck="false" rows="2" placeholder="粘贴要跳过的字符"></textarea>
        </label>
      </div>
    </section>

    <main class="relative flex min-h-0 min-w-0 flex-col">
      <div class="flex h-16 flex-none items-center justify-between gap-4 border-b border-line px-6">
        <div>
          <h2 class="m-0 text-head">位图字体工作区</h2>
          <p class="mt-0.5 mb-0 text-faint">{{ ready ? `${activeFamily} · ${state.sizePx}px · ${modeLabel}` : '上传字体文件或指定系统字体后自动生成' }}</p>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="state.pageCount" class="badge">{{ state.glyphCount }} 字形 · {{ state.pageCount }} 页</span>
          <button class="btn" :disabled="!ready || generating" @click="runBuild">重新生成</button>
          <!-- 空状态下也要能从这里导入，故不加 disabled -->
          <button class="btn btn-primary" @click="input?.click()">导入字体</button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <div v-if="!ready" class="empty-state">
          <span class="big">Aa</span>
          <strong>还没有可用的字体</strong>
          <span>上传一份 TTF / OTF / WOFF / WOFF2 / TTC 字体文件（≤ {{ Math.round(MAX_FONT_FILE_SIZE / 1024 / 1024) }}MB），或填写已安装的系统字体名</span>
          <div class="mt-3 flex gap-2">
            <button class="btn btn-primary" @click="input?.click()">选择字体文件</button>
            <button class="btn" @click="state.source = 'system'">改用系统字体</button>
          </div>
        </div>

        <template v-else>
          <section class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="faint m-0 text-caption font-medium">文本效果预览</h3>
              <label class="check-row text-[11px]"><input v-model="state.showMetrics" type="checkbox" /> 基线与行高辅助线</label>
            </div>
            <textarea v-model="state.previewText" class="input h-auto resize-y p-2 leading-normal" spellcheck="false" rows="2" placeholder="输入预览文本，支持换行"></textarea>
            <div class="flex items-center justify-center overflow-auto rounded-sm border border-line bg-stage p-3 [background-image:linear-gradient(45deg,rgb(255_255_255/5%)_25%,transparent_25%,transparent_75%,rgb(255_255_255/5%)_75%),linear-gradient(45deg,rgb(255_255_255/5%)_25%,transparent_25%,transparent_75%,rgb(255_255_255/5%)_75%)] [background-position:0_0,8px_8px] [background-size:16px_16px]">
              <canvas ref="previewCanvas" class="block max-w-full"></canvas>
            </div>
            <p class="muted">按当前生成结果逐字拼绘（含字间距、字距调整、描边与阴影），与引擎依 BMFont 度量排版的结果一致。</p>
            <p v-if="isDistanceFieldMode(state.mode)" class="muted">距离场模式此处按阈值近似着色；引擎里由 shader 采样距离场，缩放更平滑。</p>
          </section>

          <section v-if="state.scene !== 'none'" class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="faint m-0 text-caption font-medium">场景预览（{{ SCENES.find((item) => item.value === state.scene)?.label }}）</h3>
            </div>
            <div class="flex items-center justify-center overflow-auto rounded-sm border border-line bg-stage p-3 [background-image:linear-gradient(45deg,rgb(255_255_255/5%)_25%,transparent_25%,transparent_75%,rgb(255_255_255/5%)_75%),linear-gradient(45deg,rgb(255_255_255/5%)_25%,transparent_25%,transparent_75%,rgb(255_255_255/5%)_75%)] [background-position:0_0,8px_8px] [background-size:16px_16px]">
              <canvas ref="sceneCanvas" class="block max-w-full rounded-sm"></canvas>
            </div>
            <p v-if="sceneMissing.length" class="muted">样本文案缺字（不在当前字符集内，已跳过）：{{ sceneMissing.join(' ') }}</p>
            <p class="muted">用生成的字形与度量拼出游戏内常见排版，用来核对字号、行高与可读性。</p>
          </section>

          <section class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="faint m-0 text-caption font-medium">图集预览（{{ state.pageUrls[state.activePage] ? `${built?.pages[state.activePage]?.width}×${built?.pages[state.activePage]?.height}` : '未生成' }}）</h3>
              <div class="flex flex-wrap items-center gap-2">
                <span v-if="built" class="badge">占用率 本页 {{ pageOccupancy }}% · 整体 {{ totalOccupancy }}%</span>
                <span v-if="built" class="muted text-[11px]">生成耗时 {{ buildMs }}ms</span>
                <div v-if="state.pageCount > 1" class="flex flex-wrap gap-1">
                  <button
                    v-for="index in state.pageCount"
                    :key="index"
                    class="min-w-6 h-[22px] rounded-sm border px-1.5 py-0 font-mono text-[11px] leading-[normal]"
                    :class="state.activePage === index - 1 ? 'border-accent-border bg-accent-dim text-accent-strong' : 'border-line text-muted hover:bg-hover hover:text-ink'"
                    @click="state.activePage = index - 1"
                  >{{ index }}</button>
                </div>
                <div v-if="state.pageUrls[state.activePage]" class="seg [&_.seg-item]:min-w-[34px] [&_.seg-item]:cursor-pointer [&_.seg-item]:justify-center">
                  <button
                    v-for="option in ATLAS_ZOOMS"
                    :key="String(option.value)"
                    class="seg-item"
                    :class="{ active: atlasZoom === option.value }"
                    @click="atlasZoom = option.value"
                  >{{ option.label }}</button>
                </div>
              </div>
            </div>
            <div ref="atlasStage" class="flex h-[min(52vh,480px)] min-h-40 items-center justify-center overflow-auto rounded-sm border border-line bg-stage p-3 [background-image:linear-gradient(45deg,rgb(255_255_255/5%)_25%,transparent_25%,transparent_75%,rgb(255_255_255/5%)_75%),linear-gradient(45deg,rgb(255_255_255/5%)_25%,transparent_25%,transparent_75%,rgb(255_255_255/5%)_75%)] [background-position:0_0,8px_8px] [background-size:16px_16px]">
              <canvas v-show="hasAtlasPage" ref="atlasCanvas" class="m-auto block flex-none"></canvas>
              <p v-if="!hasAtlasPage" class="muted">{{ atlasPlaceholder }}</p>
            </div>
          </section>

          <section v-if="built" class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="faint m-0 text-caption font-medium">字形列表（{{ visibleGlyphs.total }} 个）</h3>
              <div class="flex flex-wrap items-center gap-2">
                <input v-model="glyphFilter" class="input w-50" type="text" spellcheck="false" placeholder="搜索字符 / 码点 / U+41" />
                <button class="btn btn-ghost" :disabled="!overrideCount" @click="resetAllOverrides">重置微调（{{ overrideCount }}）</button>
              </div>
            </div>
            <div class="max-h-80 divide-y divide-line overflow-auto rounded-sm border border-line">
              <div class="sticky top-0 z-1 grid grid-cols-[46px_56px_1fr_1fr_1fr_30px_30px] items-center gap-1 bg-surface px-1.5 py-0.5 text-[11px] text-faint">
                <span>字符</span>
                <span>码点</span>
                <span>xoffset</span>
                <span>yoffset</span>
                <span>xadvance</span>
                <span></span>
              </div>
              <div v-for="glyph in visibleGlyphs.items" :key="glyph.code" class="grid grid-cols-[46px_56px_1fr_1fr_1fr_30px_30px] items-center gap-1 px-1.5 py-0.5">
                <span class="mono text-center text-[15px]">{{ glyph.char === ' ' ? '␠' : glyph.char }}</span>
                <span class="mono faint">{{ glyph.code }}</span>
                <input class="input h-6 px-1 py-0 text-right font-mono text-[11px]" type="number" :value="glyph.xoffset" @change="setGlyphMetric(glyph.code, 'xoffset', inputValue($event))" />
                <input class="input h-6 px-1 py-0 text-right font-mono text-[11px]" type="number" :value="glyph.yoffset" @change="setGlyphMetric(glyph.code, 'yoffset', inputValue($event))" />
                <input class="input h-6 px-1 py-0 text-right font-mono text-[11px]" type="number" :value="glyph.xadvance" @change="setGlyphMetric(glyph.code, 'xadvance', inputValue($event))" />
                <button class="grid size-5.5 place-items-center rounded-sm border border-line text-[12px] text-muted hover:bg-hover hover:text-ink" title="重置该字形微调" @click="resetGlyph(glyph.code)">↺</button>
                <button class="grid size-5.5 place-items-center rounded-sm border border-line text-[12px] text-muted hover:bg-hover hover:text-ink" title="从字符集中排除该字形" @click="excludeGlyph(glyph)">✕</button>
              </div>
            </div>
            <p v-if="visibleGlyphs.total > GLYPH_LIST_LIMIT" class="muted">仅显示前 {{ GLYPH_LIST_LIMIT }} 个，用搜索缩小范围。</p>
          </section>
        </template>
      </div>

      <div v-if="generating" class="absolute inset-0 z-20 grid place-items-center bg-[rgb(13_15_19/0.55)]">
        <div class="flex items-center gap-4 rounded-md border border-line-strong bg-surface px-6 py-5 shadow-popover">
          <span class="size-5.5 flex-none animate-spin rounded-full border-2 border-line-strong border-t-accent"></span>
          <div>
            <strong class="text-body">正在生成字形图集</strong>
            <p v-if="progress.total" class="muted mono mt-0.5 mb-0 text-[11px]">{{ progress.done }}/{{ progress.total }}</p>
          </div>
        </div>
      </div>
    </main>

    <!-- 右栏：渲染参数与导出 -->
    <section class="panel overflow-auto border-l border-line">
      <div class="section">
        <h2 class="section-title">位图字体生成</h2>
        <p class="muted">本地处理，不上传素材</p>
      </div>

      <div class="section">
        <h2 class="section-title">渲染参数</h2>
        <div class="field-row gap-3 [&_.field]:min-w-0 [&_.field]:flex-1 [&_.input]:w-full">
          <label class="field">
            <span class="field-label">字号（px）</span>
            <input v-model.number="state.sizePx" class="input" type="number" min="6" max="256" />
          </label>
          <label class="field">
            <span class="field-label">留白（px）</span>
            <input v-model.number="state.padding" class="input" type="number" min="0" max="8" />
          </label>
        </div>
        <label class="field mt-3">
          <span class="field-label">字形表示</span>
          <select v-model="state.mode" class="select w-full">
            <option value="bitmap">位图（覆盖度 alpha）</option>
            <option value="sdf">SDF 距离场（单通道）</option>
            <option value="msdf">MSDF（RGB 三通道，保尖角）</option>
            <option value="mtsdf">MTSDF（RGB + alpha 单通道）</option>
          </select>
        </label>
        <template v-if="isDistanceFieldMode(state.mode)">
          <div class="field-row mt-3 gap-3 [&_.field]:min-w-0 [&_.field]:flex-1 [&_.input]:w-full">
            <label class="field">
              <span class="field-label">Distance Range（px）</span>
              <input v-model.number="state.sdfSpread" class="input" type="number" min="1" max="32" />
            </label>
            <label class="field">
              <span class="field-label">着色阈值</span>
              <input v-model.number="state.sdfThreshold" class="input" type="number" min="0" max="1" step="0.05" />
            </label>
          </div>
          <p class="muted">Range 越大缩放范围越宽但驻留伪影越明显，游戏 UI 常用 4–8px；阈值 0.5 为标准边界。</p>
        </template>
        <p v-else class="muted">位图模式边缘最锐利，但只适合按生成字号 1:1 使用。</p>

        <div class="field-row mt-3 gap-3 [&_.field]:min-w-0 [&_.field]:flex-1 [&_.input]:w-full">
          <label class="field">
            <span class="field-label">字间距（px）</span>
            <input v-model.number="state.letterSpacing" class="input" type="number" min="-8" max="16" />
          </label>
          <label class="field">
            <span class="field-label">行间距（px）</span>
            <input v-model.number="state.lineSpacing" class="input" type="number" min="-16" max="32" />
          </label>
        </div>
        <p class="muted">字间距叠加到每个字形的步进上；行间距叠加到行高上（lineHeight = ascent + descent + 行间距）。</p>
      </div>

      <div v-if="metrics" class="section">
        <h2 class="section-title">字体度量</h2>
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-caption [&_.mono]:text-right">
          <span class="faint">Ascent</span><span class="mono">{{ metrics.ascent }}px</span>
          <span class="faint">Descent</span><span class="mono">{{ metrics.descent }}px</span>
          <span class="faint">Base</span><span class="mono">{{ metrics.base }}px</span>
          <span class="faint">Line Height</span><span class="mono">{{ metrics.lineHeight }}px</span>
          <span class="faint">Letter / Line</span><span class="mono">{{ metrics.letterSpacing }} / {{ metrics.lineSpacing }}px</span>
          <span class="faint">已排除</span><span class="mono">{{ metrics.excluded }} 个字形</span>
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">图集尺寸</h2>
        <label class="field">
          <span class="field-label">单页最大边长</span>
          <select v-model.number="state.maxAtlasSize" class="select w-full">
            <option :value="512">512</option>
            <option :value="1024">1024</option>
            <option :value="2048">2048</option>
            <option :value="4096">4096</option>
          </select>
        </label>
        <label class="check-row mt-3"><input v-model="state.powerOfTwo" type="checkbox" /> 宽高取 2 的幂</label>
        <p class="muted">放不下的字形自动溢出到下一页，各页尺寸保持一致。</p>
      </div>

      <div class="section">
        <h2 class="section-title">字形效果</h2>
        <template v-if="state.mode === 'bitmap'">
          <div class="field-row gap-3 [&_.field]:min-w-0 [&_.field]:flex-1 [&_.input]:w-full">
            <label class="field">
              <span class="field-label">描边宽度（px）</span>
              <input v-model.number="state.strokeWidth" class="input" type="number" min="0" max="8" />
            </label>
            <label class="field">
              <span class="field-label">描边颜色</span>
              <input v-model="state.strokeColor" class="input h-7.5 w-full p-0.5" type="color" />
            </label>
          </div>
          <label class="check-row mt-3"><input v-model="state.shadowEnabled" type="checkbox" /> 启用投影</label>
          <template v-if="state.shadowEnabled">
            <div class="field-row mt-3 gap-3 [&_.field]:min-w-0 [&_.field]:flex-1 [&_.input]:w-full">
              <label class="field">
                <span class="field-label">偏移 X / Y</span>
                <input v-model.number="state.shadowX" class="input" type="number" min="-8" max="8" />
              </label>
              <label class="field">
                <span class="field-label">&nbsp;</span>
                <input v-model.number="state.shadowY" class="input" type="number" min="-8" max="8" />
              </label>
            </div>
            <label class="field mt-3">
              <span class="field-label">投影颜色</span>
              <input v-model="state.shadowColor" class="input h-7.5 w-full p-0.5" type="color" />
            </label>
          </template>
          <p class="muted">描边与阴影在图集生成前绘制进字形像素，引擎无需再处理。</p>
        </template>
        <p v-else class="muted">距离场本身是单色场，描边与投影交给引擎 shader，不在此处烘焙。</p>
      </div>

      <div class="section">
        <h2 class="section-title">字距调整（Kerning）</h2>
        <label class="check-row"><input v-model="state.kerning" type="checkbox" /> 自动计算常见字距对</label>
        <p class="muted">按逐行墨迹范围求最小水平间隙，只对前 512 个字符计算，最多产出 4000 对。</p>
        <p v-if="built" class="badge">当前生效 {{ kernBadge.total }} 对（手动 {{ kernBadge.manual }} 对）</p>
        <div class="mt-2 grid grid-cols-[1fr_1fr_1fr_auto] gap-1">
          <input v-model="newKern.first" class="input px-1 py-0 text-center font-mono" type="text" maxlength="2" placeholder="A" />
          <input v-model="newKern.second" class="input px-1 py-0 text-center font-mono" type="text" maxlength="2" placeholder="V" />
          <input v-model.number="newKern.amount" class="input px-1 py-0 font-mono" type="number" min="-32" max="0" />
          <button class="btn" @click="addKernPair">添加</button>
        </div>
        <div v-if="state.kerningPairs.length" class="mt-2 max-h-45 divide-y divide-line overflow-auto">
          <div v-for="(pair, index) in state.kerningPairs" :key="`${pair.first}-${pair.second}`" class="grid grid-cols-[1fr_1fr_22px] items-center gap-1 py-0.5">
            <span class="mono">{{ charOf(pair.first) }}{{ charOf(pair.second) }}</span>
            <input
              class="input px-1 py-0 font-mono"
              type="number"
              :value="pair.amount"
              @change="pair.amount = Math.round(Number(inputValue($event)))"
            />
            <button class="grid size-5.5 place-items-center rounded-sm border border-line text-[12px] text-muted hover:bg-hover hover:text-ink" title="删除该字距对" @click="removeKernPair(index)">✕</button>
          </div>
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">场景预览</h2>
        <label class="field">
          <span class="field-label">模板</span>
          <select v-model="state.scene" class="select w-full">
            <option v-for="item in SCENES" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
      </div>

      <div class="section">
        <h2 class="section-title">导出</h2>
        <label class="check-row"><input v-model="state.withFnt" type="checkbox" /> BMFont 文本（.fnt）</label>
        <label class="check-row mt-2"><input v-model="state.withXml" type="checkbox" /> BMFont XML（.xml）</label>
        <label class="check-row mt-3"><input v-model="state.withJson" type="checkbox" /> JSON 元数据（.json）</label>
        <label class="field mt-3">
          <span class="field-label">文件名</span>
          <input v-model="state.name" class="input mono w-full" type="text" spellcheck="false" placeholder="font" />
        </label>
        <p class="muted">输出内容：图集 PNG + 勾选的元数据，统一打包为 ZIP。字距对写进 .fnt / .xml 的 kernings 段与 JSON。</p>
      </div>

      <div class="section flex flex-col gap-2">
        <button class="btn btn-primary w-full justify-center" :disabled="!built || exporting" @click="exportFont">
          {{ exporting ? '打包中…' : '导出字体 ZIP' }}
        </button>
        <button class="btn btn-ghost w-full justify-center" :disabled="!ready" @click="resetAll">重置</button>
        <p v-if="errorText" class="text-caption text-danger">{{ errorText }}</p>
        <p v-else-if="warnText" class="warn">{{ warnText }}</p>
        <p v-if="infoText" class="muted text-[11px]">{{ infoText }}</p>
      </div>
    </section>
  </div>
</template>