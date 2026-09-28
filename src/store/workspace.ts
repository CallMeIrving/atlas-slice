import { reactive } from 'vue'
import type { ShadowMode } from '@/core/color-key'
import type { ImageCropRect } from '@/core/crop'

export type WorkspacePage = 'atlas' | 'matte' | 'video' | 'watermark' | 'layersplit'

export type MatteMode = 'auto' | 'color' | 'solid' | 'imgly' | 'rmbg'

export interface MatteState {
  fileName: string
  sourceUrl: string
  resultUrl: string
  mode: MatteMode
  background: 'checker' | 'white' | 'black' | 'original'
  tolerance: number
  cropTransparent: boolean
  brushSize: number
  sampledColor: string
  /** AI 引擎参数 */
  aiMaxSide: number
  imglyModel: 'isnet' | 'isnet_fp16' | 'isnet_quint8'
  imglyPublicPath: string
  aiDevice: 'cpu' | 'gpu'
  aiDtype: 'q8' | 'fp16' | 'fp32'
  aiModelHost: 'huggingface.co' | 'hf-mirror.com'
  rmbgModelId: string
  /** AI 处理状态（进度文本/百分比） */
  aiStatus: string
  aiProgress: number
  status: 'empty' | 'ready' | 'processing' | 'done' | 'error'
}

export interface VideoFrame {
  id: string
  /** 抽帧原始图像（dataURL PNG） */
  url: string
  /** 去水印结果（dataURL PNG），存在时作为抠图的输入 */
  watermarkUrl?: string
  /** 抠图结果（dataURL PNG），存在时优先展示与导出 */
  matteUrl?: string
  /** 裁切区域（相对帧图像像素坐标），各帧使用同一区域，便于重置与重新裁切 */
  crop?: ImageCropRect
  /** 裁切结果（dataURL PNG），存在时在抠图结果之上优先展示与导出 */
  cropUrl?: string
  timestamp: number
  selected: boolean
}

/** 视频帧抠图方式：solid 走纯色背景色相判据，其余为 AI 模型 */
export type FrameMatteMode = 'solid' | 'imgly' | 'rmbg'

export interface VideoMatteSettings {
  mode: FrameMatteMode
  /** 颜色容差，色相判据下换算为色相窗口与饱和度窗口 */
  tolerance: number
  shadow: ShadowMode
  /** 手动指定的背景基准色（#rrggbb）；为空时自动从图像四边采样 */
  baseColor: string
}

/** 一键处理流水线的步骤开关与裁切区域 */
export interface VideoPipelineSettings {
  /** 是否启用裁切步骤（需框选区域，默认关闭） */
  cropEnabled: boolean
  /** 是否启用抠图步骤（默认开启，按需求默认使用模型抠图） */
  matteEnabled: boolean
  /** 裁切区域（图像像素坐标），各帧共用同一区域 */
  crop: ImageCropRect | null
}

export interface VideoState {
  fileName: string
  sourceUrl: string
  duration: number
  width: number
  height: number
  fps: number
  flipX: boolean
  rotation: 0 | 90 | 180 | 270
  error: string
  start: number
  end: number
  mode: 'count' | 'fps'
  count: number
  targetFps: number
  frames: VideoFrame[]
  /** 帧抠图设置（抽帧后按帧执行，不参与抽帧过程） */
  matte: VideoMatteSettings
  /** 一键处理流水线配置 */
  pipeline: VideoPipelineSettings
  status: 'empty' | 'ready' | 'processing' | 'done' | 'error'
}

/** 去水印修复方式：patch 按蒙版替换水印像素，alpha 逆向 Alpha 还原，region 整块重建，texture 环带纹理合成 */
export type WatermarkMode = 'patch' | 'alpha' | 'region' | 'texture'

export interface WatermarkSettings {
  mode: WatermarkMode
  /** 水印本色 #rrggbb（alpha 模式解算用），空串 = 按投影自动估算 */
  watermarkColor: string
  /** 水印置信度阈值（曼哈顿色差），仅 patch 模式生效 */
  threshold: number
  /** 手动底色覆盖 #rrggbb，空串 = 自动从 ROI 外圈环带采样 */
  baseColor: string
  /** patch 模式是否保留底色噪点（坐标哈希确定性噪声，逐帧一致） */
  keepNoise: boolean
  /** 重建精细度（0 快速 / 1 标准 / 2 精细），仅 texture 模式使用 */
  quality: number
}

export interface WatermarkState {
  /** 数据来源：单张图片 / 视频帧列表 */
  source: 'image' | 'frames'
  fileName: string
  /** 单图来源的 blob URL；帧模式的画面由 frameId 对应的帧推出 */
  sourceUrl: string
  /** 样板帧的处理结果（帧模式即样板帧的预览结果） */
  resultUrl: string
  /** 帧模式下作为样板与 ROI 参照的帧 id */
  frameId: string
  status: 'empty' | 'ready' | 'processing' | 'done' | 'error'
  error: string
  /** ROI（图像像素坐标），只在会话内保留，不写 localStorage */
  roi: ImageCropRect | null
  settings: WatermarkSettings
}

