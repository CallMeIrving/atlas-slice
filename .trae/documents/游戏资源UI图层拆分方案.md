# 游戏资源 UI 图层拆分 — 实施方案

## Context

现有 AtlasSlice 是纯前端本地工具（Vue 3 + Vite），所有处理都在浏览器内完成。新需求是**把一张游戏 UI 截图（如商店面板）拆成可独立复用的图层**：自动识别每个 UI 元素（按钮 / 图标 / 文本块 / 面板底板 / 边框 / 装饰 / 进度条），精确抠出带 alpha 的独立 PNG，标注类别与 z-order，供美术直接取用。

浏览器端 ONNX/Transformers.js 无法承载开放词表检测 + 精细分割这类大模型，因此**单独建一个 Python 服务（`server/`）本地推理，通过 HTTP API 对接前端**。

已确认的四项决策：
1. **输出形态**：逐元素拆分 + 语义标注（每元素一层，可勾选 / 改名 / 换序 / 合并 / 导出）
2. **模型路线**：检测 + 分割组合 —— GroundingDINO（开放词表检测）+ SAM（框驱动精细分割），可叠加 Florence-2 做 OCR
3. **目标设备**：Apple Silicon MPS（macOS，`python3` 3.10.4 / arm64），torch 走默认 PyPI
4. **交付范围**：Python 服务 + 前端新页面（导航新增「图层拆分」）

---

## 一、Python 服务 `server/`

### 1.1 目录结构

```
server/
├── README.md                  # 启动 / 下权重 / curl 示例 / 端口与安全声明
├── requirements.txt           # 核心依赖
├── requirements-ocr.txt       # 可选：Florence-2 额外依赖（timm / einops）
├── pyproject.toml             # 仅 [tool.ruff] / [tool.pytest.ini_options]，不重复声明依赖
├── Makefile                   # venv / install / models / run / test / doctor
├── .gitignore                 # .venv/ __pycache__/ models/ tmp/ *.log
├── models/                    # 权重落地（gitignore）
├── tmp/jobs/<job_id>/         # 运行期产物（gitignore）
├── scripts/
│   ├── download_models.py     # snapshot_download + 字节校验 + 镜像源
│   └── doctor.py              # torch 版本 / mps 可用性 / 权重就位 / 磁盘余量
├── tests/                     # conftest.py / test_api.py / test_device.py / test_manifest.py
│                              # test_text_alpha.py / test_pipeline.py
└── app/
    ├── main.py                # create_app()：CORS、路由挂载、异常处理、启动清理
    ├── config.py              # Settings：host/port/模型目录/上限/TTL/设备覆盖
    ├── schemas.py  errors.py  deps.py
    ├── routers/               # health.py  models.py  layers.py
    ├── runtime/               # device.py  model_manager.py  jobs.py  storage.py
    ├── models/registry.py     # SERVER_MODELS 清单（repo_id / role / files+size）
    └── pipeline/
        ├── backends.py        # Protocol: Detector/Segmenter/Ocr + dataclass
        ├── detect_grounding_dino.py   detect_florence2.py(可选)
        ├── segment_sam.py             ocr_florence2.py(可选)
        ├── text_alpha.py  mask_refine.py  zorder.py  background.py
        ├── exporter.py        # layers/*.png + layers.json + atlas.json + bundle.zip
        └── runner.py          # 阶段编排，可脱离 HTTP 单跑
```

### 1.2 依赖（venv + requirements.txt，Python 3.10 / arm64）

```
fastapi==0.115.*      uvicorn[standard]==0.32.*   python-multipart==0.0.12
pydantic==2.9.*       pydantic-settings==2.6.*    pillow==11.*
numpy==1.26.4         opencv-python-headless==4.10.0.84
torch==2.5.1          torchvision==0.20.1         transformers==4.46.3
accelerate==1.1.*     safetensors==0.4.*          huggingface_hub==0.26.*
```
`requirements-ocr.txt`：`timm==1.0.*` `einops==0.8.*`

