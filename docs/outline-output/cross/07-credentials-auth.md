# 凭证与认证生命周期

> 同一份"我的令牌存在哪、什么时候过期、改了 key 为什么没生效"的困惑，在使用者眼里是"我刚才输的那串 sk-... 到底被写到了哪个文件、能不能给同事看、明天还会不会自动登录"，在开发者眼里是"为什么 `getOpenAIClient` 要做模块级缓存、为什么 ChatGPT 订阅路径要去读 Codex CLI 的 `~/.codex/auth.json`、为什么 OAuth 刷新要留 5 分钟偏差窗口、为什么 `/provider unset` 只清 Provider 不清 key"。凭证生命周期天然是双视角主题——用户想知道"我的密钥去了哪里、安不安全"，开发者想知道"为什么 token 这么存、这个缓存策略逼出了哪些权衡、跨工具复用凭证是怎么落到代码里的"。

## 产品视角（写给使用者）

这一节回答一个几乎每个新用户都会撞上的问题：**我的密钥和登录令牌，到底去了哪里？什么时候会过期？我改了 key 为什么有时候不生效？** 我们按"凭证存哪 → 怎么登录 → 怎么刷新 → 怎么排错"四段走，每段都给你能直接照做的步骤。

### 第一件事：搞清楚你的凭证存在哪个文件

Claude Code 的凭证不是一个统一的地方，而是**按 Provider 分散在好几个文件**。下面这张清单是你需要知道的全部位置（默认 `CLAUDE_CONFIG_DIR` 没被改写时，它等于 `~/.claude`）：

| 凭证类型 | 存储位置 | 谁会写它 | 谁会读它 |
|---------|---------|---------|---------|
| Anthropic OAuth 令牌（claude.ai 订阅） | `~/.claude/.credentials.json` | `/login` OAuth 流程、自动刷新 | `getAnthropicClient` 每次 API 调用前 |
| 自定义 Anthropic API Key（workspace key） | `~/.claude.json`（userSettings 的 `workspaceApiKey` 字段） | `/login` 里按 W 输入 | `getAuthStatus` / `getAnthropicApiKey` |
| `ANTHROPIC_API_KEY` 环境变量 | 你的 shell 配置（`.zshrc` / `.bashrc` / CI secrets） | 你自己 | 优先级低于 settings 里的 `workspaceApiKey` |
| ChatGPT 订阅令牌（用 ChatGPT 订阅当后端） | `~/.claude/openai-chatgpt-auth.json` | `/login` 选 "ChatGPT account" 后写 | `getValidChatGPTAuth` 每次 OpenAI 请求前 |
| Codex CLI 共享令牌（跨工具复用） | `~/.codex/auth.json` | OpenAI 官方 Codex CLI | Claude Code 找不到自己的 chatgpt 凭证时会回退读它 |
| OpenAI / Gemini / Grok 兼容层 API Key | `~/.claude/settings.json` 的 `env` 字段（`OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROK_API_KEY` 或 `XAI_API_KEY`） | `/login` 表单填写 | 各 Provider 的 client 实例化时读 `process.env` |
| Bridge 模式的会话 JWT | 运行时签发，`sk-ant-si-` 前缀 | Remote Control 服务端 | Bridge 每次请求带在 Authorization 头 |
| 个人覆盖配置（`settings.local.json`） | `~/.claude/settings.local.json` | 你手动编辑 | 不进 git，覆盖 `settings.json` |

**怎么自查**：跑 `/login` 命令，第一屏的 `AuthPlaneSummary`（`src/commands/login/AuthPlaneSummary.tsx`）会把当前生效的凭证来源摘要给你看——是 env var 还是 settings、有没有 workspace key、是不是 claude.ai 订阅。**这个摘要永远不会回显密钥原文**（`getAuthStatus` 的注释明确写了 "ANTHROPIC_API_KEY / workspaceApiKey values are NEVER returned raw; only their presence and source"），所以你截图给同事看是安全的。

### 第二件事：用 `/login` 还是手动改配置？四种登录方式怎么选

Claude Code 支持四种登录路径，选择哪一种取决于你有什么：

1. **claude.ai 订阅账号（Anthropic OAuth）**：在 `/login` 的 ConsoleOAuthFlow 里走 OAuth 设备码流程——它会给你一个 URL 和一个 code，浏览器打开、授权、回来。成功后令牌写进 `~/.claude/.credentials.json`。这是推荐路径，因为它走 Anthropic 官方 OAuth，token 自动刷新、不需要你管过期。

