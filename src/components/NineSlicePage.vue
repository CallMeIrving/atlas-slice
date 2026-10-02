<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { loadImage } from '@/core/image'
import { downloadZip } from '@/core/media-export'
import {
  NINE_SLICE_KEYS,
  buildNinePatch,
  buildNineSliceMeta,
  clampBorder,
  scaleBorder,
  sliceNineSlice,
  sliceNineSliceAtScale,
  type NineSliceBorder,
} from '@/core/nine-slice'
import { resetNineSlice, workspace } from '@/store/workspace'

/**
 * 九宫格（9-slice）切图页。
 * 导入一张 UI 图，拖动 4 条分割线确定四边距离，
 * 实时预览拉伸效果，导出 9 块带 alpha 的 PNG 与 TexturePacker 兼容的 border 元数据。
 */

/** 分割线标识：left/right 为竖线，top/bottom 为横线 */
type GuideLine = 'left' | 'right' | 'top' | 'bottom'

const GUIDE_LABELS: Record<GuideLine, string> = { left: '左边距', right: '右边距', top: '上边距', bottom: '下边距' }

/** 模板遍历用的分割线集合：竖直两条、水平两条 */
const VERTICAL_LINES: GuideLine[] = ['left', 'right']
const HORIZONTAL_LINES: GuideLine[] = ['top', 'bottom']
/** 四边距离输入框的展示顺序 */
const BORDER_LINES: GuideLine[] = ['top', 'left', 'right', 'bottom']

const input = ref<HTMLInputElement>()
const stage = ref<HTMLElement>()
/** 源图元素缓存：切块与读取尺寸共用一次解码 */
const sourceImage = ref<HTMLImageElement | null>(null)
/** 当前切块结果（key → PNG dataURL），border 提交后重算 */
const slices = ref<Record<string, string> | null>(null)
/** 选中的分割线（方向键微调的作用对象） */
const selected = ref<GuideLine | null>(null)
const exporting = ref(false)
const errorText = ref('')

/** 导出选项：多倍率切块与 Android .9.png */
const export2x = ref(false)
const export3x = ref(false)
const exportNinePatch = ref(false)

/** 切块文件命名模板：{name} 基础名 / {part} 块名 / {scale} 倍率标记（1x 为空，2x 为 @2x） */
const NAME_TEMPLATE_KEY = 'atlas-slice.nineslice.name-template'
const DEFAULT_NAME_TEMPLATE = '{name}{scale}_{part}.png'

/** 读取本地保存的命名模板，非法（缺 {part} 会撞名）回落到默认值 */
function loadNameTemplate(): string {
  try {
    const saved = localStorage.getItem(NAME_TEMPLATE_KEY)
    if (saved && saved.includes('{part}')) return saved
  } catch { /* localStorage 不可用时用默认值 */ }
  return DEFAULT_NAME_TEMPLATE
}

const nameTemplate = ref(loadNameTemplate())
watch(nameTemplate, (value) => {
  try { localStorage.setItem(NAME_TEMPLATE_KEY, value) } catch { /* 静默 */ }
})

/** 模板是否合法：必须同时含 {name} 与 {part}，否则多块导出会互相覆盖 */
const templateValid = computed(() => nameTemplate.value.includes('{name}') && nameTemplate.value.includes('{part}'))

/** 按倍率取 {scale} 的展开值 */
function scaleTag(scale: number): string {
  return scale === 1 ? '' : `@${scale}x`
}

/** 渲染单个切块文件名；模板非法时回落默认模板，保证导出不撞名 */
function renderSliceName(scale: number, part: string): string {
  const template = templateValid.value ? nameTemplate.value : DEFAULT_NAME_TEMPLATE
  return template
    .replace(/\{name\}/g, baseName.value)
    .replace(/\{scale\}/g, scaleTag(scale))
    .replace(/\{part\}/g, part)
}

/** 命名模板实时预览：展示 1x 与 @2x 的 center 块最终文件名 */
const templatePreview = computed(() => `${renderSliceName(1, 'center')} · ${renderSliceName(2, 'center')}`)

const state = computed(() => workspace.nineslice)
const hasSource = computed(() => Boolean(state.value.sourceUrl && state.value.image))
const border = computed(() => state.value.border)
const baseName = computed(() => state.value.fileName.replace(/\.[^.]+$/, '') || 'nine-slice')

