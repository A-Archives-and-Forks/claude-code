# 可观测性

> 同一个"我想知道 Claude 在做什么"的诉求，在使用者眼里是"它现在到底卡在哪一步、这次回答烧了多少 token、能不能把这次对话导出来给同事看"，在开发者眼里是"为什么 Langfuse 追踪必须从 `getAPIProvider()` 取单一真相源、为什么 `performanceShim` 必须抢在 React/OTel 之前装上、为什么 `--dump-system-prompt` 要被 feature flag 锁死"。可观测性天然是双视角主题——用户想知道"我能不能看见、怎么看"，开发者想知道"探针插在哪、插这个位置要付出什么代价、会不会反过来把会话拖垮"。

## 产品视角（写给使用者）

这一节回答一个高频但被低估的问题：**Claude 在帮我跑任务的时候，我自己怎么知道它正在干什么、干得对不对、花了多少？** 答案按"你想看什么"分四类工具，从轻到重排列。

### 第一类：我想看它现在在做什么（实时观测）

你在 REPL 里发完一条消息，最直接的观测就是屏幕本身——流式回复、工具调用、权限弹窗、token 状态栏，这些都是"被动观测"：你不主动做什么，它们自己会显示。但当会话变长、工具链变深（比如一个 Agent 派了三个子代理、每个子代理又跑了若干次 Bash + FileEdit），光靠屏幕就不够了。这时候有两条主动路径：

- **`/debug-tool-call [N]`**：列出本会话最后 N 次工具调用（默认 5）的输入与输出。源码在 `src/commands/debug-tool-call/index.ts`，它不依赖任何远程服务，直接读会话日志（JSONL transcript，路径由 `getTranscriptPath()` 在 `index.ts:33` 决定，位于 `~/.claude/projects/<sanitize(cwd)>/<sessionId>.jsonl`）。用法场景很具体——"刚才那次 FileEdit 把哪一行改错了"、"Agent 派的子代理到底跑了什么命令"，不用翻整个 transcript 文件。注意它只显示 tool_use + tool_result 配对，纯文本回复不在这张表里。
- **状态栏的 token 数字**：每次 API 调用结束，REPL 状态栏会刷新 input/output/cache token。想看历史累积、单次费用估算，用 `/cost`（本次会话总费用）、`/usage`（按模型拆分的用量）、`/stats`（更细的统计）。这三个命令读的都是同一份 usage 累加器，区别只是聚合粒度。

### 第二类：我想把每次 API 调用、每个工具调用都记下来（Langfuse 追踪）

如果你在做长任务、调试 prompt、或者想把 Claude 的行为变成可回放的训练数据，屏幕不够用——你需要结构化的请求链路。这就是 Langfuse 集成的用途。打开 `docs/features/tools/langfuse-monitoring.md`，它是一个开源 LLM 可观测性平台，CCB 通过 OpenTelemetry 桥接进去。**核心只需要三个环境变量**：

| 环境变量 | 说明 |
|---------|------|
| `LANGFUSE_PUBLIC_KEY` | Langfuse 公钥（必填） |
| `LANGFUSE_SECRET_KEY` | Langfuse 密钥（必填） |
| `LANGFUSE_BASE_URL` | 服务地址，默认 `https://cloud.langfuse.com`；自部署时改成你的地址 |

推荐写进 `.claude/settings.json` 的 `env` 字段，每次启动自动生效。**没配这三个变量时所有追踪函数都是 no-op、零开销**——不用担心开了它拖慢响应。配齐之后，每次 API 请求、每次工具调用都会被打成 span 发到 Langfuse，你在面板里能看到：

- **LLM 调用**：模型名、Provider、输入/输出消息、token 用量（含 cache_creation / cache_read）、首 token 耗时（TTFT）、总耗时
- **工具执行**：工具名、输入、输出、耗时、错误
- **多 Agent 链路**：主 Agent 和子 Agent 各有独立 trace，能在面板里看到父子关系
- **自动脱敏**：API key、文件内容片段、shell 输出里的敏感字段会被遮蔽（实现见 `src/services/langfuse/sanitize.ts`）

