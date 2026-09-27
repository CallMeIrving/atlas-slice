import { clampCropRect, type ImageCropRect } from '@/core/crop'

/**
 * 时域中值重建：水印位置固定、而画面内容在帧间发生位移时，
 * 逐像素中值可以取回水印覆盖下的真实像素（还原而非重建，无幻觉）。
 *
 * 关键在于「对齐」：水印在图像坐标系里是静止的，只有把各帧按内容位移重新配准后，
 * 静止水印才会在同一输出像素上落到不同的采样位置——多数帧采到的是水印外的干净内容，
 * 中值即可取回真实像素（还原而非重建，无模型、无幻觉）。
 * 若不做对齐，同一图像坐标上的每一帧都被同一块水印以同一 α 覆盖，
 * 中值与仿射混合可交换，结果仍带着水印，只是底色变成帧间中值（画面反而发糊）。
 *
 * 局限：内容静止时位移为 0，对齐退化为恒等，中值结果等于单帧，水印原样保留——
 * 这是该方法的失败场景，本就不适用；真实可用性取决于运动幅度与帧数是否足以让
 * 多数帧的采样点移出水印范围（详见 temporalMedianRect 的 disagreement 说明）。
 *
 * 纯 typed-array 数学：无 DOM、无 canvas、无 Vue 依赖（仅在最后构造 ImageData 返回值，
 * 与 core/watermark 一致）；噪点与哈希全部确定性，不出现 Math.random。
 */

export interface TemporalMergeOptions {
  /** 逐帧对齐方式：none 不做对齐；shift 用块匹配估计整帧平移后再取中值 */
  align?: 'none' | 'shift'
}

export interface TemporalMergeResult {
  data: ImageData
  /** 实际参与中值的帧数（ROI 内各像素的最少有效样本数，位移越界的帧会被逐像素跳过） */
  used: number
  /** 估计出的帧间位移（align='shift' 时） */
  shift: { dx: number; dy: number } | null
  /**
   * 可行性判据：ROI 内「偏离中值」的样本占比的均值（0-1）。
   * 每个 ROI 像素上，若所有帧取到的值都一致，说明它们采到的都是同一块水印——
   * 比值≈0，中值等于单帧、水印原样保留（失败）。比值越高，说明越多帧提供了水印之外的
   * 真实内容，中值才真的重建了被遮住的像素。注意：不要用「样本离散度（MAD）」当判据——
   * 静止画面下 MAD≈0 反而最像「可信」，方向恰好相反。
   */
  disagreement: number
}

/** 块匹配搜索半径：帧长边的 1/4，封顶 32px（兼顾可测位移与 O(R²·N) 搜索开销） */
const MAX_SHIFT_RATIO = 0.25
const MAX_SHIFT_CAP = 32
/** 块匹配的整帧网格采样点数上限，用于控制搜索规模 */
const MATCH_SAMPLE_CAP = 1024
/** 判定「该帧在该像素上采到了与中值不同的内容」的通道容差（0-255） */
const DEVIATION_TOLERANCE = 8

/** 单帧的块匹配搜索半径 */
function maxShiftOf(width: number, height: number): number {
  return Math.max(2, Math.min(MAX_SHIFT_CAP, Math.round(Math.min(width, height) * MAX_SHIFT_RATIO)))
}

/**
 * 用整帧网格采样估计 target 相对 ref 的整像素平移 s = argmin Σ|ref(p) - target(p + s)|。
 * 采样点刻意排除 ROI：水印区像素在时域上恒定不变，参与匹配会把最优解拉向 0。
 */
function estimateShift(ref: ImageData, target: ImageData, rect: ImageCropRect, maxShift: number): { dx: number; dy: number } {
  const width = Math.min(ref.width, target.width)
  const height = Math.min(ref.height, target.height)
  const x0 = maxShift
  const y0 = maxShift
  const x1 = width - maxShift
  const y1 = height - maxShift
  if (x1 <= x0 || y1 <= y0) return { dx: 0, dy: 0 }

  const stride = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / MATCH_SAMPLE_CAP)))
  const refData = ref.data
  const targetData = target.data
  const refWidth = ref.width
  const targetWidth = target.width
  let bestDx = 0
  let bestDy = 0
  let bestScore = Infinity

  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      let cost = 0
      let count = 0
      for (let y = y0; y < y1; y += stride) {
        const inRectRow = y >= rect.y && y < rect.y + rect.height
        for (let x = x0; x < x1; x += stride) {
          if (inRectRow && x >= rect.x && x < rect.x + rect.width) continue
          const a = (y * refWidth + x) * 4
          const b = ((y + dy) * targetWidth + x + dx) * 4
          cost += Math.abs(refData[a] - targetData[b]) + Math.abs(refData[a + 1] - targetData[b + 1]) + Math.abs(refData[a + 2] - targetData[b + 2])
          count += 1
        }
      }
      const score = count ? cost / count : Infinity
      if (score < bestScore) {
        bestScore = score
        bestDx = dx
        bestDy = dy
      }
    }
  }
  return { dx: bestDx, dy: bestDy }
}