/** 默认四边距离：各边取图像尺寸的 1/4（至少 1px），导入新图时套用 */
function defaultBorder(width: number, height: number): NineSliceBorder {
  return {
    left: Math.max(1, Math.round(width / 4)),
    right: Math.max(1, Math.round(width / 4)),
    top: Math.max(1, Math.round(height / 4)),
    bottom: Math.max(1, Math.round(height / 4)),
  }
}

/** 数值输入框 change：按输入值提交对应分割线 */
function onLineInput(line: GuideLine, e: Event): void {
  setLine(line, Number((e.target as HTMLInputElement).value))
}

/** 导入图片：校验大小 → 解码 → 初始化 border 与预览尺寸 */
async function load(file?: File): Promise<void> {
  if (!file) return
  errorText.value = ''
  if (file.size > 10 * 1024 * 1024) {
    errorText.value = '图片超过 10MB 限制'
    return
  }
  resetNineSlice()
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url, '图片加载失败')
    sourceImage.value = image
    Object.assign(state.value, {
      fileName: file.name,
      sourceUrl: url,
      image: { width: image.naturalWidth, height: image.naturalHeight },
      border: defaultBorder(image.naturalWidth, image.naturalHeight),
      previewSize: { width: image.naturalWidth * 2, height: image.naturalHeight * 2 },
      status: 'ready',
    })
  } catch (error) {
    URL.revokeObjectURL(url)
    errorText.value = error instanceof Error ? error.message : '图片加载失败'
  } finally {
    if (input.value) input.value.value = ''
  }
}

/** 文件选择控件变化后取第一个文件 */
function onFileChange(e: Event): void {
  const target = e.target as HTMLInputElement
  void load(target.files?.[0])
  target.value = ''
}

/** 提交新的四边距离：收敛到合法范围并作废切块结果（重算由 watch 触发） */
function commitBorder(next: NineSliceBorder): void {
  if (!state.value.image) return
  state.value.border = clampBorder(next, state.value.image.width, state.value.image.height)
}

/** 单条分割线变化：以当前 border 为基准替换对应边 */
function setLine(line: GuideLine, value: number): void {
  if (!border.value) return
  commitBorder({ ...border.value, [line]: value })
}

/** 拖拽分割线：overlay 与 img 渲染区重合，位移按「图像像素/显示像素」换算 */
let dragging: GuideLine | null = null
function startDrag(line: GuideLine, e: PointerEvent): void {
  if (!state.value.image || !border.value) return
  dragging = line
  selected.value = line
  e.preventDefault()
}

function onDragMove(e: PointerEvent): void {
  if (!dragging || !stage.value || !state.value.image || !border.value) return
  const rect = stage.value.getBoundingClientRect()
  const { width, height } = state.value.image
  const value = dragging === 'left' || dragging === 'right'
    ? Math.round(((e.clientX - rect.left) / rect.width) * width)
    : Math.round(((e.clientY - rect.top) / rect.height) * height)
  if (dragging === 'left') setLine('left', value)
  if (dragging === 'right') setLine('right', width - value)
  if (dragging === 'top') setLine('top', value)
  if (dragging === 'bottom') setLine('bottom', height - value)
}

function stopDrag(): void {
  dragging = null
}

