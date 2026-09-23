<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { workspace, type MatteMode } from '@/store/workspace'
import { downloadZip } from '@/core/media-export'
import { applyColorKey, solidColorKey } from '@/core/color-key'
import { removeWithImgly, removeWithTransformers, segmentWithSam, preloadMattingModel, AI_ENGINES, type MatteProgress } from '@/core/ai-matting'

const input = ref<HTMLInputElement>()
const image = ref<HTMLImageElement>()
const canvasRef = ref<HTMLElement>()
const isDragging = ref(false)
const zoomLevel = ref(1)
const panOffset = ref({ x: 0, y: 0 })
const panPointer = ref<{ id: number; x: number; y: number; startX: number; startY: number } | null>(null)
const suppressImageClick = ref(false)
const spacePanActive = ref(false)
const fitImageSize = ref({ width: 0, height: 0 })
let canvasResizeObserver: ResizeObserver | undefined
const sampling = ref(false)
const helpOpen = ref(false)
const helpButton = ref<HTMLButtonElement>()
const helpCloseButton = ref<HTMLButtonElement>()

const methodHelp = [
  { title: '自动抠图（边缘色）', kind: '颜色抠图', description: '以图像左上角像素作为背景色，并额外去除接近纯白的像素。', scene: '背景颜色比较统一、主体和背景颜色差异明显，想快速处理时。', recommendation: '不确定时可先试；背景颜色不均匀或左上角是主体时，改用纯色背景或 AI 模型。' },
  { title: '颜色抠图', kind: '颜色抠图', description: '按指定背景颜色和容差生成透明区域，并柔化边缘、抑制彩边。', scene: '绿幕、蓝幕或已知纯色背景。', recommendation: '点击“吸取背景颜色”后在图片背景处取色；背景复杂时用 ISNet 或 BiRefNet。' },
  { title: '纯色背景抠图', kind: '颜色抠图', description: '从图片四边采样背景主色，再按容差生成透明区域。', scene: '白底商品图、纯色证件照背景、背景大体均匀的批量图片。', recommendation: '边缘主体较多或背景渐变明显时，手动取色或改用 AI。' },
  { title: 'ISNet（imgly）', kind: 'AI 模型', description: '本地运行的通用前景分割模型，默认使用 FP16。', scene: '常见人像、商品和插画的快速自动抠图。', recommendation: '通用场景优先试用；速度和内存占用相对均衡。' },
  { title: 'BiRefNet', kind: 'AI 模型', description: '输出前景分割蒙版，再合成为透明 PNG；可选 FP16、FP32 或 Q8。', scene: '复杂轮廓、细节较多，需要更精细前景蒙版的图片。', recommendation: '优先试 FP16；模型较大，浏览器内存不足时改用 ISNet。' },
  { title: 'RMBG-1.4（BRIA）', kind: 'AI 模型', description: '通用显著性分割模型，输出蒙版并合成为透明 PNG。', scene: '主体明确、背景较复杂的单张图片。', recommendation: '仅限非商业用途；模型推理占用较多内存，浏览器资源不足时改用 ISNet。' },
  { title: 'SAM 框选分割', kind: '交互分割', description: '用多个框选区域和前景/背景提示点引导模型分割，框选区域会合并。', scene: '只想保留画面中的特定对象，或一张图里有多个需要保留的区域。', recommendation: '先框住目标；漏选时追加框或前景点，误选背景时添加背景点。操作错误可用撤销；缩放后按住空格拖动画布。' },
]

async function openHelp(): Promise<void> {
  helpOpen.value = true
  await nextTick()
  helpCloseButton.value?.focus()
}

function closeHelp(): void {
  helpOpen.value = false
  void nextTick(() => helpButton.value?.focus())
}

// SAM 交互状态
const samDragging = ref(false)
const samStart = ref<{ x: number; y: number } | null>(null)
const samDrag = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
const samHistory = ref<Array<'box' | 'point'>>([])
const maskUrl = ref('')
const showMask = ref(false)
const displayRect = ref({ left: 0, top: 0, width: 0, height: 0 })
type ModelState = 'unknown' | 'loading' | 'ready' | 'error'
const modelStates = reactive<Record<string, { state: ModelState; message?: string }>>({})

const modeOptions: { value: MatteMode; label: string }[] = [
  { value: 'auto', label: '自动抠图（边缘色）' },
  { value: 'color', label: '颜色抠图' },
  { value: 'solid', label: '纯色背景抠图' },
  { value: 'imgly', label: 'ISNet（imgly）' },
  { value: 'birefnet', label: 'BiRefNet' },
  { value: 'rmbg', label: 'RMBG-1.4（BRIA）' },
  { value: 'sam', label: 'SAM 框选分割' },
]

const samTools: { value: 'box' | 'fg' | 'bg'; label: string }[] = [
  { value: 'box', label: '框选' },
  { value: 'fg', label: '前景点' },
  { value: 'bg', label: '背景点' },
]

const backgroundOptions: { value: 'checker' | 'white' | 'black' | 'original'; label: string }[] = [
  { value: 'checker', label: '棋盘格' },
  { value: 'white', label: '白底' },
  { value: 'black', label: '黑底' },
  { value: 'original', label: '原图' },
]

function setBackground(value: 'checker' | 'white' | 'black' | 'original'): void {
  workspace.matte.background = value
}

