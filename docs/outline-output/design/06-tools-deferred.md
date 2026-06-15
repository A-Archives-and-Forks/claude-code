# 第六章：工具系统的延迟加载与 CORE_TOOLS 白名单

> 60 个工具不塞进同一条 prompt，按需搜索才能活下来。

## 为什么工具不能一股脑全塞给模型

Claude Code 有 62 个工具目录（打开 `/Users/konghayao/code/ai/claude-code/packages/builtin-tools/src/tools/` 你能数到），但每次 API 请求不可能把它们全部放进 `tools` 数组。原因很直接：每个工具的 JSON Schema 定义都要消耗 token。一个 MCP server 提供 20 个工具，每个工具的 `input_schema` 加起来可能吃掉几千 token。如果用户同时接入了 5 个 MCP server，光是工具描述就能占掉 context window 的 10% 以上。

这不是理论推测——代码里有一个自动检测机制。打开 `src/utils/searchExtraTools.ts:45`，你会看到：

```typescript
const DEFAULT_AUTO_SEARCH_EXTRA_TOOLS_PERCENTAGE = 10 // 10%
```

当延迟工具的 schema 总量超过 context window 的 10%，系统自动启用延迟加载。`checkAutoThreshold` 函数（同文件 `:676`）会先用精确的 token 计数 API 衡量延迟工具总量，API 不可用时回退到字符数启发式（每 token 约 2.5 字符，同文件 `:95`）。

如果不做延迟加载，每次请求都携带全部工具 schema，后果是：prompt cache 频繁失效（工具列表一变，缓存键全部作废），模型在几十个工具中注意力稀释，token 账单膨胀。延迟加载让 tools 数组保持稳定——只有核心工具在里面，新工具按需发现。

## CORE_TOOLS：38 个"永远在线"的核心工具

`CORE_TOOLS` 定义在 `src/constants/tools.ts:137`。打开那个文件，你会看到一个 `Set<string>`，注释写得很清楚：

