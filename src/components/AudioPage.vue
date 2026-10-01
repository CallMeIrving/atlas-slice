<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AudioBatchModal from '@/components/AudioBatchModal.vue'
import AudioResultModal from '@/components/AudioResultModal.vue'
import AudioWaveform from '@/components/AudioWaveform.vue'
import MultiTrackEditor from '@/components/MultiTrackEditor.vue'
import { claimAudition, releaseAudition } from '@/core/audio/audition'
import { AUDIO_FORMATS, MP3_BITRATES } from '@/core/audio/encode'
import { type WavEncoding } from '@/core/audio/wav'
import {
  AUDIO_ASSET_MIME,
  activeAsset,
  audioState,
  clearAssetSelection,
  clearAssets,
  dismissAudioError,
  exportMixdown,
  importFiles,
  isAssetSelected,
  mixdownToAsset,
  mixFormatIssue,
  persist,
  selectedAssets,
  selectAllAssets,
  setActiveAsset,
  toggleAssetSelected,
  removeAsset,
  type AudioAsset,
} from '@/store/audio'

/**
 * 音频工具箱页。
 * 左栏素材库（可勾选、可拖拽到音轨）、中间多音轨编辑器、右栏合成导出；
 * 批量编辑的配置与结果各在一个弹窗里，与右栏的单文件合成导出互不影响。
 */

const input = ref<HTMLInputElement>()
const busy = computed(() => audioState.batch.running || audioState.loading.active)
const hasAssets = computed(() => audioState.assets.length > 0)
const hasOutputs = computed(() => audioState.outputs.length > 0)
const selectedCount = computed(() => selectedAssets.value.length)
const allSelected = computed(() => hasAssets.value && selectedCount.value === audioState.assets.length)

/** 合成导出的可用性问题（与批量的导出设置相互独立） */
const mixIssue = computed(() => mixFormatIssue())
/** 时间轴上是否有可导出的片段 */
const canExportMix = computed(() =>
  audioState.tracks.some((track) => track.clips.length > 0),
)

const WAV_ENCODINGS: { value: WavEncoding; label: string }[] = [
  { value: 'pcm16', label: '16 位整数（兼容性最好）' },
  { value: 'pcm24', label: '24 位整数（母版归档）' },
  { value: 'float32', label: '32 位浮点（无量化损失）' },
]

const mixFormatLabel = computed(
  () => AUDIO_FORMATS.find((item) => item.format === audioState.mixExport.format)?.label ?? '',
)

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds * 1000) / 1000
  if (total < 60) return `${total.toFixed(2)} s`
  const m = Math.floor(total / 60)
  return `${m}:${(total - m * 60).toFixed(2).padStart(5, '0')}`
}

function channelLabel(count: number): string {
  if (count === 1) return '单声道'
  if (count === 2) return '立体声'
  return `${count} 声道`
}

/** 预期输出只按勾选的素材算，与批量弹窗保持一致 */
const expectedCount = computed(
  () => selectedCount.value * (audioState.variants.enabled ? Math.max(0, audioState.variants.count) : 1),
)

const batchLabel = computed(() => (hasOutputs.value ? '批量编辑（再次处理）' : '批量编辑'))

function onToggleAll(): void {
  if (allSelected.value) clearAssetSelection()
  else selectAllAssets()
}

function onImport(e: Event): void {
  const target = e.target as HTMLInputElement
  const files = Array.from(target.files ?? [])
  target.value = ''
  if (files.length) void importFiles(files)
}

// ---------------------------------------------------------------- 系统文件拖放

/** 拖入的是操作系统文件时显示整页落点提示；内部素材拖拽（自定义 MIME）不响应 */
const dragDepth = ref(0)
const fileDragOver = computed(() => dragDepth.value > 0)

function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

function onFileDragEnter(e: DragEvent): void {
  if (hasFiles(e)) dragDepth.value++
}

