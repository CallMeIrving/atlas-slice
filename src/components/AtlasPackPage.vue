<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { buildAtlasJson, buildAtlasJsonArray, buildCssSprites, buildPlist, groupAnimations, type FrameMeta } from '@/core/atlas-meta'
import { loadImage, releaseCanvas } from '@/core/image'
import { canvasToBlob, downloadZip } from '@/core/media-export'
import { drawFrame, packItemsMultiPage, renderAtlas, type PackItem, type PackOptions } from '@/core/pack'
import { parseJsonAtlas } from '@/core/parsers/json'
import type { AtlasPackPageResult } from '@/store/workspace'
import { resetAtlasPack, workspace } from '@/store/workspace'
import AtlasAnimationPreview from '@/components/AtlasAnimationPreview.vue'

/**
 * 雪碧图（图集打包）页。
 * 一次导入多张素材 → MaxRects / 网格装箱成一页或多页图集 → 导出 PNG + 多格式元数据。
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024

const state = computed(() => workspace.atlaspack)
const input = ref<HTMLInputElement>()
/** 回读重打包的文件选择器（图集图片 + JSON 元数据） */
const atlasInput = ref<HTMLInputElement>()
/** 解码后的素材缓存，key 为素材 id；不放进 store，避免响应式代理大对象 */
const images = new Map<string, HTMLImageElement>()
/** 最近一次成功打包产出的每页帧元数据，导出时直接复用（与 result 页序一一对应） */
let packedMetas: Record<string, FrameMeta>[] | null = null

const packing = ref(false)
const exporting = ref(false)
/** 预览区悬停高亮的落位 id */
const hoverId = ref('')
/** 拖拽进入深度计数：>0 时显示高亮遮罩，解决子元素进出误触发 dragleave 的问题 */
const dragDepth = ref(0)
/** 导出时的 CSS 跳过帧提示（旋转帧无法用 background 无损表达） */
const cssSkipped = ref<string[]>([])
/** 是否显示右下角动画预览面板（纯界面开关，不参与打包参数） */
const showAnim = ref(true)

const activePage = computed(() => Math.min(state.value.activePage, Math.max(0, state.value.previewUrls.length - 1)))
const activeResult = computed(() => state.value.result?.[activePage.value] ?? null)
/** 全部页的落位总数，供头部徽标展示 */
const totalPlacements = computed(() => state.value.result?.reduce((sum, page) => sum + page.placements.length, 0) ?? 0)

/** 生成素材唯一 id */
function nextId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** 判断拖拽事件是否携带文件 */
function hasFiles(e: DragEvent): boolean {
  return Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'))
}

function onDragEnter(e: DragEvent): void {
  if (hasFiles(e)) dragDepth.value++
}

function onDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

/** 松手即导入：复用文件选择器的导入管线 */
function onDrop(e: DragEvent): void {
  dragDepth.value = 0
  void importFiles(e.dataTransfer?.files ?? null)
}

/** 校验并导入一批素材：逐个解码记录尺寸，任一失败则整批回滚，避免半成品列表 */
async function importFiles(files: FileList | null): Promise<void> {
  if (!files?.length) return
  state.value.error = ''
  const added: typeof state.value.items = []
  const createdUrls: string[] = []
  try {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) throw new Error(`「${file.name}」不是图片文件`)
      if (file.size > MAX_FILE_SIZE) throw new Error(`「${file.name}」超过 20MB 限制`)
      const url = URL.createObjectURL(file)
      createdUrls.push(url)
      const image = await loadImage(url, `「${file.name}」加载失败`)
      const id = nextId()
      images.set(id, image)
      added.push({ id, name: file.name, url, width: image.naturalWidth, height: image.naturalHeight })
    }
    state.value.items.push(...added)
    state.value.status = 'ready'
    scheduleRepack()
  } catch (error) {
    // 回滚：释放本批已创建的 URL 与缓存，保持与界面列表一致
    createdUrls.forEach((url) => URL.revokeObjectURL(url))
    added.forEach((item) => images.delete(item.id))
    state.value.error = error instanceof Error ? error.message : '素材导入失败'
    state.value.status = state.value.items.length ? 'ready' : 'error'
  } finally {
    if (input.value) input.value.value = ''
  }
}

function onFileChange(e: Event): void {
  void importFiles((e.target as HTMLInputElement).files)
}

function onAtlasFileChange(e: Event): void {
  void importAtlasFiles((e.target as HTMLInputElement).files)
}

