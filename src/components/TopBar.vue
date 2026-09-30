<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { store, loadImage, loadMetaFile, autoDetectFrames } from '@/store/atlas'
import { setPage, workspace, type LayerSplitState, type WatermarkState, type WorkspacePage } from '@/store/workspace'
import { modelManager } from '@/store/model-status'

/** 2D 工具下拉框条目：page 为 null 表示本期未实现（禁用展示） */
const TOOL_ENTRIES: { page: WorkspacePage | null; label: string }[] = [
  { page: 'nineslice', label: '九宫格切图' },
  { page: 'atlaspack', label: '雪碧图' },
  { page: 'palette', label: '调色板换色' },
  { page: 'tilemap', label: 'Tilemap 切片' },
  { page: null, label: '洋葱皮预览' },
  { page: 'directionsprite', label: '多方向精灵' },
]
/** 当前是否处于 2D 工具页；触发按钮据此显示模块名并高亮 */
const isToolPage = computed(() =>
  workspace.page === 'nineslice' || workspace.page === 'palette'
  || workspace.page === 'atlaspack' || workspace.page === 'directionsprite' || workspace.page === 'tilemap',
)
const toolLabel = computed(() => {
  const entry = TOOL_ENTRIES.find((item) => item.page === workspace.page)
  return entry ? entry.label : '2D 工具'
})

/** 去水印页的状态文案：该页没有数值型进度，用中文状态更直观 */
const WATERMARK_STATUS: Record<WatermarkState['status'], string> = {
  empty: '未导入',
  ready: '待处理',
  processing: '处理中',
  done: '已生成',
  error: '出错',
}
/** 图层拆分页的状态文案：离线时以连接状态优先，避免误以为是拆分本身出错 */
const LAYER_SPLIT_STATUS: Record<LayerSplitState['status'], string> = {
  empty: '未导入',
  ready: '待拆分',
  processing: '拆分中',
  done: '已拆分',
  error: '出错',
}
/** 非精灵图页的状态文案，各页展示自己的进度态 */
const pageStatus = computed(() => {
  if (workspace.page === 'matte') return workspace.matte.status
  if (workspace.page === 'video') return `${workspace.video.frames.length} 帧`
  if (workspace.page === 'layersplit') {
    return workspace.layersplit.serverOnline ? LAYER_SPLIT_STATUS[workspace.layersplit.status] : '服务离线'
  }
  if (workspace.page === 'nineslice') return workspace.nineslice.image ? '已导入' : '未导入'
  if (workspace.page === 'palette') {
    if (!workspace.palette.image) return '未导入'
    if (workspace.palette.status === 'processing') return `渲染中 ${Math.round(workspace.palette.progress * 100)}%`
    return `${workspace.palette.slots.length} 色槽 · ${workspace.palette.variants.length} 套变体`
  }
  if (workspace.page === 'atlaspack') {
    if (workspace.atlaspack.status !== 'packed') return `${workspace.atlaspack.items.length} 张素材`
    const pages = workspace.atlaspack.result?.length ?? 0
    const total = workspace.atlaspack.result?.reduce((sum, page) => sum + page.placements.length, 0) ?? 0
    return pages > 1 ? `${total} 处落位 · ${pages} 页` : `${total} 处落位`
  }
  if (workspace.page === 'directionsprite') {
    const frames = workspace.directionsprite.groups.reduce((sum, group) => sum + group.frames.length, 0)
    if (!frames) return '未导入'
    return `${workspace.directionsprite.groups.length} 组 ${frames} 帧 · ${workspace.directionsprite.slots.filter((slot) => slot.source).length} 方向`
  }
  if (workspace.page === 'tilemap') {
    return workspace.tilemap.image ? `${workspace.tilemap.tiles} 块` : '未导入'
  }
  return WATERMARK_STATUS[workspace.watermark.status]
})

const imgInput = ref<HTMLInputElement>()
const metaInput = ref<HTMLInputElement>()

/** 「2D 工具」下拉框展开状态 */
const toolsOpen = ref(false)

/** 选择 2D 工具：未实现的条目忽略，已实现的切页并收起菜单 */
function selectTool(page: WorkspacePage | null): void {
  if (!page) return
  setPage(page)
  toolsOpen.value = false
}

/** 点击下拉框外部时收起 */
function onDocClick(e: MouseEvent): void {
  if (!toolsOpen.value) return
  if (!(e.target as HTMLElement).closest('.tools-menu')) toolsOpen.value = false
}

/** Esc 收起下拉框 */
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && toolsOpen.value) toolsOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown)
})

async function onImage(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) await loadImage(file)
  ;(e.target as HTMLInputElement).value = ''
}