其他可选参数（`LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_FLUSH_AT` / `LANGFUSE_FLUSH_INTERVAL` / `LANGFUSE_EXPORT_MODE` / `LANGFUSE_TIMEOUT`）见 `docs/features/tools/langfuse-monitoring.md:49-57` 的表格，按需调。

### 第三类：我想知道系统提示长什么样（`--dump-system-prompt`）

一个常见疑问："Claude 每次开头那长长一串系统提示到底是什么？CLAUDE.md 真的被读进去了吗？" `claude --dump-system-prompt` 会渲染并打印当前模型对应的系统提示，然后直接退出——不进入 REPL、不发任何 API 请求。可选 `--model <name>` 指定模型。用法：

```bash
claude --dump-system-prompt
claude --dump-system-prompt --model claude-sonnet-4-5
```

**注意**：这条 fast-path 受 `feature('DUMP_SYSTEM_PROMPT')` 门控（`src/entrypoints/cli.tsx:93`），主要用于 prompt sensitivity eval 在特定 commit 上提取系统提示。**外部构建产物里这条路径会被编译期剔除**，dev 模式默认开启。如果你跑 `claude --dump-system-prompt` 没有任何输出，多半是当前构建禁用了这个 feature。

### 第四类：我想用调试器接进去（`BUN_INSPECT` + `dev:inspect`）

当 Claude 行为异常、你想看运行时变量值或断点单步，用 Bun 内置的 V8 inspector。两条路径：

- **开发模式**：`bun run dev:inspect`（实际跑 `scripts/dev-debug.ts`）。它读 `BUN_INSPECT` 环境变量作为端口，默认会 await inspector 连上再继续执行，适合断在启动早期。
- **指定端口**：`BUN_INSPECT=9229 bun run dev:inspect`。然后用 Chrome `chrome://inspect` 或 VS Code 的 Bun 调试器连 `ws://localhost:9229`。

注意这是开发自检工具，不是给最终用户的——它要求你能在仓库里 `bun install` 后跑 dev 模式。普通使用者想看"它在做什么"，用前两类的命令就够了。

### 一句话总结这四类

| 我想看 | 用什么 | 代价 |
|--------|--------|------|
| 当前会话的工具调用 | `/debug-tool-call` | 零（读本地 transcript） |
| 历次 API 调用 + token 用量 | `/cost` `/usage` `/stats` | 零（读本地累加器） |
| 完整请求链路（可回放） | Langfuse（`LANGFUSE_*` 环境变量） | 配齐才启用，未配零开销 |
| 系统提示长什么样 | `claude --dump-system-prompt` | feature-gated，外部构建可能被剔除 |
| 运行时变量 / 断点 | `BUN_INSPECT=9229 bun run dev:inspect` | 需要开发环境 |

## 设计视角（写给开发者）

设计大纲原本几乎没有"观测的注入点"这一节——只有第七章锚点提到 `claude.ts:2999`。这一节补上：探针插在哪、为什么插在那里、插这个位置要付出什么代价。读完之后你应该能回答："如果我要加一个新的观测维度（比如工具执行的 p99 latency），应该挂在哪一行、为什么不能挂在那行之前"。

### 为什么 Langfuse 追踪的 `provider` 字段必须从 `getAPIProvider()` 取单一真相源

打开 `src/services/api/claude.ts:2997-2999`：

```ts
// Record LLM observation in Langfuse (no-op if not configured)
recordLLMObservation(options.langfuseTrace ?? null, {
  model: resolvedModel,
  provider: getAPIProvider(),
```

