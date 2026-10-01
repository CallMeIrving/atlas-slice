<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AudioWaveform from '@/components/AudioWaveform.vue'
import TaskProgress from '@/components/TaskProgress.vue'
import { AUDIO_FORMATS, MP3_BITRATES } from '@/core/audio/encode'
import { applyNameTemplate } from '@/core/audio/pipeline'
import { CHAIN_ORDER, PLATFORM_PRESETS, SAMPLE_RATES } from '@/core/audio/presets'
import { type WavEncoding } from '@/core/audio/wav'
import {
  activeAsset,
  audioState,
  applyPlatformPreset,
  applyUserPreset,
  cancelBatch,
  clearAssets,
  createMergedAsset,
  createTrimmedAsset,
  deleteUserPreset,
  dismissAudioError,
  downloadAll,
  downloadOne,
  downloadReport,
  formatDb,
  formatLufs,
  importFiles,
  mergeSequence,
  moveMergeItem,
  persist,
  presetLabel,
  removeAsset,
  removeOutput,
  runBatch,
  saveUserPreset,
  setActiveAsset,
} from '@/store/audio'

/**
 * 音频批处理工具箱页。
 * 左栏素材库、中间工作区（波形 + 结果）、右栏处理链 / 变体 / 导出配置。
 * 素材只保留元数据与波形包络，源文件存于 store 的非响应式 Map，处理时按需重新解码。
 */

const input = ref<HTMLInputElement>()
const presetName = ref('')
const busy = computed(() => audioState.batch.running || audioState.importing)

// ---------------------------------------------------------------- 裁剪选区

const player = ref<HTMLAudioElement>()
/** 选区按秒保存；波形拖选与数值输入共用这份状态 */
const trimStart = ref(0)
const trimEnd = ref(0)
let previewing = false

const activeDuration = computed(() => activeAsset.value?.durationSec ?? 0)

/** 越界值收敛到素材时长内，并保证 start ≤ end */
const trimRange = computed(() => {
  const duration = activeDuration.value
  const start = Math.max(0, Math.min(Number(trimStart.value) || 0, duration))
  const end = Math.max(0, Math.min(Number(trimEnd.value) || 0, duration))
  return { start: Math.min(start, end), end: Math.max(start, end) }
})

const trimLength = computed(() => trimRange.value.end - trimRange.value.start)
const hasSelection = computed(() => trimLength.value >= 0.01)

/** 波形只认归一化比例，这里把秒换算成 0..1 */
const waveSelection = computed(() => {
  const duration = activeDuration.value
  if (duration <= 0 || !hasSelection.value) return null
  return { start: trimRange.value.start / duration, end: trimRange.value.end / duration }
})

function onSelect(range: { start: number; end: number } | null): void {
  const duration = activeDuration.value
  if (!range || duration <= 0) {
    trimStart.value = 0
    trimEnd.value = 0
    return
  }
  trimStart.value = Math.round(range.start * duration * 100) / 100
  trimEnd.value = Math.round(range.end * duration * 100) / 100
}

function selectAll(): void {
  trimStart.value = 0
  trimEnd.value = Math.round(activeDuration.value * 100) / 100
}

function clearSelection(): void {
  trimStart.value = 0
  trimEnd.value = 0
  stopPreview()
}

function stopPreview(): void {
  previewing = false
  player.value?.pause()
}

function previewSelection(): void {
  const el = player.value
  if (!el || !hasSelection.value) return
  el.currentTime = trimRange.value.start
  previewing = true
  void el.play()
}

/** 试听选区时到终点自动暂停，避免一直播到素材结尾 */
function onTimeUpdate(): void {
  const el = player.value
  if (!previewing || !el) return
  if (el.currentTime >= trimRange.value.end) stopPreview()
}

function trimAsset(mode: 'keep' | 'remove'): void {
  const asset = activeAsset.value
  if (!asset || !hasSelection.value) return
  stopPreview()
  void createTrimmedAsset(asset.id, trimRange.value.start, trimRange.value.end, mode)
}

