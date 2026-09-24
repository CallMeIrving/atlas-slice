<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  store,
  addManualFrame,
  selectFrame,
  setViewMode,
  setZoom,
  nudgeSelectedFrame,
  deleteFrame,
  setFrameRect,
  loadImage,
  loadMetaFile,
} from '@/store/atlas'
import { fitBoxToContent, MIN_FRAME_SIZE } from '@/core/trim'
import type { AtlasFrame, FrameRect } from '@/types/atlas'

const viewportRef = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()

const drawing = ref(false)
const panning = ref(false)
const panStart = { x: 0, y: 0, px: 0, py: 0 }
const drawStart = { x: 0, y: 0 }

// ---------- 控制点（调整边框大小） ----------
type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** 控制点显示尺寸（屏幕像素） */
const HANDLE_PX = 9
const HANDLE_CURSORS: Record<HandleName, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

const hoverHandle = ref<HandleName | null>(null)
const resizing = ref<{ id: string; handle: HandleName; start: FrameRect; rect: FrameRect } | null>(null)
/** 空格键按住：临时切换为平移模式 */
const spaceDown = ref(false)
/** 指针是否位于画布上（决定空格是否进入平移模式） */
const pointerOnStage = ref(false)

const selected = computed(() => store.frames.find((f) => f.id === store.selectedId) ?? null)

/** 鼠标指针样式：拖动图标 / 控制点方向 / 框选十字 */
const cursor = computed(() => {
  if (!store.source) return 'default'
  if (resizing.value) return HANDLE_CURSORS[resizing.value.handle]
  if (panning.value) return 'grabbing'
  if (spaceDown.value) return 'grab'
  if (hoverHandle.value) return HANDLE_CURSORS[hoverHandle.value]
  return store.viewMode === 'box' ? 'crosshair' : 'grab'
})

/** 渲染用矩形：调整中实时反映拖拽结果 */
function displayRect(f: AtlasFrame): FrameRect {
  return resizing.value && resizing.value.id === f.id ? resizing.value.rect : f.rect
}

function handlePoints(r: FrameRect): Array<{ name: HandleName; x: number; y: number }> {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  return [
    { name: 'nw', x: r.x, y: r.y },
    { name: 'n', x: cx, y: r.y },
    { name: 'ne', x: r.x + r.w, y: r.y },
    { name: 'e', x: r.x + r.w, y: cy },
    { name: 'se', x: r.x + r.w, y: r.y + r.h },
    { name: 's', x: cx, y: r.y + r.h },
    { name: 'sw', x: r.x, y: r.y + r.h },
    { name: 'w', x: r.x, y: cy },
  ]
}

function hitHandle(img: { x: number; y: number }, r: FrameRect): HandleName | null {
  const half = (HANDLE_PX + 4) / store.zoom / 2
  for (const p of handlePoints(r)) {
    if (Math.abs(img.x - p.x) <= half && Math.abs(img.y - p.y) <= half) return p.name
  }
  return null
}

/** 按控制点计算新矩形：未拖动的一侧保持锚定，含磁吸与最小尺寸限制 */
function applyResize(start: FrameRect, handle: HandleName, img: { x: number; y: number }): FrameRect {
  const src = store.source
  if (!src) return start
  const tol = MAGNET_PX / store.zoom
  const { xs, ys } = getMagnet(resizing.value?.id)
  let x1 = start.x
  let y1 = start.y
  let x2 = start.x + start.w
  let y2 = start.y + start.h
  if (handle.includes('w')) x1 = snapVal(img.x, xs, tol)
  if (handle.includes('e')) x2 = snapVal(img.x, xs, tol)
  if (handle.includes('n')) y1 = snapVal(img.y, ys, tol)
  if (handle.includes('s')) y2 = snapVal(img.y, ys, tol)
  x1 = Math.max(0, Math.min(src.width, x1))
  x2 = Math.max(0, Math.min(src.width, x2))
  y1 = Math.max(0, Math.min(src.height, y1))
  y2 = Math.max(0, Math.min(src.height, y2))
  if (x2 - x1 < MIN_FRAME_SIZE) {
    if (handle.includes('w')) x1 = Math.max(0, x2 - MIN_FRAME_SIZE)
    else x2 = Math.min(src.width, x1 + MIN_FRAME_SIZE)
  }
  if (y2 - y1 < MIN_FRAME_SIZE) {
    if (handle.includes('n')) y1 = Math.max(0, y2 - MIN_FRAME_SIZE)
    else y2 = Math.min(src.height, y1 + MIN_FRAME_SIZE)
  }
  return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) }
}

