# 第九章：省钱、提速、定制 -- 穷鬼模式、缓存、Hooks、配置文件

> token 账单太高、响应太慢、想让 Claude 自动响应特定事件 -- 这章帮你解决。

## 穷鬼模式：关掉不需要的自动任务，直接省钱

如果你用 Anthropic 官方 API 按量计费，可能会注意到每次对话结束时 Claude 会在后台做一些额外工作 -- 提取记忆、生成下一步建议。这些功能有用，但不是每次都需要。穷鬼模式 (`/poor`) 就是用来一键关掉它们的。

在 REPL 里输入 `/poor` 即可切换。你会看到类似这样的反馈：

```
Poor mode ON — extract_memories and prompt_suggestion are disabled
```

再次输入 `/poor` 则关闭：

```
Poor mode OFF — extract_memories and prompt_suggestion are restored
```

穷鬼模式关掉的核心功能有三个：`extract_memories`（每次 turn 结束后提取长期记忆）、`prompt_suggestion`（生成下一步操作建议）、以及 `verification_agent`（任务完成后自动验证结果）。这三个功能会额外消耗 API 调用和 token，关掉后只保留核心对话能力。

这个开关是持久化的 -- 它会写入 `settings.json` 的 `poorMode` 字段，下次启动 Claude 仍然生效。你可以用 `/config` 命令在设置界面中确认状态，也可以直接编辑 `~/.claude/settings.json`：

```json
{
  "poorMode": true
}
```

穷鬼模式对所有 Provider 都生效，包括 OpenAI 兼容层、Gemini 和 Grok，因为跳过的是对话流程中的额外步骤，跟具体 API 后端无关。

## Prompt 缓存：为什么第二次回答更快

Anthropic API 有 prompt 缓存机制 -- 如果连续请求之间系统提示和对话历史没有变化，API 可以复用之前的结果，响应更快、费用更低。Claude Code 在构建过程中默认利用了这个缓存。

当对话变长、需要压缩（compact）时，缓存可能会被"打断"，因为压缩后的上下文和之前不同了。`PROMPT_CACHE_BREAK_DETECTION` 功能（构建时默认启用）会在压缩操作前后检测缓存是否仍然命中，帮助理解为什么某次请求变慢了。

对于普通用户来说，你不需要做任何特殊配置。只需要知道：保持对话的连贯性（不要频繁 `/compact`）有助于维持缓存命中，从而获得更快的响应速度。

## Token 预算：控制每次请求的 token 上限

`TOKEN_BUDGET` 功能（构建时默认启用）会在系统提示中注入当前会话的 token 使用情况，让 Claude 感知到 token 预算的存在。它和 `/cost` 命令联动 -- 当你查看费用时，看到的 token 数据就是预算追踪系统收集的。

这个功能对使用按量计费 API 的用户特别有用。它不会硬性限制你的使用，而是让模型在生成回复时"心中有数"，更倾向于给出精简而非冗长的回答。

## Hooks：让 Claude 在特定事件发生时自动执行操作

Hooks 是 Claude Code 的自动化基础设施。你可以在设置文件里定义"当 X 发生时，执行 Y"，比如"每次文件修改后自动跑测试"或"每次会话结束时自动提交 git 日志"。

### Hook 的四种类型

Claude Code 支持 4 种 hook 类型：

- **command** -- 执行 shell 命令
- **prompt** -- 发送一个 LLM 提示请求
- **agent** -- 启动一个代理来验证结果
- **http** -- 向某个 URL 发送 POST 请求

### 可用的事件

Hook 可以绑定到以下事件上（在 `settings.json` 中作为 key）：

| 事件 | 触发时机 |
|------|----------|
| `PreToolUse` | 工具调用前 |
| `PostToolUse` | 工具调用完成后 |
| `PostToolUseFailure` | 工具调用失败时 |
| `SessionStart` | 会话开始时 |
| `SessionEnd` | 会话结束时 |
| `Stop` | Claude 停止生成时 |
| `UserPromptSubmit` | 用户提交输入时 |
| `PreCompact` | 上下文压缩前 |
| `PostCompact` | 上下文压缩后 |
| `Notification` | 收到通知时 |
| `SubagentStart` / `SubagentStop` | 子代理启停时 |
| `FileChanged` | 文件发生变化时 |

### 配置示例