/** 切换素材时清空选区，避免把上一条的时间轴套到新素材上 */
watch(
  () => activeAsset.value?.id,
  () => {
    trimStart.value = 0
    trimEnd.value = 0
    stopPreview()
  },
)

const hasAssets = computed(() => audioState.assets.length > 0)
const outputs = computed(() => audioState.outputs)
const issue = computed(() => formatIssue())
const availableFormats = computed(() => AUDIO_FORMATS)

/** 导出格式不可用时给出原因，用于禁用「一键处理」 */
function formatIssue(): string {
  const info = AUDIO_FORMATS.find((item) => item.format === audioState.exportSettings.format)
  if (!info) return '未知导出格式'
  if (!info.available) return `${info.label} 暂不可用：${info.hint ?? ''}`
  return ''
}

const WAV_ENCODINGS: { value: WavEncoding; label: string }[] = [
  { value: 'pcm16', label: '16 位整数（兼容性最好）' },
  { value: 'pcm24', label: '24 位整数（母版归档）' },
  { value: 'float32', label: '32 位浮点（无量化损失）' },
]

/** 命名模板实时预览：用当前素材名与所选预设渲染一个示例 */
const templatePreview = computed(() =>
  applyNameTemplate(audioState.exportSettings.nameTemplate || '{name}', {
    name: activeAsset.value?.fileName.replace(/\.[^.]+$/, '') ?? 'sound',
    preset: presetLabel(),
    variant: audioState.variants.enabled ? 'v1_+12c_+0.5dB' : '',
    index: 1,
    ext: AUDIO_FORMATS.find((item) => item.format === audioState.exportSettings.format)?.extension ?? 'wav',
  }),
)

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds * 1000) / 1000
  if (total < 60) return `${total.toFixed(2)} s`
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function channelLabel(count: number): string {
  if (count === 1) return '单声道'
  if (count === 2) return '立体声'
  return `${count} 声道`
}

/** 变体数量与主输出数量之和，用于「一键处理」按钮文案 */
const expectedCount = computed(() =>
  hasAssets.value
    ? audioState.assets.length * (audioState.variants.enabled ? Math.max(0, audioState.variants.count) : 1)
    : 0,
)

const runLabel = computed(() => {
  if (audioState.batch.running) return '处理中…'
  if (!hasAssets.value) return '请先导入素材'
  const rerun = outputs.value.length > 0
  return rerun ? '再次处理' : '开始一键处理'
})

function onImport(e: Event): void {
  const target = e.target as HTMLInputElement
  const files = Array.from(target.files ?? [])
  target.value = ''
  if (files.length) void importFiles(files)
}

function onPlatformChange(e: Event): void {
  applyPlatformPreset((e.target as HTMLSelectElement).value)
}

function onSavePreset(): void {
  if (!presetName.value.trim()) return
  saveUserPreset(presetName.value)
  presetName.value = ''
}

function onClear(): void {
  if (!window.confirm('清空全部素材与处理结果？')) return
  clearAssets()
}

function findingClass(level: 'warn' | 'error'): string {
  return level === 'error' ? 'finding error' : 'finding warn'
}

// 设置变化即落盘：刷新后处理链 / 导出配置 / 变体参数仍保持
watch(
  () => [
    audioState.chain,
    audioState.exportSettings,
    audioState.variants,
    audioState.namingPattern,
    audioState.maxDurationSec,
    audioState.mergeSettings,
  ],
  persist,
  { deep: true },
)
</script>

