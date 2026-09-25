/**
 * 模型资源持久缓存 Service Worker。
 *
 * 背景：ISNet（@imgly/background-removal）与 transformers.js 都直接 fetch 远端权重，
 * 只依赖浏览器 HTTP 缓存，刷新页面是否重新下载并不可控。这里把模型文件写入
 * Cache Storage，之后命中缓存直接返回，做到「下载一次后不再重下」。
 *
 * 只处理模型资源：已知模型域名下的请求，或路径以 .onnx/.wasm/.data/.bin 结尾的请求。
 * 其余请求（含本站的 JS/CSS）原样放行，不影响开发时的热更新。
 *
 * 注意：ONNX 会话本身在页面内存里，刷新后无论如何都要重新初始化；
 * 本 Worker 消除的是「重新下载权重」，不是「重新加载到内存」。
 */
const CACHE_NAME = 'atlas-slice-models-v1'
const CACHE_PREFIX = 'atlas-slice-models-'

/** 已知的模型托管域名，子域一并命中（如 cdn-lfs.huggingface.co） */
const MODEL_HOSTS = ['staticimgly.com', 'huggingface.co', 'hf.co', 'hf-mirror.com']
/** 兜底判据：兼容用户在「资源地址」里填的自定义镜像 */
const MODEL_FILE_RE = /\.(onnx|wasm|data|bin)$/i
/**
 * imgly 的权重不是单个大文件：resources.json 把它切成约 4MB 的分片，
 * 分片是 content-addressed 的（文件名就是 hash，且没有扩展名），
 * 例如公共镜像 /registry.npmmirror.com/.../files/dist/<sha256>。
 * 这类分片只能靠文件名形态识别，否则自定义镜像下的权重完全不会被缓存。
 */
const CHUNK_HASH_RE = /^[0-9a-f]{32,128}$/i

function isModelRequest(url) {
  const host = url.hostname.toLowerCase()
  if (MODEL_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true
  if (MODEL_FILE_RE.test(url.pathname) || url.pathname.endsWith('/resources.json')) return true
  return CHUNK_HASH_RE.test(url.pathname.slice(url.pathname.lastIndexOf('/') + 1))
}

/** 命中缓存直接返回；未命中则请求网络并异步写入缓存 */
async function fromCacheOrNetwork(event) {
  const request = event.request
  let cache = null
  try {
    cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(request, { ignoreVary: true })
    if (cached) return cached
  } catch (error) {
    // 缓存不可用（隐私模式、配额异常等）时退化为直连：
    // 缓存层只做加速，绝不能因为它让模型加载失败
    console.warn('[模型缓存] 读取缓存失败，改为直连', request.url, error)
    cache = null
  }
  const response = await fetch(request)
  if (cache && response.status === 200) {
    // 只缓存完整的 200：206 是分段响应，错误页缓存下来会让后续加载一直失败。
    // 写入失败（多为配额不足）只丢缓存，不影响本次响应
    event.waitUntil(
      cache.put(request, response.clone()).catch((error) => {
        console.warn('[模型缓存] 写入缓存失败，本次仍按网络结果返回', request.url, error)
      }),
    )
  }
  return response
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(
      names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)),
    )
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  // Range 请求本身不是完整文件，缓存下来会污染后续的整文件读取
  if (request.headers.has('range')) return
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  if (!isModelRequest(url)) return
  event.respondWith(fromCacheOrNetwork(event))
})
