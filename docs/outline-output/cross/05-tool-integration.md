# 与其他工具集成

> 同一个"接入外部工具"的动作，在使用者眼里是"我能在 VS Code / Zed / Cursor / GitHub Actions / Codex CLI 里用 Claude 吗、要装什么、凭证怎么走"，在开发者眼里是"为什么 IDE 走 MCP 的 `sse-ide` / `ws-ide` 子类型、为什么 ACP agent 用 stdio NDJSON、为什么 ChatGPT 订阅凭证要 fallback 读 `~/.codex/auth.json`、为什么 `install-github-app` 是 React 多步表单而不是一行 shell"。集成天然是双视角主题——用户想知道"能不能接、怎么接"，开发者想知道"边界在哪、契约长什么样、为什么这样切"。

## 产品视角（写给使用者）

这一节回答一个最高频的问题：**我能在 X 里用 Claude 吗？** 答案按"接入形态"分成五类，每类给一个清单式的"做什么 → 怎么做"。

### 第一类：把 Claude 接进 IDE（VS Code / Cursor / Windsurf / JetBrains / Zed）

你能在主流 IDE 里得到一个能看见当前工作区、能开 diff、能跑工具的 Claude。两条路径，按 IDE 选：

- **VS Code 家族（VS Code / Cursor / Windsurf）+ JetBrains 家族**：装官方扩展或插件，然后在 `claude` REPL 里跑 `/ide`（命令在 `src/commands/ide/index.ts` 注册，实现在 `src/commands/ide/ide.tsx`）。它会扫描当前在跑的 IDE、列出带扩展的实例、让你选一个连过去。`/ide open`（`ide.tsx:277-329`）还会把当前 worktree 或 cwd 在选中的 IDE 里打开。注意 VS Code 系列有一条限制：同一时刻只能有一个 Claude 实例连过去（`ide.tsx:127-131` 的告警）。
- **Zed / Cursor 等 ACP 客户端**：ACP（Agent Client Protocol）是 stdio NDJSON 协议。Claude 自身就是一个 ACP agent，跑 `claude --acp`（`src/entrypoints/cli.tsx:123-124` 的 fast-path，受 `feature('ACP')` 门控）就会进入 stdio 模式，由 IDE 直接 spawn。Zed 侧的配置方式见 `docs/features/agents/acp.md`：在 Zed 的 `settings.json` 里加 `agent_servers`，`command` 指向 `claude`，`args` 写 `["--acp"]`。

**这两条路径的区别**：`/ide` 是 Claude 主动连过去（Claude 作为 MCP client 反向连 IDE 的 MCP server），适合在终端 REPL 里把 IDE 当作"上下文源"；`--acp` 是 IDE 把 Claude 当 agent 调起来（Claude 作为 ACP server），适合 IDE 内置的 Agent Panel。两种方向都支持，挑你顺手的。

**自动连接**：`/ide` 第一次手动选完之后，会在 `IdeAutoConnectDialog`（`src/components/IdeAutoConnectDialog.js`）里问你要不要"以后自动连"。开了之后下次启动 REPL 会自动连上同一台 IDE，不用每次 `/ide`。要关掉就再跑 `/ide` 选 `None`，会弹 `IdeDisableAutoConnectDialog`。

### 第二类：把 Claude 暴露成可以被远程调用的服务（ACP / Bridge / RCS）

"我有一台跑 Claude 的机器、想让另一台机器（或浏览器、或团队同事）调用它"——三类方案：

