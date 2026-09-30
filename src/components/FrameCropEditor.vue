<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { clampCropRect, drawCropToCanvas, inscribedRect, type ImageCropRect } from '@/core/crop'
import { useRoiSelection } from '@/composables/useRoiSelection'

/**
 * 通用区域框选编辑器（裁切 / 去水印共用）。
 * 舞台 + 8 个控制点 + 框外压暗 + X/Y/宽/高 输入 + 实时预览；
 * 区域持有方是父组件（v-model），附加工具与说明通过插槽注入；
 * 拖拽交互状态机由 useRoiSelection 提供，本组件只负责舞台测量与像素定位。
 */
const props = withDefaults(
  defineProps<{
    /** 框选输入图像（已抠图的帧传抠图结果，去水印传原始画面） */
    sourceUrl: string
    /** 当前区域（图像像素坐标） */
    modelValue: ImageCropRect
    /** 第一栏说明文案 */
    caption?: string
    /** 是否显示宽高比预设（去水印等不需要比例约束的场景可关闭） */
    showRatio?: boolean
    /** 是否显示右侧预览栏（父组件自带放大对比时可关闭） */
    showPreview?: boolean
    /** 是否显示「整帧」快捷操作 */
    showFullFrame?: boolean
  }>(),
  {
    caption: '框选区域 · 拖拽空白处重新框选，拖动框体移动，拖动控制点调整大小',
    showRatio: true,
    showPreview: true,
    showFullFrame: true,
  },
)
const emit = defineEmits<{ 'update:modelValue': [value: ImageCropRect] }>()

/** 预设宽高比（宽 ÷ 高），0 表示不限制 */
const RATIO_PRESETS: { label: string; value: number }[] = [
  { label: '自由比例', value: 0 },
  { label: '1:1', value: 1 },
  { label: '3:4', value: 3 / 4 },
  { label: '4:3', value: 4 / 3 },
  { label: '9:16', value: 9 / 16 },
  { label: '16:9', value: 16 / 9 },
]

const stage = ref<HTMLElement>()
const sourceImage = ref<HTMLImageElement>()
const previewCanvas = ref<HTMLCanvasElement>()
/** 舞台在视口中的位置，用于把图像矩形换算成舞台内定位坐标 */
const stageOrigin = ref({ left: 0, top: 0 })
/** 当前宽高比（0 表示自由），只约束框选过程，不写入 frames */
const ratio = ref(0)
const errorText = ref('')
/** 预览重绘的 rAF 句柄，合并拖动时的高频变更 */
let previewFrame = 0

/** 框选交互状态机：区域更新经 emit 交给父组件，宽高比由本组件注入 */
const roi = useRoiSelection({
  getImage: () => sourceImage.value,
  onUpdate: (rect) => emit('update:modelValue', rect),
  getRatio: () => ratio.value,
})
const { box, tool, dragging, natural, handles, setBox, onStageDown, onBoxDown, onHandleDown } = roi
roi.syncFrom(props.modelValue)

/** 裁切框在舞台中的像素位置：按渲染缩放比把图像坐标映射回舞台内坐标 */
const boxStyle = computed(() => {
  const rect = roi.imageRect.value
  const size = natural.value
  const ready = rect.width > 0 && size.width > 0
  const scaleX = ready ? rect.width / size.width : 0
  const scaleY = ready ? rect.height / size.height : 0
  const offsetX = rect.left - stageOrigin.value.left
  const offsetY = rect.top - stageOrigin.value.top
  return {
    display: ready ? 'block' : 'none',
    left: `${offsetX + box.value.x * scaleX}px`,
    top: `${offsetY + box.value.y * scaleY}px`,
    width: `${box.value.width * scaleX}px`,
    height: `${box.value.height * scaleY}px`,
  }
})

/** 计算图像与舞台在视口中的位置，窗口尺寸变化与图片加载后都需要重新测量 */
function measure(): void {
  roi.measure()
  const container = stage.value
  if (!container) return
  const origin = container.getBoundingClientRect()
  stageOrigin.value = { left: origin.left, top: origin.top }
}

/** 图像加载完成：状态机记录原始尺寸并归一化区域，再补测舞台与预览 */
function onImageLoad(): void {
  roi.onImageLoad()
  measure()
  renderPreview()
}

