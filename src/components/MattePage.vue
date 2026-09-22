<script setup lang="ts">
import { computed, ref } from 'vue'
import { workspace } from '@/store/workspace'
import { downloadZip } from '@/core/media-export'

const input = ref<HTMLInputElement>()
const image = ref<HTMLImageElement>()
const isDragging = ref(false)
const sampling = ref(false)

const backgroundStyle = computed(() => {
  const background = workspace.matte.background
  if (background === 'checker') return { backgroundImage: 'linear-gradient(45deg, #232734 25%, transparent 25%), linear-gradient(-45deg, #232734 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #232734 75%), linear-gradient(-45deg, transparent 75%, #232734 75%)', backgroundSize: '24px 24px', backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0px' }
  if (background === 'white') return { background: '#fff' }
  if (background === 'black') return { background: '#000' }
  return { background: '#101217' }
})

function openFile(): void { input.value?.click() }

function load(file?: File): void {
  if (!file || !file.type.startsWith('image/')) return
  if (workspace.matte.sourceUrl) URL.revokeObjectURL(workspace.matte.sourceUrl)
  workspace.matte.fileName = file.name
  workspace.matte.sourceUrl = URL.createObjectURL(file)
  workspace.matte.resultUrl = ''
  workspace.matte.sampledColor = ''
  workspace.matte.status = 'ready'
}

function handleDrop(event: DragEvent): void {
  isDragging.value = false
  load(event.dataTransfer?.files[0])
}

function runMatte(): void {
  if (!workspace.matte.sourceUrl) return
  workspace.matte.status = 'processing'
  window.setTimeout(() => {
    // MVP：浏览器原生本地处理先提供可用的颜色抠图；模型适配层后续接入。
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const img = image.value
    if (!img) { workspace.matte.status = 'error'; return }
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    if (workspace.matte.mode === 'color' || workspace.matte.mode === 'auto') {
      const threshold = workspace.matte.tolerance
      const sampled = workspace.matte.sampledColor.match(/^#([0-9a-f]{6})$/i)
      const baseR = sampled ? Number.parseInt(sampled[1].slice(0, 2), 16) : data.data[0]
      const baseG = sampled ? Number.parseInt(sampled[1].slice(2, 4), 16) : data.data[1]
      const baseB = sampled ? Number.parseInt(sampled[1].slice(4, 6), 16) : data.data[2]
      for (let i = 0; i < data.data.length; i += 4) {
        const matchesWhite = data.data[i] > 255 - threshold && data.data[i + 1] > 255 - threshold && data.data[i + 2] > 255 - threshold
        const distance = Math.abs(data.data[i] - baseR) + Math.abs(data.data[i + 1] - baseG) + Math.abs(data.data[i + 2] - baseB)
        if (workspace.matte.mode === 'color' ? matchesWhite : distance < threshold * 3) data.data[i + 3] = 0
      }
      ctx.putImageData(data, 0, 0)
    }
    if (workspace.matte.cropTransparent) cropAlpha(canvas)
    canvas.toBlob((blob) => {
      if (!blob) { workspace.matte.status = 'error'; return }
      if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
      workspace.matte.resultUrl = URL.createObjectURL(blob)
      workspace.matte.status = 'done'
    }, 'image/png')
  }, 180)
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
    workspace.matte.sampledColor = `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`
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
  workspace.matte.resultUrl = ''
  workspace.matte.mode = 'auto'
  workspace.matte.tolerance = 24
  workspace.matte.cropTransparent = true
  workspace.matte.sampledColor = ''
  sampling.value = false
  workspace.matte.status = workspace.matte.sourceUrl ? 'ready' : 'empty'
}

async function exportPackage(): Promise<void> {
  if (!workspace.matte.resultUrl) return
  const response = await fetch(workspace.matte.resultUrl); const blob = await response.blob()
  await downloadZip([{ name: `${workspace.matte.fileName.replace(/\.[^.]+$/, '')}-cutout.png`, blob }, { name: 'config.json', blob: JSON.stringify({ mode: workspace.matte.mode, tolerance: workspace.matte.tolerance, cropTransparent: workspace.matte.cropTransparent }, null, 2) }], `${workspace.matte.fileName.replace(/\.[^.]+$/, '')}-cutout.zip`)
}
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
        <label class="radio-row"><input v-model="workspace.matte.mode" value="auto" type="radio" /> 自动抠图 <span class="badge badge-accent">边缘颜色</span></label>
        <label class="radio-row"><input v-model="workspace.matte.mode" value="color" type="radio" /> 颜色抠图</label>
        <label class="radio-row"><input v-model="workspace.matte.mode" value="manual" type="radio" /> 手动修正 <span class="badge">即将支持</span></label>
        <template v-if="workspace.matte.mode === 'color'">
          <button class="btn full" :class="{ 'btn-primary': sampling }" @click="sampling = !sampling">{{ sampling ? '请点击图片取色' : '吸取背景颜色' }}</button>
          <div v-if="workspace.matte.sampledColor" class="sampled-color"><span class="color-chip" :style="{ background: workspace.matte.sampledColor }"></span><span>已取色 {{ workspace.matte.sampledColor }}</span><button class="btn-icon" title="清除取色" @click="workspace.matte.sampledColor = ''">×</button></div>
          <label class="field"><span class="field-label">颜色容差 {{ workspace.matte.tolerance }}</span><input v-model.number="workspace.matte.tolerance" class="range" type="range" min="1" max="100" /></label>
        </template>
        <label class="check-row"><input v-model="workspace.matte.cropTransparent" type="checkbox" /> 自动裁切透明边缘</label>
      </div>
      <div class="section"><h2 class="section-title">模型状态</h2><div class="model-row"><span>BiRefNet</span><span class="badge">待接入</span></div><div class="model-row"><span>颜色抠图</span><span class="badge badge-accent">可用</span></div></div>
      <div class="section actions"><button class="btn btn-primary full" :disabled="!workspace.matte.sourceUrl || workspace.matte.status === 'processing'" @click="runMatte">{{ workspace.matte.status === 'processing' ? '处理中…' : '开始抠图' }}</button><button class="btn full" :disabled="!workspace.matte.resultUrl" @click="download">导出透明 PNG</button><button class="btn full" :disabled="!workspace.matte.resultUrl" @click="exportPackage">导出 PNG + 配置 ZIP</button><button class="btn btn-ghost full" :disabled="!workspace.matte.sourceUrl || workspace.matte.status === 'processing'" @click="resetMatte">重置抠图</button></div>
    </section>
    <main class="tool-main">
      <div class="tool-header"><div><h2>抠图工作区</h2><p>{{ workspace.matte.fileName || '导入一张图片开始处理' }}</p></div><div class="seg"><button v-for="item in [['checker','棋盘格'],['white','白底'],['black','黑底'],['original','原图']]" :key="item[0]" class="seg-item" :class="{ active: workspace.matte.background === item[0] }" @click="workspace.matte.background = item[0] as typeof workspace.matte.background">{{ item[1] }}</button></div></div>
      <div class="matte-canvas" :class="{ dragging: isDragging }" :style="backgroundStyle" @dragover.prevent="isDragging = true" @dragleave="isDragging = false" @drop.prevent="handleDrop">
        <div v-if="!workspace.matte.sourceUrl" class="drop-hint" @click="openFile"><span class="big">＋</span><strong>拖入图片</strong><span>PNG / JPG / WebP</span></div>
        <img v-else ref="image" :class="{ sampling }" :src="workspace.matte.resultUrl || workspace.matte.sourceUrl" alt="预览" @click="sampleColor" />
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
.matte-canvas { flex: 1; min-height: 0; margin: 24px; display: grid; place-items: center; border: 1px solid var(--border); overflow: hidden; }.matte-canvas.dragging { border-color: var(--accent); }.matte-canvas img { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: auto; }
.drop-hint { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--text-faint); cursor: pointer; }.drop-hint .big { font-size: 36px; color: var(--accent); }.drop-hint strong { color: var(--text); }
.full { width: 100%; justify-content: center; }.radio-row, .model-row { display: flex; align-items: center; gap: 8px; min-height: 32px; color: var(--text-muted); }.model-row { justify-content: space-between; }.range { width: 100%; accent-color: var(--accent); }.actions { display: flex; flex-direction: column; gap: 8px; }
.sampling { cursor: crosshair; }.sampled-color { display:flex; align-items:center; gap:8px; color:var(--text-muted); font:12px var(--font-mono); }.color-chip { width:18px; height:18px; border:1px solid var(--border-strong); border-radius:3px; }.btn-icon { margin-left:auto; color:var(--text-faint); }
</style>
