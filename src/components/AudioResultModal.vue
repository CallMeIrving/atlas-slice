<script setup lang="ts">
/**
 * 批量处理结果弹窗。
 * 逐条列出输出：可试听、可单独下载，也能一次性打包下载或导出质检报告。
 */

import { computed, onBeforeUnmount, ref } from 'vue'
import { claimAudition, releaseAudition } from '@/core/audio/audition'
import { AUDIO_FORMATS } from '@/core/audio/encode'
import {
  audioState,
  downloadAll,
  downloadOne,
  downloadReport,
  formatDb,
  formatLufs,
  presetLabel,
  removeOutput,
} from '@/store/audio'

const emit = defineEmits<{ close: [] }>()

const outputs = computed(() => audioState.outputs)

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

function findingClass(level: 'warn' | 'error'): string {
  return level === 'error' ? 'finding error' : 'finding warn'
}

// 试听互斥：本弹窗占用的播放位 key，关闭时统一让位
const claimed = new Set<string>()
const body = ref<HTMLElement>()

function onPlayerPlay(outputId: string, event: Event): void {
  const el = event.target
  if (!(el instanceof HTMLAudioElement)) return
  const key = `output:${outputId}`
  claimed.add(key)
  // 抢占播放位：素材库播放器与时间轴试听会被自动停掉
  claimAudition(key, () => el.pause())
}

function onPlayerStop(outputId: string): void {
  const key = `output:${outputId}`
  claimed.delete(key)
  releaseAudition(key)
}

onBeforeUnmount(() => {
  body.value?.querySelectorAll('audio').forEach((el) => el.pause())
  claimed.forEach((key) => releaseAudition(key))
  claimed.clear()
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal wide">
      <header class="modal-head">
        <div>
          <h2>处理结果（{{ outputs.length }}）</h2>
          <p>
            {{ presetLabel() }} ·
            {{ AUDIO_FORMATS.find((item) => item.format === audioState.exportSettings.format)?.label }}
          </p>
        </div>
        <button class="modal-close" @click="emit('close')">×</button>
      </header>

      <div ref="body" class="modal-body">
        <p v-if="!outputs.length" class="muted">本次没有生成文件。</p>
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
                <li v-for="(finding, i) in output.findings" :key="i" :class="findingClass(finding.level)">
                  {{ finding.message }}
                </li>
              </ul>
              <p v-else class="muted small">质检通过</p>
            </div>
            <div class="output-actions">
              <audio
                class="player"
                :src="output.previewUrl"
                controls
                preload="none"
                @play="onPlayerPlay(output.id, $event)"
                @pause="onPlayerStop(output.id)"
                @ended="onPlayerStop(output.id)"
              ></audio>
              <button class="btn btn-icon" title="下载" @click="downloadOne(output)">↓</button>
              <button class="btn btn-icon btn-danger" title="移除" @click="removeOutput(output.id)">×</button>
            </div>
          </li>
        </ul>
      </div>

      <footer class="modal-foot report-foot">
        <p class="muted small report-note">
          报告是本次批量的<strong>处理记录</strong>：每条输出一行，记录源文件、处理链动作与前后 LUFS / 峰值对比。
          CSV 便于用表格核对，JSON 带完整配置、便于脚本二次处理。文件本身用「打包下载 ZIP」取。
        </p>
        <div class="report-actions">
          <button class="btn" :disabled="!outputs.length" @click="downloadReport('csv')">报告 CSV</button>
          <button class="btn" :disabled="!outputs.length" @click="downloadReport('json')">报告 JSON</button>
          <button class="btn btn-primary" :disabled="!outputs.length" @click="downloadAll()">打包下载 ZIP</button>
          <button class="btn" @click="emit('close')">关闭</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal.wide {
  width: min(860px, calc(100vw - 48px));
}
.modal-body {
  max-height: min(62vh, 640px);
  overflow: auto;
}
.small {
  font-size: var(--fs-caption);
}
.report-foot {
  flex-wrap: wrap;
}
.report-note {
  margin: 0 auto 0 0;
  max-width: 46%;
  line-height: 1.45;
}
.report-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-left: auto;
}
.output-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.output-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-raised);
}
.output-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.output-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.output-name {
  font-size: var(--fs-body);
  word-break: break-all;
}
.output-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  font-size: 11px;
}
.output-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: none;
}
.player {
  width: 220px;
  height: 30px;
}
.finding-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
}
.finding.warn {
  color: #fbbf24;
}
.finding.error {
  color: var(--danger);
}
</style>
