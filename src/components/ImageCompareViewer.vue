<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 通用图片前后对比查看器。
 * 单舞台叠加 before/after 两层：分割线在舞台（屏幕）空间裁切 after 层，
 * 两层共享同一 transform（缩放/平移），保证像素级对齐且分割线不随平移漂移。
 * 支持滚轮以光标为中心缩放、空白拖拽平移、双击复位、分割线拖动；
 * 通过 #overlay 插槽可在 before 层内叠加跟随缩放平移的内容（如 ROI 框选）。
 */

const props = withDefaults(
  defineProps<{
    /** 原图地址（对比的左侧/底图） */
    beforeUrl: string
    /** 结果图地址；为空时只渲染原图层、无分割线 */
    afterUrl?: string
    /** 原图角标文案 */
    beforeLabel?: string
    /** 结果图角标文案 */
    afterLabel?: string
    /** 分割线位置（0–100，v-model:divider） */
    divider?: number
    /** 最小缩放倍率 */
    minZoom?: number
    /** 最大缩放倍率 */
    maxZoom?: number
    /** 框选模式：空白处按下不平移，改为 emit background-down 交给父组件处理 */
    selectionMode?: boolean
  }>(),
  {
    afterUrl: '',
    beforeLabel: '原图',
    afterLabel: '结果',
    divider: 50,
    minZoom: 1,
    maxZoom: 8,
    selectionMode: false,
  },
)

const emit = defineEmits<{
  'update:divider': [value: number]
  /** selectionMode 下舞台空白处按下 */
  'background-down': [event: PointerEvent]
  /** 原图加载完成（携带原始像素尺寸） */
  load: [natural: { width: number; height: number }]
}>()

const stage = ref<HTMLElement>()
const beforeImage = ref<HTMLImageElement>()

/** 原图原始像素尺寸 */
const natural = ref({ width: 0, height: 0 })
/** 舞台可视区尺寸（CSS 像素） */
const stageSize = ref({ width: 0, height: 0 })
/** 缩放倍率（1 = 适应舞台） */
const zoom = ref(1)
/** 平移偏移（屏幕像素，相对舞台中心） */
const pan = ref({ x: 0, y: 0 })
/** 正在平移拖拽 */
const panning = ref(false)
let panPointer: { id: number; startX: number; startY: number; baseX: number; baseY: number } | null = null
/** 分割线拖拽指针 id */
let dividerPointer: number | null = null
let resizeObserver: ResizeObserver | undefined

/** 适应舞台时的显示尺寸：长边不放大（与抠图页 fit 规则一致） */
const fitSize = computed(() => {
  const { width: natW, height: natH } = natural.value
  const { width: stageW, height: stageH } = stageSize.value
  if (!natW || !natH || !stageW || !stageH) return { width: 0, height: 0 }
  const scale = Math.min(stageW / natW, stageH / natH, 1)
  return { width: Math.max(1, Math.round(natW * scale)), height: Math.max(1, Math.round(natH * scale)) }
})

/** 两层共享的 transform：显式 px 尺寸 + translate·scale，保证 before/after 严格对齐 */
const boxStyle = computed(() => ({
  width: `${fitSize.value.width}px`,
  height: `${fitSize.value.height}px`,
  transform: `translate3d(${pan.value.x}px, ${pan.value.y}px, 0) scale(${zoom.value})`,
}))

/** 平移钳制：图像放大后边缘不得离开舞台中心区，zoom=1 时自动回中 */
function clampPan(): void {
  const limitX = Math.max(0, (fitSize.value.width * zoom.value - stageSize.value.width) / 2)
  const limitY = Math.max(0, (fitSize.value.height * zoom.value - stageSize.value.height) / 2)
  pan.value = {
    x: Math.min(Math.max(pan.value.x, -limitX), limitX),
    y: Math.min(Math.max(pan.value.y, -limitY), limitY),
  }
}

/**
 * 以指定舞台内坐标为不动点缩放：
 * pan' = c - ((c - pan) / oldZoom) * newZoom，c 为该点相对舞台中心的偏移。
 */
