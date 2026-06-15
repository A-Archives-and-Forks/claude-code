# 第一章：Code Splitting 不是优化，是生存需求

> 17MB 单文件让 Bun/JSC 暴食 1GB 内存，分割成 600+ chunks 才降到 35MB。

## JSC 的贪婪解析 vs V8 懒解析：一场 5 倍的内存鸿沟

打开 `vite.config.ts:94`，你会看到一段与代码看起来无关、却写满血泪的注释：

```
// Code splitting: Bun/JSC parses the entire single-file bundle eagerly,
// consuming ~1 GB RSS for a 17 MB output (vs ~220 MB on Node/V8 which
// lazy-parses). Splitting into chunks allows Bun to load modules on demand,
// bringing RSS down to ~300 MB.
```

这段注释不是工程美学，而是测出来的生存数据。把同一个项目两种构建方式分别跑一次 `claude --version`：

- 单文件 17MB 产物 + Bun/JSC：RSS 暴涨到约 1GB
- 同样 17MB 产物 + Node/V8：RSS 只有约 220MB
- 切成 600+ chunks + Bun/JSC：`--version` 的 RSS 从 966MB 骤降到 35MB

为什么差这么多？因为 JavaScriptCore（Bun 的 JS 引擎）和 V8（Node 的引擎）对"一个函数被 import 但还没被调用"的假设完全相反：

- **V8 假设你大概率不会立刻执行它**，所以只做懒解析（lazy parsing）—— 函数体在第一次被调用时才完整解析、编译成字节码。17MB 的 bundle 里 90% 的函数是死代码（启动路径根本不会走到），V8 几乎不为它们付钱。
- **JSC 假设你大概率会立刻执行它**，于是对整个 bundle 做 eager parsing + bytecode 编译 + JIT。17MB 里每一个函数、每一个闭包、每一个 `_c()` 调用都被即时编译成机器码塞进 RSS。死代码和活代码付同样的代价。

反事实推演：如果项目坚持单文件输出会怎样？`claude --version` 会消耗近 1GB 内存——一个本该 50ms 返回版本号的命令，会让用户怀疑 CLI 在偷偷挖矿。这种启动代价直接杀死了工具。

所以"为什么必须 code splitting"的答案不是"分包更优雅"，而是"JSC 的内存模型逼我们切割"。一旦切到 chunks 级别，JSC 的按需加载优势就回来了：Bun 只解析 `cli.js` 入口真正 import 的那些 chunk，其他 chunk 在被 import 之前完全不进内存。

## 双构建管线：Bun.build vs Vite，为什么不能合并

项目里同时存在 `build.ts`（用 `Bun.build()`）和 `vite.config.ts`（用 Rollup），两条链路做的事情高度重叠：都接收 `src/entrypoints/cli.tsx` 作为入口、都启用代码分割、都把 chunks 输出到 `dist/`。

打开 `build.ts:23`，你会看到 Bun 原生构建的全部代码分割配置只有一行：

```ts
const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir,
  target: 'bun',
  splitting: true,
  sourcemap: 'linked',
  define: {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features,
})
```

`splitting: true` 是 Bun 的原生 code splitting 开关。产物落在 `dist/` 根目录下，每个 chunk 是平铺的 `.js` 文件。

而 Vite 那条链路（`vite.config.ts:91` 的 `rollupOptions`）输出布局完全不同：

```ts
output: {
  format: 'es',
  entryFileNames: 'cli.js',
  chunkFileNames: 'chunks/[name]-[hash].js',
},
```

入口固定是 `dist/cli.js`，所有 chunk 被集中扔进 `dist/chunks/` 子目录。这种布局差异不是审美分歧，而是两条链路要服务不同目的：

- **Bun.build** 是默认开发链路，产物给 Bun 运行时执行。
- **Vite 链路** 服务于更深度的场景——它需要 `featureFlagsPlugin()`（feature flag 在 transform 阶段替换为字面量，见第五章）、`importMetaRequirePlugin()`（Node.js 兼容补丁）、`.md`/`.txt`/`.html`/`.css` 作为 raw 字符串加载（模拟 Bun 的 text loader 行为，对应 `vite.config.ts:43` 的 `rawAssetPlugin`），以及 `dedupe: ['react', 'react-reconciler', 'react-compiler-runtime']`（保证工作区里只有一份 React，否则两份 reconciler 会让 Ink 渲染器崩掉）。