- **ACP agent 远程化**：`claude --acp` 默认是本地 stdio。要让 WebSocket 客户端也能调，跑 `acp-link`（`packages/acp-link/`，README 在 `packages/acp-link/README.md`）。它把 WebSocket 连接桥接到 ACP agent 的 stdin/stdout。默认端口 9315，默认会自动生成一个 token；要固定 token 用 `ACP_AUTH_TOKEN` 环境变量，要禁用认证（不推荐）用 `--no-auth`。详细 CLI 选项见 README。
- **Bridge / Remote Control 快速路径**：`claude remote-control` / `claude rc` / `claude remote` / `claude sync` / `claude bridge`（`cli.tsx:178-188`，五个别名都进同一条 fast-path，受 `feature('BRIDGE_MODE')` 门控）。这条路径把当前进程接到一个 Remote Control 后端，让你的 REPL 能被远端控制。
- **自托管 RCS（Remote Control Server）**：如果你要给一个团队或长期跑的后端，用 `packages/remote-control-server/`（Docker 部署 + Web UI 控制面板，启动用 `bun run rcs`）。它的 README（`packages/remote-control-server/README.md`）列了五项能力：会话管理、实时消息流（WebSocket / SSE 双向）、权限审批（在 Web UI 里点同意/拒绝）、多环境管理（注册多台运行环境、心跳和断线重连）、API Key + JWT 双层认证。acp-link 也能注册到 RCS：设 `ACP_RCS_URL` / `ACP_RCS_TOKEN` / `ACP_RCS_GROUP`（或 `--group <id>` flag），就能在 RCS Web UI 里看到这个 ACP agent。

**这三类的取舍**：acp-link 适合"我有一台机器、想让外部 WebSocket 调一下"；`claude remote-control` 适合"我正在 REPL 里干活、临时让远端接入"；自托管 RCS 适合"团队级长期跑"。同一个底（query loop + 工具系统）三种接入形态，见设计视角的"集成边界"一节。

### 第三类：把 Claude 嵌进 GitHub 工作流（issue / PR review / 自动修复）

两条入口：

- **手动一键装**：`claude install-github-app`（实现在 `src/commands/install-github-app/install-github-app.tsx`，命令注册在 `src/commands/install-github-app/index.ts`）。它是一个多步 React 表单（不是 shell 命令），会带你走完：检测 `gh` 是否装了、选 repo、检测现有 workflow、装 GitHub App、写 API key 到 GitHub Secret、装 workflow 文件。装完之后，在你的 GitHub repo 里 `@claude` 提一句，就会触发 `claude-code-action` 跑一轮。具体能触发什么事件、workflow 模板长什么样，看 `src/constants/github-app.ts`——`WORKFLOW_CONTENT` 是写进你 repo 的 workflow 文件内容，`GITHUB_ACTION_SETUP_DOCS_URL` 指向 `anthropics/claude-code-action` 仓库的 setup 文档。
- **直接 commit + push + 开 PR**：`/commit-push-pr`（`src/commands/commit-push-pr.ts`）。这不是 GitHub App，是你本地 `claude` 直接用 `gh` CLI 帮你开 PR。它内部有一个 `ALLOWED_TOOLS` 白名单（`commit-push-pr.ts:11-23`），只允许 `Bash(git ...)` / `Bash(gh pr ...)` / `SearchExtraTools` 和两个 Slack 工具。如果你的 CLAUDE.md 提到要往 Slack 发 PR 链接，它还会用 `SearchExtraTools` 找 Slack 工具问你要不要发（`commit-push-pr.ts` 的 `slackStep`）。
- **PR 自动修复**：`/autofix-pr`（`src/commands/autofix-pr/`，入口 `launchAutofixPr.ts`）。这是给 CI 上跑的——PR 触发后 Claude 看一遍、发现明显问题就自动提交一个修复 commit。

### 第四类：和 Codex CLI 共享 ChatGPT 订阅凭证

如果你同时在用 Codex CLI 和 Claude，并且想用 ChatGPT 订阅当后端（`OPENAI_AUTH_MODE=chatgpt`），你**不需要在两边各登录一次**。Claude 会先读自己的 `~/.claude/openai-chatgpt-auth.json`；如果不存在，会 fallback 读 Codex CLI 的 `~/.codex/auth.json`（`src/services/api/openai/chatgptAuth.ts:339-344`）。所以你在 Codex CLI 里登录过、Claude 这边就能直接复用。

反过来不成立：Codex CLI 不会读 Claude 的凭证文件。如果你只想在 Claude 里用，就只在 Claude 这边 `/login` 走 ChatGPT 设备码流程；如果你想在两边都用，去 Codex CLI 登录一次更省事。