const isAiMode = computed(() => ['imgly', 'birefnet', 'rmbg', 'sam'].includes(workspace.matte.mode))
const canPanImage = computed(() => Boolean(workspace.matte.sourceUrl) && (workspace.matte.mode !== 'sam' || spacePanActive.value))
const zoomPercent = computed(() => `${Math.round(zoomLevel.value * 100)}%`)
const imageViewStyle = computed(() => ({ width: fitImageSize.value.width ? `${fitImageSize.value.width}px` : 'auto', height: fitImageSize.value.height ? `${fitImageSize.value.height}px` : 'auto', transform: `translate3d(${panOffset.value.x}px, ${panOffset.value.y}px, 0) scale(${zoomLevel.value})` }))
const runDisabled = computed(() => !workspace.matte.sourceUrl || workspace.matte.status === 'processing' || (workspace.matte.mode === 'sam' && !workspace.matte.samBoxes.length && !workspace.matte.samPoints.length))
const undoSamDisabled = computed(() => workspace.matte.status === 'processing' || (!samHistory.value.length && !samDragging.value))
const selectedModelKey = computed(() => {
  const mode = workspace.matte.mode
  if (mode === 'imgly') return `imgly|${workspace.matte.imglyModel}|${workspace.matte.aiDevice}|${workspace.matte.imglyPublicPath}`
  if (mode === 'birefnet') return `birefnet|${workspace.matte.birefnetModelId}|${workspace.matte.aiDtype}|${workspace.matte.aiDevice}|${workspace.matte.aiModelHost}`
  if (mode === 'rmbg') return `rmbg|${workspace.matte.rmbgModelId}|${workspace.matte.aiDtype}|${workspace.matte.aiDevice}|${workspace.matte.aiModelHost}`
  if (mode === 'sam') return `sam|${workspace.matte.samModelId}|${workspace.matte.aiDevice}|${workspace.matte.aiModelHost}`
  return ''
})
const selectedModelState = computed(() => selectedModelKey.value ? (modelStates[selectedModelKey.value]?.state ?? 'unknown') : 'unknown')

function modelStateLabel(state: ModelState): string {
  return state === 'ready' ? '已加载' : state === 'loading' ? '加载中…' : state === 'error' ? '加载失败' : '未加载'
}

function modelStateForEngine(engine: (typeof AI_ENGINES)[number]['key']): ModelState {
  const mode = workspace.matte.mode
  if (mode !== engine) return 'unknown'
  return selectedModelState.value
}

function setModelState(key: string, state: ModelState, message?: string): void {
  modelStates[key] = { state, message }
}

async function preloadSelectedModel(): Promise<void> {
  const mode = workspace.matte.mode
  if (!['imgly', 'birefnet', 'rmbg', 'sam'].includes(mode)) return
  const key = selectedModelKey.value
  if (!key || modelStates[key]?.state === 'loading' || modelStates[key]?.state === 'ready') return
  setModelState(key, 'loading')
  workspace.matte.aiStatus = '准备模型…'
  workspace.matte.aiProgress = -1
  const onProgress = (progress: MatteProgress): void => {
    workspace.matte.aiStatus = progress.text
    workspace.matte.aiProgress = progress.percent ?? -1
  }
  try {
    if (mode === 'imgly') await preloadMattingModel({ engine: 'imgly', model: workspace.matte.imglyModel, device: workspace.matte.aiDevice, maxSide: 1, publicPath: workspace.matte.imglyPublicPath || undefined, onProgress })
    else if (mode === 'birefnet' || mode === 'rmbg') await preloadMattingModel({ engine: mode, modelId: mode === 'birefnet' ? workspace.matte.birefnetModelId : workspace.matte.rmbgModelId, dtype: workspace.matte.aiDtype, device: workspace.matte.aiDevice, modelHost: workspace.matte.aiModelHost, maxSide: workspace.matte.aiMaxSide, onProgress })
    else await preloadMattingModel({ engine: 'sam', modelId: workspace.matte.samModelId, device: workspace.matte.aiDevice, modelHost: workspace.matte.aiModelHost, boxes: [], points: [], maxSide: workspace.matte.aiMaxSide, onProgress })
    setModelState(key, 'ready')
    workspace.matte.aiStatus = '模型已加载，可直接开始处理'
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型加载失败'
    setModelState(key, 'error', message)
    workspace.matte.aiStatus = message
  } finally {
    workspace.matte.aiProgress = -1
  }
}

const backgroundStyle = computed(() => {
  const background = workspace.matte.background
  if (background === 'checker') return { backgroundImage: 'linear-gradient(45deg, #232734 25%, transparent 25%), linear-gradient(-45deg, #232734 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #232734 75%), linear-gradient(-45deg, transparent 75%, #232734 75%)', backgroundSize: '24px 24px', backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0px' }
  if (background === 'white') return { background: '#fff' }
  if (background === 'black') return { background: '#000' }
  return { background: '#101217' }
})

function setSamTool(tool: 'box' | 'fg' | 'bg'): void {
  workspace.matte.samTool = tool
}

function openFile(): void { input.value?.click() }

function load(file?: File): void {
  if (!file || !file.type.startsWith('image/')) return
  if (workspace.matte.sourceUrl) URL.revokeObjectURL(workspace.matte.sourceUrl)
  workspace.matte.fileName = file.name
  workspace.matte.sourceUrl = URL.createObjectURL(file)
  workspace.matte.resultUrl = ''
  workspace.matte.sampledColor = ''
  workspace.matte.samBoxes = []
  workspace.matte.samPoints = []
  samHistory.value = []
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
  maskUrl.value = ''
  showMask.value = false
  workspace.matte.status = 'ready'
  resetView()
  void nextTick(updateDisplayRect)
}

function resetView(): void {
  zoomLevel.value = 1
  panOffset.value = { x: 0, y: 0 }
  panPointer.value = null
  suppressImageClick.value = false
  fitImageToCanvas(true)
}

function fitImageToCanvas(resetZoom = false): void {
  const img = image.value
  const canvas = canvasRef.value
  if (!img?.naturalWidth || !img.naturalHeight || !canvas?.clientWidth || !canvas.clientHeight) return
  const scale = Math.min(canvas.clientWidth / img.naturalWidth, canvas.clientHeight / img.naturalHeight, 1)
  fitImageSize.value = {
    width: Math.max(1, Math.round(img.naturalWidth * scale)),
    height: Math.max(1, Math.round(img.naturalHeight * scale)),
  }
  if (resetZoom) {
    zoomLevel.value = 1
    panOffset.value = { x: 0, y: 0 }
  }
  void nextTick(updateDisplayRect)
}

function applyZoom(nextZoom: number, localX?: number, localY?: number): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const bounds = canvas.getBoundingClientRect()
  const centerX = (localX ?? bounds.width / 2) - bounds.width / 2
  const centerY = (localY ?? bounds.height / 2) - bounds.height / 2
  const oldZoom = zoomLevel.value
  const newZoom = Math.min(8, Math.max(0.2, nextZoom))
  panOffset.value = {
    x: centerX - ((centerX - panOffset.value.x) / oldZoom) * newZoom,
    y: centerY - ((centerY - panOffset.value.y) / oldZoom) * newZoom,
  }
  zoomLevel.value = newZoom
  void nextTick(updateDisplayRect)
}

