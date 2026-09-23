import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // dev 环境将 hf-mirror 模型请求转发到国内镜像，规避浏览器直连外网限制
      // 前缀用 /hf-mirror2：与旧 /hf-mirror 缓存隔离，避免命中陈旧缓存（调试期遗留）
      '/hf-mirror2': {
        target: 'https://hf-mirror.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hf-mirror2/, ''),
        configure: (proxy) => {
          // hf-mirror 检测到浏览器 Referer 会返回"警告"页面，转发前剥离浏览器上下文头
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('referer')
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('sec-fetch-mode')
            proxyReq.removeHeader('sec-fetch-site')
            proxyReq.removeHeader('sec-fetch-dest')
          })
          // 禁止缓存模型响应，避免浏览器 HTTP 缓存命中旧 HTML
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-store, must-revalidate'
          })
          // hf-mirror 返回的重定向 Location 是相对路径（或 hf-mirror.com 绝对路径），
          // 补回 /hf-mirror2 前缀，保证浏览器后续请求继续走本代理
          proxy.on('proxyRes', (proxyRes) => {
            const location = proxyRes.headers['location']
            if (!location) return
            if (location.startsWith('/')) {
              proxyRes.headers['location'] = '/hf-mirror2' + location
            } else if (location.includes('hf-mirror.com')) {
              proxyRes.headers['location'] = '/hf-mirror2' + new URL(location).pathname
            }
          })
        },
      },
    },
  },
})
