<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { imageToImageData, loadImage, releaseCanvas } from '@/core/image'
import { canvasToBlob, downloadZip, type ZipEntry } from '@/core/media-export'
import {
  buildTiledJson,
  enumerateTiles,
  isEmptyTile,
  renderTileName,
  sliceTile,
  tileColumns,
  tileRows,
  type TileRect,
} from '@/core/tilemap'
import { resetTilemap, workspace } from '@/store/workspace'

/**
 * Tilemap 切片页。
 * 导入一张 tileset 图，按 tile 宽高 + 外边距 + 间距切分成单块 PNG，
 * 并导出 Tiled 兼容的 tileset JSON（含源 tileset 图，导入即用）。
 * 网格几何完全由 core/tilemap.ts 的 enumerateTiles 提供，预览、统计与导出共用同一份计算。
 */

const MAX_FILE_SIZE = 30 * 1024 * 1024
/** 切片预览上限：全量渲染上万个 dataURL 会拖垮界面，导出不受此限制 */
const PREVIEW_LIMIT = 120
/** 网格叠加画布的长边上限：仅作视觉参考，避免为几千像素的图申请大画布 */
const GRID_MAX_SIDE = 1200

const state = computed(() => workspace.tilemap)
const input = ref<HTMLInputElement>()
const gridCanvas = ref<HTMLCanvasElement>()
/** 已解码的源图，切片与像素判定共用一次解码 */
const sourceImage = ref<HTMLImageElement | null>(null)
/** 源图像素数据，仅在「跳过空白」开启时惰性读取 */
const pixelData = ref<ImageData | null>(null)
/** 实际参与导出的 tile（跳过空白后） */
const keptTiles = ref<TileRect[]>([])
/** 切片预览样本（前 PREVIEW_LIMIT 块） */
const previews = ref<Array<{ name: string; url: string }>>([])
const exporting = ref(false)

const hasSource = computed(() => Boolean(state.value.sourceUrl && state.value.image))

/** 基准名：文件名去掉扩展名 */
const baseName = computed(() => state.value.fileName.replace(/\.[^.]+$/, '') || 'tileset')

/** 网格几何：宽高非法时返回空，避免除零/死循环 */
const tiles = computed<TileRect[]>(() => {
  const image = state.value.image
  const options = state.value.options
  if (!image || options.tileW < 1 || options.tileH < 1) return []
  return enumerateTiles(image.width, image.height, options)
})

/** 网格列数（Tiled 描述用） */
const columns = computed(() => {
  const image = state.value.image
  return image && state.value.options.tileW >= 1 ? tileColumns(image.width, state.value.options) : 0
})

/** 网格行数（Tiled 描述用） */
const rows = computed(() => {
  const image = state.value.image
  return image && state.value.options.tileH >= 1 ? tileRows(image.height, state.value.options) : 0
})

/** 导入图片：校验类型与大小 → 解码 → 初始化尺寸 */
async function load(file?: File): Promise<void> {
  if (!file) return
  state.value.error = ''
  if (!file.type.startsWith('image/')) {
    state.value.error = '请选择 PNG / JPG / WebP 图片文件'
    return
  }
  if (file.size > MAX_FILE_SIZE) {
    state.value.error = '图片超过 30MB 限制'
    return
  }
  resetTilemap()
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url, '图片加载失败')
    sourceImage.value = image
    pixelData.value = null
    Object.assign(state.value, {
      fileName: file.name,
      sourceUrl: url,
      image: { width: image.naturalWidth, height: image.naturalHeight },
      status: 'ready',
    })
  } catch (error) {
    URL.revokeObjectURL(url)
    sourceImage.value = null
    state.value.error = error instanceof Error ? error.message : '图片加载失败'
    state.value.status = 'error'
  } finally {
    if (input.value) input.value.value = ''
  }
}

function onFileChange(e: Event): void {
  void load((e.target as HTMLInputElement).files?.[0])
}

