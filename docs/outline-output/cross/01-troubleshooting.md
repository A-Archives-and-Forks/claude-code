# 排错与错误对照

> 同一条 429 在使用者眼里是"我流量打太多了吗？"，在开发者眼里是"响应头里那串 `x-ratelimit-*` 该被哪个适配器解析"；同一份 Bedrock 400 在使用者眼里是"为什么 Opus 4.7 调不通"，在开发者眼里是"SDK 0.28.1 那个 `anthropic_beta` 体重植漏洞还要打补丁打多久"。排错天生是双视角主题，所以单独成章。

## 产品视角（写给使用者）

这一节回答两个问题：**当 Claude 报错时第一步该做什么**，以及**看到具体错误码该怎么自救**。读完之后，你不需要去翻源码，就能把九成的常见问题处理掉。

### 第一步永远先跑两条命令

当 Claude 报错、卡住、行为异常时，按下面顺序排查。两条命令分工很明确：

- `claude doctor` —— 一张屏幕显示版本信息（含远端 npm/GCS 上的 stable 与 latest 版本号）、配置文件路径、settings 校验错误、keybindings 警告、MCP 解析警告、沙箱状态、安装锁文件状态。它的源码在 `src/screens/Doctor.tsx`（命令注册在 `src/commands/doctor/doctor.tsx`），相当于一次"全身体检"。
- `bun run health` —— 跑 `scripts/health-check.ts`，更偏工程化自检（依赖完整性、构建产物完整性等）。开发模式下比 `claude doctor` 更底层，适合"刚 clone 下来跑不起来"的场景。

90% 的"莫名其妙不工作"在这两条命令的输出里都能看到线索——版本落后、settings.json 写错字段、keybindings 语法错、MCP 配置文件 JSON 解析失败。**先看这两条输出再问别人**，能省掉一大半来回。

### Provider 报错对照表

下面这张表覆盖最常见的 API 报错。Provider 切换方式详见产品第二章；这里只讲"切完之后出错了怎么办"。

