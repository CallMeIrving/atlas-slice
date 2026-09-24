<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { applyColorKey, colorKeyBase, sampleEdgeColor, type ColorKeyBase } from '@/core/color-key'
import { describeMattingError, removeWithImgly, removeWithTransformers, type MatteProgress } from '@/core/ai-matting'
import { persistMediaSettings, workspace, type FrameMatteMode } from '@/store/workspace'

const props = defineProps<{ frameId: string }>()
const emit = defineEmits<{ close: [] }>()

/** AI 推理分辨率上限：帧抠图要连续处理多帧，限制在 1024 内可显著降低 wasm 堆压力 */
const AI_MAX_SIDE_LIMIT = 1024

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
const cancelBatch = ref(false)
const batch = ref({ running: false, done: 0, total: 0 })
/** 临时图片元素缓存，避免批量时重复解码同一帧 */
let sourceDataCache: { id: string; data: ImageData } | null = null
/** 自增令牌，用于丢弃参数变更后过期的异步预览结果 */
let previewToken = 0
/** 批量进度前缀，让单帧推理的进度文本带上全局进度 */
const progressPrefix = ref('')

const modeOptions: { value: FrameMatteMode; label: string }[] = [
  { value: 'solid', label: '纯色背景（本地算法，零等待）' },
  { value: 'imgly', label: 'ISNet（imgly）AI 模型' },
  { value: 'birefnet', label: 'BiRefNet AI 模型' },
  { value: 'rmbg', label: 'RMBG-1.4（BRIA）AI 模型' },
]

const frame = computed(() => workspace.video.frames.find((item) => item.id === props.frameId) ?? null)
const frameIndex = computed(() => workspace.video.frames.findIndex((item) => item.id === props.frameId))
const isSolid = computed(() => workspace.video.matte.mode === 'solid')
const busy = computed(() => processing.value || batch.value.running)
/** 当前生效的基准色：手动取色优先，其次自动采样 */
const activeBase = computed<ColorKeyBase | null>(() => {
  const manual = hexToRgb(workspace.video.matte.baseColor)
  return manual ? colorKeyBase(manual.r, manual.g, manual.b) : autoBase.value
})
const baseHex = computed(() => {
  const base = activeBase.value
  return base ? rgbToHex(base.r, base.g, base.b) : '—'
})

/** #rrggbb → RGB，非法输入返回 null */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/** RGB → #rrggbb */
function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** 加载图片元素（dataURL / blob URL 通用） */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图像加载失败'))
    image.src = url
  })
}

/** Blob → dataURL，用于持久保存抠图结果 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取抠图结果失败'))
    reader.readAsDataURL(blob)
  })
}

/** 取出图片的像素数据（保留原始分辨率） */
function imageToImageData(image: HTMLImageElement): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/** ImageData → dataURL PNG */
function imageDataToUrl(data: ImageData): string {
  const canvas = document.createElement('canvas')
  canvas.width = data.width
  canvas.height = data.height
  canvas.getContext('2d')!.putImageData(data, 0, 0)
  return canvas.toDataURL('image/png')
}

/** 取出当前帧原图像素数据，按帧 id 缓存避免重复解码 */
function currentSourceData(image: HTMLImageElement): ImageData {
  if (!sourceDataCache || sourceDataCache.id !== props.frameId) {
    sourceDataCache = { id: props.frameId, data: imageToImageData(image) }
  }
  return sourceDataCache.data
}

/**
 * 纯色背景抠图：手动基准色优先，否则从图像四边采样；始终在像素副本上运算，
 * 因此可以反复调参而不会叠加误差。
 */
function matteSolidData(image: HTMLImageElement): { url: string; base: ColorKeyBase } {
  const source = currentSourceData(image)
  const work = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
  const manual = hexToRgb(workspace.video.matte.baseColor)
  const base = manual ? colorKeyBase(manual.r, manual.g, manual.b) : sampleEdgeColor(source)
  applyColorKey(work, {
    r: base.r,
    g: base.g,
    b: base.b,
    tolerance: workspace.video.matte.tolerance,
    shadow: workspace.video.matte.shadow,
    // 仅中性色背景需要额外去除近白像素；有彩色背景下白色饱和度接近 0，天然不匹配
    removeWhite: !base.chromatic,
  })
  return { url: imageDataToUrl(work), base }
}

