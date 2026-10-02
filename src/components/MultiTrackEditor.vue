<script setup lang="ts">
/**
 * 多音轨编辑器。
 *
 * 素材从左侧素材库拖进来成为片段，片段可在轨内拖动、跨轨移动、拖边缘裁剪，
 * 每条音轨可独立静音 / 独奏。试听与「合成到素材库」都走 store 的混音路径，
 * 保证听到的就是最后合成出来的。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import AudioWaveform from '@/components/AudioWaveform.vue'
import { claimAudition, releaseAudition } from '@/core/audio/audition'
import { PcmPlayer } from '@/core/audio/preview'
import {
  AUDIO_ASSET_MIME,
  activeClip,
  addClipFromAsset,
  addTrack,
  assetOf,
  audioState,
  beginLoading,
  buildMixdownPcm,
  clipDuration,
  duplicateClip,
  endLoading,
  ensureTracks,
  findClip,
  mixdownToAsset,
  moveClip,
  removeClip,
  removeTrack,
  renameTrack,
  setActiveClip,
  setClipFade,
  setClipGain,
  timelineDurationSec,
  toggleTrackMute,
  toggleTrackSolo,
  trimClipEdge,
  type TrackClip,
} from '@/store/audio'

/** 在试听协调器里代表「时间轴试听」这一路 */
const TIMELINE_AUDITION = 'timeline'

const ZOOM_LEVELS = [1, 1.5, 2, 3, 5, 8, 12, 20, 30, 45, 65, 95, 140, 200, 300, 450, 700]
const ZOOM_MIN = ZOOM_LEVELS[0]
const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
/** 标尺刻度候选值：取第一个像素间距够宽的 */
const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
/** 轨道头宽度，与 .head-cell 的 width 保持一致 */
const HEAD_WIDTH = 156
/** 刻度标签之间的最小像素间距 */
const TICK_MIN_PX = 72
/** 单屏最多渲染的刻度数，长素材放大到极限时避免刻度爆炸 */
const TICK_MAX_COUNT = 400

const pxPerSec = ref(65)
const scrollRef = ref<HTMLElement>()
const playhead = ref(0)
const playing = ref(false)
const preparing = ref(false)
const dragging = ref(false)

const player = new PcmPlayer()
/** 时间轴改动后混音结果失效，下次试听需要重新混音 */
let previewDirty = true

const trackCount = computed(() => audioState.tracks.length)
const clipCount = computed(() => audioState.tracks.reduce((sum, track) => sum + track.clips.length, 0))
const canEdit = computed(() => clipCount.value > 0)

const spanSec = computed(() => Math.max(20, timelineDurationSec.value + 4))
const laneWidth = computed(() => Math.round(spanSec.value * pxPerSec.value))
const tickStep = computed(
  () =>
    RULER_STEPS.find(
      (step) => step * pxPerSec.value >= TICK_MIN_PX && spanSec.value / step <= TICK_MAX_COUNT,
    ) ?? 600,
)
const tickWidth = computed(() => tickStep.value * pxPerSec.value)
/** 「适应窗口」会算出非整档倍率，显示时最多保留一位小数 */
const zoomLabel = computed(() =>
  Number.isInteger(pxPerSec.value) ? String(pxPerSec.value) : pxPerSec.value.toFixed(1),
)

const ticks = computed(() => {
  const out: number[] = []
  for (let t = 0; t <= spanSec.value + 1e-6; t += tickStep.value) out.push(Math.round(t * 1000) / 1000)
  return out
})

/** 时间轴签名：任一参数变化就作废已混音的试听内容 */
const signature = computed(() =>
  audioState.tracks
    .map(
      (track) =>
        `${track.muted ? 'm' : ''}${track.solo ? 's' : ''}|` +
        track.clips
          .map(
            (clip) =>
              `${clip.assetId}:${clip.startSec}:${clip.trimStartSec}:${clip.trimEndSec}:${clip.gainDb}:${clip.fadeInSec}:${clip.fadeOutSec}`,
          )
          .join(','),
    )
    .join('#'),
)

player.onTick = (sec) => {
  playhead.value = sec
}
player.onEnd = () => {
  playing.value = false
  playhead.value = player.durationSec
  releaseAudition(TIMELINE_AUDITION)
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds * 100) / 100
  if (total < 60) return `${total.toFixed(2)} s`
  const m = Math.floor(total / 60)
  return `${m}:${(total - m * 60).toFixed(2).padStart(5, '0')}`
}

