<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { colorKeyBase, type ColorKeyBase } from '@/core/color-key'
import { describeMattingError, AI_MAX_SIDE_LIMIT } from '@/core/ai-matting'
import {
  applyMatteToFrames,
  hexToRgb,
  matteFrameImage,
  matteManualData,
  matteSolidData,
  rgbToHex,
  type FrameMatteContext,
} from '@/core/frame-matte'
import { recropFrame } from '@/core/frame-crop'
import { clampCropRect } from '@/core/crop'
import { imageToImageData } from '@/core/image'
import { createCancelToken, type CancelToken } from '@/core/frame-extract'
import { useRoiSelection } from '@/composables/useRoiSelection'
import { persistMediaSettings, frameCleanUrl, workspace } from '@/store/workspace'
import MatteSettingsFields from '@/components/MatteSettingsFields.vue'
import TaskProgress from '@/components/TaskProgress.vue'

/**
 * 移除背景弹窗（原「帧抠图」）。
 * 设置项交给 MatteSettingsFields、单帧/批量处理交给 core/frame-matte、
 * 进度展示交给 TaskProgress，与一键处理流水线共用同一份实现。
 * 「手动移除」方式下在原图上框选区域，框内像素直接置透明。
 */
const props = defineProps<{ frameId: string }>()
const emit = defineEmits<{ close: [] }>()

const sourceImage = ref<HTMLImageElement>()
/** 当前帧处理结果预览（dataURL PNG） */
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
const isManual = computed(() => workspace.video.matte.mode === 'manual')
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

/** 手动移除的框选舞台与图像在视口中的原点（用于把图像坐标换算成舞台内定位） */
const stage = ref<HTMLElement>()
const stageOrigin = ref({ left: 0, top: 0 })
const roi = useRoiSelection({
  getImage: () => sourceImage.value,
  // 框选区域即移除区域，唯一出口写回设置，批量时同一坐标应用到全部帧
  onUpdate: (rect) => { workspace.video.matte.manualRect = rect },
})
const { box, dragging, natural, handles, imageRect, setBox, syncFrom, onStageDown, onBoxDown, onHandleDown } = roi

/** 框选区域在舞台中的像素位置：按渲染缩放比把图像坐标映射回舞台内坐标 */
const manualBoxStyle = computed(() => {
  const rect = imageRect.value
  const size = natural.value
  const area = box.value
  const ready = rect.width > 0 && size.width > 0 && area.width > 0
  const scaleX = ready ? rect.width / size.width : 0
  const scaleY = ready ? rect.height / size.height : 0
  return {
    display: ready ? 'block' : 'none',
    left: `${rect.left - stageOrigin.value.left + area.x * scaleX}px`,
    top: `${rect.top - stageOrigin.value.top + area.y * scaleY}px`,
    width: `${area.width * scaleX}px`,
    height: `${area.height * scaleY}px`,
  }
})

/** 重新测量图像矩形与舞台原点（窗口尺寸变化、图片加载、切到手动方式后都需要） */
function measureStage(): void {
  roi.measure()
  const element = stage.value
  if (!element) return
  const origin = element.getBoundingClientRect()
  stageOrigin.value = { left: origin.left, top: origin.top }
}

/** 清除手动框选区域（回到「不做任何移除」的状态） */
function clearManualRect(): void {
  workspace.video.matte.manualRect = null
  syncFrom({ x: 0, y: 0, width: 0, height: 0 })
  previewUrl.value = ''
}

/** 手动输入坐标后把区域收敛到图像范围内，并走 setBox 写回设置 */
function normalizeManualBox(): void {
  const size = natural.value
  if (!size.width || !size.height) return
  setBox(clampCropRect(box.value, size.width, size.height))
}

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

