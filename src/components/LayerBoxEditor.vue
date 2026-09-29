<script setup lang="ts">
import Konva from 'konva'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { detectBoxes, type DetectBox, type UserBox } from '@/core/layer-split'
import { workspace, type LayerCategory } from '@/store/workspace'
import { createCancelToken } from '@/core/frame-extract'

/**
 * 多框编辑器（Konva 版）。
 *
 * 之前用「CSS transform 的 <img> + canvas 覆盖层」双坐标系，缩放后两者必须逐帧手工同步，
 * 一旦 getBoundingClientRect 与 transform 时序错开就会框选偏移。
 * 这里改为单一 Konva.Stage：底图与所有框都在同一个 Group 里，
 * 缩放/平移只作用于 Group 的 scale/position，框与像素天然对齐，无需任何手工换算。
 *
 * 交互：
 * - 默认 100% = 整图完整、居中展示（fitScale 由舞台尺寸算出）
 * - 空白拖拽画新框；点框拖动移动；选中框用 Konva.Transformer 八向调节大小
 * - 同一区域多个框：单击选中顶层，双击逐层向下切换（数组靠后 = 层级在上）
 * - 滚轮以光标为锚点缩放；按住 Space 或中键拖拽平移
 */

const emit = defineEmits<{
  confirm: [boxes: UserBox[]]
  cancel: []
}>()

/** 编辑器中的框（数据以原图像素坐标存储，与渲染缩放无关） */
interface EditBox {
  id: string
  x: number
  y: number
  w: number
  h: number
  label: string
  category: string
  score: number
  /** 检测框 = false，用户新增 = true */
  manual: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  button: '按钮',
  icon: '图标',
  text: '文本',
  panel: '面板',
  border: '边框',
  decoration: '装饰',
  progress: '进度条',
  background: '背景',
  other: '其它',
}

const CATEGORY_COLORS: Record<string, string> = {
  button: '#4c9cff',
  icon: '#5ec27a',
  text: '#e8a838',
  panel: '#b07af5',
  border: '#e87a5a',
  decoration: '#5ad5e8',
  progress: '#e85ad5',
  background: '#888888',
  other: '#aaaaaa',
}

const DEFAULT_CATEGORY: LayerCategory = 'other'
/** 「适应」时四周留出的舞台边距（屏幕像素） */
const FIT_PADDING = 24
const MIN_ZOOM_RATIO = 0.2
const MAX_ZOOM_RATIO = 12

const wrap = ref<HTMLElement>()
const stageRef = ref<{ getNode: () => Konva.Node } | null>(null)
const worldRef = ref<{ getNode: () => Konva.Node } | null>(null)
const transformerRef = ref<{ getNode: () => Konva.Node } | null>(null)

const boxes = ref<EditBox[]>([])
const selectedId = ref<string | null>(null)
const detecting = ref(false)
const errorText = ref('')
const imageNode = ref<HTMLImageElement | null>(null)
const natural = ref({ width: 0, height: 0 })
/** 舞台尺寸（屏幕像素），由 ResizeObserver 维护 */
const stageSize = ref({ width: 0, height: 0 })
/** 视图：世界 Group 的缩放与平移（屏幕像素） */
const view = ref({ scale: 1, x: 0, y: 0 })
/** 用户是否手动缩放/平移过：未手动操作时尺寸变化自动重新适应 */
let userAdjusted = false
const spacePressed = ref(false)

let boxCounter = 0
/** 正在画新框：记录锚点与临时框 id */
let drawing: { anchorX: number; anchorY: number; id: string } | null = null
/** 正在平移：记录起始指针与世界位置 */
let panning: { startX: number; startY: number; x: number; y: number } | null = null

const split = computed(() => workspace.layersplit)
const selectedBox = computed(() => boxes.value.find((b) => b.id === selectedId.value) || null)

/** 整图完整展示时的基准缩放：100% 即「全图 + 居中」 */
const fitScale = computed(() => {
  const { width, height } = stageSize.value
  const nw = natural.value.width
  const nh = natural.value.height
  if (!width || !height || !nw || !nh) return 1
  return Math.max(0.01, Math.min((width - FIT_PADDING * 2) / nw, (height - FIT_PADDING * 2) / nh))
})

