<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { groupAnimations } from '@/core/atlas-meta'
import { loadImage, releaseCanvas } from '@/core/image'
import { drawFrame } from '@/core/pack'
import type { AtlasPackPageResult } from '@/store/workspace'

/**
 * 雪碧图动画预览：把当前页图集按落位抠帧，按文件名或落位顺序循环播放。
 * FPS / 循环 / 播放暂停可调，requestAnimationFrame + 时间累积驱动，与画布尺寸解耦。
 */

const props = defineProps<{ result: AtlasPackPageResult; previewUrl: string }>()

/** 单个预览帧：只保留抠帧需要的几何字段 */
interface PreviewFrame {
  name: string
  x: number
  y: number
  w: number
  h: number
  rotated: boolean
}

/** 帧序：按文件名自然排序（walk-2 < walk-10）或按打包落位顺序 */
const order = ref<'name' | 'placement'>('name')
const fps = ref(12)
const playing = ref(true)
const loop = ref(false)
const frameIndex = ref(0)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
/** 悬浮面板位置；null 时停留在默认右下角，首次拖动后转为绝对坐标 */
const pos = ref<{ x: number; y: number } | null>(null)
/** 拖动中的指针与面板位置基准 */
let dragStart: { px: number; py: number; x: number; y: number } | null = null

/** 解码后的图集图像与预渲染帧画布均为非响应式大对象 */
let atlasImg: HTMLImageElement | null = null
let frameCanvases: HTMLCanvasElement[] = []
let rafId = 0
let lastTime = 0
let acc = 0
let dirty = true

/** 命名动画分组（按文件名结尾数字聚合，2 帧以上才算） */
const animGroups = computed(() => groupAnimations(props.result.placements.map((p) => p.name)))
/** 当前播放的动画组名；空串 = 全部帧 */
const activeAnim = ref('')
watch(animGroups, (groups) => {
  if (activeAnim.value && !groups[activeAnim.value]) activeAnim.value = ''
})

/** 帧列表：选中动画组时按组内顺序播放，否则文件名序（localeCompare 数值比较）或落位序 */
const frames = computed<PreviewFrame[]>(() => {
  const all: PreviewFrame[] = props.result.placements.map((p) => ({
    name: p.name, x: p.x, y: p.y, w: p.w, h: p.h, rotated: p.rotated,
  }))
  const selected = activeAnim.value ? animGroups.value[activeAnim.value] : null
  if (selected) {
    const byName = new Map(all.map((f) => [f.name, f]))
    return selected.map((name) => byName.get(name)).filter((f): f is PreviewFrame => Boolean(f))
  }
  if (order.value === 'name') {
    all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }
  return all
})

/** 画布尺寸取最大帧，变尺寸帧居中绘制，避免画布来回跳动 */
const frameSize = computed(() => ({
  w: Math.max(1, ...frames.value.map((f) => f.w)),
  h: Math.max(1, ...frames.value.map((f) => f.h)),
}))

/** 重建帧画布缓存：图集图像或帧列表变化后调用 */
function rebuild(): void {
  frameCanvases.forEach(releaseCanvas)
  frameCanvases = []
  if (!atlasImg) { dirty = true; return }
  frameCanvases = frames.value.map((frame) => drawFrame(atlasImg!, frame))
  if (frameIndex.value >= frames.value.length) frameIndex.value = 0
  dirty = true
}

/** 把当前帧画布居中绘制到展示画布 */
function draw(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const { w, h } = frameSize.value
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, w, h)
  const frame = frameCanvases[frameIndex.value]
  if (frame) ctx.drawImage(frame, Math.floor((w - frame.width) / 2), Math.floor((h - frame.height) / 2))
}

/** 前进一帧：非循环模式在末帧暂停 */
function advance(): void {
  const count = frames.value.length
  if (!count) return
  if (frameIndex.value + 1 < count) {
    frameIndex.value++
  } else if (loop.value) {
    frameIndex.value = 0
  } else {
    playing.value = false
  }
  dirty = true
}

/** 主循环：按 FPS 累积时间推进帧，仅在内容变化时重绘 */
function tick(time: number): void {
  rafId = requestAnimationFrame(tick)
  const dt = lastTime ? time - lastTime : 0
  lastTime = time
  if (playing.value && frames.value.length) {
    acc += dt
    const interval = 1000 / Math.max(1, fps.value)
    // 上限防止后台标签页切回后一次性补帧造成快进
    while (acc >= interval && acc < 250) {
      acc -= interval
      advance()
    }
    if (acc >= 250) acc = 0
  }
  if (dirty) {
    dirty = false
    draw()
  }
}

