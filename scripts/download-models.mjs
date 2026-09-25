// 下载抠图模型到 public/models/，让本地权重可复现
// 用法：
//   node scripts/download-models.mjs                  # 下载界面可选的全部精度（约 295MB）
//   node scripts/download-models.mjs --fp16-only      # 只下默认 FP16（RMBG，约 84MB）
//   node scripts/download-models.mjs --repo=briaai/RMBG-1.4   # 只下某一个模型
//   node scripts/download-models.mjs --host=https://huggingface.co
//   node scripts/download-models.mjs --imgly          # 把 ISNet（imgly）权重镜像到本地（官方 CDN，国内需代理）
//   node scripts/download-models.mjs --imgly --source=https://example.com/xxx/dist/   # 换 ISNet 镜像源
//   node scripts/download-models.mjs --imgly --out=/tmp/imgly-mirror-test             # 换输出目录
//   node scripts/download-models.mjs --force          # 已存在的文件也重新下载
// 说明：
// - 模型清单来自 src/core/model-registry.json，与浏览器端「模型管理」弹窗共用同一份数据。
// - public/models/* 被 .gitignore 忽略，换机器或清空工作区后需要重跑本脚本。
// - 代码对 RMBG-1.4 强制 local_files_only，缺文件不会回落远程，必须下全。
// - 下载中断会保留 .part 文件，下次运行用 Range 请求续传；下载完成后按字节数校验。
// - --imgly / --source= / --out= 只作用于 ISNet 镜像（镜像目录是扁平两层：resources.json + 分片同名同级），
//   此时不会下载清单里的 RMBG 权重；ISNet 镜像目录存在时运行时不再访问 CDN。
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODELS_DIR = join(ROOT, 'public', 'models')
const MANIFEST_PATH = join(ROOT, 'src', 'core', 'model-registry.json')

/**
 * 各仓库需要落地的文件，统一从共享清单读取。
 * size 是字节数，用于校验下载完整性；
 * tier='base' 表示精简集（配置 + 界面默认精度）也要下载，tier='extra' 只在全量模式下下载。
 */
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const REPOS = MANIFEST.repos
const IMGLY_PACKAGE = MANIFEST.imgly.package
const IMGLY_MIRROR_DIR = join(MODELS_DIR, MANIFEST.imgly.mirrorPath)

/**
 * ISNet 的资源清单 resources.json 里没有版本号，官方 CDN 的版本号等于已安装运行时的版本，
 * 因此从 node_modules 里读，避免脚本里硬编码版本（升级依赖后无需改脚本）。
 */
function installedVersion(pkg) {
  const path = join(ROOT, 'node_modules', pkg, 'package.json')
  if (!existsSync(path)) throw new Error(`未找到已安装的 ${pkg}，请先执行 pnpm install`)
  return JSON.parse(readFileSync(path, 'utf8')).version
}

const args = process.argv.slice(2)

/** 取选项值，`--opt=value` 与 `--opt value` 两种写法都支持；没有该选项时返回 undefined */
function optionValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const force = args.includes('--force')
const baseOnly = args.includes('--fp16-only')
const repoArg = optionValue('--repo')
const hostArg = optionValue('--host')
const onlyRepo = repoArg ? repoArg.trim().toLowerCase() : ''
const HOST = (hostArg ?? process.env.MODEL_HOST ?? 'https://hf-mirror.com').replace(/\/+$/, '')

const sourceArg = optionValue('--source')
const outArg = optionValue('--out')
// --source / --out 只对 ISNet 镜像有意义，出现即视为只镜像 ISNet，避免误把清单里的 RMBG 也下一遍
const imglyOnly = args.includes('--imgly') || Boolean(sourceArg) || Boolean(outArg)
const IMGLY_SOURCE = (sourceArg ?? `https://staticimgly.com/${IMGLY_PACKAGE}-data/${installedVersion(IMGLY_PACKAGE)}/dist/`).replace(/\/+$/, '')
const IMGLY_OUT_DIR = outArg ? resolve(outArg) : IMGLY_MIRROR_DIR

let downloaded = 0
let skipped = 0
const failures = []

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

/** 取文本（resources.json），失败时给出带地址的错误信息 */
async function fetchText(url) {
  let response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    throw new Error(`无法连接 ${url}（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`)
  return await response.text()
}

/**
 * 下载 imgly 的单个分片。
 * 分片是 content-addressed 的（文件名即 hash，无扩展名），体积约 4MB 且服务端不一定支持 Range，
 * 因此不做断点续传，直接写 .part 再改名，并强制校验字节数等于 offsets 差值。
 */
