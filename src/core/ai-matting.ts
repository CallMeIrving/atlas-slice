/**
 * AI 抠图引擎统一封装。
 *
 * 支持的引擎：
 * - imgly     : @imgly/background-removal（ISNet，MIT 可商用）
 * - birefnet  : transformers.js + BiRefNet_lite-ONNX（MIT 可商用，质量高）
 * - rmbg      : transformers.js + BRIA RMBG-1.4（效果顶尖，⚠️不可商用）
 * - sam       : transformers.js + SAM（框选/提示点分割，可多区域一起抠图）
 *
 * 所有引擎输入图像源（HTMLImageElement / HTMLCanvasElement），输出透明 PNG Blob；
 * SAM 额外返回分割蒙版（白前景/黑背景）。
 * 引擎内部均为动态 import，避免主包体积膨胀。
 */

export interface MatteProgress {
  phase: 'loading' | 'processing'
  text: string
  /** 0-100，无法计算进度时为 undefined */
  percent?: number
}

export interface AiEngineBaseOptions {
  /** 处理前最大边长像素，0 = 保持原图尺寸 */
  maxSide?: number
  onProgress?: (progress: MatteProgress) => void
}

export interface ImglyOptions extends AiEngineBaseOptions {
  model: 'isnet' | 'isnet_fp16' | 'isnet_quint8'
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

export interface SamPoint {
  x: number
  y: number
  /** 1 = 前景点（要保留），0 = 背景点（要排除） */
  label: 0 | 1
}

export interface SamBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface SamOptions extends AiEngineBaseOptions {
  modelId: string
  device: 'cpu' | 'gpu'
  /** 模型托管源，国内网络可用 hf-mirror.com 镜像 */
  modelHost: 'huggingface.co' | 'hf-mirror.com'
  /** 坐标基于原图像素空间（未缩放前） */
  boxes: SamBox[]
  points: SamPoint[]
}

export interface AiMattingResult {
  blob: Blob
  /** SAM 专用：分割蒙版 PNG（白色前景 / 黑色背景） */
  maskBlob?: Blob
}

export type AiEngine = 'imgly' | 'birefnet' | 'rmbg' | 'sam'

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
  { key: 'birefnet', label: 'BiRefNet', license: 'MIT 可商用', size: '约 115MB（FP16）', description: '高质量分割，细节保留好' },
  { key: 'rmbg', label: 'RMBG-1.4（BRIA）', license: '⚠️不可商用', size: '约 44-176MB（Q8-FP32）', description: '效果顶尖，注意许可限制' },
  { key: 'sam', label: 'SAM 框选分割', license: 'Apache-2.0', size: '约 110MB（Q8）', description: '框选/点击区域精确分割' },
]

type CanvasSource = HTMLImageElement | HTMLCanvasElement

type TransformerPipeline = (input: unknown) => Promise<unknown>

interface RawImageLike {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  channels: number
}

const transformerPipelineCache = new Map<string, TransformerPipeline>()
const transformerPipelineLoading = new Map<string, Promise<TransformerPipeline>>()
const samRuntimeCache = new Map<string, { processor: SamProcessorLike; model: SamModelLike }>()
const samRuntimeLoading = new Map<string, Promise<{ processor: SamProcessorLike; model: SamModelLike }>>()
// Xenova/sam-vit-base is split into a vision encoder and a prompt/mask decoder.
// Keep SAM on Q8 so from_pretrained selects only the two *_quantized.onnx files.
const SAM_DTYPE = 'q8' as const
const LOCAL_MODEL_PATH = '/models/'
const LOCAL_SAM_MODEL_PATH = `${LOCAL_MODEL_PATH}Xenova/sam-vit-base/`
const SAM_LOCAL_FILES = [
  'config.json',
  'processor_config.json',
  'preprocessor_config.json',
  'quantize_config.json',
  'onnx/vision_encoder_quantized.onnx',
  'onnx/prompt_encoder_mask_decoder_quantized.onnx',
] as const

/** transformers.js Tensor 的轻量视图 */
interface AnyTensor {
  dims: number[]
  data: Float32Array
}

