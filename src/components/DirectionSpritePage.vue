<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { buildAtlasJson } from '@/core/atlas-meta'
import {
  TRANSFORM_LABELS,
  defaultSlots,
  renderDirectionAtlas,
  type DirectionFrame,
  type DirectionSlot,
  type DirectionTransform,
} from '@/core/direction-sprite'
import { loadImage } from '@/core/image'
import { downloadZip } from '@/core/media-export'
import { resetDirectionSprite, workspace } from '@/store/workspace'

/**
 * 多方向精灵页。
 * 导入一组单方向动画帧 → 按方向配置（镜像/旋转）派生各方向 → 合成方向图集并导出。
 * 镜像只能派生左右，上/下与斜向需用户显式指定来源或变换，否则标为「未生成」。
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_FRAMES = 120

/** 方向的「来源 + 变换」选项，合并为一个下拉，避免两处状态不同步 */
interface SourceOption { value: string; source: 'base' | null; transform: DirectionTransform }
const SOURCE_OPTIONS: SourceOption[] = [
  { value: 'none', source: null, transform: 'none' },
  { value: 'base-none', source: 'base', transform: 'none' },
  { value: 'base-mx', source: 'base', transform: 'mirrorX' },
  { value: 'base-my', source: 'base', transform: 'mirrorY' },
  { value: 'base-r180', source: 'base', transform: 'rot180' },
  { value: 'base-r90', source: 'base', transform: 'rot90' },
  { value: 'base-r270', source: 'base', transform: 'rot270' },
]

/** 预览用的 CSS 变换，与核心层变换保持同一套语义 */
const CSS_TRANSFORM: Record<DirectionTransform, string> = {
  none: 'none',
  mirrorX: 'scaleX(-1)',
  mirrorY: 'scaleY(-1)',
  rot180: 'rotate(180deg)',
  rot90: 'rotate(90deg)',
  rot270: 'rotate(-90deg)',
}

const state = computed(() => workspace.directionsprite)
const input = ref<HTMLInputElement>()
/** 已解码帧缓存，key 为帧 id */
const images = new Map<string, HTMLImageElement>()
const previewUrl = ref('')
const exporting = ref(false)
let previewToken = 0

const activeCount = computed(() => state.value.slots.filter((slot) => Boolean(slot.source)).length)

/** 基准名：取首帧名去掉扩展名与尾部的帧号后缀（walk_00 → walk） */
const baseName = computed(() => {
  const first = state.value.frames[0]?.name ?? ''
  const base = first.replace(/\.[^.]+$/, '').replace(/[_-]?\d+$/, '')
  return base || 'sprite'
})

/** 按文件名自然排序（数字段按数值比较），保证帧序符合直觉 */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function nextId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** 导入基准帧序列：按文件名排序后追加，任一失败整批回滚 */
async function importFiles(files: FileList | null): Promise<void> {
  if (!files?.length) return
  state.value.error = ''
  if (state.value.frames.length + files.length > MAX_FRAMES) {
    state.value.error = `帧数上限 ${MAX_FRAMES}，请分批处理`
    return
  }
  const added: DirectionFrame[] = []
  const createdUrls: string[] = []
  try {
    for (const file of Array.from(files).sort((a, b) => naturalCompare(a.name, b.name))) {
      if (!file.type.startsWith('image/')) throw new Error(`「${file.name}」不是图片文件`)
      if (file.size > MAX_FILE_SIZE) throw new Error(`「${file.name}」超过 20MB 限制`)
      const url = URL.createObjectURL(file)
      createdUrls.push(url)
      const image = await loadImage(url, `「${file.name}」加载失败`)
      const id = nextId()
      images.set(id, image)
      added.push({ id, name: file.name, url })
    }
    state.value.frames.push(...added)
    // 追加后重排整列，保证新导入的小序号帧排到前面
    state.value.frames.sort((a, b) => naturalCompare(a.name, b.name))
    state.value.status = 'ready'
  } catch (error) {
    createdUrls.forEach((url) => URL.revokeObjectURL(url))
    added.forEach((frame) => images.delete(frame.id))
    state.value.error = error instanceof Error ? error.message : '帧导入失败'
    state.value.status = state.value.frames.length ? 'ready' : 'error'
  } finally {
    if (input.value) input.value.value = ''
  }
}

function onFileChange(e: Event): void {
  void importFiles((e.target as HTMLInputElement).files)
}