/** 按当前裁切框直接绘制预览，走 canvas 避免拖动时反复做 PNG 编码 */
function renderPreview(): void {
  const image = sourceImage.value
  const canvas = previewCanvas.value
  if (!image || !canvas || !image.naturalWidth) return
  drawCropToCanvas(image, box.value, canvas)
}

/** 用 rAF 合并拖动过程中的高频预览重绘 */
function schedulePreview(): void {
  if (previewFrame) return
  previewFrame = window.requestAnimationFrame(() => {
    previewFrame = 0
    renderPreview()
  })
}

/** 切换宽高比：在当前裁切框内取符合该比例的最大内接矩形，保持中心不动 */
function applyRatio(): void {
  const size = natural.value
  const target = ratio.value
  if (!target || !size.width || !size.height) return
  const area = inscribedRect({ width: box.value.width, height: box.value.height }, target)
  roi.setBox(clampCropRect({
    x: box.value.x + (box.value.width - area.width) / 2,
    y: box.value.y + (box.value.height - area.height) / 2,
    width: area.width,
    height: area.height,
  }, size.width, size.height))
}

/** 手动输入后把矩形收敛到图像范围内；锁定比例时按比例反推另一条边 */
function normalizeBox(): void {
  const size = natural.value
  if (!size.width || !size.height) return
  const target = ratio.value
  if (!target) {
    roi.setBox(clampCropRect(box.value, size.width, size.height))
    return
  }
  const area = inscribedRect({ width: box.value.width, height: box.value.width / target }, target)
  roi.setBox(clampCropRect({
    x: box.value.x + (box.value.width - area.width) / 2,
    y: box.value.y + (box.value.height - area.height) / 2,
    width: area.width,
    height: area.height,
  }, size.width, size.height))
}

/** 恢复为整帧范围；锁定比例时取整帧范围内符合该比例的最大区域 */
function fullFrame(): void {
  const size = natural.value
  if (!size.width || !size.height) return
  if (!ratio.value) {
    roi.setBox({ x: 0, y: 0, width: size.width, height: size.height })
    return
  }
  const area = inscribedRect({ width: size.width, height: size.height }, ratio.value)
  roi.setBox({
    x: (size.width - area.width) / 2,
    y: (size.height - area.height) / 2,
    width: area.width,
    height: area.height,
  })
}

// 裁切区域变化（拖拽 / 输入）后重绘预览
watch(box, schedulePreview, { deep: true })
// 父组件重置裁切区域（如打开弹窗时带入已应用的区域）后同步本地副本
watch(() => props.modelValue, (value) => {
  if (value.x !== box.value.x || value.y !== box.value.y || value.width !== box.value.width || value.height !== box.value.height) roi.syncFrom(value)
}, { deep: true })

onMounted(() => {
  window.addEventListener('resize', measure)
  void measure()
})

onBeforeUnmount(() => {
  roi.dispose()
  window.removeEventListener('resize', measure)
  if (previewFrame) window.cancelAnimationFrame(previewFrame)
})
</script>