选型要点（**避免踩坑**）：
- **检测器**用 `transformers.AutoModelForZeroShotObjectDetection` + `AutoProcessor` 加载 `IDEA-Research/grounding-dino-tiny`。4.46 已内置 Swin backbone，无需 `timm`，不引入第三方 git 仓库。
- **分割器**用 `transformers.SamModel` + `SamProcessor` 加载 `facebook/sam-vit-base`，**不用** Meta 原版 `segment-anything`（PyPI 无官方包，且管线是「检测框驱动」，用不上 AMG）。transformers 版支持 `input_boxes` 批量提示，N 个框一次前向。
- **OCR / 备选检测**用 Florence-2（`trust_remote_code=True`），需 `transformers>=4.46`；transformers ≥4.50 会破坏其 remote code，**全工程钉 4.46.3**。
- Florence-2 的 remote code（3 个 .py）必须整仓落地，因此权重**必须整仓 `snapshot_download`**，不能像 `model-registry.json` 里 RMBG 那样手列文件清单 —— 在 registry 里注释说明。

### 1.3 设备与 dtype（`app/runtime/device.py`）

- 优先级：`--device` / 环境变量 `LAYER_SPLIT_DEVICE` → `cuda > mps > cpu`；可选值 `auto|cuda|mps|cpu`，非法值报 `DEVICE_INVALID`。
- **MPS 一律 fp32**，不提供 fp16 开关（MPS 上 fp16 在部分 attention/sdpa 算子会出 NaN）。启动前 `os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")`。
- 任务结束 `torch.mps.empty_cache()`；计时用 `torch.mps.synchronize()`。
- 加载一律 `local_files_only=True`，与项目对 RMBG「缺失文件时阻止远程回退」的策略一致。

---

## 二、API 契约

Base `http://127.0.0.1:8000`，全部挂 `/api`；dev 环境前端走 Vite 代理 `/layer-api`（同源、零 CORS）。

### 2.1 健康 / 系统

- `GET /api/health` → `{ status, version, schema:"atlas-slice.layers/1", device, models_ready, queue_depth }`
- `GET /api/system` → python / torch / transformers 版本、`device{selected,available,override,dtype}`、`limits{max_upload_bytes:20971520, max_side:4096, max_layers:200, max_queue:4}`

### 2.2 模型

- `GET /api/models` → `{ models_dir, models:[{ id, role, repo_id, dir, installed, loaded, load_error, approx_bytes, files:[{file,size,present,actual_size}], missing[] }], download_command }`
- `POST /api/models/download` `{ repo, host }` → `202 { job_id }`（复用作业系统，进度走 tqdm 回调换算）
- `POST /api/models/load` / `unload` `{ role }` → `200 { role, loaded, load_ms }`；权重缺失 → `409 MODEL_MISSING`

### 2.3 拆分任务

`POST /api/layers/split`（`multipart/form-data`：`file` + `params` JSON）

`params` 默认：
```json
{
  "classes": [
    {"label":"按钮","prompt":"button","category":"button"},
    {"label":"图标","prompt":"icon","category":"icon"},
    {"label":"文本","prompt":"text","category":"text"},
    {"label":"面板","prompt":"panel","category":"panel"},
    {"label":"边框","prompt":"border","category":"border"},
    {"label":"装饰","prompt":"decoration","category":"decoration"},
    {"label":"进度条","prompt":"progress bar","category":"progress"}
  ],
  "detector": "grounding-dino", "segmenter": "sam", "ocr": true,
  "box_threshold": 0.30, "text_threshold": 0.25, "nms_iou": 0.55,
  "min_area": 64, "max_layers": 80, "max_side": 1536,
  "background": "inpaint", "exclusive_layers": false, "feather": 1
}
```
> `prompt` 必须英文（模型词表决定），`label` 是界面用中文。这条约束要写进 UI 提示。