/** 取前 n 个样本的中位数；用插入排序（n 为帧数量级，很小），偶数个取中间两值均值 */
function medianOfSamples(samples: Float64Array, n: number): number {
  for (let i = 1; i < n; i += 1) {
    const value = samples[i]
    let j = i - 1
    while (j >= 0 && samples[j] > value) {
      samples[j + 1] = samples[j]
      j -= 1
    }
    samples[j + 1] = value
  }
  const mid = n >> 1
  return n % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2
}

/**
 * 对 ROI 做时域中值合成，返回 ROI 尺寸（rect.width × rect.height）的结果，
 * 调用方按 rect 写回帧即可，ROI 之外的像素不受影响。
 *
 * align='shift' 时按「相邻帧块匹配 → 逐帧累加」得到各帧相对首帧的位移，
 * 再把帧 i 的采样点取在 p + sᵢ，使同一输出坐标对应同一内容点。
 * 相邻帧匹配只需覆盖单帧位移，但误差会沿序列累加（长镜头需外部周期性重锚）。
 *
 * confidence 已按上面的判据改成 disagreement（偏离中值的样本占比），
 * 因为它才是「水印是否被移出」的直接指标：全帧取值一致说明水印没被移出，
 * 该值≈0；而内容离散度（MAD）在静止画面下同样≈0，方向与可行性正好相反，不能当判据。
 */
export function temporalMedianRect(frames: ImageData[], rect: ImageCropRect, options: TemporalMergeOptions = {}): TemporalMergeResult {
  if (!frames.length) throw new Error('temporalMedianRect: 至少需要 1 帧')
  const first = frames[0]
  const area = clampCropRect(rect, first.width, first.height)
  const align = options.align ?? 'none'
  const count = frames.length

  let shifts: { dx: number; dy: number }[] | null = null
  let reportedShift: { dx: number; dy: number } | null = null
  if (align === 'shift' && count > 1) {
    const maxShift = maxShiftOf(first.width, first.height)
    shifts = [{ dx: 0, dy: 0 }]
    for (let i = 1; i < count; i += 1) {
      const step = estimateShift(frames[i - 1], frames[i], area, maxShift)
      const prev = shifts[i - 1]
      shifts.push({ dx: prev.dx + step.dx, dy: prev.dy + step.dy })
    }
    let sumDx = 0
    let sumDy = 0
    for (let i = 1; i < count; i += 1) {
      sumDx += shifts[i].dx - shifts[i - 1].dx
      sumDy += shifts[i].dy - shifts[i - 1].dy
    }
    reportedShift = { dx: sumDx / (count - 1), dy: sumDy / (count - 1) }
  }

  const width = area.width
  const height = area.height
  const out = new Uint8ClampedArray(width * height * 4)
  const samples = new Float64Array(count)
  let used = count
  let disagreementSum = 0
  let disagreementCount = 0

  for (let y = 0; y < height; y += 1) {
    const iy = area.y + y
    for (let x = 0; x < width; x += 1) {
      const ix = area.x + x
      const outOffset = (y * width + x) * 4
      for (let c = 0; c < 3; c += 1) {
        let n = 0
        for (let i = 0; i < count; i += 1) {
          const frame = frames[i]
          const sx = ix + (shifts ? shifts[i].dx : 0)
          const sy = iy + (shifts ? shifts[i].dy : 0)
          if (sx < 0 || sx >= frame.width || sy < 0 || sy >= frame.height) continue
          samples[n] = frame.data[(sy * frame.width + sx) * 4 + c]
          n += 1
        }
        if (n === 0) {
          used = 0
          continue
        }
        if (n < used) used = n
        const median = medianOfSamples(samples, n)
        out[outOffset + c] = median
        // 偏离中值超过容差的样本占比：全帧一致（只采到水印）时为 0
        let deviating = 0
        for (let k = 0; k < n; k += 1) {
          if (Math.abs(samples[k] - median) > DEVIATION_TOLERANCE) deviating += 1
        }
        disagreementSum += deviating / n
        disagreementCount += 1
      }
      out[outOffset + 3] = 255
    }
  }

  return {
    data: new ImageData(out, width, height),
    used,
    shift: reportedShift,
    disagreement: disagreementCount ? disagreementSum / disagreementCount : 0,
  }
}