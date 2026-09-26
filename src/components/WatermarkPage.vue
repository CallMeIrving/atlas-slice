<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { clampCropRect, type ImageCropRect } from '@/core/crop'
import { createCancelToken, type CancelToken } from '@/core/frame-extract'
import { rgbToHex } from '@/core/frame-matte'
import { imageToImageData, loadImage } from '@/core/image'
import { downloadBlob } from '@/core/media-export'
import {
  applyWatermarkToFrames,
  clearWatermarkFromFrames,
  detectWatermarkRect,
  watermarkImageData,
  type WatermarkCorner,
  type WatermarkPlan,
} from '@/core/watermark'
import {
  persistMediaSettings,
  resetWatermark,
  startWatermarkFromFrame,
  workspace,
  type WatermarkMode,
} from '@/store/workspace'
import FrameCropEditor from '@/components/FrameCropEditor.vue'
import TaskProgress from '@/components/TaskProgress.vue'

/**
 * 去水印页。
 * 数据来源既可以是导入的单张图片，也可以是视频帧列表（用样板帧调参、再批量应用）；
 * 算法全部走 core/watermark 的零模型本地实现，与抠图链路通过 frame.watermarkUrl 打通。
 */

const MODE_OPTIONS: { value: WatermarkMode; label: string; hint: string }[] = [
  {
    value: 'alpha',
    label: '逆向 Alpha 还原（半透明水印首选）',
    hint: '由 C_comp = α·C_wm + (1-α)·C_bg 解出 α 并精确还原底色，α 本身即混合权重，抗锯齿边缘自动得到中间值，不需要阈值与羽化。',
  },
  {
    value: 'patch',
    label: '按蒙版替换水印像素',
    hint: '按色差阈值判定水印像素并替换为底色，适合不透明水印、框选留有余量的情况。',
  },
  {
    value: 'region',
    label: '整块重建（四边界插值）',
    hint: '无视蒙版，用 ROI 四边界逆向距离加权插值重建整块区域，适合底色有渐变或水印边界不确定的情况。',
  },
]

const CORNER_OPTIONS: { value: WatermarkCorner | 'auto'; label: string }[] = [
  { value: 'auto', label: '自动（四角各扫一次）' },
  { value: 'nw', label: '左上' },
  { value: 'ne', label: '右上' },
  { value: 'sw', label: '左下' },
  { value: 'se', label: '右下' },
]

/** 放大对比的倍数选项 */
const ZOOM_SCALES = [2, 4, 8]
/** 放大对比画布的长边上限，避免大 ROI 配高倍数时分配超大画布 */
const ZOOM_MAX_SIDE = 420

const input = ref<HTMLInputElement>()
const beforeCanvas = ref<HTMLCanvasElement>()
const afterCanvas = ref<HTMLCanvasElement>()
/** 自动定位的目标角落 */
const autoCorner = ref<WatermarkCorner | 'auto'>('auto')
/** 自动定位实际命中的角落，供用户确认 */
const detectedCorner = ref<WatermarkCorner | null>(null)
/** 自动采样到的底色，展示用 */
const sampledBase = ref('')
/** alpha 模式退化提示 */
const degraded = ref(false)
/** ROI 是否已为当前来源准备好（准备好后才挂载编辑器，避免编辑器先按整帧兜底覆盖自动定位结果） */
const roiReady = ref(false)
const zoomScale = ref(4)
const batch = ref({ running: false, done: 0, total: 0 })
const statusText = ref('')
const errorText = ref('')

let token: CancelToken = createCancelToken()
/** 本次解析出的参数：批量应用时全帧共用这一份，保证时域一致 */
const plan = ref<WatermarkPlan | null>(null)
let previewTimer = 0
let zoomFrame = 0
/** 预览令牌：参数变化后丢弃过期的异步结果 */
let previewToken = 0
/** 单条像素数据缓存与单条图像缓存，调参时避免重复解码（结果图每次都是新 dataURL，不做缓存以免堆积） */
let sampleCache: { url: string; data: ImageData } | null = null
let sourceImageCache: { url: string; image: HTMLImageElement } | null = null
let resultImageCache: { url: string; image: HTMLImageElement } | null = null