2. **Anthropic API Key（直连 API）**：两种方式。一是 `export ANTHROPIC_API_KEY=sk-ant-...` 写进 shell；二是在 `/login` 里按 W，输入 key，它会存到 `~/.claude.json` 的 `workspaceApiKey`（"workspace" 是因为按工作目录可覆盖）。**settings 里的 key 优先级高于 env var**——如果你两个都设了，settings 赢。

3. **ChatGPT 订阅当后端（复用 OpenAI 订阅）**：`OPENAI_AUTH_MODE=chatgpt` 打开后，`/login` 会走 OpenAI 的设备码流程（`https://auth.openai.com/codex/device`），成功后令牌写进 `~/.claude/openai-chatgpt-auth.json`。**这条路径最大的彩蛋是跨工具共享**：如果你之前装过 OpenAI 官方的 Codex CLI，它的令牌存在 `~/.codex/auth.json`，Claude Code 在自己的文件找不到时会自动回退读 Codex 的（`getValidChatGPTAuth` 的第二段，`src/services/api/openai/chatgptAuth.ts:339-346`）。换句话说：**你在 Codex CLI 登录过，Claude Code 直接就能用，不用重复登录**。

4. **OpenAI 兼容 / Gemini / Grok / 中国 LLM**：全部走 `/login` 的表单填写流程。选 Provider、填 Base URL（OpenAI 兼容层必填）、填 Key、选模型。提交后写入 `~/.claude/settings.json` 的 `env` 字段，同时把 `modelType` 改成对应的 Provider。**中国 LLM 是这条路径的一个精巧分支**：在 ConsoleOAuthFlow 里选 "China LLM Provider"（`src/components/ConsoleOAuthFlow.tsx:1294` 的 `china_provider_select` 表单），会给你一个预设列表，目前包含 DeepSeek、智谱 GLM、通义千问、小米 MiMo 四家（`src/utils/chinaLlmProviders.ts:44` 的 `CHINA_LLM_PROVIDERS`），每家还分"按量计费 API"和"包月 Coding Plan"两档 base URL。选完之后它自动填好 base URL、你只需要填 key，不用记地址。

**一个重要差别**：前三种（claude.ai 订阅 / API Key / ChatGPT 订阅）属于"认证"，后一种（OpenAI 兼容层 / Gemini / Grok）属于"换 Provider"。`/login` 命令同时处理两件事，但 `/provider` 只处理后者——见下文排错段。

### 第三件事：令牌什么时候过期、怎么自动刷新

如果你用 claude.ai 订阅或 ChatGPT 订阅，**你不需要手动刷新令牌**。Claude Code 在每次 API 调用前会检查令牌是否快过期，快过期就自动刷新。

**关键的时间窗口是 5 分钟偏差**。无论是 Anthropic OAuth 还是 ChatGPT OAuth，代码都用同一个常量：

- Anthropic OAuth：`isOAuthTokenExpired`（`src/services/oauth/client.ts:344`）用 `bufferTime = 5 * 60 * 1000`（5 分钟）。当前时间 + 5 分钟 ≥ 过期时间就认为"快过期"，触发刷新。
- ChatGPT OAuth：`REFRESH_SKEW_MS = 5 * 60 * 1000`（`src/services/api/openai/chatgptAuth.ts:9`），同样的 5 分钟窗口。

**为什么是 5 分钟不是 1 分钟？** 这是容错设计：API 请求的端到端延迟（包括网络、排队、模型推理）可能就有几秒到几十秒。如果你卡在"过期前 10 秒才刷新"，刷新完成时令牌可能已经过期了，请求被拒。5 分钟窗口给整个请求链路留出足够余量——刷新完拿到新令牌，再用它发请求，时间上稳稳的。

**多进程场景**：如果你同时开了几个 Claude Code 终端，它们都会发现令牌过期、都想去刷新。`checkAndRefreshOAuthTokenIfNeededImpl`（`src/utils/auth.ts:1443`）用了 `lockfile.lock(claudeDir)` 文件锁——谁先抢到锁谁刷新，其他进程等锁、拿到锁后再检查一次令牌是否已被刷新（"double-checked locking"），是的话直接用新令牌、不重复刷新。**还有一个跨进程失效机制**（`invalidateOAuthCacheIfDiskChanged`，`auth.ts:1316`）：进程 A 的 `/login` 写了新令牌到 `.credentials.json`，进程 B 通过 mtime 检测到文件变了，清掉自己的内存缓存、重读——避免"B 用 A 早就 revoke 掉的旧令牌反复 401"的死循环。

### 第四件事：我改了 API key 但没生效？三个最常见的"为什么"

