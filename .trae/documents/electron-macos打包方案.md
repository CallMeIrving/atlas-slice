# Electron macOS 打包方案（electron-builder）

## Context

开发态 Electron 已跑通（[electron/main.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/electron/main.ts) 拉起 Python、IPC 打通）。本轮把应用打成可分发的 macOS（Apple Silicon）安装包。

已确认的三项决策：
1. **Python 后端随包分发**：`backend:freeze`（PyInstaller `--onedir`）把 `backend/` 冻结成自包含可执行文件，落到 `backend/dist/atlas-backend/`，经 `extraResources` 打进 `Contents/Resources/backend/atlas-backend/`；主进程直接 spawn 它，**不再依赖外部 `.venv`**。若设置了 `ATLAS_BACKEND_ROOT` 仍优先用外部 backend。
2. **仅 macOS Apple Silicon**（dmg + zip）。
3. **模型权重不入包**：首次使用时下载到用户数据目录，而不是只读的 app 包内。

两个关键事实决定了设计：
- `backend/.venv` 773MB，且 `python3` 是指向系统 `python.org 3.10` 的软链，**不可重定位** —— 直接拷 venv 进包不能自包含。改用 PyInstaller 冻结：它把解释器与依赖一起收进 `--onedir` 产物，实测能打包 torch 2.5.1 + MPS（默认 hook 足够，无需 `--collect-all`），产物约 393MB（`torch` 234M、`transformers` 42M、`numpy` 32M）。
- 浏览器抠图走 transformers.js / @imgly / onnxruntime，三者都假定 **http(s) 同源** 资源地址。因此生产态**不引入自定义协议**，改为在主进程起一个回环静态服务，让 `/models/*` 与 `/assets/*` 的 URL 形态与开发态完全一致 —— 这样 `LOCAL_MODEL_ROOT='/models/'` 等全部渲染层代码**零改动**。

## 目标与范围

- 产出 `release/` 下的 `AtlasSlice.app`、`.dmg`、`.zip`（arm64）。
- 保持纯 Web（`pnpm dev` / `pnpm build`）与开发态 Electron 不回归。
- **不做**：代码签名 / 公证、Windows/Linux、应用图标（沿用 Electron 默认图标）。

## 关键设计

### 生产态用回环静态服务替代 `file://` 加载

打包后不再 `loadFile(dist/index.html)`，而是：

