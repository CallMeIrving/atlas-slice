/**
 * 音频工具状态与批处理编排。
 *
 * 内存策略：素材只保留元数据 + 波形包络 + 指纹，源文件放在非响应式 Map 里；
 * 处理时按需重新解码、用完即弃，避免整批音频同时驻留内存。
 */

import { computed, markRaw, reactive } from 'vue'
import { decodeAudioFile, CONTAINER_LABEL } from '@/core/audio/decode'
import { analyzeLoudness, formatDb, formatLufs, type LoudnessResult } from '@/core/audio/loudness'
import { buildWaveformPeaks, pcmDuration, type AudioPcm } from '@/core/audio/pcm'
import { encodeWav } from '@/core/audio/wav'
import { AUDIO_FORMATS, encodeAudio, type EncodeOptions } from '@/core/audio/encode'
import { buildInterpolationKernel } from '@/core/audio/kernel'
import { applyChain, applyNameTemplate } from '@/core/audio/pipeline'
import {
  DEFAULT_CHAIN,
  DEFAULT_EXPORT,
  DEFAULT_MIX_EXPORT,
  PLATFORM_PRESETS,
  cloneChain,
  cloneExport,
  type AudioChain,
  type EncodeSettings,
  type ExportSettings,
} from '@/core/audio/presets'
import { CancelledError, mixPcm, type MixClip } from '@/core/audio/dsp'
import { inspectPcm, reportToCsv, reportToJson, type QcFinding, type ReportRow } from '@/core/audio/qc'
import {
  DEFAULT_VARIANTS,
  fingerprintSimilarity,
  planVariants,
  renderVariant,
  variantFingerprint,
  variantTag,
  type VariantPlan,
  type VariantSettings,
} from '@/core/audio/variants'
import { downloadBlob, downloadZip } from '@/core/media-export'

export interface AudioAsset {
  id: string
  fileName: string
  /** 容器/编码名称（大写展示） */
  container: string
  sizeBytes: number
  durationSec: number
  sampleRate: number
  channelCount: number
  samplePeakDb: number
  truePeakDb: number
  integratedLufs: number
  /** 波形包络（0..1），绘制用 */
  peaks: Float32Array
  /** 指纹，用于近重复检测 */
  fingerprint: Float32Array
  /** 试听用的 blob URL */
  previewUrl: string
  /** 命名规范校验不通过时的说明 */
  nameIssue: string
  /** 与已导入素材高度相似的素材文件名 */
  duplicateOf: string
}

export interface AudioOutput {
  id: string
  assetId: string
  variantIndex: number
  label: string
  fileName: string
  mimeType: string
  blob: Blob
  /** 试听用的 blob URL，随结果一起回收 */
  previewUrl: string
  durationSec: number
  sampleRate: number
  channelCount: number
  integratedLufs: number
  samplePeakDb: number
  truePeakDb: number
  /** 处理链实际执行到的步骤说明 */
  steps: string[]
  findings: QcFinding[]
}

export interface ChainPreset {
  id: string
  name: string
  chain: AudioChain
  export: ExportSettings
  variants: VariantSettings
}

export interface BatchState {
  running: boolean
  cancelling: boolean
  done: number
  total: number
  text: string
  error: string
}

/** 资源加载态：导入 / 混音 / 编码导出期间都可观测，用于显示 loading */
export interface LoadingState {
  active: boolean
  text: string
  done: number
  total: number
}

/** 时间轴上的一个音频片段 */
export interface TrackClip {
  id: string
  assetId: string
  /** 片段在时间轴上的起点（秒） */
  startSec: number
  /** 源素材内的裁剪区间（秒） */
  trimStartSec: number
  trimEndSec: number
  /** 片段增益（dB） */
  gainDb: number
  fadeInSec: number
  fadeOutSec: number
}

/** 一条音轨，可容纳多个片段 */
export interface AudioTrack {
  id: string
  name: string
  muted: boolean
  solo: boolean
  clips: TrackClip[]
}

/** 源文件不放进响应式对象：Proxy 包裹 File 会让 arrayBuffer() 抛非法调用 */
const sourceFiles = new Map<string, File>()

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 波形绘制使用的采样桶数量 */
const PEAK_BUCKETS = 640
/** 近重复判定阈值 */
const DUPLICATE_THRESHOLD = 0.999
/** 变体去重阈值 */
const VARIANT_DUPLICATE_THRESHOLD = 0.998
const VARIANT_RETRY = 6