`provider` 字段的值直接来自 `getAPIProvider()`——整个项目里唯一一个"当前用哪个 Provider"的真相源。`getAPIProvider()`（`src/utils/model/providers.ts:15`）按 `modelType` 参数 > `CLAUDE_CODE_USE_*` 环境变量 > firstParty 默认 这条优先级链返回字符串。

**为什么不另起一个变量、不读 `process.env.CLAUDE_CODE_USE_OPENAI` 这种直接环境变量？** 因为 Provider 选择有运行时动态性。`/provider openai` 命令会清掉所有 `CLAUDE_CODE_USE_*` 然后写新的配置（`src/commands/provider.ts:39`），这一步走 `applyConfigEnvironmentVariables` 把配置反推回 `process.env`。如果在 Langfuse 这边直接读 `process.env.CLAUDE_CODE_USE_OPENAI`，就有两个风险：一是和 `/provider` 命令的写入时机产生 race，二是兼容层（OpenAI / Gemini / Grok）各自有不同的 env var 名，硬编码会漏。

**`getAPIProvider()` 作为单一真相源的设计红利**：`/provider` 命令、模型映射（`resolveOpenAIModel` / `resolveGeminiModel` / `resolveGrokModel`）、Langfuse 追踪——三个看似不相关的子系统都从同一个函数取值。只要 `getAPIProvider()` 正确，这三个地方的 Provider 字段必然一致。这是"单一真相源"原则的教科书例子：观测数据天然就应该和决策数据同源，否则面板上看到的 Provider 和实际跑的不一致，追踪就失去了意义。

**代价**：`getAPIProvider()` 不是纯函数，它每次调用都要走一遍优先级链解析。在 `claude.ts:2997` 这个位置（每次 API 响应结束后调用一次）是可接受的——一次 turn 调一次，不在热路径里。但如果你想把 provider 字段加到更高频的观测点（比如每个流式 chunk），就不能再调 `getAPIProvider()` 了，得缓存结果。

### 为什么 `recordLLMObservation` 是 fire-and-forget，不是 await

看 `claude.ts:2997` 的调用——它没有 `await`。`recordLLMObservation` 在 `src/services/langfuse/tracing.ts:85` 是 async function，但调用方不等它。

**为什么？** 观测不该阻塞主路径。Langfuse 走 OTel exporter，批量异步发到远端（`LANGFUSE_FLUSH_AT=20` 默认 20 条 span 攒一批）。如果 `await recordLLMObservation(...)`，每次 API 响应都要等网络 round-trip，用户看到的 TTFT 会暴涨。fire-and-forget 让观测在后台跑，主路径零延迟。

**代价**：观测失败用户感知不到。`tracing.ts:178` 里有一行 `logForDebugging('[langfuse] recordLLMObservation failed: ...')`——失败只打 debug 日志，不抛、不告警。这是有意的：观测是辅助、不是必需。如果 Langfuse 挂了，Claude 本身必须照常工作。`isLangfuseEnabled()`（`src/services/langfuse/client.ts:13`）只检查 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 是否存在——未配置时整条链路是 no-op，连 fire-and-forget 的开销都没有。

### 为什么 `performanceShim` 必须最先 import，OTel 才能正常工作又不会撑爆内存

打开 `src/utils/performanceShim.ts:1-17` 的文件头注释——这是整个项目最强烈的"必须最先 import"约束（在 `src/entrypoints/cli.tsx` 的第一行 import）。背景：Bun 的 `globalThis.performance` 是 JSC 原生 Performance 对象，它的 marks / measures / resource timings 存在一个**永不收缩的 C++ Vector**。长会话（daemon / `/loop`）持续累积，能撑出几百 MB 死容量。

**这跟可观测性有什么关系？** 因为 Langfuse 走 OTel，OTel 的 performance exporter（`otperformance`）会大量调用 `performance.mark()` 和 `performance.measure()` 来打 span 计时。**如果没有 shim**，每个 OTel span 都会在 C++ Vector 里留一条永不释放的 entry——观测越勤，内存爆得越快。这是"观测反向拖垮被观测对象"的经典反例。

