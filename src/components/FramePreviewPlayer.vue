<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { PreviewFrameLike } from '@/store/workspace'
import { loadImage } from '@/core/image'

/**
 * 帧动画预览播放器。
 * 视频帧页的动画预览、一键处理弹窗的最终预览与独立的洋葱皮模块共用：
 * 大图 + 上一帧/播放/下一帧/循环/FPS + 洋葱皮叠加。
 * 播放范围由传入的 frames 决定（视频帧页传的是勾选帧）。
 *
 * 洋葱皮：当前帧前后各 N 帧按透明度叠加到同一画布，越远的层越淡，用于观察相邻帧的运动轨迹。
 * 图像按帧 id 缓存解码结果，缓存键含 URL，帧被处理（裁切/抠图/去水印）换图后自动重载。
 */
const props = withDefaults(defineProps<{
  /** 播放的帧列表（仅需 id + 展示图像 URL） */
  frames: PreviewFrameLike[]
  /** 当前显示的帧 id */
  currentId: string | null
  /** 可选初始参数：缺省用组件内部默认值（组件内调节不回写，页面重新创建时按此重置） */
  fps?: number
  loop?: boolean
  onionEnabled?: boolean
  onionBefore?: number
  onionAfter?: number
  onionAlpha?: number
  /** 前后帧着色区分（过去=暖橙 / 未来=冷蓝），动画软件惯例 */
  onionTint?: boolean
}>(), {
  fps: 12,
  loop: true,
  onionEnabled: false,
  onionBefore: 2,
  onionAfter: 2,
  onionAlpha: 0.35,
  onionTint: false,
})
const emit = defineEmits<{ 'update:currentId': [value: string | null] }>()

const playing = ref(false)
const loop = ref(props.loop)
const fps = ref(props.fps)
let timer: number | null = null

/** 洋葱皮开关与参数：前后各 N 帧（0-5）+ 基础透明度，邻近层按 0.6 倍逐层衰减 */
const onion = ref(props.onionEnabled)
const onionBefore = ref(props.onionBefore)
const onionAfter = ref(props.onionAfter)
const onionAlpha = ref(props.onionAlpha)

const canvasRef = ref<HTMLCanvasElement | null>(null)
/** 已解码的帧图像缓存：id → { url, img }，避免每切一帧重新解码 */
const imageCache = new Map<string, { url: string; img: HTMLImageElement }>()
/** 着色层缓存：`${id}|${kind}` → { url, canvas }，避免每次重绘都过一遍临时画布 */
const tintCache = new Map<string, { url: string; canvas: HTMLCanvasElement }>()
/** 递增的加载版本号，过期的异步解码结果直接作废，防止快速切帧时串层 */
let loadVersion = 0

/** 帧列表 id 序列：用于在帧增删后重新校验当前帧，避免深度监听整个帧数组 */
const ids = computed(() => props.frames.map((frame) => frame.id).join(','))
const index = computed(() => {
  const found = props.frames.findIndex((frame) => frame.id === props.currentId)
  return found >= 0 ? found : 0
})
const current = computed<PreviewFrameLike | null>(() => props.frames[index.value] ?? null)

/** 停止播放并清除定时器 */
function stop(): void {
  if (timer !== null) window.clearInterval(timer)
  timer = null
  playing.value = false
}

/** 切到下一帧：循环关闭时停在末帧并停止播放 */
function next(): void {
  if (!props.frames.length) return
  if (index.value >= props.frames.length - 1) {
    if (loop.value) emit('update:currentId', props.frames[0].id)
    else { stop(); return }
  } else {
    emit('update:currentId', props.frames[index.value + 1].id)
  }
}

/** 切到上一帧：循环开启时从末帧回绕 */
function previous(): void {
  if (!props.frames.length) return
  const target = index.value <= 0 ? (loop.value ? props.frames.length - 1 : 0) : index.value - 1
  emit('update:currentId', props.frames[target].id)
}

/** 开始/暂停播放 */
function toggle(): void {
  if (playing.value) { stop(); return }
  if (!props.frames.length) return
  playing.value = true
  timer = window.setInterval(next, 1000 / Math.max(1, fps.value))
}

/** 把洋葱皮帧数收敛到 0-5、透明度收敛到 0.05-0.9 */
function clampOnionSettings(): void {
  const clamp = (value: number) => Math.min(5, Math.max(0, Math.round(value || 0)))
  onionBefore.value = clamp(onionBefore.value)
  onionAfter.value = clamp(onionAfter.value)
  onionAlpha.value = Math.min(0.9, Math.max(0.05, Number(onionAlpha.value) || 0.35))
}

