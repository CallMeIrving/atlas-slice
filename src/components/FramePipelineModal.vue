<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { frameBaseUrl, persistMediaSettings, workspace } from '@/store/workspace'
import { captureFrame, createCancelToken, extractOptionsFrom, extractRangeError, seekTo, type CancelToken } from '@/core/frame-extract'
import { describeMattingError, AI_ENGINES } from '@/core/ai-matting'
import { runFramePipeline, type PipelineProgress } from '@/core/frame-pipeline'
import type { ImageCropRect } from '@/core/crop'
import { ensureMatteModelLoaded, matteModelKey, modelStateLabel, modelStatus, type ModelEngine } from '@/store/model-status'
import ExtractSettingsFields from '@/components/ExtractSettingsFields.vue'
import MatteSettingsFields from '@/components/MatteSettingsFields.vue'
import FrameCropEditor from '@/components/FrameCropEditor.vue'
import FramePreviewPlayer from '@/components/FramePreviewPlayer.vue'
import FrameExportActions from '@/components/FrameExportActions.vue'
import TaskProgress from '@/components/TaskProgress.vue'

/**
 * 一键处理弹窗。
 * 按 抽帧 → 裁切 → 抠图 顺序配置并执行：裁切与抠图各自带启停勾选框，未勾选即跳过；
 * 抠图默认使用 AI 模型，执行前先确保模型加载完成；结束后在弹窗内预览与导出。
 * 所有单步逻辑都来自 core 模块，本组件只做配置与编排。
 */
const props = defineProps<{ video: HTMLVideoElement | null }>()
const emit = defineEmits<{ close: [] }>()

const pipeline = workspace.video.pipeline
/** 弹窗内容区，处理结束后用于滚动到底部 */
const body = ref<HTMLElement>()
/** 本会话内是否已跑过一次流水线，用于把主按钮文案改成「再次处理」 */
const ranOnce = ref(false)
/** 裁切区域：由 FrameCropEditor 双向绑定，变化后写回 pipeline 配置 */
const cropRect = ref<ImageCropRect>({ ...(pipeline.crop ?? { x: 0, y: 0, width: 0, height: 0 }) })
/** 裁切预览源：优先用已有帧，没有帧时从视频探测一帧（不写入帧列表） */
const cropSource = ref('')
const previewId = ref<string | null>(null)
const running = ref(false)
/** 已点击开始、正在加载模型（此时尚未抽帧，但仍允许取消） */
const preparing = ref(false)
/** 已请求取消，等待当前步骤收尾 */
const cancelling = ref(false)
const finished = ref(false)
const done = ref(0)
const total = ref(0)
const text = ref('')
const percent = ref(-1)
const errorText = ref('')
let token: CancelToken = createCancelToken()

const extractOptions = computed(() => extractOptionsFrom(workspace.video))
const rangeError = computed(() => extractRangeError(extractOptions.value, workspace.video.duration, Boolean(workspace.video.sourceUrl)))
/** 抠图引擎：纯色算法不需要模型，返回 null */
const matteEngine = computed<ModelEngine | null>(() => (workspace.video.matte.mode === 'solid' ? null : (workspace.video.matte.mode as ModelEngine)))
const needsModel = computed(() => pipeline.matteEnabled && matteEngine.value !== null)
const modelKey = computed(() => (matteEngine.value ? matteModelKey(matteEngine.value) : ''))
const modelState = computed(() => (modelKey.value ? (modelStatus[modelKey.value]?.state ?? 'unknown') : 'unknown'))
const modelLabel = computed(() => AI_ENGINES.find((engine) => engine.key === matteEngine.value)?.label ?? 'AI 模型')
/** 有效的裁切区域：勾选裁切但没有框选到有效区域时视为跳过 */
const validCrop = computed<ImageCropRect | null>(() => (pipeline.cropEnabled && cropRect.value.width > 0 && cropRect.value.height > 0 ? cropRect.value : null))
const cropMissing = computed(() => pipeline.cropEnabled && !validCrop.value)
const zipName = computed(() => `${workspace.video.fileName.replace(/\.[^.]+$/, '') || 'video'}-frames.zip`)

/** 主按钮文案：跑过一次后改为「再次处理」；模型未加载时提示会先加载模型 */
const startLabel = computed(() => {
  const ready = !needsModel.value || modelState.value === 'ready'
  if (!ranOnce.value) return ready ? '开始一键处理' : '加载模型并开始处理'
  return ready ? '再次处理' : '加载模型并再次处理'
})
/** 是否有任务在进行（含仅加载模型阶段）：进行中才能取消 */
const busy = computed(() => running.value || preparing.value)
const startDisabled = computed(() => busy.value || cancelling.value || !props.video || !workspace.video.sourceUrl || Boolean(rangeError.value) || cropMissing.value)
const taskText = computed(() => {
  if (cancelling.value) return '正在取消…'
  if (preparing.value) return workspace.matte.aiStatus || '加载模型中…'
  return text.value || '尚未开始'
})
const taskPercent = computed(() => (running.value ? percent.value : preparing.value ? workspace.matte.aiProgress : percent.value))
const taskError = computed(() => {
  if (errorText.value) return errorText.value
  if (modelState.value !== 'error') return ''
  const message = modelStatus[modelKey.value]?.message
  return message ? describeMattingError(message, workspace.video.matte.mode) : '模型加载失败'
})

