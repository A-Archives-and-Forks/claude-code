# 第六章：让 Claude 帮你跑大任务 -- 子代理、Plan 模式、Task 系统

> 当任务太大、一步做不完时，如何让 Claude 自己拆分、规划和并行推进。

## 什么时候该"升级"任务处理方式

日常对话中，你给 Claude 一条指令，它执行一次就完成了。但有些任务天然不适合一口气干完：代码库迁移涉及几十个文件、排查 bug 需要同时在多处搜索、重构需要先理清依赖再动手。在这些场景下，三个工具能帮你把大任务拆小：**子代理（Agent）** 处理独立的子任务，**Plan 模式** 先想清楚再动手，**Task 系统** 跟踪进度和依赖。

一个简单的判断标准：如果你发现自己反复对 Claude 说"再看看那个文件"、"顺便改一下这个"，说明这个任务已经需要拆分了。

## 子代理：让 Claude 派一个"分身"去干活

Claude Code 有一个 Agent 工具，允许 Claude 在对话过程中派生出子代理来处理子任务。子代理有自己的上下文和工具集，完成后会把结果汇报给主对话。你不需要手动启动子代理 -- 当 Claude 判断某个子任务适合独立处理时，它会自动使用 Agent 工具。

### 内置的子代理类型

Claude Code 内置了几种专门化的子代理，各有分工：

- **general-purpose** -- 通用子代理，能使用全部工具。当你让 Claude 做一个需要多步骤研究或跨文件分析的任务时，它可能会派这个子代理去执行。
- **Explore** -- 只读搜索专家，不能修改任何文件。擅长用 Glob、Grep、FileRead 快速在代码库中定位文件和关键词。当你问"这个功能在代码里怎么实现的"时，Explore 子代理会并行搜索多个路径然后汇总结果。
- **Plan** -- 架构规划师，同样只读。它会深入阅读代码、理解现有架构，然后输出一份包含步骤和关键文件的实施方案。

你不需要记住这些类型名。Claude 会根据你的问题自动选择合适的子代理。

### 子代理是怎么工作的

当你给 Claude 一个复杂指令时，它可能会这样处理：

```
你: 把 src/utils/ 下所有用到 deprecatedFunction 的地方重构掉

Claude: [使用 Agent 工具，派出一个 Explore 子代理搜索所有引用]

  > Agent (Explore): 正在搜索 src/utils/ 下的 deprecatedFunction 引用...

  [子代理完成，返回搜索结果]

Claude: 找到了 12 处引用，分布在 5 个文件中。让我逐一替换...
```

子代理运行时，你会看到一个带颜色的进度提示，标明子代理的类型和当前状态。每个子代理的输出会作为一条消息出现在对话中，Claude 主线程会基于这些结果继续工作。

子代理之间也可以形成层级：主对话可以派子代理，子代理在复杂场景下还能继续派更小的子代理（取决于配置和 feature flag）。

### 关于并行子代理

当你使用一些 Skill（如 `ultra-batch` 或 `dispatching-parallel-agents`）时，可以显式要求 Claude 同时派发多个子代理并行处理不同子任务。这在需要同时探索多个代码路径、或同时修改多个独立文件时特别高效。

```
你: 用 3 个子代理同时查一下 authentication、authorization 和 session 管理的实现

Claude: [同时派出 3 个 Explore 子代理，并行搜索]
  > Agent #1 (Explore): 搜索 authentication 相关文件...
  > Agent #2 (Explore): 搜索 authorization 相关文件...
  > Agent #3 (Explore): 搜索 session 管理相关文件...

  [三个子代理各自返回结果，Claude 汇总]
```

## Task 系统：跟踪任务进度和依赖

Task 系统提供了一套完整的任务管理工具，让 Claude 能够像使用待办清单一样跟踪工作进度。这套工具包括 `TaskCreate`、`TaskUpdate`、`TaskList` 和 `TaskGet`。

### 任务是怎么创建的

Claude 会在拆分大任务时自动使用 `TaskCreate` 创建子任务。你也可以在对话中明确要求它创建任务清单：

```
你: 帮我把用户模块重构拆成任务清单

Claude: [使用 TaskCreate 创建任务]

  > Task #1 created: 提取用户验证逻辑到独立 service
  > Task #2 created: 重构用户数据模型，添加类型约束
  > Task #3 created: 更新 API 路由使用新的 service 层
  > Task #4 created: 编写单元测试覆盖新 service
```

每个任务包含标题（subject）、描述（description）和状态（pending / in_progress / completed）。创建任务时，Claude 还可以设置 `activeForm`（进行中时显示的活动描述，如"Running tests"），以及任意的 `metadata` 键值对。

### 任务状态流转