→ `202 { job_id, status:"queued", created_at, position }`
错误：`400 BAD_IMAGE` / `415 UNSUPPORTED_MEDIA` / `413 PAYLOAD_TOO_LARGE` / `409 MODEL_MISSING` / `429 QUEUE_FULL`

`GET /api/layers/jobs/{job_id}` → 轮询（**主用轮询，非 SSE**——`TaskProgress` 是 percent 驱动，且 Vite 代理跑 SSE 需额外调 `proxyTimeout`）：
```json
{ "job_id":"…", "status":"running|queued|succeeded|failed|cancelled",
  "stage":"detect|ocr|segment|refine|zorder|background|export|done",
  "stage_progress":0.42, "progress":0.55, "message":"正在分割 12/30（button）",
  "stages":[{"stage":"detect","progress":1.0,"elapsed_ms":18420}],
  "image":{"width":1448,"height":1086,"name":"gameUI.png"},
  "error":null, "elapsed_ms":41230 }
```
`layers` / `background` / `counts` / `manifest_url` / `zip_url` **只在 `succeeded` 时内联**。

`DELETE /api/layers/jobs/{job_id}` → `200 { status:"cancelling" }`；作业线程在**每个阶段与每个元素之间**检查取消标志（对齐 `core/frame-extract.ts` 的协作式取消）。

### 2.4 结果

`GET /api/layers/jobs/{id}/layers`（**按 z 升序 = 从后到前**）：
```json
{ "schema":"atlas-slice.layers/1",
  "source":{"name":"gameUI.png","width":1448,"height":1086,"scale":1.0},
  "layers":[{ "id":"L0007","name":"button_07","label":"按钮","category":"button","score":0.83,
              "bbox":{"x":1180,"y":940,"w":200,"h":64},
              "alpha_bbox":{"x":1184,"y":944,"w":192,"h":54},
              "area":9860,"z":7,"parent_id":"L0001","source":"detect+sam","text":null,
              "png_url":"…/layers/L0007.png","png_cropped_url":"…/layers/L0007.png" }],
  "background":{"id":"L0000","method":"inpaint","z":0,"png_url":"…"},
  "counts":{"panel":1,"button":3,"icon":5,"text":8},
  "manifest_url":"…/manifest.json", "zip_url":"…/bundle.zip" }
```

- `GET …/layers/{layer_id}.png` —— 默认**裁到 `alpha_bbox` 的 RGBA PNG**（前端按 `alpha_bbox.x/y` 绘制拼回原位）；`?canvas=full` 给与原图同尺寸的整幅（默认不给：80 层 × 1448×1086 RGBA ≈ 470MB，会拖垮浏览器）。`Cache-Control: private, max-age=3600`。`layer_id` 必须正则校验（`^[A-Za-z0-9_-]{1,32}$`）防目录穿越。
- `GET …/manifest.json` → 原生清单
- `GET …/bundle.zip` → `source.png` + `background.png` + `layers/NNNN_name_label.png` + `layers.json` + **`atlas.json`（TexturePacker 哈希格式）** + `README.txt`

`atlas.json` 镜像既有约定（对齐 [json.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/core/parsers/json.ts) 与 [export.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/core/export.ts) 的 `FrameMeta`），使**「精灵图」页可直接导入**并把每个元素按 `frame` 从 `source.png` 裁出：
```json
{ "frames": { "0007_button_按钮.png": { "frame":{"x":1184,"y":944,"w":192,"h":54},
    "rotated":false,"trimmed":true,"spriteSourceSize":{...},"sourceSize":{"w":1448,"h":1086} } },
  "meta": { "app":"atlas-slice","image":"source.png","size":{"w":1448,"h":1086},
            "layerSchema":"atlas-slice.layers/1" } }
```

### 2.5 错误模型

