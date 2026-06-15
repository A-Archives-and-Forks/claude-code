# 安全

> 同一份 `sk-ant-...` 在使用者眼里是"我的密钥去了哪里、谁能看到"，在开发者眼里是"为什么用 0o600 写文件、为什么 ChatGPT 订阅要复用 `~/.codex/auth.json`、为什么 `bypassPermissions` 必须先检测是不是 root 或 sandbox"。安全天生是双视角主题——用户担心泄漏，开发者负责把每一处存储、刷新、传输、共享都设计成"即使被泄漏也尽量不致命"。

## 产品视角（写给使用者）

这一节回答三个问题：**我的密钥和令牌存在哪里**、**它们什么时候会被刷新或销毁**、**我把对话分享出去时哪些东西会跟着泄漏**。读完之后，你应该能判断"我能不能把这台机器借给同事"、"我能不能把这份 transcript 发到群里"。

### 凭证存储位置清单

Claude Code 把不同来源的凭证分散存在几个地方，不要把它们当成一个文件。下面这张表覆盖最常见的几类：

| 凭证类型 | 存储位置 | 谁能读到 | 备注 |
| --- | --- | --- | --- |
| Anthropic OAuth 令牌 / 自定义 API key | `~/.claude/` 下的 secure storage（macOS Keychain / Windows Credential Manager / Linux libsecret） | 只有当前用户的操作系统账户 | `/logout` 会清掉它（见 `src/commands/logout/logout.tsx:24` 调 `removeApiKey()`） |
| ChatGPT 订阅凭证（`OPENAI_AUTH_MODE=chatgpt`） | `~/.claude/openai-chatgpt-auth.json` | 任何能读这个文件的进程 | 文件用 `mode: 0o600` 写入（见 `src/services/api/openai/chatgptAuth.ts:162`），但仍然是明文 JSON |
| Codex CLI 共享凭证 | `~/.codex/auth.json`（即 `CODEX_HOME/auth.json`） | 任何能读这个文件的进程 | Claude Code **只读不写**这个文件（`chatgptAuth.ts:342`）；如果 `~/.claude/openai-chatgpt-auth.json` 不存在，会回退去读它 |
| Provider 环境变量（`OPENAI_API_KEY` 等） | 写进 `settings.json` 的 `env` 字段或 shell rc 文件 | 任何能读 settings 的进程 | `/provider` 命令切换 Provider 不清这些 key（见下文） |
| 团队共享设置 | `<项目>/.claude/settings.json` | 仓库的所有 collaborator | **不要**把 key 写进团队 settings.json，写到 `settings.local.json` 或环境变量里 |
| 个人覆盖设置 | `<项目>/.claude/settings.local.json` | 当前用户 | 默认被 git ignore，适合放本地 API key 之类 |

一个高频误用：把 `OPENAI_API_KEY` 提交到了项目根目录的 `.claude/settings.json`，结果 push 到团队仓库所有人都看到了。**正确做法**是放到 `.claude/settings.local.json`（git ignored）或者用 `apiKeyHelper`（`src/utils/settings/types.ts:255`，指向一个能输出 key 的本地脚本）。

### 权限模式：让 Claude 在沙箱里干活

权限模式控制 Claude 在执行工具调用之前是否需要按一次回车。用 `/permissions` 命令（`src/commands/permissions/permissions.tsx`）或 `settings.json` 的 `permissions.defaultMode` 字段切换：

- `default` —— 文件写入、shell 命令等危险操作按规则匹配后**问你**（最常见）。
- `acceptEdits` —— 文件编辑直接放行，shell 仍然问。
- `plan` —— 只读分析，不允许任何写操作。
- `auto` —— 自动分类器判定（需要 `TRANSCRIPT_CLASSIFIER` feature）。
- `bypassPermissions` —— 全部放行，**不要在普通环境用**。

`bypassPermissions` 是这条链上最危险的模式，所以代码里有专门的"环境硬性检测"（`src/setup.ts:391-435`）：在你以 root/sudo 身份启动它、或者环境既不是 Docker 也不是 Bubblewrap 也不是 `IS_SANDBOX=1`、还连着外网的情况下，CLI 会**直接退出**并报错 `--dangerously-skip-permissions cannot be used in Docker/sandbox containers with no internet access`。换句话说，bypass 只允许在"无网 + 沙箱容器"的组合里用。这是有意把滥用路径堵死。

