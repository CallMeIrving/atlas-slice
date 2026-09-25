<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { colorKeyBase, type ColorKeyBase } from '@/core/color-key'
import { describeMattingError, AI_MAX_SIDE_LIMIT } from '@/core/ai-matting'
import {
  applyMatteToFrames,
  hexToRgb,
  matteFrameImage,
  matteSolidData,
  rgbToHex,
  type FrameMatteContext,
} from '@/core/frame-matte'
import { recropFrame } from '@/core/frame-crop'
import { imageToImageData } from '@/core/image'
import { createCancelToken, type CancelToken } from '@/core/frame-extract'
import { persistMediaSettings, workspace } from '@/store/workspace'
import MatteSettingsFields from '@/components/MatteSettingsFields.vue'
import TaskProgress from '@/components/TaskProgress.vue'

/**
 * 帧抠图弹窗。
 * 设置项交给 MatteSettingsFields、单帧/批量抠图交给 core/frame-matte、
 * 进度展示交给 TaskProgress，与一键处理流水线共用同一份实现。
 */
const props = defineProps<{ frameId: string }>()
const emit = defineEmits<{ close: [] }>()

const sourceImage = ref<HTMLImageElement>()
/** 当前帧抠图结果预览（dataURL PNG） */
const previewUrl = ref('')
/** 自动采样到的背景基准色，用于展示与「恢复自动」 */
const autoBase = ref<ColorKeyBase | null>(null)
const statusText = ref('')
const progressPercent = ref(-1)
const errorText = ref('')
/** 单张处理中（AI 推理或应用结果） */
const processing = ref(false)
const batch = ref({ running: false, done: 0, total: 0 })
let token: CancelToken = createCancelToken()
/** 临时像素数据缓存，避免调参或应用结果时重复解码同一帧 */
let sourceDataCache: { id: string; data: ImageData } | null = null
/** 自增令牌，用于丢弃参数变更后过期的异步预览结果 */
let previewToken = 0
/** 批量进度前缀，让进度文本带上全局位置 */
const progressPrefix = ref('')

const frame = computed(() => workspace.video.frames.find((item) => item.id === props.frameId) ?? null)
const frameIndex = computed(() => workspace.video.frames.findIndex((item) => item.id === props.frameId))
const isSolid = computed(() => workspace.video.matte.mode === 'solid')
const busy = computed(() => processing.value || batch.value.running)
/** 当前生效的基准色：手动取色优先，其次自动采样 */
const activeBase = computed<ColorKeyBase | null>(() => {
  const manual = hexToRgb(workspace.video.matte.baseColor)
  return manual ? colorKeyBase(manual.r, manual.g, manual.b) : autoBase.value
})
/** 自动采样基准色的展示值（手动基准色由设置组件自己展示） */
const autoBaseHex = computed(() => {
  if (workspace.video.matte.baseColor) return ''
  const base = activeBase.value
  return base ? rgbToHex(base.r, base.g, base.b) : ''
})

/** 组装帧抠图上下文（抠图方式设置 + AI 偏好），每次调用都取当前值 */
function matteContext(): FrameMatteContext {
  return { settings: workspace.video.matte, ai: workspace.matte }
}

/** 取出当前帧原图像素数据，按帧 id 缓存避免重复解码 */
function currentSourceData(image: HTMLImageElement): ImageData {
  if (!sourceDataCache || sourceDataCache.id !== props.frameId) {
    sourceDataCache = { id: props.frameId, data: imageToImageData(image) }
  }
  return sourceDataCache.data
}

/** 生成当前帧的抠图预览；纯色模式瞬时完成，AI 模式在参数变化后需重新触发 */
async function runPreview(): Promise<void> {
  const image = sourceImage.value
  if (!image || !image.naturalWidth) return
  const stamp = ++previewToken
  errorText.value = ''
  try {
    if (isSolid.value) {
      const { url, base } = matteSolidData(image, workspace.video.matte, currentSourceData(image))
      if (stamp !== previewToken) return
      autoBase.value = base
      previewUrl.value = url
      return
    }
    processing.value = true
    statusText.value = '准备 AI 模型…'
    progressPercent.value = -1
    const url = await matteFrameImage(image, matteContext(), (progress) => {
      statusText.value = `${progressPrefix.value}${progress.text}`
      progressPercent.value = progress.percent ?? -1
    })
    if (stamp !== previewToken) return
    previewUrl.value = url
  } catch (error) {
    if (stamp !== previewToken) return
    errorText.value = describeMattingError(error, workspace.video.matte.mode)
  } finally {
    if (stamp === previewToken) {
      processing.value = false
      statusText.value = ''
      progressPercent.value = -1
    }
  }
}