| HTTP 状态 / 错误类型 | 含义 | 用户侧怎么办 |
| --- | --- | --- |
| **401**（`authentication_error`） | API key 无效或已过期 | 跑 `/login` 重新登录；OpenAI 兼容层检查 `OPENAI_API_KEY`，Anthropic 直连检查 OAuth 令牌或 `ANTHROPIC_API_KEY`。**注意**：OpenAI/Grok 客户端是会话级缓存的（详见下文"我改了 key 但没生效"） |
| **403** | 地区限制 / 权限不足 | 中国大陆直连 Anthropic 通常会 403；用 OpenAI 兼容层（DeepSeek / 智谱 / 通义 / Moonshot 等）或 Bedrock / Vertex 中转 |
| **429** | 限流 | 看状态栏的限流指示；如果用 Claude.ai 订阅，可跑 `/rate-limit-options` 看升级 / 加包选项；OpenAI 兼容层会自动解析 `x-ratelimit-*` 响应头展示在 `/usage` 里 |
| **529 / `"type":"overloaded_error"`** | 上游服务过载 | 稍等几秒重试。如果开了 fast mode（`/fast`），系统会自动切回标准模型并进入冷却期，状态栏会写 "Fast mode overloaded and is temporarily unavailable · resets in N" |
| **模型不存在** | Provider 不认识你传的模型名 | 检查环境变量：OpenAI 看 `OPENAI_MODEL`，Gemini 看 `GEMINI_MODEL` 或 `GEMINI_DEFAULT_{HAIKU|SONNET|OPUS}_MODEL`，Grok 看 `XAI_API_KEY` / `GROK_*`。Gemini 缺配置时会**直接抛异常**，不会静默回退 |
| **`max_output_tokens` 扣留** | 单轮输出超过模型上限 | 系统会自动最多重试 3 次（源码常量 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`，见 `src/query.ts:194`）；如果三轮还没收敛，本轮会以 `apiError === 'max_output_tokens'` 的 assistant 消息结束 |

`claude.ts` 把 `error.status === 529` 和消息体里包含 `"type":"overloaded_error"` 的情况都归到 `server_overload`（见 `src/services/api/errors.ts:1004-1011`），所以同一个上游过载事件，不管是用 HTTP 状态码表达还是用错误体表达，对用户而言是同一件事——稍等重试。

### 兼容层特有坑（OpenAI / Gemini / Grok）

下面这些是兼容层才会遇到的，Anthropic 直连不会出现：

- **我改了 API key 但没生效** —— 这是兼容层最高频的坑。`getOpenAIClient()`（`src/services/api/openai/client.ts:39`）和 Grok 客户端（`src/services/api/grok/client.ts`）都会把首次创建的客户端实例缓存到模块级变量（`cachedClient`，见 `openai/client.ts:15`）。中途改 `OPENAI_API_KEY` 环境变量不会让客户端重建。**解决办法**：重启 CLI；如果你在自己写脚本嵌入 Claude，必须显式调用 `clearOpenAIClientCache()`（`openai/client.ts:76`）清缓存。
- **DeepSeek / 自托管模型报 400** —— DeepSeek 思维模式（`deepseek-reasoner`）会返回 `reasoning_content` 字段。把它原样回传给非思维模型变体会被服务端拒绝。系统在 `src/services/providerRegistry/providerCompatMatrix.ts` 里维护了一张兼容矩阵：`strip` 模式（Cerebras / Groq / strict-openai）总是剥掉 `reasoning_content`；`drop-on-non-thinking`（permissive）只在模型名匹配 `/reason|think/i` 时才保留；只有 DeepSeek 自己走 `always-preserve`。如果你用的是 DeepSeek 自托管端点且模型名不含 `reason` / `think` 字样，要么改模型名让正则命中，要么用 `permissive` 兼容规则。
- **Bedrock Opus 4.7 报 400 `invalid beta flag`** —— 这是 `@anthropic-ai/bedrock-sdk` 0.26.4–0.28.1 的已知漏洞：SDK 把 `anthropic-beta` HTTP 头的值重植到请求体里成为 `anthropic_beta`，Bedrock 的 Opus 4.7 端点会拒绝任何带 `anthropic_beta` 体的请求。Claude Code 通过自定义 `BedrockClient` 类（`src/services/api/bedrockClient.ts`）在签名前剥离 `body.anthropic_beta` 解决。**普通用户不需要做什么**——这个补丁默认就生效。
- **Gemini 报"requires GEMINI_MODEL"** —— Gemini 是唯一在模型映射全失败时**硬抛异常**的 Provider（`packages/@ant/model-provider/src/providers/gemini/modelMapping.ts:32`）。其它 Provider 找不到映射就原样返回模型名，Gemini 不行。看到这条报错就设一下 `GEMINI_MODEL` 或 `GEMINI_DEFAULT_SONNET_MODEL`（取决于你的家族）。
- **限流信息看不到** —— OpenAI 兼容层的限流是从响应头 `x-ratelimit-remaining-requests` / `x-ratelimit-remaining-tokens` / `x-ratelimit-reset-*` 解析出来的（`src/services/providerUsage/adapters/openai.ts:62`）。如果你用的自托管端点不返回这些头，状态栏就拿不到限流信息——这不是 bug，是端点没实现。`/usage` 命令会展示已知 bucket。

### MCP 连不上的排查清单

MCP server 报"连接失败"时按下面顺序查：

1. **stdio 类型**：命令路径对不对、参数对不对、本地能否手动跑起来。
2. **SSE / HTTP 类型**：URL 能否 curl 通、是否需要 token、是否在 `claude mcp list` 里显示为已连接。
3. **OAuth 失败**：跑 `/mcp-auth` 重新走授权流程。
4. **MCP 配置文件 JSON 解析错误**：`claude doctor` 会显示 `MCP parsing warnings`，直接定位到具体文件和行号。
5. **权限被拒**：检查 `/permissions` 里是否把工具 deny 掉了；deferred tool（不在 `CORE_TOOLS` 白名单里）需要通过 `SearchExtraTools` 按需加载。

### 长会话变卡怎么办

长会话内存膨胀有两类来源，处理方式不同：

- **上下文太长** —— 跑 `/compact` 自动压缩；还不行就 `/force-snip` 强制剪裁历史；最彻底的是 `/clear` 重开。
- **JSC 内存累积** —— 即使上下文压缩了，进程 RSS 也可能不下降。这是 JavaScriptCore 的已知特性（详见下文设计视角与设计第三章）。最快的解法是退出 CLI 重开。后台长跑场景（`/loop` / daemon）这个坑会更明显。

### 我想看看 Claude 到底在做什么

下面这几条命令按"侵入性"从低到高排：

- `claude --dump-system-prompt` —— 把当前会话渲染出的完整 system prompt 打到 stdout（需要 build 时启用 `DUMP_SYSTEM_PROMPT` feature，见 `src/entrypoints/cli.tsx:90`）。排查"为什么 Claude 不按 CLAUDE.md 行事"时最有用。
- `/debug-tool-call` —— 读取最近一次工具调用的请求 / 响应明细，源码在 `src/commands/debug-tool-call/index.ts`。
- `BUN_INSPECT=9229 bun run dev:inspect` —— 把 Bun 调试器挂在 9229 端口，用 Chrome DevTools 连进去打断点。这是最重的手段，但对"卡死但没报错"类问题非常有效。
- Langfuse 追踪 —— 如果你的部署启用了 Langfuse（详见 `docs/features/tools/langfuse-monitoring.md`），每次 API 调用都会被记录为一个 observation，包含模型名、Provider、token 用量、输入输出消息。

### 反馈与上报 bug

- `/feedback` —— 弹出反馈表单，源码 `src/commands/feedback/feedback.tsx`。
- `/perf-issue` —— 性能问题专用通道，源码 `src/commands/perf-issue/index.ts`。
- `/bughunter` —— 实验性 bug 自动归因工具（隐藏命令）。

## 设计视角（写给开发者）

设计大纲原本没有排错章——这是最大的缺口。补这一节是因为排错本身就是"被约束逼出来的工程化"的最好案例：每一个看似奇怪的兼容代码、每一条 TODO、每一个 probe 脚本，背后都对应着一个用户会碰到的具体错误。这一节按"这个错误的根因是 Y 设计决策"的思路展开。

### 为什么 Bedrock 补丁必须配 probe 脚本

打开 `src/services/api/bedrockClient.ts`，你会看到一个看起来有点啰嗦的类继承：

```ts
export class BedrockClient extends AnthropicBedrock {
  async buildRequest(options: BuildRequestArg): Promise<BuildRequestRet> {
    const req = await super.buildRequest(options)
    // ... 解析 inner.body，删掉 parsed.anthropic_beta，重写 content-length
    return req
  }
}
```

这个类的唯一作用是：**让 SDK 把请求构造完，然后在它签名之前把 `anthropic_beta` 从请求体里删掉**。注释（`bedrockClient.ts:1-25`）写得极其详尽——直接点名了 SDK 的具体文件和行号（`packages/bedrock-sdk/src/client.ts:193-198`）、相关 issue（`anthropics/claude-code#49238`，2026-04-16 提出）、漏洞版本范围（0.26.4 至少到 0.28.1）。

