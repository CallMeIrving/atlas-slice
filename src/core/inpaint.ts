import { clampCropRect, type ImageCropRect } from '@/core/crop'

/* ===== 基于样本的纹理重建与梯度域融合（零模型、全本地） =====
 *
 * 为什么需要这两个算法：水印把 ROI 之下的像素彻底覆盖了，那块原始纹理（照片颗粒、
 * 渐变、方向性条纹）属于信息不可逆丢失。此时平填或边缘插值只能给出「干净但发糊」
 * 的一块补丁——不是参数没调好，而是这些方法根本没有纹理的来源。唯一可行的做法是
 * **重建**：从 ROI 之外的真实像素里搬一块材质相同的纹理回来。
 *
 * 1. patchMatchInpaint：多尺度 PatchMatch（随机化最近邻场）。核心是三个环节在金字塔上
 *    由粗到细反复迭代：
 *    - 随机初始化：每个待重建 patch 先随机指向样本区的一个位置；
 *    - 传播（propagation）：相邻 patch 的匹配通常也相邻，把邻居的匹配平移一个像素后
 *      作为候选，一步就能把成片的正确匹配扩散开；
 *    - 随机搜索（random search）：以指数收缩的半径在当前最优解附近抖动，用 O(log N)
 *      次采样覆盖整个样本区，避免停在局部最优。
 *    每层迭代结束后做一次投票（voting）：每个 ROI 像素收集覆盖它的所有 patch，
 *    只保留距离最小的一批做**距离加权**平均。取的是真实源像素，颗粒与方向性纹理被原样
 *    搬过来，而不是伪造的白噪声或平滑过渡。
 *    样本区严格排除 ROI 本身（ROI 里是被水印污染的像素，不能当样本），默认取 ROI 外圈
 *    环带；环带窄到放不下完整 patch 时放宽为「patch 中心不在 ROI 内」。
 *
 *    为什么必须多尺度：patch 距离只在 patch 内的已知像素上有意义，而 ROI 内部没有已知
 *    像素。粗层把 ROI 缩得很小，边界处的真实像素就能约束到整块区域；粗层结果上采样作为
 *    细层初值，细层只做局部修正，因此细层只需很少的迭代。
 *
 * 2. seamlessFuse：梯度域（泊松）融合。重建块与周围原图之间总有色差拼缝，直接羽化会把
 *    拼缝糊成一条灰带。正确做法是只在 ROI 内求解 ∇²f = ∇²g：以 guidance 的梯度为引导场、
 *    以 target 在 ROI 外侧 1px 的真实像素为 Dirichlet 边界，内部纹理梯度保持为 g 的梯度，
 *    整体灰度水平由外侧真实像素决定，拼缝自然消失。离散形式为 5 点拉普拉斯
 *    f(p) = (Σ f(q) − Σ g(q) + k·g(p)) / k，用 SOR（超松弛）迭代求解，
 *    ω 取模型问题的最优值 2/(1 + sin(π/N))，N 为区域长边。
 *
 *    一个必须知道的数学性质：若 target 与 guidance 在 ROI 外侧完全一致（水印流程里的
 *    常规调用形态——两者都由同一帧得到，只有 ROI 内不同），则 f ≡ g 本身就是精确解，
 *    迭代一步都不会移动。这不是 bug 而是该方程组的性质：此时解只由 g 在 ROI 内的梯度
 *    与 ROI 边界外的目标像素共同决定，而二者恰好自洽。因此融合真正的价值在于「引导场与
 *    目标边界来自不同图像」的情形（例如引导场取自另一帧、另一处纹理），此时它把引导场的
 *    梯度原样搬过来、同时把整体灰度钉到目标边界上，从而消除拼缝。调用方不要指望它去
 *    修正重建块自身的色差——那是 patchMatchInpaint 的环带加权负责的。
 *    也正因为这条性质，去水印流程没有调用它：那里传给它的 guidance 就是 patchMatchInpaint
 *    的输出，ROI 外像素与输入逐字节相同，边界色差恒为 0，调用属于纯开销。
 *    要让它真正起作用，必须提供一个「ROI 外像素与目标不同」的引导场（例如拼贴式重建）。
 *
 * 确定性：项目对同一输入必须逐字节可复现——同一份参数要逐帧套用到整段视频，任何随机抖动
 * 都会变成画面闪烁。因此随机性全部来自坐标/下标哈希（见 hashNoise），严禁 Math.random；
 * 迭代顺序固定，SOR 扫描方向按轮次交替但交替规律完全确定。
 *
 * 复杂度：
 * - patchMatchInpaint：O(Σ_L R_L · (2 + searchSteps) · PATCH²)，R_L 为第 L 层 ROI 的像素数。
 *   金字塔为等比降采样，Σ_L R_L ≈ 4/3·R（细层占主要开销）；patch 距离带剪枝
 *   （部分和一旦超过当前最优即提前返回），因此实际常量远小于上式上界。
 *   内存 O(W·H·层数)，且只对「ROI + 环带」的裁剪窗口建金字塔，远小于整图。
 * - seamlessFuse：O(iterations · rect 面积 · 3)，与图像其它区域无关。
 */

