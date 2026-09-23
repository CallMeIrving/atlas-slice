<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { workspace, type VideoFrame, persistMediaSettings } from '@/store/workspace'
import { downloadZip } from '@/core/media-export'
import { solidColorKey } from '@/core/color-key'

const input = ref<HTMLInputElement>()
const video = ref<HTMLVideoElement>()
const previewId = ref<string | null>(null)
const draggingId = ref<string | null>(null)
const playing = ref(false)
const loop = ref(true)
const previewIndex = ref(0)
const previewFps = ref(12)
let previewTimer: number | null = null
const selectedCount = computed(() => workspace.video.frames.filter((frame) => frame.selected).length)
const selectedFrames = computed(() => workspace.video.frames.filter((frame) => frame.selected))
const currentPreview = computed(() => selectedFrames.value[previewIndex.value] ?? selectedFrames.value[0] ?? null)
const expectedCount = computed(() => workspace.video.mode === 'count' ? workspace.video.count : Math.max(1, Math.floor((workspace.video.end - workspace.video.start) * workspace.video.targetFps) + 1))
const rangeError = computed(() => {
  if (!workspace.video.sourceUrl) return ''
  if (workspace.video.start < 0 || workspace.video.end < 0) return '时间不能小于 0'
  if (workspace.video.start > workspace.video.end) return '开始时间不能大于结束时间'
  if (workspace.video.end > workspace.video.duration) return '结束时间不能超过视频时长'
  if (workspace.video.mode === 'count' && (!Number.isInteger(workspace.video.count) || workspace.video.count < 1)) return '目标帧数必须为正整数'
  return ''
})

function load(file?: File): void {
  if (!file || !file.type.startsWith('video/')) return
  if (workspace.video.sourceUrl) URL.revokeObjectURL(workspace.video.sourceUrl)
  workspace.video.fileName = file.name; workspace.video.sourceUrl = URL.createObjectURL(file); workspace.video.status = 'ready'; workspace.video.error = ''; workspace.video.frames = []
}

function onMetadata(): void {
  if (!video.value) return
  workspace.video.duration = video.value.duration; workspace.video.end = video.value.duration; workspace.video.width = video.value.videoWidth; workspace.video.height = video.value.videoHeight
}

function captureFrame(element: HTMLVideoElement, timestamp: number): VideoFrame {
    const sourceW = element.videoWidth; const sourceH = element.videoHeight
    const baseW = workspace.video.outputWidth || sourceW; const baseH = workspace.video.outputHeight || sourceH
    const rotated = workspace.video.rotation === 90 || workspace.video.rotation === 270
    const canvas = document.createElement('canvas'); canvas.width = rotated ? baseH : baseW; canvas.height = rotated ? baseW : baseH
    const ctx = canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(workspace.video.rotation * Math.PI / 180); ctx.scale(workspace.video.flipX ? -1 : 1, 1)
    const scale = Math.min(baseW / sourceW, baseH / sourceH); ctx.drawImage(element, -sourceW * scale / 2, -sourceH * scale / 2, sourceW * scale, sourceH * scale); ctx.restore()
    if (workspace.video.batchMatte) {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
      // 纯色背景抠图：自动采样边缘主色，适合视频帧批量抠图
      solidColorKey(data, workspace.video.matteTolerance)
      ctx.putImageData(data, 0, 0)
    }
    return { id: `${timestamp}-${Math.random()}`, url: canvas.toDataURL('image/png'), timestamp, selected: true }
}

function seekTo(element: HTMLVideoElement, timestamp: number): Promise<void> {
  if (Math.abs(element.currentTime - timestamp) < 0.001) return Promise.resolve()
  return new Promise((resolve) => {
    const started = performance.now()
    const poll = () => {
      if (Math.abs(element.currentTime - timestamp) < 0.01 || performance.now() - started > 3000) { resolve(); return }
      window.setTimeout(poll, 16)
    }
    element.currentTime = timestamp
    poll()
  })
}