const zoomPercent = computed(() => `${Math.round((view.value.scale / fitScale.value) * 100)}%`)

const stageConfig = computed(() => ({
  width: stageSize.value.width,
  height: stageSize.value.height,
}))

/** 世界 Group：所有内容的坐标都乘以它，因此框与底图永远对齐 */
const worldConfig = computed(() => ({
  x: view.value.x,
  y: view.value.y,
  scaleX: view.value.scale,
  scaleY: view.value.scale,
  listening: true,
}))

const imageConfig = computed(() => ({
  image: imageNode.value ?? undefined,
  x: 0,
  y: 0,
  width: natural.value.width,
  height: natural.value.height,
  // 底图不接收事件：空白处点击直接落到 stage，便于画新框
  listening: false,
  perfectDrawEnabled: false,
  shadowForStrokeEnabled: false,
  draggable: false,
}))

/** 每个框的 Konva.Rect 配置（像素坐标 → 由世界 Group 负责缩放） */
const rectConfigs = computed(() => {
  const s = view.value.scale
  return boxes.value.map((box) => {
    const color = CATEGORY_COLORS[box.category] || '#aaaaaa'
    const selected = box.id === selectedId.value
    return {
      id: box.id,
      x: box.x,
      y: box.y,
      width: Math.max(1, box.w),
      height: Math.max(1, box.h),
      stroke: color,
      strokeWidth: (selected ? 2 : 1.5) / s,
      fill: selected ? 'rgba(76,141,255,0.14)' : 'rgba(0,0,0,0)',
      dash: box.manual ? [5 / s, 3 / s] : undefined,
      draggable: true,
      // 细线也便于点选
      hitStrokeWidth: 8 / s,
      name: 'box',
      perfectDrawEnabled: false,
    }
  })
})

/** 类别标签：字号随缩放反向补偿，屏幕上始终约 11px */
const labelConfigs = computed(() => {
  const s = view.value.scale
  const fontSize = 11 / s
  return boxes.value.map((box) => {
    const color = CATEGORY_COLORS[box.category] || '#aaaaaa'
    return {
      id: `${box.id}_label`,
      text: `${CATEGORY_LABELS[box.category] || box.category}${box.score > 0 ? ` ${box.score.toFixed(2)}` : ''}`,
      x: box.x,
      y: box.y - fontSize - 3 / s,
      fontSize,
      fontFamily: 'sans-serif',
      fill: color,
      listening: false,
      name: 'label',
    }
  })
})

const transformerConfig = computed(() => {
  const box = selectedBox.value
  const color = box ? CATEGORY_COLORS[box.category] || '#aaaaaa' : '#4c8dff'
  return {
    rotateEnabled: false,
    keepRatio: false,
    enabledAnchors: [
      'top-left',
      'top-center',
      'top-right',
      'middle-right',
      'bottom-right',
      'bottom-center',
      'bottom-left',
      'middle-left',
    ],
    anchorSize: 8,
    anchorCornerRadius: 2,
    anchorStroke: color,
    anchorFill: '#ffffff',
    anchorStrokeWidth: 1.5,
    borderStroke: color,
    borderStrokeWidth: 1,
    borderDash: [] as number[],
    ignoreStroke: true,
    flipEnabled: false,
    padding: 0,
    // 太小的框不允许拖出来
    boundBoxFunc: (oldBox: { width: number; height: number }, newBox: { width: number; height: number }) =>
      newBox.width < 4 || newBox.height < 4 ? oldBox : newBox,
  }
})

const boxCount = computed(() => boxes.value.length)

// ---------------------------------------------------------------- 视图

/** 同步测量舞台尺寸（RO 回调缺失时的兜底） */
function measureStage(): void {
  const el = wrap.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.width && rect.height) stageSize.value = { width: rect.width, height: rect.height }
}

/** 适应视图：整图完整、居中（100%） */
function fitView(): void {
  if (!stageSize.value.width) measureStage()
  const scale = fitScale.value
  view.value = {
    scale,
    x: (stageSize.value.width - natural.value.width * scale) / 2,
    y: (stageSize.value.height - natural.value.height * scale) / 2,
  }
  userAdjusted = false
}

