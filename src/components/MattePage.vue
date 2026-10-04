<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { persistMediaSettings, resetMatte as clearMatteSource, workspace, type MatteHistoryEntry, type MatteMode } from '@/store/workspace'
import { downloadZip } from '@/core/media-export'
import { applyColorKey, solidColorKey } from '@/core/color-key'
import type { ImageCropRect } from '@/core/crop'
import { removeWithImgly, removeWithTransformers, AI_ENGINES, AI_MAX_SIDE_OPTIONS, describeMattingError, deviceOptions, dtypeOptions, imglyDtypeForModel, resolveDevice, resolveDtype, type AiEngine, type MatteDtype, type MatteProgress } from '@/core/ai-matting'
import { ensureMatteModelLoaded, matteModelKey, modelStateLabel, modelStatus, setModelState, type ModelEngine, type ModelState } from '@/store/model-status'

const input = ref<HTMLInputElement>()
const image = ref<HTMLImageElement>()
/** 手动抠图的交互层，覆盖在原图上，坐标与图像像素 1:1 */
const manualOverlay = ref<HTMLCanvasElement>()
const canvasRef = ref<HTMLElement>()
const isDragging = ref(false)
const zoomLevel = ref(1)
const panOffset = ref({ x: 0, y: 0 })
const panPointer = ref<{ id: number; x: number; y: number; startX: number; startY: number } | null>(null)
const suppressImageClick = ref(false)
const fitImageSize = ref({ width: 0, height: 0 })
/** 上一次「适应画布」依据的图像原始尺寸，用于判断结果图刷新后是否需要重新适配 */
const fitNatural = ref({ width: 0, height: 0 })
let canvasResizeObserver: ResizeObserver | undefined
const sampling = ref(false)
const helpOpen = ref(false)
const helpButton = ref<HTMLButtonElement>()
const helpCloseButton = ref<HTMLButtonElement>()

