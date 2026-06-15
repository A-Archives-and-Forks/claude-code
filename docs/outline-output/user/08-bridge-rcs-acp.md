# 第八章：跨机器与跨团队协作 -- Bridge、Remote Control、ACP

> 让 Claude 从另一台机器、浏览器或 IDE 里被操控。

## Bridge 模式与 Remote Control -- 在浏览器里用 Claude

Bridge 模式是 Claude Code 的远程控制核心。启用后，你的本地 Claude Code 会话可以被远程客户端（浏览器、Web UI、其他工具）访问和操控。这在你想从另一台机器控制本地的 Claude，或者让团队成员在浏览器里审批权限请求时特别有用。

Bridge 由 `BRIDGE_MODE` feature flag 控制，dev 模式和默认构建都已启用。你不需要额外做任何事来开启它，只需要使用对应命令即可。

有两种常见的启动方式。第一种是从 REPL 内部启动：在 Claude Code 的对话中输入 `/remote-control`，它会将当前会话桥接到远程控制服务，并在终端显示一个 URL。

```
> /remote-control
Remote Control connecting...
This session is available via Remote Control at https://rcs.example.com/code?bridge=abc123
```

再次输入 `/remote-control` 会弹出对话框，提供三个选项：断开连接、显示二维码（方便手机扫码）、或继续当前连接。

第二种方式是通过命令行直接启动，这会进入"环境型"Remote Control 模式，注册一个可被分配工作的环境：

```bash
# 以下五个命令完全等价
claude remote-control
claude rc
claude remote
claude sync
claude bridge
```

启动后，终端会持续轮询任务，等待远程客户端分配工作。浏览器打开终端显示的 URL 后即可创建会话、发送消息、审批权限请求。

### 自托管 Remote Control Server (RCS)

RCS 是 Bridge 模式的服务端，负责接收 CLI 的注册、分发任务、转发消息。它可以部署在你自己的服务器上，所有数据流经你控制的网络，不经过任何第三方基础设施。

RCS 是一个纯内存的 HTTP + WebSocket 服务，基于 Hono 框架构建。它支持两套传输协议：V1 的 WebSocket 长连接和 V2 的 SSE + HTTP POST。

部署 RCS 最简单的方式是 Docker。在项目根目录执行：

```bash
docker build -t rcs:latest -f packages/remote-control-server/Dockerfile .
```

然后启动容器：

```bash
docker run -d \
  --name rcs \
  -p 3000:3000 \
  -e RCS_API_KEYS=sk-rcs-your-secret-key-here \
  -e RCS_BASE_URL=https://rcs.example.com \
  --restart unless-stopped \
  rcs:latest
```

也可以用 Docker Compose：

```yaml
version: "3.8"
services:
  rcs:
    build:
      context: .
      dockerfile: packages/remote-control-server/Dockerfile
    ports:
      - "3000:3000"
    environment:
      - RCS_API_KEYS=sk-rcs-your-secret-key-here
      - RCS_BASE_URL=https://rcs.example.com
    restart: unless-stopped
```

RCS 的核心配置通过环境变量控制。`RCS_API_KEYS` 是唯一的必填项，它既是客户端认证的 API Key，也用于 JWT 令牌签名，务必设置一个足够强的密钥。

在 Claude Code 这边，连接到自托管 RCS 只需要设置两个环境变量：

```bash
export CLAUDE_BRIDGE_BASE_URL="https://rcs.example.com"
export CLAUDE_BRIDGE_OAUTH_TOKEN="sk-rcs-your-secret-key-here"
```

设置 `CLAUDE_BRIDGE_BASE_URL` 后，代码会自动识别为自托管模式，跳过所有云端门控检查，不需要 claude.ai 账户。之后正常启动 Claude Code 并执行 `/remote-control` 即可。

如果你使用反向代理（Nginx 或 Caddy），需要确保代理支持 WebSocket 升级：

```nginx
server {
    listen 443 ssl;
    server_name rcs.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }
}
```