// ---------- 棋盘格纹理 ----------
let checker: CanvasPattern | null = null
function getChecker(ctx: CanvasRenderingContext2D): CanvasPattern {
  if (checker) return checker
  const c = document.createElement('canvas')
  c.width = 16
  c.height = 16
  const g = c.getContext('2d')!
  g.fillStyle = '#101217'
  g.fillRect(0, 0, 16, 16)
  g.fillStyle = '#1a1d26'
  g.fillRect(0, 0, 8, 8)
  g.fillRect(8, 8, 8, 8)
  checker = ctx.createPattern(c, 'repeat')!
  return checker
}

function fitRect(r: FrameRect): FrameRect {
  return { x: r.x, y: r.y, w: r.w, h: r.h }
}

// ---------- 渲染 ----------
function render(): void {
  const canvas = canvasRef.value
  const vp = viewportRef.value
  if (!canvas || !vp) return
  const dpr = window.devicePixelRatio || 1
  const w = vp.clientWidth
  const h = vp.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#0d0f13'
  ctx.fillRect(0, 0, w, h)

  const src = store.source
  if (!src) return
  const { zoom, panX, panY } = store

  ctx.save()
  ctx.translate(panX, panY)
  ctx.scale(zoom, zoom)

  // 图集底 + 图像
  ctx.fillStyle = getChecker(ctx)
  ctx.fillRect(0, 0, src.width, src.height)
  ctx.drawImage(src, 0, 0)

  // 帧轮廓
  for (const f of store.frames) {
    const isSel = f.id === store.selectedId
    const r = displayRect(f)
    ctx.strokeStyle = isSel ? 'rgba(232,162,61,0.9)' : 'rgba(255,255,255,0.16)'
    ctx.lineWidth = isSel ? 1.5 : 1
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
  }

  // 选中帧控制点：拖拽可调整边框大小
  if (selected.value) {
    const r = displayRect(selected.value)
    const hs = HANDLE_PX / zoom
    ctx.fillStyle = '#e8a23d'
    ctx.strokeStyle = '#14161c'
    ctx.lineWidth = 1 / zoom
    for (const p of handlePoints(r)) {
      ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs)
      ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs)
    }
  }

  // 框选遮罩：只压暗框外区域，框内保持半透明可见
  const box = store.draftBox
  if (box && box.w > 0 && box.h > 0) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, src.width, src.height)
    ctx.rect(box.x, box.y, box.w, box.h)
    ctx.fillStyle = 'rgba(6,7,10,0.55)'
    ctx.fill('evenodd')
    ctx.restore()
    ctx.strokeStyle = '#e8a23d'
    ctx.lineWidth = 1.5
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
    // 尺寸标注
    const label = `${Math.round(box.w)}×${Math.round(box.h)}`
    ctx.font = '11px "IBM Plex Mono", monospace'
    const tw = ctx.measureText(label).width + 8
    const lx = Math.min(Math.max(box.x, 0), src.width - tw)
    const ly = Math.max(box.y - 18, 0)
    ctx.fillStyle = 'rgba(20,22,28,0.9)'
    ctx.fillRect(lx, ly, tw, 16)
    ctx.strokeStyle = 'rgba(232,162,61,0.6)'
    ctx.strokeRect(lx + 0.5, ly + 0.5, tw - 1, 15)
    ctx.fillStyle = '#f2b453'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, lx + 4, ly + 8)
  }

  ctx.restore()
}

/** 已排队的重绘帧句柄：同一帧内的多次数据变更合并为一次绘制 */
let renderRaf = 0

/** 申请一次重绘：通过 requestAnimationFrame 合并高频触发（平移/缩放/调整尺寸） */
function scheduleRender(): void {
  if (renderRaf) return
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0
    render()
  })
}

