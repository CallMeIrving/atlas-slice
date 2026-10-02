<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { clampCropRect, drawCropToCanvas, type ImageCropRect } from '@/core/crop'
import { useRoiSelection } from '@/composables/useRoiSelection'
import { createCancelToken, type CancelToken } from '@/core/frame-extract'
import { rgbToHex } from '@/core/frame-matte'
import { imageToImageData, loadImage } from '@/core/image'
import { downloadBlob } from '@/core/media-export'
import {
  applyWatermarkToFrames,
  clearWatermarkFromFrames,
  watermarkImageData,
  type WatermarkPlan,
} from '@/core/watermark'
import {
  persistMediaSettings,
  resetWatermark,
  startWatermarkFromFrame,
  workspace,
  type WatermarkMode,
} from '@/store/workspace'
import ImageCompareViewer from '@/components/ImageCompareViewer.vue'
import TaskProgress from '@/components/TaskProgress.vue'

/**
 * 去水印页。
 * 数据来源既可以是导入的单张图片，也可以是视频帧列表（用样板帧调参、再批量应用）；
 * 算法全部走 core/watermark 的零模型本地实现，与抠图链路通过 frame.watermarkUrl 打通。
 * 工作区为单舞台融合：框选态在原图上编辑 ROI，处理完成后自动切换为前后对比（分割线 + 缩放 + 平移）。
 */

const MODE_OPTIONS: { value: WatermarkMode; label: string; hint: string }[] = [
  {
    value: 'alpha',
    label: '逆向 Alpha 还原（纯色底半透明水印）',
    hint: '由 C_comp = α·C_wm + (1-α)·C_bg 解出 α 并精确还原底色，α 本身即混合权重，抗锯齿边缘自动得到中间值，不需要阈值与羽化。底色不是纯色时不适用。',
  },
  {
    value: 'texture',
    label: '环带纹理合成（有纹理底首选）',
    hint: '从 ROI 外圈环带复制真实纹理块重建整个区域：环带与 ROI 同材质，搬过来的颗粒与渐变就是原图本身的细节，不会被磨平。水印压在主体结构上时仍会留下痕迹。',
  },
  {
    value: 'patch',
    label: '按蒙版替换水印像素',
    hint: '按色差阈值判定水印像素并替换为底色，适合不透明水印、框选留有余量的情况。底色带纹理时建议改用「环带纹理合成」。',
  },
  {
    value: 'region',
    label: '整块重建（四边界插值）',
    hint: '无视蒙版，用 ROI 四边界逆向距离加权插值重建整块区域，适合底色有渐变或水印边界不确定的情况。结果是平滑的，不含纹理。',
  },
]

/** 重建精细度：直接决定 PatchMatch 的金字塔层数与迭代次数，越精细越慢 */
const QUALITY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '快速' },
  { value: 1, label: '标准' },
  { value: 2, label: '精细（较慢）' },
]

const input = ref<HTMLInputElement>()
const viewer = ref<InstanceType<typeof ImageCompareViewer> | null>(null)
/** 自动采样到的底色，展示用 */
const sampledBase = ref('')
/** alpha 模式退化提示 */
const degraded = ref(false)
/** ROI 是否已为当前来源准备好（准备好后才挂载框选覆盖层，避免先按整帧兜底覆盖初始 ROI） */
const roiReady = ref(false)
/** 对比分割线位置（0–100） */
const divider = ref(50)
/** 用户意图：是否处于框选态（处理成功后自动退出，「重新框选区域」按钮找回） */
const roiEditMode = ref(true)
const batch = ref({ running: false, done: 0, total: 0 })
const statusText = ref('')
const errorText = ref('')

