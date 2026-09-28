<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { createCancelToken } from '@/core/frame-extract'
import { loadImage } from '@/core/image'
import { downloadBlob } from '@/core/media-export'
import {
  LayerSplitError,
  bundleZipUrl,
  checkServer,
  currentApiBase,
  exportLayersZip,
  mapJobToLayers,
  setApiBase,
  startSplit,
  type ServerHealth,
  type ModeToken,
  type UserBox,
} from '@/core/layer-split'
import { persistMediaSettings, resetLayerSplit, workspace } from '@/store/workspace'
import LayerBoxEditor from '@/components/LayerBoxEditor.vue'
import LayerSplitList from '@/components/LayerSplitList.vue'
import LayerSplitSettingsFields from '@/components/LayerSplitSettingsFields.vue'
import LayerSplitStage from '@/components/LayerSplitStage.vue'
import TaskProgress from '@/components/TaskProgress.vue'

/**
 * 图层拆分页。
 * 素材与推理都在本机：浏览器只负责导入、预览与合成，
 * 真正的检测/分割由 `server/` 下的 Python 服务完成，这里只通过 core/layer-split 调它的接口。
 */
const STATUS_TEXT: Record<string, string> = {
  empty: '未导入',
  ready: '待拆分',
  processing: '拆分中',
  done: '已拆分',
  error: '出错',
}

/** 服务启动命令：与 package.json 的 server:dev 一致，离线时直接给用户复制 */
const START_COMMAND = 'npm run server:dev'
const MODELS_COMMAND = 'npm run server:models'

const input = ref<HTMLInputElement>()
const serverAddr = ref(currentApiBase())
const health = ref<ServerHealth | null>(null)
/** 探活进行中（含手动重试） */
const checking = ref(false)
const copied = ref(false)
const selectedIds = ref<string[]>([])
const errorText = ref('')
const notice = ref('')
const exporting = ref(false)
const progress = ref({ running: false, percent: -1, text: '', cancelling: false })
/** 框选编辑模式：null = 不在编辑，UserBox[] = 用户确认的框选 */
const boxEditing = ref(false)
/** 用户在框选编辑器中确认的区域 */
const userBoxes = ref<UserBox[]>([])

let token: ModeToken = createCancelToken()
/** 提交代号：重置或重复提交后，迟到的作业结果不再写回 */
let runToken = 0

const split = computed(() => workspace.layersplit)
const hasSource = computed(() => Boolean(split.value.sourceUrl))
const hasLayers = computed(() => split.value.layers.length > 0)
const online = computed(() => split.value.serverOnline)
/** 权重未就绪时服务会回 409，这里提前提示，避免白等一次推理 */
const modelsMissing = computed(() => Boolean(health.value && !health.value.models_ready))
const size = computed(() => split.value.image ?? { width: 0, height: 0, scale: 1 })
const canSplit = computed(() => hasSource.value && online.value && !progress.value.running)
/** 推理长边上限与原始尺寸的差距：提示坐标会映射回原图 */
const downscaled = computed(() => size.value.scale > 0 && size.value.scale < 0.999)

/** 探活：把结果同时写进 store，顶部栏的状态文案与这里共用一份 */
async function probeServer(): Promise<void> {
  checking.value = true
  errorText.value = ''
  try {
    const result = await checkServer()
    health.value = result
    split.value.serverOnline = true
    split.value.serverDevice = result.device
  } catch (error) {
    health.value = null
    split.value.serverOnline = false
    split.value.serverDevice = ''
    errorText.value = error instanceof Error ? error.message : '无法连接本地服务'
  } finally {
    checking.value = false
  }
}

function applyServerAddr(): void {
  serverAddr.value = setApiBase(serverAddr.value)
  void probeServer()
}

async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = true
    window.setTimeout(() => { copied.value = false }, 1500)
  } catch {
    errorText.value = '复制失败，请手动选中命令复制'
  }
}

/** 量出原始像素尺寸：舞台与客户端合并/导出的画布都要用它 */
async function measureSource(): Promise<void> {
  const url = split.value.sourceUrl
  if (!url) return
  try {
    const image = await loadImage(url, '图像加载失败')
    if (split.value.sourceUrl !== url) return
    split.value.image = { width: image.naturalWidth, height: image.naturalHeight, scale: 1 }
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '图像加载失败'
  }
}