/**
 * 回读重打包：导入已有图集图片 + JSON 元数据（TexturePacker 哈希/数组格式），
 * 按帧矩形逐帧抠出（旋转帧自动还原）并转成素材，之后走常规打包管线重新装箱。
 */
async function importAtlasFiles(files: FileList | null): Promise<void> {
  if (!files?.length) return
  state.value.error = ''
  const list = Array.from(files)
  const imageFile = list.find((f) => f.type.startsWith('image/'))
  const jsonFile = list.find((f) => f.type === 'application/json' || /\.json$/i.test(f.name))
  if (!imageFile || !jsonFile) {
    state.value.error = '请同时选择图集图片和对应的 JSON 元数据文件'
    return
  }
  const added: typeof state.value.items = []
  const createdUrls: string[] = []
  try {
    const imageUrl = URL.createObjectURL(imageFile)
    createdUrls.push(imageUrl)
    const [image, parsed] = await Promise.all([
      loadImage(imageUrl, '图集图片加载失败'),
      jsonFile.text().then(parseJsonAtlas),
    ])
    if (!parsed.frames.length) throw new Error('JSON 元数据中没有任何帧')
    for (const frame of parsed.frames) {
      const canvas = drawFrame(image, { x: frame.rect.x, y: frame.rect.y, w: frame.rect.w, h: frame.rect.h, rotated: frame.rotated })
      const blob = await canvasToBlob(canvas)
      releaseCanvas(canvas)
      const url = URL.createObjectURL(blob)
      createdUrls.push(url)
      const id = nextId()
      const frameImage = await loadImage(url, `「${frame.name}」加载失败`)
      images.set(id, frameImage)
      added.push({ id, name: frame.name, url, width: frameImage.naturalWidth, height: frameImage.naturalHeight })
    }
    state.value.items.push(...added)
    state.value.status = 'ready'
    scheduleRepack()
  } catch (error) {
    // 失败回滚：释放本批 URL 与解码缓存
    createdUrls.forEach((url) => URL.revokeObjectURL(url))
    added.forEach((item) => images.delete(item.id))
    state.value.error = error instanceof Error ? error.message : '图集导入失败'
  } finally {
    if (atlasInput.value) atlasInput.value.value = ''
  }
}

/** 移除单个素材：同时释放 blob 与解码缓存 */
function removeItem(id: string): void {
  const index = state.value.items.findIndex((item) => item.id === id)
  if (index < 0) return
  URL.revokeObjectURL(state.value.items[index].url)
  images.delete(id)
  state.value.items.splice(index, 1)
  scheduleRepack()
}

/** 参数或素材变化后作废当前打包结果，强制重新打包 */
function invalidate(): void {
  state.value.status = state.value.items.length ? 'ready' : 'empty'
  state.value.result = null
  state.value.previewUrls = []
  state.value.activePage = 0
  state.value.warnings = []
  packedMetas = null
  cssSkipped.value = []
}

/** 自动重打包的防抖定时器 */
let repackTimer: number | undefined

/** 参数/素材变化后自动重打包（防抖 300ms），仅在已有打包结果时触发，避免导入阶段空跑 */
function scheduleRepack(): void {
  if (state.value.status !== 'packed') return
  window.clearTimeout(repackTimer)
  repackTimer = window.setTimeout(() => { void pack() }, 300)
}

/** 参数变化即自动重打包，预览始终与当前参数同步 */
watch(() => state.value.settings, scheduleRepack, { deep: true })

/** 热更新/切页重挂载后，从 store 里的 blob URL 重新解码素材缓存 */
watch(() => state.value.items.length, async (count) => {
  if (!count) { images.clear(); return }
  if (images.size === count) return
  images.clear()
  for (const item of state.value.items) {
    try { images.set(item.id, await loadImage(item.url, '素材加载失败')) } catch { /* 单张失败不影响其余 */ }
  }
}, { immediate: true })

/** 组装纯逻辑层所需的素材列表（只取已解码成功的） */
function collectPackItems(): PackItem[] {
  return state.value.items
    .map((item) => ({ id: item.id, name: item.name, image: images.get(item.id)! }))
    .filter((item) => Boolean(item.image))
}

/** 收敛到 0-1 区间 */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5))
}

/** 由锚点预设解析出归一化坐标（写入元数据 pivot 字段） */
function resolvePivot(): { x: number; y: number } {
  const s = state.value.settings
  switch (s.pivotMode) {
    case 'topleft': return { x: 0, y: 0 }
    case 'topcenter': return { x: 0.5, y: 0 }
    case 'bottomcenter': return { x: 0.5, y: 1 }
    case 'bottomleft': return { x: 0, y: 1 }
    case 'custom': return { x: clamp01(s.pivotX), y: clamp01(s.pivotY) }
    default: return { x: 0.5, y: 0.5 }
  }
}