权限规则本身写在 `settings.json` 的 `permissions.allow` / `deny` / `ask` 里（schema 在 `src/utils/settings/types.ts:42-55`），用 `/permissions` 命令可视化编辑。规则按"工具名 + glob 路径"匹配，比如 `Bash(npm install:*)` 表示允许所有 `npm install ...` 命令；`Read(~/.ssh/**)` 表示禁止读 ssh 目录。**deny 永远赢过 allow**，这是优先级铁律（详见 `src/utils/permissions/permissions.ts`）。

### OAuth 令牌什么时候刷新、什么时候过期

两种 OAuth 路径，各自有自己的刷新窗口：

- **ChatGPT 订阅路径** —— `chatgptAuth.ts:9` 定义了 `REFRESH_SKEW_MS = 5 * 60 * 1000`，意思是"令牌距离过期不到 5 分钟时就主动刷新"。每次调用 `getValidChatGPTAuth()`（`chatgptAuth.ts:339`）都会先 `getTokenExpiryMs` 检查，到点就 `refreshTokens` + `saveStoredAuth`。**用户侧含义**：只要你的网络能通到 `auth.openai.com`，令牌永远不会过期；如果断网超过令牌寿命（通常 1 小时），下一次调用会失败，需要重新 `/login`。
- **Bridge 模式的会话 JWT** —— `src/bridge/jwtUtils.ts:52` 同样定义了 `TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000`，加上 `FALLBACK_REFRESH_INTERVAL_MS = 30 * 60 * 1000` 和 `MAX_REFRESH_FAILURES = 3`。`createTokenRefreshScheduler` 会"在令牌过期前 5 分钟排一个 setTimeout"，失败 3 次后放弃。**用户侧含义**：Bridge 长会话（自托管 RCS、远程控制）理论上一周不掉线，但如果你看到 `bridge_token_refresh_no_oauth` 这种 diagnostic log，说明刷新链断了。

**`/logout` 会做什么**：不止删 key。它会 `flushTelemetry()` 先把还没上报的埋点冲掉（防止组织数据泄漏，见 `logout.tsx:21` 的注释），然后 `removeApiKey()` + `removeChatGPTAuth()` + 清掉 secure storage + 清一堆缓存（betas、toolSchema、Grove、policyLimits），最后 `gracefulShutdownSync(0, 'logout')` 让进程退出。所以 `/logout` 是"重置到初次安装状态"的快捷方式。

### `/share` 与 `/export` 的隐私边界

这两个命令都把会话内容写到外部，但隐私处理完全不同：

- **`/export`**（`src/commands/export/export.tsx`）—— 把会话渲染成纯文本**写到本地文件**。**没有任何脱敏**——你说了什么、Claude 回了什么、API key 是不是出现在消息里，全部原样写出去。这个命令的隐私边界就是"你自己机器上的文件系统"，把它交给同事之前请自己检查一遍。
- **`/share`**（`src/commands/share/index.ts`）—— 把会话日志**上传到 GitHub Gist**（或 `0x0.st` 兜底）。默认 `--private`（私有 Gist），但 GitHub 的 private Gist 对**任何知道 URL 的人**都可读，所以本质上还是"URL 即权限"。`--mask-secrets` 旗标会触发 `maskSecrets()`（`share/index.ts:98`），用一组正则把 `sk-ant-*` / `sk-*` / `Bearer xxx` / `AKIA*`（AWS）/ `ghp_*` / `xoxb-*`（Slack）等常见 token 替换成 `[REDACTED_*]`（模式表在 `share/index.ts:53-92`）。

**关键提醒**：`/share --mask-secrets` **不是银弹**。源码里那条 NOTE 写得很明确（`share/index.ts:89-91`）：

> We intentionally do NOT redact generic ≥32-char hex strings because they match legitimate git commit SHAs and base64 content, producing garbled share output.

也就是说，如果你的 token 长得像 32 位以上的 hex（比如某些自建服务的 token），它**不会被脱敏**。私有信息（内部文档片段、同事姓名、内部 URL）也完全不在脱敏范围里。**最稳的做法**：分享前用 `/export` 导到本地，自己过一遍再决定怎么发。