/** 移除一帧 */
function removeFrame(id: string): void {
  const index = state.value.frames.findIndex((frame) => frame.id === id)
  if (index < 0) return
  URL.revokeObjectURL(state.value.frames[index].url)
  images.delete(id)
  state.value.frames.splice(index, 1)
  if (!state.value.frames.length) {
    state.value.status = 'empty'
    previewUrl.value = ''
  }
}

/**
 * 切换方向集：重建为该方向集的默认配置（右原样、左镜像，其余未生成）。
 * 模板内不能写 TS 类型断言，取值与类型收敛都在这里完成。
 */
function onDirectionSetChange(e: Event): void {
  const value = Number((e.target as HTMLSelectElement).value)
  state.value.directionSet = value === 2 || value === 8 ? value : 4
  state.value.slots = defaultSlots(state.value.directionSet)
}

/** 方向槽当前对应的下拉值 */
function slotValue(slot: DirectionSlot): string {
  const found = SOURCE_OPTIONS.find((option) => option.source === slot.source && option.transform === slot.transform)
  return found ? found.value : 'none'
}

/** 修改某个方向的来源与变换 */
function onSlotChange(slot: DirectionSlot, e: Event): void {
  const option = SOURCE_OPTIONS.find((item) => item.value === (e.target as HTMLSelectElement).value)
  if (!option) return
  slot.source = option.source
  slot.transform = option.transform
}

/** 热更新/切页重挂载后，从 store 的 blob URL 重新解码帧缓存；并补齐方向槽 */
watch(() => state.value.frames.length, async (count) => {
  if (!count) { images.clear(); previewUrl.value = ''; return }
  if (images.size !== count) {
    images.clear()
    for (const frame of state.value.frames) {
      try { images.set(frame.id, await loadImage(frame.url, '帧加载失败')) } catch { /* 单帧失败不影响其余 */ }
    }
  }
  if (!state.value.slots.length) state.value.slots = defaultSlots(state.value.directionSet)
}, { immediate: true })

// 方向不再变化时（含未生成方向）也要同步一次，保证初次进入即有默认配置
if (!state.value.slots.length) state.value.slots = defaultSlots(state.value.directionSet)

/** 组装与帧序对齐的已解码图像数组 */
function collectImages(): HTMLImageElement[] {
  return state.value.frames.map((frame) => images.get(frame.id)!)
}

/** 渲染方向图集预览（防抖，合并连续参数变化） */
let previewTimer: number | undefined
function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => void renderPreview(), 150)
}

async function renderPreview(): Promise<void> {
  const token = ++previewToken
  if (!state.value.frames.length || !activeCount.value) {
    previewUrl.value = ''
    return
  }
  try {
    const result = renderDirectionAtlas(baseName.value, state.value.frames, collectImages(), state.value.slots, {
      padding: state.value.padding,
      cellSize: state.value.cellSize,
    })
    if (token !== previewToken) return
    previewUrl.value = result.url
    state.value.status = 'done'
    state.value.error = ''
  } catch (error) {
    if (token !== previewToken) return
    previewUrl.value = ''
    // 未解码完成属于过渡态，不当作错误打断界面
    if (!(error instanceof Error && error.message.includes('尚未解码'))) {
      state.value.error = error instanceof Error ? error.message : '方向图集渲染失败'
    }
  }
}

watch(
  () => [state.value.frames.length, state.value.padding, state.value.cellSize, JSON.stringify(state.value.slots.map((s) => [s.key, s.source, s.transform]))],
  schedulePreview,
)

