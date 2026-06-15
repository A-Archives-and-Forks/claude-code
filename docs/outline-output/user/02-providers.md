# 第二章：让 Claude 听你的 —— 配置 Provider 与模型

> 把 CCB 接到你自己想用的那家 API 上：怎么选、怎么切、为什么没生效。

## 一张表看懂 7 个 Provider

CCB 不绑定 Anthropic 官方账号，内置了 7 条 API 通道。`src/commands/provider.ts` 里硬编码的有效值就这 7 个，对应 `/provider <name>` 能接的参数：

| Provider | `modelType` 值 | 适合谁 |
|----------|---------------|--------|
| Anthropic 官方 | `anthropic`（默认，内部叫 `firstParty`） | 有 Anthropic API key 或 Claude 订阅的人 |
| OpenAI 兼容 | `openai` | DeepSeek、Ollama、vLLM、智谱、通义、Moonshot、Cerebras、Groq 等任何 OpenAI Chat Completions 协议端点 |
| Gemini | `gemini` | Google Gemini 系列 |
| Grok | `grok` | xAI Grok 系列（`GROK_API_KEY` 或 `XAI_API_KEY` 都行） |
| Bedrock | `bedrock` | AWS 用户，走 `CLAUDE_CODE_USE_BEDROCK=1`，依赖 `AWS_REGION` 等 |
| Vertex | `vertex` | Google Cloud 用户，走 `CLAUDE_CODE_USE_VERTEX=1`，需要 `ANTHROPIC_VERTEX_PROJECT_ID` 等 |
| Foundry | `foundry` | Azure AI Foundry 用户，走 `CLAUDE_CODE_USE_FOUNDRY=1`，需要 `ANTHROPIC_FOUNDRY_*` 系列 |

注意一个区别：`anthropic` / `openai` / `gemini` / `grok` 这四个会落到 `~/.claude/settings.json` 的 `modelType` 字段持久化；`bedrock` / `vertex` / `foundry` 三个云厂商只设环境变量，**不写 `settings.json`**——源码注释明确写了 "cloud providers controlled solely by env vars"。

想知道当前生效的是哪个：

```
/provider
Current API provider: openai
```

## 三种切换方式：`/provider`、`/login`、环境变量

同一个目标有三条路，按你的场景选。

**`/provider <name>` 最直接**——一行命令立刻切换，写入 `settings.json`。比如刚配完 DeepSeek 的环境变量，想切过去：

```
/provider openai
API provider set to openai.
```

它还会顺手做体检：切到 `openai` 时如果缺 `OPENAI_API_KEY` 或 `OPENAI_BASE_URL`，会返回 warning 而不是直接报错；切到 `gemini` 缺 `GEMINI_API_KEY` 同理。切到 `grok` 时接受 `GROK_API_KEY` 或 `XAI_API_KEY` 任一存在即可。

**`/login` 是引导式表单**——会弹出一个交互界面（`ConsoleOAuthFlow` 组件），让你按栏目填字段、选预设。对第一次配的人最友好，特别是接国产大模型（见下一节）。它除了填表单，还会触发一连串副作用：重置 cost state、刷新 GrowthBook feature flags、清掉 trusted device token 再重新 enroll、把 `authVersion` 自增让其他 hook 重新拉数据。所以 `/login` 不只是"写个 key"那么简单。

**环境变量是 CI/自动化场景的玩法**——所有 provider 都有对应的 `CLAUDE_CODE_USE_*` 开关，写到 shell 配置或 `.envrc` 里，`ccb` 启动时自动生效：

```bash
# 临时用 DeepSeek 跑一个会话，不污染全局配置
CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=sk-xxx \
  OPENAI_BASE_URL=https://api.deepseek.com/v1 \
  OPENAI_MODEL=deepseek-chat ccb
```

三条路里**优先级在 `src/utils/model/providers.ts` 的 `getAPIProvider()`** 里写死：先看 `settings.modelType`（`/provider` 写进去的），再看 `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`，再看 `CLAUDE_CODE_USE_OPENAI/GEMINI/GROK`，最后 fallback 到 `firstParty`。这个顺序解释了下一个排错点。