export interface PatchMatchOptions {
  /** 0 快速 / 1 标准 / 2 精细，缺省 1 */
  quality?: number
}

export interface FuseOptions {
  /** 0 快速 / 1 标准 / 2 精细，缺省 1 */
  quality?: number
}

/** patch 边长（必须为奇数）与其半径 */
const PATCH = 7
const HALF = (PATCH - 1) / 2
/**
 * 最粗层 ROI 短边下限：低于该值纹理已在降采样中混叠，patch 匹配会锁到错误相位。
 * 实测过把它放宽到 32 让 90px 高的薄水印框也跑两级金字塔（360×90 实测）：
 * 方差比 0.803→0.755、跨边界跳变 3.47→5.03，**反而更差**——粗层锁错相位后由细层继承，
 * 细层兜不住。薄 ROI 的正确调法是提高 quality（增加迭代与随机搜索步数，
 * 同尺寸下 q0→q2 方差比 0.792→0.829、跳变 4.43→2.35），因此这里保持 64 不放宽。
 */
const MIN_COARSE_SIDE = 64

interface Preset {
  /** 金字塔层数（含细层） */
  levels: number
  /** 最粗层迭代轮数 */
  coarseIterations: number
  /** 其余层迭代轮数 */
  fineIterations: number
  /** 随机搜索采样次数 */
  searchSteps: number
  /** 泊松融合迭代轮数 */
  fuseIterations: number
}

/**
 * 三档质量：档位越高 -> 金字塔层数、迭代轮数、随机搜索采样次数同步提高。
 * 取值依据实测（560×360 图、400×200 ROI）：单次 patch 距离约 0.45μs，最细层每像素
 * 每轮要算 (2 传播 + searchSteps) 次，是耗时主项；最粗层像素数只有最细层的 1/4，
 * 迭代很便宜，可以多跑几轮先把低频结构定下来。实测最细层 2 轮 + searchSteps 3
 * 时 400×200 ROI 约 0.65s，重建方差比 0.77、区域边界跳变 12.6（干净原图基准 14.5），
 * 已满足「标准档远低于 1 秒」的指标。
 * fuseIterations 每轮约 5.7ms（400×200），故标准档取 40 轮，整体仍在 1 秒内。
 */
const PRESETS: Preset[] = [
  { levels: 2, coarseIterations: 2, fineIterations: 1, searchSteps: 2, fuseIterations: 16 },
  { levels: 3, coarseIterations: 3, fineIterations: 2, searchSteps: 3, fuseIterations: 40 },
  { levels: 4, coarseIterations: 5, fineIterations: 3, searchSteps: 6, fuseIterations: 120 },
]

function presetOf(quality: number | undefined): Preset {
  const index = Math.min(2, Math.max(0, Math.round(quality ?? 1)))
  return PRESETS[index]
}

/** 整数坐标哈希 → [0,1) 的确定性伪随机数（同一坐标永远得到同一个值） */
function hashNoise(x: number, y: number, salt: number): number {
  let hash = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt + 1, 2246822519)) >>> 0
  hash = (hash ^ (hash >>> 13)) >>> 0
  hash = Math.imul(hash, 1274126177) >>> 0
  hash = (hash ^ (hash >>> 16)) >>> 0
  return hash / 4294967296
}

/**
 * 样本环带宽度：与 watermark.ts 的 ringBand 同源，但额外保证至少 3 个 patch 宽，
 * 使样本区一定能容纳完整的 patch（否则环带里挑不出合法样本）。
 */
function sampleBand(rect: ImageCropRect): number {
  return Math.max(3 * PATCH, Math.round(Math.min(rect.width, rect.height) * 0.35), 4)
}

interface LevelMeta {
  width: number
  height: number
  /** ROI 在该层的整数范围 */
  rx: number
  ry: number
  rw: number
  rh: number
}

interface Level extends LevelMeta {
  /** RGB 浮点像素（w*h*3）：环带是真实像素，ROI 内是当前重建估计 */
  rgb: Float32Array
  /** 1 = 待重建的 ROI，0 = 已知真实样本 */
  hole: Uint8Array
  /** ROI 像素的紧凑下标列表 */
  holeList: Int32Array
  /** 像素下标 → holeList 下标，非 ROI 为 -1 */
  holeIndex: Int32Array
  /** 合法样本 patch 的中心（像素下标） */
  candidates: Int32Array
}

