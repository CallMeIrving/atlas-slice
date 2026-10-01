<script setup lang="ts">
/**
 * 音效生成弹窗。
 *
 * 三段式：选音效类型 → 调 5 项参数 → 一键生成 N 个变体，
 * 试听满意后勾选要保留的变体加入素材库，之后照常走处理链 / 批量导出 / 质检。
 * 合成完全是纯样本运算，不依赖 AudioContext，也不联网。
 */

import { computed, markRaw, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AudioWaveform from '@/components/AudioWaveform.vue'
import { claimAudition, releaseAudition } from '@/core/audio/audition'
import { buildWaveformPeaks, type AudioPcm } from '@/core/audio/pcm'
import { SAMPLE_RATES } from '@/core/audio/presets'
import {
  DEFAULT_SYNTH_VARIANTS,
  SYNTH_PRESETS,
  SYNTH_GROUPS,
  generateSynthCandidates,
  type SynthParams,
  type SynthPreset,
  type SynthVariantSettings,
} from '@/core/audio/synth'
import { encodeWav } from '@/core/audio/wav'
import { addGeneratedAssets, audioState } from '@/store/audio'

const emit = defineEmits<{ close: [] }>()

/** 波形绘制桶数：音效都很短，160 格已足够看清包络形状 */
const PREVIEW_BUCKETS = 160

interface CandidateView {
  index: number
  tag: string
  params: SynthParams
  pcm: AudioPcm
  peaks: Float32Array
  previewUrl: string
  selected: boolean
}

/** 参数名与单位，界面按此渲染滑杆 */
const PARAM_FIELDS: {
  key: keyof SynthParams
  label: string
  unit: string
  /** 显示时的小数位 */
  digits: number
  hint: string
}[] = [
  { key: 'baseFreq', label: '基频', unit: 'Hz', digits: 0, hint: '音高基准；噪声类预设用它作扫频基准' },
  { key: 'durationSec', label: '时长', unit: 's', digits: 2, hint: '整条音效的长度' },
  { key: 'attackSec', label: '包络·起音', unit: 's', digits: 3, hint: '从静音升到最大的时间' },
  { key: 'decaySec', label: '包络·衰减', unit: 's', digits: 3, hint: '从最大衰减到静音的时间' },
  { key: 'pitchSemitones', label: '音高变化量', unit: '半音', digits: 1, hint: '正数上扬、负数下沉；多音预设用它定音程' },
  { key: 'tone', label: '亮度', unit: '', digits: 2, hint: '周期波形影响谐波数量，噪声影响截止频率' },
]

const presetId = ref(SYNTH_PRESETS[0].id)
const params = ref<SynthParams>({ ...SYNTH_PRESETS[0].defaults })
const variants = ref<SynthVariantSettings>({ ...DEFAULT_SYNTH_VARIANTS })
const sampleRate = ref(48000)
const candidates = ref<CandidateView[]>([])
const generating = ref(false)

const preset = computed<SynthPreset>(
  () => SYNTH_PRESETS.find((item) => item.id === presetId.value) ?? SYNTH_PRESETS[0],
)

const groupedPresets = computed(() =>
  SYNTH_GROUPS.map((group) => ({
    group,
    items: SYNTH_PRESETS.filter((item) => item.group === group),
  })),
)

const selectedCount = computed(() => candidates.value.filter((item) => item.selected).length)
const allSelected = computed(
  () => candidates.value.length > 0 && selectedCount.value === candidates.value.length,
)

function selectPreset(id: string): void {
  const next = SYNTH_PRESETS.find((item) => item.id === id)
  if (!next) return
  presetId.value = id
  params.value = { ...next.defaults }
  clearCandidates()
}

function resetParams(): void {
  params.value = { ...preset.value.defaults }
}

// ---------------------------------------------------------------- 试听

/** 候选列表共用一个播放器，天然只可能响一条 */
const player = ref<HTMLAudioElement>()
const playingTag = ref('')

function stopPlay(): void {
  player.value?.pause()
  if (playingTag.value) releaseAudition(`synth:${playingTag.value}`)
  playingTag.value = ''
}

function togglePlay(item: CandidateView): void {
  const node = player.value
  if (!node) return
  if (playingTag.value === item.tag) {
    stopPlay()
    return
  }
  stopPlay()
  claimAudition(`synth:${item.tag}`, stopPlay)
  playingTag.value = item.tag
  node.src = item.previewUrl
  void node.play().catch(() => {
    stopPlay()
    audioState.error = '无法试听该音效，浏览器可能不支持该 WAV'
  })
}

/** 自然播完或被别的来源打断时清掉播放态 */
function onPlayerStop(): void {
  const node = player.value
  const tag = playingTag.value
  if (!node || !tag || !node.paused) return
  playingTag.value = ''
  releaseAudition(`synth:${tag}`)
}

// ---------------------------------------------------------------- 生成

function clearCandidates(): void {
  stopPlay()
  candidates.value.forEach((item) => URL.revokeObjectURL(item.previewUrl))
  candidates.value = []
}

async function generate(): Promise<void> {
  if (generating.value) return
  generating.value = true
  // 渲染是同步的，先让浏览器把「生成中」画出来再开算
  await nextTick()
  try {
    clearCandidates()
    const result = generateSynthCandidates(preset.value, params.value, variants.value, sampleRate.value)
    candidates.value = result.map((item) => {
      const bytes = encodeWav(item.pcm, 'pcm16')
      const blob = new Blob([bytes as BlobPart], { type: 'audio/wav' })
      return {
        index: item.index,
        tag: item.tag,
        params: item.params,
        pcm: markRaw(item.pcm),
        peaks: markRaw(buildWaveformPeaks(item.pcm, PREVIEW_BUCKETS)),
        previewUrl: URL.createObjectURL(blob),
        // 默认勾选，用户只需要取消掉不想要的
        selected: true,
      }
    })
  } finally {
    generating.value = false
  }
}

function toggleSelected(item: CandidateView): void {
  item.selected = !item.selected
}

function toggleAll(): void {
  const next = !allSelected.value
  candidates.value.forEach((item) => {
    item.selected = next
  })
}

function addSelected(): void {
  const picked = candidates.value.filter((item) => item.selected)
  if (picked.length === 0) return
  addGeneratedAssets(picked.map((item) => ({ pcm: item.pcm, stem: `${preset.value.id}_v${item.index + 1}` })))
  clearCandidates()
  emit('close')
}

function fmtDuration(seconds: number): string {
  const total = Math.round(seconds * 1000) / 1000
  return total < 1 ? `${Math.round(total * 1000)} ms` : `${total.toFixed(2)} s`
}

/** 参数摘要：让用户不试听也能看出这条变体改了什么 */
function summaryOf(item: CandidateView): string {
  const base = preset.value.defaults
  const cents = Math.round(1200 * Math.log2(item.params.baseFreq / base.baseFreq))
  const durationRatio = Math.round((item.params.durationSec / base.durationSec - 1) * 100)
  const parts = [
    `${Math.round(item.params.baseFreq)} Hz`,
    fmtDuration(item.params.durationSec),
    `音高 ${cents >= 0 ? '+' : ''}${cents} 音分`,
    `时长 ${durationRatio >= 0 ? '+' : ''}${durationRatio}%`,
  ]
  return parts.join(' · ')
}

// 换预设或关窗都要停掉正在响的试听
watch(presetId, () => stopPlay())
onBeforeUnmount(() => {
  stopPlay()
  candidates.value.forEach((item) => URL.revokeObjectURL(item.previewUrl))
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal wide">
      <header class="modal-head">
        <div>
          <h2>音效生成</h2>
          <p>选类型 → 调参数 → 生成多个变体 → 勾选要保留的加入素材库；全程本地合成，不联网</p>
        </div>
        <button class="modal-close" @click="emit('close')">×</button>
      </header>

      <div class="modal-body">
        <div class="grid">
          <section class="block">
            <h3 class="block-title">音效类型</h3>
            <div v-for="group in groupedPresets" :key="group.group" class="group">
              <p class="group-name">{{ group.group }}</p>
              <div class="preset-grid">
                <button
                  v-for="item in group.items"
                  :key="item.id"
                  class="preset-btn"
                  :class="{ active: item.id === presetId }"
                  @click="selectPreset(item.id)"
                >
                  {{ item.label }}
                </button>
              </div>
            </div>
            <p class="muted small">{{ preset.description }}</p>
            <p class="muted small">
              写实类（脚步、材质碰撞、角色语音）需要采样或物理建模，本工具不做。
            </p>
          </section>

          <section class="block">
            <h3 class="block-title">
              参数
              <button class="btn mini" @click="resetParams">重置</button>
            </h3>
            <div v-for="field in PARAM_FIELDS" :key="field.key" class="param">
              <div class="param-head">
                <span class="field-label" :title="field.hint">{{ field.label }}</span>
                <span class="param-value mono">
                  {{ params[field.key].toFixed(field.digits) }}<template v-if="field.unit"> {{ field.unit }}</template>
                </span>
              </div>
              <input
                v-model.number="params[field.key]"
                class="slider"
                type="range"
                :min="preset.ranges[field.key].min"
                :max="preset.ranges[field.key].max"
                :step="preset.ranges[field.key].step"
              />
            </div>

            <h3 class="block-title spaced">变体生成</h3>
            <div class="field-row">
              <label class="field"><span class="field-label">数量</span>
                <input v-model.number="variants.count" class="input" type="number" min="1" max="24" /></label>
              <label class="field"><span class="field-label">随机种子</span>
                <input v-model.number="variants.seed" class="input" type="number" min="0" /></label>
              <label class="field"><span class="field-label">采样率</span>
                <select v-model.number="sampleRate" class="select">
                  <option v-for="rate in SAMPLE_RATES" :key="rate" :value="rate">{{ rate }} Hz</option>
                </select></label>
            </div>
            <div class="field-row">
              <label class="field"><span class="field-label">音高 ±音分</span>
                <input v-model.number="variants.pitchCents" class="input" type="number" min="0" max="400" /></label>
              <label class="field"><span class="field-label">时长 ±占比</span>
                <input v-model.number="variants.durationRatio" class="input" type="number" min="0" max="0.5" step="0.01" /></label>
            </div>
            <div class="field-row">
              <label class="field"><span class="field-label">包络 ±占比</span>
                <input v-model.number="variants.envelopeRatio" class="input" type="number" min="0" max="0.5" step="0.01" /></label>
              <label class="field"><span class="field-label">亮度 ±</span>
                <input v-model.number="variants.tone" class="input" type="number" min="0" max="0.5" step="0.01" /></label>
            </div>
            <label class="check-row">
              <input v-model="variants.dedupe" type="checkbox" />
              <span>避免变体过于接近</span>
            </label>
            <p class="muted small">
              抖动直接作用在合成参数上，每个变体都是独立合成的，比后期微调差异更明显；同一种子可复现同一批结果。
            </p>

            <button class="btn btn-primary full" :disabled="generating" @click="generate()">
              {{ generating ? '生成中…' : `生成 ${variants.count} 个变体` }}
            </button>
          </section>
        </div>

        <section class="block result-block">
          <h3 class="block-title">
            候选变体
            <span v-if="candidates.length" class="muted small count">
              已选 {{ selectedCount }} / {{ candidates.length }}
            </span>
            <button v-if="candidates.length" class="btn mini" @click="toggleAll">
              {{ allSelected ? '取消全选' : '全选' }}
            </button>
          </h3>
          <p v-if="!candidates.length" class="muted small">还没有生成候选，调好参数后点「生成变体」。</p>
          <ul v-else class="candidate-list">
            <li v-for="item in candidates" :key="item.tag" class="candidate">
              <label class="check-row candidate-check">
                <input type="checkbox" :checked="item.selected" @change="toggleSelected(item)" />
              </label>
              <button
                class="btn btn-icon play-btn"
                :class="{ playing: playingTag === item.tag }"
                :title="playingTag === item.tag ? '停止试听' : '试听'"
                @click="togglePlay(item)"
              >
                {{ playingTag === item.tag ? '⏸' : '▶' }}
              </button>
              <div class="candidate-main">
                <div class="candidate-head">
                  <span class="mono">{{ item.tag }}</span>
                </div>
                <AudioWaveform :peaks="item.peaks" :height="26" color="#6a7080" />
                <span class="mono faint small">{{ summaryOf(item) }}</span>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <footer class="modal-foot">
        <p class="muted small foot-note">
          加入后这些音效会默认勾选，可直接用「批量编辑」套处理链与导出格式。
        </p>
        <button class="btn" @click="emit('close')">关闭</button>
        <button class="btn btn-primary" :disabled="!selectedCount" @click="addSelected()">
          加入素材列表（{{ selectedCount }}）
        </button>
      </footer>

      <audio ref="player" hidden preload="none" @pause="onPlayerStop" @ended="onPlayerStop"></audio>
    </div>
  </div>
</template>

<style scoped>
.modal.wide {
  width: min(920px, calc(100vw - 48px));
}
.modal-body {
  max-height: min(70vh, 760px);
  overflow: auto;
}
.small {
  font-size: var(--fs-caption);
}
.faint {
  color: var(--text-faint);
}
.full {
  width: 100%;
  justify-content: center;
}
.foot-note {
  margin: 0 auto 0 0;
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--sp-5);
  align-items: start;
}
.block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.block-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-title);
}
.block-title.spaced {
  margin-top: var(--sp-4);
}
.count {
  margin-left: auto;
}
.group + .group {
  margin-top: var(--sp-2);
}
.group-name {
  margin: 0 0 var(--sp-2);
  color: var(--text-faint);
  font-size: var(--fs-caption);
}
.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.preset-btn {
  flex: 1 1 auto;
  min-width: 88px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--fs-caption);
  cursor: pointer;
}
.preset-btn:hover {
  border-color: var(--border-strong);
}
.preset-btn.active {
  border-color: var(--accent-border);
  background: var(--accent-dim);
  color: var(--accent-strong);
}
.param + .param {
  margin-top: var(--sp-2);
}
.param-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}
.param-value {
  font-size: var(--fs-caption);
  color: var(--text-muted);
}
.mini {
  margin-left: auto;
  padding: 2px 8px;
  font-size: var(--fs-caption);
}
.slider {
  width: 100%;
  margin: 2px 0 0;
}
.field-row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
}
.field-row .field {
  flex: 1;
  min-width: 0;
}
.field .input,
.field .select {
  width: 100%;
}
.check-row + .field-row,
.field-row + .field-row,
.check-row + .field,
.field + .check-row {
  margin-top: var(--sp-2);
}
.result-block {
  margin-top: var(--sp-5);
}
.candidate-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.candidate {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-raised);
}
.candidate-check {
  margin: 0;
  padding-top: 4px;
}
.candidate-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.candidate-head {
  font-size: var(--fs-caption);
}
.play-btn {
  flex: none;
  width: 26px;
  height: 26px;
  font-size: 11px;
  line-height: 1;
}
.play-btn.playing {
  border-color: var(--accent-border);
  background: var(--accent-dim);
  color: var(--accent-strong);
}
</style>