这是排错章节里最高频的三个困惑，全部跟凭证生命周期有关。

**困惑 A：我在 `/login` 输了新 key，为什么下一个请求还在用旧的？**

如果你切的是 claude.ai 订阅或 Anthropic API Key（`workspaceApiKey`），`/login` 的 `onDone` 回调（`src/commands/login/login.tsx:33-65`）会做一连串副作用：`stripSignatureBlocks`（清掉绑旧 key 的签名块）、`resetCostState`（重置费用统计）、`authVersion++`（强制 hook 重新拉取 auth 相关数据）。这些做完之后下一次请求就是新 key。

但如果你切的是 **OpenAI 兼容层 / Grok**，就要小心了：`getOpenAIClient`（`src/services/api/openai/client.ts:39`）和 `getGrokClient`（`src/services/api/grok/client.ts:15`）都是**模块级缓存客户端实例**——首次调用读 `process.env.OPENAI_API_KEY` 创建 OpenAI SDK 实例，之后整个会话直接返回这个缓存的实例。你在会话中途改了 `process.env.OPENAI_API_KEY`，缓存里的 client 还握着旧 key。

**解决办法**：要么重启 Claude Code（最简单），要么代码层面调一次 `clearOpenAIClientCache()`（`client.ts:76`）或 `clearGrokClientCache()`（`grok/client.ts:42`）。**注意**：`/login` 表单改 key 的流程会同步更新 `process.env`（`ConsoleOAuthFlow.tsx:1464-1470` 的 `process.env[k] = v` 循环），但**不会自动 clear client cache**——这是已知的"改 key 必须重启"陷阱，尤其影响 dev 模式下的迭代调试。

**困惑 B：我跑了 `/provider unset`，为什么 key 还在？**

`/provider unset`（`src/commands/provider.ts:49-62`）只清 Provider 选择本身——它 `delete` 的是 `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` / `CLAUDE_CODE_USE_OPENAI` / `CLAUDE_CODE_USE_GEMINI` / `CLAUDE_CODE_USE_GROK` 这一组 Provider 触发变量，并把 `settings.json` 的 `modelType` 清空。**它不会清 `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROK_API_KEY` 这些 key 本身**。

这是有意为之——`unset` 的语义是"回到默认 Provider（firstParty）"，不是"清空所有认证"。如果你想彻底清掉某个 Provider 的 key，要手动编辑 `~/.claude/settings.json` 的 `env` 字段，或者 `/logout`（见下文）。

**例外**：如果你切到的是 bedrock / vertex / foundry 这三个云 Provider（`provider.ts:147-161` 的 else 分支），代码会顺手 `delete process.env.OPENAI_API_KEY` 和 `delete process.env.OPENAI_BASE_URL`——因为这些云 Provider 不应该带着 OpenAI 的 key 跑。但 gemini 和 grok 的 key 不会被清。

**困惑 C：我设了 `OPENAI_BASE_URL` 指向自己的端点，为什么有些行为还像在调官方 API？**

这是 `isFirstPartyAnthropicBaseUrl()` 的 TODO 陷阱（`src/utils/model/providers.ts:43-58`）。代码注释直白地写着："这里会有问题, 只配置了 openai 协议的用户, 按理说会为 true 导致问题"。

具体症状：`buildFetch`（`src/services/api/client.ts:366-367`）会在 `getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()` 都为真时，给每个请求注入一个 `x-client-request-id` header（用于服务端日志关联）。但 `isFirstPartyAnthropicBaseUrl()` 只看 `ANTHROPIC_BASE_URL`，不看 `OPENAI_BASE_URL`。如果你只设了 `OPENAI_BASE_URL` 指向自托管端点、没设 `ANTHROPIC_BASE_URL`，`isFirstPartyAnthropicBaseUrl()` 会因为 `ANTHROPIC_BASE_URL` 不存在而返回 `true`，然后这个注入逻辑就被错误地激活了。**目前没有完美绕过**，只能同时设 `ANTHROPIC_BASE_URL` 显式指向你的端点（哪怕你不调 Anthropic 协议）来让判断走 host 比较分支。

### 第五件事：`/logout` 到底清掉了什么

`/logout`（`src/commands/logout/logout.tsx`）是"全部清空"按钮。`performLogout` 会做这一串：