任务创建后默认是 `pending` 状态。Claude 会用 `TaskUpdate` 把任务标记为 `in_progress`（开始执行）、`completed`（完成）或 `deleted`（删除）。

```
你: 继续执行任务清单

Claude: [使用 TaskUpdate 更新状态]

  > Updated task #1 in_progress, status
  [开始执行第一个任务...]

  > Updated task #1 completed, status
  > Updated task #2 in_progress, status
  [继续下一个任务...]
```

用 `TaskList` 可以随时查看所有任务的当前状态：

```
#1 [in_progress] 提取用户验证逻辑到独立 service
#2 [pending] 重构用户数据模型，添加类型约束
#3 [pending] 更新 API 路由使用新的 service 层
#4 [pending] 编写单元测试覆盖新 service
```

`TaskGet` 则用于查看单个任务的完整详情，包括描述和依赖关系。

### 任务依赖

任务之间可以设置阻塞关系。如果任务 A 阻塞了任务 B（task B 被 task A blocked），那么在 A 完成之前，B 无法开始。Claude 在规划执行顺序时会参考这些依赖关系：

```
#1 [completed] 提取用户验证逻辑到独立 service
#2 [in_progress] 重构用户数据模型，添加类型约束
#3 [blocked by #2] 更新 API 路由使用新的 service 层
#4 [blocked by #3] 编写单元测试覆盖新 service
```

### 任务钩子

Task 系统支持 hooks 集成。你可以在 `settings.json` 中配置 hooks，让特定事件（如任务创建、任务完成）触发自定义逻辑。比如，当某个关键任务完成时自动运行测试套件。

## Plan 模式：先想清楚再动手

Plan 模式是处理复杂任务的最佳实践。进入 Plan 模式后，Claude 会切换到只读状态：它可以搜索代码、阅读文件、分析架构，但不能修改任何文件。等方案设计完毕并获得你的批准后，才退出 Plan 模式开始实际编码。

### 进入 Plan 模式

有两种方式进入 Plan 模式：

**方式一：用 `/plan` 命令**

```
/plan 重构用户模块的数据层
```

这会启用 Plan 模式，并把你给出的描述作为规划目标。Claude 会在只读状态下探索代码库、设计实施方案。

**方式二：让 Claude 自动进入**

对于足够复杂的任务，Claude 会自动调用 `EnterPlanMode` 工具进入 Plan 模式。你不需要显式要求，但可以用 `/plan` 强制进入。

### Plan 模式下发生了什么

进入 Plan 模式后，权限模式会切换为 `plan`。在这个模式下：

- Claude 只能使用只读工具（Read、Glob、Grep、Bash 的只读操作）
- 文件编辑工具（Edit、Write）被禁用
- Claude 会深入探索代码库，理解现有模式和架构
- Claude 可能会问你一些问题来澄清需求

Claude 会把规划结果写入一个计划文件。你可以随时用 `/plan` 查看当前计划，或用 `/plan open` 在你的默认编辑器中打开并手动修改计划内容。

### 退出 Plan 模式并开始执行

当 Claude 完成规划后，它会调用 `ExitPlanMode` 工具。这时你会看到一个审批对话框，显示完整的计划内容。你可以：

- **批准** -- Claude 立即开始按计划编码
- **编辑** -- 在编辑器中修改计划，然后批准修改后的版本
- **拒绝** -- 让 Claude 重新规划

批准后，权限模式会恢复到进入 Plan 模式之前的状态（通常是 `default` 或 `auto`），Claude 开始按计划执行。

### VerifyPlanExecution：确认计划已正确执行

在较新的版本中，Claude 在退出 Plan 模式之前可能会调用 `VerifyPlanExecution` 工具，对计划的执行情况进行校验。它会检查：

- 计划中的所有步骤是否都已完成
- 测试是否通过
- 关键文件是否已正确创建或修改

如果某些步骤被跳过或失败了，验证结果中会包含说明。

## Goal 命令：给 Claude 一个自主推进的目标

`/goal` 命令让你给 Claude 设定一个长期目标，然后 Claude 会自主地持续工作直到目标达成，而不是等你一轮一轮地下指令。

### 设置和查看目标

```
/goal 把所有 API 端点从 REST 迁移到 GraphQL
```

这会设定一个目标。Claude 会开始自主规划、拆分任务、执行修改，每完成一轮会自动继续下一轮。你可以随时查看目标状态：

```
/goal status
```

输出会显示目标描述、当前状态、已用 token 数量、活跃时间和已执行的轮次。

### 控制目标进度

`/goal` 支持几个子命令来控制执行：

- `/goal pause` -- 暂停自动继续
- `/goal resume` -- 从暂停恢复
- `/goal continue` -- 在达到最大轮次限制后重置计数器继续
- `/goal complete` -- 手动标记目标已完成
- `/goal clear` -- 清除当前目标