### 跨工具凭证共享：和 Codex CLI 复用 auth

如果你机器上同时装了 Codex CLI（OpenAI 官方 CLI），你会发现 ChatGPT 订阅登录会在两边都生效。这是因为 `getValidChatGPTAuth()`（`chatgptAuth.ts:339-346`）在 `~/.claude/openai-chatgpt-auth.json` 不存在时会**回退去读 `~/.codex/auth.json`**（`codexAuthFilePath()`，`chatgptAuth.ts:52`）。注释里写得很坦诚（`:344`）：`Using ChatGPT auth from Codex auth.json`。

**隐私含义**：

- 你在 Codex CLI 登录 ChatGPT，Claude Code 也能直接用，不需要再登一次。
- 反过来不成立：Claude Code 的 `saveStoredAuth` 只写 `~/.claude/openai-chatgpt-auth.json`，不写 `~/.codex/auth.json`。
- 如果你想完全隔离两个工具的凭证，设 `CODEX_HOME` 环境变量把 Codex 的目录指到别处（`chatgptAuth.ts:54`）。

### `/provider unset` 只清 Provider 不清 key

一个高频困惑：跑了 `/provider unset`，以为已经把 OpenAI 凭证清干净了。看 `src/commands/provider.ts:49-62`，它做的事是：清 `modelType` 设置 + 删 `CLAUDE_CODE_USE_*` 环境变量。**它不动**：

- `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROK_API_KEY` 这些 key 环境变量（仍在 shell 或 settings.json 里）。
- `~/.claude/openai-chatgpt-auth.json`（仍在磁盘上）。
- OpenAI/Grok 客户端的模块级缓存（见设计视角）。

要彻底清，必须跑 `/logout`（清凭证文件 + secure storage）+ 手动从 settings.json 删 key 环境变量 + 重启 CLI（清缓存）。

## 设计视角（写给开发者）

设计大纲原本没有"安全"章节，相关决策散落在 Provider、Bridge、权限系统各处。这一节把它们串起来，按"为什么这么存、为什么这么检、为什么这么共享"展开。每个决策背后都有一个具体的威胁模型或约束。

### 为什么 ChatGPT 凭证用明文 JSON + 0o600，而不是 secure storage

打开 `src/services/api/openai/chatgptAuth.ts:148-164`：

```ts
async function saveStoredAuth(tokens: ChatGPTAuthTokens): Promise<void> {
  const path = authFilePath()
  await mkdir(getClaudeConfigHomeDirLocal(), { recursive: true })
  const body: StoredAuthFile = { auth_mode: 'chatgpt', tokens: { ... }, last_refresh: ... }
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
}
```

明文 JSON，文件权限 `0o600`（只有文件 owner 能读写）。**为什么不像 Anthropic OAuth 那样走 secure storage**？因为这套凭证要和 **Codex CLI 互操作**——Codex CLI 的存储格式就是 `~/.codex/auth.json` 明文 JSON（见 OpenAI 官方设计）。如果 Claude Code 把凭证塞进 macOS Keychain，Codex CLI 读不到，跨工具共享就做不到。

`chmod 0o600` 是这个权衡下的最大补偿：文件本身明文（互操作需求），但 OS 层面把读权限收紧到当前用户。注意 `chmod` 那行有 `.catch(() => undefined)`——某些文件系统（比如 FAT32 挂载点）不支持 chmod，这种情况会静默失败但文件还是会被写出来。这是一个**优先可用性而非绝对安全**的设计选择。

**根因**：跨工具互操作和强凭证存储在本地文件系统层面是冲突的。OpenAI 选择了明文 JSON，Claude Code 跟随这个选择才能复用凭证。

### 为什么 `bypassPermissions` 必须先检测 root 和 sandbox

`src/setup.ts:391-435` 是一段看起来啰嗦的检测代码，但它精确对应一个威胁模型："用户图省事用 `sudo claude --dangerously-skip-permissions` 启动"。在这种情况下，Claude 拿到的是 root 权限，所有文件（包括 `/etc/passwd`、其它用户的 home）都可读写可执行——bypass 模式就变成了"任意代码执行 root"。

