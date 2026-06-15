# 第七章：让 Claude 长时间帮你干活 -- Daemon、Background Sessions、Schedule

> 任务跑太久、需要定时执行、想让 Claude 在后台默默干活 -- 这章讲三种长时间运行的方式。

## Daemon 是什么？跟普通对话的区别

你在终端里敲 `claude` 启动的是一个交互式 REPL 会话：你打字、Claude 回复、你继续问。关掉终端，会话就没了。Daemon 是一种不同的运行模式 -- 它在后台启动一个常驻进程（supervisor），由 supervisor 管理若干 worker 子进程，每个 worker 负责一种长时间任务。

目前 daemon 内置的 worker 类型是 `remoteControl`，它运行一个 headless bridge 循环，用于接受远程会话连接。supervisor 会监控 worker 的存活状态：如果 worker 崩溃了，supervisor 会自动重启它，使用指数退避策略（从 2 秒开始，每次翻倍，上限 120 秒）。如果 worker 在 10 秒内连续崩溃 5 次，supervisor 会把 worker "停泊"（park），不再尝试重启，避免无限重启循环。

Daemon 需要启用 `DAEMON` feature flag。启动 daemon 后，它会在 `~/.claude/daemon/` 下写一个状态文件（`remote-control.json`），记录 PID、工作目录、启动时间和 worker 类型，方便其他 CLI 进程查询状态或发送停止信号。

## 启停 Daemon

在终端中用 `claude daemon` 命令管理 daemon 的生命周期：

```bash
# 启动 daemon supervisor（默认启动 remoteControl worker）
claude daemon start

# 查看 daemon 和后台会话的统一状态
claude daemon status
# 或者
claude daemon ps

# 停止 daemon（发送 SIGTERM，超时后 SIGKILL）
claude daemon stop
```

启动时可以指定工作目录、worker 模式、并发容量等参数：

```bash
claude daemon start --dir /path/to/project --spawn-mode worktree --capacity 4 --permission-mode auto-accept --sandbox
```

也可以在 REPL 里用 `/daemon` 斜杠命令执行同样的操作：

```
/daemon status
/daemon start
/daemon stop
/daemon bg -p "run the test suite"
```

注意，`/daemon attach` 不能在 REPL 内使用 -- attach 是一个阻塞交互操作，需要在外部终端执行。

## Background Sessions：让 Claude 在后台跑

Daemon 管的是 supervisor + worker 的架构，如果你只是想让 Claude 在后台跑一个任务、不想折腾 supervisor，background sessions 是更轻量的选择。

### 启动后台会话

```bash
# 最简方式：用 -p 参数传入提示词
claude daemon bg -p "run the full test suite and report results"

# 也可以用 --bg 快捷标志
claude --bg -p "check for lint errors and fix them"

# 带命名参数
claude daemon bg --name nightly-audit -p "audit all TODO comments in src/"
```

后台会话支持两种引擎：

- **tmux 引擎**（macOS/Linux，需要安装 tmux）：启动一个 tmux session 来运行 Claude，你可以随时 attach 进去看到交互界面。
- **detached 引擎**（Windows 或没有 tmux 的环境）：进程脱离终端运行，日志写到文件，attach 时查看日志。

引擎选择是自动的：在 macOS/Linux 上优先用 tmux，如果 tmux 不可用则回退到 detached；Windows 上直接用 detached。如果使用 detached 引擎，必须带 `-p` 或 `--pipe` 参数，因为 detached 模式没有交互式终端。

```bash
# 安装 tmux（macOS）
brew install tmux

# 安装 tmux（Linux）
sudo apt install tmux
```

启动成功后会输出会话信息：

```
Background session started: claude-bg-a1b2c3d4
  Engine: tmux
  Log: ~/.claude/sessions/logs/claude-bg-a1b2c3d4.log

Use `claude daemon attach claude-bg-a1b2c3d4` to reconnect.
Use `claude daemon status` to check status.
Use `claude daemon kill claude-bg-a1b2c3d4` to stop.
```

### 管理后台会话

```bash
# 列出所有活跃会话
claude daemon status

# 输出示例：
# 2 active sessions:
#
#   PID: 12345
#   Kind: bg
#   Engine: tmux
#   Session: claude-bg-a1b2c3d4
#   CWD: /home/user/myproject
#   Name: nightly-audit
#   Started: 6/14/2026, 9:00:00 AM
#
#   PID: 12346
#   Kind: daemon-worker
#   Engine: tmux
#   Session: claude-bg-e5f6g7h8
#   CWD: /home/user/myproject
#   Started: 6/14/2026, 9:00:05 AM

# 重新连接到会话（tmux 引擎直接进入交互界面）
claude daemon attach claude-bg-a1b2c3d4

# 查看会话日志
claude daemon logs claude-bg-a1b2c3d4

# 终止会话（SIGTERM -> 2秒等待 -> SIGKILL）
claude daemon kill claude-bg-a1b2c3d4
```

如果没有指定目标名称，`attach` 和 `kill` 会列出可用的会话让你选择。会话的元数据（PID、session ID、名称、启动时间等）保存在 `~/.claude/sessions/` 目录下的 JSON 文件中，进程退出后对应的 JSON 文件会被自动清理。

## Template Jobs：模板化任务

如果你经常重复执行某种结构的任务 -- 比如每天写日报、每周做代码审查 -- 可以用模板把任务的结构固定下来，之后只需 `claude job new <template>` 就能快速创建。

模板是放在 `.claude/templates/` 或 `~/.claude/templates/` 目录下的 Markdown 文件，支持 frontmatter：

