# 第七章：7-Provider 抽象层的单一调度点

> 一个函数的精确位置，决定了六个兼容层"结构性跳过" Prompt 缓存和 beta 功能——不需要任何一个 feature flag。

## 为什么有 7 个 Provider，却只有一个调度点

打开 `src/services/api/claude.ts:1344`，你会看到一个由三个连续 `if` + `return` 组成的调度块：

```ts
// claude.ts:1344-1382
if (getAPIProvider() === 'openai') {
  const { queryModelOpenAI } = await import('./openai/index.js')
  yield* queryModelOpenAI(messagesForAPI, systemPrompt, tools, signal, options)
  return
}

if (getAPIProvider() === 'gemini') {
  const { queryModelGemini } = await import('./gemini/index.js')
  yield* queryModelGemini(messagesForAPI, systemPrompt, filteredTools, signal, options, thinkingConfig)
  return
}

if (getAPIProvider() === 'grok') {
  const { queryModelGrok } = await import('./grok/index.js')
  yield* queryModelGrok(messagesForAPI, systemPrompt, filteredTools, signal, options)
  return
}
```

三个非 Anthropic Provider 在这个位置被截走，各自的路径 `yield*` 事件后直接 `return`。执行流不会继续往下走。

往下走的是什么？Anthropic 特有的逻辑——`betas` 注入（`claude.ts:1486`）、`thinking` 配置、`prompt caching`（`claude.ts:1480`）、`buildSystemPromptBlocks`。这些逻辑从第 1384 行一直延伸到函数末尾。兼容层 Provider 因为在第 1344-1382 行就 `return` 了，所以**结构性跳过**了所有 Anthropic 特有的功能。

这就是整个多 API 兼容层最核心的设计决策：不是用 feature flag 去禁用缓存和 beta，而是让调度点的位置天然形成一条分界线。分界线之前的代码是共享的（消息归一化、工具过滤、媒体剔除），分界线之后的代码是 Anthropic 独占的。

如果不这么做——如果缓存逻辑在调度点之前运行——你就需要给每个非 Anthropic Provider 加 `if (provider === 'anthropic')` 的条件包裹。代码会变成条件分支的嵌套地狱，每加一个 Provider 就多一层。

## 调度点之前：共享预处理做了什么

从 `claude.ts` 函数入口到第 1344 行之间，所有 Provider 共用同一条预处理管道。按顺序：

1. **消息归一化**（`claude.ts:1290`）——`normalizeMessagesForAPI(messages, filteredTools)` 把内部消息格式转成 API 需要的格式
2. **工具配对修复**（`claude.ts:1325`）——`ensureToolResultPairing` 修复远程会话恢复时 tool_use/tool_result 不匹配的问题
3. **Advisor 块剥离**（`claude.ts:1328-1330`）——API 没有 advisor beta 头时会拒绝 advisor 块
4. **媒体剔除**（`claude.ts:1336`）——API 拒绝超过 100 个媒体项的请求，静默丢弃最旧的

这四步对七个 Provider 一视同仁。在 Anthropic 原生路径中，这四步之后还会继续走 betas 注入、缓存标记、thinking 配置。但兼容层在第 1344 行就截断了。

## 调度点的不对称：tools vs filteredTools

仔细看第 1344-1382 行的三个分支，你会发现一个刻意的不对称：

- **OpenAI 路径**接收 `tools`（**全池**）
- **Gemini 路径**接收 `filteredTools`（**裁剪后**）
- **Grok 路径**接收 `filteredTools`（**裁剪后**）

`tools` 和 `filteredTools` 的区别在于延迟工具的过滤。打开 `claude.ts:1182-1205`：

```ts
// claude.ts:1183-1205
let filteredTools: Tools

if (useSearchExtraTools) {
  // Never include deferred tools in the API tools array
  filteredTools = tools.filter(tool => {
    if (!deferredToolNames.has(tool.name)) return true
    if (toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME)) return true
    return false
  })
} else {
  filteredTools = tools.filter(
    t => !toolMatchesName(t, SEARCH_EXTRA_TOOLS_TOOL_NAME),
  )
}
```

当 `useSearchExtraTools` 开启时，`filteredTools` 会排除所有延迟工具（除了 `SearchExtraToolsTool` 自身）。这些工具的 schema 不发给 API，只在模型通过 `SearchExtraTools` 发现后才通过 `ExecuteExtraTool` 动态加载。

那为什么 OpenAI 路径需要**全池**？注释在 `claude.ts:1346-1348` 解释了原因：