const methodHelp = [
  { title: '自动抠图（边缘色）', kind: '颜色抠图', description: '以图像左上角像素作为背景色，并额外去除接近纯白的像素。', scene: '背景颜色比较统一、主体和背景颜色差异明显，想快速处理时。', recommendation: '不确定时可先试；背景颜色不均匀或左上角是主体时，改用纯色背景或 AI 模型。' },
  { title: '颜色抠图', kind: '颜色抠图', description: '按指定背景颜色和容差生成透明区域，并柔化边缘、抑制彩边。', scene: '绿幕、蓝幕或已知纯色背景。', recommendation: '点击“吸取背景颜色”后在图片背景处取色；背景复杂时用 ISNet 或 RMBG-1.4。' },
  { title: '纯色背景抠图', kind: '颜色抠图', description: '从图片四边采样背景主色，再按容差生成透明区域。', scene: '白底商品图、纯色证件照背景、背景大体均匀的批量图片。', recommendation: '边缘主体较多或背景渐变明显时，手动取色或改用 AI。' },
  { title: 'ISNet（imgly）', kind: 'AI 模型', description: '本地运行的通用前景分割模型，默认使用 FP16。', scene: '常见人像、商品和插画的快速自动抠图。', recommendation: '通用场景优先试用；速度和内存占用相对均衡。' },
  { title: 'RMBG-1.4（BRIA）', kind: 'AI 模型', description: '通用显著性分割模型，输出蒙版并合成为透明 PNG。', scene: '主体明确、背景较复杂的单张图片。', recommendation: '仅限非商业用途；模型推理占用较多内存，浏览器资源不足时改用 ISNet。' },
  { title: '手动抠图', kind: '手动', description: '画笔涂抹或框选矩形，被覆盖的像素直接变透明，不做任何颜色或模型判断。', scene: '知道该删哪一块的局部遮挡物、残留杂边、纯色底补刀。', recommendation: '始终从原图出发，结果即时生效；涂抹错了用“撤销”或“清空标记”回退。' },
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

const modeOptions: { value: MatteMode; label: string }[] = [
  { value: 'auto', label: '自动抠图（边缘色）' },
  { value: 'color', label: '颜色抠图' },
  { value: 'solid', label: '纯色背景抠图' },
  { value: 'imgly', label: 'ISNet（imgly）' },
  { value: 'rmbg', label: 'RMBG-1.4（BRIA）' },
  { value: 'manual', label: '手动抠图' },
]

/** 处理方式的中文名：历史记录里用它标注每条结果出自哪种方式 */
function modeLabelOf(mode: MatteMode): string {
  return modeOptions.find((item) => item.value === mode)?.label ?? mode
}

const backgroundOptions: { value: 'checker' | 'white' | 'black' | 'original'; label: string }[] = [
  { value: 'checker', label: '棋盘格' },
  { value: 'white', label: '白底' },
  { value: 'black', label: '黑底' },
  { value: 'original', label: '原图' },
]

function setBackground(value: 'checker' | 'white' | 'black' | 'original'): void {
  workspace.matte.background = value
}

const isAiMode = computed(() => ['imgly', 'rmbg'].includes(workspace.matte.mode))
/** 手动抠图：在画布上涂抹或框选，直接改像素，不跑模型也不做颜色判据 */
const isManual = computed(() => workspace.matte.mode === 'manual')
const canPanImage = computed(() => Boolean(workspace.matte.sourceUrl))
const zoomPercent = computed(() => `${Math.round(zoomLevel.value * 100)}%`)
const imageViewStyle = computed(() => ({ width: fitImageSize.value.width ? `${fitImageSize.value.width}px` : 'auto', height: fitImageSize.value.height ? `${fitImageSize.value.height}px` : 'auto', transform: `translate3d(${panOffset.value.x}px, ${panOffset.value.y}px, 0) scale(${zoomLevel.value})` }))
const runDisabled = computed(() => !workspace.matte.sourceUrl || workspace.matte.status === 'processing')
/** 当前处理方式对应的模型 key；非 AI 方式返回空串。key 由共享 store 生成，与视频帧一键处理弹窗一致 */
const selectedModelKey = computed(() => (isAiMode.value ? matteModelKey(workspace.matte.mode as ModelEngine) : ''))
const selectedModelState = computed<ModelState>(() => (selectedModelKey.value ? (modelStatus[selectedModelKey.value]?.state ?? 'unknown') : 'unknown'))

/** 当前 AI 引擎；颜色类抠图没有模型，返回 null */
const aiEngine = computed<AiEngine | null>(() => (isAiMode.value ? (workspace.matte.mode as AiEngine) : null))
/** 引擎实际使用的精度：ISNet 由 imglyModel 决定，其余走共享的 aiDtype */
const effectiveDtype = computed<MatteDtype>(() => {
  const mode = workspace.matte.mode
  if (mode === 'imgly') return imglyDtypeForModel(workspace.matte.imglyModel)
  return workspace.matte.aiDtype
})
/** 当前引擎可选的精度与设备选项：模型没有的精度、跑不了的设备都不出现 */
const dtypeChoices = computed(() => (aiEngine.value ? dtypeOptions(aiEngine.value) : []))
const deviceChoices = computed(() => deviceOptions(effectiveDtype.value))

/**
 * 切换处理方式或精度后，把精度与设备写回该模型真正支持的取值。
 * 例如 RMBG 选 Q8 后设备只能是 CPU；
 * 字段被隐藏时旧值仍会参与推理，所以必须写回而不能只在下拉里收敛。
 */
watch(
  () => [workspace.matte.mode, workspace.matte.aiDtype, workspace.matte.aiDevice, workspace.matte.imglyModel] as const,
  () => {
    const engine = aiEngine.value
    if (!engine) return
    if (engine === 'rmbg') {
      const dtype = resolveDtype(engine, workspace.matte.aiDtype)
      if (dtype !== workspace.matte.aiDtype) workspace.matte.aiDtype = dtype
    }
    const device = resolveDevice(effectiveDtype.value, workspace.matte.aiDevice)
    if (device !== workspace.matte.aiDevice) workspace.matte.aiDevice = device
  },
  { immediate: true },
)

/** 模型状态区展示：只有当前选中的引擎才显示真实状态，其余显示许可信息 */
function modelStateForEngine(engine: (typeof AI_ENGINES)[number]['key']): ModelState {
  if (workspace.matte.mode !== engine) return 'unknown'
  return selectedModelState.value
}

watch(
  () => ({
    mode: workspace.matte.mode,
    brushSize: workspace.matte.brushSize,
    manualTool: workspace.matte.manualTool,
    aiMaxSide: workspace.matte.aiMaxSide,
    imglyModel: workspace.matte.imglyModel,
    imglyPublicPath: workspace.matte.imglyPublicPath,
    aiDevice: workspace.matte.aiDevice,
    aiDtype: workspace.matte.aiDtype,
    aiModelHost: workspace.matte.aiModelHost,
    rmbgModelId: workspace.matte.rmbgModelId,
  }),
  () => persistMediaSettings(),
  { deep: true },
)

/** 预加载当前处理方式的模型：加载状态与进行中的 Promise 均由共享 store 管理，重复点击不会重复下载 */
async function preloadSelectedModel(): Promise<void> {
  if (!isAiMode.value) return
  workspace.matte.aiStatus = '准备模型…'
  workspace.matte.aiProgress = -1
  const onProgress = (progress: MatteProgress): void => {
    workspace.matte.aiStatus = progress.text
    workspace.matte.aiProgress = progress.percent ?? -1
  }
  try {
    await ensureMatteModelLoaded(workspace.matte.mode as ModelEngine, onProgress)
    workspace.matte.aiStatus = '模型已加载，可直接开始处理'
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型加载失败'
    workspace.matte.aiStatus = `${message}（详细信息已输出到浏览器控制台）`
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

function openFile(): void { input.value?.click() }

function load(file?: File): void {
  if (!file || !file.type.startsWith('image/')) return
  if (workspace.matte.sourceUrl) URL.revokeObjectURL(workspace.matte.sourceUrl)
  workspace.matte.fileName = file.name
  workspace.matte.sourceUrl = URL.createObjectURL(file)
  workspace.matte.resultUrl = ''
  activeHistoryId.value = ''
  workspace.matte.sampledColor = ''
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  workspace.matte.status = 'ready'
  resetView()
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
  fitNatural.value = { width: img.naturalWidth, height: img.naturalHeight }
  if (resetZoom) {
    zoomLevel.value = 1
    panOffset.value = { x: 0, y: 0 }
  }
}

/**
 * 预览图加载完成。
 * 手动涂抹时结果图会随每次落笔刷新，尺寸不变就保持当前缩放与平移，避免每涂一笔都跳回默认视图。
 */
function onPreviewLoad(): void {
  const img = image.value
  if (!img?.naturalWidth) return
  if (isManual.value && img.naturalWidth === fitNatural.value.width && img.naturalHeight === fitNatural.value.height) return
  fitImageToCanvas(true)
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
  if (event.button !== 0 || event.pointerType !== 'mouse' || event.target !== image.value) return
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
  // naturalWidth 为 0 说明预览图还在解码（刚刷新过结果），此时取像素会抛 IndexSizeError
  if (!workspace.matte.sourceUrl || !img?.naturalWidth) return
  const modelKey = selectedModelKey.value
  const mode = workspace.matte.mode
  workspace.matte.status = 'processing'
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  const onProgress = (progress: MatteProgress): void => {
    workspace.matte.aiStatus = progress.text
    workspace.matte.aiProgress = progress.percent ?? -1
  }
  try {
    let blob: Blob | null = null
    let baseColor: string | undefined
    if (mode === 'color' || mode === 'auto' || mode === 'solid') {
      const result = await runColorKey(mode, img)
      blob = result.blob
      baseColor = result.baseColor
    } else if (mode === 'imgly') {
      const result = await removeWithImgly(img, { model: workspace.matte.imglyModel, device: workspace.matte.aiDevice, maxSide: workspace.matte.aiMaxSide, publicPath: workspace.matte.imglyPublicPath || undefined, onProgress })
      blob = result.blob
    } else if (mode === 'rmbg') {
      const result = await removeWithTransformers(img, { modelId: workspace.matte.rmbgModelId, dtype: workspace.matte.aiDtype, device: workspace.matte.aiDevice, modelHost: workspace.matte.aiModelHost, maxSide: workspace.matte.aiMaxSide, onProgress })
      blob = result.blob
    }
    if (!blob) throw new Error('未生成结果')
    const resultBlob = workspace.matte.cropTransparent ? await cropBlob(blob) : blob
    if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
    workspace.matte.resultUrl = URL.createObjectURL(resultBlob)
    workspace.matte.aiStatus = baseColor ? `完成 · 基准色 ${baseColor}` : '完成'
    workspace.matte.status = 'done'
    pushHistory(mode, resultBlob)
    if (modelKey) setModelState(modelKey, 'ready')
  } catch (error) {
    console.error('抠图处理失败', error)
    workspace.matte.status = 'error'
    workspace.matte.aiStatus = describeMattingError(error, workspace.matte.mode)
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
  workspace.matte.resultUrl = ''
  activeHistoryId.value = ''
  workspace.matte.mode = 'auto'
  workspace.matte.tolerance = 24
  workspace.matte.cropTransparent = true
  workspace.matte.sampledColor = ''
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  sampling.value = false
  workspace.matte.status = workspace.matte.sourceUrl ? 'ready' : 'empty'
}

/** 左栏列表「移除」：复用 store 的清空来源与页面的重置逻辑，移除后左栏自动隐藏 */
function removeSource(): void {
  clearMatteSource()
  resetMatte()
}

/**
 * ---- 手动抠图 ----
 * 工作画布（图像原始尺寸）是手动结果的唯一数据源：始终从原图重建一次，
 * 之后每次落笔用 destination-out 擦除，可反复叠加而不产生误差。
 * 操作按手势记录成 ops，撤销/清空只需重建画布再重放剩余 ops。
 */

/** 手动抠图的单次手势：画笔是一串连续点，框选是一个矩形，坐标均为图像像素 */
type ManualOp =
  | { tool: 'brush'; radius: number; points: { x: number; y: number }[] }
  | { tool: 'rect'; rect: ImageCropRect }

/** 已提交的手势，用于撤销与重放 */
const manualOps = ref<ManualOp[]>([])
/** 正在进行的拖拽：kind 决定按画笔还是框选收尾 */
const manualDrag = ref<{ kind: 'brush' | 'rect'; start: { x: number; y: number }; last: { x: number; y: number }; op?: ManualOp } | null>(null)
/** 框选过程中的橡皮筋矩形，仅用于预览 */
const manualPendingRect = ref<ImageCropRect | null>(null)
/** 标记色：与危险色一致，表示「这块会被删掉」 */
const MANUAL_MARK = 'rgb(224 98 106 / 0.38)'
let manualCanvas: HTMLCanvasElement | null = null
let manualContext: CanvasRenderingContext2D | null = null
/** 手动抠图的原图，撤销重放时用它复原画布 */
let manualSource: HTMLImageElement | null = null
let manualSourceUrl = ''

/** 原图解码：手动抠图必须从原始图片出发，不能用已抠图的 resultUrl */
function decodeManualSource(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const source = new Image()
    source.onload = () => {
      manualSource = source
      manualSourceUrl = workspace.matte.sourceUrl
      resolve(source)
    }
    source.onerror = () => reject(new Error('原图加载失败，无法手动抠图'))
    source.src = workspace.matte.sourceUrl
  })
}

/** 指针位置 → 图像像素坐标；图像可能被缩放平移，每次手势都按实际渲染矩形换算 */
function toImagePoint(event: PointerEvent): { x: number; y: number } | null {
  const img = image.value
  if (!img?.naturalWidth || !img.naturalHeight) return null
  const bounds = img.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return null
  const x = ((event.clientX - bounds.left) / bounds.width) * img.naturalWidth
  const y = ((event.clientY - bounds.top) / bounds.height) * img.naturalHeight
  return { x: Math.max(0, Math.min(img.naturalWidth, x)), y: Math.max(0, Math.min(img.naturalHeight, y)) }
}

/** 两点之间的规范化矩形（可反向拖拽） */
function rectBetween(from: { x: number; y: number }, to: { x: number; y: number }): ImageCropRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  }
}