在 `settings.json` 的 `hooks` 字段中添加 hook。下面是一个实际场景：每次 Claude 调用 Bash 工具执行 `git push` 之前，自动检查是否有未提交的更改：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "git status --short",
            "if": "Bash(git push *)",
            "shell": "bash"
          }
        ]
      }
    ]
  }
}
```

`if` 字段使用权限规则语法来过滤 -- 只有匹配 `Bash(git push *)` 模式的工具调用才会触发这个 hook，避免每次用 Bash 都执行。

再举一个会话启动时的例子，自动在日志中记录工作环境：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo \"$(date): Claude session started in $(pwd)\" >> ~/.claude/session-log.txt"
          }
        ]
      }
    ]
  }
}
```

### 管理 Hooks

在 REPL 中输入 `/hooks` 会打开一个交互式配置界面，你可以浏览、添加、编辑和删除 hook。你也可以直接编辑 `settings.json`。

### Hook 的高级选项

command 类型 hook 支持这些额外字段：

- `shell` -- 指定 shell 解释器（`bash` 或 `powershell`），默认用 bash
- `timeout` -- 超时时间（秒）
- `async` -- 设为 true 则在后台运行，不阻塞主流程
- `asyncRewake` -- 后台运行，如果退出码为 2 则唤醒模型（阻塞式错误）
- `once` -- 设为 true 则只执行一次，之后自动删除
- `statusMessage` -- 执行时显示的状态栏消息

http 类型 hook 支持通过 `headers` 字段添加自定义 HTTP 头，可以用 `$VAR_NAME` 或 `${VAR_NAME}` 语法引用环境变量（需配合 `allowedEnvVars` 字段声明允许的变量名列表）。

## settings.json 与 settings.local.json：团队共享 vs 个人覆盖

Claude Code 的配置文件分多个层级，支持组织统一管理和个人定制。

### 四个配置来源

| 来源 | 文件位置 | 用途 | 是否提交到 git |
|------|----------|------|---------------|
| **managed-settings** | `/etc/claude-code/managed-settings.json`（Linux）或对应系统目录 | 组织管理员强制策略，优先级最高 | 不适用 |
| **userSettings** | `~/.claude/settings.json` | 个人全局配置，所有项目共享 | 不适用 |
| **projectSettings** | 项目根目录下 `.claude/settings.json` | 项目级配置，团队共享 | 应提交 |
| **localSettings** | 项目根目录下 `.claude/settings.local.json` | 个人项目级覆盖 | 应 gitignore |

优先级从高到低：managed > local > project > user。后面的配置会合并（不是覆盖）前面的。比如 projectSettings 里设了 `hooks`，localSettings 里设了 `permissions`，两者都会生效。

### 实际用法

**团队协作场景**：在项目的 `.claude/settings.json` 中放入团队共享的权限规则和 hook 配置，提交到 git。团队成员各自可以在 `.claude/settings.local.json` 中添加个人偏好。

**个人偏好场景**：在 `~/.claude/settings.json` 中设置 `poorMode`、`defaultMode` 等全局偏好，对所有项目生效。

### 用 /config 命令管理

在 REPL 中输入 `/config` 会打开一个交互式设置界面，包含 Config、Hooks、Permissions 等标签页，可以直接修改各项配置。

## CLAUDE.md 四层层级：给 Claude 的项目指令

CLAUDE.md 是告诉 Claude "怎么理解这个项目"的文件，但它不是一个文件，而是四层层级：

1. **Managed**（如 `/etc/claude-code/CLAUDE.md`）-- 组织全局指令，所有用户、所有项目生效
2. **User**（`~/.claude/CLAUDE.md`）-- 个人全局指令，你所有项目共享
3. **Project**（项目目录下的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`）-- 项目级指令，通常提交到 git 让团队共享
4. **Local**（`CLAUDE.local.md`）-- 个人项目级指令，不提交

加载顺序是从 Managed 到 Local，越晚加载的优先级越高（模型会更关注后加载的内容）。如果你在嵌套目录中工作，`src/CLAUDE.md` 的优先级高于项目根目录的 `CLAUDE.md`。

每个层级支持多个文件：比如 `.claude/rules/` 目录下的所有 `.md` 文件都会被加载。还有一个特殊机制：`.gitignore` 的规则会被用来排除不想被加载的 CLAUDE.md 文件。

### @include 指令：引用其他文件

CLAUDE.md 支持 `@include` 语法来引用其他文件内容，避免把所有东西写在一个文件里。语法有四种形式：

```
@path/to/file          # 相对路径（等同于 @./path/to/file）
@./relative/path       # 相对路径
@~/home/path           # 用户主目录下的路径
@/absolute/path        # 绝对路径
```

比如你在项目的 `CLAUDE.md` 中写：

```markdown
# 项目规范

请遵循以下代码规范：

@./docs/coding-standards.md