/**
 * 把 AI 抠图结果统一到原帧尺寸。
 * AI 在受限分辨率（不超过 1024）上推理，结果会小于原帧；若直接采用，
 * 各帧尺寸会不一致，导出雪碧图/序列帧就会错位，因此这里按原帧尺寸放大回来。
 */
async function fitResultToSize(blob: Blob, width: number, height: number): Promise<string> {
  const url = await blobToDataUrl(blob)
  const image = await loadImage(url)
  if (image.naturalWidth === width && image.naturalHeight === height) return url
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

/**
 * 按当前设置对单帧图像执行抠图，返回结果 dataURL。
 * 始终从原始帧出发，保证反复调整参数时结果稳定、不叠加误差。
 */
async function matteFrameImage(image: HTMLImageElement): Promise<string> {
  const settings = workspace.video.matte
  if (settings.mode === 'solid') return matteSolidData(image).url
  const configured = workspace.matte.aiMaxSide
  const maxSide = configured > 0 ? Math.min(configured, AI_MAX_SIDE_LIMIT) : AI_MAX_SIDE_LIMIT
  const onProgress = (progress: MatteProgress): void => {
    statusText.value = `${progressPrefix.value}${progress.text}`
    progressPercent.value = progress.percent ?? -1
  }
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (settings.mode === 'imgly') {
    const { blob } = await removeWithImgly(image, {
      model: workspace.matte.imglyModel,
      device: workspace.matte.aiDevice,
      maxSide,
      publicPath: workspace.matte.imglyPublicPath || undefined,
      onProgress,
    })
    return fitResultToSize(blob, width, height)
  }
  const { blob } = await removeWithTransformers(image, {
    modelId: settings.mode === 'birefnet' ? workspace.matte.birefnetModelId : workspace.matte.rmbgModelId,
    dtype: workspace.matte.aiDtype,
    device: workspace.matte.aiDevice,
    modelHost: workspace.matte.aiModelHost,
    maxSide,
    onProgress,
  })
  return fitResultToSize(blob, width, height)
}

/** 生成当前帧的抠图预览；参数变更时由 watch 自动调用（纯色模式瞬时完成） */
async function runPreview(): Promise<void> {
  const image = sourceImage.value
  if (!image || !image.naturalWidth) return
  const token = ++previewToken
  errorText.value = ''
  try {
    if (isSolid.value) {
      const { url, base } = matteSolidData(image)
      if (token !== previewToken) return
      autoBase.value = base
      previewUrl.value = url
      return
    }
    processing.value = true
    statusText.value = '准备 AI 模型…'
    progressPercent.value = -1
    const url = await matteFrameImage(image)
    if (token !== previewToken) return
    previewUrl.value = url
  } catch (error) {
    if (token !== previewToken) return
    errorText.value = describeMattingError(error, workspace.video.matte.mode)
  } finally {
    if (token === previewToken) {
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

/** 清除手动基准色，恢复自动采样 */
function resetBaseColor(): void {
  workspace.video.matte.baseColor = ''
}

/** 把当前预览结果写入此帧，帧列表与导出立即生效 */
async function applyToFrame(): Promise<void> {
  const item = frame.value
  const image = sourceImage.value
  if (!item || !image) return
  errorText.value = ''
  try {
    if (!previewUrl.value) {
      processing.value = true
      previewUrl.value = await matteFrameImage(image)
    }
    item.matteUrl = previewUrl.value
  } catch (error) {
    errorText.value = describeMattingError(error, workspace.video.matte.mode)
  } finally {
    processing.value = false
    statusText.value = ''
    progressPercent.value = -1
  }
}

/** 清除此帧的抠图结果，恢复为原始抽帧画面 */
function restoreFrame(): void {
  const item = frame.value
  if (!item) return
  item.matteUrl = undefined
  previewUrl.value = ''
  autoBase.value = null
  if (isSolid.value) void runPreview()
}

/** 用当前设置批量抠图全部帧（带进度，可中途取消） */
async function batchApply(): Promise<void> {
  const list = workspace.video.frames
  if (!list.length) return
  batch.value = { running: true, done: 0, total: list.length }
  cancelBatch.value = false
  errorText.value = ''
  try {
    for (const item of list) {
      if (cancelBatch.value) break
      progressPrefix.value = `批量 ${batch.value.done + 1}/${batch.value.total} · `
      if (item.id === props.frameId && previewUrl.value) {
        item.matteUrl = previewUrl.value
      } else {
        const image = await loadImage(item.url)
        statusText.value = `${progressPrefix.value}处理中…`
        item.matteUrl = await matteFrameImage(image)
      }
      batch.value.done += 1
      statusText.value = `${progressPrefix.value}已完成`
      progressPercent.value = -1
      // 让出主线程，保证进度显示与取消按钮始终可响应
      await nextTick()
    }
  } catch (error) {
    errorText.value = describeMattingError(error, workspace.video.matte.mode)
  } finally {
    cancelBatch.value = false
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

        <div class="matte-fields">
          <label class="field">
            <span class="field-label">抠图方式</span>
            <select v-model="workspace.video.matte.mode" class="select">
              <option v-for="option in modeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <template v-if="isSolid">
            <label class="field">
              <span class="field-label">影子处理</span>
              <select v-model="workspace.video.matte.shadow" class="select">
                <option value="neutral">保留影子（转中性半透明）</option>
                <option value="remove">连影子一起抠掉</option>
                <option value="ignore">保留原样（影子带背景色）</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">颜色容差 {{ workspace.video.matte.tolerance }}</span>
              <input v-model.number="workspace.video.matte.tolerance" class="range" type="range" min="4" max="60" step="1" />
            </label>
            <div class="field">
              <span class="field-label">背景基准色</span>
              <div class="base-row">
                <span class="chip" :style="{ background: baseHex }"></span>
                <span class="mono faint">{{ baseHex }}{{ workspace.video.matte.baseColor ? ' · 手动' : ' · 自动采样' }}</span>
                <button class="btn" :disabled="!workspace.video.matte.baseColor" @click="resetBaseColor">恢复自动</button>
              </div>
            </div>
          </template>
          <template v-else>
            <label class="field">
              <span class="field-label">推理设备</span>
              <select v-model="workspace.matte.aiDevice" class="select">
                <option value="cpu">CPU（兼容性最好）</option>
                <option value="gpu">GPU / WebGPU（需浏览器支持）</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">模型精度</span>
              <select v-model="workspace.matte.aiDtype" class="select">
                <option value="fp16">FP16（推荐）</option>
                <option value="q8">Q8（体积小、速度快）</option>
                <option value="fp32">FP32（精度最高）</option>
              </select>
            </label>
          </template>
        </div>

        <p class="modal-help">
          <template v-if="isSolid">
            纯色背景走色相判据：只看色相与饱和度、不看明度，所以光照不均与地面影子都能正确归类，角色身上的白衣服与黑色线稿不会被误伤。
          </template>
          <template v-else>
            AI 模型按显著性分割主体，适合背景复杂或非纯色场景。帧抠图会在不超过 {{ AI_MAX_SIDE_LIMIT }}px
            上推理再放大回原帧尺寸，因此各帧尺寸始终一致；模型权重来自本地 public/models，已加载过的模型会直接复用，不会重新下载。
            CPU 模式下 BiRefNet / RMBG 内存占用较高，若提示内存不足请改用 ISNet 或切换到 GPU（WebGPU）。
          </template>
        </p>

        <div v-if="errorText || statusText" class="matte-status">
          <span v-if="errorText" class="matte-error">{{ errorText }}</span>
          <template v-else>
            <span class="muted">{{ statusText }}</span>
            <span v-if="progressPercent >= 0" class="mono faint">{{ progressPercent }}%</span>
          </template>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" :disabled="busy || !frame?.matteUrl" @click="restoreFrame">还原此帧</button>
        <span class="foot-spacer"></span>
        <button v-if="!isSolid" class="btn" :disabled="busy || !frame" @click="runPreview">生成预览</button>
        <button class="btn" :disabled="busy || !frame" @click="applyToFrame">应用到此帧</button>
        <button v-if="!batch.running" class="btn btn-primary" :disabled="busy || !workspace.video.frames.length" @click="batchApply">
          批量复制到全部帧
        </button>
        <button v-else class="btn btn-danger" @click="cancelBatch = true">取消（{{ batch.done }}/{{ batch.total }}）</button>
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

.matte-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-3) var(--sp-4);
}

.frame-matte .modal-help {
  margin: 0;
}

.matte-status {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}

.matte-error {
  color: var(--danger);
}

.base-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.base-row .chip {
  width: 22px;
  height: 22px;
  flex: none;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-s);
}

.range {
  width: 100%;
  accent-color: var(--accent);
}

.foot-spacer {
  flex: 1;
}
</style>