<template>
  <div class="crop-editor">
    <div class="crop-compare" :class="{ single: !props.showPreview }">
      <figure class="crop-pane">
        <figcaption class="faint">{{ props.caption }}</figcaption>
        <div ref="stage" class="crop-stage" :class="{ dragging }" @pointerdown="onStageDown">
          <img
            v-if="sourceUrl"
            ref="sourceImage"
            :src="sourceUrl"
            alt="框选原图"
            draggable="false"
            @load="onImageLoad"
            @error="errorText = '图像加载失败'"
          />
          <span v-else class="faint">暂无可框选的图像</span>
          <div class="crop-box" :style="boxStyle" @pointerdown.stop="onBoxDown">
            <span
              v-for="handle in handles"
              :key="handle"
              class="crop-handle"
              :class="`h-${handle}`"
              @pointerdown.stop="onHandleDown(handle, $event)"
            ></span>
          </div>
        </div>
      </figure>
      <figure v-if="props.showPreview" class="crop-pane">
        <figcaption class="faint">区域预览 · {{ Math.round(box.width) }} × {{ Math.round(box.height) }} px</figcaption>
        <div class="crop-stage checker">
          <canvas ref="previewCanvas" aria-label="区域预览"></canvas>
        </div>
      </figure>
    </div>

    <div class="crop-fields">
      <div class="crop-row">
        <label class="field">
          <span class="field-label">X</span>
          <input v-model.number="box.x" class="input" type="number" min="0" step="1" :max="natural.width" @change="normalizeBox" />
        </label>
        <label class="field">
          <span class="field-label">Y</span>
          <input v-model.number="box.y" class="input" type="number" min="0" step="1" :max="natural.height" @change="normalizeBox" />
        </label>
        <label class="field">
          <span class="field-label">宽度</span>
          <input v-model.number="box.width" class="input" type="number" min="1" step="1" :max="natural.width" @change="normalizeBox" />
        </label>
        <label class="field">
          <span class="field-label">高度</span>
          <input v-model.number="box.height" class="input" type="number" min="1" step="1" :max="natural.height" @change="normalizeBox" />
        </label>
      </div>
      <div class="crop-row crop-tools">
        <label v-if="props.showRatio" class="field">
          <span class="field-label">宽高比</span>
          <select v-model.number="ratio" class="select ratio-select" @change="applyRatio">
            <option v-for="item in RATIO_PRESETS" :key="item.label" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <div class="field">
          <span class="field-label">拖拽工具</span>
          <div class="seg">
            <button class="seg-item" :class="{ active: tool === 'move' }" @click="tool = 'move'">调整框选</button>
            <button class="seg-item" :class="{ active: tool === 'draw' }" @click="tool = 'draw'">重新框选</button>
          </div>
        </div>
        <div v-if="props.showFullFrame" class="field">
          <span class="field-label">快捷操作</span>
          <button class="btn" :disabled="!natural.width" @click="fullFrame">整帧</button>
        </div>
        <!-- 附加工具由调用方注入，natural/box/setBox 都在本组件内部 -->
        <slot name="tools" :natural="natural" :box="box" :set-box="setBox"></slot>
      </div>
    </div>

    <slot name="help">
      <p class="modal-help">
        裁切区域以帧图像像素为单位，会按同一坐标应用到全部帧；已抠图的帧在抠图结果上裁剪，因此抠图后再裁切也不会丢失透明背景。
        输入框与拖拽会实时同步，右侧预览即时可见。整帧范围等价于取消裁切。
      </p>
    </slot>

    <p v-if="errorText" class="crop-error">{{ errorText }}</p>
  </div>
</template>

<style scoped>
.crop-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.crop-compare {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: var(--sp-3);
}

/* 关闭预览栏后让框选舞台占满整行 */
.crop-compare.single {
  grid-template-columns: minmax(0, 1fr);
}

.crop-pane {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.crop-pane figcaption {
  font-size: var(--fs-caption);
}

.crop-stage {
  position: relative;
  height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: var(--sp-2);
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  cursor: crosshair;
  touch-action: none;
}

.crop-stage.checker {
  background-color: var(--checker-b);
  background-image: linear-gradient(45deg, var(--checker-a) 25%, transparent 25%), linear-gradient(-45deg, var(--checker-a) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--checker-a) 75%), linear-gradient(-45deg, transparent 75%, var(--checker-a) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  cursor: default;
}

.crop-stage img,
.crop-stage canvas {
  max-width: 100%;
  max-height: 100%;
  display: block;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}

.crop-box {
  position: absolute;
  border: 1px solid var(--accent);
  /* 超大扩散阴影实现框外压暗，配合舞台 overflow: hidden 裁掉多余部分 */
  box-shadow: 0 0 0 9999px rgba(8, 10, 14, 0.55);
  cursor: move;
  touch-action: none;
}

.crop-stage.dragging .crop-box {
  box-shadow: 0 0 0 9999px rgba(8, 10, 14, 0.68);
}

.crop-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  background: var(--accent);
  border: 1px solid #1a140a;
  border-radius: 2px;
}

.h-nw { left: 0; top: 0; cursor: nwse-resize; }
.h-n { left: 50%; top: 0; cursor: ns-resize; }
.h-ne { left: 100%; top: 0; cursor: nesw-resize; }
.h-e { left: 100%; top: 50%; cursor: ew-resize; }
.h-se { left: 100%; top: 100%; cursor: nwse-resize; }
.h-s { left: 50%; top: 100%; cursor: ns-resize; }
.h-sw { left: 0; top: 100%; cursor: nesw-resize; }
.h-w { left: 0; top: 50%; cursor: ew-resize; }

.crop-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.crop-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-3) var(--sp-4);
  align-items: end;
}

.crop-tools {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-4);
}

.crop-tools .field {
  flex: none;
}

.ratio-select {
  width: 130px;
}

.crop-fields .input {
  width: 100%;
}

.crop-editor .modal-help {
  margin: 0;
}

.crop-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
}
</style>