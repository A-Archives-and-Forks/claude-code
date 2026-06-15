# 第四章：slash 命令速查 —— 不用记全部，按场景找

> 你想做什么？翻到这里，按场景找到对应命令。

在 Claude Code 的交互式 REPL 中，输入 `/` 开头的文本即可触发 slash 命令。命令很多，但不需要死记硬背——按你想做的事情找就行。如果实在不确定要哪个，直接输入 `/help` 会打开一个分类浏览面板，里面有所有可用命令。

## 会话与上下文管理

当你的对话变长、上下文快满了，或者想换个话题重新开始，这些命令帮你管好会话状态。

**`/clear`**（别名 `/reset`、`/new`）清空当前对话历史，从头开始。就像关闭再重新打开一个聊天窗口，之前的消息不会丢失到磁盘上的会话记录里，但不再参与本次对话的上下文。

```
你: /clear
```

**`/compact`** 比 `/clear` 更温和——它会用 AI 总结当前对话，然后清除原始消息，只保留总结。这样你可以在不丢失要点的前提下释放上下文空间。你还可以给它自定义总结指令：

```
你: /compact 用中文总结，保留所有文件路径和关键决策
```

如果 `DISABLE_COMPACT` 环境变量被设置，`/compact` 会被禁用。

**`/force-snip`** 在当前位置插入一个"剪裁边界"。下次查询时，边界之前的消息会被从模型视角移除（REPL 的滚动历史里仍然可见）。这是在 `/compact` 不够用时的手动干预手段。

**`/resume`**（别名 `/continue`）恢复之前的对话。可以传会话 ID 或搜索关键词：

```
你: /resume abc123
你: /continue 修复认证bug
```

**`/history`**（别名 `/hist`）查看会话历史列表。

**`/context`** 可视化当前上下文使用情况——显示一个彩色网格，直观展示上下文窗口里各部分占用了多少空间。非交互模式下会以文本形式展示。

**`/rewind`**（别名 `/checkpoint`）将代码和/或对话恢复到之前的某个节点。

## 模型与 Provider 切换

想换一家 API、换一个模型、或者调整思考强度，用这几个命令。

**`/provider`**（别名 `/api`）切换 API 提供商。支持 7 个 provider：`anthropic`、`openai`、`gemini`、`grok`、`bedrock`、`vertex`、`foundry`。不带参数时显示当前 provider，`unset` 清除设置回退到环境变量：

```
你: /provider gemini
你: /provider unset
你: /provider
> Current API provider: anthropic
```

注意：`bedrock`、`vertex`、`foundry` 通过环境变量控制（`CLAUDE_CODE_USE_BEDROCK=1` 等），不会写入 settings.json。切换到 `openai`、`gemini`、`grok` 时会检查对应的 API key 是否已配置，如果缺失会给出警告。

**`/model`** 切换模型。不带参数时显示当前模型及描述，带参数时设置新模型。模型名通常形如 `claude-sonnet-4`、`claude-opus-4` 等：

```
你: /model claude-opus-4
你: /model
```

**`/effort`** 设置思考强度，影响模型在推理上的投入程度。支持 `low`、`medium`、`high`、`xhigh`、`max`、`auto` 几档：

```
你: /effort high
```

**`/login`** 通过引导式流程登录 Anthropic 账号。如果已登录则显示为"切换账号"。设置 `DISABLE_LOGIN_COMMAND=1` 可禁用此命令。

**`/logout`** 退出当前账号登录状态。设置 `DISABLE_LOGOUT_COMMAND=1` 可禁用此命令。

## 费用、用量与限流

想知道花了多少钱、用了多少 token、遇到限流怎么办，看这里。

**`/usage`**（别名 `/cost`、`/stats`）显示会话费用、套餐用量和活动统计。三个名字指向同一个命令，用哪个都行：

```
你: /usage
你: /cost
你: /stats
```

**`/rate-limit-options`** 当你撞到 API 限流时，这个命令会弹出一个菜单，提供几个选项：申请额外用量（extra usage）、升级套餐（upgrade plan）、或等待限流重置。具体可用的选项取决于你的订阅类型——Team/Enterprise 用户看到的是"申请更多"，Max 20x 用户看不到升级选项。

**`/reset-limits`** 重置限流状态。注意：当前版本此命令是一个 stub（占位），功能尚未实现。

如果你使用的是 OpenAI 兼容层，限流追踪是通过响应头 `x-ratelimit-*-requests`/`x-ratelimit-*-tokens` 和 `Reset-After` 自动完成的，不需要手动干预。

