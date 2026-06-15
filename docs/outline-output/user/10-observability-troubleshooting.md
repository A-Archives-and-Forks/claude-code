# 第十章：可观测性与排错 -- 卡住了怎么办

> Claude 报错、卡住、行为不对？本章帮你快速定位原因并解决。

## 第一步永远先跑：`claude doctor`

遇到任何不明原因的问题，第一件事是跑 `/doctor`（或在终端输入 `claude doctor`）。这个命令会自动检查你的安装环境、配置文件、MCP 连接状态、插件加载情况、版本是否最新，并给出一份结构化的诊断报告。

在 REPL 中输入：

```
/doctor
```

或在终端直接运行：

```bash
claude doctor
```

Doctor 会逐项检查并标记状态。常见检查项包括：

- 版本是否过期（与 npm 远程 `latest` / `stable` 标签对比）
- 配置文件 (`settings.json` / `settings.local.json`) 是否有语法错误
- MCP server 是否成功连接
- 插件是否有加载失败
- Sandbox / 权限相关检测
- Keybinding 冲突警告

另一个快速自检命令是 `bun run health`，它会检查运行时依赖是否齐全。如果你在开发模式下使用（`bun run dev`），这个命令可以在不启动完整 REPL 的情况下快速验证环境。

## Provider 报错对照表

API 调用失败时，Claude Code 会显示错误信息。以下是常见错误码的含义和应对方法。

### 401 / 403 -- 认证失败

**401 Unauthorized**：API key 无效、过期或未设置。检查你当前的 Provider 配置：

```
/provider
```

确认 key 已正确设置。如果你使用 OpenAI 兼容层，确认 `OPENAI_API_KEY` 环境变量已填入有效值。

**403 Forbidden**：通常表示地区限制或账号权限不足。某些 API 端点对特定地区不可用，或者你的订阅计划不包含所请求的模型。

### 429 -- 限流

当请求频率超过 API 的速率限制时，你会收到 429 错误。Claude Code 会自动解析 OpenAI 兼容层的限流响应头：

- `x-ratelimit-remaining-requests` / `x-ratelimit-limit-requests` -- 每分钟请求数
- `x-ratelimit-remaining-tokens` / `x-ratelimit-limit-tokens` -- 每分钟 token 数
- `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens` -- 重置时间

限流发生时，最直接的做法是等一会儿再试。如果你是 Anthropic 订阅用户，可以在 REPL 中输入 `/rate-limit-options` 查看可用的升级方案。

### overloaded_error（1305） -- 上游过载

这是 Anthropic API 返回的 `overloaded_error`（错误码 1305），表示服务端暂时过载。与限流不同，这不是你的请求频率问题，而是 Anthropic 服务本身在排队。等几分钟再重试即可。

### 模型不存在

当你请求的模型名称无法被 Provider 识别时，请求会失败。例如使用 Gemini 兼容层时，如果 `GEMINI_MODEL` 和 `GEMINI_DEFAULT_SONNET_MODEL` / `GEMINI_DEFAULT_OPUS_MODEL` 都没有设置，模型映射可能找不到匹配项，Gemini 客户端会直接抛出异常。

确认你当前使用的模型：

```
/model
```

## 兼容层特有坑

使用 OpenAI / Gemini / Grok 兼容层时，除了上述通用错误，还可能遇到以下兼容层特有的问题。

### DeepSeek `reasoning_content` 缺失

DeepSeek 在启用思维模式时会返回 `reasoning_content` 字段。如果某次请求的响应中缺少这个字段（即使是空值），下一次请求会被 DeepSeek API 拒绝并返回 400 错误。这是因为兼容层在流适配过程中，如果未回显 `reasoning_content: ''`（空字符串），会导致 DeepSeek 的会话状态不一致。

如果你使用 DeepSeek 且频繁遇到 400 错误，尝试切换到普通模型（关闭思维模式），或检查你的 DeepSeek 端点版本是否支持思维模式。

### OpenAI 客户端缓存

`getOpenAIClient()` 使用模块级缓存：第一次调用后客户端实例被缓存，后续调用直接返回缓存实例。这意味着如果你在运行期间修改了 `OPENAI_API_KEY` 或 `OPENAI_BASE_URL`，新值不会生效。

解决方法：重启 Claude Code。在脚本或自动化场景中，需要中途更换 key 的，可以调用 `clearOpenAIClientCache()` 清除缓存。同样的问题也存在于 `getGrokClient()`。

### Gemini 模型映射失败

Gemini 是唯一在模型映射链全部缺失时直接抛出异常的 Provider。映射优先级为：`GEMINI_MODEL` > `GEMINI_DEFAULT_SONNET_MODEL` / `GEMINI_DEFAULT_OPUS_MODEL` > 默认映射表。如果默认映射表中找不到匹配项，你会看到类似以下错误：