/** 在画布上以「擦除」模式执行绘制：颜色不参与运算，擦掉的地方 alpha 直接归零 */
function withErase(context: CanvasRenderingContext2D, draw: () => void): void {
  const previous = context.globalCompositeOperation
  context.fillStyle = '#000'
  context.strokeStyle = '#000'
  context.globalCompositeOperation = 'destination-out'
  draw()
  context.globalCompositeOperation = previous
}

function fillBrushDab(context: CanvasRenderingContext2D, point: { x: number; y: number }, radius: number): void {
  context.beginPath()
  context.arc(point.x, point.y, radius, 0, Math.PI * 2)
  context.fill()
}

function strokeBrushSegment(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, radius: number): void {
  context.lineWidth = radius * 2
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.stroke()
}

/** 把一个手势画到目标画布上（工作画布用擦除模式，交互层用标记色） */
function paintOp(context: CanvasRenderingContext2D, op: ManualOp): void {
  if (op.tool === 'rect') {
    context.fillRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height)
    return
  }
  if (op.points.length === 1) {
    fillBrushDab(context, op.points[0], op.radius)
    return
  }
  for (let index = 1; index < op.points.length; index += 1) {
    strokeBrushSegment(context, op.points[index - 1], op.points[index], op.radius)
  }
}