/** 图层类别：与本地 Python 服务的 LayerCategory 枚举一致（category 决定同深度时的层序） */
export type LayerCategory =
  | 'button'
  | 'icon'
  | 'text'
  | 'panel'
  | 'border'
  | 'decoration'
  | 'progress'
  | 'background'
  | 'other'

/** 一类要拆的 UI 元素：prompt 必须英文（模型词表决定），label 是界面文案 */
export interface LayerClassSpec {
  label: string
  prompt: string
  category: LayerCategory
  /** 编辑器里的启用开关：false 表示保留在列表但不提交给服务端（undefined 视为启用） */
  enabled?: boolean
}

export type LayerDetector = 'grounding-dino' | 'florence2' | 'auto'
export type LayerSegmenter = 'sam' | 'none'
export type LayerBackgroundMode = 'none' | 'erase' | 'inpaint'
export type LayerDevice = 'auto' | 'cuda' | 'mps' | 'cpu'

export interface LayerSplitSettings {
  classes: LayerClassSpec[]
  detector: LayerDetector
  segmenter: LayerSegmenter
  ocr: boolean
  boxThreshold: number
  textThreshold: number
  nmsIou: number
  minArea: number
  maxLayers: number
  maxSide: number
  background: LayerBackgroundMode
  exclusiveLayers: boolean
  feather: number
  device: LayerDevice
}

/** 一个拆分结果图层；列表按 z 降序展示（从上到下 = 前景到背景） */
export interface SplitLayer {
  id: string
  name: string
  label: string
  category: LayerCategory
  score: number
  bbox: { x: number; y: number; w: number; h: number }
  /** 内容矩形：PNG 已按它裁切，拼回原位时用它作为绘制坐标 */
  alphaBbox: { x: number; y: number; w: number; h: number }
  area: number
  z: number
  parentId: string | null
  source: string
  text: string | null
  /** 服务端图层是绝对 http 地址，客户端合并层是 blob 地址（重置时需 revoke） */
  pngUrl: string
  visible: boolean
  /** 由「合并选中」在客户端合成，不受服务端命名约束 */
  merged: boolean
}

/** 背景层（method 对应 background 策略）；默认不参与合成与导出 */
export interface SplitLayerBackground {
  id: string
  method: string
  pngUrl: string
  visible: boolean
}

export interface LayerSplitState {
  fileName: string
  /** 本地导入图像的 blob URL：既作为上传源，也作为导出 ZIP 里的 source.png */
  sourceUrl: string
  jobId: string
  status: 'empty' | 'ready' | 'processing' | 'done' | 'error'
  error: string
  image: { width: number; height: number; scale: number } | null
  layers: SplitLayer[]
  background: SplitLayerBackground | null
  counts: Record<string, number>
  warnings: string[]
  settings: LayerSplitSettings
  /** 本地服务是否可达，顶部栏与页面共用这一份状态 */
  serverOnline: boolean
  serverDevice: string
}

export const DEFAULT_LAYER_CLASSES: LayerClassSpec[] = [
  { label: '按钮', prompt: 'button', category: 'button' },
  { label: '图标', prompt: 'icon', category: 'icon' },
  { label: '文本', prompt: 'text', category: 'text' },
  { label: '面板', prompt: 'panel', category: 'panel' },
  { label: '边框', prompt: 'border', category: 'border' },
  { label: '装饰', prompt: 'decoration', category: 'decoration' },
  { label: '进度条', prompt: 'progress bar', category: 'progress' },
]

export const DEFAULT_LAYER_SETTINGS: LayerSplitSettings = {
  classes: DEFAULT_LAYER_CLASSES,
  detector: 'grounding-dino',
  segmenter: 'sam',
  ocr: true,
  boxThreshold: 0.30,
  textThreshold: 0.25,
  nmsIou: 0.55,
  minArea: 64,
  maxLayers: 80,
  maxSide: 1536,
  background: 'inpaint',
  exclusiveLayers: false,
  feather: 1,
  device: 'auto',
}

/** 帧的干净原图：作为抠图的输入，保证抠图在无水印画面上进行 */
export function frameCleanUrl(frame: VideoFrame): string {
  return frame.watermarkUrl ?? frame.url
}

/** 帧的裁切输入图像：抠图结果 > 去水印结果 > 原始抽帧画面 */
export function frameBaseUrl(frame: VideoFrame): string {
  return frame.matteUrl ?? frameCleanUrl(frame)
}