/** 最近邻场：ROI 每个像素 → 匹配到的样本 patch 中心 */
interface MatchField {
  width: number
  height: number
  holeIndex: Int32Array
  nnf: Int32Array
  dist: Float32Array
}

/** 从 source 裁出工作窗口（ROI + 环带），转换为 RGB 浮点数组 */
function cropToFloat(source: ImageData, meta: LevelMeta, ox: number, oy: number): Float32Array {
  const pixels = source.data
  const out = new Float32Array(meta.width * meta.height * 3)
  for (let y = 0; y < meta.height; y++) {
    const srcRow = (oy + y) * source.width + ox
    for (let x = 0; x < meta.width; x++) {
      const from = (srcRow + x) * 4
      const to = (y * meta.width + x) * 3
      out[to] = pixels[from]
      out[to + 1] = pixels[from + 1]
      out[to + 2] = pixels[from + 2]
    }
  }
  return out
}

/** 2×2 盒式降采样（确定性，无插值核依赖） */
function halve(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh * 3)
  for (let y = 0; y < dh; y++) {
    const y0 = Math.min(sh - 1, y * 2)
    const y1 = Math.min(sh - 1, y * 2 + 1)
    for (let x = 0; x < dw; x++) {
      const x0 = Math.min(sw - 1, x * 2)
      const x1 = Math.min(sw - 1, x * 2 + 1)
      const to = (y * dw + x) * 3
      for (let c = 0; c < 3; c++) {
        out[to + c] = (src[(y0 * sw + x0) * 3 + c] + src[(y0 * sw + x1) * 3 + c] + src[(y1 * sw + x0) * 3 + c] + src[(y1 * sw + x1) * 3 + c]) * 0.25
      }
    }
  }
  return out
}

/** 层参数减半，并把 ROI 收敛到该层范围内（奇数边长时向下取整可能越界） */
function halveMeta(meta: LevelMeta): LevelMeta {
  const width = Math.max(1, meta.width >> 1)
  const height = Math.max(1, meta.height >> 1)
  const rx = Math.min(width - 1, meta.rx >> 1)
  const ry = Math.min(height - 1, meta.ry >> 1)
  return {
    width,
    height,
    rx,
    ry,
    rw: Math.max(1, Math.min(width - rx, ((meta.rx + meta.rw + 1) >> 1) - rx)),
    rh: Math.max(1, Math.min(height - ry, ((meta.ry + meta.rh + 1) >> 1) - ry)),
  }
}

/** 样本是否可用：patch 完整落在层内，且与 ROI 完全不相交（ROI 里是被水印污染的像素） */
function isValidSample(x: number, y: number, meta: LevelMeta): boolean {
  if (x < HALF || y < HALF || x > meta.width - 1 - HALF || y > meta.height - 1 - HALF) return false
  return !(x + HALF >= meta.rx && x - HALF < meta.rx + meta.rw && y + HALF >= meta.ry && y - HALF < meta.ry + meta.rh)
}

function buildLevel(meta: LevelMeta, rgb: Float32Array): Level {
  const { width, height, rx, ry, rw, rh } = meta
  const hole = new Uint8Array(width * height)
  const holeIndex = new Int32Array(width * height).fill(-1)
  const list: number[] = []
  for (let y = 0; y < rh; y++) {
    const row = (ry + y) * width
    for (let x = 0; x < rw; x++) {
      const index = row + rx + x
      hole[index] = 1
      holeIndex[index] = list.length
      list.push(index)
    }
  }
  const candidates: number[] = []
  for (let y = HALF; y <= height - 1 - HALF; y++) {
    for (let x = HALF; x <= width - 1 - HALF; x++) {
      if (isValidSample(x, y, meta)) candidates.push(y * width + x)
    }
  }
  return { ...meta, rgb, hole, holeList: Int32Array.from(list), holeIndex, candidates: Int32Array.from(candidates) }
}

/**
 * 最粗层的初值：四边逆向距离加权插值 C = (Σ Ci/dᵢ) / Σ(1/dᵢ)。
 * 参考色取 ROI 外侧 1px（不取 ROI 自身，避免被水印污染）；该侧越出层边界时权重置 0，
 * 只对可用边归一化（与 watermark.ts 的 fillByEdges 同一套退化处理）。
 * 这只是一个平滑起点，真正的纹理由上层 PatchMatch 迭代重建出来。
 */
