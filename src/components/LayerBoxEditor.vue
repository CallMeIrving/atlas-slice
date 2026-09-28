<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { detectBoxes, type DetectBox, type UserBox } from '@/core/layer-split'
import { workspace, type LayerCategory } from '@/store/workspace'
import { createCancelToken } from '@/core/frame-extract'

/**
 * 多框编辑器：在源图上叠加检测框 / 用户框，支持拖拽移动、缩放、删除、新建。
 * 用户确认后 emit confirm，携带最终框选列表交给页面提交拆分。
 */

const emit = defineEmits<{
  confirm: [boxes: UserBox[]]
  cancel: []
}>()

/** 编辑器中的框（检测来源的有 score，用户新增的 score=0） */
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
  background: '#888',
  other: '#aaa',
}

const DEFAULT_CATEGORY: LayerCategory = 'other'

const stage = ref<HTMLElement>()
const sourceImage = ref<HTMLImageElement>()
const boxes = ref<EditBox[]>([])
const selectedId = ref<string | null>(null)
const detecting = ref(false)
const errorText = ref('')
/** 图像在视口中的渲染矩形 */
const imageRect = ref({ left: 0, top: 0, width: 0, height: 0 })
/** 原图像素尺寸 */
const natural = ref({ width: 0, height: 0 })

let boxCounter = 0
let drag: DragState | null = null

type DragState =
  | { kind: 'draw'; anchorX: number; anchorY: number }
  | { kind: 'move'; boxId: string; offsetX: number; offsetY: number }
  | { kind: 'resize'; boxId: string; handle: ResizeHandle }

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const split = computed(() => workspace.layersplit)
const selectedBox = computed(() => boxes.value.find((b) => b.id === selectedId.value) || null)

/** 把视口坐标换算为图像像素坐标 */
function toImageCoords(clientX: number, clientY: number): { x: number; y: number } {
  const rect = imageRect.value
  if (!rect.width || !natural.value.width) return { x: 0, y: 0 }
  const scaleX = natural.value.width / rect.width
  const scaleY = natural.value.height / rect.height
  return {
    x: Math.round((clientX - rect.left) * scaleX),
    y: Math.round((clientY - rect.top) * scaleY),
  }
}

/** 把图像像素坐标换算为舞台内 CSS 像素坐标 */
function toCssCoords(x: number, y: number, w: number, h: number): { left: number; top: number; width: number; height: number } {
  const rect = imageRect.value
  if (!rect.width || !natural.value.width) return { left: 0, top: 0, width: 0, height: 0 }
  const scaleX = rect.width / natural.value.width
  const scaleY = rect.height / natural.value.height
  return {
    left: rect.left + x * scaleX,
    top: rect.top + y * scaleY,
    width: w * scaleX,
    height: h * scaleY,
  }
}

function boxStyle(box: EditBox): Record<string, string> {
  const { left, top, width, height } = toCssCoords(box.x, box.y, box.w, box.h)
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    borderColor: CATEGORY_COLORS[box.category] || '#aaa',
    borderStyle: box.manual ? 'dashed' : 'solid',
  }
}

function clampBox(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const nw = Math.max(4, w)
  const nh = Math.max(4, h)
  return {
    x: Math.max(0, Math.min(x, natural.value.width - nw)),
    y: Math.max(0, Math.min(y, natural.value.height - nh)),
    w: Math.min(nw, natural.value.width),
    h: Math.min(nh, natural.value.height),
  }
}

/** 测量图像渲染矩形 */
function measureImageRect(): void {
  const img = sourceImage.value
  const stageEl = stage.value
  if (!img || !stageEl) return
  const imgRect = img.getBoundingClientRect()
  const stageRect = stageEl.getBoundingClientRect()
  imageRect.value = {
    left: imgRect.left - stageRect.left,
    top: imgRect.top - stageRect.top,
    width: imgRect.width,
    height: imgRect.height,
  }
}

function onSourceLoaded(): void {
  const img = sourceImage.value
  if (!img) return
  natural.value = { width: img.naturalWidth, height: img.naturalHeight }
  measureImageRect()
}

