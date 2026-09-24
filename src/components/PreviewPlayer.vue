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
  <div class="preview" :class="{ open }">
    <div class="preview-bar" @click="open = !open">
      <span class="preview-toggle">动画预览</span>
      <span class="faint mono" v-if="open && frames.length">{{ index + 1 }} / {{ frames.length }}</span>
      <span class="spacer"></span>
      <button class="btn btn-icon" title="展开/收起" @click.stop="open = !open">{{ open ? '▾' : '▸' }}</button>
    </div>
    <div v-if="open" class="preview-body">
      <div class="preview-stage">
        <canvas ref="previewRef" class="preview-canvas"></canvas>
        <div v-if="!current" class="preview-empty faint">
          {{ store.frames.length ? '请在帧列表勾选要预览的帧' : '导入帧后在此预览动画' }}
        </div>
      </div>
      <div class="preview-controls">
        <div class="play-row">
          <button class="btn btn-primary" :disabled="!frames.length" @click="togglePlay()">
            {{ playing ? '暂停' : '播放' }}
          </button>
          <button class="btn" :disabled="!frames.length" @click="step(-1)">上一帧</button>
          <button class="btn" :disabled="!frames.length" @click="step(1)">下一帧</button>
          <label class="check-row">
            <input v-model="loop" type="checkbox" />
            循环
          </label>
          <span class="spacer"></span>
          <span class="faint">速度</span>
          <input v-model.number="fps" class="input fps-input" type="number" min="1" max="30" />
          <span class="faint mono">fps</span>
        </div>
        <div class="strip-row">
          <span class="faint strip-label">帧序（拖拽调整）</span>
          <ul class="strip">
            <li
              v-for="(f, i) in frames"
              :key="f.id"
              class="strip-item"
              :class="{ active: i === index, drag: i === dragIdx }"
              draggable="true"
              @dragstart="onDragStart(i)"
              @dragover.prevent
              @drop.prevent="onDrop(i)"
              @click="index = i"
              :title="f.name"
            >
              <img :src="thumbOf(f)" alt="" draggable="false" />
              <span class="mono">{{ i }}</span>
            </li>
          </ul>
          <button class="btn btn-ghost" @click="resetNatural()">自然排序</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview {
  flex: none;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.preview-bar {
  height: 30px;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 var(--sp-3);
  cursor: pointer;
  font-size: var(--fs-caption);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.preview-bar:hover {
  background: var(--surface-hover);
}

.spacer {
  flex: 1;
}

.preview-body {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--border);
  max-height: 240px;
}

.preview-stage {
  position: relative;
  height: 200px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--stage);
  overflow: hidden;
}

.preview-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.preview-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}

.preview-controls {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.play-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.fps-input {
  width: 60px;
}

.strip-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 0;
}

.strip-label {
  flex: none;
  font-size: var(--fs-caption);
}

.strip {
  flex: 1;
  min-width: 0;
  list-style: none;
  margin: 0;
  padding: var(--sp-1);
  display: flex;
  gap: 4px;
  overflow-x: auto;
}

.strip-item {
  flex: none;
  width: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  cursor: grab;
  background: var(--surface-raised);
}

.strip-item.active {
  border-color: var(--accent-border);
  background: var(--accent-dim);
}

.strip-item.drag {
  opacity: 0.4;
}

.strip-item img {
  width: 44px;
  height: 44px;
  object-fit: contain;
  background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 10px 10px;
  border-radius: 2px;
  pointer-events: none;
}

.strip-item span {
  font-size: 10px;
  color: var(--text-faint);
}
</style>
