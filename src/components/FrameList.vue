<script setup lang="ts">
import { computed } from 'vue'
import {
  store,
  selectedFrame,
  deleteFrame,
  selectFrame,
  getCropThumb,
  clearFrames,
  toggleFrameSelection,
  selectAllFrames,
  clearFrameSelection,
} from '@/store/atlas'
import { naturalCompare } from '@/core/sort'
import type { AtlasFrame } from '@/types/atlas'

const list = computed(() => [...store.frames].sort((a, b) => naturalCompare(a.name, b.name)))

/** 选中 id 集合：把逐行的线性包含判断降为 O(1) 查表 */
const selectedSet = computed(() => new Set(store.selectedIds))

/** 是否已全选：供全选按钮的文案与切换逻辑共用，避免模板重复表达式 */
const allSelected = computed(
  () => store.frames.length > 0 && store.selectedIds.length === store.frames.length,
)

/** 取帧缩略图（走 store 缓存，避免渲染期重复 PNG 编码） */
function thumb(frame: AtlasFrame): string {
  return getCropThumb(frame)
}

const total = computed(() =>
  store.frames.reduce((s, f) => s + (f.manual ? f.contentInFrame.w * f.contentInFrame.h : f.sourceSize.w * f.sourceSize.h), 0),
)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      class="flex flex-none items-center justify-between border-b border-line px-4 py-3 text-caption font-semibold tracking-[0.08em] text-faint uppercase"
    >
      <span>帧列表</span>
      <span class="flex items-center gap-2">
        <span class="mono faint">{{ store.frames.length }} 帧</span>
        <button
          v-if="store.frames.length"
          class="rounded-sm border border-line px-[7px] py-[2px] text-faint font-normal tracking-normal normal-case transition-[color,border-color] duration-[120ms] hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-35"
          :title="allSelected ? '取消全选' : '全选帧'"
          @click="allSelected ? clearFrameSelection() : selectAllFrames()"
        >
          {{ allSelected ? '取消全选' : '全选' }}
        </button>
        <button
          class="rounded-sm border border-line px-[7px] py-[2px] text-faint font-normal tracking-normal normal-case transition-[color,border-color] duration-[120ms] hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-35"
          title="清空全部帧"
          :disabled="store.frames.length === 0"
          @click="clearFrames()"
        >
          清空
        </button>
      </span>
    </div>
    <div
      v-if="store.frames.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center text-muted"
    >
      <p class="m-0">还没有帧</p>
      <p class="faint m-0">导入元数据，或用「自动识别」扫描透明边缘</p>
    </div>
    <ul v-else class="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-2">
      <li
        v-for="frame in list"
        :key="frame.id"
        class="group flex cursor-pointer items-center gap-2 rounded-sm border px-1.5 py-1"
        :class="
          frame.id === selectedFrame?.id
            ? 'border-accent-border bg-accent-dim'
            : 'border-transparent hover:bg-hover'
        "
        @click="selectFrame(frame.id)"
      >
        <input
          class="flex-none accent-[var(--accent)]"
          type="checkbox"
          :checked="selectedSet.has(frame.id)"
          :aria-label="`选择 ${frame.name}`"
          @click.stop
          @change="toggleFrameSelection(frame.id)"
        />
        <img
          class="h-10 w-10 flex-none rounded-[3px] border border-line bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-[length:10px_10px] object-contain"
          :src="thumb(frame)"
          alt=""
          draggable="false"
        />
        <div class="min-w-0 flex-1">
          <p class="m-0 truncate text-body" :title="frame.name">{{ frame.name }}</p>
          <p class="mono faint m-0">
            {{ frame.manual ? frame.contentInFrame.w : frame.sourceSize.w }}×{{
              frame.manual ? frame.contentInFrame.h : frame.sourceSize.h
            }}
            <template v-if="frame.rotated"> · 旋转</template>
            <template v-if="frame.manual"> · 手动</template>
          </p>
        </div>
        <button
          class="btn-icon text-faint opacity-0 group-hover:opacity-100 hover:text-danger"
          title="删除帧"
          @click.stop="deleteFrame(frame.id)"
        >
          ×
        </button>
      </li>
    </ul>
    <div v-if="store.frames.length" class="mono faint flex-none border-t border-line px-4 py-1.5 text-right">
      合计内容面积 {{ Math.round(total / 10000) / 100 }} 万像素
    </div>
  </div>
</template>