function onFileDragOver(e: DragEvent): void {
  // 必须 preventDefault，否则浏览器会直接打开文件
  if (hasFiles(e)) e.preventDefault()
}

function onFileDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onFileDrop(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth.value = 0
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length) void importFiles(files)
}

// ---------------------------------------------------------------- 素材试听

/** 全列表共用一个 audio 元素，天然只可能响一条 */
const assetPlayer = ref<HTMLAudioElement>()
const playingAssetId = ref('')

function auditionKey(assetId: string): string {
  return `asset:${assetId}`
}

/** 停止列表试听并让出播放位：切换素材、删除素材、离开页面时调用 */
function stopAssetPlay(): void {
  assetPlayer.value?.pause()
  if (playingAssetId.value) releaseAudition(auditionKey(playingAssetId.value))
  playingAssetId.value = ''
}

function toggleAssetPlay(asset: AudioAsset): void {
  const node = assetPlayer.value
  if (!node) return
  if (playingAssetId.value === asset.id) {
    stopAssetPlay()
    return
  }
  stopAssetPlay()
  // 认领播放位：时间轴试听与结果弹窗里正在响的音频会被自动停掉
  claimAudition(auditionKey(asset.id), stopAssetPlay)
  playingAssetId.value = asset.id
  node.src = asset.previewUrl
  void node.play().catch(() => {
    stopAssetPlay()
    audioState.error = `无法试听「${asset.fileName}」，浏览器可能不支持该格式`
  })
}

/** 自然播完或被别的来源打断：清掉播放态 */
function onAssetPlayerStop(): void {
  const node = assetPlayer.value
  const id = playingAssetId.value
  // 切换素材时上一条的 pause 事件会晚一拍到达，此时元素已在播新素材，忽略
  if (!node || !id || !node.paused) return
  playingAssetId.value = ''
  releaseAudition(auditionKey(id))
}

function onRemoveAsset(assetId: string): void {
  if (playingAssetId.value === assetId) stopAssetPlay()
  removeAsset(assetId)
}

onBeforeUnmount(stopAssetPlay)

function onAssetDragStart(e: DragEvent, assetId: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData(AUDIO_ASSET_MIME, assetId)
  e.dataTransfer.effectAllowed = 'copy'
  setActiveAsset(assetId)
}

function openBatchModal(): void {
  audioState.error = ''
  audioState.batch.error = ''
  audioState.batchModalOpen = true
}

/** 处理完成：关掉配置弹窗，改开结果弹窗 */
function onBatchFinished(): void {
  audioState.batchModalOpen = false
  audioState.resultModalOpen = true
}

function onClear(): void {
  if (!window.confirm('清空全部素材、音轨与处理结果？')) return
  stopAssetPlay()
  clearAssets()
}

/** 合成到素材库：新素材默认勾选，可直接进批量编辑 */
async function onMixToAsset(): Promise<void> {
  await mixdownToAsset()
}

// 设置变化即落盘：刷新后处理链 / 导出配置 / 变体参数仍保持
watch(
  () => [
    audioState.chain,
    audioState.exportSettings,
    audioState.mixExport,
    audioState.mixFileName,
    audioState.variants,
    audioState.namingPattern,
    audioState.maxDurationSec,
  ],
  persist,
  { deep: true },
)
</script>

