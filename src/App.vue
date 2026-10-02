<script setup lang="ts">
import TopBar from '@/components/TopBar.vue'
import FrameList from '@/components/FrameList.vue'
import CanvasStage from '@/components/CanvasStage.vue'
import Inspector from '@/components/Inspector.vue'
import PreviewPlayer from '@/components/PreviewPlayer.vue'
import { store, dismissError } from '@/store/atlas'
import MattePage from '@/components/MattePage.vue'
import VideoPage from '@/components/VideoPage.vue'
import WatermarkPage from '@/components/WatermarkPage.vue'
import LayerSplitPage from '@/components/LayerSplitPage.vue'
import NineSlicePage from '@/components/NineSlicePage.vue'
import PalettePage from '@/components/PalettePage.vue'
import AtlasPackPage from '@/components/AtlasPackPage.vue'
import DirectionSpritePage from '@/components/DirectionSpritePage.vue'
import TilemapPage from '@/components/TilemapPage.vue'
import AudioPage from '@/components/AudioPage.vue'
import FontPage from '@/components/FontPage.vue'
import OnionSkinPage from '@/components/OnionSkinPage.vue'
import ModelManagerModal from '@/components/ModelManagerModal.vue'
import { modelManager } from '@/store/model-status'
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
      <aside class="panel min-w-0 overflow-hidden border-r border-line">
        <FrameList />
      </aside>
      <main class="min-h-0 min-w-0 overflow-hidden">
        <CanvasStage />
      </main>
      <aside class="min-h-0 min-w-0 overflow-hidden">
        <Inspector />
      </aside>
    </div>
    <PreviewPlayer v-if="workspace.page === 'atlas'" />
    <MattePage v-else-if="workspace.page === 'matte'" />
    <VideoPage v-else-if="workspace.page === 'video'" />
    <WatermarkPage v-else-if="workspace.page === 'watermark'" />
    <LayerSplitPage v-else-if="workspace.page === 'layersplit'" />
    <NineSlicePage v-else-if="workspace.page === 'nineslice'" />
    <PalettePage v-else-if="workspace.page === 'palette'" />
    <AtlasPackPage v-else-if="workspace.page === 'atlaspack'" />
    <DirectionSpritePage v-else-if="workspace.page === 'directionsprite'" />
    <TilemapPage v-else-if="workspace.page === 'tilemap'" />
    <AudioPage v-else-if="workspace.page === 'audio'" />
    <FontPage v-else-if="workspace.page === 'font'" />
    <OnionSkinPage v-else-if="workspace.page === 'onion'" />
    <!-- 兜底：页面枚举与分支不同步时也不会整屏空白 -->
    <div v-else class="p-6 text-faint">未知页面</div>

    <ModelManagerModal v-if="modelManager.open" @close="modelManager.open = false" />

    <div class="progress-bar" v-if="store.progress" :style="{ width: progressPct() + '%' }"></div>
    <div class="toast-wrap">
      <div v-if="store.error" class="toast toast-error flex items-center gap-3">
        <span>{{ store.error }}</span>
        <button class="text-base leading-none opacity-70 hover:opacity-100" @click="dismissError()">×</button>
      </div>
      <div v-if="store.notice" class="toast">{{ store.notice }}</div>
    </div>
  </div>
</template>