async function extract(): Promise<void> {
  const element = video.value
  if (!element) { workspace.video.error = '视频元素尚未准备好，请重新导入视频'; return }
  if (!workspace.video.sourceUrl || rangeError.value) { workspace.video.error = rangeError.value || '视频尚未加载'; return }
  try {
    persistMediaSettings(); workspace.video.error = ''; workspace.video.status = 'processing'; workspace.video.frames.forEach((frame) => URL.revokeObjectURL(frame.url)); workspace.video.frames = []
    const total = expectedCount.value; const step = total > 1 ? (workspace.video.end - workspace.video.start) / (total - 1) : 0; const frames: VideoFrame[] = []
    for (let index = 0; index < total; index += 1) {
      const timestamp = Math.min(workspace.video.end, workspace.video.start + step * index)
      await seekTo(element, timestamp)
      frames.push(captureFrame(element, timestamp))
    }
    workspace.video.frames = frames; workspace.video.status = 'done'
  } catch (error) {
    workspace.video.status = 'error'; workspace.video.error = error instanceof Error ? error.message : '抽帧失败'
  }
}

function toggleAll(value: boolean): void { workspace.video.frames.forEach((frame) => { frame.selected = value }) }
function removeSelected(): void { workspace.video.frames = workspace.video.frames.filter((frame) => !frame.selected) }
function stopPreview(): void { if (previewTimer !== null) window.clearInterval(previewTimer); previewTimer = null; playing.value = false }
function nextPreviewFrame(): void {
  if (!selectedFrames.value.length) return
  if (previewIndex.value >= selectedFrames.value.length - 1) {
    if (loop.value) previewIndex.value = 0
    else { previewIndex.value = selectedFrames.value.length - 1; stopPreview() }
  } else previewIndex.value += 1
  previewId.value = currentPreview.value?.id ?? null
}
function previousPreviewFrame(): void {
  if (!selectedFrames.value.length) return
  previewIndex.value = previewIndex.value <= 0 ? (loop.value ? selectedFrames.value.length - 1 : 0) : previewIndex.value - 1
  previewId.value = currentPreview.value?.id ?? null
}
function togglePreview(): void {
  if (playing.value) { stopPreview(); return }
  if (!selectedFrames.value.length) return
  playing.value = true
  previewTimer = window.setInterval(nextPreviewFrame, 1000 / Math.max(1, previewFps.value))
}
watch(selectedFrames, (frames) => {
  if (previewIndex.value >= frames.length) previewIndex.value = Math.max(0, frames.length - 1)
  if (!frames.length) stopPreview()
}, { deep: true })
watch(previewFps, () => { if (playing.value) { stopPreview(); togglePreview() } })
onBeforeUnmount(stopPreview)
function moveFrame(targetId: string): void {
  if (!draggingId.value || draggingId.value === targetId) return
  const from = workspace.video.frames.findIndex((frame) => frame.id === draggingId.value); const to = workspace.video.frames.findIndex((frame) => frame.id === targetId)
  if (from < 0 || to < 0) return
  const [frame] = workspace.video.frames.splice(from, 1); workspace.video.frames.splice(to, 0, frame)
}
function download(): void { const frame = workspace.video.frames.find((item) => item.id === previewId.value); if (!frame) return; const link = document.createElement('a'); link.href = frame.url; link.download = `frame-${Math.round(frame.timestamp * 1000)}.png`; link.click() }
async function exportSelected(): Promise<void> {
  const selected = workspace.video.frames.filter((frame) => frame.selected)
  await downloadZip(await Promise.all(selected.map(async (frame, index) => ({ name: `frame-${String(index + 1).padStart(4, '0')}.png`, blob: await (await fetch(frame.url)).blob() }))), `${workspace.video.fileName.replace(/\.[^.]+$/, '') || 'video'}-frames.zip`)
}
</script>

