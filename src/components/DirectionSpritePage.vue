<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { buildAtlasJson } from '@/core/atlas-meta'
import {
  TRANSFORM_LABELS,
  defaultSlots,
  deriveBaseName,
  renderDirectionAtlas,
  type DirectionFrame,
  type DirectionSlot,
  type DirectionTransform,
  type FrameGroup,
  type ResolvedFrameGroup,
} from '@/core/direction-sprite'
import { loadImage } from '@/core/image'
import { downloadZip } from '@/core/media-export'
import { resetDirectionSprite, workspace } from '@/store/workspace'

/**
 * 多方向精灵页。
 * 导入一组或多组单方向动画帧（如正面组 + 背面组）→ 每个方向指定来源帧组与镜像/旋转变换
 * → 合成方向图集并导出。镜像只能派生左右，上/下与斜向需另配素材组，工具不会伪造画风。
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_FRAMES = 120

/** 变换选项（来源组与变换拆成两个下拉，来源组决定「用哪份素材」） */
const TRANSFORMS: DirectionTransform[] = ['none', 'mirrorX', 'mirrorY', 'rot180', 'rot90', 'rot270']

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
/** 待导入的目标帧组 id（导入按钮按组触发） */
const pendingGroupId = ref('')
/** 已解码帧缓存，key 为帧 id */
const images = new Map<string, HTMLImageElement>()
const previewUrl = ref('')
const exporting = ref(false)
let previewToken = 0

const totalFrames = computed(() => state.value.groups.reduce((sum, group) => sum + group.frames.length, 0))
const activeCount = computed(() => state.value.slots.filter((slot) => Boolean(slot.source)).length)
/** 有效方向中的最大帧数，决定图集列数与预览表头 */
const activeColumns = computed(() =>
  state.value.slots.reduce((max, slot) => {
    if (!slot.source) return max
    const group = state.value.groups.find((item) => item.id === slot.source)
    return Math.max(max, group?.frames.length ?? 0)
  }, 0),
)

/** 基准名：取第一组首帧名派生（walk_00 → walk），仅作为 zip/回退命名 */
const baseName = computed(() => {
  const first = state.value.groups[0]?.frames[0]?.name ?? ''
  return first ? deriveBaseName(first) : 'sprite'
})

/** 按文件名自然排序（数字段按数值比较），保证帧序符合直觉 */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function nextId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** 新建空帧组；首个组自动派生默认方向配置（右原样、左镜像） */
function addGroup(): void {
  const group: FrameGroup = { id: nextId(), name: `帧组 ${state.value.groups.length + 1}`, frames: [] }
  state.value.groups.push(group)
  if (state.value.groups.length === 1) {
    state.value.slots = defaultSlots(state.value.directionSet, group.id)
  }
}

/** 删除帧组：释放 blob URL、清理解码缓存，引用它的方向槽回到「未生成」 */
function removeGroup(groupId: string): void {
  const index = state.value.groups.findIndex((group) => group.id === groupId)
  if (index < 0) return
  state.value.groups[index].frames.forEach((frame) => {
    URL.revokeObjectURL(frame.url)
    images.delete(frame.id)
  })
  state.value.groups.splice(index, 1)
  state.value.slots.forEach((slot) => {
    if (slot.source === groupId) slot.source = null
  })
  if (!state.value.groups.length) {
    state.value.status = 'empty'
    previewUrl.value = ''
  }
}

/** 导入帧到指定帧组：按文件名排序后追加，任一失败整批回滚 */
async function importFiles(files: FileList | null): Promise<void> {
  const group = state.value.groups.find((item) => item.id === pendingGroupId.value)
  if (!files?.length || !group) return
  state.value.error = ''
  if (group.frames.length + files.length > MAX_FRAMES) {
    state.value.error = `每组帧数上限 ${MAX_FRAMES}，请分批处理`
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
    group.frames.push(...added)
    // 追加后重排整列，保证新导入的小序号帧排到前面
    group.frames.sort((a, b) => naturalCompare(a.name, b.name))
    state.value.status = 'ready'
  } catch (error) {
    createdUrls.forEach((url) => URL.revokeObjectURL(url))
    added.forEach((frame) => images.delete(frame.id))
    state.value.error = error instanceof Error ? error.message : '帧导入失败'
    state.value.status = state.value.groups.some((item) => item.frames.length) ? 'ready' : 'error'
  } finally {
    if (input.value) input.value.value = ''
  }
}