/** 按剩余 ops 重建工作画布：先画原图，再重放全部手势 */
function replayManualOps(): void {
  const canvas = manualCanvas
  const context = manualContext
  if (!canvas || !context || !manualSource) return
  context.globalCompositeOperation = 'source-over'
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(manualSource, 0, 0)
  withErase(context, () => {
    for (const op of manualOps.value) paintOp(context, op)
  })
}

/** 把工作画布落盘为结果：手动模式下 resultUrl 就是这份可继续编辑的画面 */
async function refreshManualResult(): Promise<void> {
  const canvas = manualCanvas
  if (!canvas) return
  const blob = await canvasToBlob(canvas)
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  workspace.matte.resultUrl = URL.createObjectURL(blob)
  workspace.matte.aiStatus = manualOps.value.length ? `手动标记 ${manualOps.value.length} 处` : '尚未标记任何区域'
  workspace.matte.status = 'done'
  // 同一段手动编辑只占一条历史：已有条目就地刷新，首次落笔才新建
  if (manualEntryId) updateHistoryEntry(manualEntryId, blob, manualOps.value.length)
  else if (manualOps.value.length > 0) manualEntryId = pushHistory('manual', blob, manualOps.value.length)
}

/** 进入手动抠图：丢弃上一次处理结果，从原图重建工作画布与交互层 */
async function startManual(): Promise<void> {
  if (!workspace.matte.sourceUrl) return
  manualOps.value = []
  manualDrag.value = null
  manualPendingRect.value = null
  // 新的手动编辑段落单独占一条历史
  manualEntryId = ''
  activeHistoryId.value = ''
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  workspace.matte.resultUrl = ''
  workspace.matte.status = 'ready'
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  try {
    const source = manualSourceUrl === workspace.matte.sourceUrl && manualSource ? manualSource : await decodeManualSource()
    const canvas = document.createElement('canvas')
    canvas.width = source.naturalWidth
    canvas.height = source.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建绘图画布')
    context.drawImage(source, 0, 0)
    manualCanvas = canvas
    manualContext = context
    await nextTick()
    const overlay = manualOverlay.value
    if (overlay) {
      overlay.width = source.naturalWidth
      overlay.height = source.naturalHeight
    }
  } catch (error) {
    workspace.matte.status = 'error'
    workspace.matte.aiStatus = error instanceof Error ? error.message : '手动抠图初始化失败'
  }
}

/** 退出手动抠图：释放工作画布并丢弃手动结果，避免其他方式沿用一份无法再编辑的画面 */
function stopManual(): void {
  manualOps.value = []
  manualDrag.value = null
  manualPendingRect.value = null
  manualCanvas = null
  manualContext = null
  manualEntryId = ''
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  workspace.matte.resultUrl = ''
  workspace.matte.status = workspace.matte.sourceUrl ? 'ready' : 'empty'
}

function clearManualOverlay(): void {
  const overlay = manualOverlay.value
  if (overlay) overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
}

/** 把当前手势画到交互层上做实时预览（工作画布等松手才提交，避免每次移动都编码图片） */
function paintManualOverlay(gesture: ManualOp, replace: boolean): void {
  const overlay = manualOverlay.value
  const context = overlay?.getContext('2d')
  if (!overlay || !context) return
  if (replace) context.clearRect(0, 0, overlay.width, overlay.height)
  context.fillStyle = MANUAL_MARK
  context.strokeStyle = MANUAL_MARK
  context.lineWidth = 2
  if (gesture.tool === 'rect') {
    context.fillRect(gesture.rect.x, gesture.rect.y, gesture.rect.width, gesture.rect.height)
    context.strokeRect(gesture.rect.x, gesture.rect.y, gesture.rect.width, gesture.rect.height)
    return
  }
  paintOp(context, gesture)
}

function onManualDown(event: PointerEvent): void {
  if (!isManual.value || !manualContext || event.button !== 0) return
  const point = toImagePoint(event)
  if (!point) return
  event.preventDefault()
  // 指针可能已释放，捕获失败不影响本次涂抹
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    /* 忽略无效指针 */
  }
  clearManualOverlay()
  if (workspace.matte.manualTool === 'rect') {
    manualPendingRect.value = { x: point.x, y: point.y, width: 0, height: 0 }
    manualDrag.value = { kind: 'rect', start: point, last: point }
    return
  }
  const op: ManualOp = { tool: 'brush', radius: Math.max(1, workspace.matte.brushSize / 2), points: [point] }
  manualDrag.value = { kind: 'brush', start: point, last: point, op }
  paintManualOverlay(op, true)
}

function onManualMove(event: PointerEvent): void {
  const drag = manualDrag.value
  if (!drag) return
  const point = toImagePoint(event)
  if (!point) return
  if (drag.kind === 'rect') {
    manualPendingRect.value = rectBetween(drag.start, point)
    paintManualOverlay({ tool: 'rect', rect: manualPendingRect.value }, true)
    return
  }
  const op = drag.op
  if (!op || op.tool !== 'brush') return
  const previous = op.points[op.points.length - 1]
  op.points.push(point)
  paintManualOverlay({ tool: 'brush', radius: op.radius, points: [previous, point] }, false)
}

function onManualUp(event: PointerEvent): void {
  const drag = manualDrag.value
  const context = manualContext
  manualDrag.value = null
  manualPendingRect.value = null
  clearManualOverlay()
  if (!drag || !context) return
  const point = toImagePoint(event) ?? drag.last
  if (drag.kind === 'rect') {
    const rect = rectBetween(drag.start, point)
    // 单击不产生矩形，避免误删一整个像素
    if (rect.width < 1 || rect.height < 1) return
    const op: ManualOp = { tool: 'rect', rect }
    manualOps.value.push(op)
    withErase(context, () => paintOp(context, op))
  } else {
    const op = drag.op
    if (!op) return
    manualOps.value.push(op)
    withErase(context, () => paintOp(context, op))
  }
  void refreshManualResult()
}

