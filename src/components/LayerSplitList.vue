<script setup lang="ts">
import { computed, ref } from 'vue'
import { downloadLayerPng, mergeLayers, moveLayer, raiseLayer } from '@/core/layer-split'
import { workspace, type LayerCategory, type SplitLayer } from '@/store/workspace'
import LayerPreviewModal from '@/components/LayerPreviewModal.vue'

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
/** 大图查看中的图层 id；空串表示弹窗关闭 */
const previewId = ref('')

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
  <section class="panel flex min-h-0 min-w-0 flex-col overflow-hidden">
    <div class="flex flex-none items-center gap-2 px-3 pt-3 pb-2">
      <h2 class="section-title m-0">图层 <span class="badge">{{ layers.length }}</span></h2>
      <span class="muted flex-1 text-right text-caption">拖拽调整层序</span>
    </div>
    <div class="flex flex-none gap-2 px-3 pb-2">
      <button class="btn flex-1 justify-center" :disabled="selected.length < 2 || merging" @click="mergeSelection">
        {{ merging ? '合并中…' : `合并选中（${selected.length}）` }}
      </button>
      <button class="btn btn-ghost flex-1 justify-center" title="清空结果，回到待拆分" @click="emit('reset')">重置</button>
    </div>
    <p v-if="error" class="warn mx-3 flex-none">{{ error }}</p>

    <ul class="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto px-2 pb-2">
      <li
        v-for="(layer, index) in layers"
        :key="layer.id"
        class="flex cursor-pointer flex-col gap-0.5 rounded-sm border border-transparent px-1.5 py-1 hover:bg-hover"
        :class="[
          selectedSet.has(layer.id) ? 'border-accent-border bg-accent-dim' : '',
          !layer.visible ? '[&_.thumb]:opacity-40 [&_.name-input]:opacity-40' : '',
        ]"
        draggable="true"
        @dragstart="draggingId = layer.id"
        @dragover.prevent
        @drop.prevent="drop(layer.id)"
        @click="toggleSelect(layer.id, $event)"
      >
        <div class="flex min-w-0 items-center gap-2">
          <span class="mono w-4 flex-none text-right text-faint">{{ index + 1 }}</span>
          <label class="m-0 flex flex-none" title="参与合成与导出" @click.stop>
            <input v-model="layer.visible" class="accent-accent" type="checkbox" />
          </label>
          <img
            class="size-8 flex-none rounded-[3px] border border-line object-contain bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-[length:10px_10px]"
            :src="layer.pngUrl"
            :alt="layer.name"
            title="双击查看大图"
            @dblclick.stop="previewId = layer.id"
          />
          <input v-model="layer.name" class="input h-[26px] min-w-0 flex-1 text-caption" maxlength="48" title="重命名（只影响导出的文件名）" @click.stop />
        </div>
        <div class="flex items-center gap-1 pl-6 text-caption">
          <span class="faint mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {{ categoryLabel(layer.category) }} · {{ layer.label }} · {{ scoreText(layer.score) }} ·
            {{ layer.alphaBbox.w }}×{{ layer.alphaBbox.h }}
          </span>
          <span class="flex-1"></span>
          <button class="size-5 flex-none rounded-[3px] border border-line text-[11px] leading-none text-faint enabled:hover:border-accent-border enabled:hover:text-accent-strong disabled:cursor-not-allowed disabled:opacity-35" title="查看大图" @click.stop="previewId = layer.id">⤢</button>
          <button class="size-5 flex-none rounded-[3px] border border-line text-[11px] leading-none text-faint enabled:hover:border-accent-border enabled:hover:text-accent-strong disabled:cursor-not-allowed disabled:opacity-35" title="置顶" @click.stop="raise(layer.id, true)">⇧</button>
          <button class="size-5 flex-none rounded-[3px] border border-line text-[11px] leading-none text-faint enabled:hover:border-accent-border enabled:hover:text-accent-strong disabled:cursor-not-allowed disabled:opacity-35" title="置底" @click.stop="raise(layer.id, false)">⇩</button>
          <button class="size-5 flex-none rounded-[3px] border border-line text-[11px] leading-none text-faint enabled:hover:border-accent-border enabled:hover:text-accent-strong disabled:cursor-not-allowed disabled:opacity-35" :disabled="downloading === layer.id" title="下载该层 PNG" @click.stop="download(layer)">⤓</button>
        </div>
      </li>
    </ul>
    <LayerPreviewModal
      v-if="previewId"
      :layers="layers"
      :current-id="previewId"
      @update:current-id="previewId = $event"
      @close="previewId = ''"
    />
  </section>
</template>