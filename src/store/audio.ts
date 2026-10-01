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
  PLATFORM_PRESETS,
  cloneChain,
  cloneExport,
  type AudioChain,
  type ExportSettings,
} from '@/core/audio/presets'
import { CancelledError, concatPcm, cropPcm } from '@/core/audio/dsp'
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

export interface MergeSettings {
  /** 段与段之间的静音间隔（秒） */
  gapSec: number
  /** 每段首尾淡入淡出（秒） */
  fadeSec: number
}

export const audioState = reactive({
  assets: [] as AudioAsset[],
  activeAssetId: '',
  chain: cloneChain(DEFAULT_CHAIN),
  exportSettings: cloneExport(DEFAULT_EXPORT),
  variants: { ...DEFAULT_VARIANTS },
  platformPresetId: '',
  userPresets: [] as ChainPreset[],
  namingPattern: '^[a-z0-9_\\-]+$',
  maxDurationSec: 300,
  /** 合成顺序（素材 id），未列出的素材按素材库顺序追加在后面 */
  mergeOrder: [] as string[],
  mergeSettings: { gapSec: 0.05, fadeSec: 0.005 } as MergeSettings,
  importing: false,
  importDone: 0,
  importTotal: 0,
  importText: '',
  batch: { running: false, cancelling: false, done: 0, total: 0, text: '', error: '' } as BatchState,
  outputs: [] as AudioOutput[],
  reportRows: [] as ReportRow[],
  error: '',
  notice: '',
})

export const activeAsset = computed<AudioAsset | null>(
  () => audioState.assets.find((item) => item.id === audioState.activeAssetId) ?? audioState.assets[0] ?? null,
)

/** 合成顺序：显式排序过的素材在前，其余按素材库顺序排在后面 */
export const mergeSequence = computed<AudioAsset[]>(() => {
  const byId = new Map(audioState.assets.map((item) => [item.id, item]))
  const ordered: AudioAsset[] = []
  for (const id of audioState.mergeOrder) {
    const asset = byId.get(id)
    if (asset) {
      ordered.push(asset)
      byId.delete(id)
    }
  }
  return [...ordered, ...audioState.assets.filter((item) => byId.has(item.id))]
})

/** 上移 / 下移一条素材（delta 为 -1 / +1），越界时忽略 */
export function moveMergeItem(id: string, delta: number): void {
  const ids = mergeSequence.value.map((item) => item.id)
  const index = ids.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= ids.length) return
  ids.splice(index, 1)
  ids.splice(target, 0, id)
  audioState.mergeOrder = ids
}

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

// ---------------------------------------------------------------- 导入

