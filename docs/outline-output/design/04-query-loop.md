# 第四章：核心 Query Loop -- 为什么 query() 是 async generator

> 流式响应把"结果"与"副作用"解耦，调用方选择性消费——这是 async generator 而不是回调或事件发射器的根本原因。

## async generator vs 回调：为什么用 yield 而不是 EventEmitter

打开 `src/query.ts:276`，你会看到整个 query loop 的核心签名：

```ts
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
>
```

返回类型是 `AsyncGenerator<YieldedType, ReturnType>`。每次 `yield` 产出一个消息，最终 `return` 一个 `Terminal` 对象。这个设计不是风格偏好——它解决了一个具体的架构问题：**谁控制消息的流向**。

如果用 EventEmitter，调用方需要注册多个 listener（`on('message')`, `on('error')`, `on('end')`），然后在一个外部数组里手动拼装消息流。事件的消费者和 query loop 的执行是解耦的——你不知道 loop 在 yield 消息的时候自己处于什么状态。

如果用 callback，调用方需要在 callback 里处理分支逻辑：这是 tool_use 还是 thinking block？是否需要 withhold？这些分支本质上属于 query loop 的内部状态机，但 callback 把它们推给了调用方。

async generator 把状态机留在 loop 内部，只把"我现在有一个消息给你"这个事实暴露出去。调用方写一个简单的 `for await`，里面只关心"拿到消息后做什么"，不需要知道 loop 有几条 continue 路径、是否在 withhold 错误、是否正在重试 fallback 模型。

反事实推演：如果用 EventEmitter，`QueryEngine` 在 `src/QueryEngine.ts:688` 的消费循环会变成一个散落着 `if` 分支的事件处理器，而不是一个线性的 `switch (message.type)` 结构。更关键的是，`yield` 天然支持背压——调用方没消费完，loop 就不继续。EventEmitter 没有这个能力，消息会在内存里堆积。

## queryLoop() 的委托模式：两层 generator 的分离

`query()` 本身并不直接包含 `while (true)` 循环。它做的是三件事：初始化 Langfuse trace、委托给 `queryLoop()`、在 finally 块里清理资源和通知命令生命周期。

打开 `src/query.ts:393`，你会看到 `queryLoop()`：

```ts
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
  consumedAutonomyCommands: QueuedCommand[],
): AsyncGenerator<...> {
```

`query()` 用 `yield*` 把自己变成 `queryLoop()` 的透明管道。`yield*` 委托意味着 `query()` 产出的每一条消息都来自 `queryLoop()`，但 `query()` 的 finally 块在 `queryLoop()` 结束（无论是正常 return 还是 throw）后一定会执行。

为什么要把清理逻辑放在外层 generator 的 finally 里？因为 `queryLoop()` 内部有 7 个 `state = next; continue` 跳转点（打开 `src/query.ts:1372`、`src/query.ts:1437`、`src/query.ts:1524`、`src/query.ts:1581`、`src/query.ts:1616` 等处），每个跳转都可能因为新状态而触发不同路径。如果把清理分散在每个 return 之前，任何一个遗漏都会泄漏。`yield*` 的保证是：无论内层 generator 怎么退出，外层 finally 一定跑。

打开 `src/query.ts:367` 看那个 finally 块在做什么：

```ts
const gPerf = globalThis.performance
if (gPerf && typeof gPerf.clearMarks === 'function') {
  try {
    gPerf.clearMarks()
    gPerf.clearMeasures?.()
    gPerf.clearResourceTimings?.()
  } catch { }
}
```

这是上一章讲过的 `performanceShim` 的兜底防线。如果 sub-agent 直接 import `query.ts` 而没经过 `cli.tsx` 的 shim 注入，JSC 原生 Performance 的 C++ Vector 仍然会在每轮循环中膨胀。finally 块在这里做了最后一道清理。

## thinking 块的三条硬约束

打开 `src/query.ts:181`，你会看到一段罕见的、用中世纪英语风格写的注释：

