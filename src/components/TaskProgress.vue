<script setup lang="ts">
import { computed } from 'vue'

/**
 * 阶段进度条。
 * 抽帧、批量裁切、批量抠图与一键处理流水线共用：错误提示、进度文本、帧计数与取消按钮只维护一份。
 */
const props = withDefaults(
  defineProps<{
    /** 是否正在运行（决定是否显示取消按钮） */
    running: boolean
    /** 已完成数量 */
    done: number
    /** 总数量 */
    total: number
    /** 状态文本 */
    text?: string
    /** 精确百分比（0-100，-1 表示不适用，改按 done/total 估算） */
    percent?: number
    /** 错误文本，存在时只显示错误 */
    error?: string
    /** 已请求取消、正在收尾：此时禁用取消按钮并改变文案，避免重复点击 */
    cancelling?: boolean
  }>(),
  { text: '', percent: -1, error: '', cancelling: false },
)

defineEmits<{ cancel: [] }>()

/** 进度条宽度：优先用精确百分比，否则按已完成数量估算 */
const width = computed(() => {
  if (props.percent >= 0) return `${Math.min(100, props.percent)}%`
  if (!props.total) return '0%'
  return `${Math.round((props.done / props.total) * 100)}%`
})
</script>

<template>
  <div class="flex flex-col gap-2 text-caption">
    <p v-if="props.error" class="m-0 text-danger">{{ props.error }}</p>
    <template v-else>
      <div class="flex items-center gap-2">
        <span class="text-muted">{{ props.text }}</span>
        <span v-if="props.total" class="mono text-faint">{{ props.done }}/{{ props.total }}</span>
        <span v-if="props.percent >= 0" class="mono text-faint">{{ props.percent }}%</span>
        <span class="flex-1"></span>
        <button v-if="props.running" class="btn btn-danger" :disabled="props.cancelling" @click="$emit('cancel')">
          {{ props.cancelling ? '取消中…' : '取消' }}
        </button>
      </div>
      <div class="h-1.5 overflow-hidden rounded-[3px] bg-line">
        <div class="h-full bg-accent transition-[width] duration-200 ease-[ease]" :style="{ width }"></div>
      </div>
    </template>
  </div>
</template>