```typescript
/**
 * Core tools that are always loaded with full schema at initialization.
 * These tools are never deferred — they appear in the initial prompt.
 * All other tools (non-core built-in + all MCP tools) are deferred
 * and must be discovered via SearchExtraToolsTool / ExecuteExtraTool.
 */
export const CORE_TOOLS = new Set([
  // File operations
  ...SHELL_TOOL_NAMES, // 'Bash', 'Shell'
  FILE_READ_TOOL_NAME, // 'Read'
  FILE_EDIT_TOOL_NAME, // 'Edit'
  FILE_WRITE_TOOL_NAME, // 'Write'
  GLOB_TOOL_NAME, // 'Glob'
  GREP_TOOL_NAME, // 'Grep'
  NOTEBOOK_EDIT_TOOL_NAME, // 'NotebookEdit'
  // Agent & interaction
  AGENT_TOOL_NAME, // 'Agent'
  ASK_USER_QUESTION_TOOL_NAME, // 'AskUserQuestion'
  // Task management
  TASK_OUTPUT_TOOL_NAME, TASK_STOP_TOOL_NAME,
  TASK_CREATE_TOOL_NAME, TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME, TASK_UPDATE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME, // 'TodoWrite'
  // Planning
  ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_V2_TOOL_NAME,
  VERIFY_PLAN_EXECUTION_TOOL_NAME,
  // Web
  WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME,
  // Code intelligence
  LSP_TOOL_NAME,
  // Skills
  SKILL_TOOL_NAME,
  // Workflow orchestration
  WORKFLOW_TOOL_NAME,
  // Scheduling & monitoring
  SLEEP_TOOL_NAME,
  // Tool discovery (always loaded)
  SEARCH_EXTRA_TOOLS_TOOL_NAME, EXECUTE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

这个白名单的设计哲学是：模型完成日常编程任务所需的最小工具集。文件读写编辑搜索、shell 执行、agent 派发、任务管理、计划模式、web 获取、skill 调用——这些是"95% 的对话只需要这些"的工具。

注意最后三个：`SearchExtraTools`、`ExecuteExtraTool`、`SyntheticOutput`。它们本身是延迟加载机制的入口，所以必须放在核心集里，否则模型就无法发现和使用任何延迟工具——一个自举悖论。

### 反事实推演：如果把所有工具都放进 CORE_TOOLS

假设 `CORE_TOOLS` 包含全部 62 个工具。最直接的后果是每次 API 请求的 `tools` 数组体积翻倍甚至翻三倍。对 prompt cache 的影响是致命的：prompt cache 依赖 tools 列表的稳定性。`claude.ts:393` 的 `assembleToolPool` 注释里明确提到：

> The server's claude_code_system_cache_policy places a global cache breakpoint after the last prefix-matched built-in tool; a flat sort would interleave MCP tools into built-ins and invalidate all downstream cache keys whenever an MCP tool sorts between existing built-ins.

如果所有 MCP 工具都在核心集里，任何一次 MCP server 的连接/断开都会让下游所有缓存键失效。延迟加载把 MCP 工具完全排除在初始 tools 数组之外（`claude.ts:1188-1200`），保持了缓存稳定性。

## isDeferredTool 的判定逻辑

`isDeferredTool` 定义在 `packages/builtin-tools/src/tools/SearchExtraToolsTool/prompt.ts:69`。逻辑出奇地简单：

```typescript
export function isDeferredTool(tool: Tool): boolean {
  // Explicit opt-out via _meta['anthropic/alwaysLoad']
  if (tool.alwaysLoad === true) return false

  // Core tools are always loaded — never deferred
  if (CORE_TOOLS.has(tool.name)) return false

  // Everything else (non-core built-in + all MCP tools) is deferred
  return true
}
```

三条规则，没有灰色地带。要么你在 `CORE_TOOLS` 里，要么你设置了 `alwaysLoad: true`（一种 opt-out 机制，给需要特殊处理的工具留了口子），否则你就是延迟工具。所有 MCP 工具天然是延迟工具——MCP 工具的 `name` 以 `mcp__` 开头，永远不会出现在 `CORE_TOOLS` 里。

这个函数在 `claude.ts:1160-1166` 被调用时有一个性能注释：

```typescript
// Precompute once — isDeferredTool does 2 GrowthBook lookups per call
const deferredToolNames = new Set<string>()
if (useSearchExtraTools) {
  for (const t of tools) {
    if (isDeferredTool(t)) deferredToolNames.add(t.name)
  }
}
```

每次 `isDeferredTool` 调用内部会触发 GrowthBook（feature flag 平台）的远程配置查询，所以对整个工具列表遍历时必须预计算一次，缓存到 Set 里。这是反编译产物的一个典型痕迹——原版 Anthropic 代码依赖的 GrowthBook 实例在这个 fork 里被替换为空实现，但查询调用的结构保留了下来。

## SearchExtraToolsTool：两步发现协议

延迟工具的发现不是一次性完成的——它是一个两步协议，写死在 `SearchExtraToolsTool` 的 prompt 里（`prompt.ts:26-60`）。

第一步：模型调用 `SearchExtraTools`，传入查询字符串。系统搜索延迟工具池，返回匹配的工具名列表。

第二步：模型调用 `ExecuteExtraTool`，传入目标工具名和参数。系统从全局工具注册表中找到该工具，直接执行。

打开 `packages/builtin-tools/src/tools/SearchExtraToolsTool/SearchExtraToolsTool.ts:380`，你会看到第一步中 `select:` 前缀的处理：

```typescript
const selectMatch = query.match(/^select:(.+)$/i)
if (selectMatch) {
  const requested = selectMatch[1]!
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const found: string[] = []
  const alreadyLoaded: string[] = []
  const missing: string[] = []
  for (const toolName of requested) {
    const deferredMatch = findToolByName(deferredTools, toolName)
    const fullMatch = deferredMatch ?? findToolByName(tools, toolName)
    if (fullMatch) {
      if (!found.includes(fullMatch.name)) {
        found.push(fullMatch.name)
        if (!deferredMatch) {
          alreadyLoaded.push(fullMatch.name)
        }
      }
    } else {
      missing.push(toolName)
    }
  }
```

一个值得注意的细节：如果模型尝试 `select:` 一个已经是核心工具的名字，系统不会报错，而是把它放进 `alreadyLoaded` 列表返回。`mapToolResultToToolResultBlockParam` 方法（同文件 `:542`）会明确告诉模型：

```
Already loaded as core tool(s): Read. Call these directly using your normal tool interface — do NOT use ExecuteExtraTool for them.
```

这不是防御性编程的冗余——它防止了模型在压缩（compact）后丢失上下文时，对已知工具发起无意义的搜索-执行循环。反编译产物中这种"防止模型犯蠢"的引导文本随处可见，说明原版代码在生产环境中确实遇到了模型行为退化的问题。

### 查询语法：四种子模式

`SearchExtraToolsTool` 支持四种查询格式，定义在 `prompt.ts:53-56`：

- `"select:CronCreate"` — 精确选择，支持逗号分隔多选
- `"select:CronCreate,CronList"` — 多工具一次发现
- `"discover:schedule cron job"` — 纯发现模式，返回工具名 + 描述 + schema，不触发加载
- `"notebook jupyter"` — 关键词搜索，TF-IDF 语义匹配
- `"+slack send"` — 前缀 `+` 表示必须包含的词，类似搜索引擎的强制匹配

`discover:` 模式的设计意图很巧妙：模型可以先了解一个延迟工具的 schema 结构，再决定是否执行。打开 `SearchExtraToolsTool.ts:444`，discover 分支会返回 TF-IDF 搜索结果，包含每个工具的名字、描述和完整 JSON Schema——模型读完这些信息后再构建正确的参数调用 `ExecuteExtraTool`。

## TF-IDF 索引：复用 skill 搜索的算法引擎

工具搜索和 skill 搜索共享同一套 TF-IDF 算法。打开 `src/services/searchExtraTools/toolIndex.ts:1`，导入语句直接指向 skill 搜索模块：

```typescript
import {
  tokenizeAndStem,
  computeWeightedTf,
  computeIdf,
  cosineSimilarity,
} from '../skillSearch/localSearch.js'
```

这不是代码复用——这是两个子系统在同一算法上的独立实例化。`toolIndex.ts` 的 `buildToolIndex` 函数（`:80`）对每个延迟工具提取三组 token：工具名（权重 3.0）、searchHint（权重 2.5）、描述文本（权重 1.0），然后用 TF-IDF 计算向量：

```typescript
const TOOL_FIELD_WEIGHT = {
  name: 3.0,
  searchHint: 2.5,
  description: 1.0,
} as const
```

工具名权重最高是合理的——模型通常知道它要找什么工具（比如 "CronCreate"），问题在于工具名不在核心集里。searchHint 是工具开发者手写的简短能力描述，信号密度比完整描述高得多，所以权重也高于 description。

### 为什么 skill prefetch 和 tool prefetch 用独立的去重集合

打开 `src/services/searchExtraTools/prefetch.ts:24`：

```typescript
const discoveredToolsThisSession = new Set<string>()
```

这个 Set 跟踪当前会话中已经发现的延迟工具，防止重复推荐。它有容量上限（`SESSION_TRACKING_MAX = 500`，超过后裁剪到 `SESSION_TRACKING_TRIM_TO = 400`，同文件 `:22-23`），防止长会话内存泄漏。

CLAUDE.md 里明确指出这个 Set 与 skill prefetch 的去重集合互不影响。为什么？因为两个子系统的生命周期和业务语义不同。工具发现是 per-turn 的——模型每次调用 `SearchExtraTools` 都应该能看到全量延迟工具池，只是已经发现的不会重复推荐。Skill 发现是 per-session 的——一个 skill 一旦推荐过，整会话内都不应该再弹。如果共用一个 Set，工具发现可能会意外吞掉 skill 推荐，或者反过来。两个 Set 各管各的，互不干扰。

### CJK 大字符集的特殊处理

`toolIndex.ts:182-188` 有一个针对中日韩文字的特殊处理：

```typescript
if (queryCjkTokens.length > 0 && score > 0) {
  const matchingCjk = queryCjkTokens.filter(t => entry.tfVector.has(t))
  if (matchingCjk.length < CJK_MIN_BIGRAM_MATCHES) {
    const hasAsciiMatch = queryAsciiTokens.some(t => entry.tfVector.has(t))
    if (!hasAsciiMatch) score = 0
  }
}
```

CJK 文字的特征是单字匹配噪音极大（一个 "发" 字可能匹配到 "开发"、"发现"、"发明" 等完全不同的概念），所以要求至少 2 个 CJK token 同时匹配（`CJK_MIN_BIGRAM_MATCHES = 2`）才认可搜索结果。这是一个从生产经验中总结出来的启发式——纯粹基于拉丁文字设计的 TF-IDF 算法在 CJK 环境下会产生大量误匹配。

## claude.ts 的过滤点：延迟工具如何被排除在 API 请求之外

实际的延迟加载执行点在 `src/services/api/claude.ts:1188-1205`：

```typescript
if (useSearchExtraTools) {
  // Never include deferred tools in the API tools array — they are invoked
  // via ExecuteExtraTool which looks them up from the global tool registry
  // at runtime. Keeping the tools array stable preserves the prompt cache
  // across turns (discovered tools no longer bloat the tools JSON).
  filteredTools = tools.filter(tool => {
    // Always include non-deferred tools (core tools)
    if (!deferredToolNames.has(tool.name)) return true
    // Always include SearchExtraToolsTool (so it can discover more tools)
    if (toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME)) return true
    // All other deferred tools are excluded — use ExecuteExtraTool instead
    return false
  })
} else {
  filteredTools = tools.filter(
    t => !toolMatchesName(t, SEARCH_EXTRA_TOOLS_TOOL_NAME),
  )
}
```

这段代码揭示了延迟加载的核心权衡：延迟工具的 schema 完全不发送给模型，模型只能通过 `SearchExtraTools` 获取工具名，通过 `ExecuteExtraTool` 间接调用。这意味着模型在第一次使用某个延迟工具时，没有该工具的参数 schema 作为参考——它必须依赖 `SearchExtraTools` 返回的文本描述来猜测参数结构。

这就是为什么 `discover:` 查询模式存在：它让模型在执行前先看 schema。也是为什么 `SearchExtraToolsTool.ts:542-600` 的 `mapToolResultToToolResultBlockParam` 方法会返回结构化的引导文本，而不是让模型自由发挥。

## feature-gated 工具：另一种"延迟"

延迟加载和 feature flag 是两个独立的机制，但它们在 `tools.ts` 中产生了有趣的交汇。打开 `src/tools.ts:16-60`，你会看到大量这样的模式：

```typescript
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('@claude-code-best/builtin-tools/tools/SleepTool/SleepTool.js')
        .SleepTool
    : null

