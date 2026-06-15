# 第八章：流适配器 —— 让 OpenAI/Gemini/Grok 假装自己是 Anthropic

> 三个 API、三种流格式、一个统一的下游管道——全部靠 async generator 翻译

## async generator 作为格式翻译器

打开 `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts:35`，你会看到一个函数签名：

```ts
export async function* adaptOpenAIStreamToAnthropic(
  stream: AsyncIterable<ChatCompletionChunk>,
  model: string,
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
```

这不是什么中间件框架，也不是事件发射器。一个纯粹的 async generator 函数——接收 OpenAI 的 `ChatCompletionChunk` 流，`yield` 出 Anthropic 的 `BetaRawMessageStreamEvent` 流。没有依赖注入，没有 class 层次，没有状态管理库。整个"翻译"就发生在一个 `for await...of` 循环里。

这种选择有三个理由：

1. **流式翻译天然是 pull 模式**。下游消费者拉一个事件，上游才翻译一个。async generator 恰好是这个语义：`yield` 暂停，`next()` 恢复。不需要 buffer 队列，不需要背压控制——JavaScript 运行时的协程调度本身就是背压机制。

2. **纯函数，无副作用**。适配器不创建网络连接，不操作全局状态，不触发副作用。它唯一的输入是一个 `AsyncIterable`，唯一的输出是 `yield`。这使得 `@ant/model-provider` 包可以是一个纯粹的转换器库（打开 `packages/@ant/model-provider/src/index.ts` 可以确认——导出的全是转换函数和类型，没有一个 client 实例化）。

3. **调试时可以"解耦"测试**。你可以在测试中直接 `for await (const event of adaptOpenAIStreamToAnthropic(mockStream, 'gpt-4'))` 验证每个事件，不需要 mock HTTP 客户端。OpenAI 的 `ChatCompletionChunk` 只是一个普通对象，你可以手写一组 chunk 来精确测试边界条件——比如 `reasoning_content: ''`（空字符串）这种反直觉的 case。

反事实推演：如果用事件发射器（EventEmitter）或者回调模式，下游要么被迫订阅（耦合），要么需要一个 buffer 队列（复杂度）。如果用 Observable（RxJS），整个代码库就多了一个重量级依赖，而且 pull 语义需要额外的 `.forEach()` 适配——async generator 天然就是 pull 的。

## 为什么下游零分支：contentBlocks 累加器不知道上游是什么 Provider

打开 `src/services/api/claude.ts:1865`，你会看到 Anthropic 原生路径的流处理循环：

```ts
const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
// ...
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      contentBlocks[part.index] = { ...part.content_block, input: '' }
      break
```

现在打开 `src/services/api/openai/index.ts:394`，你会看到 OpenAI 兼容路径的几乎相同代码：

```ts
const contentBlocks: Record<number, Record<string, unknown>> = {}
// ...
case 'content_block_start': {
  const idx = event.index
  const cb = event.content_block
  if (cb.type === 'tool_use') {
    contentBlocks[idx] = { ...cb, input: '' }
  } else if (cb.type === 'text') {
    contentBlocks[idx] = { ...cb, text: '' }
```

两条路径处理的都是 `BetaRawMessageStreamEvent`——同一套事件类型、同一套 `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` 序列。差别只在于：Anthropic 路径从 SDK 流直接拿到这些事件，OpenAI/Grok 路径从适配器 generator 拿到这些事件。下游的 switch 语句一个字都不用改。

这是整个多 API 兼容层最关键的设计决策：**把翻译边界推到最上游，让翻译之后的所有代码只认一种"语言"**。

反事实推演：如果让每个下游模块都写 `if (provider === 'openai')` 分支，那 `QueryEngine.ts`、`REPL.tsx`、工具权限系统、token 计费、会话持久化——所有消费流事件的模块都要知道每个 Provider 的特殊格式。加一个新 Provider 就要改几十个文件。现在加一个新 Provider 只需要写一个 adapter generator——大约 200 行代码，零下游改动。

