<script setup lang="ts">
import { computed } from 'vue'
import { store, selectedFrame, deleteFrame, selectFrame, getCropCanvas, clearFrames } from '@/store/atlas'
import { naturalCompare } from '@/core/sort'

const list = computed(() => [...store.frames].sort((a, b) => naturalCompare(a.name, b.name)))

function thumb(frameId: string): string {
  const frame = store.frames.find((f) => f.id === frameId)
  if (!frame) return ''
  try {
    return getCropCanvas(frame).toDataURL()
  } catch {
    return ''
  }
}

const total = computed(() =>
  store.frames.reduce((s, f) => s + (f.manual ? f.contentInFrame.w * f.contentInFrame.h : f.sourceSize.w * f.sourceSize.h), 0),
)
</script>

<template>
  <div class="frame-list">
    <div class="list-head">
      <span>帧列表</span>
      <span class="head-right">
        <span class="mono faint">{{ store.frames.length }} 帧</span>
        <button
          class="clear-btn"
          title="清空全部帧"
          :disabled="store.frames.length === 0"
          @click="clearFrames()"
        >
          清空
        </button>
      </span>
    </div>
    <div v-if="store.frames.length === 0" class="list-empty">
      <p>还没有帧</p>
      <p class="faint">导入元数据，或用「自动识别」扫描透明边缘</p>
    </div>
    <ul v-else class="frame-ul">
      <li
        v-for="frame in list"
        :key="frame.id"
        class="frame-item"
        :class="{ active: frame.id === selectedFrame?.id }"
        @click="selectFrame(frame.id)"
      >
        <img class="thumb" :src="thumb(frame.id)" alt="" draggable="false" />
        <div class="item-body">
          <p class="item-name" :title="frame.name">{{ frame.name }}</p>
          <p class="mono faint">
            {{ frame.manual ? frame.contentInFrame.w : frame.sourceSize.w }}×{{
              frame.manual ? frame.contentInFrame.h : frame.sourceSize.h
            }}
            <template v-if="frame.rotated"> · 旋转</template>
            <template v-if="frame.manual"> · 手动</template>
          </p>
        </div>
        <button class="btn-icon del" title="删除帧" @click.stop="deleteFrame(frame.id)">×</button>
      </li>
    </ul>
    <div v-if="store.frames.length" class="list-foot mono faint">
      合计内容面积 {{ Math.round(total / 10000) / 100 }} 万像素
    </div>
  </div>
</template>

<style scoped>
.frame-list {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.list-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-caption);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.head-right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.clear-btn {
  letter-spacing: normal;
  text-transform: none;
  font-weight: 400;
  padding: 2px 7px;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  transition: color 0.12s, border-color 0.12s;
}

.clear-btn:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}

.clear-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.frame-ul {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.frame-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 4px 6px;
  border-radius: var(--radius-s);
  border: 1px solid transparent;
  cursor: pointer;
}

.frame-item:hover {
  background: var(--surface-hover);
}

.frame-item.active {
  background: var(--accent-dim);
  border-color: var(--accent-border);
}

.thumb {
  width: 40px;
  height: 40px;
  flex: none;
  object-fit: contain;
  background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 10px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
}

.item-body {
  flex: 1;
  min-width: 0;
}

.item-name {
  margin: 0;
  font-size: var(--fs-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-body p + p {
  margin: 0;
}

.del {
  opacity: 0;
  color: var(--text-faint);
}

.frame-item:hover .del {
  opacity: 1;
}

.del:hover {
  color: var(--danger);
}

.list-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--text-muted);
  text-align: center;
  padding: var(--sp-4);
}

.list-empty p {
  margin: 0;
}

.list-foot {
  flex: none;
  padding: 6px var(--sp-4);
  border-top: 1px solid var(--border);
  text-align: right;
}
</style>