<template>
  <div
    class="tool-page"
    :class="{ 'no-list': !hasAssets }"
    @dragenter="onFileDragEnter"
    @dragover="onFileDragOver"
    @dragleave="onFileDragLeave"
    @drop="onFileDrop"
  >
    <div v-if="fileDragOver" class="drop-overlay">
      <span>松开导入，视频自动提取音轨</span>
    </div>
    <!-- 左栏：素材库 -->
    <section v-if="hasAssets" class="tool-sidebar panel">
      <div class="section">
        <h2 class="section-title">素材库（{{ audioState.assets.length }}）</h2>
        <button class="btn full" :disabled="busy" @click="input?.click()">＋ 导入</button>
        <div class="select-bar">
          <label class="check-row">
            <input type="checkbox" :checked="allSelected" @change="onToggleAll" />
            <span>{{ allSelected ? '取消全选' : '全选' }}</span>
          </label>
          <span class="muted small">已选 {{ selectedCount }} / {{ audioState.assets.length }}</span>
        </div>
        <p class="muted small drag-tip">勾选的素材才会被「批量编辑」处理；拖到中间音轨可参与合成</p>
      </div>
      <ul class="asset-list">
        <li
          v-for="asset in audioState.assets"
          :key="asset.id"
          class="asset-item"
          :class="{
            active: asset.id === activeAsset?.id,
            playing: playingAssetId === asset.id,
            selected: isAssetSelected(asset.id),
          }"
          draggable="true"
          @click="setActiveAsset(asset.id)"
          @dragstart="onAssetDragStart($event, asset.id)"
        >
          <div class="asset-head">
            <input
              class="asset-check"
              type="checkbox"
              title="勾选后参与批量编辑"
              :checked="isAssetSelected(asset.id)"
              @click.stop
              @change="toggleAssetSelected(asset.id)"
            />
            <button
              class="btn btn-icon play-btn"
              :class="{ playing: playingAssetId === asset.id }"
              :title="playingAssetId === asset.id ? '停止试听' : '试听'"
              @click.stop="toggleAssetPlay(asset)"
            >
              {{ playingAssetId === asset.id ? '⏸' : '▶' }}
            </button>
            <span class="asset-name" :title="asset.fileName">{{ asset.fileName }}</span>
            <button class="btn btn-icon btn-danger" title="移除" @click.stop="onRemoveAsset(asset.id)">×</button>
          </div>
          <AudioWaveform :peaks="asset.peaks" :height="28" :color="asset.id === activeAsset?.id ? '#e8a23d' : '#6a7080'" />
          <div class="asset-meta mono faint">
            <span class="badge">{{ asset.container }}</span>
            <span>{{ fmtDuration(asset.durationSec) }}</span>
            <span>{{ asset.sampleRate }} Hz</span>
            <span>{{ channelLabel(asset.channelCount) }}</span>
          </div>
          <div v-if="asset.nameIssue" class="asset-issue">⚠ {{ asset.nameIssue }}</div>
          <div v-if="asset.duplicateOf" class="asset-issue">⚠ 与「{{ asset.duplicateOf }}」高度相似</div>
        </li>
      </ul>
    </section>

    <!-- 中间：多音轨编辑器 -->
    <main class="tool-main">
      <div class="tool-header">
        <div>
          <h2>多音轨编辑器</h2>
          <p>
            {{
              hasAssets
                ? `已勾选 ${selectedCount} 条素材 · 批量编辑预期输出 ${expectedCount} 个 · 本地处理不上传`
                : '导入音频后拖到音轨上开始编辑'
            }}
          </p>
        </div>
        <div class="header-actions">
          <input
            ref="input"
            hidden
            type="file"
            accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,video/mp4,video/quicktime,video/webm,.mov,.webm"
            multiple
            @change="onImport"
          />
          <button class="btn" :disabled="busy" @click="input?.click()">导入</button>
          <button v-if="hasOutputs" class="btn" @click="audioState.resultModalOpen = true">
            查看结果（{{ audioState.outputs.length }}）
          </button>
          <button
            class="btn btn-primary"
            :disabled="busy || !selectedCount"
            :title="selectedCount ? '只处理已勾选的素材' : '请先在左侧勾选要处理的素材'"
            @click="openBatchModal()"
          >
            {{ batchLabel }}（{{ selectedCount }}）
          </button>
        </div>
      </div>

      <div class="tool-body">
        <div v-if="!hasAssets" class="empty-state">
          <span class="big">♪</span>
          <strong>还没有素材</strong>
          <span>音频 WAV/MP3/OGG/FLAC/M4A，视频 MP4/MOV/WebM 自动提取音轨</span>
          <button class="btn btn-primary" @click="input?.click()">选择文件或拖到此处</button>
        </div>
        <MultiTrackEditor v-else />
      </div>
    </main>

    <!-- 右栏：合成导出（只针对时间轴混音结果，与批量编辑的导出设置分开） -->
    <section class="tool-sidepanel panel">
      <div class="section">
        <h2 class="section-title">合成导出</h2>
        <p class="muted small">
          把时间轴上的多轨混音导出成<strong>一个文件</strong>；这里的格式只影响这份合成结果，批量编辑的导出格式在批量弹窗里单独设置。
        </p>

        <label class="field"><span class="field-label">格式</span>
          <select v-model="audioState.mixExport.format" class="select">
            <option v-for="format in AUDIO_FORMATS" :key="format.format" :value="format.format" :disabled="!format.available">
              {{ format.label }}{{ format.available ? '' : `（${format.hint}）` }}
            </option>
          </select></label>
        <p v-if="mixIssue" class="warn">{{ mixIssue }}</p>

        <label v-if="audioState.mixExport.format === 'wav'" class="field">
          <span class="field-label">WAV 位深</span>
          <select v-model="audioState.mixExport.wavEncoding" class="select">
            <option v-for="item in WAV_ENCODINGS" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label v-else-if="audioState.mixExport.format === 'mp3'" class="field">
          <span class="field-label">MP3 码率</span>
          <select v-model.number="audioState.mixExport.mp3Bitrate" class="select">
            <option v-for="rate in MP3_BITRATES" :key="rate" :value="rate">{{ rate }} kbps</option>
          </select>
        </label>
        <label v-else-if="audioState.mixExport.format === 'ogg'" class="field">
          <span class="field-label">OGG 质量（0-10）</span>
          <input v-model.number="audioState.mixExport.oggQuality" class="input" type="number" min="0" max="10" />
        </label>

        <label class="field">
          <span class="field-label">文件名</span>
          <input v-model="audioState.mixFileName" class="input template-input" type="text" spellcheck="false" placeholder="mix" />
        </label>
        <p class="muted small">
          导出为 <span class="mono">{{ audioState.mixFileName || 'mix' }}.{{ AUDIO_FORMATS.find((item) => item.format === audioState.mixExport.format)?.extension ?? 'wav' }}</span>
          （{{ mixFormatLabel }}）
        </p>

        <div class="actions">
          <button class="btn btn-primary full" :disabled="busy || !canExportMix || !!mixIssue" :title="mixIssue" @click="exportMixdown()">
            导出合成音频
          </button>
          <button class="btn full" :disabled="busy || !canExportMix" @click="onMixToAsset">合成到素材库并勾选</button>
        </div>
        <p class="muted small">
          「导出合成音频」直接下载一份文件；要走批处理链路（处理链 / 变体 / 多格式）请用「合成到素材库」，
          它会把合成结果设为唯一勾选项，避免把参与混音的原始素材又处理一遍。
        </p>
      </div>

      <div class="section actions">
        <p v-if="audioState.notice" class="muted small">{{ audioState.notice }}</p>
        <button class="btn btn-ghost full" :disabled="busy || (!hasAssets && !hasOutputs)" @click="onClear">清空素材与结果</button>
      </div>
    </section>

    <AudioBatchModal
      v-if="audioState.batchModalOpen"
      @close="audioState.batchModalOpen = false"
      @finished="onBatchFinished"
    />
    <AudioResultModal v-if="audioState.resultModalOpen" @close="audioState.resultModalOpen = false" />

    <!-- 素材列表共用的试听播放器：整页共用一条，天然保证同时只响一个 -->
    <audio
      ref="assetPlayer"
      hidden
      preload="none"
      @pause="onAssetPlayerStop"
      @ended="onAssetPlayerStop"
    ></audio>

    <div v-if="audioState.loading.active" class="loading-veil">
      <div class="loading-card">
        <span class="spinner"></span>
        <div>
          <strong>{{ audioState.loading.text }}</strong>
          <p v-if="audioState.loading.total > 1" class="muted small mono">
            {{ audioState.loading.done }}/{{ audioState.loading.total }}
          </p>
        </div>
      </div>
    </div>

    <div v-if="audioState.error" class="toast-wrap">
      <div class="toast toast-error">
        <span>{{ audioState.error }}</span>
        <button class="toast-close" @click="dismissAudioError()">×</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-page { position: relative; display: grid; grid-template-columns: 300px minmax(0, 1fr) 340px; height: 100%; min-height: 0; }