```markdown
---
description: Generate a daily standup summary from git log
author: team-lead
---

Read the git log from the last 24 hours and write a concise standup summary.
Include: commits made, PRs opened/closed, blockers encountered.
Format the output as a bullet list.
```

```bash
# 列出所有可用模板
claude job list

# 用模板创建一个新任务
claude job new daily-standup

# 带参数
claude job new daily-standup --since yesterday

# 查看任务状态
claude job status abc12345

# 向已有任务追加回复
claude job reply abc12345 please also include deployment notes
```

模板查找顺序：先在项目的 `.claude/templates/` 目录下找，再在用户级的 `~/.claude/templates/` 目录下找，同名模板项目级优先。每个任务创建后会在 `~/.claude/jobs/<job-id>/` 下生成 `state.json`、`template.md` 和 `input.txt`，记录任务的状态和上下文。

## 定时调度：用 `/loop` 让 Claude 反复跑

`/loop` 是一种本地定时机制 -- 让 Claude 按固定间隔反复执行同一个提示词或斜杠命令，适合持续监控、定时巡检等场景。

```bash
# 每 5 分钟跑一次 /babysit-prs
/loop 5m /babysit-prs

# 每 30 分钟检查一次部署状态（默认 10 分钟间隔）
/loop 30m check the deploy status

# 每 2 小时做一次 standup
/loop 2h /standup 1

# 每天一次（午夜本地时间）
/loop 1d run the nightly full test suite

# 也可以用自然语言描述间隔
/loop check the deploy every 20m
```

`/loop` 底层通过 `CronCreate` 工具创建 cron 调度，所以它遵循 cron 系统的运行规则：任务只在 REPL 空闲时触发（不会打断正在进行的查询），调度器会在你指定的时间上自动加一个小的随机偏移来错峰。循环任务最长运行 7 天后自动过期。

管理循环任务：

```bash
# 查看当前所有定时任务
/cron-list

# 取消某个任务
/cron-delete <job-id>
```

如果 `/loop` 无法使用（cron 系统被 `CLAUDE_CODE_DISABLE_CRON=1` 环境变量禁用），可以改用系统级的 cron + pipe 模式作为替代：

```bash
# 在 crontab 里配置
*/30 * * * * cd /path/to/project && echo "check the deploy status" | claude -p
```

## 远程定时触发器：`/schedule` 与 `/triggers`

`/loop` 和本地 cron 任务有一个限制：它们只在你的本地机器上运行，关了终端就停了。如果你需要任务在云端定时执行 -- 不依赖你的电脑是否开机 -- 可以使用远程触发器。

```
/schedule
```

这个命令（也叫 `/triggers` 或 `/cron`）会引导你创建一个远程调度触发器。远程触发器的特点：

- 任务在 Anthropic 的云端基础设施中运行，不在你的本地机器上
- 每个 trigger 在指定时间创建一个完全隔离的远程会话（CCR）
- 最小调度间隔为 1 小时（本地 cron 没有这个限制）
- 需要 Claude Pro/Max/Team 订阅和 `/login` 登录

创建一个远程触发器的交互流程大致如下：

```
你: /schedule

Claude: What would you like to do with scheduled remote agents?
  1. Create a new trigger
  2. List existing triggers
  3. Update a trigger
  4. Run a trigger now

你: 我想创建一个每周一早上 9 点检查主分支 CI 状态的触发器

Claude: 好的，让我帮你设置。9am 你的本地时间（Asia/Shanghai）= 1am UTC。
触发器的 cron 表达式将是 `0 1 * * 1`。
我会使用默认模型 claude-sonnet-4-6。你确认吗？...
```

远程触发器也可以通过命令参数直接操作：

```
/schedule list
/schedule get <trigger-id>
/schedule update <trigger-id> enabled false
/schedule run <trigger-id>
/schedule delete <trigger-id>
/schedule enable <trigger-id>
/schedule disable <trigger-id>
```

创建触发器时可以关联 MCP connector（比如 Datadog、Slack），让远程 agent 能访问外部服务。connector 在 https://claude.ai/settings/connectors 管理。删除触发器需要到网页端操作：https://claude.ai/code/scheduled

## 该用哪种方式？

三种长时间运行的方式各有适用场景：

| 方式 | 适用场景 | 是否需要本地机器在线 | 最小间隔 |
|------|---------|---------------------|---------|
| Background Session | 一次性后台任务，跑完就结束 | 是 | 无（一次性） |
| `/loop` + 本地 cron | 周期性本地监控、巡检、自动修复 | 是（终端不能关） | 1 分钟 |
| `/schedule` 远程触发器 | 云端定时任务，不依赖本地机器 | 否 | 1 小时 |

简单判断标准：

- 如果是"跑完一个任务就行"，用 background session。
- 如果是"每隔几分钟帮我检查一下"，用 `/loop`。
- 如果是"我不在线的时候也要跑"，用 `/schedule` 远程触发器。

如果你需要 tmux 引擎但机器上没有安装 tmux，系统会自动回退到 detached 引擎。detached 引擎没有交互界面，所有输出只能通过日志文件查看，所以一定要带 `-p` 参数明确告诉 Claude 该做什么。

## 下一步

- 想了解如何把 Claude 嵌入 CI 流水线做自动化，看 [第十一章：自动化与 CI 集成](./11-ci-automation.md)
- 想让 Claude 在远程机器上被外部客户端调用，看 [第八章：跨机器与跨团队协作](./08-bridge-remote-acp.md)
- 想了解如何让 Claude 跑大任务、派子代理，看 [第六章：让 Claude 帮你跑大任务](./06-agents-plan-task.md)