为什么不直接给上游提 PR？因为上游修了之后，这段兼容代码也必须能被安全删除。注释最后一段写明了删除流程：

> When upstream ships a fix, verify the probe in scripts/probe-bedrock-beta-fix.ts shows "bug reproduced: false", then delete this class and change services/api/client.ts to instantiate AnthropicBedrock directly.

`scripts/probe-bedrock-beta-fix.ts` 这个文件在源码注释里被点名引用，目的是"装个探针，等上游修了就跑一下，确认 false 就删类"。这是一种"针对性补丁 + 自动退役"的工程范式——和一般补丁的区别在于它**自带退役机制**：probe 脚本本身就是"这个补丁该不该继续存在"的判据。

> **诚实核对**：注释里点名的 `scripts/probe-bedrock-beta-fix.ts` 目前在仓库里**找不到**（仓库里现存的 probe 脚本是 `scripts/probe-local-wiring.ts` 和 `scripts/probe-subscription-endpoints.ts`）。这意味着这个"自动退役机制"目前只是注释里的口头约定，并没有真的自动化。这是反编译重建工作的一个典型痕迹：原版可能有这个脚本，重建时没还原。

### 为什么 DeepSeek 必须把 reasoning_content 分三种模式处理

DeepSeek 的思维模型（`deepseek-reasoner`）会在 assistant 消息里返回 `reasoning_content` 字段。但同样一个字段，对三个不同的接收端会触发完全不同的行为：

