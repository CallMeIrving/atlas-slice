<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { clampCropRect, type ImageCropRect } from '@/core/crop'

/**
 * 帧裁切框选编辑器。
 * 舞台 + 8 个控制点 + 框外压暗 + X/Y/宽/高 输入 + 实时预览，
 * 批量裁切弹窗与一键处理弹窗共用；裁切区域的持有方是父组件（v-model）。
 */
const props = defineProps<{
  /** 裁切输入图像（已抠图的帧传抠图结果） */
  sourceUrl: string
  /** 当前裁切区域（图像像素坐标） */
  modelValue: ImageCropRect
}>()
const emit = defineEmits<{ 'update:modelValue': [value: ImageCropRect] }>()

/** 控制点方位：用于区分拖动的是哪条边 */
type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
/** 拖拽工具：draw 在任意位置重新框选，move 拖动框体位置 */
type CropTool = 'move' | 'draw'
/** 拖动状态 */
type DragState =
  | { kind: 'draw'; anchorX: number; anchorY: number }
  | { kind: 'move'; offsetX: number; offsetY: number }
  | { kind: 'resize'; handle: CropHandle }

const handles: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const stage = ref<HTMLElement>()
const sourceImage = ref<HTMLImageElement>()
const previewCanvas = ref<HTMLCanvasElement>()
/** 图像在视口中的实际渲染矩形，用于把指针位置换算成图像像素坐标 */
const imageRect = ref({ left: 0, top: 0, width: 0, height: 0 })
/** 舞台在视口中的位置，用于把图像矩形换算成舞台内定位坐标 */
const stageOrigin = ref({ left: 0, top: 0 })
/** 当前图像的原始像素尺寸 */
const natural = ref({ width: 0, height: 0 })
/** 裁切区域本地副本：以 v-model 与父组件双向同步，避免直接改写 props */
const box = ref<ImageCropRect>({ ...props.modelValue })
const tool = ref<CropTool>('move')
const dragging = ref(false)
const errorText = ref('')
let drag: DragState | null = null
/** 预览重绘的 rAF 句柄，合并拖动时的高频变更 */
let previewFrame = 0

/** 裁切框在舞台中的像素位置：按渲染缩放比把图像坐标映射回舞台内坐标 */
const boxStyle = computed(() => {
  const rect = imageRect.value
  const size = natural.value
  const ready = rect.width > 0 && size.width > 0
  const scaleX = ready ? rect.width / size.width : 0
  const scaleY = ready ? rect.height / size.height : 0
  const offsetX = rect.left - stageOrigin.value.left
  const offsetY = rect.top - stageOrigin.value.top
  return {
    display: ready ? 'block' : 'none',
    left: `${offsetX + box.value.x * scaleX}px`,
    top: `${offsetY + box.value.y * scaleY}px`,
    width: `${box.value.width * scaleX}px`,
    height: `${box.value.height * scaleY}px`,
  }
})

/** 更新裁切区域（唯一出口，保证父子单一数据源） */
function setBox(rect: ImageCropRect): void {
  box.value = rect
  emit('update:modelValue', { ...rect })
}

/** 数值收敛到 [min, max] */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 计算图像与舞台在视口中的位置，窗口尺寸变化与图片加载后都需要重新测量 */
function measure(): void {
  const image = sourceImage.value
  const container = stage.value
  if (!image || !container) return
  const rect = image.getBoundingClientRect()
  const origin = container.getBoundingClientRect()
  imageRect.value = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  stageOrigin.value = { left: origin.left, top: origin.top }
}

/** 指针位置 → 图像像素坐标（超出图像范围时收敛到边界，无有效尺寸时返回 null） */
function toImagePoint(event: PointerEvent): { x: number; y: number } | null {
  const rect = imageRect.value
  const size = natural.value
  if (!rect.width || !rect.height || !size.width) return null
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * size.width, 0, size.width),
    y: clamp(((event.clientY - rect.top) / rect.height) * size.height, 0, size.height),
  }
}

/** 图像加载完成：记录原始尺寸、沿用已选区域（无有效区域则整帧），并绘制预览 */
function onImageLoad(): void {
  const image = sourceImage.value
  if (!image) return
  const width = image.naturalWidth
  const height = image.naturalHeight
  natural.value = { width, height }
  const initial = box.value.width > 0 && box.value.height > 0
    ? box.value
    : { x: 0, y: 0, width, height }
  setBox(clampCropRect(initial, width, height))
  measure()
  renderPreview()
}

/** 按当前裁切框直接绘制预览，走 canvas 避免拖动时反复做 PNG 编码 */
function renderPreview(): void {
  const image = sourceImage.value
  const canvas = previewCanvas.value
  if (!image || !canvas || !image.naturalWidth) return
  const area = clampCropRect(box.value, image.naturalWidth, image.naturalHeight)
  canvas.width = area.width
  canvas.height = area.height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height)
}

