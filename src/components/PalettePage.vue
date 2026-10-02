<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { colorMatchWindows } from '@/core/color-key'
import {
  TEAM_COLOR_PRESETS,
  buildPaletteMeta,
  createVariantId,
  extractPaletteSlots,
  normalizeHex,
  paletteFileName,
  remapImageData,
  renderPaletteVariant,
  type PalettePreset,
  type PaletteSlot,
  type PaletteVariant,
} from '@/core/palette'
import { imageToImageData, loadImage, releaseCanvas } from '@/core/image'
import { downloadZip } from '@/core/media-export'
import { resetPalette, workspace } from '@/store/workspace'

/**
 * 调色板换色（Team Color / 皮肤系统）页。
 * 导入一张精灵图 → 提取主色板为可编辑色槽 → 给色槽指定目标色 →
 * 维护多套变体并批量导出 PNG + 映射元数据。
 */

const state = computed(() => workspace.palette)
const hasSource = computed(() => Boolean(state.value.sourceUrl && state.value.image))
const baseName = computed(() => state.value.fileName.replace(/\.[^.]+$/, '') || 'sprite')
const slots = computed(() => state.value.slots)
const variants = computed(() => state.value.variants)

/** 当前编辑的变体：色槽目标色直接写入它的映射 */
const activeVariant = computed<PaletteVariant | null>(
  () => variants.value.find((item) => item.id === state.value.activeVariantId) ?? variants.value[0] ?? null,
)

/** 源图像素缓存：一次解码，色板提取与所有变体渲染共用 */
let sourcePixels: ImageData | null = null
/** 缩略图像素缓存（缩小版），用于变体列表的实时小图 */
let thumbPixels: ImageData | null = null

/** 当前变体的全尺寸预览结果 dataURL */
const previewUrl = ref('')
/** 变体 id → 缩略图 dataURL */
const thumbs = ref<Record<string, string>>({})
const exporting = ref(false)
const samplingSlotId = ref('')
/** 取色模式下点击原图，写入该色槽的目标色 */
const pickTarget = ref(false)

const imgRef = ref<HTMLImageElement>()
const input = ref<HTMLInputElement>()

/** 容差对应的匹配窗口，用于在界面上说明「换色会覆盖多大范围」 */
const windowHint = computed(() => {
  const { hue, sat } = colorMatchWindows(state.value.tolerance)
  return `色相 ±${Math.round(hue)}° · 饱和度 ±${(sat * 100).toFixed(0)}%`
})

/** 参与预设换色的阵营色槽数量 */
const teamSlotCount = computed(() => slots.value.filter((slot) => slot.enabled && slot.team).length)

/** 已改色的色槽数量（用于提示当前变体是否已生效） */
const changedCount = computed(() => {
  const variant = activeVariant.value
  if (!variant) return 0
  return slots.value.filter((slot) => {
    const target = variant.mapping[slot.id]
    return slot.enabled && target && target.toLowerCase() !== slot.source.toLowerCase()
  }).length
})

/** 导入图片：校验 → 解码 → 缓存像素 → 自动提取一次主色板 */
async function load(file?: File): Promise<void> {
  if (!file) return
  if (file.size > 10 * 1024 * 1024) {
    state.value.error = '图片超过 10MB 限制'
    state.value.status = 'error'
    return
  }
  resetPalette()
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url, '图片加载失败')
    sourcePixels = imageToImageData(image)
    thumbPixels = await downscalePixels(image, 200)
    Object.assign(state.value, {
      fileName: file.name,
      sourceUrl: url,
      image: { width: image.naturalWidth, height: image.naturalHeight },
      error: '',
      status: 'ready',
    })
    await extract()
  } catch (error) {
    URL.revokeObjectURL(url)
    state.value.error = error instanceof Error ? error.message : '图片加载失败'
    state.value.status = 'error'
  } finally {
    if (input.value) input.value.value = ''
  }
}

/** 把源图缩小到 maxSide 以内并取出像素（变体缩略图用，避免逐套变体做全尺寸运算） */
async function downscalePixels(image: HTMLImageElement, maxSide: number): Promise<ImageData> {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height)
  releaseCanvas(canvas)
  return data
}

function onFileChange(e: Event): void {
  const target = e.target as HTMLInputElement
  void load(target.files?.[0])
  target.value = ''
}

