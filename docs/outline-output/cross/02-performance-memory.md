# 性能与内存

> 同一个"长会话越用越卡"在使用者眼里是"我该怎么压上下文"，在开发者眼里是"JavaScriptCore 的 C++ Vector 为什么永不收缩"。性能与内存是双视角主题里因果链最长的一个：用户能观察到的每一个 RSS 数字、每一次"重启就好"，背后都对应着一条具体的运行时约束或一段反编译留下的工程妥协。

## 产品视角（写给使用者）

这一节回答两个问题：**日常用着用着变卡了怎么办**，以及**怎么从一开始就把内存预算控制住**。读完之后你不需要去看源码，就能把九成长会话性能问题处理掉。

### 先分清两类"卡"

长会话变慢几乎总是下面两类原因之一，处理方式完全不同：

- **上下文太长** —— 每一轮对话都把历史消息塞进 prompt，模型推理时间和 token 账单随上下文线性增长。这种"卡"是**可逆的**：压一下上下文，立刻就快。
- **进程内存累积** —— 即使上下文压缩了，进程的 RSS（常驻内存）也可能不下降。这种"卡"是**渐进的**：压缩上下文救不了，最快的解法是退出 CLI 重开。

判断方式：跑 `/compact` 之后看响应速度。如果明显变快，说明是上下文问题；如果还是慢、状态栏或 `ps aux | grep claude` 看到的 RSS 数字还在涨，就是内存累积问题。

### 上下文变长的三条解法，从轻到重

按下面顺序试，越往下越彻底：

1. **`/compact`** —— 让 Claude 用一个小模型把历史对话总结成一段摘要，再用摘要替换原始消息。源码在 `src/commands/compact/compact.ts`。它会先尝试 session memory 压缩（保留结构化记忆），失败再走通用压缩模型。带自定义指令也行：`/compact 只保留与测试相关的部分`。
2. **`/force-snip`** —— 直接在消息数组里插一条 `snip_boundary` 系统消息，把当前位置之前的历史标记为"已剪裁"。下一次 query 时 `snipCompactIfNeeded` 会把这些消息从模型视角下移除，但 REPL 里依然能看到完整滚动历史。源码在 `src/commands/force-snip.ts:18`。比 `/compact` 更暴力：不总结、直接砍。
3. **`/clear`** —— 整个会话清空重开。源码在 `src/commands/clear/`。

日常推荐顺序是 `/compact` → `/force-snip` → `/clear`。`/force-snip` 适合"前面那段讨论已经跑偏了，我想从干净状态继续"的场景。

### 自动 compact 什么时候触发

系统会在上下文接近模型窗口上限时自动触发 compact，不需要你手动盯。如果你发现自动触发太频繁（每次刚聊几句就被压缩），说明你的 CLAUDE.md 或工具调用本身就在贡献大量上下文——可以跑 `/context` 或 `/ctx_viz` 看看上下文都被什么占满了。

### 长跑场景特别留意：daemon、/loop、容器

短会话几乎不会撞上内存累积问题，但下面这些长跑场景会：

- **`/loop`** —— 每 N 分钟自动跑一次任务，进程常驻。
- **daemon 模式** —— `claude daemon start` 启动的长驻 supervisor + worker。
- **容器 / CI** —— `CLAUDE_CODE_REMOTE=true` 时，`cli.tsx:44-49` 会自动给子进程注入 `--max-old-space-size=8192`（前提是容器有 16GB）。这是项目对容器环境的硬编码假设：你的容器至少要有 8GB 余量给 Node.js 堆。

在长跑场景下，建议每隔几小时主动重启一次进程，或者把任务拆成多次独立会话而不是一条无限循环。

### 我想知道 Claude 现在吃了多少内存

- macOS / Linux：`ps aux | grep claude`，看 RSS 列（单位 KB）。
- daemon / background session：`claude ps` 看进程列表，`claude logs` 看输出。
- 性能问题专用反馈通道：`/perf-issue`（源码 `src/commands/perf-issue/`）。

### 为什么有时候重启 CLI 是唯一解

如果压缩了上下文、清了消息，进程 RSS 还是下不去，这是 JavaScriptCore（Bun 的 JS 引擎）的已知特性：某些内部缓冲区一旦分配就不再收缩。详细原因见下面的设计视角。**用户侧能做的就是退出重开**——这不是 bug，是运行时的硬约束。