// 绘制被推迟到 rAF 回调中执行，而 rAF 回调不在 effect 的追踪期内，
// 因此这里显式列出 render 依赖的数据：任一变化即申请一次重绘（同帧内自动合并）
watch(
  () => [
    canvasRef.value,
    viewportRef.value,
    store.source,
    store.zoom,
    store.panX,
    store.panY,
    store.frames,
    store.selectedId,
    store.draftBox,
    resizing.value,
  ],
  scheduleRender,
  { immediate: true },
)

// ---------- 视口适配 ----------
function zoomFit(): void {
  const vp = viewportRef.value
  const src = store.source
  if (!vp || !src) return
  const scale = Math.min((vp.clientWidth - 40) / src.width, (vp.clientHeight - 40) / src.height, 1)
  const z = Math.max(0.02, scale)
  store.zoom = z
  store.panX = (vp.clientWidth - src.width * z) / 2
  store.panY = (vp.clientHeight - src.height * z) / 2
}

watch(
  () => store.source,
  () => {
    store.zoom = 1
    store.panX = 0
    store.panY = 0
    requestAnimationFrame(zoomFit)
  },
)

// ---------- 坐标换算 ----------
function toImg(e: MouseEvent): { x: number; y: number } {
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  return {
    x: (e.clientX - rect.left - store.panX) / store.zoom,
    y: (e.clientY - rect.top - store.panY) / store.zoom,
  }
}

// ---------- 磁吸 ----------
const MAGNET_PX = 8
function snapVal(v: number, cands: number[], tol: number): number {
  let best = v
  let bd = tol
  for (const c of cands) {
    const d = Math.abs(c - v)
    if (d <= bd) {
      bd = d
      best = c
    }
  }
  return best
}

function magnetCandidates(src: HTMLCanvasElement, excludeId?: string): { xs: number[]; ys: number[] } {
  const xs = [0, src.width]
  const ys = [0, src.height]
  for (const f of store.frames) {
    if (f.id === excludeId) continue
    xs.push(f.rect.x, f.rect.x + f.rect.w)
    ys.push(f.rect.y, f.rect.y + f.rect.h)
  }
  return { xs, ys }
}

/** 拖拽期间的磁吸候选缓存：记录构建时的排除帧 id，拖拽开始时构建一次，结束时清空 */
let magnetCache: { excludeId?: string; xs: number[]; ys: number[] } | null = null

/** 读取磁吸候选：命中缓存直接返回，excludeId 不一致时重建，避免每次 mousemove 重算 */
function getMagnet(excludeId?: string): { xs: number[]; ys: number[] } {
  const src = store.source
  if (!src) return { xs: [], ys: [] }
  if (magnetCache && magnetCache.excludeId === excludeId) return magnetCache
  magnetCache = { excludeId, ...magnetCandidates(src, excludeId) }
  return magnetCache
}

function normRect(a: { x: number; y: number }, b: { x: number; y: number }): FrameRect {
  const x1 = Math.min(a.x, b.x)
  const y1 = Math.min(a.y, b.y)
  const x2 = Math.max(a.x, b.x)
  const y2 = Math.max(a.y, b.y)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

function updateDraft(img: { x: number; y: number }): void {
  const src = store.source
  if (!src) return
  const tol = MAGNET_PX / store.zoom
  const { xs, ys } = getMagnet()
  const raw = normRect(drawStart, img)
  const x = snapVal(raw.x, xs, tol)
  const y = snapVal(raw.y, ys, tol)
  const x2 = snapVal(raw.x + raw.w, xs, tol)
  const y2 = snapVal(raw.y + raw.h, ys, tol)
  store.draftBox = fitRect({ x, y, w: x2 - x, h: y2 - y })
}

// ---------- 指针交互 ----------
function startPan(e: MouseEvent): void {
  panning.value = true
  panStart.x = e.clientX
  panStart.y = e.clientY
  panStart.px = store.panX
  panStart.py = store.panY
}

function onDown(e: MouseEvent): void {
  const src = store.source
  if (!src) return
  // 右键 / 中键 / 空格 + 左键：平移视图
  if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown.value)) {
    e.preventDefault()
    startPan(e)
    return
  }
  if (e.button !== 0) return
  // 左键优先命中选中帧的控制点，进入调整尺寸
  const sel = selected.value
  if (sel) {
    const handle = hitHandle(toImg(e), sel.rect)
    if (handle) {
      // 预热磁吸候选：调整尺寸期间复用，避免每次 mousemove 重建
      magnetCache = { excludeId: sel.id, ...magnetCandidates(src, sel.id) }
      resizing.value = { id: sel.id, handle, start: { ...sel.rect }, rect: { ...sel.rect } }
      return
    }
  }
  if (store.viewMode === 'box') {
    const img = toImg(e)
    drawing.value = true
    drawStart.x = img.x
    drawStart.y = img.y
    // 预热磁吸候选：框选期间复用
    magnetCache = { excludeId: undefined, ...magnetCandidates(src) }
    store.draftBox = { x: img.x, y: img.y, w: 0, h: 0 }
  } else {
    startPan(e)
  }
}