/** 重算切片结果与预览样本（参数变化频繁，统一走防抖入口） */
function compute(): void {
  const rects = tiles.value
  if (!rects.length) {
    keptTiles.value = []
    previews.value = []
    state.value.tiles = 0
    void nextTick(drawGrid)
    return
  }
  const options = state.value.options
  // 跳过空白需要逐像素判定：首次用到时才读取，避免大图白白占用几十 MB
  if (options.skipEmpty && !pixelData.value && sourceImage.value) {
    pixelData.value = imageToImageData(sourceImage.value)
  }
  const data = pixelData.value
  const kept = options.skipEmpty && data
    ? rects.filter((rect) => !isEmptyTile(data, rect, options.alphaThreshold))
    : rects
  keptTiles.value = kept
  state.value.tiles = kept.length

  const image = sourceImage.value
  previews.value = image
    ? kept.slice(0, PREVIEW_LIMIT).map((rect) => ({
        name: renderTileName(options.pattern, baseName.value, rect),
        url: sliceTile(image, rect),
      }))
    : []
  state.value.status = 'done'
  void nextTick(drawGrid)
}

let computeTimer: number | undefined
function scheduleCompute(): void {
  window.clearTimeout(computeTimer)
  computeTimer = window.setTimeout(compute, 120)
}

/** 把网格线画到覆盖层：画布按源图比例缩到长边上限，再由 CSS 拉伸贴合图像显示尺寸 */
function drawGrid(): void {
  const canvas = gridCanvas.value
  const image = state.value.image
  if (!canvas || !image) return
  const scale = Math.min(1, GRID_MAX_SIDE / Math.max(image.width, image.height))
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 1
  for (const rect of keptTiles.value) {
    const x = rect.x * scale
    const y = rect.y * scale
    const w = Math.max(1, rect.w * scale)
    const h = Math.max(1, rect.h * scale)
    // 强调色琥珀 #e8a23d 的半透明填充与描边，与界面主题一致
    ctx.fillStyle = 'rgba(232, 162, 61, 0.08)'
    ctx.strokeStyle = 'rgba(232, 162, 61, 0.55)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(Math.floor(x) + 0.5, Math.floor(y) + 0.5, Math.max(1, w - 1), Math.max(1, h - 1))
  }
}

/** 源图或参数变化后重新切分（pattern 只影响命名，但仍需重建预览文件名） */
watch(() => [state.value.image, state.value.options], scheduleCompute, { deep: true })

/**
 * 热更新或页面切换导致组件重挂载时，store 中仍保留 sourceUrl，
 * 但本地解码缓存已丢失，需要重新解码并补算一次切片，避免停在空白工作区。
 */
watch(hasSource, async (value) => {
  if (!value) {
    sourceImage.value = null
    pixelData.value = null
    keptTiles.value = []
    previews.value = []
    return
  }
  if (sourceImage.value) return
  try {
    sourceImage.value = await loadImage(state.value.sourceUrl, 'Tilemap 源图加载失败')
    compute()
  } catch {
    state.value.error = '源图恢复失败，请重新导入'
  }
}, { immediate: true })

/** 源图统一转成 PNG Blob，供 ZIP 内的 Tiled tileset 直接引用 */
function imageToPngBlob(image: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return canvasToBlob(canvas).finally(() => releaseCanvas(canvas))
}

/**
 * 导出 ZIP：全部切片 PNG + 源 tileset 图 + Tiled 兼容 JSON。
 * 命名模板不足以区分 tile 时自动补下划线序号，避免同名互相覆盖。
 */
