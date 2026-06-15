# 第十二章：ACP / Bridge / Daemon —— 三个长驻模式的接线

> 三个 feature-gated 的长驻模式，各自用不同策略共享同一个 query loop。

## 为什么长驻模式是 feature-gated 的

ACP（Agent Client Protocol）、Bridge（Remote Control）、Daemon（supervisor）在 `cli.tsx` 的 fast-path 优先级链中各自占据一个分支，全部被 feature flag 守卫。打开 `src/entrypoints/cli.tsx`，你会看到 `if (feature('BRIDGE_MODE'))` 守着 bridge/remote-control 分支，`if (feature('DAEMON'))` 守着 daemon 子命令，`if (feature('ACP'))` 守着 `--acp` 入口。

这不是因为这三个模式"功能不完善所以默认关闭"——实际上它们都已经恢复并且功能完整。根本原因是**启动延迟**。每个长驻模式都需要导入重量级依赖（JWT 工具、WebSocket 传输、会话管理），如果把这些 import 放在 fast-path 链之前，`claude --version` 的启动时间会被拖慢。feature flag 让 Bun 编译器在构建时通过 DCE（Dead Code Elimination）把未启用的分支整棵剪掉。

**反事实推演**：如果不做 feature gate，`BRIDGE_MODE` 分支会强制每个 CLI 进程都 import `jwtUtils.ts`、`sessionRunner.ts`、`workSecret.ts` 等 bridge 模块。在第二章（Code Splitting）已经解释过，JSC 会全量解析 import 的字节码。`--version` 的 RSS 从 35MB 暴涨回去，这不是理论推演，而是已经发生过的现实。

## ACP Agent：把 QueryEngine 包装成协议实现

ACP 的核心在 `src/services/acp/agent.ts`。打开这个文件，你会看到一个 `AcpAgent` 类实现了 `@agentclientprotocol/sdk` 的 `Agent` 接口——`initialize`、`authenticate`、`newSession`、`prompt`、`cancel` 等方法一应俱全。

设计上最值得注意的是：**ACP 没有自己的 query loop，它直接复用 `QueryEngine`**。打开 `src/services/acp/agent.ts:585`，你会看到：

```ts
const queryEngine = new QueryEngine(engineConfig)
```

ACP 的 `prompt()` 方法（`agent.ts:308`）调用的是 `session.queryEngine.submitMessage(promptInput)`——和 REPL 屏幕、pipe 模式用的是同一个 `submitMessage`。区别在于消息消费方式：REPL 把 `SDKMessage` yield 给 Ink 组件渲染，ACP 把它们转发给 ACP 协议的 `sessionUpdate` 通知。

### 消息转译层：bridge.ts

`src/services/acp/bridge.ts` 是 ACP 最厚的文件（~1000 行），职责单一但沉重：**把 Claude Code 内部的 `SDKMessage` 类型转译成 ACP 协议的 `SessionUpdate`**。它定义了一个本地判别联合类型 `BridgeSDKMessage`（`bridge.ts:168`），覆盖 9 种消息形态：system、result、assistant、stream_event、user、progress、tool_use_summary、attachment、compact_boundary。

打开 `bridge.ts:191`，你会看到 `toolInfoFromToolUse` 函数根据工具名做 switch-case，把内部工具调用元数据转译成 ACP 的 `ToolCallContent` 格式。这种"内联 switch"在反编译产物中很常见——原始代码可能用的是策略模式，但反编译后退化成了 switch-case。

### 权限流水线：createAcpCanUseTool

`src/services/acp/permissions.ts` 导出的 `createAcpCanUseTool` 是整个 ACP 权限系统的接线点。打开 `permissions.ts:32`，你会看到它返回一个 `CanUseToolFn`——和 REPL 的权限回调签名完全一致。但在内部，它做了三层处理：

