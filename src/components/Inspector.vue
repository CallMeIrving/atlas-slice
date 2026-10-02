<script setup lang="ts">
import { ref, computed } from 'vue'
import BatchResizeModal from '@/components/BatchResizeModal.vue'
import SpriteSheetModal from '@/components/SpriteSheetModal.vue'
import {
  store,
  selectedFrame,
  runExport,
  savePreset,
  loadPreset,
  deletePreset,
  persistExportSettings,
  deleteFrame,
} from '@/store/atlas'
import type { CropMode } from '@/core/crop'

const presetName = ref('')
const presetSelect = ref('')
const resizeOpen = ref(false)
const spriteOpen = ref(false)

const sel = computed(() => selectedFrame.value)

function setMode(mode: CropMode): void {
  store.mode = mode
  persistExportSettings()
}

function onSavePreset(): void {
  const name = presetName.value.trim()
  if (!name) return
  savePreset(name)
  presetName.value = ''
}

function onLoadPreset(): void {
  if (!presetSelect.value) return
  loadPreset(presetSelect.value)
}

function onDeletePreset(): void {
  if (!presetSelect.value) return
  deletePreset(presetSelect.value)
  presetSelect.value = ''
}

function onDeleteSelected(): void {
  if (store.selectedId) deleteFrame(store.selectedId)
}

function onExport(): void {
  if (store.exportTarget === 'spritesheet') spriteOpen.value = true
  else runExport()
}
</script>

<template>
  <div class="h-full overflow-y-auto border-l border-line bg-surface">
    <!-- 选中帧信息 -->
    <section class="section">
      <h2 class="section-title">选中帧</h2>
      <div v-if="!sel" class="muted frame-empty py-2 text-caption">在画布或列表中选中一帧查看详情</div>
      <dl
        v-else
        class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:overflow-hidden [&_dd]:text-right [&_dd]:text-ellipsis [&_dd]:whitespace-nowrap [&_dt]:text-faint"
      >
        <dt>名称</dt>
        <dd class="mono" :title="sel.name">{{ sel.name }}</dd>
        <dt>打包矩形</dt>
        <dd class="mono">{{ sel.rect.x }}, {{ sel.rect.y }} · {{ sel.rect.w }}×{{ sel.rect.h }}</dd>
        <dt>源帧尺寸</dt>
        <dd class="mono">{{ sel.sourceSize.w }}×{{ sel.sourceSize.h }}</dd>
        <dt>内容尺寸</dt>
        <dd class="mono">{{ sel.contentInFrame.w }}×{{ sel.contentInFrame.h }}</dd>
        <dt>属性</dt>
        <dd>
          <span v-if="sel.rotated" class="badge badge-accent">旋转</span>
          <span v-if="sel.trimmed" class="badge">已裁边</span>
          <span v-if="sel.manual" class="badge">手动</span>
          <span v-else class="badge">元数据</span>
        </dd>
      </dl>
      <div class="mt-3" v-if="sel">
        <button class="btn btn-danger" @click="onDeleteSelected()">删除此帧</button>
      </div>
    </section>

    <!-- 导出设置 -->
    <section class="section">
      <h2 class="section-title">导出设置</h2>
      <div class="field mb-3">
        <span class="field-label">导出类型</span>
        <select v-model="store.exportTarget" class="select">
          <option value="all">导出全部</option>
          <option value="selected">导出勾选</option>
          <option value="spritesheet">导出雪碧图</option>
        </select>
      </div>
      <div class="field mb-3">
        <span class="field-label">裁切模式</span>
        <div class="seg w-full">
          <button
            class="seg-item flex-1 justify-center"
            :class="{ active: store.mode === 'content' }"
            @click="setMode('content')"
          >
            实际内容
          </button>
          <button
            class="seg-item flex-1 justify-center"
            :class="{ active: store.mode === 'frame' }"
            @click="setMode('frame')"
          >
            原始帧尺寸
          </button>
        </div>
      </div>
      <div class="field mb-3">
        <span class="field-label">留边 padding</span>
        <div class="field-row">
          <input
            v-model.number="store.padding"
            class="input"
            type="number"
            min="0"
            max="128"
            @change="persistExportSettings()"
          />
          <span class="faint mono">px</span>
        </div>
      </div>
      <div class="field mb-3">
        <span class="field-label">命名模板</span>
        <input
          v-model="store.pattern"
          class="input"
          type="text"
          spellcheck="false"
          @change="persistExportSettings()"
        />
        <p class="hint faint mono mt-1 mb-0">支持 {name} 帧名 · {index} 序号(0001)</p>
      </div>
      <div class="field mb-3">
        <span class="field-label">目录（ZIP 内层级）</span>
        <input
          v-model="store.folder"
          class="input"
          type="text"
          spellcheck="false"
          placeholder="留空不建目录"
          @change="persistExportSettings()"
        />
      </div>
      <div class="check-group mt-2 mb-3 flex gap-4">
        <label class="check-row">
          <input v-model="store.withMetaJson" type="checkbox" @change="persistExportSettings()" />
          元数据 JSON
        </label>
        <label class="check-row">
          <input v-model="store.withMetaPlist" type="checkbox" @change="persistExportSettings()" />
          plist
        </label>
      </div>
      <button
        class="btn btn-primary export-btn h-[34px] w-full justify-center text-title"
        :disabled="!store.source || store.frames.length === 0 || store.busy || (store.exportTarget === 'selected' && store.selectedIds.length === 0)"
        @click="onExport()"
      >
        {{ store.progress ? `导出中 ${store.progress.done}/${store.progress.total}` : store.exportTarget === 'spritesheet' ? '设置并导出雪碧图' : '开始导出' }}
      </button>
    </section>

    <!-- 配置预设 -->
    <section class="section">
      <h2 class="section-title">配置预设</h2>
      <div v-if="store.presets.length" class="mb-2 flex gap-2">
        <select v-model="presetSelect" class="select preset-select min-w-0 flex-1">
          <option v-for="p in store.presets" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
        <button class="btn" @click="onLoadPreset()">载入</button>
        <button class="btn btn-danger" @click="onDeletePreset()">删</button>
      </div>
      <div class="mb-2 flex gap-2">
        <input
          v-model="presetName"
          class="input preset-select min-w-0 flex-1"
          type="text"
          placeholder="预设名称"
          spellcheck="false"
          @keyup.enter="onSavePreset()"
        />
        <button class="btn" @click="onSavePreset()">保存</button>
      </div>
    </section>

    <!-- 批量工具 -->
    <section class="section">
      <h2 class="section-title">批量工具</h2>
      <button
        class="btn"
        :disabled="store.selectedIds.length === 0 || store.busy"
        @click="resizeOpen = true"
      >
        统一选中帧尺寸<span v-if="store.selectedIds.length">（{{ store.selectedIds.length }}）</span>
      </button>
    </section>
  </div>
  <BatchResizeModal v-if="resizeOpen" @close="resizeOpen = false" />
  <SpriteSheetModal v-if="spriteOpen" @close="spriteOpen = false" />
</template>