function applyZoom(nextZoom: number, localX?: number, localY?: number): void {
  const bounds = stageSize.value
  const centerX = (localX ?? bounds.width / 2) - bounds.width / 2
  const centerY = (localY ?? bounds.height / 2) - bounds.height / 2
  const oldZoom = zoom.value
  const newZoom = Math.min(props.maxZoom, Math.max(props.minZoom, nextZoom))
  pan.value = {
    x: centerX - ((centerX - pan.value.x) / oldZoom) * newZoom,
    y: centerY - ((centerY - pan.value.y) / oldZoom) * newZoom,
  }
  zoom.value = newZoom
  clampPan()
}

/** 滚轮缩放：以光标位置为中心 */
function onWheel(event: WheelEvent): void {
  const bounds = stage.value?.getBoundingClientRect()
  if (!bounds) return
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
  applyZoom(zoom.value * factor, event.clientX - bounds.left, event.clientY - bounds.top)
}

/** 复位视图：只还原缩放与平移，分割线保持 */
function resetView(): void {
  zoom.value = props.minZoom
  pan.value = { x: 0, y: 0 }
}

defineExpose({ resetView, getImageEl: () => beforeImage.value })

/** 舞台按下：框选模式交给父组件；否则开始平移拖拽 */
function onStageDown(event: PointerEvent): void {
  if (event.button !== 0) return
  if (props.selectionMode) {
    emit('background-down', event)
    return
  }
  if (zoom.value <= props.minZoom) return
  panPointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, baseX: pan.value.x, baseY: pan.value.y }
  panning.value = true
  stage.value?.setPointerCapture(event.pointerId)
}

/** 平移拖拽移动 */
function onStageMove(event: PointerEvent): void {
  const active = panPointer
  if (!active || active.id !== event.pointerId) return
  pan.value = { x: active.baseX + event.clientX - active.startX, y: active.baseY + event.clientY - active.startY }
  clampPan()
}

/** 结束平移拖拽 */
function onStageUp(event: PointerEvent): void {
  if (panPointer?.id !== event.pointerId) return
  panPointer = null
  panning.value = false
}

/** 分割线按下：捕获指针，拖动中实时换算舞台内百分比 */
function onDividerDown(event: PointerEvent): void {
  dividerPointer = event.pointerId
  event.target instanceof Element && event.target.setPointerCapture(event.pointerId)
}

/** 分割线拖动：位置钳制在 [0, 100] */
function onDividerMove(event: PointerEvent): void {
  if (dividerPointer !== event.pointerId) return
  const bounds = stage.value?.getBoundingClientRect()
  if (!bounds) return
  const value = ((event.clientX - bounds.left) / bounds.width) * 100
  emit('update:divider', Math.min(100, Math.max(0, value)))
}

/** 结束分割线拖动 */
function onDividerUp(event: PointerEvent): void {
  if (dividerPointer === event.pointerId) dividerPointer = null
}

/** 原图加载完成：记录尺寸并复位视图 */
function onBeforeLoad(): void {
  const image = beforeImage.value
  if (!image) return
  natural.value = { width: image.naturalWidth, height: image.naturalHeight }
  resetView()
  emit('load', { ...natural.value })
}

/** 量一次舞台尺寸（ResizeObserver 首帧回调不可靠，挂载时先同步量一次） */
function measureStage(): void {
  const bounds = stage.value?.getBoundingClientRect()
  if (bounds) stageSize.value = { width: bounds.width, height: bounds.height }
  clampPan()
}

// 换图时旧的 transform 无意义：复位视图与分割线
watch(() => props.beforeUrl, () => {
  resetView()
  emit('update:divider', 50)
})

onMounted(() => {
  if (stage.value) {
    resizeObserver = new ResizeObserver(measureStage)
    resizeObserver.observe(stage.value)
  }
  measureStage()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
})
</script>