const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE')
  ? require('@claude-code-best/builtin-tools/tools/RemoteTriggerTool/RemoteTriggerTool.js')
      .RemoteTriggerTool
  : null
```

这是 feature flag 的条件导入模式：`feature('X')` 为真时 require 模块，否则为 null。在 `getAllBaseTools()`（同文件 `:217`）中，这些 null 值通过展开运算符被过滤掉：

```typescript
...(SleepTool ? [SleepTool] : []),
...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
```

注意这里用了 `require()` 而不是 ESM `import`。原因是 `feature()` 只能在 `if` 条件中直接使用（Bun 编译器的 DCE 限制，详见第五章），而 ESM import 是静态的，无法放在条件分支里。`require()` 是动态的，可以被条件包裹。这种反编译产物特有的模式在整个 `tools.ts` 中反复出现——原始代码可能用了其他方式实现条件加载，但反编译后只能还原为 `require()` + null 检查。

### 如果不用 require() 而用静态 import

假设把所有工具改为顶层静态 import：

```typescript
import { SleepTool } from '@claude-code-best/builtin-tools/tools/SleepTool/SleepTool.js'
import { RemoteTriggerTool } from '@claude-code-best/builtin-tools/tools/RemoteTriggerTool/RemoteTriggerTool.js'
```

即使 `feature()` 返回 false，这些模块仍然会被加载和初始化。对于大部分工具来说这不是问题，但某些工具在 import 时就会执行副作用（比如注册全局事件监听器或读取环境变量）。`require()` + null 检查确保了 feature 关闭时这些模块的代码完全不会执行。

此外，Bun 的 DCE（Dead Code Elimination）依赖 `feature()` 在 AST 层面被识别。静态 import 无法被 DCE 裁剪，意味着所有工具代码都会打包进产物——即使永远不会被调用。对于目标是按需加载 600+ chunk 的项目来说，这是不可接受的。

## SyntheticOutputTool：延迟加载体系中的特殊角色

`SyntheticOutputTool`（`packages/builtin-tools/src/tools/SyntheticOutputTool/SyntheticOutputTool.ts`）是一个看起来很奇怪的工具。它的名字叫 "StructuredOutput"，功能是"接受任意 JSON 输入并原样返回"。

打开 `SyntheticOutputTool.ts:28`：

```typescript
export const SyntheticOutputTool = buildTool({
  isMcp: false,
  isEnabled() {
    return true
  },
  isReadOnly() {
    return true
  },
  name: SYNTHETIC_OUTPUT_TOOL_NAME,
  searchHint: 'return the final response as structured JSON',
  async call(input) {
    return {
      data: 'Structured output provided successfully',
      structured_output: input,
    }
  },
})
```

它之所以在 `CORE_TOOLS` 中，是因为它服务于非交互式场景（pipe mode、SDK 调用）。当外部调用者通过 `agent({schema: ...})` 传入一个 JSON schema 时，系统会用 `createSyntheticOutputTool`（同文件 `:116`）创建一个带有 Ajv 验证的版本：

```typescript
export function createSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  const cached = toolCache.get(jsonSchema)
  if (cached) return cached

  const result = buildSyntheticOutputTool(jsonSchema)
  toolCache.set(jsonSchema, result)
  return result
}
```

注意这里的 `WeakMap` 缓存（同文件 `:109`）——同一个 schema 对象的重复创建会被跳过。注释说明了原因：Workflow 脚本在一次运行中可能调用 `agent({schema: ...})` 30-80 次，没有缓存的话每次都要做 `new Ajv() + validateSchema() + compile()`（约 1.4ms 的 JIT 编译），80 次调用就是 ~110ms 的 Ajv 开销；有缓存后降到 ~4ms。

这个工具在延迟加载体系中的角色是：它是唯一一个在核心集中但"按需配置"的工具。其他核心工具的 schema 是固定的，`SyntheticOutputTool` 的 schema 可以动态注入。

## 三种工具搜索模式的切换

`src/utils/searchExtraTools.ts:159-192` 定义了三种工具搜索模式：

| 模式 | 触发条件 | 行为 |
|------|----------|------|
| `tst` | `ENABLE_SEARCH_EXTRA_TOOLS=true` 或默认 | 始终延迟加载非核心工具 |
| `tst-auto` | `ENABLE_SEARCH_EXTRA_TOOLS=auto` 或 `auto:N` | 当延迟工具 schema 超过 context window N% 时才启用 |
| `standard` | `ENABLE_SEARCH_EXTRA_TOOLS=false` | 不延迟加载，所有工具直接暴露 |

默认行为是 `tst`——始终延迟加载。这意味着即使只有 2 个延迟工具，它们的 schema 也不会出现在初始请求中。`tst-auto` 模式给了用户一个折中选择：延迟工具少的时候全量加载（省去 SearchExtraTools 的额外一轮调用），多了才启用延迟。

`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 环境变量仍然作为延迟加载的终极开关——即使 `ENABLE_SEARCH_EXTRA_TOOLS` 未设置，只要这个变量为 true，就强制进入 `standard` 模式。这是历史遗留：早期版本依赖 Anthropic API 的 `tool_reference` beta header 实现延迟加载，禁用 beta 就等于禁用延迟。现在 beta header 已经移除（统一使用自建的 TF-IDF + keyword 搜索），但这个开关被保留了下来。

