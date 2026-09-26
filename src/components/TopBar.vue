<script setup lang="ts">
import { computed, ref } from 'vue'
import { store, loadImage, loadMetaFile, autoDetectFrames } from '@/store/atlas'
import { workspace, setPage, type WatermarkState } from '@/store/workspace'
import { modelManager } from '@/store/model-status'

/** 去水印页的状态文案：该页没有数值型进度，用中文状态更直观 */
const WATERMARK_STATUS: Record<WatermarkState['status'], string> = {
  empty: '未导入',
  ready: '待处理',
  processing: '处理中',
  done: '已生成',
  error: '出错',
}
/** 非精灵图页的状态文案，各页展示自己的进度态 */
const pageStatus = computed(() => {
  if (workspace.page === 'matte') return workspace.matte.status
  if (workspace.page === 'video') return `${workspace.video.frames.length} 帧`
  return WATERMARK_STATUS[workspace.watermark.status]
})

const imgInput = ref<HTMLInputElement>()
const metaInput = ref<HTMLInputElement>()

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
      <span class="brand-mark">◧</span>
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
</style>