<template>
  <div class="video-page">
    <header class="video-toolbar"><div class="brand"><span class="brand-mark">▶</span><div><h1>视频帧</h1><p class="brand-sub">{{ workspace.video.fileName || '从视频生成动画帧' }}</p></div></div><div class="topbar-actions"><input ref="input" hidden type="file" accept="video/*" @change="load(($event.target as HTMLInputElement).files?.[0])" /><button class="btn btn-primary" @click="input?.click()">导入视频</button><button class="btn" :disabled="!workspace.video.frames.length" @click="toggleAll(true)">全选 {{ selectedCount }}/{{ workspace.video.frames.length }}</button><button class="btn btn-danger" :disabled="!selectedCount" @click="removeSelected">删除选中</button><button class="btn" :disabled="!selectedCount" @click="exportSelected">导出选中 ZIP</button></div></header>
    <div class="video-content">
      <section class="video-preview panel"><div class="panel-title">原视频</div><div v-if="!workspace.video.sourceUrl" class="empty-state"><span class="big">▣</span><strong>导入视频开始抽帧</strong><span>支持浏览器可解码的 MP4 / WebM / MOV</span></div><template v-else><video ref="video" controls :src="workspace.video.sourceUrl" @loadedmetadata="onMetadata" /><p v-if="workspace.video.error" class="range-error">{{ workspace.video.error }}</p></template></section>
      <section class="animation-panel panel"><div class="panel-title">帧动画预览 <span v-if="currentPreview" class="badge">{{ previewIndex + 1 }} / {{ selectedFrames.length }}</span></div><div class="animation-large"><img v-if="currentPreview" :src="currentPreview.url" alt="当前动画帧" /><span v-else class="muted">抽取帧后显示动画</span></div><div class="preview-controls"><button class="btn btn-icon" :disabled="!selectedFrames.length" @click="previousPreviewFrame">‹</button><button class="btn" :disabled="!selectedFrames.length" @click="togglePreview">{{ playing ? '暂停' : '播放' }}</button><button class="btn btn-icon" :disabled="!selectedFrames.length" @click="nextPreviewFrame">›</button><label class="check-row"><input v-model="loop" type="checkbox" /> 循环</label><label class="fps-control">FPS <input v-model.number="previewFps" class="input" min="1" max="60" type="number" /></label></div></section>
      <aside class="video-settings panel"><h2 class="section-title">抽帧设置</h2><div class="field"><span class="field-label">抽帧模式</span><select v-model="workspace.video.mode" class="select"><option value="count">按数量均匀抽取</option><option value="fps">按帧率抽取</option></select></div><div v-if="workspace.video.mode === 'count'" class="field"><span class="field-label">目标帧数</span><input v-model.number="workspace.video.count" class="input" min="1" max="300" type="number" /></div><div v-else class="field"><span class="field-label">目标 FPS</span><input v-model.number="workspace.video.targetFps" class="input" min="1" max="60" type="number" /></div><div class="field"><span class="field-label">时间区间（秒）</span><div class="inline"><input v-model.number="workspace.video.start" class="input" min="0" :max="workspace.video.duration" type="number" /><span>—</span><input v-model.number="workspace.video.end" class="input" min="0" :max="workspace.video.duration" type="number" /></div></div><div v-if="rangeError" class="range-error">{{ rangeError }}</div><div class="field"><span class="field-label">输出尺寸</span><div class="inline"><input v-model.number="workspace.video.outputWidth" class="input" min="0" placeholder="原宽" type="number" /><span>×</span><input v-model.number="workspace.video.outputHeight" class="input" min="0" placeholder="原高" type="number" /></div></div><label class="check-row"><input v-model="workspace.video.flipX" type="checkbox" /> 左右翻转</label><label class="check-row"><input v-model="workspace.video.batchMatte" type="checkbox" /> 批量移除背景</label><label v-if="workspace.video.batchMatte" class="field"><span class="field-label">背景容差 {{ workspace.video.matteTolerance }}</span><input v-model.number="workspace.video.matteTolerance" class="range" type="range" min="1" max="100" /></label><div class="field"><span class="field-label">旋转</span><select v-model.number="workspace.video.rotation" class="select"><option :value="0">0°</option><option :value="90">90°</option><option :value="180">180°</option><option :value="270">270°</option></select></div><div class="estimate"><span>预计帧数</span><strong>{{ expectedCount }}</strong><small>{{ workspace.video.width }} × {{ workspace.video.height }} · {{ Math.round(expectedCount * Math.max(1, workspace.video.width * workspace.video.height * 4 / 1024 / 1024)) }} MB</small></div><button class="btn btn-primary full" :disabled="!workspace.video.sourceUrl || !!rangeError || workspace.video.status === 'processing'" @click="extract">{{ workspace.video.status === 'processing' ? '抽取中…' : '开始抽帧' }}</button></aside>
    </div>
    <section class="frame-strip panel"><div class="strip-head"><h2 class="section-title">帧列表 <span class="badge">{{ selectedCount }} 已选</span></h2><span class="muted">拖拽调整顺序 · 动画预览只播放当前勾选帧</span></div><div v-if="!workspace.video.frames.length" class="strip-empty">抽取结果会显示在这里</div><div v-else class="frames"><button v-for="(frame, index) in workspace.video.frames" :key="frame.id" class="frame-card" :class="{ active: previewId === frame.id }" draggable="true" @dragstart="draggingId = frame.id" @dragover.prevent @drop.prevent="moveFrame(frame.id)" @click="previewId = frame.id; previewIndex = Math.max(0, selectedFrames.findIndex((item) => item.id === frame.id))"><img :src="frame.url" :alt="`帧 ${index + 1}`" /><span><input v-model="frame.selected" type="checkbox" @click.stop /><b>#{{ index + 1 }}</b> {{ frame.timestamp.toFixed(2) }}s</span></button></div><button v-if="previewId" class="btn" @click="download">下载当前帧</button></section>
  </div>