## prefetch：提前预测模型需要什么工具

`prefetch.ts` 实现了一个"预取"机制：在模型的 assistant turn 开始之前，系统就会根据消息历史预测模型可能需要哪些延迟工具。

打开 `src/services/searchExtraTools/prefetch.ts:94`：

```typescript
export async function startSearchExtraToolsPrefetch(
  tools: Tools,
  messages: Message[],
): Promise<Attachment[]> {
  const startedAt = Date.now()
  const queryText = extractQueryFromMessages(null, messages)
  if (!queryText.trim()) return []

  try {
    const index = await getToolIndex(tools)
    const results = searchTools(queryText, index, 3)

    const newResults = results.filter(
      r => !discoveredToolsThisSession.has(r.name),
    )
    if (newResults.length === 0) return []
```

注意 `extractQueryFromMessages`（从 `skillSearch/prefetch.ts` 导入的共享函数）从消息历史中提取查询文本，然后对延迟工具索引做搜索。预取结果最多返回 3 个匹配（`searchTools(queryText, index, 3)`），过滤掉已发现的工具，然后以 `tool_discovery` attachment 形式注入对话。

这个预取机制有一个被有意禁用的功能——turn-zero 预取（同文件 `:138-146`）：

```typescript
export async function getTurnZeroSearchExtraToolsPrefetch(
  _input: string,
  _tools: Tools,
): Promise<Attachment | null> {
  // Disabled: turn-zero user-input tool recommendations caused frequent
  // popups. Inter-turn discovery (startSearchExtraToolsPrefetch) is still
  // active and provides non-intrusive suggestions during assistant turns.
  return null
}
```