1. `flushTelemetry`（**先** flush 再清凭证，避免清了之后还拿着旧 org 的 telemetry 数据往外发）
2. `removeApiKey`（清 Anthropic API Key）
3. `removeChatGPTAuth`（删 `~/.claude/openai-chatgpt-auth.json`）
4. `clearChatGPTSettingsAuthMode`（清 `OPENAI_AUTH_MODE` env 和 settings）
5. `secureStorage.delete()`（清安全存储——macOS keychain 或 fallback）
6. `clearAuthRelatedCaches`（清 OAuth token 缓存、betas 缓存、tool schema 缓存、user cache、Grove 配置缓存、远程管理 settings 缓存、policy limits 缓存）
7. `saveGlobalConfig` 改 `oauthAccount: undefined`（清账号关联）
8. **2 秒后 `gracefulShutdownSync(0, 'logout')`**——logout 之后进程会退出

**所以 `/logout` 之后你必须重新 `/login`**。它不像 `/provider unset` 那样保留 key、只切 Provider。

### 给同事分享对话前要注意什么

`/share` 和 `/export` 的产物**默认不包含凭证原文**，但有几个隐私边界要注意：

- `/share`（`src/commands/share/index.ts`）会把错误信息里的 home 目录路径替换成 `~`、把长 stack trace 截断到 200 字符（`sanitizeErrorMessage`，`share/index.ts:31-39`）。这是为了避免在分享链接里泄漏你的本地路径结构。但它**不会**扫描对话内容里的 key——如果你在对话里粘贴过密钥（"帮我调试一下，我的 key 是 sk-..."），那段文本会被原样分享出去。分享前自己搜一下 `sk-` 之类的敏感前缀。
- `/export` 导出的是 transcript 的子集（消息、工具调用、结果），同样**不主动扫密钥**。导出的 JSON 里不会有 `~/.claude/.credentials.json` 的内容，但会有你在对话里手动输入过的任何东西。

**最稳的做法**：分享前 `/clear` 开一个干净会话复现问题，避免把历史对话里可能含的敏感信息带出去。

## 设计视角（写给开发者）

这一节回答一组环环相扣的设计问题：**为什么 Claude Code 的凭证存储是分散的而不是统一的？为什么 `getOpenAIClient` 做模块级缓存、`getAnthropicClient` 不做？为什么 ChatGPT 订阅路径要去读 Codex CLI 的凭证文件？为什么 OAuth 刷新的偏差窗口两边都是 5 分钟？为什么 `/provider unset` 的清理边界画在"Provider 触发变量"而不是"全部凭证"？** 每个决策都不是随手做的——它们各自回应一个具体的约束或权衡。

### 为什么凭证存储是按 Provider 分散的，而不是统一一个文件

打开凭证文件清单你会发现：Anthropic OAuth 在 `~/.claude/.credentials.json`、ChatGPT OAuth 在 `~/.claude/openai-chatgpt-auth.json`、Codex CLI 共享在 `~/.codex/auth.json`、各兼容层 key 在 `~/.claude/settings.json` 的 `env`、workspace key 在 `~/.claude.json`。**为什么不收敛到一个 `~/.claude/credentials.json`？**

三个理由，重要性递减：

1. **凭证生命周期不一样**。Anthropic OAuth 令牌会自动刷新、文件会被多进程并发写（`auth.ts:1443` 的 lockfile 锁），它需要独立的文件做 mtime 检测（`invalidateOAuthCacheIfDiskChanged`，`auth.ts:1316`）。ChatGPT OAuth 也会刷新但走完全不同的 OAuth 端点（`auth.openai.com` vs Anthropic 的 OAuth 服务器），它有自己的刷新逻辑（`refreshTokens`，`chatgptAuth.ts:289`）。如果塞同一个文件，两种刷新逻辑要协调文件锁、mtime、原子写——复杂度爆炸。**按 Provider 分文件，让每个 Provider 自己管自己的生命周期**，是最干净的切分。

2. **跨工具复用要求路径兼容**。ChatGPT 订阅路径回退读 `~/.codex/auth.json`（`chatgptAuth.ts:339-346`）是为了**复用 Codex CLI 已登录的凭证**——用户在 Codex 登过，Claude Code 就能用，不用重复登录。这个设计的前提是"不修改 Codex 的文件"——Claude Code 只读它，写还是写自己的 `~/.claude/openai-chatgpt-auth.json`。如果两个工具共用一个文件，谁刷新令牌、谁负责写、文件锁怎么共享都会变成跨工具协调问题。**只读对方、写自己**是最低耦合的复用方式。