/** 原图加载完成：纯色模式立即出预览，AI 模式保留已有结果等用户触发 */
function onImageLoad(): void {
  sourceDataCache = null
  if (isSolid.value) void runPreview()
}

/**
 * 在原图上取色作为背景基准色。
 * 图片以 object-fit: contain 渲染，需按留白偏移换算回原图像素坐标。
 */
function pickBaseColor(event: MouseEvent): void {
  const image = sourceImage.value
  if (!image || !image.naturalWidth) return
  const rect = image.getBoundingClientRect()
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
  const x = Math.floor((event.clientX - rect.left - (rect.width - image.naturalWidth * scale) / 2) / scale)
  const y = Math.floor((event.clientY - rect.top - (rect.height - image.naturalHeight * scale) / 2) / scale)
  if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return
  const data = currentSourceData(image).data
  const offset = (y * image.naturalWidth + x) * 4
  workspace.video.matte.baseColor = rgbToHex(data[offset], data[offset + 1], data[offset + 2])
}

/** 把当前预览结果写入此帧，帧列表与导出立即生效（裁切结果由 core 按 frame.crop 重算） */
async function applyToFrame(): Promise<void> {
  const item = frame.value
  const image = sourceImage.value
  if (!item || !image) return
  errorText.value = ''
  try {
    if (!previewUrl.value) {
      processing.value = true
      previewUrl.value = await matteFrameImage(image, matteContext(), undefined, isSolid.value ? currentSourceData(image) : undefined)
    }
    await applyMatteToFrames([item], matteContext(), { reuse: { id: item.id, url: previewUrl.value } })
  } catch (error) {
    errorText.value = describeMattingError(error, workspace.video.matte.mode)
  } finally {
    processing.value = false
    statusText.value = ''
    progressPercent.value = -1
  }
}

/** 清除此帧的抠图结果，恢复为原始抽帧画面，并重算该帧的裁切结果 */
async function restoreFrame(): Promise<void> {
  const item = frame.value
  if (!item) return
  item.matteUrl = undefined
  previewUrl.value = ''
  autoBase.value = null
  await recropFrame(item)
  if (isSolid.value) void runPreview()
}

/** 用当前设置批量抠图全部帧（带进度、可中途取消） */
async function batchApply(): Promise<void> {
  const list = workspace.video.frames
  if (!list.length) return
  batch.value = { running: true, done: 0, total: list.length }
  token = createCancelToken()
  errorText.value = ''
  try {
    const done = await applyMatteToFrames(list, matteContext(), {
      token,
      // 样板帧已有预览结果时直接复用，省一次推理
      reuse: previewUrl.value ? { id: props.frameId, url: previewUrl.value } : null,
      onProgress: (count, total, text) => {
        progressPrefix.value = `批量 ${count}/${total} · `
        batch.value = { running: true, done: count, total }
        statusText.value = `${progressPrefix.value}${text}`
      },
    })
    statusText.value = token.cancelled ? `已取消，完成 ${done} 帧` : `已将抠图结果应用到 ${done} 帧`
  } catch (error) {
    errorText.value = describeMattingError(error, workspace.video.matte.mode)
  } finally {
    progressPrefix.value = ''
    statusText.value = ''
    progressPercent.value = -1
    batch.value = { running: false, done: batch.value.done, total: list.length }
  }
}

// 纯色模式参数变化即刷新预览；AI 模式下参数变化后旧预览失效，需重新生成
watch(
  () => [
    workspace.video.matte.mode,
    workspace.video.matte.tolerance,
    workspace.video.matte.shadow,
    workspace.video.matte.baseColor,
    workspace.matte.aiDevice,
    workspace.matte.aiDtype,
  ] as const,
  () => {
    if (busy.value) return
    if (isSolid.value) {
      void runPreview()
      return
    }
    previewUrl.value = ''
    autoBase.value = null
  },
)