function load(file?: File): void {
  if (!file || !file.type.startsWith('image/')) return
  resetLayerSplit()
  split.value.fileName = file.name
  split.value.sourceUrl = URL.createObjectURL(file)
  split.value.status = 'ready'
  selectedIds.value = []
  errorText.value = ''
  notice.value = ''
  boxEditing.value = false
  userBoxes.value = []
  void measureSource()
}

/** input[type=file] change 事件处理 */
function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  load(input.files?.[0])
}

/** 只清结果，保留来源与设置；合并层的 blob URL 由客户端创建，必须手动释放 */
function clearResult(): void {
  split.value.layers.filter((layer) => layer.merged).forEach((layer) => URL.revokeObjectURL(layer.pngUrl))
  split.value.layers = []
  split.value.background = null
  split.value.counts = {}
  split.value.warnings = []
  split.value.jobId = ''
  selectedIds.value = []
}

/** 来源、设置或层序变更后旧结果不再对应，回到待拆分；拆到一半时不打断在途作业 */
function invalidateResult(): void {
  if (progress.value.running) return
  clearResult()
  if (hasSource.value) split.value.status = 'ready'
}

async function runSplit(overrides?: UserBox[]): Promise<void> {
  if (!canSplit.value) return
  const stamp = ++runToken
  clearResult()
  token = createCancelToken()
  progress.value = { running: true, percent: 0, text: '正在提交…', cancelling: false }
  errorText.value = ''
  notice.value = ''
  split.value.status = 'processing'
  try {
    const blob = await (await fetch(split.value.sourceUrl)).blob()
    const job = await startSplit(blob, split.value.fileName, split.value.settings, {
      token,
      onProgress: (update) => {
        progress.value = { running: true, percent: update.percent, text: update.text, cancelling: progress.value.cancelling }
      },
    }, overrides)
    if (stamp !== runToken) return
    const { layers, background } = mapJobToLayers(job)
    split.value.jobId = job.job_id
    split.value.layers = layers
    split.value.background = background
    split.value.counts = job.counts ?? {}
    split.value.warnings = job.warnings ?? []
    if (job.image) {
      split.value.image = { width: job.image.width, height: job.image.height, scale: job.image.scale }
    }
    split.value.status = 'done'
    progress.value = { running: false, percent: 100, text: `已拆出 ${layers.length} 个图层`, cancelling: false }
    if (!layers.length) notice.value = '没有检测到元素：提示词要英文，或把检测框阈值调低后重试。'
  } catch (error) {
    if (stamp !== runToken) return
    const failure = error instanceof LayerSplitError ? error : null
    const cancelled = failure?.code === 'JOB_CANCELLED' || token.cancelled
    if (cancelled) {
      split.value.status = hasSource.value ? 'ready' : 'empty'
      progress.value = { running: false, percent: -1, text: '已取消', cancelling: false }
    } else if (failure?.code === 'JOB_NOT_FOUND') {
      // 作业只存在内存里，服务重启即失效：回到待拆分而不是继续轮询
      split.value.status = hasSource.value ? 'ready' : 'empty'
      errorText.value = '本地服务已重启，本次作业已失效，请重新开始拆分。'
      progress.value = { running: false, percent: -1, text: '', cancelling: false }
    } else {
      split.value.status = 'error'
      errorText.value = [failure?.message ?? '拆分失败', failure?.hint ?? ''].filter(Boolean).join(' ')
      progress.value = { running: false, percent: -1, text: '', cancelling: false }
    }
  }
}

function cancel(): void {
  token.cancelled = true
  progress.value = { ...progress.value, cancelling: true, text: '正在取消…' }
}

