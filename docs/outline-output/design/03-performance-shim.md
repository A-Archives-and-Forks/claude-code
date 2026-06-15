# 第三章：performanceShim —— JSC 内存泄漏的运行时补丁

> 170 行纯 JS 替换全局对象，拦住 JSC C++ Vector 那条永不收缩的内存黑洞。

## 一行 import，必须放在最前面

打开 `src/entrypoints/cli.tsx:1`，整个文件的第一个有效行不是 `#!/usr/bin/env bun`（那是注释），而是：

```typescript
// src/entrypoints/cli.tsx:2
// Performance shim MUST be the first import — it replaces globalThis.performance
// with a JS-backed implementation before React/OTel capture the native reference.
// Without this, JSC's C++ Vector grows without bound in long-running sessions.
import '../utils/performanceShim.js';
```

注意：这一行甚至排在 `import { feature } from 'bun:bundle'` 之前（`cli.tsx:6`），也排在所有业务逻辑 import 之前。`cli.tsx` 是整个程序的真正入口，任何东西都不会比它更早执行。

为什么必须这么早？答案藏在两个消费者的 import 时序里。

## JSC 原生 Performance 的陷阱：C++ Vector 永不收缩

JavaScriptCore（Bun 的 JS 引擎）内置的 `globalThis.performance` 对象把所有 marks、measures 和 resource timings 存储在一个 C++ 层的 `Vector` 里。这个 Vector 的关键问题不是"慢"，而是"只增不减"——即使你调用了 `performance.clearMarks()`，C++ Vector 的 capacity（已分配内存）不会缩小。`clear` 操作只是把逻辑长度归零，底层 buffer 的 capacity 一直挂在那里，被 GC 完全忽略，因为 GC 管不到 C++ 堆。

在短命脚本里这不是问题：进程一退出，操作系统回收一切。但 Claude Code 是一个长驻进程——一次 `claude` 会话可能运行几十分钟甚至更长，`/loop` 模式下更是无限制。每一轮 API 调用，OpenTelemetry 的 `SpanImpl` 都会在 `performance.mark()` 上创建条目（用来记录 span 的 startTime）。一轮对话下来可能积累几千个 marks，但 span 数据在 flush 之后就已经没用了——只是 C++ Vector 还记得它们。

打开 `src/query.ts:359`，你会看到注释里提到了具体的数字：

```typescript
// src/query.ts:358-360
// Break the closure chain: toolUseContext captures langfuseTrace which
// holds SpanImpl → otperformance (the 571MB Performance object). Nulling
// these after endTrace allows GC to reclaim the span tree.
```

571MB。这是一个 Performance 对象在长会话里膨胀到的体量。注释里甚至画了一条引用链：`toolUseContext -> langfuseTrace -> SpanImpl -> otperformance`。只要这条链上任何一个节点还活着，那个 571MB 的 Performance 对象就无法被 GC。

反事实推演：如果没有这个 shim，一个运行 30 分钟的 daemon 会话，光是 Performance 对象的 C++ Vector 残留就可能吃掉数百 MB。内存不会随对话轮次增长——它会**阶梯式跳跃**，每次大量 span 被创建又 flush 之后留下一截不可回收的 C++ capacity。这不是 OOM 崩溃，而是那种让系统越来越慢、越来越卡的"温水煮青蛙"式泄漏。

## 为什么保留 `performance.now()` 走原生，只劫持 mark/measure/getEntries

打开 `src/utils/performanceShim.ts:19`，整个文件的第一行实际代码是：

```typescript
// src/utils/performanceShim.ts:19
const original = globalThis.performance
```

然后 `performanceShim.ts:28-30` 实现的 `now()` 函数直接委托给了原生的 `original.now()`：

```typescript
// src/utils/performanceShim.ts:28-30
function now(): number {
  return original.now()
}
```

这是一个刻意的性能决策。`performance.now()` 返回的是高精度时间戳（微秒级），底层是一个单调递增的计数器，不涉及任何数据存储，所以零内存开销。Bun/JSC 的原生实现利用了 `clock_gettime(CLOCK_MONOTONIC)` 系统调用，精度和性能都最优。

