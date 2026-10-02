<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { workspace, persistMediaSettings, type OnionFrame } from '@/store/workspace'
import FramePreviewPlayer from '@/components/FramePreviewPlayer.vue'
import { generateTweens, dedupeNames } from '@/core/frame-tween'
import { loadImage } from '@/core/image'
import { downloadZip, type ZipEntry } from '@/core/media-export'

/**
 * 洋葱皮预览模块（4.7.5）：导入帧序列（多选图片 / 拖拽 / 精灵图按网格切格）→
 * 洋葱皮叠加预览（复用 FramePreviewPlayer，支持前后帧着色与键盘逐帧）→
 * 帧间补间（缓动曲线、循环补间）→ 合并时间轴预览 / 加入序列 / 导出 ZIP。
 * 透明背景的精灵帧序列效果最佳。
 */

/** 导入上限：帧数与单文件体积（dataURL 全量驻留内存，需提前拦截） */
const MAX_FRAMES = 300
const MAX_FILE_BYTES = 10 * 1024 * 1024

const input = ref<HTMLInputElement>()
const sheetInput = ref<HTMLInputElement>()
const player = ref<InstanceType<typeof FramePreviewPlayer> | null>(null)
const currentId = ref<string | null>(null)
const frameCount = computed(() => workspace.onion.frames.length)
const resultCount = computed(() => workspace.onion.tweenResults.length)

/** 预览模式：原帧序列 / 含补间（补间帧按所属帧对插回原序列的合并时间轴） */
const previewMode = ref<'source' | 'tween'>('source')

interface StripFrame { id: string; url: string; name: string; tween: boolean }

/** 合并序列：每张原帧之后插入它与下一帧之间生成的中间帧（循环补间落在末帧之后） */
const mergedFrames = computed<StripFrame[]>(() => {
  const frames = workspace.onion.frames
  const merged: StripFrame[] = []
  frames.forEach((frame, index) => {
    merged.push({ id: frame.id, url: frame.url, name: frame.name, tween: false })
    workspace.onion.tweenResults
      .filter((result) => result.pairIndex === index)
      .sort((a, b) => a.step - b.step)
      .forEach((result) => merged.push({ id: result.id, url: result.url, name: result.name, tween: true }))
  })
  return merged
})
const previewFrames = computed<StripFrame[]>(() =>
  previewMode.value === 'tween' && resultCount.value ? mergedFrames.value : workspace.onion.frames.map((frame) => ({ ...frame, tween: false })),
)
/** 帧条与预览共用同一序列：含补间模式下补间帧也可点选定位 */
const stripFrames = computed(() => previewFrames.value)

/** 切换预览序列：从补间帧切回原帧时落到所属帧对的左邻原帧，不跳回开头 */
function setPreviewMode(mode: 'source' | 'tween'): void {
  if (mode === previewMode.value) return
  if (mode === 'source' && currentId.value) {
    const tween = workspace.onion.tweenResults.find((result) => result.id === currentId.value)
    if (tween) currentId.value = workspace.onion.frames[tween.pairIndex]?.id ?? null
  }
  previewMode.value = mode
}

/** 参数变化即持久化（帧序列与补间结果不跨会话保留） */
watch(
  () => [workspace.onion.fps, workspace.onion.loop, workspace.onion.before, workspace.onion.after, workspace.onion.alpha, workspace.onion.tint, workspace.onion.tweenCount, workspace.onion.tweenEasing, workspace.onion.tweenLoop],
  () => persistMediaSettings(),
)

/** 键盘快捷键：←/→ 逐帧、空格播放/暂停；输入控件聚焦时不拦截 */
function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
  if (event.key === 'ArrowLeft') { player.value?.previous(); event.preventDefault() }
  else if (event.key === 'ArrowRight') { player.value?.next(); event.preventDefault() }
  else if (event.key === ' ' || event.code === 'Space') { player.value?.toggle(); event.preventDefault() }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** 整页拖放导入（与音频工具一致的落点提示） */
const dragging = ref(false)
let dragDepth = 0
function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}
function onDragEnter(event: DragEvent): void {
  if (!hasFiles(event)) return
  dragDepth += 1
  dragging.value = true
}
function onDragOver(event: DragEvent): void {
  if (hasFiles(event)) event.preventDefault()
}
function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragging.value = false
}
function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  void importFrames(event.dataTransfer?.files ?? null)
}

/** 读取图片文件为 dataURL（保留透明通道） */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    reader.readAsDataURL(file)
  })
}

/** 写入帧序列并重置预览与补间结果 */
function applyFrames(frames: OnionFrame[]): void {
  workspace.onion.frames = frames
  workspace.onion.tweenResults = []
  workspace.onion.status = 'ready'
  workspace.onion.error = ''
  previewMode.value = 'source'
  currentId.value = frames[0]?.id ?? null
  persistMediaSettings()
}