/** 以舞台某点为锚点缩放到指定比例 */
function zoomTo(nextScale: number, stageX: number, stageY: number): void {
  const clamped = Math.min(
    fitScale.value * MAX_ZOOM_RATIO,
    Math.max(fitScale.value * MIN_ZOOM_RATIO, nextScale),
  )
  if (Math.abs(clamped - view.value.scale) < 1e-6) return
  // 保持锚点处的图像内容不动：stagePoint = world + scale * imagePoint
  const ix = (stageX - view.value.x) / view.value.scale
  const iy = (stageY - view.value.y) / view.value.scale
  view.value = { scale: clamped, x: stageX - clamped * ix, y: stageY - clamped * iy }
  userAdjusted = true
}

/** 工具条缩放：以舞台中心为锚点 */
function zoomStep(factor: number): void {
  zoomTo(view.value.scale * factor, stageSize.value.width / 2, stageSize.value.height / 2)
}

// ---------------------------------------------------------------- 几何工具

/** 舞台坐标 → 图像像素坐标（经世界 Group 逆变换，Konva 内部完成） */
function pointerInImage(): { x: number; y: number } | null {
  const world = worldRef.value?.getNode() as Konva.Group | undefined
  if (!world) return null
  // 优先用 Konva 的相对指针；某些合成事件下它可能为 null，则用 stage 指针手工逆变换兜底
  let p = world.getRelativePointerPosition()
  if (!p) {
    const stage = world.getStage()
    const sp = stage?.getPointerPosition()
    if (!sp) return null
    const s = view.value.scale || 1
    p = { x: (sp.x - view.value.x) / s, y: (sp.y - view.value.y) / s }
  }
  return p ? { x: p.x, y: p.y } : null
}

/** 把框夹在图像范围内，且不小于 4px */
function clampRect(x: number, y: number, w: number, h: number) {
  const nw = Math.max(4, Math.min(w, natural.value.width))
  const nh = Math.max(4, Math.min(h, natural.value.height))
  return {
    x: Math.max(0, Math.min(x, natural.value.width - nw)),
    y: Math.max(0, Math.min(y, natural.value.height - nh)),
    w: nw,
    h: nh,
  }
}

/** 命中某像素点的所有框 id，按「上→下」排列（数组靠后 = 更上层） */
function hitStack(px: number, py: number): string[] {
  const stack: string[] = []
  for (let i = boxes.value.length - 1; i >= 0; i--) {
    const b = boxes.value[i]
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) stack.push(b.id)
  }
  return stack
}

// ---------------------------------------------------------------- 选中与 Transformer

/** 把 Transformer 挂到当前选中的 Rect 节点上 */
async function syncTransformer(): Promise<void> {
  await nextTick()
  const tr = transformerRef.value?.getNode() as Konva.Transformer | undefined
  const world = worldRef.value?.getNode() as Konva.Group | undefined
  if (!tr || !world) return
  const node = selectedId.value ? (world.findOne(`#${selectedId.value}`) as Konva.Rect | undefined) : undefined
  tr.nodes(node ? [node] : [])
  tr.getLayer()?.batchDraw()
}

watch(selectedId, () => {
  void syncTransformer()
})

/** 选中某个框 */
function select(id: string | null): void {
  if (selectedId.value === id) return
  selectedId.value = id
}

/** 删除选中框 */
function deleteSelected(): void {
  if (!selectedId.value) return
  const id = selectedId.value
  boxes.value = boxes.value.filter((b) => b.id !== id)
  selectedId.value = null
}

/** 清空全部 */
function clearAll(): void {
  boxes.value = []
  selectedId.value = null
}

/** 修改选中框类别（同步更新名称） */
function onCategoryChange(event: Event): void {
  const box = selectedBox.value
  if (!box) return
  const category = (event.target as HTMLSelectElement).value
  box.category = category
  box.label = CATEGORY_LABELS[category] || category
}

// ---------------------------------------------------------------- 属性面板拖动

/** 属性面板位置（相对画布左上角），拖动后保持，切换选中不重置 */
const propsPos = ref({ x: 8, y: 8 })
/** 面板拖动状态：记录指针与面板起点的偏移 */
let propsDrag: { startX: number; startY: number; originX: number; originY: number } | null = null

