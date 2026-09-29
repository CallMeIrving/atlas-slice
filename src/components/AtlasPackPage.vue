<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { buildAtlasJson, buildPlist, type FrameMeta } from '@/core/atlas-meta'
import { loadImage } from '@/core/image'
import { downloadZip } from '@/core/media-export'
import { packItems, renderAtlas, type PackItem, type PackOptions } from '@/core/pack'
import { resetAtlasPack, workspace } from '@/store/workspace'

/**
 * 智能图集打包页。
 * 一次导入多张素材 → MaxRects 装箱成一张紧凑图集 → 导出 PNG + TexturePacker 兼容元数据。
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024

const state = computed(() => workspace.atlaspack)
const input = ref<HTMLInputElement>()
/** 解码后的素材缓存，key 为素材 id；不放进 store，避免响应式代理大对象 */
const images = new Map<string, HTMLImageElement>()
/** 最近一次成功打包产出的帧元数据，导出时直接复用 */
let packedMeta: Record<string, FrameMeta> | null = null

const packing = ref(false)
const exporting = ref(false)
/** 预览区悬停高亮的落位 id */
const hoverId = ref('')

/** 生成素材唯一 id */
function nextId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
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

/** 移除单个素材：同时释放 blob 与解码缓存 */
function removeItem(id: string): void {
  const index = state.value.items.findIndex((item) => item.id === id)
  if (index < 0) return
  URL.revokeObjectURL(state.value.items[index].url)
  images.delete(id)
  state.value.items.splice(index, 1)
  if (state.value.status === 'packed') invalidate()
}

/** 参数或素材变化后作废当前打包结果，强制重新打包 */
function invalidate(): void {
  state.value.status = state.value.items.length ? 'ready' : 'empty'
  state.value.result = null
  state.value.previewUrl = ''
  packedMeta = null
}

/** 参数变化即作废结果，避免展示与当前参数不符的旧图集 */
watch(() => state.value.settings, () => { if (state.value.status === 'packed') invalidate() }, { deep: true })

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

/** 当前打包参数 */
function packOptions(): PackOptions {
  const s = state.value.settings
  return {
    padding: s.padding, margin: s.margin, maxSize: s.maxSize,
    allowRotate: s.allowRotate, powerOfTwo: s.powerOfTwo,
    trim: s.trim, alphaThreshold: s.alphaThreshold,
  }
}

/** 执行打包：装箱 → 渲染图集 → 写入预览与落位结果 */
async function pack(): Promise<void> {
  if (!state.value.items.length || packing.value) return
  packing.value = true
  state.value.error = ''
  // 让出一次事件循环，先渲染「打包中…」状态
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    const items = collectPackItems()
    const result = packItems(items, packOptions())
    const rendered = renderAtlas(items, result, Math.max(0, Math.round(state.value.settings.padding)))
    packedMeta = rendered.meta
    state.value.result = {
      width: result.width,
      height: result.height,
      fillRatio: result.fillRatio,
      placements: result.placements.map((p) => ({
        id: p.id, name: p.name, x: p.x, y: p.y, w: p.w, h: p.h,
        rotated: p.rotated, trimmed: p.trimmed, sourceSize: { ...p.sourceSize },
      })),
    }
    state.value.previewUrl = rendered.url
    state.value.status = 'packed'
  } catch (error) {
    invalidate()
    state.value.error = error instanceof Error ? error.message : '打包失败'
    state.value.status = 'error'
  } finally {
    packing.value = false
  }
}