export async function importFiles(files: File[]): Promise<void> {
  if (!files.length) return
  audioState.error = ''
  audioState.importing = true
  audioState.importTotal = files.length
  audioState.importDone = 0
  try {
    for (const file of files) {
      audioState.importText = `正在解析 ${file.name}`
      await importOne(file)
      audioState.importDone++
      // 让出主线程，长批次下进度条仍能刷新
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    notify(`已导入 ${files.length} 个音频文件`)
  } catch (error) {
    fail(error instanceof Error ? error.message : '音频导入失败')
  } finally {
    audioState.importing = false
    audioState.importText = ''
  }
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
  audioState.mergeOrder = audioState.mergeOrder.filter((item) => item !== id)
  if (audioState.activeAssetId === id) audioState.activeAssetId = audioState.assets[0]?.id ?? ''
}

export function clearAssets(): void {
  clearOutputs()
  audioState.assets.forEach((item) => URL.revokeObjectURL(item.previewUrl))
  audioState.assets = []
  sourceFiles.clear()
  audioState.mergeOrder = []
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

// ---------------------------------------------------------------- 剪辑与合成

/** 生成素材名统一用小写字母/数字/下划线，避免触发默认命名规范告警 */
function sanitizeStem(stem: string): string {
  return stem.toLowerCase().replace(/[^a-z0-9_\-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '') || 'audio'
}

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
  return asset
}

/**
 * 按选区生成新素材（非破坏性）。
 * mode='keep' 保留选区、丢弃两侧；mode='remove' 丢弃选区、把前后两段拼回一条。
 */
export async function createTrimmedAsset(
  assetId: string,
  startSec: number,
  endSec: number,
  mode: 'keep' | 'remove',
): Promise<void> {
  const asset = audioState.assets.find((item) => item.id === assetId)
  if (!asset) return
  audioState.error = ''
  audioState.importing = true
  audioState.importText = '正在生成裁剪素材'
  try {
    const pcm = await decodeAsset(asset)
    const total = pcmDuration(pcm)
    const start = Math.max(0, Math.min(startSec, total))
    const end = Math.max(start, Math.min(endSec, total))

    let result: AudioPcm
    if (mode === 'keep') {
      result = cropPcm(pcm, start, end)
    } else {
      const head = cropPcm(pcm, 0, start)
      const tail = cropPcm(pcm, end, total)
      result = await concatPcm([head, tail])
    }
    if (result.length === 0) {
      fail('选区为空，没有可保留的样本')
      return
    }
    const base = sanitizeStem(asset.fileName.replace(/\.[^.]+$/, ''))
    registerGeneratedPcm(result, `${base}_${mode === 'keep' ? 'trim' : 'cut'}`)
    notify(mode === 'keep' ? '已按选区保留并生成新素材' : '已裁掉选区并生成新素材')
  } catch (error) {
    fail(error instanceof Error ? error.message : '裁剪失败')
  } finally {
    audioState.importing = false
    audioState.importText = ''
  }
}

/** 把合成顺序里的素材首尾拼接为一条新素材 */
export async function createMergedAsset(): Promise<void> {
  const sequence = mergeSequence.value
  if (sequence.length < 2) {
    fail('至少需要两条素材才能合成')
    return
  }
  audioState.error = ''
  audioState.importing = true
  try {
    const parts: AudioPcm[] = []
    for (const asset of sequence) {
      audioState.importText = `正在解析 ${asset.fileName}`
      parts.push(await decodeAsset(asset))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    audioState.importText = '正在拼接'
    const pcm = await concatPcm(parts, {
      gapSec: audioState.mergeSettings.gapSec,
      fadeSec: audioState.mergeSettings.fadeSec,
    })
    registerGeneratedPcm(pcm, `merge_${sequence.length}`)
    notify(`已合成 ${sequence.length} 条素材，共 ${pcmDuration(pcm).toFixed(2)} 秒`)
  } catch (error) {
    fail(error instanceof Error ? error.message : '合成失败')
  } finally {
    audioState.importing = false
    audioState.importText = ''
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

/** 当前导出格式是否可用，不可用时给出原因 */
export function formatIssue(): string {
  const info = AUDIO_FORMATS.find((item) => item.format === audioState.exportSettings.format)
  if (!info) return '未知导出格式'
  if (!info.available) return `${info.label} 暂不可用：${info.hint ?? ''}`
  return ''
}

export async function runBatch(): Promise<void> {
  if (audioState.batch.running) return
  if (audioState.assets.length === 0) {
    fail('请先导入音频素材')
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
  const total = audioState.assets.length
  Object.assign(audioState.batch, { running: true, cancelling: false, done: 0, total, text: '', error: '' })

  try {
    let sequence = 1
    for (const asset of audioState.assets) {
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
  const encodeOptions: EncodeOptions = {
    format: audioState.exportSettings.format,
    wavEncoding: audioState.exportSettings.wavEncoding,
    mp3Bitrate: audioState.exportSettings.mp3Bitrate,
    oggQuality: audioState.exportSettings.oggQuality,
  }
  const encoded = await encodeAudio(pcm, encodeOptions, { isCancelled: () => cancelRequested })
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
      variants: audioState.variants,
      platformPresetId: audioState.platformPresetId,
      userPresets: audioState.userPresets,
      namingPattern: audioState.namingPattern,
      maxDurationSec: audioState.maxDurationSec,
      mergeSettings: audioState.mergeSettings,
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
      variants?: VariantSettings
      platformPresetId?: string
      userPresets?: ChainPreset[]
      namingPattern?: string
      maxDurationSec?: number
      mergeSettings?: MergeSettings
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
    if (saved.variants) Object.assign(audioState.variants, saved.variants)
    if (saved.platformPresetId) audioState.platformPresetId = saved.platformPresetId
    if (Array.isArray(saved.userPresets)) audioState.userPresets = saved.userPresets
    if (typeof saved.namingPattern === 'string') audioState.namingPattern = saved.namingPattern
    if (Number.isFinite(saved.maxDurationSec)) audioState.maxDurationSec = saved.maxDurationSec as number
    if (saved.mergeSettings) Object.assign(audioState.mergeSettings, saved.mergeSettings)
  } catch {
    /* 本地设置损坏时按默认值继续 */
  }
}

restore()

/** 供界面直接使用的展示函数 */
export { formatDb, formatLufs }

/** 预构建一次插值核，避免首次处理时才编译造成的一次性卡顿 */
buildInterpolationKernel(64, 24, 1)