但 `mark()`、`measure()`、`getEntriesByType()` 是另一回事——它们会在 C++ Vector 里插入和存储条目。shim 把这些操作全部重定向到一个 JS `Map`（`performanceShim.ts:22-26`）：

```typescript
// src/utils/performanceShim.ts:22-26
// JS-backed storage — fully GC-able
const marks = new Map<string, number>()
const measures = new Map<
  string,
  { name: string; startTime: number; duration: number }
>()
```

`Map` 是 JS 堆上的普通对象。当 `marks.clear()` 被调用时（`performanceShim.ts:112`），Map 的内部 buffer 会被 V8/Bun 的 GC 正常回收。没有 C++ Vector 的 capacity 残留问题。

反事实推演：如果把 `now()` 也用 JS 实现（比如用 `Date.now()` 或 `process.hrtime()`），精度会降低到毫秒级，而且 OTel 的 span 时间计算依赖 `performance.now()` 与 `performance.timeOrigin` 之间的差值来得到单调递增的相对时间——换成其他时间源会破坏 OTel 的计时语义。

## 为什么不能继承 Performance.prototype

`performanceShim.ts:124-126` 有一个容易被忽略的注释：

```typescript
// src/utils/performanceShim.ts:124-126
// Plain object shim — must NOT inherit from Performance.prototype because
// native getters (onresourcetimingbufferfull, timeOrigin, toJSON) check
// that `this` is an actual JSC Performance instance and throw otherwise.
```

如果 shim 用 `Object.create(Performance.prototype)` 来创建，JSC 的原生 getter（比如 `timeOrigin`）会检查 `this instanceof Performance`——当 `this` 是一个 JS 平面对象时，这些原生 getter 会直接抛出 TypeError。所以 shim 必须用纯平面对象（plain object literal），然后手动覆盖需要的属性。

但 `timeOrigin` 是只读属性，shim 需要把它代理回原生对象（`performanceShim.ts:142-144`）：

```typescript
// src/utils/performanceShim.ts:142-144
get timeOrigin() {
  return original.timeOrigin
},
```

还有一个细节——`onresourcetimingbufferfull` 的 setter 被故意设成了 no-op（`performanceShim.ts:149-151`）：

```typescript
// src/utils/performanceShim.ts:149-151
set onresourcetimingbufferfull(_v: any) {
  // no-op — prevent accumulation
},
```

这是因为 JSC 的 `Performance` 在 resource timing buffer 满时会触发这个回调——但既然 shim 已经把 resource timing 的写入变成了空操作（`clearResourceTimings` 和 `setResourceTimingBufferSize` 都是 `() => {}`），这个回调永远不该被触发，所以 setter 什么都不做。

## "未定义的必备方法"：undici 的 markResourceTiming

`performanceShim.ts:138-140` 里有一行看起来很奇怪——一个永远不做事的空函数，但注释说"必须存在"：

```typescript
// src/utils/performanceShim.ts:138-140
// Node.js v22 undici internal calls this after every fetch — must exist to
// avoid TypeError: markResourceTiming is not a function
markResourceTiming: (() => {}) as () => void,
```

Node.js v22 内部使用的 HTTP 客户端 undici，在每次 fetch 完成后都会调用 `performance.markResourceTiming()` 来记录网络请求的时间。构建产物是 Node.js 兼容的（`build.ts` 会后处理 `import.meta.require`），所以当用户用 `node dist/cli.js` 运行时，undici 会期望这个方法存在。如果 shim 不提供它，每次 fetch 都会抛 `TypeError: markResourceTiming is not a function`，整个 HTTP 请求链就断了。

这跟 OpenTelemetry 无关，跟 React 无关——纯粹是 Node.js 运行时的内部约定。shim 的角色不仅是拦截 JSC 的泄漏，还得兼容 Node.js 运行时的接口预期。

## 为什么必须最先 import：原生引用的"快照"语义

`cli.tsx` 把 `performanceShim` 放在第一个 import 的位置，不是风格偏好，而是 JS 模块系统的硬约束。