凭证刷新有 5 分钟的偏差窗口（`REFRESH_SKEW_MS = 5 * 60 * 1000`，`chatgptAuth.ts:7`）——令牌过期前 5 分钟内任意一次请求都会触发刷新，避免边界 race。详见 cross/03-security.md 的凭证章节。

### 第五类：跨工具凭证共享（其他 Provider）

**只有 ChatGPT 订阅路径**会跨工具读 Codex 的凭证文件。其他 Provider（Anthropic / 普通 OpenAI API key / Gemini / Grok / Bedrock / Vertex / Foundry）的 key 都存在 Claude 自己的 `~/.claude/` 下或 `settings.json` 里，不与任何外部工具共享。

如果你同时在别的工具（比如 Aider、Continue）里用 Anthropic API，那些工具各自读自己的配置——你需要在每个工具里都配一遍 `ANTHROPIC_API_KEY` 或对应的环境变量。这不是 bug，是有意的隔离：一个工具的凭证泄露不应该顺带把另一个工具的也带出去。

## 设计视角（写给开发者）

设计大纲原本完全没有"跨工具集成视角"。这一节补上"集成边界"——每一类集成背后都有一组明确的契约和决策：协议形态、凭证流向、feature 门控、命令路径。读完之后你应该能回答："如果我要加一个新的 IDE 集成、或一个新的 CI 平台，边界在哪、哪些约束是必须遵守的"。

### 为什么 IDE 集成走 MCP 的 `sse-ide` / `ws-ide` 子类型，而不是普通 MCP

打开 `src/commands/ide/ide.tsx:463-472`，看连接 IDE 时写入 `dynamicMcpConfig` 的逻辑：

```ts
const url = selectedIDE.url
newConfig.ide = {
  type: url.startsWith('ws:') ? 'ws-ide' : 'sse-ide',
  url: url,
  ideName: selectedIDE.name,
  authToken: selectedIDE.authToken,
  ideRunningInWindows: selectedIDE.ideRunningInWindows,
  scope: 'dynamic' as const,
} as ScopedMcpServerConfig
```

IDE 在 MCP config 里是一个特殊的 `ide` key，type 是 `sse-ide` 或 `ws-ide`——不是普通的 `sse` / `websocket`。这两个子类型在 `src/services/mcp/` 里有专门的处理路径。**为什么不给 IDE 用普通 MCP？** 因为 IDE 提供的不只是工具（`mcp__ide__*` 工具前缀，见 `ide.tsx:455-456` 的 `filter` 清理逻辑），还有 diff 显示、当前选中文件、diagnostics 推送这些"非工具形态"的能力。给 IDE 单独留一个 type，让 MCP client 知道"这个连接除了普通工具调用，还有 IDE 专有的副作用通道"。

**另一个有意思的设计**：`dynamicMcpConfig` 的 scope 是 `'dynamic'`。这意味着 IDE 配置不写进 `settings.json`，而是活在 React state 里——下次启动 REPL 不会自动恢复。自动恢复靠 `IdeAutoConnectDialog` 单独存的标志位（"以后自动连"），连接动作本身每次都要重新走一遍。这个设计的代价是：用户换一台机器、或者把 settings 同步到另一台，IDE 自动连不会跨机器带过去。收益是：IDE 的端口和 token 是会话期会变的（IDE 重启端口就变），写进持久化 settings 反而会读到过期值。

**disconnect 的细节**（`ide.tsx:446-460`）：断开连接时除了清 config，还主动 `ideClient.client.onclose = () => {}` 把 onclose 置空。**为什么？** MCP client 有自动重连机制，正常关闭会触发重连。置空 onclose 是"我说了要断、别再自己连回来"的信号——这是 RPC 类连接很容易踩的坑，`/ide` 选 None 的时候必须做这一步，否则用户会看到"我明明断了它又自己连上"。

### 为什么 ACP agent 是 stdio NDJSON，而 acp-link 要做 WebSocket → stdio 桥接