/**
 * 面板空白处按下即开始拖动。
 * 表单控件（input/select/button）上的按下不拦截，保证正常编辑与点击。
 */
function onPropsPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('input, select, button')) return
  propsDrag = { startX: event.clientX, startY: event.clientY, originX: propsPos.value.x, originY: propsPos.value.y }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}

/** 拖动面板：位置夹在画布可见范围内，避免拖丢 */
function onPropsPointerMove(event: PointerEvent): void {
  if (!propsDrag) return
  const wrapRect = wrap.value?.getBoundingClientRect()
  const panel = event.currentTarget as HTMLElement
  if (!wrapRect) return
  const maxX = Math.max(0, wrapRect.width - panel.offsetWidth - 4)
  const maxY = Math.max(0, wrapRect.height - panel.offsetHeight - 4)
  propsPos.value = {
    x: Math.min(maxX, Math.max(0, propsDrag.originX + (event.clientX - propsDrag.startX))),
    y: Math.min(maxY, Math.max(0, propsDrag.originY + (event.clientY - propsDrag.startY))),
  }
}

function onPropsPointerUp(event: PointerEvent): void {
  if (!propsDrag) return
  propsDrag = null
  const el = event.currentTarget as HTMLElement
  if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
}

// ---------------------------------------------------------------- Konva 事件

/** 从事件目标解析出所属框 id */
function boxIdFromTarget(target: Konva.Node): string | null {
  return target.name() === 'box' ? target.id() : null
}

function onMouseDown(e: Konva.KonvaEventObject<MouseEvent>): void {
  if (detecting.value) return
  const event = e.evt
  const stage = e.target.getStage()
  if (!stage) return

  // 平移：按住 Space 或鼠标中键
  if (spacePressed.value || event.button === 1) {
    const p = stage.getPointerPosition()
    if (p) panning = { startX: p.x, startY: p.y, x: view.value.x, y: view.value.y }
    event.preventDefault()
    return
  }
  if (event.button !== 0) return

  // Transformer 的锚点：交给 Konva 自身处理缩放
  if (e.target.className === 'Transformer') return

  const point = pointerInImage()
  if (!point) return

  const hitId = boxIdFromTarget(e.target)
  if (hitId) {
    // 点中框：选中（Konva 命中的就是最上层），随后由 draggable 负责移动
    select(hitId)
    return
  }

  // 空白处：开始画新框
  const id = `B${(++boxCounter).toString().padStart(3, '0')}`
  boxes.value.push({
    id,
    x: point.x,
    y: point.y,
    w: 0,
    h: 0,
    label: CATEGORY_LABELS[DEFAULT_CATEGORY] || '其它',
    category: DEFAULT_CATEGORY,
    score: 0,
    manual: true,
  })
  drawing = { anchorX: point.x, anchorY: point.y, id }
  event.preventDefault()
}

function onMouseMove(e: Konva.KonvaEventObject<MouseEvent>): void {
  const stage = e.target.getStage()
  if (!stage) return
  const container = stage.container()

  // 光标状态
  if (panning || spacePressed.value) {
    container.style.cursor = panning ? 'grabbing' : 'grab'
  } else if (e.target.className === 'Transformer') {
    container.style.cursor = 'default'
  } else if (boxIdFromTarget(e.target)) {
    container.style.cursor = 'move'
  } else {
    container.style.cursor = 'crosshair'
  }

  if (panning) {
    const p = stage.getPointerPosition()
    if (!p) return
    view.value = {
      scale: view.value.scale,
      x: panning.x + (p.x - panning.startX),
      y: panning.y + (p.y - panning.startY),
    }
    userAdjusted = true
    return
  }
  if (!drawing) return

  const point = pointerInImage()
  if (!point) return
  const box = boxes.value.find((b) => b.id === drawing!.id)
  if (!box) return
  const next = clampRect(
    Math.min(drawing.anchorX, point.x),
    Math.min(drawing.anchorY, point.y),
    Math.abs(point.x - drawing.anchorX),
    Math.abs(point.y - drawing.anchorY),
  )
  Object.assign(box, next)
}