function onMove(e: MouseEvent): void {
  const src = store.source
  if (!src) return
  pointerOnStage.value = true
  const img = toImg(e)
  store.hover = { x: Math.floor(img.x), y: Math.floor(img.y) }
  if (resizing.value) {
    resizing.value = {
      ...resizing.value,
      rect: applyResize(resizing.value.start, resizing.value.handle, img),
    }
    return
  }
  if (drawing.value) {
    hoverHandle.value = null
    updateDraft(img)
    return
  }
  if (panning.value) {
    hoverHandle.value = null
    store.panX = panStart.px + (e.clientX - panStart.x)
    store.panY = panStart.py + (e.clientY - panStart.y)
    return
  }
  hoverHandle.value = spaceDown.value || !selected.value ? null : hitHandle(img, selected.value.rect)
}

function onLeave(): void {
  hoverHandle.value = null
  pointerOnStage.value = false
  store.hover = null
  // 拖拽中移出画布：释放磁吸候选缓存（重新进入时会按需重建）
  magnetCache = null
}

function onUp(e: MouseEvent): void {
  // 拖拽结束：释放磁吸候选缓存
  magnetCache = null
  if (resizing.value) {
    const { id, rect } = resizing.value
    resizing.value = null
    setFrameRect(id, rect)
    return
  }
  if (drawing.value) {
    const box = store.draftBox
    drawing.value = false
    if (box && box.w > 0 && box.h > 0) {
      addManualFrame(box)
    } else {
      store.draftBox = null
    }
    return
  }
  if (panning.value) {
    panning.value = false
    return
  }
  // 查看模式下点击选择帧
  if (store.viewMode === 'view' && e.button === 0 && store.source) {
    const img = toImg(e)
    for (let i = store.frames.length - 1; i >= 0; i--) {
      const f = store.frames[i]
      if (
        img.x >= f.rect.x &&
        img.x <= f.rect.x + f.rect.w &&
        img.y >= f.rect.y &&
        img.y <= f.rect.y + f.rect.h
      ) {
        selectFrame(f.id)
        return
      }
    }
  }
}

function onWheel(e: WheelEvent): void {
  const src = store.source
  if (!src) return
  e.preventDefault()
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const nz = Math.min(16, Math.max(0.02, store.zoom * factor))
  const ix = (sx - store.panX) / store.zoom
  const iy = (sy - store.panY) / store.zoom
  store.zoom = nz
  store.panX = sx - ix * nz
  store.panY = sy - iy * nz
}

// ---------- 键盘 ----------
function onKey(e: KeyboardEvent): void {
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
  if (!store.source) return
  if (e.key === 'Escape') {
    drawing.value = false
    resizing.value = null
    store.draftBox = null
    return
  }
  if (e.key === ' ' || e.code === 'Space') {
    // 指针在画布上时空格进入平移模式；否则保留空格激活按钮等默认行为
    if (!pointerOnStage.value) return
    e.preventDefault()
    spaceDown.value = true
    return
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const step = e.shiftKey ? 10 : 1
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
    nudgeSelectedFrame(dx, dy)
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedId) {
    e.preventDefault()
    deleteFrame(store.selectedId)
    return
  }
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault()
    autoFit()
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === ' ' || e.code === 'Space') spaceDown.value = false
}

/** 窗口失焦时复位，避免空格状态卡住 */
function onWindowBlur(): void {
  spaceDown.value = false
}

