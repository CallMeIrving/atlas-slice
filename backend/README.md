# 图层拆分服务（backend/）

把一张游戏 UI 截图拆成**可独立复用的图层**：GroundingDINO 出框 → SAM 精细分割 →
OCR 给文本层做紧致 alpha → 包含森林算 z-order → 生成带透明通道的独立 PNG 与清单。

这是 AtlasSlice 里**唯一需要 Python 的部分**。素材流转的三种情况：

| 场景 | 素材去哪 |
|---|---|
| 其余页面（精灵图 / 抠图 / 视频 / 去水印） | 全部在浏览器内处理，不出本机 |
| 本服务 | 只在本机回环（`127.0.0.1`）内传输，文件落在 `backend/tmp/` |
| 模型权重 | 从镜像站下载到仓库根 `models/`，只在本机加载 |

## 安装

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -U pip && pip install -r requirements.txt
python scripts/doctor.py          # 解释器 / torch / MPS / 权重 / 磁盘余量
```

可选（文本层的紧致 alpha，走 Florence-2）：

```bash
pip install -r requirements-ocr.txt
```

跑测试需要 pytest / httpx：

```bash
pip install -r requirements-dev.txt   # 或 make dev
```

## 下载权重

```bash
python scripts/download_models.py --host=https://hf-mirror.com   # 约 1.5GB（含 OCR 约 2.0GB）
python scripts/download_models.py --check                        # 逐文件校验，缺失退出码 1
python scripts/download_models.py --list                         # 只看清单与就位情况
```

| 角色 | 仓库 | 约体积 |
|---|---|---|
| detect | `IDEA-Research/grounding-dino-tiny` | 694MB |
| segment | `facebook/sam-vit-base` | 375MB |
| ocr（可选） | `microsoft/Florence-2-base-ft` | 464MB |

权重落在仓库根 `models/<repo_id>/`（与浏览器抠图权重同目录，由 `LAYER_SPLIT_MODELS_DIR` 覆盖）。
**不设 `allow_patterns`**：Florence-2 的 remote code
必须整仓落地。中断可续传；`--force` 强制重下。

## 启动

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
# 或 make run
```

**安全边界：`--host 127.0.0.1` 不要改成 `0.0.0.0`。** 服务没有鉴权，绑到公网接口上
等于把本机推理能力和上传的素材一起暴露出去。

首次推理会额外等 15-45 秒（权重首次读入 + MPS kernel 编译），可以先预热：

```bash
curl -s -X POST http://127.0.0.1:8000/api/models/load \
  -H 'Content-Type: application/json' -d '{"role":"detect"}'
```

## 前端对接

dev 环境走 Vite 代理，前端用相对路径 `/layer-api/...`，零 CORS：

```ts
// vite.config.ts
server: { proxy: { '/layer-api': { target: 'http://127.0.0.1:8000', changeOrigin: true, rewrite: (p) => p.replace(/^\/layer-api/, '') } } }
```

构建产物（`dist/`）没有代理，页面上的「服务地址」会回落到
`localStorage['atlas-slice:layer-server'] || 'http://127.0.0.1:8000'`。
兜底的 CORS 只放行本机来源（`^http://(localhost|127\.0\.0\.1)(:\d+)?$`）。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活、设备、权重是否就绪、排队深度 |
| GET | `/api/system` | 版本、设备明细、各项上限 |
| GET | `/api/models` | 权重清单（逐文件就位情况） |
| POST | `/api/models/download` | 下载权重（复用作业系统，返回 job_id） |
| POST | `/api/models/load` / `unload` | 预热 / 释放显存 |
| POST | `/api/layers/split` | 提交拆分（multipart：`file` + `params` JSON） |
| GET | `/api/layers/jobs/{id}` | 轮询进度（`progress` 0-1） |
| DELETE | `/api/layers/jobs/{id}` | 协作式取消 |
| GET | `/api/layers/jobs/{id}/layers` | 图层清单（按 z 升序 = 从后到前） |
| GET | `/api/layers/jobs/{id}/layers/{lid}.png` | 单个图层 PNG（`?canvas=full` 补成原图尺寸） |
| GET | `/api/layers/jobs/{id}/manifest.json` | 原生清单 |
| GET | `/api/layers/jobs/{id}/bundle.zip` | 整包（含 `atlas.json`） |

