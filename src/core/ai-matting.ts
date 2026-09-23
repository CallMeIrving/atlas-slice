/**
 * AI 抠图引擎统一封装。
 *
 * 支持的引擎：
 * - imgly     : @imgly/background-removal（ISNet，MIT 可商用）
 * - birefnet  : transformers.js + BiRefNet_lite（MIT 可商用，质量最高）
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
  { key: 'birefnet', label: 'BiRefNet', license: 'MIT 可商用', size: '约 85MB', description: '质量最高，细节保留好' },
  { key: 'rmbg', label: 'RMBG-1.4（BRIA）', license: '⚠️不可商用', size: '约 44MB', description: '效果顶尖，注意许可限制' },
  { key: 'sam', label: 'SAM 框选分割', license: 'Apache-2.0', size: '约 150MB', description: '框选/点击区域精确分割' },
]

type CanvasSource = HTMLImageElement | HTMLCanvasElement

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

/**
 * imgly / @imgly/background-removal：ISNet 模型
 */
export async function removeWithImgly(source: CanvasSource, options: ImglyOptions): Promise<AiMattingResult> {
  const canvas = sourceToCanvas(source, options.maxSide)
  options.onProgress?.({ phase: 'loading', text: '加载 ISNet 模型…' })
  const { removeBackground } = await import('@imgly/background-removal')
  const blob = await removeBackground(canvas, {
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
 * transformers.js 背景移除（BiRefNet / RMBG）
 * 两者共用 pipeline('background-removal', ...)，返回已带 alpha 的 RGBA RawImage。
 */
export async function removeWithTransformers(source: CanvasSource, options: TransformersOptions): Promise<AiMattingResult> {
  const canvas = sourceToCanvas(source, options.maxSide)
  options.onProgress?.({ phase: 'loading', text: `加载 ${options.modelId} 模型…` })
  const transformers = await import('@huggingface/transformers')
  transformers.env.allowLocalModels = false
  transformers.env.remoteHost = modelHostUrl(options.modelHost)
  const pipeline = await transformers.pipeline('background-removal', options.modelId, {
    dtype: options.dtype,
    device: mapDevice(options.device),
    progress_callback: transformersProgress(options.onProgress),
  })
  options.onProgress?.({ phase: 'processing', text: 'AI 推理中…' })
  const output = (await pipeline(canvas)) as { toBlob(type: string): Promise<Blob> }
  const blob = await output.toBlob('image/png')
  return { blob }
}

/**
 * SAM 分割：支持多个框选区域 + 前景/背景提示点。
 * 每个框/点作为独立 prompt 分别推理（SAM 解码器对单个 prompt 输出 3 个候选 mask），
 * 按 iou 分数选最优 mask，正区域取并集(union)，再减去背景点区域，得到最终透明图。
 */
export async function segmentWithSam(source: CanvasSource, options: SamOptions): Promise<AiMattingResult> {
  const canvas = sourceToCanvas(source, options.maxSide)
  const { boxes, points, onProgress } = options
  if (boxes.length === 0 && points.length === 0) {
    throw new Error('请先框选区域或添加提示点')
  }

  onProgress?.({ phase: 'loading', text: `加载 ${options.modelId} 模型…` })
  const transformers = await import('@huggingface/transformers')
  transformers.env.allowLocalModels = false
  transformers.env.remoteHost = modelHostUrl(options.modelHost)
  const progress = transformersProgress(onProgress)
  const processor = (await transformers.AutoProcessor.from_pretrained(options.modelId, { progress_callback: progress })) as unknown as SamProcessorLike
  const model = (await transformers.SamModel.from_pretrained(options.modelId, { device: mapDevice(options.device), progress_callback: progress })) as unknown as SamModelLike

  onProgress?.({ phase: 'processing', text: 'AI 推理中…' })

  // 先用任一个提示点预处理一次，拿到图像特征与尺寸信息
  const firstPrompt = boxes.length > 0 ? boxes[0] : points[0]
  const firstPoints = 'x1' in firstPrompt ? [[firstPrompt.x1, firstPrompt.y1], [firstPrompt.x2, firstPrompt.y2]] : [[firstPrompt.x, firstPrompt.y]]
  const firstLabels = 'x1' in firstPrompt ? [2, 3] : [firstPrompt.label]
  const preprocessed = await processor(canvas, { input_points: [firstPoints], input_labels: [firstLabels] })
  const { image_embeddings, image_positional_embeddings } = await model.get_image_embeddings({ pixel_values: preprocessed.pixel_values })
  const originalSizes = preprocessed.original_sizes
  const reshapedInputSizes = preprocessed.reshaped_input_sizes

  /** 对单个 prompt 推理，返回 H×W 的软蒙版（0-1） */
  async function runPrompt(promptPoints: number[][], promptLabels: number[]): Promise<{ mask: Float32Array; width: number; height: number }> {
    const inputs = await processor(canvas, { input_points: [promptPoints], input_labels: [promptLabels] })
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

  for (const box of boxes) {
    addMask((await runPrompt([[box.x1, box.y1], [box.x2, box.y2]], [2, 3])).mask, true)
  }
  for (const point of points) {
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
