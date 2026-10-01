---
name: vite-browser-selftest
description: 在本项目中用临时自测页加 Vite 服务加浏览器自动化，验证纯前端逻辑（Web Audio、WASM 编码、Vue store 与组件端到端行为）。当需要真实浏览器运行环境、node 自测无法覆盖时使用；纯函数直接用 node/esbuild 验证，不要用本流程做永久测试
---

# Vite 临时自测页浏览器验证

本项目的纯前端音频/媒体逻辑（Web Audio 解码、wasm-media-encoders、Vue store 编排、组件交互）无法靠类型检查或 node 单测确认。用一套**临时自测页**在真实浏览器里跑真实代码，验完立即删除。

## 何时用 / 何时不用

- 用：`decodeAudioData`、WASM 懒加载编码器、AudioContext/自动播放策略、真实 File 导入、store 与真实 Vue 组件的联动、拖拽等只有浏览器才有的行为。
- 不用：与 DOM 无关的纯函数（DSP、PCM 封装、文件头解析、算法）——直接 `node` 或 esbuild 跑断言更快。
- 不用：需要长期保留进 CI 的测试。临时文件必须删除，不要留下第二个测试体系。

## 文件约定

在**仓库根目录**建 HTML、在 `src/` 建入口，统一双下划线前缀，便于识别与清理：

- `__<name>.html`（根目录，Vite 直接服务并按入口转译 TS）
- `src/__<name>.ts`（从 store / components / core 正常 `@/` 或相对路径导入真实代码）

页面只需要三样东西：一个真实按钮、一个结果面板、一个 module script：

```html
<button id="run">开始自测</button>
<pre id="uiresult">idle</pre>
<script type="module" src="/src/__<name>.ts"></script>
```

自测脚本固定结构：

```ts
const lines: string[] = []
const panel = document.getElementById('uiresult') as HTMLPreElement
function check(name: string, ok: boolean, detail = ''): void {
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  panel.textContent = lines.join('\n')
}
async function run(): Promise<void> {
  // ……逐条 check
  const p = lines.filter((l) => l.startsWith('PASS')).length
  const f = lines.filter((l) => l.startsWith('FAIL')).length
  lines.push(`\n完成：${p} 通过 / ${f} 失败`)
  panel.textContent = lines.join('\n')
}
document.getElementById('run')?.addEventListener('click', () => {
  void run().catch((error) => {
    lines.push(`ERROR ${error instanceof Error ? error.message : String(error)}`)
    panel.textContent = lines.join('\n')
  })
})
```

## 关键约束（都是踩过的坑）

1. **必须让浏览器自动化真实点击「开始自测」按钮**。Chromium 拦截无用户激活的 `play()` / AudioContext 启动（sticky activation），脚本直接跑会被 autoplay 策略打断；点击后再执行全部用例。
2. **无法操作 `<input type=file>`**。需要文件时，自测脚本里 `fetch('/assets/...')` 拉 `public/` 下的测试资源再 `new File([buf], name, { type })`。缺资源就先生成（Node 脚本、系统 `afconvert`、wasm-media-encoders 均可），产物可留在 `public/assets/...`，生成脚本本身删除。
3. **挂真实 Vue 组件**时用 `createApp(Comp).mount(host)`，宿主离屏但要给出足够尺寸：本站最低宽度 1400px，宿主宽度不足会导致布局类断言失效。涉及 DOM 更新的断言前先 `await nextTick()`。
4. **音频时长等断言留编码容差**（如 ±0.2s），MP3/AAC 有编码器延迟；浮点波形不要 `===` 精确比较。
5. **失败先分辨是测试写错还是实现 bug**。例如互斥协调器类用例：「新认领方的回调被调用」与「上一个持有者被叫停」方向相反，断言写反是测试缺陷，不要回头改实现。

## 执行步骤

1. 写好两个临时文件；先跑 `npx vue-tsc -b` 确认编译通过。编辑器里 `Cannot find module '@/...'` 之类多半是 Vite 别名索引滞后的假报错，以 vue-tsc 退出码为准。
2. 后台起独立端口服务：`npx vite --port 5199 --strictPort`（不要占用正常开发的 5173，避免与用户页面混淆），`curl -s -o /dev/null -w "%{http_code}" http://localhost:5199/__<name>.html` 确认 200。
3. 调用 browser_use 子代理，指令必须具体：打开该 URL → **硬刷新**（避免旧模块缓存，尤其改过动态 import 的代码）→ 点击「开始自测」→ 轮询 `#uiresult` 直到出现「完成：」或「ERROR」→ **逐字回报整个 pre 的文本**（不要让它总结，总结会吞掉 FAIL 行）→ 同时报告 console 错误。
4. 若有 FAIL 但摘要不完整，再发一次浏览器指令，只读取含 `FAIL` 的行原文。
5. 修复实现或测试后，必要时回到第 1 步重跑，直到全绿。

## 收尾（不可省略）

1. 删除 `__<name>.html` 与 `src/__<name>.ts`（用 DeleteFile，不要只从磁盘 rm 后忘记确认）。
2. StopCommand 停掉 5199 后台服务。
3. 确认仓库里没有 `__` 临时文件残留。
4. 跑 `npx vue-tsc -b && pnpm build` 做最终确认。
5. 向用户汇报每条关键用例的实测结果与真实文件来源。