export const audioState = reactive({
  assets: [] as AudioAsset[],
  activeAssetId: '',
  /** 勾选参与批量编辑的素材 id；批量队列只跑这些 */
  selectedAssetIds: [] as string[],
  /** 多音轨时间轴 */
  tracks: [] as AudioTrack[],
  activeClipId: '',
  chain: cloneChain(DEFAULT_CHAIN),
  /** 批量编辑的导出设置（格式 / 命名模板等），在批量编辑弹窗中配置 */
  exportSettings: cloneExport(DEFAULT_EXPORT),
  /** 合成导出的编码参数，与批量导出设置相互独立 */
  mixExport: { ...DEFAULT_MIX_EXPORT } as EncodeSettings,
  /** 合成导出的文件名（不含扩展名） */
  mixFileName: 'mix',
  variants: { ...DEFAULT_VARIANTS },
  platformPresetId: '',
  userPresets: [] as ChainPreset[],
  namingPattern: '^[a-z0-9_\\-]+$',
  maxDurationSec: 300,
  loading: { active: false, text: '', done: 0, total: 0 } as LoadingState,
  batch: { running: false, cancelling: false, done: 0, total: 0, text: '', error: '' } as BatchState,
  outputs: [] as AudioOutput[],
  reportRows: [] as ReportRow[],
  /** 批量编辑与结果弹窗开关 */
  batchModalOpen: false,
  resultModalOpen: false,
  error: '',
  notice: '',
})

export const activeAsset = computed<AudioAsset | null>(
  () => audioState.assets.find((item) => item.id === audioState.activeAssetId) ?? audioState.assets[0] ?? null,
)

// ---------------------------------------------------------------- 多音轨时间轴

/** 从素材库拖拽素材到音轨时使用的 dataTransfer 类型 */
export const AUDIO_ASSET_MIME = 'application/x-atlas-audio'

/** 片段最短时长（秒），避免裁到 0 长度后再也拖不回来 */
export const MIN_CLIP_SEC = 0.05

function nextTrackName(): string {
  const used = new Set(audioState.tracks.map((track) => track.name))
  let index = audioState.tracks.length + 1
  while (used.has(`音轨 ${index}`)) index++
  return `音轨 ${index}`
}

export function makeTrack(): AudioTrack {
  return { id: makeId('track'), name: nextTrackName(), muted: false, solo: false, clips: [] }
}

/** 初始化空时间轴：默认给 3 条空轨，可直接拖素材进来 */
export function ensureTracks(): void {
  if (audioState.tracks.length > 0) return
  for (let i = 0; i < 3; i++) audioState.tracks.push(makeTrack())
}

export function addTrack(): AudioTrack {
  const track = makeTrack()
  audioState.tracks.push(track)
  return track
}

/** 删除音轨；至少保留一条，被删轨上的选中片段一并清空选中态 */
export function removeTrack(trackId: string): void {
  if (audioState.tracks.length <= 1) return
  const index = audioState.tracks.findIndex((item) => item.id === trackId)
  if (index < 0) return
  const [removed] = audioState.tracks.splice(index, 1)
  if (removed.clips.some((clip) => clip.id === audioState.activeClipId)) audioState.activeClipId = ''
}