/** 当前打包参数 */
function packOptions(): PackOptions {
  const s = state.value.settings
  return {
    padding: s.padding, margin: s.margin, maxSize: s.maxSize,
    allowRotate: s.allowRotate, powerOfTwo: s.powerOfTwo,
    trim: s.trim, alphaThreshold: s.alphaThreshold,
    layout: s.layout, heuristic: s.heuristic,
    gridColumns: s.gridColumns, gridCell: s.gridCell, extrude: s.extrude,
    mergeDuplicate: s.mergeDuplicate,
  }
}

/** 执行打包：多页装箱 → 逐页渲染图集 → 写入预览、落位结果与告警 */
async function pack(): Promise<void> {
  if (!state.value.items.length || packing.value) return
  packing.value = true
  state.value.error = ''
  // 让出一次事件循环，先渲染「打包中…」状态
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    const items = collectPackItems()
    const opts = packOptions()
    const multi = packItemsMultiPage(items, opts)
    const s = state.value.settings
    const renderOpts = {
      padding: Math.max(0, Math.round(opts.padding)),
      extrude: opts.extrude,
      format: s.imageFormat,
      quality: Math.min(100, Math.max(0, s.webpQuality)) / 100,
      pivot: resolvePivot(),
    }
    const pages: AtlasPackPageResult[] = []
    const urls: string[] = []
    const metas: Record<string, FrameMeta>[] = []
    for (const page of multi.pages) {
      const rendered = renderAtlas(items, page, renderOpts)
      urls.push(rendered.url)
      metas.push(rendered.meta)
      pages.push({
        width: page.width,
        height: page.height,
        fillRatio: page.fillRatio,
        placements: page.placements.map((p) => ({
          id: p.id, name: p.name, x: p.x, y: p.y, w: p.w, h: p.h,
          rotated: p.rotated, trimmed: p.trimmed, sourceSize: { ...p.sourceSize },
        })),
      })
    }
    packedMetas = metas
    state.value.result = pages
    state.value.previewUrls = urls
    state.value.activePage = 0
    state.value.warnings = [...multi.errors]
    state.value.status = 'packed'
  } catch (error) {
    invalidate()
    state.value.error = error instanceof Error ? error.message : '打包失败'
    state.value.status = 'error'
  } finally {
    packing.value = false
  }
}

/** 页下标对应的文件名后缀：第一页不带序号，其后为 -2、-3… */
function pageSuffix(index: number): string {
  return index === 0 ? '' : `-${index + 1}`
}

