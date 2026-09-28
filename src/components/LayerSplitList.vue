<script setup lang="ts">
import { computed, ref } from 'vue'
import { downloadLayerPng, mergeLayers, moveLayer, raiseLayer } from '@/core/layer-split'
import { workspace, type LayerCategory, type SplitLayer } from '@/store/workspace'

/**
 * 图层列表。
 * 列表从上到下 = 前景到背景（z 降序），与服务端 layers 接口的升序相反：
 * 这里直接对应「图层面板」的心智模型，最上面的层盖住下面的。
 * 换序/合并都只改本地状态，要落到导出则用页面上的「导出 ZIP」。
 */
const props = defineProps<{ selected: string[] }>()
const emit = defineEmits<{ 'update:selected': [value: string[]]; reset: [] }>()

const CATEGORY_LABELS: Record<LayerCategory, string> = {
  button: '按钮',
  icon: '图标',
  text: '文本',
  panel: '面板',
  border: '边框',
  decoration: '装饰',
  progress: '进度条',
  background: '背景',
  other: '其它',
}

const draggingId = ref<string | null>(null)
const merging = ref(false)
const downloading = ref('')
const error = ref('')

const layers = computed(() => workspace.layersplit.layers)
const selectedSet = computed(() => new Set(props.selected))

function categoryLabel(category: LayerCategory): string {
  return CATEGORY_LABELS[category] ?? category
}

/** 合并层与「不做分割」的结果没有分数，显示占位而不是 0.00 */
function scoreText(score: number): string {
  return score > 0 ? score.toFixed(2) : '—'
}

/** 点击选中：默认单选，按住 Ctrl/⌘/Shift 逐个追加（连续多选在列表里更常用） */
function toggleSelect(id: string, event: MouseEvent): void {
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    emit(
      'update:selected',
      selectedSet.value.has(id) ? props.selected.filter((item) => item !== id) : [...props.selected, id],
    )
    return
  }
  emit('update:selected', props.selected.length === 1 && props.selected[0] === id ? [] : [id])
}

/** 拖拽换序：目标位置直接取被拖到的那一行的显示下标 */
function drop(targetId: string): void {
  const from = draggingId.value
  draggingId.value = null
  if (!from || from === targetId) return
  const to = layers.value.findIndex((layer) => layer.id === targetId)
  if (to < 0) return
  workspace.layersplit.layers = moveLayer(layers.value, from, to)
}

function raise(id: string, toTop: boolean): void {
  workspace.layersplit.layers = raiseLayer(layers.value, id, toTop)
}

/**
 * 合并选中：按 z 升序叠到一张与原图同尺寸的图上，结果插在最上面那个被合并层的原位。
 * 只保留一张新层，原来的层从列表移除；不再被引用的合并层 blob URL 立即释放。
 */
async function mergeSelection(): Promise<void> {
  const size = workspace.layersplit.image
  const ids = props.selected
  if (merging.value || !size) return
  const picked = layers.value.filter((layer) => ids.includes(layer.id))
  if (picked.length < 2) return
  merging.value = true
  error.value = ''
  try {
    const pngUrl = await mergeLayers(picked, { width: size.width, height: size.height })
    const x = Math.min(...picked.map((layer) => layer.alphaBbox.x))
    const y = Math.min(...picked.map((layer) => layer.alphaBbox.y))
    const w = Math.max(...picked.map((layer) => layer.alphaBbox.x + layer.alphaBbox.w)) - x
    const h = Math.max(...picked.map((layer) => layer.alphaBbox.y + layer.alphaBbox.h)) - y
    const merged: SplitLayer = {
      id: `M${Date.now().toString(36).toUpperCase()}`,
      name: `合并图层_${picked.length}`,
      label: '合并图层',
      category: 'other',
      score: 0,
      bbox: { x, y, w, h },
      alphaBbox: { x, y, w, h },
      area: w * h,
      z: 0,
      parentId: null,
      source: 'client-merge',
      text: null,
      pngUrl,
      visible: true,
      merged: true,
    }
    picked.filter((layer) => layer.merged).forEach((layer) => URL.revokeObjectURL(layer.pngUrl))
    const target = Math.min(...picked.map((layer) => layers.value.findIndex((item) => item.id === layer.id)))
    const rest = layers.value.filter((layer) => !ids.includes(layer.id))
    workspace.layersplit.layers = moveLayer([...rest, merged], merged.id, target)
    emit('update:selected', [merged.id])
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '合并失败'
  } finally {
    merging.value = false
  }
}