1. **本地管道优先**（`permissions.ts:79`）：先跑 `hasPermissionsToUseTool`，这是 Claude Code 内置的权限规则引擎（deny rules、allow rules、tool-specific checks）。如果本地管道直接 allow 或 deny，就不打扰远程客户端。
2. **客户端委托**（`permissions.ts:130`）：如果本地管道返回 `ask`（需要用户确认），才通过 `conn.requestPermission()` 委托给 ACP 客户端。
3. **ExitPlanMode 特殊处理**（`permissions.ts:57`）：退出计划模式时不是简单的 allow/deny，而是提供多选项（auto、acceptEdits、default、plan，如果可用还包括 bypassPermissions）。

这种设计解决了一个关键问题：**ACP 客户端不应该为每个工具调用都弹权限对话框**。本地规则（如 `.claude/settings.json` 中的 `allow` 规则）应该静默放行，只有不确定的情况才打扰用户。如果不这么做，RCS Web UI 上每秒都会弹出几个权限确认，体验完全不可用。

### bypassPermissions 的三层防护

ACP 的 `bypassPermissions` 模式有严格的三层防护，打开 `agent.ts:1005` 你会看到：

```ts
function isAcpBypassPermissionModeAvailable(settingsMode?: unknown): boolean {
  return (
    isProcessBypassPermissionModeAvailable() &&
    (isAcpBypassLocallyEnabled() ||
      isSettingsBypassPermissionMode(settingsMode))
  )
}
```

三层分别是：进程级（非 root/sandbox 环境检测，`agent.ts:1013`）、环境变量级（`ACP_PERMISSION_MODE=bypassPermissions` 或 `CLAUDE_CODE_ACP_ALLOW_BYPASS_PERMISSIONS=1`）、配置级（`settings.json` 中 `permissions.defaultMode=bypassPermissions`）。三层全部满足才开放。

**反事实推演**：如果不做这三层防护，任何能连接到 ACP agent 的客户端（包括远程 RCS 用户）都能直接绕过所有权限检查，执行任意 shell 命令。在 daemon 场景下这尤其危险——daemon worker 以宿主用户身份运行。

### Prompt 队列化

`agent.ts:278` 实现了一个简单的 prompt 队列：如果当前有 prompt 正在运行，新的 prompt 会被推入 `pendingQueue`，等待当前 prompt 完成后 FIFO 消费。`agent.ts:1054` 的 `compactPendingQueue` 函数在队列头部消费超过 1024 个且 head 指针超过长度一半时做数组切片压缩。

这个设计解决的是**并发 prompt 竞争**：如果 ACP 客户端在 Claude 还在处理上一条消息时发了新消息，没有队列的话会导致 `QueryEngine` 的 abort controller 状态混乱（`agent.ts:302` 的 `resetAbortController` 注释解释了这个问题）。

### entry.ts：为什么重定向 console.log

打开 `src/services/acp/entry.ts:44`，你会看到一行诡异的代码：

```ts
console.log = console.error
```

ACP 通过 `process.stdin` / `process.stdout` 与客户端通信（`entry.ts:36` 创建 `ndJsonStream`），所以 stdout 必须完全留给 ACP 协议消息。任何 `console.log` 调用如果写到 stdout，都会被客户端解析为 ACP 消息，导致协议错误。因此所有 console 输出都被重定向到 stderr。

**反事实推演**：如果遗漏了这行，任何 debug 级别的 `console.log` 都会在 Zed 编辑器或 RCS Web UI 上显示为不可解析的消息，触发连接断开。

## acp-link：WebSocket 代理的"进程透明"

`packages/acp-link` 是一个独立的 npm 包，不依赖 Claude Code 源码。它的职责是：**让任何 ACP 客户端（如 Zed 编辑器）通过 WebSocket 连接到一个 ACP agent 进程**。

打开 `packages/acp-link/src/server.ts:279`，你会看到 acp-link 每次 WebSocket `connect` 时都会 spawn 一个 agent 子进程：

```ts
const agentProcess = spawn(AGENT_COMMAND, AGENT_ARGS, {
  cwd: AGENT_CWD,
  stdio: ['pipe', 'pipe', 'inherit'],
})
```

