<script setup lang="ts">
import TopBar from '@/components/TopBar.vue'
import FrameList from '@/components/FrameList.vue'
import CanvasStage from '@/components/CanvasStage.vue'
import Inspector from '@/components/Inspector.vue'
import PreviewPlayer from '@/components/PreviewPlayer.vue'
import { store, dismissError } from '@/store/atlas'
import MattePage from '@/components/MattePage.vue'
import VideoPage from '@/components/VideoPage.vue'
import { workspace } from '@/store/workspace'

const progressPct = () => {
  if (!store.progress || store.progress.total === 0) return 0
  return Math.round((store.progress.done / store.progress.total) * 100)
}
</script>

<template>
  <div class="app">
    <TopBar />
    <div v-if="workspace.page === 'atlas'" class="workspace">
      <aside class="rail panel">
        <FrameList />
      </aside>
      <main class="stage-col">
        <CanvasStage />
      </main>
      <aside class="inspector-col">
        <Inspector />
      </aside>
    </div>
    <PreviewPlayer v-if="workspace.page === 'atlas'" />
    <MattePage v-else-if="workspace.page === 'matte'" />
    <VideoPage v-else />

    <div class="progress-bar" v-if="store.progress" :style="{ width: progressPct() + '%' }"></div>
    <div class="toast-wrap">
      <div v-if="store.error" class="toast toast-error">
        <span>{{ store.error }}</span>
        <button class="toast-close" @click="dismissError()">×</button>
      </div>
      <div v-if="store.notice" class="toast">{{ store.notice }}</div>
    </div>
  </div>
</template>

<style scoped>
.rail {
  border-right: 1px solid var(--border);
  min-width: 0;
  overflow: hidden;
}

.stage-col {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.inspector-col {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.toast {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.toast-close {
  color: inherit;
  font-size: 16px;
  line-height: 1;
  opacity: 0.7;
}

.toast-close:hover {
  opacity: 1;
}
</style>
