/**
 * 模型清单与本地权重状态检测。
 *
 * 清单数据放在同目录的 model-registry.json：Node 下载脚本（scripts/download-models.mjs）
 * 与浏览器端「模型管理」弹窗读的是同一份文件，新增模型只改一处。
 *
 * 浏览器没有文件系统写权限，因此这里只做两件事：探测 public/models 下的文件是否就位、
 * 生成需要用户到终端执行的下载命令；真正的落盘仍由 Node 脚本完成。
 */

import registry from '@/core/model-registry.json'
import type { AiEngine } from '@/core/ai-matting'

/** 本地权重根目录，与 vite 的 public 目录一致 */
export const LOCAL_MODEL_ROOT = '/models/'

/** 模型文件分级：base 为精简集（配置 + 界面默认精度），extra 只在全量下载时才需要 */
export type ModelFileTier = 'base' | 'extra'

export interface ModelFileSpec {
  /** 仓库内相对路径，如 onnx/model_fp16.onnx */
  file: string
  /** 期望字节数，用于校验完整性；0 表示不校验 */
  size: number
  tier: ModelFileTier
  /** 界面提示文案 */
  note?: string
  /** 上游仓库没有该文件时，由下载脚本直接写入的文本内容 */
  content?: string
}

export interface ModelRepoSpec {
  id: string
  label: string
  /** 对应的 AI 引擎，用于与 AI_ENGINES 及模型加载状态关联 */
  engine: AiEngine
  files: ModelFileSpec[]
}

/** 清单里的仓库列表。JSON 的结构由本文件的类型约束，因此这里做一次窄化 */
const manifest = registry as unknown as { repos: ModelRepoSpec[] }

export const MODEL_REPOS: ModelRepoSpec[] = manifest.repos

/**
 * 项目内置权重的仓库目录。
 * transformers.js 只认本地目录，路径必须与下载脚本写入的位置一致。
 * @param modelId 模型 ID（大小写不敏感）；非内置模型返回 undefined
 */
export function localRepoPath(modelId: string): string | undefined {
  const target = modelId.trim().toLowerCase()
  const repo = MODEL_REPOS.find((item) => item.id.toLowerCase() === target)
  return repo ? `${LOCAL_MODEL_ROOT}${repo.id}/` : undefined
}

/** 取某引擎对应的内置仓库；ISNet（imgly）的资源来自官方 CDN，没有本地仓库 */
export function repoForEngine(engine: AiEngine): ModelRepoSpec | undefined {
  return MODEL_REPOS.find((item) => item.engine === engine)
}

/** 本地文件状态：就位 / 缺失 / 大小与清单不符（下载中断留下的残缺文件） */
export type LocalFileState = 'ok' | 'missing' | 'mismatch'

export interface LocalFileStatus extends ModelFileSpec {
  state: LocalFileState
  /** 服务端返回的实际字节数，未知时为 0 */
  actualSize: number
}

export interface LocalRepoStatus {
  repo: ModelRepoSpec
  files: LocalFileStatus[]
  /** base 文件全部就位即可用界面默认精度运行 */
  ready: boolean
  /** 缺失或大小不符的文件（含 extra），供界面提示 */
  missing: string[]
}

/**
 * 用 HEAD 逐个探测仓库文件是否就位。
 * dev 环境由 vite 插件对缺失的 /models 请求返回 404，生产环境静态服务器同样返回 404，
 * 因此「非 2xx」即判定缺失；再比对 content-length 可以发现下载中断留下的残缺文件。
 * @param repo 目标仓库
 */
export async function inspectLocalRepo(repo: ModelRepoSpec): Promise<LocalRepoStatus> {
  const base = `${LOCAL_MODEL_ROOT}${repo.id}/`
  const files = await Promise.all(
    repo.files.map(async (spec): Promise<LocalFileStatus> => {
      try {
        const response = await fetch(`${base}${spec.file}`, { method: 'HEAD', cache: 'no-store' })
        if (!response.ok) return { ...spec, state: 'missing', actualSize: 0 }
        const actualSize = Number(response.headers.get('content-length') ?? 0)
        const state: LocalFileState = spec.size > 0 && actualSize > 0 && actualSize !== spec.size ? 'mismatch' : 'ok'
        return { ...spec, state, actualSize }
      } catch {
        return { ...spec, state: 'missing', actualSize: 0 }
      }
    }),
  )
  return {
    repo,
    files,
    missing: files.filter((file) => file.state !== 'ok').map((file) => file.file),
    ready: files.every((file) => file.tier !== 'base' || file.state === 'ok'),
  }
}

/**
 * 生成把模型补到本地 public/models 的命令，供用户粘贴到终端执行。
 * @param repoId 只下载指定仓库；省略时下载清单里的全部模型
 * @param host 模型源，与界面「托管源」设置保持一致
 */
export function downloadCommand(repoId?: string, host = 'https://hf-mirror.com'): string {
  const parts = ['node scripts/download-models.mjs', `--host=${host}`]
  if (repoId) parts.push(`--repo=${repoId}`)
  return parts.join(' ')
}

/** 字节数 → 便于阅读的体积文案 */
export function formatBytes(bytes: number): string {
  if (!bytes) return '未知'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}