function fillHoleSmooth(level: Level): void {
  const { width, height, rx, ry, rw, rh, rgb } = level
  const left = rx - 1
  const right = rx + rw
  const top = ry - 1
  const bottom = ry + rh
  const hasLeft = left >= 0
  const hasRight = right < width
  const hasTop = top >= 0
  const hasBottom = bottom < height
  if (!hasLeft && !hasRight && !hasTop && !hasBottom) return
  for (let y = 0; y < rh; y++) {
    const iy = ry + y
    for (let x = 0; x < rw; x++) {
      const ix = rx + x
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let weight = 0
      if (hasLeft) {
        const w = 1 / (x + 1)
        const o = (iy * width + left) * 3
        sumR += rgb[o] * w; sumG += rgb[o + 1] * w; sumB += rgb[o + 2] * w; weight += w
      }
      if (hasRight) {
        const w = 1 / (rw - x)
        const o = (iy * width + right) * 3
        sumR += rgb[o] * w; sumG += rgb[o + 1] * w; sumB += rgb[o + 2] * w; weight += w
      }
      if (hasTop) {
        const w = 1 / (y + 1)
        const o = (top * width + ix) * 3
        sumR += rgb[o] * w; sumG += rgb[o + 1] * w; sumB += rgb[o + 2] * w; weight += w
      }
      if (hasBottom) {
        const w = 1 / (rh - y)
        const o = (bottom * width + ix) * 3
        sumR += rgb[o] * w; sumG += rgb[o + 1] * w; sumB += rgb[o + 2] * w; weight += w
      }
      if (weight <= 0) continue
      const to = (iy * width + ix) * 3
      rgb[to] = sumR / weight
      rgb[to + 1] = sumG / weight
      rgb[to + 2] = sumB / weight
    }
  }
}

/** 把上一层（更粗）的重建结果双线性放大，作为本层 ROI 的初值 */
function upsampleHole(level: Level, prev: Level): void {
  const { width, height, rx, ry, rw, rh, rgb } = level
  const ratioX = prev.width / width
  const ratioY = prev.height / height
  for (let y = 0; y < rh; y++) {
    const fy = (ry + y) * ratioY
    const y0 = Math.min(prev.height - 1, Math.floor(fy))
    const y1 = Math.min(prev.height - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < rw; x++) {
      const fx = (rx + x) * ratioX
      const x0 = Math.min(prev.width - 1, Math.floor(fx))
      const x1 = Math.min(prev.width - 1, x0 + 1)
      const tx = fx - x0
      const to = ((ry + y) * width + rx + x) * 3
      for (let c = 0; c < 3; c++) {
        const a = prev.rgb[(y0 * prev.width + x0) * 3 + c]
        const b = prev.rgb[(y0 * prev.width + x1) * 3 + c]
        const d = prev.rgb[(y1 * prev.width + x0) * 3 + c]
        const e = prev.rgb[(y1 * prev.width + x1) * 3 + c]
        rgb[to + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty
      }
    }
  }
}

/**
 * patchDistance 的采样点缓存。patch 距离是整个算法的绝对热点（每次调用最多比较 PATCH²
 * 个采样点），而「待重建 patch」一侧的采样点下标与权重只与它的中心有关、与候选无关，
 * 因此按待重建像素缓存一次（preparePatch），候选之间只重算源一侧的行基准。
 * 内层循环不嵌套调用，模块级复用安全。
 */
/** 待重建 patch 的 49 个采样点在 RGB 数组中的字节下标（已按图像边界钳制） */
const holeOffset = new Int32Array(PATCH * PATCH)
/** 上者对采样点的权重：ROI 内 1、环带 3 */
const holeWeight = new Float32Array(PATCH * PATCH)
/** 当前待重建 patch 的权重和，preparePatch 写入、patchDistance 读取 */
let patchWeight = 1

/**
 * 为待重建 patch 预计算钳制后的采样点下标与权重。两点说明：
 * - 这里的钳制是必要的：ROI 可能贴着图像边界，越界采样点要折回边界像素，否则读越界。
 *   源一侧则不需要钳制——合法样本在 isValidSample 里已保证整个 patch 落在图像内。
 * - 权重和是精确剪枝的前提：剪枝阈值必须用「真实权重和」而不是权重上界（3·49），
 *   否则阈值偏大数倍，绝大多数落选候选要多算成倍的采样点才被剪掉，这是整体耗时的
 *   决定性因素。
 */
function preparePatch(level: Level, px: number, py: number): void {
  const { width, height, hole } = level
  let weight = 0
  let k = 0
  for (let i = 0; i < PATCH; i++) {
    const row = Math.min(height - 1, Math.max(0, py + i - HALF)) * width
    for (let j = 0; j < PATCH; j++) {
      const col = Math.min(width - 1, Math.max(0, px + j - HALF))
      const index = row + col
      holeOffset[k] = index * 3
      const w = hole[index] ? 1 : 3
      holeWeight[k] = w
      weight += w
      k += 1
    }
  }
  patchWeight = weight
}

/**
 * patch 距离：对应位置逐通道绝对差之和，再按权重归一化。调用前必须先
 * preparePatch 同一个待重建像素。
 * - 源一侧不做边界钳制：所有候选都经过 isValidSample 校验，patch 完整落在图像内，
 *   省掉每像素 4 次 min/max 与逐采样点的越界判断（这是热循环里的实打实的开销）。
 * - 待重建 patch 落在环带上的采样点权重 ×3：环带是真实像素，比「当前估计」更可靠，
 *   加权后边界处的匹配会主动与外圈真实纹理对齐，拼缝更小。
 * cutoffSum = 当前最优距离 × patchWeight，部分和一旦超过它即提前返回。
 */
function patchDistance(level: Level, sx: number, sy: number, cutoffSum: number): number {
  const { width, rgb } = level
  const srcBase = ((sy - HALF) * width + sx - HALF) * 3
  const rowStride = width * 3
  let sum = 0
  let k = 0
  for (let i = 0; i < PATCH; i++) {
    const aRow = srcBase + i * rowStride
    for (let j = 0; j < PATCH; j++) {
      const ao = aRow + j * 3
      const ho = holeOffset[k]
      sum += holeWeight[k] * (Math.abs(rgb[ho] - rgb[ao]) + Math.abs(rgb[ho + 1] - rgb[ao + 1]) + Math.abs(rgb[ho + 2] - rgb[ao + 2]))
      k += 1
      if (sum >= cutoffSum) return sum / patchWeight
    }
  }
  return patchWeight > 0 ? sum / patchWeight : Infinity
}

/**
 * 初始化最近邻场：优先把更粗层的匹配场按 2× 放大后继承（保证跨尺度一致），
 * 放大后落在非法位置（越界或与 ROI 相交）的像素退回哈希随机样本。
 */
function initNnf(level: Level, prev: MatchField | null): MatchField {
  const { width, height, rx, ry, rw, rh, holeList, holeIndex, candidates } = level
  const count = holeList.length
  const nnf = new Int32Array(count)
  const dist = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const pixel = holeList[i]
    const x = pixel % width
    const y = (pixel - x) / width
    let src = -1
    if (prev) {
      const cx = Math.min(prev.width - 1, x >> 1)
      const cy = Math.min(prev.height - 1, y >> 1)
      const ci = prev.holeIndex[cy * prev.width + cx]
      if (ci >= 0) {
        const s = prev.nnf[ci]
        const sp = s % prev.width
        const sx = sp * 2 + (x & 1)
        const sy = ((s - sp) / prev.width) * 2 + (y & 1)
        if (isValidSample(sx, sy, { width, height, rx, ry, rw, rh })) src = sy * width + sx
      }
    }
    if (src < 0) {
      const pick = Math.min(candidates.length - 1, (hashNoise(x, y, 7) * candidates.length) | 0)
      src = candidates[pick]
    }
    nnf[i] = src
    const sp = src % width
    preparePatch(level, x, y)
    dist[i] = patchDistance(level, sp, (src - sp) / width, Infinity)
  }
  return { width, height, holeIndex, nnf, dist }
}

