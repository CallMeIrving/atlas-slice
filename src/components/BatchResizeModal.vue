<script setup lang="ts">
import { computed, ref } from 'vue'
import { store, normalizeSelectedFrames } from '@/store/atlas'

const emit = defineEmits<{ close: [] }>()

const selected = computed(() => store.frames.filter((frame) => store.selectedIds.includes(frame.id)))
const maxWidth = computed(() => Math.max(...selected.value.map((frame) => frame.sourceSize.w), 0))
const maxHeight = computed(() => Math.max(...selected.value.map((frame) => frame.sourceSize.h), 0))
const width = ref(maxWidth.value)
const height = ref(maxHeight.value)

function apply(): void {
  const w = Math.round(Number(width.value))
  const h = Math.round(Number(height.value))
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return
  if (normalizeSelectedFrames(w, h)) emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="resize-title">
      <div class="modal-head">
        <div>
          <h2 id="resize-title">统一帧尺寸</h2>
          <p class="faint">已选择 {{ selected.length }} 帧</p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <p class="modal-help">
          以每帧中心为锚点调整矩形。尺寸不足的帧会补充透明边缘，较小目标尺寸可能裁剪内容。
        </p>
        <div class="size-fields">
          <label class="field">
            <span class="field-label">宽度</span>
            <div class="field-row">
              <input v-model.number="width" class="input" type="number" min="1" step="1" />
              <span class="faint mono">px</span>
            </div>
          </label>
          <label class="field">
            <span class="field-label">高度</span>
            <div class="field-row">
              <input v-model.number="height" class="input" type="number" min="1" step="1" />
              <span class="faint mono">px</span>
            </div>
          </label>
        </div>
        <p class="hint faint">当前选中帧最大尺寸：{{ maxWidth }}×{{ maxHeight }} px</p>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn btn-primary" :disabled="!selected.length" @click="apply">应用到选中帧</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: var(--sp-6);
  background: rgba(8, 10, 14, 0.7);
}

.modal {
  width: min(460px, calc(100vw - 48px));
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-pop);
}

.modal-head,
.modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
}

.modal-head {
  border-bottom: 1px solid var(--border);
}

.modal-head h2 {
  margin: 0;
  font-size: var(--fs-head);
}

.modal-head p {
  margin: 2px 0 0;
  font-size: var(--fs-caption);
}

.modal-close {
  color: var(--text-muted);
  font-size: 20px;
}

.modal-body {
  padding: var(--sp-5);
}

.modal-help {
  margin: 0 0 var(--sp-4);
  color: var(--text-muted);
}

.size-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4);
}

.modal-foot {
  justify-content: flex-end;
  border-top: 1px solid var(--border);
}
</style>
