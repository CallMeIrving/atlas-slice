import { ref, type Ref } from 'vue'
import { clampCropRect, type ImageCropRect } from '@/core/crop'

/**
 * 区域框选交互逻辑（裁切编辑器 / 去水印融合舞台共用）。
 * 只负责「图像像素坐标的框 + 指针映射 + 拖拽状态机」，不输出任何 CSS 定位：
 * 消费方各自决定渲染方式（舞台内测量换算，或 transform 容器内百分比定位）。
 */

/** 控制点方位：用于区分拖动的是哪条边 */
export type RoiHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
/** 拖拽工具：draw 在任意位置重新框选，move 拖动框体位置 */
export type RoiTool = 'move' | 'draw'
/** 拖动状态 */
type DragState =
  | { kind: 'draw'; anchorX: number; anchorY: number }
  | { kind: 'move'; offsetX: number; offsetY: number }
  | { kind: 'resize'; handle: RoiHandle }

export interface RoiSelectionOptions {
  /** 取当前图像元素：pointerdown 时实时 getBoundingClientRect 做视口→图像像素映射（含 CSS transform） */
  getImage: () => HTMLImageElement | null | undefined
  /** 区域更新唯一出口：已统一取整，父组件写回 store/props */
  onUpdate: (rect: ImageCropRect) => void
  /** 可选宽高比（宽 ÷ 高）getter，返回 0 表示自由；裁切页注入，去水印页不传 */
  getRatio?: () => number
}

export interface RoiSelectionApi {
  /** 框选区域本地工作副本（图像像素坐标） */
  box: Ref<ImageCropRect>
  tool: Ref<RoiTool>
  /** 是否正在拖动：供 cursor / 压暗样式使用 */
  dragging: Ref<boolean>
  /** 当前图像的原始像素尺寸 */
  natural: Ref<{ width: number; height: number }>
  /** 图像在视口中的实际渲染矩形（含 transform），供消费方换算覆盖层定位 */
  imageRect: Ref<{ left: number; top: number; width: number; height: number }>
  handles: readonly RoiHandle[]
  /** 重新测量图像矩形（窗口尺寸变化、布局变化后调用） */
  measure(): void
  /** 更新区域（唯一出口，统一取整） */
  setBox(rect: ImageCropRect): void
  /** 外部重置区域时写回本地副本（不触发 onUpdate，防回环） */
  syncFrom(rect: ImageCropRect): void
  /** 图像加载完成：记录原始尺寸、沿用已选区域（无有效区域则整帧） */
  onImageLoad(): void
  /** 舞台空白处按下：直接进入重新框选 */
  onStageDown(event: PointerEvent): void
  /** 框体内按下：框选工具继续重新框选，调整工具整体移动 */
  onBoxDown(event: PointerEvent): void
  /** 控制点按下：只调整对应边 */
  onHandleDown(handle: RoiHandle, event: PointerEvent): void
  /** 卸载时摘除 window 监听 */
  dispose(): void
}

/**
 * 创建框选交互实例。
 * 指针→图像坐标换算依赖 getBoundingClientRect（包含 CSS transform），
 * 每次手势开始（pointerdown）时实时测量，手势期间复用，避免跨缩放/平移状态混用坐标系。
 */
