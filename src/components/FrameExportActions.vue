<script setup lang="ts">
import { computed, ref } from 'vue'
import TaskProgress from '@/components/TaskProgress.vue'
import { downloadBlob, downloadZip } from '@/core/media-export'
import { createCancelToken, type CancelToken } from '@/core/frame-extract'
import { framesToGifBlob } from '@/core/gif-export'
import { frameImageUrl, type VideoFrame } from '@/store/workspace'

/**
 * 帧导出操作：下载当前帧 + 导出 ZIP + 导出 GIF。
 * 视频帧页工具栏与一键处理弹窗的结果区共用，统一走 frameImageUrl（裁切 > 抠图 > 原图）；
 * 下载、打包与 GIF 编码的错误在本组件内就地提示，调用方无需重复处理。
 */
const props = withDefaults(
  defineProps<{
    /** 参与导出的帧列表 */
    frames: VideoFrame[]
    /** 当前预览帧 id，为空表示没有可下载的当前帧 */
    currentId: string | null
    /** 导出 ZIP 的文件名 */
    zipName?: string
  }>(),
  { zipName: 'frames.zip' },
)

/** 正在打包 ZIP：用于禁用按钮并显示进度文案 */
const packing = ref(false)
/** 正在编码 GIF */
const encodingGif = ref(false)
/** 已请求取消 GIF 编码、正在收尾 */
const cancellingGif = ref(false)
/** GIF 编码进度（已完成帧数 / 总帧数） */
const gifDone = ref(0)
const gifTotal = ref(0)
/** GIF 编码取消令牌 */
let gifToken: CancelToken | null = null
/** 导出失败提示（拉取帧图、打包或编码失败），空串表示无错误 */
const error = ref('')

/** 当前预览帧；不在导出列表内时视为不可下载 */
const currentFrame = computed(() => props.frames.find((frame) => frame.id === props.currentId) ?? null)
const busy = computed(() => packing.value || encodingGif.value)

/** 把帧图像地址读取为 Blob；dataURL 与 blob URL 统一走 fetch */
async function frameBlob(frame: VideoFrame): Promise<Blob> {
  const response = await fetch(frameImageUrl(frame))
  if (!response.ok) throw new Error('帧图像读取失败')
  return response.blob()
}

/** 下载当前帧为 PNG（文件名用时间戳，避免多帧同名覆盖） */
async function downloadCurrent(): Promise<void> {
  const frame = currentFrame.value
  if (!frame || busy.value) return
  error.value = ''
  try {
    downloadBlob(await frameBlob(frame), `frame-${Math.round(frame.timestamp * 1000)}.png`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '下载当前帧失败'
  }
}

/** 把全部帧打包为 ZIP（文件名按顺序编号） */
async function exportZip(): Promise<void> {
  if (!props.frames.length || busy.value) return
  error.value = ''
  packing.value = true
  try {
    const entries = await Promise.all(props.frames.map(async (frame, index) => ({
      name: `frame-${String(index + 1).padStart(4, '0')}.png`,
      blob: await frameBlob(frame),
    })))
    await downloadZip(entries, props.zipName)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '导出 ZIP 失败'
  } finally {
    packing.value = false
  }
}

/** 把全部帧编码为 GIF 并下载（文件名沿用 ZIP 名换后缀） */
async function exportGif(): Promise<void> {
  if (!props.frames.length || busy.value) return
  error.value = ''
  encodingGif.value = true
  cancellingGif.value = false
  gifDone.value = 0
  gifTotal.value = props.frames.length
  gifToken = createCancelToken()
  try {
    const blob = await framesToGifBlob(props.frames, {
      cancelToken: gifToken,
      onProgress: (done: number, total: number) => { gifDone.value = done; gifTotal.value = total },
    })
    downloadBlob(blob, props.zipName.replace(/\.zip$/i, '') + '.gif')
  } catch (e) {
    // 用户主动取消时静默收尾，不显示错误
    if (!gifToken?.cancelled) error.value = e instanceof Error ? e.message : '导出 GIF 失败'
  } finally {
    encodingGif.value = false
    cancellingGif.value = false
    gifToken = null
  }
}

/** 请求取消 GIF 编码：令牌置位后在下一帧前退出，按钮进入「取消中…」防重复点击 */
function cancelGif(): void {
  if (!gifToken || cancellingGif.value) return
  cancellingGif.value = true
  gifToken.cancelled = true
}
</script>

<template>
  <div class="export-actions">
    <div class="export-row">
      <button class="btn" :disabled="!currentFrame || busy" @click="downloadCurrent">下载当前帧</button>
      <button class="btn" :disabled="!frames.length || busy" @click="exportZip">{{ packing ? '打包中…' : '导出 ZIP' }}</button>
      <button class="btn" :disabled="!frames.length || busy" @click="exportGif">{{ encodingGif ? '生成中…' : '导出 GIF' }}</button>
      <span v-if="error" class="export-error">{{ error }}</span>
    </div>
    <TaskProgress
      v-if="encodingGif"
      running
      :done="gifDone"
      :total="gifTotal"
      text="正在编码 GIF…"
      :cancelling="cancellingGif"
      @cancel="cancelGif"
    />
  </div>
</template>

<style scoped>
.export-actions {
  display: inline-flex;
  flex-direction: column;
  gap: var(--sp-2);
  align-items: flex-end;
}

.export-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.export-error {
  color: var(--danger);
  font-size: var(--fs-caption);
}
</style>