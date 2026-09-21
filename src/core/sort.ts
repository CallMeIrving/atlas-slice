/** 自然数字排序比较：run_2 < run_10 */
export function naturalCompare(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [a]
  const pb = b.match(/\d+|\D+/g) ?? [b]
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const ca = pa[i] ?? ''
    const cb = pb[i] ?? ''
    const na = /^\d+$/.test(ca) ? parseInt(ca, 10) : NaN
    const nb = /^\d+$/.test(cb) ? parseInt(cb, 10) : NaN
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb
      // 数字相同（如 02 与 2）时按长度继续比较
      if (ca.length !== cb.length) return ca.length - cb.length
      continue
    }
    const cmp = ca < cb ? -1 : ca > cb ? 1 : 0
    if (cmp !== 0) return cmp
  }
  return 0
}
