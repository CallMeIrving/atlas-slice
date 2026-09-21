// 生成测试图集：512×512 透明底 + 动画序列/旋转帧/trimmed 偏移帧
// 输出 test-fixtures/{test.png, test.json, test-array.json, test.plist, test.xml}
// 用法：node scripts/gen-test-atlas.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures')
const W = 512
const H = 512
const px = new Uint8Array(W * H * 4) // RGBA，默认全透明

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = a
}

/** 斜条纹内容块：条纹随 phase 变化，肉眼可辨方向/动画差异 */
function stripeBlock(x0, y0, w, h, c1, c2, phase = 0) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = (x + y + phase * 6) % 12 < 6
      const c = on ? c1 : c2
      set(x0 + x, y0 + y, c[0], c[1], c[2])
    }
  }
}

/** 旋转帧：内容(sw×sh)顺时针 90° 打包进 rectW×rectH 区域（rectW=sh, rectH=sw） */
function rotatedBlock(x0, y0, rectW, rectH, sw, sh, c1, c2) {
  const content = new Uint8Array(sw * sh * 4)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const on = (x + y) % 12 < 6
      const c = on ? c1 : c2
      const i = (y * sw + x) * 4
      content[i] = c[0]
      content[i + 1] = c[1]
      content[i + 2] = c[2]
      content[i + 3] = 255
    }
  }
  // packed(bx, by) → restored(by, rectW-1-bx)
  for (let by = 0; by < rectH; by++) {
    for (let bx = 0; bx < rectW; bx++) {
      const rx = by
      const ry = rectW - 1 - bx
      const i = (ry * sw + rx) * 4
      set(x0 + bx, y0 + by, content[i], content[i + 1], content[i + 2], content[i + 3])
    }
  }
}

// ---- 绘制内容 ----
const RED = [224, 82, 66]
const ORANGE = [232, 150, 60]
const YELLOW = [222, 196, 70]
const LIME = [150, 190, 64]
const GREEN = [70, 170, 96]
const CYAN = [58, 178, 172]
const BLUE = [84, 132, 220]
const PURPLE = [154, 104, 200]
const ROSE = [216, 96, 148]
const BROWN = [176, 122, 78]
const GOLD = [238, 192, 80]
const SLATE = [120, 132, 150]

// 动画序列 run_01..run_10：48×48，条纹相位递增（动画感）
const runColors = [RED, ORANGE, YELLOW, LIME, GREEN, CYAN, BLUE, PURPLE, ROSE, BROWN]
const runDark = [120, 40, 32]
for (let i = 0; i < 10; i++) {
  const x = 10 + (i % 8) * 58
  const y = i < 8 ? 10 : 68
  stripeBlock(x, y, 48, 48, runColors[i], runDark, i)
}

// jump_01..03：32×48
for (let i = 0; i < 3; i++) stripeBlock(126 + i * 42, 68, 32, 48, GREEN, [40, 96, 54], i)
// idle_01..02：40×48
for (let i = 0; i < 2; i++) stripeBlock(252 + i * 50, 68, 40, 48, BLUE, [44, 72, 122], i)
// coin_01..03：32×32
for (let i = 0; i < 3; i++) stripeBlock(352 + i * 42, 68, 32, 32, GOLD, [150, 110, 30], i)

// sword.png：内容 72×24，顺时针旋转打包为 24×72
rotatedBlock(10, 126, 24, 72, 72, 24, SLATE, [70, 78, 92])
// shield.png：内容 44×44，在源帧 60×52 中偏移 (8,4)，打包为内容盒 44×44
stripeBlock(44, 126, 44, 44, PURPLE, [90, 58, 122], 2)
// hero.png：64×64
stripeBlock(98, 126, 64, 64, ROSE, [130, 52, 88], 4)

// ---- 元数据 ----
const FR = (x, y, w, h) => ({ x, y, w, h })
const framesHash = {
  hero: { name: 'hero.png', rect: FR(98, 126, 64, 64), rotated: false, trimmed: false, sprite: FR(0, 0, 64, 64), src: FR(0, 0, 64, 64) },
  sword: { name: 'sword.png', rect: FR(10, 126, 24, 72), rotated: true, trimmed: false, sprite: FR(0, 0, 72, 24), src: FR(0, 0, 72, 24) },
  shield: { name: 'shield.png', rect: FR(44, 126, 44, 44), rotated: false, trimmed: true, sprite: FR(8, 4, 44, 44), src: FR(0, 0, 60, 52) },
}
for (let i = 0; i < 10; i++) {
  const x = 10 + (i % 8) * 58
  const y = i < 8 ? 10 : 68
  framesHash[`run_${String(i + 1).padStart(2, '0')}`] = {
    name: `run_${String(i + 1).padStart(2, '0')}.png`,
    rect: FR(x, y, 48, 48),
    rotated: false,
    trimmed: false,
    sprite: FR(0, 0, 48, 48),
    src: FR(0, 0, 48, 48),
  }
}
for (let i = 0; i < 3; i++) {
  const n = `jump_${String(i + 1).padStart(2, '0')}`
  framesHash[n] = { name: `${n}.png`, rect: FR(126 + i * 42, 68, 32, 48), rotated: false, trimmed: false, sprite: FR(0, 0, 32, 48), src: FR(0, 0, 32, 48) }
}
for (let i = 0; i < 2; i++) {
  const n = `idle_${String(i + 1).padStart(2, '0')}`
  framesHash[n] = { name: `${n}.png`, rect: FR(252 + i * 50, 68, 40, 48), rotated: false, trimmed: false, sprite: FR(0, 0, 40, 48), src: FR(0, 0, 40, 48) }
}
for (let i = 0; i < 3; i++) {
  const n = `coin_${String(i + 1).padStart(2, '0')}`
  framesHash[n] = { name: `${n}.png`, rect: FR(352 + i * 42, 68, 32, 32), rotated: false, trimmed: false, sprite: FR(0, 0, 32, 32), src: FR(0, 0, 32, 32) }
}

