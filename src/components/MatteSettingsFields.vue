<script setup lang="ts">
import { computed, watch } from 'vue'
import { workspace, type FrameMatteMode } from '@/store/workspace'
import { hexToRgb, rgbToHex } from '@/core/frame-matte'
import {
  deviceOptions,
  dtypeOptions,
  imglyDtypeForModel,
  imglyModelForDtype,
  resolveDevice,
  resolveDtype,
  type AiEngine,
  type MatteDevice,
  type MatteDtype,
} from '@/core/ai-matting'

/**
 * 帧抠图设置字段。
 * 绑定 workspace.video.matte（抠图方式、影子、容差、基准色）与 workspace.matte 的 AI 偏好，
 * 帧抠图弹窗与一键处理弹窗共用。
 * 推理设备与模型精度按所选抠图方式对应的模型能力过滤：模型没有的精度、跑不了的设备都不出现。
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
/** 当前抠图方式对应的 AI 引擎，纯色方式为 null */
const engine = computed<AiEngine | null>(() => (isSolid.value ? null : (workspace.video.matte.mode as AiEngine)))
/**
 * 当前生效的精度：ISNet 的精度由 imglyModel 决定（其余引擎走共享的 aiDtype），
 * 因此这里既做精度映射，也把引擎不支持的精度收敛掉。
 */
const currentDtype = computed<MatteDtype>(() => {
  const target = engine.value
  if (!target) return workspace.matte.aiDtype
  if (target === 'imgly') return imglyDtypeForModel(workspace.matte.imglyModel)
  return resolveDtype(target, workspace.matte.aiDtype)
})
/** 当前引擎可选的精度与设备选项 */
const dtypes = computed(() => (engine.value ? dtypeOptions(engine.value) : []))
const devices = computed(() => deviceOptions(currentDtype.value))

/** 精度下拉：ISNet 写回 imglyModel，其余引擎写回 aiDtype */
const dtypeValue = computed<MatteDtype>({
  get: () => currentDtype.value,
  set: (value) => {
    if (workspace.video.matte.mode === 'imgly') workspace.matte.imglyModel = imglyModelForDtype(value)
    else workspace.matte.aiDtype = value
  },
})

const deviceValue = computed<MatteDevice>({
  get: () => resolveDevice(currentDtype.value, workspace.matte.aiDevice),
  set: (value) => { workspace.matte.aiDevice = value },
})

/**
 * 切换抠图方式或精度后，把精度与设备真正写回支持的取值。
 * 只靠下拉的 getter 收敛不够：字段被隐藏时旧值仍会参与推理。
 */
watch(
  () => [workspace.video.matte.mode, workspace.matte.aiDtype, workspace.matte.aiDevice, workspace.matte.imglyModel] as const,
  () => {
    const target = engine.value
    if (!target) return
    if (target !== 'imgly') {
      const dtype = resolveDtype(target, workspace.matte.aiDtype)
      if (dtype !== workspace.matte.aiDtype) workspace.matte.aiDtype = dtype
    }
    const device = resolveDevice(currentDtype.value, workspace.matte.aiDevice)
    if (device !== workspace.matte.aiDevice) workspace.matte.aiDevice = device
  },
  { immediate: true },
)

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
        <select v-model="deviceValue" class="select">
          <option v-for="option in devices" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">模型精度</span>
        <select v-model="dtypeValue" class="select">
          <option v-for="option in dtypes" :key="option.value" :value="option.value">{{ option.label }}</option>
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