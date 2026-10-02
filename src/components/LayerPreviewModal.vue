<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { downloadLayerPng } from '@/core/layer-split'
import type { LayerCategory, SplitLayer } from '@/store/workspace'

/**
 * 单图层资源查看弹窗。
 * 棋盘格衬底看透明边缘；默认「适应窗口」，可切 1:1 或手动缩放；
 * ←/→ 在列表顺序里前后切换（含隐藏层，方便对照），Esc 关闭。
 */
const props = defineProps<{ layers: SplitLayer[]; currentId: string }>()
const emit = defineEmits<{ close: []; 'update:currentId': [value: string] }>()

const CATEGORY_LABELS: Record<LayerCategory, string> = {
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

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]

const stageRef = ref<HTMLElement | null>(null)
const stageSize = ref({ w: 0, h: 0 })
/** null = 适应窗口；数字 = 固定缩放倍率 */
const zoom = ref<number | null>(null)
const downloading = ref(false)
const error = ref('')

const index = computed(() => props.layers.findIndex((layer) => layer.id === props.currentId))
const layer = computed(() => (index.value >= 0 ? props.layers[index.value] : null))

/** 适应窗口倍率：允许小图放大铺满，但不超过 8 倍避免像素糊得看不清 */
const fitScale = computed(() => {
  const current = layer.value
  const { w, h } = stageSize.value
  if (!current || !w || !h) return 1
  return Math.min(w / current.alphaBbox.w, h / current.alphaBbox.h, 8)
})
const scale = computed(() => zoom.value ?? fitScale.value)

const displaySize = computed(() => {
  const current = layer.value
  if (!current) return { w: 0, h: 0 }
  return {
    w: Math.max(1, Math.round(current.alphaBbox.w * scale.value)),
    h: Math.max(1, Math.round(current.alphaBbox.h * scale.value)),
  }
})

/** 切换相邻图层：按当前列表顺序走，到头循环 */
function step(delta: number): void {
  const count = props.layers.length
  if (!count || index.value < 0) return
  const next = (index.value + delta + count) % count
  zoom.value = null
  error.value = ''
  emit('update:currentId', props.layers[next].id)
}

/** 缩放：以当前实际倍率为基准跳到最近档位；从「适应」起步也连续 */
function zoomStep(delta: number): void {
  const current = scale.value
  const next =
    delta > 0
      ? ZOOM_STEPS.find((value) => value > current + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
      : [...ZOOM_STEPS].reverse().find((value) => value < current - 1e-6) ?? ZOOM_STEPS[0]
  zoom.value = next
}

async function download(): Promise<void> {
  const current = layer.value
  if (!current || downloading.value) return
  downloading.value = true
  error.value = ''
  try {
    await downloadLayerPng(current)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '下载失败'
  } finally {
    downloading.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
  else if (event.key === 'ArrowLeft') step(-1)
  else if (event.key === 'ArrowRight') step(1)
}

let observer: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  const stage = stageRef.value
  if (stage) {
    // 用 ResizeObserver 量舞台尺寸，适应模式随窗口变化
    observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) stageSize.value = { w: rect.width, h: rect.height }
    })
    observer.observe(stage)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  observer?.disconnect()
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section v-if="layer" class="modal flex w-[min(880px,calc(100vw-48px))] flex-col" role="dialog" aria-modal="true" aria-labelledby="layer-preview-title">
      <div class="modal-head">
        <div class="min-w-0">
          <h2 id="layer-preview-title">{{ layer.name }}</h2>
          <p class="faint mt-0.5 mb-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {{ CATEGORY_LABELS[layer.category] ?? layer.category }} · {{ layer.label }} ·
            置信 {{ layer.score > 0 ? layer.score.toFixed(2) : '—' }} ·
            {{ layer.alphaBbox.w }}×{{ layer.alphaBbox.h }} px ·
            位于 ({{ layer.alphaBbox.x }}, {{ layer.alphaBbox.y }})
            <template v-if="layer.text"> · 文本「{{ layer.text }}」</template>
          </p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="emit('close')">×</button>
      </div>

      <div ref="stageRef" class="mx-4 grid h-[56vh] min-h-[200px] place-items-center overflow-auto rounded-sm border border-line bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-[length:16px_16px]">
        <img
          class="flex-none select-none [image-rendering:pixelated]"
          :src="layer.pngUrl"
          :alt="layer.name"
          :style="{ width: `${displaySize.w}px`, height: `${displaySize.h}px` }"
          draggable="false"
        />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 px-4 pt-3 pb-4">
        <div class="flex items-center gap-2">
          <button class="btn btn-ghost" title="上一层（←）" @click="step(-1)">← 上一层</button>
          <span class="mono faint">{{ index + 1 }} / {{ layers.length }}</span>
          <button class="btn btn-ghost" title="下一层（→）" @click="step(1)">下一层 →</button>
        </div>
        <div class="flex items-center gap-2">
          <button class="btn btn-ghost" title="缩小" @click="zoomStep(-1)">−</button>
          <span class="mono min-w-11 text-center">{{ Math.round(scale * 100) }}%</span>
          <button class="btn btn-ghost" title="放大" @click="zoomStep(1)">＋</button>
          <button class="btn btn-ghost" :class="zoom === null ? 'border-accent-border text-accent-strong' : ''" @click="zoom = null">适应</button>
          <button class="btn btn-ghost" :class="zoom === 1 ? 'border-accent-border text-accent-strong' : ''" @click="zoom = 1">1:1</button>
        </div>
        <div class="flex items-center gap-2">
          <button class="btn" :disabled="downloading" @click="download">
            {{ downloading ? '下载中…' : '下载 PNG' }}
          </button>
        </div>
      </div>
      <p v-if="error" class="warn mx-4 mt-0 mb-3">{{ error }}</p>
    </section>
  </div>
</template>
