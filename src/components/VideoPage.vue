<script setup lang="ts">
import { computed, ref } from 'vue'
import { workspace, persistMediaSettings, frameImageUrl } from '@/store/workspace'
import { extractFrames, extractOptionsFrom, extractRangeError } from '@/core/frame-extract'
import ExtractSettingsFields from '@/components/ExtractSettingsFields.vue'
import FramePreviewPlayer from '@/components/FramePreviewPlayer.vue'
import FrameExportActions from '@/components/FrameExportActions.vue'
import FrameMatteModal from '@/components/FrameMatteModal.vue'
import FrameCropModal from '@/components/FrameCropModal.vue'
import FramePipelineModal from '@/components/FramePipelineModal.vue'

const input = ref<HTMLInputElement>()
const video = ref<HTMLVideoElement>()
/** 当前预览帧 id（动画预览等场景共用） */
const previewId = ref<string | null>(null)
const draggingId = ref<string | null>(null)
/** 帧抠图弹窗目标帧 id，为空表示弹窗关闭 */
const matteTargetId = ref<string | null>(null)
/** 批量裁切弹窗目标帧 id（作为框选样板帧），为空表示弹窗关闭 */
const cropTargetId = ref<string | null>(null)
/** 一键处理弹窗开关 */
const pipelineOpen = ref(false)
const selectedCount = computed(() => workspace.video.frames.filter((frame) => frame.selected).length)
const selectedFrames = computed(() => workspace.video.frames.filter((frame) => frame.selected))
const zipName = computed(() => `${workspace.video.fileName.replace(/\.[^.]+$/, '') || 'video'}-frames.zip`)

/** 导入视频文件：重置帧列表与视频元信息 */
function load(file?: File): void {
  if (!file || !file.type.startsWith('video/')) return
  if (workspace.video.sourceUrl) URL.revokeObjectURL(workspace.video.sourceUrl)
  if (workspace.video.frames.length) workspace.video.frames.forEach((frame) => URL.revokeObjectURL(frame.url))
  Object.assign(workspace.video, { fileName: file.name, sourceUrl: URL.createObjectURL(file), status: 'ready', error: '', frames: [] })
  previewId.value = null
}

/** 读取视频元信息，作为抽帧时间区间与输出尺寸的默认值 */
function onMetadata(): void {
  if (!video.value) return
  workspace.video.duration = video.value.duration
  workspace.video.end = video.value.duration
  workspace.video.width = video.value.videoWidth
  workspace.video.height = video.value.videoHeight
}

/** 按当前抽帧设置抽取帧（实现见 core/frame-extract） */
async function extract(): Promise<void> {
  const element = video.value
  if (!element) { workspace.video.error = '视频元素尚未准备好，请重新导入视频'; return }
  const options = extractOptionsFrom(workspace.video)
  const rangeError = extractRangeError(options, workspace.video.duration, Boolean(workspace.video.sourceUrl))
  if (!workspace.video.sourceUrl || rangeError) { workspace.video.error = rangeError || '视频尚未加载'; return }
  try {
    persistMediaSettings()
    workspace.video.error = ''
    workspace.video.status = 'processing'
    workspace.video.frames.forEach((frame) => URL.revokeObjectURL(frame.url))
    workspace.video.frames = []
    previewId.value = null
    const frames = await extractFrames(element, options)
    workspace.video.frames = frames
    workspace.video.status = 'done'
  } catch (error) {
    workspace.video.status = 'error'
    workspace.video.error = error instanceof Error ? error.message : '抽帧失败'
  }
}

function toggleAll(value: boolean): void { workspace.video.frames.forEach((frame) => { frame.selected = value }) }
function removeSelected(): void { workspace.video.frames = workspace.video.frames.filter((frame) => !frame.selected) }

