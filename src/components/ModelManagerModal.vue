<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  AI_ENGINES,
  describeMattingError,
  imglyDtypeForModel,
  modelBlockReason,
  resolveDevice,
  resolveDtype,
  type MatteDtype,
  type MatteProgress,
} from '@/core/ai-matting'
import {
  MODEL_REPOS,
  downloadCommand,
  formatBytes,
  inspectLocalRepo,
  type LocalFileState,
  type LocalFileStatus,
  type LocalRepoStatus,
  type ModelRepoSpec,
} from '@/core/model-registry'
import {
  ensureMatteModelLoaded,
  matteModelKey,
  modelStateLabel,
  modelStatus,
  releaseMatteModel,
  type ModelEngine,
  type ModelState,
} from '@/store/model-status'
import { workspace } from '@/store/workspace'

/**
 * 全局「模型管理」弹窗。
 * 后续各种模型的下载与内存加载都集中在这里：本地权重是否就位、当前精度与推理设备、
 * 内存中的加载状态、卸载入口与下载命令。
 *
 * 注意浏览器没有文件系统写权限：ISNet 的资源能直接在页面内下载（官方 CDN，
 * 由浏览器缓存），而 BiRefNet / RMBG-1.4 / SAM 的权重必须落在项目的 public/models 下
 * （代码对它们强制 local_files_only，缺文件不会回落远程），这里只做检测并提供终端命令。
 */
const emit = defineEmits<{ close: [] }>()

/** 精度与设备的紧凑文案；完整选项带说明，这里只用于一行提示 */
const DTYPE_TEXT: Record<MatteDtype, string> = { fp16: 'FP16', q8: 'Q8', fp32: 'FP32' }
const FILE_STATE_TEXT: Record<LocalFileState, string> = { ok: '已就位', missing: '缺失', mismatch: '大小不符' }

/** 本地文件检测结果，按仓库 id 索引 */
const localStatus = reactive<Record<string, LocalRepoStatus>>({})
/** 是否已跑过一次检测：未检测时不显示「缺失」，避免误导 */
const checked = ref(false)
const checking = ref(false)
/** 正在进行中的加载进度，按引擎索引；仅加载期间存在 */
const progress = reactive<Record<string, { text: string; percent: number }>>({})
/** 复制反馈：key 定位是哪个按钮被点过；text 保留命令原文，复制失败时展示出来让用户手动选中 */
const copied = ref<{ key: string; ok: boolean; text: string } | null>(null)

interface EngineRow {
  engine: ModelEngine
  label: string
  license: string
  size: string
  description: string
  /** 内置权重仓库；ISNet 的资源来自官方 CDN，没有仓库 */
  repo?: ModelRepoSpec
  /** 本地文件检测结果，未检测时为 undefined */
  local?: LocalRepoStatus
  dtype: MatteDtype
  device: 'cpu' | 'gpu'
  /** 该模型在当前设备上跑不起来的原因；可用时为空串 */
  blocked: string
  /** 共享模型状态的 key 与状态 */
  statusKey: string
  state: ModelState
}

/** 引擎实际使用的精度：ISNet 由 imglyModel 决定，SAM 固定 Q8，其余走共享 aiDtype */
function effectiveDtype(engine: ModelEngine): MatteDtype {
  if (engine === 'imgly') return imglyDtypeForModel(workspace.matte.imglyModel)
  if (engine === 'sam') return 'q8'
  return resolveDtype(engine, workspace.matte.aiDtype)
}

const rows = computed<EngineRow[]>(() =>
  AI_ENGINES.map((engine) => {
    const dtype = effectiveDtype(engine.key)
    const device = resolveDevice(dtype, workspace.matte.aiDevice)
    const modelId = engine.key === 'birefnet' ? workspace.matte.birefnetModelId : engine.key === 'rmbg' ? workspace.matte.rmbgModelId : ''
    const repo = MODEL_REPOS.find((item) => item.engine === engine.key)
    const statusKey = matteModelKey(engine.key)
    return {
      engine: engine.key,
      label: engine.label,
      license: engine.license,
      size: engine.size,
      description: engine.description,
      repo,
      local: repo ? localStatus[repo.id] : undefined,
      dtype,
      device,
      blocked: modelId ? (modelBlockReason(modelId, device) ?? '') : '',
      statusKey,
      state: modelStatus[statusKey]?.state ?? 'unknown',
    }
  }),
)

/** 下载命令里的模型源，与当前「托管源」设置保持一致 */
const commandHost = computed(() => (workspace.matte.aiModelHost === 'huggingface.co' ? 'https://huggingface.co' : 'https://hf-mirror.com'))

