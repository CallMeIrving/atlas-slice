# 去水印模块 UI 重构方案

## Context

当前去水印页中间为「框选编辑器 + 右侧结果列」双栏布局，X/Y/宽/高与拖拽工具散落在工作区下方，说明文案偏多。本次重构目标：

1. 移除冗余说明文案（截图划掉部分 + 参数区两段冗长说明）
2. 操作参数（ROI 数值输入、拖拽工具）统一收进右侧配置栏
3. 原图/结果图不再左右分列，改为**单舞台前后对比**（分割线 + 缩放 + 平移）
4. 舞台底部新增 ROI 实时预览条
5. 封装通用图片对比组件，供抠图页等后续复用

**已确认决策**：单舞台融合交互模型；对比工具**自研、零新依赖**（Vue 3 生态没有同时提供「分割线 + 滚轮缩放 + 拖动平移」且维护良好的库；项目已有 MattePage 缩放平移、FrameCropEditor 指针映射等成熟自研模式）；文案只删划掉部分，保留修复方式下拉及算法 hint。

## 文件清单

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/core/crop.ts` | 修改 | 新增纯函数 `inscribedRect`、`drawCropToCanvas` |
| `src/composables/useRoiSelection.ts` | 新建 | 框选交互逻辑单一来源（从 FrameCropEditor 迁移） |
| `src/components/FrameCropEditor.vue` | 修改 | 改为消费 composable，行为不变 |
| `src/components/ImageCompareViewer.vue` | 新建 | 通用图片前后对比组件（分割线 + 缩放 + 平移） |
| `src/components/WatermarkPage.vue` | 修改 | 布局重构主战场 |

## 1. core/crop.ts 新增纯函数

```ts
/** 在给定面积内取符合宽高比（宽÷高=target）的最大内接尺寸 */
export function inscribedRect(area: {width:number;height:number}, target: number): {width:number;height:number}

/** 把图像矩形按 1:1 最近邻绘制进 canvas（canvas 尺寸=区域尺寸），供 ROI 实时预览复用 */
export function drawCropToCanvas(image: HTMLImageElement, rect: ImageCropRect, canvas: HTMLCanvasElement): void
```

`inscribedRect` 供 composable 与 FrameCropEditor 的 applyRatio/fullFrame 复用；`drawCropToCanvas` 供 FrameCropEditor 预览与去水印页 ROI 预览条复用（内部先 `clampCropRect`，`imageSmoothingEnabled = false`）。

## 2. useRoiSelection.ts（框选逻辑抽取）

从 FrameCropEditor **逐字迁移**（不重写）：`setBox`（取整+clamp+emit 出口）、`applyDrag` 三分支（draw/move/resize）、`ratioRect`、`beginDraw`、window 级 pointer 监听。

```ts
export interface RoiSelectionOptions {
  /** pointerdown 时实时取 img 元素做 getBoundingClientRect → 图像像素映射（含 CSS transform） */
  getImage: () => HTMLImageElement | null | undefined
  /** 区域更新唯一出口：已取整并钳制，父组件写回 store/props */
  onUpdate: (rect: ImageCropRect) => void
  /** 可选宽高比注入（宽÷高，0=自由）；裁切页传，去水印页不传 */
  getRatio?: () => number
}
// 返回：box / tool / dragging / natural / handles / setBox / syncFrom /
//       onImageLoad / onStageDown / onBoxDown / onHandleDown / dispose
```

**定位方式各消费方自理**（composable 不输出 CSS）：FrameCropEditor 保留现有 imageRect/stageOrigin 测量定位；去水印融合舞台的框在 transform 容器内用百分比定位（`left: box.x/natural.width*100%`），天然跟随缩放平移。

**FrameCropEditor 改造回归要点**：setBox 逐字迁移；外部重置用「四字段比较后 syncFrom」防回环；ratio 走 `getRatio` 注入；`renderPreview` 改调 `drawCropToCanvas`；dispose 在 onBeforeUnmount 摘监听。改完先在 FrameCropModal、FramePipelineModal 两个弹窗手工回归（框选/移动/8 点缩放/比例锁定/整帧/数值输入/预览）。

## 3. ImageCompareViewer.vue（通用对比组件）

### Props / Emits / Slot / Expose

```ts
interface Props {
  beforeUrl: string        // 原图
  afterUrl?: string        // 结果图；空串时只渲染 before 层、无分割线
  beforeLabel?: string     // 默认「原图」
  afterLabel?: string      // 默认「结果」
  divider?: number         // v-model:divider，0–100，默认 50
  minZoom?: number         // 默认 1
  maxZoom?: number         // 默认 8
  selectionMode?: boolean  // true：空白处按下不平移，改 emit background-down 给父组件框选
}
// emits: update:divider / background-down(PointerEvent) / load({width,height})
// #overlay 插槽 props: { img, natural, display, zoom }（置于 before 层 transform 容器内，与 img 显示盒重合）
// defineExpose: { resetView() }
```

### 双层结构（分割线不漂移的关键）

```
.stage (relative, overflow:hidden, @wheel.prevent @pointerdown @dblclick)
 ├─ .layer.before (absolute inset:0, flex 居中)
 │    └─ .canvas-box (显式 display px 宽高, transform: translate·scale, origin:center)
 │         ├─ img.before
 │         └─ #overlay (absolute inset:0, pointer-events:none)
 ├─ .layer.after (absolute inset:0, clip-path: inset(0 0 0 {divider}%) ← stage 空间！)
 │    └─ .canvas-box (与 before 共享同一 transform 状态)
 │         └─ img.after
 └─ .divider (absolute left:{divider}%)