## 中国 LLM 引导式登录：DeepSeek、智谱、通义、小米 MiMo

`/login` 走 "China LLM" 栏目时会用上 `src/utils/chinaLlmProviders.ts` 里的预设表。这张表内置了四家：

- **DeepSeek** — `https://api.deepseek.com`，注册送 5M tokens（30 天），最便宜。模型有 `deepseek-v4-pro`（推荐）、`deepseek-v4-flash`（快）。
- **智谱 GLM** — `https://open.bigmodel.cn/api/paas/v4`，`GLM-4.7-Flash` 永久免费，有 Coding Plan（Lite ¥72/mo、Pro ¥216/mo、Max ¥576/mo）。
- **通义千问** — `https://dashscope.aliyuncs.com/compatible-mode/v1`，开通后 90 天免费 tier，Coding Plan ¥200/mo。
- **小米 MiMo** — `https://api.xiaomimimo.com/v1`，1M 上下文，Token Plan 四档（Lite ¥39/mo 起）。

预设表的好处是：你不用记 base URL、不用查 key 怎么申请、不用猜模型 ID。表单里每个 provider 都带 `apiKeyPage` 字段，直接给你跳转申请 key 的链接；每个模型还标了输入/输出每百万 token 的价格、上下文窗口、推荐 tag。选 Coding Plan 模式时，`resolveChinaProviderBaseURL()` 会自动把 base URL 切到对应 coding endpoint（比如智谱切到 `https://open.bigmodel.cn/api/coding/paas/v4`），key 格式也会提示（如 `tp-...`、`sk-sp-...`）。

填完表单后写入 `~/.claude/settings.json` 的 `env` 字段并触发 `applyConfigEnvironmentVariables()`，不用重启 `ccb`。

## 用 ChatGPT 订阅当后端：设备码流程与凭证存储

如果你有 ChatGPT 订阅，可以让 CCB 直接走 ChatGPT 账号体系，而不是去 OpenAI 平台申请 API key。这套实现在 `src/services/api/openai/chatgptAuth.ts`。

启用方式是设置 `OPENAI_AUTH_MODE=chatgpt`（同时把 provider 切到 `openai`）。CCB 会启动 OAuth 设备码流程：调 `https://auth.openai.com/api/accounts/deviceauth/usercode` 拿一个 `user_code` 和验证 URL，你在浏览器里打开 `https://auth.openai.com/codex/device` 输入这个 code 完成登录，CCB 这边轮询 `/api/accounts/deviceauth/token`（最多 15 分钟，每 5 秒一次）拿回 authorization code，再换成 `id_token` / `access_token` / `refresh_token` 三件套。

凭证默认存到 `~/.claude/openai-chatgpt-auth.json`（文件权限 `0600`）。**值得注意的兼容点**：如果那个文件不存在，CCB 会 fallback 读 `~/.codex/auth.json`（即 Codex CLI 的凭证文件，路径由 `CODEX_HOME` 环境变量控制，默认 `~/.codex`）。源码里有句日志：`[OpenAI] Using ChatGPT auth from Codex auth.json`。这意味着你在 Codex CLI 登过的账号，CCB 可以无缝接用。

刷新偏差窗口是 `REFRESH_SKEW_MS = 5 * 60 * 1000`，即 5 分钟。`getValidChatGPTAuth()` 每次被调用时检查 access_token 的 JWT `exp` 字段，如果距离过期不到 5 分钟就主动 refresh，避免请求途中 token 失效。

## 每个 Provider 需要哪些环境变量

下面这张清单是从源码逐个挖出来的，配的时候照着对一遍就不会漏。

**OpenAI 兼容**（`src/services/api/openai/client.ts`）：

- `OPENAI_API_KEY` — 必填
- `OPENAI_BASE_URL` — 强烈推荐，比如 `http://localhost:11434/v1`（Ollama）
- `OPENAI_ORG_ID`、`OPENAI_PROJECT_ID` — 可选
- `OPENAI_AUTH_MODE=chatgpt` — 走 ChatGPT 订阅模式时设
- `OPENAI_MODEL` — 指定模型 ID（可选，不设 CCB 自己选档位）

