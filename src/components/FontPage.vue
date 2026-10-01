<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  MAX_FONT_FILE_SIZE,
  buildBmfontText,
  buildBmfontXml,
  buildCharset,
  buildFont,
  buildFontJson,
  isFontAvailable,
  pageFileName,
  quoteFamily,
  registerFontFace,
  renderFontPages,
  unregisterFontFace,
  type FontBuildResult,
} from '@/core/font'
import { downloadBlob, downloadZip, type ZipEntry } from '@/core/media-export'
import { resetFont, workspace } from '@/store/workspace'

/**
 * 位图字体生成页。
 * 左栏选字体来源与字符集，中间看图集与文本效果预览，右栏调渲染参数并导出；
 * 参数变化后自动重新生成（防抖），生成过程用遮罩显示进度。
 */

const state = computed(() => workspace.font)
const input = ref<HTMLInputElement>()
const previewCanvas = ref<HTMLCanvasElement>()
/** 生成结果含像素缓冲，只留在组件内；store 里只存页数 / 字符数 / 预览图 */
const built = shallowRef<FontBuildResult | null>(null)
const generating = ref(false)
const exporting = ref(false)
const progress = ref({ done: 0, total: 0 })
/** 三档反馈：错误（红）/ 警告（黄，生成成功但有字形被截断或跳过）/ 完成提示（灰） */
const errorText = ref('')
const warnText = ref('')
const infoText = ref('')
const systemAvailable = ref<boolean | null>(null)
/** 图集预览缩放：fit 表示按容器宽度自适应，其余为固定倍率 */
const atlasZoom = ref<'fit' | 1 | 2 | 4>('fit')
/** 缩放档位；图集多是几十像素的小图，固定倍率便于逐字形核对 */
const ATLAS_ZOOMS: { value: 'fit' | 1 | 2 | 4; label: string }[] = [
  { value: 'fit', label: '适应' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
]

/** 当前生效的字体家族名：上传模式用注册名，系统字体模式用用户输入的字体名 */
const activeFamily = computed(() => (
  state.value.source === 'upload' ? state.value.family : state.value.systemFamily.trim()
))
const ready = computed(() => Boolean(activeFamily.value))
const fileName = computed(() => state.value.fileName)

/** 导出文件名只允许常规字符，避免 ZIP 里出现非法路径 */
const exportName = computed(() => {
  const name = state.value.name.trim()
  return /^[\w.-]+$/.test(name) ? name : 'font'
})

/** 字符集字符数预览：直接复用生成用的合成逻辑，保证计数与结果一致 */
const charCount = computed(() => {
  try {
    return Array.from(buildCharset(state.value.charset)).length
  } catch {
    return 0
  }
})

/**
 * 图集占位文案：没有图集时要区分「正在生成」「字符集为空」「生成失败」，
 * 否则空字符集或报错后会一直显示「图集生成中…」，让人以为还在跑。
 */
const atlasPlaceholder = computed(() => {
  if (generating.value) return '图集生成中…'
  if (!charCount.value) return '字符集为空：请先在左栏勾选字符或填写 Unicode 范围'
  if (errorText.value) return '生成失败，请查看右栏提示后调整参数'
  return '等待生成…'
})

/** 当前页的预览缩放样式：fit 交给 CSS 自适应，固定倍率直接给出像素宽度 */
const atlasImgStyle = computed(() => {
  if (atlasZoom.value === 'fit') return {}
  return { width: `${(built.value?.pages[state.value.activePage]?.width ?? 0) * atlasZoom.value}px`, maxWidth: 'none' }
})

/** dataURL → Blob，单页且不附带元数据时直接下载 PNG */
function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(',')
  const mime = /^data:(.*?);/.exec(url.slice(0, comma))?.[1] ?? 'image/png'
  const binary = atob(url.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** 导入字体文件：校验 → 注册 FontFace → 交给 watch 触发生成 */
async function loadFontFile(file?: File): Promise<void> {
  if (!file) return
  errorText.value = ''
  warnText.value = ''
  infoText.value = ''
  if (!/\.(ttf|otf|woff2?|ttc)$/i.test(file.name)) {
    errorText.value = '仅支持 TTF / OTF / WOFF / WOFF2 字体文件'
    return
  }
  if (file.size > MAX_FONT_FILE_SIZE) {
    errorText.value = `字体文件超过 ${Math.round(MAX_FONT_FILE_SIZE / 1024 / 1024)}MB 限制`
    return
  }
  const previousFamily = state.value.family
  resetFont()
  built.value = null
  if (previousFamily) unregisterFontFace(previousFamily)
  const url = URL.createObjectURL(file)
  try {
    const family = await registerFontFace(url)
    Object.assign(state.value, {
      fileName: file.name, fontUrl: url, family, source: 'upload', status: 'ready', error: '',
    })
  } catch {
    URL.revokeObjectURL(url)
    errorText.value = '字体文件解析失败，请确认是有效的 TTF / OTF / WOFF 字体'
  } finally {
    if (input.value) input.value.value = ''
  }
}

function onFileChange(e: Event): void {
  void loadFontFile((e.target as HTMLInputElement).files?.[0])
}

/* ---------------- 生成 ---------------- */

let debounceTimer: ReturnType<typeof setTimeout> | undefined
let buildToken = 0

/** 生成输入指纹：任一参数变化都重新生成 */
const buildKey = computed(() => JSON.stringify({
  family: activeFamily.value,
  charset: state.value.charset,
  sizePx: state.value.sizePx,
  padding: state.value.padding,
  mode: state.value.mode,
  sdfSpread: state.value.sdfSpread,
  maxAtlasSize: state.value.maxAtlasSize,
  powerOfTwo: state.value.powerOfTwo,
}))

function scheduleBuild(): void {
  clearTimeout(debounceTimer)
  // 防抖：连续改数值时只跑最后一次，避免大字符集被反复重算
  debounceTimer = setTimeout(() => void runBuild(), 320)
}

/** 清空生成结果与摘要，避免切到无字体状态后页数与字形数还留在界面上 */
function clearResult(): void {
  built.value = null
  state.value.pageUrls = []
  state.value.pageCount = 0
  state.value.glyphCount = 0
  state.value.activePage = 0
}

async function runBuild(): Promise<void> {
  const family = activeFamily.value
  if (!family) {
    clearResult()
    state.value.status = 'empty'
    warnText.value = ''
    errorText.value = ''
    return
  }
  if (!charCount.value) {
    clearResult()
    state.value.status = 'empty'
    errorText.value = ''
    warnText.value = '字符集为空，未生成图集：请至少勾选一项预设，或填写自定义字符 / Unicode 范围'
    return
  }
  const token = ++buildToken
  generating.value = true
  errorText.value = ''
  warnText.value = ''
  infoText.value = ''
  progress.value = { done: 0, total: charCount.value }
  try {
    // 先确保字体已加载，否则首帧会量到回落字体导致度量错位
    await document.fonts.load(`${state.value.sizePx}px ${quoteFamily(family)}`, 'ABCabc123')
    const result = await buildFont({
      ...state.value.charset,
      family,
      name: exportName.value,
      sizePx: state.value.sizePx,
      padding: state.value.padding,
      mode: state.value.mode,
      sdfSpread: state.value.sdfSpread,
      maxAtlasSize: state.value.maxAtlasSize,
      powerOfTwo: state.value.powerOfTwo,
      onProgress: (done, total) => {
        if (token === buildToken) progress.value = { done, total }
      },
    })
    if (token !== buildToken) return
    built.value = result
    state.value.pageUrls = renderFontPages(result)
    state.value.pageCount = result.pages.length
    state.value.glyphCount = result.glyphs.length
    state.value.activePage = 0
    state.value.status = 'done'
    // 截断 / 跳过属于「生成成功但有损」，用警告色而不是错误色
    if (result.warnings.length) warnText.value = result.warnings.join('；')
  } catch (error) {
    if (token !== buildToken) return
    clearResult()
    state.value.status = 'error'
    errorText.value = error instanceof Error ? error.message : '字体生成失败'
  } finally {
    if (token === buildToken) generating.value = false
  }
}

watch(buildKey, () => scheduleBuild(), { immediate: true })

/** 系统字体名变化后检测一次可用性，给出提示但不阻断生成；逐字输入时防抖，避免每个字符都建一次测量画布 */
let availableTimer: ReturnType<typeof setTimeout> | undefined
watch(() => state.value.systemFamily, (value) => {
  clearTimeout(availableTimer)
  const name = value.trim()
  if (!name) {
    systemAvailable.value = null
    return
  }
  availableTimer = setTimeout(() => {
    if (state.value.systemFamily.trim() === name) systemAvailable.value = isFontAvailable(name)
  }, 220)
})

/* ---------------- 文本效果预览 ---------------- */

function drawPreview(): void {
  const canvas = previewCanvas.value
  const family = activeFamily.value
  if (!canvas || !family) return
  const size = state.value.sizePx
  const lines = (state.value.previewText || ' ').split('\n')
  const ctx = canvas.getContext('2d')!
  const font = `${size}px ${quoteFamily(family)}, sans-serif`
  ctx.font = font
  const width = Math.ceil(Math.max(...lines.map((line) => ctx.measureText(line || ' ').width)))
  const lineHeight = Math.ceil(size * 1.4)
  canvas.width = Math.max(48, width + 24)
  canvas.height = lines.length * lineHeight + 16
  // 改变画布尺寸会重置上下文状态，字体需要在尺寸确定后重新设置
  ctx.font = font
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#e8edf5'
  lines.forEach((line, index) => ctx.fillText(line, 12, 8 + index * lineHeight + Math.round(size * 0.9)))
}

watch(
  [previewCanvas, activeFamily, () => state.value.previewText, () => state.value.sizePx, () => state.value.status],
  () => nextTick(drawPreview),
  { immediate: true },
)

/* ---------------- 导出 ---------------- */

async function exportFont(): Promise<void> {
  const result = built.value
  if (!result) return
  exporting.value = true
  errorText.value = ''
  infoText.value = ''
  try {
    const base = exportName.value
    const entries: ZipEntry[] = state.value.pageUrls.map((url, index) => ({
      name: pageFileName(base, index),
      blob: url,
    }))
    if (state.value.withFnt) entries.push({ name: `${base}.fnt`, blob: buildBmfontText(result, base) })
    if (state.value.withXml) entries.push({ name: `${base}.xml`, blob: buildBmfontXml(result, base) })
    if (state.value.withJson) entries.push({ name: `${base}.json`, blob: buildFontJson(result, base) })
    // 只导出一张 PNG 且不带元数据时直接下载，省去解压一步
    if (entries.length === 1) {
      downloadBlob(dataUrlToBlob(state.value.pageUrls[0]), entries[0].name)
      infoText.value = `已导出 ${entries[0].name}`
      return
    }
    const zipName = `${base}-font.zip`
    await downloadZip(entries, zipName)
    infoText.value = `已导出 ${zipName}（${entries.length} 个文件：${entries.map((entry) => entry.name).join('、')}）`
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** 重置：注销 FontFace、释放 blob URL 并清空结果（参数保留） */
function resetAll(): void {
  const family = state.value.family
  resetFont()
  if (family) unregisterFontFace(family)
  clearResult()
  systemAvailable.value = null
  atlasZoom.value = 'fit'
  errorText.value = ''
  warnText.value = ''
  infoText.value = ''
  state.value.error = ''
}

/**
 * 页面重挂载 / 热更新后恢复上传字体：store 里还留着 blob URL 与家族名，
 * 但页面卸载时的 FontFace 引用需要重新确认，这里按保存的家族名重新注册一次。
 */
onMounted(async () => {
  if (state.value.source === 'upload' && state.value.fontUrl && state.value.family) {
    try {
      await registerFontFace(state.value.fontUrl, state.value.family)
      state.value.status = 'ready'
    } catch {
      errorText.value = '字体文件恢复失败，请重新导入'
    }
  }
})

onBeforeUnmount(() => {
  clearTimeout(debounceTimer)
  clearTimeout(availableTimer)
  // 让正在跑的生成结果作废，避免退出后回写已卸载组件的状态
  buildToken++
})
</script>

<template>
  <div class="tool-page">
    <!-- 隐藏的文件选择控件放在最外层：空状态下顶部栏的「导入字体」也要能用 -->
    <input ref="input" hidden type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" @change="onFileChange" />

    <!-- 左栏：字体来源与字符集（始终显示，未就绪时也要能选来源/填系统字体名） -->
    <section class="tool-sidebar panel">
      <div class="section">
        <h2 class="section-title">字体来源</h2>
        <label class="check-row"><input v-model="state.source" type="radio" value="upload" /> 上传字体文件</label>
        <label class="check-row mt"><input v-model="state.source" type="radio" value="system" /> 使用系统字体</label>

        <template v-if="state.source === 'upload'">
          <button class="btn full" @click="input?.click()">{{ fileName ? '更换字体文件' : '选择字体文件' }}</button>
          <p v-if="fileName" class="muted mono ellipsis" :title="fileName">{{ fileName }}</p>
          <p class="muted">支持 TTF / OTF / WOFF / WOFF2，单文件 ≤ {{ Math.round(MAX_FONT_FILE_SIZE / 1024 / 1024) }}MB。上传字体跨设备表现一致，推荐优先使用。</p>
        </template>

        <template v-else>
          <label class="field">
            <span class="field-label">系统字体名</span>
            <input v-model="state.systemFamily" class="input full-input" type="text" spellcheck="false" placeholder="例如 PingFang SC / Arial" />
          </label>
          <p v-if="systemAvailable === false" class="error-text">未检测到该字体，将回落到默认无衬线字体。</p>
          <p v-else-if="systemAvailable" class="muted">已检测到该字体（不同机器安装情况可能不同）。</p>
          <p v-else class="muted">系统字体依赖本机安装，跨设备生成结果可能不一致。</p>
        </template>
      </div>

      <div class="section">
        <h2 class="section-title">字符集</h2>
        <label class="check-row"><input v-model="state.charset.ascii" type="checkbox" /> ASCII 可打印（32–126）</label>
        <label class="check-row mt"><input v-model="state.charset.latin1" type="checkbox" /> Latin-1 补充（160–255）</label>
        <label class="check-row mt"><input v-model="state.charset.digits" type="checkbox" /> 数字与常用标点</label>
        <label class="field mt">
          <span class="field-label">自定义字符</span>
          <textarea v-model="state.charset.custom" class="input textarea" spellcheck="false" rows="3" placeholder="可直接粘贴中文或任意字符"></textarea>
        </label>
        <label class="field mt">
          <span class="field-label">Unicode 范围</span>
          <input v-model="state.charset.ranges" class="input full-input mono" type="text" spellcheck="false" placeholder="4E00-4E20, 3000-303F" />
        </label>
        <p class="muted">十六进制码点，支持「起-止」与「U+」前缀，逗号或空格分隔；单次生成上限 6000 个字符。</p>
        <p v-if="charCount" class="badge badge-accent">当前 {{ charCount }} 个字符</p>
        <p v-else class="error-text">当前 0 个字符：请至少勾选一项预设，或填写自定义字符 / Unicode 范围</p>
      </div>
    </section>

    <main class="tool-main">
      <div class="tool-header">
        <div>
          <h2>位图字体工作区</h2>
          <p>{{ ready ? `${activeFamily} · ${state.sizePx}px · ${state.mode === 'sdf' ? '距离场' : '位图'}` : '上传字体文件或指定系统字体后自动生成' }}</p>
        </div>
        <div class="header-actions">
          <span v-if="state.pageCount" class="badge">{{ state.glyphCount }} 字形 · {{ state.pageCount }} 页</span>
          <button class="btn" :disabled="!ready || generating" @click="runBuild">重新生成</button>
          <!-- 空状态下也要能从这里导入，故不加 disabled -->
          <button class="btn btn-primary" @click="input?.click()">导入字体</button>
        </div>
      </div>

      <div class="tool-body">
        <div v-if="!ready" class="empty-state">
          <span class="big">Aa</span>
          <strong>还没有可用的字体</strong>
          <span>上传一份 TTF / OTF / WOFF 字体文件（≤ {{ Math.round(MAX_FONT_FILE_SIZE / 1024 / 1024) }}MB），或填写已安装的系统字体名</span>
          <div class="empty-actions">
            <button class="btn btn-primary" @click="input?.click()">选择字体文件</button>
            <button class="btn" @click="state.source = 'system'">改用系统字体</button>
          </div>
        </div>

        <template v-else>
          <section class="preview-block">
            <h3 class="faint">文本效果预览</h3>
            <textarea v-model="state.previewText" class="input preview-textarea" spellcheck="false" rows="2" placeholder="输入预览文本，支持换行"></textarea>
            <div class="preview-stage">
              <canvas ref="previewCanvas" class="preview-canvas"></canvas>
            </div>
            <p class="muted">用原始字体直接绘制；SDF 模式的实际渲染由引擎 shader 采样距离场完成，此处仅作字形对照。</p>
          </section>

          <section class="preview-block">
            <div class="preview-head">
              <h3 class="faint">图集预览（{{ state.pageUrls[state.activePage] ? `${built?.pages[state.activePage]?.width}×${built?.pages[state.activePage]?.height}` : '未生成' }}）</h3>
              <div class="preview-tools">
                <div v-if="state.pageCount > 1" class="page-tabs">
                  <button
                    v-for="index in state.pageCount"
                    :key="index"
                    class="page-tab"
                    :class="{ active: state.activePage === index - 1 }"
                    @click="state.activePage = index - 1"
                  >{{ index }}</button>
                </div>
                <div v-if="state.pageUrls[state.activePage]" class="seg zoom-seg">
                  <button
                    v-for="option in ATLAS_ZOOMS"
                    :key="String(option.value)"
                    class="seg-item"
                    :class="{ active: atlasZoom === option.value }"
                    @click="atlasZoom = option.value"
                  >{{ option.label }}</button>
                </div>
              </div>
            </div>
            <div class="preview-stage atlas-stage">
              <img
                v-if="state.pageUrls[state.activePage]"
                class="atlas-img"
                :style="atlasImgStyle"
                :src="state.pageUrls[state.activePage]"
                alt="字体图集"
                draggable="false"
              />
              <p v-else class="muted">{{ atlasPlaceholder }}</p>
            </div>
          </section>
        </template>
      </div>

      <div v-if="generating" class="loading-veil">
        <div class="loading-card">
          <span class="spinner"></span>
          <div>
            <strong>正在生成字形图集</strong>
            <p v-if="progress.total" class="muted small mono">{{ progress.done }}/{{ progress.total }}</p>
          </div>
        </div>
      </div>
    </main>

    <!-- 右栏：渲染参数与导出 -->
    <section class="tool-sidepanel panel">
      <div class="section">
        <h2 class="section-title">位图字体生成</h2>
        <p class="muted">本地处理，不上传素材</p>
      </div>

      <div class="section">
        <h2 class="section-title">渲染参数</h2>
        <div class="field-row">
          <label class="field">
            <span class="field-label">字号（px）</span>
            <input v-model.number="state.sizePx" class="input" type="number" min="6" max="256" />
          </label>
          <label class="field">
            <span class="field-label">留白（px）</span>
            <input v-model.number="state.padding" class="input" type="number" min="0" max="8" />
          </label>
        </div>
        <label class="field mt">
          <span class="field-label">字形表示</span>
          <select v-model="state.mode" class="select full-input">
            <option value="bitmap">位图（覆盖度 alpha）</option>
            <option value="sdf">SDF 距离场（单通道）</option>
          </select>
        </label>
        <label v-if="state.mode === 'sdf'" class="field mt">
          <span class="field-label">扩散半径（px）</span>
          <input v-model.number="state.sdfSpread" class="input" type="number" min="1" max="32" />
        </label>
        <p v-if="state.mode === 'sdf'" class="muted">扩散越大，缩放范围越宽但驻留伪影越明显；游戏 UI 常用 4–8px。</p>
        <p v-else class="muted">位图模式边缘最锐利，但只适合按生成字号 1:1 使用。</p>
      </div>

      <div class="section">
        <h2 class="section-title">图集尺寸</h2>
        <label class="field">
          <span class="field-label">单页最大边长</span>
          <select v-model.number="state.maxAtlasSize" class="select full-input">
            <option :value="512">512</option>
            <option :value="1024">1024</option>
            <option :value="2048">2048</option>
            <option :value="4096">4096</option>
          </select>
        </label>
        <label class="check-row mt"><input v-model="state.powerOfTwo" type="checkbox" /> 宽高取 2 的幂</label>
        <p class="muted">放不下的字形自动溢出到下一页，各页尺寸保持一致。</p>
      </div>

      <div class="section">
        <h2 class="section-title">导出</h2>
        <label class="check-row"><input v-model="state.withFnt" type="checkbox" /> BMFont 文本（.fnt）</label>
        <label class="check-row mt"><input v-model="state.withXml" type="checkbox" /> BMFont XML（.xml）</label>
        <label class="check-row mt"><input v-model="state.withJson" type="checkbox" /> JSON 元数据（.json）</label>
        <label class="field mt">
          <span class="field-label">文件名</span>
          <input v-model="state.name" class="input full-input mono" type="text" spellcheck="false" placeholder="font" />
        </label>
        <p class="muted">输出内容：图集 PNG + 勾选的元数据，统一打包为 ZIP。</p>
      </div>

      <div class="section actions">
        <button class="btn btn-primary full" :disabled="!built || exporting" @click="exportFont">
          {{ exporting ? '打包中…' : '导出字体 ZIP' }}
        </button>
        <button class="btn btn-ghost full" :disabled="!ready" @click="resetAll">重置</button>
        <p v-if="errorText" class="error-text">{{ errorText }}</p>
        <p v-else-if="warnText" class="warn">{{ warnText }}</p>
        <p v-if="infoText" class="muted small">{{ infoText }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 三栏骨架：左栏来源与字符集 + 中间预览 + 右栏参数导出 */
.tool-page { display: grid; grid-template-columns: 300px minmax(0, 1fr) 320px; height: 100%; min-height: 0; }
.tool-sidebar { border-right: 1px solid var(--border); overflow: auto; }
.tool-sidepanel { border-left: 1px solid var(--border); overflow: auto; }
.tool-main { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tool-header { height: 64px; flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; border-bottom: 1px solid var(--border); }
.tool-header h2 { margin: 0; font-size: var(--fs-head); }
.tool-header p { margin: 2px 0 0; color: var(--text-faint); }
.tool-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding: 24px; }
.header-actions { display: flex; align-items: center; gap: var(--sp-3); }
.full { width: 100%; justify-content: center; }
.full-input { width: 100%; }
.actions { display: flex; flex-direction: column; gap: var(--sp-2); }
.mt { margin-top: var(--sp-3); }
.section > p + .field, .section > .field + .field { margin-top: var(--sp-3); }
.field-row { display: flex; gap: var(--sp-3); }
.field-row .field { flex: 1; min-width: 0; }
.field-row .input { width: 100%; }
.textarea { height: auto; padding: var(--sp-2); line-height: 1.5; resize: vertical; font-family: var(--font-mono); font-size: var(--fs-caption); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.section-title + .check-row + .check-row { margin-top: var(--sp-2); }
/* 预览区：棋盘底衬托字形透明边缘 */
.preview-block { display: flex; flex-direction: column; gap: var(--sp-2); }
.preview-block h3 { margin: 0; font-size: var(--fs-caption); font-weight: 500; }
.preview-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.preview-tools { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.zoom-seg .seg-item { min-width: 34px; justify-content: center; cursor: pointer; }
.preview-textarea { height: auto; padding: var(--sp-2); line-height: 1.5; resize: vertical; }
.empty-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
.preview-stage {
  display: flex; align-items: center; justify-content: center; padding: var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--radius-s); overflow: auto;
  background-color: var(--stage);
  background-image: linear-gradient(45deg, rgb(255 255 255 / 5%) 25%, transparent 25%, transparent 75%, rgb(255 255 255 / 5%) 75%),
    linear-gradient(45deg, rgb(255 255 255 / 5%) 25%, transparent 25%, transparent 75%, rgb(255 255 255 / 5%) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 8px 8px;
}
.preview-canvas { display: block; max-width: 100%; }
.atlas-stage { min-height: 160px; }
.atlas-img { max-width: 100%; image-rendering: pixelated; }
.page-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.page-tab {
  min-width: 24px; height: 22px; padding: 0 6px;
  border: 1px solid var(--border); border-radius: var(--radius-s);
  color: var(--text-muted); font: 11px var(--font-mono);
}
.page-tab:hover { color: var(--text); background: var(--surface-hover); }
.page-tab.active { color: var(--accent-strong); background: var(--accent-dim); border-color: var(--accent-border); }
/* 加载遮罩 */
.loading-veil { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(13, 15, 19, 0.55); }
.loading-card { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-5) var(--sp-6); border: 1px solid var(--border-strong); border-radius: var(--radius-m); background: var(--surface); box-shadow: var(--shadow-pop); }
.loading-card strong { font-size: var(--fs-body); }
.loading-card p { margin: 2px 0 0; }
.spinner { width: 22px; height: 22px; flex: none; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.error-text { color: var(--danger, #e8463a); font-size: var(--fs-caption); }
@media (max-width: 1280px) {
  .tool-page { grid-template-columns: 260px minmax(0, 1fr) 290px; }
}
</style>