Caddy 会自动处理 WebSocket 升级，配置更简单：

```
rcs.example.com {
    reverse_proxy localhost:3000
}
```

### RCS Web UI

RCS 自带一个 Web 控制面板，通过 `/code/*` 路径访问。它是一个 React 19 + Vite + Radix UI 构建的单页应用，支持暗色和亮色主题切换。

Web UI 提供的核心功能包括：

- 查看所有已注册的运行环境，区分 Claude Code 和 ACP Agent 类型
- 创建和管理远程会话，实时查看对话消息和工具调用
- 审批 Claude Code 的工具权限请求，支持六种权限模式切换
- 查看 Plan 可视化，包含进度条、状态图标和优先级标签
- 查看 Autopilot 状态（`standby` 等待下一轮、`sleeping` 模型休眠中）
- 通过 QR 码扫码快速连接

Web UI 使用 UUID 认证，无需用户账户系统，适合部署在受信任的内网环境中。

## ACP 协议 -- 把 Claude Code 接入 IDE

ACP（Agent Client Protocol）是一种标准化的 stdio 协议，允许 IDE 和编辑器通过 stdin/stdout 的 NDJSON 流驱动 AI Agent。Claude Code 实现了完整的 ACP agent 端，可以被 Zed、Cursor 等支持 ACP 的客户端直接调用。

启用 ACP 模式只需要 `--acp` 参数。它是一个 CLI 快速路径（位于 `src/entrypoints/cli.tsx` 中），由 `FEATURE_ACP` feature flag 控制。

```bash
claude --acp
```

启动后，Claude Code 不再进入 REPL，而是通过 stdin/stdout 与 ACP 客户端通信。所有 console 输出都被重定向到 stderr，避免干扰 ACP 的 NDJSON 协议流。

### 在 Zed 中接入 Claude Code

Zed 是最典型的 ACP 客户端。打开 Zed 的设置（`Cmd+,`），在 `settings.json` 中添加：

```json
{
  "agent_servers": {
    "claude-code": {
      "type": "custom",
      "command": "claude",
      "args": ["--acp"]
    }
  }
}
```

如果你需要显式传入 API 凭证（而不是依赖 `settings.json` 中的配置），可以在 `env` 字段中指定：

```json
{
  "agent_servers": {
    "claude-code": {
      "command": "claude",
      "args": ["--acp"],
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.example.com/v1",
        "ANTHROPIC_AUTH_TOKEN": "sk-xxx"
      }
    }
  }
}
```

重启 Zed 后，按 `Cmd+'` 打开 Agent Panel，在顶部下拉菜单中选择 "claude-code" 即可开始对话。

在 ACP 模式下，Claude Code 支持完整的会话管理（新建、恢复、加载、分叉、关闭）、斜杠命令和 Skills（输入 `/` 查看列表，如 `/commit`、`/review`）、权限审批、模型切换和模式切换。当 Zed 重启时，之前的会话可以自动恢复并回放历史消息。

### 权限模式与 ACP 权限管道

ACP 模式下的权限系统与 REPL 模式略有不同。当 Claude 需要使用某个工具时，权限请求会被转发到 ACP 客户端（如 Zed），由用户在 IDE 中选择 Allow、Reject 或 Always Allow。

支持六种权限模式：`default`（每次确认）、`auto`（自动判断）、`acceptEdits`（自动接受文件编辑）、`plan`（规划模式）、`dontAsk`（不询问，未预批准则拒绝）、`bypassPermissions`（绕过所有权限检查，仅在非 root 或 sandbox 环境下可用）。

权限模式可以通过环境变量设置默认值：

```bash
ACP_PERMISSION_MODE=auto claude --acp
```

也可以在 ACP 客户端中动态切换。当 Claude 处于 Plan 模式并执行退出计划时，ACP 会显示一个特殊的选项面板，让你选择退出后进入哪种模式（auto、acceptEdits、default、plan、bypassPermissions）。

## acp-link -- 通过网络暴露 ACP Agent