export function findClip(clipId: string): { track: AudioTrack; clip: TrackClip } | null {
  for (const track of audioState.tracks) {
    const clip = track.clips.find((item) => item.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

/** 片段实际时长，等于源素材内的裁剪长度 */
export function clipDuration(clip: TrackClip): number {
  return Math.max(0, clip.trimEndSec - clip.trimStartSec)
}

/** 片段结束时间（时间轴坐标） */
export function clipEndSec(clip: TrackClip): number {
  return clip.startSec + clipDuration(clip)
}

export function assetOf(clip: TrackClip): AudioAsset | null {
  return audioState.assets.find((item) => item.id === clip.assetId) ?? null
}

/**
 * 为片段找一个同轨不重叠的落点。
 * 期望位置与已有片段冲突时向后顺延到第一个空档，保证同一音轨上片段不叠放。
 */
function resolveFreeSlot(track: AudioTrack, startSec: number, durationSec: number, ignoreClipId: string): number {
  const others = track.clips
    .filter((item) => item.id !== ignoreClipId)
    .map((item) => ({ from: item.startSec, to: clipEndSec(item) }))
    .sort((a, b) => a.from - b.from)
  let cursor = Math.max(0, startSec)
  for (const span of others) {
    if (cursor + durationSec <= span.from) break
    if (cursor < span.to) cursor = span.to
  }
  return cursor
}

/** 把素材放到指定音轨：整段使用源素材，之后可拖位置或裁边缘 */
export function addClipFromAsset(trackId: string, assetId: string, startSec = 0): TrackClip | null {
  const track = audioState.tracks.find((item) => item.id === trackId)
  const asset = audioState.assets.find((item) => item.id === assetId)
  if (!track || !asset) return null
  const clip: TrackClip = {
    id: makeId('clip'),
    assetId,
    startSec: resolveFreeSlot(track, startSec, asset.durationSec, ''),
    trimStartSec: 0,
    trimEndSec: asset.durationSec,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
  }
  track.clips.push(clip)
  audioState.activeClipId = clip.id
  return clip
}

/** 拖动片段：可换轨、可改起点；与同轨已有片段重叠时自动顺延 */
export function moveClip(clipId: string, targetTrackId: string, startSec: number): void {
  const found = findClip(clipId)
  const target = audioState.tracks.find((item) => item.id === targetTrackId)
  if (!found || !target) return
  const duration = clipDuration(found.clip)
  found.clip.startSec = resolveFreeSlot(target, Math.max(0, startSec), duration, clipId)
  if (target.id !== found.track.id) {
    found.track.clips.splice(found.track.clips.indexOf(found.clip), 1)
    target.clips.push(found.clip)
  }
}

/**
 * 拖动片段边缘裁剪。
 * 起点侧同时平移时间轴位置，让「裁掉的部分」真正消失而不是留下空白；
 * 终点侧只改裁剪终点。
 */
export function trimClipEdge(clipId: string, side: 'start' | 'end', timelineSec: number): void {
  const found = findClip(clipId)
  if (!found) return
  const { clip } = found
  const asset = assetOf(clip)
  if (!asset) return

  if (side === 'start') {
    // 时间轴坐标换算回源素材坐标，再夹到 [0, 裁剪终点 - 最短时长]
    const wanted = clip.trimStartSec + (timelineSec - clip.startSec)
    const next = Math.min(Math.max(0, wanted), clip.trimEndSec - MIN_CLIP_SEC)
    clip.startSec = Math.max(0, clip.startSec + (next - clip.trimStartSec))
    clip.trimStartSec = next
  } else {
    const wanted = clip.trimStartSec + (timelineSec - clip.startSec)
    clip.trimEndSec = Math.max(clip.trimStartSec + MIN_CLIP_SEC, Math.min(asset.durationSec, wanted))
  }
  clip.fadeInSec = Math.min(clip.fadeInSec, clipDuration(clip) / 2)
  clip.fadeOutSec = Math.min(clip.fadeOutSec, clipDuration(clip) / 2)
}

export function setClipGain(clipId: string, gainDb: number): void {
  const found = findClip(clipId)
  if (found) found.clip.gainDb = Math.max(-60, Math.min(24, Number(gainDb) || 0))
}

export function setClipFade(clipId: string, side: 'in' | 'out', seconds: number): void {
  const found = findClip(clipId)
  if (!found) return
  const value = Math.max(0, Math.min(clipDuration(found.clip) / 2, Number(seconds) || 0))
  if (side === 'in') found.clip.fadeInSec = value
  else found.clip.fadeOutSec = value
}

/** 复制片段到同轨紧随其后 */
export function duplicateClip(clipId: string): void {
  const found = findClip(clipId)
  if (!found) return
  const copy: TrackClip = {
    ...found.clip,
    id: makeId('clip'),
    startSec: resolveFreeSlot(found.track, clipEndSec(found.clip), clipDuration(found.clip), ''),
  }
  found.track.clips.push(copy)
  audioState.activeClipId = copy.id
}

export function removeClip(clipId: string): void {
  const found = findClip(clipId)
  if (!found) return
  found.track.clips.splice(found.track.clips.indexOf(found.clip), 1)
  if (audioState.activeClipId === clipId) audioState.activeClipId = ''
}

export function setActiveClip(clipId: string): void {
  audioState.activeClipId = clipId
}

export const activeClip = computed<TrackClip | null>(() => {
  const found = audioState.activeClipId ? findClip(audioState.activeClipId) : null
  return found?.clip ?? null
})

export function toggleTrackMute(trackId: string): void {
  const track = audioState.tracks.find((item) => item.id === trackId)
  if (track) track.muted = !track.muted
}

export function toggleTrackSolo(trackId: string): void {
  const track = audioState.tracks.find((item) => item.id === trackId)
  if (track) track.solo = !track.solo
}

export function renameTrack(trackId: string, name: string): void {
  const track = audioState.tracks.find((item) => item.id === trackId)
  if (track) track.name = name.trim() || track.name
}

export const hasSolo = computed(() => audioState.tracks.some((track) => track.solo))

/**
 * 参与混音的片段。
 * 静音轨整体跳过；存在独奏轨时只有独奏轨参与。
 * 预览与合成共用同一份判定，保证「听到的」和「合成出来的」一致。
 */
export const audibleClips = computed<{ track: AudioTrack; clip: TrackClip; asset: AudioAsset }[]>(() => {
  const soloed = hasSolo.value
  const rows: { track: AudioTrack; clip: TrackClip; asset: AudioAsset }[] = []
  for (const track of audioState.tracks) {
    if (track.muted) continue
    if (soloed && !track.solo) continue
    for (const clip of track.clips) {
      const asset = assetOf(clip)
      if (asset) rows.push({ track, clip, asset })
    }
  }
  return rows
})

/** 时间轴总长（含被静音轨，避免标尺随静音切换抖动） */
export const timelineDurationSec = computed(() => {
  let longest = 0
  for (const track of audioState.tracks) {
    for (const clip of track.clips) longest = Math.max(longest, clipEndSec(clip))
  }
  return longest
})

/** 质检与报告使用的约束 */
export const qcLimits = computed(() => ({
  maxDurationSec: audioState.maxDurationSec,
  targetLufs: audioState.chain.normalize.targetLufs,
  lufsTolerance: 3,
  normalizeEnabled: audioState.chain.normalize.enabled && audioState.chain.normalize.mode === 'lufs',
}))

export function setActiveAsset(id: string): void {
  audioState.activeAssetId = id
}

// ---------------------------------------------------------------- 素材勾选

/** 已勾选、将被批量编辑处理的素材 */
export const selectedAssets = computed(() =>
  audioState.assets.filter((item) => audioState.selectedAssetIds.includes(item.id)),
)

export function isAssetSelected(id: string): boolean {
  return audioState.selectedAssetIds.includes(id)
}

export function toggleAssetSelected(id: string): void {
  const index = audioState.selectedAssetIds.indexOf(id)
  if (index >= 0) audioState.selectedAssetIds.splice(index, 1)
  else audioState.selectedAssetIds.push(id)
}

export function selectAllAssets(): void {
  audioState.selectedAssetIds = audioState.assets.map((item) => item.id)
}

export function clearAssetSelection(): void {
  audioState.selectedAssetIds = []
}

function notify(message: string): void {
  audioState.notice = message
  window.setTimeout(() => {
    if (audioState.notice === message) audioState.notice = ''
  }, 3200)
}

function fail(message: string): void {
  audioState.error = message
}

export function dismissAudioError(): void {
  audioState.error = ''
}

// ---------------------------------------------------------------- 资源加载态

/**
 * 统一的资源加载态。
 * 导入、混音、编码导出都走这里，界面只需盯住 loading 就能显示 loading 指示，
 * 不必为每种耗时操作各写一套状态。
 */
export function beginLoading(text: string, total = 0): void {
  Object.assign(audioState.loading, { active: true, text, done: 0, total })
}

export function updateLoading(text: string, done?: number): void {
  if (text) audioState.loading.text = text
  if (typeof done === 'number') audioState.loading.done = done
}

export function endLoading(): void {
  Object.assign(audioState.loading, { active: false, text: '', done: 0, total: 0 })
}

// ---------------------------------------------------------------- 导入

export async function importFiles(files: File[]): Promise<void> {
  if (!files.length) return
  audioState.error = ''
  beginLoading(files.length > 1 ? '正在解析音频文件' : `正在解析 ${files[0].name}`, files.length)
  const failures: string[] = []
  let imported = 0
  try {
    for (const file of files) {
      updateLoading(`正在解析 ${file.name}`)
      try {
        await importOne(file)
        imported++
      } catch (error) {
        // 单个文件失败不牵连其余文件：选中一批时混进视频或损坏文件，其余素材照常导入
        failures.push(`${file.name}：${error instanceof Error ? error.message : '导入失败'}`)
      }
      updateLoading('', audioState.loading.done + 1)
      // 让出主线程，长批次下进度仍能刷新
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    endLoading()
  }
  if (imported > 0) notify(`已导入 ${imported} 个音频文件`)
  if (failures.length > 0) fail(failures.join('；'))
}

async function importOne(file: File): Promise<void> {
  const result = await decodeAudioFile(file, file.name)
  addPcmAsset(file, result.pcm, result.container)
  // 探测不到原始采样率时提示一次，避免用户以为素材本身有问题
  if (!result.detectedRate) {
    notify(`${file.name} 未能识别原始采样率，已按浏览器默认采样率解码`)
  }
}

/** 把一份 PCM 登记为素材：分析响度、提取波形与指纹，并把源文件放进非响应式表 */
function addPcmAsset(file: File, pcm: AudioPcm, containerKey: string): AudioAsset {
  const analysis = analyzeLoudness(pcm)
  const peaks = markRaw(buildWaveformPeaks(pcm, PEAK_BUCKETS))
  const fingerprint = markRaw(variantFingerprint(pcm))

  const duplicate = audioState.assets.find(
    (item) => fingerprintSimilarity(item.fingerprint, fingerprint) >= DUPLICATE_THRESHOLD,
  )
  const baseName = file.name.replace(/\.[^.]+$/, '')
  const pattern = safeRegex(audioState.namingPattern)

  const asset: AudioAsset = {
    id: makeId('asset'),
    fileName: file.name,
    container: CONTAINER_LABEL[containerKey] ?? containerKey.toUpperCase(),
    sizeBytes: file.size,
    durationSec: pcmDuration(pcm),
    sampleRate: pcm.sampleRate,
    channelCount: pcm.channels.length,
    samplePeakDb: analysis.samplePeakDb,
    truePeakDb: analysis.truePeakDb,
    integratedLufs: analysis.integratedLufs,
    peaks,
    fingerprint,
    previewUrl: URL.createObjectURL(file),
    nameIssue: pattern && !pattern.test(baseName) ? `「${baseName}」不符合命名规范` : '',
    duplicateOf: duplicate ? duplicate.fileName : '',
  }
  sourceFiles.set(asset.id, file)
  audioState.assets.push(asset)
  // 新导入 / 新合成的素材默认勾选，省一次手动勾
  audioState.selectedAssetIds.push(asset.id)
  if (!audioState.activeAssetId) audioState.activeAssetId = asset.id
  return asset
}

/** 取素材源文件并重新解码，失败时抛出可直接展示的错误 */
async function decodeAsset(asset: AudioAsset): Promise<AudioPcm> {
  const file = sourceFiles.get(asset.id)
  if (!file) throw new Error(`源文件已失效：${asset.fileName}`)
  const decoded = await decodeAudioFile(file, asset.fileName)
  return decoded.pcm
}

function safeRegex(pattern: string): RegExp | null {
  if (!pattern.trim()) return null
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

export function removeAsset(id: string): void {
  const index = audioState.assets.findIndex((item) => item.id === id)
  if (index < 0) return
  URL.revokeObjectURL(audioState.assets[index].previewUrl)
  sourceFiles.delete(id)
  audioState.assets.splice(index, 1)
  audioState.selectedAssetIds = audioState.selectedAssetIds.filter((item) => item !== id)
  // 素材被删后时间轴上引用它的片段一并清掉，避免留下放不出声的空片段
  let droppedActive = false
  for (const track of audioState.tracks) {
    const kept = track.clips.filter((clip) => {
      if (clip.assetId !== id) return true
      if (clip.id === audioState.activeClipId) droppedActive = true
      return false
    })
    if (kept.length !== track.clips.length) track.clips = kept
  }
  if (droppedActive) audioState.activeClipId = ''
  if (audioState.activeAssetId === id) audioState.activeAssetId = audioState.assets[0]?.id ?? ''
}

export function clearAssets(): void {
  clearOutputs()
  audioState.assets.forEach((item) => URL.revokeObjectURL(item.previewUrl))
  audioState.assets = []
  audioState.selectedAssetIds = []
  sourceFiles.clear()
  audioState.tracks.forEach((track) => {
    track.clips = []
    track.muted = false
    track.solo = false
  })
  audioState.activeClipId = ''
  audioState.activeAssetId = ''
}

function clearOutputs(): void {
  audioState.outputs.forEach((item) => URL.revokeObjectURL(item.previewUrl))
  audioState.outputs = []
  audioState.reportRows = []
}

export function removeOutput(id: string): void {
  const index = audioState.outputs.findIndex((item) => item.id === id)
  if (index < 0) return
  URL.revokeObjectURL(audioState.outputs[index].previewUrl)
  audioState.outputs.splice(index, 1)
}

// ---------------------------------------------------------------- 多音轨混音

/** 已存在的素材名后追加序号，避免同名素材并排出现 */
function uniqueAssetStem(stem: string): string {
  const used = new Set(audioState.assets.map((item) => item.fileName.replace(/\.[^.]+$/, '')))
  if (!used.has(stem)) return stem
  let seq = 2
  while (used.has(`${stem}_${seq}`)) seq++
  return `${stem}_${seq}`
}

/** 把处理结果写成 WAV 再走一遍导入流程，从而复用分析 / 波形 / 指纹 / 试听等既有逻辑 */
function registerGeneratedPcm(pcm: AudioPcm, stem: string): AudioAsset {
  const fileName = `${uniqueAssetStem(stem)}.wav`
  const bytes = encodeWav(pcm, 'float32')
  const file = new File([bytes as BlobPart], fileName, { type: 'audio/wav' })
  const asset = addPcmAsset(file, pcm, 'wav')
  audioState.activeAssetId = asset.id
  // 合成结果设为唯一勾选项：接下来的「批量编辑」默认就是导出这一条合成音频，
  // 不会把参与混音的原始素材一起再处理一遍
  audioState.selectedAssetIds = [asset.id]
  return asset
}

/**
 * 解码参与混音的片段。
 * 同一素材被多个片段引用时只解码一次——长音频重复解码是最容易拖垮内存的地方。
 */
export async function loadAudibleClips(): Promise<MixClip[]> {
  const rows = audibleClips.value
  const decoded = new Map<string, AudioPcm>()
  for (const row of rows) {
    if (decoded.has(row.asset.id)) continue
    updateLoading(`正在解码 ${row.asset.fileName}`)
    decoded.set(row.asset.id, await decodeAsset(row.asset))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return rows.map((row) => ({
    pcm: decoded.get(row.asset.id) as AudioPcm,
    startSec: row.clip.startSec,
    trimStartSec: row.clip.trimStartSec,
    trimEndSec: row.clip.trimEndSec,
    gainDb: row.clip.gainDb,
    fadeInSec: row.clip.fadeInSec,
    fadeOutSec: row.clip.fadeOutSec,
  }))
}

/** 混音输出采样率取参与混音素材的最高值，避免把高采样素材降级 */
function mixdownSampleRate(): number {
  let highest = 0
  for (const row of audibleClips.value) highest = Math.max(highest, row.asset.sampleRate)
  return highest || 48000
}

/** 按时间轴混音出 PCM（试听与合成都走这一条路径，保证听到的就是合成的） */
export async function buildMixdownPcm(): Promise<AudioPcm> {
  const clips = await loadAudibleClips()
  if (clips.length === 0) throw new Error('时间轴上没有可合成的片段，请先拖素材到音轨')
  updateLoading('正在混音')
  return mixPcm(clips, { sampleRate: mixdownSampleRate() })
}

/** 把时间轴混音成一条新素材加入素材库，之后可继续走批量编辑导出 */
export async function mixdownToAsset(): Promise<AudioAsset | null> {
  if (audibleClips.value.length === 0) {
    fail('时间轴上没有可合成的片段，请先把左侧素材拖到音轨上')
    return null
  }
  audioState.error = ''
  beginLoading('正在合成音频')
  try {
    const pcm = await buildMixdownPcm()
    if (pcm.length === 0) {
      fail('合成结果为空，请检查片段的裁剪区间')
      return null
    }
    const usedTracks = audioState.tracks.filter((track) => track.clips.length > 0).length
    const asset = registerGeneratedPcm(pcm, `mix_${usedTracks}tracks`)
    notify(`已合成 ${pcmDuration(pcm).toFixed(2)} 秒音频，可继续批量编辑`)
    return asset
  } catch (error) {
    fail(error instanceof Error ? error.message : '合成失败')
    return null
  } finally {
    endLoading()
  }
}

/**
 * 直接把时间轴混音结果编码后下载。
 * 与「合成到素材库 → 批量编辑」是两条不同的路：这里只出一份文件，不进素材库、不进批量队列。
 */
export async function exportMixdown(): Promise<void> {
  if (audibleClips.value.length === 0) {
    fail('时间轴上没有可导出的片段，请先把左侧素材拖到音轨上')
    return
  }
  const issue = mixFormatIssue()
  if (issue) {
    fail(issue)
    return
  }
  audioState.error = ''
  beginLoading('正在合成音频')
  try {
    const pcm = await buildMixdownPcm()
    if (pcm.length === 0) {
      fail('合成结果为空，请检查片段的裁剪区间')
      return
    }
    updateLoading('正在编码音频')
    const encoded = await encodeAudio(pcm, encodeOptionsFor(audioState.mixExport))
    const stem = sanitizeFileName(audioState.mixFileName.trim() || 'mix')
    downloadBlob(
      new Blob([encoded.bytes as BlobPart], { type: encoded.mimeType }),
      `${stem}.${encoded.extension}`,
    )
    notify(`已导出 ${pcmDuration(pcm).toFixed(2)} 秒合成音频（${stem}.${encoded.extension}）`)
  } catch (error) {
    fail(error instanceof Error ? error.message : '合成导出失败')
  } finally {
    endLoading()
  }
}

// ---------------------------------------------------------------- 预设

export function applyPlatformPreset(id: string): void {
  const preset = PLATFORM_PRESETS.find((item) => item.id === id)
  if (!preset) return
  audioState.platformPresetId = id
  Object.assign(audioState.chain, cloneChain({ ...audioState.chain, ...preset.chain }))
  // 部分字段用展开覆盖后仍是旧值，这里按预设逐项写入，保证 enabled 一并生效
  for (const [key, value] of Object.entries(preset.chain)) {
    Object.assign(audioState.chain[key as keyof AudioChain] as object, value)
  }
  Object.assign(audioState.exportSettings, preset.export)
  notify(`已应用预设「${preset.label}」`)
}

export function saveUserPreset(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) {
    fail('预设名称不能为空')
    return
  }
  const preset: ChainPreset = {
    id: makeId('preset'),
    name: trimmed,
    chain: cloneChain(audioState.chain),
    export: cloneExport(audioState.exportSettings),
    variants: { ...audioState.variants },
  }
  audioState.userPresets.push(preset)
  persist()
  notify(`已保存预设「${trimmed}」`)
}

export function applyUserPreset(id: string): void {
  const preset = audioState.userPresets.find((item) => item.id === id)
  if (!preset) return
  audioState.chain = cloneChain(preset.chain)
  audioState.exportSettings = cloneExport(preset.export)
  audioState.variants = { ...preset.variants }
  audioState.platformPresetId = ''
  notify(`已套用预设「${preset.name}」`)
}

export function deleteUserPreset(id: string): void {
  const index = audioState.userPresets.findIndex((item) => item.id === id)
  if (index < 0) return
  audioState.userPresets.splice(index, 1)
  persist()
}

export function presetLabel(): string {
  return PLATFORM_PRESETS.find((item) => item.id === audioState.platformPresetId)?.label ?? '自定义'
}

// ---------------------------------------------------------------- 批处理

let cancelRequested = false

export function cancelBatch(): void {
  if (!audioState.batch.running) return
  cancelRequested = true
  audioState.batch.cancelling = true
  audioState.batch.text = '正在取消…'
}

function encodeOptionsFor(settings: EncodeSettings): EncodeOptions {
  return {
    format: settings.format,
    wavEncoding: settings.wavEncoding,
    mp3Bitrate: settings.mp3Bitrate,
    oggQuality: settings.oggQuality,
  }
}

function issueOf(format: string): string {
  const info = AUDIO_FORMATS.find((item) => item.format === format)
  if (!info) return '未知导出格式'
  if (!info.available) return `${info.label} 暂不可用：${info.hint ?? ''}`
  return ''
}

/** 批量导出设置的可用性问题（批量编辑弹窗用） */
export function formatIssue(): string {
  return issueOf(audioState.exportSettings.format)
}

/** 合成导出设置的可用性问题 */
export function mixFormatIssue(): string {
  return issueOf(audioState.mixExport.format)
}

export async function runBatch(): Promise<void> {
  if (audioState.batch.running) return
  if (audioState.assets.length === 0) {
    fail('请先导入音频素材')
    return
  }
  const targets = selectedAssets.value
  if (targets.length === 0) {
    fail('请先在左侧素材库勾选要批量处理的素材')
    return
  }
  const issue = formatIssue()
  if (issue) {
    fail(issue)
    return
  }

  cancelRequested = false
  clearOutputs()
  audioState.error = ''
  const total = targets.length
  Object.assign(audioState.batch, { running: true, cancelling: false, done: 0, total, text: '', error: '' })

  try {
    let sequence = 1
    for (const asset of targets) {
      if (cancelRequested) throw new CancelledError()
      audioState.batch.text = `处理 ${asset.fileName}`
      await processAsset(asset, () => sequence++)
      audioState.batch.done++
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (cancelRequested) throw new CancelledError()
    notify(`处理完成，共生成 ${audioState.outputs.length} 个文件`)
  } catch (error) {
    if (error instanceof CancelledError) {
      notify('已取消处理')
    } else {
      const message = error instanceof Error ? error.message : '处理失败'
      audioState.batch.error = message
      fail(message)
    }
  } finally {
    audioState.batch.running = false
    audioState.batch.cancelling = false
    audioState.batch.text = ''
  }
}

async function processAsset(asset: AudioAsset, nextSequence: () => number): Promise<void> {
  const file = sourceFiles.get(asset.id)
  if (!file) throw new Error(`源文件已失效：${asset.fileName}`)
  // 每次从原始文件重新解码，保证「处理 → 再处理」结果一致且不累积上轮处理
  const decoded = await decodeAudioFile(file, asset.fileName)
  const baseAnalysis = analyzeLoudness(decoded.pcm)

  const chained = await applyChain(decoded.pcm, audioState.chain, {
    isCancelled: () => cancelRequested,
  })
  const stepText = chained.steps.map((step) => `${step.label}：${step.detail}`)

  if (audioState.variants.enabled && audioState.variants.count > 0) {
    await emitVariants(asset, chained.pcm, baseAnalysis, stepText, nextSequence)
  } else {
    await emitOutput(asset, chained.pcm, baseAnalysis, -1, '', stepText, nextSequence())
  }
}

async function emitVariants(
  asset: AudioAsset,
  pcm: AudioPcm,
  baseAnalysis: LoudnessResult,
  stepText: string[],
  nextSequence: () => number,
): Promise<void> {
  const accepted: Float32Array[] = []
  for (let index = 0; index < audioState.variants.count; index++) {
    if (cancelRequested) throw new CancelledError()
    let rendered: AudioPcm | null = null
    let plan: VariantPlan | null = null
    // 相似度超阈值就换一组随机参数重掷，避免产出雷同变体
    for (let attempt = 0; attempt <= VARIANT_RETRY; attempt++) {
      const plans = planVariants(audioState.variants, attempt * 1000 + index)
      const candidate = plans[index % Math.max(1, plans.length)]
      const result = renderVariant(pcm, candidate, { isCancelled: () => cancelRequested })
      if (!audioState.variants.dedupe) {
        rendered = result
        plan = candidate
        break
      }
      const fingerprint = variantFingerprint(result)
      const tooSimilar = accepted.some((item) => fingerprintSimilarity(item, fingerprint) >= VARIANT_DUPLICATE_THRESHOLD)
      if (!tooSimilar) {
        accepted.push(fingerprint)
        rendered = result
        plan = candidate
        break
      }
    }
    if (!rendered || !plan) continue
    await emitOutput(asset, rendered, baseAnalysis, index, variantTag(plan), stepText, nextSequence())
  }
}

async function emitOutput(
  asset: AudioAsset,
  pcm: AudioPcm,
  baseAnalysis: LoudnessResult,
  variantIndex: number,
  variantLabel: string,
  stepText: string[],
  sequence: number,
): Promise<void> {
  const encoded = await encodeAudio(pcm, encodeOptionsFor(audioState.exportSettings), {
    isCancelled: () => cancelRequested,
  })
  const analysis = analyzeLoudness(pcm)
  const findings = inspectPcm(pcm, analysis, qcLimits.value)

  const name = applyNameTemplate(audioState.exportSettings.nameTemplate || '{name}', {
    name: asset.fileName.replace(/\.[^.]+$/, ''),
    preset: presetLabel(),
    variant: variantLabel,
    index: sequence,
    ext: encoded.extension,
  })
  const fileName = uniqueName(`${sanitizeFileName(name)}.${encoded.extension}`)
  const blob = markRaw(new Blob([encoded.bytes as BlobPart], { type: encoded.mimeType }))
  const previewUrl = URL.createObjectURL(blob)

  audioState.outputs.push({
    id: makeId('out'),
    assetId: asset.id,
    variantIndex,
    label: variantLabel || '主输出',
    fileName,
    mimeType: encoded.mimeType,
    blob,
    previewUrl,
    durationSec: pcm.sampleRate > 0 ? pcm.length / pcm.sampleRate : 0,
    sampleRate: pcm.sampleRate,
    channelCount: pcm.channels.length,
    integratedLufs: analysis.integratedLufs,
    samplePeakDb: analysis.samplePeakDb,
    truePeakDb: analysis.truePeakDb,
    steps: stepText,
    findings,
  })

  audioState.reportRows.push({
    source: asset.fileName,
    output: fileName,
    variant: variantLabel || '主输出',
    status: 'ok',
    durationSec: pcm.sampleRate > 0 ? pcm.length / pcm.sampleRate : 0,
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.length,
    beforeLufs: baseAnalysis.integratedLufs,
    afterLufs: analysis.integratedLufs,
    beforePeakDb: baseAnalysis.samplePeakDb,
    afterPeakDb: analysis.samplePeakDb,
    steps: stepText.join('；'),
    findings: findings.map((item) => item.message).join('；'),
    error: '',
  })
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'audio'
}

/**
 * 同名结果自动追加序号。
 * 模板里带 {variant}/{index} 时通常不会撞名，但用户可能把模板改成固定串，
 * 这里兜底保证 ZIP 内不会出现同名条目互相覆盖。
 */
function uniqueName(name: string): string {
  if (!audioState.exportSettings.ensureUnique) return name
  const used = new Set(audioState.outputs.map((item) => item.fileName))
  if (!used.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let seq = 2
  while (used.has(`${stem}_${seq}${ext}`)) seq++
  return `${stem}_${seq}${ext}`
}

// ---------------------------------------------------------------- 导出

export async function downloadAll(): Promise<void> {
  if (audioState.outputs.length === 0) {
    fail('没有可下载的结果，请先执行处理')
    return
  }
  try {
    await downloadZip(
      audioState.outputs.map((item) => ({ name: item.fileName, blob: item.blob })),
      `audio-export-${audioState.outputs.length}.zip`,
    )
    notify(`已打包下载 ${audioState.outputs.length} 个文件`)
  } catch (error) {
    fail(error instanceof Error ? error.message : '打包下载失败')
  }
}

export function downloadOne(output: AudioOutput): void {
  downloadBlob(output.blob, output.fileName)
}

export function downloadReport(format: 'csv' | 'json'): void {
  if (audioState.reportRows.length === 0) {
    fail('没有可导出的报告，请先执行处理')
    return
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  if (format === 'csv') {
    downloadBlob(new Blob([`\ufeff${reportToCsv(audioState.reportRows)}`], { type: 'text/csv;charset=utf-8' }), `audio-report-${stamp}.csv`)
    return
  }
  const meta = {
    preset: presetLabel(),
    format: audioState.exportSettings.format,
    chain: audioState.chain,
    variants: audioState.variants,
  }
  downloadBlob(new Blob([reportToJson(audioState.reportRows, meta)], { type: 'application/json' }), `audio-report-${stamp}.json`)
}

// ---------------------------------------------------------------- 设置持久化

const SETTINGS_KEY = 'atlas-slice:audio-settings'

/** 只持久化参数，素材与处理结果不跨会话保留 */
export function persist(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      chain: audioState.chain,
      exportSettings: audioState.exportSettings,
      mixExport: audioState.mixExport,
      mixFileName: audioState.mixFileName,
      variants: audioState.variants,
      platformPresetId: audioState.platformPresetId,
      userPresets: audioState.userPresets,
      namingPattern: audioState.namingPattern,
      maxDurationSec: audioState.maxDurationSec,
    }))
  } catch {
    /* 本地存储不可用时忽略，不影响本次会话使用 */
  }
}

function restore(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as {
      chain?: AudioChain
      exportSettings?: ExportSettings
      mixExport?: EncodeSettings
      mixFileName?: string
      variants?: VariantSettings
      platformPresetId?: string
      userPresets?: ChainPreset[]
      namingPattern?: string
      maxDurationSec?: number
    } | null
    if (!saved) return
    if (saved.chain) {
      for (const [key, value] of Object.entries(saved.chain)) {
        const target = audioState.chain[key as keyof AudioChain]
        if (target && typeof value === 'object') Object.assign(target as object, value)
      }
    }
    if (saved.exportSettings) {
      Object.assign(audioState.exportSettings, saved.exportSettings)
      // 上次选中的格式可能已下线，回落到 WAV 避免出现空选项
      if (!AUDIO_FORMATS.some((item) => item.format === audioState.exportSettings.format && item.available)) {
        audioState.exportSettings.format = 'wav'
      }
    }
    if (saved.mixExport) {
      Object.assign(audioState.mixExport, saved.mixExport)
      if (!AUDIO_FORMATS.some((item) => item.format === audioState.mixExport.format && item.available)) {
        audioState.mixExport.format = 'wav'
      }
    }
    if (typeof saved.mixFileName === 'string') audioState.mixFileName = saved.mixFileName
    if (saved.variants) Object.assign(audioState.variants, saved.variants)
    if (saved.platformPresetId) audioState.platformPresetId = saved.platformPresetId
    if (Array.isArray(saved.userPresets)) audioState.userPresets = saved.userPresets
    if (typeof saved.namingPattern === 'string') audioState.namingPattern = saved.namingPattern
    if (Number.isFinite(saved.maxDurationSec)) audioState.maxDurationSec = saved.maxDurationSec as number
  } catch {
    /* 本地设置损坏时按默认值继续 */
  }
}

restore()

/** 供界面直接使用的展示函数 */
export { formatDb, formatLufs }

/** 预构建一次插值核，避免首次处理时才编译造成的一次性卡顿 */
buildInterpolationKernel(64, 24, 1)