## 设计视角（写给开发者）

设计大纲里性能主题分布在第一、三、四章，是全书最深的几章。这一节把数据链串起来讲：从 17MB 单文件的灾难，到 `performanceShim` 的运行时补丁，到 6,889 个 `_debugStack` 的"看不见的内存"，再到 `cli.tsx:48` 那条看似随意的 `--max-old-space-size` 注入。

### JSC 的贪婪解析：17MB 单文件为什么能让 RSS 涨到 1GB

这是全书最戏剧性的设计动机。打开 `vite.config.ts:94-102`：

```ts
output: {
  format: 'es',
  // Code splitting: Bun/JSC parses the entire single-file bundle eagerly,
  // consuming ~1 GB RSS for a 17 MB output (vs ~220 MB on Node/V8 which
  // lazy-parses). Splitting into chunks allows Bun to load modules on demand,
  // bringing RSS down to ~300 MB.
  entryFileNames: 'cli.js',
  chunkFileNames: 'chunks/[name]-[hash].js',
},
```

JavaScriptCore（Bun 用的 JS 引擎）和 V8（Node.js 用的）在解析策略上有根本差异：**JSC 全量解析 + 全量 JIT**，V8 懒解析。同样一份 17MB 的单文件 bundle，JSC 会把整份 bytecode 和 JIT 编译结果一次性吃进内存，RSS 直接冲到 ~1GB；V8 只在函数被调用时才解析，RSS 只要 ~220MB。

CLAUDE.md 里记录的实测数据更细：单文件 17MB 产物导致 RSS 暴涨至 ~1GB；切成 600+ chunks 后，Bun 按需加载，`--version` 的 RSS 从 966MB 骤降到 35MB，完整加载从 1GB+ 降到 ~500MB。

**为什么 Vite 必须代码分割而不是单文件**——这不是性能优化，是**生存需求**。Bun.build（`build.ts:23` 的 `splitting: true`）和 Vite（`vite.config.ts:94` 的 `chunkFileNames: 'chunks/[name]-[hash].js'`）两条构建管线都默认走代码分割，原因就是这条。

`scripts/post-build.ts` 还要在分割后做两件事：(1) 把 `import.meta.require` 替换成 Node.js 兼容的 `createRequire` 探测，让产物同时能在 bun 和 node 上跑；(2) patch 掉第三方依赖（`@anthropic-ai/sandbox-runtime`）里未受保护的 `var { ... } = globalThis.Bun` 解构——否则在 Node.js 启动会崩。这两步都是"代码分割 + 双运行时兼容"的下游工程代价。

### performanceShim：JSC 原生 Performance 的 C++ Vector 永不收缩

打开 `src/utils/performanceShim.ts:1-17`，文件头注释直接写明了根因：

> In Bun, globalThis.performance is JSC's native Performance object. It stores marks, measures, and resource timings in a C++ Vector that never shrinks even after clearMarks(). Long-running sessions (daemon, /loop) accumulate hundreds of MB of dead capacity.

JSC 的原生 `performance` 对象把 `mark()` / `measure()` / resource timings 存进一个 C++ Vector，这个 Vector **只增不减**——即使你调 `clearMarks()`，C++ 那头的容量也不会释放。React reconciler 和 OpenTelemetry / Langfuse 客户端都会反复调用 `mark` / `measure` 做时间打点，长会话里这些死容量能累积几百 MB。

shim 做的事（`performanceShim.ts:19-155`）很克制：

- **`performance.now()` 继续走原生**（`performanceShim.ts:28-30`）—— 高频调用、不占内存，没必要劫持。
- **`mark` / `measure` / `getEntries*` 重定向到 GC 可回收的 JS Map**（`performanceShim.ts:22-26` 的 `marks` / `measures`）—— Map 是普通 JS 对象，GC 能正常回收。
- **不继承 Performance.prototype**（`performanceShim.ts:124-126`）—— 因为原生 getter（`timeOrigin` / `onresourcetimingbufferfull` / `toJSON`）会检查 `this` 是不是真正的 JSC Performance 实例，继承就抛错。
- **提供 `markResourceTiming` 空函数**（`performanceShim.ts:140`）—— Node.js v22 的 undici 内部每次 fetch 后都会调这个方法，不存在就 TypeError。