`performanceShim` 的解决方案（`performanceShim.ts:127-155`）：保留 `performance.now()` 走原生（快、零内存成本——OTel 用它打时间戳），劫持 `mark` / `measure` / `getEntries` / `clearMarks` 走 JS Map（GC 能回收）。**必须在 React reconciler 和 OTel import 之前装上**，否则它们会捕获原生 Performance 的引用，shim 装了也劫持不到。

**这条约束的代价**：`performanceShim` 永远是 `cli.tsx` 的第一行。如果你写了一个新模块、它在 import 阶段就碰 performance（比如模块顶层 `performance.mark('foo')`），你必须保证它 import 在 shim 之后。这就是为什么 `cli.tsx` 的 import 顺序不能随便调。

### 为什么 query.ts 的 finally 块要兜底 clearMarks

打开 `src/query.ts:367-379`：

```ts
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
  } catch { ... }
```

这是 performanceShim 的第二道防线。**为什么有了 shim 还要在这里兜底？** 因为 sub-agent 会直接 `import query from 'src/query.ts'`，不走 `cli.tsx` 的入口。如果某个 sub-agent 启动路径上 shim 没装上（比如测试环境、或某种奇怪的 import 顺序），原生的 C++ Vector 就会开始累积。`query()` 是所有 turn 的共同出口，在它的 finally 块兜底一次 `clearMarks`，是"shim 万一没装上"的最后保险。

**注释里有意思的一句话**："even after spans are flushed and nullified"——OTel 自己 flush span 之后会把自己持有的引用置空，但**原生 Performance 的 Vector 不会被 OTel 清**。OTel 和 Performance 是两个独立的累积源，OTel 的清理不覆盖 Performance。这是 JSC 实现的细节，也是 shim 必须劫持 mark/measure 而不是依赖 OTel 自己清理的根因。

### 为什么 `--dump-system-prompt` 必须 feature-gated

看 `cli.tsx:90-104` 的 fast-path：`feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt'`。注释说得很清楚："Used by prompt sensitivity evals to extract the system prompt at a specific commit. Ant-only: eliminated from external builds via feature flag."

**为什么这么谨慎？** 系统提示是产品的核心 IP——它定义了 Claude 的行为、约束、工具使用风格。`--dump-system-prompt` 把它原样 stdout 出来，等于把 IP 暴露给任何能跑这个命令的人。feature flag 让这条路径在内部 eval 场景（CI 跑 prompt 回归）可用、在外部构建产物里编译期剔除——DCE 直接把整段 if 删掉，连字符串"`--dump-system-prompt`"都不出现在外部产物里。

**这条路径本身的设计也很克制**：它不发任何 API 请求，只渲染系统提示然后 exit（`cli.tsx:102-103`）。`getSystemPrompt([], model)` 传空 messages 数组——因为系统提示不依赖对话内容，只依赖模型（不同模型的 prompt 略有差异）。如果你想 debug "我的 CLAUDE.md 到底有没有被读进去"，`--dump-system-prompt` 是最直接的工具，但前提是你跑的构建启用了这个 feature。

### 为什么 `/debug-tool-call` 不走远程服务、只读本地 transcript

打开 `src/commands/debug-tool-call/index.ts`——整个命令没有任何网络调用。`getTranscriptPath()`（`index.ts:33-43`）返回本会话的 JSONL 路径，`parseToolCallsFromLog()`（`index.ts:85-119`）逐行 parse JSON、按 `tool_use_id` 配对 use 和 result。

**为什么不走 Langfuse？** 两个原因：

