# 第十三章：安全 —— 凭证、权限、刷新、共享

> 你的 API 密钥和令牌到底存在哪里、谁能看到、怎么撤回。

## 凭证存储位置清单

Claude Code 在运行过程中会接触多种凭证，分布在 `~/.claude/` 目录下的几个文件中。了解它们的位置和用途，是保护自己账户安全的第一步。

**Anthropic API Key（Workspace Key）**

Anthropic 的 API 密钥有两个来源。优先级最高的是环境变量 `ANTHROPIC_API_KEY`，其次是全局配置文件 `~/.claude.json` 中的 `workspaceApiKey` 字段。当你通过 `/login` 选择 "API Usage Billing" 时，密钥会被保存到 `~/.claude.json`。保存后，代码会尝试对文件执行 `chmod 600`，确保只有文件所有者可以读取。在 Windows 上 `chmod` 无效，代码会输出一条提醒，建议你用 `icacls` 手动限制访问。

Workspace Key 只接受 `sk-ant-api03-` 前缀的密钥，长度限制在 20 到 256 字符之间。错误信息中永远不会包含密钥原文，即使验证失败也只会显示前 4 个字符。

```bash
# 查看当前配置中是否存有 Workspace Key
cat ~/.claude.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('has workspaceApiKey' if 'workspaceApiKey' in d else 'no workspaceApiKey')"
```

**ChatGPT 订阅凭证**

如果你通过 ChatGPT 订阅路径使用 Claude Code（`OPENAI_AUTH_MODE=chatgpt`），OAuth 令牌会存储在 `~/.claude/openai-chatgpt-auth.json` 中。这个文件的权限是 `0600`（仅 owner 可读写）。文件中包含 `id_token`、`access_token`、`refresh_token` 三类令牌和上次刷新的时间戳。

```json
// ~/.claude/openai-chatgpt-auth.json（简化示意）
{
  "auth_mode": "chatgpt",
  "tokens": {
    "id_token": "eyJhbGc...",
    "access_token": "eyJhbGc...",
    "refresh_token": "v1.MjQ...",
    "account_id": "account-abc123"
  },
  "last_refresh": "2025-06-14T10:30:00.000Z"
}
```

**跨工具共享的 Codex 凭证**

Claude Code 会检查 `~/.codex/auth.json`（路径受 `CODEX_HOME` 环境变量影响）。当 `~/.claude/openai-chatgpt-auth.json` 中没有有效令牌时，会回退读取这个文件。这意味着如果你之前用 Codex CLI 登录过同一个 ChatGPT 账户，Claude Code 可以直接复用那些令牌，不需要再走一遍设备码流程。

**Trusted Device Token**

在 Bridge / Remote Control 模式下，Claude Code 使用受信任设备令牌来标识已注册的设备。这个令牌存储在 macOS Keychain 中（通过 `security` 命令读写），不是普通的文件。你也可以通过环境变量 `CLAUDE_TRUSTED_DEVICE_TOKEN` 手动指定一个令牌，这在测试场景中很方便。

**`settings.json` / `settings.local.json`**

这两个文件存储权限规则、hooks、keybindings 等配置。`settings.json` 是团队共享的，`settings.local.json` 是个人覆盖，后者不应提交到版本控制。这两个文件本身不存储 API 密钥，但如果你在 hooks 中引用了密钥路径，就要注意不要把它们分享出去。

## OAuth 设备码流程

Claude Code 支持两种 OAuth 登录路径：Anthropic 官方 OAuth 和 ChatGPT 订阅的设备码流程。两者的交互方式类似，但底层协议不同。

**Anthropic OAuth（/login 默认路径）**

输入 `/login` 后选择 "Subscription Plan" 或 "API Usage Billing"，终端会打开浏览器跳转到 Anthropic 的 OAuth 页面。你在浏览器中完成授权后，终端会收到授权码（通过粘贴码或自动回调），然后 Claude Code 用这个码换取 access token 并保存到系统。登录成功后，代码会刷新 GrowthBook feature flags、策略限制、远程托管设置，并注册受信任设备令牌。

如果浏览器没有自动打开，终端会在几秒后提示你手动复制 URL 并粘贴返回的授权码。输入 `c` 可以快速复制 URL 到剪贴板。

**ChatGPT 订阅设备码流程**

当你选择 ChatGPT 订阅作为后端时，`/login` 会启动一个不同的设备码流程。流程分为三步：

