<script setup lang="ts">
import { computed } from 'vue'
import {
  workspace,
  type LayerBackgroundMode,
  type LayerCategory,
  type LayerClassSpec,
  type LayerDetector,
} from '@/store/workspace'

/**
 * 图层拆分设置字段。
 * 直接绑定 workspace.layersplit.settings，页面只负责「开始拆分」按钮，
 * 与抽帧设置字段（ExtractSettingsFields）保持同一范式。
 */

const CATEGORY_OPTIONS: { value: LayerCategory; label: string }[] = [
  { value: 'button', label: '按钮' },
  { value: 'icon', label: '图标' },
  { value: 'text', label: '文本' },
  { value: 'panel', label: '面板' },
  { value: 'border', label: '边框' },
  { value: 'decoration', label: '装饰' },
  { value: 'progress', label: '进度条' },
  { value: 'background', label: '背景' },
  { value: 'other', label: '其它' },
]

const DETECTOR_OPTIONS: { value: LayerDetector; label: string }[] = [
  { value: 'grounding-dino', label: 'GroundingDINO（开放词表，推荐）' },
  { value: 'florence2', label: 'Florence-2（需额外权重）' },
  { value: 'auto', label: '自动（优先 DINO，缺权重时回落）' },
]

const BACKGROUND_OPTIONS: { value: LayerBackgroundMode; label: string; hint: string }[] = [
  { value: 'inpaint', label: '修复重建（默认）', hint: '用 OpenCV Telea 修补元素位置，大块区域会涂抹、丢纹理。' },
  { value: 'erase', label: '擦除为透明', hint: '元素位置置为透明，诚实但叠加时仍会露出残影。' },
  { value: 'none', label: '保留原像素', hint: '背景层就是原图，元素会在背景上重复一份。' },
]

/** 预设：界面类型不同，需要拆的类别也不同，避免每次手填七个提示词 */
const PRESETS: { name: string; classes: LayerClassSpec[] }[] = [
  {
    name: '商店面板',
    classes: [
      { label: '面板', prompt: 'panel', category: 'panel' },
      { label: '按钮', prompt: 'button', category: 'button' },
      { label: '图标', prompt: 'icon', category: 'icon' },
      { label: '文本', prompt: 'text', category: 'text' },
      { label: '进度条', prompt: 'progress bar', category: 'progress' },
      { label: '装饰', prompt: 'decoration', category: 'decoration' },
    ],
  },
  {
    name: '背包',
    classes: [
      { label: '面板', prompt: 'panel', category: 'panel' },
      { label: '格子边框', prompt: 'slot border', category: 'border' },
      { label: '图标', prompt: 'item icon', category: 'icon' },
      { label: '文本', prompt: 'text', category: 'text' },
      { label: '按钮', prompt: 'button', category: 'button' },
    ],
  },
  {
    name: 'HUD',
    classes: [
      { label: '面板', prompt: 'hud panel', category: 'panel' },
      { label: '进度条', prompt: 'progress bar', category: 'progress' },
      { label: '图标', prompt: 'icon', category: 'icon' },
      { label: '文本', prompt: 'text', category: 'text' },
      { label: '装饰', prompt: 'decoration', category: 'decoration' },
    ],
  },
  {
    name: '战斗结算',
    classes: [
      { label: '面板', prompt: 'panel', category: 'panel' },
      { label: '文本', prompt: 'text', category: 'text' },
      { label: '按钮', prompt: 'button', category: 'button' },
      { label: '图标', prompt: 'icon', category: 'icon' },
      { label: '装饰', prompt: 'decoration', category: 'decoration' },
    ],
  },
]

const settings = computed(() => workspace.layersplit.settings)
/** 启用中的类别数量：一个都没有时后端会 422，这里提前提示 */
const enabledCount = computed(() => settings.value.classes.filter((item) => item.enabled !== false).length)
const backgroundHint = computed(
  () => BACKGROUND_OPTIONS.find((item) => item.value === settings.value.background)?.hint ?? '',
)

function applyPreset(preset: (typeof PRESETS)[number]): void {
  settings.value.classes = preset.classes.map((item) => ({ ...item }))
}

function addClass(): void {
  settings.value.classes.push({ label: '新元素', prompt: 'element', category: 'other' })
}

function removeClass(index: number): void {
  settings.value.classes.splice(index, 1)
}
</script>

