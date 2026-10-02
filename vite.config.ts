import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

/**
 * 统一模型目录的静态供给：把浏览器对 `/models/*` 的请求映射到仓库根下的 `models/`。
 * 模型权重已从 public/models 移出，这里读盘直接回文件；缺失返回 404，避免把首页 HTML 当模型解析。
 */
function modelFilesPlugin() {
  const modelsRoot = fileURLToPath(new URL('./models/', import.meta.url))
  const MIME: Record<string, string> = {
    '.json': 'application/json',
    '.onnx': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.bin': 'application/octet-stream',
    '.data': 'application/octet-stream',
    '.pt': 'application/octet-stream',
    '.js': 'text/javascript',
  }
  return {
    name: 'model-files',
    configureServer(server: {
      middlewares: { use: (handler: (req: { url?: string; method?: string }, res: {
        statusCode: number
        setHeader: (name: string, value: string) => void
        end: () => void
      }, next: () => void) => void) => void }
    }) {
      server.middlewares.use((request, response, next) => {
        const url = decodeURIComponent(request.url?.split('?')[0] ?? '')
        if (!url.startsWith('/models/')) {
          next()
          return
        }
        const filePath = join(modelsRoot, url.slice('/models/'.length))
        if (!normalize(filePath).startsWith(normalize(modelsRoot))) {
          response.statusCode = 403
          response.end()
          return
        }
        if (!existsSync(filePath)) {
          response.statusCode = 404
          response.end()
          return
        }
        const size = statSync(filePath).size
        response.statusCode = 200
        response.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
        response.setHeader('Content-Length', String(size))
        response.setHeader('Cache-Control', 'no-cache')
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        createReadStream(filePath).pipe(response as unknown as NodeJS.WritableStream)
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), modelFilesPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    watch: {
      // 本地 Python 虚拟环境与模型权重（数 GB）在项目根附近，直接排除，避免拖慢 HMR
      ignored: ['**/backend/**', '**/models/**'],
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