/** SAM 模型/处理器的类型补丁（transformers.js 类型未覆盖这些私有 API） */
interface SamModelLike {
  get_image_embeddings(inputs: { pixel_values: unknown }): Promise<{ image_embeddings: unknown; image_positional_embeddings: unknown }>
  (inputs: Record<string, unknown>): Promise<{ pred_masks: AnyTensor; iou_scores: AnyTensor }>
}

interface SamProcessorLike {
  (image: unknown, options: { input_points: number[][][]; input_labels: number[][] }): Promise<{
    pixel_values: unknown
    original_sizes: number[][]
    reshaped_input_sizes: number[][]
    input_points: unknown
    input_labels: unknown
  }>
  post_process_masks(masks: unknown, originalSizes: number[][], reshapedInputSizes: number[][], options: { binarize: boolean }): Promise<AnyTensor | AnyTensor[]>
}

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

function rawImageToCanvas(image: RawImageLike): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const rgba = new Uint8ClampedArray(image.width * image.height * 4)
  for (let index = 0; index < image.width * image.height; index += 1) {
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

/** 用单通道蒙版（0-255）作为 alpha 合成到原图上，返回结果画布（与输入同尺寸） */
function composeAlphaCanvas(sourceCanvas: HTMLCanvasElement, mask: Uint8ClampedArray): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = sourceCanvas.width
  out.height = sourceCanvas.height
  const ctx = out.getContext('2d')!
  ctx.drawImage(sourceCanvas, 0, 0)
  const imageData = ctx.getImageData(0, 0, out.width, out.height)
  const pixels = imageData.data
  for (let i = 0; i < out.width * out.height; i += 1) {
    pixels[i * 4 + 3] = mask[i]
  }
  ctx.putImageData(imageData, 0, 0)
  return out
}

