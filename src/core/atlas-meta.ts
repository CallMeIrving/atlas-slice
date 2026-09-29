/**
 * 图集元数据的共享构建层。
 *
 * 「精灵图导出」「智能图集打包」「多方向精灵」都要输出同一套 TexturePacker 兼容元数据，
 * 这里作为单一数据源，避免各处各写一份 JSON / plist 结构导致格式漂移。
 *
 * 坐标约定（与 parsers/json.ts 的回读逻辑保持一致）：
 * - `frame`：纹理中的实际打包矩形；旋转帧记的是「已旋转后」的 w/h，并置 `rotated: true`
 * - `sourceSize`：未旋转的原始帧尺寸
 * - `spriteSourceSize`：内容相对原帧的偏移矩形
 */

/** 单个帧的元数据描述（几何字段以图集坐标记录） */
export interface FrameMeta {
  /** 帧在图集中的打包矩形（raw，旋转帧为旋转后的 w/h） */
  frame: { x: number; y: number; w: number; h: number }
  rotated: boolean
  trimmed: boolean
  /** 内容矩形，相对原始源帧坐标 */
  spriteSourceSize: { x: number; y: number; w: number; h: number }
  /** 原始帧尺寸（未旋转） */
  sourceSize: { w: number; h: number }
  /** 工具私有字段：是否为手动框选创建的帧 */
  manual: boolean
}

/** plist 矩形字符串 {{x,y},{w,h}} */
export function plistRect(r: { x: number; y: number; w: number; h: number }): string {
  return `{{${r.x},${r.y}},{${r.w},${r.h}}}`
}

/** 生成 cocos2d 格式 3 的 plist 元数据；imageName 为纹理文件名 */
export function buildPlist(
  meta: Record<string, FrameMeta>,
  atlas: { w: number; h: number },
  imageName = 'atlas.png',
): string {
  const entries = Object.entries(meta)
    .map(([name, m]) => {
      return `    <key>${name}</key>
    <dict>
      <key>frame</key><string>${plistRect(m.frame)}</string>
      <key>offset</key><string>{0,0}</string>
      <key>rotated</key>${m.rotated ? '<true/>' : '<false/>'}
      <key>trimmed</key>${m.trimmed ? '<true/>' : '<false/>'}
      <key>sourceColorRect</key><string>${plistRect(m.spriteSourceSize)}</string>
      <key>sourceSize</key><string>{${m.sourceSize.w},${m.sourceSize.h}}</string>
      <key>manual</key>${m.manual ? '<true/>' : '<false/>'}
    </dict>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>frames</key>
  <dict>
${entries}
  </dict>
  <key>metadata</key>
  <dict>
    <key>format</key><integer>3</integer>
    <key>size</key><string>{${atlas.w},${atlas.h}}</string>
    <key>textureFileName</key><string>${imageName}</string>
  </dict>
</dict>
</plist>
`
}

/** 生成 TexturePacker 哈希格式的 JSON 元数据；imageName 为纹理文件名（可与图集 PNG 同名） */
export function buildAtlasJson(
  meta: Record<string, FrameMeta>,
  atlas: { w: number; h: number },
  imageName = 'atlas.png',
): string {
  return JSON.stringify(
    {
      frames: meta,
      meta: { app: 'atlas-slice', format: 'RGBA8888', image: imageName, size: atlas },
    },
    null,
    2,
  )
}