1. 请求设备码：向 `https://auth.openai.com/api/accounts/deviceauth/usercode` 发送 POST 请求，获取一个 6 位的用户码和 `deviceAuthId`。
2. 等待授权：终端提示你打开 `https://auth.openai.com/codex/device` 并输入用户码。之后 Claude Code 每 5 秒轮询一次 token 端点，等待你完成授权。超时上限是 15 分钟。
3. 交换令牌：授权完成后，用 `authorization_code` 和 `code_verifier` 向 `/oauth/token` 端点换取 `id_token`、`access_token` 和 `refresh_token`，然后保存到 `~/.claude/openai-chatgpt-auth.json`。

```
# 设备码流程终端输出示意
> /login
  1. Anthropic Subscription Plan (Claude Pro/Max)
  2. API Usage Billing (Anthropic Console)
  3. ChatGPT account with subscription
  4. OpenAI Chat Completions API
  5. Gemini API
  ...
[选择 3]

Requesting device code...
Please open this URL in your browser and enter the code:

  URL:   https://auth.openai.com/codex/device
  Code:  ABC-DEF

Waiting for authorization... (timeout: 15m)
Authorization successful. Tokens saved.
```

**中国 LLM 提供商**

中国 LLM 提供商（DeepSeek、智谱 GLM、通义千问、Moonshot、Cerebras、Groq）使用不同的登录流程。在 `/login` 中选择对应的提供商后，终端会展示一个选择界面，让你选择访问模式（API 或 Coding Plan），然后输入 API Key。这些密钥会保存到配置中，不走 OAuth 设备码流程。

## OAuth 令牌自动刷新

ChatGPT 订阅路径的令牌不会永不过期。Claude Code 在每次使用令牌前都会检查是否即将过期，并在必要时自动刷新。

**5 分钟偏差窗口**

`chatgptAuth.ts` 中定义了一个常量 `REFRESH_SKEW_MS = 5 * 60 * 1000`（5 分钟）。当 access token 的过期时间距离当前时间不到 5 分钟时，就会触发刷新。这意味着即使在高延迟的网络环境下，也不会因为令牌刚好过期而中断操作。

刷新使用 `refresh_token` 向 `/oauth/token` 发送 `grant_type=refresh_token` 请求。成功后获得新的 `id_token`、`access_token`，以及可能更新的 `refresh_token`（如果服务端返回了新的）。新令牌会立即写回 `~/.claude/openai-chatgpt-auth.json` 并更新 `last_refresh` 时间戳。

**Bridge 模式的令牌刷新**

在 Bridge（Remote Control）模式下，Claude Code 使用 `createTokenRefreshScheduler` 来管理会话令牌的自动刷新。这个调度器会解析 JWT 的 `exp` 字段，在令牌过期前 5 分钟触发刷新。如果 JWT 无法解析（例如使用了不透明的 OAuth token），调度器会保持现有的定时器不被覆盖，避免中断刷新链。

刷新失败时不会立刻放弃，而是会重试最多 3 次（`MAX_REFRESH_FAILURES = 3`），每次间隔 60 秒。如果连续 3 次都无法获取新的 OAuth token，调度器会停止尝试，后续需要手动重新连接。

```
# Bridge 模式令牌刷新日志示意
[bridge:token] Scheduled token refresh for sessionId=abc123 in 25m (expires=2025-06-14T12:00:00.000Z, buffer=300s)
[bridge:token] Refreshing token for sessionId=abc123: new token prefix=eyJhbGcDk7xYk2...
[bridge:token] Scheduled follow-up refresh for sessionId=abc123 in 30m
```

**Anthropic OAuth 刷新**

Anthropic 官方 OAuth 的令牌刷新机制嵌入在 `OAuthService` 中。当你执行 `/login` 后，OAuth token 会被安装到系统中。Bridge 模式会通过 `installOAuthTokens` 保存这些令牌，并在后续的 API 调用中自动使用。刷新逻辑与 ChatGPT 路径类似，也是基于 token 的过期时间。

## 权限模式语义

Claude Code 的权限系统决定了 Claude 在使用工具（执行命令、读写文件、搜索代码等）时是否需要你的明确许可。理解每种模式的含义和切换方式，可以让你在使用效率和安全性之间找到平衡。

**六种权限模式**

| 模式 | 含义 | 切换方式 |
|------|------|----------|
| Default | 每次工具调用都需要你手动确认或拒绝 | 默认模式 |
| Plan | 只规划不执行，退出 Plan 后回到 Default | `/plan` |
| Accept Edits | 自动批准文件编辑，其他操作仍需确认 | `M-x` 快捷键 |
| Bypass | 自动批准所有工具调用 | 仅限特定环境 |
| Don't Ask | 自动批准但跳过某些检查 | 内部模式 |
| Auto | 基于分类器自动决定批准或拒绝 | 仅限内部用户 |