ACP 的协议形态选择写在 `docs/features/agents/acp.md`：stdin/stdout 的 NDJSON 流。**为什么是 stdio？** 因为 stdio 是 IDE 调子进程最简单的形态——IDE spawn `claude --acp`，往 stdin 写 NDJSON，从 stdout 读 NDJSON。不需要开端口、不需要握手、不需要网络配置。代价是"只能本地调用"——IDE 和 agent 必须在同一台机器上同一个进程树里。

acp-link（`packages/acp-link/`）就是为突破这个限制存在的。看 README 的 "How It Works"：它监听 WebSocket、收到 `connect` 消息就 spawn 配置好的 ACP agent 子进程、把 WebSocket 帧和 agent 的 stdin/stdout 双向桥接。**为什么不直接给 ACP agent 加一个 WebSocket 模式？** 因为 stdio 和 WebSocket 是两种完全不同的 I/O 模型——stdio 是阻塞 read、WebSocket 是事件回调。把它们塞进同一个 agent 进程会让 agent 的代码复杂度爆炸。acp-link 作为独立进程承担"协议翻译"，agent 自己保持纯 stdio，**单一职责**。

**这个设计的代价**：多了一层进程。acp-link 进程崩了，agent 和 WebSocket 客户端都会失联。RCS 的多环境管理（README 提到"心跳和断线重连"）部分就是为了缓解这个——acp-link 进程挂了 RCS 能检测到、能重启。`packages/acp-link/src/manager/`（README 的 "Manager UI" 段）进一步提供了"一台机器跑多个 acp-link 子进程、统一管理"的形态，这是为团队场景设计的。

**凭证透传**：ACP agent 启动时会读 `settings.json` 里的环境变量（见 `docs/features/agents/acp.md` 第 58 行，`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 等）。Zed 这种 IDE 还能在 `agent_servers` 配置里显式传 `env`。**为什么不让 ACP 协议自己带凭证？** 因为 ACP 是协议、凭证是部署期决策——协议只规定"怎么对话"，凭证由调用方（IDE 的 `agent_servers.env` / RCS 的环境变量 / acp-link 启动时的环境）决定。这种分离让同一个 ACP agent 能在不同 IDE、不同部署形态下复用，不需要改 agent 代码。

### 为什么 ChatGPT 订阅凭证要 fallback 读 `~/.codex/auth.json`

打开 `src/services/api/openai/chatgptAuth.ts:42-57`：

```ts
function authFilePath(): string {
  return join(getClaudeConfigHomeDirLocal(), AUTH_FILE)
}

function codexAuthFilePath(): string {
  return join(
    process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'),
    'auth.json',
  )
}
```

两个路径函数。`getValidChatGPTAuth`（`chatgptAuth.ts:339-344`）的读取顺序是：**先读 Claude 自己的 `~/.claude/openai-chatgpt-auth.json`，读不到再 fallback 读 Codex CLI 的 `~/.codex/auth.json`**，并打一条 debug 日志 `[OpenAI] Using ChatGPT auth from Codex auth.json`。

**为什么这么设计？** ChatGPT 订阅的 OAuth 设备码流程是 OpenAI 自己发的（`ISSUER = 'https://auth.openai.com'`，`CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'`，`chatgptAuth.ts:5-6`）。Codex CLI 用的是同一个 issuer 同一个 client_id（验证：`verificationUrl` 用 `${ISSUER}/codex/device`，`chatgptAuth.ts:217`）。两边走的是同一套令牌体系，令牌可以互换——所以让 Claude 复用 Codex 的凭证是合法的、不是"借用"。

**为什么不强制让用户在 Claude 这边也登录一次？** 因为 ChatGPT 订阅用户已经为这个 token 付过费、已经走完设备码握手了。让他在每个工具里都重做一次设备码登录（打开浏览器、输 userCode、等待授权）是明显的体验灾难。fallback 读 Codex 凭证把"一次登录、多个工具复用"变成可能。

**反向不成立**：Codex CLI 不会读 Claude 的凭证文件。这是有意的非对称——Claude 这边承认"我是后来的、我读你的"，但 Codex CLI 作为 OpenAI 自家工具不知道 Claude 的存在。这种非对称在跨工具凭证共享里很常见：后入场的一方做兼容，先入场的一方保持简单。

