/**
 * Electron 主进程。
 *
 * 职责：
 * - 拉起本地 Python 图层拆分服务（uvicorn 子进程）：开发态用仓库根 backend/ 的 venv，
 *   打包态优先用随包的冻结可执行文件（backend:freeze 产物），也可用 ATLAS_BACKEND_ROOT 指向外部 backend；
 * - 打包态起一个只绑回环的静态服务，把前端产物（dist/）与可写模型目录（userData/models）以 http 供出 ——
 *   浏览器端 transformers.js / @imgly / onnxruntime 拿到的仍是同源 http 地址，渲染层无需为打包改路径；
 * - IPC：Python 服务地址、浏览器抠图模型的应用内下载。
 * 本文件由 esbuild 编译为 CommonJS（dist-electron/main.cjs），不做类型检查。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { extname, dirname, join, normalize, sep } from 'node:path'

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
/** 开发态：仓库根（dist-electron 的上一级）；打包态：app.asar 根 */
const appRoot = isDev ? join(__dirname, '..') : app.getAppPath()
/** extraResources 的落点：开发态是仓库根，打包态是 Contents/Resources */
const resources = isDev ? appRoot : process.resourcesPath
/** 前端产物目录（开发态由 vite 供出，打包态由下面的静态服务供出） */
const distDir = join(appRoot, 'dist')

/** 模型可写目录：开发态沿用仓库根 models/，打包态落到用户数据目录（app 包内只读） */
function modelsDir(): string {
  return isDev ? join(appRoot, 'models') : join(app.getPath('userData'), 'models')
}
/** Python 临时产物目录 */
function tmpDir(): string {
  return isDev ? join(appRoot, 'backend', 'tmp') : join(app.getPath('userData'), 'tmp')
}
/** Python 后端根目录：允许用 ATLAS_BACKEND_ROOT 指定外部 backend（打包态默认 userData/backend） */
function backendRoot(): string {
  if (process.env.ATLAS_BACKEND_ROOT) return process.env.ATLAS_BACKEND_ROOT
  return isDev ? join(appRoot, 'backend') : join(app.getPath('userData'), 'backend')
}

let mainWindow: BrowserWindow | null = null
let pythonChild: ReturnType<typeof spawn> | null = null
let pythonBaseUrl: string | null = null
/** stopped | starting | ready | missing | error */
let pythonStatus = 'stopped'
let staticServer: Server | null = null
let staticPort = 0
/** 有意停止 Python（窗口全部关闭 / 退出应用）时置位，避免 exit 回调把正常回收当成启动失败 */
let pythonStopping = false

function pythonVenvPath(): string {
  // Windows 下 venv 解释器在 Scripts/ 目录且带 .exe，其余平台走 bin/
  return process.platform === 'win32'
    ? join(backendRoot(), '.venv', 'Scripts', 'python.exe')
    : join(backendRoot(), '.venv', 'bin', 'python')
}

/** 随包分发的冻结后端可执行文件：electron-builder extraResources → Resources/backend/atlas-backend/ */
function bundledBackendExe(): string {
  // Windows 下 PyInstaller 产物带 .exe 后缀
  return join(
    resources,
    'backend',
    'atlas-backend',
    process.platform === 'win32' ? 'atlas-backend.exe' : 'atlas-backend',
  )
}

/** 取一个空闲的 127.0.0.1 端口，避免与本机其它服务冲突 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 8000
      server.close(() => resolve(port))
    })
  })
}

// ---------------------------------------------------------------- 打包态静态服务

/** 按扩展名给 content-type：模型与前端资源都在这里供出 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 请求 URL → 磁盘文件：`/models/` 走可写模型目录，其余走前端产物 */
function resolveRequest(urlPath: string): { filePath: string; root: string } {
  if (urlPath.startsWith('/models/')) {
    return { filePath: join(modelsDir(), urlPath.slice('/models/'.length)), root: modelsDir() }
  }
  return { filePath: join(distDir, urlPath === '/' ? 'index.html' : urlPath.slice(1)), root: distDir }
}

/**
 * 起静态服务（只绑回环、随机端口）。
 * 支持 GET/HEAD 与单段 Range：大 onnx 分片的按需读取、以及渲染层对
 * `/models/...` 的 HEAD 探测（inspectLocalRepo）都依赖它。缺失返回 404，避免把首页 HTML 当模型解析。
 */
function startStaticServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0])
      const { root } = resolveRequest(urlPath)
      let { filePath } = resolveRequest(urlPath)
      // 目录穿越防护：解析后必须仍在根目录内
      const normalizedRoot = normalize(root)
      const normalizedFile = normalize(filePath)
      if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(normalizedRoot + sep)) {
        response.statusCode = 403
        response.end()
        return
      }
      // 前端路由（SPA）未命中的静态文件回落到 index.html；模型请求缺失则如实 404
      if (!existsSync(filePath) && root === distDir) filePath = join(distDir, 'index.html')
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        response.statusCode = 404
        response.end()
        return
      }
      const size = statSync(filePath).size
      response.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader('Cache-Control', 'no-cache')

      const range = request.headers.range
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        const start = match && match[1] ? Number(match[1]) : 0
        const end = match && match[2] ? Number(match[2]) : size - 1
        if (!match || start > end || start >= size) {
          response.statusCode = 416
          response.setHeader('Content-Range', `bytes */${size}`)
          response.end()
          return
        }
        const last = Math.min(end, size - 1)
        response.statusCode = 206
        response.setHeader('Content-Range', `bytes ${start}-${last}/${size}`)
        response.setHeader('Content-Length', String(last - start + 1))
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        createReadStream(filePath, { start, end: last }).pipe(response)
        return
      }

      response.statusCode = 200
      response.setHeader('Content-Length', String(size))
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      createReadStream(filePath).pipe(response)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      staticServer = server
      staticPort = (server.address() as AddressInfo).port
      resolve(staticPort)
    })
  })
}