日常使用中，你最常接触的是 Default 和 Accept Edits。Default 模式适合你希望对每个操作保持掌控的场景，比如在生产代码库中工作。Accept Edits 适合你信任 Claude 的编辑能力、但仍然想监督命令执行的场景。

**Bypass 模式的可用性**

Bypass 模式（自动批准所有工具调用）不是随时可用的。代码中有一个 `bypassPermissionsKillswitch` 模块来管理这个模式的可用性。在大多数环境下，bypass 权限始终可用（当前实现是 no-op），但在远程模式或特定安全策略下，它可能被禁用。

**权限规则**

除了模式级别的开关，你还可以通过 `/permissions` 命令配置细粒度的 allow/deny 规则。规则会根据工具名匹配和 glob 模式来决定是否跳过确认。规则分为 allow（白名单）和 deny（黑名单）两类，deny 规则的优先级高于 allow。

```
# 在 /permissions 界面中配置规则的交互流程
> /permissions

  Permission Rules

  [+] Add rule
  [x] Allow: BashTool(npm test)
  [x] Allow: BashTool(npm run lint)
  [x] Deny:  BashTool(rm -rf*)

  Rules are evaluated in order. Deny rules override allow rules.
```

**ACP 权限管道**

当你通过 ACP（Agent Client Protocol）连接 Claude Code 时，权限决策会经过一条统一的管道。`createAcpCanUseTool` 函数先运行本地的权限规则检查（deny/allow/bypass），如果本地规则没有得出结论，就把决策委托给 ACP 客户端。客户端可以返回 "Always Allow"、"Allow Once" 或 "Reject" 三种选择。

ACP 管道对 `ExitPlanMode` 工具有特殊处理，提供额外的选项："Yes, and use auto mode"、"Yes, and auto-accept edits"、"Yes, and manually approve edits"。

## JWT 与 Bridge 模式认证

Bridge 模式（通过 `claude remote-control`、`claude rc` 或 `claude bridge` 启动）是一种让外部客户端（如 Web UI、IDE 插件）远程控制 Claude Code 会话的方式。在这种模式下，认证和安全机制与本地 REPL 有显著不同。

**JWT 令牌的生命周期**

Bridge 模式使用 JWT（JSON Web Token）进行会话认证。`jwtUtils.ts` 中的 `decodeJwtPayload` 函数可以解码 JWT 的 payload（不验证签名），提取 `exp` 过期时间。`sk-ant-si-` 前缀的 session-ingress token 会被自动去除前缀后再解码。

令牌刷新调度器会在令牌过期前 5 分钟（`TOKEN_REFRESH_BUFFER_MS`）触发刷新。如果无法从 JWT 中解析过期时间（例如使用了不透明的 OAuth token），调度器会使用一个 30 分钟的固定刷新间隔作为后备。

**受信任设备令牌**

Bridge 会话使用 `TrustedDeviceToken` 进行设备级认证。这个令牌通过 `enrollTrustedDevice()` 在 `/login` 时注册，存储在 macOS Keychain 中。注册有严格的时间窗口限制——必须在账户创建后的 10 分钟内完成。令牌有 90 天的滚动过期时间，每次成功使用都会续期。

受信任设备令牌受 GrowthBook feature gate `tengu_sessions_elevated_auth_enforcement` 控制。只有当这个 gate 启用时，CLI 才会在请求中携带 `X-Trusted-Device-Token` header。令牌读取使用 `memoize` 缓存，避免每次请求都启动 `security` 子进程。

**令牌刷新失败处理**

当 Bridge 模式下的令牌刷新连续失败时，系统会：
1. 记录失败次数，最多允许 3 次连续失败。
2. 每次失败后等待 60 秒再重试。
3. 超过 3 次后停止尝试，输出诊断日志 `bridge_token_refresh_no_oauth`。
4. 之后需要重新建立连接才能恢复。

登录切换账户时（`/login` → 新账户），代码会先清除旧的受信任设备令牌（`clearTrustedDeviceToken`），然后异步注册新账户的令牌，避免用旧令牌发送 bridge 请求。

## /share 与 /export 的隐私边界

当你想跟同事分享一段 Claude Code 的对话时，`/share` 和 `/export` 是两个主要工具。它们对隐私的处理方式不同，你需要根据场景选择。

**`/export`：导出到本地文件**

`/export` 把当前对话渲染成纯文本文件并保存到你指定的路径（默认是当前工作目录）。文件名自动根据第一条消息的前 50 个字符生成，加上时间戳后缀。