const frames = computed(() => workspace.video.frames)
const isFrames = computed(() => workspace.watermark.source === 'frames')
/** 帧模式的画面固定取原始抽帧画面：反复调参始终从同一稳定源重算，不叠加误差 */
const sourceUrl = computed(() => (isFrames.value ? (sampleFrame.value?.url ?? '') : workspace.watermark.sourceUrl))
const hasSource = computed(() => Boolean(sourceUrl.value))
const resultUrl = computed(() => workspace.watermark.resultUrl)
const watermarkedCount = computed(() => frames.value.filter((frame) => frame.watermarkUrl).length)
const usesThreshold = computed(() => plan.value?.mode === 'patch')
const activeModeHint = computed(() => MODE_OPTIONS.find((item) => item.value === workspace.watermark.settings.mode)?.hint ?? '')
const editorCaption = computed(() => `点击水印所在位置框选 · 当前 ROI ${roiLabel.value}`)
const roiLabel = computed(() => {
  const rect = workspace.watermark.roi
  return rect ? `${Math.round(rect.x)},${Math.round(rect.y)} · ${Math.round(rect.width)}×${Math.round(rect.height)} px` : '未设置'
})

/** 帧模式下的样板帧：指定的帧不存在时回落到第一帧 */
const sampleFrame = computed(() => {
  const list = frames.value
  return list.find((frame) => frame.id === workspace.watermark.frameId) ?? list[0] ?? null
})

/** ROI 双向绑定：编辑器只在本组件确认 ROI 就绪后挂载，因此这里始终有值 */
const roiModel = computed<ImageCropRect>({
  get: () => workspace.watermark.roi ?? { x: 0, y: 0, width: 0, height: 0 },
  set: (value) => { workspace.watermark.roi = value },
})

/** 取来源图像的像素数据（单条缓存，调参时避免重复解码） */
async function sourceData(url: string): Promise<ImageData> {
  if (sampleCache?.url !== url) sampleCache = { url, data: imageToImageData(await loadImage(url)) }
  return sampleCache.data
}

/** 取来源图像元素（单条缓存，放大对比反复绘制时避免重复解码） */
async function sourceImage(url: string): Promise<HTMLImageElement> {
  if (sourceImageCache?.url !== url) sourceImageCache = { url, image: await loadImage(url) }
  return sourceImageCache.image
}

/** 自动定位失败时的兜底 ROI：右下角一小块（水印最常见的位置） */
function defaultCornerRect(width: number, height: number): ImageCropRect {
  const boxWidth = Math.max(8, Math.round(width * 0.28))
  const boxHeight = Math.max(8, Math.round(height * 0.12))
  const margin = Math.max(2, Math.round(Math.min(width, height) * 0.02))
  return clampCropRect({ x: width - boxWidth - margin, y: height - boxHeight - margin, width: boxWidth, height: boxHeight }, width, height)
}

/**
 * 来源变化后的准备：清缓存 → 自动定位 ROI（定位不到则给右下角默认框）→ 允许挂载编辑器。
 * ROI 已存在（例如用户切回同一来源）时只做范围收敛，保留用户手工框选的结果。
 */
async function prepareSource(): Promise<void> {
  roiReady.value = false
  sampleCache = null
  sourceImageCache = null
  resultImageCache = null
  const url = sourceUrl.value
  if (!url) { workspace.watermark.roi = null; return }
  try {
    const image = await sourceImage(url)
    const data = await sourceData(url)
    if (workspace.watermark.roi) {
      workspace.watermark.roi = clampCropRect(workspace.watermark.roi, image.naturalWidth, image.naturalHeight)
    } else {
      const found = detectWatermarkRect(data, { corner: autoCorner.value })
      detectedCorner.value = found?.corner ?? null
      workspace.watermark.roi = found ? found.rect : defaultCornerRect(image.naturalWidth, image.naturalHeight)
    }
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '图像加载失败'
    return
  }
  roiReady.value = true
}