```ts
/**
 * The rules of thinking are lengthy and fortuitous. ...
 *
 * The rules follow:
 * 1. A message that contains a thinking or redacted_thinking block must be part of a query whose max_thinking_length > 0
 * 2. A thinking block may not be the last message in a block
 * 3. Thinking blocks must be preserved for the duration of an assistant trajectory
 *     (a single turn, or if that turn includes a tool_use block then also its
 *      subsequent tool_result and the following assistant message)
 *
 * Heed these rules well, young wizard. For they are the rules of thinking, and
 * the rules of thinking are the rules of the universe. If ye does not heed these
 * rules, ye will be punished with an entire day of debugging and hair pulling.
 */
```

这三条规则是 Anthropic API 的硬性约束。违反任何一条都会得到 400 错误。反编译者在这里留下了这段风格化的注释，因为他们在调试时确实被这些规则惩罚过。

规则 1 意味着：如果启用了 thinking，`max_thinking_length` 参数必须大于 0。否则 API 拒绝带 thinking block 的请求。

规则 2 意味着：thinking block 后面必须有内容（text 或 tool_use）。不能以 thinking 结束一条消息。在恢复循环（下文讲）中，这决定了 recovery message 的构造方式——你不能只发一个 thinking block，必须在后面跟一个续写指令。

规则 3 意味着：thinking block 的生命周期是整个"assistant 轨迹"——一次单轮，或者如果那次调用了工具，还包括工具结果和下一轮 assistant 回复。这意味着在工具执行的中间步骤里，thinking block 必须原封不动地保留在消息历史中。不能因为压缩或 compact 而把 thinking block 从轨迹中摘出去。

反事实推演：如果没有规则 3，compact 算法可以把 thinking block 当作普通内容摘要掉。但 API 校验会 400，所以 compact 逻辑必须特别处理 thinking block——要么保留，要么在 compact 前把它从轨迹里剥离。这增加了 compact 的复杂性，但无法绕过。

## MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3：扣留错误的恢复博弈

打开 `src/query.ts:194`：

```ts
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
```

这个数字后面藏着一个精巧的设计决策。当 Claude 的输出触及 `max_output_tokens` 上限时，API 返回一个带 `apiError: 'max_output_tokens'` 的 assistant message。正常情况下，这个错误应该直接 yield 给调用方。但问题在于：SDK 调用方（比如 cowork、desktop 客户端）会在收到任何带 `error` 字段的消息时**立即终止会话**。

打开 `src/query.ts:196` 的注释：

```ts
/**
 * Is this a max_output_tokens error message? If so, the streaming loop should
 * withhold it from SDK callers until we know whether the recovery loop can
 * continue. Yielding early leaks an intermediate error to SDK callers (e.g.
 * cowork/desktop) that terminate the session on any `error` field — the
 * recovery loop keeps running but nobody is listening.
 */
```

这就是为什么有 `isWithheldMaxOutputTokens` 函数（`src/query.ts:205`）。在流式循环中（`src/query.ts:1059`），如果消息是 `max_output_tokens` 错误，它不会被 yield，而是被扣留。

恢复机制分两个阶段：

**阶段 1：升级重试。** 如果从未设置过 `maxOutputTokensOverride`（意味着使用了默认的 8k 上限），把上限提升到 `ESCALATED_MAX_TOKENS`（`src/query.ts:1472`），然后用 `continue` 重试同一个请求。不需要插入 recovery message——模型拿到更大的上限后能自己续写。这个阶段只触发一次。

**阶段 2：多轮恢复。** 如果升级后仍然触及上限（或者一开始就用了自定义上限），插入一条 `isMeta: true` 的 user message（`src/query.ts:1497`），内容是 `"Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened."`，然后 `continue` 重试。这个阶段最多触发 3 次（`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`）。

3 次是个工程折中：太少会导致长代码生成任务频繁失败，太多会导致无限循环。在极端情况下（模型陷入重复输出），3 次重试足以检测到问题并 surface 错误。

打开 `src/query/transitions.ts` 可以看到所有 continue 原因的类型定义：

```ts
export type Continue =
  | { reason: 'collapse_drain_retry'; committed: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_tokens_escalate' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'token_budget_continuation' }
  | { reason: 'next_turn' }
```