```ts
// OpenAI emulates Anthropic's dynamic tool loading client-side. It needs
// the full tool pool so SearchExtraToolsTool can search deferred MCP tools that
// were intentionally filtered out of the initial API tool list above.
```

OpenAI 适配器（`src/services/api/openai/index.ts:214`）收到 `tools` 后，在内部做了自己的过滤逻辑（`index.ts:253-263`）。它保留全池是为了让 `SearchExtraToolsTool` 的 prompt 里能看到所有可搜索的 MCP 工具。Gemini 和 Grok 的适配器不需要这个——它们直接用传入的 `filteredTools` 构建请求。

这个不对称恰恰是"调度点位置精确"论点的最强证据：如果调度点在更前面（消息归一化之前），`filteredTools` 还没计算出来，三个路径都无法做延迟工具优化。如果调度点在更后面（Anthropic 逻辑之后），兼容层就需要处理 beta/caching 的副作用。当前这个精确位置——归一化之后、Anthropic 逻辑之前——是唯一的甜蜜点。

## getAPIProvider()：单一真相源

打开 `src/utils/model/providers.ts:15`：

```ts
// providers.ts:15-32
export function getAPIProvider(
  settings: Pick<SettingsJson, 'modelType'> = getInitialSettings(),
): APIProvider {
  const modelType = settings.modelType
  if (modelType === 'openai') return 'openai'
  if (modelType === 'gemini') return 'gemini'
  if (modelType === 'grok') return 'grok'

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) return 'openai'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI)) return 'gemini'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GROK)) return 'grok'

  return 'firstParty'
}
```

这个函数有三层优先级：

1. **`modelType` 参数**——来自 `settings.json` 的持久化配置（`/provider` 命令写入）
2. **`CLAUDE_CODE_USE_*` 环境变量**——Bedrock / Vertex / Foundry 的云 Provider 检测
3. **兜底 `firstParty`**——Anthropic 直连 API

注意 `bedrock`、`vertex`、`foundry` 只通过环境变量检测。打开 `src/commands/provider.ts:127-161`，你会看到 `/provider` 命令对这两类 Provider 的处理不同：

```ts
// provider.ts:129-161
if (
  arg === 'anthropic' ||
  arg === 'openai' ||
  arg === 'gemini' ||
  arg === 'grok'
) {
  // 清除所有云 provider 环境变量
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GROK
  updateSettingsForSource('userSettings', { modelType: arg })
  applyConfigEnvironmentVariables()
  return { type: 'text', value: `API provider set to ${arg}.` }
} else {
  // 云 Provider：只设环境变量，不碰 settings.json
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GROK
  process.env[getEnvVarForProvider(arg)] = '1'
  applyConfigEnvironmentVariables()
  return { type: 'text', value: `API provider set to ${arg} (via environment variable).` }
}
```

`/provider openai` 写 `settings.json`（下次启动仍生效），`/provider bedrock` 只设环境变量（进程退出即消失）。这个区分是有道理的：Bedrock/Vertex/Foundry 的认证依赖 AWS/GCP/Azure 的 credential chain，不适合持久化到用户配置文件。

切换时还有一个重要的原子性设计：**先清除所有竞争 Provider 的标记，再设置目标 Provider**。`/provider unset`（`provider.ts:49-61`）更彻底——同时删除所有 `CLAUDE_CODE_USE_*` 环境变量并清除 `modelType`。

如果不做这个"全部清除再设置"的原子操作，用户从 `openai` 切到 `gemini` 时，`CLAUDE_CODE_USE_OPENAI=1` 可能残留在环境中，导致 `getAPIProvider()` 在 `modelType` 检查之后命中环境变量层，返回错误的 Provider。

## "类型谎言"：4 个 SDK 伪装成 Anthropic

打开 `src/services/api/client.ts:84`，`getAnthropicClient()` 函数返回类型声明为 `Promise<Anthropic>`。但在函数体内部，Bedrock、Vertex、Foundry 三个分支返回的是完全不同的 SDK 实例，通过 `as unknown as Anthropic` 强转：

```ts
// client.ts:189 — Bedrock
return new BedrockClient(bedrockArgs) as unknown as Anthropic

// client.ts:219 — Foundry
return new AnthropicFoundry(foundryArgs) as unknown as Anthropic

// client.ts:297 — Vertex
return new AnthropicVertex(vertexArgs) as unknown as Anthropic
```

注释甚至承认了这个"谎言"：

```ts
// client.ts:188
// we have always been lying about the return type - this doesn't support batching or models
```