/** 帧的展示/导出图像：裁切结果 > 抠图结果 > 去水印结果 > 原始抽帧画面 */
export function frameImageUrl(frame: VideoFrame): string {
  return frame.cropUrl ?? frameBaseUrl(frame)
}

export const workspace = reactive({
  page: 'atlas' as WorkspacePage,
  matte: {
    fileName: '', sourceUrl: '', resultUrl: '', mode: 'auto', background: 'checker',
    tolerance: 24, cropTransparent: true, brushSize: 24, sampledColor: '', status: 'empty',
    aiMaxSide: 0, imglyModel: 'isnet_fp16', imglyPublicPath: '', aiDevice: 'cpu', aiDtype: 'fp16', aiModelHost: 'huggingface.co',
    rmbgModelId: 'briaai/RMBG-1.4',
    aiStatus: '', aiProgress: -1,
  } as MatteState,
  video: {
    fileName: '', sourceUrl: '', duration: 0, width: 0, height: 0, fps: 30,
    start: 0, end: 0, mode: 'count', count: 12, targetFps: 12, flipX: false, rotation: 0, error: '', frames: [], status: 'empty',
    matte: { mode: 'imgly', tolerance: 24, shadow: 'neutral', baseColor: '' } as VideoMatteSettings,
    pipeline: { cropEnabled: false, matteEnabled: true, crop: null } as VideoPipelineSettings,
  } as VideoState,
  watermark: {
    source: 'image', fileName: '', sourceUrl: '', resultUrl: '', frameId: '', status: 'empty', error: '', roi: null,
    settings: { mode: 'alpha', watermarkColor: '#ffffff', threshold: 48, baseColor: '', keepNoise: true, quality: 1 } as WatermarkSettings,
  } as WatermarkState,
  layersplit: {
    fileName: '', sourceUrl: '', jobId: '', status: 'empty', error: '', image: null,
    layers: [], background: null, counts: {}, warnings: [], serverOnline: false, serverDevice: '',
    settings: { ...DEFAULT_LAYER_SETTINGS, classes: DEFAULT_LAYER_CLASSES.map((item) => ({ ...item })) },
  } as LayerSplitState,
})

const SETTINGS_KEY = 'atlas-slice:media-settings'
/** 界面支持的处理方式，用于丢弃本地设置里已下线的取值 */
const MATTE_MODES: MatteMode[] = ['auto', 'color', 'solid', 'imgly', 'rmbg']
/** 去水印支持的修复方式，同样用于收敛本地设置 */
const WATERMARK_MODES: WatermarkMode[] = ['patch', 'alpha', 'region', 'texture']
/** 图层拆分支持的类别与选项，用于丢弃本地设置里已下线的取值 */
const LAYER_CATEGORIES: LayerCategory[] = ['button', 'icon', 'text', 'panel', 'border', 'decoration', 'progress', 'background', 'other']
const LAYER_DETECTORS: LayerDetector[] = ['grounding-dino', 'florence2', 'auto']
const LAYER_SEGMENTERS: LayerSegmenter[] = ['sam', 'none']
const LAYER_BACKGROUNDS: LayerBackgroundMode[] = ['none', 'erase', 'inpaint']
const LAYER_DEVICES: LayerDevice[] = ['auto', 'cuda', 'mps', 'cpu']

/**
 * 收敛本地保存的图层拆分设置。
 * 类别列表是用户可增删的：未知 category 直接丢弃，整份为空时回落到默认，避免出现无类可拆的空列表。
 */
function convergeLayerSettings(saved: Partial<LayerSplitSettings> | undefined): LayerSplitSettings {
  const base: LayerSplitSettings = { ...DEFAULT_LAYER_SETTINGS, classes: DEFAULT_LAYER_CLASSES.map((item) => ({ ...item })) }
  if (!saved) return base
  const { classes, ...rest } = saved
  const merged = { ...base, ...rest }
  if (Array.isArray(classes)) {
    const kept = classes
      .filter((item): item is LayerClassSpec => Boolean(item?.label?.trim() && item?.prompt?.trim()))
      .filter((item) => LAYER_CATEGORIES.includes(item.category))
      .map((item) => ({ label: item.label, prompt: item.prompt, category: item.category, enabled: item.enabled !== false }))
    merged.classes = kept.length ? kept : base.classes
  }
  if (!LAYER_DETECTORS.includes(merged.detector)) merged.detector = base.detector
  if (!LAYER_SEGMENTERS.includes(merged.segmenter)) merged.segmenter = base.segmenter
  if (!LAYER_BACKGROUNDS.includes(merged.background)) merged.background = base.background
  if (!LAYER_DEVICES.includes(merged.device)) merged.device = base.device
  return merged
}
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as {
    matte?: Partial<MatteState>
    video?: Partial<VideoState>
    watermark?: { settings?: Partial<WatermarkSettings> }
    layersplit?: { settings?: Partial<LayerSplitSettings> }
  } | null
  if (saved?.matte) Object.assign(workspace.matte, saved.matte)
  // 旧版本可能存过已经移除的处理方式，直接收敛到默认值，避免下拉框出现空选项
  if (!MATTE_MODES.includes(workspace.matte.mode)) workspace.matte.mode = 'auto'
  if (saved?.video) Object.assign(workspace.video, saved.video)
  // 去水印只持久化参数（ROI 与来源不落盘，重新打开时按新画面重新定位）
  if (saved?.watermark?.settings) Object.assign(workspace.watermark.settings, saved.watermark.settings)
  if (!WATERMARK_MODES.includes(workspace.watermark.settings.mode)) workspace.watermark.settings.mode = 'alpha'
  // 图层拆分同样只持久化设置（结果与服务端作业一一对应，不跨会话保留）
  workspace.layersplit.settings = convergeLayerSettings(saved?.layersplit?.settings)
} catch { /* ignore invalid local settings */ }