然后通过 Node.js 的 `Readable.toWeb` / `Writable.toWeb` 把子进程的 stdin/stdout 转成 Web Stream，交给 `@agentclientprotocol/sdk` 的 `ndJsonStream`：

```ts
const input = Writable.toWeb(agentProcess.stdin!)
const output = Readable.toWeb(agentProcess.stdout!)
const stream = acp.ndJsonStream(input, output)
const connection = new acp.ClientSideConnection(...)
```

对 ACP 客户端来说，它以为自己在和一个原生 ACP 服务通信——它不知道中间隔了一层 WebSocket 代理和一个被 spawn 的子进程。这就是"进程透明"的含义。

### 权限传递：环境变量注入

acp-link 的 `buildAgentEnv()`（`server.ts:1031`）把 `ACP_PERMISSION_MODE` 注入到子进程的环境变量中。子进程（即 Claude Code ACP agent）在启动时读取这个环境变量来决定默认权限模式。

这种设计让 acp-link 可以在启动时通过 CLI 参数 `--permission-mode auto` 或环境变量 `ACP_PERMISSION_MODE` 统一设置权限模式，而不需要每个 ACP 客户端在 `newSession` 时分别指定。权限模式解析链（`server.ts:986`）：客户端请求的 mode > acp-link 默认 mode（环境变量/CLI 参数）> agent 内部默认。对于 `bypassPermissions`，则强制要求 acp-link 本地已启用该模式（`server.ts:1005`），否则直接抛异常。

### RCS 集成：REST 注册 + WS identify 两步流程

打开 `packages/acp-link/src/rcs-upstream.ts:66`，你会看到 `registerViaRest` 方法先通过 REST API `POST /v1/environments/bridge` 注册，获取 `environment_id`，然后建立 WebSocket 连接发送 `identify` 消息（`rcs-upstream.ts:143`）。

两步流程的设计意图：REST 注册是无状态的，可以用 API token 认证；WebSocket identify 则是在已建立的 WS 连接上用 `Sec-WebSocket-Protocol` header 传递 token（`ws-auth.ts:9` 的 `encodeWebSocketAuthProtocol` 把 token 编码成 `rcs.auth.<base64url>` 格式）。两者分离的好处是 WebSocket 可以断线重连而不需要重新注册（只要 `environment_id` 还有效）。

打开 `ws-auth.ts:60`，你会看到 token 比较用了 `timingSafeEqual`：

```ts
return timingSafeEqual(sha256(providedToken), sha256(expectedToken))
```

先 SHA-256 再比较，防止 timing attack 泄漏 token 长度信息。

### 虚拟 WSContext：relay 的巧妙设计

`server.ts:120` 的 `createRelayWs()` 创建了一个假的 `WSContext` 对象——`send` 是 no-op，`readyState` 永远返回 1（OPEN）。这是因为 RCS relay 消息不需要发送到本地 WebSocket，而是通过 `rcsUpstream.send()` 发送到 RCS 服务器。虚拟 WSContext 让 relay 消息可以复用 `dispatchClientMessage` 的完整分发逻辑，而不需要为 relay 写一套独立的处理代码。

### 前端重连不重启进程

`server.ts:252` 有一个容易被忽略但很精巧的设计：

```ts
if (state.connection && state.process && !state.process.killed && state.process.exitCode === null) {
  logAgent.info('already connected, resending status')
  send(ws, 'status', { connected: true, ... })
  return
}
```

当 Zed 编辑器因网络波动断开 WebSocket 后重连时，acp-link 检查 agent 进程是否还活着。如果进程还健康，只重新发送 status 消息，不重启进程。这避免了每次前端重连都重启 agent 的浪费——agent 进程可能正在执行一个长时间任务。

## Bridge 模式：Anthropic 原版的"云端会话调度"

Bridge 模式（`src/bridge/`）是 Anthropic 原版 Claude Code 的 Remote Control 实现——与 ACP 不同，它是围绕 Anthropic 云端 API 设计的。ACP 是后来添加的开放协议，Bridge 则是原始的封闭实现。