.drop-overlay { position: absolute; inset: 8px; z-index: 50; display: grid; place-items: center; border: 2px dashed var(--accent-border); border-radius: var(--radius-m); background: var(--accent-dim); pointer-events: none; }
.drop-overlay span { font-size: var(--fs-head); color: var(--accent-strong); }
.tool-page.no-list { grid-template-columns: minmax(0, 1fr) 340px; }
.tool-sidebar { border-right: 1px solid var(--border); overflow: auto; display: flex; flex-direction: column; }
.tool-sidepanel { border-left: 1px solid var(--border); overflow: auto; }
.tool-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tool-header { height: 64px; flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; border-bottom: 1px solid var(--border); }
.tool-header h2 { margin: 0; font-size: var(--fs-head); }
.tool-header p { margin: 2px 0 0; color: var(--text-faint); }
.tool-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding: 16px 24px 24px; }
.header-actions { display: flex; align-items: center; gap: var(--sp-3); }
.full { width: 100%; justify-content: center; }
.small { font-size: var(--fs-caption); }
.actions { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-2); }
.section > .field + .field, .section > .field + .check-row, .section > .check-row + .field { margin-top: var(--sp-3); }
.section > p + .field, .section > .check-row + .field { margin-top: var(--sp-3); }
.field-row { display: flex; align-items: flex-end; gap: var(--sp-3); }
.field-row .btn { flex: 1; justify-content: center; }
.section .select { width: 100%; }
.template-input { width: 100%; font-family: var(--font-mono); font-size: var(--fs-caption); }

