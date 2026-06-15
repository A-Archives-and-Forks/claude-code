# 第三章：日常对话 -- 交互式 REPL 怎么用

> 装好 Claude Code 之后，每天打开它会做什么、怎么用。

## 发消息、看回复、中断与退出

启动 `claude` 之后，你会看到一个输入框。直接输入你想说的话，按 Enter 发送。Claude 的回复会以流式文本逐字出现，就像在聊天。

如果你中途觉得方向不对，想停下来，按 **Esc** 可以中断当前正在生成的回复。中断后，已输出的部分仍然保留在对话里，你可以换个方向继续追问。如果 Claude 正在调用某个工具（比如读文件或执行命令），Esc 也会中断工具执行。

想要彻底退出 REPL，按 **Ctrl+C**。第一次按会尝试中断当前任务，再次按会退出程序。

你也可以在非交互场景下使用 pipe 模式，一次性发送问题并获取结果：

```bash
echo "解释一下 package.json 里的 scripts 字段" | claude -p
```

这种模式下不需要启动完整的交互界面，适合脚本调用和快速提问。

## 会话持久化：恢复、历史与清空

Claude Code 会把每次对话自动保存为会话日志。下次你想继续上次的对话，有几种方式。

**恢复上次对话**：直接在输入框里输入 `/resume`，会弹出一个历史会话列表，你可以按时间或项目筛选。也可以在启动时直接恢复：

```bash
# 恢复当前项目最近的对话
claude --continue

# 恢复指定会话 ID 的对话
claude --resume <session-id>

# 恢复时创建新的会话 ID（不影响原始会话）
claude --continue --fork-session
```

`--continue`（简写 `-c`）恢复当前目录下最近一次对话，`--resume` 可以指定会话 ID 或搜索关键词。

**查看历史**：输入 `/history`（别名 `/hist`）可以浏览所有历史会话，包括跨项目的记录。

**清空当前上下文**：如果对话太长、上下文窗口快满了，输入 `/clear`（别名 `/reset`、`/new`）会清空当前对话历史，从零开始。这不会删除会话日志，只是释放当前上下文窗口。

## 切换模型与思考强度

不同的任务适合不同的模型。你可以随时在对话中切换。

**切换模型**：输入 `/model`，后面跟模型名称即可。不传参数时会显示当前使用的模型：

```
/model claude-sonnet-4-20250514
/model opus
```

模型名称支持简写。切换后立即生效，下一轮对话就会使用新模型。

**调整思考强度**：用 `/effort` 命令控制 Claude 的推理深度：

```
/effort low       # 快速响应，适合简单问题
/effort medium   # 默认，平衡速度和质量
/effort high      # 深度思考，适合复杂任务
/effort xhigh     # 扩展推理，超过 high 但不到 max
/effort max       # 最大推理强度（外部用户为会话级，不持久化）
/effort auto      # 让系统自动决定
```

设置会持久化到用户配置，下次启动仍然生效。你也可以通过环境变量 `CLAUDE_CODE_EFFORT_LEVEL` 设置。

**ultrathink 触发词**：当 `ULTRATHINK` feature 启用时，在输入中包含 `ultrathink` 关键词会自动将本轮对话的思考强度提升到 `high`。这是一种"按需激活"的方式，不需要提前切换 `/effort`，只需在需要深度思考的那一轮输入里写上 ultrathink 即可。

## 权限模式切换

Claude Code 执行文件读写、Shell 命令等操作时，默认会逐个询问你是否允许。你可以通过 `/mode` 命令切换交互模式来调整这个行为。

输入 `/mode` 后会弹出一个选择器，可用的模式包括：

- `default` -- 标准模式，每次工具调用都需要确认
- `gentle` -- 更温和的交互风格
- `sharp` -- 精简直接
- `workhorse` -- 工作流优化，减少不必要的确认
- `token-saver` -- 节省 token 消耗
- `super-ai` -- 高自主性模式

模式切换会立即生效并持久化到配置中。选择哪种模式取决于你的信任程度和任务类型：在做探索性任务时可以用更自主的模式，在操作关键文件时切回 default。

## 查看 token 消耗与费用

想知道这一轮对话花了多少钱、用了多少 token，输入 `/usage`（别名 `/cost` 或 `/stats`）。

```
/usage
```

这会显示当前会话的费用估算、token 使用量、以及计划限额的剩余情况。对于有 rate limit 的 Provider，还会显示限流相关状态。

