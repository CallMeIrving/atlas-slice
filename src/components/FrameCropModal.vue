<script setup lang="ts">
import { computed, ref } from 'vue'
import { applyCropToFrames, clearFrameCrop } from '@/core/frame-crop'
import { createCancelToken, type CancelToken } from '@/core/frame-extract'
import type { ImageCropRect } from '@/core/crop'
import { frameBaseUrl, workspace } from '@/store/workspace'
import FrameCropEditor from '@/components/FrameCropEditor.vue'
import TaskProgress from '@/components/TaskProgress.vue'

/**
 * 批量裁切弹窗。
 * 只负责「选样板帧 + 批量进度」外壳，框选编辑交给 FrameCropEditor、
 * 批量裁切交给 core/frame-crop，与一键处理流水线共用同一份实现。
 */
const props = defineProps<{ frameId: string }>()
const emit = defineEmits<{ close: [] }>()

const frame = computed(() => workspace.video.frames.find((item) => item.id === props.frameId) ?? null)
const frameIndex = computed(() => workspace.video.frames.findIndex((item) => item.id === props.frameId))
/** 裁切输入图像：已抠图的帧在抠图结果上裁切 */
const baseUrl = computed(() => (frame.value ? frameBaseUrl(frame.value) : ''))
/** 已应用裁切的帧数，用于「清除全部裁切」的可用状态与数量提示 */
const croppedCount = computed(() => workspace.video.frames.filter((item) => item.cropUrl).length)
/** 裁切区域：初始沿用样板帧已应用的区域，宽高为 0 时由编辑器在图片加载后填为整帧 */
const cropRect = ref<ImageCropRect>(frame.value?.crop ? { ...frame.value.crop } : { x: 0, y: 0, width: 0, height: 0 })
const batch = ref({ running: false, done: 0, total: 0 })
const statusText = ref('')
const errorText = ref('')
let token: CancelToken = createCancelToken()
const busy = computed(() => batch.value.running)

/** 把当前裁切区域应用到全部帧（整帧范围等价于清除裁切） */
async function applyAll(): Promise<void> {
  const list = workspace.video.frames
  if (!list.length) return
  batch.value = { running: true, done: 0, total: list.length }
  token = createCancelToken()
  errorText.value = ''
  try {
    const done = await applyCropToFrames(
      list,
      cropRect.value,
      (count, total) => {
        batch.value = { running: true, done: count, total }
        statusText.value = `批量 ${count}/${total} · 处理中…`
      },
      token,
    )
    const applied = workspace.video.frames.some((item) => item.crop)
    statusText.value = token.cancelled
      ? `已取消，完成 ${done} 帧`
      : applied ? `已将裁切应用到 ${done} 帧` : '已清除全部帧的裁切'
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '批量裁切失败'
  } finally {
    batch.value = { running: false, done: batch.value.done, total: list.length }
  }
}

/** 清除全部帧的裁切结果，恢复为裁切前的画面 */
function clearAll(): void {
  clearFrameCrop(workspace.video.frames)
  errorText.value = ''
  statusText.value = '已清除全部帧的裁切'
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal frame-crop" role="dialog" aria-modal="true" aria-labelledby="frame-crop-title">
      <div class="modal-head">
        <div>
          <h2 id="frame-crop-title">批量裁切</h2>
          <p class="faint">
            第 {{ frameIndex + 1 }} 帧 · {{ frame?.timestamp.toFixed(2) }}s · 圈选区域后按同一区域应用到全部
            {{ workspace.video.frames.length }} 帧
          </p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <FrameCropEditor v-model="cropRect" :source-url="baseUrl" />
        <TaskProgress
          v-if="busy || statusText || errorText"
          :running="busy"
          :done="batch.done"
          :total="batch.total"
          :text="statusText"
          :error="errorText"
          @cancel="token.cancelled = true"
        />
      </div>
      <div class="modal-foot">
        <button class="btn btn-danger" :disabled="busy || !croppedCount" @click="clearAll">
          清除全部裁切（{{ croppedCount }}）
        </button>
        <span class="foot-spacer"></span>
        <button class="btn btn-primary" :disabled="busy || !workspace.video.frames.length" @click="applyAll">应用到全部帧</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.frame-crop {
  width: min(900px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
}

.frame-crop .modal-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.foot-spacer {
  flex: 1;
}
</style>