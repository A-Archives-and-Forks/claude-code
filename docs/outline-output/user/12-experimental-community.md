# 第十二章：进阶实验性能力与社区生态

> 想折腾更多？这里是一张"还能玩什么"的地图。

## 实验性 Feature Flag 速览

Claude Code 有几十个 feature flag，大部分在构建时已默认启用（见 `scripts/defines.ts` 中的 `DEFAULT_BUILD_FEATURES` 列表），用户无需关心。但有几个 flag 的行为比较有趣，值得单独了解。

已默认启用的进阶 flag 包括：

| Flag | 作用 |
|------|------|
| `BUDDY` | 陪伴宠物角色，在输入框旁边显示一个 ASCII 小伙伴 |
| `KAIROS` | 定时任务系统核心，配合 `/brief` 使用 |
| `LODESTONE` | 上下文锚点，优化长对话中的相关性检索 |
| `ULTRAPLAN` | 超级规划模式，深度分析后生成实施计划 |
| `MONITOR_TOOL` | 流式监控后台进程输出 |
| `KAIROS_BRIEF` | 定时摘要，定时汇报当前会话状态 |
| `ULTRATHINK` | 超深度思考模式，增加推理链长度 |

所有 flag 都可以通过环境变量在运行时控制。格式是 `FEATURE_<FLAG_NAME>=1`，例如：

```bash
# 启用 Buddy 宠物（构建时已默认启用，这里只是演示语法）
FEATURE_BUDDY=1 bun run dev

# Dev 模式默认启用全部 flag，无需额外设置
bun run dev
```

注意：`feature()` 函数有 Bun 编译器的限制，只能出现在 `if` 条件或三元表达式中，不能赋值给变量。用户层面不需要关心这个细节，只需要知道"设置环境变量后重启即生效"。

Skill 搜索与工具搜索预取是两个特殊的实验性 flag：`EXPERIMENTAL_SKILL_SEARCH` 和 `EXPERIMENTAL_SEARCH_EXTRA_TOOLS`。它们虽然被编译进了构建产物，但运行时默认关闭。要开启需要额外设置环境变量 `SKILL_SEARCH_ENABLED=1`。这两个 flag 的设计考虑是： bounded caches 已修复了内存溢出风险，但磁盘侧的观察累积和首次查询时的模型选择仍然是运营层面的权衡，因此默认关闭、由使用者自行决定是否开启。

```bash
# 开启 Skill 搜索实验
FEATURE_EXPERIMENTAL_SKILL_SEARCH=1 SKILL_SEARCH_ENABLED=1 bun run dev
```

## Buddy：你的编码小伙伴

`/buddy` 命令会在你的输入框旁边召唤一个 ASCII 小伙伴。它是一个纯本地的陪伴角色，不会消耗任何 API token，也不影响对话功能。

第一次运行 `/buddy` 时，系统会根据一个随机种子生成一个随机物种、名字和性格：

```
> /buddy

A wild companion appeared!

   ╭──────────╮
   │  ○    ○  │
   │    >│    │
   │  ╰────╯  │
   ╰──────────╯

Waddles the Duck
Rarity: ** (common)
"Quirky and easily amused. Leaves rubber duck debugging tips everywhere."

Your companion will now appear beside your input box!
Say its name to get its take . /buddy pet . /buddy off
```

物种包括 duck、goose、blob、cat、dragon、octopus、owl、penguin、turtle、snail、ghost、axolotl、capybara、cactus、robot、rabbit、mushroom、chonk 共 18 种，每种有固定的默认名字和性格描述。稀有度从 common 到 legendary 不等，还有极低概率出现 shiny 变体。

`/buddy` 支持几个子命令：

- `/buddy pet` -- 摸一下小伙伴，触发心形动画和反应台词，同时自动取消静音
- `/buddy off` -- 静音小伙伴（不删除，只是不显示）
- `/buddy on` -- 取消静音，重新显示
- `/buddy`（无参数）-- 如果已有小伙伴则显示卡片，没有则孵化新的

小伙伴的数据保存在全局配置的 `companion` 字段中，所以重启后仍然存在。每个人的小伙伴由种子决定，理论上相同种子会生成相同结果。

## Brief 与 Recap：会话状态摘要

当你离开一段时间后回来，不想滚动翻阅大量历史消息，可以用 `/recap`（别名 `/away` 或 `/catchup`）生成一句当前会话的摘要：

```
> /recap

You're refactoring the authentication module. The JWT refresh logic has been
implemented; next up is adding unit tests for the token rotation edge case.
```

`/recap` 由 `AWAY_SUMMARY` feature flag 控制，构建时已默认启用。它会调用一个独立的 Opus 模型来分析当前会话的上下文，生成不超过 40 个单词的简短描述，涵盖当前目标、活跃任务和下一步行动。没有任何格式标记，就是一句纯文本。

