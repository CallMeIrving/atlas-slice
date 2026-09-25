import { createApp } from 'vue'
import App from './App.vue'
import '@/styles/tokens.css'
import '@/styles/base.css'

createApp(App).mount('#app')

// 注册模型缓存 Worker：把 ISNet / RMBG 的权重写进 Cache Storage，下载一次后刷新不再重下。
// 只拦截模型资源，失败时静默跳过，不影响应用本身（见 public/model-cache-sw.js）。
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/model-cache-sw.js').catch((error) => {
      console.warn('[模型缓存] Service Worker 注册失败，模型仍可加载但会重复下载', error)
    })
  })
}