/** 导出方向图集 PNG + JSON 元数据 */
async function exportZip(): Promise<void> {
  if (!state.value.frames.length || !activeCount.value) return
  exporting.value = true
  state.value.error = ''
  try {
    const result = renderDirectionAtlas(baseName.value, state.value.frames, collectImages(), state.value.slots, {
      padding: state.value.padding,
      cellSize: state.value.cellSize,
    })
    const pngName = `${baseName.value}.png`
    const entries = [
      { name: pngName, blob: result.url },
      { name: `${baseName.value}.json`, blob: buildAtlasJson(result.meta, { w: result.columns * result.cellSize, h: result.rows * result.cellSize }, pngName) },
    ]
    await downloadZip(entries, `${baseName.value}-directions.zip`)
  } catch (error) {
    state.value.error = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 重置整页 */
function resetAll(): void {
  window.clearTimeout(previewTimer)
  images.clear()
  previewUrl.value = ''
  resetDirectionSprite()
}
</script>

<template>
  <div class="tool-page">
    <section class="tool-sidebar panel">
      <div class="section">
        <h2 class="section-title">多方向精灵</h2>
        <p class="muted">单方向 → 镜像/旋转派生多方向</p>
      </div>

      <div class="section">
        <h2 class="section-title">基准帧序列</h2>
        <button class="btn btn-primary full" @click="input?.click()">导入帧（可多选）</button>
        <input ref="input" hidden multiple type="file" accept="image/png,image/jpeg,image/webp" @change="onFileChange" />
        <p class="muted hint">按文件名自然排序为帧序；建议命名如 walk_00.png、walk_01.png。</p>
        <ul v-if="state.frames.length" class="frame-list">
          <li v-for="(frame, index) in state.frames" :key="frame.id" class="frame-row">
            <span class="mono faint">{{ String(index).padStart(2, '0') }}</span>
            <img class="frame-thumb" :src="frame.url" :alt="frame.name" draggable="false" />
            <span class="frame-name" :title="frame.name">{{ frame.name }}</span>
            <button class="btn btn-icon btn-danger" title="移除" @click="removeFrame(frame.id)">×</button>
          </li>
        </ul>
        <p v-else class="muted">尚未导入帧</p>
      </div>

      <div class="section">
        <h2 class="section-title">方向集</h2>
        <label class="field">
          <span class="field-label">方向数量</span>
          <select :value="state.directionSet" class="select" @change="onDirectionSetChange">
            <option :value="2">2 向（右 / 左）</option>
            <option :value="4">4 向（下 / 左 / 右 / 上）</option>
            <option :value="8">8 向（含四对角）</option>
          </select>
        </label>
        <p class="muted hint">切换方向集会按默认规则重建配置：右=原样、左=水平镜像，其余方向默认为「未生成」。</p>
      </div>

      <div class="section">
        <h2 class="section-title">方向配置</h2>
        <div v-for="slot in state.slots" :key="slot.key" class="slot-row" :class="{ off: !slot.source }">
          <span class="slot-dir">{{ slot.label }}</span>
          <select class="select slot-select" :value="slotValue(slot)" @change="onSlotChange(slot, $event)">
            <option v-for="option in SOURCE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.value === 'none' ? '未生成' : TRANSFORM_LABELS[option.transform] }}
            </option>
          </select>
        </div>
        <p class="muted hint">水平镜像补左右；投射物/箭头可用旋转派生上/下与斜向。角色画风的上/下需另配素材，工具不会伪造。</p>
      </div>

      <div class="section">
        <h2 class="section-title">单元格</h2>
        <div class="field-row">
          <label class="field">
            <span class="field-label">留白</span>
            <input v-model.number="state.padding" class="input" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">边长（0 自动）</span>
            <input v-model.number="state.cellSize" class="input" type="number" min="0" />
          </label>
        </div>
      </div>

      <div class="section actions">
        <button class="btn btn-primary full" :disabled="!state.frames.length || !activeCount || exporting" @click="exportZip">
          {{ exporting ? '导出中…' : `导出方向图集（${activeCount} 方向 × ${state.frames.length} 帧）` }}
        </button>
        <button class="btn btn-ghost full" :disabled="!state.frames.length" @click="resetAll">重置</button>
        <p v-if="state.error" class="error-text">{{ state.error }}</p>
      </div>
    </section>

    <main class="tool-main">
      <div class="tool-header">
        <div>
          <h2>方向工作区</h2>
          <p>
            <template v-if="state.frames.length">
              {{ activeCount }} 个方向 · {{ state.frames.length }} 帧
              <span v-if="activeCount < state.slots.length"> · {{ state.slots.length - activeCount }} 个方向未生成</span>
            </template>
            <template v-else>导入一组单方向帧开始合成</template>
          </p>
        </div>
        <span v-if="previewUrl" class="badge badge-accent">已合成</span>
      </div>

      <div class="tool-body">
        <div v-if="!state.frames.length" class="empty-state">
          <span class="big">⊹</span>
          <strong>还没有可合成的帧</strong>
          <span>导入同一动作、同一方向的逐帧序列（PNG / JPG / WebP，单张 ≤ 20MB），再为各方向指定镜像或旋转</span>
        </div>

        <template v-else>
          <section class="ds-block">
            <h3 class="ds-block-title">方向 × 帧 预览</h3>
            <div class="ds-table-wrap">
              <table class="ds-table">
                <thead>
                  <tr>
                    <th class="ds-corner">方向</th>
                    <th v-for="(frame, index) in state.frames" :key="frame.id" class="mono">{{ String(index).padStart(2, '0') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="slot in state.slots" :key="slot.key" :class="{ off: !slot.source }">
                    <th class="ds-dir">{{ slot.label }}<span v-if="!slot.source" class="ds-tag">未生成</span></th>
                    <td v-for="frame in state.frames" :key="frame.id" class="ds-cell">
                      <img
                        v-if="slot.source"
                        :src="frame.url"
                        :alt="`${slot.label}-${frame.name}`"
                        :style="{ transform: CSS_TRANSFORM[slot.transform] }"
                        draggable="false"
                      />
                      <span v-else class="ds-empty">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="ds-block">
            <h3 class="ds-block-title">合成结果</h3>
            <div class="ds-atlas">
              <img v-if="previewUrl" :src="previewUrl" alt="方向图集预览" draggable="false" />
              <p v-else class="muted">至少为一个方向指定来源后即可预览</p>
            </div>
          </section>
        </template>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* 页面骨架与九宫格页同构：侧栏 + 主工作区 */
.tool-page { display: grid; grid-template-columns: 320px minmax(0, 1fr); height: 100%; min-height: 0; }
.tool-sidebar { border-right: 1px solid var(--border); overflow: auto; }
.tool-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tool-header { height: 64px; flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; border-bottom: 1px solid var(--border); }
.tool-header h2 { margin: 0; font-size: var(--fs-head); }
.tool-header p { margin: 2px 0 0; color: var(--text-faint); }
.tool-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-5); padding: 24px; }
.full { width: 100%; justify-content: center; }
.actions { display: flex; flex-direction: column; gap: var(--sp-2); }
.hint { margin: var(--sp-2) 0 0; font-size: var(--fs-caption); }
.section > .field + .field, .section > .field-row + .field { margin-top: var(--sp-3); }
.section > p + .field, .section > p + .field-row { margin-top: var(--sp-3); }
.field-row { display: flex; gap: var(--sp-3); margin-top: var(--sp-3); }
.field-row .field { flex: 1; min-width: 0; }
.field-row .input { width: 100%; }
.select { width: 100%; }
.error-text { color: var(--danger); font-size: var(--fs-caption); }

/* 帧列表 */
.frame-list { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); max-height: 220px; overflow: auto; }
.frame-row { display: flex; align-items: center; gap: var(--sp-2); }
.frame-thumb { width: 26px; height: 26px; flex: none; object-fit: contain; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--stage); }
.frame-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); }