async function download(layer: SplitLayer): Promise<void> {
  downloading.value = layer.id
  error.value = ''
  try {
    await downloadLayerPng(layer)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '下载失败'
  } finally {
    downloading.value = ''
  }
}
</script>

<template>
  <section class="layer-panel panel">
    <div class="list-head">
      <h2 class="section-title">图层 <span class="badge">{{ layers.length }}</span></h2>
      <span class="muted">拖拽调整层序</span>
    </div>
    <div class="list-actions">
      <button class="btn" :disabled="selected.length < 2 || merging" @click="mergeSelection">
        {{ merging ? '合并中…' : `合并选中（${selected.length}）` }}
      </button>
      <button class="btn btn-ghost" title="清空结果，回到待拆分" @click="emit('reset')">重置</button>
    </div>
    <p v-if="error" class="warn">{{ error }}</p>

    <ul class="layer-list">
      <li
        v-for="(layer, index) in layers"
        :key="layer.id"
        class="layer-item"
        :class="{ active: selectedSet.has(layer.id), hidden: !layer.visible }"
        draggable="true"
        @dragstart="draggingId = layer.id"
        @dragover.prevent
        @drop.prevent="drop(layer.id)"
        @click="toggleSelect(layer.id, $event)"
      >
        <div class="row-main">
          <span class="layer-index mono">{{ index + 1 }}</span>
          <label class="layer-check" title="参与合成与导出" @click.stop>
            <input v-model="layer.visible" type="checkbox" />
          </label>
          <img class="thumb" :src="layer.pngUrl" :alt="layer.name" />
          <input v-model="layer.name" class="input name-input" maxlength="48" title="重命名（只影响导出的文件名）" @click.stop />
        </div>
        <div class="row-meta">
          <span class="faint mono">
            {{ categoryLabel(layer.category) }} · {{ layer.label }} · {{ scoreText(layer.score) }} ·
            {{ layer.alphaBbox.w }}×{{ layer.alphaBbox.h }}
          </span>
          <span class="row-spacer"></span>
          <button class="mini" title="置顶" @click.stop="raise(layer.id, true)">⇧</button>
          <button class="mini" title="置底" @click.stop="raise(layer.id, false)">⇩</button>
          <button class="mini" :disabled="downloading === layer.id" title="下载该层 PNG" @click.stop="download(layer)">⤓</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.layer-panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.list-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
}

.list-head .section-title {
  margin: 0;
}

.list-head .muted {
  flex: 1;
  font-size: var(--fs-caption);
  text-align: right;
}

.list-actions {
  flex: none;
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--sp-3) var(--sp-2);
}

.list-actions .btn {
  flex: 1;
  justify-content: center;
}

.layer-panel .warn {
  flex: none;
  margin: 0 var(--sp-3) var(--sp-2);
}

.layer-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0 var(--sp-2) var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.layer-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  cursor: pointer;
}

.layer-item:hover {
  background: var(--surface-hover);
}

.layer-item.active {
  background: var(--accent-dim);
  border-color: var(--accent-border);
}

.layer-item.hidden .thumb,
.layer-item.hidden .name-input {
  opacity: 0.4;
}

.row-main {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.layer-index {
  flex: none;
  width: 16px;
  color: var(--text-faint);
  font-size: var(--fs-caption);
  text-align: right;
}

.layer-check {
  flex: none;
  margin: 0;
  display: flex;
}

.layer-check input {
  accent-color: var(--accent);
}

.thumb {
  flex: none;
  width: 32px;
  height: 32px;
  object-fit: contain;
  background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 10px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
}

.name-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  font-size: var(--fs-caption);
}

.row-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding-left: 24px;
  font-size: var(--fs-caption);
}

.row-meta .faint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-spacer {
  flex: 1;
}

.mini {
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 3px;
  line-height: 1;
  font-size: 11px;
}

.mini:hover:not(:disabled) {
  color: var(--accent-strong);
  border-color: var(--accent-border);
}

.mini:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>