费用追踪基于 API 响应中的 usage 字段实时计算，每个 Provider 的计费方式不同，但 `/usage` 会统一展示。

## 上下文管理与自动压缩

长时间对话会让上下文窗口越来越满。Claude Code 有几种机制来管理这个问题。

**手动压缩**：输入 `/compact` 可以触发上下文压缩。Claude 会把之前的对话总结成一段摘要，释放上下文空间但保留关键信息。你也可以附上自定义的压缩指令：

```
/compact 重点保留代码修改相关的讨论
```

系统在上下文接近上限时也会自动触发 compact，无需手动干预。

**强制剪裁**：输入 `/force-snip` 会在当前位置插入一个剪裁边界。边界之前的所有消息将从下一轮对话的模型视角中移除，但 REPL 的 UI 滚动历史仍然保留，你仍然可以往回翻看。与 `/compact` 不同，`/force-snip` 不会生成摘要，而是直接丢弃旧消息。

一般来说，优先使用 `/compact`（保留摘要），只有当你确认旧消息完全不再需要时才用 `/force-snip`。

## 导出与分享对话

有时候你想把对话内容保存下来或分享给同事。

**导出到文件**：输入 `/export` 会把当前对话导出为一个文件。支持指定文件名：

```
/export my-session.md
```

导出内容是纯文本格式，包含完整的对话记录，方便用其他工具查看或归档。

**上传分享**：输入 `/share` 会把当前会话日志上传到 GitHub Gist，生成一个可分享的链接：

```
/share                       # 默认创建 secret Gist
/share --public              # 创建公开 Gist
/share --mask-secrets        # 自动脱敏 API key 等凭证
/share --summary-only        # 只分享摘要（每轮截取前 200 字符）
/share --allow-public-fallback  # gh 不可用时回退到 0x0.st
```

**隐私提示**：`/share` 上传的 JSONL 文件包含当前会话的所有输入和工具输出。虽然 `--mask-secrets` 可以自动替换常见格式的 API key、Bearer token、AWS key 和 GitHub token，但不保证能覆盖所有敏感信息。分享前请确认内容安全。如果只想让别人了解大概讨论了什么，用 `--summary-only` 是更安全的选择。

**生成摘要**：输入 `/summary` 会让 Claude 对当前对话生成一份结构化的会话摘要。这比 `/compact` 更详细，适合在结束一个长会话前做总结归档。

## 更换主题、输出风格与语言

**主题**：输入 `/theme` 可以更换界面配色方案。适合根据终端背景和个人偏好调整。

**输出风格**：`/output-style` 命令可以调整 Claude 的回复风格（该命令目前标记为已废弃，推荐使用 `/config` 代替）。

**界面语言**：输入 `/lang` 可以切换显示语言：

```
/lang zh     # 简体中文
/lang en     # English
/lang auto   # 跟随系统语言
```

这个设置影响的是界面提示和部分 UI 文本的显示语言，不影响 Claude 的回复语言（回复语言由对话上下文和 CLAUDE.md 配置决定）。

## 配置项目记忆：CLAUDE.md 与 /memory

Claude Code 每次启动时会自动加载项目目录下的 `CLAUDE.md` 文件作为上下文。你可以在里面写项目约定、代码规范、常用命令等，让 Claude "记住"你的项目特性。

CLAUDE.md 支持四层层级，后加载的优先级更高：

1. **Managed** -- 平台管理的全局指令
2. **User** -- 用户主目录下的 `~/.claude/CLAUDE.md`
3. **Project** -- 项目根目录的 `CLAUDE.md`
4. **Local** -- 子目录中的 `CLAUDE.md`

你可以用 `@include` 指令在 CLAUDE.md 里引用其他文件，支持相对路径、家目录路径和绝对路径：

```markdown
@./docs/coding-standards.md
@~/my-global-rules.md
@/etc/claude/company-rules.md
```

支持的文件类型不限于 `.md`，还包括 `.ts`、`.py`、`.rs`、`.sql` 等几十种文本格式。如果引用的文件不存在，会被静默忽略。

在对话中输入 `/memory` 可以直接编辑 Claude 的记忆文件，快速追加或修改项目知识。

## 下一步

- 想快速查找某个 slash 命令，看 [第四章：slash 命令速查](./04-slash-commands.md)
- 想接入外部工具扩展 Claude 的能力，看 [第五章：扩展 Claude 的能力](./05-extensions.md)
- 想了解 token 消耗优化和配置进阶，看 [第九章：省钱、提速、定制](./09-budget-config.md)