export function useRoiSelection(options: RoiSelectionOptions): RoiSelectionApi {
  const handles: RoiHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

  const box = ref<ImageCropRect>({ x: 0, y: 0, width: 0, height: 0 })
  const tool = ref<RoiTool>('move')
  const dragging = ref(false)
  const natural = ref({ width: 0, height: 0 })
  /** 图像在视口中的实际渲染矩形，用于把指针位置换算成图像像素坐标 */
  const imageRect = ref({ left: 0, top: 0, width: 0, height: 0 })
  let drag: DragState | null = null

  /** 更新裁切区域（唯一出口，保证父子单一数据源）：统一取整到 1 像素，避免拖动产生的浮点坐标写进输入框与帧数据 */
  function setBox(rect: ImageCropRect): void {
    const next: ImageCropRect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    }
    box.value = next
    options.onUpdate({ ...next })
  }

  /** 数值收敛到 [min, max] */
  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }

  /** 重新测量图像矩形（getBoundingClientRect 天然包含 transform，缩放平移后的舞台同样适用） */
  function measure(): void {
    const image = options.getImage()
    if (!image) return
    const rect = image.getBoundingClientRect()
    imageRect.value = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }

  /** 指针位置 → 图像像素坐标（超出图像范围时收敛到边界，无有效尺寸时返回 null） */
  function toImagePoint(event: PointerEvent): { x: number; y: number } | null {
    const rect = imageRect.value
    const size = natural.value
    if (!rect.width || !rect.height || !size.width) return null
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * size.width, 0, size.width),
      y: clamp(((event.clientY - rect.top) / rect.height) * size.height, 0, size.height),
    }
  }

  /**
   * 按当前宽高比与锚点生成裁切矩形。
   * anchor 为不动点；signX/signY 表示矩形相对锚点的伸展方向，0 表示该轴以锚点为中心展开。
   * 自由比例下两轴独立收敛；锁定比例时等比缩放，保证宽高比不被边界破坏。
   */
  function ratioRect(
    anchor: { x: number; y: number },
    signX: -1 | 0 | 1,
    signY: -1 | 0 | 1,
    rawWidth: number,
    rawHeight: number,
  ): ImageCropRect {
    const size = natural.value
    const target = options.getRatio?.() ?? 0
    let width = Math.max(1, rawWidth)
    let height = Math.max(1, rawHeight)
    if (target) {
      if (signX === 0) width = height * target
      else if (signY === 0) height = width / target
      else {
        width = Math.max(rawWidth, rawHeight * target)
        height = width / target
      }
    }
    const limitX = signX > 0 ? size.width - anchor.x : signX < 0 ? anchor.x : 2 * Math.min(anchor.x, size.width - anchor.x)
    const limitY = signY > 0 ? size.height - anchor.y : signY < 0 ? anchor.y : 2 * Math.min(anchor.y, size.height - anchor.y)
    if (target) {
      const scale = Math.min(1, Math.max(1, limitX) / width, Math.max(1, limitY) / height)
      width *= scale
      height *= scale
    } else {
      width = Math.min(width, Math.max(1, limitX))
      height = Math.min(height, Math.max(1, limitY))
    }
    return {
      x: signX > 0 ? anchor.x : signX < 0 ? anchor.x - width : anchor.x - width / 2,
      y: signY > 0 ? anchor.y : signY < 0 ? anchor.y - height : anchor.y - height / 2,
      width,
      height,
    }
  }

  /** 图像加载完成：记录原始尺寸、沿用已选区域（无有效区域则整帧），并重新测量 */
  function onImageLoad(): void {
    const image = options.getImage()
    if (!image) return
    const width = image.naturalWidth
    const height = image.naturalHeight
    natural.value = { width, height }
    const initial = box.value.width > 0 && box.value.height > 0
      ? box.value
      : { x: 0, y: 0, width, height }
    setBox(clampCropRect(initial, width, height))
    measure()
  }

  /** 按拖动模式更新裁切框，各分支都通过 ratioRect 约束在图像范围内 */
  function applyDrag(point: { x: number; y: number }): void {
    const mode = drag
    if (!mode) return
    const size = natural.value
    const current = box.value
    if (mode.kind === 'draw') {
      setBox(ratioRect(
        { x: mode.anchorX, y: mode.anchorY },
        point.x >= mode.anchorX ? 1 : -1,
        point.y >= mode.anchorY ? 1 : -1,
        Math.abs(point.x - mode.anchorX),
        Math.abs(point.y - mode.anchorY),
      ))
      return
    }
    if (mode.kind === 'move') {
      setBox({
        ...current,
        x: clamp(point.x - mode.offsetX, 0, size.width - current.width),
        y: clamp(point.y - mode.offsetY, 0, size.height - current.height),
      })
      return
    }
    // 控制点：以对边/对角的锚点为不动点，未拖动的轴保持原尺寸；越过锚点时收敛为 1px
    const handle = mode.handle
    const signX: -1 | 0 | 1 = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
    const signY: -1 | 0 | 1 = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
    const anchorX = signX > 0 ? current.x : signX < 0 ? current.x + current.width : current.x + current.width / 2
    const anchorY = signY > 0 ? current.y : signY < 0 ? current.y + current.height : current.y + current.height / 2
    setBox(ratioRect(
      { x: anchorX, y: anchorY },
      signX,
      signY,
      signX === 0 ? current.width : Math.max(1, (point.x - anchorX) * signX),
      signY === 0 ? current.height : Math.max(1, (point.y - anchorY) * signY),
    ))
  }

  /** 拖动过程中的指针移动：统一在 window 上监听，指针移出舞台也不会中断 */
  function onPointerMove(event: PointerEvent): void {
    const point = toImagePoint(event)
    if (point) applyDrag(point)
  }

  /** 结束拖动并移除全局监听 */
  function stopDrag(): void {
    drag = null
    dragging.value = false
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', stopDrag)
    window.removeEventListener('pointercancel', stopDrag)
  }

  /** 开始拖动：先测量再挂 window 级监听，保证松开鼠标一定能收尾 */
  function startDrag(mode: DragState, event: PointerEvent): void {
    drag = mode
    dragging.value = true
    measure()
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    event.preventDefault()
  }

  /** 以按下点为锚点重新框选 */
  function beginDraw(event: PointerEvent): void {
    measure()
    const point = toImagePoint(event)
    if (!point) return
    setBox({ x: point.x, y: point.y, width: 1, height: 1 })
    startDrag({ kind: 'draw', anchorX: point.x, anchorY: point.y }, event)
  }

  /** 舞台空白处按下：直接进入重新框选 */
  function onStageDown(event: PointerEvent): void {
    beginDraw(event)
  }

  /** 框体内按下：框选工具继续重新框选，调整工具整体移动 */
  function onBoxDown(event: PointerEvent): void {
    if (tool.value === 'draw') {
      beginDraw(event)
      return
    }
    measure()
    const point = toImagePoint(event)
    if (!point) return
    startDrag({ kind: 'move', offsetX: point.x - box.value.x, offsetY: point.y - box.value.y }, event)
  }

  /** 控制点按下：只调整对应边 */
  function onHandleDown(handle: RoiHandle, event: PointerEvent): void {
    startDrag({ kind: 'resize', handle }, event)
  }

  /** 外部重置区域时写回本地副本（不触发 onUpdate，避免 emit→watch→回灌 死循环） */
  function syncFrom(rect: ImageCropRect): void {
    box.value = { ...rect }
  }

  function dispose(): void {
    stopDrag()
  }

  return {
    box,
    tool,
    dragging,
    natural,
    imageRect,
    handles,
    measure,
    setBox,
    syncFrom,
    onImageLoad,
    onStageDown,
    onBoxDown,
    onHandleDown,
    dispose,
  }
}
