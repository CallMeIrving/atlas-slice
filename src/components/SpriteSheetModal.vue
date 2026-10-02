<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cropFrame, type CropMode } from '@/core/crop'
import { store, orderedFrames, runExport } from '@/store/atlas'
import { naturalCompare } from '@/core/sort'
import { layoutSpriteFrames, type SpriteSheetLayout } from '@/core/spritesheet'

const emit = defineEmits<{ close: [] }>()

const scope = ref<'all' | 'selected'>('all')
const layout = ref<SpriteSheetLayout>('compact')
const mode = ref<CropMode>(store.mode)
const columns = ref(4)
const gap = ref(0)
const margin = ref(0)
const filename = ref('spritesheet')
const withMetaJson = ref(true)
const withMetaPlist = ref(false)
const sortMode = ref<'natural' | 'current'>('natural')
const cellWInput = ref(1)
const cellHInput = ref(1)
const cellSizeTouched = ref(false)
const previewRef = ref<HTMLCanvasElement>()

const frames = computed(() => {
  const source = scope.value === 'selected'
    ? orderedFrames.value.filter((frame) => store.selectedIds.includes(frame.id))
    : orderedFrames.value
  return sortMode.value === 'natural' ? [...source].sort((a, b) => naturalCompare(a.name, b.name)) : source
})

const frameW = computed(() =>
  Math.max(...frames.value.map((frame) => mode.value === 'content' ? frame.contentInFrame.w : frame.sourceSize.w), 1),
)
const frameH = computed(() =>
  Math.max(...frames.value.map((frame) => mode.value === 'content' ? frame.contentInFrame.h : frame.sourceSize.h), 1),
)
const padding = computed(() => Math.max(0, Math.round(store.padding)))
const autoCellW = computed(() => Math.max(1, Math.round(frameW.value + padding.value * 2)))
const autoCellH = computed(() => Math.max(1, Math.round(frameH.value + padding.value * 2)))
const cellW = computed(() => Math.max(1, Math.round(Number(cellWInput.value) || autoCellW.value)))
const cellH = computed(() => Math.max(1, Math.round(Number(cellHInput.value) || autoCellH.value)))
const spriteLayout = computed(() => layoutSpriteFrames(frames.value, {
  layout: layout.value,
  mode: mode.value,
  padding: padding.value,
  cellW: cellW.value,
  cellH: cellH.value,
  columns: Math.max(1, Math.round(columns.value)),
  gap: Math.max(0, Math.round(gap.value)),
  margin: Math.max(0, Math.round(margin.value)),
}))
const fits = computed(() => frames.value.every((frame) => {
  const w = mode.value === 'content' ? frame.contentInFrame.w + padding.value * 2 : frame.sourceSize.w + padding.value * 2
  const h = mode.value === 'content' ? frame.contentInFrame.h + padding.value * 2 : frame.sourceSize.h + padding.value * 2
  return w <= cellW.value && h <= cellH.value
}))
const rowCount = computed(() => layout.value === 'grid'
  ? Math.ceil(frames.value.length / Math.max(1, Math.round(columns.value)))
  : new Set(spriteLayout.value.placements.map((placement) => placement.y)).size)
const sheetW = computed(() => spriteLayout.value.width)
const sheetH = computed(() => spriteLayout.value.height)

watch([autoCellW, autoCellH], ([w, h]) => {
  if (!cellSizeTouched.value) {
    cellWInput.value = w
    cellHInput.value = h
  }
}, { immediate: true })

function drawPreview(): void {
  const canvas = previewRef.value
  const source = store.source
  if (!canvas) return
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (!width || !height) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const checker = document.createElement('canvas')
  checker.width = 16
  checker.height = 16
  const checkerCtx = checker.getContext('2d')!
  checkerCtx.fillStyle = '#101217'
  checkerCtx.fillRect(0, 0, 16, 16)
  checkerCtx.fillStyle = '#1a1d26'
  checkerCtx.fillRect(0, 0, 8, 8)
  checkerCtx.fillRect(8, 8, 8, 8)
  ctx.fillStyle = ctx.createPattern(checker, 'repeat')!
  ctx.fillRect(0, 0, width, height)

  if (!source || !frames.value.length) return
  const scale = Math.min((width - 20) / Math.max(1, sheetW.value), (height - 20) / Math.max(1, sheetH.value))
  const offsetX = (width - sheetW.value * scale) / 2
  const offsetY = (height - sheetH.value * scale) / 2
  ctx.save()
  ctx.translate(offsetX, offsetY)
  for (const placement of spriteLayout.value.placements) {
    const i = placement.index
    const frame = placement.frame
    const sprite = cropFrame(source, frame, { mode: mode.value, padding: padding.value })
    const cellX = placement.x * scale
    const cellY = placement.y * scale
    const cellWidth = placement.w * scale
    const cellHeight = placement.h * scale
    const spriteX = cellX + ((placement.w - sprite.width) * scale) / 2
    const spriteY = cellY + ((placement.h - sprite.height) * scale) / 2
    ctx.drawImage(sprite, spriteX, spriteY, sprite.width * scale, sprite.height * scale)
    ctx.strokeStyle = 'rgba(232, 162, 61, 0.55)'
    ctx.lineWidth = 1
    ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellWidth - 1, cellHeight - 1)
    if (scale > 0.35) {
      ctx.fillStyle = 'rgba(8, 10, 14, 0.78)'
      ctx.fillRect(cellX + 3, cellY + 3, 24, 16)
      ctx.fillStyle = '#f2b453'
      ctx.font = '11px sans-serif'
      ctx.fillText(String(i + 1), cellX + 7, cellY + 15)
    }
  }
  ctx.restore()
}

