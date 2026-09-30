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
  /** 锚点（相对原帧的归一化坐标，0-1），未指定时引擎按各自默认处理 */
  pivot?: { x: number; y: number }
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

/**
 * 从帧名聚合命名动画：去掉扩展名后，以「结尾数字（可带 _ - 空格分隔）」归组，
 * 如 walk_0.png / walk-1.png / walk2.png 都归入 walk 组；组内按数字升序。
 * 只保留 2 帧及以上的组，单帧不成动画。
 */
export function groupAnimations(names: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  for (const name of names) {
    const stem = name.replace(/\.[^.]+$/, '')
    const m = stem.match(/^(.*?)[_\-\s]?(\d+)$/)
    if (!m || !m[1]) continue
    ;(groups[m[1]] ??= []).push(name)
  }
  const result: Record<string, string[]> = {}
  for (const [base, list] of Object.entries(groups)) {
    if (list.length < 2) continue
    list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    result[base] = list
  }
  return result
}

/** 生成 TexturePacker 哈希格式的 JSON 元数据；imageName 为纹理文件名（可与图集 PNG 同名） */
export function buildAtlasJson(
  meta: Record<string, FrameMeta>,
  atlas: { w: number; h: number },
  imageName = 'atlas.png',
  animations?: Record<string, string[]>,
): string {
  return JSON.stringify(
    {
      frames: meta,
      // 命名动画分组（可选）：引擎或运行时可据此直接取帧序列
      ...(animations && Object.keys(animations).length ? { animations } : {}),
      meta: { app: 'atlas-slice', format: 'RGBA8888', image: imageName, size: atlas },
    },
    null,
    2,
  )
}

/**
 * 生成 TexturePacker 数组格式的 JSON 元数据（frames 为数组，每项附 filename）。
 * 部分引擎（如 Phaser 旧版、Cocos Creator 部分导入器）只认数组格式。
 */
export function buildAtlasJsonArray(
  meta: Record<string, FrameMeta>,
  atlas: { w: number; h: number },
  imageName = 'atlas.png',
  animations?: Record<string, string[]>,
): string {
  const frames = Object.entries(meta).map(([filename, m]) => ({ filename, ...m }))
  return JSON.stringify(
    {
      frames,
      ...(animations && Object.keys(animations).length ? { animations } : {}),
      meta: { app: 'atlas-slice', format: 'RGBA8888', image: imageName, size: atlas },
    },
    null,
    2,
  )
}

/**
 * 生成 CSS sprites 样式表：每个帧一条 `.类名 { width/height/background-position }` 规则。
 * 旋转帧无法用 background 无损表达（transform 会破坏布局），跳过并返回名单由调用方提示。
 */
export function buildCssSprites(
  meta: Record<string, FrameMeta>,
  imageName = 'atlas.png',
): { css: string; skipped: string[] } {
  const skipped: string[] = []
  const rules: string[] = [
    `.atlas-slice { background-image: url("${imageName}"); background-repeat: no-repeat; display: inline-block; }`,
  ]
  for (const [name, m] of Object.entries(meta)) {
    if (m.rotated) {
      skipped.push(name)
      continue
    }
    // 类名：文件名去扩展名，非法 CSS 字符替换为下划线
    const className = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
    rules.push(
      `.atlas-slice.${className} { width: ${m.frame.w}px; height: ${m.frame.h}px; background-position: -${m.frame.x}px -${m.frame.y}px; }`,
    )
  }
  return { css: rules.join('\n') + '\n', skipped }
}