let token: CancelToken = createCancelToken()
/** 本次解析出的参数：批量应用时全帧共用这一份，保证时域一致 */
const plan = ref<WatermarkPlan | null>(null)
/** 手动处理期间的忙碌标记：按钮禁用与结果区文案共用 */
const processing = ref(false)
/** 处理令牌：重复点击时丢弃过期的异步结果 */
let runToken = 0
/** 来源图像的像素数据与图像元素各缓存一条，避免重复解码 */
let sampleCache: { url: string; data: ImageData } | null = null
let sourceImageCache: { url: string; image: HTMLImageElement } | null = null
let resultImageCache: { url: string; image: HTMLImageElement } | null = null

/** 框选交互状态机：图像元素从对比组件取（getBoundingClientRect 天然包含缩放平移），更新写回 store */
const roi = useRoiSelection({
  getImage: () => viewer.value?.getImageEl() ?? null,
  onUpdate: (rect) => { workspace.watermark.roi = rect },
})
const { box, tool, natural, handles, setBox, onStageDown, onBoxDown, onHandleDown } = roi

const frames = computed(() => workspace.video.frames)
const isFrames = computed(() => workspace.watermark.source === 'frames')
/** 帧模式的画面固定取原始抽帧画面：反复调参始终从同一稳定源重算，不叠加误差 */
const sourceUrl = computed(() => (isFrames.value ? (sampleFrame.value?.url ?? '') : workspace.watermark.sourceUrl))
const hasSource = computed(() => Boolean(sourceUrl.value))
const resultUrl = computed(() => workspace.watermark.resultUrl)
const watermarkedCount = computed(() => frames.value.filter((frame) => frame.watermarkUrl).length)
const usesThreshold = computed(() => plan.value?.mode === 'patch')
/** 精细度只作用于 texture 模式（PatchMatch 的金字塔层数与迭代次数），其余模式不看这个值 */
const isTextureMode = computed(() => workspace.watermark.settings.mode === 'texture')
const activeModeHint = computed(() => MODE_OPTIONS.find((item) => item.value === workspace.watermark.settings.mode)?.hint ?? '')
/** 框选态：用户意图框选，或还没有可对比的结果 */
const editingRoi = computed(() => roiEditMode.value || !resultUrl.value)
const roiLabel = computed(() => {
  const rect = workspace.watermark.roi
  return rect ? `${Math.round(rect.x)},${Math.round(rect.y)} · ${Math.round(rect.width)}×${Math.round(rect.height)} px` : '未设置'
})

/** 帧模式下的样板帧：指定的帧不存在时回落到第一帧 */
const sampleFrame = computed(() => {
  const list = frames.value
  return list.find((frame) => frame.id === workspace.watermark.frameId) ?? list[0] ?? null
})

/** ROI 框在覆盖层内的百分比定位：覆盖层与图像显示盒重合，天然跟随缩放平移 */
const roiBoxStyle = computed(() => {
  const size = natural.value
  if (!size.width || !size.height) return { display: 'none' }
  return {
    left: `${(box.value.x / size.width) * 100}%`,
    top: `${(box.value.y / size.height) * 100}%`,
    width: `${(box.value.width / size.width) * 100}%`,
    height: `${(box.value.height / size.height) * 100}%`,
  }
})

/** 框外四块压暗区域的百分比定位 */
const dimStyles = computed(() => {
  const size = natural.value
  const b = box.value
  if (!size.width || !size.height) return { top: {}, bottom: {}, left: {}, right: {} }
  const x = (b.x / size.width) * 100
  const y = (b.y / size.height) * 100
  const w = (b.width / size.width) * 100
  const h = (b.height / size.height) * 100
  return {
    top: { left: '0%', top: '0%', width: '100%', height: `${y}%` },
    bottom: { left: '0%', top: `${y + h}%`, width: '100%', height: `${100 - y - h}%` },
    left: { left: '0%', top: `${y}%`, width: `${x}%`, height: `${h}%` },
    right: { left: `${x + w}%`, top: `${y}%`, width: `${100 - x - w}%`, height: `${h}%` },
  }
})