/** 提取主色板：重建色槽并把所有变体的映射重置为「保持原色」 */
async function extract(): Promise<void> {
  if (!sourcePixels || !state.value.sourceUrl) return
  state.value.status = 'processing'
  state.value.error = ''
  try {
    const next = await extractPaletteSlots(state.value.sourceUrl, {
      maxSlots: state.value.maxSlots,
      tolerance: state.value.tolerance,
      includeNeutrals: state.value.includeNeutrals,
    })
    if (!next.length) {
      state.value.error = '未提取到有效主色板，可尝试提高容差'
      state.value.status = 'error'
      return
    }
    state.value.slots = next
    state.value.variants = [createVariant('原色', next)]
    state.value.activeVariantId = state.value.variants[0].id
    state.value.status = 'ready'
    await renderAll()
  } catch (error) {
    state.value.error = error instanceof Error ? error.message : '主色板提取失败'
    state.value.status = 'error'
  }
}

/** 新建一个「保持原色」的变体 */
function createVariant(name: string, slotList: PaletteSlot[]): PaletteVariant {
  const mapping: Record<string, string> = {}
  slotList.forEach((slot) => { mapping[slot.id] = slot.source })
  return { id: createVariantId(), name, mapping }
}

/** 添加变体：复制当前变体的映射，便于在其基础上微调 */
function addVariant(): void {
  const current = activeVariant.value
  const mapping: Record<string, string> = {}
  slots.value.forEach((slot) => { mapping[slot.id] = current?.mapping[slot.id] ?? slot.source })
  const variant: PaletteVariant = {
    id: createVariantId(),
    name: `变体${variants.value.length + 1}`,
    mapping,
  }
  state.value.variants.push(variant)
  state.value.activeVariantId = variant.id
}

/** 删除变体（至少保留一套） */
function removeVariant(id: string): void {
  const index = variants.value.findIndex((item) => item.id === id)
  if (index < 0 || variants.value.length <= 1) return
  variants.value.splice(index, 1)
  delete thumbs.value[id]
  if (state.value.activeVariantId === id) state.value.activeVariantId = variants.value[0]?.id ?? ''
}

/** 把阵营色预设写入指定变体：只写入标记为阵营色的启用槽，按顺序循环取预设色 */
function applyPresetTo(variant: PaletteVariant, preset: PalettePreset): void {
  const targets = slots.value.filter((slot) => slot.enabled && slot.team)
  if (!targets.length) return
  preset.colors.forEach((color, index) => {
    const slot = targets[index % targets.length]
    if (slot) variant.mapping[slot.id] = color
  })
}

/** 把预设应用到当前变体 */
function applyPreset(preset: PalettePreset): void {
  const variant = activeVariant.value
  if (!variant) return
  applyPresetTo(variant, preset)
}

/** 一次生成全部阵营色变体（Team Color 批量出图） */
function generateTeamVariants(): void {
  if (!slots.value.length) return
  const generated = TEAM_COLOR_PRESETS.map((preset) => {
    const variant = createVariant(preset.label, slots.value)
    applyPresetTo(variant, preset)
    return variant
  })
  state.value.variants = [createVariant('原色', slots.value), ...generated]
  state.value.activeVariantId = generated[0].id
  void renderAll()
}

/** 色槽开关 */
function toggleSlot(slot: PaletteSlot, e: Event): void {
  slot.enabled = (e.target as HTMLInputElement).checked
}

/** 阵营色标记开关：决定该槽是否会被阵营色预设写入目标色 */
function toggleTeam(slot: PaletteSlot, e: Event): void {
  slot.team = (e.target as HTMLInputElement).checked
}

/** 色槽目标色输入（color picker 与十六进制文本框共用，非法值回落到原色） */
function onSlotHexInput(slot: PaletteSlot, e: Event): void {
  const variant = activeVariant.value
  if (!variant) return
  const hex = normalizeHex((e.target as HTMLInputElement).value)
  variant.mapping[slot.id] = hex ?? slot.source
}

/** 变体重命名 */
function onVariantRename(variant: PaletteVariant, e: Event): void {
  const name = (e.target as HTMLInputElement).value.trim()
  if (name) variant.name = name
}

/** 取色模式：点击原图把该点颜色写入指定色槽的目标色 */
function startPick(slot: PaletteSlot): void {
  samplingSlotId.value = slot.id
  pickTarget.value = true
}