/**
 * 按洋葱皮参数收集当前帧与邻居层，画到同一画布。
 * 先画远处的层（透明度更淡），当前帧最后以全不透明盖顶；层与层之间靠画布缩放尺寸对齐（同源视频帧同尺寸）。
 * 开启着色时过去帧染暖橙、未来帧染冷蓝（保留部分原色），轨迹方向一眼可辨。
 */
const TINT_COLORS = { past: '#ff9d45', future: '#4da3ff' } as const

/** 取层的绘制源：着色开启且已缓存着色结果则用缓存，否则现画一张着色画布 */
function tintedSource(id: string, kind: 'past' | 'future'): HTMLImageElement | HTMLCanvasElement | null {
  const entry = imageCache.get(id)
  if (!entry) return null
  if (!props.onionTint) return entry.img
  const key = `${id}|${kind}`
  const cached = tintCache.get(key)
  if (cached && cached.url === entry.url) return cached.canvas
  const tinted = document.createElement('canvas')
  tinted.width = entry.img.naturalWidth
  tinted.height = entry.img.naturalHeight
  const ctx = tinted.getContext('2d')!
  ctx.drawImage(entry.img, 0, 0)
  // source-atop 只覆盖非透明像素，保住原有 alpha 形状
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = 0.65
  ctx.fillStyle = TINT_COLORS[kind]
  ctx.fillRect(0, 0, tinted.width, tinted.height)
  tintCache.set(key, { url: entry.url, canvas: tinted })
  return tinted
}

function draw(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const cur = current.value ? imageCache.get(current.value.id) : undefined
  if (!cur) {
    canvas.width = 1
    canvas.height = 1
    return
  }
  const layers: { src: HTMLImageElement | HTMLCanvasElement; w: number; h: number; alpha: number }[] = []
  if (onion.value) {
    const before = Math.min(onionBefore.value, index.value)
    const after = Math.min(onionAfter.value, props.frames.length - 1 - index.value)
    const pushLayer = (id: string, distance: number, kind: 'past' | 'future') => {
      const src = tintedSource(id, kind)
      if (!src) return
      const w = 'naturalWidth' in src ? src.naturalWidth : src.width
      const h = 'naturalHeight' in src ? src.naturalHeight : src.height
      layers.push({ src, w, h, alpha: onionAlpha.value * Math.pow(0.6, distance - 1) })
    }
    for (let d = 1; d <= before; d++) pushLayer(props.frames[index.value - d].id, d, 'past')
    for (let d = 1; d <= after; d++) pushLayer(props.frames[index.value + d].id, d, 'future')
    // 透明度低的（远的）先画，透明度高的（近的）叠在上面
    layers.sort((a, b) => a.alpha - b.alpha)
  }
  const w = Math.max(cur.img.naturalWidth, ...layers.map((layer) => layer.w))
  const h = Math.max(cur.img.naturalHeight, ...layers.map((layer) => layer.h))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  ctx.imageSmoothingEnabled = false
  for (const layer of layers) {
    ctx.globalAlpha = layer.alpha
    ctx.drawImage(layer.src, 0, 0)
  }
  ctx.globalAlpha = 1
  ctx.drawImage(cur.img, 0, 0)
}

/**
 * 确保当前帧与洋葱皮邻居帧已解码（缓存命中跳过），随后立即重绘。
 * 异步解码用版本号作废过期结果；缓存按帧 id 记录 URL，帧换图（裁切/抠图）时自动重载。
 */
function ensureLoaded(): void {
  if (!current.value) return
  const version = ++loadVersion
  const needed: PreviewFrameLike[] = [current.value]
  if (onion.value) {
    for (let d = 1; d <= Math.min(onionBefore.value, index.value); d++) needed.push(props.frames[index.value - d])
    for (let d = 1; d <= Math.min(onionAfter.value, props.frames.length - 1 - index.value); d++) needed.push(props.frames[index.value + d])
  }
  needed.forEach((frame) => {
    const url = frame.url
    const entry = imageCache.get(frame.id)
    if (entry) {
      // 同一帧换了处理结果图则作废旧缓存
      if (entry.url === url) return
      imageCache.delete(frame.id)
    }
    loadImage(url).then((img) => {
      if (version !== loadVersion) return
      imageCache.set(frame.id, { url, img })
      draw()
    }).catch(() => {
      // 单帧解码失败只缺失该层，不影响主帧显示
    })
  })
  // 超出 64 个只保留最近访问的，防止大量帧反复翻阅时缓存无限增长
  while (imageCache.size > 64) {
    const oldest = imageCache.keys().next().value
    if (oldest === undefined) break
    imageCache.delete(oldest)
  }
  draw()
}

