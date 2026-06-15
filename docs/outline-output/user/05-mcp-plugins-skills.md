# 第五章：扩展 Claude 的能力 -- MCP Server、插件、Skill

> 内置工具不够用时，用 MCP 接入外部服务，用插件扩展功能，用 Skill 沉淀工作流。

## MCP 是什么？什么时候该用它

MCP（Model Context Protocol）是一种标准化协议，让 Claude Code 能调用外部程序提供的工具和资源。你可以把它理解成一个"工具插件接口"：任何实现了 MCP 协议的程序，都可以把自身能力暴露给 Claude Code 使用。

典型的使用场景包括：

- **数据库操作**：接入一个 MCP server，让 Claude Code 能直接查询和管理数据库
- **API 交互**：接入 Sentry、GitHub、Slack 等服务的 MCP server，让 Claude Code 能直接操作这些服务
- **文件系统扩展**：接入特定格式（比如 Figma 设计文件）的 MCP server

MCP server 通过三种传输方式与 Claude Code 通信：

| 传输方式 | 适合场景 | 典型命令 |
|----------|---------|---------|
| **stdio** | 本地命令行程序，如 `npx my-mcp-server` | `claude mcp add my-server -- npx my-mcp-server` |
| **SSE** | 远程服务，通过 Server-Sent Events 通信 | `claude mcp add --transport sse my-server https://example.com/sse` |
| **HTTP** | 远程 HTTP 端点 | `claude mcp add --transport http sentry https://mcp.sentry.dev/mcp` |

如果你只是想让 Claude Code 做一些固定的本地操作（比如跑测试、读日志），通常写一个 Skill（见本章后半部分）更轻量。MCP 更适合需要持续运行的外部服务或复杂的多工具场景。

## 用 `claude mcp add` 接入现成 MCP server

最常见的方式是通过 `claude mcp add` 命令，把一个现成的 MCP server 注册到 Claude Code。

### 添加 stdio 类型的 server

stdio 类型适用于本地可执行程序，比如通过 `npx` 运行的 Node.js 包：

```bash
# 添加一个 stdio server，自动以 -- 后面的内容为子命令
claude mcp add my-server -- npx my-mcp-server

# 带环境变量
claude mcp add -e API_KEY=xxx my-server -- npx my-mcp-server

# 带额外参数
claude mcp add my-server -- my-command --some-flag arg1
```

### 添加 HTTP 或 SSE 类型的 server

对于远程 MCP 服务，需要指定传输方式：

```bash
# HTTP server
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

# 带认证头的 HTTP server
claude mcp add --transport http corridor https://app.corridor.dev/api/mcp \
  --header "Authorization: Bearer your-token"

# SSE server
claude mcp add --transport sse my-server https://example.com/sse
```

### 配置范围

`-s` 参数控制配置写入的位置，影响谁能看到这个 MCP server：

| 范围 | 说明 | 配置文件位置 |
|------|------|------------|
| `local`（默认） | 仅当前项目 | 项目目录下的配置文件 |
| `user` | 当前用户所有项目 | 用户主目录下的全局配置 |
| `project` | 项目级共享（可提交到 git） | 项目目录下的配置文件 |

例如，把一个数据库 MCP server 配置为整个团队可用：

```bash
claude mcp add -s project my-db -- npx my-db-mcp-server
```

## 管理已接入的 server

注册之后，你可以在对话内或通过 CLI 管理这些 MCP server。

### CLI 方式

```bash
# 列出所有已配置的 MCP server
claude mcp list

# 查看某个 server 的详情
claude mcp get my-server

# 移除一个 server
claude mcp remove my-server

# 从特定范围移除
claude mcp remove -s local my-server
```

### 对话内方式

在 REPL 中输入 `/mcp` 会打开 MCP 管理面板。你可以在这里：

- **启用/禁用 server**：`/mcp enable my-server` 或 `/mcp disable my-server`
- **批量操作**：`/mcp enable all` 或 `/mcp disable all`
- **重新连接**：`/mcp reconnect my-server`（当连接断开时）
- **查看 server 提供的工具和资源**：在面板中选择 server 查看详情

启用或禁用是会话级别的操作，不会删除配置。重启 Claude Code 后，之前禁用的 server 会恢复启用状态。

## 把 Claude Code 自己暴露为 MCP server

`claude mcp serve` 命令把 Claude Code 自身启动为一个 MCP server，让其他 MCP 客户端（比如 IDE、其他 AI 工具）能调用它的工具：

```bash
# 启动 Claude Code MCP server
claude mcp serve

# 带调试信息
claude mcp serve --debug

# 详细输出
claude mcp serve --verbose
```

这在你想把 Claude Code 的文件操作、搜索、代码编辑等能力暴露给外部工具时很有用。

## MCP server 连接了但工具看不到？排查要点