/** 导出 ZIP：每页图集 PNG + 按勾选输出 JSON / plist / CSS / 数组 JSON 元数据 */
async function exportZip(): Promise<void> {
  const pages = state.value.result
  const urls = state.value.previewUrls
  if (!pages?.length || !packedMetas || urls.length !== pages.length) return
  exporting.value = true
  state.value.error = ''
  cssSkipped.value = []
  try {
    const base = state.value.settings.name.trim() || 'atlas'
    const ext = state.value.settings.imageFormat === 'webp' ? 'webp' : 'png'
    const entries: Array<{ name: string; blob: Blob | string }> = []
    pages.forEach((page, index) => {
      const suffix = pageSuffix(index)
      const imageName = `${base}${suffix}.${ext}`
      const meta = packedMetas![index]
      const size = { w: page.width, h: page.height }
      const animations = state.value.settings.withAnimations ? groupAnimations(Object.keys(meta)) : undefined
      entries.push({ name: imageName, blob: urls[index] })
      if (state.value.settings.withMetaJson) {
        entries.push({ name: `${base}${suffix}.json`, blob: buildAtlasJson(meta, size, imageName, animations) })
      }
      if (state.value.settings.withMetaPlist) {
        entries.push({ name: `${base}${suffix}.plist`, blob: buildPlist(meta, size, imageName) })
      }
      if (state.value.settings.withJsonArray) {
        entries.push({ name: `${base}${suffix}-array.json`, blob: buildAtlasJsonArray(meta, size, imageName, animations) })
      }
      if (state.value.settings.withCss) {
        const { css, skipped } = buildCssSprites(meta, imageName)
        entries.push({ name: `${base}${suffix}.css`, blob: css })
        cssSkipped.value.push(...skipped.map((name) => `第 ${index + 1} 页：旋转帧「${name}」无法写入 CSS，已跳过`))
      }
    })
    await downloadZip(entries, `${base}.zip`)
    state.value.warnings = [
      // 保留打包阶段的告警（超大素材跳过等），追加本次导出的 CSS 跳过提示
      ...state.value.warnings.filter((w) => !w.includes('无法写入 CSS')),
      ...cssSkipped.value,
    ]
  } catch (error) {
    state.value.error = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 窄屏与缩放无关：落位框按当前页尺寸换算成百分比定位 */
function placementStyle(placement: { x: number; y: number; w: number; h: number }): Record<string, string> {
  const result = activeResult.value
  if (!result) return {}
  return {
    left: `${(placement.x / result.width) * 100}%`,
    top: `${(placement.y / result.height) * 100}%`,
    width: `${(placement.w / result.width) * 100}%`,
    height: `${(placement.h / result.height) * 100}%`,
  }
}

/** 重置整页 */
function resetAll(): void {
  window.clearTimeout(repackTimer)
  images.clear()
  packedMetas = null
  hoverId.value = ''
  dragDepth.value = 0
  cssSkipped.value = []
  resetAtlasPack()
}
</script>

<template>
  <div class="relative grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)_320px]" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <!-- 左栏：仅展示图集素材列表 -->
    <section class="panel overflow-auto border-r border-line">
      <div class="section">
        <h2 class="section-title">图集列表</h2>
        <p class="muted hint mt-1 mb-0 text-caption">素材按导入顺序参与打包，可单独移除</p>
        <ul v-if="state.items.length" class="mt-2 mb-0 flex list-none flex-col gap-1 p-0">
          <li v-for="item in state.items" :key="item.id" class="flex items-center gap-2">
            <img class="size-6.5 flex-none rounded-sm border border-line bg-stage object-contain" :src="item.url" :alt="item.name" draggable="false" />
            <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-caption" :title="item.name">{{ item.name }}</span>
            <span class="mono faint">{{ item.width }}×{{ item.height }}</span>
            <button class="btn btn-icon btn-danger" title="移除" @click="removeItem(item.id)">×</button>
          </li>
        </ul>
        <p v-else class="muted">尚未导入素材</p>
      </div>
    </section>

    <main class="flex min-h-0 min-w-0 flex-col">
      <div class="flex h-16 flex-none items-center justify-between gap-4 border-b border-line px-6">
        <div>
          <h2 class="m-0 text-head">雪碧图工作区</h2>
          <p class="mt-0.5 mb-0 text-faint">
            <template v-if="state.result">
              {{ state.items.length }} 张素材 → {{ state.result.length }} 页图集 · 共 {{ totalPlacements }} 处落位
            </template>
            <template v-else>导入多张素材后点击「开始打包」</template>
          </p>
        </div>
        <div class="flex items-center gap-3">
          <input ref="input" hidden multiple type="file" accept="image/png,image/jpeg,image/webp" @change="onFileChange" />
          <input ref="atlasInput" hidden multiple type="file" accept="image/png,image/jpeg,image/webp,.json,application/json" @change="onAtlasFileChange" />
          <button class="btn btn-primary" @click="input?.click()">导入图片</button>
          <button class="btn" @click="atlasInput?.click()">导入图片+JSON</button>
          <span v-if="state.status === 'packed'" class="badge badge-accent">
            {{ activeResult ? `${activeResult.width}×${activeResult.height} · 填充率 ${(activeResult.fillRatio * 100).toFixed(1)}%` : '' }}
          </span>
        </div>
      </div>

      <div class="relative flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto p-6">
        <div v-if="!state.previewUrls.length" class="empty-state">
          <span class="big">▤</span>
          <strong>还没有可打包的素材</strong>
          <span>一次导入多张角色帧 / 道具 / 图标（PNG / JPG / WebP，单张 ≤ 20MB），或直接拖拽到此处</span>
        </div>

        <template v-else>
          <div v-if="state.previewUrls.length > 1" class="flex flex-wrap justify-center gap-2">
            <button
              v-for="(url, index) in state.previewUrls"
              :key="url"
              class="cursor-pointer rounded-full border border-line bg-transparent px-[14px] py-1 text-ink"
              :class="index === activePage && 'border-accent bg-accent-dim text-accent'"
              @click="state.activePage = index"
            >
              第 {{ index + 1 }} 页
            </button>
          </div>

          <div class="flex flex-col items-center gap-2">
            <div class="relative inline-block rounded-sm border border-line bg-stage leading-0">
              <img class="block max-h-[56vh] max-w-full object-contain" :src="state.previewUrls[activePage]" alt="打包结果" draggable="false" />
              <div class="absolute inset-0">
                <div
                  v-for="placement in activeResult?.placements ?? []"
                  :key="placement.id"
                  class="absolute border border-transparent transition-[background,border-color] duration-100 hover:border-accent hover:bg-accent-dim"
                  :class="hoverId === placement.id && 'border-accent bg-accent-dim'"
                  :style="placementStyle(placement)"
                  :title="`${placement.name} · ${placement.sourceSize.w}×${placement.sourceSize.h}${placement.rotated ? ' · 已旋转' : ''}`"
                  @mouseenter="hoverId = placement.id"
                  @mouseleave="hoverId = ''"
                ></div>
              </div>
            </div>
            <p v-if="hoverId" class="muted mono">
              {{ activeResult?.placements.find((p) => p.id === hoverId)?.name }}
            </p>
          </div>

          <AtlasAnimationPreview
            v-if="showAnim && activeResult"
            :result="activeResult"
            :preview-url="state.previewUrls[activePage]"
          />
        </template>

        <transition
          name="fade"
          enter-active-class="transition-opacity duration-150"
          leave-active-class="transition-opacity duration-150"
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
        >
          <div v-if="dragDepth > 0" class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-sm border-2 border-dashed border-accent bg-accent-dim text-head text-accent">
            <span>松开以导入图片</span>
          </div>
        </transition>
      </div>
    </main>

    <!-- 右栏：导入、布局参数与导出配置 -->
    <section class="panel overflow-auto border-l border-line">
      <div class="section [&>p+.check-row]:mt-3">
        <h2 class="section-title">雪碧图打包</h2>
        <p class="muted">MaxRects / 网格装箱，放不下自动分页，本地处理不上传</p>
        <label class="check-row"><input v-model="showAnim" type="checkbox" /> 动画预览（右下角悬浮）</label>
      </div>

      <div class="section [&>.field+.field]:mt-3 [&>.check-row+.check-row]:mt-3 [&>.check-row+.field]:mt-3 [&>p+.field]:mt-3 [&>p+.check-row]:mt-3">
        <h2 class="section-title">布局参数</h2>
        <label class="field">
          <span class="field-label">布局方式</span>
          <select v-model="state.settings.layout" class="select w-full">
            <option value="compact">紧凑装箱（MaxRects）</option>
            <option value="grid">固定网格</option>
            <option value="strip-h">横向条带（单行）</option>
            <option value="strip-v">纵向条带（单列）</option>
          </select>
        </label>
        <template v-if="state.settings.layout === 'compact'">
          <label class="field">
            <span class="field-label">装箱启发式</span>
            <select v-model="state.settings.heuristic" class="select w-full">
              <option value="bssf">残留最小边（BSSF）</option>
              <option value="bl">底左（BL）</option>
              <option value="contact">接触周长（Contact）</option>
            </select>
          </label>
          <label class="check-row"><input v-model="state.settings.allowRotate" type="checkbox" /> 允许 90° 旋转以提升紧凑度</label>
        </template>
        <template v-else-if="state.settings.layout === 'grid'">
          <div class="field-row gap-3 mt-3 [&_.field]:min-w-0 [&_.field]:flex-1 [&_.input]:w-full">
            <label class="field">
              <span class="field-label">列数（0 自动）</span>
              <input v-model.number="state.settings.gridColumns" class="input" type="number" min="0" />
            </label>
            <label class="field">
              <span class="field-label">格尺寸（0 自动）</span>
              <input v-model.number="state.settings.gridCell" class="input" type="number" min="0" />
            </label>
          </div>
          <p class="muted hint mt-1 mb-0 text-caption">网格模式按固定单元格排布，不旋转，适合帧动画序列。</p>
        </template>
        <p v-else class="muted hint mt-1 mb-0 text-caption">条带模式按导入顺序单行/单列排布，不旋转，放不下自动分页。</p>
        <label class="check-row"><input v-model="state.settings.mergeDuplicate" type="checkbox" /> 合并相同帧（Alias 去重）</label>
        <label class="field">
          <span class="field-label">边缘外扩（extrude）</span>
          <select v-model.number="state.settings.extrude" class="select w-full">
            <option :value="0">不外扩</option>
            <option :value="1">1 px</option>
            <option :value="2">2 px</option>
          </select>
        </label>
        <div class="field-row gap-3 mt-3 [&_.field]:min-w-0 [&_.field]:flex-1 [&_.input]:w-full">
          <label class="field">
            <span class="field-label">素材留白</span>
            <input v-model.number="state.settings.padding" class="input" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">外边距</span>
            <input v-model.number="state.settings.margin" class="input" type="number" min="0" />
          </label>
        </div>
        <label class="field">
          <span class="field-label">最大边长</span>
          <select v-model.number="state.settings.maxSize" class="select w-full">
            <option :value="512">512 px</option>
            <option :value="1024">1024 px</option>
            <option :value="2048">2048 px</option>
            <option :value="4096">4096 px</option>
          </select>
        </label>
        <label class="check-row"><input v-model="state.settings.trim" type="checkbox" /> 裁掉透明边（trim）</label>
        <label v-if="state.settings.trim" class="field">
          <span class="field-label">裁剪 alpha 阈值 {{ state.settings.alphaThreshold }}</span>
          <input v-model.number="state.settings.alphaThreshold" class="w-full accent-accent" type="range" min="1" max="64" />
        </label>
        <label class="check-row"><input v-model="state.settings.powerOfTwo" type="checkbox" /> 宽高取 2 的幂</label>
      </div>

      <div class="section [&>.field+.field]:mt-3 [&>.check-row+.check-row]:mt-3 [&>.check-row+.field]:mt-3 [&>p+.field]:mt-3 [&>p+.check-row]:mt-3">
        <h2 class="section-title">导出</h2>
        <label class="field">
          <span class="field-label">图片格式</span>
          <select v-model="state.settings.imageFormat" class="select w-full">
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
          </select>
        </label>
        <label v-if="state.settings.imageFormat === 'webp'" class="field">
          <span class="field-label">WebP 质量 {{ state.settings.webpQuality }}</span>
          <input v-model.number="state.settings.webpQuality" class="w-full accent-accent" type="range" min="10" max="100" />
        </label>
        <label class="field">
          <span class="field-label">锚点（Pivot，写入元数据）</span>
          <select v-model="state.settings.pivotMode" class="select w-full">
            <option value="center">中心</option>
            <option value="topleft">左上</option>
            <option value="topcenter">上中</option>
            <option value="bottomcenter">下中</option>
            <option value="bottomleft">左下</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <div v-if="state.settings.pivotMode === 'custom'" class="field-row">
          <label class="field">
            <span class="field-label">X (0-1)</span>
            <input v-model.number="state.settings.pivotX" class="input" type="number" min="0" max="1" step="0.05" />
          </label>
          <label class="field">
            <span class="field-label">Y (0-1)</span>
            <input v-model.number="state.settings.pivotY" class="input" type="number" min="0" max="1" step="0.05" />
          </label>
        </div>
        <label class="field">
          <span class="field-label">图集文件名</span>
          <input v-model="state.settings.name" class="input" type="text" spellcheck="false" placeholder="atlas" />
        </label>
        <label class="check-row"><input v-model="state.settings.withMetaJson" type="checkbox" /> 附带 JSON 元数据（哈希格式）</label>
        <label class="check-row"><input v-model="state.settings.withJsonArray" type="checkbox" /> 附带 JSON 元数据（数组格式）</label>
        <label class="check-row"><input v-model="state.settings.withAnimations" type="checkbox" /> JSON 附带命名动画分组</label>
        <label class="check-row"><input v-model="state.settings.withMetaPlist" type="checkbox" /> 附带 plist 元数据</label>
        <label class="check-row"><input v-model="state.settings.withCss" type="checkbox" /> 附带 CSS sprites 样式表</label>
      </div>

      <div class="section flex flex-col gap-2">
        <button class="btn btn-primary w-full justify-center" :disabled="!state.items.length || packing" @click="pack">
          {{ packing ? '打包中…' : '开始打包' }}
        </button>
        <button class="btn w-full justify-center" :disabled="state.status !== 'packed' || exporting" @click="exportZip">
          {{ exporting ? '导出中…' : '导出 ZIP' }}
        </button>
        <button class="btn btn-ghost w-full justify-center" :disabled="!state.items.length && !state.previewUrls.length" @click="resetAll">重置</button>
        <p v-if="state.error" class="text-caption text-danger">{{ state.error }}</p>
        <p v-for="(warning, index) in state.warnings" :key="index" class="text-caption text-faint">{{ warning }}</p>
      </div>
    </section>
  </div>
</template>