/** 在原图上采样颜色 */
function onStageClick(e: MouseEvent): void {
  if (!pickTarget.value || !samplingSlotId.value || !sourcePixels) return
  const element = imgRef.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * sourcePixels.width)
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * sourcePixels.height)
  const clampedX = Math.max(0, Math.min(sourcePixels.width - 1, x))
  const clampedY = Math.max(0, Math.min(sourcePixels.height - 1, y))
  const offset = (clampedY * sourcePixels.width + clampedX) * 4
  const pixels = sourcePixels.data
  const variant = activeVariant.value
  const slot = slots.value.find((item) => item.id === samplingSlotId.value)
  if (!variant || !slot) return
  const hex = normalizeHex(
    `#${[pixels[offset], pixels[offset + 1], pixels[offset + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
  )
  if (hex) variant.mapping[slot.id] = hex
  pickTarget.value = false
  samplingSlotId.value = ''
}

/** 取消取色 */
function cancelPick(): void {
  pickTarget.value = false
  samplingSlotId.value = ''
}

/** 渲染当前变体的全尺寸预览 + 全部变体缩略图 */
let renderToken = 0
async function renderAll(): Promise<void> {
  if (!sourcePixels || !thumbPixels || !activeVariant.value) return
  const token = ++renderToken
  state.value.status = 'processing'
  state.value.progress = 0
  try {
    const url = await renderPaletteVariant(sourcePixels, slots.value, activeVariant.value, state.value.tolerance, (ratio) => {
      if (token === renderToken) state.value.progress = ratio
    })
    if (token !== renderToken) return
    previewUrl.value = url
    const next: Record<string, string> = {}
    for (const variant of variants.value) {
      const work = new ImageData(new Uint8ClampedArray(thumbPixels.data), thumbPixels.width, thumbPixels.height)
      await remapImageData(work, slots.value, variant, state.value.tolerance)
      const canvas = document.createElement('canvas')
      canvas.width = work.width
      canvas.height = work.height
      canvas.getContext('2d')!.putImageData(work, 0, 0)
      next[variant.id] = canvas.toDataURL('image/png')
      releaseCanvas(canvas)
      if (token !== renderToken) return
    }
    thumbs.value = next
    state.value.progress = -1
    state.value.status = 'done'
  } catch (error) {
    if (token !== renderToken) return
    state.value.progress = -1
    state.value.error = error instanceof Error ? error.message : '变体渲染失败'
    state.value.status = 'error'
  }
}

/** 映射/容差变化后防抖重渲染，避免拖动取色器时逐帧全量扫描 */
let renderTimer: number | undefined
function scheduleRender(): void {
  if (!sourcePixels) return
  window.clearTimeout(renderTimer)
  renderTimer = window.setTimeout(() => void renderAll(), 180)
}

watch(
  () => activeVariant.value?.mapping,
  (mapping) => { if (mapping) scheduleRender() },
  { deep: true },
)
// 切换当前变体时全尺寸预览需要换成该变体的结果
watch(() => state.value.activeVariantId, scheduleRender)
watch(() => state.value.tolerance, scheduleRender)
watch(() => slots.value.map((slot) => slot.enabled).join(','), scheduleRender)

/** 导出 ZIP：全部变体 PNG + palette.json 映射元数据 */
async function exportZip(): Promise<void> {
  if (!sourcePixels || !variants.value.length) return
  exporting.value = true
  state.value.error = ''
  try {
    const entries: Array<{ name: string; blob: Blob | string }> = []
    const manifest: Array<{ name: string; fileName: string }> = []
    for (let index = 0; index < variants.value.length; index++) {
      const variant = variants.value[index]
      const fileName = paletteFileName(state.value.nameTemplate, baseName.value, variant.name, index)
      // 一律现算，避免预览防抖渲染未完成时导出到旧映射的结果
      const url = await renderPaletteVariant(sourcePixels, slots.value, variant, state.value.tolerance)
      entries.push({ name: fileName, blob: url })
      manifest.push({ name: variant.name, fileName })
    }
    entries.push({
      name: 'palette.json',
      blob: JSON.stringify(buildPaletteMeta(state.value.fileName, slots.value, manifest, state.value.tolerance), null, 2),
    })
    await downloadZip(entries, `${baseName.value}-palette.zip`)
  } catch (error) {
    state.value.error = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 重置整页 */
function resetAll(): void {
  resetPalette()
  sourcePixels = null
  thumbPixels = null
  previewUrl.value = ''
  thumbs.value = {}
  cancelPick()
}

/** 释放 ObjectURL，避免切页后泄漏 */
onBeforeUnmount(() => {
  window.clearTimeout(renderTimer)
  if (state.value.sourceUrl) URL.revokeObjectURL(state.value.sourceUrl)
})
</script>

<template>
  <div class="grid h-full min-h-0" :class="hasSource ? 'grid-cols-[280px_minmax(0,1fr)_320px]' : 'grid-cols-[minmax(0,1fr)_320px]'">
    <!-- 左栏：已导入图片列表，未导入时整栏不显示 -->
    <section v-if="hasSource" class="panel overflow-auto border-r border-line">
      <div class="section">
        <h2 class="section-title">图集列表</h2>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <li class="flex items-center gap-2">
            <img class="size-10 flex-none rounded-sm border border-line bg-stage object-contain" :src="state.sourceUrl" :alt="state.fileName" draggable="false" />
            <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-caption" :title="state.fileName">{{ state.fileName }}</span>
            <span class="mono faint">{{ state.image?.width }}×{{ state.image?.height }}</span>
            <button class="btn btn-icon btn-danger" title="移除" @click="resetAll">×</button>
          </li>
        </ul>
      </div>
    </section>

    <main class="flex min-h-0 min-w-0 flex-col">
      <div class="flex h-16 flex-none items-center justify-between gap-4 border-b border-line px-6">
        <div>
          <h2 class="m-0 text-head">换色工作区</h2>
          <p class="mt-0.5 mb-0 text-faint">{{ state.image ? `${state.image.width}×${state.image.height} px · ${slots.length} 个色槽 · ${variants.length} 套变体` : '导入一张精灵图开始提取色板' }}</p>
        </div>
        <div class="flex items-center gap-3">
          <input ref="input" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="onFileChange" />
          <button class="btn btn-primary" @click="input?.click()">导入图片</button>
          <label class="check-row">
            <input v-model="state.checkerBg" type="checkbox" />
            <span>棋盘底</span>
          </label>
          <span v-if="activeVariant" class="badge badge-accent">{{ activeVariant.name }} · {{ changedCount }} 处已换色</span>
          <button class="btn" :disabled="!slots.length" @click="addVariant">＋ 添加变体</button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-6">
        <div v-if="!hasSource" class="empty-state">
          <span class="big">◑</span>
          <strong>还没有可换色的图片</strong>
          <span>导入一张角色 / 阵营精灵图（PNG / JPG / WebP，≤ 10MB），自动提取主色板后即可逐槽换色</span>
        </div>

        <template v-else>
          <section class="flex flex-col gap-3">
            <h3 class="m-0 flex flex-wrap items-center gap-3 text-caption font-semibold tracking-[0.06em] text-faint uppercase">
              色槽与目标色
              <span class="faint normal-case font-normal tracking-normal">关闭的色槽不参与换色；只有勾选「阵营色」的槽会被预设换色</span>
            </h3>
            <div v-if="slots.length" class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(268px,1fr))]">
              <article v-for="slot in slots" :key="slot.id" class="flex flex-col gap-2 rounded-md border border-line bg-surface p-3" :class="!slot.enabled && 'opacity-50'">
                <header class="flex items-center justify-between">
                  <label class="check-row">
                    <input :checked="slot.enabled" type="checkbox" @change="toggleSlot(slot, $event)" />
                    <span class="mono">{{ slot.id.replace('slot-', '#') }}</span>
                  </label>
                  <label class="check-row team-row" title="勾选后阵营色预设才会写入该槽；默认只标记占比最高的有彩色槽">
                    <input :checked="slot.team" type="checkbox" @change="toggleTeam(slot, $event)" />
                    <span>阵营色</span>
                  </label>
                  <span class="badge">{{ (slot.ratio * 100).toFixed(1) }}%</span>
                </header>
                <div class="flex items-center gap-2">
                  <span class="size-6.5 flex-none rounded-sm border border-line-strong" :style="{ background: slot.source }" :title="`原色 ${slot.source}`"></span>
                  <span class="text-faint">→</span>
                  <input
                    class="size-6.5 flex-none cursor-pointer rounded-sm border border-line-strong bg-none bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:rounded-[2px] [&::-webkit-color-swatch]:border-0"
                    type="color"
                    :value="activeVariant?.mapping[slot.id] ?? slot.source"
                    :title="`目标色 ${activeVariant?.mapping[slot.id] ?? slot.source}`"
                    @input="onSlotHexInput(slot, $event)"
                  />
                  <input
                    class="input mono h-6.5 min-w-0 flex-1"
                    type="text"
                    :value="activeVariant?.mapping[slot.id] ?? slot.source"
                    @change="onSlotHexInput(slot, $event)"
                  />
                  <button class="btn btn-icon" :class="pickTarget && samplingSlotId === slot.id && 'text-accent-strong border-accent-border'" :title="pickTarget && samplingSlotId === slot.id ? '点击原图取色' : '从原图取色'" @click="startPick(slot)">⌖</button>
                </div>
                <div class="h-[3px] overflow-hidden rounded-[2px] bg-hover"><i class="block h-full bg-accent" :style="{ width: `${Math.min(100, slot.ratio * 100)}%` }"></i></div>
              </article>
            </div>
            <p v-else class="muted">未提取到色槽，请调整容差后重新提取。</p>
          </section>

          <section class="flex flex-col gap-3">
            <h3 class="m-0 flex flex-wrap items-center gap-3 text-caption font-semibold tracking-[0.06em] text-faint uppercase">
              对比预览
              <span v-if="pickTarget" class="inline-flex items-center gap-2 font-normal normal-case tracking-normal text-accent-strong">取色中：点击左侧原图任意位置写入目标色 <button class="btn btn-ghost h-[22px] px-2 text-caption" @click="cancelPick">取消</button></span>
              <span v-else-if="state.status === 'processing'" class="inline-flex items-center gap-2 font-normal normal-case tracking-normal text-accent-strong">渲染中 {{ Math.round(state.progress * 100) }}%</span>
            </h3>
            <div class="grid grid-cols-2 items-start gap-4">
              <figure class="m-0 flex flex-col gap-2">
                <figcaption class="text-caption text-faint">原图</figcaption>
                <div class="grid min-h-[220px] place-items-center overflow-hidden rounded-sm border border-line bg-stage p-3" :class="state.checkerBg && 'bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-[length:12px_12px]'">
                  <img
                    ref="imgRef"
                    :src="state.sourceUrl"
                    class="block max-h-[46vh] max-w-full object-contain select-none"
                    :class="pickTarget && 'cursor-crosshair'"
                    alt="原图"
                    draggable="false"
                    @click="onStageClick"
                  />
                </div>
              </figure>
              <figure class="m-0 flex flex-col gap-2">
                <figcaption class="text-caption text-faint">{{ activeVariant?.name ?? '变体' }}</figcaption>
                <div class="grid min-h-[220px] place-items-center overflow-hidden rounded-sm border border-line bg-stage p-3" :class="state.checkerBg && 'bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-[length:12px_12px]'">
                  <img v-if="previewUrl" class="block max-h-[46vh] max-w-full object-contain select-none" :src="previewUrl" alt="变体预览" draggable="false" />
                  <p v-else class="muted">渲染中…</p>
                </div>
              </figure>
            </div>
          </section>

          <section class="flex flex-col gap-3">
            <h3 class="m-0 flex flex-wrap items-center gap-3 text-caption font-semibold tracking-[0.06em] text-faint uppercase">
              变体列表
              <span class="faint normal-case font-normal tracking-normal">点击卡片切换当前编辑的变体，导出时全部生成</span>
            </h3>
            <div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
              <article
                v-for="variant in variants"
                :key="variant.id"
                class="flex cursor-pointer flex-col gap-2 rounded-md border border-line bg-surface p-2"
                :class="variant.id === activeVariant?.id ? 'border-accent-border shadow-[var(--focus-ring)]' : 'hover:border-line-strong'"
                @click="state.activeVariantId = variant.id"
              >
                <div class="grid h-24 place-items-center overflow-hidden rounded-sm bg-stage" :class="state.checkerBg && 'bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-[length:10px_10px]'">
                  <img v-if="thumbs[variant.id]" class="max-h-full max-w-full object-contain" :src="thumbs[variant.id]" :alt="variant.name" draggable="false" />
                </div>
                <div class="flex items-center gap-2">
                  <input class="input h-6 min-w-0 flex-1" type="text" :value="variant.name" @change="onVariantRename(variant, $event)" />
                  <button class="btn btn-icon btn-danger" :disabled="variants.length <= 1" title="删除变体" @click.stop="removeVariant(variant.id)">×</button>
                </div>
              </article>
            </div>
          </section>
        </template>
      </div>
    </main>

    <!-- 右栏：配置、参数与导出 -->
    <section class="panel overflow-auto border-l border-line">
      <div class="section">
        <h2 class="section-title">调色板换色</h2>
        <p class="muted">Team Color / 皮肤变体，本地处理不上传</p>
      </div>

      <div class="section [&>.field+.field]:mt-3 [&>.field+.check-row]:mt-3 [&>.check-row+.btn]:mt-3 [&>p+.field]:mt-3 [&>p+.btn]:mt-3">
        <h2 class="section-title">主色板提取</h2>
        <label class="field">
          <span class="field-label">色槽数量 {{ state.maxSlots }}</span>
          <input v-model.number="state.maxSlots" class="w-full accent-accent" type="range" min="3" max="12" :disabled="!hasSource" />
        </label>
        <label class="field">
          <span class="field-label">颜色容差 {{ state.tolerance }}</span>
          <input v-model.number="state.tolerance" class="w-full accent-accent" type="range" min="4" max="60" />
        </label>
        <p class="muted hint mt-1 mb-0 text-caption">{{ windowHint }}（沿用抠图页的色相/饱和度判据）</p>
        <label class="check-row">
          <input v-model="state.includeNeutrals" type="checkbox" />
          <span>黑/灰/白单独列为色槽</span>
        </label>
        <button class="btn w-full justify-center" :disabled="!hasSource || state.status === 'processing'" @click="extract">
          {{ state.status === 'processing' ? '处理中…' : '重新提取主色板' }}
        </button>
      </div>

      <div class="section [&>.field+.field]:mt-3 [&>.field+.check-row]:mt-3 [&>.check-row+.btn]:mt-3 [&>p+.field]:mt-3 [&>p+.btn]:mt-3">
        <h2 class="section-title">阵营色预设</h2>
        <div class="mb-3 grid grid-cols-2 gap-2">
          <button
            v-for="preset in TEAM_COLOR_PRESETS"
            :key="preset.key"
            class="flex h-7 items-center gap-1.5 rounded-sm border border-line bg-raised px-2 text-caption text-muted enabled:hover:border-line-strong enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
            :disabled="!activeVariant"
            :title="`把 ${preset.label} 应用到当前变体`"
            @click="applyPreset(preset)"
          >
            <span class="inline-flex gap-0.5">
              <i v-for="color in preset.colors" :key="color" class="size-2 rounded-[2px]" :style="{ background: color }"></i>
            </span>
            <span>{{ preset.label }}</span>
          </button>
        </div>
        <p v-if="hasSource" class="muted hint mt-1 mb-0 text-caption">
          <template v-if="teamSlotCount">当前 {{ teamSlotCount }} 个色槽标记为阵营色，预设只换这些区域</template>
          <template v-else>还没有阵营色槽：请在色槽卡片勾选「阵营色」，预设才有可写入的目标</template>
        </p>
        <button class="btn w-full justify-center" :disabled="!slots.length" @click="generateTeamVariants">一次生成 7 套阵营变体</button>
      </div>

      <div class="section [&>.field+.field]:mt-3 [&>.field+.check-row]:mt-3 [&>.check-row+.btn]:mt-3 [&>p+.field]:mt-3 [&>p+.btn]:mt-3">
        <h2 class="section-title">导出</h2>
        <label class="field">
          <span class="field-label">命名模板</span>
          <input v-model="state.nameTemplate" class="input" type="text" placeholder="{base}_{variant}.png" />
        </label>
        <p class="muted hint mt-1 mb-0 text-caption">占位符：{base} 源图名 · {variant} 变体名 · {index} 序号</p>
        <button class="btn btn-primary w-full justify-center" :disabled="!variants.length || exporting || !hasSource" @click="exportZip">
          {{ exporting ? '导出中…' : `导出 ZIP（${variants.length} 套 PNG + 元数据）` }}
        </button>
        <button class="btn btn-ghost w-full justify-center" :disabled="!hasSource" @click="resetAll">重置</button>
        <p v-if="state.error" class="text-caption text-danger">{{ state.error }}</p>
      </div>
    </section>

  </div>
</template>


