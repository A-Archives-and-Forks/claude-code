# 第九章：Usage 字段映射与模型映射的优先级链

> 四级优先级链、ANSI 清理、模块级缓存陷阱——兼容层里那些不能省的"丑"代码

## 模型映射不是查表那么简单

三个兼容层（OpenAI、Gemini、Grok）各自有一个 `resolve<Model>Model` 函数，都遵循同一套四级优先级链。但"遵循"的方式有微妙分歧，正是这些分歧暴露了每个 Provider 的历史包袱和设计权衡。

打开 `packages/@ant/model-provider/src/providers/openai/modelMapping.ts:36`，你会看到 `resolveOpenAIModel` 的完整实现：

```ts
export function resolveOpenAIModel(anthropicModel: string): string {
  if (process.env.OPENAI_MODEL) {
    return process.env.OPENAI_MODEL
  }

  const cleanModel = anthropicModel.replace(/\[1m\]$/, '')

  const family = getModelFamily(cleanModel)
  if (family) {
    const openaiEnvVar = `OPENAI_DEFAULT_${family.toUpperCase()}_MODEL`
    const openaiOverride = process.env[openaiEnvVar]
    if (openaiOverride) return openaiOverride

    const anthropicEnvVar = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
    const anthropicOverride = process.env[anthropicEnvVar]
    if (anthropicOverride) return anthropicOverride
  }

  return DEFAULT_MODEL_MAP[cleanModel] ?? cleanModel
}
```

优先级链：`OPENAI_MODEL` > `OPENAI_DEFAULT_{FAMILY}_MODEL` > `ANTHROPIC_DEFAULT_{FAMILY}_MODEL` > `DEFAULT_MODEL_MAP[cleanModel]` > `cleanModel`（passthrough）。

注意第五级：当查表也找不到时，OpenAI 选择把模型名原样传过去。这是一个隐式契约——Ollama、vLLM 等本地端点会收到 `claude-sonnet-4-20250514` 这样的 Anthropic 模型名，它们当然不认识，但也不会崩溃（大不了返回 404）。这个 passthrough 是有意为之，让用户不需要为每个自定义端点手动配置映射。

### 正则推断模型家族

三个 Provider 共用同一个 `getModelFamily` 函数，逻辑完全一样：

```ts
function getModelFamily(model: string): 'haiku' | 'sonnet' | 'opus' | null {
  if (/haiku/i.test(model)) return 'haiku'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return null
}
```

用正则从模型名字符串推断家族，而不是查表。为什么？因为模型名不是静态的——`claude-sonnet-4-20250514`、`claude-sonnet-4-6`、`claude-3-5-sonnet-20241022` 全是不同的 key，但都是 sonnet。如果用精确匹配，每次新增模型版本都要更新三个映射表。正则 `/haiku|sonnet|opus/i` 是一个把"Anthropic 模型名中嵌入家族信息"这个约定利用到极致的 hack。

如果不这么做，每当 Anthropic 发布新模型（opUs 4.7、sonnet 5...），三个 Provider 的映射表都要同步更新。反编译重建过程中这种多处同步是最容易遗漏的地方——一个表更新了、另一个忘了，就会导致某个 Provider 下 opus 请求被错误地映射成默认模型。

注意检查顺序：haiku 先于 opus、opus 先于 sonnet。如果顺序反过来，一个包含 `opus` 的模型名会被错误地先匹配到 `sonnet`。但等等——为什么 `opus` 会被匹配到 `sonnet`？因为 `sonnet` 不包含 `opus` 子串。这个顺序实际上目前不会造成误匹配，但如果未来有一个叫 `super-sonnet-opus` 的模型呢？正则 `test()` 是子串匹配，不是词匹配——这个陷阱目前 dormant，但很脆弱。

## Gemini：唯一会硬抛异常的映射

打开 `packages/@ant/model-provider/src/providers/gemini/modelMapping.ts:8`，对比 OpenAI 的同一个函数：

```ts
export function resolveGeminiModel(anthropicModel: string): string {
  if (process.env.GEMINI_MODEL) {
    return process.env.GEMINI_MODEL
  }

  const cleanModel = anthropicModel.replace(/\[1m\]$/i, '')
  const family = getModelFamily(cleanModel)

  if (!family) {
    return cleanModel
  }

  const geminiEnvVar = `GEMINI_DEFAULT_${family.toUpperCase()}_MODEL`
  const geminiModel = process.env[geminiEnvVar]
  if (geminiModel) {
    return geminiModel
  }

  const sharedEnvVar = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
  const resolvedModel = process.env[sharedEnvVar]
  if (resolvedModel) {
    return resolvedModel
  }

  throw new Error(
    `Gemini provider requires GEMINI_MODEL or ${geminiEnvVar} (or ${sharedEnvVar} for backward compatibility) to be configured.`,
  )
}
```

