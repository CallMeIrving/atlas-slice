<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { workspace, type MatteMode } from '@/store/workspace'
import { downloadZip } from '@/core/media-export'
import { applyColorKey, solidColorKey } from '@/core/color-key'
import { removeWithImgly, removeWithTransformers, segmentWithSam, AI_ENGINES, type MatteProgress } from '@/core/ai-matting'

const input = ref<HTMLInputElement>()
const image = ref<HTMLImageElement>()
const canvasRef = ref<HTMLElement>()
const isDragging = ref(false)
const sampling = ref(false)

// SAM 交互状态
const samDragging = ref(false)
const samStart = ref<{ x: number; y: number } | null>(null)
const samDrag = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
const maskUrl = ref('')
const showMask = ref(false)
const displayRect = ref({ left: 0, top: 0, width: 0, height: 0 })

const modeOptions: { value: MatteMode; label: string }[] = [
  { value: 'auto', label: '自动抠图（边缘色）' },
  { value: 'color', label: '颜色抠图' },
  { value: 'solid', label: '纯色背景抠图' },
  { value: 'imgly', label: 'ISNet（imgly）' },
  { value: 'birefnet', label: 'BiRefNet' },
  { value: 'rmbg', label: 'RMBG-1.4（BRIA）' },
  { value: 'sam', label: 'SAM 框选分割' },
]

const samTools: { value: 'box' | 'fg' | 'bg'; label: string }[] = [
  { value: 'box', label: '框选' },
  { value: 'fg', label: '前景点' },
  { value: 'bg', label: '背景点' },
]

const backgroundOptions: { value: 'checker' | 'white' | 'black' | 'original'; label: string }[] = [
  { value: 'checker', label: '棋盘格' },
  { value: 'white', label: '白底' },
  { value: 'black', label: '黑底' },
  { value: 'original', label: '原图' },
]

function setBackground(value: 'checker' | 'white' | 'black' | 'original'): void {
  workspace.matte.background = value
}

const isAiMode = computed(() => ['imgly', 'birefnet', 'rmbg', 'sam'].includes(workspace.matte.mode))
const runDisabled = computed(() => !workspace.matte.sourceUrl || workspace.matte.status === 'processing' || (workspace.matte.mode === 'sam' && !workspace.matte.samBoxes.length && !workspace.matte.samPoints.length))

const backgroundStyle = computed(() => {
  const background = workspace.matte.background
  if (background === 'checker') return { backgroundImage: 'linear-gradient(45deg, #232734 25%, transparent 25%), linear-gradient(-45deg, #232734 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #232734 75%), linear-gradient(-45deg, transparent 75%, #232734 75%)', backgroundSize: '24px 24px', backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0px' }
  if (background === 'white') return { background: '#fff' }
  if (background === 'black') return { background: '#000' }
  return { background: '#101217' }
})

function setSamTool(tool: 'box' | 'fg' | 'bg'): void {
  workspace.matte.samTool = tool
}

function openFile(): void { input.value?.click() }

function load(file?: File): void {
  if (!file || !file.type.startsWith('image/')) return
  if (workspace.matte.sourceUrl) URL.revokeObjectURL(workspace.matte.sourceUrl)
  workspace.matte.fileName = file.name
  workspace.matte.sourceUrl = URL.createObjectURL(file)
  workspace.matte.resultUrl = ''
  workspace.matte.sampledColor = ''
  workspace.matte.samBoxes = []
  workspace.matte.samPoints = []
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
  maskUrl.value = ''
  showMask.value = false
  workspace.matte.status = 'ready'
  void nextTick(updateDisplayRect)
}

function handleDrop(event: DragEvent): void {
  isDragging.value = false
  load(event.dataTransfer?.files[0])
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('生成图片失败'))), 'image/png')
  })
}