<template>
  <div
    ref="stage"
    class="cmp-stage"
    :class="{ 'selection-mode': props.selectionMode, panning }"
    @wheel.prevent="onWheel"
    @pointerdown="onStageDown"
    @pointermove="onStageMove"
    @pointerup="onStageUp"
    @pointercancel="onStageUp"
    @dblclick="resetView"
  >
    <div class="cmp-layer">
      <div class="cmp-box" :style="boxStyle">
        <img ref="beforeImage" :src="props.beforeUrl" alt="原图" draggable="false" @load="onBeforeLoad" />
        <div class="cmp-overlay">
          <!-- 叠加内容位于 transform 容器内，与 img 显示盒重合，天然跟随缩放平移 -->
          <slot name="overlay" :img="beforeImage" :natural="natural" :display="fitSize" :zoom="zoom"></slot>
        </div>
      </div>
    </div>

    <div v-if="props.afterUrl" class="cmp-layer cmp-after" :style="{ clipPath: `inset(0 0 0 ${props.divider}%)` }">
      <div class="cmp-box" :style="boxStyle">
        <img :src="props.afterUrl" alt="结果图" draggable="false" />
      </div>
    </div>

    <div
      v-if="props.afterUrl"
      class="cmp-divider"
      :style="{ left: `${props.divider}%` }"
      @pointerdown.stop="onDividerDown"
      @pointermove="onDividerMove"
      @pointerup="onDividerUp"
      @pointercancel="onDividerUp"
    >
      <span class="cmp-divider-handle">⇔</span>
    </div>

    <template v-if="props.afterUrl">
      <span class="cmp-label label-before">{{ props.beforeLabel }}</span>
      <span class="cmp-label label-after">{{ props.afterLabel }}</span>
    </template>

    <div class="cmp-zoombar" @pointerdown.stop>
      <button class="cmp-zoom-btn" :disabled="zoom <= props.minZoom" title="缩小" @click="applyZoom(zoom / 1.2)">−</button>
      <span class="cmp-zoom-value mono">{{ Math.round(zoom * 100) }}%</span>
      <button class="cmp-zoom-btn" :disabled="zoom >= props.maxZoom" title="放大" @click="applyZoom(zoom * 1.2)">＋</button>
      <button class="cmp-fit-btn" title="复位视图" @click="resetView">复位</button>
    </div>
  </div>
</template>

<style scoped>
.cmp-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  touch-action: none;
  cursor: default;
}
.cmp-stage.selection-mode { cursor: crosshair; }
.cmp-stage.panning { cursor: grabbing; }

/* 图层铺满舞台并居中，transform 只作用于内层显示盒 */
.cmp-layer {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
/* after 层的 clip-path 作用在舞台空间：分割线屏幕位置恒定，不随平移漂移 */
.cmp-after { clip-path: inset(0 0 0 50%); }

.cmp-box { position: relative; flex: none; }
.cmp-box img { width: 100%; height: 100%; display: block; object-fit: fill; user-select: none; -webkit-user-drag: none; }

.cmp-overlay { position: absolute; inset: 0; pointer-events: none; }

.cmp-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--accent);
  cursor: ew-resize;
  z-index: 2;
}
.cmp-divider-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);
  color: #1a140a;
  font-size: 14px;
  user-select: none;
}

.cmp-label {
  position: absolute;
  top: 8px;
  z-index: 2;
  padding: 2px 8px;
  border-radius: var(--radius-s);
  background: rgba(8, 10, 14, 0.66);
  color: var(--text);
  font-size: var(--fs-caption);
  pointer-events: none;
}
.label-before { left: 8px; }
.label-after { right: 8px; }

.cmp-zoombar {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-raised);
}
.cmp-zoom-btn { width: 26px; height: 26px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-raised); color: var(--text); cursor: pointer; font-size: 15px; line-height: 1; }
.cmp-zoom-btn:disabled { opacity: 0.4; cursor: default; }
.cmp-zoom-value { min-width: 44px; font-size: var(--fs-caption); color: var(--text-muted); text-align: center; }
.cmp-fit-btn { height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-raised); color: var(--text); font-size: var(--fs-caption); cursor: pointer; }
.cmp-zoom-btn:not(:disabled):hover, .cmp-fit-btn:hover { border-color: var(--accent); color: var(--accent); }
</style>