async function exportZip(): Promise<void> {
  const image = sourceImage.value
  if (!image || !keptTiles.value.length) return
  exporting.value = true
  state.value.error = ''
  try {
    const options = state.value.options
    const entries: ZipEntry[] = []
    const seen = new Map<string, number>()
    for (const rect of keptTiles.value) {
      const rendered = renderTileName(options.pattern, baseName.value, rect)
      let name = /\.png$/i.test(rendered) ? rendered : `${rendered}.png`
      const duplicated = seen.get(name) ?? 0
      seen.set(name, duplicated + 1)
      if (duplicated) name = name.replace(/\.png$/i, `_${duplicated}.png`)
      entries.push({ name, blob: sliceTile(image, rect) })
    }
    const pngName = `${baseName.value}.png`
    entries.push({ name: pngName, blob: await imageToPngBlob(image) })
    entries.push({
      name: `${baseName.value}.json`,
      blob: buildTiledJson(
        baseName.value,
        pngName,
        image.naturalWidth,
        image.naturalHeight,
        columns.value,
        rows.value,
        options,
      ),
    })
    await downloadZip(entries, `${baseName.value}-tileset.zip`)
  } catch (error) {
    state.value.error = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 重置整页：释放来源并清空本地缓存 */
function resetAll(): void {
  window.clearTimeout(computeTimer)
  sourceImage.value = null
  pixelData.value = null
  keptTiles.value = []
  previews.value = []
  resetTilemap()
}

onBeforeUnmount(() => window.clearTimeout(computeTimer))
</script>

<template>
  <div class="grid h-full min-h-0" :class="hasSource ? 'grid-cols-[280px_minmax(0,1fr)_320px]' : 'grid-cols-[minmax(0,1fr)_320px]'">
    <!-- 左栏：已导入 tileset 列表，未导入时整栏不显示 -->
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
          <h2 class="m-0 text-head">Tilemap 工作区</h2>
          <p class="mt-0.5 mb-0 text-faint">
            <template v-if="state.image">
              {{ state.image.width }}×{{ state.image.height }} px · {{ columns }} 列 × {{ rows }} 行
            </template>
            <template v-else>导入一张 tileset 图开始切分</template>
          </p>
        </div>
        <div class="flex items-center gap-3">
          <input ref="input" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="onFileChange" />
          <button class="btn btn-primary" @click="input?.click()">导入 tileset</button>
          <span v-if="keptTiles.length" class="badge badge-accent">{{ keptTiles.length }} 块已切出</span>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-6">
        <div v-if="!hasSource" class="empty-state">
          <span class="big">▦</span>
          <strong>还没有可切分的 tileset</strong>
          <span>导入一张规则排布的 tileset 图（PNG / JPG / WebP，≤ 30MB），设置单块尺寸与间距后导出切片与 Tiled JSON</span>
        </div>

        <template v-else>
          <section class="flex flex-col gap-3">
            <h3 class="m-0 text-caption font-semibold tracking-[0.06em] text-faint uppercase">网格预览</h3>
            <div class="flex justify-center">
              <div class="relative rounded-sm border border-line bg-stage outline-none">
                <img class="block max-h-[56vh] max-w-full object-contain select-none [image-rendering:pixelated]" :src="state.sourceUrl" alt="tileset 源图" draggable="false" />
                <canvas ref="gridCanvas" class="pointer-events-none absolute inset-0 size-full"></canvas>
              </div>
            </div>
            <p v-if="!tiles.length" class="muted">当前参数无法排出完整的整块网格，请调小单块尺寸或外边距。</p>
          </section>

          <section v-if="previews.length" class="flex flex-col gap-3">
            <h3 class="m-0 text-caption font-semibold tracking-[0.06em] text-faint uppercase">
              切片预览（前 {{ previews.length }} / {{ keptTiles.length }}）
            </h3>
            <div class="grid max-h-[42vh] gap-2 overflow-auto rounded-md border border-line bg-stage p-2 [grid-template-columns:repeat(auto-fill,minmax(88px,1fr))]">
              <figure v-for="tile in previews" :key="tile.name" class="m-0 flex min-w-0 flex-col items-center gap-1">
                <img class="size-14 rounded-sm border border-line bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-[length:10px_10px] object-contain [image-rendering:pixelated]" :src="tile.url" :alt="tile.name" draggable="false" />
                <figcaption class="mono max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-faint">{{ tile.name }}</figcaption>
              </figure>
            </div>
            <p v-if="keptTiles.length > previews.length" class="muted">
              仅预览前 {{ previews.length }} 块，导出仍包含全部 {{ keptTiles.length }} 块。
            </p>
          </section>
        </template>
      </div>
    </main>

    <!-- 右栏：配置、参数与导出 -->
    <section class="panel overflow-auto border-l border-line">
      <div class="section">
        <h2 class="section-title">Tilemap 切片</h2>
        <p class="muted">本地处理，不上传素材</p>
      </div>

      <div class="section">
        <h2 class="section-title">网格参数</h2>
        <div class="grid grid-cols-2 gap-x-3 gap-y-2 [&_.input]:w-full">
          <label class="field">
            <span class="field-label">单块宽</span>
            <input v-model.number="state.options.tileW" class="input" type="number" min="1" :disabled="!hasSource" />
          </label>
          <label class="field">
            <span class="field-label">单块高</span>
            <input v-model.number="state.options.tileH" class="input" type="number" min="1" :disabled="!hasSource" />
          </label>
          <label class="field">
            <span class="field-label">外边距</span>
            <input v-model.number="state.options.margin" class="input" type="number" min="0" :disabled="!hasSource" />
          </label>
          <label class="field">
            <span class="field-label">间距</span>
            <input v-model.number="state.options.spacing" class="input" type="number" min="0" :disabled="!hasSource" />
          </label>
          <label class="field">
            <span class="field-label">左上偏移 X</span>
            <input v-model.number="state.options.offsetX" class="input" type="number" min="0" :disabled="!hasSource" />
          </label>
          <label class="field">
            <span class="field-label">左上偏移 Y</span>
            <input v-model.number="state.options.offsetY" class="input" type="number" min="0" :disabled="!hasSource" />
          </label>
        </div>
        <p class="muted hint mt-3 mb-0 text-caption">列数 = ⌊(图宽 − 外边距×2 − 偏移 + 间距) / (单块宽 + 间距)⌋，行数同理。</p>
      </div>

      <div class="section [&>.check-row+.field]:mt-3 [&>.field+.field]:mt-3 [&>label+.muted]:mt-2 [&>.check-row+.muted]:mt-2 [&>p+.field]:mt-3">
        <h2 class="section-title">空白处理</h2>
        <label class="check-row"><input v-model="state.options.skipEmpty" type="checkbox" :disabled="!hasSource" /> 跳过全透明 tile</label>
        <label class="field">
          <span class="field-label">透明阈值（alpha ≤ 视为空白）</span>
          <input v-model.number="state.options.alphaThreshold" class="input" type="number" min="0" max="255" :disabled="!hasSource || !state.options.skipEmpty" />
        </label>
        <p class="muted">勾选后网格预览不再标出被跳过的块，导出也不包含它们。</p>
      </div>

      <div class="section">
        <h2 class="section-title">命名模板</h2>
        <input v-model="state.options.pattern" class="input mono w-full text-caption" type="text" spellcheck="false" :disabled="!hasSource" placeholder="{name}_{index}.png" />
        <p class="muted">占位符：{name} 基准名 · {index} 三位序号 · {seq} 序号 · {col} / {row} 行列号。重名会自动补序号。</p>
      </div>

      <div class="section flex flex-col gap-2">
        <button class="btn btn-primary w-full justify-center" :disabled="!keptTiles.length || exporting" @click="exportZip">
          {{ exporting ? '打包中…' : `导出 ZIP（${keptTiles.length} 块 + Tiled JSON）` }}
        </button>
        <button class="btn btn-ghost w-full justify-center" :disabled="!hasSource" @click="resetAll">重置</button>
        <p v-if="state.error" class="text-caption text-danger">{{ state.error }}</p>
      </div>
    </section>

  </div>
</template>

