<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 波形包络绘制。
 * 只接收「每格峰值」数组（由 buildWaveformPeaks 生成），不持有 PCM，
 * 因此素材列表与结果列表可以各自画图而不额外占用内存。
 *
 * 开启 selectable 后可在波形上拖选区间，选区以归一化比例（0..1）对外汇报，
 * 由父组件换算成秒，组件自身不关心时长。
 */
export interface WaveSelection {
  start: number
  end: number
}

const props = withDefaults(
  defineProps<{
    peaks: Float32Array
    height?: number
    /** 波形颜色（canvas 不解析 CSS 变量，需传实际色值） */
    color?: string
    /** 是否叠加中轴线 */
    axis?: boolean
    /** 是否允许拖选区间 */
    selectable?: boolean
    /** 当前选区（归一化 0..1），null 表示无选区 */
    selection?: WaveSelection | null
  }>(),
  { height: 44, color: '#e8a23d', axis: true, selectable: false, selection: null },
)

const emit = defineEmits<{ select: [selection: WaveSelection | null] }>()

const canvas = ref<HTMLCanvasElement>()
const dragging = ref(false)
/** 拖拽起点（归一化），仅拖拽期间有效 */
let anchor = 0

const SELECTION_FILL = 'rgba(232,162,61,0.22)'
/** 小于该比例的拖拽视为单击，用于清除选区 */
const CLICK_EPSILON = 0.004

function draw(): void {
  const el = canvas.value
  if (!el) return
  const width = el.clientWidth
  if (width <= 0) return
  const dpr = window.devicePixelRatio || 1
  const height = props.height
  el.width = Math.max(1, Math.round(width * dpr))
  el.height = Math.max(1, Math.round(height * dpr))
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const mid = height / 2
  if (props.axis) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(width, mid)
    ctx.stroke()
  }

  const peaks = props.peaks
  if (peaks && peaks.length > 0) {
    ctx.fillStyle = props.color
    const barWidth = Math.max(1, width / peaks.length)
    for (let i = 0; i < peaks.length; i++) {
      const amplitude = Math.min(1, Math.abs(peaks[i]))
      const barHeight = Math.max(1, amplitude * (height - 2))
      const x = i * barWidth
      ctx.fillRect(x, mid - barHeight / 2, Math.max(0.6, barWidth - 0.6), barHeight)
    }
  }

  if (!props.selectable || !props.selection) return
  const x1 = Math.round(props.selection.start * width)
  const x2 = Math.round(props.selection.end * width)
  ctx.fillStyle = SELECTION_FILL
  ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height)
  ctx.fillStyle = props.color
  ctx.fillRect(x1, 0, 2, height)
  ctx.fillRect(Math.max(0, x2 - 2), 0, 2, height)
}

/** 事件坐标 → 归一化位置 */
function positionOf(event: PointerEvent): number {
  const el = canvas.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
}

function onPointerDown(event: PointerEvent): void {
  if (!props.selectable || event.button !== 0) return
  anchor = positionOf(event)
  dragging.value = true
  canvas.value?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  const current = positionOf(event)
  emit('select', { start: Math.min(anchor, current), end: Math.max(anchor, current) })
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId)
  const current = positionOf(event)
  // 没有拖动幅度的单击视为清除选区，便于快速取消
  if (Math.abs(current - anchor) < CLICK_EPSILON) emit('select', null)
}

let observer: ResizeObserver | null = null

onMounted(() => {
  draw()
  if (canvas.value?.parentElement) {
    observer = new ResizeObserver(() => draw())
    observer.observe(canvas.value.parentElement)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(() => props.peaks, draw)
watch(() => props.height, draw)
watch(() => props.selection, draw, { deep: true })
watch(() => props.selectable, draw)
</script>

<template>
  <canvas
    ref="canvas"
    class="waveform"
    :class="{ selectable: props.selectable, dragging }"
    :style="{ height: `${props.height}px` }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  ></canvas>
</template>

<style scoped>
.waveform {
  display: block;
  width: 100%;
}
.waveform.selectable {
  cursor: crosshair;
  touch-action: none;
}
.waveform.selectable.dragging {
  cursor: ew-resize;
}
</style>