3. **环境变量与 settings 的分层**。OpenAI / Gemini / Grok 的 key 是通过 `process.env` 读的（`getOpenAIClient` 的 `process.env.OPENAI_API_KEY`，`client.ts:46`），但 `/login` 把它们写到 `settings.json` 的 `env` 字段是为了**持久化 + 跨会话生效**。`applyConfigEnvironmentVariables`（在 `/provider` 命令末尾调用，`provider.ts:145`）负责把 settings.json 的 `env` 字段反推回 `process.env`，这样 client 实例化时就能读到。**为什么不直接写 shell rc 文件？** 因为 Claude Code 不应该改你的 shell 环境——那会把它的配置泄漏到所有终端会话。settings.json 的 `env` 字段是"只在 Claude Code 进程内生效的 env var"，作用域正确。

**这条分散设计的代价**：用户（和文档）需要记住五个不同的文件位置。这是清晰的复杂度——集中式存储看似简洁，但要把五种不同的刷新策略、并发安全、跨工具兼容塞进一个文件，复杂度只会更高、更难调试。

### 为什么 `getOpenAIClient` 做模块级缓存，`getAnthropicClient` 不做

打开两个 client 工厂对比：

- `getOpenAIClient`（`src/services/api/openai/client.ts:39`）：`let cachedClient: OpenAI | null = null`，首次调用创建实例后赋给 `cachedClient`，之后直接 return。需要清空时调 `clearOpenAIClientCache()`（`client.ts:76`）把 `cachedClient = null`。
- `getGrokClient`（`src/services/api/grok/client.ts:15`）：完全相同的模式，`cachedClient` + `clearGrokClientCache()`。
- `getAnthropicClient`（`src/services/api/client.ts:84`）：**没有模块级缓存**。每次调用都走完整的 client 构造流程——读 env、检查 OAuth、动态 import Bedrock/Foundry/Vertex SDK、构造 `new Anthropic(...)` 或 `new BedrockClient(...)` 等。

**为什么这种不对称？** 因为两个家族的 client 构造代价完全不同。

OpenAI / Grok 的 client 构造很便宜——读三个 env var、`new OpenAI({ apiKey, baseURL, ... })` 就完了。但每次 API 请求都重新构造一个 OpenAI SDK 实例会有隐性开销：SDK 内部会建立 HTTP agent、连接池、重试策略。**缓存这个实例让连接池能复用**，是合理的性能优化。

Anthropic 路径的 client 构造代价高且动态：它要根据 `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` 动态 import 不同的 SDK（`client.ts:153-298`），还要 `await checkAndRefreshOAuthTokenIfNeeded()`、`await refreshAndGetAwsCredentials()`、`await refreshGcpCredentialsIfNeeded()`——**这些都是异步、有副作用的**。每次调用都走一遍这套流程，相当于每次 API 请求都触发一次凭证刷新检查。**关键在于 Anthropic 路径的 client 实例按参数化构造**——`getAnthropicClient({ apiKey, model, ... })` 接收 model/region 参数，不同 model（比如 Haiku vs Sonnet）可能要走不同的 AWS region（`ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION`，`client.ts:157-160`）。模块级单例缓存根本对不上这种参数化需求。

**这条不对称的代价**就是产品视角提到的"困惑 A"——会话中途改 OpenAI/Grok key，缓存里的 client 握着旧 key。`clearOpenAIClientCache` 是逃生口，但 `/login` 表单流程没调它。这是"性能优化 vs 配置变更"的固有张力：缓存越激进，改配置越要手动清缓存。

**为什么 `clearOpenAIClientCache` 还存在？** 因为它服务于 dev/调试场景——开发者在 REPL 里 `process.env.OPENAI_API_KEY = '...'` 手动改环境变量做实验，调一次 clear 就能强制重建 client。生产用户的等价操作是重启进程。

### 为什么 OAuth 刷新偏差窗口两边都是 5 分钟

打开两处刷新判断的代码：

```ts
// Anthropic OAuth —— src/services/oauth/client.ts:344
export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) return false;
  const bufferTime = 5 * 60 * 1000;  // 5 分钟
  const now = Date.now();
  const expiresWithBuffer = now + bufferTime;
  return expiresWithBuffer >= expiresAt;
}

// ChatGPT OAuth —— src/services/api/openai/chatgptAuth.ts:9
const REFRESH_SKEW_MS = 5 * 60 * 1000;  // 同样 5 分钟
// ...
if (expiresAt !== null && expiresAt <= Date.now() + REFRESH_SKEW_MS) {
  tokens = await refreshTokens(tokens);
  await saveStoredAuth(tokens);
}
```

**两边都是 5 分钟，不是巧合**。这个数字回应一个共同的约束：**API 请求的端到端延迟不可忽略**。