<template>
  <div class="tool-page" :class="{ 'no-list': !hasAssets }">
    <!-- 左栏：素材库 -->
    <section v-if="hasAssets" class="tool-sidebar panel">
      <div class="section">
        <h2 class="section-title">素材库（{{ audioState.assets.length }}）</h2>
        <button class="btn full" :disabled="busy" @click="input?.click()">＋ 导入音频</button>
        <div v-if="audioState.importing" class="import-line">
          <span class="muted">{{ audioState.importText }}</span>
          <span class="mono faint">{{ audioState.importDone }}/{{ audioState.importTotal }}</span>
        </div>
      </div>
      <ul class="asset-list">
        <li
          v-for="asset in audioState.assets"
          :key="asset.id"
          class="asset-item"
          :class="{ active: asset.id === activeAsset?.id }"
          @click="setActiveAsset(asset.id)"
        >
          <div class="asset-head">
            <span class="asset-name" :title="asset.fileName">{{ asset.fileName }}</span>
            <button class="btn btn-icon btn-danger" title="移除" @click.stop="removeAsset(asset.id)">×</button>
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

    <!-- 中间：工作区 -->
    <main class="tool-main">
      <div class="tool-header">
        <div>
          <h2>音频工作区</h2>
          <p>
            {{ hasAssets ? `${expectedCount} 个预期输出 · 本地处理不上传` : '导入音频开始批量处理' }}
          </p>
        </div>
        <div class="header-actions">
          <input ref="input" hidden type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aiff" multiple @change="onImport" />
          <button class="btn" :disabled="busy" @click="input?.click()">导入音频</button>
          <button class="btn btn-primary" :disabled="busy || !hasAssets || !!issue" :title="issue" @click="runBatch()">
            {{ runLabel }}
          </button>
        </div>
      </div>

      <div class="tool-body">
        <TaskProgress
          v-if="audioState.batch.running || audioState.batch.error"
          :running="audioState.batch.running"
          :cancelling="audioState.batch.cancelling"
          :done="audioState.batch.done"
          :total="audioState.batch.total"
          :text="audioState.batch.text"
          :error="audioState.batch.error"
          @cancel="cancelBatch()"
        />

        <div v-if="!hasAssets" class="empty-state">
          <span class="big">♪</span>
          <strong>还没有音频素材</strong>
          <span>导入 WAV / MP3 / OGG / FLAC / M4A / AIFF，支持一次选多个文件</span>
          <button class="btn btn-primary" @click="input?.click()">导入音频</button>
        </div>

        <template v-else>
          <!-- 当前素材详情 -->
          <section v-if="activeAsset" class="detail-card">
            <header class="detail-head">
              <div>
                <h3>{{ activeAsset.fileName }}</h3>
                <p class="faint">{{ fmtSize(activeAsset.sizeBytes) }} · {{ activeAsset.container }} · {{ channelLabel(activeAsset.channelCount) }}</p>
              </div>
              <span v-if="audioState.assets.length > 1" class="badge">{{ audioState.assets.length }} 个素材将全部处理</span>
            </header>
            <AudioWaveform
              :peaks="activeAsset.peaks"
              :height="88"
              selectable
              :selection="waveSelection"
              @select="onSelect"
            />
            <div class="trim-bar">
              <div class="trim-fields">
                <label class="field"><span class="field-label">起点(s)</span>
                  <input v-model.number="trimStart" class="input" type="number" min="0" :max="activeDuration" step="0.01" /></label>
                <label class="field"><span class="field-label">终点(s)</span>
                  <input v-model.number="trimEnd" class="input" type="number" min="0" :max="activeDuration" step="0.01" /></label>
                <span class="muted small mono">选中 {{ fmtDuration(trimLength) }}</span>
              </div>
              <div class="header-actions">
                <button class="btn" @click="selectAll">全选</button>
                <button class="btn" :disabled="!hasSelection" @click="previewSelection">试听选区</button>
                <button class="btn" :disabled="!hasSelection" @click="clearSelection">清除</button>
                <button class="btn btn-primary" :disabled="!hasSelection || busy" @click="trimAsset('keep')">保留选区</button>
                <button class="btn" :disabled="!hasSelection || busy" @click="trimAsset('remove')">裁掉选区</button>
              </div>
            </div>
            <p class="muted small">在波形上拖动框选区间，单击波形清除选区；裁剪结果会作为新素材加入素材库。</p>
            <audio ref="player" class="player" :src="activeAsset.previewUrl" controls preload="none" @timeupdate="onTimeUpdate"></audio>
            <dl class="meta-grid">
              <div><dt>时长</dt><dd class="mono">{{ fmtDuration(activeAsset.durationSec) }}</dd></div>
              <div><dt>采样率</dt><dd class="mono">{{ activeAsset.sampleRate }} Hz</dd></div>
              <div><dt>声道</dt><dd class="mono">{{ activeAsset.channelCount }}</dd></div>
              <div><dt>采样峰值</dt><dd class="mono">{{ formatDb(activeAsset.samplePeakDb) }}</dd></div>
              <div><dt>真峰值</dt><dd class="mono">{{ formatDb(activeAsset.truePeakDb) }}</dd></div>
              <div><dt>积分响度</dt><dd class="mono">{{ formatLufs(activeAsset.integratedLufs) }}</dd></div>
            </dl>
          </section>

          <!-- 处理结果 -->
          <section class="result-card">
            <header class="detail-head">
              <div>
                <h3>处理结果（{{ outputs.length }}）</h3>
                <p class="faint">导出格式：{{ AUDIO_FORMATS.find((f) => f.format === audioState.exportSettings.format)?.label }}</p>
              </div>
              <div class="header-actions">
                <button class="btn" :disabled="!outputs.length" @click="downloadReport('csv')">报告 CSV</button>
                <button class="btn" :disabled="!outputs.length" @click="downloadReport('json')">报告 JSON</button>
                <button class="btn btn-primary" :disabled="!outputs.length" @click="downloadAll()">打包下载 ZIP</button>
              </div>
            </header>

            <p v-if="!outputs.length" class="muted">还没有结果，点击右上角「{{ runLabel }}」开始处理。</p>
            <ul v-else class="output-list">
              <li v-for="output in outputs" :key="output.id" class="output-row">
                <div class="output-main">
                  <div class="output-head">
                    <span class="output-name" :title="output.fileName">{{ output.fileName }}</span>
                    <span v-if="output.variantIndex >= 0" class="badge badge-accent">变体 {{ output.variantIndex + 1 }}</span>
                    <span v-else class="badge">主输出</span>
                  </div>
                  <div class="output-meta mono faint">
                    <span>{{ fmtDuration(output.durationSec) }}</span>
                    <span>{{ output.sampleRate }} Hz</span>
                    <span>{{ channelLabel(output.channelCount) }}</span>
                    <span>{{ formatLufs(output.integratedLufs) }}</span>
                    <span>TP {{ formatDb(output.truePeakDb) }}</span>
                  </div>
                  <ul v-if="output.findings.length" class="finding-list">
                    <li v-for="(finding, i) in output.findings" :key="i" :class="findingClass(finding.level)">{{ finding.message }}</li>
                  </ul>
                  <p v-else class="muted small">质检通过</p>
                </div>
                <div class="output-actions">
                  <audio class="player small" :src="output.previewUrl" controls preload="none"></audio>
                  <button class="btn btn-icon" title="下载" @click="downloadOne(output)">↓</button>
                  <button class="btn btn-icon btn-danger" title="移除" @click="removeOutput(output.id)">×</button>
                </div>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </main>

    <!-- 右栏：配置 -->
    <section class="tool-sidepanel panel">
      <div class="section">
        <h2 class="section-title">平台预设</h2>
        <label class="field">
          <span class="field-label">选择规范</span>
          <select class="select" :value="audioState.platformPresetId" @change="onPlatformChange">
            <option value="">自定义（不套用）</option>
            <option v-for="preset in PLATFORM_PRESETS" :key="preset.id" :value="preset.id">{{ preset.label }}</option>
          </select>
        </label>
        <p class="muted small">
          {{ PLATFORM_PRESETS.find((p) => p.id === audioState.platformPresetId)?.description ?? '按需手动配置处理链与导出参数' }}
        </p>
      </div>

      <div class="section">
        <h2 class="section-title">我的预设</h2>
        <div class="field-row">
          <input v-model="presetName" class="input" type="text" placeholder="预设名称" />
          <button class="btn" :disabled="!presetName.trim()" @click="onSavePreset">保存</button>
        </div>
        <p v-if="!audioState.userPresets.length" class="muted small">保存后可一键恢复整套处理链与导出配置。</p>
        <ul v-else class="preset-list">
          <li v-for="preset in audioState.userPresets" :key="preset.id" class="preset-row">
            <span class="preset-name" :title="preset.name">{{ preset.name }}</span>
            <button class="btn" @click="applyUserPreset(preset.id)">套用</button>
            <button class="btn btn-icon btn-danger" title="删除" @click="deleteUserPreset(preset.id)">×</button>
          </li>
        </ul>
      </div>

      <div class="section">
        <h2 class="section-title">剪辑与合成</h2>
        <p class="muted small">裁剪：在中间波形上拖选区间后点「保留选区 / 裁掉选区」。合成：按下面顺序把素材首尾拼接成一条新素材。</p>
        <div class="field-row">
          <label class="field"><span class="field-label">拼接间隔(s)</span>
            <input v-model.number="audioState.mergeSettings.gapSec" class="input" type="number" min="0" max="5" step="0.01" /></label>
          <label class="field"><span class="field-label">段间淡入淡出(s)</span>
            <input v-model.number="audioState.mergeSettings.fadeSec" class="input" type="number" min="0" max="1" step="0.005" /></label>
        </div>
        <ul class="merge-list">
          <li v-for="(asset, i) in mergeSequence" :key="asset.id" class="merge-row">
            <span class="merge-index mono">{{ i + 1 }}</span>
            <span class="merge-name" :title="asset.fileName">{{ asset.fileName }}</span>
            <button class="btn btn-icon" :disabled="i === 0" title="上移" @click="moveMergeItem(asset.id, -1)">↑</button>
            <button class="btn btn-icon" :disabled="i === mergeSequence.length - 1" title="下移" @click="moveMergeItem(asset.id, 1)">↓</button>
          </li>
        </ul>
        <p v-if="mergeSequence.length < 2" class="muted small">至少需要两条素材才能合成。</p>
        <p v-else class="muted small">合成顺序共 {{ mergeSequence.length }} 条，结果会作为新素材加入素材库。</p>
        <button class="btn btn-primary full" :disabled="busy || mergeSequence.length < 2" @click="createMergedAsset()">
          生成合成素材
        </button>
      </div>

      <div class="section">
        <h2 class="section-title">处理链（固定顺序）</h2>
        <div v-for="(step, i) in CHAIN_ORDER" :key="step.key" class="chain-step">
          <label class="check-row">
            <input v-model="audioState.chain[step.key].enabled" type="checkbox" />
            <span class="chain-index">{{ i + 1 }}</span>
            <span>{{ step.label }}</span>
          </label>

          <div v-if="step.key === 'crop'" class="chain-body">
            <div class="field-row">
              <label class="field"><span class="field-label">起点(s)</span>
                <input v-model.number="audioState.chain.crop.startSec" class="input" type="number" min="0" step="0.01" /></label>
              <label class="field"><span class="field-label">终点(s)</span>
                <input v-model.number="audioState.chain.crop.endSec" class="input" type="number" min="0" step="0.01" /></label>
            </div>
            <p class="muted small">终点填 0 表示裁到结尾。</p>
          </div>

          <div v-else-if="step.key === 'trimSilence'" class="chain-body">
            <div class="field-row">
              <label class="field"><span class="field-label">阈值(dBFS)</span>
                <input v-model.number="audioState.chain.trimSilence.thresholdDb" class="input" type="number" step="1" /></label>
              <label class="field"><span class="field-label">头部保留(s)</span>
                <input v-model.number="audioState.chain.trimSilence.headSec" class="input" type="number" min="0" step="0.005" /></label>
              <label class="field"><span class="field-label">尾部保留(s)</span>
                <input v-model.number="audioState.chain.trimSilence.tailSec" class="input" type="number" min="0" step="0.005" /></label>
            </div>
          </div>

          <div v-else-if="step.key === 'speed'" class="chain-body">
            <label class="field"><span class="field-label">速率倍率（音高联动）</span>
              <input v-model.number="audioState.chain.speed.factor" class="input" type="number" min="0.25" max="4" step="0.05" /></label>
          </div>

          <div v-else-if="step.key === 'fade'" class="chain-body">
            <div class="field-row">
              <label class="field"><span class="field-label">淡入(s)</span>
                <input v-model.number="audioState.chain.fade.inSec" class="input" type="number" min="0" step="0.005" /></label>
              <label class="field"><span class="field-label">淡出(s)</span>
                <input v-model.number="audioState.chain.fade.outSec" class="input" type="number" min="0" step="0.005" /></label>
            </div>
          </div>

          <div v-else-if="step.key === 'channels'" class="chain-body">
            <label class="field"><span class="field-label">目标</span>
              <select v-model.number="audioState.chain.channels.target" class="select">
                <option :value="1">单声道</option>
                <option :value="2">立体声</option>
              </select></label>
          </div>

          <div v-else-if="step.key === 'resample'" class="chain-body">
            <label class="field"><span class="field-label">目标采样率</span>
              <select v-model.number="audioState.chain.resample.targetRate" class="select">
                <option v-for="rate in SAMPLE_RATES" :key="rate" :value="rate">{{ rate }} Hz</option>
              </select></label>
          </div>

          <div v-else-if="step.key === 'normalize'" class="chain-body">
            <label class="field"><span class="field-label">方式</span>
              <select v-model="audioState.chain.normalize.mode" class="select">
                <option value="lufs">响度标准化（EBU R128）</option>
                <option value="peak">峰值标准化</option>
              </select></label>
            <div v-if="audioState.chain.normalize.mode === 'lufs'" class="field-row">
              <label class="field"><span class="field-label">目标(LUFS)</span>
                <input v-model.number="audioState.chain.normalize.targetLufs" class="input" type="number" step="0.5" /></label>
              <label class="field"><span class="field-label">真峰值上限(dBTP)</span>
                <input v-model.number="audioState.chain.normalize.maxTruePeakDb" class="input" type="number" step="0.5" /></label>
            </div>
            <label v-else class="field"><span class="field-label">目标峰值(dBFS)</span>
              <input v-model.number="audioState.chain.normalize.targetPeakDb" class="input" type="number" step="0.5" /></label>
          </div>

          <div v-else-if="step.key === 'limiter'" class="chain-body">
            <label class="field"><span class="field-label">上限(dBFS)</span>
              <input v-model.number="audioState.chain.limiter.ceilingDb" class="input" type="number" step="0.5" /></label>
          </div>
        </div>
        <p class="muted small">各步骤按上方顺序依次作用，未勾选的步骤会被跳过。</p>
      </div>

      <div class="section">
        <h2 class="section-title">变体生成</h2>
        <label class="check-row">
          <input v-model="audioState.variants.enabled" type="checkbox" />
          <span>为每条素材生成多个微变体</span>
        </label>
        <template v-if="audioState.variants.enabled">
          <div class="field-row">
            <label class="field"><span class="field-label">数量</span>
              <input v-model.number="audioState.variants.count" class="input" type="number" min="1" max="12" /></label>
            <label class="field"><span class="field-label">随机种子</span>
              <input v-model.number="audioState.variants.seed" class="input" type="number" min="0" /></label>
          </div>
          <div class="field-row">
            <label class="field"><span class="field-label">音高 ±音分</span>
              <input v-model.number="audioState.variants.pitchCents" class="input" type="number" min="0" max="200" /></label>
            <label class="field"><span class="field-label">音量 ±dB</span>
              <input v-model.number="audioState.variants.gainDb" class="input" type="number" min="0" max="6" step="0.1" /></label>
          </div>
          <div class="field-row">
            <label class="field"><span class="field-label">裁剪起点 ≤占比</span>
              <input v-model.number="audioState.variants.trimRatio" class="input" type="number" min="0" max="0.5" step="0.01" /></label>
            <label class="field"><span class="field-label">时长变化 ≤占比</span>
              <input v-model.number="audioState.variants.durationRatio" class="input" type="number" min="0" max="0.5" step="0.01" /></label>
          </div>
          <div class="field-row">
            <label class="field"><span class="field-label">音色 ±dB</span>
              <input v-model.number="audioState.variants.eqDb" class="input" type="number" min="0" max="12" step="0.5" /></label>
          </div>
          <label class="check-row">
            <input v-model="audioState.variants.dedupe" type="checkbox" />
            <span>相似度去重（避免变体雷同）</span>
          </label>
        </template>
      </div>

      <div class="section">
        <h2 class="section-title">导出设置</h2>
        <label class="field"><span class="field-label">格式</span>
          <select v-model="audioState.exportSettings.format" class="select">
            <option v-for="format in availableFormats" :key="format.format" :value="format.format" :disabled="!format.available">
              {{ format.label }}{{ format.available ? '' : `（${format.hint}）` }}
            </option>
          </select></label>
        <p v-if="issue" class="warn">{{ issue }}</p>

        <label v-if="audioState.exportSettings.format === 'wav'" class="field">
          <span class="field-label">WAV 位深</span>
          <select v-model="audioState.exportSettings.wavEncoding" class="select">
            <option v-for="item in WAV_ENCODINGS" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label v-else-if="audioState.exportSettings.format === 'mp3'" class="field">
          <span class="field-label">MP3 码率</span>
          <select v-model.number="audioState.exportSettings.mp3Bitrate" class="select">
            <option v-for="rate in MP3_BITRATES" :key="rate" :value="rate">{{ rate }} kbps</option>
          </select>
        </label>
        <label v-else-if="audioState.exportSettings.format === 'ogg'" class="field">
          <span class="field-label">OGG 质量（0-10）</span>
          <input v-model.number="audioState.exportSettings.oggQuality" class="input" type="number" min="0" max="10" />
        </label>

        <label class="field">
          <span class="field-label">命名模板</span>
          <input v-model="audioState.exportSettings.nameTemplate" class="input template-input" type="text" spellcheck="false" placeholder="{name}_{variant}" />
        </label>
        <p class="muted small">占位符：{name} {preset} {variant} {index} {ext} · 预览：<span class="mono">{{ templatePreview }}</span></p>
        <label class="check-row">
          <input v-model="audioState.exportSettings.ensureUnique" type="checkbox" />
          <span>同名时自动追加序号</span>
        </label>
      </div>

      <div class="section">
        <h2 class="section-title">质检与命名规范</h2>
        <label class="field"><span class="field-label">单条时长上限(s)</span>
          <input v-model.number="audioState.maxDurationSec" class="input" type="number" min="1" /></label>
        <label class="field"><span class="field-label">素材名规范（正则）</span>
          <input v-model="audioState.namingPattern" class="input template-input" type="text" spellcheck="false" placeholder="^[a-z0-9_\-]+$" /></label>
        <p class="muted small">导入时校验素材名，不符合规范的条目会在素材列表中提示。</p>
      </div>

      <div class="section actions">
        <button class="btn btn-primary full" :disabled="busy || !hasAssets || !!issue" :title="issue" @click="runBatch()">
          {{ runLabel }}
        </button>
        <p v-if="audioState.notice" class="muted small">{{ audioState.notice }}</p>
        <button class="btn btn-ghost full" :disabled="busy || (!hasAssets && !outputs.length)" @click="onClear">清空素材与结果</button>
      </div>
    </section>

    <div v-if="audioState.error" class="toast-wrap">
      <div class="toast toast-error">
        <span>{{ audioState.error }}</span>
        <button class="toast-close" @click="dismissAudioError()">×</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-page { display: grid; grid-template-columns: 300px minmax(0, 1fr) 340px; height: 100%; min-height: 0; }
