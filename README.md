# AtlasSlice 图集切片

面向游戏开发 / 美术人员的**图集切片工具**：把游戏图集（Sprite Atlas / Spritesheet）按元数据、透明边缘或手动框选切分为独立小图，并支持批量导出、动画预览与配置预设。

纯本地 Web 应用，所有图片处理都在浏览器内完成，**不上传任何服务器**，素材零泄露风险。

## 功能特性

**导入**

- 图集图片：PNG / JPG / WebP，点击选择或直接拖到画布，单文件 ≤ 10MB
- 元数据：TexturePacker JSON（哈希表与数组结构）、cocos2d / SpriteKit plist、TexturePacker XML，按内容自动识别格式
- 把图片和元数据一起拖进画布，会同时载入两者
- 可先导入元数据、后导入图片，元数据会在图片载入后自动生效

**三种裁切方式并存**

1. **读取元数据裁切** —— 按 `frame` 矩形、`rotated`、`trimmed` 信息精确裁切
2. **自动识别透明边缘** —— 逐像素扫描，按连通域拆分成多个内容块
3. **手动框选** —— 画布上拖拽矩形，支持微调与删除

自动识别与手动框选都会忽略小于 **16×16** 的内容块，避免产生碎片帧。

**框选辅助**

- 选中帧后拖拽 8 个控制点调整边框，带边缘磁吸与图集边界约束
- 框选区域半透明遮罩，框内图案清晰可见
- `F` 自动贴合内容边界，方向键像素级微调（配合 `Shift` 为 10px 步进）

**导出**

- 裁切模式：`实际内容`（只保留不透明内容）/ `原始帧尺寸`（保留透明区域）
- 统一留边 padding，防止合图出血
- 命名模板：`{name}` 帧名 · `{index}` 补零序号(0001) · `{seq}` 序号
- ZIP 内自定义目录层级
- 输出独立 PNG；多帧或勾选了元数据时打包为 ZIP
- 可选附带元数据 **JSON** 与 **plist**（可分别勾选）

导出的元数据以**原始图集坐标**记录 `frame` / `rotated` / `trimmed` / `spriteSourceSize` / `sourceSize`，因此可以重新「导入元数据」还原出与导出前完全一致的帧，方便中途存档后继续编辑。

**动画预览**

- 默认按自然数字排序（1、2、10 而非 1、10、2）
- 播放 / 暂停、上一帧 / 下一帧、循环开关、速度（fps）调节
- 底部帧序条可拖拽调整顺序，一键恢复自然排序

**配置预设**

导出设置（裁切模式、padding、命名模板、目录、元数据选项）与预设保存在浏览器 `localStorage`，刷新不丢失。

## 快速开始

环境要求：Node.js 18+。

```bash
pnpm install                  # 安装依赖
pnpm run dev                  # 启动开发服务器（默认 http://localhost:5173）
pnpm run build                # 类型检查 + 生产构建，产物在 dist/
pnpm run preview              # 本地预览生产构建
pnpm run models:download      # 下载抠图模型到 public/models/（可选，约 640MB）
```

## 抠图模型下载

抠图模块支持颜色抠图、ISNet、BiRefNet、RMBG-1.4。颜色抠图不需要下载模型；ISNet 默认从 IMG.LY CDN 加载并由浏览器缓存，BiRefNet、RMBG-1.4 默认从项目的 `public/models/` 本地目录加载。模型加载完成后，界面会显示「已加载」，失败时会显示具体错误。

### 一键下载

`public/models/*` 被 `.gitignore` 忽略，权重不会进 Git，换机器或清空工作区后需要用脚本重新落地：

```bash
pnpm run models:download                 # 全量：界面可选的全部精度，约 640MB
pnpm run models:download -- --fp16-only  # 精简集：BiRefNet/RMBG 默认 FP16，约 200MB
pnpm run models:download -- --force      # 已存在的文件也重新下载
pnpm run models:download -- --host=https://huggingface.co   # 换模型源，默认 hf-mirror.com
```

脚本行为：

- 默认走 `hf-mirror.com`（中国大陆访问 `huggingface.co` 可能超时），可用 `--host=` 或环境变量 `MODEL_HOST` 覆盖。
- 先写入 `.part` 再改名，中断后下次运行按 `Range` 续传；服务端不支持 Range 时自动从头下载。
- 下载完成后按字节数校验完整性，不符会给出警告；已存在且字节数一致的文件直接跳过。
- 失败项会在末尾汇总列出，并以退出码 1 结束，方便挂到 `postinstall` 或 CI。

### 模型地址

