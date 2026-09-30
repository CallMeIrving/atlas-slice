# Electron 化 + Python/模型拆分 + 统一按需下载 架构方案

## 背景与目标

当前是「前后端分离的纯 Web 应用」，模型分散在两处、两套下载、两个清单：

| 用途 | 运行时 | 权重位置 | 下载器 | 清单 |
|---|---|---|---|---|
| 抠图 RMBG/ISNet | 浏览器渲染进程（transformers.js / @imgly/background-removal） | `public/models/`（294M） | `scripts/download-models.mjs`（Node） | `src/core/model-registry.json` |
| 图层拆分 GroundingDINO/SAM/Florence-2 | Python（FastAPI + torch，`server/`） | `server/models/`（3.2G） | `server/scripts/download_models.py` | `server/app/models/registry.py` |

目标（已与用户确认）：
1. **改成 Electron 项目**（先搭开发态：主进程拉起 Python、IPC 打通；打包作为后续阶段）。
2. **拆分 Python**：`server/` 独立为顶层 `backend/`。
3. **统一模型目录**：`public/models/` 与 `server/models/` 合并为单一顶层 `models/`。
4. **抠图推理仍留在浏览器**（transformers.js / imgly），只统一「存放 + 下载」，不改执行。
5. **保留纯 Web 运行**（`pnpm dev` / `vite build`）。
6. **按需下载**：各模型首次用到时才下载，界面可预下载，Electron 下支持应用内下载。

## 目标目录结构

```
atlas-slice/
├── electron/                      # 新增：Electron 主进程 + 预加载
│   ├── main.ts                    # 窗口创建 + 拉起 Python 子进程 + IPC
│   └── preload.ts                 # contextBridge 暴露 window.atlasSlice
├── src/                           # 渲染进程（Vue，基本不动）
├── backend/                       # 原 server/ 整体迁入（Python 后端）
│   ├── app/                       #   app/models/ 是 Python 代码包（registry/download），随迁，不拆
│   ├── scripts/  tests/  requirements*.txt  pyproject.toml  README.md  Makefile
├── models/                        # 统一模型目录（新建，整体 git-ignore）
│   ├── briaai/RMBG-1.4/                       # 浏览器抠图 RMBG（原 public/models/briaai）
│   ├── @imgly/background-removal-data/dist/   # 浏览器抠图 ISNet（原 public/models/@imgly）
│   ├── IDEA-Research/grounding-dino-tiny/     # torch 检测（原 server/models/...）
│   ├── facebook/sam-vit-base/                 # torch 分割
│   └── microsoft/Florence-2-base-ft/          # torch OCR
├── public/                        # 静态资源，移除 models/
├── scripts/
│   ├── download-models.mjs        # 改写到 models/
│   └── gen-test-atlas.mjs
├── dist-electron/                 # 新增：Electron 主进程编译产物（git-ignore）
└── package.json                   # 增 electron 相关脚本与依赖
```

说明：root `models/`（权重）与 `backend/app/models/`（Python 代码包）同名不同义，路径不冲突，后者随 `backend/` 迁入不变。

---

## Phase 0：统一模型目录 `models/`

1. 新建根目录 `models/`。
2. 本地移动现有权重（权重本身已被 `.gitignore` 忽略，直接 `mv`，无需 `git mv`）：
   - `server/models/*` → `models/`（3 个 torch 仓库 + 其 `.cache/huggingface` 下载缓存）
   - `public/models/*` → `models/`（`briaai/RMBG-1.4` + `@imgly/background-removal-data`）
3. 删除空的 `server/models/`、`public/models/`。
4. 更新 `.gitignore`：移除 `public/models/*`、`server/models/`，改为 `models/`（整目录忽略）。
5. 更新 `backend/app/config.py`：`DEFAULT_MODELS_DIR = SERVER_ROOT / "models"` → `SERVER_ROOT.parent / "models"`（保持 `LAYER_SPLIT_MODELS_DIR` 环境变量覆盖能力）。
6. 更新 `scripts/download-models.mjs`：`MODELS_DIR = join(ROOT, 'models')`（原 `public/models`）；imgly 镜像目录随之落到 `models/@imgly/background-removal-data/dist/`。

