# AUTOFIX-PR-001: 恢复 `/autofix-pr` 命令实现

| 字段 | 值 |
|---|---|
| **Issue Type** | Story |
| **Priority** | High |
| **Component** | Slash Commands / Remote Agent (CCR) |
| **Reporter** | unraid |
| **Assignee** | Claude Opus 4.7 |
| **Sprint** | 2026-04 W4 |
| **Story Points** | 8 |
| **Branch** | `feat/autofix-pr` |
| **Worktree** | `E:\Source_code\Claude-code-bast-autofix-pr` |
| **Base Commit** | `4f1649e2` (origin/main) |
| **Status** | In Progress |
| **Spec Document** | `docs/features/autofix-pr.md` |

---

## Summary

将 `src/commands/autofix-pr/index.js` 的 stub（`{isEnabled:()=>false, isHidden:true, name:'stub'}`）替换为完整 LocalJSXCommand 实现，让用户能在 fork 仓库内通过 `/autofix-pr <PR#>` 派发 CCR 远程 session 自动修复 PR 上的 CI 失败，含跨仓库语法 `<owner>/<repo>#<n>`。

## User Story

**As a** 在 fork 仓库工作的开发者
**I want** 通过 `/autofix-pr 386` 触发远端 Claude session 自动修复 PR 上的 CI 失败并 push 回 PR 分支
**So that** 我不用切到 web/手动跑 lint/typecheck 修复就能让 PR 变绿

## 背景

本仓库是 Anthropic 官方 `@anthropic-ai/claude-code` 的反编译/重构版本。`/autofix-pr` 在 fork 中被 stub 化，导致斜杠菜单不可见、不可调起。仓库内远程派发基础设施（teleportToRemote、RemoteAgentTask、reviewRemote.ts 模板）完整可用。

实施基于 `claude.exe` 反编译产物的黄金证据，照抄 `reviewRemote.ts` 模板按 §2.2 差异表改造。

## 验收标准 (Acceptance Criteria)

| ID | 标准 | 验收方法 |
|---|---|---|
| AC1 | 命令在斜杠菜单可见可调起 | dev 模式输入 `/au` 出现 `/autofix-pr` 补全 |
| AC2 | 跨仓 PR 语法生效 | `/autofix-pr anthropics/claude-code#999` 不报 repo-not-allowed |
| AC3 | 远端真正完成修复 | session 完成后目标 PR 出现新 commit |
| AC4 | 不破坏其他 stub | `/share` 等保持 hidden |
| AC5 | TypeScript 严格模式 0 错误 | `bun run typecheck` exit 0 |
| AC6 | bridge 可触发 | RC bridge 触发 `/autofix-pr 386` 能跑通 |
| AC7 | stop 子命令终止 | `/autofix-pr stop` 后任务被 abort，单例锁释放 |
| AC8 | 单例锁生效 | 已监控 PR 时第二次启动被拒，提示 `Run /autofix-pr stop first` |
| AC9 | 测试覆盖 | 4 份测试文件全过；新增模块行覆盖率 ≥ 80% |
| AC10 | bun:test 全绿 | `bun test` exit 0 |

## 子任务 (Subtasks)

| Step | 任务 | 文件 | 行数估计 |
|---|---|---|---|
| 1 | 加 `AUTOFIX_PR` feature flag | `scripts/defines.ts` | +1 |
| 2 | `teleportToRemote` 加 `source?: string` 字段并透传到 sessionContext | `src/utils/teleport.tsx` | +5 |
| 3 | 删 stub，新建命令对象 | `src/commands/autofix-pr/{index.js→.ts}` (删 index.d.ts) | ~50 |
| 4 | 参数解析 | `src/commands/autofix-pr/parseArgs.ts` | ~30 |
| 5 | 单例锁状态管理 | `src/commands/autofix-pr/monitorState.ts` | ~40 |
| 6 | 后台 teammate 创建 | `src/commands/autofix-pr/inProcessAgent.ts` | ~60 |
| 7 | 项目 skills 探测 | `src/commands/autofix-pr/skillDetect.ts` | ~30 |
| 8 | 主流程（照抄 reviewRemote.ts） | `src/commands/autofix-pr/launchAutofixPr.ts` | ~250 |
| 9 | 测试套件（4 文件） | `src/commands/autofix-pr/__tests__/*.test.ts` | ~150 |
| 10 | typecheck + test:all 全绿 | — | — |
| 11 | dev 模式手测四种调用 | — | — |

