<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  store,
  selectedFrame,
  runExport,
  savePreset,
  loadPreset,
  deletePreset,
  persistExportSettings,
  deleteFrame,
  autoDetectFrames,
} from '@/store/atlas'
import type { CropMode } from '@/core/crop'

const presetName = ref('')
const presetSelect = ref('')

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
</script>

<template>
  <div class="inspector">
    <!-- 选中帧信息 -->
    <section class="section">
      <h2 class="section-title">选中帧</h2>
      <div v-if="!sel" class="muted frame-empty">在画布或列表中选中一帧查看详情</div>
      <dl v-else class="kv">
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
      <div class="row-actions" v-if="sel">
        <button class="btn btn-danger" @click="onDeleteSelected()">删除此帧</button>
      </div>
    </section>

    <!-- 导出设置 -->
    <section class="section">
      <h2 class="section-title">导出设置</h2>
      <div class="field">
        <span class="field-label">裁切模式</span>
        <div class="seg seg-wide">
          <button
            class="seg-item"
            :class="{ active: store.mode === 'content' }"
            @click="setMode('content')"
          >
            实际内容
          </button>
          <button
            class="seg-item"
            :class="{ active: store.mode === 'frame' }"
            @click="setMode('frame')"
          >
            原始帧尺寸
          </button>
        </div>
      </div>
      <div class="field">
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
      <div class="field">
        <span class="field-label">命名模板</span>
        <input
          v-model="store.pattern"
          class="input"
          type="text"
          spellcheck="false"
          @change="persistExportSettings()"
        />
        <p class="hint faint mono">支持 {name} 帧名 · {index} 序号(0001)</p>
      </div>
      <div class="field">
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
      <div class="check-group">
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
        class="btn btn-primary export-btn"
        :disabled="!store.source || store.frames.length === 0 || store.busy"
        @click="runExport()"
      >
        {{ store.progress ? `导出中 ${store.progress.done}/${store.progress.total}` : '开始导出' }}
      </button>
    </section>

    <!-- 配置预设 -->
    <section class="section">
      <h2 class="section-title">配置预设</h2>
      <div v-if="store.presets.length" class="preset-row">
        <select v-model="presetSelect" class="select preset-select">
          <option v-for="p in store.presets" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
        <button class="btn" @click="onLoadPreset()">载入</button>
        <button class="btn btn-danger" @click="onDeletePreset()">删</button>
      </div>
      <div class="preset-row">
        <input
          v-model="presetName"
          class="input preset-select"
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
      <button class="btn" :disabled="!store.source || store.busy" @click="autoDetectFrames()">
        重新自动识别全部帧
      </button>
      <p class="hint faint">将清空当前帧列表，按透明边缘重新拆分</p>
    </section>
  </div>
</template>

<style scoped>
.inspector {
  height: 100%;
  overflow-y: auto;
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.frame-empty {
  font-size: var(--fs-caption);
  padding: var(--sp-2) 0;
}

.kv {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  font-size: var(--fs-body);
}

.kv dt {
  color: var(--text-faint);
}

.kv dd {
  margin: 0;
  text-align: right;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-actions {
  margin-top: var(--sp-3);
}

.seg-wide {
  width: 100%;
}

.seg-wide .seg-item {
  flex: 1;
  justify-content: center;
}

.field {
  margin-bottom: var(--sp-3);
}

.field-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.hint {
  margin: 4px 0 0;
  font-size: var(--fs-caption);
}

.check-group {
  display: flex;
  gap: var(--sp-4);
  margin: var(--sp-2) 0 var(--sp-3);
}

.check-row {
  margin: 0;
}

.export-btn {
  width: 100%;
  justify-content: center;
  height: 34px;
  font-size: var(--fs-title);
}

.preset-row {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}

.preset-select {
  flex: 1;
  min-width: 0;
}
</style>