- **DeepSeek 自己**：期望被原样回传（`always-preserve`）。
- **Cerebras / Groq / 标准 OpenAI 协议端点**：拒绝任何非标准字段（`strip`）。
- **permissive 端点（非 DeepSeek）**：思维模型变体可以保留，非思维变体会拒绝（`drop-on-non-thinking`，靠模型名正则 `/reason|think/i` 判断）。

这套规则定义在 `src/services/providerRegistry/providerCompatMatrix.ts:43-76` 的 `COMPAT_PROFILES` 表里，由 `applyCompatRule`（同文件 `:104`）实施。打开 `getDeepSeekReasoningMode`（`:86`）你能看到三种模式的判定：`thinking-only`（有 reasoning_content 无 tool_calls）、`thinking+tools`（两者都有）、`normal`（都没有）。

**根因**：DeepSeek 的 API 把"模型上一轮想了什么"塞回 `reasoning_content` 字段，期望客户端在下一次请求里回传。但标准 OpenAI 协议没有这个字段，严格端点（Cerebras / Qwen）会直接 400。所以兼容矩阵本质上是一张"哪些端点容忍哪些非标准字段"的合约表——这是"多 Provider 兼容"工程化的必然产物。

反事实推演：如果只写一种策略（比如永远 strip），DeepSeek 思维模式就彻底用不了；如果只写 always-preserve，严格端点全炸。三种模式是兼容性 / 功能性的最小必要切分。

### 为什么 isFirstPartyAnthropicBaseUrl 的 TODO 是个真陷阱

打开 `src/utils/model/providers.ts:43`：

```ts
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  // TODO: 这里会有问题, 只配置了 openai 协议的用户, 按理说会为 true 导致问题
  if (!baseUrl) {
    return true
  }
  // ... 检查 host 是否为 api.anthropic.com
}
```

这条 TODO 的含义是：**如果用户只配了 OpenAI 兼容层（`CLAUDE_CODE_USE_OPENAI=1` + `OPENAI_BASE_URL=...`），但没有配 `ANTHROPIC_BASE_URL`，那么这个函数返回 `true`**。也就是说系统会误以为"现在是 Anthropic 直连模式"，从而触发一些只该在 firstParty 模式下才生效的行为。

这个函数在 `src/services/api/client.ts:367`（`buildFetch`）被用来决定是否注入 `x-client-request-id` 头。注释（`client.ts:365`）写得很谨慎："Only send to the first-party API — Bedrock/Vertex/Foundry don't log it and unknown headers risk rejection by strict proxies (inc-4029 class)."

**根因**：函数判定的输入只有 `ANTHROPIC_BASE_URL` 一个变量，但"用户在用哪家 Provider"实际上由 `getAPIProvider()`（同文件 `:15`）综合 `modelType` / `CLAUDE_CODE_USE_*` 环境变量决定。两个判定来源脱节就会导致 firstParty 行为泄漏到兼容层场景。

修复方向（TODO 没明说，但隐含）是把判定改成"先看 `getAPIProvider()` 是不是 `firstParty`，再看 base URL 是不是 anthropic 域"。但这是一个**有副作用的改动**——会改变 firstParty 路径下注入 header 的行为，需要回归测试，所以至今挂在 TODO 上。

### 为什么 OpenAI 客户端是模块级缓存，而 Anthropic 客户端不是

对比两个客户端工厂函数：