function zoomIn(): void { applyZoom(zoomLevel.value * 1.2) }
function zoomOut(): void { applyZoom(zoomLevel.value / 1.2) }

function zoomAtPointer(event: WheelEvent): void {
  if (!workspace.matte.sourceUrl) return
  const bounds = canvasRef.value?.getBoundingClientRect()
  if (!bounds) return
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
  applyZoom(zoomLevel.value * factor, event.clientX - bounds.left, event.clientY - bounds.top)
}

function onPanStart(event: PointerEvent): void {
  const isSamPan = workspace.matte.mode === 'sam' && spacePanActive.value
  const startedOnImage = event.target === image.value || (event.target instanceof Element && Boolean(event.target.closest('.sam-overlay')))
  if (event.button !== 0 || event.pointerType !== 'mouse' || !startedOnImage) return
  if (workspace.matte.mode === 'sam' && !isSamPan) return
  panPointer.value = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: panOffset.value.x, startY: panOffset.value.y }
  suppressImageClick.value = false
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPanMove(event: PointerEvent): void {
  const active = panPointer.value
  if (!active || active.id !== event.pointerId) return
  const dx = event.clientX - active.x
  const dy = event.clientY - active.y
  if (Math.abs(dx) + Math.abs(dy) > 3) suppressImageClick.value = true
  panOffset.value = { x: active.startX + dx, y: active.startY + dy }
  void nextTick(updateDisplayRect)
}

function onPanEnd(event: PointerEvent): void {
  if (panPointer.value?.id !== event.pointerId) return
  panPointer.value = null
}

function handleDrop(event: DragEvent): void {
  isDragging.value = false
  load(event.dataTransfer?.files[0])
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('生成图片失败'))), 'image/png')
  })
}

/** 本地颜色类抠图统一入口：solid 走边缘主色采样，color/auto 走基准色 */
async function runColorKey(mode: 'auto' | 'color' | 'solid', img: HTMLImageElement): Promise<{ blob: Blob; baseColor?: string }> {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let baseColor: string | undefined
  if (mode === 'solid') {
    const base = solidColorKey(data, workspace.matte.tolerance)
    baseColor = `#${toHex(base.r)}${toHex(base.g)}${toHex(base.b)}`
    workspace.matte.aiStatus = `基准色 ${baseColor}`
  } else if (mode === 'color') {
    let baseR = data.data[0]
    let baseG = data.data[1]
    let baseB = data.data[2]
    const sampled = workspace.matte.sampledColor.match(/^#([0-9a-f]{6})$/i)
    if (sampled) {
      baseR = Number.parseInt(sampled[1].slice(0, 2), 16)
      baseG = Number.parseInt(sampled[1].slice(2, 4), 16)
      baseB = Number.parseInt(sampled[1].slice(4, 6), 16)
    }
    applyColorKey(data, { r: baseR, g: baseG, b: baseB, tolerance: workspace.matte.tolerance, removeWhite: false })
  } else {
    applyColorKey(data, { r: data.data[0], g: data.data[1], b: data.data[2], tolerance: workspace.matte.tolerance, removeWhite: true })
  }
  ctx.putImageData(data, 0, 0)
  return { blob: await canvasToBlob(canvas), baseColor }
}

async function cropBlob(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve, reject) => {
      const source = new Image()
      source.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = source.naturalWidth
        canvas.height = source.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(source, 0, 0)
        cropAlpha(canvas)
        canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('裁切透明边缘失败'))), 'image/png')
      }
      source.onerror = () => reject(new Error('裁切透明边缘失败'))
      source.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function runMatte(): Promise<void> {
  const img = image.value
  if (!workspace.matte.sourceUrl || !img) return
  const modelKey = selectedModelKey.value
  workspace.matte.status = 'processing'
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  const onProgress = (progress: MatteProgress): void => {
    workspace.matte.aiStatus = progress.text
    workspace.matte.aiProgress = progress.percent ?? -1
  }
  try {
    const mode = workspace.matte.mode
    let blob: Blob | null = null
    let baseColor: string | undefined
    if (mode === 'color' || mode === 'auto' || mode === 'solid') {
      const result = await runColorKey(mode, img)
      blob = result.blob
      baseColor = result.baseColor
    } else if (mode === 'imgly') {
      const result = await removeWithImgly(img, { model: workspace.matte.imglyModel, device: workspace.matte.aiDevice, maxSide: workspace.matte.aiMaxSide, publicPath: workspace.matte.imglyPublicPath || undefined, onProgress })
      blob = result.blob
    } else if (mode === 'birefnet' || mode === 'rmbg') {
      const result = await removeWithTransformers(img, { modelId: mode === 'birefnet' ? workspace.matte.birefnetModelId : workspace.matte.rmbgModelId, dtype: workspace.matte.aiDtype, device: workspace.matte.aiDevice, modelHost: workspace.matte.aiModelHost, maxSide: workspace.matte.aiMaxSide, onProgress })
      blob = result.blob
    } else if (mode === 'sam') {
      const result = await segmentWithSam(img, { modelId: workspace.matte.samModelId, device: workspace.matte.aiDevice, modelHost: workspace.matte.aiModelHost, boxes: workspace.matte.samBoxes, points: workspace.matte.samPoints, maxSide: workspace.matte.aiMaxSide, onProgress })
      blob = result.blob
      if (result.maskBlob) {
        if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
        maskUrl.value = URL.createObjectURL(result.maskBlob)
        showMask.value = true
      }
    }
    if (!blob) throw new Error('未生成结果')
    const resultBlob = workspace.matte.cropTransparent ? await cropBlob(blob) : blob
    if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
    workspace.matte.resultUrl = URL.createObjectURL(resultBlob)
    workspace.matte.status = 'done'
    workspace.matte.aiStatus = baseColor ? `完成 · 基准色 ${baseColor}` : '完成'
    if (modelKey) setModelState(modelKey, 'ready')
  } catch (error) {
    console.error('抠图处理失败', error)
    workspace.matte.status = 'error'
    const message = error instanceof Error ? error.message : '处理失败'
    workspace.matte.aiStatus = /bad_alloc|allocation failed/i.test(message)
      ? '浏览器可用内存不足，建议改用 ISNet 或关闭其他占用较大的页面后重试'
      : message
  } finally {
    workspace.matte.aiProgress = -1
  }
}