接入 MCP server 后，如果 Claude Code 似乎"不知道"新工具的存在，可能有以下原因：

1. **server 启动失败**：用 `claude mcp list` 检查 server 状态。stdio 类型的 server 如果命令路径不对或依赖缺失，会静默失败。
2. **工具是延迟加载的**：非核心工具（包括所有 MCP 工具）默认不会全部加载到上下文。Claude Code 使用 SearchExtraTools 机制，按需搜索和加载延迟工具。当你的请求需要用到 MCP 工具时，它会自动搜索并加载。
3. **OAuth 认证未完成**：需要 OAuth 的 HTTP/SSE server 如果认证未通过，工具虽然能被发现但调用会失败。
4. **scope 不对**：`claude mcp add -s local` 添加的 server 只在当前项目目录生效。切换到其他目录后该 server 不可用。

## 自己写一个 MCP server 的最小骨架

如果你找不到现成的 MCP server 来满足需求，可以自己写一个。核心步骤是：

1. 使用 MCP SDK 创建一个 Server 实例
2. 注册工具（ListTools + CallTool）
3. 通过 stdio 或 HTTP 暴露服务

下面是一个最简单的 stdio MCP server（TypeScript，使用官方 `@modelcontextprotocol/sdk`）：

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "my-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_weather",
      description: "Get the current weather for a city",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { city } = request.params.arguments as { city: string };
  return {
    content: [{ type: "text", text: `Weather in ${city}: sunny, 22C` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

写好后注册到 Claude Code：

```bash
claude mcp add weather-server -- npx tsx my-mcp-server.ts
```

接下来在对话里让 Claude Code "查询北京的天气"，它就会自动调用你的 `get_weather` 工具。

## 内置 MCP 能力：Computer Use、Chrome 控制、语音输入

除了接入外部 MCP server，Claude Code 本身也提供了几个内置的 MCP 功能，覆盖屏幕控制、浏览器操作和语音输入。

### Computer Use（屏幕控制）

通过 `--computer-use-mcp` 启动参数加载，提供截屏、键鼠控制和应用管理能力。支持 macOS、Windows、Linux 三大桌面平台，共 38 个工具。

```bash
claude --computer-use-mcp
```

启用后，Claude Code 可以看到你的屏幕、模拟鼠标键盘操作、管理应用窗口。比如你可以说"打开系统设置，把亮度调到 80%"，它会截图、识别界面、操作完成。详见 [Computer Use 文档](../../features/external/computer-use.md)。

### Chrome 浏览器控制

通过 `--chrome-native-host` 或 `--claude-in-chrome-mcp` 启动参数加载。提供两种方案：

- **Chrome Use MCP**（社区开源）：通过 MCP 扩展接入，适合自托管场景
- **Claude in Chrome**（原生集成）：Anthropic 官方扩展，提供完整能力（截图、网络监控、JS 执行等）

详见 [Chrome 控制文档](../../features/external/chrome-control.md)。

### 语音输入

通过 `FEATURE_VOICE_MODE=1` 启用，支持 Push-to-Talk 语音输入。长按空格键录音，释放后自动转录并发送。支持 Anthropic STT 和豆包 ASR 两种后端。

```bash
FEATURE_VOICE_MODE=1 claude
```

在对话中用 `/voice` 切换语音模式，`/voice doubao` 切换到豆包后端。详见 [Voice Mode 文档](../../features/external/voice-mode.md)。

## 插件系统：安装和管理社区插件

插件（Plugin）是在 Claude Code 中扩展功能的另一种方式。与 MCP server 不同，插件可以包含工具、命令、设置项等多种能力，更像一个"功能包"。

### 浏览和安装插件

在 REPL 中输入 `/plugin`（或 `/plugins`、`/marketplace`）打开插件管理界面。你也可以用命令行子操作：

```bash
# 打开插件菜单
/plugin

# 安装插件
/plugin install plugin-name

# 从指定 marketplace 安装
/plugin install plugin-name@marketplace-url

# 管理已安装的插件
/plugin manage

# 启用/禁用/卸载
/plugin enable plugin-name
/plugin disable plugin-name
/plugin uninstall plugin-name
```

### 插件市场

插件通过 marketplace 分发。Claude Code 支持管理多个 marketplace 来源：

```bash
# 添加一个 marketplace
/plugin marketplace add https://my-marketplace.example.com/registry.json

# 列出已添加的 marketplace
/plugin marketplace list

# 更新 marketplace 索引
/plugin marketplace update
```

### 验证插件

安装前可以验证插件的完整性：

```bash
/plugin validate path/to/plugin
```

### 插件 vs MCP server

两者的界限有时模糊，但大致可以这样区分：

| 维度 | MCP Server | 插件 |
|------|-----------|------|
| 通信方式 | 标准协议（stdio/SSE/HTTP） | 直接集成到 Claude Code |
| 包含内容 | 工具和资源 | 工具 + 命令 + 设置 + UI 组件 |
| 来源 | 任何实现了 MCP 的程序 | Claude Code 插件市场 |
| 管理方式 | `claude mcp add/list/remove` | `/plugin install/manage` |

简单来说：MCP server 适合对接外部服务，插件适合扩展 Claude Code 自身的行为。

## Skill 是什么？

Skill 是一段 Markdown 文本，定义了 Claude Code 在特定场景下应该怎么行动。它不是"可执行代码"，而是一份结构化的行为指南，被 Claude Code 读取后影响它的决策和操作方式。

你可以把 Skill 理解为给 Claude Code 的一份"操作手册"：告诉它在遇到特定类型任务时，应该遵循什么步骤、用什么工具、注意什么事项。

### 查看可用 Skill

在 REPL 中输入 `/skills` 打开 Skill 列表面板。你会看到所有可用的 Skill 及其简要描述。每个 Skill 有一个名称和触发条件（whenToUse），Claude Code 会根据对话上下文自动匹配最相关的 Skill。

### Skill Store（远程 Skill 市场）

`/skill-store` 命令打开远程 Skill 市场，可以浏览和安装社区发布的 Skill。它需要 Anthropic API Key 或 workspace API key：

```bash
# 打开 Skill Store
/skill-store

# 列出可用 Skill
/skill-store list

# 查看某个 Skill 的详情
/skill-store get skill-id

# 查看版本历史
/skill-store versions skill-id

# 安装 Skill
/skill-store install skill-id
```

`/skill-store` 也叫 `/ss` 或 `/cloud-skills`，三个别名指向同一个命令。

### `/skills` 与 `/skill-store` 的区别

| 命令 | 作用 | 数据来源 |
|------|------|---------|
| `/skills` | 查看当前会话可用的所有 Skill（本地 + 远程 + 内置） | 本地 `.claude/skills/` 目录 + 内置 Skill |
| `/skill-store` | 浏览和安装远程社区的 Skill | Anthropic Skill 市场（需 API Key） |

简单说：`/skills` 看你"有什么"，`/skill-store` 去"买新的"。

## 写一个自己的 Skill 并复用

自定义 Skill 是 Markdown 文件，放在 `.claude/skills/` 目录下（项目级）或 `~/.claude/skills/`（用户级）。

### Skill 文件结构

一个 Skill 文件就是一份结构化的 Markdown：

```markdown
---
name: my-code-review
description: Review code changes with security and performance focus
---

# Code Review Skill

When asked to review code, follow these steps:

1. Read the changed files using the Read tool
2. Check for common security issues (injection, auth bypass, data leaks)
3. Check for performance anti-patterns (N+1 queries, unnecessary allocations)
4. Verify error handling is complete
5. Report findings in a structured table format
```

把这个文件保存为 `.claude/skills/my-code-review.md` 后，Claude Code 在处理代码审查请求时就会参考这个 Skill 的指导。

### Skill 搜索与自动匹配

启用 Skill Search（`/skill-search start`）后，Claude Code 会在每轮对话中自动搜索并加载与当前任务最相关的 Skill。搜索基于 TF-IDF 向量余弦相似度算法，支持英文词干化和中文 bi-gram 分词。

```bash
/skill-search start   # 启用自动匹配
/skill-search stop    # 禁用自动匹配
/skill-search status  # 查看当前状态
```

启用后，Skill Search 会索引 `.claude/skills/` 和 `~/.claude/skills/` 下的所有 Markdown 文件，根据对话内容自动匹配并注入相关 Skill 指导。

### 延迟工具加载：SearchExtraTools 与 ExecuteExtraTools

Claude Code 的工具系统采用延迟加载策略。核心工具（Read、Edit、Write、Bash、Glob、Grep 等 38 个）始终可用，其余工具（包括所有 MCP 工具）需要按需发现和加载。

当你让 Claude Code 执行一个需要非核心工具的操作时，它会自动完成两步：

1. **SearchExtraTools** -- 搜索并发现需要的工具
2. **ExecuteExtraTool** -- 加载并执行发现的工具

这个过程对用户完全透明。比如你说"帮我创建一个定时任务，每 5 分钟检查部署状态"，Claude Code 会自动搜索 `CronCreate` 工具，然后执行它。你不需要手动触发任何操作。

## 下一步

- 想让 Claude Code 自动执行多步任务，看 [第六章：子代理、Plan 模式、Task 系统](./06-agents-plans-tasks.md)
- 想省钱和优化性能，看 [第九章：穷鬼模式、缓存、Hooks、配置文件](./09-budget-caches-hooks.md)
- 遇到 MCP server 连接问题，看 [第十章：可观测性与排错](./10-observability-troubleshooting.md)
