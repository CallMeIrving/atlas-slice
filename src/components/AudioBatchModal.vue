<script setup lang="ts">
/**
 * 批量编辑弹窗。
 *
 * 批处理相关的配置全部集中在这里：平台预设 / 我的预设 / 处理链 / 变体生成 /
 * 导出设置 / 质检规范，配置与执行在同一个面板里完成；处理结束后由父组件切到结果弹窗。
 */

import { computed, ref } from 'vue'
import TaskProgress from '@/components/TaskProgress.vue'
import { AUDIO_FORMATS, MP3_BITRATES } from '@/core/audio/encode'
import { applyNameTemplate } from '@/core/audio/pipeline'
import { CHAIN_ORDER, PLATFORM_PRESETS, SAMPLE_RATES } from '@/core/audio/presets'
import { type WavEncoding } from '@/core/audio/wav'
import {
  applyPlatformPreset,
  applyUserPreset,
  audioState,
  cancelBatch,
  deleteUserPreset,
  formatIssue,
  presetLabel,
  runBatch,
  saveUserPreset,
  selectedAssets,
} from '@/store/audio'

const emit = defineEmits<{ close: []; finished: [] }>()

const presetName = ref('')

const WAV_ENCODINGS: { value: WavEncoding; label: string }[] = [
  { value: 'pcm16', label: '16 位整数（兼容性最好）' },
  { value: 'pcm24', label: '24 位整数（母版归档）' },
  { value: 'float32', label: '32 位浮点（无量化损失）' },
]

const issue = computed(() => formatIssue())
const running = computed(() => audioState.batch.running)
const selectedCount = computed(() => selectedAssets.value.length)
const presetDescription = computed(
  () =>
    PLATFORM_PRESETS.find((item) => item.id === audioState.platformPresetId)?.description ??
    '按需手动配置处理链参数',
)

/** 预期输出 = 勾选素材数 ×（开启变体时按变体数） */
const expectedCount = computed(
  () => selectedCount.value * (audioState.variants.enabled ? Math.max(0, audioState.variants.count) : 1),
)

/** 命名模板实时预览：用第一条勾选素材的名字渲染一个示例 */
const templatePreview = computed(() =>
  applyNameTemplate(audioState.exportSettings.nameTemplate || '{name}', {
    name: selectedAssets.value[0]?.fileName.replace(/\.[^.]+$/, '') ?? 'sound',
    preset: presetLabel(),
    variant: audioState.variants.enabled ? 'v1_+12c_+0.5dB' : '',
    index: 1,
    ext: AUDIO_FORMATS.find((item) => item.format === audioState.exportSettings.format)?.extension ?? 'wav',
  }),
)
const formatLabel = computed(
  () => AUDIO_FORMATS.find((item) => item.format === audioState.exportSettings.format)?.label ?? '',
)

function onPlatformChange(e: Event): void {
  const target = e.target
  if (target instanceof HTMLSelectElement) applyPlatformPreset(target.value)
}

function onSavePreset(): void {
  if (!presetName.value.trim()) return
  saveUserPreset(presetName.value)
  presetName.value = ''
}