export function persistMediaSettings(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    matte: { mode: workspace.matte.mode, background: workspace.matte.background, tolerance: workspace.matte.tolerance, cropTransparent: workspace.matte.cropTransparent, aiMaxSide: workspace.matte.aiMaxSide, imglyModel: workspace.matte.imglyModel, imglyPublicPath: workspace.matte.imglyPublicPath, aiDevice: workspace.matte.aiDevice, aiDtype: workspace.matte.aiDtype, aiModelHost: workspace.matte.aiModelHost, rmbgModelId: workspace.matte.rmbgModelId },
    video: { mode: workspace.video.mode, count: workspace.video.count, targetFps: workspace.video.targetFps, flipX: workspace.video.flipX, rotation: workspace.video.rotation, matte: { ...workspace.video.matte }, pipeline: { ...workspace.video.pipeline }, },
    watermark: { settings: { ...workspace.watermark.settings } },
    layersplit: { settings: { ...workspace.layersplit.settings, classes: workspace.layersplit.settings.classes.map((item) => ({ ...item })) } },
  }))
}

export function setPage(page: WorkspacePage): void {
  workspace.page = page
}

export function resetMatte(): void {
  if (workspace.matte.sourceUrl) URL.revokeObjectURL(workspace.matte.sourceUrl)
  if (workspace.matte.resultUrl) URL.revokeObjectURL(workspace.matte.resultUrl)
  Object.assign(workspace.matte, { fileName: '', sourceUrl: '', resultUrl: '', status: 'empty' })
}

export function resetVideo(): void {
  if (workspace.video.sourceUrl) URL.revokeObjectURL(workspace.video.sourceUrl)
  workspace.video.frames.forEach((frame) => URL.revokeObjectURL(frame.url))
  Object.assign(workspace.video, { fileName: '', sourceUrl: '', duration: 0, width: 0, height: 0, start: 0, end: 0, frames: [], status: 'empty' })
}

/** 重置去水印页：释放单图来源的 blob URL，清空样板结果与 ROI（参数保留） */
export function resetWatermark(): void {
  if (workspace.watermark.sourceUrl) URL.revokeObjectURL(workspace.watermark.sourceUrl)
  Object.assign(workspace.watermark, { fileName: '', sourceUrl: '', resultUrl: '', frameId: '', status: 'empty', error: '', roi: null })
}

/**
 * 从视频帧页进入去水印：把指定帧作为样板并切页。
 * ROI 与结果一律清空，交由页面按新来源给出一块初始 ROI，避免沿用上一张画面的坐标。
 */
export function startWatermarkFromFrame(frameId: string): void {
  const frames = workspace.video.frames
  const target = frames.find((frame) => frame.id === frameId) ?? frames[0]
  if (!target) return
  Object.assign(workspace.watermark, {
    source: 'frames', frameId: target.id, fileName: workspace.video.fileName,
    resultUrl: '', status: 'ready', error: '', roi: null,
  })
  setPage('watermark')
}

/**
 * 重置图层拆分页：释放本地来源与客户端合并层的 blob URL，清空结果（设置保留）。
 * 服务端图层 PNG 是 http 地址，不能 revoke；只有合并层与来源是本地 blob。
 */
export function resetLayerSplit(): void {
  const split = workspace.layersplit
  if (split.sourceUrl) URL.revokeObjectURL(split.sourceUrl)
  split.layers.filter((layer) => layer.merged).forEach((layer) => URL.revokeObjectURL(layer.pngUrl))
  Object.assign(split, {
    fileName: '', sourceUrl: '', jobId: '', status: 'empty', error: '',
    image: null, layers: [], background: null, counts: {}, warnings: [],
  })
}
