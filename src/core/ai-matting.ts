/**
 * AI 抠图引擎统一封装。
 *
 * 支持的引擎：
 * - imgly     : @imgly/background-removal（ISNet，MIT 可商用）
 * - birefnet  : transformers.js + BiRefNet_lite-ONNX（MIT 可商用，质量高）
 * - rmbg      : transformers.js + BRIA RMBG-1.4（效果顶尖，⚠️不可商用）
 *
 * 所有引擎输入图像源（HTMLImageElement / HTMLCanvasElement），输出透明 PNG Blob。
 * 引擎内部均为动态 import，避免主包体积膨胀。
 */

import { releaseCanvas } from '@/core/image'
import { LOCAL_MODEL_ROOT, localRepoPath } from '@/core/model-registry'

export interface MatteProgress {
  phase: 'loading' | 'processing'
  text: string
  /** 0-100，无法计算进度时为 undefined */
  percent?: number
}

/**
 * AI 推理的最长边上限。
 * onnxruntime-web 的 wasm 堆有固定上限，超出后分配激活值会直接抛
 * `failed to call OrtRun(). ERROR_CODE: 6, std::bad_alloc`（与机器物理内存无关）。
 * 大图按原尺寸推理必然触发，因此所有引擎统一在该上限内推理，结果再放大回原尺寸。
 */
export const AI_MAX_SIDE_LIMIT = 1024

/**
 * 把界面上的「最大边长」收敛成实际推理用的最长边。
 * 0 或未配置都表示「自动」，即使用 AI_MAX_SIDE_LIMIT——而不是原图尺寸，
 * 否则一张 3000×2000 的图就会把 wasm 堆撑爆。
 * @param configured 界面配置值（0 表示自动）
 * @returns 实际用于推理的像素上限，必定大于 0
 */
export function resolveInferenceMaxSide(configured?: number): number {
  return configured && configured > 0 ? Math.min(configured, AI_MAX_SIDE_LIMIT) : AI_MAX_SIDE_LIMIT
}

export interface AiEngineBaseOptions {
  /** 处理前最大边长像素；0 或未配置 = 自动（收敛到 {@link AI_MAX_SIDE_LIMIT}） */
  maxSide?: number
  onProgress?: (progress: MatteProgress) => void
}

export interface ImglyOptions extends AiEngineBaseOptions {
  model: ImglyModel
  device: 'cpu' | 'gpu'
  /** 模型资源基础地址，留空使用官方 CDN（staticimgly.com） */
  publicPath?: string
}

export interface TransformersOptions extends AiEngineBaseOptions {
  modelId: string
  /** q8 = 量化版（体积小、速度快）；fp16 = 半精度（体积减半、内存友好）；fp32 = 高精度 */
  dtype: 'q8' | 'fp16' | 'fp32'
  device: 'cpu' | 'gpu'
  /** 模型托管源，国内网络可用 hf-mirror.com 镜像 */
  modelHost: 'huggingface.co' | 'hf-mirror.com'
}

/** 界面使用的设备名 → transformers.js 4.x 实际设备名 */
function mapDevice(device: 'cpu' | 'gpu'): 'wasm' | 'webgpu' {
  return device === 'gpu' ? 'webgpu' : 'wasm'
}

export interface AiMattingResult {
  blob: Blob
}

export type AiEngine = 'imgly' | 'birefnet' | 'rmbg'

/** 模型托管源 → transformers.js 的 remoteHost。
 *  dev 环境 hf-mirror 走 vite 代理同源转发（/hf-mirror2），规避浏览器直连外网限制；
 *  生产环境直连镜像。 */
function modelHostUrl(modelHost: 'huggingface.co' | 'hf-mirror.com'): string {
  if (modelHost === 'huggingface.co') return 'https://huggingface.co/'
  // dev 环境走 vite 代理（绝对 URL，transformers.js 内部用 isValidUrl 校验，相对路径会被跳过）
  if (import.meta.env.DEV) return `${location.origin}/hf-mirror2/`
  return 'https://hf-mirror.com/'
}