**风险**：这个 fallback 假设 Codex CLI 的凭证文件格式稳定。如果某天 Codex CLI 改了 `auth.json` 的 schema（加字段、改字段名、嵌套层级变化），Claude 这边的 `readStoredAuth`（`chatgptAuth.ts:123`）就要跟着改。这是跨工具集成的固有脆弱性——**两边的格式没有契约约束，只靠"碰巧一致"维持**。如果 Codex CLI 那边改了，Claude 这边不会自动收到通知，要靠用户报"我用 ChatGPT 模式登录不了了"才会被发现。

### `install-github-app` 为什么是 React 多步表单，而不是一行 shell

打开 `src/commands/install-github-app/install-github-app.tsx`，它 import 了 11 个 Step 组件：`ApiKeyStep` / `CheckExistingSecretStep` / `CheckGitHubStep` / `ChooseRepoStep` / `CreatingStep` / `ErrorStep` / `ExistingWorkflowStep` / `InstallAppStep` / `OAuthFlowStep` / `SuccessStep` / `WarningsStep`。一个简单的"装 GitHub App"为什么要拆这么多步？

因为"装一个 GitHub App"在生产环境里至少有 11 个分支：

- `gh` 装了吗？没装怎么办？（`CheckGitHubStep`）
- 用户想装到当前 repo 还是别的 repo？当前 repo 探测到了吗？（`ChooseRepoStep`）
- API key 用现有的还是新建？用 OAuth 还是 API key？（`ApiKeyStep`，`selectedApiKeyOption: 'new' | 'existing' | 'oauth'`，见 `install-github-app.tsx:36`）
- repo 里已经有同名 secret 了吗？要覆盖还是保留？（`CheckExistingSecretStep`）
- repo 里已经有 workflow 文件了吗？要装哪几个？（`ExistingWorkflowStep`，默认 `['claude', 'claude-review']`，见 `install-github-app.tsx:35`）
- 创建过程中出错了？错误长什么样、能不能重试？（`ErrorStep`、`CreatingStep`）
- 装完了有哪些警告？比如权限不够、repo 是 fork、org policy 限制？（`WarningsStep`）

每一个分支都需要用户决策、都要展示状态。**用一行 shell 解决不了**——shell 是"我已知所有参数、一次性执行"，而 GitHub App 安装是"边探测边问边装"。React 多步表单是这种"探测-决策-执行-反馈"循环的自然形态。

**契约**：`install-github-app` 写进用户 repo 的 workflow 文件内容是写死在 `src/constants/github-app.ts` 的 `WORKFLOW_CONTENT` 常量里——这是一个 GitHub Actions YAML 字符串，定义了 `issue_comment` / `pull_request_review_comment` / `issues` / `pull_request_review` 四类事件的触发条件（都是 `@claude` mention），跑在 `ubuntu-latest` 上，permissions 是 `contents: read` / `pull-requests: read` / `issues: read` / `id-token: write`。PR 标题也是常量 `PR_TITLE = 'Add Claude Code GitHub Workflow'`。**这些常量就是 Claude ↔ GitHub 的契约**——改 `WORKFLOW_CONTENT` 等于改所有未来用户装上去的 workflow 模板，要非常小心向后兼容。

### `/commit-push-pr` 的 `ALLOWED_TOOLS` 白名单为什么这么窄

看 `src/commands/commit-push-pr.ts:11-23`：只允许 `Bash(git ...)` 几条、`Bash(gh pr ...)` 几条、`SearchExtraTools`、两个 Slack 工具。**为什么不给它 `FileEdit` / `FileWrite`？** 因为 `/commit-push-pr` 的语义是"把已经做好的改动提交、推送、开 PR"——它不应该再修改代码。如果允许 `FileEdit`，这个命令就会从"提交工具"退化成"提交 + 顺手再改点代码"的工具，权限边界就乱了。