@~/claude-rules/my-personal-preferences.md
```

`@include` 只在文本节点中生效（不会解析代码块内的内容），支持 60 多种文本扩展名（`.md`、`.ts`、`.py`、`.json`、`.yaml`、`.sql` 等）。不存在的文件会被静默忽略，循环引用会被自动检测和阻断。

## keybindings.json：自定义快捷键

Claude Code 的快捷键可以通过 `~/.claude/keybindings.json` 文件自定义。在 REPL 中输入 `/keybindings` 会自动生成一个模板文件（如果还没有的话）并在编辑器中打开它。

生成的模板包含所有可绑定的默认快捷键。你可以修改绑定值、添加新的绑定，或者设为 `null` 来取消某个快捷键。每个绑定项包含 context（如 `"normal"` 或 `"insert"`）和具体的键映射。

模板文件顶部会包含 JSON Schema 引用，支持编辑器的自动补全和校验：

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "normal",
      "bindings": {
        "enter": "submit",
        "escape": "cancel"
      }
    }
  ]
}
```

注意：部分快捷键是保留的（如退出快捷键），不可重新绑定，模板中已自动过滤掉这些项。

## 权限规则配置：控制 Claude 能做什么

权限规则定义了 Claude 在使用工具时需要什么样的批准。你可以在 settings 的 `permissions` 字段中配置 `allow`、`deny` 和 `ask` 规则列表。

### 规则语法

每条规则是一个字符串，格式为 `ToolName` 或 `ToolName(content)`：

```
Bash              # 匹配所有 Bash 工具调用
Bash(npm test)    # 只匹配执行 "npm test" 的 Bash 调用
Bash(git *)       # 匹配所有以 "git " 开头的 Bash 调用
Read(*.ts)        # 匹配所有读取 .ts 文件的操作
Write              # 匹配所有文件写入
```

圆括号内的内容支持通配符 `*`。如果只写工具名不写内容（如 `Bash`），则匹配该工具的所有调用。

### 配置示例

在项目的 `.claude/settings.json` 中配置：

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "Bash(git status *)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(npm test *)",
      "Bash(npm run lint *)"
    ],
    "deny": [
      "Bash(rm -rf *)"
    ],
    "defaultMode": "ask"
  }
}
```

这个配置的含义是：读文件、搜索、查看 git 状态和日志、跑测试和 lint 不需要确认；`rm -rf` 命令一律拒绝；其他操作需要手动确认。

### 管理

在 REPL 中输入 `/permissions` 会打开一个交互式权限管理界面，可以添加、编辑、删除规则，还可以重试之前被拒绝的工具调用。

### 权限模式

`defaultMode` 可以设为以下值：
- `ask` -- 每次需要工具权限时询问（默认）
- `auto` -- 自动批准所有工具调用
- `deny` -- 拒绝所有工具调用
- `sandbox` -- 在沙箱环境中执行

在 REPL 中也可以通过 `/mode` 命令临时切换权限模式。

## Feature Flag 运行时开关

Feature flag 控制着哪些功能在运行时启用。大部分功能在构建时已经由 `DEFAULT_BUILD_FEATURES` 决定了默认状态，但你可以通过环境变量在运行时覆盖。

用法：设置 `FEATURE_<FLAG_NAME>=1` 来启用某个 flag。例如：

```bash
FEATURE_MONITOR_TOOL=1 bun run dev
```

### 已禁用的 feature flag

以下 flag 在构建中已被注释掉，意味着即使设置环境变量也不会生效（代码路径不存在）：

| Flag | 禁用原因 |
|------|----------|
| `CONTEXT_COLLAPSE` | 实现是空壳 stub，启用后会抑制 auto compact 导致上下文管理失效 |
| `HISTORY_SNIP` | snip 功能暂时关闭 |
| `FORK_SUBAGENT` | 已通过 Agent tool 的等效方式实现，无需单独功能 |
| `UDS_INBOX` | 构建后 node.js 环境卡住 |
| `LAN_PIPES` | 依赖 UDS_INBOX，同样有 node.js 兼容问题 |
| `REVIEW_ARTIFACT` | API 请求无响应，待排查 schema 兼容性 |
| `SKILL_LEARNING` | 功能暂停 |
| `TEAMMEM` | 依赖 COORDINATOR_MODE，邮箱文件无限增长 |

对于这些已禁用的 flag，不要尝试启用 -- 相关代码可能不完整或不兼容。

## 下一步

- 想了解所有 slash 命令的完整分类，看 [第四章：slash 命令速查](./04-slash-commands.md)
- 想了解 token 消费和费用查看，看 [第三章：日常对话](./03-repl-daily.md)
- 想排查 Provider 报错或性能问题，看 [第十章：可观测性与排错](./10-troubleshooting.md)