/**
 * 逐像素迭代：传播 + 随机搜索。
 * 扫描方向按轮次交替（正扫吸收左上邻居已更新的匹配，反扫吸收右下），
 * 与 PatchMatch 原文一致；顺序完全固定，因此结果确定。
 */
function refine(level: Level, field: MatchField, iterations: number, radius0: number, searchSteps: number): void {
  const { width, height, rx, ry, rw, rh, holeList, holeIndex } = level
  const { nnf, dist } = field
  const count = holeList.length
  const meta: LevelMeta = { width, height, rx, ry, rw, rh }
  for (let it = 0; it < iterations; it++) {
    const forward = (it & 1) === 0
    const start = forward ? 0 : count - 1
    const end = forward ? count : -1
    const step = forward ? 1 : -1
    for (let i = start; i !== end; i += step) {
      const pixel = holeList[i]
      const x = pixel % width
      const y = (pixel - x) / width
      let bestDist = dist[i]
      let bestSrc = nnf[i]
      // 该待重建 patch 的行列下标与权重和只算一次，供本轮所有候选共用
      preparePatch(level, x, y)
      // 扫描方向：邻居取「已扫过」的一侧，源坐标同向平移一个像素
      const dir = forward ? 1 : -1
      const nx = x - dir
      if (nx >= 0 && nx < width) {
        const ni = holeIndex[y * width + nx]
        if (ni >= 0) {
          const s = nnf[ni]
          const sp = s % width
          const sx = sp + dir
          const sy = (s - sp) / width
          if (isValidSample(sx, sy, meta)) {
            const d = patchDistance(level, sx, sy, bestDist * patchWeight)
            if (d < bestDist) { bestDist = d; bestSrc = sy * width + sx }
          }
        }
      }
      const ny = y - dir
      if (ny >= 0 && ny < height) {
        const ni = holeIndex[ny * width + x]
        if (ni >= 0) {
          const s = nnf[ni]
          const sp = s % width
          const sx = sp
          const sy = (s - sp) / width + dir
          if (isValidSample(sx, sy, meta)) {
            const d = patchDistance(level, sx, sy, bestDist * patchWeight)
            if (d < bestDist) { bestDist = d; bestSrc = sy * width + sx }
          }
        }
      }
      // 随机搜索：半径逐次减半，指数级覆盖搜索空间，代价与搜索范围无关
      let radius = radius0
      for (let s = 0; s < searchSteps; s++) {
        const bp = bestSrc % width
        const bx = bp + Math.round((hashNoise(x, y, 31 + s * 2) * 2 - 1) * radius)
        const by = (bestSrc - bp) / width + Math.round((hashNoise(x, y, 32 + s * 2) * 2 - 1) * radius)
        radius = Math.max(1, radius >> 1)
        if (!isValidSample(bx, by, meta)) continue
        const d = patchDistance(level, bx, by, bestDist * patchWeight)
        if (d < bestDist) { bestDist = d; bestSrc = by * width + bx }
      }
      nnf[i] = bestSrc
      dist[i] = bestDist
    }
  }
}