<template>
  <div class="flex flex-col">
    <div class="section">
      <h2 class="section-title">类别预设</h2>
      <div class="flex flex-wrap gap-2">
        <button v-for="preset in PRESETS" :key="preset.name" class="btn btn-ghost" @click="applyPreset(preset)">
          {{ preset.name }}
        </button>
      </div>
    </div>

    <div class="section [&>div+div]:mt-1 [&>div+button]:mt-3">
      <h2 class="section-title">元素类别（{{ enabledCount }} 个启用）</h2>
      <p class="muted">
        提示词必须是英文：模型词表由训练语料决定，中文提示词会静默返回 0 个框。「名称」只影响界面与导出文件名。
      </p>
      <div
        v-for="(item, index) in settings.classes"
        :key="index"
        class="mt-2 grid grid-cols-[20px_minmax(0,0.9fr)_minmax(0,1fr)_84px_28px] items-center gap-2"
      >
        <label class="check-row m-0 gap-0">
          <input
            type="checkbox"
            :checked="item.enabled !== false"
            :title="item.enabled === false ? '已停用，不会提交给服务端' : '已启用'"
            @change="item.enabled = ($event.target as HTMLInputElement).checked"
          />
        </label>
        <input v-model="item.label" class="input min-w-0 text-caption" placeholder="名称" maxlength="48" />
        <input v-model="item.prompt" class="input mono min-w-0 text-caption" placeholder="prompt" maxlength="96" />
        <select v-model="item.category" class="select min-w-0 text-caption">
          <option v-for="option in CATEGORY_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <button class="btn btn-ghost" title="删除该类别" @click="removeClass(index)">×</button>
      </div>
      <button class="btn w-full justify-center" @click="addClass">添加类别</button>
      <div v-if="!enabledCount" class="warn">至少启用一个类别，否则服务端会拒绝这次请求。</div>
    </div>

    <div class="section">
      <h2 class="section-title">模型与设备</h2>
      <div class="field">
        <span class="field-label">检测器</span>
        <select v-model="settings.detector" class="select">
          <option v-for="option in DETECTOR_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
      <label class="check-row"><input v-model="settings.ocr" type="checkbox" /> 识别文本（用 Florence-2 取紧致笔画，需额外权重）</label>
    </div>

    <div class="section [&_.field+.field]:mt-3 [&_.check-row+.field]:mt-3 [&_p+.field]:mt-3">
      <h2 class="section-title">阈值</h2>
      <label class="field">
        <span class="field-label">检测框阈值 {{ settings.boxThreshold.toFixed(2) }}（越低越容易多框）</span>
        <input v-model.number="settings.boxThreshold" class="range w-full accent-accent" type="range" min="0.05" max="0.9" step="0.05" />
      </label>
      <label class="field">
        <span class="field-label">文本阈值 {{ settings.textThreshold.toFixed(2) }}（同时决定笔画与底色的灰度差）</span>
        <input v-model.number="settings.textThreshold" class="range w-full accent-accent" type="range" min="0.05" max="0.9" step="0.05" />
      </label>
      <label class="field">
        <span class="field-label">同类别去重 IoU {{ settings.nmsIou.toFixed(2) }}</span>
        <input v-model.number="settings.nmsIou" class="range w-full accent-accent" type="range" min="0.3" max="0.95" step="0.05" />
      </label>
      <label class="field">
        <span class="field-label">最小面积 {{ settings.minArea }} px（小于它的碎块丢弃）</span>
        <input v-model.number="settings.minArea" class="input" type="number" min="1" />
      </label>
    </div>

    <div class="section [&_.field+.field]:mt-3 [&_.check-row+.field]:mt-3 [&_p+.field]:mt-3">
      <h2 class="section-title">输出</h2>
      <label class="field">
        <span class="field-label">推理长边上限 {{ settings.maxSide }} px（超出等比缩小，坐标会映射回原图）</span>
        <input v-model.number="settings.maxSide" class="input" type="number" min="64" step="64" />
      </label>
      <label class="field">
        <span class="field-label">图层数上限 {{ settings.maxLayers }}（超出按 分数×面积 截断）</span>
        <input v-model.number="settings.maxLayers" class="input" type="number" min="1" />
      </label>
      <label class="field">
        <span class="field-label">羽化半径 {{ settings.feather }} px</span>
        <input v-model.number="settings.feather" class="range w-full accent-accent" type="range" min="0" max="8" />
      </label>
      <div class="field">
        <span class="field-label">背景层策略</span>
        <select v-model="settings.background" class="select">
          <option v-for="option in BACKGROUND_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
      <p class="muted">{{ backgroundHint }}</p>
      <label class="check-row">
        <input v-model="settings.exclusiveLayers" type="checkbox" />
        独占裁剪（把子层从父层里减掉）
      </label>
      <p class="muted">
        开启后「叠加全部图层 ≈ 还原原图」，代价是父层出现空洞、单独看不好用；默认关闭，保留完整的父层。
      </p>
    </div>
  </div>
</template>