OpenTelemetry 的 `@opentelemetry/core` 包导出了一个 `otperformance` 对象，它在模块初始化时读取 `globalThis.performance` 并缓存到一个模块级变量里。这个变量在模块的整个生命周期内都不会变——它是一个"快照"，记录的是模块被 import 那一瞬间 `globalThis.performance` 指向什么。

类似的，React 的 reconciler 在初始化时也会读取 `globalThis.performance`。一旦它们捕获了原生 Performance 的引用，后续你再替换 `globalThis.performance` 也无济于事——那些模块仍然持有一条指向原生对象的引用链，mark/measure 继续往那个永不收缩的 C++ Vector 里塞东西。

所以 `performanceShim` 必须在 OTel 和 React 之前安装。`cli.tsx:2` 的 import 保证了这一点——ESM 规范要求 import 按书写顺序深度优先执行，`performanceShim.js` 的顶层代码（`performanceShim.ts:169` 的 `installPerformanceShim()`）会在其他任何模块被加载之前执行完毕。

反事实推演：如果把 `performanceShim` 的 import 放到第 10 行甚至第 50 行，OTel 或 React 很可能在它之前就被某个间接依赖链拉进来了（ESM 的 import 图是深度优先的）。一旦错过窗口，shim 就完全失效，而你还不知道——因为 `performance.now()` 仍然正常工作，只有 `mark/measure` 在偷偷泄漏。

## installPerformanceShim 的幂等保护

`performanceShim.ts:162-165`：

```typescript
// src/utils/performanceShim.ts:162-165
export function installPerformanceShim(): void {
  if ((globalThis as Record<string, unknown>).__performanceShimInstalled) return
  ;(globalThis as Record<string, unknown>).__performanceShimInstalled = true
  globalThis.performance = shim
}
```

用 `__performanceShimInstalled` 做幂等检查。这个看起来是多余的——shim 不是只在 `cli.tsx` 里 import 一次吗？实际上不是。`performanceShim.ts:169` 的 `installPerformanceShim()` 在模块顶层调用，而 ESM 模块在同一个进程内只执行一次顶层代码，所以正常情况下确实只运行一次。

但这个保护是为 sub-agent 场景预留的——如果 sub-agent 进程（比如 `spawn` 出的子进程）独立加载了 `performanceShim`，幂等检查确保不会创建多层代理。`installPerformanceShim` 是 `export` 的，意味着它也可以被手动调用——这在测试环境或嵌套场景里有用。

## query.ts 的 finally 块：shim 的第二道防线

`cli.tsx` 的第一行 import 是第一道防线。但防线可能被突破——比如 sub-agent 直接 import `src/query.ts` 而不经过 `cli.tsx` 入口。这种情况下 shim 可能还没装上，OTel 的 span marks 就直接写进了原生 Performance。

打开 `src/query.ts:367-380`，在 `yield* queryLoop()` 的 finally 块里，你会看到一段兜底代码：