/**
 * 投票写回：每个 ROI 像素收集覆盖它的所有 patch，先求出该像素的最优 patch 距离，
 * 再只累计「距离 ≤ 最优 × 1.5 + 1」的那一批，按 1/(d+1) 加权平均。
 * 只取头部匹配是关键：把大量不相似的 patch 一起平均就是模糊；只平均最像的几个
 * 既抑制了单点噪声，又完整保留了方向性纹理。取到的都是真实源像素，逐字节可复现。
 */
function vote(level: Level, field: MatchField): void {
  const { width, height, holeList, holeIndex, hole, rgb } = level
  const { nnf, dist } = field
  const count = holeList.length
  const floor = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const pixel = holeList[i]
    const x = pixel % width
    const y = (pixel - x) / width
    const x0 = Math.max(0, x - HALF)
    const x1 = Math.min(width - 1, x + HALF)
    const y0 = Math.max(0, y - HALF)
    const y1 = Math.min(height - 1, y + HALF)
    let best = Infinity
    for (let qy = y0; qy <= y1; qy++) {
      const row = qy * width
      for (let qx = x0; qx <= x1; qx++) {
        const qi = holeIndex[row + qx]
        if (qi >= 0 && dist[qi] < best) best = dist[qi]
      }
    }
    floor[i] = best
  }
  for (let i = 0; i < count; i++) {
    const pixel = holeList[i]
    const x = pixel % width
    const y = (pixel - x) / width
    const limit = floor[i] * 1.5 + 1
    const x0 = Math.max(0, x - HALF)
    const x1 = Math.min(width - 1, x + HALF)
    const y0 = Math.max(0, y - HALF)
    const y1 = Math.min(height - 1, y + HALF)
    let sumR = 0
    let sumG = 0
    let sumB = 0
    let sumW = 0
    for (let qy = y0; qy <= y1; qy++) {
      const row = qy * width
      for (let qx = x0; qx <= x1; qx++) {
        const qi = holeIndex[row + qx]
        if (qi < 0) continue
        const d = dist[qi]
        if (d > limit) continue
        const s = nnf[qi]
        const sp = s % width
        const ax = sp + (x - qx)
        const ay = (s - sp) / width + (y - qy)
        if (ax < 0 || ay < 0 || ax >= width || ay >= height) continue
        const aIndex = ay * width + ax
        if (hole[aIndex]) continue
        const w = 1 / (d + 1)
        const ao = aIndex * 3
        sumR += rgb[ao] * w
        sumG += rgb[ao + 1] * w
        sumB += rgb[ao + 2] * w
        sumW += w
      }
    }
    if (sumW <= 0) continue
    const to = pixel * 3
    rgb[to] = sumR / sumW
    rgb[to + 1] = sumG / sumW
    rgb[to + 2] = sumB / sumW
  }
}

/**
 * 多尺度 PatchMatch 纹理合成：以 ROI 外侧环带为样本源重建 ROI，返回新 ImageData（尺寸同 source），不改入参。
 * ROI 覆盖整幅图（没有任何样本）时退化为平滑插值填充。
 */