/** 本地颜色类抠图统一入口：solid 走边缘主色采样，color/auto 走基准色 */
async function runColorKey(mode: 'auto' | 'color' | 'solid', img: HTMLImageElement): Promise<{ blob: Blob; baseColor?: string }> {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let baseColor: string | undefined
  if (mode === 'solid') {
    const base = solidColorKey(data, workspace.matte.tolerance)
    baseColor = `#${toHex(base.r)}${toHex(base.g)}${toHex(base.b)}`
    workspace.matte.aiStatus = `基准色 ${baseColor}`
  } else if (mode === 'color') {
    let baseR = data.data[0]
    let baseG = data.data[1]
    let baseB = data.data[2]
    const sampled = workspace.matte.sampledColor.match(/^#([0-9a-f]{6})$/i)
    if (sampled) {
      baseR = Number.parseInt(sampled[1].slice(0, 2), 16)
      baseG = Number.parseInt(sampled[1].slice(2, 4), 16)
      baseB = Number.parseInt(sampled[1].slice(4, 6), 16)
    }
    applyColorKey(data, { r: baseR, g: baseG, b: baseB, tolerance: workspace.matte.tolerance, removeWhite: false })
  } else {
    applyColorKey(data, { r: data.data[0], g: data.data[1], b: data.data[2], tolerance: workspace.matte.tolerance, removeWhite: true })
  }
  ctx.putImageData(data, 0, 0)
  return { blob: await canvasToBlob(canvas), baseColor }
}

async function cropBlob(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve, reject) => {
      const source = new Image()
      source.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = source.naturalWidth
        canvas.height = source.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(source, 0, 0)
        cropAlpha(canvas)
        canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('裁切透明边缘失败'))), 'image/png')
      }
      source.onerror = () => reject(new Error('裁切透明边缘失败'))
      source.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function runMatte(): Promise<void> {
  const img = image.value
  if (!workspace.matte.sourceUrl || !img) return
  workspace.matte.status = 'processing'
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  const onProgress = (progress: MatteProgress): void => {
    workspace.matte.aiStatus = progress.text
    workspace.matte.aiProgress = progress.percent ?? -1
  }
  try {
    const mode = workspace.matte.mode
    let blob: Blob | null = null
    let baseColor: string | undefined
    if (mode === 'color' || mode === 'auto' || mode === 'solid') {
      const result = await runColorKey(mode, img)
      blob = result.blob
      baseColor = result.baseColor
    } else if (mode === 'imgly') {
      const result = await removeWithImgly(img, { model: workspace.matte.imglyModel, device: workspace.matte.aiDevice, maxSide: workspace.matte.aiMaxSide, publicPath: workspace.matte.imglyPublicPath || undefined, onProgress })
      blob = result.blob
    } else if (mode === 'birefnet' || mode === 'rmbg') {
      const result = await removeWithTransformers(img, { modelId: mode === 'birefnet' ? workspace.matte.birefnetModelId : workspace.matte.rmbgModelId, dtype: workspace.matte.aiDtype, device: workspace.matte.aiDevice, modelHost: workspace.matte.aiModelHost, maxSide: workspace.matte.aiMaxSide, onProgress })
      blob = result.blob
    } else if (mode === 'sam') {
      const result = await segmentWithSam(img, { modelId: workspace.matte.samModelId, device: workspace.matte.aiDevice, modelHost: workspace.matte.aiModelHost, boxes: workspace.matte.samBoxes, points: workspace.matte.samPoints, maxSide: workspace.matte.aiMaxSide, onProgress })
      blob = result.blob
      if (result.maskBlob) {
        if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
        maskUrl.value = URL.createObjectURL(result.maskBlob)
        showMask.value = true
      }
    }
    if (!blob) throw new Error('未生成结果')
    const resultBlob = workspace.matte.cropTransparent ? await cropBlob(blob) : blob
    if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
    workspace.matte.resultUrl = URL.createObjectURL(resultBlob)
    workspace.matte.status = 'done'
    workspace.matte.aiStatus = baseColor ? `完成 · 基准色 ${baseColor}` : '完成'
  } catch (error) {
    workspace.matte.status = 'error'
    workspace.matte.aiStatus = error instanceof Error ? error.message : '处理失败'
  } finally {
    workspace.matte.aiProgress = -1
  }
}