function sampleColor(event: MouseEvent): void {
  if (suppressImageClick.value) {
    suppressImageClick.value = false
    return
  }
  if (!sampling.value || !image.value) return
  const source = new Image()
  source.onload = () => {
    const bounds = image.value!.getBoundingClientRect()
    const x = Math.max(0, Math.min(source.naturalWidth - 1, Math.floor((event.clientX - bounds.left) / bounds.width * source.naturalWidth)))
    const y = Math.max(0, Math.min(source.naturalHeight - 1, Math.floor((event.clientY - bounds.top) / bounds.height * source.naturalHeight)))
    const canvas = document.createElement('canvas'); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight
    const ctx = canvas.getContext('2d')!; ctx.drawImage(source, 0, 0)
    const pixel = ctx.getImageData(x, y, 1, 1).data
    workspace.matte.sampledColor = `#${[pixel[0], pixel[1], pixel[2]].map(toHex).join('')}`
    sampling.value = false
  }
  source.src = workspace.matte.sourceUrl
}

function cropAlpha(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!; const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) if (pixels[(y * canvas.width + x) * 4 + 3] > 10) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  if (maxX < minX) return
  const trimmed = document.createElement('canvas'); trimmed.width = maxX - minX + 1; trimmed.height = maxY - minY + 1
  trimmed.getContext('2d')!.drawImage(canvas, minX, minY, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height)
  canvas.width = trimmed.width; canvas.height = trimmed.height; canvas.getContext('2d')!.drawImage(trimmed, 0, 0)
}

function download(): void {
  if (!workspace.matte.resultUrl) return
  const link = document.createElement('a'); link.href = workspace.matte.resultUrl; link.download = `${workspace.matte.fileName.replace(/\.[^.]+$/, '')}-cutout.png`; link.click()
}

function resetMatte(): void {
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
  workspace.matte.resultUrl = ''
  maskUrl.value = ''
  showMask.value = false
  workspace.matte.mode = 'auto'
  workspace.matte.tolerance = 24
  workspace.matte.cropTransparent = true
  workspace.matte.sampledColor = ''
  workspace.matte.samBoxes = []
  workspace.matte.samPoints = []
  samHistory.value = []
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  sampling.value = false
  workspace.matte.status = workspace.matte.sourceUrl ? 'ready' : 'empty'
}

async function exportPackage(): Promise<void> {
  if (!workspace.matte.resultUrl) return
  const response = await fetch(workspace.matte.resultUrl); const blob = await response.blob()
  const mode = workspace.matte.mode
  const config: Record<string, unknown> = { mode, cropTransparent: workspace.matte.cropTransparent }
  if (mode === 'color' || mode === 'auto' || mode === 'solid') config.tolerance = workspace.matte.tolerance
  if (mode === 'color') config.sampledColor = workspace.matte.sampledColor
  if (mode === 'imgly') { config.engine = 'imgly'; config.model = workspace.matte.imglyModel; config.publicPath = workspace.matte.imglyPublicPath || undefined }
  if (mode === 'birefnet' || mode === 'rmbg') { config.engine = mode; config.modelId = mode === 'birefnet' ? workspace.matte.birefnetModelId : workspace.matte.rmbgModelId; config.dtype = workspace.matte.aiDtype }
  if (mode === 'sam') { config.engine = 'sam'; config.modelId = workspace.matte.samModelId; config.boxes = workspace.matte.samBoxes; config.points = workspace.matte.samPoints }
  if (['imgly', 'birefnet', 'rmbg', 'sam'].includes(mode)) { config.device = workspace.matte.aiDevice; config.maxSide = workspace.matte.aiMaxSide; config.modelHost = workspace.matte.aiModelHost }
  await downloadZip([{ name: `${workspace.matte.fileName.replace(/\.[^.]+$/, '')}-cutout.png`, blob }, { name: 'config.json', blob: JSON.stringify(config, null, 2) }], `${workspace.matte.fileName.replace(/\.[^.]+$/, '')}-cutout.zip`)
}

// ---- SAM 框选交互 ----

function updateDisplayRect(): void {
  const img = image.value
  const canvasEl = canvasRef.value
  if (!img || !canvasEl) return
  const ib = img.getBoundingClientRect()
  const cb = canvasEl.getBoundingClientRect()
  displayRect.value = { left: ib.left - cb.left, top: ib.top - cb.top, width: ib.width, height: ib.height }
}

function naturalFromEvent(event: MouseEvent): { x: number; y: number } | null {
  const img = image.value
  if (!img) return null
  const bounds = img.getBoundingClientRect()
  const x = Math.round(((event.clientX - bounds.left) / bounds.width) * img.naturalWidth)
  const y = Math.round(((event.clientY - bounds.top) / bounds.height) * img.naturalHeight)
  if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null
  return { x, y }
}

