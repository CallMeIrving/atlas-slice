/**
 * 图层拆分：本地 Python 服务的唯一业务逻辑出口。
 *
 * 页面与列表组件只调用这里，不直接拼 URL、不直接 fetch：
 * - 服务地址解析（dev 走 Vite 代理 `/layer-api`，构建产物回落到绝对地址）；
 * - 统一错误模型（后端的 `{error:{code,message,detail}}` → `LayerSplitError`）；
 * - `startSplit` 内部即「提交 + 轮询」，把 `stage/stage_progress` 换算成 0-100 交给 `TaskProgress`；
 * - 结果的客户端合并与导出（尊重改名 / 隐藏 / 排序），与服务端 `bundle.zip` 区分开。
 */

import type { LayerCategory, LayerSplitSettings, SplitLayer, SplitLayerBackground } from '@/store/workspace'
import { applyNaming } from './export'
import { loadImage, releaseCanvas } from './image'
import { canvasToBlob, downloadBlob, downloadZip, type ZipEntry } from './media-export'

/** 服务地址的本地存储键：构建产物没有 Vite 代理，页面上的输入框写这里 */
const SERVER_KEY = 'atlas-slice:layer-server'
const DEFAULT_SERVER = 'http://127.0.0.1:8000'
const POLL_MS = 500

// ---------------------------------------------------------------- 类型

export interface ServerHealth {
  status: string
  version: string
  schema: string
  uptime_s: number
  device: string
  models_ready: boolean
  queue_depth: number
}

export interface ServerModelFile {
  file: string
  size: number
  present: boolean
  actual_size: number
}

export interface ServerModel {
  id: string
  role: string
  label: string
  repo_id: string
  dir: string
  installed: boolean
  loaded: boolean
  load_error: string | null
  optional: boolean
  approx_bytes: number
  files: ServerModelFile[]
  missing: string[]
}

export interface ServerModelList {
  models_dir: string
  models: ServerModel[]
  download_command: string
}

export interface ServerStageStat {
  stage: string
  progress: number
  elapsed_ms: number
}

export interface ServerImageInfo {
  name: string
  width: number
  height: number
  scale: number
}

export interface ServerRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ServerLayer {
  id: string
  name: string
  label: string
  category: string
  score: number
  bbox: ServerRect
  alpha_bbox: ServerRect
  area: number
  z: number
  parent_id: string | null
  source: string
  text: string | null
  png_url: string
  png_cropped_url: string
}

export interface ServerBackground {
  id: string
  method: string
  z: number
  png_url: string
}

export interface ServerJob {
  job_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  stage: string
  stage_progress: number
  progress: number
  message: string
  stages: ServerStageStat[]
  image: ServerImageInfo | null
  error: string | null
  elapsed_ms: number
  position: number
  layers?: ServerLayer[] | null
  background?: ServerBackground | null
  counts?: Record<string, number> | null
  warnings: string[]
  manifest_url?: string | null
  zip_url?: string | null
}

export interface ModeToken {
  cancelled: boolean
}

export interface JobHandlers {
  /** 进度回调：percent 0-100（-1 表示该阶段无细化进度） */
  onProgress?: (update: { percent: number; text: string }) => void
  /** 协作式取消令牌：置 cancelled 后下一轮轮询即请求取消 */
  token?: ModeToken
  intervalMs?: number
}

/** 后端统一错误体；`code` 用于分支（如 JOB_NOT_FOUND 表示服务重启过） */
export class LayerSplitError extends Error {
  readonly code: string
  readonly detail: Record<string, unknown>

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'LayerSplitError'
    this.code = code
    this.detail = detail
  }

  /** 后端给的可执行提示（如缺权重时的下载命令） */
  get hint(): string {
    return typeof this.detail.hint === 'string' ? this.detail.hint : ''
  }
}

// ---------------------------------------------------------------- 服务地址

let apiBase = ''