// 抠图设置与 AI 偏好持久化（AI 偏好与「抠图」页共用同一组字段）
watch(
  () => [workspace.video.matte, workspace.matte.aiDevice, workspace.matte.aiDtype, workspace.matte.aiModelHost, workspace.matte.aiMaxSide] as const,
  () => persistMediaSettings(),
  { deep: true },
)

// 打开弹窗时复用该帧已应用的抠图结果
previewUrl.value = frame.value?.matteUrl ?? ''
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal frame-matte" role="dialog" aria-modal="true" aria-labelledby="frame-matte-title">
      <div class="modal-head">
        <div>
          <h2 id="frame-matte-title">帧抠图</h2>
          <p class="faint">
            第 {{ frameIndex + 1 }} 帧 · {{ frame?.timestamp.toFixed(2) }}s · 先单张调好效果，再批量复制到全部帧
          </p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <div class="matte-compare">
          <figure class="matte-pane">
            <figcaption class="faint">原图<template v-if="isSolid"> · 点击背景处吸取基准色</template></figcaption>
            <div class="matte-stage" :class="{ pickable: isSolid }">
              <img v-if="frame" ref="sourceImage" :src="frame.url" alt="原始帧" @load="onImageLoad" @click="pickBaseColor" />
            </div>
          </figure>
          <figure class="matte-pane">
            <figcaption class="faint">抠图结果 <span v-if="frame?.matteUrl" class="badge badge-accent">已应用</span></figcaption>
            <div class="matte-stage checker">
              <img v-if="previewUrl" :src="previewUrl" alt="抠图结果" />
              <span v-else class="faint">尚未生成预览</span>
            </div>
          </figure>
        </div>

        <MatteSettingsFields :auto-base-hex="autoBaseHex" />

        <p class="modal-help">
          <template v-if="isSolid">
            纯色背景走色相判据：只看色相与饱和度、不看明度，所以光照不均与地面影子都能正确归类，角色身上的白衣服与黑色线稿不会被误伤。
          </template>
          <template v-else>
            AI 模型按显著性分割主体，适合背景复杂或非纯色场景。帧抠图会在不超过 {{ AI_MAX_SIDE_LIMIT }}px
            上推理再放大回原帧尺寸，因此各帧尺寸始终一致；模型权重来自本地 public/models，已加载过的模型会直接复用，不会重新下载。
            CPU 模式下 RMBG 内存占用较高，若提示内存不足请改用 ISNet 或切换到 GPU（WebGPU）。
          </template>
        </p>

        <TaskProgress
          v-if="processing || batch.running || statusText || errorText"
          :running="batch.running"
          :done="batch.done"
          :total="batch.total"
          :text="statusText || (processing ? '处理中…' : '')"
          :percent="progressPercent"
          :error="errorText"
          @cancel="token.cancelled = true"
        />
      </div>
      <div class="modal-foot">
        <button class="btn" :disabled="busy || !frame?.matteUrl" @click="restoreFrame">还原此帧</button>
        <span class="foot-spacer"></span>
        <button v-if="!isSolid" class="btn" :disabled="busy || !frame" @click="runPreview">生成预览</button>
        <button class="btn" :disabled="busy || !frame" @click="applyToFrame">应用到此帧</button>
        <button v-if="!batch.running" class="btn btn-primary" :disabled="busy || !workspace.video.frames.length" @click="batchApply">
          批量复制到全部帧
        </button>
        <button v-else class="btn btn-danger" @click="token.cancelled = true">取消（{{ batch.done }}/{{ batch.total }}）</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.frame-matte {
  width: min(840px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
}

.frame-matte .modal-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.matte-compare {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-3);
}

.matte-pane {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.matte-pane figcaption {
  font-size: var(--fs-caption);
}

.matte-stage {
  height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: var(--sp-2);
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
}

.matte-stage.checker {
  background-color: var(--checker-b);
  background-image: linear-gradient(45deg, var(--checker-a) 25%, transparent 25%), linear-gradient(-45deg, var(--checker-a) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--checker-a) 75%), linear-gradient(-45deg, transparent 75%, var(--checker-a) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}

.matte-stage img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.matte-stage.pickable img {
  cursor: crosshair;
}

.frame-matte .modal-help {
  margin: 0;
}

.foot-spacer {
  flex: 1;
}
</style>