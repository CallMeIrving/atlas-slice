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
pnpm install      # 安装依赖
pnpm run dev      # 启动开发服务器（默认 http://localhost:5173）
pnpm run build    # 类型检查 + 生产构建，产物在 dist/
pnpm run preview  # 本地预览生产构建
```

## 抠图模型下载

抠图模块支持颜色抠图、ISNet、BiRefNet、RMBG-1.4 和 SAM。颜色抠图不需要下载模型；AI 模型首次预加载或首次使用时会下载并缓存到浏览器。模型加载完成后，界面会显示「已加载」，失败时会显示具体错误。

### 模型地址

| 模型 | 项目中的模型 ID / 选项 | 官方下载地址 | 国内镜像 |
|---|---|---|---|
| ISNet（imgly） | `isnet_fp16`、`isnet`、`isnet_quint8` | [IMG.LY 模型资源](https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/) | 无 HuggingFace 镜像 |
| BiRefNet | `onnx-community/BiRefNet_lite-ONNX` | [HuggingFace 模型仓库](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/tree/main) | [hf-mirror 镜像](https://hf-mirror.com/onnx-community/BiRefNet_lite-ONNX) |
| RMBG-1.4 | `briaai/RMBG-1.4` | [HuggingFace 模型仓库](https://huggingface.co/briaai/RMBG-1.4/tree/main) | [hf-mirror 镜像](https://hf-mirror.com/briaai/RMBG-1.4) |
| SAM | `Xenova/sam-vit-base` | [HuggingFace 模型仓库](https://huggingface.co/Xenova/sam-vit-base/tree/main) | [hf-mirror 镜像](https://hf-mirror.com/Xenova/sam-vit-base) |

### 网络和代理说明

- BiRefNet、RMBG-1.4、SAM 托管在 HuggingFace。中国大陆网络访问 HuggingFace 可能不稳定，遇到下载失败时可在界面把「模型源」切换为 `hf-mirror.com`，或使用代理网络。
- `hf-mirror.com` 是第三方镜像，不是 HuggingFace 官方站点。用于生产部署时，建议下载后校验文件并固定版本。
- ISNet 默认从 IMG.LY 的 `staticimgly.com` CDN 获取模型和 WASM 文件，是否需要代理取决于当前网络。也可以通过「资源地址（publicPath）」改成自己的静态文件地址。
- 模型体积较大，SAM 仓库约 1.34GB，BiRefNet 仓库约 339MB，RMBG-1.4 仓库约 842MB；实际下载量会根据模型精度和 Transformers.js 所需文件变化。

### 离线部署

可以把模型提前放到应用的 `public/models/` 目录。目录名要和模型 ID 保持一致，例如：

```text
public/models/
├── onnx-community/BiRefNet_lite-ONNX/
├── briaai/RMBG-1.4/
├── Xenova/sam-vit-base/
└── imgly/1.7.0/dist/
```

启动应用后，在「抠图」页面选择对应模型，点击「预加载当前模型」。应用会优先复用浏览器缓存或本地模型目录；模型 ID、目录结构或文件不完整时会显示「加载失败」。

RMBG-1.4 还需要遵守 [BRIA 模型许可证](https://huggingface.co/briaai/RMBG-1.4/tree/main) 的使用限制；BiRefNet 仓库标注 MIT，SAM 仓库标注 Apache-2.0。

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
  gen-test-atlas.mjs   生成测试图集（图片 + 4 种元数据）
test-fixtures/         生成的测试图集产物
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