async function downloadImglyChunk(url, target, size) {
  const part = `${target}.part`
  mkdirSync(dirname(target), { recursive: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { flags: 'w' }))
  const written = statSync(part).size
  if (size && written !== size) throw new Error(`字节数不符：期望 ${size} 字节，实际 ${written} 字节`)
  renameSync(part, target)
  return written
}

/**
 * 把 ISNet（imgly）的资源镜像到本地目录。
 * imgly 运行时读取 <publicPath>/resources.json，再用 new URL(chunk.name, publicPath) 拼分片地址，
 * 所以镜像目录是扁平两层：resources.json 与全部分片同级。
 * 分片字段名两种都要兼容：1.7.0 是 name，1.4.5 是 hash。
 */
async function mirrorImgly() {
  console.log(`[ISNet 镜像] 来源 ${IMGLY_SOURCE}${sourceArg ? '（--source 指定）' : '（官方 CDN，中国大陆通常需要代理）'}`)
  console.log(`输出目录 ${IMGLY_OUT_DIR}\n`)
  try {
    const resourcesText = await fetchText(`${IMGLY_SOURCE}/resources.json`)
    const resourceMap = JSON.parse(resourcesText)
    mkdirSync(IMGLY_OUT_DIR, { recursive: true })
    writeFileSync(join(IMGLY_OUT_DIR, 'resources.json'), resourcesText)

    /** 分片文件名 → 期望字节数；同一分片可能被多个 key 引用，按名字去重 */
    const chunkSizes = new Map()
    for (const entry of Object.values(resourceMap)) {
      for (const chunk of entry?.chunks ?? []) {
        const name = chunk.name ?? chunk.hash
        if (!name) continue
        const offsets = chunk.offsets ?? []
        const size = offsets.length === 2 ? offsets[1] - offsets[0] : 0
        if (!chunkSizes.has(name) || chunkSizes.get(name) === 0) chunkSizes.set(name, size)
      }
    }
    console.log(`   resources.json 就位（${Object.keys(resourceMap).length} 个资源，${chunkSizes.size} 个分片）\n`)

    for (const [name, size] of chunkSizes) {
      const target = join(IMGLY_OUT_DIR, name)
      if (!force && isComplete(target, size)) {
        console.log(`   跳过 ${name}`)
        skipped += 1
        continue
      }
      process.stdout.write(`   下载 ${name}（${mb(size)}） …`)
      try {
        const started = Date.now()
        await downloadImglyChunk(`${IMGLY_SOURCE}/${name}`, target, size)
        console.log(` 完成（${((Date.now() - started) / 1000).toFixed(1)}s）`)
        downloaded += 1
      } catch (error) {
        console.log(' 失败')
        failures.push(`imgly/${name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    console.log(' 失败')
    failures.push(`imgly 镜像：${error instanceof Error ? error.message : String(error)}`)
  }
  console.log('')
}

async function main() {
  if (imglyOnly) {
    await mirrorImgly()
  } else {
    await downloadRepos()
  }

  console.log(`下载 ${downloaded} 个，跳过 ${skipped} 个，失败 ${failures.length} 个`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure}`)
    if (imglyOnly) {
      console.error('官方 CDN（staticimgly.com）在中国大陆通常需要代理：可先挂代理重试，或用 --source=<可访问的镜像地址> 换源。')
      console.error('本脚本可重复运行：已下载且字节数正确的分片会直接跳过。')
    } else {
      console.error('可重新运行本脚本续传：中断的 .part 文件会从断点继续。')
    }
    process.exitCode = 1
  }
}

/** 下载清单里的仓库权重（RMBG），行为与加 --imgly 之前一致 */
async function downloadRepos() {
  const selected = onlyRepo ? REPOS.filter((repo) => repo.id.toLowerCase() === onlyRepo) : REPOS
  if (selected.length === 0) {
    console.error(`清单里没有 id 为 ${repoArg} 的模型，可用：${REPOS.map((repo) => repo.id).join('、')}`)
    process.exitCode = 1
    return
  }

  console.log(`模型源：${HOST}${hostArg ? '（--host 指定）' : ''}`)
  console.log(`下载范围：${onlyRepo ? `仅 ${selected[0].id}` : baseOnly ? '精简集（默认 FP16）' : '全量（所有精度）'}\n`)

  for (const repo of selected) {
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
}

await main()