| 模型 | 项目中的模型 ID / 选项 | 官方下载地址 | 国内镜像 |
|---|---|---|---|
| ISNet（imgly） | `isnet_fp16`、`isnet`、`isnet_quint8` | [IMG.LY 模型资源](https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/) | 无 HuggingFace 镜像 |
| BiRefNet | `onnx-community/BiRefNet_lite-ONNX` | [HuggingFace 模型仓库](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/tree/main) | [hf-mirror 镜像](https://hf-mirror.com/onnx-community/BiRefNet_lite-ONNX) |
| RMBG-1.4 | `briaai/RMBG-1.4` | [HuggingFace 模型仓库](https://huggingface.co/briaai/RMBG-1.4/tree/main) | [hf-mirror 镜像](https://hf-mirror.com/briaai/RMBG-1.4) |

### 必需文件与排除文件

项目中的 Transformers.js 模型默认使用本地目录和 `local_files_only`，不会因为仓库中存在多个精度版本而全部下载。ISNet 由 `@imgly/background-removal` 管理 CDN 资源；离线部署时只需要复制当前精度对应的文件。

#### ISNet（imgly）

ISNet 由 `@imgly/background-removal` 管理资源，项目只会加载界面当前选择的一个模型：

| 选项 | 必需资源 | 不需要同时下载 |
|---|---|---|
| `isnet_fp16` | ISNet FP16 资源 | `isnet`、`isnet_quint8` |
| `isnet` | ISNet 原始精度资源 | `isnet_fp16`、`isnet_quint8` |
| `isnet_quint8` | ISNet 量化资源 | `isnet`、`isnet_fp16` |

资源由库内部按 `model` 参数选择，代码不应把三套 ISNet 资源复制到同一个离线目录中。

#### BiRefNet

项目已提供默认 FP16 本地模型。模型目录 `public/models/onnx-community/BiRefNet_lite-ONNX/` 必需：

```text
config.json
preprocessor_config.json
onnx/model_fp16.onnx       # FP16，界面默认精度
```

如果界面切换精度，则只保留对应文件：

```text
onnx/model.onnx             # FP32
onnx/model_fp16.onnx        # FP16
```

该仓库目前没有 `model_quantized.onnx`，因此不要选择或下载 Q8 文件；`q8` 选项只适用于实际提供量化权重的模型。项目使用 `background-removal` Pipeline，避免为纯图像模型探测 tokenizer 文件，所以**不需要** `processor_config.json`（该仓库也没有这个文件）。

不需要下载仓库中的其他说明文件或其他精度权重。两种精度可以同时放在同一目录：Transformers.js 按界面当前 `dtype` 只请求对应文件名，全量下载会把两种都留下以便随时切换，只想省空间时用 `--fp16-only` 只保留 FP16。

#### RMBG-1.4

项目已提供默认 FP16 本地模型。模型目录 `public/models/briaai/RMBG-1.4/` 必需：

```text
config.json
preprocessor_config.json
onnx/model_fp16.onnx        # 当前默认精度，推荐
```

按界面选择的精度替换为对应文件：

```text
onnx/model.onnx             # FP32
onnx/model_fp16.onnx        # FP16
onnx/model_quantized.onnx   # Q8
```

不需要下载 `model.pth`、`model.safetensors`、`pytorch_model.bin`、Python 推理脚本、示例图片或未选择的 ONNX 精度文件。浏览器端只使用 `onnx/` 下与当前 `dtype` 匹配的一个文件。项目使用 `background-removal` Pipeline，并对 RMBG 的 Segformer 配置做了兼容处理。

### 网络和代理说明

- BiRefNet、RMBG-1.4 的权重放在项目本地目录（由 `pnpm run models:download` 落地），不依赖运行时访问 HuggingFace。重新下载或切换模型 ID 时，中国大陆网络访问 HuggingFace 可能不稳定，可在界面把「模型源」切换为 `hf-mirror.com`，或使用代理网络。
- `hf-mirror.com` 是第三方镜像，不是 HuggingFace 官方站点。用于生产部署时，建议下载后校验文件并固定版本。
- ISNet 默认从 IMG.LY 的 `staticimgly.com` CDN 获取模型和 WASM 文件，是否需要代理取决于当前网络。也可以通过「资源地址（publicPath）」改成自己的静态文件地址。
- 模型仓库展示的总大小包含多个精度和非浏览器文件；全量下载约 640MB，`--fp16-only` 精简集约 200MB（BiRefNet FP16 约 115MB + RMBG FP16 约 88MB）。实际运行还会加载 Transformers.js 的运行时 WASM 文件。模型状态是页面运行时状态，刷新后会重新初始化本地模型，不会重复下载权重。

### 离线部署

可以把模型提前放到应用的 `public/models/` 目录。因为 `onnx-community/BiRefNet_lite-ONNX`、`briaai/RMBG-1.4` 这两组目录名和层级容易写错，最省事的方式是直接运行 `pnpm run models:download`，脚本会按模型 ID 建好目录。手工放置时目录名要和模型 ID 保持一致，例如：

```text
public/models/
├── onnx-community/BiRefNet_lite-ONNX/  # config + preprocessor + FP16/FP32 权重
└── briaai/RMBG-1.4/                    # config + preprocessor + FP16/Q8/FP32 权重
```

启动应用后，在「抠图」页面选择对应模型，点击「预加载当前模型」。项目会优先使用 `public/models/` 中的本地模型；刷新页面后会重新初始化模型运行时。Vite 对 `/models/` 下不存在的文件返回 404，避免把应用首页 HTML 当作 JSON 解析。

注意：`.gitignore` 默认忽略 `public/models/*`，本地模型不会被 Git 提交；部署或交付时需要单独复制这些模型文件（模型目录约 640MB，交付纯前端产物时建议只复制当前精度，如 BiRefNet FP16 与 RMBG FP16），或者删除相应忽略规则后再提交。

RMBG-1.4 还需要遵守 [BRIA 模型许可证](https://huggingface.co/briaai/RMBG-1.4/tree/main) 的使用限制；BiRefNet 仓库标注 MIT。

## 使用流程

1. 点「导入图片」载入图集，工具会自动识别透明边缘生成帧
2. 若有配套元数据，点「导入元数据」按元数据精确切分
3. 切到「框选」模式手动补框漏切的图，或选中帧后拖控制点修正边框
4. 右侧「导出设置」里选裁切模式、留边、命名模板与目录，勾选需要的元数据格式
5. 点「开始导出」得到独立 PNG 或 ZIP
6. 底部「动画预览」检查帧序与播放效果，必要时拖拽调整顺序

## 画布操作

| 操作 | 说明 |
|---|---|
| 点击 | 选中帧 |
| 拖拽控制点 | 调整选中帧边框 |
| 左键拖拽 | 平移视图（查看模式） |
| `空格` + 左键 / 右键 / 中键 | 平移视图 |
| `F` | 自动贴合内容边界 |
| `方向键` | 像素级微调（`Shift` 为 10px 步进） |
| `Del` / `Backspace` | 删除选中帧 |
| `Esc` | 取消当前框选 / 调整 |

## 支持的元数据格式

**TexturePacker JSON**（哈希表与数组结构均支持）

```json
{
  "frames": {
    "hero.png": {
      "frame": { "x": 98, "y": 126, "w": 64, "h": 64 },
      "rotated": false,
      "trimmed": false,
      "spriteSourceSize": { "x": 0, "y": 0, "w": 64, "h": 64 },
      "sourceSize": { "w": 64, "h": 64 }
    }
  },
  "meta": { "image": "atlas.png", "size": { "w": 512, "h": 512 } }
}
```

**cocos2d plist**（format 3）与 **TexturePacker XML** 同样支持，格式自动识别，无需手动指定。

## 项目结构

```
src/
  components/          TopBar · FrameList · CanvasStage · Inspector · PreviewPlayer
  core/
    crop.ts            帧裁切（实际内容 / 原始帧尺寸双模式）
    trim.ts            透明边缘检测与连通域拆分
    sort.ts            自然数字排序
    export.ts          导出 PNG / ZIP / 元数据 JSON / plist
    parsers/           JSON · plist · XML 元数据解析
  store/atlas.ts       应用状态与动作（reactive 单例）
  styles/              设计令牌与基础样式
  types/atlas.ts       帧数据结构定义
scripts/
  gen-test-atlas.mjs     生成测试图集（图片 + 4 种元数据）
  download-models.mjs    下载抠图模型到 public/models/
public/models/           本地抠图权重（被 .gitignore 忽略，用脚本下载）
test-fixtures/           生成的测试图集产物
```

## 技术栈

Vue 3（`<script setup>` + TypeScript）· Vite 6 · Canvas 2D · jszip · fast-xml-parser

## 测试图集

仓库自带一份 512×512 的测试图集（21 帧，含动画序列、旋转帧、trimmed 偏移帧），覆盖全部 4 种元数据格式：

```bash
node scripts/gen-test-atlas.mjs   # 重新生成到 test-fixtures/
```

## 许可证

[MIT](LICENSE)