/** 生成当前帧的处理预览；纯色与手动方式瞬时完成，AI 模式在参数变化后需重新触发 */
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
    if (isManual.value) {
      // 未框选区域时 matteManualData 原样返回，这里直接展示提示而不当成结果
      if (!workspace.video.matte.manualRect) {
        previewUrl.value = ''
        return
      }
      previewUrl.value = matteManualData(image, workspace.video.matte, currentSourceData(image))
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

/** 原图加载完成：纯色模式立即出预览，手动模式只记录尺寸，AI 模式保留已有结果等用户触发 */
function onImageLoad(): void {
  sourceDataCache = null
  const image = sourceImage.value
  // 尺寸与当前方式无关，一律记录：从 AI 方式切到手动后无需重新加载图片也能立即框选
  if (image) natural.value = { width: image.naturalWidth, height: image.naturalHeight }
  if (isManual.value) {
    // 手动模式不自动框选整帧：保持「尚未框选」的空状态，避免一打开就把整帧抹透明
    if (image && workspace.video.matte.manualRect) syncFrom(workspace.video.matte.manualRect)
    void nextTick(measureStage)
    return
  }
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
      // 纯色与手动方式都在本地像素上运算，直接复用当前帧缓存，省一次解码
      previewUrl.value = await matteFrameImage(image, matteContext(), undefined, isSolid.value || isManual.value ? currentSourceData(image) : undefined)
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
    if (isManual.value) {
      // 手动模式的区域由拖拽结束的监听单独触发，这里只处理切换方式后的状态
      void nextTick(measureStage)
      void runPreview()
      return
    }
    previewUrl.value = ''
    autoBase.value = null
  },
)

// 手动模式：拖动结束再刷新预览，避免框选过程中每一步都做整图 PNG 编码
watch(dragging, (now, before) => {
  if (before && !now && isManual.value) void runPreview()
})

// 抠图设置与 AI 偏好持久化（AI 偏好与「抠图」页共用同一组字段）
watch(
  () => [workspace.video.matte, workspace.matte.aiDevice, workspace.matte.aiDtype, workspace.matte.aiModelHost, workspace.matte.aiMaxSide] as const,
  () => persistMediaSettings(),
  { deep: true },
)

onMounted(() => {
  window.addEventListener('resize', measureStage)
  if (workspace.video.matte.manualRect) syncFrom(workspace.video.matte.manualRect)
  void nextTick(measureStage)
})

onBeforeUnmount(() => {
  roi.dispose()
  window.removeEventListener('resize', measureStage)
})