`/brief` 则是一个更宏观的"简报模式"开关。开启后，Claude 的所有面向用户的输出会通过 Brief 工具统一处理，实现结构化的简报式展示。这个命令由 `KAIROS` 和 `KAIROS_BRIEF` 两个 feature flag 共同控制：

```
> /brief

Brief-only mode enabled
```

再次输入 `/brief` 可以关闭。注意 Brief 工具有账户级别的权限检查（`isBriefEntitled`），如果你的账户未启用该功能，开启时会提示 "Brief tool is not enabled for your account"。

## Advisor、Insights 和 Thinkback：让 Claude 反思自己

这三个命令各有不同的用途。

`/advisor` 允许你设置一个"顾问模型"，让当前模型在生成回复时参考另一个模型的意见。这是一个高级功能，由 `canUserConfigureAdvisor()` 控制可见性：

```
> /advisor

Advisor: not set
Use "/advisor <model>" to enable (e.g. "/advisor opus").

> /advisor opus

Advisor set to claude-opus-4-20250514.
```

设置后会持久化到用户配置（`userSettings`），重启后依然生效。使用 `/advisor unset` 或 `/advisor off` 可以关闭。如果当前使用的主模型不支持 advisor 功能，系统会提示你切换到支持的模型。

`/insights` 是一个重量级命令，会分析你所有的 Claude Code 会话历史，生成一份完整的 HTML 报告。它使用 Opus 模型对会话数据进行多维分析，覆盖以下方面：

- 项目领域分布（你在哪些项目上花了多少时间）
- 交互风格分析（你通常怎么使用 Claude Code）
- 有效工作流发现（哪些使用方式效果最好）
- 摩擦点分析（哪些地方让你感到不便）
- 改进建议和未来展望

`/insights` 会读取本地存储的所有会话日志，需要 Opus 模型权限，运行时间较长。报告以 HTML 文件形式保存在本地，适合定期回顾自己的使用模式。

`/think-back`（注意带横杠）是一个季节性功能，由 GrowthBook 的 `tengu_thinkback` 特性门控。它会生成你的 Claude Code "年度回顾"动画，类似音乐平台的年度听歌报告。配合 `/thinkback-play` 可以重放动画效果。

## Teleport：跨设备恢复会话

`/teleport`（别名 `/tp`）让你从 Claude.ai 网页端恢复一个会话到本地 CLI。这对于"在网页上开始的任务，想在本地终端继续"的场景特别有用。

不带参数运行 `/teleport` 会从 Sessions API 拉取你的会话列表：

```
> /teleport --print

## Available sessions (most recent first)

  01. Refactor auth module to use JWT        active     2025-06-14  id=abc12345-...
  02. Debug memory leak in worker process    completed  2025-06-13  id=def67890-...
  03. Add integration tests for API layer   active     2025-06-12  id=ghi24680-...

Run `/teleport <session-id>` to resume a session.
```

传入会话 ID 可以恢复具体会话。恢复前系统会检查本地 git 状态是否干净，因为恢复过程可能涉及分支切换。如果 git 有未提交的修改，会报错并提示你先处理。

```bash
# 查看可用会话
/teleport

# 恢复特定会话
/teleport abc12345-6789-abcd-ef01-234567890abc
```

Teleport 的前提是你已通过 OAuth 认证登录（`claude auth login`）。如果认证 token 过期或无效，会提示你重新登录。该命令不支持通过 Remote Control / Bridge 使用（`bridgeSafe: false`）。

## Pipes：跨会话消息传递

`/pipes` 命令管理跨机器、跨会话的消息管道。它属于 `pipes` 模块的一部分，用于在多个 Claude Code 实例之间广播消息。

不带参数运行 `/pipes` 会显示当前管道状态，包括你的管道名称、角色（main 或 sub）、连接的管道列表等：

```
> /pipes

Your pipe:   claude-macbook-pro
Role:        main
Machine ID:  a1b2c3d4...
IP:          192.168.1.42
Host:        macbook-pro.local

Main machine: a1b2c3d4... (this machine)
  [main] claude-macbook-pro  macbook-pro.local/192.168.1.42  [alive] (you)
  [sub-1] claude-linux-box   linux-server/192.168.1.100     [alive]

Selected: (none -- messages run locally only)

Commands:
  /pipes select <name>    -- select pipe for broadcast
  /pipes deselect <name>  -- deselect pipe
  /pipes all              -- select all connected
  /pipes none             -- deselect all
  /send <name> <msg>      -- send to specific pipe
  /claim-main             -- claim this machine as main
```

通过 `/pipes select <name>` 选择目标管道后，你的消息会被广播到选中的管道。`/send <name> <msg>` 则可以直接向特定管道发送一条消息而不影响广播设置。

`/pipes` 依赖管道注册表（`pipeRegistry`）来发现网络上的其他实例。在 LAN_PIPES feature 启用时，还会通过局域网信标（`lanBeacon`）自动发现局域网内的对等节点。