导出的内容包含对话中的所有用户消息和助手回复（包括工具调用的结果），以纯文本格式呈现。`/export` 不会对内容做脱敏处理——如果你的对话中包含了 API 密钥、文件路径或其他敏感信息，它们会原样出现在导出文件中。

```bash
# 导出到指定文件
> /export my-session.txt
Conversation exported to: /home/user/project/my-session.txt

# 不带参数会弹出文件名对话框
> /export
```

**`/share`：上传到 GitHub Gist**

`/share` 把会话日志（JSONL 格式）上传到 GitHub Gist。默认创建 secret Gist（只有拥有链接的人可以访问），你也可以用 `--public` 创建公开 Gist。

上传前，`/share` 提供了几种隐私保护选项：

- `--mask-secrets`：自动脱敏 API 密钥和令牌。代码会匹配 `sk-ant-*`、`sk-*`、`Bearer` token、AWS 密钥（`AKIA*`）、GitHub token（`ghp_*`/`gho_*`等）、Slack token（`xoxb-*`）等模式，替换为 `[REDACTED_*]` 占位符。
- `--summary-only`：只上传摘要，每轮对话只取前 200 个字符。
- `--private`：创建 secret Gist（默认行为）。
- `--allow-public-fallback`：当 `gh` CLI 不可用时，回退到 `0x0.st` 粘贴服务。

```bash
# 安全地分享（脱敏 + 摘要）
> /share --mask-secrets --summary-only

## Session shared

URL:        https://gist.github.com/abc123...
Session:    sess_xyz
Visibility: secret
Content:    summary only (truncated)
Secrets:    masked before upload
```

**注意**：即使使用了 `--mask-secrets`，脱敏也不是万无一失的。代码注释明确说明不会匹配普通的 32 位以上十六进制字符串（因为它们可能匹配 git commit SHA 或 base64 内容）。分享前最好自己检查一遍内容。

**没有 `gh` CLI 时的选择**

如果你没有安装 GitHub CLI（`gh`），`/share` 会告诉你手动命令并提示安装 `gh`。你也可以用 `--allow-public-fallback` 让它回退到 `0x0.st`，但注意 `0x0.st` 是公开的粘贴服务，任何知道 URL 的人都能看到内容。

## 跨工具凭证共享的隐私影响

Claude Code 和 Codex CLI 可以共享 ChatGPT 订阅的 OAuth 令牌。这种共享带来了便利，但也意味着两个工具对同一组令牌拥有相同的访问权限。

**共享机制**

当 `~/.claude/openai-chatgpt-auth.json` 中没有有效令牌时，Claude Code 会读取 `~/.codex/auth.json`。这意味着如果你之前用 Codex CLI 登录过 ChatGPT 账户，切换到 Claude Code 后不需要重新登录。

```typescript
// chatgptAuth.ts 中的回退逻辑（简化）
let tokens = await readStoredAuth(authFilePath())          // ~/.claude/openai-chatgpt-auth.json
if (!tokens) {
  tokens = await readStoredAuth(codexAuthFilePath())       // ~/.codex/auth.json
}
```

**这意味着什么**

两个工具共享同一组 refresh token。如果你在一个工具中执行了 `/logout` 或删除了凭证文件，另一个工具也会失去访问权限。反过来，如果你在 Codex CLI 中刷新了令牌，Claude Code 会使用新的令牌（因为它读取的是文件内容，而不是内存缓存）。

令牌文件的权限是 `0o600`（仅 owner 可读写），这提供了基础的文件系统级保护。但如果你的主目录权限设置不当，或者在其他用户的机器上工作，就要格外注意这两个文件的安全性。

**撤销访问**

如果你想撤销 Claude Code 对 ChatGPT 账户的访问，除了删除本地的 `openai-chatgpt-auth.json` 和 `~/.codex/auth.json`，还应该到 OpenAI 的账户设置中撤销对应的 OAuth 应用授权。否则，refresh token 可能仍然有效，已经获取的 access token 在过期前仍可使用。

```bash
# 删除本地凭证文件
rm ~/.claude/openai-chatgpt-auth.json
rm ~/.codex/auth.json
```

## 下一步

- 想了解如何配置 Provider 和切换 API 后端，看 [第二章：让 Claude 听你的](./02-providers.md)
- 想了解 Bridge 和 Remote Control 模式的完整用法，看 [第八章：跨机器与跨团队协作](./08-bridge-rcs-acp.md)
- 想了解遇到认证错误如何排错，看 [第十章：可观测性与排错](./10-observability-troubleshooting.md)
- 想了解权限规则的具体语法和配置方法，看 [第九章：省钱、提速、定制](./09-budget-hooks-config.md)