/** 加载失败时的可读原因：把引擎原始报错翻译成中文 */
function errorText(row: EngineRow): string {
  const message = modelStatus[row.statusKey]?.message
  return message ? describeMattingError(message, row.engine) : ''
}

/** 是否可加载：已在内存中、跑不起来、或本地基础文件不全时不可加载（未检测时先放行，失败会给出明确原因） */
function canLoad(row: EngineRow): boolean {
  if (row.state === 'loading' || row.state === 'ready') return false
  if (row.blocked) return false
  return !(checked.value && row.repo && !row.local?.ready)
}

/** 主按钮文案：ISNet 的权重要到首次加载时才联网下载，因此与其它引擎区分 */
function loadLabel(row: EngineRow): string {
  if (row.state === 'loading') return '加载中…'
  if (row.state === 'ready') return '已加载'
  return row.engine === 'imgly' ? '下载并加载' : '加载到内存'
}

/** 探测内置仓库的本地文件是否就位 */
async function checkLocal(): Promise<void> {
  checking.value = true
  try {
    const results = await Promise.all(MODEL_REPOS.map((repo) => inspectLocalRepo(repo)))
    for (const result of results) localStatus[result.repo.id] = result
    checked.value = true
  } finally {
    checking.value = false
  }
}

/** 加载到内存：进度写入共享 store，与抠图页、一键处理弹窗看到的是同一份状态 */
async function load(engine: ModelEngine): Promise<void> {
  progress[engine] = { text: '准备模型…', percent: -1 }
  try {
    await ensureMatteModelLoaded(engine, (update: MatteProgress) => {
      progress[engine] = { text: update.text, percent: update.percent ?? -1 }
    })
  } catch {
    // 失败原因已由 modelStatus 保存，errorText 会翻译后展示，这里只负责清掉进度
  } finally {
    delete progress[engine]
  }
}

/** 卸载：释放底层 ONNX 会话，把 wasm 堆内存归还浏览器 */
async function unload(engine: ModelEngine): Promise<void> {
  await releaseMatteModel(engine)
}

/**
 * 复制文本到剪贴板并给出结果反馈。
 * 失败（浏览器未授予剪贴板权限等）时保留命令原文，由模板就地展示供手动选中，
 * 且不自动消失——否则用户还没选中，提示和命令就一起没了。
 * @param text 待复制的完整命令
 * @param key 反馈归属的按钮标识
 */
async function copy(text: string, key: string): Promise<void> {
  let ok = true
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    ok = false
  }
  copied.value = { key, ok, text }
  if (!ok) return
  window.setTimeout(() => {
    if (copied.value?.key === key) copied.value = null
  }, 2000)
}

/** 文件状态文案：大小不符时补上实际字节数，便于判断是否下载中断 */
function fileStateText(file: LocalFileStatus): string {
  return file.state === 'mismatch' ? `${FILE_STATE_TEXT[file.state]}（实际 ${formatBytes(file.actualSize)}）` : FILE_STATE_TEXT[file.state]
}