## Local Vault 与 Memory Stores：本地长期记忆

`/local-vault` 提供一个本地的键值存储，你可以用它保存想要跨会话持久化的信息。它不依赖任何远程服务，数据完全存储在本地。

```bash
# 查看所有条目
> /local-vault list

# 存储一条信息
> /local-vault set project-arch We use a monorepo with turborepo

# 读取一条信息（默认隐藏值）
> /local-vault get project-arch
project-arch: ********

# 读取并显示明文
> /local-vault get project-arch --reveal
project-arch: We use a monorepo with turborepo

# 删除一条信息
> /local-vault delete project-arch
```

键名不能以 `-` 开头（包括各种 Unicode 连字符变体），这是为了防止与命令行参数标志混淆。

`/memory-stores` 是一个更结构化的记忆管理系统，支持创建多个记忆库（store），每个库下可以创建多条记忆（memory），支持版本管理和内容撤回：

```bash
# 创建一个新的记忆库
> /memory-stores create project-conventions

# 在库中添加一条记忆
> /memory-stores create-memory <store-id> Always use Zod for input validation

# 查看某个库的所有记忆
> /memory-stores memories <store-id>

# 更新一条记忆
> /memory-stores update-memory <store-id> <memory-id> Always use Zod or Valibot for input validation

# 查看某个库的版本历史
> /memory-stores versions <store-id>

# 撤回某个版本的内容
> /memory-stores redact <store-id> <version-id>

# 归档不再使用的库
> /memory-stores archive <store-id>
```

Memory stores 比 local-vault 更适合管理需要跟踪变更的结构化知识。local-vault 更适合存储简单的键值对配置。两者互补，根据你的数据复杂度选择即可。

## TUI 模式：无闪烁全屏体验

`/tui` 命令切换 Claude Code 的显示模式。开启后使用 ANSI 备用屏幕缓冲区（alternate screen buffer），UI 占据整个终端窗口，退出后自动恢复原始内容，不会污染你的终端滚动历史。

```bash
# 开启 TUI 模式
> /tui on

## TUI mode enabled

Marker written: `~/.claude/.tui-mode`

Flicker-free alternate-screen rendering will be active on the next
session start. Add this to your shell profile to make it permanent:

  [ -f "$HOME/.claude/.tui-mode" ] && export CLAUDE_CODE_NO_FLICKER=1

To disable: `/tui off`
```

TUI 模式的设置通过标记文件 `~/.claude/.tui-mode` 持久化，跨会话生效。你还可以通过环境变量 `CLAUDE_CODE_NO_FLICKER` 控制：

```bash
# 强制开启（覆盖标记文件）
CLAUDE_CODE_NO_FLICKER=1 claude

# 强制关闭
CLAUDE_CODE_NO_FLICKER=0 claude
```

推荐在 shell 配置文件中添加自动检测，这样每次启动 Claude Code 时都会自动启用 TUI 模式：

```bash
# 添加到 ~/.zshrc 或 ~/.bashrc
[ -f "$HOME/.claude/.tui-mode" ] && export CLAUDE_CODE_NO_FLICKER=1
```

`/tui status` 可以查看当前 TUI 模式的状态，包括标记文件是否存在、环境变量设置情况等。注意：运行时修改环境变量不会立即生效，需要重启会话。

## Stickers 和 Output Style

`/stickers` 命令用于订购 Claude Code 的实体贴纸。这是一个简单的互动功能，不涉及任何技术配置。

`/output-style` 命令已被标记为隐藏（deprecated），官方推荐使用 `/config` 命令来更改输出风格。如果你在旧版本的文档中看到 `/output-style`，直接使用 `/config` 替代即可。

## 贡献与反馈

如果你在使用过程中遇到问题或有改进建议，有几种反馈渠道：

`/feedback`（别名 `/bug`）是最直接的反馈方式。它会在交互式界面中引导你提交反馈。注意：当你使用 Bedrock、Vertex 或 Foundry 作为 Provider 时，`/feedback` 命令会被自动禁用。如果你手动设置了 `DISABLE_FEEDBACK_COMMAND=1` 或 `DISABLE_BUG_COMMAND=1`，该命令也会被隐藏。

```bash
# 直接提交反馈
> /feedback

# 带描述提交
> /feedback The Grep tool sometimes returns stale results after file edits
```

如果你是开发者或想深入了解项目内部，可以：

- 查看 GitHub Issues 提交 bug 报告或功能请求
- 在本地启动文档站查看最新文档：`bun run docs:dev`（基于 Mintlify）
- 阅读项目中的 `CLAUDE.md` 了解贡献规范和代码约定

## 下一步

- 想了解如何切换模型和 Provider，看 [第二章](./02-providers.md)
- 想排查错误或查看常见问题，看 [第十章](./10-observability-troubleshooting.md)
- 想把 Claude 嵌入 CI 流水线，看 [第十一章](./11-ci-integration.md)