function sampleColor(event: MouseEvent): void {
  if (!sampling.value || !image.value) return
  const source = new Image()
  source.onload = () => {
    const bounds = image.value!.getBoundingClientRect()
    const x = Math.max(0, Math.min(source.naturalWidth - 1, Math.floor((event.clientX - bounds.left) / bounds.width * source.naturalWidth)))
    const y = Math.max(0, Math.min(source.naturalHeight - 1, Math.floor((event.clientY - bounds.top) / bounds.height * source.naturalHeight)))
    const canvas = document.createElement('canvas'); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight
    const ctx = canvas.getContext('2d')!; ctx.drawImage(source, 0, 0)
    const pixel = ctx.getImageData(x, y, 1, 1).data
    workspace.matte.sampledColor = `#${[pixel[0], pixel[1], pixel[2]].map(toHex).join('')}`
    sampling.value = false
  }
  source.src = workspace.matte.sourceUrl
}

function cropAlpha(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!; const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) if (pixels[(y * canvas.width + x) * 4 + 3] > 10) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  if (maxX < minX) return
  const trimmed = document.createElement('canvas'); trimmed.width = maxX - minX + 1; trimmed.height = maxY - minY + 1
  trimmed.getContext('2d')!.drawImage(canvas, minX, minY, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height)
  canvas.width = trimmed.width; canvas.height = trimmed.height; canvas.getContext('2d')!.drawImage(trimmed, 0, 0)
}

function download(): void {
  if (!workspace.matte.resultUrl) return
  const link = document.createElement('a'); link.href = workspace.matte.resultUrl; link.download = `${workspace.matte.fileName.replace(/\.[^.]+$/, '')}-cutout.png`; link.click()
}

function resetMatte(): void {
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
  workspace.matte.resultUrl = ''
  maskUrl.value = ''
  showMask.value = false
  workspace.matte.mode = 'auto'
  workspace.matte.tolerance = 24
  workspace.matte.cropTransparent = true
  workspace.matte.sampledColor = ''
  workspace.matte.samBoxes = []
  workspace.matte.samPoints = []
  workspace.matte.aiStatus = ''
  workspace.matte.aiProgress = -1
  sampling.value = false
  workspace.matte.status = workspace.matte.sourceUrl ? 'ready' : 'empty'
}

async function exportPackage(): Promise<void> {
  if (!workspace.matte.resultUrl) return
  const response = await fetch(workspace.matte.resultUrl); const blob = await response.blob()
  const mode = workspace.matte.mode
  const config: Record<string, unknown> = { mode, cropTransparent: workspace.matte.cropTransparent }
  if (mode === 'color' || mode === 'auto' || mode === 'solid') config.tolerance = workspace.matte.tolerance
  if (mode === 'color') config.sampledColor = workspace.matte.sampledColor
  if (mode === 'imgly') { config.engine = 'imgly'; config.model = workspace.matte.imglyModel; config.publicPath = workspace.matte.imglyPublicPath || undefined }
  if (mode === 'birefnet' || mode === 'rmbg') { config.engine = mode; config.modelId = mode === 'birefnet' ? workspace.matte.birefnetModelId : workspace.matte.rmbgModelId; config.dtype = workspace.matte.aiDtype }
  if (mode === 'sam') { config.engine = 'sam'; config.modelId = workspace.matte.samModelId; config.boxes = workspace.matte.samBoxes; config.points = workspace.matte.samPoints }
  if (['imgly', 'birefnet', 'rmbg', 'sam'].includes(mode)) { config.device = workspace.matte.aiDevice; config.maxSide = workspace.matte.aiMaxSide; config.modelHost = workspace.matte.aiModelHost }
  await downloadZip([{ name: `${workspace.matte.fileName.replace(/\.[^.]+$/, '')}-cutout.png`, blob }, { name: 'config.json', blob: JSON.stringify(config, null, 2) }], `${workspace.matte.fileName.replace(/\.[^.]+$/, '')}-cutout.zip`)
}

