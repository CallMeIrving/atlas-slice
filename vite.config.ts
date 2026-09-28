import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

function modelAssetNotFoundPlugin() {
  const publicRoot = fileURLToPath(new URL('./public/', import.meta.url))
  return {
    name: 'model-asset-not-found',
    configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: { statusCode: number; end: () => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0] ?? ''
        if (!pathname.startsWith('/models/')) {
          next()
          return
        }
        const filePath = normalize(join(publicRoot, pathname.slice('/'.length)))
        if (!filePath.startsWith(publicRoot) || existsSync(filePath)) {
          next()
          return
        }
        response.statusCode = 404
        response.end()
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), modelAssetNotFoundPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    watch: {
      // 本地 Python 服务的权重有数 GB，放在项目根下会拖慢 HMR，直接排除
      ignored: ['**/server/**'],
    },
    proxy: {
      // dev 环境把图层拆分请求转发到本机 Python 服务，前端用相对路径 → 零 CORS 预检
      '/layer-api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/layer-api/, ''),
      },
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