/* 素材库 */
.drag-tip { margin: var(--sp-2) 0 0; }
.asset-list { list-style: none; margin: 0; padding: var(--sp-2) var(--sp-4) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
.asset-item { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-raised); cursor: grab; }
.asset-item.active { border-color: var(--accent-border); background: var(--accent-dim); }
.asset-item:active { cursor: grabbing; }
.select-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); margin-top: var(--sp-2); }
.asset-check { flex: none; margin: 0; cursor: pointer; }
.asset-item.selected { border-color: var(--border-strong); }
.asset-head { display: flex; align-items: center; gap: var(--sp-2); }
.asset-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); }
.asset-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: 11px; }
.asset-issue { color: #fbbf24; font-size: 11px; }
.play-btn { flex: none; width: 26px; height: 26px; font-size: 11px; line-height: 1; }
.play-btn.playing { border-color: var(--accent-border); background: var(--accent-dim); color: var(--accent-strong); }
.asset-item.playing { border-color: var(--accent-border); }

/* 加载遮罩 */
.loading-veil { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgba(13, 15, 19, 0.55); }
.loading-card { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-5) var(--sp-6); border: 1px solid var(--border-strong); border-radius: var(--radius-m); background: var(--surface); box-shadow: var(--shadow-pop); }
.loading-card strong { font-size: var(--fs-body); }
.loading-card p { margin: 2px 0 0; }
.spinner { width: 22px; height: 22px; flex: none; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.toast { display: flex; align-items: center; gap: var(--sp-3); }
.toast-close { color: inherit; font-size: 16px; line-height: 1; opacity: 0.7; }
.toast-close:hover { opacity: 1; }
</style>