打开 `src/bridge/bridgeMain.ts:1`，第一行就是 `import { feature } from 'bun:bundle'`——整个 bridge 目录都是 feature-gated 的。Bridge 的核心是 `runBridgeLoop` 函数（`bridgeMain.ts:140`），它实现了一个经典的 poll-dispatch 模式：

1. 向 Anthropic 云端 API 轮询待处理的 work item（`bridgeMain.ts` 中的 poll 循环）
2. 收到 work 后 spawn 一个子进程执行（通过 `SessionSpawner`）
3. 心跳活跃的 work item（`bridgeMain.ts` 的 heartbeat 循环）
4. work 完成后 ack 回云端

Bridge 使用 JWT 认证（`jwtUtils.ts` 中的 `createTokenRefreshScheduler`），token 刷新调度器定期刷新 access token。Work secret（`workSecret.ts` 的 `decodeWorkSecret`）包含编码后的 JWT，用于 ack 和心跳的认证。

### Daemon 与 Bridge 的关系

Daemon（`src/daemon/`）是 Bridge 的 supervisor。打开 `src/daemon/main.ts:52`，`daemonMain` 函数处理 `claude daemon start/stop/status/bg/attach/logs/kill` 子命令。其中 `start` 子命令启动 supervisor 循环（`main.ts:230`），supervisor 的唯一默认 worker 是 `remoteControl`：

```ts
const workers: WorkerState[] = [{
  kind: 'remoteControl',
  process: null,
  backoffMs: BACKOFF_INITIAL_MS,
  failureCount: 0,
  parked: false,
  ...
}]
```

每个 worker 通过 `buildCliLaunch` + `spawnCli` 启动子进程，传入 `--daemon-worker=remoteControl` 参数。子进程入口在 `src/daemon/workerRegistry.ts:26`，映射到 `runRemoteControlWorker()`（`workerRegistry.ts:57`），后者调用 `runBridgeHeadless(opts, controller.signal)`——最终进入 Bridge 的 headless 循环。

**为什么 Daemon 不直接跑 Bridge 循环？** 因为 Daemon 需要监控 worker 进程的健康状态，在崩溃时重启。如果 Bridge 循环直接在 supervisor 进程里跑，supervisor 崩溃时没有更高层的恢复机制。worker 进程隔离让 supervisor 可以通过退出码判断是永久错误（`EXIT_CODE_PERMANENT = 78`，来自 `sysexits.h` 的 `EX_CONFIG`）还是可重试的临时错误。

### Worker 崩溃的指数退避与快速失败 park

打开 `src/daemon/main.ts:377`，你会看到 worker 退出处理逻辑。快速失败检测（`main.ts:394`）：如果 worker 在启动后 10 秒内退出，计入 `failureCount`，连续 5 次快速失败后 park 该 worker（不再重启）。正常退出的 worker 则重置 `failureCount` 和 `backoffMs`。

退避策略是标准的指数退避（`main.ts:423`）：初始 2 秒，倍数 2，上限 120 秒。加上随机 jitter 防止多个 worker 同时重启。

**反事实推演**：如果没有 park 机制，一个配置错误的 worker（比如 CWD 不存在）会无限循环 spawn-crash-restart，持续消耗 CPU 和日志空间。`EXIT_CODE_PERMANENT` 让 worker 可以主动声明"别重启我了"。

### Daemon 状态持久化

`src/daemon/state.ts` 把 daemon 的 PID、CWD、启动时间、worker 类型写入 `~/.claude/daemon/remote-control.json`。另一个 CLI 进程（比如 `claude daemon status`）通过读取这个文件并用 `process.kill(pid, 0)` 检测进程是否存活来查询状态。如果 PID 已死但文件还在，自动清理（`state.ts:99` 的 stale 检测）。

## 自托管 RCS：三层架构的交汇点

`packages/remote-control-server/`（简称 RCS）是自托管的 Remote Control Server，提供了完整的 Web UI 控制面板。打开 `packages/remote-control-server/src/index.ts:1`，你会看到一个 Hono 应用注册了四组路由：

