<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { formatBytes } from '@/core/model-registry'
import {
  checkServer,
  fetchServerModels,
  loadServerModel,
  onServerStatus,
  requestModelDownload,
  unloadServerModel,
  type ServerModel,
  type ServerModelList,
} from '@/core/layer-split'
import { workspace } from '@/store/workspace'

/**
 * 模型管理弹窗里的「本地 Python 服务」卡片。
 *
 * 这组权重与浏览器里的 ONNX 权重是两套东西：不同运行时（本机 PyTorch/MPS vs 浏览器 wasm）、
 * 不同下载器（snapshot_download vs 下载脚本）、不同设备语义（服务启动参数 vs WebGPU 支持），
 * 因此单独一张卡片，而不是塞进 model-registry.json。
 * 权重落在仓库根 models/ 下（与浏览器抠图权重同目录），由本地 Python 服务按需下载。
 */
const list = ref<ServerModelList | null>(null)
const online = ref(false)
const device = ref('')
/** 是否已完成过一次连接尝试：未尝试前不显示「未连接」的红色状态 */
const checked = ref(false)
const checking = ref(false)
const error = ref('')
/** 正在加载/卸载的 role */
const busy = ref('')
/** 正在下载权重的 role 与进度文本 */
const downloading = ref('')
const downloadText = ref('')
const downloadPercent = ref(-1)
/** 复制反馈：失败时保留命令原文供手动选中 */
const copied = ref<{ key: string; ok: boolean; text: string } | null>(null)
/** Electron 下主进程服务状态的取消订阅函数 */
let offServerStatus: (() => void) | null = null

/** 与弹窗顶部的「模型源」保持一致：服务端 snapshot_download 走同一个镜像 */
const host = computed(() => (workspace.matte.aiModelHost === 'huggingface.co' ? 'https://huggingface.co' : 'https://hf-mirror.com'))

async function refresh(): Promise<void> {
  checking.value = true
  error.value = ''
  try {
    const health = await checkServer()
    online.value = true
    device.value = health.device
    list.value = await fetchServerModels()
  } catch (cause) {
    online.value = false
    device.value = ''
    list.value = null
    error.value = cause instanceof Error ? cause.message : '无法连接本地服务'
  } finally {
    checked.value = true
    checking.value = false
  }
}

/** 加载 / 卸载：权重常驻内存会占 1-2GB，不拆分时应主动释放 */
async function toggleLoad(model: ServerModel): Promise<void> {
  busy.value = model.role
  error.value = ''
  try {
    if (model.loaded) await unloadServerModel(model.role)
    else await loadServerModel(model.role)
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '模型加载失败'
  } finally {
    busy.value = ''
  }
}

/** 下载权重：复用服务端作业系统，进度按整体百分比展示 */
async function downloadModel(model: ServerModel): Promise<void> {
  if (downloading.value) return
  downloading.value = model.role
  downloadText.value = `正在下载 ${model.label}…`
  downloadPercent.value = 0
  error.value = ''
  try {
    await requestModelDownload(model.repo_id, host.value, {
      onProgress: (update) => {
        downloadText.value = update.text
        downloadPercent.value = update.percent
      },
    })
    await refresh()
    downloadText.value = `${model.label} 下载完成`
    downloadPercent.value = 100
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '权重下载失败'
    downloadText.value = ''
  } finally {
    downloading.value = ''
  }
}

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

onMounted(() => {
  void refresh()
  // Electron 下服务由主进程拉起，冷启动晚于弹窗打开：就绪后自动刷新，无需手动重试
  offServerStatus = onServerStatus((ready) => {
    if (ready) void refresh()
  })
})

onUnmounted(() => {
  offServerStatus?.()
  offServerStatus = null
})
</script>