/**
 * 按当前参数生成样板预览。
 * 三种修复方式都是零模型本地运算，速度足够快，因此参数一改就刷新，不需要「生成预览」按钮。
 */
async function runPreview(): Promise<void> {
  const url = sourceUrl.value
  const area = workspace.watermark.roi
  if (!url || !area || batch.value.running) return
  const stamp = ++previewToken
  errorText.value = ''
  workspace.watermark.status = 'processing'
  try {
    const result = watermarkImageData(workspace.watermark.settings, area, await sourceData(url))
    if (stamp !== previewToken) return
    plan.value = result.plan
    degraded.value = result.degraded
    sampledBase.value = rgbToHex(result.plan.base.r, result.plan.base.g, result.plan.base.b)
    workspace.watermark.resultUrl = result.url
    workspace.watermark.status = 'done'
    scheduleZoom()
  } catch (error) {
    if (stamp !== previewToken) return
    workspace.watermark.status = 'error'
    errorText.value = error instanceof Error ? error.message : '去水印处理失败'
  }
}

/** 合并高频参数与 ROI 变化的预览重算 */
function schedulePreview(): void {
  if (previewTimer) window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => {
    previewTimer = 0
    void runPreview()
  }, 120)
}

/** 绘制 ROI 局部放大对比：处理前取原始画面，处理后取本次结果 */
async function renderZoom(): Promise<void> {
  const canvas = beforeCanvas.value
  const url = sourceUrl.value
  const area = workspace.watermark.roi
  if (!canvas || !url || !area) return
  const source = await sourceImage(url)
  const rect = clampCropRect(area, source.naturalWidth, source.naturalHeight)
  const scale = Math.min(zoomScale.value, ZOOM_MAX_SIDE / Math.max(1, rect.width, rect.height))
  const draw = (target: HTMLCanvasElement, image: HTMLImageElement): void => {
    target.width = Math.max(1, Math.round(rect.width * scale))
    target.height = Math.max(1, Math.round(rect.height * scale))
    const ctx = target.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, target.width, target.height)
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, target.width, target.height)
  }
  draw(canvas, source)
  const after = afterCanvas.value
  const result = workspace.watermark.resultUrl
  if (!after || !result) return
  if (resultImageCache?.url !== result) resultImageCache = { url: result, image: await loadImage(result) }
  draw(after, resultImageCache.image)
}

/** 用 rAF 合并拖动 ROI 时的高频对比图重绘 */
function scheduleZoom(): void {
  if (zoomFrame) return
  zoomFrame = window.requestAnimationFrame(() => {
    zoomFrame = 0
    void renderZoom()
  })
}

/** 导入单张图片：切到图片模式，ROI 与结果交给 prepareSource 重算 */
function load(file?: File): void {
  if (!file || !file.type.startsWith('image/')) return
  if (workspace.watermark.sourceUrl) URL.revokeObjectURL(workspace.watermark.sourceUrl)
  Object.assign(workspace.watermark, {
    source: 'image', fileName: file.name, sourceUrl: URL.createObjectURL(file),
    resultUrl: '', frameId: '', status: 'ready', error: '', roi: null,
  })
}

/** 自动定位水印并把结果写入编辑器 */
async function autoDetect(setBox: (rect: ImageCropRect) => void): Promise<void> {
  const url = sourceUrl.value
  if (!url || !batch.value.running) return
  errorText.value = ''
  try {
    const found = detectWatermarkRect(await sourceData(url), { corner: autoCorner.value })
    if (!found) { errorText.value = '未定位到明显的水印区域，请手动框选'; return }
    detectedCorner.value = found.corner
    setBox(found.rect)
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '自动定位失败'
  }
}