关键差异：Gemini 在四级优先级全部 miss 时**直接 throw Error**。OpenAI passthrough、Grok 也有 `DEFAULT_FAMILY_MAP` 兜底，只有 Gemini 拒绝猜测。

为什么？因为 Gemini 的模型命名空间和 Anthropic 完全不同——把 `claude-sonnet-4-20250514` 传给 Gemini API 会得到一个明确的 400 错误，而不是"用默认模型"的 graceful degradation。Gemini 团队选择 fail-fast：与其让用户困惑于一个他们没配置过的模型在 Gemini 上跑出不可预期的结果，不如直接报错，强制用户配置映射。

反事实推演：如果 Gemini 也做 passthrough，用户配好了 `CLAUDE_CODE_USE_GEMINI=1` 和 `GEMINI_API_KEY`，但忘了配 `GEMINI_MODEL`，请求会发送到 Google 的 API endpoint，API 返回 400 或 404，错误信息可能被 OpenAI stream adapter 捕获并包装成一个令人困惑的 "API Error: model not found"。用户会以为 Gemini 不可用，而不是"我忘了配模型映射"。显式 throw 给出了精确的错误信息，直接指向解决方案。

## Grok：唯一支持用户自定义 JSON 映射的 Provider

打开 `packages/@ant/model-provider/src/providers/grok/modelMapping.ts:34`，你会看到一个其他 Provider 都没有的特性：

```ts
function getUserModelMap(): Record<string, string> | null {
  const raw = process.env.GROK_MODEL_MAP
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    // ignore invalid JSON
  }
  return null
}
```

通过 `GROK_MODEL_MAP` 环境变量，用户可以传入一个完整的 JSON 对象来自定义映射。在 `resolveGrokModel` 中，这个用户映射被插在 `GROK_MODEL` 全局覆盖和 `GROK_DEFAULT_{FAMILY}_MODEL` 家族覆盖之间（`modelMapping.ts:59`），形成了一个五级优先级链：

`GROK_MODEL` > `GROK_MODEL_MAP[family]` > `GROK_DEFAULT_{FAMILY}_MODEL` > `ANTHROPIC_DEFAULT_{FAMILY}_MODEL` > `DEFAULT_MODEL_MAP` > `DEFAULT_FAMILY_MAP` > `cleanModel`

为什么只有 Grok 有这个？xAI 的 Grok 模型更新频繁（`grok-3-mini-fast` -> `grok-4.20-reasoning`），且用户经常在多个 Grok 模型之间切换做 A/B 测试。一个 JSON 环境变量比四个 `GROK_DEFAULT_*_MODEL` 变量更灵活。这是一个"用户需求驱动"的 API 设计，而不是架构统一性的产物。

注意 `catch` 分支的静默忽略——如果 `GROK_MODEL_MAP` 不是合法 JSON，函数返回 `null`，相当于用户没有配置映射。没有 warning、没有 log。这种静默失败在 CLI 工具中很常见：在非交互模式下向 stderr 输出 warning 可能会干扰下游脚本。

## 防御性清理：ANSI 加粗后缀

三个 `resolve` 函数开头都有同一行：

```ts
const cleanModel = anthropicModel.replace(/\[1m\]$/, '')
```

这剥离了模型名末尾的 ANSI 终端加粗转义序列 `\x1b[1m`。为什么会有人在模型名里嵌入 ANSI 代码？

答案在 REPL 屏幕的显示逻辑里——某些 UI 组件会把模型名渲染成粗体用于高亮显示，但如果后续代码不小心把显示值当成了数据值传进了 API 调用链，模型名就会带上 `\x1b[1m` 后缀。这行 `replace` 是一个防御性修复：它假设 bug 在上游（显示逻辑），在下游（API 调用）拦截。

OpenAI 的版本用的是不带 `i` flag 的 `/\[1m\]$/`，而 Gemini 用了 `/\[1m\]$/i`。大小写不敏感 vs 敏感的差异，说明这个清理逻辑是在不同时间由不同人添加的，没有统一。这正是反编译重建项目的典型特征——同一个 bug 被修了两次，修法不完全一致。

## 模块级 Client 缓存：改 API key 必须重启

打开 `src/services/api/openai/client.ts:15`，你会看到：

```ts
let cachedClient: OpenAI | null = null

export function getOpenAIClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  if (cachedClient) return cachedClient
  // ... 创建 client ...
  if (!options?.fetchOverride) {
    cachedClient = client
  }
  return client
}
```