<template>
  <article class="flex flex-col gap-2 rounded-md border border-line bg-raised px-4 py-3">
    <header class="flex flex-wrap items-center gap-3">
      <div class="mr-auto flex items-center gap-2 text-body">
        <strong>本地 Python 服务</strong>
        <span class="badge">本机推理</span>
        <span class="faint">约 1.5GB（含 OCR 约 2.0GB）</span>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="!checked" class="badge">未检测</span>
        <span v-else class="badge" :class="online ? 'badge-accent' : 'bg-[rgb(248_113_113/0.14)] text-danger'">
          {{ online ? `已连接 · ${device || '设备未知'}` : '服务未连接' }}
        </span>
        <button class="btn" :disabled="checking" @click="refresh">{{ checking ? '检测中…' : '重新检测' }}</button>
      </div>
    </header>

    <p class="muted m-0 text-caption leading-[1.6]">
      GroundingDINO（开放词表检测）+ SAM（框驱动分割），可选 Florence-2 识别文本。
      这组权重由本地 Python 服务用 PyTorch 推理，<strong>统一落在仓库根 models/ 下</strong>，不经过浏览器；
      服务只监听 127.0.0.1，素材不出本机。
    </p>
    <p v-if="checked && !online" class="faint m-0 text-caption leading-[1.6]">
      先按 backend/README.md 建好虚拟环境与依赖，再启动服务：<span class="mono">npm run backend:dev</span>
    </p>
    <p v-if="error" class="m-0 text-caption text-danger">{{ error }}</p>

    <div v-if="downloading || downloadText" class="flex flex-col gap-1 text-caption">
      <p class="faint m-0">{{ downloadText }}</p>
      <div class="h-1.5 overflow-hidden rounded-[3px] bg-line">
        <div class="h-full bg-accent transition-[width] duration-200 ease-[ease]" :style="{ width: downloadPercent >= 0 ? downloadPercent + '%' : '100%' }"></div>
      </div>
    </div>

    <div v-if="list" class="flex flex-col gap-1 border-t border-dashed border-line pt-2">
      <div class="flex flex-wrap items-center gap-2 text-caption">
        <span class="mono mr-auto text-muted">{{ list.models_dir }}</span>
        <button class="btn btn-ghost" @click="copy(list.download_command, 'all')">复制下载命令</button>
        <span v-if="copied?.key === 'all'" class="text-caption" :class="copied.ok ? 'text-accent-strong' : 'text-danger'">
          {{ copied.ok ? '已复制' : '复制失败' }}
        </span>
      </div>

      <div v-for="model in list.models" :key="model.id" class="server-model flex flex-col gap-1 pt-2 [&+.server-model]:mt-2 [&+.server-model]:border-t [&+.server-model]:border-dashed [&+.server-model]:border-line">
        <div class="flex flex-wrap items-center gap-2 text-caption">
          <span class="mono mr-auto text-muted">{{ model.label }} · {{ model.role }}</span>
          <span v-if="model.installed" class="text-accent-strong">权重已就位</span>
          <span v-else class="text-danger">缺 {{ model.missing.length }} 个文件</span>
          <span v-if="model.optional" class="badge">可选</span>
          <span v-if="model.loaded" class="text-accent-strong">已在内存</span>
          <button class="btn btn-ghost" :disabled="!!busy || !model.installed" @click="toggleLoad(model)">
            {{ busy === model.role ? '处理中…' : model.loaded ? '卸载' : '加载到内存' }}
          </button>
          <button class="btn btn-ghost" :disabled="!!downloading || !online" @click="downloadModel(model)">
            {{ downloading === model.role ? '下载中…' : '下载权重' }}
          </button>
        </div>
        <p v-if="model.load_error" class="m-0 text-caption text-danger">{{ model.load_error }}</p>
        <p class="faint m-0 text-caption leading-[1.6]">
          提示：SAM 的权重缺失时，拆分仍然可用，但只能拿到检测框的矩形，边缘不会贴合元素。
        </p>
        <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
          <li v-for="file in model.files" :key="file.file" class="flex items-center gap-2 text-[11px]">
            <span class="mono mr-auto break-all text-faint">{{ file.file }}</span>
            <span class="faint">{{ formatBytes(file.size) }}</span>
            <span :class="file.present ? 'text-accent-strong' : 'text-danger'">
              {{ file.present ? '已就位' : '缺失' }}
            </span>
          </li>
        </ul>
      </div>
    </div>

    <code v-if="copied && !copied.ok" class="block select-all break-all rounded-sm border border-dashed border-line-strong bg-raised px-2.5 py-2 font-mono text-[11px] text-muted">{{ copied.text }}</code>
  </article>
</template>