function onSamDown(event: MouseEvent): void {
  if (workspace.matte.mode !== 'sam' || workspace.matte.status === 'processing' || panPointer.value) return
  const pos = naturalFromEvent(event)
  if (!pos) return
  if (workspace.matte.samTool === 'box') {
    samStart.value = pos
    samDragging.value = true
  } else {
    workspace.matte.samPoints.push({ x: pos.x, y: pos.y, label: workspace.matte.samTool === 'fg' ? 1 : 0 })
    samHistory.value.push('point')
    invalidateSamResult()
  }
}

function onSamMove(event: MouseEvent): void {
  if (!samDragging.value || !samStart.value) return
  const pos = naturalFromEvent(event)
  if (!pos) return
  samDrag.value = {
    x1: Math.min(samStart.value.x, pos.x),
    y1: Math.min(samStart.value.y, pos.y),
    x2: Math.max(samStart.value.x, pos.x),
    y2: Math.max(samStart.value.y, pos.y),
  }
}

function onSamUp(): void {
  if (!samDragging.value) return
  const drag = samDrag.value
  if (drag && (drag.x2 > drag.x1 || drag.y2 > drag.y1)) {
    workspace.matte.samBoxes.push(drag)
    samHistory.value.push('box')
    invalidateSamResult()
  }
  samDragging.value = false
  samStart.value = null
  samDrag.value = null
}

function invalidateSamResult(): void {
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
  workspace.matte.resultUrl = ''
  maskUrl.value = ''
  showMask.value = false
  workspace.matte.aiStatus = ''
  workspace.matte.status = workspace.matte.sourceUrl ? 'ready' : 'empty'
}

function undoSam(): void {
  if (workspace.matte.status === 'processing') return
  if (samDragging.value) {
    samDragging.value = false
    samStart.value = null
    samDrag.value = null
    return
  }
  const lastAction = samHistory.value.pop()
  if (!lastAction) return
  if (lastAction === 'box') workspace.matte.samBoxes.pop()
  else workspace.matte.samPoints.pop()
  invalidateSamResult()
}

function onSamKeyDown(event: KeyboardEvent): void {
  if (helpOpen.value && event.key === 'Escape') {
    event.preventDefault()
    closeHelp()
    return
  }
  const isUndo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey
  if (!isUndo || workspace.matte.mode !== 'sam' || undoSamDisabled.value) return
  const target = event.target
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return
  event.preventDefault()
  undoSam()
}

function onWindowKeyDown(event: KeyboardEvent): void {
  const target = event.target
  const isEditing = target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')
  const isInteractive = target instanceof HTMLElement && target.closest('button, a, select, input, textarea, [contenteditable="true"]')
  if (event.code === 'Space' && workspace.matte.mode === 'sam' && !helpOpen.value && !isEditing && !isInteractive) {
    spacePanActive.value = true
    event.preventDefault()
    return
  }
  onSamKeyDown(event)
}

function onWindowKeyUp(event: KeyboardEvent): void {
  if (event.code === 'Space') spacePanActive.value = false
}

function onWindowBlur(): void {
  spacePanActive.value = false
  panPointer.value = null
}

function clearSam(): void {
  workspace.matte.samBoxes = []
  workspace.matte.samPoints = []
  samHistory.value = []
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
  maskUrl.value = ''
  showMask.value = false
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  workspace.matte.resultUrl = ''
  workspace.matte.status = workspace.matte.sourceUrl ? 'ready' : 'empty'
}

function boxStyle(box: { x1: number; y1: number; x2: number; y2: number }): Record<string, string> {
  const img = image.value
  if (!img || !displayRect.value.width) return {}
  const sx = displayRect.value.width / img.naturalWidth
  const sy = displayRect.value.height / img.naturalHeight
  return { left: `${box.x1 * sx}px`, top: `${box.y1 * sy}px`, width: `${(box.x2 - box.x1) * sx}px`, height: `${(box.y2 - box.y1) * sy}px` }
}

function pointStyle(point: { x: number; y: number }): Record<string, string> {
  const img = image.value
  if (!img || !displayRect.value.width) return {}
  return { left: `${(point.x / img.naturalWidth) * displayRect.value.width}px`, top: `${(point.y / img.naturalHeight) * displayRect.value.height}px` }
}

function onWindowResize(): void {
  fitImageToCanvas()
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('keydown', onWindowKeyDown)
  window.addEventListener('keyup', onWindowKeyUp)
  window.addEventListener('blur', onWindowBlur)
  if (canvasRef.value) {
    canvasResizeObserver = new ResizeObserver(() => fitImageToCanvas())
    canvasResizeObserver.observe(canvasRef.value)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('keydown', onWindowKeyDown)
  window.removeEventListener('keyup', onWindowKeyUp)
  window.removeEventListener('blur', onWindowBlur)
  canvasResizeObserver?.disconnect()
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
})
</script>