/** 撤销最后一次手势：重放剩余 ops 即可，比保存像素快照省内存 */
function undoManual(): void {
  if (!manualOps.value.length) return
  manualOps.value.pop()
  replayManualOps()
  void refreshManualResult()
}

/** 清空全部手势，回到原图 */
function clearManual(): void {
  if (!manualOps.value.length) return
  manualOps.value = []
  replayManualOps()
  void refreshManualResult()
}

/**
 * ---- 抠图历史 ----
 * 每次抠图产出的结果 PNG 都留一份快照，仅存在内存里（刷新即失效）。
 * 快照自带图像数据，因此不依赖源图，可直接回看、重新导出。
 */

/** 历史条数上限：超出后丢弃最早的快照并释放地址 */
const MAX_HISTORY = 24
/** 预览区当前展示的历史条目 id；为空表示展示的是本次刚生成的结果 */
const activeHistoryId = ref('')
/** 手动抠图正在写入的历史条目 id：同一段手动编辑只占一条，避免每落一笔都新增 */
let manualEntryId = ''

function historyTime(entry: MatteHistoryEntry): string {
  const date = new Date(entry.createdAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 记录一次结果快照，返回新条目 id */
function pushHistory(mode: MatteMode, blob: Blob, markCount?: number): string {
  const entry: MatteHistoryEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    fileName: workspace.matte.fileName || 'cutout.png',
    mode,
    blob,
    url: URL.createObjectURL(blob),
    createdAt: Date.now(),
    markCount,
  }
  workspace.matte.history.unshift(entry)
  while (workspace.matte.history.length > MAX_HISTORY) {
    const dropped = workspace.matte.history.pop()
    if (dropped) URL.revokeObjectURL(dropped.url)
  }
  activeHistoryId.value = entry.id
  return entry.id
}

/** 就地刷新某条历史（手动抠图反复落笔时用，避免历史被同一次编辑刷屏） */
function updateHistoryEntry(id: string, blob: Blob, markCount: number): void {
  const entry = workspace.matte.history.find((item) => item.id === id)
  if (!entry) return
  URL.revokeObjectURL(entry.url)
  entry.blob = blob
  entry.url = URL.createObjectURL(blob)
  entry.markCount = markCount
  entry.createdAt = Date.now()
}

function removeHistory(entry: MatteHistoryEntry): void {
  const index = workspace.matte.history.indexOf(entry)
  if (index < 0) return
  URL.revokeObjectURL(entry.url)
  workspace.matte.history.splice(index, 1)
  if (activeHistoryId.value === entry.id) activeHistoryId.value = ''
  if (manualEntryId === entry.id) manualEntryId = ''
}

function clearHistory(): void {
  workspace.matte.history.forEach((entry) => URL.revokeObjectURL(entry.url))
  workspace.matte.history = []
  activeHistoryId.value = ''
  manualEntryId = ''
}

function downloadEntry(entry: MatteHistoryEntry): void {
  const base = entry.fileName.replace(/\.[^.]+$/, '') || 'cutout'
  const link = document.createElement('a')
  link.href = entry.url
  link.download = `${base}-cutout.png`
  link.click()
}

/** 把历史结果重新载入预览区；手动模式先退出，避免交互层与历史结果互相覆盖 */
async function restoreHistory(entry: MatteHistoryEntry): Promise<void> {
  if (isManual.value) {
    workspace.matte.mode = 'auto'
    // 等 stopManual 跑完（它会清空并 revoke 当前结果），再挂上历史结果
    await nextTick()
  }
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  workspace.matte.resultUrl = URL.createObjectURL(entry.blob)
  workspace.matte.aiStatus = `已载入历史：${modeLabelOf(entry.mode)}`
  workspace.matte.status = 'done'
  activeHistoryId.value = entry.id
}

async function exportPackage(): Promise<void> {
  const base = workspace.matte.fileName.replace(/\.[^.]+$/, '') || 'cutout'
  const mode = workspace.matte.mode
  const config: Record<string, unknown> = { mode, cropTransparent: workspace.matte.cropTransparent }
  if (!workspace.matte.resultUrl) return
  const response = await fetch(workspace.matte.resultUrl); const blob = await response.blob()
  if (mode === 'color' || mode === 'auto' || mode === 'solid') config.tolerance = workspace.matte.tolerance
  if (mode === 'color') config.sampledColor = workspace.matte.sampledColor
  if (mode === 'imgly') { config.engine = 'imgly'; config.model = workspace.matte.imglyModel; config.publicPath = workspace.matte.imglyPublicPath || undefined }
  if (mode === 'rmbg') { config.engine = mode; config.modelId = workspace.matte.rmbgModelId; config.dtype = workspace.matte.aiDtype }
  if (['imgly', 'rmbg'].includes(mode)) { config.device = workspace.matte.aiDevice; config.maxSide = workspace.matte.aiMaxSide; config.modelHost = workspace.matte.aiModelHost }
  if (mode === 'manual') { config.tool = workspace.matte.manualTool; config.brushSize = workspace.matte.brushSize; config.markCount = manualOps.value.length }
  await downloadZip([{ name: `${base}-cutout.png`, blob }, { name: 'config.json', blob: JSON.stringify(config, null, 2) }], `${base}-cutout.zip`)
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (helpOpen.value && event.key === 'Escape') {
    event.preventDefault()
    closeHelp()
  }
}

function onWindowBlur(): void {
  panPointer.value = null
}

function onWindowResize(): void {
  fitImageToCanvas()
}

/** 进入/退出手动抠图时初始化和释放工作画布 */
watch(isManual, (manual) => {
  if (manual) void startManual()
  else stopManual()
})

/** 手动模式下换图（含左栏移除后重新导入）要重建工作画布与交互层 */
watch(
  () => workspace.matte.sourceUrl,
  () => {
    if (isManual.value) void startManual()
  },
)

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('keydown', onWindowKeyDown)
  window.addEventListener('blur', onWindowBlur)
  if (canvasRef.value) {
    canvasResizeObserver = new ResizeObserver(() => fitImageToCanvas())
    canvasResizeObserver.observe(canvasRef.value)
  }
  // 刷新后重新初始化运行时；模型文件会优先复用浏览器缓存或 models/。
  if (isAiMode.value) void preloadSelectedModel()
  if (isManual.value) void startManual()
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('keydown', onWindowKeyDown)
  window.removeEventListener('blur', onWindowBlur)
  canvasResizeObserver?.disconnect()
  stopManual()
})
</script>