/** 导入多张帧图片，按文件名自然排序（walk-2 < walk-10），超限提前拒绝 */
async function importFrames(fileList: FileList | null): Promise<void> {
  if (!fileList?.length) return
  try {
    const files = Array.from(fileList).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    if (files.length > MAX_FRAMES) throw new Error(`一次最多导入 ${MAX_FRAMES} 帧，当前 ${files.length} 张`)
    const oversized = files.find((file) => file.size > MAX_FILE_BYTES)
    if (oversized) throw new Error(`${oversized.name} 超过 10MB，请先压缩`)
    const frames: OnionFrame[] = await Promise.all(
      files.map(async (file) => ({ id: crypto.randomUUID(), name: file.name, url: await readAsDataUrl(file) })),
    )
    applyFrames(frames)
  } catch (error) {
    workspace.onion.status = 'error'
    workspace.onion.error = error instanceof Error ? error.message : '导入失败'
  }
}

/** 文件选择回调：把选择结果交给导入流程 */
function onPick(event: Event): void {
  void importFrames((event.target as HTMLInputElement).files)
  ;(event.target as HTMLInputElement).value = ''
}

/** 精灵图按网格切成帧序列：列 × 行 均匀切分，行优先编号 */
const sheetCols = ref(4)
const sheetRows = ref(1)
function clampGrid(value: number, fallback: number): number {
  return Math.min(32, Math.max(1, Math.round(value) || fallback))
}
async function sliceSheet(fileList: FileList | null): Promise<void> {
  const file = fileList?.[0]
  if (!file) return
  try {
    const url = await readAsDataUrl(file)
    const img = await loadImage(url)
    const cols = clampGrid(sheetCols.value, 4)
    const rows = clampGrid(sheetRows.value, 1)
    const cellW = Math.floor(img.naturalWidth / cols)
    const cellH = Math.floor(img.naturalHeight / rows)
    if (cellW < 1 || cellH < 1) throw new Error('切分格太小，请减少列/行数')
    const frames: OnionFrame[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('canvas')
        cell.width = cellW
        cell.height = cellH
        cell.getContext('2d')!.drawImage(img, c * cellW, r * cellH, cellW, cellH, 0, 0, cellW, cellH)
        frames.push({ id: crypto.randomUUID(), name: `${file.name.replace(/\.[^.]+$/, '')}-${String(frames.length + 1).padStart(3, '0')}.png`, url: cell.toDataURL('image/png') })
        cell.width = 0
        cell.height = 0
      }
    }
    applyFrames(frames)
  } catch (error) {
    workspace.onion.status = 'error'
    workspace.onion.error = error instanceof Error ? error.message : '切格失败'
  }
}
function onPickSheet(event: Event): void {
  void sliceSheet((event.target as HTMLInputElement).files)
  ;(event.target as HTMLInputElement).value = ''
}

/** 生成帧间补间：每对相邻帧生成 tweenCount 帧中间过渡，可选缓动曲线与循环对 */
async function runTween(): Promise<void> {
  if (frameCount.value < 2) return
  workspace.onion.status = 'tweening'
  workspace.onion.error = ''
  try {
    const results = await generateTweens(workspace.onion.frames, workspace.onion.tweenCount, {
      easing: workspace.onion.tweenEasing,
      loop: workspace.onion.tweenLoop,
    })
    workspace.onion.tweenResults = results.map((result) => ({ id: crypto.randomUUID(), url: result.url, name: result.name, pairIndex: result.pairIndex, step: result.step }))
    workspace.onion.status = 'done'
    persistMediaSettings()
  } catch (error) {
    workspace.onion.status = 'error'
    workspace.onion.error = error instanceof Error ? error.message : '补间生成失败'
  }
}

/** 把合并时间轴（原帧 + 补间帧）落为新的帧序列，可继续编辑或再补间 */
function applyMergedToSequence(): void {
  if (!resultCount.value) return
  applyFrames(mergedFrames.value.map((frame) => ({ id: frame.id, name: frame.name, url: frame.url })))
}

/** 把 dataURL 转成 Blob 供 ZIP 打包 */
async function urlToBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  return response.blob()
}

/** 导出补间结果为 ZIP（同名条目追加序号，防止截断命名互相覆盖） */
async function exportZip(): Promise<void> {
  if (!resultCount.value) return
  const names = dedupeNames(workspace.onion.tweenResults)
  const entries: ZipEntry[] = await Promise.all(
    workspace.onion.tweenResults.map(async (result, index) => ({ name: names[index], blob: await urlToBlob(result.url) })),
  )
  await downloadZip(entries, 'onion-tween.zip')
}