<template>
  <div class="tool-page">
    <section class="tool-sidebar panel">
      <div class="section"><h2 class="section-title">抠图工具</h2><p class="muted">本地处理，不上传素材</p></div>
      <div class="section">
        <button class="btn btn-primary full" @click="openFile">导入图片</button>
        <input ref="input" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="load(($event.target as HTMLInputElement).files?.[0])" />
      </div>
      <div class="section">
        <div class="method-title-row">
          <h2 class="section-title">处理方式</h2>
          <button ref="helpButton" class="help-button" type="button" aria-label="查看处理方式说明和推荐" title="处理方式说明和推荐" @click="openHelp">?</button>
        </div>
        <select v-model="workspace.matte.mode" class="select full">
          <option v-for="option in modeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <template v-if="workspace.matte.mode === 'color'">
          <button class="btn full" :class="{ 'btn-primary': sampling }" @click="sampling = !sampling">{{ sampling ? '请点击图片取色' : '吸取背景颜色' }}</button>
          <div v-if="workspace.matte.sampledColor" class="sampled-color"><span class="color-chip" :style="{ background: workspace.matte.sampledColor }"></span><span>已取色 {{ workspace.matte.sampledColor }}</span><button class="btn-icon" title="清除取色" @click="workspace.matte.sampledColor = ''">×</button></div>
        </template>
        <template v-if="workspace.matte.mode === 'color' || workspace.matte.mode === 'solid'">
          <label class="field"><span class="field-label">颜色容差 {{ workspace.matte.tolerance }}</span><input v-model.number="workspace.matte.tolerance" class="range" type="range" min="1" max="100" /></label>
          <p v-if="workspace.matte.mode === 'solid'" class="muted">自动采样图像边缘主色作为背景基准，适合纯色背景</p>
        </template>
        <template v-if="isAiMode && workspace.matte.mode !== 'sam'">
          <div v-if="workspace.matte.mode === 'rmbg'" class="warn">⚠️ RMBG 仅供评估，不可商用</div>
          <label v-if="workspace.matte.mode === 'imgly'" class="field"><span class="field-label">模型</span>
            <select v-model="workspace.matte.imglyModel" class="select">
              <option value="isnet_fp16">ISNet FP16（推荐）</option>
              <option value="isnet">ISNet 原版</option>
              <option value="isnet_quint8">ISNet 量化（最快）</option>
            </select>
          </label>
          <label v-if="workspace.matte.mode === 'imgly'" class="field"><span class="field-label">资源地址（publicPath）</span><input v-model="workspace.matte.imglyPublicPath" class="input" type="text" placeholder="留空使用官方 CDN" /></label>
          <template v-if="workspace.matte.mode === 'birefnet' || workspace.matte.mode === 'rmbg'">
            <label class="field"><span class="field-label">模型 ID</span>
              <input v-if="workspace.matte.mode === 'birefnet'" v-model="workspace.matte.birefnetModelId" class="input" type="text" />
              <input v-else v-model="workspace.matte.rmbgModelId" class="input" type="text" />
            </label>
            <label class="field"><span class="field-label">精度</span>
              <select v-model="workspace.matte.aiDtype" class="select" title="FP16 是推荐默认值，可降低浏览器内存占用；FP32 最吃内存；Q8 仅适用于模型提供量化权重的情况">
                <option value="fp16">FP16 半精度（推荐，内存更友好）</option>
                <option value="fp32">FP32 高精度（兼容性广，最吃内存）</option>
                <option value="q8">Q8 量化（较快较省内存，需模型提供量化权重）</option>
              </select>
            </label>
          </template>
          <label class="field"><span class="field-label">模型源</span>
            <select v-model="workspace.matte.aiModelHost" class="select">
              <option value="huggingface.co">HuggingFace（默认）</option>
              <option value="hf-mirror.com">国内镜像 hf-mirror.com</option>
            </select>
          </label>
          <label class="field"><span class="field-label">运行设备</span>
            <select v-model="workspace.matte.aiDevice" class="select">
              <option value="cpu">CPU（WASM，通用）</option>
              <option value="gpu">GPU（WebGPU，需浏览器支持）</option>
            </select>
          </label>
          <label class="field"><span class="field-label">最大边长</span>
            <select v-model.number="workspace.matte.aiMaxSide" class="select">
              <option :value="0">原图尺寸</option>
              <option :value="1024">1024px</option>
              <option :value="768">768px</option>
              <option :value="512">512px（最快）</option>
            </select>
          </label>
        </template>
        <template v-if="workspace.matte.mode === 'sam'">
          <div class="seg">
            <button v-for="tool in samTools" :key="tool.value" class="seg-item" :class="{ active: workspace.matte.samTool === tool.value }" @click="setSamTool(tool.value)">{{ tool.label }}</button>
          </div>
          <p class="muted">框选多个区域可一起分割；前景点=保留，背景点=排除</p>
          <div class="model-row"><span>已框选 {{ workspace.matte.samBoxes.length }} 区域</span><span class="badge badge-accent">{{ workspace.matte.samPoints.length }} 提示点</span></div>
          <div class="sam-actions">
            <button class="btn" :disabled="undoSamDisabled" title="撤销最近添加的框或提示点（⌘Z / Ctrl+Z）" @click="undoSam">撤销上一步</button>
            <button class="btn" :disabled="workspace.matte.status === 'processing'" @click="clearSam">清除标注</button>
          </div>
          <label class="check-row"><input v-model="showMask" type="checkbox" /> 显示分割蒙版</label>
          <img v-if="showMask && maskUrl" class="mask-thumb" :src="maskUrl" alt="分割蒙版" />
          <a v-if="workspace.matte.resultUrl" class="result-link" :href="workspace.matte.resultUrl" target="_blank" rel="noreferrer">在新标签页预览抠图结果 ↗</a>
          <label class="field"><span class="field-label">模型 ID</span><input v-model="workspace.matte.samModelId" class="input" type="text" /></label>
          <label class="field"><span class="field-label">模型源</span>
            <select v-model="workspace.matte.aiModelHost" class="select">
              <option value="huggingface.co">HuggingFace（默认）</option>
              <option value="hf-mirror.com">国内镜像 hf-mirror.com</option>
            </select>
          </label>
          <label class="field"><span class="field-label">运行设备</span>
            <select v-model="workspace.matte.aiDevice" class="select">
              <option value="cpu">CPU（WASM，通用）</option>
              <option value="gpu">GPU（WebGPU，需浏览器支持）</option>
            </select>
          </label>
          <label class="field"><span class="field-label">最大边长</span>
            <select v-model.number="workspace.matte.aiMaxSide" class="select">
              <option :value="0">自动限制 1024px</option>
              <option :value="1024">1024px</option>
              <option :value="768">768px</option>
              <option :value="512">512px（最快）</option>
            </select>
          </label>
          <p class="muted">SAM 默认最多以 1024px 推理并输出，避免大图耗尽浏览器内存；标注坐标会自动换算。</p>
        </template>
        <label class="check-row"><input v-model="workspace.matte.cropTransparent" type="checkbox" /> 自动裁切透明边缘</label>
      </div>
      <div class="section">
        <h2 class="section-title">模型状态</h2>
        <div v-for="engine in AI_ENGINES" :key="engine.key" class="model-row">
          <span :title="engine.description">{{ engine.label }} <span class="muted">{{ engine.size }}</span></span>
          <span class="badge" :class="{ 'badge-accent': workspace.matte.mode === engine.key }">{{ workspace.matte.mode === engine.key ? modelStateLabel(modelStateForEngine(engine.key)) : engine.license }}</span>
        </div>
        <button v-if="isAiMode" class="btn full preload-button" :disabled="selectedModelState === 'loading' || selectedModelState === 'ready'" @click="preloadSelectedModel">{{ selectedModelState === 'ready' ? '模型已加载' : '预加载当前模型' }}</button>
        <p v-if="isAiMode" class="muted model-state-hint">“未加载”表示当前页面还没初始化模型；预加载会优先复用浏览器缓存或本地模型目录。</p>
        <div v-if="workspace.matte.aiStatus" class="ai-status">
          <p class="muted">{{ workspace.matte.aiStatus }}</p>
          <div v-if="workspace.matte.aiProgress >= 0" class="progress-track"><div class="progress-fill" :style="{ width: workspace.matte.aiProgress + '%' }"></div></div>
        </div>
      </div>
      <div class="section actions">
        <button class="btn btn-primary full" :disabled="runDisabled" @click="runMatte">{{ workspace.matte.status === 'processing' ? '处理中…' : (workspace.matte.mode === 'sam' ? '开始分割' : '开始抠图') }}</button>
        <button class="btn full" :disabled="!workspace.matte.resultUrl" @click="download">导出透明 PNG</button>
        <button class="btn full" :disabled="!workspace.matte.resultUrl" @click="exportPackage">导出 PNG + 配置 ZIP</button>
        <button class="btn btn-ghost full" :disabled="!workspace.matte.sourceUrl || workspace.matte.status === 'processing'" @click="resetMatte">重置抠图</button>
      </div>
    </section>
    <main class="tool-main">
      <div class="tool-header">
        <div><h2>抠图工作区</h2><p>{{ workspace.matte.fileName || '导入一张图片开始处理' }}</p></div>
        <div class="canvas-header-actions">
          <div v-if="workspace.matte.sourceUrl" class="zoom-controls" aria-label="画布缩放控制">
            <button class="zoom-button" type="button" title="缩小" aria-label="缩小" :disabled="zoomLevel <= 0.2" @click="zoomOut">−</button>
            <output class="zoom-value" aria-live="polite">{{ zoomPercent }}</output>
            <button class="zoom-button" type="button" title="放大" aria-label="放大" :disabled="zoomLevel >= 8" @click="zoomIn">+</button>
            <button class="fit-button" type="button" title="完整适配画布" @click="resetView">适应画布</button>
          </div>
          <div class="seg"><button v-for="item in backgroundOptions" :key="item.value" class="seg-item" :class="{ active: workspace.matte.background === item.value }" @click="setBackground(item.value)">{{ item.label }}</button></div>
        </div>
      </div>
      <div ref="canvasRef" class="matte-canvas" :class="{ dragging: isDragging, 'can-pan': canPanImage, 'is-panning': !!panPointer }" :style="backgroundStyle" @dragover.prevent="isDragging = true" @dragleave="isDragging = false" @drop="handleDrop" @click="sampleColor" @wheel.prevent="zoomAtPointer" @pointerdown="onPanStart" @pointermove="onPanMove" @pointerup="onPanEnd" @pointercancel="onPanEnd">
        <div v-if="!workspace.matte.sourceUrl" class="drop-hint" @click="openFile"><span class="big">＋</span><strong>拖入图片</strong><span>PNG / JPG / WebP</span></div>
        <template v-else>
          <img ref="image" :class="{ sampling }" :style="imageViewStyle" :src="workspace.matte.mode === 'sam' ? workspace.matte.sourceUrl : (workspace.matte.resultUrl || workspace.matte.sourceUrl)" alt="预览" draggable="false" @load="fitImageToCanvas(true)" />
          <div v-if="workspace.matte.mode === 'sam'" class="sam-overlay" :class="'tool-' + workspace.matte.samTool" :style="{ left: displayRect.left + 'px', top: displayRect.top + 'px', width: displayRect.width + 'px', height: displayRect.height + 'px' }" @mousedown="onSamDown" @mousemove="onSamMove" @mouseup="onSamUp" @mouseleave="onSamUp">
            <div v-for="(box, index) in workspace.matte.samBoxes" :key="'b' + index" class="sam-box" :style="boxStyle(box)"></div>
            <div v-if="samDrag" class="sam-box sam-drag" :style="boxStyle(samDrag)"></div>
            <span v-for="(point, index) in workspace.matte.samPoints" :key="'p' + index" class="sam-point" :class="point.label === 1 ? 'fg' : 'bg'" :style="pointStyle(point)"></span>
          </div>
        </template>
      </div>
    </main>
    <div v-if="helpOpen" class="help-backdrop" @click.self="closeHelp">
      <section class="help-dialog" role="dialog" aria-modal="true" aria-labelledby="matte-help-title" aria-describedby="matte-help-intro">
        <header class="help-head">
          <div>
            <h2 id="matte-help-title">处理方式说明与推荐</h2>
            <p id="matte-help-intro">按背景特点和目标精度选择；这些抠图均在本地浏览器处理。</p>
          </div>
          <button ref="helpCloseButton" class="btn-icon help-close" type="button" aria-label="关闭说明" @click="closeHelp">×</button>
        </header>
        <div class="help-content">
          <article v-for="item in methodHelp" :key="item.title" class="help-card">
            <div class="help-card-title"><h3>{{ item.title }}</h3><span class="help-kind">{{ item.kind }}</span></div>
            <p>{{ item.description }}</p>
            <p><strong>适用场景：</strong>{{ item.scene }}</p>
            <p class="help-recommend"><strong>推荐：</strong>{{ item.recommendation }}</p>
          </article>
        </div>
        <footer class="help-foot">
          <span>快速建议：纯色背景试“纯色背景”；一般图片试 ISNet；复杂细节试 BiRefNet；指定目标区域用 SAM。</span>
          <button class="btn btn-primary" type="button" @click="closeHelp">知道了</button>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tool-page { display: grid; grid-template-columns: 280px minmax(0, 1fr); height: 100%; min-height: 0; }