function fmtTick(sec: number): string {
  if (sec < 60) return `${Number.isInteger(sec) ? sec : sec.toFixed(2)}s`
  const m = Math.floor(sec / 60)
  return `${m}:${String(Math.round(sec - m * 60)).padStart(2, '0')}`
}

// ---------------------------------------------------------------- 波形

const EMPTY_PEAKS = new Float32Array(0)
const peakCache = new Map<string, Float32Array>()

/** 片段只画自己那段裁剪区间的包络，用视图避免复制样本 */
function clipPeaks(clip: TrackClip): Float32Array {
  const key = `${clip.assetId}:${clip.trimStartSec}:${clip.trimEndSec}`
  const cached = peakCache.get(key)
  if (cached) return cached
  const asset = assetOf(clip)
  if (!asset || asset.peaks.length === 0) return EMPTY_PEAKS
  const total = asset.durationSec || 1
  const from = Math.max(0, Math.floor((clip.trimStartSec / total) * asset.peaks.length))
  const to = Math.min(asset.peaks.length, Math.ceil((clip.trimEndSec / total) * asset.peaks.length))
  const view = asset.peaks.subarray(from, Math.max(from + 1, to))
  // 裁剪过程中 key 会不断变化，超过阈值就整体丢弃，避免缓存无限增长
  if (peakCache.size > 240) peakCache.clear()
  peakCache.set(key, view)
  return view
}

function clipStyle(clip: TrackClip): Record<string, string> {
  return {
    left: `${clip.startSec * pxPerSec.value}px`,
    width: `${Math.max(8, clipDuration(clip) * pxPerSec.value)}px`,
  }
}

// ---------------------------------------------------------------- 轨道与片段操作

const laneRefs = new Map<string, HTMLElement>()
let drag: { mode: 'move' | 'trim-start' | 'trim-end'; clipId: string; startX: number; trackId: string; originStart: number } | null =
  null

function setLaneRef(id: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) laneRefs.set(id, el)
  else laneRefs.delete(id)
}

function laneRects(): { id: string; rect: DOMRect }[] {
  const out: { id: string; rect: DOMRect }[] = []
  for (const track of audioState.tracks) {
    const el = laneRefs.get(track.id)
    if (el) out.push({ id: track.id, rect: el.getBoundingClientRect() })
  }
  return out
}

/** 指针落在哪条轨道上；落在轨外时取最近的轨道 */
function laneIdAt(clientY: number, fallback: string): string {
  let nearest = fallback
  let distance = Number.POSITIVE_INFINITY
  for (const lane of laneRects()) {
    if (clientY >= lane.rect.top && clientY <= lane.rect.bottom) return lane.id
    const gap = Math.abs(clientY - (lane.rect.top + lane.rect.bottom) / 2)
    if (gap < distance) {
      distance = gap
      nearest = lane.id
    }
  }
  return nearest
}

/** 视口坐标换算成时间轴秒数；轨道元素已随滚动偏移，无需再算 scrollLeft */
function secAt(clientX: number, trackId: string): number {
  const el = laneRefs.get(trackId)
  if (!el) return 0
  return Math.max(0, (clientX - el.getBoundingClientRect().left) / pxPerSec.value)
}

function onDragOver(e: DragEvent): void {
  if (!e.dataTransfer) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}

function onDrop(e: DragEvent, trackId: string): void {
  e.preventDefault()
  const assetId = e.dataTransfer?.getData(AUDIO_ASSET_MIME) ?? ''
  if (!assetId) return
  addClipFromAsset(trackId, assetId, secAt(e.clientX, trackId))
}

function beginDrag(e: PointerEvent, clipId: string, mode: 'move' | 'trim-start' | 'trim-end'): void {
  if (e.button !== 0) return
  const found = findClip(clipId)
  if (!found) return
  e.preventDefault()
  setActiveClip(clipId)
  drag = { mode, clipId, startX: e.clientX, trackId: found.track.id, originStart: found.clip.startSec }
  dragging.value = true
  // 监听挂在 window 上：片段跨轨移动时元素会被重新挂载，挂在自己身上的监听会随之中断
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
}

function onDragMove(e: PointerEvent): void {
  if (!drag) return
  e.preventDefault()
  if (drag.mode === 'move') {
    const target = laneIdAt(e.clientY, drag.trackId)
    moveClip(drag.clipId, target, Math.max(0, drag.originStart + (e.clientX - drag.startX) / pxPerSec.value))
    drag.trackId = target
    return
  }
  trimClipEdge(drag.clipId, drag.mode === 'trim-start' ? 'start' : 'end', secAt(e.clientX, drag.trackId))
}