function onMouseUp(): void {
  if (drawing) {
    const box = boxes.value.find((b) => b.id === drawing!.id)
    if (box && (box.w < 4 || box.h < 4)) {
      // 画得太小视为误触
      boxes.value = boxes.value.filter((b) => b.id !== box.id)
    } else if (box) {
      select(box.id)
    }
    drawing = null
  }
  panning = null
}

/** 拖动框结束后写回模型并夹在图像范围内 */
function onDragEnd(e: Konva.KonvaEventObject<DragEvent>): void {
  const node = e.target as Konva.Rect
  const box = boxes.value.find((b) => b.id === node.id())
  if (!box) return
  const next = clampRect(node.x(), node.y(), box.w, box.h)
  node.position({ x: next.x, y: next.y })
  box.x = next.x
  box.y = next.y
}

/** Transformer 缩放过程中实时写回模型（把 scale 归一到 width/height） */
function onTransform(e: Konva.KonvaEventObject<Event>): void {
  const node = e.target as Konva.Rect
  const box = boxes.value.find((b) => b.id === node.id())
  if (!box) return
  const sx = node.scaleX()
  const sy = node.scaleY()
  let x = node.x()
  let y = node.y()
  let w = node.width() * sx
  let h = node.height() * sy
  if (sx < 0) x += w
  if (sy < 0) y += h
  w = Math.abs(w)
  h = Math.abs(h)
  node.scaleX(1)
  node.scaleY(1)
  const next = clampRect(x, y, w, h)
  box.x = next.x
  box.y = next.y
  box.w = next.w
  box.h = next.h
  node.position({ x: next.x, y: next.y })
  node.size({ width: next.w, height: next.h })
}

/**
 * 双击：重叠框逐层向下切换。
 *
 * 浏览器双击会先派发两次 mousedown（每次都把选中抢回最顶层），再派发 dblclick。
 * 若 dblclick 直接基于「当前选中」定位，游标会被 mousedown 重置、卡在顶层↔次层。
 * 因此这里用命中栈 + 独立循环游标：同一区域连续双击时游标递增，切换不受 mousedown 影响。
 * 首次进入某重叠区域时游标置 1（从顶层进到下一层），到底后回绕顶层。
 */
let lastStackKey = ''
let cycleIndex = 0
function onDblClick(): void {
  const point = pointerInImage()
  if (!point) return
  const stack = hitStack(point.x, point.y)
  if (!stack.length) return
  const key = stack.join(',')
  if (key === lastStackKey) cycleIndex += 1
  else {
    cycleIndex = 1
    lastStackKey = key
  }
  select(stack[cycleIndex % stack.length])
}

/** 滚轮以光标为锚点缩放（原生监听，便于 preventDefault 阻止页面滚动） */
function onNativeWheel(event: WheelEvent): void {
  if (detecting.value || !stageSize.value.width) return
  event.preventDefault()
  const stage = stageRef.value?.getNode() as Konva.Stage | undefined
  if (!stage) return
  const rect = stage.container().getBoundingClientRect()
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
  zoomTo(view.value.scale * factor, event.clientX - rect.left, event.clientY - rect.top)
}

// ---------------------------------------------------------------- 键盘

function onKeydown(event: KeyboardEvent): void {
  if (event.key === ' ') {
    spacePressed.value = true
    event.preventDefault()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selectedId.value && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      deleteSelected()
    }
  } else if (event.key === 'Escape') {
    select(null)
  }
}

function onKeyup(event: KeyboardEvent): void {
  if (event.key === ' ') spacePressed.value = false
}

// ---------------------------------------------------------------- 数据与生命周期

function bindStageEvents(): void {
  const stage = stageRef.value?.getNode() as Konva.Stage | undefined
  if (!stage) return
  stage.on('mousedown', onMouseDown)
  stage.on('mousemove', onMouseMove)
  stage.on('mouseup', onMouseUp)
  stage.on('mouseleave', onMouseUp)
  stage.on('dblclick', onDblClick)
  stage.on('dragend', onDragEnd)
  stage.on('transform', onTransform)
  stage.container().addEventListener('wheel', onNativeWheel, { passive: false })
}