/** 把同一份参数应用到全部帧（带进度、可中途取消） */
async function batchApply(): Promise<void> {
  const current = plan.value
  const list = frames.value
  if (!current || !list.length || batch.value.running) return
  batch.value = { running: true, done: 0, total: list.length }
  token = createCancelToken()
  errorText.value = ''
  try {
    const sample = sampleFrame.value
    const done = await applyWatermarkToFrames(list, current, {
      token,
      // 样板帧已有预览结果时直接复用，省一次处理
      reuse: sample && resultUrl.value ? { id: sample.id, url: resultUrl.value } : null,
      onProgress: (count, total, text) => {
        batch.value = { running: true, done: count, total }
        statusText.value = text
      },
    })
    statusText.value = token.cancelled ? `已取消，完成 ${done} 帧` : `已将去水印结果应用到 ${done} 帧`
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '批量去水印失败'
  } finally {
    batch.value = { running: false, done: batch.value.done, total: list.length }
  }
}

/** 清除全部帧的去水印结果，恢复为原始抽帧画面（裁切结果随画面一起重算） */
async function restoreFrames(): Promise<void> {
  if (batch.value.running) return
  await clearWatermarkFromFrames(frames.value)
  statusText.value = '已还原全部帧的去水印结果'
  errorText.value = ''
}

/** 下载样板结果 PNG */
async function downloadResult(): Promise<void> {
  const url = workspace.watermark.resultUrl
  if (!url) return
  try {
    downloadBlob(await (await fetch(url)).blob(), `${workspace.watermark.fileName.replace(/\.[^.]+$/, '') || 'image'}-watermark-removed.png`)
  } catch {
    errorText.value = '下载失败'
  }
}

/** 重置去水印页（参数保留，来源、ROI 与结果清空） */
function resetAll(): void {
  resetWatermark()
  plan.value = null
  sampledBase.value = ''
  degraded.value = false
  statusText.value = ''
  errorText.value = ''
}

// 来源变化：重新准备 ROI 并出一次预览
watch(sourceUrl, () => {
  statusText.value = ''
  void prepareSource().then(() => schedulePreview())
})
// ROI 变化（拖拽 / 输入 / 自动定位）后重算预览与放大对比
watch(() => workspace.watermark.roi, () => { schedulePreview(); scheduleZoom() })
// 参数变化即刷新预览，同时持久化（与抠图页共用同一份本地设置）
watch(workspace.watermark.settings, () => { persistMediaSettings(); schedulePreview() }, { deep: true })
watch(zoomScale, scheduleZoom)

// 首次进入页面：已有来源时补齐 ROI 与预览
void prepareSource().then(() => schedulePreview())

onBeforeUnmount(() => {
  if (previewTimer) window.clearTimeout(previewTimer)
  if (zoomFrame) window.cancelAnimationFrame(zoomFrame)
  // 离开页面时中断尚未结束的批量处理，保留已完成的帧
  token.cancelled = true
})
</script>