1. **零依赖原则**：`/debug-tool-call` 是诊断工具，诊断工具不能依赖被诊断的东西。如果 Langfuse 挂了、网络断了、配置错了，用户跑 `/debug-tool-call` 还得能看到工具调用——这是排错最后一道防线，必须本地可用。
2. **新鲜度**：transcript 是本会话刚写下去的，Langfuse 是批量异步发的（`LANGFUSE_FLUSH_AT=20`），有延迟。"`/debug-tool-call` 显示的就是刚才那一次"和"显示的是 20 个 span 之前那一次"，对排错体验差别巨大。

**代价**：transcript 文件格式是会话私有的 JSONL schema，没有跨工具兼容承诺。如果未来 transcript 格式改了，`parseToolCallsFromLog` 的字段访问（`block.type === 'tool_use'` / `block.tool_use_id` 等）要同步改。这是"零依赖"换"零网络"的固有成本。

## 两视角如何呼应

用户视角的每一个"我想看什么"，在设计视角都能找到对应的注入点决策：

- **"我想看这次 API 调用烧了多少 token、用的哪个 Provider"**（产品视角的 `/cost` `/usage` + Langfuse 面板）对应 **"`provider` 字段为什么必须从 `getAPIProvider()` 取、`recordLLMObservation` 为什么是 fire-and-forget"**（设计视角）——用户看到的是面板里一行清晰的 `provider: openai`，开发者看到的是"单一真相源 + 异步不阻塞主路径"的双重决策，否则要么面板字段和实际跑的不一致，要么 TTFT 被观测拖慢。
- **"我想看 Claude 的完整请求链路，可回放"**（产品视角的 Langfuse）对应 **"performanceShim 为什么必须最先 import、query.ts 的 finally 块为什么兜底 clearMarks"**（设计视角）——用户看到的是"开了 Langfuse 长跑也不卡"，开发者看到的是"OTel 越勤、JSC 原生 Performance 的 C++ Vector 撑得越快，shim + finally 双保险把累积源掐死在 GC 能回收的 JS 内存里"。如果这个决策做错了，观测本身会把会话拖崩——这是可观测性章节必须双视角覆盖的最强理由。
- **"我想知道系统提示到底长什么样"**（产品视角的 `--dump-system-prompt`）对应 **"为什么这条 fast-path 必须 feature-gated、为什么外部构建编译期剔除"**（设计视角）——用户看到的是"`claude --dump-system-prompt` 一跑就有"，开发者看到的是"系统提示是核心 IP、DCE 在编译期把整段 if 删掉、外部产物连这个字符串都不出现"。
- **"我想看刚才那次工具调用的输入输出"**（产品视角的 `/debug-tool-call`）对应 **"为什么它只读本地 transcript、不走 Langfuse"**（设计视角）——用户看到的是"零延迟、零配置就能用"，开发者看到的是"诊断工具不能依赖被诊断的东西 + 新鲜度优先于跨工具兼容性"的双重原则。
- **"我想断点单步看运行时变量"**（产品视角的 `BUN_INSPECT=9229 bun run dev:inspect`）对应 **"`bun run dev:inspect` 走 `scripts/dev-debug.ts`、读 `BUN_INSPECT` 环境变量决定端口"**（设计视角）——用户看到的是"端口一连、断点就生效"，开发者看到的是"开发自检工具要求仓库可 `bun install`、普通使用者用前几类命令就够了"。

这种呼应关系是"可观测性"必须双视角覆盖的核心原因：用户视角告诉你**怎么看**，设计视角告诉你**探针插在哪里、这个位置会不会反过来把会话拖垮、哪些观测路径受 feature 门控**。两个视角合在一起，才能让使用者正确选择观测工具的层级（被动看屏幕 → `/debug-tool-call` → Langfuse → `--dump-system-prompt` → `dev:inspect`，按介入深度递增），也让开发者在加新观测维度时知道"挂在 `getAPIProvider()` 同源、走 fire-and-forget、注意 performanceShim 已经装好"——而不是把每个探针都重新设计一遍、甚至不小心把观测路径变成新的内存泄漏源。