**为什么必须最先 import**——这是整段代码里最脆弱的顺序依赖。打开 `src/entrypoints/cli.tsx:1-5`：

```ts
#!/usr/bin/env bun
// Performance shim MUST be the first import — it replaces globalThis.performance
// with a JS-backed implementation before React/OTel capture the native reference.
// Without this, JSC's C++ Vector grows without bound in long-running sessions.
import '../utils/performanceShim.js';
```

原因（`performanceShim.ts:14-16`）：React reconciler 和 OTel / Langfuse 在 import 时会**捕获 `globalThis.performance` 的引用**。一旦它们拿到原生引用，shim 再装上也没用——它们调用的是自己缓存的原生对象。所以 shim 必须在 React / OTel 加载**之前**就把 `globalThis.performance` 换掉。`installPerformanceShim()`（`performanceShim.ts:162-166`）用 `globalThis.__performanceShimInstalled` 守护幂等性，并且文件末尾（`:169`）自动调用一次，保证"import 即安装"。

### query.ts:367 的兜底：防 sub-agent 绕过 shim

`src/query.ts:367-380` 在每次 query 的收尾位置写了这段：

```ts
const gPerf = globalThis.performance
if (gPerf && typeof gPerf.clearMarks === 'function') {
  try {
    gPerf.clearMarks()
    gPerf.clearMeasures?.()
    gPerf.clearResourceTimings?.()
  } catch {
    // Non-critical — some environments may not support all methods
  }
}
```

注释（`query.ts:367-370`）解释了为什么需要兜底："OTel references globalThis.performance which stores marks/measures/resource timings in a C++ Vector that never shrinks. Long-running sessions accumulate hundreds of MB of dead capacity even after spans are flushed and nullified."

**为什么有了 shim 还要兜底**：某些 sub-agent 路径会**直接 `import query`**，而不经过 `cli.tsx` 的入口。如果那个进程的 shim 没装上（比如测试环境、嵌入式调用），原生的 `performance` 还在，每次 query 累积的 marks 就会泄漏。这段兜底调的是 `globalThis.performance`（已经被 shim 替换过的话就是 shim 的 `clearMarks`，没有的话就是原生的），作为"shim 没生效时的保险栓"。

注意这个兜底是**尽力而为**：原生 `clearMarks()` 在 JSC 上即使能调，C++ Vector 也不收缩（见上面 shim 注释）。所以兜底主要救的是 shim 已装但 Map 需要清空的场景，以及"sub-agent 没装 shim 但又想尽力"的场景。

### 6,889 个 _debugStack Error 对象：开发模式下看不见的 12MB

打开 `build.ts:26-31`：

```ts
define: {
  ...getMacroDefines(),
  // React production mode — eliminates _debugStack Error objects
  // (6,889 objects × ~1.7KB = 12MB in dev builds) and removes
  // prop-type / key warnings not useful in a production CLI tool.
  'process.env.NODE_ENV': JSON.stringify('production'),
},
```

React 在开发模式下（`process.env.NODE_ENV !== 'production'`）会为每次组件渲染构造一个 `Error` 对象，用于捕获调用栈、生成 `_debugStack` 字段。这在浏览器开发工具里有用，但在 CLI 工具里就是纯内存浪费：6,889 个 `Error` 对象，每个约 1.7KB，合计约 12MB。

`vite.config.ts:124` 的对应位置注释（"6,889 objects × ~1.7KB = 12MB in dev builds"）和 `build.ts` 的注释互相印证。这就是为什么 build 强制 `NODE_ENV='production'`——不是审美，是实打实的 12MB。

### cli.tsx:44 的 CLAUDE_CODE_REMOTE 内存注入

打开 `src/entrypoints/cli.tsx:42-49`：

```ts
// Set max heap size for child processes in CCR environments (containers have 16GB)
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  const existing = process.env.NODE_OPTIONS || '';
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192';
}
```

注释写得很直白："containers have 16GB"。这是项目对容器环境（Claude Code Remote / CCR）的**硬编码假设**：容器至少有 16GB 内存，所以子进程堆上限可以放心设到 8GB。

**为什么硬编码 8GB 而不是按容器实际内存动态算**：因为 `NODE_OPTIONS` 必须在子进程启动前设置，而那时还没有可靠的"当前容器内存上限"查询方式（cgroup 接口在不同运行时下行为不一）。8GB 是一个保守的"16GB 容器的一半给堆"的工程经验值。

