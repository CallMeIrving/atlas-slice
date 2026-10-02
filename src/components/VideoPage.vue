<script setup lang="ts">
import { computed, ref } from 'vue'
import { workspace, persistMediaSettings, frameImageUrl, startWatermarkFromFrame } from '@/store/workspace'
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

/** 把勾选帧（未勾选任何帧时用全部帧）送入洋葱皮预览模块：有处理结果用处理图，切页继续调参 */
function sendToOnion(): void {
  const source = selectedFrames.value.length ? selectedFrames.value : workspace.video.frames
  const base = workspace.video.fileName.replace(/\.[^.]+$/, '') || 'video'
  workspace.onion.frames = source.map((frame, index) => ({
    id: crypto.randomUUID(),
    name: `${base}-${String(index + 1).padStart(3, '0')}.png`,
    url: frameImageUrl(frame),
  }))
  workspace.onion.tweenResults = []
  workspace.onion.status = 'ready'
  workspace.onion.error = ''
  workspace.page = 'onion'
}
const zipName = computed(() => `${workspace.video.fileName.replace(/\.[^.]+$/, '') || 'video'}-frames.zip`)

/** 导入视频文件：重置帧列表与视频元信息 */
function load(file?: File): void {
  if (!file || !file.type.startsWith('video/')) return
  if (workspace.video.sourceUrl) URL.revokeObjectURL(workspace.video.sourceUrl)
  if (workspace.video.frames.length) workspace.video.frames.forEach((frame) => URL.revokeObjectURL(frame.url))
  Object.assign(workspace.video, { fileName: file.name, sourceUrl: URL.createObjectURL(file), status: 'ready', error: '', frames: [] })
  previewId.value = null
}

/** 读取视频元信息，作为抽帧时间区间的默认值 */
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
/** 跳到去水印页：带上当前预览帧作为样板帧 */
function openWatermark(): void {
  startWatermarkFromFrame(previewId.value ?? '')
}
/** 一键处理完成或关闭后，把预览定位到首帧 */
function closePipeline(): void {
  pipelineOpen.value = false
  if (!workspace.video.frames.some((frame) => frame.id === previewId.value)) previewId.value = workspace.video.frames[0]?.id ?? null
}
</script>

<template>
  <div class="video-page flex-1 min-h-0 h-auto overflow-hidden grid grid-rows-[64px_minmax(0,1fr)_250px]">
    <header class="video-toolbar flex items-center justify-between px-4 border-b border-line bg-surface">
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
    <div class="video-content grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_280px] gap-px min-h-0 overflow-hidden bg-line">
      <section class="video-preview panel min-w-0 min-h-0 flex flex-col overflow-hidden bg-stage">
        <div class="panel-title h-9 flex-none flex items-center gap-2 px-3 text-muted border-b border-line text-caption">原视频</div>
        <div v-if="!workspace.video.sourceUrl" class="empty-state">
          <span class="big">▣</span><strong>导入视频开始抽帧</strong><span>支持浏览器可解码的 MP4 / WebM / MOV</span>
        </div>
        <template v-else>
          <video ref="video" controls class="w-full h-[calc(100%-36px)] min-w-0 min-h-0 object-contain" :src="workspace.video.sourceUrl" @loadedmetadata="onMetadata" />
          <p v-if="workspace.video.error" class="range-error text-danger text-caption">{{ workspace.video.error }}</p>
        </template>
      </section>
      <section class="animation-panel panel min-w-0 min-h-0 flex flex-col overflow-hidden bg-stage">
        <div class="panel-title h-9 flex-none flex items-center gap-2 px-3 text-muted border-b border-line text-caption">帧动画预览</div>
        <FramePreviewPlayer v-model:current-id="previewId" :frames="selectedFrames.map((frame) => ({ id: frame.id, url: frameImageUrl(frame) }))" />
      </section>
      <aside class="video-settings panel flex flex-col overflow-hidden">
        <h2 class="section-title flex-none m-0 px-4 pt-3.5 pb-3 border-b border-line">抽帧设置</h2>
        <div class="settings-body flex-1 min-h-0 overflow-auto p-4"><ExtractSettingsFields /></div>
        <div class="settings-footer flex-none px-4 py-3 border-t border-line">
          <button
            class="btn btn-primary w-full justify-center"
            :disabled="!workspace.video.sourceUrl || workspace.video.status === 'processing'"
            @click="extract"
          >
            {{ workspace.video.status === 'processing' ? '抽取中…' : '开始抽帧' }}
          </button>
        </div>
      </aside>
    </div>
    <section class="frame-strip panel border-t border-line px-4 py-3 min-h-0 overflow-auto">
      <div class="strip-head flex justify-between items-center gap-3">
        <h2 class="section-title m-0">帧列表 <span class="badge">{{ selectedCount }} 已选</span></h2>
        <span class="muted flex-1 text-faint">拖拽调整顺序 · 点击帧后可单独抠图 · 同一裁切区域可批量应用到全部帧 · 动画预览只播放当前勾选帧</span>
        <button class="btn" :disabled="!workspace.video.frames.length" @click="openCrop">批量裁切</button>
        <button class="btn" :disabled="!workspace.video.frames.length" @click="openMatte">移除背景</button>
        <button class="btn" :disabled="!workspace.video.frames.length" @click="openWatermark">去水印</button>
        <button class="btn" :disabled="!workspace.video.frames.length" title="把当前勾选帧（有处理结果用处理图）送入洋葱皮预览模块" @click="sendToOnion">送入洋葱皮</button>
      </div>
      <div v-if="!workspace.video.frames.length" class="strip-empty text-faint py-[30px]">抽取结果会显示在这里</div>
      <div v-else class="frames flex gap-2.5 overflow-x-auto pt-2 pb-3">
        <button
          v-for="(frame, index) in workspace.video.frames"
          :key="frame.id"
          class="frame-card w-[120px] flex-none p-1 text-left bg-raised border border-line rounded-sm"
          :class="{
            'border-accent': previewId === frame.id,
            'border-accent-border': !!frame.matteUrl,
            'outline-1 outline-dashed outline-accent outline-offset-[-3px]': !!frame.cropUrl,
            'outline-1 outline-dotted outline-accent-strong outline-offset-[-3px]': !!frame.watermarkUrl,
          }"
          draggable="true"
          @dragstart="draggingId = frame.id"
          @dragover.prevent
          @drop.prevent="moveFrame(frame.id)"
          @click="previewId = frame.id"
        >
          <img :src="frameImageUrl(frame)" :alt="`帧 ${index + 1}`" class="w-[110px] h-[90px] object-contain bg-checker-a bg-[linear-gradient(45deg,#232734_25%,transparent_25%),linear-gradient(-45deg,transparent_75%,#232734_75%)] [background-size:12px_12px]" />
          <span class="flex items-center gap-1 pt-[3px] text-faint text-[11px] font-mono leading-[normal]"><input v-model="frame.selected" type="checkbox" @click.stop /><b>#{{ index + 1 }}</b> {{ frame.timestamp.toFixed(2) }}s</span>
        </button>
      </div>
    </section>
    <FrameMatteModal v-if="matteTargetId" :frame-id="matteTargetId" @close="matteTargetId = null" />
    <FrameCropModal v-if="cropTargetId" :frame-id="cropTargetId" @close="cropTargetId = null" />
    <FramePipelineModal v-if="pipelineOpen" :video="video ?? null" @close="closePipeline" />
  </div>
</template>