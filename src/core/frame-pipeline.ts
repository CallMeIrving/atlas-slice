import { nextTick } from 'vue'
import { applyCropToFrames } from '@/core/frame-crop'
import { applyMatteToFrames, type FrameMatteContext } from '@/core/frame-matte'
import { extractFrames, type CancelToken, type ExtractOptions } from '@/core/frame-extract'
import type { ImageCropRect } from '@/core/crop'
import type { VideoFrame } from '@/store/workspace'

/**
 * 视频帧「一键处理」流水线编排。
 *
 * 只负责按 抽帧 → 裁切 → 抠图 的顺序调用各步骤的 core 模块，不重复实现任何单步逻辑：
 * - 抽帧   → core/frame-extract
 * - 裁切   → core/frame-crop（先裁切，抠图后由 frame-matte 自动重算裁切结果）
 * - 抠图   → core/frame-matte
 * 未启用的步骤直接跳过，并把它的权重并入前面的步骤，保证整体百分比单调递增。
 */

export type PipelineStage = 'extract' | 'crop' | 'matte'

export interface PipelineInput {
  extract: ExtractOptions
  /** null = 跳过裁切步骤 */
  crop: ImageCropRect | null
  /** null = 跳过抠图步骤 */
  matte: FrameMatteContext | null
}

export interface PipelineProgress {
  stage: PipelineStage
  done: number
  total: number
  text: string
  /** 整体进度百分比（0-100） */
  percent: number
}

export interface PipelineOptions {
  /** 抽帧结果写入的目标数组（调用方传 workspace.video.frames，中途即可看到结果） */
  frames: VideoFrame[]
  onProgress: (progress: PipelineProgress) => void
  token?: CancelToken
}

export interface PipelineResult {
  /** 中断/失败时停在的阶段 */
  stage: PipelineStage
  cancelled: boolean
  error?: unknown
}

/** 各阶段权重（合计 100）：抽帧固定保留基础权重，裁切与抠图按是否启用分配 */
function stageWeights(input: PipelineInput): Record<PipelineStage, number> {
  const crop = input.crop ? 40 : 0
  const matte = input.matte ? 55 : 0
  return { extract: 100 - crop - matte, crop, matte }
}

/** 单实例锁：同一时间只允许一条流水线在执行，避免重复点击叠加运行 */
let running = false

/**
 * 按 抽帧 → 裁切 → 抠图 顺序执行一键处理。
 * 每完成一步即把结果写入 options.frames；任一步失败或取消时立即返回，并保留已完成的结果。
 */
export async function runFramePipeline(
  video: HTMLVideoElement,
  input: PipelineInput,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { frames: target, onProgress, token } = options
  if (running) return { stage: 'extract', cancelled: false, error: new Error('已有处理任务正在执行') }
  running = true
  const weights = stageWeights(input)
  let stage: PipelineStage = 'extract'
  try {
    // ---- 步骤一：抽帧（始终执行，作为后续步骤的输入） ----
    stage = 'extract'
    onProgress({ stage, done: 0, total: 0, text: '抽帧中…', percent: 0 })
    const extracted = await extractFrames(
      video,
      input.extract,
      (done, total) => onProgress({
        stage,
        done,
        total,
        text: `抽帧 ${done}/${total}`,
        percent: Math.round((weights.extract * done) / Math.max(1, total)),
      }),
      token,
    )
    target.push(...extracted)
    if (token?.cancelled) return { stage, cancelled: true }
    await nextTick()

    // ---- 步骤二：裁切（未启用则跳过，权重已并入抽帧） ----
    if (input.crop) {
      stage = 'crop'
      const base = weights.extract
      onProgress({ stage, done: 0, total: target.length, text: '裁切中…', percent: base })
      await applyCropToFrames(
        target,
        input.crop,
        (done, total) => onProgress({
          stage,
          done,
          total,
          text: `裁切 ${done}/${total}`,
          percent: base + Math.round((weights.crop * done) / Math.max(1, total)),
        }),
        token,
      )
      if (token?.cancelled) return { stage, cancelled: true }
      await nextTick()
    }

    // ---- 步骤三：抠图（未启用则跳过；每帧会按 frame.crop 重算裁切结果） ----
    if (input.matte) {
      stage = 'matte'
      const base = weights.extract + weights.crop
      onProgress({ stage, done: 0, total: target.length, text: '抠图中…', percent: base })
      await applyMatteToFrames(target, input.matte, {
        token,
        onProgress: (done, total) => onProgress({
          stage,
          done,
          total,
          text: `抠图 ${done}/${total}`,
          percent: base + Math.round((weights.matte * done) / Math.max(1, total)),
        }),
      })
      if (token?.cancelled) return { stage, cancelled: true }
    }

    onProgress({ stage, done: target.length, total: target.length, text: '处理完成', percent: 100 })
    return { stage, cancelled: false }
  } catch (error) {
    return { stage, cancelled: false, error }
  } finally {
    running = false
  }
}