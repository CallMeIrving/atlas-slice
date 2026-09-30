/**
 * 渲染进程里由 preload 通过 contextBridge 暴露的 Electron 能力。
 * 纯 Web 运行下 window.atlasSlice 为 undefined，调用方需判空。
 */

export interface AtlasSliceStatus {
  ready: boolean
  baseUrl: string | null
  status: string
}

export interface AtlasSliceBridge {
  getPythonBaseUrl(): string | null
  onPythonStatus(cb: (status: AtlasSliceStatus) => void): () => void
  downloadModel(args: { repo?: string | null; host?: string; imgly?: boolean }): Promise<{ ok: boolean; message: string }>
  onDownloadProgress(cb: (text: string) => void): () => void
}

declare global {
  interface Window {
    atlasSlice?: AtlasSliceBridge
  }
}

export {}