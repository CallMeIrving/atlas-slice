<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import {
  AI_ENGINES,
  describeMattingError,
  imglyDtypeForModel,
  resolveDevice,
  resolveDtype,
  type MatteDtype,
  type MatteProgress,
} from '@/core/ai-matting'
import {
  IMGLY_MIRROR_COMMAND,
  IMGLY_MIRROR_PATH,
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
import ServerModelCard from '@/components/ServerModelCard.vue'

/**
 * 全局「模型管理」弹窗。
 * 后续各种模型的下载与内存加载都集中在这里：本地权重是否就位、当前精度与推理设备、
 * 内存中的加载状态、卸载入口与下载命令。
 *
 * 注意浏览器没有文件系统写权限：ISNet 的资源运行时就会下载（本地镜像优先，无镜像才回落官方 CDN，
 * 由浏览器缓存），也可以先用下载脚本镜像到 models/ 下；而 RMBG-1.4 的权重必须落在
 * models/ 下（代码对它们强制 local_files_only，缺文件不会回落远程），这里只做检测并提供终端命令。
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

/** Electron 环境：权重可直接经主进程落到 models/，不必手工跑终端命令 */
const isElectron = Boolean(window.atlasSlice)
/** 应用内下载进行中；进度文本来自主进程脚本的 stdout */
const downloading = ref(false)
const downloadText = ref('')
const downloadOk = ref(false)
let offProgress: (() => void) | null = null

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
  /** 共享模型状态的 key 与状态 */
  statusKey: string
  state: ModelState
}

/** 引擎实际使用的精度：ISNet 由 imglyModel 决定，其余走共享 aiDtype */
function effectiveDtype(engine: ModelEngine): MatteDtype {
  if (engine === 'imgly') return imglyDtypeForModel(workspace.matte.imglyModel)
  return resolveDtype(engine, workspace.matte.aiDtype)
}