**为什么这段代码在 cli.tsx 顶层而不是 init.ts**：和 `CLAUDE_CODE_ABLATION_BASELINE`（`cli.tsx:56`）是同一个原因——子进程一启动就要读 `NODE_OPTIONS`，`init()` 跑得太晚。这是入口文件的"副作用顶层化"模式。

### distRoot.ts：vendor 二进制路径解析

打开 `src/utils/distRoot.ts:15-27`：

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

代码分割之后，chunk 文件散落在 `dist/` 或 `dist/chunks/` 下，但 vendor 二进制（ripgrep、audio-capture）在 `dist/vendor/`。chunk 文件需要能在运行时定位到 vendor 目录。`distRoot` 用 `lastIndexOf('dist')` 或 `lastIndexOf('src')`（dev 模式）反向定位根目录。

**为什么不用 `import.meta.url` 的相对路径推算**：因为 chunk 文件名带 hash（`chunks/[name]-[hash].js`），嵌套层级不固定；`ripgrep.ts` / `computerUse/setup.ts` / `claudeInChrome/setup.ts` / `updateCCB.ts` 都依赖这个共享函数。CLAUDE.md 的"尾声"章节提到一个相关坑：`vendor/ripgrep/arm64-darwin` 二进制如果缺失，Grep 工具会 spawn 该路径并 ENOENT——`distRoot` 的 vendor 复制逻辑（`build.ts:91-93`）就是为了保证构建产物里 vendor 二进制存在。

### 性能预算与 token 预算的耦合

内存预算之外还有 token 预算：`TOKEN_BUDGET` feature 与 `/cost` / `/usage` 联动。token 预算直接影响单轮 API 调用的延迟和费用，但它和内存预算是**正交**的——压缩上下文（省 token）不一定释放内存（JSC Vector 不收缩），释放内存（重启进程）也不一定省 token（上下文还在持久化存储里）。

用户看到"卡"时，往往分不清是哪一类预算耗尽。这正是性能主题必须双视角覆盖的原因：产品视角教用户**按症状分流**（上下文卡 vs 内存卡），设计视角解释**为什么分流之后内存卡还是救不回来**。

## 两视角如何呼应

用户视角的痛点几乎都能在设计视角找到对应的运行时约束：

- **"长会话越用越卡，重启就好"**（产品视角）对应 **"JSC 的 C++ Vector 永不收缩 + performanceShim 必须最先 import"**（设计视角）——用户看到的是 RSS 上涨，根因在 JSC 原生 Performance 对象的内存模型。设计视角的 shim 把大部分 `mark` / `measure` 重定向到 GC 可回收的 JS Map，但兜底代码（`query.ts:367`）承认 shim 可能被 sub-agent 绕过，所以用户侧的"重启就好"是最诚实的解法。
- **"`/compact` 之后还是慢"**（产品视角）对应 **"token 预算与内存预算正交"**（设计视角）——`/compact` 压的是模型视角的上下文（省 token、省推理时间），但 REPL 里的消息对象、JSC Vector 里的 marks 都还在内存里。这是为什么产品视角必须教用户区分"上下文卡"和"内存卡"。
- **"容器里跑 Claude 会不会 OOM"**（产品视角）对应 **"cli.tsx:44 的 CLAUDE_CODE_REMOTE 内存注入硬编码 8GB"**（设计视角）——产品视角告诉用户"容器至少给 16GB"，设计视角解释为什么是 8GB 而不是动态算。
- **"启动 `--version` 为什么也要几百 MB"**（隐含的工程好奇）对应 **"17MB 单文件让 RSS 涨到 1GB，必须代码分割"**（设计视角）——`--version` RSS 从 966MB 降到 35MB 是代码分割的直接收益，用户感知到的是"CLI 启动飞快"，背后是 JSC 全量解析 vs V8 懒解析的根本差异。

这种呼应关系是性能章必须双视角覆盖的核心原因：产品视角告诉用户**遇到卡顿怎么办**，设计视角告诉用户**为什么有些卡顿只能重启**。两个视角合在一起，才能让使用者在"压缩、剪裁、清空、重启"之间做出正确选择，也让维护者在改性能相关代码时知道哪些约束是硬的、不能碰。