export interface EngineMeta {
  key: AiEngine
  label: string
  license: string
  size: string
  description: string
}

/** 引擎元信息，供界面"模型状态"区展示 */
export const AI_ENGINES: EngineMeta[] = [
  { key: 'imgly', label: 'ISNet（imgly）', license: '免费可用', size: '约 30-170MB', description: '速度快，通用背景分离' },
  { key: 'birefnet', label: 'BiRefNet', license: 'MIT 可商用', size: '约 115MB（FP16）', description: '分割质量高，但浏览器内跑不起来（见下方说明）' },
  { key: 'rmbg', label: 'RMBG-1.4（BRIA）', license: '⚠️不可商用', size: '约 44-176MB（Q8-FP32）', description: '效果顶尖，注意许可限制' },
]

/** 界面上的模型精度：fp32 / fp16 为非量化权重，q8 为 int8 量化权重 */
export type MatteDtype = 'q8' | 'fp16' | 'fp32'

/** 界面上的推理设备：cpu 走 wasm，gpu 走 WebGPU */
export type MatteDevice = 'cpu' | 'gpu'

/** imgly（ISNet）的精度由 model 参数决定，没有独立的 dtype 通道 */
export type ImglyModel = 'isnet' | 'isnet_fp16' | 'isnet_quint8'

export interface MatteOption<T> {
  value: T
  label: string
}

const DTYPE_OPTIONS: MatteOption<MatteDtype>[] = [
  { value: 'fp16', label: 'FP16（推荐）' },
  { value: 'q8', label: 'Q8（体积小、速度快）' },
  { value: 'fp32', label: 'FP32（精度最高）' },
]

const DEVICE_OPTIONS: MatteOption<MatteDevice>[] = [
  { value: 'cpu', label: 'CPU（兼容性最好）' },
  { value: 'gpu', label: 'GPU / WebGPU（需浏览器支持）' },
]

/**
 * 推理分辨率（最大边长）选项，抠图页各引擎共用。
 * 刻意不提供「原图尺寸」：原尺寸推理会撑爆 wasm 堆并抛 std::bad_alloc，
 * 0 统一表示「自动」，展示文案也必须与实际行为一致。
 */
export const AI_MAX_SIDE_OPTIONS: MatteOption<number>[] = [
  { value: 0, label: `自动（最长边 ${AI_MAX_SIDE_LIMIT}px）` },
  { value: 1024, label: '1024px' },
  { value: 768, label: '768px' },
  { value: 512, label: '512px（最快）' },
]

/**
 * 各引擎实际提供的权重精度与 WebGPU 能力，与 README「抠图模型下载」一致：
 * - imgly（ISNet）三个精度齐全，由 @imgly/background-removal 按 model 参数选择；
 * - birefnet（onnx-community/BiRefNet_lite-ONNX）只有 model.onnx / model_fp16.onnx，没有量化权重；
 * - rmbg（briaai/RMBG-1.4）提供 model_quantized.onnx，三个精度齐全。
 * 未列出的精度就是该模型不具备的能力，界面不应提供。
 */
const ENGINE_DTYPES: Record<AiEngine, MatteDtype[]> = {
  imgly: ['fp16', 'q8', 'fp32'],
  birefnet: ['fp16', 'fp32'],
  rmbg: ['fp16', 'q8', 'fp32'],
}

/** 精度 → imgly 模型参数的映射，让界面精度在 ISNet 上真正生效 */
const IMGLY_MODEL_BY_DTYPE: Record<MatteDtype, ImglyModel> = { fp16: 'isnet_fp16', q8: 'isnet_quint8', fp32: 'isnet' }
const IMGLY_DTYPE_BY_MODEL: Record<ImglyModel, MatteDtype> = { isnet_fp16: 'fp16', isnet_quint8: 'q8', isnet: 'fp32' }

/** imgly 模型参数 → 界面精度 */
export function imglyDtypeForModel(model: ImglyModel): MatteDtype {
  return IMGLY_DTYPE_BY_MODEL[model]
}