.tool-page.no-list { grid-template-columns: minmax(0, 1fr) 340px; }
.tool-sidebar { border-right: 1px solid var(--border); overflow: auto; }
.tool-sidepanel { border-left: 1px solid var(--border); overflow: auto; }
.tool-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tool-header { height: 64px; flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; border-bottom: 1px solid var(--border); }
.tool-header h2 { margin: 0; font-size: var(--fs-head); }
.tool-header p { margin: 2px 0 0; color: var(--text-faint); }
.tool-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding: 24px; }
.header-actions { display: flex; align-items: center; gap: var(--sp-3); }
.full { width: 100%; justify-content: center; }
.small { font-size: var(--fs-caption); }
.actions { display: flex; flex-direction: column; gap: var(--sp-2); }
.section > .field + .field, .section > .field + .check-row { margin-top: var(--sp-3); }
.section > p + .field, .section > .check-row + .field { margin-top: var(--sp-3); }
.field-row { display: flex; align-items: flex-end; gap: var(--sp-3); }
.field-row .field { flex: 1; min-width: 0; }
.field-row .input, .field-row .select { flex: 1; min-width: 0; width: 100%; }
.section .select { width: 100%; }
.template-input { width: 100%; font-family: var(--font-mono); font-size: var(--fs-caption); }