## 关键差异（vs `reviewRemote.ts`）

| 字段 | reviewRemote (ultrareview) | launchAutofixPr |
|---|---|---|
| `environmentId` | `env_011111111111111111111113` | 不传 |
| `useDefaultEnvironment` | 不传 | `true` |
| `useBundle` | 有（branch mode） | 不传 |
| `skipBundle` | 不传 | （隐含；不传 useBundle 即可） |
| `reuseOutcomeBranch` | 不传 | 传（PR head 分支） |
| `githubPr` | 不传 | 必传 `{owner, repo, number}` |
| `source` | 不传 | `'autofix_pr'`（新增字段） |
| `environmentVariables` | `BUGHUNTER_*` 一组 | 不传 |
| `remoteTaskType` | `'ultrareview'` | `'autofix-pr'` |
| `isLongRunning` | false | `true` |

## 仓库现状盘点

`teleport.tsx` line 947 起的 options interface **已含**: `useDefaultEnvironment` / `onBundleFail` / `skipBundle` / `reuseOutcomeBranch` / `githubPr`。**仅缺** `source` 一个字段。`REMOTE_TASK_TYPES` (line 99) 已含 `'autofix-pr'`，`AutofixPrRemoteTaskMetadata` (line 112) 已定义，`registerRemoteAgentTask` 已 export 并支持 `isLongRunning`。

## Telemetry 事件

```
tengu_autofix_pr_started   { action, has_pr_number, has_repo_path }
tengu_autofix_pr_result    { result: success_rc|failed|cancelled, error_code? }
```

`error_code` 取值：`rc_already_monitoring_other` / `session_create_failed` / `exception`

## Definition of Done

- [ ] 全部 11 步实施完成
- [ ] `bun run typecheck` exit 0（零类型错误）
- [ ] `bun test` exit 0（含新增 4 份测试）
- [ ] 新增模块行覆盖率 ≥ 80%
- [ ] silent-failure-hunter / state-modeler 检查通过
- [ ] code-reviewer + security-reviewer 无 CRITICAL/HIGH
- [ ] `/ask-codex` 交叉复核无遗漏问题
- [ ] dev 模式 4 种调用手测通过（PR# / stop / 跨仓 / 重复锁拒绝）
- [ ] commit message: `feat: implement /autofix-pr command (replace stub)`

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `source` 字段 CCR backend 未识别 | session 仍可创建但 routing 信息缺失 | 字段为可选透传，无副作用；后端识别后自动生效 |
| `subscribePR` API client 不全 | webhook 订阅失败 | `.catch(()=>{})` 容忍 |
| 用户无 CCR 权限 | `checkRemoteAgentEligibility` false | 降级错误文案，不破坏会话 |
| PR 在 fork 仓且 CCR 没访问权 | `git_repository source error` | 前置检查识别并提示用户 |
| 上游恢复官方实现冲突 | merge 冲突 | fork 本地优先，吸收 source/env 字段变更 |

## 依赖

- `teleportToRemote` (`src/utils/teleport.tsx:947`)
- `registerRemoteAgentTask` (`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:526`)
- `checkRemoteAgentEligibility` / `getRemoteTaskSessionUrl` / `formatPreconditionError`
- `detectCurrentRepositoryWithHost` (`src/utils/detectRepository.ts`)
- `feature` from `bun:bundle`

## 回退

```bash
# 完全撤回
git checkout main
git worktree remove E:/Source_code/Claude-code-bast-autofix-pr
git branch -D feat/autofix-pr
```

`AUTOFIX_PR` flag 在 production 默认开启（加入 `DEFAULT_BUILD_FEATURES`），灰度通过保留官方 `feature('AUTOFIX_PR')` 守卫即可单点关停。

## 变更日志

| 日期 | 作者 | 说明 |
|---|---|---|
| 2026-04-29 | Claude Opus 4.7 | 创建 ticket（基于 `docs/features/autofix-pr.md` 770 行规格） |