onMounted(() => {
  void checkLocal()
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal model-modal" role="dialog" aria-modal="true" aria-labelledby="model-manager-title">
      <div class="modal-head">
        <div>
          <h2 id="model-manager-title">模型管理</h2>
          <p class="faint">模型下载与内存加载的统一入口；加载期间关闭窗口不会中断下载，重新打开即可看到进度</p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="manager-bar">
          <span class="muted">模型源 <span class="mono">{{ commandHost }}</span></span>
          <button class="btn" :disabled="checking" @click="checkLocal">{{ checking ? '检测中…' : '重新检测本地文件' }}</button>
          <button class="btn" @click="copy(downloadCommand(undefined, commandHost), 'all')">复制全部下载命令</button>
          <span v-if="copied" class="copy-hint" :class="{ fail: !copied.ok }">{{ copied.ok ? '已复制到剪贴板' : '复制失败，请手动选中下方命令' }}</span>
        </div>

        <code v-if="copied && !copied.ok" class="cmd-fallback">{{ copied.text }}</code>

        <article v-for="row in rows" :key="row.engine" class="model-card">
          <header class="card-head">
            <div class="card-title">
              <strong>{{ row.label }}</strong>
              <span class="badge">{{ row.license }}</span>
              <span class="faint">{{ row.size }}</span>
            </div>
            <div class="card-actions">
              <span class="badge" :class="{ 'badge-accent': row.state === 'ready', 'badge-error': row.state === 'error' }">{{ modelStateLabel(row.state) }}</span>
              <button class="btn" :disabled="!canLoad(row)" @click="load(row.engine)">{{ loadLabel(row) }}</button>
              <button
                class="btn"
                :disabled="row.state !== 'ready' || row.engine === 'imgly'"
                :title="row.engine === 'imgly' ? 'ISNet 的会话由 imgly 运行时内部持有，重新加载页面即可释放' : '释放 ONNX 会话，归还 wasm 堆内存'"
                @click="unload(row.engine)"
              >
                卸载
              </button>
            </div>
          </header>

          <p class="card-meta muted">{{ row.description }} · 加载方式 {{ DTYPE_TEXT[row.dtype] }} · {{ row.device === 'gpu' ? 'GPU / WebGPU' : 'CPU' }}（在「抠图」页或一键处理弹窗中切换）</p>

          <div v-if="row.blocked" class="warn">⛔ {{ row.blocked }}</div>

          <p v-if="row.state === 'error'" class="card-error">{{ errorText(row) }}</p>

          <div v-if="progress[row.engine]" class="load-status">
            <p class="faint">{{ progress[row.engine].text }}</p>
            <div class="load-track"><div class="load-fill" :style="{ width: progress[row.engine].percent >= 0 ? progress[row.engine].percent + '%' : '100%' }"></div></div>
          </div>

          <template v-if="row.engine === 'imgly'">
            <p class="card-meta faint">权重来自官方 CDN（staticimgly.com），首次加载时联网下载并由浏览器缓存；imgly 运行时不提供卸载接口，刷新页面即可释放。</p>
          </template>

          <div v-else-if="row.repo" class="file-list">
            <div class="file-head">
              <span class="mono">{{ row.repo.id }}</span>
              <span v-if="!checked" class="faint">未检测</span>
              <span v-else-if="row.local?.ready" class="ok">基础文件已就位</span>
              <span v-else class="miss">缺 {{ row.local?.missing.length ?? 0 }} 个文件</span>
              <button class="btn btn-ghost" @click="copy(downloadCommand(row.repo.id, commandHost), row.repo.id)">复制下载命令</button>
              <span v-if="copied?.key === row.repo.id" class="copy-hint" :class="{ fail: !copied.ok }">{{ copied.ok ? '已复制' : '复制失败' }}</span>
            </div>
            <ul v-if="row.local" class="file-items">
              <li v-for="file in row.local.files" :key="file.file">
                <span class="mono">{{ file.file }}</span>
                <span class="faint">{{ formatBytes(file.size) }}</span>
                <span v-if="file.tier === 'extra'" class="badge">可选精度</span>
                <span class="file-state" :class="file.state">{{ fileStateText(file) }}</span>
              </li>
            </ul>
            <p v-if="row.local && !row.local.ready" class="card-meta faint">
              浏览器没有文件系统写权限，这些权重必须在终端执行上面的命令下载到 public/models 下（命令会跳过已存在的文件，可重复运行续传）。
            </p>
          </div>
        </article>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.model-modal {
  width: min(880px, calc(100vw - 48px));
}

.model-modal .modal-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-height: min(72vh, 760px);
  overflow-y: auto;
}

.manager-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--border);
}

.manager-bar .muted {
  margin-right: auto;
  font-size: var(--fs-caption);
}

.copy-hint {
  font-size: var(--fs-caption);
  color: var(--accent-strong);
}

.copy-hint.fail {
  color: var(--danger);
}

/* 剪贴板不可用时的兜底：命令原文可整体选中，用户复制到终端即可 */
.cmd-fallback {
  display: block;
  padding: 8px 10px;
  background: var(--surface-raised);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-s);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
  user-select: all;
}

.model-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.card-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-right: auto;
  font-size: var(--fs-body);
}

.card-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.card-meta {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.card-error {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--danger);
}

.badge-error {
  background: rgba(248, 113, 113, 0.14);
  color: var(--danger);
}

.load-status {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
}

.load-status p {
  margin: 0;
}

.load-track {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}

.load-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding-top: var(--sp-2);
  border-top: 1px dashed var(--border);
}

.file-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}

.file-head .mono {
  margin-right: auto;
  color: var(--text-muted);
}

.file-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.file-items li {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: 11px;
}

.file-items .mono {
  margin-right: auto;
  color: var(--text-faint);
}

.file-state.ok,
.ok {
  color: var(--accent-strong);
}

.file-state.missing,
.file-state.mismatch,
.miss {
  color: var(--danger);
}
</style>