/* 方向槽 */
.slot-row { display: flex; align-items: center; gap: var(--sp-2); }
.slot-row + .slot-row { margin-top: var(--sp-2); }
.slot-row.off .slot-dir { color: var(--text-faint); }
.slot-dir { width: 44px; flex: none; font-size: var(--fs-body); }
.slot-select { flex: 1; min-width: 0; }

/* 预览表格 */
.ds-block { display: flex; flex-direction: column; gap: var(--sp-3); }
.ds-block-title { margin: 0; font-size: var(--fs-caption); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-faint); }
.ds-table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-m); }
.ds-table { border-collapse: collapse; }
.ds-table th, .ds-table td { border: 1px solid var(--border); padding: 4px; text-align: center; }
.ds-table thead th { color: var(--text-faint); font-size: var(--fs-caption); position: sticky; top: 0; background: var(--surface); }
.ds-corner { position: sticky; left: 0; z-index: 2; }
.ds-dir { position: sticky; left: 0; z-index: 1; background: var(--surface); font-weight: 500; white-space: nowrap; padding: 4px 8px; }
.ds-tag { display: block; font-size: 10px; color: var(--text-faint); font-weight: 400; }
.ds-table tr.off .ds-dir { color: var(--text-faint); }
.ds-cell { width: 56px; height: 56px; background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 10px 10px; }
.ds-cell img { max-width: 48px; max-height: 48px; object-fit: contain; }
.ds-empty { color: var(--text-faint); }
.ds-atlas { display: grid; place-items: center; min-height: 180px; padding: var(--sp-3); border: 1px dashed var(--border); border-radius: var(--radius-s); background: var(--stage); }
.ds-atlas img { max-width: 100%; max-height: 56vh; object-fit: contain; image-rendering: pixelated; }

@media (max-width: 1100px) {
  .tool-page { grid-template-columns: 260px minmax(0, 1fr); }
}
</style>