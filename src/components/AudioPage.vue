<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AudioBatchModal from '@/components/AudioBatchModal.vue'
import AudioResultModal from '@/components/AudioResultModal.vue'
import AudioSynthModal from '@/components/AudioSynthModal.vue'
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

/** 音效生成：没有素材也能用，所以与导入按钮一样始终可见 */
function openSynthModal(): void {
  audioState.error = ''
  audioState.synthModalOpen = true
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
    class="relative grid h-full min-h-0"
    :class="hasAssets ? 'grid-cols-[300px_minmax(0,1fr)_340px]' : 'grid-cols-[minmax(0,1fr)_340px]'"
    @dragenter="onFileDragEnter"
    @dragover="onFileDragOver"
    @dragleave="onFileDragLeave"
    @drop="onFileDrop"
  >
    <div
      v-if="fileDragOver"
      class="pointer-events-none absolute inset-2 z-50 grid place-items-center rounded-md border-2 border-dashed border-accent-border bg-accent-dim"
    >
      <span class="text-head text-accent-strong">松开导入，视频自动提取音轨</span>
    </div>
    <!-- 左栏：素材库 -->
    <section v-if="hasAssets" class="panel flex flex-col overflow-auto border-r border-line">
      <div class="section">
        <h2 class="section-title">素材库（{{ audioState.assets.length }}）</h2>
        <button class="btn w-full justify-center" :disabled="busy" @click="input?.click()">＋ 导入</button>
        <div class="mt-2 flex items-center justify-between gap-2">
          <label class="check-row">
            <input type="checkbox" :checked="allSelected" @change="onToggleAll" />
            <span>{{ allSelected ? '取消全选' : '全选' }}</span>
          </label>
          <span class="muted text-caption">已选 {{ selectedCount }} / {{ audioState.assets.length }}</span>
        </div>
        <p class="m-0 mt-2 text-caption muted">勾选的素材才会被「批量编辑」处理；拖到中间音轨可参与合成</p>
      </div>
      <ul class="m-0 flex list-none flex-col gap-3 px-4 pt-2 pb-4">
        <li
          v-for="asset in audioState.assets"
          :key="asset.id"
          class="flex cursor-grab flex-col gap-2 rounded-sm border p-3 active:cursor-grabbing"
          :class="[
            isAssetSelected(asset.id) && playingAssetId !== asset.id
              ? 'border-line-strong'
              : asset.id === activeAsset?.id || playingAssetId === asset.id
                ? 'border-accent-border'
                : 'border-line',
            asset.id === activeAsset?.id ? 'bg-accent-dim' : 'bg-raised',
          ]"
          draggable="true"
          @click="setActiveAsset(asset.id)"
          @dragstart="onAssetDragStart($event, asset.id)"
        >
          <div class="flex items-center gap-2">
            <input
              class="m-0 flex-none cursor-pointer"
              type="checkbox"
              title="勾选后参与批量编辑"
              :checked="isAssetSelected(asset.id)"
              @click.stop
              @change="toggleAssetSelected(asset.id)"
            />
            <button
              class="btn btn-icon h-[26px] w-[26px] flex-none text-[11px] leading-none"
              :class="playingAssetId === asset.id && 'border-accent-border bg-accent-dim text-accent-strong'"
              :title="playingAssetId === asset.id ? '停止试听' : '试听'"
              @click.stop="toggleAssetPlay(asset)"
            >
              {{ playingAssetId === asset.id ? '⏸' : '▶' }}
            </button>
            <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-caption" :title="asset.fileName">{{ asset.fileName }}</span>
            <button class="btn btn-icon btn-danger" title="移除" @click.stop="onRemoveAsset(asset.id)">×</button>
          </div>
          <AudioWaveform :peaks="asset.peaks" :height="28" :color="asset.id === activeAsset?.id ? '#e8a23d' : '#6a7080'" />
          <div class="mono faint flex flex-wrap items-center gap-2 text-[11px]">
            <span class="badge">{{ asset.container }}</span>
            <span>{{ fmtDuration(asset.durationSec) }}</span>
            <span>{{ asset.sampleRate }} Hz</span>
            <span>{{ channelLabel(asset.channelCount) }}</span>
          </div>
          <div v-if="asset.nameIssue" class="text-[11px] text-[#fbbf24]">⚠ {{ asset.nameIssue }}</div>
          <div v-if="asset.duplicateOf" class="text-[11px] text-[#fbbf24]">⚠ 与「{{ asset.duplicateOf }}」高度相似</div>
        </li>
      </ul>
    </section>

    <!-- 中间：多音轨编辑器 -->
    <main class="flex min-h-0 min-w-0 flex-col">
      <div class="flex h-16 flex-none items-center justify-between gap-4 border-b border-line px-6">
        <div>
          <h2 class="m-0 text-head">多音轨编辑器</h2>
          <p class="mt-0.5 mb-0 text-faint">
            {{
              hasAssets
                ? `已勾选 ${selectedCount} 条素材 · 批量编辑预期输出 ${expectedCount} 个 · 本地处理不上传`
                : '导入音频后拖到音轨上开始编辑'
            }}
          </p>
        </div>
        <div class="flex items-center gap-3">
          <input
            ref="input"
            hidden
            type="file"
            accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,video/mp4,video/quicktime,video/webm,.mov,.webm"
            multiple
            @change="onImport"
          />
          <button class="btn" :disabled="busy" @click="input?.click()">导入</button>
          <button class="btn" :disabled="busy" title="程序化合成 UI 音 / 8-bit / 科幻 / 打击类音效" @click="openSynthModal()">
            音效生成
          </button>
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

      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 pt-4 pb-6">
        <div v-if="!hasAssets" class="empty-state">
          <span class="big">♪</span>
          <strong>还没有素材</strong>
          <span>音频 WAV/MP3/OGG/FLAC/M4A，视频 MP4/MOV/WebM 自动提取音轨</span>
          <div class="flex items-center gap-3">
            <button class="btn btn-primary" @click="input?.click()">选择文件或拖到此处</button>
            <button class="btn" @click="openSynthModal()">或生成一个音效</button>
          </div>
        </div>
        <MultiTrackEditor v-else />
      </div>
    </main>

    <!-- 右栏：合成导出（只针对时间轴混音结果，与批量编辑的导出设置分开） -->
    <section class="panel overflow-auto border-l border-line">
      <div class="section">
        <h2 class="section-title">合成导出</h2>
        <p class="muted text-caption">
          把时间轴上的多轨混音导出成<strong>一个文件</strong>；这里的格式只影响这份合成结果，批量编辑的导出格式在批量弹窗里单独设置。
        </p>

        <label class="field mt-3"><span class="field-label">格式</span>
          <select v-model="audioState.mixExport.format" class="select w-full">
            <option v-for="format in AUDIO_FORMATS" :key="format.format" :value="format.format" :disabled="!format.available">
              {{ format.label }}{{ format.available ? '' : `（${format.hint}）` }}
            </option>
          </select></label>
        <p v-if="mixIssue" class="warn">{{ mixIssue }}</p>

        <label v-if="audioState.mixExport.format === 'wav'" class="field mt-3">
          <span class="field-label">WAV 位深</span>
          <select v-model="audioState.mixExport.wavEncoding" class="select w-full">
            <option v-for="item in WAV_ENCODINGS" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label v-else-if="audioState.mixExport.format === 'mp3'" class="field mt-3">
          <span class="field-label">MP3 码率</span>
          <select v-model.number="audioState.mixExport.mp3Bitrate" class="select w-full">
            <option v-for="rate in MP3_BITRATES" :key="rate" :value="rate">{{ rate }} kbps</option>
          </select>
        </label>
        <label v-else-if="audioState.mixExport.format === 'ogg'" class="field mt-3">
          <span class="field-label">OGG 质量（0-10）</span>
          <input v-model.number="audioState.mixExport.oggQuality" class="input" type="number" min="0" max="10" />
        </label>

        <label class="field mt-3">
          <span class="field-label">文件名</span>
          <input v-model="audioState.mixFileName" class="input w-full font-mono text-caption" type="text" spellcheck="false" placeholder="mix" />
        </label>
        <p class="muted text-caption">
          导出为 <span class="mono">{{ audioState.mixFileName || 'mix' }}.{{ AUDIO_FORMATS.find((item) => item.format === audioState.mixExport.format)?.extension ?? 'wav' }}</span>
          （{{ mixFormatLabel }}）
        </p>

        <div class="mt-2 flex flex-col gap-2">
          <button class="btn btn-primary w-full justify-center" :disabled="busy || !canExportMix || !!mixIssue" :title="mixIssue" @click="exportMixdown()">
            导出合成音频
          </button>
          <button class="btn w-full justify-center" :disabled="busy || !canExportMix" @click="onMixToAsset">合成到素材库并勾选</button>
        </div>
        <p class="muted text-caption">
          「导出合成音频」直接下载一份文件；要走批处理链路（处理链 / 变体 / 多格式）请用「合成到素材库」，
          它会把合成结果设为唯一勾选项，避免把参与混音的原始素材又处理一遍。
        </p>
      </div>

      <div class="section mt-2 flex flex-col gap-2">
        <p v-if="audioState.notice" class="muted text-caption">{{ audioState.notice }}</p>
        <button class="btn btn-ghost w-full justify-center" :disabled="busy || (!hasAssets && !hasOutputs)" @click="onClear">清空素材与结果</button>
      </div>
    </section>

    <AudioBatchModal
      v-if="audioState.batchModalOpen"
      @close="audioState.batchModalOpen = false"
      @finished="onBatchFinished"
    />
    <AudioResultModal v-if="audioState.resultModalOpen" @close="audioState.resultModalOpen = false" />
    <AudioSynthModal v-if="audioState.synthModalOpen" @close="audioState.synthModalOpen = false" />

    <!-- 素材列表共用的试听播放器：整页共用一条，天然保证同时只响一个 -->
    <audio
      ref="assetPlayer"
      hidden
      preload="none"
      @pause="onAssetPlayerStop"
      @ended="onAssetPlayerStop"
    ></audio>

    <div v-if="audioState.loading.active" class="fixed inset-0 z-60 grid place-items-center bg-[rgb(13_15_19_/_0.55)]">
      <div class="flex items-center gap-4 rounded-md border border-line-strong bg-surface px-6 py-5 shadow-popover">
        <span class="h-[22px] w-[22px] flex-none animate-spin rounded-full border-2 border-line-strong border-t-accent"></span>
        <div>
          <strong class="text-body">{{ audioState.loading.text }}</strong>
          <p v-if="audioState.loading.total > 1" class="muted mono mt-0.5 mb-0 text-caption">
            {{ audioState.loading.done }}/{{ audioState.loading.total }}
          </p>
        </div>
      </div>
    </div>

    <div v-if="audioState.error" class="toast-wrap">
      <div class="toast toast-error flex items-center gap-3">
        <span>{{ audioState.error }}</span>
        <button class="text-base leading-none opacity-70 hover:opacity-100" @click="dismissAudioError()">×</button>
      </div>
    </div>
  </div>
</template>
