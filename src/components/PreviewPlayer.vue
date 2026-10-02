<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { store, orderedFrames, getCropCanvas, getCropThumb, setOrder, resetOrder } from '@/store/atlas'
import type { AtlasFrame } from '@/types/atlas'

const open = ref(false)
const playing = ref(false)
const fps = ref(12)
const loop = ref(true)
const index = ref(0)
const previewRef = ref<HTMLCanvasElement>()
const dragIdx = ref<number | null>(null)

let timer: number | null = null

const frames = computed(() => {
  const selected = new Set(store.selectedIds)
  return orderedFrames.value.filter((frame) => selected.has(frame.id))
})
const current = computed(() => frames.value[index.value] ?? null)

function clampIndex(): void {
  if (index.value >= frames.value.length) index.value = Math.max(0, frames.value.length - 1)
}

watch(frames, clampIndex)

function draw(): void {
  const canvas = previewRef.value
  const frame = current.value
  if (!canvas || !frame) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#0d0f13'
  ctx.fillRect(0, 0, w, h)
  // 棋盘格
  const checker = document.createElement('canvas')
  checker.width = 16
  checker.height = 16
  const g = checker.getContext('2d')!
  g.fillStyle = '#101217'
  g.fillRect(0, 0, 16, 16)
  g.fillStyle = '#1a1d26'
  g.fillRect(0, 0, 8, 8)
  g.fillRect(8, 8, 8, 8)
  const pat = ctx.createPattern(checker, 'repeat')!
  ctx.fillStyle = pat
  ctx.fillRect(0, 0, w, h)

  const src = getCropCanvas(frame)
  if (src.width < 1 || src.height < 1) return
  const scale = Math.min((w - 16) / src.width, (h - 16) / src.height)
  const dw = src.width * scale
  const dh = src.height * scale
  ctx.imageSmoothingEnabled = scale < 1
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh)
  ctx.imageSmoothingEnabled = false
}

watch(current, draw)
watch(() => store.frames.length, draw)

function togglePlay(): void {
  playing.value = !playing.value
}

function step(d: number): void {
  if (!frames.value.length) return
  index.value = (index.value + d + frames.value.length) % frames.value.length
}

function tick(): void {
  if (!frames.value.length) return
  if (index.value >= frames.value.length - 1) {
    if (loop.value) index.value = 0
    else {
      playing.value = false
      return
    }
  } else {
    index.value++
  }
}

function syncTimer(): void {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
  if (playing.value) {
    timer = window.setInterval(tick, Math.max(1, Math.round(1000 / fps.value)))
  }
}

watch(playing, syncTimer)
watch(fps, syncTimer)

function onDragStart(i: number): void {
  dragIdx.value = i
}

function onDrop(i: number): void {
  const from = dragIdx.value
  dragIdx.value = null
  if (from === null || from === i) return
  const ids = frames.value.map((f) => f.id)
  const [moved] = ids.splice(from, 1)
  ids.splice(i, 0, moved)
  setOrder(ids)
}

function resetNatural(): void {
  resetOrder()
  index.value = 0
}

/** 帧序条缩略图（走 store 缓存，避免渲染期重复 PNG 编码） */
function thumbOf(frame: AtlasFrame): string {
  return getCropThumb(frame)
}

onMounted(() => {
  requestAnimationFrame(draw)
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
})
</script>

<template>
  <div class="flex-none border-t border-line bg-surface" :class="{ open }">
    <div
      class="flex h-[30px] cursor-pointer items-center gap-3 px-3 text-caption font-semibold tracking-[0.08em] text-faint uppercase hover:bg-hover"
      @click="open = !open"
    >
      <span class="preview-toggle">动画预览</span>
      <span class="faint mono" v-if="open && frames.length">{{ index + 1 }} / {{ frames.length }}</span>
      <span class="flex-1"></span>
      <button class="btn btn-icon" title="展开/收起" @click.stop="open = !open">{{ open ? '▾' : '▸' }}</button>
    </div>
    <div v-if="open" class="grid max-h-60 grid-cols-[300px_1fr] gap-4 border-t border-line px-4 py-3">
      <div class="relative h-50 overflow-hidden rounded-sm border border-line bg-stage">
        <canvas ref="previewRef" class="block h-full w-full"></canvas>
        <div v-if="!current" class="faint absolute inset-0 grid place-items-center">
          {{ store.frames.length ? '请在帧列表勾选要预览的帧' : '导入帧后在此预览动画' }}
        </div>
      </div>
      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <button class="btn btn-primary" :disabled="!frames.length" @click="togglePlay()">
            {{ playing ? '暂停' : '播放' }}
          </button>
          <button class="btn" :disabled="!frames.length" @click="step(-1)">上一帧</button>
          <button class="btn" :disabled="!frames.length" @click="step(1)">下一帧</button>
          <label class="check-row">
            <input v-model="loop" type="checkbox" />
            循环
          </label>
          <span class="flex-1"></span>
          <span class="faint">速度</span>
          <input v-model.number="fps" class="input fps-input w-[60px]" type="number" min="1" max="30" />
          <span class="faint mono">fps</span>
        </div>
        <div class="flex min-h-0 items-center gap-3">
          <span class="faint strip-label flex-none text-caption">帧序（拖拽调整）</span>
          <ul class="m-0 flex min-w-0 flex-1 list-none gap-1 overflow-x-auto p-1">
            <li
              v-for="(f, i) in frames"
              :key="f.id"
              class="flex w-[52px] flex-none cursor-grab flex-col items-center gap-0.5 rounded-sm border p-[3px]"
              :class="[
                i === index ? 'border-accent-border bg-accent-dim' : 'border-line bg-raised',
                i === dragIdx ? 'opacity-40' : '',
              ]"
              draggable="true"
              @dragstart="onDragStart(i)"
              @dragover.prevent
              @drop.prevent="onDrop(i)"
              @click="index = i"
              :title="f.name"
            >
              <img
                class="h-11 w-11 rounded-[2px] bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-[length:10px_10px] object-contain pointer-events-none"
                :src="thumbOf(f)"
                alt=""
                draggable="false"
              />
              <span class="mono text-[10px] text-faint">{{ i }}</span>
            </li>
          </ul>
          <button class="btn btn-ghost" @click="resetNatural()">自然排序</button>
        </div>
      </div>
    </div>
  </div>
</template>