**为什么 Slack 工具要单列？** 看 `commit-push-pr.ts` 后面的 `slackStep` 逻辑：如果你的 CLAUDE.md 里写了"开完 PR 往 Slack 发链接"，这个命令会尝试用 `SearchExtraTools` 找 Slack 工具，问你要不要发。这是一条**条件性集成**——不是所有用户都装了 Slack MCP，所以不能硬编码 `mcp__slack__send_message`，要走延迟工具搜索。如果没找到，silent skip，不打扰用户。

**`getPromptContent` 里的 `process.env.USER_TYPE === 'ant' && isUndercover()`**（`commit-push-pr.ts:33-40` 附近）是一个有意思的边界：Anthropic 内部用户跑这个命令时，会切到 "undercover" 模式——不暴露自己在用 Claude。这是 dogfooding 的产物：内部用户用自家工具时，对外（比如在公开的开源 repo 里开 PR）不能露出"这是 AI 写的"的痕迹。这个分支只在 `USER_TYPE === 'ant'` 时生效，普通用户看不到。

### 三种长驻模式（ACP / Bridge / Daemon）共享底层 query loop 但各有独立 entry

这是设计大纲第十二章的核心论点在集成视角下的具体化。三者的关系：

- **ACP**（`src/services/acp/`）：`cli.tsx:123-124` 的 `--acp` fast-path，受 `feature('ACP')` 门控。进入 `src/services/acp/entry.ts`，spawn 一个 `AcpAgent`（`agent.ts`）。agent 把 ACP 客户端的请求桥接到内部的 query loop（`src/services/acp/bridge.ts`），权限决策走 `createAcpCanUseTool`（`src/services/acp/permissions.ts`）。
- **Bridge**（`src/bridge/`）：`cli.tsx:178-188` 的 `remote-control` / `rc` / `remote` / `sync` / `bridge` 五个别名 fast-path，受 `feature('BRIDGE_MODE')` 门控。进入 `src/bridge/bridgeMain.ts`，JWT 认证（`jwtUtils.ts`）、消息传输（`bridgeMessaging.ts`）、权限回调（`bridgePermissionCallbacks.ts`）。
- **Daemon**（`src/daemon/`）：`cli.tsx` 的 `daemon` 子命令，受 `feature('DAEMON')` 门控。`src/daemon/main.ts` 是 entry，`workerRegistry.ts` 管 worker，`--daemon-worker=<kind>` 派生精简 worker。

**共享的部分**：三者都最终调用 `src/query.ts` 的 `query()` async generator（见设计大纲第五章）。工具系统、Provider 路由、流式响应——这些都是共用的。**各自增加的编排层**：ACP 加了"会话管理 + 权限桥接 + prompt 排队"，Bridge 加了"JWT 认证 + 远端消息传输 + 权限远程审批"，Daemon 加了"worker 注册表 + 心跳 + 精简 worker 派生"。

**为什么三个要分开**：因为它们的**调用方不同**。ACP 的调用方是 IDE（同机 stdio），Bridge 的调用方是 RCS 后端（远端 JWT），Daemon 的调用方是 CI 或 supervisor（进程级 spawn）。三种调用方对认证、传输、生命周期的要求完全不同——IDE 不需要认证（已经在用户机器上）、RCS 必须认证（暴露在网络上）、Daemon 必须支持后台 + 心跳（长跑）。把这些塞进同一个 entry 会让代码变成"if (acp) {...} else if (bridge) {...} else if (daemon) {...}"的分支地狱。分开三个 entry、各自 feature-gated，是**用 entry 数量换 entry 简单度**的权衡。

**BYOC runner 是三条线的交汇点**：`claude environment-runner` / `claude self-hosted-runner`（见设计大纲第十二章）是这三条线和 CI（产品大纲第十一章）的交汇——它能让外部 CI 系统以 Bring-Your-Own-Compute 的方式调用 Claude，背后可能用 ACP（同机）、Bridge（远端）、或 Daemon（长跑）任意一种。这是"集成边界"最抽象的一层：用户不直接选 ACP/Bridge/Daemon，他选的是 environment-runner，由 runner 决定底下用哪种长驻模式。