watch(
  [frames, layout, mode, cellW, cellH, columns, gap, margin, padding, sheetW, sheetH, spriteLayout],
  () => nextTick(drawPreview),
  { flush: 'post' },
)

onMounted(() => {
  nextTick(drawPreview)
})

onBeforeUnmount(() => {
  previewRef.value = undefined
})

async function apply(): Promise<void> {
  if (!frames.value.length || (layout.value === 'grid' && !fits.value)) return
  store.exportTarget = 'spritesheet'
  await runExport({
    scope: scope.value,
    layout: layout.value,
    mode: mode.value,
    padding: padding.value,
    cellW: cellW.value,
    cellH: cellH.value,
    columns: Math.max(1, Math.round(columns.value)),
    gap: Math.max(0, Math.round(gap.value)),
    margin: Math.max(0, Math.round(margin.value)),
    filename: filename.value.trim() || 'spritesheet',
    withMetaJson: withMetaJson.value,
    withMetaPlist: withMetaPlist.value,
  })
  if (!store.error) emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal w-[min(620px,calc(100vw-48px))] max-h-[calc(100vh-48px)] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="spritesheet-title">
      <div class="modal-head">
        <div>
          <h2 id="spritesheet-title">导出雪碧图</h2>
          <p class="faint">{{ layout === 'compact' ? '紧凑排列' : '固定网格布局' }} · {{ frames.length }} 帧 · 预计 {{ sheetW }}×{{ sheetH }} px</p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="modal-body [&_.field]:min-w-0">
        <div class="grid grid-cols-2 gap-x-4 gap-y-3">
          <label class="field">
            <span class="field-label">导出范围</span>
            <select v-model="scope" class="select">
              <option value="all">全部帧</option>
              <option value="selected">已勾选帧</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">排序</span>
            <select v-model="sortMode" class="select">
              <option value="natural">名称自然排序</option>
              <option value="current">当前帧序</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">布局方式</span>
            <select v-model="layout" class="select">
              <option value="compact">紧凑排列（推荐）</option>
              <option value="grid">固定网格</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">裁切模式</span>
            <select v-model="mode" class="select">
              <option value="content">实际内容</option>
              <option value="frame">原始帧尺寸</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">列数</span>
            <input v-model.number="columns" class="input" type="number" min="1" max="64" step="1" />
          </label>
          <label v-if="layout === 'grid'" class="field">
            <span class="field-label">单元格宽度</span>
            <div class="field-row"><input v-model.number="cellWInput" class="input" type="number" min="1" step="1" @input="cellSizeTouched = true" /><span class="faint mono">px</span></div>
          </label>
          <label v-if="layout === 'grid'" class="field">
            <span class="field-label">单元格高度</span>
            <div class="field-row"><input v-model.number="cellHInput" class="input" type="number" min="1" step="1" @input="cellSizeTouched = true" /><span class="faint mono">px</span></div>
          </label>
          <label class="field">
            <span class="field-label">单元格间距</span>
            <div class="field-row"><input v-model.number="gap" class="input" type="number" min="0" step="1" /><span class="faint mono">px</span></div>
          </label>
          <label class="field">
            <span class="field-label">外边距</span>
            <div class="field-row"><input v-model.number="margin" class="input" type="number" min="0" step="1" /><span class="faint mono">px</span></div>
          </label>
        </div>
        <div class="mt-4">
          <div class="mb-2 flex justify-between text-caption text-muted">
            <span>布局预览</span>
            <span class="faint mono">{{ sheetW }}×{{ sheetH }} px</span>
          </div>
          <div class="relative h-[220px] overflow-hidden rounded-sm border border-line bg-stage">
            <canvas ref="previewRef" class="block h-full w-full"></canvas>
            <span v-if="!frames.length" class="faint absolute inset-0 grid place-items-center">当前范围没有帧</span>
          </div>
        </div>
        <div class="my-4 flex flex-wrap gap-4 rounded-sm border border-line p-3 font-mono text-caption text-muted">
          <span>{{ layout === 'grid' ? `单元格 ${cellW}×${cellH}` : '按实际尺寸紧凑排列' }}</span>
          <span>{{ rowCount }} 行 × {{ Math.max(1, Math.round(columns)) }} 列</span>
          <span>背景：透明</span>
        </div>
        <label class="field mb-3">
          <span class="field-label">文件名</span>
          <input v-model="filename" class="input" type="text" spellcheck="false" />
        </label>
        <div class="flex gap-4">
          <label class="check-row"><input v-model="withMetaJson" type="checkbox" /> JSON 坐标</label>
          <label class="check-row"><input v-model="withMetaPlist" type="checkbox" /> plist 坐标</label>
        </div>
        <p v-if="!frames.length" class="hint text-danger">当前范围没有可导出的帧，请先勾选帧或切换为全部帧。</p>
        <p v-else-if="layout === 'grid' && !fits" class="hint text-danger">单元格尺寸小于至少一帧，请增大宽度或高度。</p>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn btn-primary" :disabled="!frames.length || (layout === 'grid' && !fits) || store.busy" @click="apply">导出雪碧图</button>
      </div>
    </section>
  </div>
</template>
