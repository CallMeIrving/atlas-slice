<script setup lang="ts">
import { ref, watch } from 'vue'
import { loadImage } from '@/core/image'
import type { SplitLayer, SplitLayerBackground } from '@/store/workspace'

/**
 * 图层合成舞台。
 * 只做一件事：把背景层与全部可见图层按 z 升序叠加绘制到画布上。
 * 画布的内部分辨率等于原图像素尺寸，靠 CSS 的 max-width/max-height 等比缩放到容器内，
 * 因此绘制坐标可以直接用服务端给的 alpha_bbox，不需要任何缩放换算。
 */
const props = defineProps<{
  layers: SplitLayer[]
  background: SplitLayerBackground | null
  /** 需要高亮描边的图层 id（与列表里的选中项联动） */
  selected: string[]
  width: number
  height: number
}>()

const emit = defineEmits<{ select: [id: string] }>()

const canvas = ref<HTMLCanvasElement>()
const error = ref('')
/** 图像缓存：同一 url 只解码一次，反复勾选/换序时不会重复请求 */
const cache = new Map<string, HTMLImageElement>()
/** 重绘代号：解码是异步的，参数又变了就丢弃这一轮的结果 */
let generation = 0

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** 棋盘格底：与帧列表同一套配色，透明区域一眼可辨 */
function checkerboard(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement('canvas')
  tile.width = 10
  tile.height = 10
  const tileCtx = tile.getContext('2d')
  if (!tileCtx) return null
  tileCtx.fillStyle = cssVar('--checker-b', '#101217')
  tileCtx.fillRect(0, 0, 10, 10)
  tileCtx.fillStyle = cssVar('--checker-a', '#1a1d26')
  tileCtx.fillRect(0, 0, 5, 5)
  tileCtx.fillRect(5, 5, 5, 5)
  return ctx.createPattern(tile, 'repeat')
}

async function image(url: string): Promise<HTMLImageElement> {
  const hit = cache.get(url)
  if (hit) return hit
  const loaded = await loadImage(url, '图层加载失败')
  cache.set(url, loaded)
  return loaded
}

/**
 * 点击 canvas 选中图层：把视口坐标换算为图像像素坐标，
 * 找到 alphaBbox 包含该点的最顶层可见图层（z 最大），emit select。
 */
function onClick(event: MouseEvent): void {
  const target = canvas.value
  if (!target || !props.width || !props.height) return
  const rect = target.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const scaleX = props.width / rect.width
  const scaleY = props.height / rect.height
  const px = Math.round((event.clientX - rect.left) * scaleX)
  const py = Math.round((event.clientY - rect.top) * scaleY)

  // 按 z 降序（前景在前）找第一个命中的可见图层
  const visible = props.layers.filter((l) => l.visible).sort((a, b) => b.z - a.z)
  for (const layer of visible) {
    const { x, y, w, h } = layer.alphaBbox
    if (px >= x && px <= x + w && py >= y && py <= y + h) {
      emit('select', layer.id)
      return
    }
  }
}

async function draw(): Promise<void> {
  const target = canvas.value
  if (!target || !props.width || !props.height) return
  const stamp = ++generation
  target.width = props.width
  target.height = props.height
  const ctx = target.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = checkerboard(ctx) ?? cssVar('--checker-b', '#101217')
  ctx.fillRect(0, 0, props.width, props.height)

  try {
    if (props.background?.visible) {
      ctx.drawImage(await image(props.background.pngUrl), 0, 0)
      if (stamp !== generation) return
    }
    const visible = props.layers.filter((layer) => layer.visible).sort((a, b) => a.z - b.z)
    for (const layer of visible) {
      ctx.drawImage(await image(layer.pngUrl), layer.alphaBbox.x, layer.alphaBbox.y)
      if (stamp !== generation) return
    }
    error.value = ''
  } catch (cause) {
    if (stamp === generation) error.value = cause instanceof Error ? cause.message : '图层绘制失败'
    return
  }

  // 高亮描边画在全部图层之上，避免被后画的层盖住
  const selected = props.layers.filter((layer) => props.selected.includes(layer.id))
  if (selected.length) {
    ctx.lineWidth = Math.max(1, Math.round(Math.min(props.width, props.height) / 500))
    ctx.strokeStyle = cssVar('--accent', '#4c8dff')
    ctx.setLineDash([6, 4])
    selected.forEach((layer) => {
      ctx.strokeRect(layer.alphaBbox.x, layer.alphaBbox.y, layer.alphaBbox.w, layer.alphaBbox.h)
    })
    ctx.setLineDash([])
  }
}

watch(
  () => [props.layers, props.background, props.selected, props.width, props.height],
  () => { void draw() },
  { deep: true, immediate: true },
)
</script>

<template>
  <figure class="m-0 flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-sm border border-line bg-stage p-3">
    <canvas ref="canvas" class="max-h-full min-h-0 max-w-full shadow-[0_0_0_1px_var(--border)]" @click="onClick"></canvas>
    <figcaption v-if="error" class="faint flex-none text-caption">{{ error }}</figcaption>
  </figure>
</template>