/** 界面精度 → imgly 模型参数 */
export function imglyModelForDtype(dtype: MatteDtype): ImglyModel {
  return IMGLY_MODEL_BY_DTYPE[dtype]
}

/** 浏览器是否支持 WebGPU；无此能力时 GPU 选项不显示 */
export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/** 某引擎可用的精度选项（模型没有的精度不会出现） */
export function dtypeOptions(engine: AiEngine): MatteOption<MatteDtype>[] {
  const available = ENGINE_DTYPES[engine]
  return DTYPE_OPTIONS.filter((option) => available.includes(option.value))
}

/**
 * 指定精度下可用的设备选项。
 * GPU（WebGPU）要求浏览器支持，且权重不能被量化——量化权重的 int8 算子在后端跑不起来，
 * 所以 Q8 精度下只保留 CPU。
 */
export function deviceOptions(dtype: MatteDtype): MatteOption<MatteDevice>[] {
  if (!hasWebGpu() || dtype === 'q8') return DEVICE_OPTIONS.filter((option) => option.value === 'cpu')
  return DEVICE_OPTIONS
}

/** 把精度收敛到引擎支持的取值；不支持时回退到该引擎的首个可用精度 */
export function resolveDtype(engine: AiEngine, dtype: MatteDtype): MatteDtype {
  return ENGINE_DTYPES[engine].includes(dtype) ? dtype : ENGINE_DTYPES[engine][0]
}

/** 把设备收敛到当前精度支持的取值；GPU 不可用时回退 CPU */
export function resolveDevice(dtype: MatteDtype, device: MatteDevice): MatteDevice {
  return deviceOptions(dtype).some((option) => option.value === device) ? device : 'cpu'
}

/**
 * 已知在浏览器里跑不起来的「引擎 + 设备」组合及其确切原因。
 *
 * BiRefNet_lite（onnx-community）实测结论：
 * - 它的 ONNX 图把输入写死成 1024×1024（图上是静态维度），改小输入会直接报
 *   `Got: 512 Expected: 1024`，所以界面上的「最大边长」对它完全无效；
 * - 在该分辨率下 wasm(CPU) 推理需要 3.6GB 以上的 wasm 堆，而 wasm32 上限是 4GB，
 *   实测跑到 3629MB 后抛 `std::bad_alloc`——单张图也一样，与机器物理内存无关；
 * - 换 WebGPU 也不行：模型需要 11 个 storage buffer，超过浏览器给的上限 10。
 * 提前拦下可以避免白跑 25 秒、并避免 wasm 堆被破坏（堆一旦分配失败就再也用不了，
 * 之后连 RMBG / ISNet 都会跟着失败，必须刷新页面才能恢复）。
 * @param engine AI 引擎标识
 * @param device 目标推理设备
 * @returns 原因文案；可用时返回 null
 */
function unsupportedEngineReason(engine: AiEngine, device: MatteDevice): string | null {
  if (engine !== 'birefnet') return null
  return device === 'gpu'
    ? 'BiRefNet 在浏览器里跑不起来：它需要 11 个 storage buffer，超过 WebGPU 上限 10。请改用 ISNet（imgly）或 RMBG-1.4。'
    : 'BiRefNet 在浏览器里跑不起来：它的输入被固定为 1024×1024，需要 3.6GB 以上的 wasm 堆（wasm32 上限 4GB），单张图也会内存不足，且「最大边长」对它无效。请改用 ISNet（imgly）或 RMBG-1.4。'
}

/**
 * 按模型 ID 做能力预检：项目内置的 BiRefNet 权重在当前浏览器跑不起来。
 * 内置权重用「模型 ID → 本地路径」的映射还原引擎，非内置模型（用户自己填的仓库）不做拦截。
 * @param modelId 模型 ID 或本地路径
 * @param device 目标推理设备
 * @returns 不可用原因；可用时返回 null
 */