/** FPS 输入收敛到 1-30 的整数 */
function clampFps(): void {
  fps.value = Math.min(30, Math.max(1, Math.round(fps.value || 12)))
}

/** 开始拖动：把默认右下角定位换算成绝对坐标并锁定指针 */
function onDragStart(e: PointerEvent): void {
  const panel = panelRef.value
  if (!panel) return
  const rect = panel.getBoundingClientRect()
  pos.value = pos.value ?? { x: rect.left, y: rect.top }
  dragStart = { px: e.clientX, py: e.clientY, x: pos.value.x, y: pos.value.y }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

/** 拖动中更新面板位置，并钳制在视口范围内 */
function onDragMove(e: PointerEvent): void {
  if (!dragStart || !panelRef.value) return
  const rect = panelRef.value.getBoundingClientRect()
  const x = Math.min(Math.max(0, dragStart.x + e.clientX - dragStart.px), window.innerWidth - rect.width)
  const y = Math.min(Math.max(0, dragStart.y + e.clientY - dragStart.py), window.innerHeight - rect.height)
  pos.value = { x, y }
}

/** 结束拖动 */
function onDragEnd(): void {
  dragStart = null
}

watch(() => props.previewUrl, async (url) => {
  atlasImg = null
  try {
    atlasImg = await loadImage(url, '图集加载失败')
  } catch { /* 预览区保持空白，不影响打包结果 */ }
  rebuild()
}, { immediate: true })

watch(frames, rebuild)

onMounted(() => {
  rafId = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  frameCanvases.forEach(releaseCanvas)
  frameCanvases = []
})
</script>

<template>
  <div
    v-if="frames.length"
    ref="panelRef"
    class="anim-preview fixed right-5 bottom-5 z-50 w-[232px] flex flex-col gap-2 px-3 py-2 bg-raised border border-line rounded-sm [box-shadow:0_8px_24px_rgb(0_0_0_/_35%)]"
    :class="{ 'right-auto bottom-auto': pos }"
    :style="pos ? { left: `${pos.x}px`, top: `${pos.y}px` } : undefined"
  >
    <div
      class="anim-header flex items-baseline justify-between gap-2 cursor-grab select-none touch-none active:cursor-grabbing"
      title="拖动移动面板"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <strong class="text-caption">动画预览</strong>
      <span class="mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" :title="frames[frameIndex]?.name">{{ frameIndex + 1 }} / {{ frames.length }}</span>
    </div>
    <div class="anim-stage flex items-center justify-center min-h-[72px] p-1 border border-line rounded-sm bg-[repeating-conic-gradient(var(--stage)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
      <canvas ref="canvasRef" class="anim-canvas max-w-full max-h-[110px] [image-rendering:pixelated]"></canvas>
    </div>
    <div class="anim-controls flex items-center gap-2">
      <button class="btn btn-play flex-none" @click="playing = !playing">{{ playing ? '暂停' : '播放' }}</button>
      <label class="anim-fps flex items-center gap-1 flex-1 min-w-0">
        <span class="muted">FPS</span>
        <input v-model.number="fps" class="input w-full" type="number" min="1" max="30" @change="clampFps" />
      </label>
      <label class="anim-check flex items-center gap-1 whitespace-nowrap text-caption"><input v-model="loop" type="checkbox" /> 循环</label>
    </div>
    <div class="anim-selects flex flex-col gap-2">
      <label v-if="Object.keys(animGroups).length" class="anim-order flex items-center gap-2">
        <span class="muted">动画</span>
        <select v-model="activeAnim" class="select flex-1">
          <option value="">全部帧</option>
          <option v-for="(names, base) in animGroups" :key="base" :value="base">{{ base }}（{{ names.length }}）</option>
        </select>
      </label>
      <label class="anim-order flex items-center gap-2">
        <span class="muted">帧序</span>
        <select v-model="order" class="select flex-1" :disabled="Boolean(activeAnim)">
          <option value="name">按文件名</option>
          <option value="placement">按落位顺序</option>
        </select>
      </label>
    </div>
  </div>
</template>