// 帧列表变化后：为空则停止播放，当前帧已被移除则回退到首帧，并清理已不在列表中的缓存
watch(ids, () => {
  if (!props.frames.length) { stop(); return }
  if (!props.frames.some((frame) => frame.id === props.currentId)) emit('update:currentId', props.frames[0].id)
  const alive = new Set(props.frames.map((frame) => frame.id))
  for (const [id] of imageCache) if (!alive.has(id)) imageCache.delete(id)
  ensureLoaded()
})
// FPS 变化后按新间隔重启定时器
watch(fps, () => { if (playing.value) { stop(); toggle() } })
// 当前帧变化后重新加载邻居并重绘；immediate 保证挂载后立即加载首帧
watch(index, ensureLoaded, { immediate: true })
// 洋葱皮参数变化后重绘；画布挂载后立即画一次
watch([onion, onionBefore, onionAfter, onionAlpha], ensureLoaded, { immediate: true })
watch(canvasRef, () => draw())
// 着色开关变化：清着色缓存并重绘（缓存条目本身带 url 校验，这里主动失效更即时）
watch(() => props.onionTint, () => { tintCache.clear(); draw() })
onBeforeUnmount(() => {
  stop()
  imageCache.clear()
  tintCache.clear()
})

/** 页面级快捷键（←/→ 切帧、空格播放）通过 ref 调用这三个方法 */
defineExpose({ next, previous, toggle })
</script>

<template>
  <div class="preview-player flex flex-col flex-[1_1_auto] min-h-0">
    <div class="preview-large flex-1 min-h-0 flex items-center justify-center overflow-hidden p-2 bg-stage">
      <canvas v-if="current" ref="canvasRef" class="preview-canvas max-w-full max-h-full w-auto h-auto [image-rendering:pixelated]"></canvas>
      <span v-else class="muted text-faint">没有可预览的帧</span>
    </div>
    <div class="preview-controls flex-none min-h-[44px] flex items-center gap-1.5 justify-center p-1.5 border-t border-line">
      <button class="btn btn-icon" :disabled="!frames.length" @click="previous">‹</button>
      <button class="btn" :disabled="!frames.length" @click="toggle">{{ playing ? '暂停' : '播放' }}</button>
      <button class="btn btn-icon" :disabled="!frames.length" @click="next">›</button>
      <span v-if="current" class="badge">{{ index + 1 }} / {{ frames.length }}</span>
      <label class="check-row"><input v-model="loop" type="checkbox" /> 循环</label>
      <label class="fps-control flex items-center gap-1 text-faint">FPS <input v-model.number="fps" class="input w-[54px]" min="1" max="60" type="number" /></label>
      <label class="check-row"><input v-model="onion" type="checkbox" /> 洋葱皮</label>
    </div>
    <div v-if="onion" class="onion-controls flex-none min-h-9 flex items-center justify-center gap-2.5 py-1 px-2 border-t border-line text-faint text-caption">
      <label class="onion-num flex items-center gap-1">前 <input v-model.number="onionBefore" class="input w-11" type="number" min="0" max="5" @change="clampOnionSettings" /></label>
      <label class="onion-num flex items-center gap-1">后 <input v-model.number="onionAfter" class="input w-11" type="number" min="0" max="5" @change="clampOnionSettings" /></label>
      <label class="onion-alpha flex items-center gap-1.5">
        透明度
        <input v-model.number="onionAlpha" class="range w-[90px]" type="range" min="0.05" max="0.9" step="0.05" @change="clampOnionSettings" />
        <span class="mono min-w-8">{{ Math.round(onionAlpha * 100) }}%</span>
      </label>
      <span class="onion-hint text-faint text-[11px] opacity-[0.85] cursor-help whitespace-nowrap" title="当前帧为不透明画面时会完全盖住邻居层，洋葱皮只对透明背景的帧（如抠图后的精灵帧）可见">仅对透明帧可见（抠图后）</span>
    </div>
  </div>
</template>
