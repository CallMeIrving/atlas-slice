<script setup lang="ts">
import { ref, computed } from 'vue'
import { store, loadImage, loadMetaFile, autoDetectFrames, runExport } from '@/store/atlas'

const imgInput = ref<HTMLInputElement>()
const metaInput = ref<HTMLInputElement>()

const statusText = computed(() => {
  const img = store.imageName || '未导入图片'
  const meta = store.metaFormat ? ` · ${store.metaFormat}` : store.frames.length ? ' · 自动识别' : ''
  return `${img} · ${store.frames.length} 帧${meta}`
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
      <span class="brand-mark">◧</span>
      <div>
        <h1>图集切片</h1>
        <p class="brand-sub">{{ statusText }}</p>
      </div>
    </div>
    <div class="topbar-actions">
      <input ref="imgInput" type="file" accept="image/*" hidden @change="onImage" />
      <input ref="metaInput" type="file" accept=".json,.plist,.xml,.txt" hidden @change="onMeta" />
      <button class="btn" :disabled="store.busy" @click="imgInput?.click()">导入图片</button>
      <button class="btn" :disabled="store.busy" @click="metaInput?.click()">导入元数据</button>
      <button class="btn" :disabled="!store.source || store.busy" @click="autoDetectFrames()">
        自动识别
      </button>
      <button
        class="btn btn-primary"
        :disabled="!store.source || store.frames.length === 0 || store.busy"
        @click="runExport()"
      >
        导出{{ store.frames.length ? `（${store.frames.length} 帧）` : '' }}
      </button>
    </div>
  </header>
</template>