### VS Code 桥接（`vscode-ide-bridge/`）的现状

CLAUDE.md 提到 `vscode-ide-bridge/` 是"VS Code 桥接"辅助目录。**但这个目录在当前仓库里实际不存在**（`ls` 返回空）。VS Code 集成实际走的是 `/ide` 命令 + VS Code 扩展（扩展是独立分发的，不在本仓库里），不是通过这个目录里的代码。`vscode-ide-bridge/` 在仓库的某个历史版本里存在过、后来被移除或合并到 `src/commands/ide/`——`CLAUDE.md` 的描述滞后了。**这是反编译重建工作的典型痕迹**：文档描述的是"原本应该有什么"，代码里实际是"重建后剩下了什么"。

## 两视角如何呼应

用户视角的每一个"我能接什么"的清单，几乎都能在设计视角找到对应的契约和决策：

- **"我能在 VS Code / Zed / Cursor 里用 Claude 吗"**（产品视角）对应 **"为什么 IDE 走 MCP 的 `sse-ide` / `ws-ide` 子类型、为什么 ACP agent 用 stdio NDJSON"**（设计视角）——用户看到的是"装个扩展、`/ide` 一连就行"，开发者看到的是"`dynamicMcpConfig` 的 `ide` key 用了专门的 type、ACP 协议形态选择 stdio 是为了 IDE spawn 子进程最简单"。
- **"我能不能让远端调用我机器上的 Claude"**（产品视角）对应 **"acp-link 为什么是 WebSocket → stdio 桥接、自托管 RCS 为什么是 Docker + Web UI"**（设计视角）——用户看到的是"`claude remote-control` 一跑、Web UI 一开就能用"，开发者看到的是"三种长驻模式（ACP / Bridge / Daemon）共享 query loop 但各有独立 entry、用 entry 数量换 entry 简单度"。
- **"我在 Codex CLI 登录过、Claude 这边能复用吗"**（产品视角）对应 **"为什么 ChatGPT 订阅凭证要 fallback 读 `~/.codex/auth.json`"**（设计视角）——用户看到的是"不用再登录一次"，开发者看到的是"两边用同一 issuer 同一 client_id、令牌可互换、但 schema 没有契约约束只靠碰巧一致"。
- **"我能在 GitHub Actions 里用 Claude 吗"**（产品视角）对应 **"`install-github-app` 为什么是 React 多步表单、`/commit-push-pr` 的 `ALLOWED_TOOLS` 白名单为什么这么窄"**（设计视角）——用户看到的是"`claude install-github-app` 一键装、`@claude` 一 at 就触发"，开发者看到的是"11 个 Step 组件对应 11 个分支、`WORKFLOW_CONTENT` 常量是 Claude ↔ GitHub 的契约、白名单用'允许什么'定义命令的语义边界"。
- **"我的 key 会不会被别的工具读到"**（产品视角）对应 **"跨工具凭证共享为什么只有 ChatGPT 订阅路径、为什么反向不成立"**（设计视角）——用户看到的是"除了 ChatGPT 订阅路径、其他 key 都不共享"，开发者看到的是"后入场的一方做兼容、先入场的一方保持简单的非对称设计"。
- **"`vscode-ide-bridge/` 是什么"**（产品视角用户翻 CLAUDE.md 看到的）对应 **"反编译重建工作的典型痕迹——文档描述原本应该有什么、代码里实际剩下了什么"**（设计视角）——用户看到的是"文档里提到了一个目录"，开发者看到的是"那个目录在当前仓库里实际不存在、VS Code 集成走的是 `/ide` + 独立扩展"。

这种呼应关系是"与其他工具集成"必须双视角覆盖的核心原因：用户视角告诉你**怎么接**，设计视角告诉你**接的边界在哪、契约长什么样、哪些描述滞后于代码**。两个视角合在一起，才能让使用者正确判断"我现在的接法是不是最优、要不要换一种"，也让开发者在加新集成时知道"哪些约束（凭证隔离、协议形态、feature 门控、entry 分离）是必须遵守的"——而不是把每个集成都重新发明一遍。