/** 用 rAF 合并拖动过程中的高频预览重绘 */
function schedulePreview(): void {
  if (previewFrame) return
  previewFrame = window.requestAnimationFrame(() => {
    previewFrame = 0
    renderPreview()
  })
}

/** 按拖动模式更新裁切框，各分支都把矩形约束在图像范围内 */
function applyDrag(point: { x: number; y: number }): void {
  const mode = drag
  if (!mode) return
  const size = natural.value
  const current = box.value
  if (mode.kind === 'draw') {
    setBox({
      x: Math.min(mode.anchorX, point.x),
      y: Math.min(mode.anchorY, point.y),
      width: Math.max(1, Math.abs(point.x - mode.anchorX)),
      height: Math.max(1, Math.abs(point.y - mode.anchorY)),
    })
    return
  }
  if (mode.kind === 'move') {
    setBox({
      ...current,
      x: clamp(point.x - mode.offsetX, 0, size.width - current.width),
      y: clamp(point.y - mode.offsetY, 0, size.height - current.height),
    })
    return
  }
  let left = current.x
  let top = current.y
  let right = current.x + current.width
  let bottom = current.y + current.height
  if (mode.handle.includes('w')) left = clamp(point.x, 0, right - 1)
  if (mode.handle.includes('e')) right = clamp(point.x, left + 1, size.width)
  if (mode.handle.includes('n')) top = clamp(point.y, 0, bottom - 1)
  if (mode.handle.includes('s')) bottom = clamp(point.y, top + 1, size.height)
  setBox({ x: left, y: top, width: right - left, height: bottom - top })
}

/** 拖动过程中的指针移动：统一在 window 上监听，指针移出舞台也不会中断 */
function onPointerMove(event: PointerEvent): void {
  const point = toImagePoint(event)
  if (point) applyDrag(point)
}

/** 结束拖动并移除全局监听 */
function stopDrag(): void {
  drag = null
  dragging.value = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
}

/** 开始拖动：window 级监听保证松开鼠标一定能收尾 */
function startDrag(mode: DragState, event: PointerEvent): void {
  drag = mode
  dragging.value = true
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
  event.preventDefault()
}

/** 以按下点为锚点重新框选 */
function beginDraw(event: PointerEvent): void {
  measure()
  const point = toImagePoint(event)
  if (!point) return
  setBox({ x: point.x, y: point.y, width: 1, height: 1 })
  startDrag({ kind: 'draw', anchorX: point.x, anchorY: point.y }, event)
}

/** 舞台空白处按下：直接进入重新框选 */
function onStageDown(event: PointerEvent): void {
  beginDraw(event)
}

/** 框体内按下：框选工具继续重新框选，调整工具整体移动 */
function onBoxDown(event: PointerEvent): void {
  if (tool.value === 'draw') {
    beginDraw(event)
    return
  }
  measure()
  const point = toImagePoint(event)
  if (!point) return
  startDrag({ kind: 'move', offsetX: point.x - box.value.x, offsetY: point.y - box.value.y }, event)
}

/** 控制点按下：只调整对应边 */
function onHandleDown(handle: CropHandle, event: PointerEvent): void {
  measure()
  startDrag({ kind: 'resize', handle }, event)
}

/** 手动输入后把矩形收敛到图像范围内 */
function normalizeBox(): void {
  const size = natural.value
  if (!size.width || !size.height) return
  setBox(clampCropRect(box.value, size.width, size.height))
}

/** 恢复为整帧范围 */
function fullFrame(): void {
  const size = natural.value
  if (!size.width || !size.height) return
  setBox({ x: 0, y: 0, width: size.width, height: size.height })
}

// 裁切区域变化（拖拽 / 输入）后重绘预览
watch(box, schedulePreview, { deep: true })
// 父组件重置裁切区域（如打开弹窗时带入已应用的区域）后同步本地副本
watch(() => props.modelValue, (value) => {
  if (value.x !== box.value.x || value.y !== box.value.y || value.width !== box.value.width || value.height !== box.value.height) box.value = { ...value }
}, { deep: true })

onMounted(() => {
  window.addEventListener('resize', measure)
  void measure()
})

onBeforeUnmount(() => {
  stopDrag()
  window.removeEventListener('resize', measure)
  if (previewFrame) window.cancelAnimationFrame(previewFrame)
})
</script>