## message_stop 后兜底：零分支叙事的少数例外

"下游零分支"是个好故事，但故事有裂痕。打开 `src/services/api/openai/index.ts:535`：

```ts
// Safety: if stream ended without message_stop, assemble and yield whatever we have
if (partialMessage) {
  for (const output of assembleFinalAssistantOutputs({
    partialMessage,
    contentBlocks,
    tools,
    agentId: options.agentId,
    usage,
    stopReason,
    maxTokens,
  })) {
    yield output
  }
}
```

这段 post-loop 安全回退只存在于 OpenAI 和 Grok 路径，Anthropic 原生路径不需要。原因在于适配器的架构特征：OpenAI 和 Grok 的 `adaptOpenAIStreamToAnthropic` 在 `message_stop` 之前才组装最终的 `contentBlocks`，而网络中断可能导致 `for await` 循环在 `message_stop` yield 之前就退出。适配器本身无法区分"正常结束"和"网络中断"——`AsyncIterable` 的 `done` 标志对两者返回的都是 `true`。

所以在 `message_stop` 正常 yield 之后，OpenAI 路径会 `partialMessage = null`（`src/services/api/openai/index.ts:490`），让 post-loop 回退跳过。如果 `partialMessage` 没被重置，说明 stream 异常中断，回退会把已累积的内容块组装出来。

如果没这个回退会怎样？用户看到的就是：模型明明已经返回了部分文本，但 REPL 屏幕上什么都没出现——因为 `AssistantMessage` 从未被 yield。这种"静默丢失"在交互式 CLI 里是不可接受的。

## @ant/model-provider 作为无副作用转换器库

打开 `packages/@ant/model-provider/src/index.ts`，整个包导出的内容清单如下：

- 转换函数：`anthropicMessagesToOpenAI`、`anthropicToolsToOpenAI`、`adaptOpenAIStreamToAnthropic`、`anthropicMessagesToGemini`、`adaptGeminiStreamToAnthropic`、`resolveOpenAIModel`、`resolveGrokModel`、`resolveGeminiModel`
- 类型：各种 Message、Tool、Usage 类型
- Hooks：`registerHooks`、`registerClientFactories`（依赖注入用，但默认无副作用）

注意这里**没有** `getOpenAIClient()`、没有 `streamGeminiGenerateContent()`、没有任何 HTTP 客户端实例化。这些在 `src/services/api/openai/client.ts` 和 `src/services/api/gemini/client.ts` 里——`src/services/api` 层才是"有副作用"的客户端实例化器。

为什么要拆成两层？

1. **`@ant/model-provider` 可以在没有网络的情况下测试**。它只是一个纯函数库，转换逻辑可以 100% 单元测试覆盖，不需要 mock HTTP。
2. **`src/services/api` 层有 feature flag 依赖**。OpenAI 路径的 `queryModelOpenAI` 内部会检查 `isChatGPTAuthEnabled()`（`src/services/api/openai/index.ts:355`），会调用 `isSearchExtraToolsEnabled()`，这些是运行时条件，不适合放进纯转换库。
3. **客户端缓存是有状态的**。`getOpenAIClient()` 和 `getGrokClient()`（`src/services/api/grok/client.ts:15`）都用模块级 `cachedClient` 变量缓存实例，这是为了复用 TCP 连接。这种有状态的东西不属于"纯转换"层。

反事实推演：如果把 HTTP 客户端和转换函数混在同一个包里，测试转换逻辑就必须要么 mock HTTP（复杂且脆弱），要么真正发网络请求（慢且不可控）。拆分后，`packages/@ant/model-provider/src/shared/__tests__/` 下的测试可以纯内存运行。

## DeepSeek 思维模式的三层兼容

打开 `src/services/api/openai/requestBody.ts:70`，你会看到一个看起来很奇怪的函数返回类型：

