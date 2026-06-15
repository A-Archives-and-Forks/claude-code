# 第十一章：自动化与 CI 集成 —— 把 Claude 嵌入流水线

> 不想每次都手动对话？让 Claude 在脚本、CI 和容器里自动干活。

## Pipe 模式：一句话调用，拿结果就走

Pipe 模式（也叫 headless / print 模式）是 Claude Code 最直接的自动化入口。不需要 TTY，不需要交互，传入提示词，拿回结果，进程退出。它在 `src/main.tsx` 里注册为 `-p, --print` 选项，描述原文是 "Print response and exit (useful for pipes)"。

最基本的用法：

```bash
# 把结果直接输出到终端
claude -p "解释当前目录的 package.json 依赖关系"

# 管道传入提示词
echo "列出 src/ 下所有 .ts 文件" | claude -p

# 把结果存到文件
claude -p "给 src/utils/hash.ts 写单元测试" > hash.test.ts
```

Pipe 模式有几个值得注意的行为。第一，**信任对话框被跳过**——命令行帮助文本明确写了 "The workspace trust dialog is skipped when Claude is run with the -p mode. Only use this flag in directories you trust." 意味着 Claude 会直接在当前目录操作文件，不会先问你是否信任它。所以只在可信目录用 `-p`。

第二，支持结构化输出。配合 `--output-format json` 可以拿到 JSON 格式的结果，方便脚本解析：

```bash
claude -p "列出 3 个最常见的 TypeScript 性能问题" --output-format json
```

第三，支持流式 JSON 输出（`--output-format stream-json`），适合需要实时处理中间结果的场景。

第四，可以限制工具白名单。在 CI 环境中，你可能不想让 Claude 随意执行任意命令。通过 `--allowed-tools` 参数可以精确控制：

```bash
claude -p "检查 package.json 里有没有废弃依赖" \
  --allowed-tools Bash(npm audit:*) Bash(cat:*) Read
```

`--allowed-tools` 的值支持 glob 风格匹配，比如 `Bash(git:*)` 匹配所有 git 命令，`Bash(npm install:*)` 只允许 npm install 相关命令。

## Headless 模式的环境差异

Pipe 模式的底层走的是 headless 路径。在 `src/main.tsx` 中，headless 模式会在启动时创建一个轻量级的 `headlessStore`（Zustand store），跳过 Ink UI 渲染、MCP 交互式认证等需要 TTY 的步骤。

在无 TTY 的环境（CI runner、Docker 容器、cron 任务）下，Claude Code 会自动检测并进入 headless 行为。但有一个常见坑：**嵌套 bun 启动时 TTY 检测可能出错**。比如你的脚本用 bun 调用另一个 bun 进程时，子进程可能误判自己有 TTY。

解决方案是设置环境变量 `CLAUDE_CODE_FORCE_INTERACTIVE`：

```bash
# 在 CI 脚本中，如果 Claude 意外进入了交互模式（卡住等待输入），
# 反过来设置这个变量让 stdin/stdout/stderr 的 isTTY 被强制标记为 true
CLAUDE_CODE_FORCE_INTERACTIVE=1 claude -p "你的提示词"
```

这个环境变量的处理逻辑在 `src/entrypoints/cli.tsx` 的顶层，在 main() 函数之前就生效。它会把 `process.stdin`、`process.stdout`、`process.stderr` 的 `isTTY` 属性强行覆写为 `true`。代码注释说这是 "Best-effort dev-only override for nested bun launch on Windows"，但实际上在任何嵌套场景都可能用到。

`--bare` 模式是更激进的 headless 变体。它设置 `CLAUDE_CODE_SIMPLE=1`，跳过 hooks、LSP、plugin sync、attribution、auto-memory、background prefetches、keychain reads 和 CLAUDE.md 自动发现。适合只需要最原始能力的 CI 场景：

```bash
claude --bare -p "解释这个函数的作用" --system-prompt "你是一个代码审查助手"
```

注意 `--bare` 模式下 OAuth 和 keychain 认证不会被读取，只能通过 `ANTHROPIC_API_KEY` 环境变量或 `--settings` 参数提供凭证。

## 容器环境与 `CLAUDE_CODE_REMOTE`