async function start(): Promise<void> {
  await runBatch()
  if (audioState.outputs.length > 0) emit('finished')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="!running && emit('close')">
    <div class="modal w-[min(920px,calc(100vw-48px))]">
      <header class="modal-head">
        <div>
          <h2>批量编辑</h2>
          <p>只处理素材库中已勾选的素材；处理结果会单独列出并可逐条试听</p>
        </div>
        <button class="modal-close" :disabled="running" @click="emit('close')">×</button>
      </header>

      <div class="modal-body max-h-[min(68vh,720px)] overflow-auto">
        <TaskProgress
          v-if="running || audioState.batch.error"
          :running="running"
          :cancelling="audioState.batch.cancelling"
          :done="audioState.batch.done"
          :total="audioState.batch.total"
          :text="audioState.batch.text"
          :error="audioState.batch.error"
          @cancel="cancelBatch()"
        />

        <div
          class="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-5 [&_.field-row]:items-end [&_.field-row]:gap-3 [&_.field-row_.field]:min-w-0 [&_.field-row_.field]:flex-1 [&_.field-row_.select]:flex-1 [&_.field_.input]:w-full [&_.field_.select]:w-full [&_.check-row+.field]:mt-1 [&_.check-row+.field-row]:mt-1 [&_.field+.field]:mt-1 [&_.field+.field-row]:mt-1 [&_.field-row+.field]:mt-1 [&_.field-row+.field-row]:mt-1 [&_.field-row+.check-row]:mt-1"
        >
          <div class="flex min-w-0 flex-col gap-4">
            <section class="flex flex-col gap-2">
              <h3 class="m-0 border-b border-line pb-2 text-title">平台预设</h3>
              <label class="field">
                <span class="field-label">选择规范</span>
                <select class="select" :value="audioState.platformPresetId" @change="onPlatformChange">
                  <option value="">自定义（不套用）</option>
                  <option v-for="preset in PLATFORM_PRESETS" :key="preset.id" :value="preset.id">
                    {{ preset.label }}
                  </option>
                </select>
              </label>
              <p class="muted text-caption">{{ presetDescription }}</p>
            </section>

            <section class="flex flex-col gap-2">
              <h3 class="m-0 border-b border-line pb-2 text-title">我的预设</h3>
              <div class="field-row">
                <input v-model="presetName" class="input" type="text" placeholder="预设名称" />
                <button class="btn" :disabled="!presetName.trim()" @click="onSavePreset">保存</button>
              </div>
              <p v-if="!audioState.userPresets.length" class="muted text-caption">
                保存后可一键恢复整套处理链与变体配置。
              </p>
              <ul v-else class="m-0 flex list-none flex-col gap-2 p-0">
                <li v-for="preset in audioState.userPresets" :key="preset.id" class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-caption" :title="preset.name">{{ preset.name }}</span>
                  <button class="btn" @click="applyUserPreset(preset.id)">套用</button>
                  <button class="btn btn-icon btn-danger" title="删除" @click="deleteUserPreset(preset.id)">×</button>
                </li>
              </ul>
            </section>

            <section class="flex flex-col gap-2">
              <h3 class="m-0 border-b border-line pb-2 text-title">处理链（固定顺序）</h3>
              <div v-for="(step, i) in CHAIN_ORDER" :key="step.key" class="border-t border-line py-2 [&:first-of-type]:border-t-0">
                <label class="check-row">
                  <input v-model="audioState.chain[step.key].enabled" type="checkbox" />
                  <span class="inline-flex h-4 w-4 flex-none items-center justify-center rounded-[3px] bg-hover font-mono text-[10px] text-faint">{{ i + 1 }}</span>
                  <span>{{ step.label }}</span>
                </label>

                <div v-if="step.key === 'crop'" class="m-0 mt-2 ml-6 flex flex-col gap-2">
                  <div class="field-row">
                    <label class="field"><span class="field-label">起点(s)</span>
                      <input v-model.number="audioState.chain.crop.startSec" class="input" type="number" min="0" step="0.01" /></label>
                    <label class="field"><span class="field-label">终点(s)</span>
                      <input v-model.number="audioState.chain.crop.endSec" class="input" type="number" min="0" step="0.01" /></label>
                  </div>
                  <p class="muted text-caption">终点填 0 表示裁到结尾。</p>
                </div>

                <div v-else-if="step.key === 'trimSilence'" class="m-0 mt-2 ml-6 flex flex-col gap-2">
                  <div class="field-row">
                    <label class="field"><span class="field-label">阈值(dBFS)</span>
                      <input v-model.number="audioState.chain.trimSilence.thresholdDb" class="input" type="number" step="1" /></label>
                    <label class="field"><span class="field-label">头部保留(s)</span>
                      <input v-model.number="audioState.chain.trimSilence.headSec" class="input" type="number" min="0" step="0.005" /></label>
                    <label class="field"><span class="field-label">尾部保留(s)</span>
                      <input v-model.number="audioState.chain.trimSilence.tailSec" class="input" type="number" min="0" step="0.005" /></label>
                  </div>
                </div>

                <div v-else-if="step.key === 'speed'" class="m-0 mt-2 ml-6 flex flex-col gap-2">
                  <label class="field"><span class="field-label">速率倍率（音高联动）</span>
                    <input v-model.number="audioState.chain.speed.factor" class="input" type="number" min="0.25" max="4" step="0.05" /></label>
                </div>

                <div v-else-if="step.key === 'fade'" class="m-0 mt-2 ml-6 flex flex-col gap-2">
                  <div class="field-row">
                    <label class="field"><span class="field-label">淡入(s)</span>
                      <input v-model.number="audioState.chain.fade.inSec" class="input" type="number" min="0" step="0.005" /></label>
                    <label class="field"><span class="field-label">淡出(s)</span>
                      <input v-model.number="audioState.chain.fade.outSec" class="input" type="number" min="0" step="0.005" /></label>
                  </div>
                </div>

                <div v-else-if="step.key === 'channels'" class="m-0 mt-2 ml-6 flex flex-col gap-2">
                  <label class="field"><span class="field-label">目标</span>
                    <select v-model.number="audioState.chain.channels.target" class="select">
                      <option :value="1">单声道</option>
                      <option :value="2">立体声</option>
                    </select></label>
                </div>

                <div v-else-if="step.key === 'resample'" class="m-0 mt-2 ml-6 flex flex-col gap-2">
                  <label class="field"><span class="field-label">目标采样率</span>
                    <select v-model.number="audioState.chain.resample.targetRate" class="select">
                      <option v-for="rate in SAMPLE_RATES" :key="rate" :value="rate">{{ rate }} Hz</option>
                    </select></label>
                </div>

                <div v-else-if="step.key === 'normalize'" class="m-0 mt-2 ml-6 flex flex-col gap-2">
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

                <div v-else-if="step.key === 'limiter'" class="m-0 mt-2 ml-6 flex flex-col gap-2">
                  <label class="field"><span class="field-label">上限(dBFS)</span>
                    <input v-model.number="audioState.chain.limiter.ceilingDb" class="input" type="number" step="0.5" /></label>
                </div>
              </div>
              <p class="muted text-caption">各步骤按上方顺序依次作用，未勾选的步骤会被跳过。</p>
            </section>
          </div>

          <div class="flex min-w-0 flex-col gap-4">
            <section class="flex flex-col gap-2">
              <h3 class="m-0 border-b border-line pb-2 text-title">变体生成</h3>
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
                <label class="field"><span class="field-label">音色 ±dB</span>
                  <input v-model.number="audioState.variants.eqDb" class="input" type="number" min="0" max="12" step="0.5" /></label>
                <label class="check-row">
                  <input v-model="audioState.variants.dedupe" type="checkbox" />
                  <span>相似度去重（避免变体雷同）</span>
                </label>
              </template>
            </section>

            <section class="flex flex-col gap-2">
              <h3 class="m-0 border-b border-line pb-2 text-title">导出设置（批量）</h3>
              <label class="field"><span class="field-label">格式</span>
                <select v-model="audioState.exportSettings.format" class="select">
                  <option
                    v-for="format in AUDIO_FORMATS"
                    :key="format.format"
                    :value="format.format"
                    :disabled="!format.available"
                  >
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
                <input
                  v-model="audioState.exportSettings.nameTemplate"
                  class="input font-mono text-caption"
                  type="text"
                  spellcheck="false"
                  placeholder="{name}_{variant}"
                />
              </label>
              <p class="muted text-caption">
                占位符：{name} {preset} {variant} {index} {ext} · 预览：<span class="mono">{{ templatePreview }}</span>
              </p>
              <label class="check-row">
                <input v-model="audioState.exportSettings.ensureUnique" type="checkbox" />
                <span>同名时自动追加序号</span>
              </label>
            </section>

            <section class="flex flex-col gap-2">
              <h3 class="m-0 border-b border-line pb-2 text-title">质检与命名规范</h3>
              <label class="field"><span class="field-label">单条时长上限(s)</span>
                <input v-model.number="audioState.maxDurationSec" class="input" type="number" min="1" /></label>
              <label class="field"><span class="field-label">素材名规范（正则）</span>
                <input
                  v-model="audioState.namingPattern"
                  class="input font-mono text-caption"
                  type="text"
                  spellcheck="false"
                  placeholder="^[a-z0-9_\-]+$"
                /></label>
              <p class="muted text-caption">
                导入时按此校验素材名，不符合规范的条目会在素材列表中提示；时长上限用于结果质检。
              </p>
            </section>

            <section class="flex flex-col gap-2">
              <h3 class="m-0 border-b border-line pb-2 text-title">本次输出</h3>
              <dl class="m-0 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 [&_dt]:m-0 [&_dt]:text-caption [&_dt]:text-faint [&_dd]:mt-0.5 [&_dd]:mb-0">
                <div><dt>已勾选素材</dt><dd class="mono">{{ selectedCount }} / {{ audioState.assets.length }} 条</dd></div>
                <div><dt>预设</dt><dd class="mono">{{ presetLabel() }}</dd></div>
                <div><dt>导出格式</dt><dd class="mono">{{ formatLabel }}</dd></div>
                <div><dt>预期文件</dt><dd class="mono">{{ expectedCount }} 个</dd></div>
              </dl>
              <p v-if="!selectedCount" class="warn">素材库中还没有勾选任何素材，请先勾选后再处理。</p>
              <p class="muted text-caption">合成音频的单文件导出在右侧「合成导出」中设置，与这里互不影响。</p>
            </section>
          </div>
        </div>
      </div>

      <footer class="modal-foot">
        <p v-if="audioState.notice" class="muted m-0 mr-auto text-caption">{{ audioState.notice }}</p>
        <button class="btn" :disabled="running" @click="emit('close')">关闭</button>
        <button
          class="btn btn-primary"
          :disabled="running || !selectedCount || !!issue"
          :title="issue || (!selectedCount ? '请先勾选要处理的素材' : '')"
          @click="start()"
        >
          {{ running ? '处理中…' : '开始处理' }}
        </button>
      </footer>
    </div>
  </div>
</template>
