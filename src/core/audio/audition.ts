/**
 * 试听互斥协调器。
 *
 * 页面里有多处会出声（素材列表的播放按钮、多音轨编辑器试听、结果列表播放器），
 * 它们各自用唯一 key 在这里登记一个「怎么把自己停掉」的回调；
 * 任何一路开播前先认领播放位，认领时会把上一路直接停掉，
 * 于是任何时刻最多只有一条音频在响。
 */

type StopFn = () => void

const stoppers = new Map<string, StopFn>()
let currentKey = ''

/** 认领播放位；若已有其它来源在播，先把它停掉 */
export function claimAudition(key: string, stop: StopFn): void {
  if (currentKey === key) {
    stoppers.set(key, stop)
    return
  }
  const previous = stoppers.get(currentKey)
  currentKey = key
  stoppers.set(key, stop)
  previous?.()
}

/** 让出播放位：自然播完、手动停止或组件卸载时调用 */
export function releaseAudition(key: string): void {
  stoppers.delete(key)
  if (currentKey === key) currentKey = ''
}