在 Docker 容器或远程 CI 环境里跑 Claude Code 时，内存管理是个实际问题。Bun/JSC 的内存行为和 Node.js/V8 不同（详见设计篇），在大代码库上可能消耗较多内存。

`src/entrypoints/cli.tsx` 顶层有一段专门处理容器环境的逻辑：

```typescript
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  const existing = process.env.NODE_OPTIONS || '';
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192';
}
```

设置 `CLAUDE_CODE_REMOTE=true` 后，会自动给 `NODE_OPTIONS` 追加 `--max-old-space-size=8192`（8GB 上限）。这对 Node.js 运行时的构建产物生效——V8 引擎会尊重这个限制。容器通常有 16GB 内存配额，8GB 上限留足余量。

在 Docker Compose 或 CI 配置中这样用：

```yaml
# docker-compose.yml
services:
  claude-worker:
    image: your-claude-image
    environment:
      - CLAUDE_CODE_REMOTE=true
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    working_dir: /app
    command: ["node", "dist/cli.js", "-p", "运行测试并报告结果"]
```

```yaml
# GitHub Actions workflow
env:
  CLAUDE_CODE_REMOTE: true
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## GitHub Actions 集成：`install-github-app`

Claude Code 内置了一套完整的 GitHub Actions 自动配置流程，通过 `/install-github-app` 命令触发。这个命令是 `local-jsx` 类型（交互式 React 组件），会引导你一步步完成配置。

整个流程大致如下：

1. 检查 GitHub CLI (`gh`) 是否安装
2. 选择目标仓库（默认检测当前 git 仓库）
3. 选择 API Key 认证方式（已有 key / 新建 key / OAuth）
4. 选择要安装的 workflow（PR 助手 `claude.yml` / 代码审查 `claude-code-review.yml`，可多选）
5. 自动创建分支、写入 workflow 文件、设置 secret、打开浏览器创建 PR

安装完成后，你的仓库里会多两个 workflow 文件。

**PR 助手 workflow** (`.github/workflows/claude.yml`)：监听 PR/Issue 评论中包含 `@claude` 的事件，自动触发 Claude 执行任务：

```yaml
name: Claude Code

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]

jobs:
  claude:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      ...
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

配置成功后，在 PR 评论中 `@claude 修复这个测试失败`，Claude 就会在 GitHub Actions runner 里自动分析、修改代码、提交。

**代码审查 workflow** (`.github/workflows/claude-code-review.yml`)：在 PR 创建或更新时自动触发代码审查，使用 `code-review` 插件生成结构化的审查报告。