/** 控制点定位：handle 是 .roi-box 的子元素，百分比相对框自身取 0/50/100 八个锚点；scale(1/zoom) 抵消舞台缩放保持恒定屏幕尺寸 */
function handleStyle(handle: string, zoom: number): Record<string, string> {
  const left = handle.includes('w') ? '0%' : handle.includes('e') ? '100%' : '50%'
  const top = handle.includes('n') ? '0%' : handle.includes('s') ? '100%' : '50%'
  return {
    left,
    top,
    transform: `translate(-50%, -50%) scale(${1 / zoom})`,
  }
}

/** 取来源图像的像素数据（单条缓存，调参时避免重复解码） */
async function sourceData(url: string): Promise<ImageData> {
  if (sampleCache?.url !== url) sampleCache = { url, data: imageToImageData(await loadImage(url)) }
  return sampleCache.data
}

/** 取来源图像元素（缓存一条，准备 ROI 与后续处理复用同一次解码） */
async function sourceImage(url: string): Promise<HTMLImageElement> {
  if (sourceImageCache?.url !== url) sourceImageCache = { url, image: await loadImage(url) }
  return sourceImageCache.image
}

/** 新来源的初始 ROI：右下角一小块（水印最常见的位置），之后一律由用户手动框选 */
function defaultCornerRect(width: number, height: number): ImageCropRect {
  const boxWidth = Math.max(8, Math.round(width * 0.28))
  const boxHeight = Math.max(8, Math.round(height * 0.12))
  const margin = Math.max(2, Math.round(Math.min(width, height) * 0.02))
  return clampCropRect({ x: width - boxWidth - margin, y: height - boxHeight - margin, width: boxWidth, height: boxHeight }, width, height)
}

/**
 * 来源变化后的准备：清缓存 → 给一个初始 ROI → 回到框选态并允许挂载覆盖层。
 * ROI 已存在（例如用户切回同一来源）时只做范围收敛，保留用户手工框选的结果。
 */
async function prepareSource(): Promise<void> {
  roiReady.value = false
  sampleCache = null
  sourceImageCache = null
  resultImageCache = null
  roiEditMode.value = true
  const url = sourceUrl.value
  if (!url) { workspace.watermark.roi = null; return }
  try {
    const image = await sourceImage(url)
    workspace.watermark.roi = workspace.watermark.roi
      ? clampCropRect(workspace.watermark.roi, image.naturalWidth, image.naturalHeight)
      : defaultCornerRect(image.naturalWidth, image.naturalHeight)
    natural.value = { width: image.naturalWidth, height: image.naturalHeight }
    setBox(workspace.watermark.roi)
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '图像加载失败'
    return
  }
  roiReady.value = true
}

/** 手动处理：按当前框选区域与参数生成结果图。
 * 修复方式是零模型本地运算，但精细档的纹理合成耗时明显，因此统一改为点「去水印」才执行。 */
