/** 帧在纹理中的矩形区域（像素坐标，原点左上，打包方向） */
export interface FrameRect {
  x: number
  y: number
  w: number
  h: number
}

/** 规范化后的图集帧数据（兼容 JSON / plist / XML 三种元数据） */
export interface AtlasFrame {
  /** 唯一 id（用于 UI 选中与排序） */
  id: string
  /** 帧名，通常带扩展名，如 "run_01.png" */
  name: string
  /** 帧在纹理中的打包矩形（raw，未处理旋转） */
  rect: FrameRect
  /** 是否为旋转帧 */
  rotated: boolean
  /** 是否裁掉了透明边 */
  trimmed: boolean
  /** 源帧尺寸（原始帧宽高，未旋转） */
  sourceSize: { w: number; h: number }
  /** 内容矩形，相对于"旋转还原后的打包帧"画布（裁切实际内容时使用） */
  contentInFrame: FrameRect
  /** 内容矩形，相对于"原始源帧"坐标（还原完整帧时使用） */
  contentInOriginal: FrameRect
  /** 是否为手动框选创建的帧 */
  manual: boolean
}

export interface AtlasMeta {
  imagePath?: string
  size?: { w: number; h: number }
  format?: string
}

/** 元数据解析结果 */
export interface ParsedAtlas {
  format: 'json-hash' | 'json-array' | 'plist' | 'xml'
  frames: AtlasFrame[]
  meta: AtlasMeta
}