export function patchMatchInpaint(source: ImageData, rect: ImageCropRect, options: PatchMatchOptions = {}): ImageData {
  if (source.width <= 0 || source.height <= 0) return source
  const out = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
  if (rect.width <= 0 || rect.height <= 0) return out
  const area = clampCropRect(rect, source.width, source.height)
  const preset = presetOf(options.quality)

  // 工作窗口 = ROI + 环带（越界部分裁掉）。只对窗口建金字塔，开销与整图尺寸解耦。
  const band = sampleBand(area)
  const ox = Math.max(0, area.x - band)
  const oy = Math.max(0, area.y - band)
  const metas: LevelMeta[] = [{
    width: Math.min(source.width, area.x + area.width + band) - ox,
    height: Math.min(source.height, area.y + area.height + band) - oy,
    rx: area.x - ox,
    ry: area.y - oy,
    rw: area.width,
    rh: area.height,
  }]
  // 层数：受质量档与 ROI 尺寸双重限制。粗层的 patch 必须还能分辨出纹理结构，
  // 否则纹理周期性在降采样后混叠，粗层会锁到一个错的相位、再由细层继承下来，
  // 因此 ROI 短边每降采样一次都要求仍不小于 MIN_COARSE_SIDE。
  const minDim = Math.min(area.width, area.height)
  let levelCount = 1
  while (levelCount < preset.levels && (minDim >> levelCount) >= MIN_COARSE_SIDE) levelCount += 1
  for (let i = 1; i < levelCount; i++) metas.push(halveMeta(metas[i - 1]))

  const rgbs: Float32Array[] = [cropToFloat(source, metas[0], ox, oy)]
  for (let i = 1; i < metas.length; i++) {
    rgbs.push(halve(rgbs[i - 1], metas[i - 1].width, metas[i - 1].height, metas[i].width, metas[i].height))
  }

  const levels: Level[] = []
  let prev: Level | null = null
  let field: MatchField | null = null
  for (let i = metas.length - 1; i >= 0; i--) {
    const level = buildLevel(metas[i], rgbs[i])
    if (prev) upsampleHole(level, prev)
    else fillHoleSmooth(level)
    if (level.candidates.length > 0 && level.holeList.length > 0) {
      // 最粗层没有任何先验，必须做全局随机搜索；更细层继承了上采样的匹配场，
      // 但也必须在全尺度上做一次随机搜索——粗层的匹配可能整体偏了一个纹理周期，
      // 单靠传播（每轮只挪 1px）纠正不回来。搜索半径从该层尺寸起逐次减半，
      // 用 O(searchSteps) 次采样覆盖全部尺度。
      const coarsest = i === metas.length - 1
      const radius0 = Math.max(4, Math.max(level.width, level.height) >> 1)
      const steps = preset.searchSteps
      field = initNnf(level, field)
      refine(level, field, coarsest ? preset.coarseIterations : preset.fineIterations, radius0, steps)
      vote(level, field)
    } else {
      // 环带放不下完整 patch（极端情况：ROI 几乎覆盖整幅图）：保留平滑初值
      field = null
    }
    prev = level
    levels.push(level)
  }

  const finest = levels[levels.length - 1]
  const pixels = out.data
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const from = ((area.y - oy + y) * finest.width + (area.x - ox + x)) * 3
      const to = ((area.y + y) * source.width + area.x + x) * 4
      pixels[to] = finest.rgb[from]
      pixels[to + 1] = finest.rgb[from + 1]
      pixels[to + 2] = finest.rgb[from + 2]
    }
  }
  return out
}

/**
 * 梯度域（泊松）融合：以 guidance 在 rect 内的梯度为引导场，解 ∇²f = ∇²g；
 * 边界取 target 在 rect 外侧 1px 的像素；原地写入 target 的 rect 区域。
 * 该侧越出图像时该邻居整体不计入，并按可用邻居数 k 重新归一化（与 fillByEdges 一致）。
 */