// ---- SAM 框选交互 ----

function updateDisplayRect(): void {
  const img = image.value
  const canvasEl = canvasRef.value
  if (!img || !canvasEl) return
  const ib = img.getBoundingClientRect()
  const cb = canvasEl.getBoundingClientRect()
  displayRect.value = { left: ib.left - cb.left, top: ib.top - cb.top, width: ib.width, height: ib.height }
}

function naturalFromEvent(event: MouseEvent): { x: number; y: number } | null {
  const img = image.value
  if (!img) return null
  const bounds = img.getBoundingClientRect()
  const x = Math.round(((event.clientX - bounds.left) / bounds.width) * img.naturalWidth)
  const y = Math.round(((event.clientY - bounds.top) / bounds.height) * img.naturalHeight)
  if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null
  return { x, y }
}

function onSamDown(event: MouseEvent): void {
  if (workspace.matte.mode !== 'sam') return
  const pos = naturalFromEvent(event)
  if (!pos) return
  if (workspace.matte.samTool === 'box') {
    samStart.value = pos
    samDragging.value = true
  } else {
    workspace.matte.samPoints.push({ x: pos.x, y: pos.y, label: workspace.matte.samTool === 'fg' ? 1 : 0 })
  }
}

function onSamMove(event: MouseEvent): void {
  if (!samDragging.value || !samStart.value) return
  const pos = naturalFromEvent(event)
  if (!pos) return
  samDrag.value = {
    x1: Math.min(samStart.value.x, pos.x),
    y1: Math.min(samStart.value.y, pos.y),
    x2: Math.max(samStart.value.x, pos.x),
    y2: Math.max(samStart.value.y, pos.y),
  }
}

function onSamUp(): void {
  if (!samDragging.value) return
  const drag = samDrag.value
  if (drag && (drag.x2 > drag.x1 || drag.y2 > drag.y1)) workspace.matte.samBoxes.push(drag)
  samDragging.value = false
  samStart.value = null
  samDrag.value = null
}

function clearSam(): void {
  workspace.matte.samBoxes = []
  workspace.matte.samPoints = []
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
  maskUrl.value = ''
  showMask.value = false
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  workspace.matte.resultUrl = ''
  workspace.matte.status = workspace.matte.sourceUrl ? 'ready' : 'empty'
}

function boxStyle(box: { x1: number; y1: number; x2: number; y2: number }): Record<string, string> {
  const img = image.value
  if (!img || !displayRect.value.width) return {}
  const sx = displayRect.value.width / img.naturalWidth
  const sy = displayRect.value.height / img.naturalHeight
  return { left: `${box.x1 * sx}px`, top: `${box.y1 * sy}px`, width: `${(box.x2 - box.x1) * sx}px`, height: `${(box.y2 - box.y1) * sy}px` }
}

function pointStyle(point: { x: number; y: number }): Record<string, string> {
  const img = image.value
  if (!img || !displayRect.value.width) return {}
  return { left: `${(point.x / img.naturalWidth) * displayRect.value.width}px`, top: `${(point.y / img.naturalHeight) * displayRect.value.height}px` }
}

function onWindowResize(): void {
  updateDisplayRect()
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value)
})
</script>