/** 把单通道蒙版渲染为白前景/黑背景的 PNG 画布 */
function maskToCanvas(mask: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  const pixels = imageData.data
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = mask[i]
    pixels[i * 4 + 1] = mask[i]
    pixels[i * 4 + 2] = mask[i]
    pixels[i * 4 + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas
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

async function inspectSamLocalFiles(onProgress?: (progress: MatteProgress) => void): Promise<void> {
  const baseUrl = `${LOCAL_MODEL_PATH}Xenova/sam-vit-base/`
  console.groupCollapsed('[SAM] 本地模型文件检查')
  try {
    for (const file of SAM_LOCAL_FILES) {
      const url = `${baseUrl}${file}`
      onProgress?.({ phase: 'loading', text: `检查本地文件 ${file}…` })
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      const contentType = response.headers.get('content-type') ?? ''
      const contentLength = response.headers.get('content-length') ?? '未知'
      console.info('[SAM] 文件检查', { file, url, status: response.status, contentType, contentLength })
      if (!response.ok) throw new Error(`本地文件 ${file} 请求失败：HTTP ${response.status}（${url}）`)
      if (contentType.toLowerCase().includes('text/html')) throw new Error(`本地文件 ${file} 返回了 HTML，不是模型文件（${url}）`)
    }
  } finally {
    console.groupEnd()
  }
}

function transformerCacheKey(options: Pick<TransformersOptions, 'modelId' | 'dtype' | 'device' | 'modelHost'>): string {
  return `${options.modelId}|${options.dtype}|${options.device}|${options.modelHost}`
}

/**
 * 同一模型只保留一个已初始化的 pipeline。
 * 切换精度/设备会生成新的缓存 key，若不驱逐旧实例，ONNX Runtime 会话会一直堆在内存里，
 * 多次切换后极易触发 wasm 堆分配失败（std::bad_alloc）。
 */
function evictStalePipelines(activeKey: string, modelId: string): void {
  const prefix = `${modelId}|`
  for (const key of [...transformerPipelineCache.keys()]) {
    if (key !== activeKey && key.startsWith(prefix)) transformerPipelineCache.delete(key)
  }
}

function localModelPathFor(modelId: string): string | undefined {
  const normalizedId = modelId.toLowerCase()
  if (normalizedId === 'onnx-community/birefnet_lite-onnx') return '/models/onnx-community/BiRefNet_lite-ONNX/'
  if (normalizedId === 'briaai/rmbg-1.4') return '/models/briaai/RMBG-1.4/'
  return undefined
}

async function getTransformerPipeline(options: TransformersOptions): Promise<TransformerPipeline> {
  const key = transformerCacheKey(options)
  const cached = transformerPipelineCache.get(key)
  if (cached) return cached
  const loading = transformerPipelineLoading.get(key)
  if (loading) return loading
  const task = (async () => {
    const transformers = await import('@huggingface/transformers')
    transformers.env.allowLocalModels = true
    transformers.env.localModelPath = LOCAL_MODEL_PATH
    transformers.env.remoteHost = modelHostUrl(options.modelHost)
    const localModelPath = localModelPathFor(options.modelId)
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
      transformerPipelineCache.set(key, pipeline)
      evictStalePipelines(key, options.modelId)
      return pipeline
    } finally {
      transformers.env.allowRemoteModels = allowRemoteModels
      transformers.env.useBrowserCache = useBrowserCache
    }
  })()
  transformerPipelineLoading.set(key, task)
  try { return await task } finally { transformerPipelineLoading.delete(key) }
}

function samCacheKey(options: Pick<SamOptions, 'modelId' | 'device' | 'modelHost'>): string {
  return `${options.modelId}|${options.device}|${options.modelHost}`
}

async function loadSamRuntime(options: SamOptions, modelHost: SamOptions['modelHost']): Promise<{ processor: SamProcessorLike; model: SamModelLike }> {
  const transformers = await import('@huggingface/transformers')
  transformers.env.allowLocalModels = true
  transformers.env.localModelPath = LOCAL_MODEL_PATH
  transformers.env.remoteHost = modelHostUrl(modelHost)
  const progress = transformersProgress(options.onProgress)
  await inspectSamLocalFiles(options.onProgress)
  const allowRemoteModels = transformers.env.allowRemoteModels
  const useBrowserCache = transformers.env.useBrowserCache
  // SAM 文件已随项目放入 public/models，严格使用本地文件，避免缺文件时
  // 把远程 HTML 错误页当成 JSON 解析。
  transformers.env.allowRemoteModels = false
  transformers.env.useBrowserCache = false
  try {
    console.info('[SAM] 开始初始化 Transformers.js', {
      modelId: options.modelId,
      dtype: SAM_DTYPE,
      device: mapDevice(options.device),
      localModelPath: transformers.env.localModelPath,
      allowRemoteModels: transformers.env.allowRemoteModels,
    })
    const processor = (await transformers.AutoProcessor.from_pretrained(LOCAL_SAM_MODEL_PATH, { local_files_only: true, progress_callback: progress })) as unknown as SamProcessorLike
    console.info('[SAM] AutoProcessor 初始化完成')
    const model = (await transformers.SamModel.from_pretrained(LOCAL_SAM_MODEL_PATH, { local_files_only: true, device: mapDevice(options.device), dtype: SAM_DTYPE, progress_callback: progress })) as unknown as SamModelLike
    console.info('[SAM] SamModel 初始化完成')
    return { processor, model }
  } finally {
    transformers.env.allowRemoteModels = allowRemoteModels
    transformers.env.useBrowserCache = useBrowserCache
  }
}

async function getSamRuntime(options: SamOptions): Promise<{ processor: SamProcessorLike; model: SamModelLike }> {
  const key = samCacheKey(options)
  const cached = samRuntimeCache.get(key)
  if (cached) return cached
  const loading = samRuntimeLoading.get(key)
  if (loading) return loading
  const task = (async () => {
    const runtime = await loadSamRuntime(options, options.modelHost)
    samRuntimeCache.set(key, runtime)
    return runtime
  })()
  samRuntimeLoading.set(key, task)
  try { return await task } finally { samRuntimeLoading.delete(key) }
}

export type PreloadOptions =
  | ({ engine: 'imgly' } & ImglyOptions)
  | ({ engine: 'birefnet' | 'rmbg' } & TransformersOptions)
  | ({ engine: 'sam' } & SamOptions)

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
  if (options.engine === 'sam') {
    await getSamRuntime(options)
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
    return engine === 'imgly'
      ? '浏览器可用内存不足：请关闭其他占用较大的页面后重试，或降低处理分辨率'
      : '浏览器可用内存不足。BiRefNet / RMBG 推理占用很高（CPU 模式尤甚），建议改用 ISNet（imgly）、把推理设备切到 GPU（WebGPU），或关闭其他占用较大的页面后重试'
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
  const canvas = sourceToCanvas(source, options.maxSide)
  options.onProgress?.({ phase: 'loading', text: '加载 ISNet 模型…' })
  const { removeBackground } = await import('@imgly/background-removal')
  // IMG.LY 1.7 decodes Blob/URL inputs into its internal HWC tensor; a canvas
  // is returned unchanged by its decoder and later fails when reading shape.
  const inputBlob = await canvasToBlob(canvas)
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
  const canvas = sourceToCanvas(source, options.maxSide)
  // 模型实例按「模型 + 精度 + 设备 + 托管源」缓存，命中缓存时不会重新下载权重
  const reused = transformerPipelineCache.has(transformerCacheKey(options))
  options.onProgress?.({ phase: 'loading', text: reused ? '复用已加载的模型…' : `检查 ${options.modelId} 模型…` })
  const pipeline = await getTransformerPipeline(options)
  options.onProgress?.({ phase: 'processing', text: 'AI 推理中…' })
  const output = await pipeline(canvas)
  if (output && typeof output === 'object' && 'data' in output && 'width' in output && 'height' in output && 'channels' in output) {
    const resultBlob = await canvasToBlob(rawImageToCanvas(output as RawImageLike))
    return { blob: resultBlob }
  }
  const outputs = output as Array<{ mask: { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number } }>
  const segmentationOutput = outputs[0]
  if (!segmentationOutput?.mask?.data?.length) throw new Error(`${options.modelId} 没有返回有效的分割蒙版`)

  const { data, width, height, channels } = segmentationOutput.mask
  const mask = new Uint8ClampedArray(canvas.width * canvas.height)
  // The image-segmentation pipeline returns the mask resized to the input image.
  // Handle a possible dimension mismatch with canvas interpolation for robustness.
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = width
  maskCanvas.height = height
  const maskCtx = maskCanvas.getContext('2d')!
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const value = data[i * channels]
    const offset = i * 4
    rgba[offset] = value
    rgba[offset + 1] = value
    rgba[offset + 2] = value
    rgba[offset + 3] = 255
  }
  maskCtx.putImageData(new ImageData(rgba, width, height), 0, 0)
  const scaledMask = document.createElement('canvas')
  scaledMask.width = canvas.width
  scaledMask.height = canvas.height
  const scaledCtx = scaledMask.getContext('2d')!
  scaledCtx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height)
  const scaledData = scaledCtx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 0; i < mask.length; i += 1) mask[i] = scaledData[i * 4]

  const blob = await canvasToBlob(composeAlphaCanvas(canvas, mask))
  return { blob }
}