前置条件：
- 安装 GitHub CLI：`brew install gh`（macOS）或参考 [cli.github.com](https://cli.github.com/)
- `gh` 已登录并有目标仓库的 admin 权限
- 准备好 Anthropic API Key（OAuth token 也支持）

如果不想用交互式命令，`setupGitHubActions.ts` 里暴露了完整的 API 级流程。`install-github-app` 命令本质上就是对这个 API 的 UI 包装。

## `/commit-push-pr`：一键提交、推送、开 PR

`/commit-push-pr` 是一个 prompt 类型命令（不是交互式命令），适合在 CI 或自动化流程中调用。它会分析当前分支相对于默认分支的所有变更（不是只看最新 commit），自动生成 commit message、推送到远程、创建 PR。

它内置了一个允许工具白名单，严格限制只能执行 git 和 gh 命令：

```typescript
const ALLOWED_TOOLS = [
  'Bash(git checkout --branch:*)',
  'Bash(git checkout -b:*)',
  'Bash(git add:*)',
  'Bash(git status:*)',
  'Bash(git push:*)',
  'Bash(git commit:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr merge:*)',
  'SearchExtraTools',
  'mcp__slack__send_message',
  'mcp__claude_ai_Slack__slack_send_message',
]
```

在交互式 REPL 中直接输入：

```
/commit-push-pr
```

或者带上额外指令：

```
/commit-push-pr 重点说明新增了缓存层来优化查询性能
```

Claude 会自动查看 `git status`、`git diff`、`git branch --show-current`，分析所有相关提交，生成 commit message，推送到远程，并通过 `gh pr create` 创建 PR。如果 CLAUDE.md 里配置了 Slack 通知，还会尝试搜索 Slack 工具并发送 PR 链接。

Git 安全协议被硬编码在 prompt 里：不更新 git config、不跑破坏性命令（`push --force`、`hard reset`）、不跳 hooks、不提交含密钥的文件。

## `/subscribe-pr`：订阅 PR 事件

`/subscribe-pr` 命令让你关注某个 PR 的动态——新评论、CI 状态变化、review 等。它把订阅信息存在本地的 `~/.claude/pr-subscriptions.json` 文件里。

使用方式：

```
# 通过完整 URL 订阅
/subscribe-pr https://github.com/owner/repo/pull/123

# 通过短引用
/subscribe-pr owner/repo#123

# 如果在 git 仓库内，直接用 PR 编号
/subscribe-pr 123

# 查看当前订阅列表
/subscribe-pr --list

# 取消订阅
/subscribe-pr --remove 123
```

订阅数据结构很简单——每条记录包含仓库、PR 编号和订阅时间。这个功能在 Bridge 模式下特别有用，Bridge 层的 `useReplBridge` 和 `webhookSanitizer` 会根据订阅过滤入站事件，只推送你关心的 PR 通知。

## Pipe 多会话与 `/pipe-status`

Claude Code 支持主从 pipe 架构——一个主会话可以连接多个子会话，通过 pipe IPC 机制传递消息和任务。`/pipe-status` 命令查看当前连接状态。

有三种角色：

- **Main 模式**：未连接任何子会话的默认状态
- **Slave（被控）模式**：被主会话控制，所有数据上报给 master
- **Master（主控）模式**：已连接子会话，可以向子会话派发任务

在 master 模式下，`/pipe-status` 会显示每个子会话的状态、连接时间、历史记录数，并列出可用操作：

```
/pipe-status
# Master mode — 2 sub session(s) connected:
#
#   worker-1
#     Status:    idle (connected)
#     Connected: 14:32:05
#     History:   12 entries
#
#   worker-2
#     Status:    busy (connected)
#     Connected: 14:33:12
#     History:   8 entries
#
# Commands:
#   /send <name> <msg>  — Send a task to a sub session
#   /history <name>     — View sub session transcript
#   /detach [name]      — Disconnect from a sub session (or all)
```

## BYOC Runner：`environment-runner` 与 `self-hosted-runner`

BYOC（Bring Your Own Compute）Runner 是两种 headless 长驻运行模式，设计目标是在你自己的基础设施上运行 Claude Code 任务。它们都在 `src/entrypoints/cli.tsx` 中注册为独立的 fast-path，避免加载完整 CLI。

**`claude environment-runner`**：

```bash
claude environment-runner <args...>
```

这是一个 BYOC（自带计算环境）的 headless runner。入口在 `src/environment-runner/main.ts`，受 `BYOC_ENVIRONMENT_RUNNER` feature flag 控制。

**`claude self-hosted-runner`**：

```bash
claude self-hosted-runner <args...>
```

这是一个自托管 runner，对接 SelfHostedRunnerWorkerService API（register + poll，poll 同时充当 heartbeat）。入口在 `src/self-hosted-runner/main.ts`，受 `SELF_HOSTED_RUNNER` feature flag 控制。

注意：这两个 runner 的当前实现是 stub（占位），`main.ts` 里只有 `Promise.resolve()`。它们是 feature-gated 的，需要在构建时启用对应 feature 才能使用。实际的 BYOC 能力目前更多通过 Bridge 模式（`BRIDGE_MODE`）和 ACP 协议（`ACP`）实现。

如果你想在自己的服务器上长驻运行 Claude 任务，当前可用的替代方案是：
- Bridge 模式：`claude remote-control` 启动后，外部客户端通过 WebSocket 连接
- ACP 协议：`claude --acp` 把 Claude 暴露为 ACP agent
- 自托管 RCS：`bun run rcs` 启动 Remote Control Server，包含 Web UI

## 定时任务：cron + pipe 实现巡检

自动化不只是"跑一次"，很多时候你需要定期巡检。有两种方式：

**方式一：cron 调用 pipe 模式**

最简单的方式是用系统 crontab 定时调用 `claude -p`：

```bash
# 每 30 分钟检查一次主分支是否有新的 CI 失败
*/30 * * * * cd /path/to/repo && claude --bare -p "检查 CI 是否有失败，如果有则列出失败原因" >> /var/log/claude-ci-check.log 2>&1

# 每天早上 9 点生成一份代码变更摘要
0 9 * * * cd /path/to/repo && claude --bare -p "总结过去 24 小时 main 分支的所有变更" | mail -s "日报" team@example.com
```

**方式二：`/schedule` 远程 cron 触发器**

`/schedule` 命令创建远程 cron 触发器，由服务端按计划触发（需要认证）。这种方式不依赖本机在线：

```
# 创建一个每小时触发一次的巡检任务
/schedule create "检查依赖安全漏洞" --cron "0 * * * *" --prompt "运行 npm audit 并报告高危漏洞"
```

更详细的内容见第七章（Daemon、Background Sessions、Schedule）。

## 退出码与脚本判断

在脚本里调用 Claude 时，判断成功失败很重要。Pipe 模式下，Claude Code 的退出码取决于执行结果：

- `0`：正常完成
- 非 `0`：出错或被拒绝

结合 shell 的 `&&` / `||` 可以实现条件执行：

```bash
# 只有 Claude 确认代码正确才执行部署
claude -p "审查这个 PR 的代码质量，如果有问题就说 FAIL" && ./deploy.sh

# Claude 分析失败时发送告警
claude -p "分析错误日志 /var/log/app.log" || echo "分析失败，需要人工介入" | mail -s "告警" ops@example.com
```

`src/entrypoints/cli.tsx` 中，各个 fast-path 在出错时通过 `process.exitCode = 1` 或 `process.exit(1)` 设置退出码。主流程的退出码由 `src/main.tsx` 中的 action handler 决定。

一个实用的 CI 脚本模板：

```bash
#!/bin/bash
set -euo pipefail

# 环境准备
export ANTHROPIC_API_KEY="${API_KEY}"
export CLAUDE_CODE_REMOTE=true  # 容器环境内存优化

# 运行 Claude 分析
if claude --bare -p "检查 src/ 下是否有明显的 bug 或安全问题" --allowed-tools "Read Grep Glob"; then
  echo "检查通过"
  exit 0
else
  echo "发现问题，检查输出"
  exit 1
fi
```

## `CLAUDE_CODE_ABLATION_BASELINE`：消融实验基线

`CLAUDE_CODE_ABLATION_BASELINE` 是一个用于 harness-science L0 消融实验的环境变量。当同时满足 `feature('ABLATION_BASELINE')` 和设置了该环境变量时，`cli.tsx` 顶层会批量设置一组简化开关：

```
CLAUDE_CODE_SIMPLE=1               # 简化模式
CLAUDE_CODE_DISABLE_THINKING=1      # 禁用 thinking
DISABLE_INTERLEAVED_THINKING=1      # 禁用交错 thinking
DISABLE_COMPACT=1                    # 禁用 compact
DISABLE_AUTO_COMPACT=1              # 禁用自动 compact
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1   # 禁用自动记忆
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1  # 禁用后台任务
```

这个逻辑被特意放在 `cli.tsx` 的顶层（不在 `init.ts` 里），因为 `BashTool`、`AgentTool`、`PowerShellTool` 在 import 时就把 `DISABLE_BACKGROUND_TASKS` 等环境变量捕获进模块级常量——如果放在 `init()` 里就太晚了。

普通用户不需要关心这个环境变量。它是给做模型能力消融实验的研究者用的。

## 下一步

- 想在 PR 评论中自动触发 Claude，回到本章"GitHub Actions 集成"部分，参考 `setupGitHubActions` 的自动配置流程
- 想了解 `@claude` 在 GitHub 中的完整配置，看 [claude-code-action 仓库](https://github.com/anthropics/claude-code-action) 的使用文档
- 想让 Claude 定时自动执行任务（不依赖本机 crontab），看 [第七章：Daemon、Background Sessions、Schedule](./07-daemon-bg-schedule.md)
- 想把 Claude 暴露给外部客户端调用，看 [第八章：Bridge、Remote Control、ACP](./08-bridge-rcs-acp.md)
- 想限制 Claude 在 CI 中的权限，看 [第九章：权限规则配置指南](./09-savings-hooks-config.md) 中的 `allow` / `deny` 规则部分