/** 拖拽调整帧顺序 */
function moveFrame(targetId: string): void {
  if (!draggingId.value || draggingId.value === targetId) return
  const from = workspace.video.frames.findIndex((frame) => frame.id === draggingId.value)
  const to = workspace.video.frames.findIndex((frame) => frame.id === targetId)
  if (from < 0 || to < 0) return
  const [frame] = workspace.video.frames.splice(from, 1)
  workspace.video.frames.splice(to, 0, frame)
}

/** 打开帧抠图弹窗：作用于当前预览帧，没有预览帧时取第一帧 */
function openMatte(): void {
  const target = workspace.video.frames.find((frame) => frame.id === previewId.value) ?? workspace.video.frames[0]
  matteTargetId.value = target?.id ?? null
}
/** 打开批量裁切弹窗：以当前预览帧作为框选样板，裁切区域应用到全部帧 */
function openCrop(): void {
  const target = workspace.video.frames.find((frame) => frame.id === previewId.value) ?? workspace.video.frames[0]
  cropTargetId.value = target?.id ?? null
}
/** 打开一键处理弹窗：抽帧 → 裁切 → 抠图 一次跑完 */
function openPipeline(): void {
  pipelineOpen.value = true
}
/** 一键处理完成或关闭后，把预览定位到首帧 */
function closePipeline(): void {
  pipelineOpen.value = false
  if (!workspace.video.frames.some((frame) => frame.id === previewId.value)) previewId.value = workspace.video.frames[0]?.id ?? null
}
</script>

<template>
  <div class="video-page">
    <header class="video-toolbar">
      <div class="brand">
        <span class="brand-mark">▶</span>
        <div>
          <h1>视频帧</h1>
          <p class="brand-sub">{{ workspace.video.fileName || '从视频生成动画帧' }}</p>
        </div>
      </div>
      <div class="topbar-actions">
        <input ref="input" hidden type="file" accept="video/*" @change="load(($event.target as HTMLInputElement).files?.[0])" />
        <button class="btn btn-primary" @click="input?.click()">导入视频</button>
        <button class="btn btn-primary" :disabled="!workspace.video.sourceUrl" @click="openPipeline">一键处理</button>
        <button class="btn" :disabled="!workspace.video.frames.length" @click="toggleAll(true)">全选 {{ selectedCount }}/{{ workspace.video.frames.length }}</button>
        <button class="btn btn-danger" :disabled="!selectedCount" @click="removeSelected">删除选中</button>
        <FrameExportActions :frames="selectedFrames" :current-id="previewId" :zip-name="zipName" />
      </div>
    </header>
    <div class="video-content">
      <section class="video-preview panel">
        <div class="panel-title">原视频</div>
        <div v-if="!workspace.video.sourceUrl" class="empty-state">
          <span class="big">▣</span><strong>导入视频开始抽帧</strong><span>支持浏览器可解码的 MP4 / WebM / MOV</span>
        </div>
        <template v-else>
          <video ref="video" controls :src="workspace.video.sourceUrl" @loadedmetadata="onMetadata" />
          <p v-if="workspace.video.error" class="range-error">{{ workspace.video.error }}</p>
        </template>
      </section>
      <section class="animation-panel panel">
        <div class="panel-title">帧动画预览</div>
        <FramePreviewPlayer v-model:current-id="previewId" :frames="selectedFrames" />
      </section>
      <aside class="video-settings panel">
        <h2 class="section-title">抽帧设置</h2>
        <div class="settings-body"><ExtractSettingsFields /></div>
        <div class="settings-footer">
          <button
            class="btn btn-primary full"
            :disabled="!workspace.video.sourceUrl || workspace.video.status === 'processing'"
            @click="extract"
          >
            {{ workspace.video.status === 'processing' ? '抽取中…' : '开始抽帧' }}
          </button>
        </div>
      </aside>
    </div>
    <section class="frame-strip panel">
      <div class="strip-head">
        <h2 class="section-title">帧列表 <span class="badge">{{ selectedCount }} 已选</span></h2>
        <span class="muted">拖拽调整顺序 · 点击帧后可单独抠图 · 同一裁切区域可批量应用到全部帧 · 动画预览只播放当前勾选帧</span>
        <button class="btn" :disabled="!workspace.video.frames.length" @click="openCrop">批量裁切</button>
        <button class="btn" :disabled="!workspace.video.frames.length" @click="openMatte">移除背景</button>
      </div>
      <div v-if="!workspace.video.frames.length" class="strip-empty">抽取结果会显示在这里</div>
      <div v-else class="frames">
        <button
          v-for="(frame, index) in workspace.video.frames"
          :key="frame.id"
          class="frame-card"
          :class="{ active: previewId === frame.id, matted: !!frame.matteUrl, cropped: !!frame.cropUrl }"
          draggable="true"
          @dragstart="draggingId = frame.id"
          @dragover.prevent
          @drop.prevent="moveFrame(frame.id)"
          @click="previewId = frame.id"
        >
          <img :src="frameImageUrl(frame)" :alt="`帧 ${index + 1}`" />
          <span><input v-model="frame.selected" type="checkbox" @click.stop /><b>#{{ index + 1 }}</b> {{ frame.timestamp.toFixed(2) }}s</span>
        </button>
      </div>
    </section>
    <FrameMatteModal v-if="matteTargetId" :frame-id="matteTargetId" @close="matteTargetId = null" />
    <FrameCropModal v-if="cropTargetId" :frame-id="cropTargetId" @close="cropTargetId = null" />
    <FramePipelineModal v-if="pipelineOpen" :video="video ?? null" @close="closePipeline" />
  </div>