/** 指针按下：判断是新建框、移动框、还是缩放框 */
function onPointerDown(event: PointerEvent): void {
  if (detecting.value) return
  const target = event.target as HTMLElement
  const stageEl = stage.value
  if (!stageEl) return

  // 点击了控制点 → 缩放
  const handleEl = target.closest('[data-handle]') as HTMLElement | null
  if (handleEl) {
    const boxId = handleEl.closest('[data-box-id]')?.getAttribute('data-box-id')
    const handle = handleEl.getAttribute('data-handle') as ResizeHandle
    if (boxId && handle) {
      selectedId.value = boxId
      drag = { kind: 'resize', boxId, handle }
      stageEl.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
  }

  // 点击了框体 → 移动
  const boxEl = target.closest('[data-box-id]') as HTMLElement | null
  if (boxEl) {
    const boxId = boxEl.getAttribute('data-box-id')
    if (boxId) {
      selectedId.value = boxId
      const pt = toImageCoords(event.clientX, event.clientY)
      const box = boxes.value.find((b) => b.id === boxId)
      if (box) {
        drag = { kind: 'move', boxId, offsetX: pt.x - box.x, offsetY: pt.y - box.y }
      }
      stageEl.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
  }

  // 空白处 → 新建框
  const pt = toImageCoords(event.clientX, event.clientY)
  const id = `B${(++boxCounter).toString().padStart(3, '0')}`
  const newBox: EditBox = {
    id,
    x: pt.x,
    y: pt.y,
    w: 0,
    h: 0,
    label: CATEGORY_LABELS[DEFAULT_CATEGORY] || '其它',
    category: DEFAULT_CATEGORY,
    score: 0,
    manual: true,
  }
  boxes.value.push(newBox)
  selectedId.value = id
  drag = { kind: 'draw', anchorX: pt.x, anchorY: pt.y }
  stageEl.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  if (!drag) return
  const pt = toImageCoords(event.clientX, event.clientY)
  const state = drag

  if (state.kind === 'draw') {
    const box = boxes.value.find((b) => b.id === selectedId.value)
    if (!box) return
    const x = Math.min(state.anchorX, pt.x)
    const y = Math.min(state.anchorY, pt.y)
    const w = Math.abs(pt.x - state.anchorX)
    const h = Math.abs(pt.y - state.anchorY)
    Object.assign(box, clampBox(x, y, w, h))
  } else if (state.kind === 'move') {
    const box = boxes.value.find((b) => b.id === state.boxId)
    if (!box) return
    const clamped = clampBox(pt.x - state.offsetX, pt.y - state.offsetY, box.w, box.h)
    box.x = clamped.x
    box.y = clamped.y
  } else if (state.kind === 'resize') {
    const box = boxes.value.find((b) => b.id === state.boxId)
    if (!box) return
    let { x: x1, y: y1, w, h } = box
    let x2 = x1 + w
    let y2 = y1 + h
    const handle = state.handle
    if (handle.includes('w')) x1 = pt.x
    if (handle.includes('n')) y1 = pt.y
    if (handle.includes('e')) x2 = pt.x
    if (handle.includes('s')) y2 = pt.y
    const nx = Math.min(x1, x2)
    const ny = Math.min(y1, y2)
    const nw = Math.abs(x2 - x1)
    const nh = Math.abs(y2 - y1)
    const clamped = clampBox(nx, ny, nw, nh)
    box.x = clamped.x
    box.y = clamped.y
    box.w = clamped.w
    box.h = clamped.h
  }
}

function onPointerUp(event: PointerEvent): void {
  if (!drag) return
  const stageEl = stage.value
  if (stageEl) stageEl.releasePointerCapture(event.pointerId)

  // 新建框太小则删除
  if (drag.kind === 'draw') {
    const box = boxes.value.find((b) => b.id === selectedId.value)
    if (box && (box.w < 4 || box.h < 4)) {
      boxes.value = boxes.value.filter((b) => b.id !== box.id)
      selectedId.value = null
    }
  }
  drag = null
}

/** 删除选中框 */
function deleteSelected(): void {
  if (!selectedId.value) return
  boxes.value = boxes.value.filter((b) => b.id !== selectedId.value)
  selectedId.value = null
}

/** 清空全部 */
function clearAll(): void {
  boxes.value = []
  selectedId.value = null
}

/** 自动检测 */
let cancelToken = { cancelled: false }
async function autoDetect(): Promise<void> {
  if (detecting.value) return
  detecting.value = true
  errorText.value = ''
  cancelToken = createCancelToken()
  try {
    const blob = await (await fetch(split.value.sourceUrl)).blob()
    const result = await detectBoxes(blob, split.value.fileName, split.value.settings)
    if (cancelToken.cancelled) return
    // 映射检测结果到 EditBox
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
    if (!boxes.value.length) {
      errorText.value = '未检测到任何元素，请手动框选或调整检测参数后重试。'
    }
    // 更新图像尺寸（可能被缩放）
    if (result.width && result.height) {
      natural.value = { width: result.width, height: result.height }
    }
  } catch (cause) {
    if (cancelToken.cancelled) return
    errorText.value = cause instanceof Error ? cause.message : '检测失败'
  } finally {
    detecting.value = false
  }
}

/** 确认拆分 */
function confirm(): void {
  const valid = boxes.value.filter((b) => b.w >= 4 && b.h >= 4)
  if (!valid.length) {
    errorText.value = '请至少框选一个区域'
    return
  }
  const userBoxes: UserBox[] = valid.map((b) => ({
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    label: b.label,
    category: b.category,
  }))
  emit('confirm', userBoxes)
}

/** 修改选中框的类别 */
function changeCategory(category: string): void {
  if (!selectedBox.value) return
  selectedBox.value.category = category
  selectedBox.value.label = CATEGORY_LABELS[category] || category
}

/** select change 事件转字符串 */
function onCategoryChange(event: Event): void {
  changeCategory((event.target as HTMLSelectElement).value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selectedId.value && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      deleteSelected()
    }
  } else if (event.key === 'Escape') {
    selectedId.value = null
  }
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', measureImageRect)
  const stageEl = stage.value
  if (stageEl) {
    resizeObserver = new ResizeObserver(() => measureImageRect())
    resizeObserver.observe(stageEl)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', measureImageRect)
  resizeObserver?.disconnect()
  cancelToken.cancelled = true
})
</script>

<template>
  <div class="box-editor">
    <div class="editor-toolbar">
      <button class="btn btn-primary" :disabled="detecting" @click="autoDetect">
        {{ detecting ? '检测中…' : '自动检测' }}
      </button>
      <button class="btn" :disabled="!boxes.length" @click="clearAll">清空全部</button>
      <span class="spacer"></span>
      <span class="muted">共 {{ boxes.length }} 个框</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost" @click="emit('cancel')">取消</button>
      <button class="btn btn-primary" :disabled="!boxes.length" @click="confirm">确认拆分（{{ boxes.length }}）</button>
    </div>
    <p v-if="errorText" class="warn">{{ errorText }}</p>

    <!-- 选中框的属性编辑 -->
    <div v-if="selectedBox" class="box-props">
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
        {{ selectedBox.w }}×{{ selectedBox.h }} · ({{ selectedBox.x }}, {{ selectedBox.y }})
      </span>
      <button class="btn btn-ghost" @click="deleteSelected">删除（Del）</button>
    </div>

    <!-- 舞台 -->
    <div ref="stage" class="stage" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp">
      <img
        ref="sourceImage"
        :src="split.sourceUrl"
        alt="待编辑素材"
        @load="onSourceLoaded"
        draggable="false"
      />
      <!-- 框叠层 -->
      <div
        v-for="box in boxes"
        :key="box.id"
        class="edit-box"
        :class="{ selected: box.id === selectedId }"
        :data-box-id="box.id"
        :style="boxStyle(box)"
      >
        <span class="box-label">{{ CATEGORY_LABELS[box.category] || box.category }}{{ box.score > 0 ? ` ${box.score.toFixed(2)}` : '' }}</span>
        <template v-if="box.id === selectedId">
          <span v-for="h in HANDLES" :key="h" :class="['handle', h]" :data-handle="h"></span>
        </template>
      </div>
    </div>

    <p class="hint muted">
      空白处拖拽画新框 · 点框体选中后拖动移动 · 拖控制点调整大小 · Delete 删除选中
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

.box-props {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex: none;
  padding: var(--sp-2);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
}

.box-props .field {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.box-props .field-label {
  font-size: var(--fs-caption);
  color: var(--text-faint);
}

.box-props .input {
  height: 28px;
  font-size: var(--fs-caption);
}

.box-props .mono {
  font-size: var(--fs-caption);
}

.stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  touch-action: none;
  cursor: crosshair;
}

.stage img {
  max-width: 100%;
  max-height: 100%;
  min-height: 0;
  object-fit: contain;
  user-select: none;
  pointer-events: none;
}

.edit-box {
  position: absolute;
  border: 2px solid;
  border-radius: 2px;
  cursor: move;
  box-sizing: border-box;
}

.edit-box.selected {
  background: rgba(76, 141, 255, 0.1);
  z-index: 2;
}

.edit-box:hover {
  background: rgba(255, 255, 255, 0.05);
}

.box-label {
  position: absolute;
  top: -18px;
  left: 0;
  font-size: 10px;
  line-height: 1;
  padding: 2px 4px;
  background: var(--surface);
  border-radius: 2px;
  white-space: nowrap;
  pointer-events: none;
}

.handle {
  position: absolute;
  width: 10px;
  height: 10px;
  background: var(--surface);
  border: 1.5px solid var(--accent, #4c8dff);
  border-radius: 50%;
  pointer-events: none;
}

.handle.nw { top: -5px; left: -5px; cursor: nw-resize; }
.handle.n  { top: -5px; left: 50%; margin-left: -5px; cursor: n-resize; }
.handle.ne { top: -5px; right: -5px; cursor: ne-resize; }
.handle.e  { top: 50%; right: -5px; margin-top: -5px; cursor: e-resize; }
.handle.se { bottom: -5px; right: -5px; cursor: se-resize; }
.handle.s  { bottom: -5px; left: 50%; margin-left: -5px; cursor: s-resize; }
.handle.sw { bottom: -5px; left: -5px; cursor: sw-resize; }
.handle.w  { top: 50%; left: -5px; margin-top: -5px; cursor: w-resize; }

.hint {
  flex: none;
  font-size: var(--fs-caption);
  text-align: center;
}
</style>