**Gemini 兼容**（`packages/@ant/model-provider/src/providers/gemini/modelMapping.ts`）：

- `GEMINI_API_KEY` — 必填，没有就 `resolveGeminiModel()` 会直接 throw
- `GEMINI_MODEL` — 直接指定模型（最高优先级）
- `GEMINI_DEFAULT_SONNET_MODEL` / `GEMINI_DEFAULT_OPUS_MODEL` / `GEMINI_DEFAULT_HAIKU_MODEL` — 按 anthropic 模型族映射
- `ANTHROPIC_DEFAULT_SONNET_MODEL` 等 — 向后兼容（已废弃但仍读）

**Grok 兼容**（`src/services/api/grok/client.ts` + `modelMapping.ts`）：

- `GROK_API_KEY` 或 `XAI_API_KEY` — 任一即可，前者优先
- `GROK_BASE_URL` — 可选，默认 `https://api.x.ai/v1`
- `GROK_MODEL` — 直接指定（最高优先级）
- `GROK_DEFAULT_OPUS_MODEL` 等 — 按 family 映射
- `GROK_MODEL_MAP` — JSON 字符串，一次性传完整映射表

**Bedrock / Vertex / Foundry**：依赖各家 SDK 的标准环境变量（`AWS_REGION`、`ANTHROPIC_VERTEX_PROJECT_ID`、`ANTHROPIC_FOUNDRY_*`），CCB 自己不额外定义。

## 模型映射是怎么决定的

CCB 内部统一用 Anthropic 的模型名（`claude-sonnet-4-6`、`claude-opus-4-6`、`claude-haiku-4-5-20251001` 等）做调度，落到具体 provider 时再做一次映射。映射函数遵循同一条优先级链：

1. `PROVIDER_MODEL`（如 `GEMINI_MODEL`、`GROK_MODEL`、`OPENAI_MODEL`）——直接写死，最高优先级
2. `PROVIDER_DEFAULT_{FAMILY}_MODEL`——按 sonnet / opus / haiku 三个 family 分别覆盖
3. `ANTHROPIC_DEFAULT_{FAMILY}_MODEL`——向后兼容的共享环境变量
4. 内置默认表（Grok 在 `modelMapping.ts` 里有硬编码表，比如 opus family 默认映射到 `grok-4.20-reasoning`）

举两个具体例子。Gemini 路径下如果你只设了 `GEMINI_DEFAULT_SONNET_MODEL=gemini-2.5-flash`，那么 CCB 调用 sonnet 时会用 flash，调用 opus 时会因为找不到映射抛错：`Gemini provider requires GEMINI_MODEL or GEMINI_DEFAULT_OPUS_MODEL (or ANTHROPIC_DEFAULT_OPUS_MODEL for backward compatibility) to be configured.`。

Grok 路径下，没设任何 `GROK_*` 时走默认表：opus family → `grok-4.20-reasoning`，sonnet/haiku family → `grok-3-mini-fast`。模型名带 `[1m]` 后缀（1M 上下文标记）会在映射前被 `replace(/\[1m\]$/, '')` 剥掉。

## 为什么切了 Provider 没生效

这是 issue 区最高频的困惑之一，根因几乎都在 `getAPIProvider()` 的优先级上。

**`settings.modelType` 优先于环境变量**。如果你之前用过 `/provider openai`，那 `~/.claude/settings.json` 里就写死了 `"modelType": "openai"`。后来你想换回 Anthropic 官方，只在 shell 里 `unset CLAUDE_CODE_USE_OPENAI`——没用，因为 settings 的优先级更高。正确做法是用 `/provider unset`，它会清掉 `modelType` 字段并删除所有 `CLAUDE_CODE_USE_*` 环境变量：

```
/provider unset
API provider cleared (will use environment variables).
```

注意 `/provider unset` **只清 Provider，不清 API key**。`OPENAI_API_KEY`、`GEMINI_API_KEY` 这些是独立保留的，你想彻底换 provider 还得自己清 key。