function toTPJson(f) {
  return {
    frame: f.rect,
    rotated: f.rotated,
    trimmed: f.trimmed,
    spriteSourceSize: f.sprite,
    sourceSize: { w: f.src.w, h: f.src.h },
  }
}

const jsonHash = { frames: {}, meta: { image: 'test.png', size: { w: W, h: H }, format: 'RGBA8888' } }
for (const k of Object.keys(framesHash)) jsonHash.frames[framesHash[k].name] = toTPJson(framesHash[k])

const jsonArray = {
  frames: Object.values(framesHash).map((f) => ({ filename: f.name, ...toTPJson(f) })),
  meta: jsonHash.meta,
}

const plistFrames = {}
for (const f of Object.values(framesHash)) {
  const srcCx = f.sprite.x + f.sprite.w / 2
  const srcCy = f.sprite.y + f.sprite.h / 2
  plistFrames[f.name] = {
    frame: `{{${f.rect.x},${f.rect.y}},{${f.rect.w},${f.rect.h}}}`,
    offset: `{${Math.round(srcCx - f.src.w / 2)},${Math.round(srcCy - f.src.h / 2)}}`,
    rotated: f.rotated,
    sourceColorRect: `{{${f.sprite.x},${f.sprite.y}},{${f.sprite.w},${f.sprite.h}}}`,
    sourceSize: `{${f.src.w},${f.src.h}}`,
    ...(f.trimmed ? { trimmed: true } : {}),
  }
}
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>frames</key>
  <dict>
${Object.entries(plistFrames)
  .map(
    ([name, d]) => `    <key>${name}</key>
    <dict>
      <key>frame</key><string>${d.frame}</string>
      <key>offset</key><string>${d.offset}</string>
      <key>rotated</key>${d.rotated ? '<true/>' : '<false/>'}
      <key>sourceColorRect</key><string>${d.sourceColorRect}</string>
      <key>sourceSize</key><string>${d.sourceSize}</string>
      ${d.trimmed ? '<key>trimmed</key><true/>' : ''}
    </dict>`,
  )
  .join('\n')}
  </dict>
  <key>metadata</key>
  <dict>
    <key>format</key><integer>3</integer>
    <key>size</key><string>{${W},${H}}</string>
    <key>textureFileName</key><string>test.png</string>
  </dict>
</dict>
</plist>
`

const xmlSprites = Object.values(framesHash)
  .map((f) => {
    const base = `<sprite n="${f.name}" x="${f.rect.x}" y="${f.rect.y}" w="${f.rect.w}" h="${f.rect.h}"`
    if (f.rotated) {
      return `${base} r="y" oX="${f.sprite.x}" oY="${f.sprite.y}" oW="${f.src.w}" oH="${f.src.h}"/>`
    }
    if (f.trimmed) {
      return `${base} oX="${f.sprite.x}" oY="${f.sprite.y}" oW="${f.src.w}" oH="${f.src.h}"/>`
    }
    return `${base}/>`
  })
  .join('\n  ')
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TextureAtlas imagePath="test.png" width="${W}" height="${H}">
  ${xmlSprites}
</TextureAtlas>
`

// ---- PNG 编码 ----
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8
ihdr[9] = 6 // 8bit RGBA
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0
  for (let x = 0; x < W; x++) {
    const s = (y * W + x) * 4
    const d = y * (1 + W * 4) + 1 + x * 4
    raw[d] = px[s]
    raw[d + 1] = px[s + 1]
    raw[d + 2] = px[s + 2]
    raw[d + 3] = px[s + 3]
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'test.png'), png)
writeFileSync(join(OUT, 'test.json'), JSON.stringify(jsonHash, null, 2))
writeFileSync(join(OUT, 'test-array.json'), JSON.stringify(jsonArray, null, 2))
writeFileSync(join(OUT, 'test.plist'), plist)
writeFileSync(join(OUT, 'test.xml'), xml)
console.log(`已生成 ${Object.keys(framesHash).length} 帧的测试图集到 ${OUT}`)