模块级变量 `cachedClient` 在第一次调用后持住，后续调用直接返回。问题在于：`apiKey` 和 `baseURL` 在构造时就固化在 OpenAI 实例内部了。如果用户在会话中途修改了 `OPENAI_API_KEY` 环境变量，`getOpenAIClient()` 仍然返回旧 client。

对比 `src/services/api/client.ts:84` 的 `getAnthropicClient`——它**每次调用都创建新实例**，不缓存。因为 Anthropic client 的构造逻辑较重（OAuth token 刷新、AWS credential 获取），但每次调用都重新读取环境变量。两种设计的根本差异是：OpenAI/Grok 用缓存换取快速启动，Anthropic 用无缓存换取配置热更新。

Grok 的 `src/services/api/grok/client.ts:13` 是同样的模式——`let cachedClient: OpenAI | null = null`，同样有 `clearGrokClientCache()` 导出。

这就是为什么大纲里有一条特别提示：会话中改 API key 必须调用 `clearOpenAIClientCache()` 或重启。`/login` 命令在写入新凭证后，内部确实调用了 `clearOpenAIClientCache()` 和 `clearGrokClientCache()`，但如果用户直接 `export OPENAI_API_KEY=xxx` 而不走 `/login`，缓存就不会被清除。

如果不做模块级缓存，每次 API 调用都要 `new OpenAI(...)` 重新建立 HTTP 连接池，对于流式响应（每个 turn 可能持续数十秒），连接复用的收益是真实的。但缓存带来的配置不可变副作用，是这种设计必须付出的代价。

## Usage 字段映射：镜像设计打破"下游零分支"叙事

第八章讲流适配器时强调了一个叙事：下游代码不知道上游是什么 Provider，`contentBlocks` 累加器完全零分支。但在 Usage 字段映射上，这个叙事有一个刻意设计的例外。

打开 `src/services/api/openai/openaiShared.ts:18`，你会看到 `updateOpenAIUsage`：

```ts
export function updateOpenAIUsage(
  current: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  },
  delta: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
): typeof current {
  return {
    input_tokens: delta.input_tokens ?? current.input_tokens,
    output_tokens: delta.output_tokens ?? current.output_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens !== undefined &&
      delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : current.cache_creation_input_tokens,
    cache_read_input_tokens:
      delta.cache_read_input_tokens !== undefined &&
      delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : current.cache_read_input_tokens,
  }
}
```

再看 `src/services/api/claude.ts:3084` 的 `updateUsage`（Anthropic 原生路径）：

```ts
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: BetaMessageDeltaUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    // ... 更多字段
  }
}
```

两者是**镜像函数**——`openaiShared.ts` 的注释直接说 "Mirrors updateUsage() in claude.ts"。但为什么要维护两份几乎相同的函数，而不是抽一个共享的 `mergeUsage`？

答案是语义差异。Anthropic 的 streaming API 返回**累积值**（`message_start` 里 input_tokens 是总量，后续 `message_delta` 里的 input_tokens 永远是 0 或同一个值）。而 OpenAI 兼容层的流适配器把 Chat Completions 的 delta usage 转换成 Anthropic 格式时，某些事件可能携带显式的 0 值。`openaiShared.ts:35` 的 `> 0` guard 确保增量 0 不会覆盖掉之前累积的真实值。

`claude.ts:3079` 的注释精确解释了这个设计动机：

> Input-related tokens (input_tokens, cache_creation_input_tokens, cache_read_input_tokens) are typically set in message_start and remain constant. message_delta events may send explicit 0 values for these fields, which should not overwrite the values from message_start.

这是"下游零分支"叙事里唯一需要针对性修补的点。`contentBlocks` 累加器不需要区分 Provider，但 Usage 累加必须区分——因为 Anthropic 的 `message_delta` 携带 0 值是正常行为，OpenAI 适配器如果也发 0 值，必须被正确处理。

如果把这个 `> 0` guard 去掉，一次 OpenAI 请求中如果 `message_delta` 携带了 `cache_creation_input_tokens: 0`，累积的缓存 token 计数就会被静默清零。用户会看到 `/cost` 报告的缓存命中数突然从数百 tokens 跳到 0，但 API 实际上已经命中了缓存。这种"数字撒谎"比报错更危险，因为用户不会主动排查一个看起来正常但偏低的数字。

### cache 字段保留策略的深层原因

`cache_creation_input_tokens` 和 `cache_read_input_tokens` 是 Anthropic 的 prompt caching 特有字段。OpenAI 和 Grok 根本没有这个概念。那为什么 OpenAI 兼容层的 usage 对象里还要有这两个字段？