考虑这条时间线：`getValidChatGPTAuth` 判断"快过期"→ 触发 `refreshTokens`（一次 OAuth 端点的网络 round-trip，可能 200ms-2s）→ 拿到新 access_token → 用它发 API 请求（排队 + 模型推理，几秒到几十秒）。如果偏差窗口留得太短（比如 10 秒），就会出现：判断"还没过期"→ 用旧 token 发请求 → 请求到达服务端时 token 已经过期 → 401。5 分钟窗口给整个请求链路（刷新 + 排队 + 推理）留出了充足余量。

**为什么不更长，比如 30 分钟？** 因为偏差窗口越长，刷新越频繁，OAuth 服务端承受的 refresh 请求越多。对 Anthropic 这种用户量级，每个用户每 25 分钟刷一次 vs 每 55 分钟刷一次，服务端负载差一倍。5 分钟是"请求链路延迟的上界估计 + 余量"的工程取舍——它不会卡到过期边界，也不会刷新得太勤。

**ChatGPT 路径的额外复杂度**：`getValidChatGPTAuth`（`chatgptAuth.ts:339-361`）还有一条**读 Codex 文件的回退逻辑**。先读 `~/.claude/openai-chatgpt-auth.json`，读不到再读 `~/.codex/auth.json`。**为什么这么做？** 因为 OpenAI 官方 Codex CLI 用的是同一个 OAuth client_id（`CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'`，`chatgptAuth.ts:7`）——也就是说 Codex CLI 和 Claude Code 在 OpenAI 那边注册的是**同一个应用**。用户在 Codex 登录拿到的令牌，Claude Code 拿来直接能用，因为对 OpenAI 服务端来说是同一个 client。这是一个相当大胆的跨工具复用决策——它把"Codex 装了 → Claude Code 免登录"做成了零配置体验，代价是两个工具的 OAuth client_id 必须永远保持一致。

### 为什么 `/provider unset` 的清理边界画在 Provider 触发变量，而不清 key

打开 `src/commands/provider.ts:49-62` 的 `unset` 分支：

```ts
if (arg === 'unset') {
  updateSettingsForSource('userSettings', { modelType: undefined });
  // Also clear all provider-specific env vars to prevent conflicts
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.CLAUDE_CODE_USE_VERTEX;
  delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  delete process.env.CLAUDE_CODE_USE_OPENAI;
  delete process.env.CLAUDE_CODE_USE_GEMINI;
  delete process.env.CLAUDE_CODE_USE_GROK;
  return {
    type: 'text',
    value: 'API provider cleared (will use environment variables).',
  };
}
```

它清的是 `modelType` 和六个 `CLAUDE_CODE_USE_*`——**全部是"Provider 选择"层**。它不清 `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROK_API_KEY` / `OPENAI_BASE_URL` / 任何 settings.json `env` 字段里实际存的 key。

**为什么这么画边界？** 因为"切换 Provider"和"清空凭证"是两个独立的用户意图。`/provider unset` 的返回文案说得很清楚："API provider cleared (will use environment variables)"——它的语义是"回到 firstParty 默认，接下来按 env var 决定行为"，**不是"把我所有的 key 都删了"**。如果 unset 顺手清了 key，用户切个 Provider 试一下、再切回来，key 就没了——这是不可接受的数据丢失。

**真正"清凭证"的命令是 `/logout`**（见产品视角）——它做完整的清空 + 进程退出。`unset` 和 `logout` 的分工是：`unset` 改 Provider 选择（可逆，不动凭证），`logout` 清认证身份（不可逆，进程退出）。

**有意思的对比**：`/provider` 切换到 bedrock / vertex / foundry（云 Provider）时（`provider.ts:147-161`），代码会顺手 `delete process.env.OPENAI_API_KEY` 和 `delete process.env.OPENAI_BASE_URL`。**为什么这三个 Provider 特殊？** 因为云 Provider 走的是 Anthropic 协议（Bedrock / Vertex / Foundry 都是 Anthropic 模型在云厂商的托管），不应该带着 OpenAI 协议的 key 跑——带了反而可能让 SDK 误判走错路径。Gemini / Grok 的 key 不被清，是因为它们和 firstParty 之间不存在协议混淆风险（Provider 选择本身就是排他的）。

### 为什么 `/login` 的 `onDone` 要做那么多副作用

打开 `src/commands/login/login.tsx:33-65`——`onDone` 回调在登录成功后会做这一串：