/** 帧号收敛到 1-5 */
function clampTweenCount(): void {
  workspace.onion.tweenCount = Math.min(5, Math.max(1, Math.round(workspace.onion.tweenCount || 2)))
}

/** 清空补间结果 */
function clearResults(): void {
  workspace.onion.tweenResults = []
  if (previewMode.value === 'tween') previewMode.value = 'source'
  if (workspace.onion.status === 'done') workspace.onion.status = frameCount.value ? 'ready' : 'empty'
}
</script>

<template>
  <div class="onion-page" @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <div v-if="dragging" class="drop-overlay">松手导入帧序列（图片按文件名排序）</div>
    <div class="onion-content">
      <div class="onion-left">
        <section class="frames-panel panel">
          <div class="panel-title">帧序列 <span class="badge">{{ frameCount }} 帧</span></div>
          <div class="frames-body">
            <div class="frames-actions">
              <input ref="input" hidden type="file" accept="image/*" multiple @change="onPick" />
              <button class="btn btn-primary" @click="input?.click()">导入帧序列</button>
              <span class="muted">多选 / 拖入图片按文件名排序 · 透明背景精灵帧效果最佳</span>
              <div class="sheet-box" title="把一张按网格排列多帧的精灵图（spritesheet）按列×行切成帧序列；逐张导入或视频帧送入无需此功能">
                <span class="sheet-label">精灵图切格 · 一张网格大图切成帧序列</span>
                <div class="sheet-row">
                  <input ref="sheetInput" hidden type="file" accept="image/*" @change="onPickSheet" />
                  <span class="sheet-size">
                    <input v-model.number="sheetCols" class="input" type="number" min="1" max="32" title="列数" />列
                    <span class="muted">×</span>
                    <input v-model.number="sheetRows" class="input" type="number" min="1" max="32" title="行数" />行
                  </span>
                  <button class="btn" @click="sheetInput?.click()">切为帧序列</button>
                </div>
              </div>
            </div>
            <div v-if="!frameCount" class="strip-empty">导入图片序列后开始洋葱皮预览</div>
            <div v-else class="strip">
              <button
                v-for="(frame, index) in stripFrames"
                :key="frame.id"
                class="frame-card"
                :class="{ active: currentId === frame.id, tween: frame.tween }"
                @click="currentId = frame.id"
              >
                <img :src="frame.url" :alt="`帧 ${index + 1}`" />
                <span><b>#{{ index + 1 }}</b><template v-if="frame.tween"> 补</template> {{ frame.name }}</span>
              </button>
            </div>
          </div>
        </section>

        <aside class="settings-panel panel">
          <h2 class="section-title">帧间补间</h2>
          <div class="settings-body">
            <p class="muted">相邻帧逐像素混合生成中间过渡帧，适合手绘动画缺帧时补过渡。</p>
            <label class="setting-row">
              <span>每对生成</span>
              <span class="setting-input">
                <input v-model.number="workspace.onion.tweenCount" class="input" type="number" min="1" max="5" @change="clampTweenCount" />
                <span class="muted">帧</span>
              </span>
            </label>
            <label class="setting-row">
              <span>权重曲线</span>
              <select v-model="workspace.onion.tweenEasing" class="input">
                <option value="linear">匀速</option>
                <option value="ease">缓入缓出</option>
              </select>
            </label>
            <label class="setting-row">
              <span>循环补间（末帧→首帧）</span>
              <input v-model="workspace.onion.tweenLoop" type="checkbox" />
            </label>
            <button class="btn btn-primary full" :disabled="frameCount < 2 || workspace.onion.status === 'tweening'" @click="runTween">
              {{ workspace.onion.status === 'tweening' ? '生成中…' : '生成补间' }}
            </button>
            <p v-if="workspace.onion.error" class="range-error">{{ workspace.onion.error }}</p>

            <template v-if="resultCount">
              <div class="result-head">
                <strong>补间结果</strong>
                <span class="badge">{{ resultCount }} 帧</span>
              </div>
              <div class="results">
                <div v-for="result in workspace.onion.tweenResults" :key="result.id" class="result-card">
                  <img :src="result.url" :alt="result.name" />
                  <span class="mono">{{ result.name }}</span>
                </div>
              </div>
              <div class="result-actions">
                <button class="btn" @click="exportZip">导出 ZIP</button>
                <button class="btn" @click="applyMergedToSequence">合并序列加入帧序列</button>
                <button class="btn" @click="clearResults">清空</button>
              </div>
            </template>
          </div>
        </aside>
      </div>

      <section class="preview-panel panel">
        <div class="panel-title">
          洋葱皮预览
          <div v-if="resultCount" class="mode-switch" role="group" aria-label="预览序列切换">
            <button class="mode-btn" :class="{ active: previewMode === 'source' }" @click="setPreviewMode('source')">原帧 {{ frameCount }}</button>
            <button class="mode-btn" :class="{ active: previewMode === 'tween' }" @click="setPreviewMode('tween')">含补间 {{ mergedFrames.length }}</button>
          </div>
          <label class="tint-toggle" title="过去帧染暖橙、未来帧染冷蓝，便于分辨轨迹方向">
            <input v-model="workspace.onion.tint" type="checkbox" />
            <span>前后帧着色</span>
          </label>
          <span class="kbd-hint">←/→ 逐帧 · 空格播放</span>
        </div>
        <FramePreviewPlayer
          ref="player"
          v-model:current-id="currentId"
          :frames="previewFrames"
          :fps="workspace.onion.fps"
          :loop="workspace.onion.loop"
          :onion-enabled="true"
          :onion-before="workspace.onion.before"
          :onion-after="workspace.onion.after"
          :onion-alpha="workspace.onion.alpha"
          :onion-tint="workspace.onion.tint"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.onion-page { position: relative; flex: 1; min-height: 0; height: auto; overflow: hidden; }