function endDrag(): void {
  if (!drag) return
  drag = null
  dragging.value = false
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
}

function onLaneDown(e: PointerEvent, trackId: string): void {
  setActiveClip('')
  const at = secAt(e.clientX, trackId)
  playhead.value = at
  player.seek(at)
}

// ---------------------------------------------------------------- 缩放

/** 离当前倍率最近的一档，用于「适应窗口」这类非整档倍率下继续加减档 */
function nearestZoomIndex(): number {
  let best = 0
  let distance = Number.POSITIVE_INFINITY
  ZOOM_LEVELS.forEach((level, index) => {
    const gap = Math.abs(level - pxPerSec.value)
    if (gap < distance) {
      distance = gap
      best = index
    }
  })
  return best
}

/**
 * 改变缩放倍率，并让锚点处的时间保持在原来的屏幕位置。
 * anchorClientX 传鼠标横坐标（滚轮缩放），不传则取视口中心（按钮缩放）。
 */
function applyZoom(next: number, anchorClientX?: number): void {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
  const el = scrollRef.value
  if (clamped === pxPerSec.value || !el) {
    pxPerSec.value = clamped
    return
  }
  const offset = anchorClientX === undefined ? el.clientWidth / 2 : anchorClientX - el.getBoundingClientRect().left
  // 视口内容坐标 → 时间：轨道内容从 HEAD_WIDTH 之后开始
  const anchorSec = Math.max(0, (el.scrollLeft + offset - HEAD_WIDTH) / pxPerSec.value)
  pxPerSec.value = clamped
  // 等宽度更新后再定位，否则 scrollLeft 会被旧内容宽度夹住
  void nextTick(() => {
    el.scrollLeft = Math.max(0, anchorSec * clamped + HEAD_WIDTH - offset)
  })
}

function zoomBy(direction: number): void {
  const index = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, nearestZoomIndex() + direction))
  applyZoom(ZOOM_LEVELS[index])
}

/** 把整段时间轴缩放到一屏 */
function fitToView(): void {
  const el = scrollRef.value
  if (!el) return
  const available = el.clientWidth - HEAD_WIDTH - 24
  if (available <= 0) return
  applyZoom(available / spanSec.value)
}

/** Ctrl / ⌘ + 滚轮缩放，以光标处时间为锚点 */
function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  const index = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, nearestZoomIndex() + (e.deltaY < 0 ? 1 : -1)))
  applyZoom(ZOOM_LEVELS[index], e.clientX)
}

// ---------------------------------------------------------------- 选中片段属性

const gainValue = computed({
  get: () => activeClip.value?.gainDb ?? 0,
  set: (value: number) => {
    if (activeClip.value) setClipGain(activeClip.value.id, value)
  },
})
const fadeInValue = computed({
  get: () => activeClip.value?.fadeInSec ?? 0,
  set: (value: number) => {
    if (activeClip.value) setClipFade(activeClip.value.id, 'in', value)
  },
})
const fadeOutValue = computed({
  get: () => activeClip.value?.fadeOutSec ?? 0,
  set: (value: number) => {
    if (activeClip.value) setClipFade(activeClip.value.id, 'out', value)
  },
})

function onRenameInput(trackId: string, event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) renameTrack(trackId, target.value)
}

// ---------------------------------------------------------------- 试听与合成

function stopPlayback(): void {
  playing.value = false
  player.pause()
  releaseAudition(TIMELINE_AUDITION)
}

async function togglePlay(): Promise<void> {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (!canEdit.value || preparing.value) return
  const resumeAt = playhead.value
  preparing.value = true
  beginLoading('正在准备试听')
  try {
    if (previewDirty || player.durationSec === 0) {
      player.setPcm(await buildMixdownPcm())
      previewDirty = false
    }
  } catch (error) {
    audioState.error = error instanceof Error ? error.message : '试听准备失败'
    return
  } finally {
    preparing.value = false
    endLoading()
  }
  // 认领播放位：素材库 / 结果弹窗里正在响的音频会被自动停掉
  claimAudition(TIMELINE_AUDITION, stopPlayback)
  playing.value = true
  player.play(resumeAt >= player.durationSec - 0.01 ? 0 : resumeAt)
}

async function onMixdown(): Promise<void> {
  if (playing.value) stopPlayback()
  await mixdownToAsset()
}

watch(signature, () => {
  previewDirty = true
  if (playing.value) stopPlayback()
})

watch(
  () => audioState.assets.length,
  () => {
    peakCache.clear()
  },
)

