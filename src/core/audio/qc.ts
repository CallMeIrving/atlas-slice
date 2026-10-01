/**
 * 批量质检与导出报告。
 *
 * 质检只做「确定能判对」的几类问题（全静音、削波、疑似爆音、超长、响度偏离），
 * 宁可少报也不误报，避免用户对告警脱敏。
 */

import type { LoudnessResult } from './loudness'
import type { AudioPcm } from './pcm'

export type QcCode = 'silent' | 'clipping' | 'pop' | 'tooLong' | 'loudnessHigh' | 'loudnessDeviation'

export interface QcFinding {
  code: QcCode
  level: 'warn' | 'error'
  message: string
}

export interface QcLimits {
  /** 允许的最长时长（秒） */
  maxDurationSec: number
  /** 期望响度（LUFS） */
  targetLufs: number
  /** 响度允许偏差（LU） */
  lufsTolerance: number
  /** 是否启用了响度标准化：启用了就按目标比对，没启用只判断是否偏高 */
  normalizeEnabled: boolean
}

/** 相邻样本跳变超过该值视为疑似爆音（满量程级跳变，正常素材极少触发） */
const POP_DELTA = 0.95
/** 削波判定阈值 */
const CLIP_LEVEL = 0.999

export function inspectPcm(pcm: AudioPcm, analysis: LoudnessResult, limits: QcLimits): QcFinding[] {
  const findings: QcFinding[] = []
  const durationSec = pcm.sampleRate > 0 ? pcm.length / pcm.sampleRate : 0

  if (!Number.isFinite(analysis.samplePeakDb) || analysis.samplePeakDb < -60) {
    findings.push({ code: 'silent', level: 'error', message: '整段接近全静音，请检查源文件或裁剪区间' })
    return findings
  }

  let clipped = 0
  let pops = 0
  for (const channel of pcm.channels) {
    let previous = channel.length > 0 ? channel[0] : 0
    for (let i = 0; i < channel.length; i++) {
      const value = channel[i]
      if (Math.abs(value) >= CLIP_LEVEL) clipped++
      if (Math.abs(value - previous) >= POP_DELTA) pops++
      previous = value
    }
  }
  if (clipped > 0) {
    findings.push({ code: 'clipping', level: 'warn', message: `检测到 ${clipped} 个削波采样，建议降低增益或启用限幅` })
  }
  if (pops > 0) {
    findings.push({ code: 'pop', level: 'warn', message: `检测到 ${pops} 处疑似爆音（样本级突跳）` })
  }
  if (durationSec > limits.maxDurationSec) {
    findings.push({
      code: 'tooLong',
      level: 'warn',
      message: `时长 ${durationSec.toFixed(1)} s 超过建议上限 ${limits.maxDurationSec} s`,
    })
  }

  const lufs = analysis.integratedLufs
  if (Number.isFinite(lufs)) {
    if (limits.normalizeEnabled) {
      if (Math.abs(lufs - limits.targetLufs) > limits.lufsTolerance) {
        findings.push({
          code: 'loudnessDeviation',
          level: 'warn',
          message: `响度 ${lufs.toFixed(1)} LUFS 偏离目标 ${limits.targetLufs} LUFS 超过 ${limits.lufsTolerance} LU`,
        })
      }
    } else if (lufs > -14) {
      findings.push({ code: 'loudnessHigh', level: 'warn', message: `响度 ${lufs.toFixed(1)} LUFS 偏高，建议启用响度标准化` })
    }
  }
  return findings
}

export interface ReportRow {
  source: string
  output: string
  variant: string
  status: 'ok' | 'failed'
  durationSec: number
  sampleRate: number
  channels: number
  beforeLufs: number
  afterLufs: number
  beforePeakDb: number
  afterPeakDb: number
  steps: string
  findings: string
  error: string
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

const REPORT_HEADER = [
  '源文件', '输出文件', '变体', '状态', '时长(s)', '采样率(Hz)', '声道',
  '处理前响度(LUFS)', '处理后响度(LUFS)', '处理前峰值(dBFS)', '处理后峰值(dBFS)',
  '处理步骤', '质检', '错误',
]

export function reportToCsv(rows: ReportRow[]): string {
  const lines = [REPORT_HEADER.join(',')]
  for (const row of rows) {
    lines.push([
      row.source,
      row.output,
      row.variant,
      row.status === 'ok' ? '成功' : '失败',
      row.durationSec.toFixed(3),
      String(row.sampleRate),
      String(row.channels),
      Number.isFinite(row.beforeLufs) ? row.beforeLufs.toFixed(1) : '',
      Number.isFinite(row.afterLufs) ? row.afterLufs.toFixed(1) : '',
      Number.isFinite(row.beforePeakDb) ? row.beforePeakDb.toFixed(1) : '',
      Number.isFinite(row.afterPeakDb) ? row.afterPeakDb.toFixed(1) : '',
      row.steps,
      row.findings,
      row.error,
    ].map(csvCell).join(','))
  }
  return lines.join('\n')
}

export function reportToJson(rows: ReportRow[], meta: Record<string, unknown>): string {
  return JSON.stringify({ generatedAt: new Date().toISOString(), ...meta, rows }, null, 2)
}