检测逻辑按"威胁递进"排：

1. **第一道（`:397-408`）**：`process.getuid() === 0` 且不是 sandbox（`IS_SANDBOX !== '1'` 且 `CLAUDE_CODE_BUBBLEWRAP` 未设）——直接 `process.exit(1)`。这是"绝对禁止"层。注释里特意提到"TPU devspaces 要求 root"，所以留了 `IS_SANDBOX=1` 的逃生口。
2. **第二道（`:410-434`，仅 `USER_TYPE === 'ant'`）**：进一步要求"必须是 Docker / Bubblewrap / IS_SANDBOX 容器"**且** "无外网"。`hasInternet` 这一条特别严：即使你套了 Docker，只要还能 ping 通外网，bypass 就被拒。

**为什么对 `USER_TYPE === 'ant'` 特别严格**：Anthropic 内部用户的默认部署环境更复杂，代码里特意为内部用户加了"容器 + 无网"的双重要求（`:411` 那行 `process.env.USER_TYPE === 'ant'` 判断）。外部用户的判断只走第一道。

**根因**：bypassPermissions 模式下整个权限管线被跳过，所以必须在它生效**之前**做环境断言。一旦放进去，再想限制就晚了——Claude 已经能跑任意 shell 命令了。这是一个"防御必须在威胁生效前完成"的典型例子。

### 为什么 ACP 权限走"本地管线 + 远端委托"两段式

`src/services/acp/permissions.ts:32-173` 的 `createAcpCanUseTool` 是 ACP 模式下所有工具调用的权限闸门。它不直接把每个调用都甩给远端客户端，而是分两段：

1. **本地管线（`:79-106`）**：先跑 `hasPermissionsToUseTool`，让 deny / allow / bypassPermissions / acceptEdits 这些本地规则自己消化。如果本地已经能决定 allow 或 deny，**直接返回，不打扰远端**。
2. **远端委托（`:108-172`）**：本地规则判定为 `ask` 时，才通过 `conn.requestPermission()` 把 `allow_always` / `allow_once` / `reject_once` 三个选项发给 ACP 客户端（VS Code、Cursor 等）。

**为什么这么设计**：ACP 客户端可能是 IDE、Web UI、自研工具，它们不一定都有良好的权限 UI，而且每次 round-trip 都有延迟。如果连"用户已经 deny 的工具"都要去远端问一遍，体验会很糟。本地管线是"快速短路"，远端委托只在"真的需要人决策"时才触发。

注意 `forceDecision !== undefined` 那一段（`:71-73`）：coordinator / swarm worker 场景会预绑定一个决策，跳过本地管线直接返回。这是"信任父进程已经做了决策"的快捷路径，避免子 worker 重复打断用户。

### 为什么 `HasAppStateContext` 主动 throw 防嵌套

打开 `src/state/AppState.tsx:57-64`：

```ts
const HasAppStateContext = React.createContext<boolean>(false);

export function AppStateProvider({ children, ... }: Props): React.ReactNode {
  const hasAppStateContext = useContext(HasAppStateContext);
  if (hasAppStateContext) {
    throw new Error('AppStateProvider can not be nested within another AppStateProvider');
  }
  // ...
}
```

第一眼看起来像"开发者警告"，但它其实有**安全含义**。AppState 是整个应用的单一 store，包含 messages、tools、permissions、MCP 连接等敏感字段。如果允许嵌套，外层 Provider 的 children 里某个子组件 mount 了一个内层 Provider，内层的 store 就和外层**脱钩**——内层的 useAppState 拿到的是内层 store，permission 决策、消息历史、凭证状态全部错乱。

具体的安全风险场景：一个恶意 MCP 工具或者插件组件如果不小心（或故意）渲染了一个 AppStateProvider，就有可能让一部分 UI 用着"被隔离的、权限被偷偷放宽"的 store。React Context 本身没有"防重复嵌套"机制，所以项目用 `HasAppStateContext` 这个布尔 context 主动 throw——**第一次 mount 时它从 false 变 true，第二次 mount 时读到 true 就抛错**。

**根因**：单一 store 是"权限决策单一真相源"的前提。一旦允许多 store 嵌套，权限规则、bypass 状态、secure storage 引用都可能错配。这是"防御性编程"在 React Context 层的落地。