参考现有实现：
- [config.py](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/server/app/config.py) 的 `DEFAULT_MODELS_DIR`/`SERVER_ROOT`
- [download-models.mjs](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/scripts/download-models.mjs) 的 `MODELS_DIR`/`IMGLY_MIRROR_DIR`

## Phase 1：拆分 Python `server/` → `backend/`

用 `git mv server backend` 保留历史，随后逐处更新引用：

1. `package.json`：
   - `server:dev` → `backend:dev`，命令内 `cd server` → `cd backend`
   - `server:models` → `backend:models`，命令内 `cd server` → `cd backend`
2. `vite.config.ts`：`/layer-api` 代理 target `127.0.0.1:8000` 不变，无需改。
3. `src/core/layer-split.ts`：`DEFAULT_SERVER = 'http://127.0.0.1:8000'` 不变。
4. `src/components/ServerModelCard.vue`：文案 `server/README.md` → `backend/README.md`、`npm run server:dev` → `npm run backend:dev`。
5. `backend/server/README.md` → 顶层推进到 `backend/README.md`，其中启动命令、`server/` 路径字样同步改。
6. `backend/server/.gitignore`、`Makefile` 随迁；`Makefile` 内路径若写死 `cd server` 则同步。
7. `backend/app/config.py` 注释里「server/models」等字样与 `SERVER_ROOT`/`DEFAULT_TMP_DIR` 依据新位置核对（`SERVER_ROOT = Path(__file__).resolve().parent.parent` 现在指向 `backend/`，天然正确）。

## Phase 2：让 `/models/` 在 Web 端可访问

`models/` 移出 `public/` 后，浏览器访问 `LOCAL_MODEL_ROOT='/'/models/` 需要新的静态供给：

1. 扩展 [vite.config.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/vite.config.ts)：把现有 `modelAssetNotFoundPlugin` 改为「`/models/*` → `<root>/models/*`」的静态文件服务中间件（按扩展名给 content-type；缺失返回 404）。不引入新依赖，用 `fs.createReadStream` 实现。
   - 注意：`watch.ignored` 里 `**/server/**` 需同步调整为 `**/backend/**`，且模型目录不再在 `public` 下，无需额外 watch 排除（`models/` 位于根，Vite 默认不 watch 非 publicDir 目录）。
2. transformers.js / imgly 无需改代码：`LOCAL_MODEL_ROOT='/'/models/`、`IMGLY_MIRROR_PATH` 不变，仅底层由「Vite 静态 public」换成「middleware」供给。
3. 生产 Web（`vite build`）说明：`models/` 不在 `dist/` 内，交付时需将 `models/` 与 `dist/` 一起部署、由静态服务器把 `/models/` 映到该目录（README 补充一句）。开发态优先，此条仅文档化。

## Phase 3：Electron 开发态骨架

新增依赖（devDependencies）：`electron`、`esbuild`、`wait-on`、`concurrently`。

1. `electron/main.ts`（主进程）：
   - `app.whenReady()` 建 `BrowserWindow`，`webPreferences.preload` 指向 `dist-electron/preload.js`。
   - 加载目标：存在 `process.env.VITE_DEV_SERVER_URL` → `loadURL(localhost:5173)`；否则 `loadFile('../dist/index.html')`（生产，后续阶段）。
   - 拉起 Python：`spawn(backend/.venv/bin/python, ['-m','uvicorn','app.main:app','--host','127.0.0.1','--port', <端口>], { cwd: '<root>/backend' })`。端口选择：默认 8000，被占用则退而找空闲端口。arm64 下 venv python 需 `arch -arm64` 前缀，复用现有 [package.json](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/package.json) `server:dev` 里的检测写法。
   - 启动后轮询 `/api/health` 直到就绪，把 base URL 通过 IPC 暴露给渲染进程；Python 未装/启动失败时置「未就绪」状态，前端沿用现有 `checkServer()` 的「服务未连接」展示，不阻断其它功能。
   - `ipcMain.handle('python:getBaseUrl')` 返回 base URL；`before-quit` 时 `kill` Python 子进程。
   - `ipcMain.handle('model:download', ...)`（应用内下载，配合 Phase 4）。
