import { reactive } from 'vue'

export type WorkspacePage = 'atlas' | 'matte' | 'video'

export type MatteMode = 'auto' | 'color' | 'solid' | 'imgly' | 'birefnet' | 'rmbg' | 'sam'

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
  birefnetModelId: string
  rmbgModelId: string
  samModelId: string
  /** SAM 交互状态 */
  samBoxes: { x1: number; y1: number; x2: number; y2: number }[]
  samPoints: { x: number; y: number; label: 0 | 1 }[]
  samTool: 'box' | 'fg' | 'bg'
  /** AI 处理状态（进度文本/百分比） */
  aiStatus: string
  aiProgress: number
  status: 'empty' | 'ready' | 'processing' | 'done' | 'error'
}

export interface VideoFrame {
  id: string
  url: string
  timestamp: number
  selected: boolean
}

export interface VideoState {
  fileName: string
  sourceUrl: string
  duration: number
  width: number
  height: number
  fps: number
  outputWidth: number
  outputHeight: number
  flipX: boolean
  rotation: 0 | 90 | 180 | 270
  batchMatte: boolean
  matteTolerance: number
  error: string
  start: number
  end: number
  mode: 'count' | 'fps'
  count: number
  targetFps: number
  frames: VideoFrame[]
  status: 'empty' | 'ready' | 'processing' | 'done' | 'error'
}

export const workspace = reactive({
  page: 'atlas' as WorkspacePage,
  matte: {
    fileName: '', sourceUrl: '', resultUrl: '', mode: 'auto', background: 'checker',
    tolerance: 24, cropTransparent: true, brushSize: 24, sampledColor: '', status: 'empty',
    aiMaxSide: 0, imglyModel: 'isnet_fp16', imglyPublicPath: '', aiDevice: 'cpu', aiDtype: 'fp32', aiModelHost: 'huggingface.co',
    birefnetModelId: 'onnx-community/BiRefNet_lite', rmbgModelId: 'briaai/RMBG-1.4', samModelId: 'Xenova/sam-vit-base',
    samBoxes: [], samPoints: [], samTool: 'box', aiStatus: '', aiProgress: -1,
  } as MatteState,
  video: {
    fileName: '', sourceUrl: '', duration: 0, width: 0, height: 0, fps: 30,
    start: 0, end: 0, mode: 'count', count: 12, targetFps: 12, outputWidth: 0, outputHeight: 0, flipX: false, rotation: 0, batchMatte: false, matteTolerance: 24, error: '', frames: [], status: 'empty',
  } as VideoState,
})

const SETTINGS_KEY = 'atlas-slice:media-settings'
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as { matte?: Partial<MatteState>; video?: Partial<VideoState> } | null
  if (saved?.matte) Object.assign(workspace.matte, saved.matte)
  if (saved?.video) Object.assign(workspace.video, saved.video)
} catch { /* ignore invalid local settings */ }

export function persistMediaSettings(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    matte: { mode: workspace.matte.mode, background: workspace.matte.background, tolerance: workspace.matte.tolerance, cropTransparent: workspace.matte.cropTransparent, aiMaxSide: workspace.matte.aiMaxSide, imglyModel: workspace.matte.imglyModel, imglyPublicPath: workspace.matte.imglyPublicPath, aiDevice: workspace.matte.aiDevice, aiDtype: workspace.matte.aiDtype, aiModelHost: workspace.matte.aiModelHost, birefnetModelId: workspace.matte.birefnetModelId, rmbgModelId: workspace.matte.rmbgModelId, samModelId: workspace.matte.samModelId },
    video: { mode: workspace.video.mode, count: workspace.video.count, targetFps: workspace.video.targetFps, outputWidth: workspace.video.outputWidth, outputHeight: workspace.video.outputHeight, flipX: workspace.video.flipX, rotation: workspace.video.rotation, batchMatte: workspace.video.batchMatte, matteTolerance: workspace.video.matteTolerance },
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