// 打开弹窗时复用该帧已应用的处理结果
previewUrl.value = frame.value?.matteUrl ?? ''
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal flex max-h-[calc(100vh-48px)] w-[min(840px,calc(100vw-48px))] flex-col" role="dialog" aria-modal="true" aria-labelledby="frame-matte-title">
      <div class="modal-head">
        <div>
          <h2 id="frame-matte-title">移除背景</h2>
          <p class="faint">
            第 {{ frameIndex + 1 }} 帧 · {{ frame?.timestamp.toFixed(2) }}s · 先单张调好效果，再批量复制到全部帧
          </p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="modal-body flex min-h-0 flex-1 flex-col gap-4 overflow-auto">
        <div class="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3">
          <figure class="m-0 flex flex-col gap-2">
            <figcaption class="faint text-caption">
              <template v-if="isManual">原图 · 拖拽空白处框选要移除的区域，拖动框体或控制点微调</template>
              <template v-else>原图<template v-if="isSolid"> · 点击背景处吸取基准色</template></template>
            </figcaption>
            <div
              ref="stage"
              class="relative flex h-[300px] items-center justify-center overflow-hidden rounded-sm border border-line bg-stage p-2"
              :class="[isManual && 'cursor-crosshair touch-none', isSolid && '[&_img]:cursor-crosshair']"
              @pointerdown="isManual && onStageDown($event)"
            >
              <img v-if="frame" ref="sourceImage" class="max-h-full max-w-full object-contain" :src="frameCleanUrl(frame)" alt="原始帧" @load="onImageLoad" @click="isSolid && pickBaseColor($event)" />
              <div
                v-if="isManual"
                class="absolute cursor-move touch-none border border-danger bg-[rgb(224_98_106_/_0.28)]"
                :style="manualBoxStyle"
                @pointerdown.stop="onBoxDown($event)"
              >
                <span
                  v-for="handle in handles"
                  :key="handle"
                  class="absolute -mt-[5px] -ml-[5px] size-2.5 rounded-[2px] border border-[#1a140a] bg-danger"
                  :class="{
                    'left-0 top-0 cursor-nwse-resize': handle === 'nw',
                    'left-1/2 top-0 cursor-ns-resize': handle === 'n',
                    'left-full top-0 cursor-nesw-resize': handle === 'ne',
                    'left-full top-1/2 cursor-ew-resize': handle === 'e',
                    'left-full top-full cursor-nwse-resize': handle === 'se',
                    'left-1/2 top-full cursor-ns-resize': handle === 's',
                    'left-0 top-full cursor-nesw-resize': handle === 'sw',
                    'left-0 top-1/2 cursor-ew-resize': handle === 'w',
                  }"
                  @pointerdown.stop="onHandleDown(handle, $event)"
                ></span>
              </div>
            </div>
            <div v-if="isManual" class="grid grid-cols-4 items-end gap-x-3 [&_.input]:w-full">
              <label class="field">
                <span class="field-label">X</span>
                <input v-model.number="box.x" class="input" type="number" min="0" step="1" :max="natural.width" @change="normalizeManualBox" />
              </label>
              <label class="field">
                <span class="field-label">Y</span>
                <input v-model.number="box.y" class="input" type="number" min="0" step="1" :max="natural.height" @change="normalizeManualBox" />
              </label>
              <label class="field">
                <span class="field-label">宽度</span>
                <input v-model.number="box.width" class="input" type="number" min="1" step="1" :max="natural.width" @change="normalizeManualBox" />
              </label>
              <label class="field">
                <span class="field-label">高度</span>
                <input v-model.number="box.height" class="input" type="number" min="1" step="1" :max="natural.height" @change="normalizeManualBox" />
              </label>
            </div>
          </figure>
          <figure class="m-0 flex flex-col gap-2">
            <figcaption class="faint text-caption">{{ isManual ? '移除结果' : '抠图结果' }} <span v-if="frame?.matteUrl" class="badge badge-accent">已应用</span></figcaption>
            <div class="flex h-[300px] items-center justify-center overflow-hidden rounded-sm border border-line bg-checker-b p-2 [background-image:linear-gradient(45deg,var(--checker-a)_25%,transparent_25%),linear-gradient(-45deg,var(--checker-a)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--checker-a)_75%),linear-gradient(-45deg,transparent_75%,var(--checker-a)_75%)] [background-position:0_0,0_8px,8px_-8px,-8px_0] [background-size:16px_16px]">
              <img v-if="previewUrl" class="max-h-full max-w-full object-contain" :src="previewUrl" alt="抠图结果" />
              <span v-else class="faint">{{ isManual && !workspace.video.matte.manualRect ? '尚未框选区域' : '尚未生成预览' }}</span>
            </div>
          </figure>
        </div>

        <MatteSettingsFields :auto-base-hex="autoBaseHex" />

        <p class="modal-help m-0">
          <template v-if="isSolid">
            纯色背景走色相判据：只看色相与饱和度、不看明度，所以光照不均与地面影子都能正确归类，角色身上的白衣服与黑色线稿不会被误伤。
          </template>
          <template v-else-if="isManual">
            手动移除直接抠像素：框选区域内的像素整块变为透明，不做任何颜色判断，因此适合局部遮挡物、纯色底、角色残影这类
            「知道该删哪一块」的场景。区域以帧图像像素为单位，会按同一坐标应用到全部帧。
          </template>
          <template v-else>
            AI 模型按显著性分割主体，适合背景复杂或非纯色场景。帧抠图会在不超过 {{ AI_MAX_SIDE_LIMIT }}px
            上推理再放大回原帧尺寸，因此各帧尺寸始终一致；模型权重来自本地 models/，已加载过的模型会直接复用，不会重新下载。
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
        <span class="flex-1"></span>
        <button v-if="isManual" class="btn" :disabled="busy || !workspace.video.matte.manualRect" @click="clearManualRect">清除选区</button>
        <button v-if="!isSolid" class="btn" :disabled="busy || !frame || (isManual && !workspace.video.matte.manualRect)" @click="runPreview">生成预览</button>
        <button class="btn" :disabled="busy || !frame || (isManual && !workspace.video.matte.manualRect)" @click="applyToFrame">应用到此帧</button>
        <button v-if="!batch.running" class="btn btn-primary" :disabled="busy || !workspace.video.frames.length || (isManual && !workspace.video.matte.manualRect)" @click="batchApply">
          批量复制到全部帧
        </button>
        <button v-else class="btn btn-danger" @click="token.cancelled = true">取消（{{ batch.done }}/{{ batch.total }}）</button>
      </div>
    </section>
  </div>
</template>