/** 准备裁切预览源：优先复用已有帧，没有帧时用当前抽帧参数在起始时间探测一帧 */
async function prepareCropSource(): Promise<void> {
  if (cropSource.value) return
  const first = workspace.video.frames[0]
  if (first) {
    cropSource.value = frameBaseUrl(first)
    return
  }
  const element = props.video
  if (!element) return
  try {
    element.pause()
    const options = extractOptions.value
    await seekTo(element, options.start)
    cropSource.value = captureFrame(element, options.start, options).url
  } catch {
    errorText.value = '裁切预览取样失败，可先执行一次抽帧再框选区域'
  }
}

/**
 * 预加载抠图模型；状态由共享 store 管理，与「抠图」页看到的是同一份。
 * @returns 是否已就绪（纯色算法无需模型，直接视为就绪）
 */
async function preloadModel(): Promise<boolean> {
  const engine = matteEngine.value
  if (!engine) return true
  workspace.matte.aiStatus = '准备模型…'
  workspace.matte.aiProgress = -1
  try {
    await ensureMatteModelLoaded(engine, (progress) => {
      workspace.matte.aiStatus = progress.text
      workspace.matte.aiProgress = progress.percent ?? -1
    })
    workspace.matte.aiStatus = '模型已加载，可直接开始处理'
    return true
  } catch (error) {
    workspace.matte.aiStatus = describeMattingError(error, workspace.video.matte.mode)
    return false
  } finally {
    workspace.matte.aiProgress = -1
  }
}

/** 请求取消：置位令牌后各步骤会在当前帧处理完退出并保留已完成结果，重复点击无效 */
function cancel(): void {
  if (cancelling.value) return
  cancelling.value = true
  token.cancelled = true
}

/** 执行一键处理：先确保模型加载完成，再按 抽帧 → 裁切 → 抠图 顺序执行 */
async function start(): Promise<void> {
  const element = props.video
  if (!element || busy.value) return
  errorText.value = ''
  finished.value = false
  // 令牌先于模型加载创建：加载期间点取消或关闭弹窗也能阻止后续流水线启动
  token = createCancelToken()
  cancelling.value = false
  if (needsModel.value) {
    preparing.value = true
    const loaded = await preloadModel()
    preparing.value = false
    if (token.cancelled) { text.value = '已取消，未开始处理'; return }
    if (!loaded) { errorText.value = workspace.matte.aiStatus || '模型加载失败，无法执行抠图'; return }
  }
  running.value = true
  ranOnce.value = true
  done.value = 0
  total.value = 0
  text.value = '准备中…'
  percent.value = 0
  // 每次都从原始视频重新抽帧，因此先清空旧帧，避免在已抠图/已裁切的画面上二次处理
  workspace.video.frames.forEach((frame) => URL.revokeObjectURL(frame.url))
  workspace.video.frames = []
  workspace.video.error = ''
  workspace.video.status = 'processing'
  previewId.value = null
  const frames = workspace.video.frames
  const result = await runFramePipeline(
    element,
    {
      extract: extractOptions.value,
      crop: validCrop.value,
      matte: pipeline.matteEnabled ? { settings: workspace.video.matte, ai: workspace.matte } : null,
    },
    {
      frames,
      token,
      onProgress: (progress: PipelineProgress) => {
        done.value = progress.done
        total.value = progress.total
        text.value = progress.text
        percent.value = progress.percent
      },
    },
  )
  running.value = false
  cancelling.value = false
  if (result.error) {
    errorText.value = describeMattingError(result.error, workspace.video.matte.mode)
    workspace.video.error = errorText.value
    workspace.video.status = 'error'
    return
  }
  workspace.video.status = 'done'
  finished.value = true
  text.value = result.cancelled ? `已取消，已保留 ${frames.length} 帧` : `处理完成，共 ${frames.length} 帧`
  // 全部步骤（含抠图）跑完后滚到底部，让结果预览与导出直接进入视野
  scrollToBottom()
}

/** 把弹窗内容区滚动到底部；等结果区渲染完成后再滚，避免高度还没算出来 */
function scrollToBottom(): void {
  void nextTick(() => {
    const element = body.value
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  })
}

/** 关闭弹窗：模型加载或流水线执行中关闭会先请求取消，避免关闭后仍在后台跑完 */
function close(): void {
  if (busy.value) cancel()
  emit('close')
}

// 配置变化后写回 pipeline.crop 并持久化：裁切区域、两个步骤开关与抠图设置可改的字段都在这里
watch(
  () => [cropRect.value, pipeline.cropEnabled, pipeline.matteEnabled, workspace.video.matte, workspace.matte.aiDevice, workspace.matte.aiDtype, workspace.matte.aiModelHost, workspace.matte.aiMaxSide] as const,
  () => {
    pipeline.crop = cropRect.value.width > 0 && cropRect.value.height > 0 ? { ...cropRect.value } : null
    persistMediaSettings()
  },
  { deep: true },
)