.drop-overlay { position: absolute; inset: 8px; z-index: 5; display: flex; align-items: center; justify-content: center; color: var(--accent-strong); font-size: var(--fs-body); background: rgba(20, 24, 34, 0.72); border: 2px dashed var(--accent); border-radius: var(--radius-m); pointer-events: none; }
.onion-content { height: 100%; display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 1px; background: var(--border); }
.onion-left { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 1px; background: var(--border); }
.frames-panel, .preview-panel, .settings-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--surface); }
.frames-panel { flex: 3 1 60%; }
.settings-panel { flex: 2 1 40%; }
.panel-title { height: 36px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px; color: var(--text-muted); border-bottom: 1px solid var(--border); font-size: var(--fs-caption); }
.mode-switch { display: flex; gap: 2px; padding: 2px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-s); }
.mode-btn { height: 22px; padding: 0 8px; color: var(--text-faint); border-radius: calc(var(--radius-s) - 2px); font-size: var(--fs-caption); }
.mode-btn:hover { color: var(--text); }
.mode-btn.active { color: var(--accent-strong); background: var(--accent-dim); }
.tint-toggle { display: flex; align-items: center; gap: 5px; color: var(--text-faint); font-size: var(--fs-caption); cursor: pointer; }
.kbd-hint { margin-left: auto; color: var(--text-faint); font: 11px var(--font-mono); }
.frames-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; overflow: hidden; }
.frames-actions { flex: none; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.frames-actions .muted { font-size: var(--fs-caption); }
.sheet-box { display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 100%; padding-top: 10px; border-top: 1px dashed var(--border); }
.sheet-label { color: var(--text-muted); font-size: var(--fs-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sheet-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--fs-caption); }
.sheet-size { display: flex; align-items: center; gap: 4px; color: var(--text-faint); }
.sheet-size .input { width: 44px; }
.strip { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-content: start; overflow-y: auto; padding: 12px 4px 4px; }
.strip-empty { color: var(--text-faint); padding: 24px 0; font-size: var(--fs-caption); }
.frame-card { min-width: 0; padding: 4px; text-align: left; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-s); }
.frame-card.active { border-color: var(--accent); }
.frame-card.tween { border-style: dashed; }
.frame-card img { width: 100%; height: 76px; object-fit: contain; background-color: var(--checker-a); background-image: linear-gradient(45deg, #232734 25%, transparent 25%), linear-gradient(-45deg, transparent 75%, #232734 75%); background-size: 12px 12px; }
.frame-card span { display: block; padding-top: 3px; color: var(--text-faint); font: 11px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-panel .section-title { flex: none; margin: 0; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.settings-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.settings-body .muted { font-size: var(--fs-caption); line-height: 1.5; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--fs-caption); }
.setting-input { display: flex; align-items: center; gap: 6px; }
.setting-input .input { width: 56px; }
.full { width: 100%; justify-content: center; }
.range-error { color: var(--danger); font-size: var(--fs-caption); margin: 0; }
.result-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-size: var(--fs-caption); }
.results { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; }
.result-card { padding: 4px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-s); }
.result-card img { width: 100%; height: 60px; object-fit: contain; background-color: var(--checker-a); background-image: linear-gradient(45deg, #232734 25%, transparent 25%), linear-gradient(-45deg, transparent 75%, #232734 75%); background-size: 12px 12px; }
.result-card .mono { display: block; padding-top: 3px; color: var(--text-faint); font: 10px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