.tool-sidebar { border-right: 1px solid var(--border); overflow: auto; }
.method-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.method-title-row .section-title { margin-bottom: var(--sp-2); }
.help-button { display: grid; place-items: center; width: 21px; height: 21px; flex: none; margin-top: -3px; border: 1px solid var(--border-strong); border-radius: 50%; background: transparent; color: var(--text-muted); font: 600 12px/1 var(--font-sans); cursor: pointer; }
.help-button:hover, .help-button:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }
.help-backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 24px; background: rgba(8, 10, 14, .72); }
.help-dialog { display: flex; flex-direction: column; width: min(820px, calc(100vw - 32px)); max-height: min(760px, calc(100vh - 32px)); overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-m); background: var(--surface); box-shadow: var(--shadow-pop); }
.help-head, .help-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; }
.help-head { border-bottom: 1px solid var(--border); }
.help-head h2 { margin: 0; font-size: var(--fs-head); }
.help-head p { margin: 4px 0 0; color: var(--text-muted); font-size: var(--fs-caption); }
.help-close { color: var(--text-muted); font-size: 22px; }
.help-content { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 16px 20px; overflow-y: auto; }
.help-card { min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-raised, var(--surface)); }
.help-card-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.help-card h3 { margin: 0; font-size: 14px; }
.help-kind { flex: none; padding: 2px 6px; border-radius: 999px; background: var(--surface-hover, var(--border)); color: var(--text-muted); font-size: 10px; }
.help-card p { margin: 6px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.55; }
.help-card strong { color: var(--text); font-weight: 600; }
.help-card .help-recommend { color: var(--text); }
.help-foot { border-top: 1px solid var(--border); color: var(--text-faint); font-size: 12px; }
@media (max-width: 640px) { .help-backdrop { padding: 10px; }.help-content { grid-template-columns: 1fr; padding: 12px; }.help-foot { align-items: flex-start; flex-direction: column; }.help-dialog { max-height: calc(100vh - 20px); } }
.tool-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tool-header { height: 64px; flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; border-bottom: 1px solid var(--border); }
.tool-header h2 { margin: 0; font-size: 16px; }.tool-header p { margin: 2px 0 0; color: var(--text-faint); }
.canvas-header-actions { display: flex; align-items: center; gap: 16px; }
.zoom-controls { display: flex; align-items: center; gap: 6px; padding-right: 14px; border-right: 1px solid var(--border); }
.zoom-button, .fit-button { height: 30px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-raised); color: var(--text); cursor: pointer; }
.zoom-button { width: 30px; font-size: 17px; line-height: 1; }.zoom-button:disabled { opacity: .4; cursor: default; }
.zoom-value { min-width: 46px; color: var(--text-muted); font: 12px var(--font-mono); text-align: center; }
.fit-button { padding: 0 10px; font-size: 12px; }.fit-button:hover, .zoom-button:not(:disabled):hover { border-color: var(--accent); color: var(--accent); }
.matte-canvas { flex: 1; min-height: 0; margin: 24px; display: grid; place-items: center; border: 1px solid var(--border); overflow: hidden; position: relative; }.matte-canvas.dragging { border-color: var(--accent); }.matte-canvas img { width: auto; height: auto; max-width: calc(100% - 2px); max-height: calc(100% - 2px); object-fit: contain; image-rendering: auto; transform-origin: center center; }.matte-canvas.can-pan { cursor: grab; }.matte-canvas.is-panning { cursor: grabbing; user-select: none; }.matte-canvas img.sampling { cursor: crosshair; }
.drop-hint { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--text-faint); cursor: pointer; }.drop-hint .big { font-size: 36px; color: var(--accent); }.drop-hint strong { color: var(--text); }
.full { width: 100%; justify-content: center; }.model-row { display: flex; align-items: center; gap: 8px; min-height: 32px; color: var(--text-muted); justify-content: space-between; }.range { width: 100%; accent-color: var(--accent); }.actions { display: flex; flex-direction: column; gap: 8px; }
.preload-button { margin-top: 8px; }
.model-state-hint { margin: 8px 0 0; line-height: 1.5; }
.sampling { cursor: crosshair; }.sampled-color { display:flex; align-items:center; gap:8px; color:var(--text-muted); font:12px var(--font-mono); }.color-chip { width:18px; height:18px; border:1px solid var(--border-strong); border-radius:3px; }.btn-icon { margin-left:auto; color:var(--text-faint); }
.warn { padding: 8px 10px; border: 1px solid #b45309; color: #fbbf24; background: rgba(251, 191, 36, 0.08); border-radius: 6px; font-size: 12px; margin-bottom: 8px; }
.select { width: 100%; }
.ai-status { margin-top: 8px; }.ai-status p { margin: 0 0 4px; font-size: 12px; word-break: break-all; }
.progress-track { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }.progress-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
.sam-overlay { position: absolute; z-index: 2; touch-action: none; }.sam-overlay.tool-box { cursor: crosshair; }.sam-overlay.tool-fg { cursor: pointer; }.sam-overlay.tool-bg { cursor: cell; }
.sam-box { position: absolute; border: 1.5px solid var(--accent); background: rgba(102, 192, 255, 0.15); box-sizing: border-box; }.sam-drag { border-style: dashed; }
.sam-point { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 2px rgba(0, 0, 0, 0.6); }.sam-point.fg { background: #4ade80; }.sam-point.bg { background: #f87171; }
.sam-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mask-thumb { width: 100%; border: 1px solid var(--border-strong); border-radius: 6px; margin-top: 8px; }
.result-link { display: inline-block; margin-top: 8px; color: var(--accent); font-size: 12px; text-decoration: none; }
</style>