export function modelBlockReason(modelId: string, device: MatteDevice): string | null {
  const localPath = localRepoPath(modelId)
  if (!localPath) return null
  return unsupportedEngineReason(localPath.includes('BiRefNet') ? 'birefnet' : 'rmbg', device)
}

type CanvasSource = HTMLImageElement | HTMLCanvasElement

/** transformers.js 的 pipeline：可调用，且能通过 dispose 释放底层 ONNX 会话 */
type TransformerPipeline = ((input: unknown) => Promise<unknown>) & { dispose?: () => Promise<void> }

interface RawImageLike {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  channels: number
}

interface TransformerPipelineEntry {
  pipeline: TransformerPipeline
  /** 记录会话所属引擎，「卸载」时才能精确释放指定模型而不影响其它已加载模型 */
  engine: AiEngine
}

const transformerPipelineCache = new Map<string, TransformerPipelineEntry>()
const transformerPipelineLoading = new Map<string, Promise<TransformerPipelineEntry>>()

/** 把图像源绘制到画布；maxSide > 0 时等比降采样以节省显存/算力 */
export function sourceToCanvas(source: CanvasSource, maxSide = 0): HTMLCanvasElement {
  const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width
  const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height
  let targetW = width
  let targetH = height
  if (maxSide > 0 && Math.max(width, height) > maxSide) {
    const scale = maxSide / Math.max(width, height)
    targetW = Math.max(1, Math.round(width * scale))
    targetH = Math.max(1, Math.round(height * scale))
  }
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  canvas.getContext('2d')!.drawImage(source, 0, 0, targetW, targetH)
  return canvas
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画布转 PNG 失败'))), 'image/png')
  })
}

/**
 * transformers.js 的 RawImage → 画布。
 * RGBA 输出直接在同一段内存上建视图（零拷贝），避免每次推理再复制一份
 * 宽×高×4 的缓冲；只有通道数不足 4 时才逐像素补齐。
 */
function rawImageToCanvas(image: RawImageLike): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const pixelCount = image.width * image.height
  if (image.channels === 4 && image.data.length === pixelCount * 4) {
    const rgba = image.data instanceof Uint8ClampedArray
      ? image.data
      : new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length)
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, image.width, image.height), 0, 0)
    return canvas
  }
  const rgba = new Uint8ClampedArray(pixelCount * 4)
  for (let index = 0; index < pixelCount; index += 1) {
    const sourceOffset = index * image.channels
    const targetOffset = index * 4
    rgba[targetOffset] = image.data[sourceOffset] ?? 0
    rgba[targetOffset + 1] = image.data[sourceOffset + 1] ?? rgba[targetOffset]
    rgba[targetOffset + 2] = image.data[sourceOffset + 2] ?? rgba[targetOffset]
    rgba[targetOffset + 3] = image.channels >= 4 ? (image.data[sourceOffset + 3] ?? 255) : 255
  }
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, image.width, image.height), 0, 0)
  return canvas
}

/**
 * 把单通道蒙版作为 alpha 合成进源画布，并就地返回源画布。
 * 直接复用源画布自身的 ImageData，不再额外创建「蒙版画布 + 缩放画布 + 结果画布」，
 * 单次推理的峰值缓冲从 4 份降到 1 份。
 * @param sourceCanvas 待合成的画布（会被就地修改，调用方需确认它只是临时画布）
 * @param mask 单通道蒙版数据
 * @param maskWidth 蒙版宽
 * @param maskHeight 蒙版高
 * @param channels 蒙版每像素通道数（通常为 1）
 */