/** 客户端 ZIP：尊重改名/隐藏/层序/合并，命名走统一的命名模板 */
async function exportClientZip(): Promise<void> {
  if (exporting.value || !hasLayers.value) return
  exporting.value = true
  errorText.value = ''
  try {
    await exportLayersZip(split.value.layers, {
      name: split.value.fileName || 'image.png',
      width: size.value.width,
      height: size.value.height,
      url: split.value.sourceUrl,
    })
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 服务端整包：原样命名并带 atlas.json，与客户端 ZIP 刻意区分 */
async function exportServerBundle(): Promise<void> {
  if (exporting.value || !split.value.jobId) return
  exporting.value = true
  errorText.value = ''
  try {
    const response = await fetch(bundleZipUrl(split.value.jobId))
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
    const base = (split.value.fileName || 'layers').replace(/\.[^.]+$/, '')
    downloadBlob(await response.blob(), `${base}-bundle.zip`)
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '下载失败'
  } finally {
    exporting.value = false
  }
}

function reset(): void {
  runToken += 1
  token.cancelled = true
  progress.value = { running: false, percent: -1, text: '', cancelling: false }
  resetLayerSplit()
  selectedIds.value = []
  errorText.value = ''
  notice.value = ''
  boxEditing.value = false
  userBoxes.value = []
}

/** 进入框选编辑模式 */
function startBoxEdit(): void {
  boxEditing.value = true
  errorText.value = ''
  notice.value = ''
}

/** 框选编辑确认：用用户框选拆分 */
function confirmBoxEdit(boxes: UserBox[]): void {
  boxEditing.value = false
  userBoxes.value = boxes
  void runSplit(boxes)
}

/** 框选编辑取消 */
function cancelBoxEdit(): void {
  boxEditing.value = false
}

/** 直接拆分（不经过框选编辑） */
function quickSplit(): void {
  void runSplit()
}

// 设置只持久化（与其余处理页共用同一份本地设置），同时作废旧结果
watch(split.value.settings, () => { persistMediaSettings(); invalidateResult() }, { deep: true })

onMounted(() => { void probeServer() })
</script>

<template>
  <div class="tool-page">
    <section class="tool-sidebar panel">
      <div class="section">
        <h2 class="section-title">素材</h2>
        <button class="btn btn-primary full" @click="input?.click()">导入图片</button>
        <input
          ref="input"
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp"
          @change="onFileChange"
        />
        <p class="muted file-name">
          {{ split.fileName || '未选择素材' }}
          <span v-if="size.width" class="mono"> · {{ size.width }}×{{ size.height }}</span>
        </p>
      </div>

      <div class="section">
        <h2 class="section-title">本地服务</h2>
        <p class="muted">
          检测与分割由本机 Python 服务完成，素材不出本机
          <span class="mono">{{ online ? ` · ${split.serverDevice || '设备未知'}` : '' }}</span>
        </p>
        <div class="field-row">
          <input v-model="serverAddr" class="input mono" placeholder="http://127.0.0.1:8000" @keyup.enter="applyServerAddr" />
          <button class="btn" :disabled="checking" @click="applyServerAddr">{{ checking ? '连接中…' : '应用' }}</button>
        </div>
        <div class="field-row">
          <span class="status" :class="{ ok: online }">{{ online ? '已连接' : '未连接' }}</span>
          <button class="btn btn-ghost" :disabled="checking" @click="probeServer">重试连接</button>
          <button class="btn btn-ghost" @click="copy(START_COMMAND)">{{ copied ? '已复制' : '复制启动命令' }}</button>
        </div>
      </div>

      <LayerSplitSettingsFields />

      <div class="section actions">
        <template v-if="hasSource && !hasLayers && !boxEditing">
          <button class="btn btn-primary full" :disabled="!canSplit" @click="startBoxEdit">
            框选编辑
          </button>
          <button class="btn full" :disabled="!canSplit" @click="quickSplit">
            快速拆分
          </button>
        </template>
        <button v-if="hasLayers" class="btn btn-primary full" :disabled="!canSplit" @click="startBoxEdit">
          重新框选拆分
        </button>
        <button v-if="boxEditing" class="btn full" @click="cancelBoxEdit">退出编辑</button>
        <TaskProgress
          v-if="progress.running || progress.text || errorText"
          :running="progress.running"
          :done="0"
          :total="0"
          :percent="progress.percent"
          :text="progress.text"
          :error="errorText"
          :cancelling="progress.cancelling"
          @cancel="cancel"
        />
        <p v-if="notice" class="muted">{{ notice }}</p>
        <template v-if="hasLayers">
          <button class="btn btn-primary full" :disabled="exporting" @click="exportClientZip">
            {{ exporting ? '打包中…' : `导出 ZIP（${split.layers.filter((layer) => layer.visible).length} 层）` }}
          </button>
          <button class="btn full" :disabled="exporting || !split.jobId" @click="exportServerBundle">下载服务端整包</button>
          <p class="muted">
            客户端 ZIP 尊重改名、隐藏与层序；服务端整包按原样命名，并附带可直接导入「精灵图」页的 atlas.json。
          </p>
        </template>
        <button class="btn btn-ghost full" :disabled="!hasSource" @click="reset">重置</button>
      </div>
    </section>

    <main class="tool-main">
      <div class="tool-header">
        <div>
          <h2>图层拆分工作区</h2>
          <p>{{ split.fileName || '导入一张游戏 UI 截图，拆成可独立复用的图层' }}</p>
        </div>
        <span v-if="hasLayers" class="badge badge-accent">{{ split.layers.length }} 个图层</span>
        <span v-else class="badge">{{ STATUS_TEXT[split.status] }}</span>
      </div>

      <div class="tool-body">
        <div v-if="!online" class="warn offline">
          <p><strong>本地 Python 服务未连接</strong>：拆分必须由它执行推理。</p>
          <p class="mono cmd">{{ START_COMMAND }}</p>
          <div class="offline-actions">
            <button class="btn" @click="copy(START_COMMAND)">{{ copied ? '已复制' : '复制命令' }}</button>
            <button class="btn" :disabled="checking" @click="probeServer">{{ checking ? '连接中…' : '重试连接' }}</button>
          </div>
          <p class="muted">
            首次使用需先在 server/ 目录建虚拟环境并安装依赖，再用
            <span class="mono">{{ MODELS_COMMAND }}</span>
            下载权重（约 1.5GB）。服务只监听 127.0.0.1。
          </p>
        </div>

        <div v-else-if="modelsMissing" class="warn">
          <p><strong>模型权重未就绪</strong>：先执行 <span class="mono">{{ MODELS_COMMAND }}</span> 下载权重，再重试连接。</p>
        </div>

        <div v-if="!hasSource" class="empty-state">
          <span class="big">▤</span>
          <strong>还没有可拆分的素材</strong>
          <span>导入一张游戏 UI 截图（商店面板 / 背包 / HUD 等），或在左侧填好类别提示词</span>
        </div>

        <div v-else class="ls-workspace">
          <LayerBoxEditor
            v-if="boxEditing"
            @confirm="confirmBoxEdit"
            @cancel="cancelBoxEdit"
          />
          <figure v-else-if="!hasLayers" class="ls-source">
            <img :src="split.sourceUrl" alt="待拆分素材" />
            <figcaption class="faint">
              {{ progress.running ? '正在拆分…' : '尚未拆分' }}
              <span v-if="downscaled" class="mono"> · 推理按 1/{{ (1 / size.scale).toFixed(2) }} 缩放，坐标已映射回原图</span>
            </figcaption>
          </figure>
          <LayerSplitStage
            v-else
            :layers="split.layers"
            :background="split.background"
            :selected="selectedIds"
            :width="size.width"
            :height="size.height"
            @select="selectedIds = [$event]"
          />
          <LayerSplitList
            v-if="hasLayers"
            v-model:selected="selectedIds"
            @reset="reset"
          />
        </div>

        <p v-if="split.warnings.length" class="warn">
          {{ split.warnings.join('；') }}
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.tool-page { display: grid; grid-template-columns: 320px minmax(0, 1fr); height: 100%; min-height: 0; }
.tool-sidebar { border-right: 1px solid var(--border); overflow: auto; }
.tool-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tool-header { height: 64px; flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; border-bottom: 1px solid var(--border); }
.tool-header h2 { margin: 0; font-size: var(--fs-head); }
.tool-header p { margin: 2px 0 0; color: var(--text-faint); }
.tool-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding: 24px; }
.full { width: 100%; justify-content: center; }
.actions { display: flex; flex-direction: column; gap: var(--sp-2); }
.file-name { margin: var(--sp-2) 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { flex: 1; color: var(--danger); font-size: var(--fs-caption); }
.status.ok { color: var(--accent-strong); }
.section .field-row + .field-row { margin-top: var(--sp-2); }
.section .muted + .field-row { margin-top: var(--sp-2); }
.offline .cmd { margin: var(--sp-2) 0; padding: 6px 8px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-s); user-select: all; }
.offline-actions { display: flex; gap: var(--sp-2); }
/* 工作区：左侧合成舞台，右侧图层面板 */
.ls-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--sp-4); align-items: stretch; }
.ls-source { margin: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-3); background: var(--stage); border: 1px solid var(--border); border-radius: var(--radius-s); overflow: hidden; }
.ls-source img { max-width: 100%; max-height: 100%; min-height: 0; object-fit: contain; }
.ls-source figcaption { flex: none; font-size: var(--fs-caption); }
</style>