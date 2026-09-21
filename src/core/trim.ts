/** 帧最小边长：小于该尺寸的内容块不生成帧（自动识别与手动框选通用） */
export const MIN_FRAME_SIZE = 16

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

/** 扫描像素 alpha，求不透明内容的包围盒（自动识别透明边缘） */
export function trimBBox(imageData: ImageData, alphaThreshold = 8): BBox | null {
  const { width, height, data } = imageData
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** 四连通域分析：把图集中所有互不相连的内容块拆成多个帧候选 */
export function detectSprites(imageData: ImageData, alphaThreshold = 8): BBox[] {
  const { width, height, data } = imageData
  const visited = new Uint8Array(width * height)
  const boxes: BBox[] = []
  const stack: number[] = []
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]

  for (let start = 0; start < width * height; start++) {
    if (visited[start] || data[start * 4 + 3] <= alphaThreshold) continue
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    stack.length = 0
    stack.push(start)
    visited[start] = 1
    while (stack.length) {
      const idx = stack.pop()!
      const x = idx % width
      const y = (idx / width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (const [dx, dy] of dirs) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const ni = ny * width + nx
        if (!visited[ni] && data[ni * 4 + 3] > alphaThreshold) {
          visited[ni] = 1
          stack.push(ni)
        }
      }
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 })
  }

  // 按从上到下、从左到右排序，稳定帧序
  boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x))
  return boxes
}

/** 在给定区域内搜索不透明内容包围盒（Auto-fit 用），返回相对画布坐标 */
export function fitBoxToContent(
  source: HTMLCanvasElement,
  box: BBox,
  alphaThreshold = 8,
): BBox | null {
  const x0 = Math.max(0, Math.floor(box.x))
  const y0 = Math.max(0, Math.floor(box.y))
  const x1 = Math.min(source.width, Math.ceil(box.x + box.w))
  const y1 = Math.min(source.height, Math.ceil(box.y + box.h))
  if (x1 <= x0 || y1 <= y0) return null
  const w = x1 - x0
  const h = y1 - y0
  const ctx = source.getContext('2d')!
  const imageData = ctx.getImageData(x0, y0, w, h)
  const inner = trimBBox(imageData, alphaThreshold)
  if (!inner) return null
  return { x: x0 + inner.x, y: y0 + inner.y, w: inner.w, h: inner.h }
}
