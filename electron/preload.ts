/**
 * Electron 预加载脚本：通过 contextBridge 暴露最小的一组能力给渲染进程。
 * 渲染进程里通过 window.atlasSlice 访问（类型见 src/types/global.d.ts）。
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface AtlasSliceStatus {
  ready: boolean
  baseUrl: string | null
  status: string
}

const bridge = {
  /** 同步取当前 Python 服务地址，未就绪返回 null */
  getPythonBaseUrl: (): string | null => ipcRenderer.sendSync('python:getBaseUrl') as string | null,

  /** 订阅 Python 服务状态变化；返回取消订阅函数 */
  onPythonStatus: (cb: (status: AtlasSliceStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AtlasSliceStatus) => cb(status)
    ipcRenderer.on('python:status', listener)
    return () => ipcRenderer.removeListener('python:status', listener)
  },

  /** 应用内下载浏览器抠图模型（RMBG / ISNet 镜像） */
  downloadModel: (args: { repo?: string | null; host?: string; imgly?: boolean }): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('model:download', args) as Promise<{ ok: boolean; message: string }>,

  /** 订阅下载进度文本 */
  onDownloadProgress: (cb: (text: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, text: string) => cb(text)
    ipcRenderer.on('model:download-progress', listener)
    return () => ipcRenderer.removeListener('model:download-progress', listener)
  },
}

contextBridge.exposeInMainWorld('atlasSlice', bridge)