// 勾选裁切且尚无预览源时，取一帧作为框选样板
watch(() => pipeline.cropEnabled, (enabled) => { if (enabled) void prepareCropSource() })

onMounted(() => { if (pipeline.cropEnabled) void prepareCropSource() })
</script>

<template>
  <div class="modal-backdrop" @click.self="close">
    <section class="modal pipeline-modal" role="dialog" aria-modal="true" aria-labelledby="frame-pipeline-title">
      <div class="modal-head">
        <div>
          <h2 id="frame-pipeline-title">一键处理</h2>
          <p class="faint">按 抽帧 → 裁切 → 抠图 顺序执行，未勾选的步骤自动跳过，结果写入同一个帧列表</p>
        </div>
        <button class="btn-icon modal-close" aria-label="关闭" @click="close">×</button>
      </div>
      <div ref="body" class="modal-body">
        <section class="step">
          <h3 class="step-title"><span class="step-no">1</span>抽帧 <span class="badge badge-accent">必选</span></h3>
          <ExtractSettingsFields />
        </section>

        <section class="step">
          <h3 class="step-title">
            <label class="check-row"><input v-model="pipeline.cropEnabled" type="checkbox" /><span class="step-no">2</span>裁切</label>
            <span class="faint">勾选后按同一区域裁切全部帧，未勾选则跳过</span>
          </h3>
          <template v-if="pipeline.cropEnabled">
            <FrameCropEditor v-model="cropRect" :source-url="cropSource" />
            <p v-if="cropMissing" class="step-warn">请先在上方框选有效的裁切区域</p>
          </template>
          <p v-else class="faint step-skip">已跳过裁切步骤</p>
        </section>

        <section class="step">
          <h3 class="step-title">
            <label class="check-row"><input v-model="pipeline.matteEnabled" type="checkbox" /><span class="step-no">3</span>抠图</label>
            <span class="faint">默认使用 AI 模型（ISNet），可切回纯色背景算法</span>
          </h3>
          <template v-if="pipeline.matteEnabled">
            <MatteSettingsFields />
            <div v-if="needsModel" class="model-row">
              <span>{{ modelLabel }} · {{ modelStateLabel(modelState) }}</span>
              <button class="btn" :disabled="modelState === 'loading' || modelState === 'ready'" @click="preloadModel">预加载模型</button>
            </div>
            <p v-if="needsModel" class="faint step-help">
              执行前会先确保模型加载完成。权重按「抠图方式 + 模型精度 + 推理设备 + 资源地址」分别缓存，
              其中任一项变了就是另一份权重，需要单独下载一次；同一组合只需下载一次，之后由 Service Worker 缓存复用。
            </p>
          </template>
          <p v-else class="faint step-skip">已跳过抠图步骤</p>
        </section>

        <section class="step">
          <h3 class="step-title">执行</h3>
          <TaskProgress
            :running="busy"
            :done="done"
            :total="total"
            :text="taskText"
            :percent="taskPercent"
            :error="taskError"
            :cancelling="cancelling"
            @cancel="cancel"
          />
        </section>

        <section v-if="finished && workspace.video.frames.length" class="step">
          <h3 class="step-title">结果预览与导出 <span class="badge">{{ workspace.video.frames.length }} 帧</span></h3>
          <div class="result-preview"><FramePreviewPlayer v-model:current-id="previewId" :frames="workspace.video.frames" /></div>
          <div class="result-actions">
            <FrameExportActions :frames="workspace.video.frames" :current-id="previewId" :zip-name="zipName" />
          </div>
        </section>
      </div>
      <div class="modal-foot">
        <span class="foot-spacer"></span>
        <button class="btn" @click="close">关闭</button>
        <button v-if="busy" class="btn btn-danger" :disabled="cancelling" @click="cancel">
          {{ cancelling ? '取消中…' : running ? `取消（${done}/${total}）` : '取消加载' }}
        </button>
        <button v-else class="btn btn-primary" :disabled="startDisabled" @click="start">{{ startLabel }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pipeline-modal {
  width: min(960px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
}

.pipeline-modal .modal-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

.step {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--border);
}

.step:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.step-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--fs-head);
}

.step-title .faint {
  font-size: var(--fs-caption);
}

.step-no {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-dim);
  color: var(--accent-strong);
  font: 600 12px/1 var(--font-mono);
}

.step-skip {
  margin: 0;
}

.step-warn {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
}

.step-help {
  margin: 0;
  line-height: 1.5;
}

.model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  color: var(--text-muted);
}

.result-preview {
  height: 260px;
  display: flex;
  min-height: 0;
}

.result-actions {
  display: flex;
  gap: var(--sp-2);
  justify-content: flex-end;
}

.foot-spacer {
  flex: 1;
}
</style>