/** 触发指定帧组的文件选择（共享一个隐藏 input，先记录目标组） */
function pickFiles(groupId: string): void {
  pendingGroupId.value = groupId
  input.value?.click()
}

function onFileChange(e: Event): void {
  void importFiles((e.target as HTMLInputElement).files)
}

/** 移除组内一帧 */
function removeFrame(groupId: string, frameId: string): void {
  const group = state.value.groups.find((item) => item.id === groupId)
  if (!group) return
  const index = group.frames.findIndex((frame) => frame.id === frameId)
  if (index < 0) return
  URL.revokeObjectURL(group.frames[index].url)
  images.delete(frameId)
  group.frames.splice(index, 1)
  if (!totalFrames.value) {
    state.value.status = 'empty'
    previewUrl.value = ''
  }
}

/**
 * 切换方向集：重建为该方向集的默认配置（首组右原样、左镜像，其余未生成）。
 * 模板内不能写 TS 类型断言，取值与类型收敛都在这里完成。
 */
function onDirectionSetChange(e: Event): void {
  const value = Number((e.target as HTMLSelectElement).value)
  state.value.directionSet = value === 2 || value === 8 ? value : 4
  state.value.slots = defaultSlots(state.value.directionSet, state.value.groups[0]?.id ?? null)
}

/** 方向槽当前的来源组下拉值（空串 = 未生成） */
function slotSource(slot: DirectionSlot): string {
  return slot.source ?? ''
}

/** 方向槽来源组的帧序列（组不存在或未指定时为空） */
function slotFrames(slot: DirectionSlot): DirectionFrame[] {
  return state.value.groups.find((group) => group.id === slot.source)?.frames ?? []
}

/** 修改某个方向的来源帧组 */
function onSlotSourceChange(slot: DirectionSlot, e: Event): void {
  const value = (e.target as HTMLSelectElement).value
  slot.source = value || null
}

/** 修改某个方向的派生变换 */
function onSlotTransformChange(slot: DirectionSlot, e: Event): void {
  const value = (e.target as HTMLSelectElement).value as DirectionTransform
  if (TRANSFORMS.includes(value)) slot.transform = value
}

/** 热更新/切页重挂载后，从 store 的 blob URL 重新解码帧缓存；并补齐方向槽 */
watch(() => totalFrames.value, async (count) => {
  if (!count) { images.clear(); previewUrl.value = ''; return }
  if (images.size !== count) {
    images.clear()
    for (const group of state.value.groups) {
      for (const frame of group.frames) {
        try { images.set(frame.id, await loadImage(frame.url, '帧加载失败')) } catch { /* 单帧失败不影响其余 */ }
      }
    }
  }
  if (!state.value.slots.length) state.value.slots = defaultSlots(state.value.directionSet)
}, { immediate: true })

// 方向不再变化时（含未生成方向）也要同步一次，保证初次进入即有默认配置
if (!state.value.slots.length) state.value.slots = defaultSlots(state.value.directionSet)

/** 组装核心层需要的已解码帧组数组 */
function collectResolved(): ResolvedFrameGroup[] {
  return state.value.groups.map((group) => ({
    group,
    images: group.frames.map((frame) => images.get(frame.id)!),
  }))
}

/** 是否所有帧都已完成解码（未齐属于过渡态，跳过渲染） */
function allDecoded(): boolean {
  return images.size === totalFrames.value
}

/** 渲染方向图集预览（防抖，合并连续参数变化） */
let previewTimer: number | undefined
function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => void renderPreview(), 150)
}

