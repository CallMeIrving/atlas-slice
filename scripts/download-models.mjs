// 下载抠图模型到 public/models/，让本地权重可复现
// 用法：
//   node scripts/download-models.mjs                  # 下载界面可选的全部精度（约 750MB）
//   node scripts/download-models.mjs --fp16-only      # 只下默认 FP16（BiRefNet/RMBG）+ SAM Q8（约 310MB）
//   node scripts/download-models.mjs --host=https://huggingface.co
//   node scripts/download-models.mjs --force          # 已存在的文件也重新下载
// 说明：
// - public/models/* 被 .gitignore 忽略，换机器或清空工作区后需要重跑本脚本。
// - 代码对 BiRefNet / RMBG-1.4 / SAM 强制 local_files_only，缺文件不会回落远程，必须下全。
// - 下载中断会保留 .part 文件，下次运行用 Range 请求续传；下载完成后按字节数校验。
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODELS_DIR = join(ROOT, 'public', 'models')

/**
 * 各仓库需要落地的文件。size 是字节数，用于校验下载完整性；
 * tier='base' 表示精简集（配置 + 界面默认精度）也要下载，tier='extra' 只在全量模式下下载。
 */
const REPOS = [
  {
    id: 'onnx-community/BiRefNet_lite-ONNX',
    label: 'BiRefNet',
    files: [
      { file: 'config.json', size: 81, tier: 'base' },
      { file: 'preprocessor_config.json', size: 391, tier: 'base' },
      { file: 'onnx/model_fp16.onnx', size: 114538221, tier: 'base', note: 'FP16，界面默认精度' },
      { file: 'onnx/model.onnx', size: 224005088, tier: 'extra', note: 'FP32；该仓库没有量化权重，界面不提供 Q8' },
    ],
  },
  {
    id: 'briaai/RMBG-1.4',
    label: 'RMBG-1.4',
    files: [
      { file: 'config.json', size: 548, tier: 'base' },
      { file: 'preprocessor_config.json', size: 345, tier: 'base' },
      { file: 'onnx/model_fp16.onnx', size: 88217533, tier: 'base', note: 'FP16，界面默认精度' },
      { file: 'onnx/model_quantized.onnx', size: 44403226, tier: 'extra', note: 'Q8' },
      { file: 'onnx/model.onnx', size: 176153355, tier: 'extra', note: 'FP32' },
    ],
  },
  {
    id: 'Xenova/sam-vit-base',
    label: 'SAM（项目固定 Q8）',
    files: [
      { file: 'config.json', size: 440, tier: 'base' },
      { file: 'preprocessor_config.json', size: 466, tier: 'base' },
      { file: 'quantize_config.json', size: 2017, tier: 'base' },
      { file: 'onnx/vision_encoder_quantized.onnx', size: 101088469, tier: 'base' },
      { file: 'onnx/prompt_encoder_mask_decoder_quantized.onnx', size: 4903810, tier: 'base', note: 'SAM 的权重拆成编码器与解码器两个文件' },
      // 上游仓库没有 processor_config.json，但 SAM_LOCAL_FILES 会 HEAD 检查它，缺了直接抛错，这里直接生成
      { file: 'processor_config.json', size: 40, tier: 'base', content: '{\n  "processor_class": "SamProcessor"\n}\n' },
    ],
  },
]

const args = process.argv.slice(2)
const force = args.includes('--force')
const baseOnly = args.includes('--fp16-only')
const hostArg = args.find((arg) => arg.startsWith('--host='))
const HOST = (hostArg ? hostArg.slice('--host='.length) : process.env.MODEL_HOST || 'https://hf-mirror.com').replace(/\/+$/, '')

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 目标文件是否已是完整文件（有期望字节数时按字节数判断） */
function isComplete(path, size) {
  if (!existsSync(path)) return false
  return size ? statSync(path).size === size : true
}

/** 下载单个文件：写入 .part 后改名，中断时保留 .part 供下次续传 */
async function downloadFile(repoId, entry) {
  const target = join(MODELS_DIR, repoId, entry.file)
  const part = `${target}.part`
  const resumable = existsSync(part) ? statSync(part).size : 0
  mkdirSync(dirname(target), { recursive: true })
  const url = `${HOST}/${repoId}/resolve/main/${entry.file}`
  const response = await fetch(url, { headers: resumable > 0 ? { Range: `bytes=${resumable}-` } : {}, redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`)
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/html')) throw new Error(`返回 HTML 而不是模型文件（${url}），请检查模型源`)
  const resuming = resumable > 0 && response.status === 206
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { flags: resuming ? 'a' : 'w' }))
  const written = statSync(part).size
  if (entry.size && written !== entry.size) {
    console.warn(`      ⚠ 大小不符：期望 ${entry.size} 字节，实际 ${written} 字节，已保留下载结果`)
  }
  renameSync(part, target)
  return written
}

async function main() {
  console.log(`模型源：${HOST}${hostArg ? '（--host 指定）' : ''}`)
  console.log(`下载范围：${baseOnly ? '精简集（默认 FP16 + SAM Q8）' : '全量（所有精度）'}\n`)

  let downloaded = 0
  let skipped = 0
  const failures = []

  for (const repo of REPOS) {
    const files = repo.files.filter((entry) => !baseOnly || entry.tier === 'base')
    console.log(`[${repo.label}] ${repo.id} —— ${files.length} 个文件`)
    mkdirSync(join(MODELS_DIR, repo.id), { recursive: true })

    for (const entry of files) {
      const target = join(MODELS_DIR, repo.id, entry.file)
      const note = entry.note ? `（${entry.note}）` : ''
      if (!force && isComplete(target, entry.size)) {
        console.log(`   跳过 ${entry.file}${note}`)
        skipped += 1
        continue
      }
      process.stdout.write(`   下载 ${entry.file}${note} …`)
      try {
        const started = Date.now()
        if (entry.content != null) {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, entry.content)
        } else {
          await downloadFile(repo.id, entry)
        }
        const size = statSync(target).size
        console.log(` 完成 ${mb(size)}（${((Date.now() - started) / 1000).toFixed(1)}s）`)
        downloaded += 1
      } catch (error) {
        console.log(' 失败')
        failures.push(`${repo.id}/${entry.file}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    console.log('')
  }

  console.log(`下载 ${downloaded} 个，跳过 ${skipped} 个，失败 ${failures.length} 个`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure}`)
    console.error('可重新运行本脚本续传：中断的 .part 文件会从断点继续。')
    process.exitCode = 1
  }
}

await main()