ACP 协议本身基于 stdio，意味着 ACP agent 只能在本机使用。`acp-link` 是一个 WebSocket 代理服务器，将远程 WebSocket 客户端桥接到本地 ACP agent 的 stdio 接口，让 ACP agent 可以通过网络访问。

### 独立使用

最基本的用法：启动 acp-link，让它管理一个 ACP agent 子进程：

```bash
acp-link claude --acp
```

默认监听 `localhost:9315`。你也可以指定端口和主机：

```bash
acp-link --port 9000 --host 0.0.0.0 claude --acp
```

启用 HTTPS（自动生成自签名证书）：

```bash
acp-link --https claude --acp
```

acp-link 启动后会自动生成一个随机认证 token。WebSocket 客户端通过 `rcs.auth.<base64url-token>` 子协议传递 token。如果需要固定 token：

```bash
ACP_AUTH_TOKEN=my-fixed-token acp-link claude --acp
```

开发环境下可以禁用认证（不推荐在生产环境使用）：

```bash
acp-link --no-auth claude --acp
```

### 与 RCS 集成

acp-link 可以将 ACP agent 注册到 RCS，通过 RCS 的 Web UI 进行交互。设置两个环境变量即可：

```bash
ACP_RCS_URL=http://localhost:3000 \
ACP_RCS_TOKEN=sk-rcs-your-key \
acp-link claude --acp
```

注册流程分两步：首先通过 REST API 向 RCS 注册环境，然后建立 WebSocket 连接并发送 identify 消息。之后 ACP agent 会出现在 RCS Web UI 的环境列表中，与普通 Claude Code 会话一起管理和监控。

## IDE 集成 -- 在编辑器里使用 Claude Code

除了通过 ACP 协议接入 Zed 等原生 ACP 客户端，Claude Code 还提供 `/ide` 命令，帮助检测和连接正在运行的 IDE。这个命令会自动扫描本地已安装的 IDE（包括 JetBrains 系列和各种终端），并提供选择界面。

在 REPL 中输入：

```
/ide
```

Claude Code 会检测本地运行的 IDE 和支持的终端，让你选择要连接的目标。连接后，Claude Code 可以通过 IDE 的 Language Server Protocol 获取代码上下文，提供更精准的编辑建议。

## SSH 远程模式

`SSH_REMOTE` feature 允许 Claude Code 通过 SSH 在远程机器上工作。在 main.tsx 中通过 `feature('SSH_REMOTE')` 控制，当启用时会接管 `--ssh` 参数和相关的 SSH 连接逻辑。

启用 SSH 远程模式后，Claude Code 可以在远程机器上启动会话，通过 SSH 隧道保持通信。这对于在服务器或 CI 环境中使用 Claude Code 特别有用。`/remote-setup` 命令提供辅助设置流程，`/remote-env` 命令提供远程环境管理界面。

## 常见问题

**Remote Control is not available in this build** -- `BRIDGE_MODE` feature flag 未启用。使用 dev 模式（`bun run dev`）默认启用，或确保构建时包含该 flag。

**认证失败 (401 Unauthorized)** -- 检查 `CLAUDE_BRIDGE_OAUTH_TOKEN` 是否与 RCS 的 `RCS_API_KEYS` 中的值完全匹配，注意排除多余空格或换行。

**WebSocket 连接中断** -- 如果使用反向代理，确认已配置 WebSocket 升级（`Upgrade` / `Connection` 头），`proxy_read_timeout` 建议设为 86400 秒。

**RCS 重启后数据丢失** -- RCS 使用纯内存存储，重启后所有会话和环境数据都会清除。`/app/data` 卷已预留但当前未使用。

## 下一步

- 想配置 Provider 和模型，看 [第二章](./02-providers.md)
- 想了解权限模式和安全配置，看 [第九章](./09-budget-caching-hooks.md)
- 想在 CI 流水线中使用 Claude Code，看 [第十一章](./11-ci-integration.md)
- 想处理连接问题和其他报错，看 [第十章](./10-troubleshooting.md)