async function runWatermark(): Promise<void> {
  const url = sourceUrl.value
  const area = workspace.watermark.roi
  if (!url || !area || processing.value || batch.value.running) return
  const stamp = ++runToken
  processing.value = true
  errorText.value = ''
  workspace.watermark.status = 'processing'
  try {
    const result = watermarkImageData(workspace.watermark.settings, area, await sourceData(url))
    if (stamp !== runToken) return
    plan.value = result.plan
    degraded.value = result.degraded
    sampledBase.value = rgbToHex(result.plan.base.r, result.plan.base.g, result.plan.base.b)
    workspace.watermark.resultUrl = result.url
    workspace.watermark.status = 'done'
    // 处理成功：退出框选态，舞台自动切换为前后对比
    roiEditMode.value = false
  } catch (error) {
    if (stamp !== runToken) return
    workspace.watermark.status = 'error'
    errorText.value = error instanceof Error ? error.message : '去水印处理失败'
  } finally {
    if (stamp === runToken) processing.value = false
  }
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

/** 作废当前结果：框选、参数或来源一变，旧结果与旧参数就不再对应当前画面 */
function invalidateResult(): void {
  // 同时作废在途处理，避免迟到的结果写回作废后的状态
  runToken += 1
  processing.value = false
  plan.value = null
  workspace.watermark.resultUrl = ''
  sampledBase.value = ''
  degraded.value = false
}

/** 重置去水印页（参数保留，来源、ROI 与结果清空） */
function resetAll(): void {
  invalidateResult()
  resetWatermark()
  statusText.value = ''
  errorText.value = ''
}

/** 手动输入 ROI 数值后把矩形收敛到图像范围内 */
function normalizeRoiBox(): void {
  const size = natural.value
  if (!size.width || !size.height) return
  setBox(clampCropRect(box.value, size.width, size.height))
}

/** 对比组件原图加载完成：同步像素尺寸并刷新预览条 */
function onViewerLoad(size: { width: number; height: number }): void {
  natural.value = size
  scheduleRoiPreview()
}

const sourceCanvas = ref<HTMLCanvasElement>()
const resultCanvas = ref<HTMLCanvasElement>()
/** 预览重绘的 rAF 句柄，合并拖动时的高频变更 */
let roiPreviewFrame = 0

/** 用 rAF 合并框选拖动过程中的预览重绘 */
function scheduleRoiPreview(): void {
  if (roiPreviewFrame) return
  roiPreviewFrame = window.requestAnimationFrame(() => {
    roiPreviewFrame = 0
    void renderRoiPreview()
  })
}

/** 绘制底部 ROI 实时预览：原图裁切恒显，有结果时并列结果同区域裁切 */
async function renderRoiPreview(): Promise<void> {
  const area = workspace.watermark.roi
  const url = sourceUrl.value
  if (!area || !url) return
  try {
    const image = await sourceImage(url)
    if (sourceCanvas.value) drawCropToCanvas(image, area, sourceCanvas.value)
    if (!editingRoi.value && resultUrl.value) {
      if (resultImageCache?.url !== resultUrl.value) resultImageCache = { url: resultUrl.value, image: await loadImage(resultUrl.value) }
      if (resultCanvas.value) drawCropToCanvas(resultImageCache.image, area, resultCanvas.value)
    }
  } catch {
    // 图像尚未就绪时跳过本轮，下一次变更会重新调度
  }
}

// 来源变化：作废旧结果后重新准备 ROI；结果一律由「去水印」按钮触发，不自动重算
watch(sourceUrl, () => {
  statusText.value = ''
  invalidateResult()
  void prepareSource()
})
// 框选区域变化后作废旧结果：旧 plan 与当前画面已不对应，
// 既避免对比视图误导，也避免「应用到全部帧」按过期参数批量处理
watch(() => workspace.watermark.roi, () => invalidateResult())
// 参数变化只持久化（与抠图页共用同一份本地设置），并作废旧结果
watch(workspace.watermark.settings, () => { persistMediaSettings(); invalidateResult() }, { deep: true })
// 框选区域（拖拽 / 输入）与结果变化后重绘预览条
watch(box, scheduleRoiPreview, { deep: true })
watch(resultUrl, scheduleRoiPreview)
watch(editingRoi, scheduleRoiPreview)

// 首次进入页面：已有来源时补齐 ROI
void prepareSource()

onBeforeUnmount(() => {
  // 离开页面时中断尚未结束的批量处理，保留已完成的帧
  token.cancelled = true
  roi.dispose()
  if (roiPreviewFrame) window.cancelAnimationFrame(roiPreviewFrame)
})
</script>

<template>
  <div class="grid h-full min-h-0" :class="hasSource ? 'grid-cols-[280px_minmax(0,1fr)_320px]' : 'grid-cols-[minmax(0,1fr)_320px]'">
    <!-- 左栏：当前来源列表（单图为导入图，帧模式为样板帧画面），无来源时整栏不显示 -->
    <section v-if="hasSource" class="panel overflow-auto border-r border-line">
      <div class="section">
        <h2 class="section-title">图集列表</h2>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <li class="flex items-center gap-2">
            <img class="size-10 flex-none rounded-sm border border-line bg-stage object-contain" :src="sourceUrl" :alt="workspace.watermark.fileName" draggable="false" />
            <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-caption" :title="workspace.watermark.fileName">{{ workspace.watermark.fileName }}</span>
            <!-- 帧模式尺寸取视频帧尺寸；单图模式 store 未记录尺寸，不显示 -->
            <span v-if="isFrames && workspace.video.width" class="mono faint">{{ workspace.video.width }}×{{ workspace.video.height }}</span>
            <button class="btn btn-icon btn-danger" title="移除" @click="resetAll">×</button>
          </li>
        </ul>
      </div>
    </section>

    <main class="flex min-h-0 min-w-0 flex-col">
      <div class="flex h-16 flex-none items-center justify-between gap-4 border-b border-line px-6">
        <div>
          <h2 class="m-0 text-head">去水印工作区</h2>
          <p class="mt-0.5 mb-0 text-faint">{{ isFrames ? `样板帧 #${frames.findIndex((frame) => frame.id === sampleFrame?.id) + 1} · ${frames.length} 帧待处理` : (workspace.watermark.fileName || '导入一张图片开始处理') }}</p>
        </div>
        <div class="flex items-center gap-3">
          <input ref="input" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="load(($event.target as HTMLInputElement).files?.[0])" />
          <button class="btn btn-primary" @click="input?.click()">导入图片</button>
          <button class="btn" :disabled="!frames.length" @click="startWatermarkFromFrame(workspace.watermark.frameId)">使用视频帧列表（{{ frames.length }} 帧）</button>
          <span v-if="watermarkedCount" class="badge badge-accent">{{ watermarkedCount }} 帧已去水印</span>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <div v-if="!hasSource" class="empty-state">
          <span class="big">▨</span>
          <strong>还没有可处理的画面</strong>
          <span>导入一张图片，或先在「视频帧」页抽帧后回到这里</span>
        </div>

        <template v-else>
          <!-- 单舞台：框选态编辑 ROI，处理完成后自动切换为前后对比（缩放/平移/分割线） -->
          <div class="flex min-h-[360px] flex-1 [&>.cmp-stage]:flex-1">
            <ImageCompareViewer
              ref="viewer"
              :before-url="sourceUrl"
              :after-url="editingRoi ? '' : resultUrl"
              :divider="divider"
              :selection-mode="editingRoi"
              @update:divider="divider = $event"
              @background-down="onStageDown($event)"
              @load="onViewerLoad"
            >
              <template #overlay="{ zoom }">
                <template v-if="editingRoi && roiReady && natural.width">
                  <div class="pointer-events-none absolute bg-[rgb(8_10_14_/_0.55)]" :style="dimStyles.top"></div>
                  <div class="pointer-events-none absolute bg-[rgb(8_10_14_/_0.55)]" :style="dimStyles.bottom"></div>
                  <div class="pointer-events-none absolute bg-[rgb(8_10_14_/_0.55)]" :style="dimStyles.left"></div>
                  <div class="pointer-events-none absolute bg-[rgb(8_10_14_/_0.55)]" :style="dimStyles.right"></div>
                  <div class="pointer-events-auto absolute cursor-move border border-accent" :style="[roiBoxStyle, { borderWidth: `${1 / zoom}px` }]" @pointerdown.stop="onBoxDown($event)">
                    <span
                      v-for="handle in handles"
                      :key="handle"
                      class="pointer-events-auto absolute size-2.5 rounded-[2px] border border-[#1a140a] bg-accent"
                      :class="{ 'cursor-nwse-resize': handle === 'nw' || handle === 'se', 'cursor-nesw-resize': handle === 'ne' || handle === 'sw', 'cursor-ns-resize': handle === 'n' || handle === 's', 'cursor-ew-resize': handle === 'e' || handle === 'w' }"
                      :style="handleStyle(handle, zoom)"
                      @pointerdown.stop="onHandleDown(handle, $event)"
                    ></span>
                  </div>
                </template>
              </template>
            </ImageCompareViewer>
          </div>

          <!-- 底部 ROI 实时预览：框选区域原图裁切 + 结果同区域裁切并列 -->
          <div v-if="roiReady" class="flex flex-none gap-4">
            <figure class="m-0 flex min-w-0 flex-1 flex-col gap-2">
              <figcaption class="faint overflow-hidden text-ellipsis whitespace-nowrap text-caption">框选区域 · {{ roiLabel }}</figcaption>
              <div class="flex h-[110px] items-center justify-center overflow-hidden rounded-sm border border-line bg-checker-b p-2 [background-image:linear-gradient(45deg,var(--checker-a)_25%,transparent_25%),linear-gradient(-45deg,var(--checker-a)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--checker-a)_75%),linear-gradient(-45deg,transparent_75%,var(--checker-a)_75%)] [background-position:0_0,0_8px,8px_-8px,-8px_0] [background-size:16px_16px]"><canvas ref="sourceCanvas" class="block h-auto max-h-full w-auto max-w-full" aria-label="框选区域预览"></canvas></div>
            </figure>
            <figure v-if="!editingRoi && resultUrl" class="m-0 flex min-w-0 flex-1 flex-col gap-2">
              <figcaption class="faint overflow-hidden text-ellipsis whitespace-nowrap text-caption">结果同区域</figcaption>
              <div class="flex h-[110px] items-center justify-center overflow-hidden rounded-sm border border-line bg-checker-b p-2 [background-image:linear-gradient(45deg,var(--checker-a)_25%,transparent_25%),linear-gradient(-45deg,var(--checker-a)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--checker-a)_75%),linear-gradient(-45deg,transparent_75%,var(--checker-a)_75%)] [background-position:0_0,0_8px,8px_-8px,-8px_0] [background-size:16px_16px]"><canvas ref="resultCanvas" class="block h-auto max-h-full w-auto max-w-full" aria-label="结果同区域预览"></canvas></div>
            </figure>
          </div>
        </template>

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

    <!-- 右栏：框选区域、修复方式与参数配置 -->
    <section class="panel overflow-auto border-l border-line">
      <div class="section">
        <h2 class="section-title">去水印</h2>
        <label v-if="isFrames && frames.length" class="field">
          <span class="field-label">样板帧</span>
          <select v-model="workspace.watermark.frameId" class="select">
            <option v-for="(frame, index) in frames" :key="frame.id" :value="frame.id">
              #{{ index + 1 }} · {{ frame.timestamp.toFixed(2) }}s
            </option>
          </select>
        </label>
      </div>

      <div class="section [&_.field+.field]:mt-3">
        <h2 class="section-title">框选区域（ROI）</h2>
        <div class="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 [&_.field]:min-w-0 [&_.input]:w-full">
          <label class="field">
            <span class="field-label">X</span>
            <input v-model.number="box.x" class="input" type="number" min="0" step="1" :max="natural.width" @change="normalizeRoiBox" />
          </label>
          <label class="field">
            <span class="field-label">Y</span>
            <input v-model.number="box.y" class="input" type="number" min="0" step="1" :max="natural.height" @change="normalizeRoiBox" />
          </label>
          <label class="field">
            <span class="field-label">宽度</span>
            <input v-model.number="box.width" class="input" type="number" min="1" step="1" :max="natural.width" @change="normalizeRoiBox" />
          </label>
          <label class="field">
            <span class="field-label">高度</span>
            <input v-model.number="box.height" class="input" type="number" min="1" step="1" :max="natural.height" @change="normalizeRoiBox" />
          </label>
        </div>
        <div class="field">
          <span class="field-label">拖拽工具</span>
          <div class="seg">
            <button class="seg-item" :class="{ active: tool === 'move' }" @click="tool = 'move'">调整框选</button>
            <button class="seg-item" :class="{ active: tool === 'draw' }" @click="tool = 'draw'">重新框选</button>
          </div>
        </div>
        <button class="btn w-full justify-center" :disabled="!roiReady || editingRoi" @click="roiEditMode = true">重新框选区域</button>
      </div>

      <div class="section">
        <h2 class="section-title">修复方式</h2>
        <select v-model="workspace.watermark.settings.mode" class="select w-full justify-center">
          <option v-for="item in MODE_OPTIONS" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
        <p class="muted">{{ activeModeHint }}</p>
      </div>

      <div class="section [&_.field+.check-row]:mt-3 [&_.field+.field]:mt-3 [&_p+.field]:mt-3">
        <h2 class="section-title">参数</h2>
        <div v-if="workspace.watermark.settings.mode === 'alpha'" class="field">
          <span class="field-label">水印本色（解算用）</span>
          <div class="field-row">
            <input
              class="h-[28px] w-[42px] flex-none rounded-sm border border-line bg-raised p-0.5"
              type="color"
              :value="workspace.watermark.settings.watermarkColor || '#ffffff'"
              @input="workspace.watermark.settings.watermarkColor = ($event.target as HTMLInputElement).value"
            />
            <span class="mono faint min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{{ workspace.watermark.settings.watermarkColor || '自动估算' }}</span>
            <button class="btn btn-ghost h-[26px] px-2 text-caption" :disabled="!workspace.watermark.settings.watermarkColor" @click="workspace.watermark.settings.watermarkColor = ''">自动</button>
          </div>
        </div>

        <div class="field">
          <span class="field-label">底色</span>
          <div class="field-row">
            <input
              class="h-[28px] w-[42px] flex-none rounded-sm border border-line bg-raised p-0.5"
              type="color"
              :value="workspace.watermark.settings.baseColor || sampledBase || '#000000'"
              @input="workspace.watermark.settings.baseColor = ($event.target as HTMLInputElement).value"
            />
            <span class="mono faint min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{{ sampledBase ? `环带采样 ${sampledBase}` : '待采样' }}</span>
            <button class="btn btn-ghost h-[26px] px-2 text-caption" :disabled="!workspace.watermark.settings.baseColor" @click="workspace.watermark.settings.baseColor = ''">自动</button>
          </div>
        </div>

        <label v-if="usesThreshold" class="field">
          <span class="field-label">色差阈值 {{ workspace.watermark.settings.threshold }}</span>
          <input v-model.number="workspace.watermark.settings.threshold" class="w-full accent-accent" type="range" min="1" max="150" />
        </label>
        <label v-if="usesThreshold" class="check-row">
          <input v-model="workspace.watermark.settings.keepNoise" type="checkbox" /> 保留底色噪点
        </label>

        <label v-if="isTextureMode" class="field">
          <span class="field-label">重建精细度</span>
          <select v-model.number="workspace.watermark.settings.quality" class="select w-full justify-center">
            <option v-for="item in QUALITY_OPTIONS" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>

        <div v-if="degraded" class="warn">水印色与底色过于接近，投影无意义，已自动退化为「按蒙版替换水印像素」。</div>
      </div>

      <div class="section flex flex-col gap-2">
        <button class="btn btn-primary w-full justify-center" :disabled="!roiReady || processing" @click="runWatermark">
          {{ processing ? '处理中…' : '去水印' }}
        </button>
        <template v-if="isFrames">
          <button class="btn w-full justify-center" :disabled="!plan || batch.running || !frames.length" @click="batchApply">应用到全部帧</button>
          <button class="btn w-full justify-center" :disabled="!watermarkedCount || batch.running" @click="restoreFrames">还原全部帧（{{ watermarkedCount }}）</button>
        </template>
        <button class="btn w-full justify-center" :disabled="!resultUrl" @click="downloadResult">下载 PNG</button>
        <button class="btn btn-ghost w-full justify-center" :disabled="batch.running" @click="resetAll">重置去水印</button>
      </div>
    </section>
  </div>
</template>