```json
{ "error": { "code":"MODEL_MISSING", "message":"检测权重未安装：…",
             "detail":{ "missing":[…], "role":"detect",
                        "hint":"cd server && .venv/bin/python scripts/download_models.py --repo=detect" } } }
```
`code` 枚举：`BAD_IMAGE` `UNSUPPORTED_MEDIA` `PAYLOAD_TOO_LARGE` `INVALID_PARAMS` `DEVICE_INVALID` `MODEL_MISSING` `MODEL_LOAD_FAILED` `OUT_OF_MEMORY` `JOB_NOT_FOUND` `JOB_CANCELLED` `QUEUE_FULL` `INTERNAL`。MPS OOM（`RuntimeError: MPS backend out of memory`）专抓，映射 `OUT_OF_MEMORY` 并给 `suggested_max_side`。

### 2.6 上限 / 临时文件 / 清理 / CORS

- 上传 ≤ 20MB；解码后 `max_side` 默认 1536、硬上限 4096，超出等比缩小并回写 `source.scale`。`max_layers` 默认 80、硬上限 200，超出按 `score × area` 截断并写 `job.warnings`。
- 临时目录 `server/tmp/jobs/<job_id>/`，落盘一律是归一化 PNG（上传原始字节不落盘）。
- `JOB_TTL_SECONDS=3600` + 最多保留 20 个作业（LRU 淘汰）+ 启动全量清扫。作业只存内存，进程重启即失效（前端遇 `404 JOB_NOT_FOUND` 回到 `ready` 并提示「服务已重启」）。
- **串行执行**：`JobManager` 单 worker 线程（MPS 内存不允许并行），队列上限 4。
- **CORS/代理**：
  - dev：`vite.config.ts` 的 `server.proxy` 增加 `/layer-api` → `http://127.0.0.1:8000`（`changeOrigin` + rewrite 去掉前缀），前端用相对路径，**零 CORS 预检**，`<img src>` 预览也直接可用。
  - 兜底：`CORSMiddleware` 用 `allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"`，**不写** `allow_origins=["*"]`。
  - 生产构建：`dist/` 无代理，前端 `detectApiBase()` 回落到 `localStorage['atlas-slice:layer-server'] || 'http://127.0.0.1:8000'`，页面提供「服务地址」输入框。
  - **安全边界**：只绑 `127.0.0.1`，README 明确禁止 `--host 0.0.0.0`；素材只在本机进程与临时目录流转。README 首页「不上传任何服务器」的表述改为三段式：浏览器内处理（默认）→ 本地 Python 服务（仅本机回环）。

---

## 三、算法管线细节（`app/pipeline/`）

阶段：`detect → ocr → segment → refine → zorder → background → export`

1. **detect**：GroundingDINO。**prompt 必须小写 + 每类以句点分隔**（`"button . icon . text ."`），漏句点会静默返回 0 框 —— 这是最常见的「跑通但没结果」故障，要在 `detect_grounding_dino.py` 里做 prompt 归一化，空结果返回 warning 而非空数组。
2. **segment**：SAM 由检测框驱动（SAM 自身无语义，只有 point/box 提示）。**一次前向传多个框**（`processor(image, input_boxes=[[b1,b2,…]], return_tensors="pt")`）远快于逐框循环；`post_process_masks` 需回传 `original_sizes` / `reshaped_input_sizes`，**框坐标用原图尺度**（processor 内部会 resize 到 1024）。
3. **text_alpha**：OCR 框是矩形/四边形，直接给矩形 alpha 会把背景一起抠走。做法：框四边 1-2px 环带中位数估底色 `bg` → 灰度差 `|gray-bg|` 阈值取前景（渐变底退回 `cv2.adaptiveThreshold`）→ **软 alpha** `clip(diff/softness,0,1)*255` 而非二值 → `GaussianBlur(0.6)` → 去 <`min_area` 碎点 + 1px dilate。Florence-2 `<OCR_WITH_REGION>` 给的是 **quad_boxes**，用 `cv2.fillPoly` 建四边形掩膜更准。`text` 类别可跳过 SAM。
4. **zorder**：包含森林（B 是 A 的子层当 `area(A∩B)/area(B) > 0.9` 且 `area(A) > area(B)*1.15`）→ `z_key = (depth, category_rank, -area, y)`（category_rank：panel/background 最低、border 次低、decoration 中、icon/text/progress 高）→ 同类别 IoU>0.85 去重保留高分，跨类别保留并记 `parent_id`。`exclusive_layers`（把子层 alpha 从父层减掉）**默认 false**，UI 写清两种模式差别。
5. **background**：`none`（保留原像素，诚实但带残影）/ `erase`（元素位 alpha 置 0）/ `inpaint`（默认，掩膜 = 元素 alpha 并集再 dilate 3px，`cv2.inpaint(..., INPAINT_TELEA)`；大洞会涂抹丢纹理，UI 需提示局限）。浏览器侧 `core/inpaint.ts` 是 TS，Python 侧无法复用，仅作算法参考。
6. **颜色空间**：PIL 是 RGB(A)，OpenCV 是 BGR(A)；无 alpha 的图先 `convert('RGB')`，别把 4 通道喂进 OpenCV。