**`/perf-issue`** 生成一份性能快照报告，包含内存占用、CPU 使用、token 消耗、工具调用次数、缓存命中率、费用估算等信息。默认以 Markdown 格式写入 `~/.claude/perf-reports/` 目录：

```
你: /perf-issue
> Perf snapshot written to:
>   `~/.claude/perf-reports/perf-2026-06-14T10-30-00-abc12345.md`

你: /perf-issue --format=json --limit=5000
```

## 配置与个性化

让 Claude Code 按你的习惯工作——主题、语言、快捷键、配置面板。

**`/config`**（别名 `/settings`）打开配置面板，可以集中管理各种设置项。

**`/theme`** 切换终端界面主题。会弹出可选主题列表供你选择。

**`/lang`** 设置显示语言，支持 `en`、`zh`、`auto`（自动检测）：

```
你: /lang zh
你: /lang auto
```

**`/keybindings`** 打开或创建你的快捷键配置文件 `~/.claude/keybindings.json`。需要 `isKeybindingCustomizationEnabled()` 返回 true 才可用。

**`/env`** 显示当前环境信息快照，包括运行时信息（平台、CWD、PID、Bun/Node 版本、session ID）和关键环境变量。敏感值（匹配 token/password/auth/api_key 等关键词的）会被自动遮掩。只显示 `CLAUDE_*`、`FEATURE_*`、`ANTHROPIC_*`、`BUN_*`、`NODE_*`、`GEMINI_*`、`OPENAI_*`、`GROK_*` 等前缀的环境变量：

```
你: /env
> ## Runtime
>   platform:        darwin arm64
>   cwd:             /Users/you/project
>   pid:             12345
>   bun:             1.2.0
> ## Environment Variables (allowlisted prefixes)
>   ANTHROPIC_API_KEY=sk-a…d2 (38 chars)
>   ...
```

**`/output-style`** 修改输出风格。已标记为 deprecated（不推荐使用），建议改用 `/config` 来调整。

**`/mode`** 切换交互模式，支持多种预设：`default`、`gentle`、`sharp`、`workhorse`、`token-saver`、`super-ai`：

```
你: /mode token-saver
```

## 项目与文件操作

让 Claude 关注特定的目录、查看文件列表和变更差异。

**`/add-dir`** 将一个新目录添加到 Claude Code 的工作范围内：

```
你: /add-dir /path/to/another/project
```

**`/diff`** 查看未提交的代码变更和每轮对话中的 diff。会以交互式界面展示。

**`/files`** 列出当前上下文中包含的所有文件。注意：此命令仅对 Anthropic 内部用户可用（`USER_TYPE=ant`）。

**`/context`** 和 **`/ctx_viz`** 都用于可视化上下文使用。`/context` 是主要命令，在交互模式下显示彩色网格，非交互模式下显示文本摘要。`/ctx_viz` 当前是 stub（禁用状态）。

## 插件、Skill 与扩展

当内置功能不够用，想装插件、浏览技能市场或管理 Skill。

**`/plugin`**（别名 `/plugins`、`/marketplace`）管理 Claude Code 插件——浏览、安装、启用、禁用、卸载。可以进入插件市场（Marketplace）浏览社区贡献的插件。

```
你: /plugin
你: /plugins
你: /marketplace
```

**`/skills`** 列出当前可用的所有 Skill。Skill 是一种可复用的工作流单元。

**`/skill-store`**（别名 `/ss`、`/cloud-skills`）浏览和安装远程技能市场中的 Skill。需要 Claude Pro/Max/Team 订阅。支持 list、get、versions、install 等子命令：

```
你: /skill-store list
你: /skill-store get my-skill-id
你: /skill-store install my-skill-id@1.0
```

**`/reload-plugins`** 激活待定的插件变更到当前会话。当你安装或更新了插件后，需要执行此命令让改动生效（SDK 调用方通常通过 `query.reloadPlugins()` 来触发）。

**`/hooks`** 查看和管理工具事件的钩子配置。在 `settings.json` 中配置的 hooks 会在特定工具事件发生时自动执行脚本。

## 工作流自动化

把日常重复操作固化为可重放的工作流。

**`/commit`** 让 Claude 帮你生成 git commit。它只被允许执行 `git add`、`git status`、`git commit` 三个命令，会分析你的变更后生成合适的 commit message 并提交。

```
你: /commit
```

**`/commit-push-pr`** 一条龙完成 commit、push 和创建 PR。Claude 会自动创建分支、提交代码、推送并在 GitHub 上创建 Pull Request。

**`/review`** 让 Claude 审查一个 Pull Request。不带参数时会列出所有开放的 PR，带 PR 编号时直接审查指定 PR：

```
你: /review
你: /review 42
```