```

- clip-path 作用在 after **外层**（stage 空间），分割线屏幕位置恒定；两层内层 transform 共享同一状态 → 像素级对齐。
- display 尺寸：仿 MattePage `fitImageToCanvas`（`min(stageW/natW, stageH/natH, 1)` 不放大），ResizeObserver 观察 stage。
- 滚轮缩放：复用 MattePage `applyZoom` 光标中心公式，zoom ∈ [1,8]。
- 平移钳制：`limitX = max(0, (displayW*zoom - stageW)/2)`，zoom=1 自动回中。
- 对比模式空白拖拽 = 平移；双击 = 复位 zoom/pan（divider 不动）；分割线 handle 用 setPointerCapture 拖拽。
- `beforeUrl` 变化时内部复位 zoom/pan/divider。

## 4. WatermarkPage.vue 重构

### 状态机

```ts
const roiEditMode = ref(true)
const editingRoi = computed(() => roiEditMode.value || !resultUrl.value)
// runWatermark 成功 → roiEditMode=false（框选隐藏、分割线出现）
// 右栏「重新框选」→ roiEditMode=true；切来源 → true
// ROI 变化 → 现有 watch 触发 invalidateResult，旧结果自动作废（不新增逻辑）
```

viewer 绑定：`:after-url="editingRoi ? '' : resultUrl"`、`:selection-mode="editingRoi"`。

### 中间栏新结构

```
.tool-main
 ├─ .tool-header（不变：标题/导入图片/使用视频帧列表/badge）
 └─ .tool-body
     ├─ empty-state（不变）
     ├─ ImageCompareViewer（min-height ~360px）
     │    └─ #overlay（v-if=editingRoi）：SVG 框（viewBox=图像尺寸，四块压暗 rect + ROI rect，
     │        vector-effect="non-scaling-stroke"）+ 8 控制点（百分比定位 + scale(1/zoom) 恒定屏幕尺寸），
     │        绑 composable 的 onBoxDown/onHandleDown/onStageDown
     ├─ .roi-preview-strip（底部 ~110px）：canvas 原图 ROI 裁切 + v-if 结果同区域裁切并列，
     │    watch([box, resultUrl]) rAF 节流重绘（drawCropToCanvas）；结果图用 resultImageCache 解码缓存
     └─ TaskProgress（位置不变）
```

删除原 `wm-workspace` 双列与 FrameCropEditor 引用。左栏图集列表不动。

### 右栏结构

1. 「去水印」标题 — **删**「本地处理，不上传素材」；样板帧下拉（isFrames）移入此区
2. 「框选区域 (ROI)」★新增 — 2×2 网格 X/Y/宽度/高度（绑 composable.box，@change 钳制；grid 项 `min-width:0`、input 宽 100%）+ 拖拽工具 seg（调整框选/重新框选）+「重新框选」按钮（`:disabled="editingRoi"`）+ 当前 ROI 文本
3. 「修复方式」— 保留下拉 + activeModeHint
4. 「参数」— 保留颜色/阈值/噪点/精细度控件；**删**色差阈值说明段、重建精细度原理段；保留 degraded 警告
5. actions — 不变

### 删除的文案（汇总）

- `本地处理，不上传素材`
- 「数据来源」section 标题与文件名行（`file-name`）
- 框选区下方说明段（原空 `#help` 插槽所在区域随 FrameCropEditor 一并移除）
- 色差阈值说明（L419）、重建精细度原理（L427-429）

## 实施顺序

1. `crop.ts` 纯函数 → 2. `useRoiSelection.ts` → 3. `FrameCropEditor.vue` 接入 + 两弹窗回归 → 4. `ImageCompareViewer.vue` → 5. `WatermarkPage.vue` 重构 → 6. 全量走查

每步跑 `npm run build`（vue-tsc -b && vite build）。

## 验证

浏览器走查 `http://localhost:5173` 去水印页（端口占用时落 5174）：

- 导入图 → 框选/移动/8 点缩放 ↔ 右栏数值输入双向同步；改 ROI/参数后旧结果作废
- 滚轮以光标为中心缩放 1–8x；对比模式空白拖拽平移；框选模式空白拖拽重新框选；双击复位
- 点「去水印」→ 框选自动隐藏、分割线出现；平移缩放时分割线不漂移；拖分割线对比
- 「重新框选」找回框选态
- 底部预览条：原图 ROI 与结果同区域并列逐像素对照
- 帧模式：样板帧切换、应用到全部帧、还原全部帧、下载 PNG
- 回归：FrameCropModal、FramePipelineModal 框选行为与改造前一致
- 三栏 DOM 顺序 sidebar→main→sidepanel 不变；≤1100px 收窄断点正常

## 风险点

1. **分割线漂移**：clip-path 必须在 stage 空间外层，误放 transform 内层会随 pan 跑
2. **坐标系混用**：pointer→image 映射必须 pointerdown 时实时 `getBoundingClientRect()`（含 transform），禁止缓存旧 rect 跨手势使用（memory 已有教训）
3. **控制点随缩放变形**：SVG `non-scaling-stroke` + handle `scale(1/zoom)` 抵消
4. **roi 写回回环**：onUpdate→store→watch 回灌用四字段比较守卫；prepareSource 显式 syncFrom，不 watch roi 回灌
5. **迟到结果**：现有 runToken 守卫保留，invalidateResult 会 bump runToken
6. **侧栏横向滚动**：ROI 网格遵守 grid 项 `min-width:0` + input 100% 宽度教训