onMounted(() => {
  ensureTracks()
})

onBeforeUnmount(() => {
  endDrag()
  player.dispose()
  releaseAudition(TIMELINE_AUDITION)
})
</script>

<template>
  <section
    class="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-line bg-surface"
    :class="dragging && 'select-none'"
  >
    <header class="flex flex-none items-center justify-between gap-3 border-b border-line px-3 py-2">
      <div class="flex items-center gap-2">
        <button class="btn" @click="addTrack()">＋ 音轨</button>
        <span class="muted mono text-caption">
          {{ trackCount }} 轨 · {{ clipCount }} 片段 · {{ fmtDuration(timelineDurationSec) }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn btn-icon" title="缩小（Ctrl/⌘ + 滚轮也行）" :disabled="pxPerSec <= ZOOM_MIN" @click="zoomBy(-1)">−</button>
        <span class="muted mono min-w-[62px] text-center text-caption">{{ zoomLabel }} px/s</span>
        <button class="btn btn-icon" title="放大（Ctrl/⌘ + 滚轮也行）" :disabled="pxPerSec >= ZOOM_MAX" @click="zoomBy(1)">＋</button>
        <button class="btn" title="把整段时间轴缩放到一屏" @click="fitToView()">适应窗口</button>
        <button class="btn" :disabled="!canEdit || preparing" @click="togglePlay()">
          {{ playing ? '⏸ 停止' : '▶ 试听' }}
        </button>
        <button class="btn btn-primary" :disabled="!canEdit || preparing" @click="onMixdown()">合成到素材库</button>
      </div>
    </header>

    <div ref="scrollRef" class="relative min-h-0 flex-1 overflow-auto" @wheel="onWheel">
      <div class="sticky top-0 z-4 flex h-7">
        <div class="sticky left-0 z-5 flex w-[156px] flex-none items-center border-r border-line bg-surface px-3 text-caption text-faint">时间轴</div>
        <div class="relative flex-none border-b border-line" :style="{ width: `${laneWidth}px` }">
          <div v-for="tick in ticks" :key="tick" class="absolute inset-y-0 border-l border-line" :style="{ left: `${tick * pxPerSec}px` }">
            <span class="absolute top-[5px] left-1 font-mono text-[10px] whitespace-nowrap text-faint">{{ fmtTick(tick) }}</span>
          </div>
          <div class="pointer-events-none absolute inset-y-0 w-px bg-accent-strong" :style="{ left: `${playhead * pxPerSec}px` }"></div>
        </div>
      </div>

      <div v-for="track in audioState.tracks" :key="track.id" class="flex h-16 border-t border-line">
        <div class="sticky left-0 z-3 flex w-[156px] flex-none flex-col gap-1 border-r border-line bg-surface p-2">
          <input
            class="w-full rounded-[3px] border border-transparent bg-transparent px-1 py-px text-caption hover:border-line-strong hover:bg-raised focus:border-line-strong focus:bg-raised"
            :value="track.name"
            title="双击可重命名"
            @change="onRenameInput(track.id, $event)"
          />
          <div class="flex gap-1">
            <button
              class="inline-flex h-5 w-6 items-center justify-center rounded-[3px] border font-mono text-[11px] enabled:hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-40"
              :class="track.muted ? 'border-accent-border bg-accent-dim text-accent-strong' : 'border-line bg-raised text-muted'"
              title="静音"
              @click="toggleTrackMute(track.id)"
            >M</button>
            <button
              class="inline-flex h-5 w-6 items-center justify-center rounded-[3px] border font-mono text-[11px] enabled:hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-40"
              :class="track.solo ? 'border-accent-border bg-accent-dim text-accent-strong' : 'border-line bg-raised text-muted'"
              title="独奏"
              @click="toggleTrackSolo(track.id)"
            >S</button>
            <button
              class="inline-flex h-5 w-6 items-center justify-center rounded-[3px] border border-line bg-raised font-mono text-[11px] text-muted enabled:hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-40"
              title="删除音轨"
              :disabled="trackCount <= 1"
              @click="removeTrack(track.id)"
            >
              ×
            </button>
          </div>
        </div>

        <div
          class="relative flex-none bg-[linear-gradient(to_right,var(--border)_1px,transparent_0)] bg-repeat"
          :ref="(el) => setLaneRef(track.id, el)"
          :style="{ width: `${laneWidth}px`, backgroundSize: `${tickWidth}px 100%` }"
          @dragover="onDragOver"
          @drop="onDrop($event, track.id)"
          @pointerdown.self="onLaneDown($event, track.id)"
        >
          <div
            v-for="clip in track.clips"
            :key="clip.id"
            class="absolute top-[5px] bottom-[5px] flex cursor-grab flex-col justify-center overflow-hidden rounded-sm border bg-raised touch-none"
            :class="[
              clip.id === audioState.activeClipId
                ? 'border-accent-strong shadow-[0_0_0_1px_var(--accent-border)]'
                : 'border-accent-border',
              (track.muted || (audioState.tracks.some((t) => t.solo) && !track.solo)) && 'opacity-[0.42]',
            ]"
            :style="clipStyle(clip)"
            :title="assetOf(clip)?.fileName"
            @pointerdown="beginDrag($event, clip.id, 'move')"
          >
            <AudioWaveform
              :peaks="clipPeaks(clip)"
              :height="46"
              :color="clip.id === audioState.activeClipId ? '#f2b453' : '#e8a23d'"
              :axis="false"
            />
            <span class="pointer-events-none absolute right-[10px] bottom-px left-[10px] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted">{{ assetOf(clip)?.fileName ?? '素材已移除' }}</span>
            <span class="mono pointer-events-none absolute top-px left-[10px] text-[10px] text-faint" v-if="clip.fadeInSec > 0 || clip.fadeOutSec > 0">
              fade {{ clip.fadeInSec.toFixed(2) }}/{{ clip.fadeOutSec.toFixed(2) }}
            </span>
            <span class="mono pointer-events-none absolute top-px right-[10px] left-auto text-[10px] text-accent-strong" v-if="clip.gainDb !== 0">
              {{ clip.gainDb > 0 ? '+' : '' }}{{ clip.gainDb.toFixed(1) }} dB
            </span>
            <span class="absolute inset-y-0 left-0 w-[7px] cursor-ew-resize bg-[linear-gradient(to_right,rgba(232,162,61,0.28),transparent)]" title="拖动裁剪起点" @pointerdown.stop="beginDrag($event, clip.id, 'trim-start')"></span>
            <span class="absolute inset-y-0 right-0 w-[7px] cursor-ew-resize bg-[linear-gradient(to_left,rgba(232,162,61,0.28),transparent)]" title="拖动裁剪终点" @pointerdown.stop="beginDrag($event, clip.id, 'trim-end')"></span>
          </div>
          <div class="pointer-events-none absolute inset-y-0 z-2 w-px bg-accent-strong opacity-75" :style="{ left: `${playhead * pxPerSec}px` }"></div>
        </div>
      </div>

      <p v-if="!clipCount" class="pointer-events-none absolute top-11 left-[180px] m-0 rounded-sm border border-dashed border-line-strong px-3 py-2 text-caption text-faint">
        把左侧素材库里的音频拖到任意音轨上；拖动片段可换位或换轨，拖动片段两侧边缘可裁剪；
        素材太长时用 Ctrl / ⌘ + 滚轮缩放，或点「适应窗口」一屏看全
      </p>
    </div>

    <footer v-if="activeClip" class="flex flex-none flex-wrap items-center gap-3 border-t border-line bg-raised px-3 py-2">
      <span class="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap text-caption" :title="assetOf(activeClip)?.fileName">{{ assetOf(activeClip)?.fileName ?? '素材已移除' }}</span>
      <span class="muted mono text-caption">
        {{ activeClip.startSec.toFixed(2) }}s → {{ (activeClip.startSec + clipDuration(activeClip)).toFixed(2) }}s · 长
        {{ clipDuration(activeClip).toFixed(2) }}s
      </span>
      <label class="flex items-center gap-2 text-caption text-faint">
        <span>音量(dB)</span>
        <input v-model.number="gainValue" class="input w-[84px] px-1.5 py-0.5" type="number" min="-60" max="24" step="0.5" />
      </label>
      <label class="flex items-center gap-2 text-caption text-faint">
        <span>淡入(s)</span>
        <input v-model.number="fadeInValue" class="input w-[84px] px-1.5 py-0.5" type="number" min="0" step="0.01" />
      </label>
      <label class="flex items-center gap-2 text-caption text-faint">
        <span>淡出(s)</span>
        <input v-model.number="fadeOutValue" class="input w-[84px] px-1.5 py-0.5" type="number" min="0" step="0.01" />
      </label>
      <button class="btn" @click="duplicateClip(activeClip.id)">复制片段</button>
      <button class="btn btn-danger" @click="removeClip(activeClip.id)">删除片段</button>
    </footer>
  </section>
</template>
