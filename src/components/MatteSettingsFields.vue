<script setup lang="ts">
import { computed } from 'vue'
import { workspace, type FrameMatteMode } from '@/store/workspace'
import { hexToRgb, rgbToHex } from '@/core/frame-matte'

/**
 * 帧抠图设置字段。
 * 绑定 workspace.video.matte（抠图方式、影子、容差、基准色）与 workspace.matte 的 AI 偏好，
 * 帧抠图弹窗与一键处理弹窗共用。
 */
const props = withDefaults(
  defineProps<{
    /** 预览图上自动采样到的背景基准色（#rrggbb），仅在纯色方式下用于展示 */
    autoBaseHex?: string
  }>(),
  { autoBaseHex: '' },
)

const modeOptions: { value: FrameMatteMode; label: string }[] = [
  { value: 'solid', label: '纯色背景（本地算法，零等待）' },
  { value: 'imgly', label: 'ISNet（imgly）AI 模型' },
  { value: 'birefnet', label: 'BiRefNet AI 模型' },
  { value: 'rmbg', label: 'RMBG-1.4（BRIA）AI 模型' },
]

const isSolid = computed(() => workspace.video.matte.mode === 'solid')
/** 手动基准色（已规范化为小写 #rrggbb） */
const manualHex = computed(() => {
  const rgb = hexToRgb(workspace.video.matte.baseColor)
  return rgb ? rgbToHex(rgb.r, rgb.g, rgb.b) : ''
})
/** 展示用的基准色：手动优先，其次自动采样 */
const baseHex = computed(() => manualHex.value || props.autoBaseHex || '—')

/** 清除手动基准色，恢复自动采样 */
function resetBaseColor(): void {
  workspace.video.matte.baseColor = ''
}
</script>

<template>
  <div class="matte-fields">
    <label class="field">
      <span class="field-label">抠图方式</span>
      <select v-model="workspace.video.matte.mode" class="select">
        <option v-for="option in modeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <template v-if="isSolid">
      <label class="field">
        <span class="field-label">影子处理</span>
        <select v-model="workspace.video.matte.shadow" class="select">
          <option value="neutral">保留影子（转中性半透明）</option>
          <option value="remove">连影子一起抠掉</option>
          <option value="ignore">保留原样（影子带背景色）</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">颜色容差 {{ workspace.video.matte.tolerance }}</span>
        <input v-model.number="workspace.video.matte.tolerance" class="range" type="range" min="4" max="60" step="1" />
      </label>
      <div class="field">
        <span class="field-label">背景基准色</span>
        <div class="base-row">
          <span class="chip" :style="{ background: baseHex }"></span>
          <span class="mono faint">{{ baseHex }}{{ manualHex ? ' · 手动' : ' · 自动采样' }}</span>
          <button class="btn" :disabled="!workspace.video.matte.baseColor" @click="resetBaseColor">恢复自动</button>
        </div>
      </div>
    </template>
    <template v-else>
      <label class="field">
        <span class="field-label">推理设备</span>
        <select v-model="workspace.matte.aiDevice" class="select">
          <option value="cpu">CPU（兼容性最好）</option>
          <option value="gpu">GPU / WebGPU（需浏览器支持）</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">模型精度</span>
        <select v-model="workspace.matte.aiDtype" class="select">
          <option value="fp16">FP16（推荐）</option>
          <option value="q8">Q8（体积小、速度快）</option>
          <option value="fp32">FP32（精度最高）</option>
        </select>
      </label>
    </template>
  </div>
</template>

<style scoped>
.matte-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-3) var(--sp-4);
}

.base-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.base-row .chip {
  width: 22px;
  height: 22px;
  flex: none;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-s);
}

.range {
  width: 100%;
  accent-color: var(--accent);
}
</style>