<template>
  <div class="tool-page">
    <section class="tool-sidebar panel">
      <div class="section">
        <h2 class="section-title">去水印</h2>
        <p class="muted">本地处理，不上传素材</p>
      </div>

      <div class="section">
        <h2 class="section-title">数据来源</h2>
        <button class="btn btn-primary full" @click="input?.click()">导入图片</button>
        <input ref="input" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="load(($event.target as HTMLInputElement).files?.[0])" />
        <button class="btn full" :disabled="!frames.length" @click="startWatermarkFromFrame(workspace.watermark.frameId)">
          使用视频帧列表（{{ frames.length }} 帧）
        </button>
        <label v-if="isFrames && frames.length" class="field">
          <span class="field-label">样板帧</span>
          <select v-model="workspace.watermark.frameId" class="select">
            <option v-for="(frame, index) in frames" :key="frame.id" :value="frame.id">
              #{{ index + 1 }} · {{ frame.timestamp.toFixed(2) }}s
            </option>
          </select>
        </label>
        <p class="muted file-name">{{ workspace.watermark.fileName || '未选择来源' }}</p>
      </div>

      <div class="section">
        <h2 class="section-title">修复方式</h2>
        <select v-model="workspace.watermark.settings.mode" class="select full">
          <option v-for="item in MODE_OPTIONS" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
        <p class="muted">{{ activeModeHint }}</p>
      </div>

      <div class="section">
        <h2 class="section-title">参数</h2>
        <div v-if="workspace.watermark.settings.mode === 'alpha'" class="field">
          <span class="field-label">水印本色（解算用）</span>
          <div class="field-row">
            <input
              class="color-input"
              type="color"
              :value="workspace.watermark.settings.watermarkColor || '#ffffff'"
              @input="workspace.watermark.settings.watermarkColor = ($event.target as HTMLInputElement).value"
            />
            <span class="mono faint">{{ workspace.watermark.settings.watermarkColor || '自动估算' }}</span>
            <button class="btn btn-ghost" :disabled="!workspace.watermark.settings.watermarkColor" @click="workspace.watermark.settings.watermarkColor = ''">自动</button>
          </div>
        </div>

        <div class="field">
          <span class="field-label">底色</span>
          <div class="field-row">
            <input
              class="color-input"
              type="color"
              :value="workspace.watermark.settings.baseColor || sampledBase || '#000000'"
              @input="workspace.watermark.settings.baseColor = ($event.target as HTMLInputElement).value"
            />
            <span class="mono faint">{{ sampledBase ? `环带采样 ${sampledBase}` : '待采样' }}</span>
            <button class="btn btn-ghost" :disabled="!workspace.watermark.settings.baseColor" @click="workspace.watermark.settings.baseColor = ''">自动</button>
          </div>
        </div>

        <label v-if="usesThreshold" class="field">
          <span class="field-label">色差阈值 {{ workspace.watermark.settings.threshold }}</span>
          <input v-model.number="workspace.watermark.settings.threshold" class="range" type="range" min="1" max="150" />
        </label>
        <label v-if="usesThreshold" class="check-row">
          <input v-model="workspace.watermark.settings.keepNoise" type="checkbox" /> 保留底色噪点
        </label>
        <p v-if="usesThreshold" class="muted">底色本身带噪点时，平填会出现一块过于平滑的补丁；噪点用坐标哈希生成，逐帧完全一致。</p>

        <div v-if="degraded" class="warn">水印色与底色过于接近，投影无意义，已自动退化为「按蒙版替换水印像素」。</div>
      </div>

      <div class="section actions">
        <template v-if="isFrames">
          <button class="btn btn-primary full" :disabled="!plan || batch.running || !frames.length" @click="batchApply">应用到全部帧</button>
          <button class="btn full" :disabled="!watermarkedCount || batch.running" @click="restoreFrames">还原全部帧（{{ watermarkedCount }}）</button>
        </template>
        <button class="btn full" :disabled="!resultUrl" @click="downloadResult">下载 PNG</button>
        <button class="btn btn-ghost full" :disabled="batch.running" @click="resetAll">重置去水印</button>
      </div>
    </section>

    <main class="tool-main">
      <div class="tool-header">
        <div>
          <h2>去水印工作区</h2>
          <p>{{ isFrames ? `样板帧 #${frames.findIndex((frame) => frame.id === sampleFrame?.id) + 1} · ${frames.length} 帧待处理` : (workspace.watermark.fileName || '导入一张图片开始处理') }}</p>
        </div>
        <span v-if="watermarkedCount" class="badge badge-accent">{{ watermarkedCount }} 帧已去水印</span>
      </div>

      <div class="tool-body">
        <div v-if="!hasSource" class="empty-state">
          <span class="big">▨</span>
          <strong>还没有可处理的画面</strong>
          <span>导入一张图片，或先在「视频帧」页抽帧后回到这里</span>
        </div>

        <FrameCropEditor
          v-else-if="roiReady"
          v-model="roiModel"
          :source-url="sourceUrl"
          :caption="editorCaption"
          :show-ratio="false"
          :show-preview="false"
          :show-full-frame="false"
        >
          <template #tools="{ natural, setBox }">
            <label class="field">
              <span class="field-label">定位角落</span>
              <select v-model="autoCorner" class="select corner-select">
                <option v-for="item in CORNER_OPTIONS" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </label>
            <div class="field">
              <span class="field-label">自动定位</span>
              <button class="btn" :disabled="!hasSource || !natural.width || batch.running" @click="autoDetect(setBox)">自动框选水印</button>
            </div>
            <span v-if="detectedCorner" class="mono faint corner-status">已定位：{{ CORNER_OPTIONS.find((item) => item.value === detectedCorner)?.label }}</span>
          </template>
          <template #help>
            <p class="modal-help">
              在图上框住水印（可留一点余量），底色由 ROI 外圈环带中位采样得到。角落水印外侧就是确定可采样的纯色背景，
              因此这里用解方程的方式精确还原，而不是让模型去猜纹理——猜出来的纹理逐帧都不一样，画面会抖动。
            </p>
          </template>
        </FrameCropEditor>

        <section v-if="resultUrl && roiReady" class="zoom-panel panel">
          <div class="zoom-head">
            <h3>ROI 放大对比</h3>
            <span class="mono faint">{{ roiLabel }}</span>
            <div class="seg">
              <button
                v-for="scale in ZOOM_SCALES"
                :key="scale"
                class="seg-item"
                :class="{ active: zoomScale === scale }"
                @click="zoomScale = scale"
              >{{ scale }}×</button>
            </div>
          </div>
          <div class="zoom-body">
            <figure class="zoom-pane">
              <figcaption class="faint">处理前</figcaption>
              <div class="zoom-stage"><canvas ref="beforeCanvas"></canvas></div>
            </figure>
            <figure class="zoom-pane">
              <figcaption class="faint">处理后</figcaption>
              <div class="zoom-stage"><canvas ref="afterCanvas"></canvas></div>
            </figure>
          </div>
        </section>

        <TaskProgress
          v-if="batch.running || statusText || errorText"
          :running="batch.running"
          :done="batch.done"
          :total="batch.total"
          :text="statusText"
          :error="errorText"
          @cancel="token.cancelled = true"
        />
      </div>
    </main>
  </div>