/**
 * SAM 分割：支持多个框选区域 + 前景/背景提示点。
 * 每个框/点作为独立 prompt 分别推理（SAM 解码器对单个 prompt 输出 3 个候选 mask），
 * 按 iou 分数选最优 mask，正区域取并集(union)，再减去背景点区域，得到最终透明图。
 */
export async function segmentWithSam(source: CanvasSource, options: SamOptions): Promise<AiMattingResult> {
  const sourceWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width
  const sourceHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height
  // SAM restores candidate masks to its input size. Cap that intermediate size so
  // high-resolution inputs and multiple prompts cannot allocate several full-size masks.
  const configuredMaxSide = options.maxSide ?? 0
  const requestedMaxSide = configuredMaxSide > 0 ? configuredMaxSide : 1024
  const canvas = sourceToCanvas(source, Math.min(requestedMaxSide, 1024))
  const { boxes, points, onProgress } = options
  if (boxes.length === 0 && points.length === 0) {
    throw new Error('请先框选区域或添加提示点')
  }

  onProgress?.({ phase: 'loading', text: `加载 ${options.modelId} 模型…` })
  const transformers = await import('@huggingface/transformers')
  const { processor, model } = await getSamRuntime(options)
  const rawImage = transformers.RawImage.fromCanvas(canvas)

  onProgress?.({ phase: 'processing', text: 'AI 推理中…' })

  // 标注始终记录在原图像素空间。模型输入可能经 maxSide 缩放，提示点也必须使用同一图像空间。
  const scaleX = canvas.width / sourceWidth
  const scaleY = canvas.height / sourceHeight
  const modelBoxes = boxes.map((box) => ({ x1: box.x1 * scaleX, y1: box.y1 * scaleY, x2: box.x2 * scaleX, y2: box.y2 * scaleY }))
  const modelPoints = points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY, label: point.label }))

  // 先用任一个提示点预处理一次，拿到图像特征与尺寸信息
  const firstPrompt = modelBoxes.length > 0 ? modelBoxes[0] : modelPoints[0]
  const firstPoints = 'x1' in firstPrompt ? [[firstPrompt.x1, firstPrompt.y1], [firstPrompt.x2, firstPrompt.y2]] : [[firstPrompt.x, firstPrompt.y]]
  const firstLabels = 'x1' in firstPrompt ? [2, 3] : [firstPrompt.label]
  const preprocessed = await processor(rawImage, { input_points: [firstPoints], input_labels: [firstLabels] })
  const { image_embeddings, image_positional_embeddings } = await model.get_image_embeddings({ pixel_values: preprocessed.pixel_values })
  const originalSizes = preprocessed.original_sizes
  const reshapedInputSizes = preprocessed.reshaped_input_sizes

  /** 对单个 prompt 推理，返回 H×W 的软蒙版（0-1） */
  async function runPrompt(promptPoints: number[][], promptLabels: number[]): Promise<{ mask: Float32Array; width: number; height: number }> {
    const inputs = await processor(rawImage, { input_points: [promptPoints], input_labels: [promptLabels] })
    const outputs = await model({ image_embeddings, image_positional_embeddings, input_points: inputs.input_points, input_labels: inputs.input_labels })
    // iou_scores: [1, 1, 3]（num_multimask_outputs = 3）
    const iou = outputs.iou_scores.data
    let best = 0
    for (let k = 1; k < 3; k += 1) if (iou[k] > iou[best]) best = k
    const processed = await processor.post_process_masks(outputs.pred_masks, originalSizes, reshapedInputSizes, { binarize: false })
    const masks = Array.isArray(processed) ? processed[0] : processed
    const dims = masks.dims
    const height = dims[dims.length - 2]
    const width = dims[dims.length - 1]
    const stride = height * width
    const data = masks.data
    const mask = new Float32Array(stride)
    const base = best * stride
    for (let p = 0; p < stride; p += 1) mask[p] = data[base + p]
    return { mask, width, height }
  }

  let stride = 0
  let union = new Float32Array(0)
  let unionNeg = new Float32Array(0)
  /** 把单个 prompt 的蒙版并入正/负并集 */
  function addMask(mask: Float32Array, positive: boolean): void {
    if (stride === 0) {
      stride = mask.length
      union = new Float32Array(stride)
      unionNeg = new Float32Array(stride)
    }
    const target = positive ? union : unionNeg
    for (let p = 0; p < stride; p += 1) if (mask[p] > target[p]) target[p] = mask[p]
  }

  for (const box of modelBoxes) {
    addMask((await runPrompt([[box.x1, box.y1], [box.x2, box.y2]], [2, 3])).mask, true)
  }
  for (const point of modelPoints) {
    addMask((await runPrompt([[point.x, point.y]], [point.label])).mask, point.label === 1)
  }

  // 最终蒙版 = 正区域并集 × (1 - 背景点区域)
  const final = new Uint8ClampedArray(stride)
  for (let p = 0; p < stride; p += 1) {
    final[p] = Math.round(union[p] * (1 - unionNeg[p]) * 255)
  }

  const outCanvas = composeAlphaCanvas(canvas, final)
  const blob = await canvasToBlob(outCanvas)
  const maskCanvas = maskToCanvas(final, canvas.width, canvas.height)
  const maskBlob = await canvasToBlob(maskCanvas)
  return { blob, maskBlob }
}