看 `src/services/api/openai/index.ts:129`，Grok 路径的 usage 初始化就包含了这两个字段：

```ts
let usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}
```

因为这两个字段会在 Langfuse 追踪、`/cost` 计算、token 统计等下游消费者中被引用。如果 OpenAI 路径的 usage 对象缺少这两个字段，下游代码要么需要 Provider 分支，要么在访问时 undefined。让所有 Provider 的 usage 结构保持一致，下游才能继续"零分支"。

这也是为什么 `openaiShared.ts` 要用 `> 0` guard 而不是简单的 `?? current`。`??` 只检查 `null` 和 `undefined`，不检查 `0`。当 OpenAI 适配器发出 `cache_creation_input_tokens: 0` 时，`??` 会用 0 覆盖累积值，`> 0` guard 则会保留累积值。这个细微的语义差异就是整个 Usage 镜像设计存在的理由。

## BedrockClient：针对 SDK 漏洞的运行时补丁

打开 `src/services/api/bedrockClient.ts:29`，你会看到一个极短的类：

```ts
export class BedrockClient extends AnthropicBedrock {
  async buildRequest(options: BuildRequestArg): Promise<BuildRequestRet> {
    const req = await super.buildRequest(options)

    const inner = (
      req as unknown as { req?: { body?: unknown; headers?: unknown } }
    )?.req
    if (!inner || typeof inner.body !== 'string' || inner.body.length === 0) {
      return req
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(inner.body) as Record<string, unknown>
    } catch {
      return req
    }
    if (!('anthropic_beta' in parsed)) {
      return req
    }

    delete parsed.anthropic_beta
    const cleanedBody = JSON.stringify(parsed)
    inner.body = cleanedBody

    const byteLen = String(new TextEncoder().encode(cleanedBody).length)
    const h = inner.headers
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      if (h.has('content-length')) h.set('content-length', byteLen)
    } else if (h && typeof h === 'object') {
      const asDict = h as Record<string, string>
      if ('content-length' in asDict) asDict['content-length'] = byteLen
    }

    return req
  }
}
```

这个类做了一件事：`super.buildRequest()` 构建完请求后，检查 body JSON 里是否包含 `anthropic_beta` 字段，如果有就删掉，然后更新 `content-length` header。

注释里说得很清楚（`bedrockClient.ts:4`）：这是 `@anthropic-ai/bedrock-sdk` 版本 0.26.4 到 0.28.1 的一个 bug——SDK 把 `anthropic-beta` HTTP header 的值复制到了请求 body 里的 `anthropic_beta` 字段。Bedrock 的 Opus 4.7 端点会拒绝任何 body 里包含 `anthropic_beta` 的请求，返回 400 "invalid beta flag"。

为什么不在 SDK 修复后直接删除这个类？因为 `bedrockClient.ts:22` 的注释留了一条明确的退出路径：

> When upstream ships a fix, verify the probe in scripts/probe-bedrock-beta-fix.ts shows "bug reproduced: false", then delete this class.

这个 probe 脚本（`scripts/probe-bedrock-beta-fix.ts`）会动态 import `@anthropic-ai/bedrock-sdk`，调用 `buildRequest`，检查 body 里是否出现 `anthropic_beta`。当 SDK 修复了这个 bug，probe 报告 "bug reproduced: false"，开发者就可以安全地删除 `BedrockClient`，让 `client.ts` 直接使用 `AnthropicBedrock`。

注意 `as unknown as` 的双重断言链（`bedrockClient.ts:33`）：`req as unknown as { req?: { body?: unknown; headers?: unknown } }`。这是反编译产物的典型痕迹——原始类型信息在反编译过程中丢失了，开发者只能通过运行时观察推断内部结构。`req.req.body` 这种嵌套是 Bedrock SDK 的内部实现细节，不在公共类型里。

如果不做这个补丁，所有使用 Bedrock + Opus 4.7 的用户都会在每个请求上收到 400 错误。这不是"优雅降级"，是"完全不可用"。

## 延伸阅读

- 想看调度点如何把三个 Provider 路径统一接入，见 [第七章：7-Provider 抽象层的单一调度点](./07-provider-dispatch.md)
- 想看流适配器如何把 OpenAI/Grok 响应翻译成 Anthropic 格式，见 [第八章：流适配器](./08-stream-adapters.md)
- 想看 `getAPIProvider()` 的优先级判定逻辑，见 [第七章：7-Provider 抽象层的单一调度点](./07-provider-dispatch.md) 中"Provider 路由优先级链"一节