- **v1 路由**：`/v1/environments/bridge`——REST 注册端点，供 acp-link 调用
- **v2 路由**：`/v2/code-sessions`、`/v2/worker`——Worker API，供 Bridge 模式使用
- **acp 路由**：`/acp/ws`——ACP WebSocket 端点，供 acp-link 连接
- **web 路由**：`/web/*`——React 19 + Vite + Radix UI 构建的 Web UI

RCS 的核心传输层在 `packages/remote-control-server/src/transport/`，有三个 WebSocket handler：`ws-handler.ts`（原始 Bridge WS）、`acp-ws-handler.ts`（ACP 协议 WS）、`acp-relay-handler.ts`（ACP relay，转发现有 ACP 连接的消息）。这三个 handler 共享同一个 `event-bus.ts` 事件总线。

RCS 是三个长驻模式的交汇点：
- **Bridge 模式**通过 v2 Worker API 注册和通信
- **ACP 模式**通过 acp-link 代理注册和通信
- **Daemon**可以管理运行 RCS 或 Bridge worker 的进程

## 三个模式的横向对比

| 维度 | ACP | Bridge | Daemon |
|------|-----|--------|--------|
| 协议 | 开放 ACP 协议（ndjson over stdio） | Anthropic 私有 REST+WS API | 进程管理（spawn + SIGTERM） |
| 入口 | `--acp` flag | `BRIDGE_MODE` feature | `DAEMON` feature |
| 通信方式 | stdin/stdout ndjson | HTTP REST + WebSocket | 环境变量 + stdio pipe |
| 认证 | 无（自托管） | JWT + OAuth | 本地文件状态 |
| query 复用 | 直接 new QueryEngine | spawn 子进程跑 REPL/bridge | spawn 子进程跑 worker |
| 超时管理 | prompt 队列 + cancelGeneration | session timeout + work secret | 快速失败 park + 退避 |

### 为什么 ACP 不 spawn 子进程

Bridge 和 Daemon 都通过 spawn 子进程来隔离工作负载，但 ACP 直接在同一进程内创建 `QueryEngine` 实例。原因是：ACP 的通信通道是 stdin/stdout——它本身就是被设计为"被某个 IDE 或代理 spawn 的子进程"。如果 ACP 再 spawn 子进程，就变成了两层子进程嵌套，通信复杂度倍增。

### 为什么 Bridge 需要 poll 循环而不是 push

Bridge 的设计受制于 Anthropic 云端 API 的架构——work item 存在云端队列中，本地 bridge 需要主动轮询。这不是技术选择而是架构约束。ACP 模式则不同，客户端直接 push prompt 给 agent，不需要云端中间层。

## environment-runner：三条线的交汇点

`claude environment-runner` / `claude self-hosted-runner`（BYOC runner）是产品大纲第十一章提到的功能。它是 ACP、Bridge、CI 三条线的交汇点：在 CI 环境中，runner 可以用 ACP 协议暴露 Claude Code 能力，也可以通过 Bridge 模式连接 Anthropic 云端。三者共享的底层是同一个 `QueryEngine`，区别只在于谁发起 prompt（CI 脚本、IDE 客户端、云端调度器）和权限如何传递（环境变量、JWT、ACP permission 回调）。

## 延伸阅读

- 想看 QueryEngine 的完整 API，见 [第四章：核心 Query Loop](./04-query-loop.md)
- 想看 feature flag 的 DCE 机制如何让这三个模式在构建时被剪掉，见 [第五章：Feature Flag 系统的三个硬约束](./05-feature-flags.md)
- 想看权限系统的完整规则引擎，见 [第十一章：三层状态管理](./11-state-management.md) 中的 `AppState.toolPermissionContext` 段
- 想看 Code Splitting 如何让长驻模式的开销不影响快速路径，见 [第一章：Code Splitting 不是优化，是生存需求](./01-code-splitting.md)