```
Gemini API request failed (404 Not Found): ...
```

设置明确的模型名称可以避免这个问题：

```json
{
  "env": {
    "GEMINI_MODEL": "gemini-2.5-pro"
  }
}
```

## Bedrock Opus 4.7 的 400 错误

如果你使用 AWS Bedrock 作为 Provider，调用 Opus 4.7 模型时可能遇到 400 "invalid beta flag" 错误。这是一个已知的上游 SDK bug：`@anthropic-ai/bedrock-sdk`（版本 0.26.4 至 0.28.1）会将 `anthropic-beta` HTTP 头的值错误地复制到请求体的 `anthropic_beta` 字段中，而 Bedrock 的 Opus 4.7 端点会拒绝请求体中包含此字段的请求。

Claude Code 通过自定义的 `BedrockClient`（继承自 `AnthropicBedrock`）自动修补这个问题：在 SDK 构建 `buildRequest` 完成后，删除请求体中的 `anthropic_beta` 字段，同时保留 HTTP 头中的正确值。

项目提供了 probe 脚本用于验证 SDK 状态：

```bash
bun run scripts/probe-local-wiring.ts
```

## MCP server 连不上

当 MCP server 无法连接时，检查以下几点：

**stdio 模式**：确认命令路径和参数正确。

```bash
claude mcp list
```

检查已配置的 MCP server 列表。确认 `command` 指向的可执行文件存在且可执行。

**SSE 模式**：确认 URL 可达、超时设置合理。如果 MCP server 启动较慢，可能需要调整超时时间。

**OAuth 认证**：某些 MCP server 需要 OAuth 授权。在 REPL 中使用 `/mcp-auth` 进行认证。如果认证失败，检查回调 URL 是否正确配置。

**MCP 配置语法错误**：`claude mcp list` 会显示解析警告。如果添加 server 后出现 `McpParsingWarnings`，说明配置 JSON 有格式问题，需要修正。

## 权限被拒、工具被禁用、延迟工具没加载

Claude Code 使用权限模式控制工具的使用。如果你发现某个工具被禁用或权限被拒：

1. **确认当前权限模式**：在 REPL 中输入 `/permissions` 查看当前权限规则。
2. **权限规则配置**：在 `settings.json` 中配置 `allow` / `deny` 规则，使用工具名匹配和 glob 模式。例如：

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test*)",
      "FileReadTool"
    ],
    "deny": [
      "Bash(rm -rf*)"
    ]
  }
}
```

3. **延迟工具加载**：60 个内置工具中，只有 38 个核心工具是始终加载的（`CORE_TOOLS` 白名单）。其余工具通过 `SearchExtraTools` 按需搜索和加载。如果你需要的工具没有被自动加载，可以在对话中明确提及工具名，触发搜索和加载过程。

## 内存膨胀与长会话

长时间运行的会话（daemon 模式、`/loop` 循环、大量工具调用）可能导致内存膨胀。这是因为 Bun 使用的 JSC 引擎的 `Performance` 对象将 marks/measures 存储在一个永不收缩的 C++ Vector 中。

Claude Code 通过 `performanceShim` 解决这个问题：它在启动时将 `globalThis.performance` 替换为 JS Map 支持的实现，`performance.now()` 仍然走原生（精确且快速），但 `mark` / `measure` / `getEntries` 操作存储在 GC 可回收的 JS 内存中。

如果你仍然感觉到长会话变慢，可以：

1. 使用 `/compact` 压缩上下文，减少内存中的消息量。
2. 使用 `/force-snip` 强制裁剪更早的消息。
3. 重启 Claude Code 会话。

## 调试模式

### `BUN_INSPECT` 调试器

使用 Bun 内置的调试器来排查运行时问题：

```bash
BUN_INSPECT=9229 bun run dev:inspect
```

然后连接 Chrome DevTools（打开 `chrome://inspect`）或使用 VS Code 的调试面板连接到 `ws://localhost:9229`。

### `--dump-system-prompt`

查看当前构建版本生成的完整系统提示（需要 `DUMP_SYSTEM_PROMPT` feature 启用）：

```bash
FEATURE_DUMP_SYSTEM_PROMPT=1 claude --dump-system-prompt --model claude-sonnet-4-20250514
```

这会将渲染后的系统提示打印到终端，适合调试 prompt 组装逻辑。

### `/debug-tool-call` 查看工具调用

在 REPL 中输入 `/debug-tool-call` 查看最近 5 次工具调用的输入和输出。指定数字可以查看更多：

```
/debug-tool-call 10
```

它会从当前会话的 transcript 日志中读取最近的工具调用对，显示工具名、输入参数和返回结果。

### `/perf-issue` 性能快照