<template>
  <div class="tool-page">
    <section class="tool-sidebar panel">
      <div class="section"><h2 class="section-title">抠图工具</h2><p class="muted">本地处理，不上传素材</p></div>
      <div class="section">
        <button class="btn btn-primary full" @click="openFile">导入图片</button>
        <input ref="input" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="load(($event.target as HTMLInputElement).files?.[0])" />
      </div>
      <div class="section">
        <h2 class="section-title">处理方式</h2>
        <select v-model="workspace.matte.mode" class="select full">
          <option v-for="option in modeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <template v-if="workspace.matte.mode === 'color'">
          <button class="btn full" :class="{ 'btn-primary': sampling }" @click="sampling = !sampling">{{ sampling ? '请点击图片取色' : '吸取背景颜色' }}</button>
          <div v-if="workspace.matte.sampledColor" class="sampled-color"><span class="color-chip" :style="{ background: workspace.matte.sampledColor }"></span><span>已取色 {{ workspace.matte.sampledColor }}</span><button class="btn-icon" title="清除取色" @click="workspace.matte.sampledColor = ''">×</button></div>
        </template>
        <template v-if="workspace.matte.mode === 'color' || workspace.matte.mode === 'solid'">
          <label class="field"><span class="field-label">颜色容差 {{ workspace.matte.tolerance }}</span><input v-model.number="workspace.matte.tolerance" class="range" type="range" min="1" max="100" /></label>
          <p v-if="workspace.matte.mode === 'solid'" class="muted">自动采样图像边缘主色作为背景基准，适合纯色背景</p>
        </template>
        <template v-if="isAiMode && workspace.matte.mode !== 'sam'">
          <div v-if="workspace.matte.mode === 'rmbg'" class="warn">⚠️ RMBG 仅供评估，不可商用</div>
          <label v-if="workspace.matte.mode === 'imgly'" class="field"><span class="field-label">模型</span>
            <select v-model="workspace.matte.imglyModel" class="select">
              <option value="isnet_fp16">ISNet FP16（推荐）</option>
              <option value="isnet">ISNet 原版</option>
              <option value="isnet_quint8">ISNet 量化（最快）</option>
            </select>
          </label>
          <label v-if="workspace.matte.mode === 'imgly'" class="field"><span class="field-label">资源地址（publicPath）</span><input v-model="workspace.matte.imglyPublicPath" class="input" type="text" placeholder="留空使用官方 CDN" /></label>
          <template v-if="workspace.matte.mode === 'birefnet' || workspace.matte.mode === 'rmbg'">
            <label class="field"><span class="field-label">模型 ID</span>
              <input v-if="workspace.matte.mode === 'birefnet'" v-model="workspace.matte.birefnetModelId" class="input" type="text" />
              <input v-else v-model="workspace.matte.rmbgModelId" class="input" type="text" />
            </label>
            <label class="field"><span class="field-label">精度</span>
              <select v-model="workspace.matte.aiDtype" class="select" title="FP32 高精度最吃内存；FP16 减半更轻量（BiRefNet 支持）；Q8 量化最快（仅 RMBG/SAM 提供量化文件）">
                <option value="fp32">FP32 高精度（兼容所有模型，最吃内存）</option>
                <option value="fp16">FP16 半精度（体积减半、内存友好）</option>
                <option value="q8">Q8 量化（快、体积小，RMBG/SAM 可用）</option>
              </select>
            </label>
          </template>
          <label class="field"><span class="field-label">模型源</span>
            <select v-model="workspace.matte.aiModelHost" class="select">
              <option value="huggingface.co">HuggingFace（默认）</option>
              <option value="hf-mirror.com">国内镜像 hf-mirror.com</option>
            </select>
          </label>
          <label class="field"><span class="field-label">运行设备</span>
            <select v-model="workspace.matte.aiDevice" class="select">
              <option value="cpu">CPU（WASM，通用）</option>
              <option value="gpu">GPU（WebGPU，需浏览器支持）</option>
            </select>
          </label>
          <label class="field"><span class="field-label">最大边长</span>
            <select v-model.number="workspace.matte.aiMaxSide" class="select">
              <option :value="0">原图尺寸</option>
              <option :value="1024">1024px</option>
              <option :value="768">768px</option>
              <option :value="512">512px（最快）</option>
            </select>
          </label>
        </template>
        <template v-if="workspace.matte.mode === 'sam'">
          <div class="seg">
            <button v-for="tool in samTools" :key="tool.value" class="seg-item" :class="{ active: workspace.matte.samTool === tool.value }" @click="setSamTool(tool.value)">{{ tool.label }}</button>
          </div>
          <p class="muted">框选多个区域可一起分割；前景点=保留，背景点=排除</p>
          <div class="model-row"><span>已框选 {{ workspace.matte.samBoxes.length }} 区域</span><span class="badge badge-accent">{{ workspace.matte.samPoints.length }} 提示点</span></div>
          <button class="btn full" @click="clearSam">清除标注</button>
          <label class="check-row"><input v-model="showMask" type="checkbox" /> 显示分割蒙版</label>
          <img v-if="showMask && maskUrl" class="mask-thumb" :src="maskUrl" alt="分割蒙版" />
          <label class="field"><span class="field-label">模型 ID</span><input v-model="workspace.matte.samModelId" class="input" type="text" /></label>
          <label class="field"><span class="field-label">模型源</span>
            <select v-model="workspace.matte.aiModelHost" class="select">
              <option value="huggingface.co">HuggingFace（默认）</option>
              <option value="hf-mirror.com">国内镜像 hf-mirror.com</option>
            </select>
          </label>
          <label class="field"><span class="field-label">运行设备</span>
            <select v-model="workspace.matte.aiDevice" class="select">
              <option value="cpu">CPU（WASM，通用）</option>
              <option value="gpu">GPU（WebGPU，需浏览器支持）</option>
            </select>
          </label>
          <label class="field"><span class="field-label">最大边长</span>
            <select v-model.number="workspace.matte.aiMaxSide" class="select">
              <option :value="0">原图尺寸</option>
              <option :value="1024">1024px</option>
              <option :value="768">768px</option>
              <option :value="512">512px（最快）</option>
            </select>
          </label>
        </template>
        <label class="check-row"><input v-model="workspace.matte.cropTransparent" type="checkbox" /> 自动裁切透明边缘</label>
      </div>
      <div class="section">
        <h2 class="section-title">模型状态</h2>
        <div v-for="engine in AI_ENGINES" :key="engine.key" class="model-row">
          <span :title="engine.description">{{ engine.label }} <span class="muted">{{ engine.size }}</span></span>
          <span class="badge" :class="{ 'badge-accent': workspace.matte.mode === engine.key }">{{ workspace.matte.mode === engine.key ? '使用中' : engine.license }}</span>
        </div>
        <div v-if="workspace.matte.aiStatus" class="ai-status">
          <p class="muted">{{ workspace.matte.aiStatus }}</p>
          <div v-if="workspace.matte.aiProgress >= 0" class="progress-track"><div class="progress-fill" :style="{ width: workspace.matte.aiProgress + '%' }"></div></div>
        </div>
      </div>
      <div class="section actions">
        <button class="btn btn-primary full" :disabled="runDisabled" @click="runMatte">{{ workspace.matte.status === 'processing' ? '处理中…' : (workspace.matte.mode === 'sam' ? '开始分割' : '开始抠图') }}</button>
        <button class="btn full" :disabled="!workspace.matte.resultUrl" @click="download">导出透明 PNG</button>
        <button class="btn full" :disabled="!workspace.matte.resultUrl" @click="exportPackage">导出 PNG + 配置 ZIP</button>
        <button class="btn btn-ghost full" :disabled="!workspace.matte.sourceUrl || workspace.matte.status === 'processing'" @click="resetMatte">重置抠图</button>
      </div>
    </section>
    <main class="tool-main">
      <div class="tool-header"><div><h2>抠图工作区</h2><p>{{ workspace.matte.fileName || '导入一张图片开始处理' }}</p></div><div class="seg"><button v-for="item in backgroundOptions" :key="item.value" class="seg-item" :class="{ active: workspace.matte.background === item.value }" @click="setBackground(item.value)">{{ item.label }}</button></div></div>
      <div ref="canvasRef" class="matte-canvas" :class="{ dragging: isDragging }" :style="backgroundStyle" @dragover.prevent="isDragging = true" @dragleave="isDragging = false" @drop="handleDrop">
        <div v-if="!workspace.matte.sourceUrl" class="drop-hint" @click="openFile"><span class="big">＋</span><strong>拖入图片</strong><span>PNG / JPG / WebP</span></div>
        <template v-else>
          <img ref="image" :class="{ sampling }" :src="workspace.matte.resultUrl || workspace.matte.sourceUrl" alt="预览" @click="sampleColor" @load="updateDisplayRect" />
          <div v-if="workspace.matte.mode === 'sam'" class="sam-overlay" :class="'tool-' + workspace.matte.samTool" :style="{ left: displayRect.left + 'px', top: displayRect.top + 'px', width: displayRect.width + 'px', height: displayRect.height + 'px' }" @mousedown="onSamDown" @mousemove="onSamMove" @mouseup="onSamUp" @mouseleave="onSamUp">
            <div v-for="(box, index) in workspace.matte.samBoxes" :key="'b' + index" class="sam-box" :style="boxStyle(box)"></div>
            <div v-if="samDrag" class="sam-box sam-drag" :style="boxStyle(samDrag)"></div>
            <span v-for="(point, index) in workspace.matte.samPoints" :key="'p' + index" class="sam-point" :class="point.label === 1 ? 'fg' : 'bg'" :style="pointStyle(point)"></span>
          </div>
        </template>
      </div>
    </main>
  </div>
