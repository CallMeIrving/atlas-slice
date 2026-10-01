/**
 * 分数延迟插值核（窗函数 sinc）。
 *
 * 重采样、变速与 True Peak 过采样共用同一套核构造：
 * 相位表把连续的小数延迟离散化，运行时只需查表并按固定抽头数做乘加。
 */

export function sinc(x: number): number {
  if (x === 0) return 1
  const pix = Math.PI * x
  return Math.sin(pix) / pix
}

/** 汉宁窗；x 为相对半窗宽的归一化偏移，超出 ±1 视为 0 */
function hann(x: number): number {
  const a = Math.abs(x)
  if (a >= 1) return 0
  return 0.5 * (1 + Math.cos(Math.PI * x))
}

/**
 * 构造相位 × 抽头的权重表。
 *
 * 约定：第 p 相（frac = p / phases）用于求「x[i] 与 x[i+1] 之间偏移 frac」处的值，
 * 取样本的下标偏移为 `i - (taps / 2 - 1) + t`。
 * cutoff 为相对 Nyquist 的归一化截止（重采样降采样时 < 1，纯插值时为 1）。
 */
export function buildInterpolationKernel(phases: number, taps: number, cutoff: number): Float32Array {
  const half = taps / 2
  const table = new Float32Array(phases * taps)
  for (let p = 0; p < phases; p++) {
    const frac = p / phases
    let sum = 0
    for (let t = 0; t < taps; t++) {
      const x = t - (half - 1) - frac
      const weight = cutoff * sinc(cutoff * x) * hann(x / half)
      table[p * taps + t] = weight
      sum += weight
    }
    if (sum !== 0) {
      for (let t = 0; t < taps; t++) table[p * taps + t] /= sum
    }
  }
  return table
}

/** 相位表首地址偏移：按小数位置取最接近的相位 */
export function kernelPhaseOffset(phases: number, taps: number, frac: number): number {
  const index = frac <= 0 ? 0 : frac >= 1 ? phases - 1 : Math.round(frac * phases)
  return index * taps
}