</template>

<style scoped>
.tool-page { display: grid; grid-template-columns: 320px minmax(0, 1fr); height: 100%; min-height: 0; }
.tool-sidebar { border-right: 1px solid var(--border); overflow: auto; }
.tool-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tool-header { height: 64px; flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; border-bottom: 1px solid var(--border); }
.tool-header h2 { margin: 0; font-size: var(--fs-head); }
.tool-header p { margin: 2px 0 0; color: var(--text-faint); }
.tool-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding: 24px; }
.full { width: 100%; justify-content: center; }
.actions { display: flex; flex-direction: column; gap: var(--sp-2); }
.file-name { margin: var(--sp-2) 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.section .field + .field, .section .field + .check-row { margin-top: var(--sp-3); }
.range { width: 100%; accent-color: var(--accent); }
.color-input { width: 42px; height: 28px; flex: none; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-raised); }
.field-row .btn { height: 26px; padding: 0 var(--sp-2); font-size: var(--fs-caption); }
.field-row .faint { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.corner-select { width: 100%; }
.corner-status { align-self: center; }
.zoom-panel { padding: var(--sp-3) var(--sp-4); }
.zoom-head { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-3); }
.zoom-head h3 { margin: 0; font-size: var(--fs-title); }
.zoom-head .seg { margin-left: auto; }
.zoom-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
.zoom-pane { margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.zoom-pane figcaption { font-size: var(--fs-caption); }
.zoom-stage { height: 200px; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: var(--sp-2); background: var(--stage); border: 1px solid var(--border); border-radius: var(--radius-s); }
.zoom-stage canvas { max-width: 100%; max-height: 100%; image-rendering: pixelated; }
</style>