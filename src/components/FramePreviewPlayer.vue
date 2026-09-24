<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { frameImageUrl, type VideoFrame } from '@/store/workspace'

/**
 * 帧动画预览播放器。
 * 视频帧页的动画预览与一键处理弹窗的最终预览共用：大图 + 上一帧/播放/下一帧/循环/FPS。
 * 播放范围由传入的 frames 决定（视频帧页传的是勾选帧）。
 */
const props = defineProps<{
  /** 播放的帧列表 */
  frames: VideoFrame[]
  /** 当前显示的帧 id */
  currentId: string | null
}>()
const emit = defineEmits<{ 'update:currentId': [value: string | null] }>()

const playing = ref(false)
const loop = ref(true)
const fps = ref(12)
let timer: number | null = null

/** 帧列表 id 序列：用于在帧增删后重新校验当前帧，避免深度监听整个帧数组 */
const ids = computed(() => props.frames.map((frame) => frame.id).join(','))
const index = computed(() => {
  const found = props.frames.findIndex((frame) => frame.id === props.currentId)
  return found >= 0 ? found : 0
})
const current = computed<VideoFrame | null>(() => props.frames[index.value] ?? null)

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

// 帧列表变化后：为空则停止播放，当前帧已被移除则回退到首帧
watch(ids, () => {
  if (!props.frames.length) { stop(); return }
  if (!props.frames.some((frame) => frame.id === props.currentId)) emit('update:currentId', props.frames[0].id)
})
// FPS 变化后按新间隔重启定时器
watch(fps, () => { if (playing.value) { stop(); toggle() } })
onBeforeUnmount(stop)
</script>

<template>
  <div class="preview-player">
    <div class="preview-large">
      <img v-if="current" :src="frameImageUrl(current)" alt="当前动画帧" />
      <span v-else class="muted">没有可预览的帧</span>
    </div>
    <div class="preview-controls">
      <button class="btn btn-icon" :disabled="!frames.length" @click="previous">‹</button>
      <button class="btn" :disabled="!frames.length" @click="toggle">{{ playing ? '暂停' : '播放' }}</button>
      <button class="btn btn-icon" :disabled="!frames.length" @click="next">›</button>
      <span v-if="current" class="badge">{{ index + 1 }} / {{ frames.length }}</span>
      <label class="check-row"><input v-model="loop" type="checkbox" /> 循环</label>
      <label class="fps-control">FPS <input v-model.number="fps" class="input" min="1" max="60" type="number" /></label>
    </div>
  </div>
</template>

<style scoped>
.preview-player {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.preview-large {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 8px;
  background: var(--stage);
}

.preview-large img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-large .muted {
  color: var(--text-faint);
}

.preview-controls {
  flex: none;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  padding: 6px;
  border-top: 1px solid var(--border);
}

.fps-control {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-faint);
}

.fps-control .input {
  width: 54px;
}
</style>