// ---------- Auto-fit ----------
function autoFit(): void {
  const src = store.source
  if (!src) return
  if (drawing.value && store.draftBox && store.draftBox.w > 0) {
    const fitted = fitBoxToContent(src, store.draftBox)
    if (fitted) store.draftBox = fitted
    return
  }
  if (store.selectedId) {
    const f = store.frames.find((it) => it.id === store.selectedId)
    if (f) {
      const fitted = fitBoxToContent(src, f.rect)
      if (fitted) setFrameRect(f.id, fitted)
    }
  }
}

// ---------- 拖放导入 ----------
function onDrop(e: DragEvent): void {
  const files = Array.from(e.dataTransfer?.files ?? [])
  const image = files.find((f) => f.type.startsWith('image/'))
  const meta = files.find((f) => /\.(json|plist|xml|txt)$/i.test(f.name))
  if (image) loadImage(image)
  if (meta) loadMetaFile(meta)
}

// ---------- 生命周期 ----------
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('resize', zoomFit)
  requestAnimationFrame(zoomFit)
  // 挂载后补一次重绘：watch 的首次执行发生在挂载前，此时 canvas 尚未就绪
  scheduleRender()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('resize', zoomFit)
  if (renderRaf) cancelAnimationFrame(renderRaf)
})
</script>

<template>
  <div class="stage-shell" @dragover.prevent @drop.prevent="onDrop">
    <div class="stage-toolbar">
      <div class="seg">
        <button
          class="seg-item"
          :class="{ active: store.viewMode === 'view' }"
          @click="setViewMode('view')"
        >
          查看
        </button>
        <button
          class="seg-item"
          :class="{ active: store.viewMode === 'box' }"
          @click="setViewMode('box')"
        >
          框选
        </button>
      </div>
      <button class="btn" :disabled="!store.source" @click="autoFit()">自动贴合</button>
      <span class="toolbar-hint faint" v-if="store.viewMode === 'box'">
        <span class="kbd">F</span> 贴合 · <span class="kbd">方向键</span> 微调 · <span class="kbd">Del</span> 删除 · 拖拽框选 ·
        空格 / 右键 平移
      </span>
      <span class="toolbar-hint faint" v-else>
        点击选中 · 拖拽控制点调整边框 · <span class="kbd">方向键</span> 微调 · 拖拽平移
      </span>
      <span class="spacer"></span>
      <button class="btn btn-icon" title="缩小" :disabled="!store.source" @click="setZoom(store.zoom / 1.25)">−</button>
      <button class="btn btn-icon zoom-label" title="适配窗口" :disabled="!store.source" @click="zoomFit()">
        {{ Math.round(store.zoom * 100) }}%
      </button>
      <button class="btn btn-icon" title="放大" :disabled="!store.source" @click="setZoom(store.zoom * 1.25)">+</button>
    </div>
    <div ref="viewportRef" class="stage-viewport">
      <canvas
        ref="canvasRef"
        class="stage-canvas"
        :style="{ cursor }"
        @mousedown="onDown"
        @mousemove="onMove"
        @mouseup="onUp"
        @mouseleave="onLeave"
        @wheel="onWheel"
        @contextmenu.prevent
      ></canvas>
      <div v-if="!store.source" class="empty-state stage-empty">
        <p class="big">拖入图集图片开始</p>
        <p class="faint">支持 PNG / WebP / JPEG · 单文件 ≤ 10MB</p>
        <p class="faint">再导入 TexturePacker JSON / plist / XML 元数据，或直接「自动识别」</p>
      </div>
    </div>
    <div class="stage-status">
      <span class="mono faint" v-if="store.hover">光标 {{ store.hover.x }}, {{ store.hover.y }}</span>
      <span v-else class="faint">悬停查看坐标</span>
      <span class="spacer"></span>
      <span class="mono faint" v-if="store.source">{{ store.source.width }} × {{ store.source.height }}</span>
      <span class="mono faint" v-else>未载入图像</span>
    </div>
  </div>
</template>

<style scoped>
.stage-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--stage);
}

.stage-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.spacer {
  flex: 1;
}

.toolbar-hint {
  font-size: var(--fs-caption);
  margin-left: var(--sp-2);
}

.zoom-label {
  font-family: var(--font-mono);
  width: 58px;
}

.stage-viewport {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.stage-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.stage-empty {
  position: absolute;
  inset: 0;
}

.stage-status {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: 4px var(--sp-3);
  background: var(--surface);
  border-top: 1px solid var(--border);
  font-size: var(--fs-caption);
}
</style>