// ---------------------------------------------------------------- Python 子进程

function broadcastStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('python:status', {
      ready: pythonStatus === 'ready',
      baseUrl: pythonBaseUrl,
      status: pythonStatus,
    })
  }
}

async function waitForHealth(port: number): Promise<void> {
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && pythonChild) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) {
        pythonBaseUrl = base
        pythonStatus = 'ready'
        broadcastStatus()
        return
      }
    } catch {
      // 服务仍在启动，继续轮询
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (pythonChild) {
    pythonStatus = 'error'
    broadcastStatus()
  }
}

function startPython(): void {
  const venvPython = pythonVenvPath()
  const bundledExe = bundledBackendExe()
  // 外部 backend（ATLAS_BACKEND_ROOT）与开发态 venv 优先；两者都没有时再用随包的冻结可执行文件
  const hasExternal = Boolean(process.env.ATLAS_BACKEND_ROOT) || existsSync(venvPython)
  const useBundled = !hasExternal && !isDev && existsSync(bundledExe)
  if (!hasExternal && !useBundled) {
    pythonStatus = 'missing'
    broadcastStatus()
    return
  }
  pythonStatus = 'starting'
  broadcastStatus()

  void (async () => {
    const port = await findFreePort()
    const serveArgs = ['--host', '127.0.0.1', '--port', String(port)]
    let command: string
    let args: string[]
    let cwd: string
    if (useBundled) {
      // 自包含可执行文件：无需 arch 包装，也不依赖外部 venv
      command = bundledExe
      args = serveArgs
      cwd = dirname(bundledExe)
    } else {
      // Apple Silicon 下与 package.json 的 backend:dev 保持一致，用 arch -arm64 前缀
      const isArm = process.platform === 'darwin' && process.arch === 'arm64'
      command = isArm ? 'arch' : venvPython
      args = isArm
        ? ['-arm64', venvPython, '-m', 'uvicorn', 'app.main:app', ...serveArgs]
        : ['-m', 'uvicorn', 'app.main:app', ...serveArgs]
      cwd = backendRoot()
    }
    const child = spawn(command, args, {
      cwd,
      // 把可写目录经 LAYER_SPLIT_* 传给后端，避免它去写 app 包内的只读路径
      env: { ...process.env, LAYER_SPLIT_MODELS_DIR: modelsDir(), LAYER_SPLIT_TMP_DIR: tmpDir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    pythonChild = child
    child.stderr.on('data', (chunk: Buffer) => {
      if (process.env.DEBUG_PYTHON) process.stderr.write(chunk)
    })
    child.on('exit', (code) => {
      pythonChild = null
      pythonBaseUrl = null
      pythonStatus = pythonStopping || code === 0 ? 'stopped' : 'error'
      pythonStopping = false
      broadcastStatus()
    })
    await waitForHealth(port)
  })()
}

/** 主动回收 Python 子进程：窗口全部关闭或退出应用时调用 */
function stopPython(): void {
  if (!pythonChild) return
  pythonStopping = true
  pythonChild.kill()
}

// ---------------------------------------------------------------- 应用内下载模型

/** 应用内下载浏览器抠图模型（RMBG / ISNet 镜像），复用 scripts/download-models.mjs */
async function downloadModel(args: {
  repo?: string | null
  host?: string
  imgly?: boolean
}): Promise<{ ok: boolean; message: string }> {
  const script = join(resources, 'scripts', 'download-models.mjs')
  const argv = [script]
  if (args.imgly) argv.push('--imgly')
  else if (args.repo) argv.push(`--repo=${args.repo}`)
  if (args.host) argv.push(`--host=${args.host}`)

  const sender = mainWindow?.webContents
  return new Promise((resolve) => {
    // 在 Electron 主进程里以纯 Node 方式执行脚本；模型落到可写目录，清单从 Resources 取
    const child = spawn(process.execPath, argv, {
      cwd: resources,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ATLAS_MODELS_DIR: modelsDir(),
        ATLAS_MANIFEST_PATH: join(resources, 'src', 'core', 'model-registry.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderrTail = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString().replace(/\r/g, '').trim()
      if (text) sender?.send('model:download-progress', text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    child.on('error', (error) => {
      resolve({ ok: false, message: error.message })
    })
    child.on('exit', (code) => {
      resolve({ ok: code === 0, message: code === 0 ? '下载完成' : stderrTail || `下载失败（退出码 ${code}）` })
    })
  })
}

// ---------------------------------------------------------------- 窗口

function createWindow(): void {
  mainWindow = new BrowserWindow({
    // 与前端布局下限对齐：body / .app 的 min-width 都是 1400（src/styles/tokens.css、base.css）
    width: 1400,
    height: 800,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!)
  } else {
    // 打包态走回环静态服务：页面与模型同源 http，渲染层无需为打包改路径
    void mainWindow.loadURL(`http://127.0.0.1:${staticPort}/`)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  ipcMain.on('python:getBaseUrl', (event) => {
    event.returnValue = pythonBaseUrl
  })
  ipcMain.handle('model:download', (_event, args) => downloadModel(args))

  mkdirSync(modelsDir(), { recursive: true })
  if (!isDev) await startStaticServer()

  createWindow()
  startPython()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      // 窗口关过就会被回收，重开时补拉起；已在运行则不重复启动
      if (!pythonChild) startPython()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    // macOS 下应用仍驻留 Dock，但按架构文档的约定：没有窗口就不再占用本机推理进程
    stopPython()
  } else {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopPython()
  staticServer?.close()
})