当遇到性能问题时，使用 `/perf-issue` 生成一份详细的性能报告：

```
/perf-issue
```

报告保存到 `~/.claude/perf-reports/` 目录，包含：

- 进程内存使用（RSS、heap、external）
- CPU 使用统计
- Token 用量分解（input/output/cache_creation/cache_read）
- 缓存命中率
- 费用估算（基于 Anthropic 公开定价）
- 工具调用次数和平均执行时间
- 会话挂钟时间

支持三种输出格式：

```
/perf-issue --format=json
/perf-issue --format=csv
/perf-issue --format=md
```

### `/heapdump` 堆快照

当怀疑内存泄漏时，使用 `/heapdump` 导出 V8 堆快照文件：

```
/heapdump
```

快照文件会保存到桌面（`~/Desktop/`），可以用 Chrome DevTools 的 Memory 面板加载分析。

## Langfuse 追踪

如果你想深入了解每次 API 调用的细节（模型、Provider、token 消耗、工具执行链路），可以启用 Langfuse 追踪。Langfuse 是一个开源的 LLM 可观测性平台，支持自部署或使用 Langfuse Cloud。

在 `settings.json` 中配置三个必填环境变量：

```json
{
  "env": {
    "LANGFUSE_PUBLIC_KEY": "pk-xxx",
    "LANGFUSE_SECRET_KEY": "sk-xxx",
    "LANGFUSE_BASE_URL": "https://cloud.langfuse.com"
  }
}
```

可选参数包括 `LANGFUSE_TRACING_ENVIRONMENT`（环境标签，默认 `development`）、`LANGFUSE_FLUSH_AT`（批量发送阈值，默认 20）、`LANGFUSE_FLUSH_INTERVAL`（定时刷新间隔秒数，默认 10）等。

未配置时，所有追踪函数为 no-op，零开销。

启用后，每次查询会创建一个 Trace（agent 类型），其中包含：

- **LLM Generation** -- 记录 API 调用，按 Provider 映射为不同名称（`ChatAnthropic`、`ChatOpenAI`、`ChatGoogleGenerativeAI`、`ChatXAI` 等）
- **Tool Observation** -- 记录每个工具调用的输入输出和耗时
- **子 Agent Trace** -- 通过 Agent 工具派生的子代理有独立的 Trace

所有上传的数据会自动脱敏：API key、token、password 等敏感字段被替换为 `[REDACTED]`，文件读写工具的输出被完全遮蔽，Shell 工具输出截断至 500 字符。

## 导出会话

当你需要把对话记录分享给同事、存档或提交 bug 报告时，可以使用以下命令：

- `/export` -- 导出当前会话为文件
- `/share` -- 分享会话（具体格式取决于实现）
- `/recap` -- 生成会话摘要

注意隐私边界：导出的内容可能包含你对话中的代码片段和文件内容，但不会包含 API key 等凭证。在分享前检查导出内容，确保不包含敏感信息。

## 反馈与上报 bug

### `/feedback` 提交反馈

在 REPL 中输入 `/feedback` 可以提交产品反馈。你可以在描述中附上遇到的问题，也可以引用 `/perf-issue` 生成的报告。

### `/bughunter` 自动排查

`/bughunter` 命令在当前版本中为 stub（`isEnabled` 返回 `false`），尚未实现。

### GitHub Issues

如果以上方法都无法解决问题，可以在项目 GitHub 仓库提交 Issue。提交时建议附上：

- `/perf-issue` 生成的性能报告
- `/debug-tool-call` 的输出
- 具体的错误信息和复现步骤
- 你使用的 Provider 和模型

## 已知禁用的 feature flag

以下 feature flag 在构建时被禁用，启用可能导致核心功能异常：

- `CONTEXT_COLLAPSE` -- 上下文折叠（反编译丢失）
- `HISTORY_SNIP` -- 历史剪裁（反编译丢失）
- `FORK_SUBAGENT` -- 分叉子代理（反编译丢失）
- `UDS_INBOX` -- Unix Domain Socket 收件箱（反编译丢失）
- `LAN_PIPES` -- 局域管道（反编译丢失）
- `REVIEW_ARTIFACT` -- 代码审查产物（反编译丢失）
- `SKILL_LEARNING` -- 技能学习（原本即为 stub）
- `TEAMMEM` -- 团队成员（原本即为 stub）

除非你清楚知道后果，否则不要通过 `FEATURE_<NAME>=1` 启用这些 flag。

## 下一步

- 想配置 Provider 和模型，看 [第二章](./02-providers.md)
- 想理解 slash 命令，看 [第四章](./04-slash-commands.md)
- 想配置 MCP server 和插件，看 [第五章](./05-mcp-plugins-skills.md)
- 想省钱和优化性能，看 [第九章](./09-budget-cache-hooks.md)