---

## 四、前端集成

### 4.1 改动既有文件

| 文件 | 改动 |
|---|---|
| [workspace.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/store/workspace.ts#L5) | `WorkspacePage` 加 `'layersplit'`；新增 `LayerCategory` / `LayerClassSpec` / `LayerSplitSettings` / `SplitLayerState` / `LayerSplitState` + `DEFAULT_LAYER_CLASSES`；`workspace` 加 `layersplit` 条目；持久化块加 `layersplit.settings` 并**按既有白名单模式收敛已下线取值**（classes 过滤未知 category、空则回落默认；detector/segmenter/background/device 白名单）；`persistMediaSettings()` 补一条；新增 `resetLayerSplit()`（只 revoke `sourceUrl` 与客户端 merge 出的 blob URL，服务端 PNG 不用 revoke） |
| [App.vue](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/App.vue#L38) | **必须**把 `WatermarkPage` 的 `v-else` 改成 `v-else-if="workspace.page === 'watermark'"`，再加 `LayerSplitPage v-else-if="workspace.page === 'layersplit'"`，末尾补 `<div v-else>` 未知页兜底 |
| [TopBar.vue](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/components/TopBar.vue#L16-L20) | `pageStatus` **必须**加 `layersplit` 显式分支（否则回落成水印状态）；加 `LAYER_SPLIT_STATUS` 文案表；nav 加第 5 个按钮「图层拆分」+ `nav-dot` |
| [vite.config.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/vite.config.ts#L37-L45) | `server.proxy` 加 `/layer-api`；`server.watch.ignored` 加 `**/server/**`（多 GB 权重在项目根下会拖慢 HMR） |
| 根 `.gitignore` | 加 `server/models/`、`server/tmp/`、`server/.venv/` |
| 根 `package.json` | 加 `"server:dev"` / `"server:models"` 便捷脚本 |
| README.md / 需求文档.md | README 加 server 章节、目录树补 `server/`、本地性表述改三段式；需求文档补新页条目 |

### 4.2 新增前端文件

| 文件 | 职责 |
|---|---|
| `src/core/layer-split.ts` | **前端唯一业务逻辑出口**：`detectApiBase/apiUrl/checkServer/fetchServerModels/requestModelDownload/startSplit/cancelSplit/layerPngUrl/bundleZipUrl/mapJobToLayers/moveLayer/mergeLayers/exportLayersZip/downloadLayerPng/buildLayersManifest`。`startSplit` 内部即「POST + 轮询循环」，把 `stage/stage_progress` 映射为 0-100（detect 0-35 / ocr 35-45 / segment 45-75 / refine 75-85 / zorder 85-90 / background 90-97 / export 97-100），`TaskProgress` 直接吃 `:percent`；轮询 500ms，每次循环检查 `token.cancelled` → `cancelSplit` 并抛错。 |
| `src/components/LayerSplitPage.vue` | 页面骨架，对齐 `WatermarkPage.vue` 的 `.tool-page/.tool-sidebar.panel/.tool-main/.tool-header/.tool-body` 与 320px 左栏；`onMounted` 调 `checkServer()`，离线渲染 `.warn` + 启动命令 + 复制按钮 + 「重试连接」；主按钮「开始拆分」（`btn btn-primary`）；`TaskProgress` 传 `running/percent/text/error/cancelling` + `@cancel`；`watch(settings, deep)` → `persistMediaSettings()` + 作废旧结果 |
| `src/components/LayerSplitSettingsFields.vue` | 类别提示词编辑器（label/prompt/category/开关/删除）+ 预设（商店面板/背包/HUD/战斗结算）+ 阈值与 `background`/`exclusive` 开关。范式对齐 `ExtractSettingsFields.vue` |
| `src/components/LayerSplitList.vue` | 图层列表：缩略图 / 可见性 / 改名（行内 `input`）/ 选中 / 拖拽换序（复用 `VideoPage.moveFrame` 的 `draggingId + dragover.prevent + drop.prevent` 范式）/ 置顶置底 / 合并选中 / 重置。列表**从上到下 = 前景到背景**（降序 z），表头提示「拖拽调整层序」 |
| `src/components/LayerSplitStage.vue` | 预览舞台：棋盘底 + 按 z 叠层合成 + 单层高亮描边 |
| `src/components/ServerModelCard.vue` | 接入 `ModelManagerModal.vue` 的「本地 Python 服务」卡片，复用现有 `.model-card/.file-list/.file-state/.badge` 类，零新增 CSS 体系 |

**合并与导出**：`mergeLayers` 用 `document.createElement('canvas')` 设原图尺寸，按 z 升序遍历 `visible` 层，`ctx.drawImage(await loadImage(layer.pngUrl), layer.alphaBbox.x, layer.alphaBbox.y)`（复用 [image.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/core/image.ts) 的 `loadImage`），最后 `canvasToBlob` + `releaseCanvas`。

**两条导出路径必须区分**（否则用户会觉得「改名没生效」）：
- 主按钮 = **客户端 ZIP**（尊重改名/隐藏/排序/合并，命名走 [export.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/core/export.ts) 的 `applyNaming`），用 `downloadZip(entries, name)`（[media-export.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/core/media-export.ts#L12)），并从 `workspace.layersplit.sourceUrl` 一起写入 `source.png` 保持两包同构；
- 次要按钮 = **服务端 `bundle.zip`**（原样 label，含 `atlas.json`）。

### 4.3 模型管理：最小一致方案

**在 `ModelManagerModal` 加独立「本地 Python 服务」卡片，不把 Python 权重塞进 `model-registry.json`，也不扩 `AiEngine` union。** 理由：
- `LOCAL_MODEL_ROOT='/models/'` + `inspectLocalRepo()` 是浏览器对**同源 `/models/...`** 发 HEAD；Python 权重在 `server/models/`，既不同源也不同路径；
- `downloadCommand()` 生成 `node scripts/download-models.mjs`，对 Python 权重是错命令；
- `ModelRepoSpec.engine: AiEngine` 语义是「抠图引擎」，硬塞会污染 `matting` 分支与 `matteModelKey()`。

代价是模型列表有两个来源，但二者本就是不同运行时（浏览器 ONNX/wasm vs 本机 PyTorch/MPS）、不同下载器、不同设备语义，分开展示更诚实。卡片注明「该组权重由本地 Python 服务管理，不在 public/models 下」。

---

## 五、权重获取

| role | repo_id | 约体积 | 落地路径 |
|---|---|---|---|
| detect | `IDEA-Research/grounding-dino-tiny` | ~694MB | `server/models/IDEA-Research/grounding-dino-tiny/` |
| segment | `facebook/sam-vit-base` | ~375MB | `server/models/facebook/sam-vit-base/` |
| ocr（可选） | `microsoft/Florence-2-base-ft` | ~464MB | `server/models/microsoft/Florence-2-base-ft/` |

默认三件套 ~1.53GB；含 Florence-2 ~2.0GB。冷启动首次推理额外 15-45s（权重首次读入 + MPS kernel 编译），`POST /api/models/load` 可提前预热。

`server/scripts/download_models.py` 对齐 `scripts/download-models.mjs` 的约定（`.part`+续传+字节校验+镜像源），但复用 `snapshot_download` 自带的 `.incomplete` + Range 续传：
```python
# 关键顺序：先设 HF_ENDPOINT，再 import huggingface_hub
os.environ.setdefault("HF_ENDPOINT", os.environ.get("MODEL_HOST", "https://hf-mirror.com"))
from huggingface_hub import snapshot_download
```
参数 `--repo=detect|segment|ocr|all`、`--host=`、`--force`、`--list`、`--check`；不设 `allow_patterns`（Florence-2 remote code 必须全量落地）。校验 `registry.py` 里的 `size` 与 `stat().st_size`，不符打印警告并以非 0 退出。

**绝不允许静默降级**：缺权重 → `409 MODEL_MISSING` + hint 命令；页面禁用主按钮；不允许自动把 `segmenter` 降成 `none` 或静默换 CPU 返回半成品。

---

## 六、风险要点（按严重度）

1. **MPS + fp16 = NaN/崩溃** → 恒 fp32 + `PYTORCH_ENABLE_MPS_FALLBACK=1`。
2. **内存（最现实）**：GroundingDINO-tiny + SAM-ViT-B 同时驻留 + 1024² 激活，峰值 RSS 3-4GB；macOS 统一内存下易触发 swap。缓解：阶段串行 + **阶段间互斥驻留**（detect 完 unload 检测器再 load 分割器）+ 单 worker + `empty_cache()` + `max_side` 默认 1536 + OOM 映射上限建议。**不默认上 SAM-ViT-H**（2.4GB）。
3. **首请求延迟** 15-45s 易被当成卡死 → 预热 + 文案明确「首次加载模型，约 20-40 秒」。
4. **prompt 缺句点静默返回 0 框** → 归一化 + warning。
5. **嵌套重叠**：button 内含 icon/label 时全合并会把半透明边缘叠两次 → 包含森林 + z 排序 + 去重（见三.4）。
6. **Vite 监视 `server/`** → `watch.ignored`。
7. **作业只在内存** → `404 JOB_NOT_FOUND` 时回 `ready` 态而非无限轮询。

---

## 七、分期顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | `server/` 骨架（main/config/errors/schemas/health/doctor/requirements/Makefile） | — |
| P1 | `models/registry.py` + `download_models.py` + `GET /api/models`（先全 `installed:false` 也能验收契约） | P0 |
| P2 | `runtime/device.py` + `model_manager.py`（`local_files_only` + `MODEL_MISSING`） | P1 |
| P3 | `pipeline/backends.py` + `detect_grounding_dino.py` + `segment_sam.py` + `mask_refine.py`，用 `runner.py --image` 脱离 HTTP 单跑 | P2 |
| P4 | `text_alpha.py` / `zorder.py` / `background.py` / `exporter.py` | P3 |
| P5 | `runtime/jobs.py` + `runtime/storage.py` + `routers/layers.py` + `routers/models.py` | P4 |
| P6 | `tests/` 全套 | P5 |
| P7 | `src/core/layer-split.ts` | P5 契约冻结 |
| P8 | `workspace.ts` + `App.vue` + `TopBar.vue` + `vite.config.ts` | P7 |
| P9 | `LayerSplitPage.vue` + 3 个子组件 | P8 |
| P10 | `ServerModelCard.vue` 接入 `ModelManagerModal.vue` | P9 |
| P11 | README / 需求文档 / `.gitignore` / `package.json` | P10 |

---

## 八、验证

**1) 起服务**
```bash
cd server && python3 -m venv .venv && source .venv/bin/activate
pip install -U pip && pip install -r requirements.txt
python scripts/doctor.py                       # torch 2.5.1 / mps available True / 权重表
python scripts/download_models.py --host=https://hf-mirror.com   # ~1.5GB，可中断续传
python scripts/download_models.py --check      # 全部 ok，退出码 0
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```
> `--host 127.0.0.1` 是安全边界，不要改成 `0.0.0.0`。

**2) curl 逐接口**
```bash
curl -s http://127.0.0.1:8000/api/health | python3 -m json.tool
JOB=$(curl -s -X POST http://127.0.0.1:8000/api/layers/split \
  -F "file=@public/assets/testImages/gameUI.png" \
  -F 'params={"classes":[{"label":"按钮","prompt":"button","category":"button"},{"label":"图标","prompt":"icon","category":"icon"},{"label":"文本","prompt":"text","category":"text"},{"label":"面板","prompt":"panel","category":"panel"}],"segmenter":"sam","ocr":true,"background":"inpaint"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')
curl -s "http://127.0.0.1:8000/api/layers/jobs/$JOB"            # 轮询到 succeeded
curl -s "http://127.0.0.1:8000/api/layers/jobs/$JOB/layers" | python3 -m json.tool
curl -s -o /tmp/L0001.png "http://127.0.0.1:8000/api/layers/jobs/$JOB/layers/L0001.png"
sips -g hasAlpha /tmp/L0001.png                                 # 期望 hasAlpha: yes
curl -s -o /tmp/layers.zip "http://127.0.0.1:8000/api/layers/jobs/$JOB/bundle.zip" && unzip -l /tmp/layers.zip
```
错误分支：临时改名 `server/models/facebook` → `409 MODEL_MISSING`；传 25MB → `413`；`/layers/L0001.png` 用错 id → `404`。

**3) 前端端到端**（`pnpm dev` → 5173）
- 未起服务：页面 `.warn` + 启动命令 + 复制按钮，`pageStatus` 显示「服务未连接」，主按钮禁用；起服务后「重试连接」→「待处理」。
- 导入 `public/assets/testImages/gameUI.png`（1448×1086，已确认存在，< max_side 1536 不缩放）；`gameAssets.png`（1536×1024）验证边界。
- 点「开始拆分」→ `TaskProgress` 依次走 detect→segment→export；图层列表出缩略图（棋盘底）；勾选可见即时反映到右侧合成预览；改名后「导出 ZIP（当前编辑）」解压验证 `layers.json` 是新名字、隐藏层不在 `layers/` 里。
- 拖拽换序 → 合并选中 → 导出与原图对照（非独占模式重叠区有轻微差异，属预期）。
- **回灌验证**：在「精灵图」页导入 `gameUI.png`，再导入 ZIP 里的 `atlas.json`，确认出现与图层同名同坐标的帧。
- 构建产物：`pnpm build && pnpm preview`（4173），页面「服务地址」填 `http://127.0.0.1:8000`，确认走绝对地址同样可用。

**4) 自动化测试**：`cd server && pytest -q` —— 默认只跑免权重用例（`FakeDetectorBackend` 返回固定框、`FakeSegmenterBackend` 返回合成 mask），覆盖 z-order/包含森林/去重/`alpha_bbox` 裁切/文本紧致 alpha/错误码/路径校验/上限；真实模型用例标 `@pytest.mark.slow`，用 `LAYER_SPLIT_TEST_MODELS=1` 显式开启。

---

## 关键文件

- [src/store/workspace.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/store/workspace.ts)
- `src/core/layer-split.ts`（新建，前端唯一业务逻辑出口）
- `src/components/LayerSplitPage.vue`（新建）
- [src/App.vue](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/src/App.vue)
- [vite.config.ts](file:///Users/oubuwen/Documents/trae_projects/atlas-slice/vite.config.ts)
- `server/app/main.py`、`server/app/pipeline/runner.py`、`server/app/routers/layers.py`（新建）