`BedrockClient`、`AnthropicFoundry`、`AnthropicVertex` 各自有不同的构造参数、不同的认证方式、不同的 region 处理。但它们的 SDK 都实现了与 `Anthropic` 类似的 `messages.create()` 接口，所以下游代码可以统一调用。这是一个鸭子类型（duck typing）的实用主义选择——不依赖 TypeScript 的类型系统来保证接口兼容，而是靠运行时的 API 契约。

反事实推演：如果为每种 SDK 定义独立的类型（`BedrockClient | AnthropicVertex | AnthropicFoundry | Anthropic`），下游 `claude.ts` 中每处调用都需要联合类型缩窄。代码量至少翻三倍，但安全性收益微乎其微——三个云 SDK 都是 Anthropic 官方发布的，接口一致性有保障。

## isFirstPartyAnthropicBaseUrl() 的 TODO 陷阱

回到 `providers.ts:43-59`：

```ts
// providers.ts:43-59
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  // TODO: 这里会有问题, 只配置了 openai 协议的用户, 按理说会为 true 导致问题
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
```

这个函数在多处被调用，用来判断"当前是否使用 Anthropic 官方 API"。问题在于：当用户只设了 `OPENAI_BASE_URL` 而没设 `ANTHROPIC_BASE_URL` 时，`baseUrl` 为空，函数返回 `true`。但如果 `getAPIProvider()` 返回的是 `openai`（因为 `modelType='openai'` 或 `CLAUDE_CODE_USE_OPENAI=1`），`isFirstPartyAnthropicBaseUrl()` 仍然说"是 firstParty"。

这个不一致可能导致 firstParty 专有的行为（比如 prompt caching 的启用逻辑）泄漏到 OpenAI 兼容路径。TODO 注释已经指出了这个坑，但至今未修复。

## Langfuse 追踪也依赖单一真相源

打开 `claude.ts:2997-2999`：

```ts
// claude.ts:2997-2999
recordLLMObservation(options.langfuseTrace ?? null, {
  model: resolvedModel,
  provider: getAPIProvider(),
  // ...
})
```

Langfuse 的 `recordLLMObservation` 直接调用 `getAPIProvider()` 获取 provider 字段。这意味着所有可观测性数据——token 消耗、延迟、模型使用——都绑定在同一个真相源上。如果有人绕过 `getAPIProvider()` 用其他方式判断当前 Provider（比如直接读 `process.env.CLAUDE_CODE_USE_OPENAI`），Langfuse 追踪就会出现不一致。

## 为什么 Bedrock / Vertex / Foundry 不在调度点

你可能注意到，`claude.ts:1344-1382` 的调度块只处理 `openai`、`gemini`、`grok` 三个 Provider。Bedrock、Vertex、Foundry 去哪了？

答案是：它们在 `getAnthropicClient()`（`client.ts:84`）层面就被替换了。`claude.ts` 调用 `getAnthropicClient()` 时，如果环境变量 `CLAUDE_CODE_USE_BEDROCK=1`，拿到的 `client` 实例已经是 `BedrockClient` 了——但它的类型被伪装成 `Anthropic`。后续的 `client.messages.create()` 调用走的是 Bedrock SDK 的实现。

这意味着 Bedrock/Vertex/Foundry **不走调度点的兼容路径**，而是走 Anthropic 原生路径的全部逻辑——包括 betas、thinking、prompt caching。它们能这么做，是因为这三个 SDK 本来就是 Anthropic 官方发布的，接口与 `Anthropic` SDK 高度一致，不需要消息格式转换。

只有真正"非 Anthropic"的 Provider（OpenAI 协议、Gemini 原生 API、Grok/xAI）才需要独立的流适配器和调度分支。

如果不这么区分，Bedrock/Vertex/Foundry 也要经过 OpenAI 式的消息转换——但它们本来就能接受 Anthropic 原生格式，转换纯属浪费且引入额外的序列化/反序列化误差。

## 延伸阅读

- 想看流适配器如何把 OpenAI/Gemini/Grok 的流格式转成 Anthropic 的 `BetaRawMessageStreamEvent`，见 [第八章：流适配器](./08-stream-adapters.md)
- 想看 Usage 字段映射和模型映射的四级优先级链，见 [第九章：Usage 字段映射与模型映射](./09-usage-model-mapping.md)
- 想看 Feature Flag 如何在构建期替换 `feature()` 调用，见 [第六章：Feature Flag 系统的三个硬约束](./06-feature-flags.md)