function applyMaskToCanvas(
  sourceCanvas: HTMLCanvasElement,
  mask: Uint8Array | Uint8ClampedArray,
  maskWidth: number,
  maskHeight: number,
  channels: number,
): HTMLCanvasElement {
  const width = sourceCanvas.width
  const height = sourceCanvas.height
  const ctx = sourceCanvas.getContext('2d')!
  const imageData = ctx.getImageData(0, 0, width, height)
  const pixels = imageData.data
  if (maskWidth === width && maskHeight === height) {
    for (let i = 0; i < width * height; i += 1) pixels[i * 4 + 3] = mask[i * channels]
  } else {
    // 蒙版尺寸与输入不一致时按最近邻换算，避免再分配一张同尺寸画布
    for (let y = 0; y < height; y += 1) {
      const maskY = Math.min(maskHeight - 1, Math.floor((y * maskHeight) / height))
      for (let x = 0; x < width; x += 1) {
        const maskX = Math.min(maskWidth - 1, Math.floor((x * maskWidth) / width))
        pixels[(y * width + x) * 4 + 3] = mask[(maskY * maskWidth + maskX) * channels]
      }
    }
  }
  ctx.putImageData(imageData, 0, 0)
  return sourceCanvas
}

/** transformers.js 下载进度回调结构 */
interface TransformersProgress {
  status: string
  progress?: number
  file?: string
  loaded?: number
  total?: number
}

function transformersProgress(onProgress?: (progress: MatteProgress) => void) {
  return (info: TransformersProgress) => {
    if (!onProgress) return
    if (info.status === 'progress' || info.status === 'download') {
      onProgress({ phase: 'loading', text: info.file ? `下载 ${info.file}…` : '下载模型…', percent: info.progress != null ? Math.round(info.progress) : undefined })
    } else if (info.status === 'ready') {
      onProgress({ phase: 'loading', text: '模型就绪', percent: 100 })
    }
  }
}

function transformerCacheKey(options: Pick<TransformersOptions, 'modelId' | 'dtype' | 'device' | 'modelHost'>): string {
  return `${options.modelId}|${options.dtype}|${options.device}|${options.modelHost}`
}

/** 释放 pipeline 的底层 ONNX 会话。只把实例从缓存 Map 里删掉并不会归还 wasm 堆内存 */
async function disposePipeline(pipeline: TransformerPipeline | undefined): Promise<void> {
  try {
    await pipeline?.dispose?.()
  } catch (error) {
    console.warn('[抠图] 释放模型会话失败', error)
  }
}

/**
 * 从模型 ID 推断 transformers.js 引擎归属：内置 BiRefNet 权重归 birefnet，其余归 rmbg。
 * 与 {@link modelBlockReason} 使用同一套判定，保证「拦截」和「释放」指向同一个引擎。
 */
function engineForModelId(modelId: string): AiEngine {
  return localRepoPath(modelId)?.includes('BiRefNet') ? 'birefnet' : 'rmbg'
}

/**
 * 释放除 keepKey 之外的所有已初始化 ONNX 会话。
 * 所有 transformers pipeline 共用同一份 onnxruntime 的 wasm 堆，任何时刻只允许一个会话存活：
 * 旧会话不显式 dispose 就不会归还堆内存，反复切换模型/精度/设备会持续堆积，
 * 最终演变成 std::bad_alloc（表现就是「内存不足」，且与机器物理内存无关）。
 * @param keepKey 本次要保留的缓存 key
 */
async function releaseOtherSessions(keepKey: string): Promise<void> {
  for (const [key, entry] of [...transformerPipelineCache]) {
    if (key === keepKey) continue
    transformerPipelineCache.delete(key)
    await disposePipeline(entry.pipeline)
  }
}

/**
 * 释放指定引擎已初始化的 ONNX 会话，把 wasm 堆内存归还给浏览器。
 * 只从缓存 Map 里删引用不会归还内存，必须走 dispose（见 {@link releaseOtherSessions}）。
 * ISNet（imgly）的会话与资源缓存都由 imgly 运行时内部持有，没有可释放的句柄，此处不做处理。
 * @param engine 目标引擎
 */
export async function releaseMattingModel(engine: AiEngine): Promise<void> {
  if (engine === 'imgly') return
  for (const [key, entry] of [...transformerPipelineCache]) {
    if (entry.engine !== engine) continue
    transformerPipelineCache.delete(key)
    await disposePipeline(entry.pipeline)
  }
}