```ts
export function buildOpenAIRequestBody(params: {
  // ...
}): ChatCompletionCreateParamsStreaming & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
}
```

返回值同时包含三套互不兼容的 thinking mode 参数——`thinking`、`enable_thinking`、`chat_template_kwargs`。注释解释了原因（`src/services/api/openai/requestBody.ts:63`）：

```ts
// Three thinking-mode formats are sent simultaneously; each endpoint uses the
// format it recognizes and ignores the others:
// - Official DeepSeek API:    `thinking: { type: 'enabled' }`
// - Self-hosted DeepSeek:     `enable_thinking: true` + `chat_template_kwargs: { thinking: true }`
// - MiMo (Xiaomi):            `chat_template_kwargs: { enable_thinking: true }`
```

OpenAI SDK 会把未知的键透传到 HTTP body。所以三套参数同时发送，每个端点各自识别自己认识的字段，忽略其余的。这不是一个优雅的设计，但它解决了一个实际的问题：DeepSeek 的思维模式参数在不同部署版本之间不兼容，用户不应该为了切换部署而改配置。

适配器一侧也有对应的处理。打开 `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts:117`：

```ts
// Handle reasoning_content -> Anthropic thinking block.
// Empty string is a valid signal: DeepSeek v4 thinking mode sometimes
// returns reasoning_content: "" when the model answers directly. The
// empty thinking block must round-trip back to the API in subsequent
// requests, otherwise DeepSeek rejects with 400.
const reasoningContent = (delta as any).reasoning_content
if (reasoningContent != null) {
```

注意 `reasoningContent != null` 而不是 `reasoningContent !== ''`。空字符串是合法的——它告诉适配器"这个请求触发了 thinking mode 但模型选择直接回答"。空 thinking block 必须在下一轮对话中回传，否则 DeepSeek API 会返回 400 错误。这是反编译过程中才能发现的"坑"：OpenAI 官方 API 从不返回 `reasoning_content: ''`，只有 DeepSeek 的特殊行为需要这个处理。

## 为什么 Grok 复用整个 OpenAI 适配器栈

打开 `src/services/api/grok/index.ts:51`，你会看到 Grok 查询函数 `queryModelGrok` 的 import 列表：

```ts
import {
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  adaptOpenAIStreamToAnthropic,
  resolveGrokModel,
} from '@ant/model-provider'
```

五个 import 里四个是 OpenAI 适配器的共享函数。只有 `resolveGrokModel` 是 Grok 特有的。整个消息转换、工具转换、流适配全是复用的。

原因在 `src/services/api/grok/index.ts:47` 的注释里：

```ts
// Grok (xAI) query path. Grok uses an OpenAI-compatible API, so we reuse
// the OpenAI message/tool converters and stream adapter. Only the client
// (different base URL + API key) and model mapping are Grok-specific.
```

xAI 的 Grok API 是 OpenAI Chat Completions 协议的一个实现。它返回的数据结构和 OpenAI 完全一致：`ChatCompletionChunk`，包含 `choices[0].delta.content`、`choices[0].delta.tool_calls` 等。所以消息转换逻辑、流翻译逻辑可以一字不改地复用。

真正"Grok 特有"的只有两处：

1. **模型映射**（`packages/@ant/model-provider/src/providers/grok/modelMapping.ts:51`）：Anthropic 模型名到 Grok 模型名的映射，而且支持 `GROK_MODEL_MAP` 环境变量让用户自定义整个 JSON 映射表——这是 Grok 独有的功能，OpenAI 适配器没有对应设计。
2. **客户端实例化**（`src/services/api/grok/client.ts:15`）：`getGrokClient()` 用 `GROK_API_KEY`（或 `XAI_API_KEY`）和 `https://api.x.ai/v1` 作为默认 base URL，不复用 `getOpenAIClient()`。