2. `electron/preload.ts`：
   - `contextBridge.exposeInMainWorld('atlasSlice', { getPythonBaseUrl, onPythonStatus, downloadModel })`。
3. 编译：新增脚本 `esbuild electron/main.ts electron/preload.ts --bundle --platform=node --external:electron --format=cjs --outdir=dist-electron`。
4. `package.json`：
   - `"main": "dist-electron/main.js"`
   - `"dev:electron": "concurrently -k \"vite\" \"esbuild ... --watch\" \"wait-on http://localhost:5173 && electron .\""`
   - 保留 `dev`/`build`/`preview` 纯 Web 脚本不变。
5. 渲染层接入：`src/core/layer-split.ts` 的 `detectApiBase()` 优先取 `window.atlasSlice?.getPythonBaseUrl?.() ?? window.atlasSlice?.getPythonBase?.()`（Electron 下自动连子进程），否则走现有 `localStorage` / `/layer-api` 回退逻辑。新增 `src/types/global.d.ts` 声明 `window.atlasSlice`。

## Phase 4：统一管理界面 + 按需下载

现状：[ModelManagerModal.vue](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/components/ModelManagerModal.vue) 已同时展示浏览器引擎与 [ServerModelCard.vue](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/components/ServerModelCard.vue)（Python），即统一的界面临近就绪。本轮做：

1. **浏览器模型（RMBG/ISNet）应用内下载**：
   - Electron 下：`ModelManagerModal` 的「复制下载命令」改为/增加「直接下载」按钮，走 `window.atlasSlice.downloadModel(...)` → 主进程调用既有 [download-models.mjs](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/scripts/download-models.mjs) 逻辑（把下载器抽成可 `import` 的模块或由主进程 `spawn('node', ['scripts/download-models.mjs', ...])`），进度经 IPC 事件回传。
   - Web 下：保留现有「生成终端命令」体验（浏览器无磁盘写权限）。
2. **torch 模型按需下载**：沿用 Python `/api/models/download` 作业轮询（已实现，[ServerModelCard.vue](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/components/ServerModelCard.vue) 已有「下载权重」按钮），Electron 下会自动连上子进程，无需额外改动。
3. **首次使用自触发**（按需语义）：
   - 抠图/视频一键处理：`inspectLocalRepo` 判 `!ready` 时，Electron 下自动经 IPC 触发下载后再加载；Web 下抛出现有可读错误 + 命令提示。
   - 图层拆分：Python 已返回 `MODEL_MISSING` + 下载 hint；Electron 下可弹出建议触发 `/api/models/download`。
4. **manifest 处置**：浏览器 `src/core/model-registry.json` 与 Python `backend/app/models/registry.py` 描述的是**互不相交的模型集合**（无重复无漂移风险），为最小改动先各自保留；「统一」落在「同一目录 + 同一界面 + 同一按需下载入口」。若后续要单点清单，可再把 Python 的 `registry.py` 改为读共享 JSON（列为后续可选，不在本轮）。

## 交付范围边界

- 本轮：Phase 0–4（目录拆分、Python 独立、模型统一、Electron 开发态、按需下载）。
- 追加完成：`electron-builder` 打包（macOS arm64，dmg/zip，见 [electron-macos打包方案.md](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/.trae/documents/electron-macos打包方案.md)）+ Python 用 PyInstaller 打成自包含可执行并随包分发（`pnpm backend:freeze`）。
- 明确跳过：生产 Electron 下用自定义协议/IPC 供给模型替代回环 HTTP 静态服务 —— 现有回环 HTTP 静态服务功能等价，改协议要动渲染层（`inspectLocalRepo` 的 HEAD 探测、ORT wasm、imgly 的 `new URL(name, publicPath)`）且有回归风险，零收益。