- 主进程用 Node `http` 起一个只绑 `127.0.0.1`、随机空闲端口的静态服务；
- 路由：`/models/*` → 可写模型目录；其余 → `dist/`（SPA 回落到 `index.html`）；
- 支持 `GET/HEAD/Range`（大 onnx 分片与 `inspectLocalRepo` 的 HEAD 探测都依赖）、按扩展名给 MIME（复用 [vite.config.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/vite.config.ts#L13-L21) 的映射，补 `.wasm`）、目录穿越防护；
- 就绪后 `mainWindow.loadURL('http://127.0.0.1:<port>/')`。

收益：页面是同源 http，`/assets/...`（Vite 默认 `base:'/'`）与 `/models/...` 都能直接命中，**无需改 `vite.config.ts` 的 base，也无需把 `LOCAL_MODEL_ROOT` / `IMGLY_MIRROR_PATH` 改成函数**；transformers.js 会把它当合法 http 地址，imgly 的 `new URL(name, publicPath)` 与 onnxruntime 的 fetch 全都自然可用。

### 可写目录（dev / prod 分流）

| 用途 | 开发态 | 打包态 |
|---|---|---|
| 模型 | 仓库根 `models/` | `app.getPath('userData')/models` |
| Python 临时产物 | `backend/tmp/` | `app.getPath('userData')/tmp` |
| 后端 | 仓库根 `backend/` 的 `.venv` | 随包冻结可执行 `Resources/backend/atlas-backend/atlas-backend`；`ATLAS_BACKEND_ROOT` 优先 |

Python 子进程经 env 注入 `LAYER_SPLIT_MODELS_DIR` / `LAYER_SPLIT_TMP_DIR`（[config.py](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/backend/app/config.py#L20-L36) 已支持 `LAYER_SPLIT_` 前缀覆盖）。

## 实施步骤

### 1. 依赖与脚本（[package.json](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/package.json)）
- 新增 devDependency：`electron-builder`（^25）；`backend/requirements-dev.txt` 新增 `pyinstaller`。
- 新增脚本：
  - `pack:dir`：`pnpm build && pnpm electron:build && pnpm backend:freeze && electron-builder --mac --arm64 --dir`（快速冒烟，出 .app 不出 dmg）
  - `dist:mac`：`pnpm build && pnpm electron:build && pnpm backend:freeze && electron-builder --mac --arm64`
  - `backend:freeze`：PyInstaller 冻结后端（见步骤 7）
- [.gitignore](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/.gitignore) 追加 `release/`、`backend/dist/`、`backend/build/`。

### 2. electron-builder 配置（新增 `electron-builder.yml`）
- `appId: com.atlasslice.app`；`productName: AtlasSlice`；`directories.output: release`；`asar: true`。
- `files` 白名单：`dist/**`、`dist-electron/**`、`package.json`（**排除** `src/`、`backend/`、`models/`、`test-fixtures/`、`public/test-assets/`）。
- `extraResources`：`scripts/download-models.mjs`、`src/core/model-registry.json`（下载脚本的清单）、`backend/dist/atlas-backend` → `backend/atlas-backend`（冻结后端；缺失时 electron-builder 会直接报错）。
- `mac`：`target: [{target: dmg, arch: [arm64]}, {target: zip, arch: [arm64]}]`、`category: public.app-category.graphics-design`。
- 暂不写 `icon`（`public/assets/logo.png` 仅 256×256，低于 512 会被回退为默认图标）；后续加 `build/icon.png`（≥1024）即可。

### 3. 主进程改造（[electron/main.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/electron/main.ts)）
- `root` 拆成 `appRoot = isDev ? join(__dirname,'..') : app.getAppPath()` 与 `resources = isDev ? appRoot : process.resourcesPath`。
- 新增静态服务模块（可内联在 main.ts 或拆 `electron/static-server.ts`）：起服务、暴露 `port`、`app.on('before-quit')` 时关闭。
- `createWindow()` 生产分支改为 `loadURL(http://127.0.0.1:<port>/)`。
- Python 子进程（`startPython()`）：解析顺序为 **外部 backend（`ATLAS_BACKEND_ROOT`，或用 `pythonVenvPath()` 探测到的 venv）→ 随包冻结可执行（`bundledBackendExe()`）→ `missing`**。外部走 `arch -arm64 <venv> -m uvicorn app.main:app`，随包直接 spawn `Resources/backend/atlas-backend/atlas-backend`（无需 arch 包装），两者都经 `--host/--port` 传动态端口并注入 `LAYER_SPLIT_MODELS_DIR`/`LAYER_SPLIT_TMP_DIR`。
- `downloadModel()`（[L107-L142](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/electron/main.ts#L107-L142)）：脚本路径改为 `join(resources,'scripts','download-models.mjs')`，`cwd: resources`，env 加 `ATLAS_MODELS_DIR=<modelsDir>`、`ATLAS_MANIFEST_PATH=join(resources,'model-registry.json')`。

### 4. 下载脚本（[scripts/download-models.mjs](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/scripts/download-models.mjs)）
- `MODELS_DIR = process.env.ATLAS_MODELS_DIR ?? join(ROOT,'models')`；`MANIFEST_PATH = process.env.ATLAS_MANIFEST_PATH ?? join(ROOT,'src','core','model-registry.json')`。
- `installedVersion()`（L42）在无 `node_modules` 时回退到 `--source=` 或一个固定版本常量，避免打包态抛错。

### 5. 渲染层
- [src/main.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/main.ts#L11-L17)：Electron 下**跳过 Service Worker 注册**（`if (window.atlasSlice) return`）。`file://` 不允许 SW，且本地权重已在磁盘，用 Cache Storage 再存一份只会重复占用 GB 级空间。
- 其余渲染层代码（`LOCAL_MODEL_ROOT`、`IMGLY_MIRROR_PATH`、`inspectLocalRepo`、`ai-matting`）**不改**。

### 6. 文档（[README.md](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/README.md)）
- 补「打包」小节：`pnpm pack:dir` / `pnpm dist:mac`（均前置 `backend:freeze`）、产物在 `release/`、未签名（Gatekeeper 需 `xattr -dr com.apple.quarantine`）、首次使用模型按需下载到 `userData/models`、图层拆分由随包冻结后端提供（`ATLAS_BACKEND_ROOT` 可覆盖为外部 backend）。

### 7. 冻结 Python 后端（`backend/scripts/serve.py` + `backend:freeze`）
- 新增 `backend/scripts/serve.py`：`from app.main import app` 后 `uvicorn.run(app, host, port)`。冻结后无法再用 `uvicorn app.main:app` 的字符串导入，必须直接传应用对象；`--host/--port` 走命令行，默认值取 `Settings`，并调用 `multiprocessing.freeze_support()`。
- `backend:freeze` 脚本要点（macOS 专属）：
  - `PYINSTALLER_CONFIG_DIR` 必须指向可写目录（用 `backend/build/pyinstaller`）——默认的 `~/Library/Application Support/pyinstaller` 常被沙箱/权限拦截；
  - `arch -arm64` 后面**必须跟绝对路径**的 python（相对路径会报 `No such file or directory`）；
  - 参数：`--noconfirm --clean --onedir --name atlas-backend --paths "$PWD" --distpath "$PWD/dist" --workpath "$PWD/build/pyinstaller/work" --specpath "$PWD/build"`，排除 `matplotlib`/`tkinter`/`pytest`/`IPython` 瘦身，入口 `scripts/serve.py`；
  - 产物 `backend/dist/atlas-backend/`（可执行同名 + `_internal/`），已被 `.gitignore` 忽略。
- 注意：仓库 `.venv` 的 python 是指向系统 python.org 3.10 的软链，冻结后不携带该解释器依赖，可自包含迁移。

## 验证

1. `pnpm pack:dir` → 打开 `release/mac-arm64/AtlasSlice.app`：
   - 窗口正常加载，无 `/assets/*` 404；抠图页可选模型；
   - 点「模型管理 → 直接下载」把 RMBG 权重落到 `~/Library/Application Support/AtlasSlice/models`，随后可「加载到内存」；
   - DevTools 确认 Service Worker 未注册；`/models/...` 请求命中 `127.0.0.1` 静态服务；
   - 不设 `ATLAS_BACKEND_ROOT` 时，图层拆分页应能「服务在线」并完成一次拆分（走 `Resources/backend/atlas-backend/atlas-backend`）。
2. `pnpm dist:mac` → 产出 dmg/zip。
3. `pnpm backend:freeze` 后直接运行 `backend/dist/atlas-backend/atlas-backend --port 8123`，`curl 127.0.0.1:8123/api/health` 返回 200。
4. 回归：`pnpm build`、`pnpm electron:build`、`pnpm backend:dev` + `pytest -q`、`pnpm dev` 纯 Web 下 `/models/` 中间件仍可用。
5. 若 RMBG 加载时仍访问 CDN 取 ort wasm：把 `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{mjs,wasm}` 加入 `extraResources` 并设置 `env.backends.onnx.wasm.wasmPaths`（视验证结果决定，非默认改动）。

## 已知限制

- 无自定义图标（默认 Electron 图标）。
- 未签名/公证，仅本机与内网分发。
- 随包后端不携带模型权重，图层拆分首次使用仍需把权重下到 `userData/models`。
- 包体较大（冻结后端约 400MB，含 torch）。
- `index.html` 引用的 Google Fonts 与首次 ISNet 下载（若未镜像）需要网络。