注意 `getGrokClient`（`src/services/api/grok/client.ts:15`）的缓存策略和 `getOpenAIClient` 完全一样——模块级 `cachedClient` 变量，有 `clearGrokClientCache()` 清理函数。这是因为在反编译还原时，复用了同一个缓存模式。

反事实推演：如果为 Grok 单独写一套转换器和适配器，代码量大约翻倍（Grok 路径大约 200 行，完整的 OpenAI 路径大约 500 行）。维护两套几乎相同的代码容易产生不一致——比如 OpenAI 路径修了一个 DeepSeek thinking mode 的 bug，Grok 路径忘了同步。复用消除了这种风险。

## ChatGPT 订阅路径：OpenAI 内部的第二个适配器

打开 `src/services/api/openai/index.ts:355`，你会看到一段三元表达式：

```ts
const adaptedStream = isChatGPTAuthEnabled()
  ? adaptResponsesStreamToAnthropic(
      await createChatGPTResponsesStream({ ... }),
      openaiModel,
    )
  : adaptOpenAIStreamToAnthropic(
      await getOpenAIClient({ ... }).chat.completions.create(
        buildOpenAIRequestBody({ ... }),
        { signal },
      ),
      openaiModel,
    )
```

同属 OpenAI 路径，但有两种完全不同的适配器：

- **Chat Completions 路径**：用 `adaptOpenAIStreamToAnthropic`（来自 `@ant/model-provider`），处理标准的 OpenAI Chat Completions 流。
- **Responses API 路径**：用 `adaptResponsesStreamToAnthropic`（`src/services/api/openai/responsesAdapter.ts:1`），处理 ChatGPT 订阅的 Responses API 流。

Responses API 是 OpenAI 内部的新一代 API 格式，和 Chat Completions 有结构性差异。打开 `src/services/api/openai/responsesAdapter.ts:61`，你会看到消息格式完全不同——`role: "user"` 变成 `{ role: "user", content: ... }`，`role: "assistant"` 的 tool_calls 变成独立的 `{ type: "function_call", call_id: ... }` 对象，`role: "system"` 被合并到 `instructions` 字段：

```ts
if (role === 'system' || role === 'developer') {
  const text = textFromContent(record.content)
  if (text) instructions.push(text)
  continue
}
```

流事件格式也不同。Chat Completions 用 `choices[0].delta`，Responses API 用 `response.output_text.delta`、`response.reasoning_text.delta`、`response.output_item.added`、`response.function_call_arguments.delta` 等。`adaptResponsesStreamToAnthropic`（`src/services/api/openai/responsesAdapter.ts:249`）需要把所有这些事件类型翻译成统一的 `BetaRawMessageStreamEvent`。

但关键的相同点是：**翻译完成后，两条路径 yield 出的事件类型完全一致**。所以 `src/services/api/openai/index.ts:407` 的 `for await (const event of adaptedStream)` 循环对两种路径都用同一套 switch 处理。这就是"下游零分支"的力量——即使上游有两个适配器，下游也只需要一份处理逻辑。

为什么不直接把 Responses API 的转换也放进 `@ant/model-provider`？因为 Responses API 的消息格式不是 OpenAI 官方 SDK 类型的一部分——它是一个 ChatGPT 特有的 REST API，没有对应的 TypeScript SDK 类型。`responsesAdapter.ts` 里全部使用 `Record<string, unknown>` 作为类型，因为它在类型层面就是"结构未知的 JSON"。把它留在 `src/services/api` 层更合理。

## 延伸阅读

- 想看 Usage 字段映射与模型映射的优先级链，见 [第九章](./09-usage-model-mapping.md)
- 想看 Provider 调度的完整流程（消息归一化、工具过滤、三路径分发），见 [第七章](./07-provider-dispatch.md)
- 想看模块级 client cache 的陷阱和 clearOpenAIClientCache()，见 [第九章](./09-usage-model-mapping.md)