async function getTransformerPipeline(options: TransformersOptions): Promise<TransformerPipeline> {
  const key = transformerCacheKey(options)
  const cached = transformerPipelineCache.get(key)
  if (cached) return cached.pipeline
  const loading = transformerPipelineLoading.get(key)
  if (loading) return (await loading).pipeline
  const task = (async (): Promise<TransformerPipelineEntry> => {
    // 能力预检放在最前面：既避免白白下载上百 MB 权重，也避免跑 25 秒后
    // 抛 bad_alloc 把 wasm 堆搞坏（堆坏掉之后所有引擎都会跟着失败）
    const blocked = modelBlockReason(options.modelId, options.device)
    if (blocked) throw new Error(blocked)
    const transformers = await import('@huggingface/transformers')
    transformers.env.allowLocalModels = true
    transformers.env.localModelPath = LOCAL_MODEL_ROOT
    transformers.env.remoteHost = modelHostUrl(options.modelHost)
    const localModelPath = localRepoPath(options.modelId)
    const pretrainedModel = localModelPath ?? options.modelId
    const allowRemoteModels = transformers.env.allowRemoteModels
    const useBrowserCache = transformers.env.useBrowserCache
    if (localModelPath) {
      transformers.env.allowRemoteModels = false
      transformers.env.useBrowserCache = false
    }
    const progress = transformersProgress(options.onProgress)
    try {
      const pipelineOptions: Parameters<typeof transformers.pipeline>[2] = {
        dtype: options.dtype,
        device: mapDevice(options.device),
        local_files_only: Boolean(localModelPath),
        progress_callback: progress,
      }
      if (options.modelId.toLowerCase() === 'briaai/rmbg-1.4') {
        const config = await transformers.AutoConfig.from_pretrained(pretrainedModel, { progress_callback: progress })
        if (config.model_type === 'SegformerForSemanticSegmentation') config.model_type = 'segformer'
        pipelineOptions.config = config
      }
      const pipeline = (await transformers.pipeline('background-removal', pretrainedModel, pipelineOptions)) as unknown as TransformerPipeline
      const entry: TransformerPipelineEntry = { pipeline, engine: engineForModelId(options.modelId) }
      transformerPipelineCache.set(key, entry)
      await releaseOtherSessions(key)
      return entry
    } finally {
      transformers.env.allowRemoteModels = allowRemoteModels
      transformers.env.useBrowserCache = useBrowserCache
    }
  })()
  transformerPipelineLoading.set(key, task)
  try { return (await task).pipeline } finally { transformerPipelineLoading.delete(key) }
}

export type PreloadOptions =
  | ({ engine: 'imgly' } & ImglyOptions)
  | ({ engine: 'birefnet' | 'rmbg' } & TransformersOptions)

/** 下载并初始化指定模型。重复调用会复用已初始化的实例。 */
export async function preloadMattingModel(options: PreloadOptions): Promise<void> {
  if (options.engine === 'imgly') {
    // IMG.LY exposes loading through removeBackground itself; a 1px warmup causes
    // its model files to be downloaded and kept in its internal cache.
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    await removeWithImgly(canvas, { ...options, maxSide: 1 })
    return
  }
  await getTransformerPipeline(options)
}

/**
 * 把 AI 引擎抛出的原始错误翻译成可执行的中文提示。
 * 典型场景：onnxruntime-web 的 wasm 堆分配失败会抛出
 * `failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc`，
 * 这句英文对用户没有指导意义，必须换成「怎么办」。
 * @param error 捕获到的异常
 * @param engine 触发抠图的引擎标识，用于给出针对性的替代方案
 */