还有 `/ultrareview` 命令，它会在 Claude Code on the web 上运行一个更深入的 bug 搜索和验证流程，大约需要 10-20 分钟。

**`/plan`** 进入 Plan 模式或查看当前计划。先想清楚再动手：

```
你: /plan 重构认证模块，将 JWT 逻辑抽到独立 service
你: /plan open
```

**`/triggers`**（别名 `/cron`）管理云端定时触发的远程代理任务（cloud cron）。需要 Claude Pro/Max/Team 订阅。支持创建、查看、更新、删除、运行、启用、禁用等操作：

```
你: /triggers list
你: /triggers create "*/30 * * * *" "检查 deploy 状态"
你: /triggers run trigger-123
```

注意：命令名叫 `/triggers`（对应底层 API endpoint `/v1/code/triggers`），别名 `/cron`。

**`/goal`** 设置一个持续性目标，Claude 会跨轮次自动推进。支持 status、clear、pause、resume、complete 等子命令：

```
你: /goal 完成 login 模块的单元测试覆盖
你: /goal status
你: /goal complete
```

**`/workflows`** 打开工作流监控面板，实时显示运行中的 workflow 的 run/phase/agent 进度。

## 权限与安全

管理工具权限、沙箱模式，控制 Claude 能做什么。

**`/permissions`**（别名 `/allowed-tools`）管理工具的 allow/deny 权限规则。可以精细控制哪些工具被允许自动执行，哪些需要每次确认。

**`/sandbox`** 切换沙箱模式。沙箱模式下，shell 命令会被限制在一个隔离环境中执行，防止意外修改系统文件。支持配置排除模式——某些命令可以不经沙箱直接执行：

```
你: /sandbox
> (sandbox enabled, 可配置 exclude 规则)
```

注意：此命令仅在支持的平台上显示，且需要平台在启用列表中。

**`/poor`** 切换穷鬼模式——关闭 `extract_memories` 和 `prompt_suggestion` 两个功能来节省 token 消耗。设置会持久化到 `settings.json`：

```
你: /poor
> Poor mode enabled — extract_memories and prompt_suggestion disabled.
```

## 记忆与会话输出

管理 Claude 的记忆文件、导出和分享会话。

**`/memory`** 编辑 Claude 的记忆文件（CLAUDE.md 等）。会打开一个编辑界面让你查看和修改 Claude 对你项目的长期记忆。

**`/summary`** 手动触发一次会话摘要生成。通常会自动在满足条件时提取，但你可以随时用这个命令主动生成：

```
你: /summary
> Session summary updated.
> [摘要内容]
```

**`/export`** 将当前对话导出到文件或剪贴板：

```
你: /export conversation-backup.md
```

**`/share`** 将当前会话日志上传到 GitHub Gist，方便分享给同事或提交 issue。支持多个标志来控制分享方式：

```
你: /share --private --mask-secrets
你: /share --public --summary-only
你: /share --mask-secrets --allow-public-fallback
```

可选标志：
- `--public`：创建公开 Gist（默认 `--private`）
- `--mask-secrets`：上传前遮掩 API key、token 等敏感信息
- `--summary-only`：只上传摘要（每轮截取前 200 字符）
- `--allow-public-fallback`：如果 `gh gist` 失败，回退到 0x0.st

注意：需要安装 `gh` CLI 工具并已登录。

## 诊断与帮助

遇到问题或需要了解系统状态时。

**`/help`** 打开帮助面板。面板有三个标签页：general（通用快捷键和用法）、commands（所有内置命令）、custom-commands（自定义命令）。设置 `DISABLE_DOCTOR_COMMAND=1` 可禁用。

```
你: /help
```

**`/doctor`** 诊断和验证你的 Claude Code 安装及配置是否正确。遇到莫名其妙的问题时，先跑这个：

```
你: /doctor
```

**`/status`** 显示 Claude Code 的综合状态信息：版本号、当前模型、账号信息、API 连通性、工具状态等。

**`/version`** 只显示当前运行的版本号和构建时间：

```
你: /version
> 2.7.0 (built 2026-06-14T08:00:00Z)
```

**`/feedback`**（别名 `/bug`）提交关于 Claude Code 的反馈。注意：在 Bedrock、Vertex、Foundry 或隐私模式下此命令不可用。

## 下一步

- 想了解 MCP Server、插件和 Skill 的详细用法，看 [第五章：扩展 Claude 的能力](./05-extensions.md)
- 想在 CI 或脚本中无交互调用 Claude，看 [第十一章：自动化与 CI 集成](./11-ci-integration.md)
- 遇到报错或卡住，看 [第十章：可观测性与排错](./10-troubleshooting.md)