/** 方向键微调选中的分割线（Shift 为 10px 步进，与精灵图页约定一致） */
function onKeydown(e: KeyboardEvent): void {
  if (!selected.value || !border.value || !state.value.image) return
  const step = e.shiftKey ? 10 : 1
  const vertical = selected.value === 'left' || selected.value === 'right'
  const delta = vertical ? (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0)
    : (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
  if (!delta) return
  e.preventDefault()
  setLine(selected.value, border.value[selected.value] + delta)
}

/** 分割线在 overlay 上的百分比定位（基于图像自然尺寸） */
function guideStyle(line: GuideLine): Record<string, string> {
  if (!state.value.image || !border.value) return {}
  const { width, height } = state.value.image
  if (line === 'left') return { left: `${(border.value.left / width) * 100}%` }
  if (line === 'right') return { left: `${((width - border.value.right) / width) * 100}%` }
  if (line === 'top') return { top: `${(border.value.top / height) * 100}%` }
  return { top: `${((height - border.value.bottom) / height) * 100}%` }
}

// border 变化后重算切块：拖拽期间用 rAF 节流，合并同一帧内的多次变更
let sliceToken = 0
let sliceQueued = false
watch(border, () => {
  if (sliceQueued || !state.value.sourceUrl || !border.value) return
  sliceQueued = true
  requestAnimationFrame(async () => {
    sliceQueued = false
    if (!state.value.sourceUrl || !border.value) return
    const token = ++sliceToken
    try {
      const result = await sliceNineSlice(sourceImage.value ?? state.value.sourceUrl, border.value)
      if (token !== sliceToken) return
      slices.value = result
      state.value.status = 'done'
    } catch {
      if (token === sliceToken) slices.value = null
    }
  })
}, { deep: true })

/** 预览自适应：按容器宽度等比缩放（轨道直接乘系数，不用 transform，避免溢出与坐标错位） */
const previewWrap = ref<HTMLElement>()
const wrapWidth = ref(0)
let resizeObserver: ResizeObserver | null = null
const previewScale = computed(() => {
  const total = state.value.previewSize.width
  if (!total || !wrapWidth.value) return 1
  return Math.min(1, wrapWidth.value / total)
})

/** 3×3 预览网格的列宽/行高：角块固定、中心块按 previewSize 拉伸，再统一乘以缩放系数 */
function trackPx(v: number): string {
  return `${Math.max(0, Math.round(v * previewScale.value))}px`
}
const gridCols = computed(() => {
  const b = border.value
  const size = state.value.previewSize
  if (!b) return '0px 0px 0px'
  return `${trackPx(b.left)} ${trackPx(size.width - b.left - b.right)} ${trackPx(b.right)}`
})
const gridRows = computed(() => {
  const b = border.value
  const size = state.value.previewSize
  if (!b) return '0px 0px 0px'
  return `${trackPx(b.top)} ${trackPx(size.height - b.top - b.bottom)} ${trackPx(b.bottom)}`
})

/**
 * 导出 ZIP：9 块 PNG + TexturePacker 兼容的 border 元数据 JSON。
 * 可选附加项：@2x / @3x 多倍率切块（带各自缩放后的 border 元数据）、
 * Android .9.png 补丁（原图加 1px 透明边与黑线标记）。
 */
async function exportZip(): Promise<void> {
  if (!border.value || !state.value.image || !slices.value) return
  exporting.value = true
  errorText.value = ''
  try {
    const { width, height } = state.value.image
    const entries = NINE_SLICE_KEYS
      .filter((key) => slices.value?.[key])
      .map((key) => ({ name: renderSliceName(1, key), blob: slices.value![key] }))
    const meta = buildNineSliceMeta(`${baseName.value}.png`, width, height, border.value)
    entries.push({ name: `${baseName.value}.json`, blob: JSON.stringify(meta, null, 2) })

    // 多倍率切块：按倍率放大整图后重新切分，元数据中的 border 同步缩放
    for (const scale of [2, 3]) {
      const enabled = scale === 2 ? export2x.value : export3x.value
      if (!enabled) continue
      const scaled = await sliceNineSliceAtScale(sourceImage.value ?? state.value.sourceUrl!, border.value, scale)
      NINE_SLICE_KEYS
        .filter((key) => scaled[key])
        .forEach((key) => entries.push({ name: renderSliceName(scale, key), blob: scaled[key] }))
      const scaledMeta = buildNineSliceMeta(
        `${baseName.value}${scaleTag(scale)}.png`,
        Math.round(width * scale),
        Math.round(height * scale),
        scaleBorder(border.value, scale, width, height),
      )
      entries.push({ name: `${baseName.value}${scaleTag(scale)}.json`, blob: JSON.stringify(scaledMeta, null, 2) })
    }

    // Android .9.png：文件名把扩展名前的 .png 替换为 .9.png
    if (exportNinePatch.value && sourceImage.value) {
      entries.push({
        name: `${baseName.value}.9.png`,
        blob: buildNinePatch(sourceImage.value, border.value),
      })
    }

    await downloadZip(entries, `${baseName.value}-nine-slice.zip`)
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 重置整页：释放来源并清空切块 */
function resetAll(): void {
  resetNineSlice()
  sourceImage.value = null
  slices.value = null
  selected.value = null
  errorText.value = ''
}

// 来源出现后再观察预览容器宽度：v-else 分支的元素挂载晚于 onMounted。
// immediate + 缓存恢复：热更新或页面切换导致组件重挂载时，store 里的 sourceUrl 仍在，
// 但本地解码缓存（sourceImage / slices）已丢失，需要重新解码并补算一次切块。
watch(hasSource, async (value) => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!value) return
  if (!sourceImage.value && state.value.sourceUrl) {
    try {
      sourceImage.value = await loadImage(state.value.sourceUrl, '九宫格源图加载失败')
      if (border.value) {
        slices.value = await sliceNineSlice(sourceImage.value, border.value)
        state.value.status = 'done'
      }
    } catch {
      errorText.value = '源图恢复失败，请重新导入'
    }
  }
  await nextTick()
  if (!previewWrap.value) return
  wrapWidth.value = previewWrap.value.clientWidth
  resizeObserver = new ResizeObserver((entries) => {
    wrapWidth.value = entries[0]?.contentRect.width ?? wrapWidth.value
  })
  resizeObserver.observe(previewWrap.value)
}, { immediate: true })

document.addEventListener('pointermove', onDragMove)
document.addEventListener('pointerup', stopDrag)
onBeforeUnmount(() => {
  document.removeEventListener('pointermove', onDragMove)
  document.removeEventListener('pointerup', stopDrag)
  resizeObserver?.disconnect()
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
          <h2 class="m-0 text-head">九宫格工作区</h2>
          <p class="mt-0.5 mb-0 text-faint">{{ state.image ? `${state.image.width}×${state.image.height} px · 分割线可拖动` : '导入一张 UI 图开始切分' }}</p>
        </div>
        <div class="flex items-center gap-3">
          <input ref="input" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="onFileChange" />
          <button class="btn btn-primary" @click="input?.click()">导入图片</button>
          <span v-if="slices" class="badge badge-accent">{{ NINE_SLICE_KEYS.filter((k) => slices?.[k]).length }} 块已切出</span>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <div v-if="!hasSource" class="empty-state">
          <span class="big">▦</span>
          <strong>还没有可切分的图片</strong>
          <span>导入一张游戏 UI 面板 / 按钮 / 气泡框图片（PNG / JPG / WebP，≤ 10MB）</span>
        </div>

        <div v-else class="grid grid-cols-2 items-start gap-4">
          <section class="flex min-w-0 flex-col gap-2">
            <h3 class="faint m-0 text-caption font-medium">原图与分割线</h3>
            <div class="relative self-center rounded-sm border border-line bg-stage outline-none focus:border-accent" tabindex="0" @keydown="onKeydown">
              <img class="block max-h-[52vh] max-w-full object-contain select-none" :src="state.sourceUrl" alt="九宫格源图" draggable="false" />
              <div ref="stage" class="absolute inset-0">
                <div
                  v-for="line in VERTICAL_LINES"
                  :key="line"
                  class="absolute inset-y-0 ml-[-3.5px] w-1.75 cursor-col-resize bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:ml-[-0.5px] after:w-px after:bg-accent after:opacity-85 after:content-[''] hover:after:opacity-100 hover:after:shadow-[0_0_0_1px_var(--accent-dim)]"
                  :class="selected === line && 'after:opacity-100 after:shadow-[0_0_0_1px_var(--accent-dim)]'"
                  :style="guideStyle(line)"
                  @pointerdown="startDrag(line, $event)"
                ></div>
                <div
                  v-for="line in HORIZONTAL_LINES"
                  :key="line"
                  class="absolute inset-x-0 mt-[-3.5px] h-1.75 cursor-row-resize bg-transparent after:absolute after:inset-x-0 after:top-1/2 after:mt-[-0.5px] after:h-px after:bg-accent after:opacity-85 after:content-[''] hover:after:opacity-100 hover:after:shadow-[0_0_0_1px_var(--accent-dim)]"
                  :class="selected === line && 'after:opacity-100 after:shadow-[0_0_0_1px_var(--accent-dim)]'"
                  :style="guideStyle(line)"
                  @pointerdown="startDrag(line, $event)"
                ></div>
              </div>
            </div>
          </section>

          <section class="flex min-w-0 flex-col gap-2">
            <h3 class="faint m-0 text-caption font-medium">拉伸预览（{{ state.previewSize.width }}×{{ state.previewSize.height }}）</h3>
            <div ref="previewWrap" class="flex justify-center overflow-hidden rounded-sm border border-dashed border-line bg-stage p-3">
              <div
                v-if="slices"
                class="grid"
                :style="{ gridTemplateColumns: gridCols, gridTemplateRows: gridRows }"
              >
                <img
                  v-for="key in NINE_SLICE_KEYS"
                  :key="key"
                  class="block size-full [image-rendering:auto]"
                  :src="slices[key]"
                  :alt="key"
                  draggable="false"
                />
              </div>
              <p v-else class="muted">切分计算中…</p>
            </div>
          </section>
        </div>
      </div>
    </main>

    <!-- 右栏：配置、参数与导出 -->
    <section class="panel overflow-auto border-l border-line">
      <div class="section">
        <h2 class="section-title">九宫格切图</h2>
        <p class="muted">本地处理，不上传素材</p>
      </div>

      <div class="section">
        <h2 class="section-title">四边距离（px）</h2>
        <div class="grid grid-cols-2 gap-x-3 gap-y-2 [&_.input]:w-full">
          <label v-for="line in BORDER_LINES" :key="line" class="field">
            <span class="field-label">{{ GUIDE_LABELS[line] }}</span>
            <input
              class="input"
              type="number"
              min="0"
              :value="border ? border[line] : 0"
              :disabled="!hasSource"
              @change="onLineInput(line, $event)"
              @focus="selected = line"
            />
          </label>
        </div>
        <p class="muted">拖动画布上的分割线，或点选数值框后用方向键微调（Shift 为 10px）。</p>
      </div>

      <div class="section">
        <h2 class="section-title">拉伸预览尺寸</h2>
        <div class="field-row [&_.field]:min-w-0 [&_.field]:flex-1 [&_.input]:min-w-0 [&_.input]:flex-1">
          <label class="field">
            <span class="field-label">宽</span>
            <input v-model.number="state.previewSize.width" class="input" type="number" min="1" :disabled="!hasSource" />
          </label>
          <label class="field">
            <span class="field-label">高</span>
            <input v-model.number="state.previewSize.height" class="input" type="number" min="1" :disabled="!hasSource" />
          </label>
        </div>
      </div>

      <div class="section [&>p+.field]:mt-3">
        <h2 class="section-title">导出选项</h2>
        <label class="check-row"><input v-model="export2x" type="checkbox" :disabled="!hasSource" /> @2x 多倍率切块</label>
        <label class="check-row"><input v-model="export3x" type="checkbox" :disabled="!hasSource" /> @3x 多倍率切块</label>
        <label class="check-row"><input v-model="exportNinePatch" type="checkbox" :disabled="!hasSource" /> Android .9.png</label>
        <p class="muted">倍率切块按整图放大后重新切分，并附带缩放后的 border 元数据；.9.png 以上下左右黑线标记拉伸区与内容区。</p>
        <label class="field">
          <span class="field-label">切块命名模板</span>
          <input v-model="nameTemplate" class="input w-full font-mono text-caption" type="text" spellcheck="false" placeholder="{name}{scale}_{part}.png" />
        </label>
        <p v-if="!templateValid" class="text-caption text-danger">模板需同时包含 {name} 与 {part}，否则文件会互相覆盖（导出时按默认模板处理）。</p>
        <p v-else class="muted">占位符：{name} 基础名 · {part} 块名 · {scale} 倍率（1x 为空）。预览：{{ templatePreview }}</p>
      </div>

      <div class="section flex flex-col gap-2">
        <button class="btn btn-primary w-full justify-center" :disabled="!slices || exporting" @click="exportZip">
          {{ exporting ? '打包中…' : '导出 ZIP（9 PNG + 元数据）' }}
        </button>
        <button class="btn btn-ghost w-full justify-center" :disabled="!hasSource" @click="resetAll">重置</button>
        <p v-if="errorText" class="text-caption text-danger">{{ errorText }}</p>
      </div>
    </section>

  </div>
</template>