```typescript
// src/query.ts:367-380
// Clear JSC's native Performance buffers. OTel (otperformance) references
// globalThis.performance which stores marks/measures/resource timings in a
// C++ Vector that never shrinks. Long-running sessions accumulate hundreds
// of MB of dead capacity even after spans are flushed and nullified.
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

注意这段代码的防御性写法：先检查 `typeof gPerf.clearMarks === 'function'`，再用 `try/catch` 包裹。如果 shim 已经装上，`clearMarks()` 清空的是 JS Map——无害但也没必要（Map 本来就在每一轮 turn 之后由业务代码正常管理）。如果 shim 没装上，`clearMarks()` 清空的是原生 C++ Vector——逻辑长度归零，但 capacity 不缩小，只能算是"止血"而非"治愈"。

这就是为什么这段 finally 块只是"兜底"：它能阻止情况恶化，但不能根治 C++ Vector 不收缩的问题。真正的修复是 shim 本身——把数据存储从 C++ Vector 转移到 JS Map。

注释里还提到了一个细节（`query.ts:358-360`）：在调用 `clearMarks` 之前，代码先断开了引用链——把 `langfuseTrace`、`langfuseRootTrace`、`langfuseBatchSpan` 全部设为 `null`。这是因为 Langfuse 的 `SpanImpl` 对象持有 `otperformance` 的引用，而 `otperformance` 指向原生 Performance 对象。只有把整条引用链上的指针都断开，GC 才能回收 span 树。

## 为什么 dev 模式把 NODE_ENV 设成 'production'

`scripts/dev.ts:17-22`：

```typescript
// scripts/dev.ts:17-22
const defines = {
  ...getMacroDefines(),
  // React production mode — prevents 6,889+ _debugStack Error objects
  // (12MB) from accumulating during long-running sessions.
  // dev 模式使用 development 模式
  'process.env.NODE_ENV': JSON.stringify('production'),
}
```

这是一个反直觉的决策：开发模式为什么要把 `NODE_ENV` 设成 `production`？React 在 `development` 模式下会为每个组件实例创建一个 `_debugStack` 属性——这是一个完整的 `Error` 对象，用来在 DevTools 里显示组件的调用栈。每个 `Error` 对象携带 stack trace 字符串，大约 1.7KB。

Claude Code 的 UI 层有 149 个组件目录，在一个活跃的 REPL 会话里组件创建/销毁极其频繁。注释里给出了实测数据：6,889 个 `_debugStack` Error 对象，累计 12MB。这不是一次性的——组件在每次渲染周期都会重新创建，这些 Error 对象在 development 模式下会不断累积。

`process.env.NODE_ENV` 在这里是通过 Bun 的 `-d` flag（`scripts/dev.ts:25-28`）做编译期替换的——它不是运行时的 `process.env` 读取，而是在编译时被字面量 `'production'` 替换。这意味着 React 的条件分支（`if (process.env.NODE_ENV !== 'production')`）会在编译期被 DCE（Dead Code Elimination）完全移除，零运行时开销。

注释里有一处中文"dev 模式使用 development 模式"跟实际代码矛盾——代码确实设成了 `production`。这是反编译产物里残留的原始注释与实际行为不一致的痕迹之一：原始代码可能在某个迭代中从 `development` 改成了 `production`，但注释没有同步更新。

反事实推演：如果 dev 模式保留 `development`，每次启动 REPL 后几分钟就会积累 12MB 的 `_debugStack` 对象。对一个本来就因为 JSC eager parsing 而内存紧张的运行时来说，这是雪上加霜。

## 两个防御层次的设计哲学

`performanceShim` 和 `NODE_ENV='production'` 解决的是同一个类问题：JSC 运行时在长会话场景下的内存管理缺陷。但它们用了完全不同的策略：

- `performanceShim` 是**替换策略**：在消费者看到原生对象之前，用一个可控的替代品换掉它。这需要精确的时序控制（必须第一个 import）。
- `NODE_ENV='production'` 是**消除策略**：通过编译期 DCE 让问题代码根本不存在于产物中。不需要时序控制，因为代码已经被删除了。

`query.ts:367` 的 `clearMarks` 兜底是第三种策略——**缓解策略**：问题已经发生了，但至少不让它继续恶化。它承认 shim 可能没装上，而 C++ Vector 已经在泄漏了。

三层防御，从"预防"到"消除"到"缓解"，覆盖了不同场景下的内存泄漏路径。这种分层不是过度工程——每一层对应的失败模式都不一样，而且每一层的失败概率都不为零。

## 延伸阅读
- 想看 JSC 的另一个内存陷阱（eager parsing 导致 17MB 单文件暴食 1GB），见 [第一章：Code Splitting 不是优化，是生存需求](./01-code-splitting.md)
- 想理解 `process.env.NODE_ENV` 编译期替换背后的 Bun 编译器 DCE 机制，见 [第五章：Feature Flag 系统的三个硬约束](./05-feature-flags.md)
- 想看 `query.ts` 的 finally 块在更大上下文中的作用（async generator 的生命周期管理），见 [第四章：核心 Query Loop —— 为什么 query() 是 async generator](./04-query-loop.md)
- 想了解 Langfuse span 引用链如何与 OTel 的 `otperformance` 串联，见 [第十一章：状态管理](./11-state-management.md)