/* 素材库 */
.import-line { display: flex; justify-content: space-between; margin-top: var(--sp-2); font-size: var(--fs-caption); }
.asset-list { list-style: none; margin: 0; padding: var(--sp-2) var(--sp-4) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
.asset-item { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-raised); cursor: pointer; }
.asset-item.active { border-color: var(--accent-border); background: var(--accent-dim); }
.asset-head { display: flex; align-items: center; gap: var(--sp-2); }
.asset-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); }
.asset-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: 11px; }
.asset-issue { color: #fbbf24; font-size: 11px; }

/* 工作区卡片 */
.detail-card, .result-card { border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); }
.detail-head h3 { margin: 0; font-size: var(--fs-head); }
.detail-head p { margin: 2px 0 0; }
.player { width: 100%; height: 34px; }
.player.small { width: 200px; height: 30px; }

/* 裁剪选区工具条 */
.trim-bar { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.trim-fields { display: flex; align-items: flex-end; gap: var(--sp-3); }
.trim-fields .field { width: 110px; }
.trim-fields .input { width: 100%; }

/* 合成顺序 */
.merge-list { list-style: none; margin: var(--sp-3) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.merge-row { display: flex; align-items: center; gap: var(--sp-2); }
.merge-index { width: 16px; flex: none; text-align: center; font-size: 11px; color: var(--text-faint); }
.merge-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); }
.section > p + .btn { margin-top: var(--sp-3); }
.meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); margin: 0; }
.meta-grid dt { margin: 0; font-size: var(--fs-caption); color: var(--text-faint); }
.meta-grid dd { margin: 2px 0 0; }

/* 结果列表 */
.output-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.output-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-s); }
.output-main { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.output-head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.output-name { font-size: var(--fs-body); word-break: break-all; }
.output-meta { display: flex; flex-wrap: wrap; gap: var(--sp-3); font-size: 11px; }
.output-actions { display: flex; align-items: center; gap: var(--sp-2); flex: none; }
.finding-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
.finding.warn { color: #fbbf24; }
.finding.error { color: var(--danger); }

/* 处理链 */
.chain-step { padding: var(--sp-2) 0; border-top: 1px solid var(--border); }
.chain-step:first-of-type { border-top: none; }
.chain-index { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; background: var(--surface-hover); font: 10px var(--font-mono); color: var(--text-faint); }
.chain-body { margin: var(--sp-2) 0 0 24px; display: flex; flex-direction: column; gap: var(--sp-2); }

/* 预设 */
.preset-list { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.preset-row { display: flex; align-items: center; gap: var(--sp-2); }
.preset-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); }

.toast { display: flex; align-items: center; gap: var(--sp-3); }
.toast-close { color: inherit; font-size: 16px; line-height: 1; opacity: 0.7; }
.toast-close:hover { opacity: 1; }
</style>