</template>

<style scoped>
.video-page { flex:1; min-height:0; height:auto; overflow:hidden; display:grid; grid-template-rows:64px minmax(0,1fr) 250px; }.video-toolbar { display:flex; align-items:center; justify-content:space-between; padding:0 16px; border-bottom:1px solid var(--border); background:var(--surface); }.video-toolbar h1 { margin:0; font-size:var(--fs-title); }.video-content { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) 280px; gap:1px; min-height:0; overflow:hidden; background:var(--border); }.video-preview, .animation-panel { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; background:var(--stage); }.panel-title { height:36px; flex:none; display:flex; align-items:center; gap:8px; padding:0 12px; color:var(--text-muted); border-bottom:1px solid var(--border); font-size:var(--fs-caption); }.video-preview video { width:100%; height:calc(100% - 36px); min-width:0; min-height:0; object-fit:contain; }.video-settings { display:flex; flex-direction:column; overflow:hidden; }.video-settings .section-title { flex:none; margin:0; padding:14px 16px 12px; border-bottom:1px solid var(--border); }.settings-body { flex:1; min-height:0; overflow:auto; padding:16px; }.settings-footer { flex:none; padding:12px 16px; border-top:1px solid var(--border); }.range-error { color:var(--danger); font-size:var(--fs-caption); }.full { width:100%; justify-content:center; }.frame-strip { border-top:1px solid var(--border); padding:12px 16px; min-height:0; overflow:auto; }.strip-head { display:flex; justify-content:space-between; align-items:center; gap:12px; }.strip-head h2 { margin:0; }.strip-head .muted { flex:1; }.frames { display:flex; gap:10px; overflow-x:auto; padding:8px 0 12px; }.frame-card { width:120px; flex:none; padding:4px; text-align:left; background:var(--surface-raised); border:1px solid var(--border); border-radius:var(--radius-s); }.frame-card.active { border-color:var(--accent); }.frame-card.matted { border-color:var(--accent-border); }.frame-card.cropped { outline:1px dashed var(--accent); outline-offset:-3px; }.frame-card img { width:110px; height:90px; object-fit:contain; background-color:var(--checker-a); background-image:linear-gradient(45deg, #232734 25%, transparent 25%), linear-gradient(-45deg, transparent 75%, #232734 75%); background-size:12px 12px; }.frame-card span { display:flex; align-items:center; gap:4px; padding-top:3px; color:var(--text-faint); font:11px var(--font-mono); }.strip-empty { color:var(--text-faint); padding:30px 0; }.muted { color:var(--text-faint); }
</style>