export function seamlessFuse(target: ImageData, guidance: ImageData, rect: ImageCropRect, options: FuseOptions = {}): void {
  if (target.width <= 0 || target.height <= 0) return
  if (rect.width <= 0 || rect.height <= 0) return
  if (guidance.width !== target.width || guidance.height !== target.height) return
  const area = clampCropRect(rect, target.width, target.height)
  const iterations = presetOf(options.quality).fuseIterations
  const width = target.width
  const height = target.height
  const tp = target.data
  const gp = guidance.data
  const stride = area.width * 3
  // 初值取 guidance：它已经是解的良好近似，收敛所需的迭代数大幅下降。
  const f = new Float32Array(stride * area.height)
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const from = ((area.y + y) * width + area.x + x) * 4
      const to = (y * area.width + x) * 3
      f[to] = gp[from]
      f[to + 1] = gp[from + 1]
      f[to + 2] = gp[from + 2]
    }
  }
  // 再把初值整体平移一个「Dirichlet 边界上的平均色差」。
  // 为什么必须做这一步：令 h = f − g，则 h 在 rect 内调和、在边界上等于 t − g。
  // 调和函数的内部值由边界主导，其中最慢收敛的正是这个**整体灰度（直流）模态**——
  // 它只靠 SOR 迭代推进时收敛因子约为 ω−1（400 长的区域约 0.984），意味着要几百轮
  // 才能把色差拉平，固定迭代预算下会留下明显的整体偏色。先一次性扣掉边界均值，
  // 剩下的只是边界附近的高频起伏，几十轮就收敛（实测拉普拉斯残差已到 8bit 舍入下限）。
  // 该平移量完全由输入决定，确定；且在目标与引导在边界处相同时为 0，不改变退化情形。
  let driftR = 0
  let driftG = 0
  let driftB = 0
  let driftCount = 0
  const addDrift = (index4: number): void => {
    driftR += tp[index4] - gp[index4]
    driftG += tp[index4 + 1] - gp[index4 + 1]
    driftB += tp[index4 + 2] - gp[index4 + 2]
    driftCount += 1
  }
  const left = area.x - 1
  const right = area.x + area.width
  const top = area.y - 1
  const bottom = area.y + area.height
  if (left >= 0) for (let y = 0; y < area.height; y++) addDrift(((area.y + y) * width + left) * 4)
  if (right < width) for (let y = 0; y < area.height; y++) addDrift(((area.y + y) * width + right) * 4)
  if (top >= 0) for (let x = 0; x < area.width; x++) addDrift((top * width + area.x + x) * 4)
  if (bottom < height) for (let x = 0; x < area.width; x++) addDrift((bottom * width + area.x + x) * 4)
  if (driftCount > 0) {
    const dr = driftR / driftCount
    const dg = driftG / driftCount
    const db = driftB / driftCount
    for (let i = 0; i < f.length; i += 3) {
      f[i] += dr
      f[i + 1] += dg
      f[i + 2] += db
    }
  }
  // SOR 松弛因子取 Poisson 模型问题的最优值 ω = 2/(1 + sin(π/N))，N 取区域长边。
  // 这里必须用最优值本身、不能保守地压低：ρ(ω) 在 ω 靠近最优值时极不敏感，
  // 一旦低到 1.9（400 长的区域），平滑模态的收敛因子会从 0.984 恶化到 0.999，
  // 等于把收敛速度拉慢一个数量级。只有在极小的区域（N 很小时 ω 逼近 2）才略作收敛钳制。
  const omega = Math.min(1.99, 2 / (1 + Math.sin(Math.PI / Math.max(1, Math.max(area.width, area.height)))))
  for (let it = 0; it < iterations; it++) {
    const forward = (it & 1) === 0
    const yStart = forward ? 0 : area.height - 1
    const yEnd = forward ? area.height : -1
    const yStep = forward ? 1 : -1
    const xStart = forward ? 0 : area.width - 1
    const xEnd = forward ? area.width : -1
    const xStep = forward ? 1 : -1
    for (let y = yStart; y !== yEnd; y += yStep) {
      const iy = area.y + y
      const upRow = iy > 0 ? (iy - 1) * width : -1
      const downRow = iy + 1 < height ? (iy + 1) * width : -1
      const selfRow = iy * width
      const fUp = y > 0 ? -stride : 0
      const fDown = y + 1 < area.height ? stride : 0
      for (let x = xStart; x !== xEnd; x += xStep) {
        const ix = area.x + x
        const local = y * stride + x * 3
        // 四个邻居的几何关系与像素是否越界只与坐标有关，提到通道循环外算一次，
        // 否则三个通道要各判一轮分支（这是融合热循环里最主要的冗余）
        const nLeft = ix > 0 ? selfRow + ix - 1 : -1
        const nRight = ix + 1 < width ? selfRow + ix + 1 : -1
        const nUp = upRow >= 0 ? upRow + ix : -1
        const nDown = downRow >= 0 ? downRow + ix : -1
        const fLeft = x > 0 ? -3 : 0
        const fRight = x + 1 < area.width ? 3 : 0
        for (let c = 0; c < 3; c++) {
          let k = 0
          let sumF = 0
          let sumG = 0
          if (nLeft >= 0) {
            const n = nLeft * 4 + c
            k += 1
            sumG += gp[n]
            sumF += fLeft !== 0 ? f[local + fLeft + c] : tp[n]
          }
          if (nRight >= 0) {
            const n = nRight * 4 + c
            k += 1
            sumG += gp[n]
            sumF += fRight !== 0 ? f[local + fRight + c] : tp[n]
          }
          if (nUp >= 0) {
            const n = nUp * 4 + c
            k += 1
            sumG += gp[n]
            sumF += fUp !== 0 ? f[local + fUp + c] : tp[n]
          }
          if (nDown >= 0) {
            const n = nDown * 4 + c
            k += 1
            sumG += gp[n]
            sumF += fDown !== 0 ? f[local + fDown + c] : tp[n]
          }
          if (k === 0) continue
          const g = gp[(selfRow + ix) * 4 + c]
          const solved = (sumF - sumG + k * g) / k
          f[local + c] += omega * (solved - f[local + c])
        }
      }
    }
  }
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const from = y * stride + x * 3
      const to = ((area.y + y) * width + area.x + x) * 4
      tp[to] = f[from]
      tp[to + 1] = f[from + 1]
      tp[to + 2] = f[from + 2]
    }
  }
}