/** 归一化服务地址：去尾斜杠；dev 走相对前缀，构建产物回落到绝对地址 */
function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function detectApiBase(): string {
  // Electron 下始终读主进程给出的动态端口，避免缓存过期（Python 服务可能晚于页面启动）
  if (window.atlasSlice) {
    return normalizeBase(window.atlasSlice.getPythonBaseUrl() || '') || DEFAULT_SERVER
  }
  if (apiBase) return apiBase
  const saved = localStorage.getItem(SERVER_KEY)
  apiBase = normalizeBase(saved || (import.meta.env.DEV ? '/layer-api' : DEFAULT_SERVER)) || DEFAULT_SERVER
  return apiBase
}

/** 当前生效的服务地址（供页面输入框展示） */
export function currentApiBase(): string {
  return detectApiBase()
}

/**
 * Electron 下订阅主进程的 Python 服务状态，供页面在服务就绪时自动重新探活。
 *
 * Python 冷启动（uvicorn 导入 torch）通常晚于页面加载，此时 getPythonBaseUrl() 仍是 null；
 * 且 Electron 里的服务端口是动态挑选的（不是 8000），所以必须等就绪事件到来后再探活。
 * 纯 Web 环境没有主进程，返回一个空的取消订阅函数。
 * @param cb 状态变化回调，参数为服务是否就绪
 * @returns 取消订阅函数
 */
export function onServerStatus(cb: (ready: boolean) => void): () => void {
  if (!window.atlasSlice) return () => {}
  return window.atlasSlice.onPythonStatus((status) => cb(status.ready))
}

/** 覆盖服务地址并持久化；返回归一化后的结果 */
export function setApiBase(value: string): string {
  apiBase = normalizeBase(value) || DEFAULT_SERVER
  localStorage.setItem(SERVER_KEY, apiBase)
  return apiBase
}