## 实施进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 0 | 统一模型目录 `models/` | 已完成 |
| Phase 1 | `server/` → `backend/` 拆分 | 已完成 |
| Phase 2 | `/models/` 在 Web 端可访问（Vite 中间件 + 生产静态供给说明） | 已完成 |
| Phase 3 | Electron 开发态骨架（主进程 / 预加载 / IPC / 子进程拉起） | 已完成 |
| Phase 4.1 | 浏览器模型（RMBG/ISNet）应用内下载（IPC） | 已完成 |
| Phase 4.2 | torch 模型按需下载（复用 `/api/models/download`） | 已完成 |
| Phase 4.3 | 首次使用自触发下载（图层拆分 `MODEL_MISSING` 就地下载并重试） | 已完成 |
| Phase 3 追加 | 关闭窗口即停 Python 子进程；`activate` 时补拉起 | 已完成 |
| 阶段 5 | electron-builder 打包（macOS Apple Silicon，dmg + zip） | 已完成 |
| 阶段 6 | Python 冻结成自包含可执行并随包分发（PyInstaller `--onedir`） | 已完成 |

待完成 / 后续可选：

- **代码签名与公证**：当前 `mac.identity: null`，仅本机与内网分发（分发前需 `xattr -dr com.apple.quarantine`）。
- **单点模型清单**：浏览器 `src/core/model-registry.json` 与 Python `backend/app/models/registry.py` 仍各自保留（集合互不相交），如需单点可把后者改为读共享 JSON。
- **自定义协议供给模型**：已评估并跳过（理由见上）。

已完成（追加）：

- **应用图标**：`public/assets/logo.png` 换成 1024×1024 带透明边的图标版，`mac.icon` 指向它，electron-builder 生成 `icon.icns`。

## 需修改/新增的关键文件清单

- 改：[package.json](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/package.json)、[vite.config.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/vite.config.ts)、[.gitignore](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/.gitignore)、[scripts/download-models.mjs](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/scripts/download-models.mjs)、[backend/app/config.py](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/backend/app/config.py)、[src/core/layer-split.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/core/layer-split.ts)、[src/components/ServerModelCard.vue](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/components/ServerModelCard.vue)、[src/components/ModelManagerModal.vue](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/components/ModelManagerModal.vue)、[README.md](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/README.md)
- 迁：`server/` → [backend/](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/backend)（`git mv`，保留历史）
- 新增：[electron/main.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/electron/main.ts)、[electron/preload.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/electron/preload.ts)、[src/types/global.d.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/types/global.d.ts)、`models/`（目录）、`dist-electron/`（目录）
- 新增（打包阶段）：[electron-builder.yml](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/electron-builder.yml)、[backend/scripts/serve.py](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/backend/scripts/serve.py)

## 验证方式

1. `pnpm install`（装 electron/esbuild/wait-on/concurrently）。
2. 纯 Web：`pnpm dev` → 页面加载，抠图页选 RMBG 走 `/models/` 中间件供给，本地权重可加载；`pnpm build && pnpm preview` 无类型错误。
3. Python：`pnpm backend:dev`，模型已移到 `models/` 后，「图层拆分」页 `checkServer` 返回在线、各 torch 权重「就位」，可正常拆分。
4. 下载脚本：`pnpm models:download` 落在 `models/`（RMBG）、`pnpm models:download -- --imgly` 落 `models/@imgly/...`；`pnpm backend:models` 落 torch 权重。
5. Electron：`pnpm dev:electron` → 窗口打开加载应用，Python 子进程自动拉起、`getPythonBaseUrl` 生效，抠图与图层拆分均可跑；关闭窗口 Python 子进程随之退出。
6. Python 测试（免权重用例）：`cd backend && .venv/bin/python -m pytest -q`。