function unbindStageEvents(): void {
  const stage = stageRef.value?.getNode() as Konva.Stage | undefined
  if (!stage) return
  stage.off('mousedown', onMouseDown)
  stage.off('mousemove', onMouseMove)
  stage.off('mouseup', onMouseUp)
  stage.off('mouseleave', onMouseUp)
  stage.off('dblclick', onDblClick)
  stage.off('dragend', onDragEnd)
  stage.off('transform', onTransform)
  stage.container().removeEventListener('wheel', onNativeWheel)
}

/** 载入底图：拿到像素尺寸后立即适应视图 */
function loadImageElement(url: string): void {
  const img = new window.Image()
  img.onload = () => {
    natural.value = { width: img.naturalWidth, height: img.naturalHeight }
    imageNode.value = img
    nextTick(fitView)
  }
  img.onerror = () => {
    errorText.value = '源图加载失败，请重新导入。'
  }
  img.src = url
}

let resizeObserver: ResizeObserver | null = null
let cancelToken = createCancelToken()

/** stage 节点出现后再绑定事件（v-if 门控下 onMounted 时它还不存在） */
watch(stageRef, (node) => {
  if (node) bindStageEvents()
})

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  const el = wrap.value
  if (el) {
    // 同步量一次初始尺寸：ResizeObserver 首帧回调不可靠，缺了这一句画布永远不会出现
    const rect = el.getBoundingClientRect()
    stageSize.value = { width: rect.width, height: rect.height }
    resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box || !box.width) return
      stageSize.value = { width: box.width, height: box.height }
      // 用户没手动调整过视图时，尺寸变化自动重新适应，保证始终全图居中
      if (!userAdjusted) fitView()
    })
    resizeObserver.observe(el)
  }
  loadImageElement(split.value.sourceUrl)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  unbindStageEvents()
  resizeObserver?.disconnect()
  cancelToken.cancelled = true
})

// ---------------------------------------------------------------- 检测与提交

/** 自动检测：结果坐标由服务端映射回原图像素，直接可作为 Konva 世界坐标 */
async function autoDetect(): Promise<void> {
  if (detecting.value) return
  detecting.value = true
  errorText.value = ''
  cancelToken = createCancelToken()
  try {
    const blob = await (await fetch(split.value.sourceUrl)).blob()
    const result = await detectBoxes(blob, split.value.fileName, split.value.settings)
    if (cancelToken.cancelled) return
    boxes.value = result.boxes.map((b: DetectBox, i: number) => ({
      id: `D${(i + 1).toString().padStart(3, '0')}`,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      label: b.label,
      category: b.category,
      score: b.score,
      manual: false,
    }))
    boxCounter = boxes.value.length
    select(null)
    if (!boxes.value.length) errorText.value = '未检测到任何元素，请手动框选或调整检测参数后重试。'
  } catch (cause) {
    if (cancelToken.cancelled) return
    errorText.value = cause instanceof Error ? cause.message : '检测失败'
  } finally {
    detecting.value = false
  }
}

/** 确认拆分：把当前框交给上层发起作业。服务端 UserBox 要求整数像素，必须先取整 */
function confirm(): void {
  const valid = boxes.value
    .filter((b) => b.w >= 4 && b.h >= 4)
    .map((b) => {
      const x = Math.round(b.x)
      const y = Math.round(b.y)
      const w = Math.round(b.w)
      const h = Math.round(b.h)
      return { x, y, w, h, label: b.label, category: b.category }
    })
    .filter((b) => b.w >= 1 && b.h >= 1)
  if (!valid.length) {
    errorText.value = '请至少框选一个区域'
    return
  }
  emit('confirm', valid)
}
</script>