**`isFirstPartyAnthropicBaseUrl()` 有个 TODO 陷阱**（`src/utils/model/providers.ts:43`）。这个函数判断当前是不是走 Anthropic 官方 endpoint，逻辑是看 `ANTHROPIC_BASE_URL` 有没有设、设的是不是 `api.anthropic.com`。但 TODO 注释明确写了："这里会有问题, 只配置了 openai 协议的用户, 按理说会为 true 导致问题"。意思是：如果你只设了 `OPENAI_BASE_URL`（指向 DeepSeek）但没设 `ANTHROPIC_BASE_URL`，这个函数会返回 `true`（因为 `ANTHROPIC_BASE_URL` 未设默认 firstParty），让下游某些 firstParty 专属的行为（比如特定 betas 头）泄漏到 OpenAI 兼容路径上。如果遇到奇怪的请求被拒，先检查这个。

## 我改了 API key 但没生效

另一个高频坑，根因是模块级 client cache。

`getOpenAIClient()`（`src/services/api/openai/client.ts:39`）和 `getGrokClient()`（`src/services/api/grok/client.ts`）都是单例缓存：第一次调用时读 `process.env.OPENAI_API_KEY` / `OPENAI_BASE_URL` 构造一个 OpenAI SDK 实例，存到模块级变量 `cachedClient`，之后所有调用直接复用这个实例。

```ts
// client.ts 的核心逻辑
let cachedClient: OpenAI | null = null
export function getOpenAIClient(): OpenAI {
  if (cachedClient) return cachedClient
  // ... 读 env、new OpenAI(...)
  cachedClient = client
  return client
}
```

这意味着：你在 REPL 里改了 `process.env.OPENAI_API_KEY`（或通过 `/login` 重写了 `settings.json` 的 env），但当前会话的 client 实例还是用旧 key 构造的——下一次请求还是旧 key。两种解法：

1. **重启 `ccb`**——最简单粗暴，所有模块级 cache 自然清空
2. **调用 `clearOpenAIClientCache()` / `clearGrokClientCache()`**——程序化清缓存，但你没法在 REPL 里直接调，需要走 `/login` 这类会触发完整副作用的路径

`/login` 命令的 `onDone` 回调里调了 `context.onChangeAPIKey()`，这个 hook 会负责让下游感知 key 变了。所以**改 key 的正确姿势是走 `/login`，而不是手改 `settings.json` 后期望立刻生效**。

## 本地模型与自托管端点

CCB 的 OpenAI 兼容层对本地模型特别友好，因为 Ollama、vLLM、LM Studio 这些工具都暴露 OpenAI Chat Completions 协议。

**Ollama**（本地跑 Llama、Qwen 等）：

```bash
# 先启动 ollama 并 pull 一个模型
ollama serve &
ollama pull qwen2.5-coder:32b

# 让 CCB 用它
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=ollama              # ollama 不校验 key，随便填
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=qwen2.5-coder:32b
ccb
```

**vLLM**（自托管推理引擎）：把 `OPENAI_BASE_URL` 指向你的 vLLM server（默认 `http://localhost:8000/v1`），`OPENAI_MODEL` 填你启动 vLLM 时 `--model` 传的名字。

**DeepSeek 自托管**：跟官方 API 一样走 OpenAI 兼容，区别只是 base URL。注意思维模式的请求体格式跟官方 API 略有不同（见下一节）。

本地模型的两个实用环境变量：

- `OPENAI_MAX_TOKENS` —— 显卡显存不够时强制限制 max output tokens（比如 RTX 3060 12GB 跑 65536-token 模型会 OOM，调小这个）
- `API_TIMEOUT_MS` —— 默认 600000（10 分钟），本地模型推理慢的话可以调大

## DeepSeek 思维模式：三格式注入与空字符串回显

DeepSeek 系列模型（`deepseek-reasoner`、`deepseek-v3`、`deepseek-v4`、`deepseek-chat`、`deepseek-coder`、`deepseek-r1` 等，凡是模型名包含 `deepseek` 的）会自动启用思维模式。检测逻辑在 `src/services/api/openai/requestBody.ts:21` 的 `isOpenAIThinkingEnabled()`：

```ts
return modelLower.includes('deepseek') || modelLower.includes('mimo')
```