const rows = computed<EngineRow[]>(() =>
  AI_ENGINES.map((engine) => {
    const dtype = effectiveDtype(engine.key)
    const device = resolveDevice(dtype, workspace.matte.aiDevice)
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

/** 是否可加载：已在内存中、或本地基础文件不全时不可加载（未检测时先放行，失败会给出明确原因） */
function canLoad(row: EngineRow): boolean {
  if (row.state === 'loading' || row.state === 'ready') return false
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
 * Electron 下的应用内下载：RMBG 传 repo id，ISNet 镜像传 imgly=true。
 * 完成后刷新本地文件检测，让「已就位 / 缺失」状态即时更新。
 */
async function download(repoId?: string): Promise<void> {
  if (downloading.value || !window.atlasSlice) return
  downloading.value = true
  downloadOk.value = false
  downloadText.value = repoId ? '下载模型权重…' : '下载 ISNet 镜像…'
  try {
    const result = repoId
      ? await window.atlasSlice.downloadModel({ repo: repoId, host: commandHost.value })
      : await window.atlasSlice.downloadModel({ imgly: true })
    downloadOk.value = result.ok
    downloadText.value = result.message || (result.ok ? '下载完成' : '下载失败')
  } catch (cause) {
    downloadOk.value = false
    downloadText.value = cause instanceof Error ? cause.message : '下载失败'
  } finally {
    downloading.value = false
  }
  await checkLocal()
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
  offProgress = window.atlasSlice?.onDownloadProgress((text) => {
    if (!downloading.value) return
    downloadText.value = text
  }) ?? null
})

onUnmounted(() => {
  offProgress?.()
  offProgress = null
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal w-[min(880px,calc(100vw-48px))]" role="dialog" aria-modal="true" aria-labelledby="model-manager-title">
      <div class="modal-head">
        <div>
          <h2 id="model-manager-title">模型管理</h2>
          <p class="faint">模型下载与内存加载的统一入口；加载期间关闭窗口不会中断下载，重新打开即可看到进度</p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="emit('close')">×</button>
      </div>

      <div class="modal-body flex max-h-[min(72vh,760px)] flex-col gap-3 overflow-y-auto">
        <div class="flex flex-wrap items-center gap-2 border-b border-line pb-3">
          <span class="muted mr-auto text-caption">模型源 <span class="mono">{{ commandHost }}</span></span>
          <button class="btn" :disabled="checking" @click="checkLocal">{{ checking ? '检测中…' : '重新检测本地文件' }}</button>
          <button class="btn" @click="copy(downloadCommand(undefined, commandHost), 'all')">复制全部下载命令</button>
          <span v-if="copied" class="text-caption" :class="copied.ok ? 'text-accent-strong' : 'text-danger'">{{ copied.ok ? '已复制到剪贴板' : '复制失败，请手动选中下方命令' }}</span>
        </div>

        <code v-if="copied && !copied.ok" class="block select-all break-all rounded-sm border border-dashed border-line-strong bg-raised px-2.5 py-2 font-mono text-[11px] text-muted">{{ copied.text }}</code>

        <div v-if="downloading || downloadText" class="flex flex-col gap-1 text-caption">
          <p class="faint m-0" :class="!downloadOk && 'text-danger'">{{ downloadText }}</p>
          <div class="h-1.5 overflow-hidden rounded-[3px] bg-line"><div class="h-full transition-[width] duration-200 ease-[ease]" :class="downloadOk && !downloading ? 'bg-accent-strong' : 'bg-accent'" style="width: 100%"></div></div>
        </div>

        <article v-for="row in rows" :key="row.engine" class="flex flex-col gap-2 rounded-md border border-line bg-raised px-4 py-3">
          <header class="flex flex-wrap items-center gap-3">
            <div class="mr-auto flex items-center gap-2 text-body">
              <strong>{{ row.label }}</strong>
              <span class="badge">{{ row.license }}</span>
              <span class="faint">{{ row.size }}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="badge" :class="row.state === 'ready' ? 'badge-accent' : row.state === 'error' ? 'bg-[rgb(248_113_113/0.14)] text-danger' : ''">{{ modelStateLabel(row.state) }}</span>
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

          <p class="muted m-0 text-caption leading-[1.6]">{{ row.description }} · 加载方式 {{ DTYPE_TEXT[row.dtype] }} · {{ row.device === 'gpu' ? 'GPU / WebGPU' : 'CPU' }}（在「抠图」页或一键处理弹窗中切换）</p>

          <p v-if="row.state === 'error'" class="m-0 text-caption text-danger">{{ errorText(row) }}</p>

          <div v-if="progress[row.engine]" class="flex flex-col gap-1 text-caption">
            <p class="faint m-0">{{ progress[row.engine].text }}</p>
            <div class="h-1.5 overflow-hidden rounded-[3px] bg-line"><div class="h-full bg-accent transition-[width] duration-200 ease-[ease]" :style="{ width: progress[row.engine].percent >= 0 ? progress[row.engine].percent + '%' : '100%' }"></div></div>
          </div>

          <template v-if="row.engine === 'imgly'">
            <div class="flex items-center gap-2 text-caption">
              <span class="mono mr-auto text-muted">{{ IMGLY_MIRROR_PATH }}</span>
              <button v-if="isElectron" class="btn btn-ghost" :disabled="downloading" @click="download()">{{ downloading ? '下载中…' : '直接下载镜像' }}</button>
              <button class="btn btn-ghost" @click="copy(IMGLY_MIRROR_COMMAND, 'imgly-mirror')">复制镜像命令</button>
              <span v-if="copied?.key === 'imgly-mirror'" class="text-caption" :class="copied.ok ? 'text-accent-strong' : 'text-danger'">{{ copied.ok ? '已复制' : '复制失败' }}</span>
            </div>
            <p class="faint m-0 text-caption leading-[1.6]">
              权重来自 IMG.LY 官方 CDN（staticimgly.com）。运行时按「资源地址里填写的地址 → 上面的本地镜像目录 → 官方 CDN」的顺序取资源，
              镜像就位时不会访问 CDN。
              <span class="text-accent-strong">该网址在国内通常需要代理才能访问</span>，没有代理就无法完成首次下载（会提示「无法下载 ISNet 模型资源」）。
            </p>
            <p class="faint m-0 text-caption leading-[1.6]">
              镜像方法：在终端执行 <span class="mono">{{ IMGLY_MIRROR_COMMAND }}</span>（挂在代理下执行一次即可，脚本会跳过已下载且字节数正确的分片，可重复运行）；
              换镜像源可加 <span class="mono">--source=&lt;可访问的地址&gt;</span>，临时验证可加 <span class="mono">--out=&lt;目录&gt;</span>。
            </p>
            <p class="faint m-0 text-caption leading-[1.6]">
              官方 CDN 按「精度 + 推理设备」分别下载权重（切换其中任一项都是另一份文件，需要单独下载一次）；
              镜像命令会把 resources.json 里的全部分片一次性落到本地，之后由 Service Worker 持久缓存，刷新或重启浏览器都不会重新下载。
              但 ONNX 会话本身在页面内存里，刷新后仍需重新加载到内存。imgly 运行时不提供卸载接口。
            </p>
          </template>

          <div v-else-if="row.repo" class="flex flex-col gap-1 border-t border-dashed border-line pt-2">
            <div class="flex items-center gap-2 text-caption">
              <span class="mono mr-auto text-muted">{{ row.repo.id }}</span>
              <span v-if="!checked" class="faint">未检测</span>
              <span v-else-if="row.local?.ready" class="text-accent-strong">基础文件已就位</span>
              <span v-else class="text-danger">缺 {{ row.local?.missing.length ?? 0 }} 个文件</span>
              <button v-if="isElectron" class="btn btn-ghost" :disabled="downloading" @click="download(row.repo.id)">{{ downloading ? '下载中…' : '直接下载' }}</button>
              <button class="btn btn-ghost" @click="copy(downloadCommand(row.repo.id, commandHost), row.repo.id)">复制下载命令</button>
              <span v-if="copied?.key === row.repo.id" class="text-caption" :class="copied.ok ? 'text-accent-strong' : 'text-danger'">{{ copied.ok ? '已复制' : '复制失败' }}</span>
            </div>
            <ul v-if="row.local" class="m-0 flex list-none flex-col gap-0.5 p-0">
              <li v-for="file in row.local.files" :key="file.file" class="flex items-center gap-2 text-[11px]">
                <span class="mono mr-auto text-faint">{{ file.file }}</span>
                <span class="faint">{{ formatBytes(file.size) }}</span>
                <span v-if="file.tier === 'extra'" class="badge">可选精度</span>
                <span :class="file.state === 'ok' ? 'text-accent-strong' : 'text-danger'">{{ fileStateText(file) }}</span>
              </li>
            </ul>
            <p class="faint m-0 text-caption leading-[1.6]">
              <template v-if="row.local?.ready">权重已落在仓库根 models/ 下，刷新页面不会重新下载，只需重新加载到内存。</template>
              <template v-else>浏览器没有文件系统写权限，这些权重必须执行上面的命令下载到 models/ 下（命令会跳过已存在的文件，可重复运行续传）。</template>
              <span v-if="workspace.matte.aiModelHost === 'huggingface.co'" class="text-accent-strong">
                当前托管源 huggingface.co 国内需代理，建议改选 hf-mirror.com（国内可直连）；下载命令已默认使用 hf-mirror.com。
              </span>
            </p>
          </div>
        </article>

        <!-- 本地 Python 服务：运行时与下载器都和上面的浏览器引擎不同，因此单列一张卡片 -->
        <ServerModelCard />
      </div>

      <div class="modal-foot">
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </section>
  </div>
</template>