### 为什么 Bridge 的 JWT 不验签

`src/bridge/jwtUtils.ts:21-32` 的 `decodeJwtPayload` 函数注释里写得很坦诚：

```ts
/**
 * Decode a JWT's payload segment without verifying the signature.
 * Strips the `sk-ant-si-` session-ingress prefix if present.
 */
```

只解码 payload，不验签。**为什么**？因为 Bridge 模式（自托管 RCS、远程控制）用的是"会话级 JWT"，签发和验证都在**同一进程**里完成（Anthropic 服务端签发，Bridge 进程消费）。签名校验在 TLS 层已经做了——Bridge 客户端到服务端的 WebSocket 是 `wss://`，传输层防了 MITM。在这个信任模型下，再做一次 JWT 验签只是徒增 CPU 开销。

但这套设计的**前提**是"Bridge 进程本身没被入侵"。如果攻击者拿到了 Bridge 进程的内存，他们可以直接调 `getAccessToken()`（`jwtUtils.ts:168`）拿到 OAuth 令牌，根本不用伪造 JWT。所以威胁模型是"防网络层攻击，不防进程被入侵"。

`createTokenRefreshScheduler`（`:72-256`）那 200 行的"失败重试 + generation counter + 30 分钟兜底 + 3 次失败放弃"逻辑，本质上是在防"刷新链断裂后会话静默掉线"——这是**可用性**防御，不是机密性防御。

### 为什么 share 的脱敏用正则而不是结构化扫描

`src/commands/share/index.ts:53-92` 的 `SECRET_PATTERNS` 表是一组正则，按"前缀 + 长度"匹配各类 token。**为什么不用 AST 解析 JSON、扫所有字符串字段**？

因为 transcript 的内容**不是结构化的**——它是用户和 Claude 的自由对话，token 可能出现在 markdown 代码块里、可能出现在错误消息里、可能被 Claude 引用又转述了一遍。结构化扫描要么扫不到（被文本包裹），要么扫到太多（合法的长字符串被误判）。

正则方案的优势是**精准按已知前缀匹配**：`sk-ant-` 是 Anthropic key 的固定前缀，`ghp_` 是 GitHub PAT 的固定前缀，`AKIA` 是 AWS key 的固定前缀。这些前缀是上游服务设计的"防误识别"机制，复用它们比自创规则更可靠。

但代价就是 `share/index.ts:89-91` 那条 NOTE 承认的局限：**没有固定前缀的 token（hex、base64）无法脱敏**，因为它们和合法的 git SHA、文件 hash 无法区分。这是"宁可漏过，不可误杀"的设计选择——误杀会把 transcript 弄成 `[REDACTED]` 满屏飞，比漏掉少数 token 还糟。

**根因**：在自由文本上做凭证脱敏是一个"召回率 vs 精确率"的权衡。share 选择了高精确率（固定前缀匹配），牺牲召回率（无前缀 token 漏过）。如果需要更强的脱敏，应该在源头（写入 transcript 之前）做，而不是在导出时亡羊补牢。

### 为什么 `/logout` 必须先 flushTelemetry

`src/commands/logout/logout.tsx:19-22` 的顺序看起来很奇怪：

```ts
export async function performLogout({ clearOnboarding = false }): Promise<void> {
  // Flush telemetry BEFORE clearing credentials to prevent org data leakage
  const { flushTelemetry } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();
  await removeApiKey();
  // ...
}
```

注释里的"prevent org data leakage"是关键。OpenTelemetry 的 instrumentation 在用户登录状态下会带上"当前组织 ID、用户 ID"等元数据，这些数据要发到 Anthropic 的 telemetry 后端。如果你先 `removeApiKey()` 再 flush，flush 出去的 telemetry 是"未登录状态"的，但这些事件实际上发生在"登录状态"下——属性不匹配。

更严重的场景：用户从 Org A 切到 Org B。如果先 clear 再 flush，A 状态下的事件可能被错误归因到 B 组织，泄漏 A 的活动给 B 管理员。先 flush 保证 A 状态下的事件还带着 A 的身份信息发出去，再 clear 切换身份。