为什么不直接弃用 Bun.build？因为 Bun 原生构建是最快的开发回路，开发者每次 `bun run build` 不想等 Vite + Rollup 全套 transpile。两条链路在工程上分工明确：Bun.build 是 quick path，Vite 是 production-grade path。

## post-build 阶段：为什么必须 patch `globalThis.Bun` 解构

打开 `build.ts:62`，你会看到构建完成后还要跑一段第二轮补丁：

```ts
// Also patch unguarded globalThis.Bun destructuring from third-party deps
// (e.g. @anthropic-ai/sandbox-runtime) so Node.js doesn't crash at import time.
let bunPatched = 0
const BUN_DESTRUCTURE = /var \{([^}]+)\} = globalThis\.Bun;?/g
const BUN_DESTRUCTURE_SAFE =
  'var {$1} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};'
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (BUN_DESTRUCTURE.test(content)) {
    await writeFile(
      filePath,
      content.replace(BUN_DESTRUCTURE, BUN_DESTRUCTURE_SAFE),
    )
    bunPatched++
  }
}
```

这段正则补丁把 `var {x, y} = globalThis.Bun;` 改写成 `var {x, y} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};`。

为什么要这么做？因为 `@anthropic-ai/sandbox-runtime` 这类第三方依赖在源码里直接 `var {...} = globalThis.Bun;` 解构 Bun 全局对象。在 Bun 运行时下这没事，`globalThis.Bun` 永远存在。但如果用户用 `node dist/cli.js` 启动同一个产物，`globalThis.Bun` 是 `undefined`，对 `undefined` 做解构会立刻抛 `TypeError: Cannot destructure property 'x' of 'globalThis.Bun' as it is undefined`，整个 CLI 启动失败。

补丁的策略是后处理：扫描所有产物文件（包括 `dist/` 平铺文件 + `dist/chunks/` 子目录文件——Vite 链路对应 `scripts/post-build.ts:38` 的第二步扫描），把无保护的解构全部转成带 `typeof` 守卫的版本。这是一种"产物级兼容"——上游源码不改一行，靠后处理把跨运行时兼容性焊死在产物里。

反事实推演：如果不打这个补丁，产物就只能用 `bun` 跑、不能用 `node` 跑，"双入口"承诺（见下一节）直接作废。这恰恰解释了为什么 `build.ts:43` 处理完 `import.meta.require` 之后，紧接着在 `build.ts:62` 处理 `globalThis.Bun` 解构——这两段都是为了让同一份产物同时活在两个运行时里。

## 构建产物同时兼容 bun/node：双入口与 `import.meta.require` 探测

打开 `build.ts:43`，你会看到第一轮补丁：

```ts
const IMPORT_META_REQUIRE = 'var __require = import.meta.require;'
const COMPAT_REQUIRE = `var __require = typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url);`
```

Bun 把 `import.meta.require` 当作一等公民——它是 Bun 内置的同步 `require`。但 Node.js 不认这个 API。所以补丁把无脑访问替换成运行时探测：在 Bun 下走 `import.meta.require`，在 Node 下退到 `(await import("module")).createRequire(import.meta.url)`，靠 `createRequire` 桥接 CommonJS。

补丁完成后，`build.ts:95` 会生成两个可执行入口：

```ts
const cliBun = join(outdir, 'cli-bun.js')
const cliNode = join(outdir, 'cli-node.js')

await writeFile(cliBun, '#!/usr/bin/env bun\nimport "./cli.js"\n')
await writeFile(cliNode, '#!/usr/bin/env node\nimport "./cli.js"\n')

const { chmodSync } = await import('fs')
chmodSync(cliBun, 0o755)
chmodSync(cliNode, 0o755)
```

两个文件的唯一区别是 shebang——一个声明 `#!/usr/bin/env bun`、一个声明 `#!/usr/bin/env node`。两者都 `import "./cli.js"`，加载同一份主产物。

为什么必须保留双入口？因为部署环境五花八门：

- 一些 CI 容器只装了 Node.js
- 一些用户的开发机偏好 Bun 的启动速度
- 一些 Docker 镜像为了体积只装 Node.js

如果只发一个 `bun` 入口，Node 用户就用不了；如果只发 `node` 入口，Bun 用户拿不到 `import.meta.require` 的性能优势。双入口让同一份 `dist/cli.js` 适配两种部署，唯一的代价是 96 字节的额外文件。

注意 `build.ts:95` 这段写入的产物是 Bun.build 链路的；Vite 链路对应 `scripts/post-build.ts:71`，逻辑完全镜像——同样的 shebang 写入、同样的 chmod 0o755、同样的 `import "./cli.js"`。两条链路都必须各自生成双入口，因为它们各自产出的 `dist/cli.js` 不能交叉引用。