想强制关掉？设 `OPENAI_ENABLE_THINKING=0`。想给非 DeepSeek 模型强制开？设 `OPENAI_ENABLE_THINKING=1`。

启用思维模式后，CCB 会在请求体里**同时塞三种格式**，因为不同 endpoint 认不同的字段，互不冲突：

```ts
...(enableThinking && {
  thinking: { type: 'enabled' },                              // 官方 DeepSeek API
  enable_thinking: true,                                       // 自托管 DeepSeek-V3.2
  chat_template_kwargs: { thinking: true, enable_thinking: true }, // 自托管 + MiMo
}),
```

这里有个反直觉但关键的细节：**必须把 `reasoning_content: ''`（空字符串）原样回显回去**。DeepSeek v4 在思维模式下，如果模型直接回答（不思考），会在 assistant message 里返回 `reasoning_content: ""`（空字符串而非缺失）。下一次请求必须把这个空字符串原样传回去，否则 DeepSeek 返回 400：`reasoning_content ... must be passed back`。

这套回显策略在 `src/services/providerRegistry/providerCompatMatrix.ts` 里按 provider 分了三档：

- `always-preserve`（DeepSeek）——总是保留，包括空字符串
- `drop-on-non-thinking`（permissive 默认）——非思维模型时丢掉
- `strip`（Cerebras / Groq / strict-openai）——总是丢掉

所以同一份对话历史，发给 DeepSeek 时带 `reasoning_content`，发给 Groq 时被剥得干干净净，互不污染。

## `/effort` 与 `CLAUDE_CODE_EFFORT_LEVEL`：思考强度的四档

`/effort` 控制模型在回答前思考多久。`src/commands/effort/effort.tsx` 接受的参数：`low` / `medium` / `high` / `xhigh` / `max` / `auto`。`EFFORT_LEVELS` 在 `src/utils/effort.ts` 里写死是 `['low', 'medium', 'high', 'xhigh', 'max']`（注意 `max` 对外部用户是 session-only，不持久化；只有 `USER_TYPE === 'ant'` 才能 persist）。

```
/effort low       # Quick, straightforward implementation with minimal overhead
/effort medium    # Balanced approach with standard implementation and testing
/effort high      # Comprehensive implementation with extensive testing
/effort xhigh     # Extended reasoning beyond high, short of max
/effort max       # Maximum capability with deepest reasoning
/effort auto      # 跟随模型默认
```

`CLAUDE_CODE_EFFORT_LEVEL` 环境变量覆盖一切，优先级最高。它还接受 `unset` / `auto` 两个特殊值表示"别发 effort 参数"。设了环境变量再跑 `/effort medium`，CCB 会告诉你："Not applied: CLAUDE_CODE_EFFORT_LEVEL=xxx overrides effort this session"。

落地到 ChatGPT 订阅模式（`OPENAI_AUTH_MODE=chatgpt` + 走 Responses API）时，`src/services/api/openai/responsesAdapter.ts` 把 effort 映射成 `reasoning.effort` 参数。Responses API 只认四档（`'low' | 'medium' | 'high' | 'xhigh'`），所以 `/effort max` 在 ChatGPT 模式下会被 `resolveAppliedEffort()` 降级为 `xhigh`（源码注释："Keep /effort max usable as a familiar alias in ChatGPT subscription mode"）。

不是所有模型都支持 effort。`modelSupportsEffort()` 在 `src/utils/effort.ts:34` 里维护白名单，目前包含 `opus-4-7`、`opus-4-6`、`sonnet-4-6`、`deepseek-v4-pro`，以及 ChatGPT Codex 推理模型。设 `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` 可以强制全开（自担 API 报错风险）。

## 下一步

- 想知道日常发消息、看流式回复、切权限模式怎么操作，看 [第三章：日常对话 —— 交互式 REPL 怎么用](./03-repl.md)
- 想按场景查 slash 命令（`/clear`、`/compact`、`/cost` 等），看 [第四章：slash 命令速查](./04-slash-commands.md)
- 想接入 MCP server、装插件、写 Skill，看 [第五章：扩展 Claude 的能力](./05-extensions.md)