```ts
context.onChangeAPIKey();
context.setMessages(stripSignatureBlocks);  // 清掉绑旧 key 的签名块
resetCostState();                            // 重置费用统计
void refreshRemoteManagedSettings();         // 拉新的远程管理 settings
void refreshPolicyLimits();                  // 拉新的 policy limits
resetUserCache();                            // 清 user 数据缓存
refreshGrowthBookAfterAuthChange();          // 刷 GrowthBook feature flags
clearTrustedDeviceToken();                   // 清旧的 trusted device token
void enrollTrustedDevice();                  // 重新注册 trusted device
resetAutoModeGateCheck();                    // 重置 auto mode 检查
context.setAppState(prev => ({ ...prev, authVersion: prev.authVersion + 1 }));
```

**为什么这么多副作用？** 因为登录本质上是"切换身份"——身份变了，所有跟身份绑定的状态都得跟着刷新，否则就会出现"用 A 身份登录、UI 上显示的还是 B 身份的数据"的撕裂。

逐条看：

- `stripSignatureBlocks`：thinking blocks 和 connector_text 这些字段在 API 响应里是带签名的（绑 API key）。新 key 不能验证旧 key 的签名，所以必须清掉，否则下一次请求会被服务端拒。
- `resetCostState`：费用统计是按账号累计的，换账号必须清零。
- `refreshRemoteManagedSettings` / `refreshPolicyLimits`：远程管理的 settings 和 policy limits 是按 org/account 下发的，换账号要重新拉。
- `resetUserCache` + `refreshGrowthBookAfterAuthChange`：**顺序很重要**——必须先清 user cache 再刷 GrowthBook，否则 GrowthBook 会拿到旧账号的 user 数据去判 feature flag。注释（`login.tsx:46-48`）专门写了这一点。
- `clearTrustedDeviceToken` + `enrollTrustedDevice`：**也必须先清再注册**（`login.tsx:51-54` 注释）——否则异步的 `enrollTrustedDevice` 还在飞行中时，bridge 调用可能拿着旧账号的 trusted device token 发出去。
- `authVersion++`：这是一个"脏检查"版本号。`useAppState` 的 hook 订阅这个字段，它变了就触发重新拉取 auth 相关数据（比如 MCP server 列表是按账号不同的）。

**这条设计的核心原则**：登录不是"换一个字符串"，而是"切换一整套绑身份的状态"。`onDone` 这串副作用是在明确枚举所有跟身份绑定的子系统，确保它们同步更新。**代价**是这条回调很长、修改时要小心——加一个新的"绑身份"子系统，必须在这里加对应的刷新调用，否则就会出现状态撕裂。这是"集中式身份切换"的维护成本。

### 为什么凭证文件要 `chmod 0o600`，settings.json 不要

打开 `saveStoredAuth`（`chatgptAuth.ts:148-165`）——写 `openai-chatgpt-auth.json` 时显式 `mode: 0o600`，然后 `chmod(path, 0o600)` 兜底（`chatgptAuth.ts:164`）。**为什么这么严格？**

因为这个文件包含 `access_token` / `refresh_token` / `id_token`——任何能读这个文件的人都能冒用你的 ChatGPT 订阅。0600（owner 读写，其他人无权限）是文件系统层面的最低保护。兜底的 `chmod` 是为了应付 umask 没生效或跨平台差异——某些系统 `writeFile({ mode: 0o600 })` 会被 umask 削成 0644，显式 `chmod` 把权限补回去。

**对比**：`settings.json` 里的 `OPENAI_API_KEY` 没有这种保护——它就是普通 JSON 文件，按你的 umask 走。**为什么差别对待？** 因为 API key 是可以撤销的（去服务商面板 revoke），泄露后的止损路径清晰。OAuth refresh_token 撤销要复杂得多（要走 OAuth revocation endpoint、还可能影响其他用同一 OAuth 应用的工具）。**敏感度越高，文件权限越严**——这是一个朴素但被严格执行的原则。

### 为什么 Anthropic 的 workspace key 走 macOS keychain，OpenAI 兼容层的 key 走明文 settings

打开 `src/utils/secureStorage/`——有 `macOsKeychainStorage.ts` / `plainTextStorage.ts` / `fallbackStorage.ts`。`workspaceApiKey`（Anthropic 的自定义 API Key）在 macOS 上会优先走 keychain（`src/utils/auth.ts` 的 `getApiKeyFromApiKeyHelper` 流程）。但 OpenAI / Gemini / Grok 的 key 直接写在 settings.json 的 `env` 字段、明文存储。

**为什么不对称？** 两个原因：