</template>

<style scoped>
.tool-page { display: grid; grid-template-columns: 280px minmax(0, 1fr); height: 100%; min-height: 0; }
.tool-sidebar { border-right: 1px solid var(--border); overflow: auto; }
.tool-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tool-header { height: 64px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; border-bottom: 1px solid var(--border); }
.tool-header h2 { margin: 0; font-size: 16px; }.tool-header p { margin: 2px 0 0; color: var(--text-faint); }
.matte-canvas { flex: 1; min-height: 0; margin: 24px; display: grid; place-items: center; border: 1px solid var(--border); overflow: hidden; position: relative; }.matte-canvas.dragging { border-color: var(--accent); }.matte-canvas img { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: auto; }
.drop-hint { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--text-faint); cursor: pointer; }.drop-hint .big { font-size: 36px; color: var(--accent); }.drop-hint strong { color: var(--text); }
.full { width: 100%; justify-content: center; }.model-row { display: flex; align-items: center; gap: 8px; min-height: 32px; color: var(--text-muted); justify-content: space-between; }.range { width: 100%; accent-color: var(--accent); }.actions { display: flex; flex-direction: column; gap: 8px; }
.sampling { cursor: crosshair; }.sampled-color { display:flex; align-items:center; gap:8px; color:var(--text-muted); font:12px var(--font-mono); }.color-chip { width:18px; height:18px; border:1px solid var(--border-strong); border-radius:3px; }.btn-icon { margin-left:auto; color:var(--text-faint); }
.warn { padding: 8px 10px; border: 1px solid #b45309; color: #fbbf24; background: rgba(251, 191, 36, 0.08); border-radius: 6px; font-size: 12px; margin-bottom: 8px; }
.select { width: 100%; }
.ai-status { margin-top: 8px; }.ai-status p { margin: 0 0 4px; font-size: 12px; word-break: break-all; }
.progress-track { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }.progress-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
.sam-overlay { position: absolute; z-index: 2; touch-action: none; }.sam-overlay.tool-box { cursor: crosshair; }.sam-overlay.tool-fg { cursor: pointer; }.sam-overlay.tool-bg { cursor: cell; }
.sam-box { position: absolute; border: 1.5px solid var(--accent); background: rgba(102, 192, 255, 0.15); box-sizing: border-box; }.sam-drag { border-style: dashed; }
.sam-point { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 2px rgba(0, 0, 0, 0.6); }.sam-point.fg { background: #4ade80; }.sam-point.bg { background: #f87171; }
.mask-thumb { width: 100%; border: 1px solid var(--border-strong); border-radius: 6px; margin-top: 8px; }
</style>