| | Anthropic | OpenAI | Grok |
| --- | --- | --- | --- |
| 入口 | `getAnthropicClient`（`client.ts:84`） | `getOpenAIClient`（`openai/client.ts:39`） | `getGrokClient`（`grok/client.ts`） |
| 缓存 | 不缓存，每次按 model / region 参数化新建 | 模块级 `cachedClient` 单例 | 模块级单例 |
| 改 key 后果 | 下次调用立刻生效 | 必须重启或 `clearOpenAIClientCache()` | 必须重启 |

为什么设计不一致？看 `client.ts:153-298` 就明白了：Anthropic 路径每次构造客户端时要做 AWS / GCP / Azure 凭证刷新、按模型选 region、注入几十个 header——这些都是**会话过程中可能变化的参数**，所以必须每次重新构造。OpenAI / Grok 路径简单得多：一个 key、一个 base URL，理论上整个会话都不变，所以缓存能省掉重复初始化的开销。

代价就是"改 key 不生效"这个高频用户困惑。`clearOpenAIClientCache`（`openai/client.ts:76`）是项目给用户留的逃生口——但这要求用户**知道这个函数存在**，对一般使用者完全不可见。这是"性能 vs 可调试性"的典型权衡。

### 为什么错误归类要绕一圈通过错误消息字符串匹配

打开 `src/services/api/errors.ts:1004-1011`，你会看到这种判定：

```ts
if (
  error instanceof APIError &&
  (error.status === 529 ||
    error.message?.includes('"type":"overloaded_error"'))
) {
  return 'server_overload'
}
```

为什么不光看 `status === 529`，还要扫消息文本？因为 Anthropic API 在某些路径下会用其它状态码（比如 503）配 `"type":"overloaded_error"` 错误体表达同一个"上游过载"事件。SDK 的 `APIError` 不一定把错误类型暴露成结构化字段，错误体只能从 `message` 里捞。

`withRetry.ts:612-616` 和 `:716-720` 用同样的字符串匹配判定 529 / overloaded。这种基于字符串的错误匹配**天然脆弱**——上游改一个字段名整个判定就失效。但目前没有更好的方案：上游 SDK 的错误类型抽象不够细，自己重写又会让兼容层耦合到具体 SDK 版本。这是"用 SDK 但 SDK 抽象不到位"的典型代价。

### 为什么 performanceShim 必须最先 import

打开 `src/entrypoints/cli.tsx:5`：

```ts
// Performance shim MUST be the first import — it replaces globalThis.performance
// with a JS-backed implementation before React/OTel capture the native reference.
import '../utils/performanceShim.js';
```

注释里的"MUST be the first import"不是审美，而是**顺序依赖**。`src/utils/performanceShim.ts:1-17` 解释了原因：JSC 原生的 `performance` 对象把 marks / measures / resource timings 存进一个永不收缩的 C++ Vector。长会话（daemon、`/loop`）会累积几百 MB 的死容量。

shim 做的事是：保留 `performance.now()` 走原生（快、不占内存），但把 `mark` / `measure` / `getEntries` 重定向到 GC 可回收的 JS Map。**为什么必须最先 import**：因为 React reconciler 和 OTel / Langfuse 客户端会**捕获 `globalThis.performance` 的引用**。一旦它们拿到原生引用，shim 再装上也没用——它们调用的是自己缓存的原生对象。

`src/query.ts:367-380` 在每次 query 的 finally 块里调用 `gPerf.clearMarks()` / `clearMeasures()` / `clearResourceTimings()`，作为兜底——防止某些 sub-agent 路径直接 `import query` 而 shim 没装上的情况。这是一个"shim 没生效时的保险栓"。

**这条和排错的交集**：用户报告"长会话越用越卡，RSS 涨到 1GB"时，根因往往就是某个 import 路径绕过了 shim、或者某个第三方库缓存了原生 performance 引用。排查方向是去看最近一次新增的依赖有没有在顶层捕获 performance。

### 为什么 Langfuse 追踪必须从 getAPIProvider() 取 provider

