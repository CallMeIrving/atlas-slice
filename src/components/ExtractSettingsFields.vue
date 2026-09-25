<script setup lang="ts">
import { computed } from 'vue'
import { workspace } from '@/store/workspace'
import { expectedFrameCount, extractOptionsFrom, extractRangeError } from '@/core/frame-extract'

/**
 * 抽帧设置字段。
 * 直接绑定 workspace.video 的抽帧参数，视频帧页与一键处理弹窗共用，
 * 因此「开始抽帧」按钮与流水线执行按钮各自留在父组件里。
 */
const options = computed(() => extractOptionsFrom(workspace.video))
/** 参数校验提示（空串表示合法） */
const rangeError = computed(() => extractRangeError(options.value, workspace.video.duration, Boolean(workspace.video.sourceUrl)))
/** 预计抽出的帧数 */
const expectedCount = computed(() => expectedFrameCount(options.value))
/** 按 RGBA 逐像素估算的内存占用（MB） */
const estimatedMb = computed(() => Math.round(expectedCount.value * Math.max(1, workspace.video.width * workspace.video.height * 4 / 1024 / 1024)))
</script>

<template>
  <div class="extract-fields">
    <div class="field">
      <span class="field-label">抽帧模式</span>
      <select v-model="workspace.video.mode" class="select">
        <option value="count">按数量均匀抽取</option>
        <option value="fps">按帧率抽取</option>
      </select>
    </div>
    <div v-if="workspace.video.mode === 'count'" class="field">
      <span class="field-label">目标帧数</span>
      <input v-model.number="workspace.video.count" class="input" min="1" max="300" type="number" />
    </div>
    <div v-else class="field">
      <span class="field-label">目标 FPS</span>
      <input v-model.number="workspace.video.targetFps" class="input" min="1" max="60" type="number" />
    </div>
    <div class="field">
      <span class="field-label">时间区间（秒）</span>
      <div class="inline">
        <input v-model.number="workspace.video.start" class="input" min="0" :max="workspace.video.duration" type="number" />
        <span>—</span>
        <input v-model.number="workspace.video.end" class="input" min="0" :max="workspace.video.duration" type="number" />
      </div>
    </div>
    <div v-if="rangeError" class="range-error">{{ rangeError }}</div>
    <label class="check-row"><input v-model="workspace.video.flipX" type="checkbox" /> 左右翻转</label>
    <div class="field">
      <span class="field-label">旋转</span>
      <select v-model.number="workspace.video.rotation" class="select">
        <option :value="0">0°</option>
        <option :value="90">90°</option>
        <option :value="180">180°</option>
        <option :value="270">270°</option>
      </select>
    </div>
    <div class="estimate">
      <span>预计帧数</span>
      <strong>{{ expectedCount }}</strong>
      <small>{{ workspace.video.width }} × {{ workspace.video.height }} · {{ estimatedMb }} MB</small>
    </div>
  </div>
</template>

<style scoped>
.extract-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.inline {
  display: flex;
  align-items: center;
  gap: 8px;
}

.inline .input {
  width: 100px;
}

.range-error {
  color: var(--danger);
  font-size: var(--fs-caption);
}

.estimate {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
}

.estimate strong {
  font: 20px var(--font-mono);
  color: var(--accent);
}

.estimate small {
  color: var(--text-faint);
}
</style>