<template>
  <div class="crop-editor">
    <div class="crop-compare">
      <figure class="crop-pane">
        <figcaption class="faint">框选区域 · 拖拽空白处重新框选，拖动框体移动，拖动控制点调整大小</figcaption>
        <div ref="stage" class="crop-stage" :class="{ dragging }" @pointerdown="onStageDown">
          <img
            v-if="sourceUrl"
            ref="sourceImage"
            :src="sourceUrl"
            alt="裁切原图"
            draggable="false"
            @load="onImageLoad"
            @error="errorText = '图像加载失败'"
          />
          <span v-else class="faint">暂无可裁切的图像</span>
          <div class="crop-box" :style="boxStyle" @pointerdown.stop="onBoxDown">
            <span
              v-for="handle in handles"
              :key="handle"
              class="crop-handle"
              :class="`h-${handle}`"
              @pointerdown.stop="onHandleDown(handle, $event)"
            ></span>
          </div>
        </div>
      </figure>
      <figure class="crop-pane">
        <figcaption class="faint">裁切预览 · {{ Math.round(box.width) }} × {{ Math.round(box.height) }} px</figcaption>
        <div class="crop-stage checker">
          <canvas ref="previewCanvas" aria-label="裁切预览"></canvas>
        </div>
      </figure>
    </div>

    <div class="crop-fields">
      <label class="field">
        <span class="field-label">X</span>
        <input v-model.number="box.x" class="input" type="number" min="0" :max="natural.width" @change="normalizeBox" />
      </label>
      <label class="field">
        <span class="field-label">Y</span>
        <input v-model.number="box.y" class="input" type="number" min="0" :max="natural.height" @change="normalizeBox" />
      </label>
      <label class="field">
        <span class="field-label">宽度</span>
        <input v-model.number="box.width" class="input" type="number" min="1" :max="natural.width" @change="normalizeBox" />
      </label>
      <label class="field">
        <span class="field-label">高度</span>
        <input v-model.number="box.height" class="input" type="number" min="1" :max="natural.height" @change="normalizeBox" />
      </label>
      <div class="field">
        <span class="field-label">拖拽工具</span>
        <div class="seg">
          <button class="seg-item" :class="{ active: tool === 'move' }" @click="tool = 'move'">调整框选</button>
          <button class="seg-item" :class="{ active: tool === 'draw' }" @click="tool = 'draw'">重新框选</button>
        </div>
      </div>
      <div class="field">
        <span class="field-label">快捷操作</span>
        <button class="btn" :disabled="!natural.width" @click="fullFrame">整帧</button>
      </div>
    </div>

    <p class="modal-help">
      裁切区域以帧图像像素为单位，会按同一坐标应用到全部帧；已抠图的帧在抠图结果上裁剪，因此抠图后再裁切也不会丢失透明背景。
      输入框与拖拽会实时同步，右侧预览即时可见。整帧范围等价于取消裁切。
    </p>

    <p v-if="errorText" class="crop-error">{{ errorText }}</p>
  </div>
</template>

<style scoped>
.crop-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.crop-compare {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: var(--sp-3);
}

.crop-pane {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.crop-pane figcaption {
  font-size: var(--fs-caption);
}

.crop-stage {
  position: relative;
  height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: var(--sp-2);
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  cursor: crosshair;
  touch-action: none;
}

.crop-stage.checker {
  background-color: var(--checker-b);
  background-image: linear-gradient(45deg, var(--checker-a) 25%, transparent 25%), linear-gradient(-45deg, var(--checker-a) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--checker-a) 75%), linear-gradient(-45deg, transparent 75%, var(--checker-a) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  cursor: default;
}

.crop-stage img,
.crop-stage canvas {
  max-width: 100%;
  max-height: 100%;
  display: block;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}

.crop-box {
  position: absolute;
  border: 1px solid var(--accent);
  /* 超大扩散阴影实现框外压暗，配合舞台 overflow: hidden 裁掉多余部分 */
  box-shadow: 0 0 0 9999px rgba(8, 10, 14, 0.55);
  cursor: move;
  touch-action: none;
}

.crop-stage.dragging .crop-box {
  box-shadow: 0 0 0 9999px rgba(8, 10, 14, 0.68);
}

.crop-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  background: var(--accent);
  border: 1px solid #1a140a;
  border-radius: 2px;
}

.h-nw { left: 0; top: 0; cursor: nwse-resize; }
.h-n { left: 50%; top: 0; cursor: ns-resize; }
.h-ne { left: 100%; top: 0; cursor: nesw-resize; }
.h-e { left: 100%; top: 50%; cursor: ew-resize; }
.h-se { left: 100%; top: 100%; cursor: nwse-resize; }
.h-s { left: 50%; top: 100%; cursor: ns-resize; }
.h-sw { left: 0; top: 100%; cursor: nesw-resize; }
.h-w { left: 0; top: 50%; cursor: ew-resize; }

.crop-fields {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr)) auto auto;
  gap: var(--sp-3) var(--sp-4);
  align-items: end;
}

.crop-fields .input {
  width: 100%;
}

.crop-editor .modal-help {
  margin: 0;
}

.crop-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
}
</style>