/** 导出 ZIP：图集 PNG + JSON（可选 plist），元数据不足时提示重新打包 */
async function exportZip(): Promise<void> {
  const result = state.value.result
  if (!result || !packedMeta || !state.value.previewUrl) return
  exporting.value = true
  state.value.error = ''
  try {
    const base = state.value.settings.name.trim() || 'atlas'
    const pngName = `${base}.png`
    const entries: Array<{ name: string; blob: Blob | string }> = [{ name: pngName, blob: state.value.previewUrl }]
    if (state.value.settings.withMetaJson) {
      entries.push({ name: `${base}.json`, blob: buildAtlasJson(packedMeta, { w: result.width, h: result.height }, pngName) })
    }
    if (state.value.settings.withMetaPlist) {
      entries.push({ name: `${base}.plist`, blob: buildPlist(packedMeta, { w: result.width, h: result.height }, pngName) })
    }
    await downloadZip(entries, `${base}.zip`)
  } catch (error) {
    state.value.error = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 窄屏与缩放无关：落位框按图集尺寸换算成百分比定位 */
function placementStyle(placement: { x: number; y: number; w: number; h: number }): Record<string, string> {
  const result = state.value.result
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
  images.clear()
  packedMeta = null
  hoverId.value = ''
  resetAtlasPack()
}
</script>

<template>
  <div class="tool-page">
    <section class="tool-sidebar panel">
      <div class="section">
        <h2 class="section-title">智能图集打包</h2>
        <p class="muted">MaxRects 装箱，本地处理不上传</p>
      </div>

      <div class="section">
        <h2 class="section-title">素材来源</h2>
        <button class="btn btn-primary full" @click="input?.click()">导入图片（可多选）</button>
        <input ref="input" hidden multiple type="file" accept="image/png,image/jpeg,image/webp" @change="onFileChange" />
        <ul v-if="state.items.length" class="pack-list">
          <li v-for="item in state.items" :key="item.id" class="pack-row">
            <img class="pack-thumb" :src="item.url" :alt="item.name" draggable="false" />
            <span class="pack-name" :title="item.name">{{ item.name }}</span>
            <span class="mono faint">{{ item.width }}×{{ item.height }}</span>
            <button class="btn btn-icon btn-danger" title="移除" @click="removeItem(item.id)">×</button>
          </li>
        </ul>
        <p v-else class="muted">尚未导入素材</p>
      </div>

      <div class="section">
        <h2 class="section-title">打包参数</h2>
        <label class="field">
          <span class="field-label">最大边长</span>
          <select v-model.number="state.settings.maxSize" class="select">
            <option :value="512">512 px</option>
            <option :value="1024">1024 px</option>
            <option :value="2048">2048 px</option>
            <option :value="4096">4096 px</option>
          </select>
        </label>
        <div class="field-row">
          <label class="field">
            <span class="field-label">素材留白</span>
            <input v-model.number="state.settings.padding" class="input" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">外边距</span>
            <input v-model.number="state.settings.margin" class="input" type="number" min="0" />
          </label>
        </div>
        <label class="check-row"><input v-model="state.settings.trim" type="checkbox" /> 裁掉透明边（trim）</label>
        <label v-if="state.settings.trim" class="field">
          <span class="field-label">裁剪 alpha 阈值 {{ state.settings.alphaThreshold }}</span>
          <input v-model.number="state.settings.alphaThreshold" class="range" type="range" min="1" max="64" />
        </label>
        <label class="check-row"><input v-model="state.settings.allowRotate" type="checkbox" /> 允许 90° 旋转以提升紧凑度</label>
        <label class="check-row"><input v-model="state.settings.powerOfTwo" type="checkbox" /> 宽高取 2 的幂</label>
        <p class="muted hint">自动从面积下界起搜索最紧凑的图集尺寸，命中即停。</p>
      </div>

      <div class="section">
        <h2 class="section-title">导出</h2>
        <label class="field">
          <span class="field-label">图集文件名</span>
          <input v-model="state.settings.name" class="input" type="text" spellcheck="false" placeholder="atlas" />
        </label>
        <label class="check-row"><input v-model="state.settings.withMetaJson" type="checkbox" /> 附带 JSON 元数据</label>
        <label class="check-row"><input v-model="state.settings.withMetaPlist" type="checkbox" /> 附带 plist 元数据</label>
      </div>

      <div class="section actions">
        <button class="btn btn-primary full" :disabled="!state.items.length || packing" @click="pack">
          {{ packing ? '打包中…' : '开始打包' }}
        </button>
        <button class="btn full" :disabled="state.status !== 'packed' || exporting" @click="exportZip">
          {{ exporting ? '导出中…' : '导出 ZIP' }}
        </button>
        <button class="btn btn-ghost full" :disabled="!state.items.length && !state.previewUrl" @click="resetAll">重置</button>
        <p v-if="state.error" class="error-text">{{ state.error }}</p>
      </div>
    </section>

    <main class="tool-main">
      <div class="tool-header">
        <div>
          <h2>图集工作区</h2>
          <p>
            <template v-if="state.result">
              {{ state.items.length }} 张 → {{ state.result.width }}×{{ state.result.height }} px · 填充率 {{ (state.result.fillRatio * 100).toFixed(1) }}%
            </template>
            <template v-else>导入多张素材后点击「开始打包」</template>
          </p>
        </div>
        <span v-if="state.status === 'packed'" class="badge badge-accent">{{ state.result?.placements.length }} 处落位</span>
      </div>

      <div class="tool-body">
        <div v-if="!state.previewUrl" class="empty-state">
          <span class="big">▤</span>
          <strong>还没有可打包的素材</strong>
          <span>一次导入多张角色帧 / 道具 / 图标（PNG / JPG / WebP，单张 ≤ 20MB），自动装箱成一张图集</span>
        </div>

        <div v-else class="pack-preview-wrap">
          <div class="pack-preview">
            <img class="pack-image" :src="state.previewUrl" alt="打包结果" draggable="false" />
            <div class="pack-overlay">
              <div
                v-for="placement in state.result?.placements ?? []"
                :key="placement.id"
                class="pack-cell"
                :class="{ active: hoverId === placement.id }"
                :style="placementStyle(placement)"
                :title="`${placement.name} · ${placement.sourceSize.w}×${placement.sourceSize.h}${placement.rotated ? ' · 已旋转' : ''}`"
                @mouseenter="hoverId = placement.id"
                @mouseleave="hoverId = ''"
              ></div>
            </div>
          </div>
          <p v-if="hoverId" class="muted mono">
            {{ state.result?.placements.find((p) => p.id === hoverId)?.name }}
          </p>
        </div>
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
.tool-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding: 24px; }
.full { width: 100%; justify-content: center; }
.actions { display: flex; flex-direction: column; gap: var(--sp-2); }
.hint { margin: var(--sp-1) 0 0; font-size: var(--fs-caption); }
/* 只给直接堆叠在 section 下的字段加间距，网格/行内布局由 gap 控制，避免误加 margin 造成错位 */
.section > .field + .field, .section > .check-row + .check-row, .section > .check-row + .field { margin-top: var(--sp-3); }
.section > p + .field, .section > p + .check-row { margin-top: var(--sp-3); }
.field-row { display: flex; gap: var(--sp-3); margin-top: var(--sp-3); }
.field-row .field { flex: 1; min-width: 0; }
.field-row .input { width: 100%; }
.range { width: 100%; accent-color: var(--accent); }
.select { width: 100%; }
.error-text { color: var(--danger); font-size: var(--fs-caption); }

/* 素材列表 */
.pack-list { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); max-height: 240px; overflow: auto; }
.pack-row { display: flex; align-items: center; gap: var(--sp-2); }
.pack-thumb { width: 26px; height: 26px; flex: none; object-fit: contain; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--stage); }
.pack-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); }

/* 结果预览：img 与 overlay 共用同一盒模型，落位按百分比定位 */
.pack-preview-wrap { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); }
.pack-preview { position: relative; display: inline-block; line-height: 0; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--stage); }
.pack-image { display: block; max-width: 100%; max-height: 62vh; object-fit: contain; }
.pack-overlay { position: absolute; inset: 0; }
.pack-cell { position: absolute; border: 1px solid transparent; transition: background 0.1s, border-color 0.1s; }
.pack-cell:hover, .pack-cell.active { border-color: var(--accent); background: var(--accent-dim); }

@media (max-width: 1100px) {
  .tool-page { grid-template-columns: 260px minmax(0, 1fr); }
}
</style>