/** 拼接接口地址；服务端返回的相对路径（如 `png_url`）也要过这里 */
export function apiUrl(path: string): string {
  const base = detectApiBase()
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

// ---------------------------------------------------------------- 请求

const STAGE_TEXT: Record<string, string> = {
  detect: '检测元素',
  ocr: '识别文本',
  segment: '分割图层',
  refine: '优化边缘',
  zorder: '整理层序',
  background: '重建背景',
  export: '导出产物',
  done: '完成',
}

/** 阶段权重：与后端 `STAGE_WEIGHTS` 一致，用于把阶段进度换算成总体百分比 */
const STAGE_WEIGHTS: [string, number][] = [
  ['detect', 35],
  ['ocr', 10],
  ['segment', 30],
  ['refine', 10],
  ['zorder', 5],
  ['background', 7],
  ['export', 3],
]

/** 阶段 + 阶段内进度 → 0-100；阶段未知（如权重下载）返回 -1，交由调用方退化为整体进度 */
export function stagePercent(stage: string, stageProgress: number): number {
  if (stage === 'done') return 100
  const index = STAGE_WEIGHTS.findIndex(([name]) => name === stage)
  if (index < 0) return -1
  const clamped = Math.min(1, Math.max(0, stageProgress))
  const before = STAGE_WEIGHTS.slice(0, index).reduce((sum, [, weight]) => sum + weight, 0)
  return Math.round(before + STAGE_WEIGHTS[index][1] * clamped)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 解析响应：非 2xx 时把后端错误体转成 `LayerSplitError` */
async function ensureOk(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // 非 JSON 响应（代理 502、进程被 kill 等）走下面的兜底文案
  }
  if (response.ok) return (payload ?? {}) as Record<string, unknown>
  const error = (payload as { error?: { code?: string; message?: string; detail?: Record<string, unknown> } } | null)?.error
  throw new LayerSplitError(
    error?.code ?? `HTTP_${response.status}`,
    error?.message ?? `请求失败（HTTP ${response.status}）`,
    error?.detail ?? {},
  )
}

/** 统一请求入口：网络层失败（服务未启动）也映射成可读错误 */
async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(apiUrl(path), init)
  } catch (error) {
    throw new LayerSplitError('SERVER_UNREACHABLE', `无法连接本地服务 ${detectApiBase()}`, {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  return ensureOk(response)
}

// ---------------------------------------------------------------- 接口

/** 探活：返回设备与权重就绪状态，用于页面顶部的连接提示 */
export async function checkServer(): Promise<ServerHealth> {
  return (await request('/api/health')) as unknown as ServerHealth
}

/** 权重清单（逐文件就位情况），供模型管理卡片展示 */
export async function fetchServerModels(): Promise<ServerModelList> {
  return (await request('/api/models')) as unknown as ServerModelList
}

/** 请求下载权重：复用作业系统，返回终态作业（可用于展示进度） */
export async function requestModelDownload(
  repo: string | null,
  host: string,
  handlers: JobHandlers = {},
): Promise<ServerJob> {
  const accepted = (await request('/api/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, host }),
  })) as { job_id: string }
  return pollJob(accepted.job_id, handlers, false)
}

/** 加载 / 卸载本地权重（预热与释放显存） */
export async function loadServerModel(role: string): Promise<void> {
  await request('/api/models/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
}

export async function unloadServerModel(role: string): Promise<void> {
  await request('/api/models/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
}

/** 轮询作业到终态；失败/取消抛 `LayerSplitError`（code 分别为 JOB_FAILED / JOB_CANCELLED） */
async function pollJob(jobId: string, handlers: JobHandlers, stageDriven = true): Promise<ServerJob> {
  const interval = handlers.intervalMs ?? POLL_MS
  for (;;) {
    if (handlers.token?.cancelled) {
      await cancelSplit(jobId)
      throw new LayerSplitError('JOB_CANCELLED', '已取消')
    }
    const job = (await request(`/api/layers/jobs/${jobId}`)) as unknown as ServerJob
    if (job.status === 'succeeded') return job
    if (job.status === 'failed') throw new LayerSplitError('JOB_FAILED', job.error || '拆分失败')
    if (job.status === 'cancelled') throw new LayerSplitError('JOB_CANCELLED', '已取消')

    if (handlers.onProgress) {
      const mapped = stageDriven ? stagePercent(job.stage, job.stage_progress) : -1
      const percent = mapped >= 0 ? mapped : Math.round((job.progress ?? 0) * 100)
      const text = job.message || STAGE_TEXT[job.stage] || (job.status === 'queued' ? '排队中' : '处理中')
      handlers.onProgress({ percent: job.status === 'queued' && mapped < 0 ? 0 : percent, text })
    }
    await sleep(interval)
  }
}

/** 界面设置 → 后端参数（camelCase → snake_case，并剔除未启用的类别） */
export function toServerParams(settings: LayerSplitSettings, overrideBoxes?: UserBox[]): Record<string, unknown> {
  const params: Record<string, unknown> = {
    classes: settings.classes
      .filter((item) => item.enabled !== false)
      .map((item) => ({ label: item.label, prompt: item.prompt, category: item.category })),
    detector: settings.detector,
    segmenter: settings.segmenter,
    ocr: settings.ocr,
    box_threshold: settings.boxThreshold,
    text_threshold: settings.textThreshold,
    nms_iou: settings.nmsIou,
    min_area: settings.minArea,
    max_layers: settings.maxLayers,
    max_side: settings.maxSide,
    background: settings.background,
    exclusive_layers: settings.exclusiveLayers,
    feather: settings.feather,
    device: settings.device,
  }
  if (overrideBoxes && overrideBoxes.length) {
    params.override_boxes = overrideBoxes
  }
  return params
}

/** 用户框选区域（图像像素坐标） */
export interface UserBox {
  x: number
  y: number
  w: number
  h: number
  label: string
  category: string
}

/** 检测端点返回的单个框 */
export interface DetectBox {
  x: number
  y: number
  w: number
  h: number
  label: string
  category: string
  score: number
}

/** 检测端点返回 */
export interface DetectResult {
  boxes: DetectBox[]
  width: number
  height: number
  scale: number
  warnings: string[]
}

/** 仅检测（不分割），供前端预检和编辑框选 */
export async function detectBoxes(
  image: Blob,
  fileName: string,
  settings: LayerSplitSettings,
): Promise<DetectResult> {
  const form = new FormData()
  form.append('file', image, fileName || 'image.png')
  form.append('params', JSON.stringify(toServerParams(settings)))
  return (await request('/api/layers/detect', { method: 'POST', body: form })) as unknown as DetectResult
}

/** 提交拆分并轮询到终态 */
export async function startSplit(
  image: Blob,
  fileName: string,
  settings: LayerSplitSettings,
  handlers: JobHandlers = {},
  overrideBoxes?: UserBox[],
): Promise<ServerJob> {
  const form = new FormData()
  form.append('file', image, fileName || 'image.png')
  form.append('params', JSON.stringify(toServerParams(settings, overrideBoxes)))
  const accepted = (await request('/api/layers/split', { method: 'POST', body: form })) as { job_id: string }
  return pollJob(accepted.job_id, handlers)
}

/** 请求取消（协作式：作业线程在阶段与元素之间检查标志） */
export async function cancelSplit(jobId: string): Promise<void> {
  await request(`/api/layers/jobs/${jobId}`, { method: 'DELETE' })
}

/** 服务端图层 PNG 地址；`full` 时补成原图尺寸（默认给 alpha_bbox 裁切的小图） */
export function layerPngUrl(jobId: string, layerId: string, full = false): string {
  return apiUrl(`/api/layers/jobs/${jobId}/layers/${layerId}.png${full ? '?canvas=full' : ''}`)
}

/** 服务端整包地址（原样 label，含 atlas.json） */
export function bundleZipUrl(jobId: string): string {
  return apiUrl(`/api/layers/jobs/${jobId}/bundle.zip`)
}

// ---------------------------------------------------------------- 数据映射

/** 把轮询结果映射成列表状态；列表按 z 降序（从上到下 = 前景到背景） */
export function mapJobToLayers(job: ServerJob): { layers: SplitLayer[]; background: SplitLayerBackground | null } {
  const layers = (job.layers ?? [])
    .map((layer): SplitLayer => ({
      id: layer.id,
      name: layer.name,
      label: layer.label,
      category: layer.category as LayerCategory,
      score: layer.score,
      bbox: { ...layer.bbox },
      alphaBbox: { ...layer.alpha_bbox },
      area: layer.area,
      z: layer.z,
      parentId: layer.parent_id,
      source: layer.source,
      text: layer.text,
      pngUrl: apiUrl(layer.png_url),
      visible: true,
      merged: false,
    }))
    .sort((a, b) => b.z - a.z)

  const background: SplitLayerBackground | null = job.background
    ? { id: job.background.id, method: job.background.method, pngUrl: apiUrl(job.background.png_url), visible: false }
    : null
  return { layers, background }
}

/** 重排后按显示顺序（降序）重算 z：最上面一层的 z 最大 */
function reindex(layers: SplitLayer[]): SplitLayer[] {
  const total = layers.length
  return layers.map((layer, index) => ({ ...layer, z: total - index }))
}

/** 拖拽换序：把 fromId 移到 toIndex，随后重算 z */
export function moveLayer(layers: SplitLayer[], fromId: string, toIndex: number): SplitLayer[] {
  const from = layers.findIndex((layer) => layer.id === fromId)
  if (from < 0) return layers
  const next = [...layers]
  const [moved] = next.splice(from, 1)
  next.splice(Math.min(Math.max(toIndex, 0), next.length), 0, moved)
  return reindex(next)
}

/** 置顶 / 置底 */
export function raiseLayer(layers: SplitLayer[], id: string, toTop: boolean): SplitLayer[] {
  return moveLayer(layers, id, toTop ? 0 : layers.length)
}

// ---------------------------------------------------------------- 合并 / 导出

/**
 * 把选中图层合并成一张与原图同尺寸的图（按 z 升序 = 从后到前叠加）。
 * 返回可直接给 `<img>` 用的 blob URL；调用方负责在作废时 revoke。
 *
 * 图层先取成 blob 再解码：服务端 PNG 在构建产物里是跨源地址，
 * 直接 drawImage 会污染画布导致 toBlob 抛 SecurityError。
 */
export async function mergeLayers(layers: SplitLayer[], size: { width: number; height: number }): Promise<string> {
  const ordered = [...layers].sort((a, b) => a.z - b.z)
  if (!ordered.length) throw new Error('没有可合并的图层')
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')!
  const temporary: string[] = []
  try {
    for (const layer of ordered) {
      const url = URL.createObjectURL(await fetchBlob(layer.pngUrl))
      temporary.push(url)
      const image = await loadImage(url, `图层「${layer.name}」加载失败`)
      ctx.drawImage(image, layer.alphaBbox.x, layer.alphaBbox.y)
    }
    const blob = await canvasToBlob(canvas)
    return URL.createObjectURL(blob)
  } finally {
    temporary.forEach((url) => URL.revokeObjectURL(url))
    releaseCanvas(canvas)
  }
}

/** 客户端清单：与服务端 layers.json 同构，导出 ZIP 时一并写入 */
export function buildLayersManifest(
  layers: SplitLayer[],
  source: { name: string; width: number; height: number },
): Record<string, unknown> {
  const ordered = [...layers].sort((a, b) => a.z - b.z)
  const counts: Record<string, number> = {}
  const entries = ordered.map((layer, index) => {
    counts[layer.category] = (counts[layer.category] ?? 0) + 1
    return {
      id: layer.id,
      name: layer.name,
      label: layer.label,
      category: layer.category,
      score: layer.score,
      bbox: { ...layer.bbox },
      alpha_bbox: { ...layer.alphaBbox },
      area: layer.area,
      z: layer.z,
      parent_id: layer.parentId,
      source: layer.source,
      text: layer.text,
      rotation: 0,
      file: fileNameFor(layer, index),
    }
  })
  return {
    schema: 'atlas-slice.layers/1',
    source,
    layers: entries,
    counts,
    warnings: [],
  }
}

/** 导出文件名：沿用 export.ts 的命名模板，序号按 z 升序（最底层为 0001） */
function fileNameFor(layer: SplitLayer, index: number): string {
  return ensurePng(applyNaming('{index}_{name}', layer.name, index + 1))
}

function ensurePng(name: string): string {
  return /\.png$/i.test(name) ? name : `${name}.png`
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`读取图层失败（HTTP ${response.status}）`)
  return response.blob()
}

/** 下载单个图层 PNG（默认用列表里显示的名字） */
export async function downloadLayerPng(layer: SplitLayer): Promise<void> {
  const blob = await fetchBlob(layer.pngUrl)
  const name = layer.merged ? layer.name : fileNameFor(layer, layer.z - 1)
  downloadBlob(blob, ensurePng(name))
}

/**
 * 客户端导出 ZIP：尊重改名 / 隐藏 / 排序 / 合并，并带上 source.png 与服务端整包同构。
 * 服务端 `bundle.zip` 是另一条路径（原样 label、含 atlas.json），两者刻意分开。
 */
export async function exportLayersZip(
  layers: SplitLayer[],
  source: { name: string; width: number; height: number; url: string },
): Promise<void> {
  const visible = [...layers].filter((layer) => layer.visible).sort((a, b) => a.z - b.z)
  if (!visible.length) throw new Error('没有可导出的图层')
  const entries: ZipEntry[] = []
  for (let index = 0; index < visible.length; index++) {
    const layer = visible[index]
    const name = layer.merged ? ensurePng(layer.name) : fileNameFor(layer, index)
    entries.push({ name: `layers/${name}`, blob: await fetchBlob(layer.pngUrl) })
  }
  entries.push({ name: 'source.png', blob: await fetchBlob(source.url) })
  entries.push({
    name: 'layers.json',
    blob: JSON.stringify(buildLayersManifest(layers, { name: source.name, width: source.width, height: source.height }), null, 2),
  })
  const base = source.name.replace(/\.[^.]+$/, '') || 'layers'
  await downloadZip(entries, `${base}-layers.zip`)
}