每个 `continue` 站点都构造一个新的 `State` 对象（`src/query.ts:261`），包含完整的 9 个字段。这不是偷懒——用解构 + 单一赋值 `state = next` 代替 9 个独立赋值，让每个 continue 站点只改它关心的字段，其余字段从解构的旧值自动继承。如果用 9 个独立赋值，任何一个遗漏都会导致状态不一致。

反事实推演：如果 `max_output_tokens` 错误不被扣留而是直接 yield，SDK 调用方会在 recovery loop 还在跑的时候就断开连接。recovery loop 可能成功续写了剩余内容，但没有人听。用户看到的是一个截断的回答和"出错了"的提示，而实际上再等几秒就能拿到完整结果。

## QueryEngine：跨 turn 的会话编排器

`query()` 处理的是单次用户输入到完成（或失败）的完整过程。但一个对话有多个 turn。`QueryEngine`（`src/QueryEngine.ts:192`）就是这个跨 turn 的编排器。

打开 `src/QueryEngine.ts:192` 的类定义：

```ts
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()
```

每个字段都有明确的跨 turn 生命周期：

- `mutableMessages`：消息历史，跨 turn 不断增长（除非 compact/snip）
- `totalUsage`：token 消耗累计，跨 turn 叠加
- `readFileState`：文件内容缓存，避免跨 turn 重复读取同一个文件
- `discoveredSkillNames`：turn 内发现的新 skill 名称，每个 turn 开始时清空（`src/QueryEngine.ts:246`），防止无限增长

`submitMessage()` 本身也是 async generator（`src/QueryEngine.ts:217`）：

```ts
async *submitMessage(
  prompt: string | ContentBlockParam[],
  options?: { uuid?: string; isMeta?: boolean },
): AsyncGenerator<SDKMessage, void, unknown>
```

它在内部调用 `query()`（`src/QueryEngine.ts:688`），但做了三件 `query()` 不管的事：

1. **消息持久化**：在进入 query loop 之前就把用户消息写入 transcript（`src/QueryEngine.ts:460`），确保即使进程在 API 响应到达前被杀死，`--resume` 也能恢复到发送点。

2. **SDK 消息转换**：把内部 `Message` 类型转换为 `SDKMessage` 格式，通过 `normalizeMessage` 做字段映射（`src/QueryEngine.ts:789`）。

3. **权限拒绝追踪**：通过 `wrappedCanUseTool`（`src/QueryEngine.ts:253`）包装每个工具调用的权限检查，记录拒绝事件到 `permissionDenials`，最终随 `result` 消息返回给 SDK 调用方。

为什么不把这些逻辑放进 `query()` 里？因为 `query()` 需要保持与 UI 路径（REPL screen）的通用性。REPL 不做 transcript 持久化（它有自己的会话管理），不需要 SDK 消息转换。`QueryEngine` 是 SDK/Headless 路径特有的编排层。

反事实推演：如果把 transcript 持久化放进 `query()`，REPL 路径也必须处理 transcript 逻辑，要么做条件分支（污染 `query()` 的纯净性），要么 REPlay 模式也写 transcript（造成重复写入）。分离后，`query()` 保持通用，`QueryEngine` 专注 SDK 语义。

## snipReplay 回调：feature gate 的依赖注入技巧

打开 `src/QueryEngine.ts:166`，你会看到 `snipReplay` 字段的注释：

```ts
/**
 * Snip-boundary handler: receives each yielded system message plus the
 * current mutableMessages store. Returns undefined if the message is not a
 * snip boundary; otherwise returns the replayed snip result. Injected by
 * ask() when HISTORY_SNIP is enabled so feature-gated strings stay inside
 * the gated module (keeps QueryEngine free of excluded strings and testable
 * despite feature() returning false under bun test).
 */
```

这是一个精心设计的依赖注入模式。`QueryEngine` 本身不 import `snipCompact.js`——它只定义了一个回调接口。实际的 snip 逻辑在 `src/QueryEngine.ts:1346` 处，由工厂函数有条件地注入：

```ts
...(feature('HISTORY_SNIP')
  ? {
      snipReplay: (yielded: Message, store: Message[]) => {
        if (!snipProjection!.isSnipBoundaryMessage(yielded))
          return undefined
        return snipModule!.snipCompactIfNeeded(store, { force: true })
      },
    }
  : {}),
```