打开 `src/services/api/claude.ts:2997`：

```ts
recordLLMObservation(options.langfuseTrace ?? null, {
  model: resolvedModel,
  provider: getAPIProvider(),
  // ...
})
```

`provider` 字段直接调 `getAPIProvider()`（`src/utils/model/providers.ts:15`）取值——不读缓存、不信变量、单一真相源。**为什么这么严格**：Langfuse 上游的报表按 Provider 分组聚合（openai / gemini / grok / firstParty / bedrock / vertex / foundry）。如果不同代码路径用了不同的 Provider 判定（比如有的读 `CLAUDE_CODE_USE_OPENAI`、有的读 `settings.modelType`），同一类请求会被分到不同桶，统计就废了。

`getAPIProvider()` 把判定逻辑收敛到一处：先看 `modelType`，再看 `CLAUDE_CODE_USE_*` 环境变量，最后默认 `firstParty`。**任何**想读"当前在用哪家 Provider"的代码——`/provider` 命令、Langfuse 观测、模型映射——都必须走这个函数。这是"单一真相源"原则的硬执行。

### 为什么 errors.ts 要写 1000+ 行

`src/services/api/errors.ts` 是一个超过 1000 行的文件，里面几乎全是错误归类逻辑（`return 'rate_limit'` / `return 'server_overload'` / `return 'prompt_too_long'` ...）。为什么错误归类要写这么多？

因为每一个归类结果都对应**不同的用户提示 / 不同的重试策略 / 不同的 UI 反馈**：

- `rate_limit` → 展示剩余配额、提示升级
- `server_overload` → 静默重试 + cooldown
- `prompt_too_long` → 提示用户 `/compact`
- `pdf_too_large` → 提示用户拆分 PDF

而归类的输入五花八门：HTTP 状态码、错误消息字符串、SDK 错误类型、自定义 off-switch 消息（见 `errors.ts:991-997`）。同一个"上游过载"语义可以用 `status === 529`、`status === 503 + overloaded_error`、甚至 emergency off-switch 消息表达。把所有这些判定集中到一个文件，是**避免错误处理碎片化**的工程实践——否则每个调用点都得自己写一遍字符串匹配，必然漂移。

## 两视角如何呼应

用户视角的痛点几乎都能在设计视角找到对应的设计决策：

- **"我改了 API key 但没生效"**（产品视角）对应**"OpenAI/Grok 客户端为什么是模块级缓存"**（设计视角）——这是性能优化带来的副作用。设计视角给出逃生口 `clearOpenAIClientCache`，但这个逃生口对一般用户不可见，所以产品视角必须明说"重启 CLI"。
- **"Bedrock Opus 4.7 报 400"**（产品视角）对应**"为什么 Bedrock 补丁必须配 probe 脚本"**（设计视角）——补丁默认就生效，用户什么都不用做；但 probe 脚本的缺失是反编译重建的诚实边界。
- **"Gemini 报 requires GEMINI_MODEL"**（产品视角）对应**"Gemini 为什么在映射全失败时硬抛异常"**（设计视角）——这是 Gemini Provider 唯一不静默回退的设计选择，产品视角必须把"必须配置环境变量"讲清楚。
- **"长会话越用越卡"**（产品视角）对应**"performanceShim 必须最先 import"**（设计视角）——用户看到的是 RSS 上涨，根因在 JSC C++ Vector 永不收缩。
- **"529 / overloaded 怎么处理"**（产品视角）对应**"为什么错误归类要绕一圈通过字符串匹配"**（设计视角）——用户只需要知道"稍等重试"，开发者必须理解字符串匹配的脆弱性。
- **"Langfuse 里 Provider 分桶不对"**（产品视角）对应**"为什么 provider 字段必须从 getAPIProvider() 取"**（设计视角）——单一真相源是统计正确性的前提。

这种呼应关系是排错章必须双视角覆盖的核心原因：用户视角告诉你**遇到这个错误怎么办**，设计视角告诉你**为什么会有这个错误**。两个视角合在一起，才能让使用者和维护者用同一套词汇对话。