当 Claude 遇到无法自行解决的阻塞时，它会用 `GoalTool` 将目标标记为 `blocked` 并说明原因。连续 3 轮遇到同样的阻塞条件后，目标会被自动标记为阻塞状态，等待你介入。

### Goal 与 Task 系统的配合

`/goal` 通常会与 Task 系统配合使用。Claude 设定目标后会自动创建任务清单，然后逐个执行。你可以在 `/workflows` 面板中同时看到目标和任务的状态。

## Worktree 隔离：在独立分支里做实验

当你需要做一些可能有风险或需要独立验证的改动时，Claude 可以用 `EnterWorktree` 工具创建一个 git worktree -- 一个独立的工作目录，关联到一个新的 git 分支。

### Claude 如何使用 Worktree

你不需要手动管理 worktree。当你告诉 Claude 做一些需要隔离的操作时，它可能会自动调用 `EnterWorktree`：

```
你: 试试把 ORM 从 Prisma 换成 Drizzle，先在一个独立分支上验证可行性
```

Claude 会创建一个 worktree，在新分支上做实验，完成后汇报结果。你的主工作目录完全不受影响。

### Worktree 的生命周期

- **创建**：`EnterWorktree` 创建 worktree 和关联分支，会话切换到 worktree 目录
- **退出 -- 保留**：`ExitWorktree(action: "keep")` 保留 worktree 和分支，会话切回原目录
- **退出 -- 删除**：`ExitWorktree(action: "remove")` 删除 worktree 和分支。如果有未提交的改动或未合并的 commit，Claude 会先列出它们，需要你确认并传入 `discard_changes: true` 才会执行删除

你也可以在启动 Claude 时直接指定 worktree 模式：

```bash
claude --tmux --worktree
```

这会自动创建一个 worktree 并在 tmux 会话中运行。

## Coordinator 模式：多 Worker 协作

Coordinator 模式是一个高级特性（需要 `COORDINATOR_MODE` feature flag），把 Claude 变成一个任务调度器。启用后，Claude 只能使用 Agent（派发子任务）、SendMessage（给子代理发消息）和 TaskStop（停止子任务）三个工具，不再直接执行任何操作。

### 启用 Coordinator 模式

```
/coordinator
```

启用后，Claude 会变成一个编排者。你给它一个大任务，它会拆分成多个子任务，然后派发给不同的 worker 子代理并行执行：

```
你: 把这个 monorepo 的所有包从 CommonJS 迁移到 ESM

Claude (Coordinator): 我把这个任务拆成 5 个子任务，派发给 worker 执行...

  > Agent (worker #1): 迁移 packages/utils/ ...
  > Agent (worker #2): 迁移 packages/core/ ...
  > Agent (worker #3): 迁移 packages/api/ ...
  ...

  [Worker 完成后汇报结果，Coordinator 汇总]
```

再次输入 `/coordinator` 可以关闭 Coordinator 模式，恢复正常的工具使用。

## Workflow 脚本：固化可重放的多步工作流

`/workflows` 命令打开一个监控面板，实时显示当前工作流的运行状态、各阶段进度和子代理活动。这个面板适合在 Claude 执行复杂多步任务时监控整体进展。

在面板中，你可以看到：

- 当前工作流的运行状态（running / paused / completed）
- 各阶段的进度
- 活跃的子代理列表及其状态
- 用键盘快捷键控制工作流（暂停、继续、取消）

```
/workflows
```

面板以终端 UI 形式展示，不阻塞主对话。

## 如何选择合适的方式

面对一个大任务，选择哪种方式取决于任务的性质：

| 场景 | 推荐方式 |
|------|----------|
| 需要先理解代码再动手 | Plan 模式 |
| 需要长时间自主推进 | `/goal` |
| 需要并行处理多个独立子任务 | Agent 子代理 / Coordinator 模式 |
| 需要在隔离环境做实验 | Worktree |
| 需要跟踪多个子任务的进度 | Task 系统 |
| 需要监控复杂工作流的执行 | `/workflows` 面板 |

这些方式可以组合使用。比如，你可以先用 Plan 模式设计方案，然后 Claude 自动创建 Task 清单，再派子代理并行执行各任务，同时你在 `/workflows` 面板中监控进度。

## 下一步

- 想了解如何让 Claude 定时或后台执行任务，看 [第七章：Daemon、Background Sessions、Schedule](./07-daemon-bg-schedule.md)
- 想了解如何通过 Bridge 或 RCS 远程控制这些任务，看 [第八章：跨机器与跨团队协作](./08-bridge-remote-acp.md)
- 想了解权限模式如何影响子代理和 Plan 模式的行为，看 [第九章：省钱、提速、定制](./09-budget-caching-hooks.md)