<template>
  <div class="grid h-full min-h-0" :class="workspace.matte.sourceUrl ? 'grid-cols-[280px_minmax(0,1fr)_320px]' : 'grid-cols-[minmax(0,1fr)_320px]'">
    <!-- 左栏：已导入源图列表，未导入时整栏不显示 -->
    <section v-if="workspace.matte.sourceUrl" class="panel overflow-auto border-r border-line">
      <div class="section">
        <h2 class="section-title">图集列表</h2>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <li class="flex items-center gap-2">
            <img class="size-10 flex-none rounded-sm border border-line bg-stage object-contain" :src="workspace.matte.sourceUrl" :alt="workspace.matte.fileName" draggable="false" />
            <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-caption" :title="workspace.matte.fileName">{{ workspace.matte.fileName }}</span>
            <!-- 尺寸取工作区预览 img 元素的自然尺寸 -->
            <span v-if="image?.naturalWidth" class="mono faint">{{ image?.naturalWidth }}×{{ image?.naturalHeight }}</span>
            <button class="btn btn-icon btn-danger ml-auto text-faint" title="移除" @click="removeSource">×</button>
          </li>
        </ul>
      </div>
      <!-- 抠图历史：每次抠图产出的结果快照，仅本次会话保留 -->
      <div v-if="workspace.matte.history.length" class="section">
        <div class="flex items-start justify-between gap-2">
          <h2 class="section-title">抠图历史</h2>
          <button class="btn-icon -mt-[3px] text-faint" type="button" title="清空历史记录" @click="clearHistory">×</button>
        </div>
        <p class="muted">共 {{ workspace.matte.history.length }} 条 · 仅本次会话保留</p>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <li v-for="entry in workspace.matte.history" :key="entry.id" class="flex items-center gap-2 rounded-sm border p-1" :class="activeHistoryId === entry.id ? 'border-accent bg-accent-dim' : 'border-line'">
            <button class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left" type="button" :title="`载入这条结果（${modeLabelOf(entry.mode)}）`" @click="restoreHistory(entry)">
              <img class="size-10 flex-none rounded-sm border border-line bg-stage object-contain" :src="entry.url" :alt="modeLabelOf(entry.mode)" draggable="false" />
              <span class="min-w-0 flex-1">
                <span class="block text-caption text-ink">{{ modeLabelOf(entry.mode) }}</span>
                <span class="block text-faint">{{ historyTime(entry) }}<template v-if="entry.markCount"> · {{ entry.markCount }} 处</template></span>
              </span>
            </button>
            <button class="btn btn-icon text-faint" type="button" title="导出这张结果" @click="downloadEntry(entry)">⇩</button>
            <button class="btn btn-icon btn-danger text-faint" type="button" title="删除这条记录" @click="removeHistory(entry)">×</button>
          </li>
        </ul>
      </div>
    </section>

    <main class="flex min-h-0 min-w-0 flex-col">
      <div class="flex h-16 flex-none items-center justify-between gap-4 border-b border-line px-6">
        <div><h2 class="m-0 text-head">抠图工作区</h2><p class="mt-0.5 mb-0 text-faint">{{ workspace.matte.fileName || '导入一张图片开始处理' }}</p></div>
        <div class="flex items-center gap-3">
          <input ref="input" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="load(($event.target as HTMLInputElement).files?.[0])" />
          <button class="btn btn-primary" @click="openFile">导入图片</button>
          <div class="flex items-center gap-4">
            <div v-if="workspace.matte.sourceUrl" class="flex items-center gap-1.5 border-r border-line pr-3.5" aria-label="画布缩放控制">
              <button class="h-[30px] w-[30px] cursor-pointer rounded-sm border border-line bg-raised text-[17px] leading-none text-ink disabled:cursor-default disabled:opacity-40 enabled:hover:border-accent enabled:hover:text-accent" type="button" title="缩小" aria-label="缩小" :disabled="zoomLevel <= 0.2" @click="zoomOut">−</button>
              <output class="min-w-[46px] text-center font-mono text-[12px] text-muted" aria-live="polite">{{ zoomPercent }}</output>
              <button class="h-[30px] w-[30px] cursor-pointer rounded-sm border border-line bg-raised text-[17px] leading-none text-ink disabled:cursor-default disabled:opacity-40 enabled:hover:border-accent enabled:hover:text-accent" type="button" title="放大" aria-label="放大" :disabled="zoomLevel >= 8" @click="zoomIn">+</button>
              <button class="h-[30px] cursor-pointer rounded-sm border border-line bg-raised px-2.5 text-[12px] text-ink hover:border-accent hover:text-accent" type="button" title="完整适配画布" @click="resetView">适应画布</button>
            </div>
            <div class="seg"><button v-for="item in backgroundOptions" :key="item.value" class="seg-item" :class="{ active: workspace.matte.background === item.value }" @click="setBackground(item.value)">{{ item.label }}</button></div>
          </div>
        </div>
      </div>
      <div ref="canvasRef" class="relative m-6 grid min-h-0 flex-1 place-items-center overflow-hidden border" :class="[isDragging ? 'border-accent' : 'border-line', panPointer ? 'cursor-grabbing select-none' : (canPanImage ? 'cursor-grab' : '')]" :style="backgroundStyle" @dragover.prevent="isDragging = true" @dragleave="isDragging = false" @drop="handleDrop" @click="sampleColor" @wheel.prevent="zoomAtPointer" @pointerdown="onPanStart" @pointermove="onPanMove" @pointerup="onPanEnd" @pointercancel="onPanEnd">
        <div v-if="!workspace.matte.sourceUrl" class="flex cursor-pointer flex-col items-center gap-2 text-faint" @click="openFile"><span class="text-[36px] text-accent">＋</span><strong class="text-ink">拖入图片</strong><span>PNG / JPG / WebP</span></div>
        <template v-else>
          <div class="relative" :style="imageViewStyle">
            <img ref="image" class="block size-full object-contain" :class="{ 'cursor-crosshair': sampling }" :src="workspace.matte.resultUrl || workspace.matte.sourceUrl" alt="预览" draggable="false" @load="onPreviewLoad" />
            <!-- 手动抠图交互层：与图像像素 1:1，涂抹/框选在此绘制标记，松手才提交到工作画布 -->
            <canvas v-if="isManual" ref="manualOverlay" class="absolute inset-0 size-full cursor-crosshair touch-none" @pointerdown="onManualDown" @pointermove="onManualMove" @pointerup="onManualUp" @pointercancel="onManualUp" />
          </div>
        </template>
      </div>
    </main>

    <!-- 右栏：处理方式、模型状态与导出配置 -->
    <section class="panel overflow-auto border-l border-line">
      <div class="section"><h2 class="section-title">抠图工具</h2><p class="muted">本地处理，不上传素材</p></div>
      <div class="section">
        <div class="flex items-start justify-between gap-2">
          <h2 class="section-title">处理方式</h2>
          <button ref="helpButton" class="-mt-[3px] grid size-[21px] flex-none cursor-pointer place-items-center rounded-full border border-line-strong bg-transparent font-sans font-semibold text-[12px] leading-none text-muted hover:border-accent hover:text-accent focus-visible:outline-none" type="button" aria-label="查看处理方式说明和推荐" title="处理方式说明和推荐" @click="openHelp">?</button>
        </div>
        <select v-model="workspace.matte.mode" class="select w-full justify-center">
          <option v-for="option in modeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <template v-if="workspace.matte.mode === 'color'">
          <button class="btn w-full justify-center" :class="{ 'btn-primary': sampling }" @click="sampling = !sampling">{{ sampling ? '请点击图片取色' : '吸取背景颜色' }}</button>
          <div v-if="workspace.matte.sampledColor" class="flex items-center gap-2 font-mono text-[12px] text-muted"><span class="size-[18px] rounded-[3px] border border-line-strong" :style="{ background: workspace.matte.sampledColor }"></span><span>已取色 {{ workspace.matte.sampledColor }}</span><button class="btn-icon ml-auto text-faint" title="清除取色" @click="workspace.matte.sampledColor = ''">×</button></div>
        </template>
        <template v-if="workspace.matte.mode === 'color' || workspace.matte.mode === 'solid'">
          <label class="field"><span class="field-label">颜色容差 {{ workspace.matte.tolerance }}</span><input v-model.number="workspace.matte.tolerance" class="w-full accent-accent" type="range" min="1" max="100" /></label>
          <p v-if="workspace.matte.mode === 'solid'" class="muted">自动采样图像边缘主色作为背景基准，适合纯色背景</p>
        </template>
        <template v-if="isAiMode">
          <div v-if="workspace.matte.mode === 'rmbg'" class="warn">⚠️ RMBG 仅供评估，不可商用</div>
          <label v-if="workspace.matte.mode === 'imgly'" class="field"><span class="field-label">模型</span>
            <select v-model="workspace.matte.imglyModel" class="select w-full">
              <option value="isnet_fp16">ISNet FP16（推荐）</option>
              <option value="isnet">ISNet 原版</option>
              <option value="isnet_quint8">ISNet 量化（最快）</option>
            </select>
          </label>
          <label v-if="workspace.matte.mode === 'imgly'" class="field"><span class="field-label">资源地址（publicPath）</span><input v-model="workspace.matte.imglyPublicPath" class="input" type="text" placeholder="留空时优先用本地镜像目录 /models，无镜像才用官方 CDN" /></label>
          <template v-if="workspace.matte.mode === 'rmbg'">
            <label class="field"><span class="field-label">模型 ID</span>
              <input v-model="workspace.matte.rmbgModelId" class="input" type="text" />
            </label>
            <label class="field"><span class="field-label">精度</span>
              <select v-model="workspace.matte.aiDtype" class="select w-full" title="FP16 是推荐默认值，可降低浏览器内存占用；FP32 最吃内存；Q8 仅适用于模型提供量化权重的情况（本模型没有的精度不会列出）">
                <option v-for="option in dtypeChoices" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
          </template>
          <label class="field"><span class="field-label">模型源</span>
            <select v-model="workspace.matte.aiModelHost" class="select w-full">
              <option value="huggingface.co">HuggingFace（默认）</option>
              <option value="hf-mirror.com">国内镜像 hf-mirror.com</option>
            </select>
          </label>
          <label class="field"><span class="field-label">运行设备</span>
            <select v-model="workspace.matte.aiDevice" class="select w-full">
              <option v-for="option in deviceChoices" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label class="field"><span class="field-label">最大边长</span>
            <select v-model.number="workspace.matte.aiMaxSide" class="select w-full">
              <option v-for="option in AI_MAX_SIDE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <p v-if="workspace.matte.mode === 'rmbg'" class="muted">RMBG 的模型输入被固定为 1024×1024，最大边长只影响合成输出的画布尺寸，不影响推理占用的内存</p>
        </template>
        <template v-if="isManual">
          <label class="field"><span class="field-label">手动工具</span>
            <div class="seg w-full">
              <button class="seg-item flex-1 justify-center" :class="{ active: workspace.matte.manualTool === 'brush' }" type="button" @click="workspace.matte.manualTool = 'brush'">画笔涂抹</button>
              <button class="seg-item flex-1 justify-center" :class="{ active: workspace.matte.manualTool === 'rect' }" type="button" @click="workspace.matte.manualTool = 'rect'">框选矩形</button>
            </div>
          </label>
          <label v-if="workspace.matte.manualTool === 'brush'" class="field"><span class="field-label">笔刷大小 {{ workspace.matte.brushSize }} px</span><input v-model.number="workspace.matte.brushSize" class="w-full accent-accent" type="range" min="2" max="200" /></label>
          <p class="muted">在画布上涂抹或框选，覆盖的像素立即变透明；始终从原图出发，反复涂抹不叠加误差。</p>
        </template>
        <label class="check-row" :class="{ 'cursor-default opacity-50': isManual }"><input v-model="workspace.matte.cropTransparent" type="checkbox" :disabled="isManual" /> 自动裁切透明边缘</label>
        <p v-if="isManual" class="muted">手动抠图结果与原图同尺寸，不做透明边裁切</p>
      </div>
      <div class="section">
        <h2 class="section-title">模型状态</h2>
        <div v-for="engine in AI_ENGINES" :key="engine.key" class="flex min-h-8 items-center justify-between gap-2 text-muted">
          <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" :title="`${engine.label} ${engine.size} · ${engine.description}`">{{ engine.label }} <span class="muted">{{ engine.size }}</span></span>
          <span class="badge flex-none whitespace-nowrap" :class="{ 'badge-accent': workspace.matte.mode === engine.key }">{{ workspace.matte.mode === engine.key ? modelStateLabel(modelStateForEngine(engine.key)) : engine.license }}</span>
        </div>
        <button v-if="isAiMode" class="btn mt-2 w-full justify-center" :disabled="selectedModelState === 'loading' || selectedModelState === 'ready'" @click="preloadSelectedModel">{{ selectedModelState === 'ready' ? '模型已加载' : '预加载当前模型' }}</button>
        <p v-if="isAiMode" class="muted mt-2 mb-0 leading-normal">“未加载”表示当前页面还没初始化模型；预加载会优先复用浏览器缓存或本地模型目录。</p>
        <div v-if="workspace.matte.aiStatus" class="mt-2">
          <p class="muted mt-0 mb-1 text-[12px] break-all">{{ workspace.matte.aiStatus }}</p>
          <div v-if="workspace.matte.aiProgress >= 0" class="h-1.5 overflow-hidden rounded-[3px] bg-line"><div class="h-full bg-accent [transition:width_0.2s_ease]" :style="{ width: workspace.matte.aiProgress + '%' }"></div></div>
        </div>
      </div>
      <div class="section flex flex-col gap-2">
        <button v-if="!isManual" class="btn btn-primary w-full justify-center" :disabled="runDisabled" @click="runMatte">{{ workspace.matte.status === 'processing' ? '处理中…' : '开始抠图' }}</button>
        <template v-else>
          <p class="muted m-0">手动抠图即时生效：在画布上涂抹或框选即可，无需点击开始。</p>
          <div class="flex gap-2">
            <button class="btn flex-1 justify-center" :disabled="!manualOps.length" @click="undoManual">撤销</button>
            <button class="btn flex-1 justify-center" :disabled="!manualOps.length" @click="clearManual">清空标记</button>
          </div>
        </template>
        <button class="btn w-full justify-center" :disabled="!workspace.matte.resultUrl" @click="download">导出透明 PNG</button>
        <button class="btn w-full justify-center" :disabled="!workspace.matte.resultUrl" @click="exportPackage">导出 PNG + 配置 ZIP</button>
        <button class="btn btn-ghost w-full justify-center" :disabled="!workspace.matte.sourceUrl || workspace.matte.status === 'processing'" @click="resetMatte">重置抠图</button>
      </div>
    </section>
    <div v-if="helpOpen" class="fixed inset-0 z-30 grid place-items-center bg-[rgb(8_10_14_/_0.72)] p-6" @click.self="closeHelp">
      <section class="flex max-h-[min(760px,calc(100vh-32px))] w-[min(820px,calc(100vw-32px))] flex-col overflow-hidden rounded-md border border-line-strong bg-surface shadow-popover" role="dialog" aria-modal="true" aria-labelledby="matte-help-title" aria-describedby="matte-help-intro">
        <header class="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="matte-help-title" class="m-0 text-head">处理方式说明与推荐</h2>
            <p id="matte-help-intro" class="mt-1 mb-0 text-caption text-muted">按背景特点和目标精度选择；这些抠图均在本地浏览器处理。</p>
          </div>
          <button ref="helpCloseButton" class="btn-icon ml-auto text-[22px] text-faint" type="button" aria-label="关闭说明" @click="closeHelp">×</button>
        </header>
        <div class="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 overflow-y-auto px-5 py-4">
          <article v-for="item in methodHelp" :key="item.title" class="min-w-0 rounded-sm border border-line bg-raised p-3">
            <div class="mb-2 flex items-center justify-between gap-2"><h3 class="m-0 text-[14px]">{{ item.title }}</h3><span class="flex-none rounded-full bg-hover px-1.5 py-0.5 text-[10px] text-muted">{{ item.kind }}</span></div>
            <p class="mt-1.5 mb-0 text-[12px] leading-[1.55] text-muted">{{ item.description }}</p>
            <p class="mt-1.5 mb-0 text-[12px] leading-[1.55] text-muted"><strong class="font-semibold text-ink">适用场景：</strong>{{ item.scene }}</p>
            <p class="mt-1.5 mb-0 text-[12px] leading-[1.55] text-ink"><strong class="font-semibold text-ink">推荐：</strong>{{ item.recommendation }}</p>
          </article>
        </div>
        <footer class="flex items-center justify-between gap-4 border-t border-line px-5 py-4 text-[12px] text-faint">
          <span>快速建议：纯色背景试“纯色背景”；一般图片试 ISNet；细节较多时试 RMBG-1.4。</span>
          <button class="btn btn-primary" type="button" @click="closeHelp">知道了</button>
        </footer>
      </section>
    </div>
  </div>
</template>