async function onMeta(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) await loadMetaFile(file)
  ;(e.target as HTMLInputElement).value = ''
}

defineExpose({})
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <img class="brand-mark" src="/assets/logo.png" alt="AtlasSlice" />
      <div>
        <h1>AtlasSlice</h1>
        <p class="brand-sub">本地动画素材处理工具</p>
      </div>
    </div>
    <nav class="page-nav" aria-label="功能页面">
      <button class="nav-item" :class="{ active: workspace.page === 'atlas' }" @click="setPage('atlas')">精灵图 <span v-if="store.frames.length" class="nav-count">{{ store.frames.length }}</span></button>
      <button class="nav-item" :class="{ active: workspace.page === 'matte' }" @click="setPage('matte')">抠图 <span v-if="workspace.matte.status === 'done'" class="nav-dot">●</span></button>
      <button class="nav-item" :class="{ active: workspace.page === 'video' }" @click="setPage('video')">视频帧 <span v-if="workspace.video.frames.length" class="nav-count">{{ workspace.video.frames.length }}</span></button>
      <button class="nav-item" :class="{ active: workspace.page === 'watermark' }" @click="setPage('watermark')">去水印 <span v-if="workspace.watermark.status === 'done'" class="nav-dot">●</span></button>
      <button class="nav-item" :class="{ active: workspace.page === 'layersplit' }" @click="setPage('layersplit')">图层拆分 <span v-if="workspace.layersplit.status === 'done'" class="nav-dot">●</span></button>
      <div class="tools-menu" @click.stop>
        <button class="nav-item" :class="{ active: isToolPage }" aria-haspopup="menu" :aria-expanded="toolsOpen" @click="toolsOpen = !toolsOpen">{{ toolLabel }} <span class="nav-caret">▾</span></button>
        <div v-if="toolsOpen" class="tools-dropdown" role="menu">
          <button
            v-for="entry in TOOL_ENTRIES"
            :key="entry.label"
            class="tools-option"
            :class="{ active: entry.page === workspace.page, disabled: !entry.page }"
            role="menuitem"
            :disabled="!entry.page"
            @click="selectTool(entry.page)"
          >
            <span>{{ entry.label }}</span>
            <span v-if="!entry.page" class="tools-soon">规划中</span>
          </button>
        </div>
      </div>
    </nav>
    <div class="topbar-actions">
      <input ref="imgInput" type="file" accept="image/*" hidden @change="onImage" />
      <input ref="metaInput" type="file" accept=".json,.plist,.xml,.txt" hidden @change="onMeta" />
      <button class="btn" @click="modelManager.open = true">模型管理</button>
      <template v-if="workspace.page === 'atlas'">
        <button class="btn" :disabled="store.busy" @click="imgInput?.click()">导入图片</button>
        <button class="btn" :disabled="store.busy" @click="metaInput?.click()">导入元数据</button>
        <button class="btn" :disabled="!store.source || store.busy" @click="autoDetectFrames()">
        自动识别
        </button>
      </template>
      <span v-else class="page-status">{{ pageStatus }}</span>
    </div>
  </header>
</template>

<style scoped>
.page-nav { display:flex; align-self:stretch; align-items:center; gap:4px; margin-left:16px; }
.nav-item { height:32px; padding:0 12px; color:var(--text-muted); border-radius:var(--radius-s); }
.nav-item:hover { color:var(--text); background:var(--surface-hover); }
.nav-item.active { color:var(--accent-strong); background:var(--accent-dim); }
.nav-count, .nav-dot { margin-left:4px; color:var(--accent); font:11px var(--font-mono); }
.page-status { color:var(--text-faint); font-size:var(--fs-caption); text-transform:uppercase; }
.tools-menu { position:relative; }
.nav-caret { margin-left:4px; font-size:10px; }
.tools-dropdown {
  position:absolute; top:calc(100% + 6px); left:0; z-index:30; min-width:160px;
  display:flex; flex-direction:column; gap:2px; padding:4px;
  background:var(--surface-raised, var(--surface)); border:1px solid var(--border);
  border-radius:var(--radius-m); box-shadow:0 8px 24px rgb(0 0 0 / 35%);
}
.tools-option {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  height:28px; padding:0 10px; color:var(--text-muted); border-radius:var(--radius-s); text-align:left;
}
.tools-option:hover:not(.disabled) { color:var(--text); background:var(--surface-hover); }
.tools-option.active { color:var(--accent-strong); background:var(--accent-dim); }
.tools-option.disabled { color:var(--text-faint); cursor:not-allowed; }
.tools-soon { font:11px var(--font-mono); opacity:.7; }
</style>