错误统一是 `{"error":{"code","message","detail"}}`，`code` 取值：
`BAD_IMAGE` `UNSUPPORTED_MEDIA` `PAYLOAD_TOO_LARGE` `INVALID_PARAMS` `DEVICE_INVALID`
`MODEL_MISSING` `MODEL_LOAD_FAILED` `OUT_OF_MEMORY` `JOB_NOT_FOUND` `QUEUE_FULL` `INTERNAL`。

### curl 走一遍

```bash
curl -s http://127.0.0.1:8000/api/health | python3 -m json.tool

JOB=$(curl -s -X POST http://127.0.0.1:8000/api/layers/split \
  -F "file=@../public/assets/test/testImages/gameUI.png" \
  -F 'params={"classes":[{"label":"按钮","prompt":"button","category":"button"},{"label":"图标","prompt":"icon","category":"icon"},{"label":"文本","prompt":"text","category":"text"},{"label":"面板","prompt":"panel","category":"panel"}],"segmenter":"sam","ocr":true,"background":"inpaint"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')

curl -s "http://127.0.0.1:8000/api/layers/jobs/$JOB"                 # 轮询到 succeeded
curl -s "http://127.0.0.1:8000/api/layers/jobs/$JOB/layers" | python3 -m json.tool
curl -s -o /tmp/L0001.png "http://127.0.0.1:8000/api/layers/jobs/$JOB/layers/L0001.png"
sips -g hasAlpha /tmp/L0001.png                                      # 期望 hasAlpha: yes
curl -s -o /tmp/layers.zip "http://127.0.0.1:8000/api/layers/jobs/$JOB/bundle.zip" && unzip -l /tmp/layers.zip
```

`params` 里的 `prompt` **必须是英文小写**（模型词表决定），`label` 是界面用的中文；
漏掉类别之间的句点分隔会静默返回 0 框——服务端会做归一化并在结果为空时给出 warning。

## 约束与取舍

- 上传 ≤ 20MB；解码后 `max_side` 默认 1536、硬上限 4096，超出等比缩放并回写 `source.scale`。
- `max_layers` 默认 80、硬上限 200，超出按 `score × area` 截断并写进 `warnings`。
- **串行执行**：单 worker 线程，队列上限 4。MPS 统一内存不允许两个大模型同时驻留，
  因此加载新角色前会先卸载其它角色（阶段间互斥驻留，峰值 RSS 3-4GB）。
- **MPS 一律 fp32**：fp16 在部分 attention / sdpa 算子上会出 NaN；`PYTORCH_ENABLE_MPS_FALLBACK=1`
  由服务启动时自动设置。
- 作业只存在内存里，进程重启即失效。前端遇到 `404 JOB_NOT_FOUND` 应回到「待处理」态并提示
  「服务已重启」，而不是继续轮询。
- 临时产物在 `backend/tmp/jobs/<job_id>/`，TTL 1 小时、最多保留 20 个作业，启动时全量清扫。

## 脱离 HTTP 单跑管线

接前端之前先把模型调通用这条：

```bash
python -m app.pipeline.runner --image ../public/assets/test/testImages/gameUI.png \
  --prompt "button,icon,text,panel" --max-side 1536
```

产物默认落在 `backend/tmp/manual/`。

## 测试

```bash
python -m pytest -q                       # 免权重用例（Fake 后端）
LAYER_SPLIT_TEST_MODELS=1 python -m pytest -q -m slow   # 需要真实权重
```

## 配置

全部字段都能用 `LAYER_SPLIT_` 前缀的环境变量覆盖（也可写 `backend/.env`）：
`LAYER_SPLIT_DEVICE` `LAYER_SPLIT_MODELS_DIR` `LAYER_SPLIT_TMP_DIR` `LAYER_SPLIT_PORT`
`LAYER_SPLIT_MAX_UPLOAD_BYTES` `LAYER_SPLIT_JOB_TTL_SECONDS` `LAYER_SPLIT_MAX_QUEUE` 等。