</template>

<style scoped>
.video-page { flex:1; min-height:0; height:auto; overflow:hidden; display:grid; grid-template-rows:64px minmax(0,1fr) 250px; }.video-toolbar { display:flex; align-items:center; justify-content:space-between; padding:0 16px; border-bottom:1px solid var(--border); background:var(--surface); }.video-toolbar h1 { margin:0; font-size:var(--fs-title); }.video-content { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) 280px; gap:1px; min-height:0; overflow:hidden; background:var(--border); }.video-preview, .animation-panel { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; background:var(--stage); }.panel-title { height:36px; flex:none; display:flex; align-items:center; gap:8px; padding:0 12px; color:var(--text-muted); border-bottom:1px solid var(--border); font-size:var(--fs-caption); }.video-preview video { width:100%; height:calc(100% - 36px); min-width:0; min-height:0; object-fit:contain; }.animation-large { flex:1; min-height:0; display:grid; place-items:center; overflow:hidden; }.animation-large img { max-width:100%; max-height:100%; object-fit:contain; }.animation-large .muted { color:var(--text-faint); }.animation-panel .preview-controls { flex:none; min-height:44px; justify-content:center; padding:6px; border-top:1px solid var(--border); }.video-settings { padding:16px; display:flex; flex-direction:column; gap:16px; overflow:auto; }.inline { display:flex; align-items:center; gap:8px; }.inline .input { width:100px; }.range-error { color:var(--danger); font-size:var(--fs-caption); }.estimate { padding:12px; display:flex; flex-direction:column; gap:3px; background:var(--surface-raised); border:1px solid var(--border); }.estimate strong { font:20px var(--font-mono); color:var(--accent); }.estimate small { color:var(--text-faint); }.full { width:100%; justify-content:center; }.frame-strip { border-top:1px solid var(--border); padding:12px 16px; min-height:0; overflow:auto; }.strip-head { display:flex; justify-content:space-between; align-items:center; gap:12px; }.strip-head h2 { margin:0; }.preview-controls { display:flex; align-items:center; gap:6px; }.fps-control { display:flex; align-items:center; gap:4px; color:var(--text-faint); }.fps-control .input { width:54px; }.frames { display:flex; gap:10px; overflow-x:auto; padding:8px 0 12px; }.frame-card { width:120px; flex:none; padding:4px; text-align:left; background:var(--surface-raised); border:1px solid var(--border); border-radius:var(--radius-s); }.frame-card.active { border-color:var(--accent); }.frame-card img { width:110px; height:90px; object-fit:contain; background-color:var(--checker-a); background-image:linear-gradient(45deg, #232734 25%, transparent 25%), linear-gradient(-45deg, transparent 75%, #232734 75%); background-size:12px 12px; }.frame-card span { display:flex; align-items:center; gap:4px; padding-top:3px; color:var(--text-faint); font:11px var(--font-mono); }.strip-empty { color:var(--text-faint); padding:30px 0; }.muted { color:var(--text-faint); }
</style>