<template>
  <div class="box-editor">
    <div class="editor-toolbar">
      <button class="btn btn-primary" :disabled="detecting" @click="autoDetect">
        {{ detecting ? '检测中…' : '自动检测' }}
      </button>
      <button class="btn" :disabled="!boxes.length" @click="clearAll">清空全部</button>
      <span class="spacer"></span>
      <span class="muted">共 {{ boxCount }} 个框</span>
      <span class="spacer"></span>
      <span class="zoom-controls">
        <button class="btn btn-ghost" title="缩小" @click="zoomStep(1 / 1.25)">−</button>
        <span class="mono zoom-value">{{ zoomPercent }}</span>
        <button class="btn btn-ghost" title="放大" @click="zoomStep(1.25)">+</button>
        <button class="btn btn-ghost" title="适应：整图完整展示" @click="fitView">适应</button>
      </span>
      <button class="btn btn-ghost" @click="emit('cancel')">取消</button>
      <button class="btn btn-primary" :disabled="!boxes.length" @click="confirm">确认拆分（{{ boxes.length }}）</button>
    </div>
    <p v-if="errorText" class="warn">{{ errorText }}</p>

    <!-- 画布：单一 Konva.Stage，底图与框共用同一坐标系 -->
    <div ref="wrap" class="stage-wrap">
      <!-- 选中框的属性编辑：悬浮在画布左上角，可拖动，不占布局空间 -->
      <div
        v-if="selectedBox"
        class="box-props"
        :style="{ transform: `translate(${propsPos.x}px, ${propsPos.y}px)` }"
        @pointerdown="onPropsPointerDown"
        @pointermove="onPropsPointerMove"
        @pointerup="onPropsPointerUp"
      >
        <span class="drag-handle" title="按住拖动面板">⠿ 属性</span>
        <label class="field">
          <span class="field-label">类别</span>
          <select class="input" :value="selectedBox.category" @change="onCategoryChange">
            <option v-for="(label, key) in CATEGORY_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">名称</span>
          <input class="input" v-model="selectedBox.label" maxlength="48" />
        </label>
        <span class="mono faint">
          {{ Math.round(selectedBox.w) }}×{{ Math.round(selectedBox.h) }} · ({{ Math.round(selectedBox.x) }}, {{ Math.round(selectedBox.y) }})
        </span>
        <button class="btn btn-ghost" @click="deleteSelected">删除（Del）</button>
      </div>

      <v-stage v-if="stageSize.width" ref="stageRef" :config="stageConfig">
        <v-layer>
          <v-group ref="worldRef" :config="worldConfig">
            <v-image :config="imageConfig" />
            <v-rect v-for="cfg in rectConfigs" :key="cfg.id" :config="cfg" />
            <v-text v-for="cfg in labelConfigs" :key="cfg.id" :config="cfg" />
          </v-group>
          <v-transformer ref="transformerRef" :config="transformerConfig" />
        </v-layer>
      </v-stage>
    </div>

    <p class="hint muted">
      空白拖拽画框 · 点框体拖动移动 · 拖控制点缩放大小 · <strong>双击重叠区域逐层向下切换</strong> ·
      滚轮缩放 · 按住 Space/中键拖拽平移
    </p>
  </div>
</template>

<style scoped>
.box-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  flex: 1;
}

.editor-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: none;
}

.editor-toolbar .spacer {
  flex: 1;
}

.zoom-controls {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.zoom-value {
  min-width: 52px;
  text-align: center;
  font-size: var(--fs-caption);
}

.box-props {
  /* 悬浮在画布左上角（top/left 为 0，位置由 transform 平移），absolute 不占布局空间 */
  position: absolute;
  top: 0;
  left: 0;
  z-index: 10;
  /* 上下布局：字段纵向堆叠成紧凑卡片 */
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
  width: 168px;
  padding: var(--sp-2);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  user-select: none;
  cursor: move;
}

.box-props input,
.box-props select,
.box-props button {
  cursor: auto;
}

.drag-handle {
  color: var(--text-faint);
  font-size: var(--fs-caption);
  cursor: grab;
  flex: none;
}

.box-props .field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.box-props .field-label {
  font-size: var(--fs-caption);
  color: var(--text-faint);
}

.box-props .input {
  width: 100%;
  height: 28px;
  font-size: var(--fs-caption);
}

.box-props .mono {
  font-size: var(--fs-caption);
}

.box-props .btn {
  justify-content: center;
}

.stage-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
}

.stage-wrap :deep(div) {
  outline: none;
}

.hint {
  flex: none;
  font-size: var(--fs-caption);
  text-align: center;
}
</style>