1. **历史路径依赖**。Anthropic 的 API Key 存储从早期就走 keychain（因为 Anthropic 是默认 Provider，它的 key 是核心凭证）。OpenAI 兼容层是后加的（反编译重建时恢复的），它复用了 `settings.json` 的 `env` 字段——这个字段本来就是"明文环境变量配置"，加 key 进去是最低改造成本。
2. **跨平台**。macOS keychain 是平台特性，Linux / Windows 没有等价物（`fallbackStorage.ts` 是降级方案）。OpenAI 兼容层要在所有平台一致工作，最简单就是不用 keychain。Anthropic 路径在非 macOS 平台也会降级到 fallback 存储。

**这条不对称的安全含义**：你的 `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROK_API_KEY` 是**明文存在 `~/.claude/settings.json` 里的**。任何能读这个文件的进程（包括你运行的任何脚本、任何被攻破的进程）都能拿到这些 key。**实践建议**：如果你在共享机器上用，把 key 放 shell env var（`export OPENAI_API_KEY=...`）而不是 `/login` 表单——shell 配置文件至少权限是 0600 默认、不进 git。

## 两视角如何呼应

用户视角的每一个"凭证相关的痛点"，在设计视角都能找到对应的边界决策：

- **"我的密钥去了哪里"**（产品视角的凭证文件清单）对应 **"为什么凭证存储按 Provider 分散、为什么不收敛到一个文件"**（设计视角）——用户要记五个文件位置，是因为三种凭证生命周期（OAuth 自动刷新 / API Key 手动管理 / 兼容层 env 配置）的并发安全和跨工具复用要求不同的存储策略，强行合并只会让复杂度从"五个文件"变成"一个文件里的五种锁"。
- **"我改了 key 为什么没生效"**（产品视角困惑 A）对应 **"`getOpenAIClient` 为什么做模块级缓存、`getAnthropicClient` 为什么不做"**（设计视角）——用户遇到的是"改了 key 还在用旧的"，开发者看到的是"连接池复用的性能优化 vs 配置变更的缓存失效"的固有张力。`clearOpenAIClientCache` 是逃生口，但 `/login` 表单没调它——这是已知的设计缺口，不是 bug。
- **"令牌什么时候过期、怎么自动刷新"**（产品视角第三段）对应 **"为什么两边偏差窗口都是 5 分钟、为什么有跨进程 lockfile"**（设计视角）——用户看到的是"不用手动刷新，自动续期"，开发者看到的是"API 请求端到端延迟的工程余量 + 多进程并发刷新的 double-checked locking + 跨进程 mtime 失效"的三重设计。
- **"`/provider unset` 为什么 key 还在"**（产品视角困惑 B）对应 **"为什么 unset 的清理边界画在 Provider 触发变量、不清 key 本身"**（设计视角）——用户期望 unset 是"全部清空"，开发者把它定位成"可逆的 Provider 切换"，把"不可逆的凭证清空"留给 `/logout`。两个命令的分工是明确且有意的。
- **"用 Codex CLI 登过，Claude Code 为什么不用再登"**（产品视角第三种登录路径）对应 **"ChatGPT 路径为什么读 `~/.codex/auth.json`、为什么两个工具共用一个 OAuth client_id"**（设计视角）——用户看到的是"零配置跨工具体验"，开发者看到的是"两个工具注册为同一个 OAuth 应用、只读对方凭证、写自己凭证"的最低耦合复用，代价是 client_id 永远不能改。
- **"分享对话前要注意什么"**（产品视角末段）对应 **"`sanitizeErrorMessage` 为什么只清路径不清 key、为什么 `/share` 和 `/export` 不主动扫密钥"**（设计视角）——用户被告知"分享前自己搜一下 `sk-`"，开发者看到的是"自动扫密钥的误报风险（误伤合法的 sk- 前缀 demo key）和实现成本（要支持几十种 Provider 的 key 格式识别），所以只做路径清理这种零误报的操作，把 key 识别留给用户"。

这种呼应关系是"凭证与认证生命周期"必须双视角覆盖的核心原因：用户视角告诉你**密钥去哪了、怎么管理、出了问题怎么自救**，设计视角告诉你**为什么 token 这么存、这个缓存策略逼出了什么权衡、跨工具复用是怎么落到代码里的**。两个视角合在一起，才能让使用者正确选择登录方式（订阅 OAuth / API Key / 兼容层表单 / 跨工具复用）并知道每种方式的凭证文件位置和过期行为，也让开发者在改 Provider 系统时知道"为什么不能把所有 key 塞一个文件、为什么 client 缓存策略要按 Provider 家族区分、为什么 OAuth 偏差窗口改了会出问题"——而不是把每个决策都重新走一遍、甚至不小心破坏跨工具凭证复用或多进程刷新安全。