export function describeMattingError(error: unknown, engine?: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  if (/bad_alloc|allocation failed|out of memory|OOM/i.test(raw)) {
    // wasm 堆一旦分配失败就已经被破坏，同页面内任何模型都会继续失败，只能靠刷新恢复
    return '浏览器 wasm 堆已用尽（这是 WebAssembly 的 4GB 上限，与机器物理内存无关）。堆损坏后本页面内所有模型都会失败，请先刷新页面（Cmd+R），再改用内存占用更低的 ISNet（imgly）或 RMBG-1.4。'
  }
  if (engine === 'imgly' && /Failed to fetch|NetworkError|network error/i.test(raw)) {
    return '无法下载 ISNet 模型资源（官方 CDN staticimgly.com）。请检查网络或代理后重试，或在该模型的「资源地址」里填写可访问的镜像地址'
  }
  if (/Can't load|Could not locate|no such file|not found|404|Failed to fetch|Unauthorized|local_files_only/i.test(raw)) {
    return '本地缺少该精度的模型权重文件，请改用 FP16，或检查 public/models 下的模型文件是否完整'
  }
  return raw || '抠图处理失败'
}

/**
 * imgly / @imgly/background-removal：ISNet 模型
 */
export async function removeWithImgly(source: CanvasSource, options: ImglyOptions): Promise<AiMattingResult> {
  const canvas = sourceToCanvas(source, resolveInferenceMaxSide(options.maxSide))
  options.onProgress?.({ phase: 'loading', text: '加载 ISNet 模型…' })
  const { removeBackground } = await import('@imgly/background-removal')
  // IMG.LY 1.7 decodes Blob/URL inputs into its internal HWC tensor; a canvas
  // is returned unchanged by its decoder and later fails when reading shape.
  const inputBlob = await canvasToBlob(canvas)
  // 已转成 Blob，画布不再需要，立刻归还给浏览器
  releaseCanvas(canvas)
  const blob = await removeBackground(inputBlob, {
    model: options.model,
    device: options.device,
    output: { format: 'image/png' },
    ...(options.publicPath ? { publicPath: options.publicPath } : {}),
    progress: (key: string, current: number, total: number) => {
      if (key.startsWith('fetch:')) {
        options.onProgress?.({ phase: 'loading', text: `下载模型资源…`, percent: total > 0 ? Math.round((current / total) * 100) : undefined })
      } else if (key.startsWith('compute:')) {
        options.onProgress?.({ phase: 'processing', text: 'AI 推理中…', percent: total > 0 ? Math.round((current / total) * 100) : undefined })
      }
    },
  })
  return { blob }
}

/**
 * transformers.js 显著性分割（BiRefNet / RMBG）。
 * 这两个模型输出分割蒙版，需通过 image-segmentation 管线取 mask，再与原图合成 alpha。
 */
export async function removeWithTransformers(source: CanvasSource, options: TransformersOptions): Promise<AiMattingResult> {
  const canvas = sourceToCanvas(source, resolveInferenceMaxSide(options.maxSide))
  // 模型实例按「模型 + 精度 + 设备 + 托管源」缓存，命中缓存时不会重新下载权重
  const reused = transformerPipelineCache.has(transformerCacheKey(options))
  options.onProgress?.({ phase: 'loading', text: reused ? '复用已加载的模型…' : `检查 ${options.modelId} 模型…` })
  const pipeline = await getTransformerPipeline(options)
  options.onProgress?.({ phase: 'processing', text: 'AI 推理中…' })
  const output = await pipeline(canvas)
  if (output && typeof output === 'object' && 'data' in output && 'width' in output && 'height' in output && 'channels' in output) {
    const resultCanvas = rawImageToCanvas(output as RawImageLike)
    const resultBlob = await canvasToBlob(resultCanvas)
    releaseCanvas(resultCanvas)
    releaseCanvas(canvas)
    return { blob: resultBlob }
  }
  const outputs = output as Array<{ mask: { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number } }>
  const segmentationOutput = outputs[0]
  if (!segmentationOutput?.mask?.data?.length) throw new Error(`${options.modelId} 没有返回有效的分割蒙版`)

  // 管线返回的蒙版通常已还原到输入尺寸，直接就地合成到画布上，
  // 不再额外分配「蒙版画布 + 缩放画布 + 结果画布」三份大缓冲
  const { data, width, height, channels } = segmentationOutput.mask
  const blob = await canvasToBlob(applyMaskToCanvas(canvas, data, width, height, channels))
  releaseCanvas(canvas)
  return { blob }
}