注释很直白：用户输入第一条消息时就弹出工具推荐太烦了。这说明团队在"信息前置"和"用户打扰"之间做过权衡——预取可以保留在 assistant turn 之间（模型正在思考时悄悄准备），但不能在用户刚打字时就弹出来。

## 工具池的排序与缓存稳定性

`src/tools.ts:376-398` 的 `assembleToolPool` 函数有一个精心设计的排序策略：

```typescript
const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
return uniqBy(
  [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
  'name',
)
```

内置工具排在前面，MCP 工具排在后面，各自按名称排序。`uniqBy` 保证同名工具以内置优先。注释解释了原因：

> The server's claude_code_system_cache_policy places a global cache breakpoint after the last prefix-matched built-in tool; a flat sort would interleave MCP tools into built-ins and invalidate all downstream cache keys whenever an MCP tool sorts between existing built-ins.

如果用一个扁平的全局排序，MCP 工具可能插在内置工具之间（比如 `mcp__github__create_issue` 排在 `FileEdit` 和 `FileRead` 之间）。每增加或删除一个 MCP 工具，所有排在它后面的工具的缓存键都会变。分区排序让内置工具的缓存完全不受 MCP 工具变动的影响。

## 延伸阅读

- 想看 feature flag 系统如何约束 `require()` 条件导入的写法，见 [第五章：Feature Flag 系统的三个硬约束](./05-feature-flags.md)
- 想看 prompt cache 如何依赖工具列表的稳定性，见 [第七章：7-Provider 抽象层的单一调度点](./07-provider-dispatch.md)
- 想看 skill prefetch 与 tool prefetch 共享 `extractQueryFromMessages` 的设计，见 [第十二章：ACP / Bridge / Daemon](./12-long-running-modes.md) 中的 ACP 权限管道段
- 想看 `performanceShim` 如何在 JSC 内存约束下保护长会话的 tools 处理，见 [第三章：performanceShim](./03-performance-shim.md)