## distRoot.ts：让 chunk 文件在任何深度都能找到 vendor 二进制

打开 `src/utils/distRoot.ts:15`，你会看到一个被反复使用的 `distRoot` 函数：

```ts
const distRoot = (() => {
  const parts = __dirname.split(path.sep)
  const distIdx = parts.lastIndexOf('dist')
  if (distIdx !== -1) {
    return parts.slice(0, distIdx + 1).join(path.sep)
  }
  // Dev mode: from src/utils/ → project root
  const srcIdx = parts.lastIndexOf('src')
  if (srcIdx !== -1) {
    return parts.slice(0, srcIdx).join(path.sep)
  }
  return __dirname
})()
```

这段代码用 `lastIndexOf('dist')` 在 `__dirname` 里倒着找 `dist` 目录，找到就返回那个目录的绝对路径；找不到再找 `src`（dev 模式 fallback）；都找不到就回退到 `__dirname` 本身。

为什么需要这个函数？因为 code splitting 之后，chunk 文件可能躺在三个不同的深度：

- 单文件构建：`dist/cli.js`，深度 = `dist/`
- 代码分割 Bun.build：`dist/chunk-xxx.js`，深度 = `dist/`
- 代码分割 Vite：`dist/chunks/chunk-xxx.js`，深度 = `dist/`（多了一层 `chunks/`）

而 vendor 二进制（`dist/vendor/audio-capture/`、`dist/vendor/ripgrep/`）永远在 `dist/vendor/` 下。`ripgrep.ts`、`computerUse/setup.ts`、`claudeInChrome/setup.ts`、`updateCCB.ts` 都需要从各自的位置反推 `dist/` 根目录才能拼出正确的 vendor 路径。

如果用 `import.meta.url` 内联推算，每个调用点都得自己写一遍 `lastIndexOf('dist')` 逻辑——而且一旦 Vite 链路改动 `chunks/` 子目录的深度，所有调用点全部失效。`distRoot.ts` 把这个脆弱推算收敛到一处，让上层调用方写 `path.join(distRoot(), 'vendor/ripgrep/ripgrep-' + process.platform + '-' + process.arch)` 就够了。

反事实推演：如果直接用 `path.resolve(__dirname, '../vendor/ripgrep/...')`，在 Bun.build 平铺布局下能跑、在 Vite `chunks/` 子目录布局下就会拼出 `dist/chunks/vendor/ripgrep/...`——一个根本不存在的路径，Grep 工具一调用就 spawn ENOENT。这就是为什么 `CLAUDE.md` 特意点名 `distRoot` 函数被多个文件复用：vendor 路径解析的脆弱性必须集中收口。

## 锚点的诚实：为什么 Vite 注释说 "~300MB" 而本章说 "35MB"

最后留一个诚实的核对：`vite.config.ts:94` 的注释说 code splitting 后 RSS "bringing RSS down to ~300 MB"，而本章开篇引用的数据是 `--version` 的 35MB。

这两个数字都对，但测量的是不同的东西：

- **35MB** 是 `claude --version` 这种零模块加载的 fast-path（见第二章）——CLI 在加载完入口判断完参数就直接退出，几乎所有 chunk 都没被 import。
- **300MB** 是 CLI 完整启动、加载完 REPL、初始化完 Ink 渲染器之后的稳态 RSS——大量 chunk 已经按需加载进来了。

这两个数字一起讲完整的故事：code splitting 让 fast-path 极致轻量（35MB），让 full-session 也能控制在合理范围（300MB vs 单文件的 1GB）。如果只引用其中一个数字会误导——前者让人以为 Bun 已经轻如鸿毛，后者让人以为它仍然吃内存。完整的对照表才是这条设计决策的全部证据。

## 延伸阅读
- 想理解 `--version` 为什么能做到 35MB RSS，见 [第二章：入口的 Fast-Path 优先级链](./02-fast-path.md)
- 想看 JSC 在长会话里继续作妖的另一个证据（`performanceShim` 兜底 C++ Vector 永不收缩），见 [第三章：performanceShim](./03-performance-shim.md)
- 想了解 MACRO 编译期注入的另一面（`process.env.NODE_ENV='production'` 顺手干掉 6,889 个 `_debugStack` Error 对象、省下 12MB），见 [第五章：Feature Flag 系统的三个硬约束](./05-feature-flags.md)