**根因**：telemetry 的"身份绑定"必须和"事件发生时机"一致。`/logout` 不是单纯的"删 key"，而是一次"身份切换的状态机迁移"，必须按正确顺序：flush（保留旧身份） → clear（切换到匿名） → reset caches（清旧身份相关的缓存） → shutdown（进程退出）。

### 为什么 OpenAI 客户端是模块级缓存（设计取舍回顾）

这个点在 cross/01-troubleshooting.md 已经详细讲过，这里只补充**安全含义**。`getOpenAIClient`（`src/services/api/openai/client.ts:39`）把首次创建的客户端缓存到模块级 `cachedClient`，整个会话不重建。

**安全副作用**：会话中改 `OPENAI_API_KEY` 环境变量，**新 key 不会生效**，旧 key 仍在用。这听起来是 bug，但在另一个角度是**安全特性**：如果某个恶意脚本在会话中途改了 `OPENAI_API_KEY` 想劫持流量，它做不到——客户端已经被缓存，绑定的是原始 key。

代价是"用户合法换 key"也得重启 CLI，这是性能优化（避免每次调用都重建 axios 实例）和安全性（绑定首次凭证）的共同产物。`clearOpenAIClientCache()`（`openai/client.ts:76`）是逃生口，但只在 SDK 嵌入场景（用户自己写脚本）才可见——普通 CLI 用户根本不知道这个函数存在，只能通过重启来清缓存。

对比 `getAnthropicClient`（`client.ts:84`）：每次按 model/region 参数化新建，因为 AWS / GCP / Azure 凭证刷新、region 选择、header 注入都是**会话过程中可能变化的参数**。Anthropic 路径必须每次重新构造，所以它的"换 key 立即生效"行为是被动得到的，不是有意设计的。

## 两视角如何呼应

用户视角的每一个安全焦虑，几乎都能在设计视角找到对应的设计决策：

- **"我的密钥存在哪里"**（产品视角）对应 **"ChatGPT 凭证为什么用明文 JSON + 0o600"**（设计视角）——明文是为了和 Codex CLI 互操作，0o600 是这个权衡下的补偿。用户看到的是"明文 JSON"，开发者看到的是"互操作和强存储的冲突"。
- **"bypassPermissions 为什么被拒了"**（产品视角）对应 **"为什么 bypass 必须先检测 root 和 sandbox"**（设计视角）——用户看到的是"启动失败报错"，开发者看到的是"防御必须在威胁生效前完成"。
- **"令牌什么时候过期"**（产品视角）对应 **"为什么 OAuth 用 5 分钟刷新窗口"**（设计视角）——用户看到的是"自动续期"，开发者看到的是"刷新链断裂后的 3 次重试 + 30 分钟兜底"。
- **"`/share --mask-secrets` 会不会泄漏"**（产品视角）对应 **"为什么脱敏用正则而不是结构化扫描"**（设计视角）——用户看到的是"已脱敏"标签，开发者看到的是"召回率 vs 精确率权衡 + 无前缀 token 漏过的诚实交代"。
- **"`/logout` 真的清干净了吗"**（产品视角）对应 **"为什么必须先 flushTelemetry 再清凭证"**（设计视角）——用户看到的是"重置到初次安装"，开发者看到的是"telemetry 身份绑定的状态机迁移"。
- **"我把项目 settings.json push 到团队仓库会怎样"**（产品视角）对应 **"settings.json vs settings.local.json 的分层"**（设计视角）——用户看到的是"哪些文件会被共享"，开发者看到的是"团队设置和个人覆盖的优先级"。
- **"Codex CLI 登录的 ChatGPT 凭证 Claude 能用吗"**（产品视角）对应 **"为什么 chatgptAuth 回退读 `~/.codex/auth.json`"**（设计视角）——用户看到的是"两边都生效"，开发者看到的是"跨工具凭证互操作的有意设计"。

这种呼应关系是安全章必须双视角覆盖的核心原因：用户视角告诉你**怎么用才安全**，设计视角告诉你**这个安全机制覆盖了什么、没覆盖什么**。两个视角合在一起，才能让使用者正确评估"我能把这台机器借给同事吗"、"我能把这份 transcript 发到群里吗"这类问题——不会盲目信任某个"已脱敏"标签，也不会因为某个明文 JSON 就以为整套凭证管理都不安全。