async function renderPreview(): Promise<void> {
  const token = ++previewToken
  if (!totalFrames.value || !activeCount.value) {
    previewUrl.value = ''
    return
  }
  if (!allDecoded()) return
  try {
    const result = renderDirectionAtlas(baseName.value, collectResolved(), state.value.slots, {
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
    state.value.error = error instanceof Error ? error.message : '方向图集渲染失败'
  }
}

watch(
  () => [
    state.value.groups.map((group) => group.frames.map((frame) => frame.id)),
    state.value.padding,
    state.value.cellSize,
    JSON.stringify(state.value.slots.map((s) => [s.key, s.source, s.transform])),
  ],
  schedulePreview,
)

/** 导出方向图集 PNG + JSON 元数据 */
async function exportZip(): Promise<void> {
  if (!totalFrames.value || !activeCount.value) return
  exporting.value = true
  state.value.error = ''
  try {
    const result = renderDirectionAtlas(baseName.value, collectResolved(), state.value.slots, {
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
        <p class="muted">多组单方向帧 → 镜像/旋转派生多方向</p>
      </div>

      <div class="section">
        <h2 class="section-title">基准帧组</h2>
        <button class="btn btn-primary full" @click="addGroup">添加帧组</button>
        <input ref="input" hidden multiple type="file" accept="image/png,image/jpeg,image/webp" @change="onFileChange" />
        <p class="muted hint">每组导入同一方向、同一动作的逐帧序列；如正面组派生左/下，背面组派生上。建议命名 walk_00.png。</p>
        <div v-for="(group, gi) in state.groups" :key="group.id" class="group-card">
          <div class="group-head">
            <span class="mono faint">{{ gi + 1 }}</span>
            <input v-model="group.name" class="input group-name" type="text" placeholder="帧组名称" />
            <span class="mono faint">{{ group.frames.length }} 帧</span>
            <button class="btn btn-icon btn-danger" title="删除帧组" @click="removeGroup(group.id)">×</button>
          </div>
          <button class="btn btn-ghost full" @click="pickFiles(group.id)">导入帧（可多选）</button>
          <ul v-if="group.frames.length" class="frame-list">
            <li v-for="(frame, index) in group.frames" :key="frame.id" class="frame-row">
              <span class="mono faint">{{ String(index).padStart(2, '0') }}</span>
              <img class="frame-thumb" :src="frame.url" :alt="frame.name" draggable="false" />
              <span class="frame-name" :title="frame.name">{{ frame.name }}</span>
              <button class="btn btn-icon btn-danger" title="移除" @click="removeFrame(group.id, frame.id)">×</button>
            </li>
          </ul>
          <p v-else class="muted">尚未导入帧</p>
        </div>
        <p v-if="!state.groups.length" class="muted">尚未添加帧组</p>
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
        <p class="muted hint">切换方向集会重建配置：首个组派生右=原样、左=水平镜像，其余方向默认为「未生成」。</p>
      </div>

      <div class="section">
        <h2 class="section-title">方向配置</h2>
        <div v-for="slot in state.slots" :key="slot.key" class="slot-row" :class="{ off: !slot.source }">
          <span class="slot-dir">{{ slot.label }}</span>
          <select class="select slot-group" :value="slotSource(slot)" @change="onSlotSourceChange(slot, $event)">
            <option value="">未生成</option>
            <option v-for="group in state.groups" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select>
          <select
            class="select slot-transform"
            :value="slot.transform"
            :disabled="!slot.source"
            @change="onSlotTransformChange(slot, $event)"
          >
            <option v-for="transform in TRANSFORMS" :key="transform" :value="transform">
              {{ TRANSFORM_LABELS[transform] }}
            </option>
          </select>
        </div>
        <p class="muted hint">每个方向从所选帧组取帧再做变换：镜像/旋转适合对称素材，角色上/下方向请配正面、背面两组帧。</p>
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
        <button class="btn btn-primary full" :disabled="!totalFrames || !activeCount || exporting" @click="exportZip">
          {{ exporting ? '导出中…' : `导出方向图集（${activeCount} 方向 × ${activeColumns} 帧）` }}
        </button>
        <button class="btn btn-ghost full" :disabled="!state.groups.length" @click="resetAll">重置</button>
        <p v-if="state.error" class="error-text">{{ state.error }}</p>
      </div>
    </section>

    <main class="tool-main">
      <div class="tool-header">
        <div>
          <h2>方向工作区</h2>
          <p>
            <template v-if="state.groups.length">
              {{ state.groups.length }} 个帧组 · {{ activeCount }} 个方向 · {{ activeColumns }} 帧
              <span v-if="activeCount < state.slots.length"> · {{ state.slots.length - activeCount }} 个方向未生成</span>
            </template>
            <template v-else>添加帧组并导入单方向帧开始合成</template>
          </p>
        </div>
        <span v-if="previewUrl" class="badge badge-accent">已合成</span>
      </div>

      <div class="tool-body">
        <div v-if="!state.groups.length" class="empty-state">
          <span class="big">⊹</span>
          <strong>还没有可合成的帧</strong>
          <span>添加帧组并导入同一动作、同一方向的逐帧序列（PNG / JPG / WebP，单张 ≤ 20MB），再为各方向指定来源帧组与镜像或旋转</span>
        </div>

        <template v-else>
          <section class="ds-block">
            <h3 class="ds-block-title">方向 × 帧 预览</h3>
            <div class="ds-table-wrap">
              <table class="ds-table">
                <thead>
                  <tr>
                    <th class="ds-corner">方向</th>
                    <th v-for="index in activeColumns" :key="index" class="mono">{{ String(index - 1).padStart(2, '0') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="slot in state.slots" :key="slot.key" :class="{ off: !slot.source }">
                    <th class="ds-dir">{{ slot.label }}<span v-if="!slot.source" class="ds-tag">未生成</span></th>
                    <template v-if="slot.source">
                      <td v-for="index in activeColumns" :key="index" class="ds-cell">
                        <img
                          v-if="slotFrames(slot)[index - 1]"
                          :src="slotFrames(slot)[index - 1].url"
                          :alt="slotFrames(slot)[index - 1].name"
                          :style="{ transform: CSS_TRANSFORM[slot.transform] }"
                          draggable="false"
                        />
                        <span v-else class="ds-empty">—</span>
                      </td>
                    </template>
                    <template v-else>
                      <td v-for="index in activeColumns" :key="index" class="ds-cell">
                        <span class="ds-empty">—</span>
                      </td>
                    </template>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="ds-block">
            <h3 class="ds-block-title">合成结果</h3>
            <div class="ds-atlas">
              <img v-if="previewUrl" :src="previewUrl" alt="方向图集预览" draggable="false" />
              <p v-else class="muted">至少为一个方向指定来源帧组后即可预览</p>
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

/* 帧组卡片 */
.group-card { margin-top: var(--sp-3); padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius-m); display: flex; flex-direction: column; gap: var(--sp-2); }
.group-head { display: flex; align-items: center; gap: var(--sp-2); }
.group-name { flex: 1; min-width: 0; }

/* 帧列表 */
.frame-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); max-height: 220px; overflow: auto; }
.frame-row { display: flex; align-items: center; gap: var(--sp-2); }
.frame-thumb { width: 26px; height: 26px; flex: none; object-fit: contain; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--stage); }
.frame-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); }

/* 方向槽：来源组 + 变换 双下拉 */
.slot-row { display: flex; align-items: center; gap: var(--sp-2); }
.slot-row + .slot-row { margin-top: var(--sp-2); }
.slot-row.off .slot-dir { color: var(--text-faint); }
.slot-dir { width: 44px; flex: none; font-size: var(--fs-body); }
.slot-group { flex: 1; min-width: 0; }
.slot-transform { flex: 1; min-width: 0; }

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