当 `HISTORY_SNIP` 关闭时（包括 `bun test` 环境下 `feature()` 返回 `false`），`snipReplay` 就是 `undefined`。`QueryEngine` 在 `src/QueryEngine.ts:948` 用可选链调用它：

```ts
const snipResult = this.config.snipReplay?.(msg, this.mutableMessages)
```

这样做解决了两个问题：

**问题 1：excluded-strings 检查。** `snipCompact.js` 里包含 snip 特有的字符串（边界消息文本等）。如果 `QueryEngine` 直接 import 它，即使在 feature 关闭时，这些字符串也会被 bundle 进产物，触发内部的 excluded-strings 安全检查。通过回调注入，feature 关闭时 `snipCompact.js` 根本不会被 import。

**问题 2：测试隔离。** `bun test` 下 `feature()` 永远返回 `false`。如果 `QueryEngine` 直接依赖 `feature('HISTORY_SNIP')` 的结果来决定控制流，测试时所有 snip 分支都是死代码。通过回调注入，测试时 `snipReplay` 是 `undefined`，所有 snip 逻辑被跳过，`QueryEngine` 的主路径仍然可测。想要测试 snip 行为的测试可以手动注入一个 mock 回调。

反事实推演：如果不用回调注入而是直接在 `QueryEngine` 里写 `if (feature('HISTORY_SNIP')) { snipModule.snipCompactIfNeeded(...) }`，`bun test` 下这个分支永远不执行。测试无法覆盖 snip 的边界情况。更糟的是，每次有人改了 `snipCompact.js` 的导出签名，`QueryEngine` 的类型检查也会报错——即使 feature 关闭时这段代码根本不会运行。

## 无限循环的 `while(true)` 和它 7 个出口

回到 `queryLoop()` 的 `src/query.ts:460`：

```ts
// eslint-disable-next-line no-constant-condition
while (true) {
```

这不是失控的循环。它是一个有限状态机，每个 `continue` 都带着一个明确的 `transition` 原因（记录在 `src/query/transitions.ts:13` 的 `Continue` 类型中）。循环出口有三类：

**正常退出（return Terminal）：** `completed`（`src/query.ts:1633`）、`blocking_limit`（`src/query.ts:830`）、`image_error`（`src/query.ts:1224`）、`model_error`（`src/query.ts:1243`）、`aborted_streaming`（`src/query.ts:1324`）、`stop_hook_prevented`（`src/query.ts:1555`）、`prompt_too_long`（`src/query.ts:1448`）、`max_turns`。

**异常退出（throw）：** 任何未被内层 try/catch 捕获的异常会向上传播，`query()` 的外层 finally 块负责清理。

**continue 跳转（state = next; continue）：** 7 个跳转点覆盖恢复场景：context collapse drain retry、reactive compact retry、max_output_tokens 升级、max_output_tokens 多轮恢复、stop hook blocking、token budget continuation、next turn（工具调用后的下一轮）。

每个 continue 站点构造一个完整的新 `State` 对象。这不是冗余——`State` 类型有 9 个字段，其中 `transition` 字段记录了"为什么继续"。测试可以断言 `state.transition?.reason === 'max_output_tokens_recovery'` 来验证恢复路径是否被触发，而不需要检查消息内容。

反事实推演：如果不用统一的 `State` 对象而是用散落的变量赋值（`messages = newMessages; toolUseContext = newCtx; maxOutputTokensRecoveryCount++`），任何一个 continue 站点漏了一个变量都会导致后续迭代读到过期的状态。`state = { ...state, messages, toolUseContext, ... }` 的模式虽然看起来啰嗦，但保证了每次跳转都是原子替换。

## 延伸阅读

- 想看 query loop 的内存防线（performanceShim），见 [第三章](./03-performance-shim.md)
- 想看 feature flag 为什么让 `query()` 顶部的 conditional require 成为必须，见 [第五章](./05-feature-flags.md)
- 想看 QueryEngine 的上层状态管理（bootstrap/state.ts 的 singleton 限制），见 [第十一章](./11-state-management.md)
- 想看 query loop 里的 compact 子系统如何被触发，见产品大纲第三章"上下文管理与自动压缩"
