import { reactive } from 'vue'
import { preloadMattingModel, releaseMattingModel, type MatteProgress } from '@/core/ai-matting'
import { workspace } from '@/store/workspace'

/**
 * AI 模型加载状态共享 store。
 *
 * 此前模型状态是「抠图」页的组件内局部变量，视频帧一键处理弹窗无法感知模型是否已加载。
 * 上移到这里后，两处读到的是同一份状态、同一个加载 Promise：
 * 在任何一处加载完成，另一处立刻显示「已加载」，也不会并发重复下载同一模型。
 */

export type ModelState = 'unknown' | 'loading' | 'ready' | 'error'
export type ModelEngine = 'imgly' | 'rmbg'

export interface ModelStatusEntry {
  state: ModelState
  message?: string
}

/** 按「引擎 | 模型 id | 精度 | 设备 | 托管源 | 资源地址」拼 key：任一参数变化 key 即变化，旧状态自动失效 */
export function matteModelKey(engine: ModelEngine): string {
  const ai = workspace.matte
  if (engine === 'imgly') return `imgly|${ai.imglyModel}|${ai.aiDevice}|${ai.imglyPublicPath}`
  return `rmbg|${ai.rmbgModelId}|${ai.aiDtype}|${ai.aiDevice}|${ai.aiModelHost}`
}

export const modelStatus = reactive<Record<string, ModelStatusEntry>>({})

/** 状态文案，供界面展示 */
export function modelStateLabel(state: ModelState): string {
  return state === 'ready' ? '已加载' : state === 'loading' ? '加载中…' : state === 'error' ? '加载失败' : '未加载'
}

/** 写入指定 key 的模型状态 */
export function setModelState(key: string, state: ModelState, message?: string): void {
  modelStatus[key] = { state, message }
}

/** 正在加载中的 Promise，命中即复用，避免并发重复初始化同一模型 */
const pendingLoads = new Map<string, Promise<void>>()

/**
 * 确保指定引擎的模型已加载。
 * ready 立即返回；loading 复用同一个 pending Promise；error 允许重试；
 * 未加载时才真正下载并初始化模型（内部复用 ai-matting 的实例缓存）。
 */
export async function ensureMatteModelLoaded(engine: ModelEngine, onProgress?: (progress: MatteProgress) => void): Promise<void> {
  const key = matteModelKey(engine)
  const current = modelStatus[key]
  if (current?.state === 'ready') return
  const pending = pendingLoads.get(key)
  if (pending) return pending
  const ai = workspace.matte
  const task = (async () => {
    setModelState(key, 'loading')
    try {
      if (engine === 'imgly') {
        await preloadMattingModel({ engine: 'imgly', model: ai.imglyModel, device: ai.aiDevice, maxSide: 1, publicPath: ai.imglyPublicPath || undefined, onProgress })
      } else {
        await preloadMattingModel({ engine: 'rmbg', modelId: ai.rmbgModelId, dtype: ai.aiDtype, device: ai.aiDevice, modelHost: ai.aiModelHost, maxSide: ai.aiMaxSide, onProgress })
      }
      setModelState(key, 'ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : '模型加载失败'
      console.error('[模型加载失败]', { engine, modelKey: key, error })
      setModelState(key, 'error', message)
      throw error
    }
  })()
  pendingLoads.set(key, task)
  try {
    await task
  } finally {
    pendingLoads.delete(key)
  }
}

/**
 * 卸载指定引擎：释放底层 ONNX 会话（归还 wasm 堆内存）并清掉界面状态。
 * 加载中的任务不做处理——会话已经建到一半，中途清状态只会让界面与实际不符；
 * 卸载按钮在「加载中」时本就不可点。
 * @param engine 目标引擎
 */
export async function releaseMatteModel(engine: ModelEngine): Promise<void> {
  await releaseMattingModel(engine)
  delete modelStatus[matteModelKey(engine)]
}

/** 全局「模型管理」弹窗的开关：顶部栏入口与弹窗自身读写同一份状态 */
export const modelManager = reactive({ open: false })