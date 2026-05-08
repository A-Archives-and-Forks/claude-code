# 内部命令解锁与 Stub 恢复总规划

> **状态**：规划阶段 → 即将进入实施
> **基于**：反向查阅 `C:/Users/12180/.local/bin/claude.exe` v2.1.123 字符串 + fork 代码残留扫描
> **验收**：订阅用户视角（claude-ai availability），所有可恢复命令在 `/help` 出现且可调用

## 一、命令分级（基于反向查阅 + 代码残留）

### A. 已是完整实现，只需移到主 COMMANDS 数组 — **零代码工作量**

| 命令 | 行数 | 性质 | 订阅用户价值 |
|---|---|---|---|
| `/bridge-kick` | 200 | bridge 故障注入调试器（RC 测试） | 中（开发/调试 RC 时） |
| `/init-verifiers` | 262 | 创建项目 verifier skills（quality-gate 自动化） | **高**（quality-gate 高频功能） |
| `/commit` | 92 | git commit 命令 | **高**（每天用） |
| `/commit-push-pr` | 158 | commit + push + 创建 PR | **高**（高频开发流） |

### B. 底层完整 + 1 行 stub launcher，仿 autofix-pr 模式恢复

| 命令 | 底层证据 | 工作量 |
|---|---|---|
| `/teleport` | `src/utils/teleport.tsx` 已 export 5+ utility，官方 19 个 `tengu_teleport_*` 事件可对标 | ~150 行 launcher |
| `/share` | sessions API 已有（订阅 endpoint），需 launcher | ~150 行 |

### C. 纯本地命令（无需 Anthropic 后端，可自主实现替代）

| 命令 | 字面意思 → 自主替代设计 | 工作量 |
|---|---|---|
| `/env` | dump 本地 env vars + config（白名单字段） | ~60 行 |
| `/ctx_viz` | 当前会话 context 可视化（messages 数 + token 分布 + role）；类似系统 `CtxInspect` 工具 | ~100 行 |
| `/debug-tool-call` | 列出最近 N 个 tool call 的 input/output | ~80 行 |
| `/perf-issue` | 本地 metrics 导出：token 用量、响应延迟、cache hit、tool count；写到 `~/.claude/perf-reports/` | ~120 行 |
| `/break-cache` | 强制下次请求清空 prompt cache（在系统 prompt 后插入 ephemeral cache_control 标记） | ~50 行 |

### D. GitHub API 类（订阅用户可用，需 GitHub token）

| 命令 | 设计 | 工作量 |
|---|---|---|
| `/issue` | 创建当前仓库的 GitHub issue（用 `gh` CLI 或 GraphQL） | ~150 行 |

### E. 不做（无替代价值或已有等价命令）

| 命令 | 不做原因 |
|---|---|
| `/onboarding` | 一次性引导，订阅用户不需要 |
| `/bughunter` | 已被 `/ultrareview` 完全替代 |
| `/good-claude` | Anthropic 内部反馈收集，无替代价值 |
| `/backfill-sessions` | 需要 Anthropic admin endpoint，fork 无后端 |
| `/ant-trace` | Anthropic 内部 trace 系统 |
| `/agents-platform` | Anthropic agents platform 集成 |
| `/mock-limits` | QA 内部测试用 |
| `/reset-limits` / `/reset-limits-non-interactive` | 需要 Anthropic admin endpoint 重置用户配额 |

## 二、实施顺序（全自主执行）

### Phase 1：零代码移动（5 分钟）⭐ 立即收益最大

操作：从 `INTERNAL_ONLY_COMMANDS` 移到主 `COMMANDS` 数组：
- `commit`
- `commitPushPr`
- `bridgeKick`
- `initVerifiers`

仅改 `src/commands.ts` 一处。

### Phase 2：仿 autofix-pr 模式恢复（约 2 小时）

- Step 2.1：`/teleport` launcher（最易，底层全在）
- Step 2.2：`/share` launcher

### Phase 3：纯本地命令（约 2 小时）

- Step 3.1：`/env`
- Step 3.2：`/ctx_viz`
- Step 3.3：`/debug-tool-call`
- Step 3.4：`/perf-issue`
- Step 3.5：`/break-cache`

### Phase 4：GitHub 类（约 30 分钟）

- Step 4.1：`/issue`

### Phase 5：验证

- `bun run typecheck`：0 错误
- `bun test`：现有测试不破坏 + 新命令测试通过
- `bun run build`：生成 dist
- `bun --feature ...verify-*.ts`：每个新命令的注册验证脚本

## 三、风险与回退

| 风险 | 缓解 |
|---|---|
| 移到主数组后，命令依赖 Anthropic 内部 API 才能工作（如 `/bridge-kick`） | 命令对象设 `isHidden: false` 但保留环境检查逻辑（如 RC 未启动时报错友好） |
| `/commit` 命令与用户 git workflow 冲突 | 先看 commit.ts 现状（已 92 行实现），不动逻辑，只改注册 |
| `/teleport` 与 `/autofix-pr` 类似的 source 字段问题 | 复用 `/autofix-pr` 学到的 lock pattern + skipBundle 决策 |
| 反向查阅误判（某命令官方公开但实际依赖内部 API） | 命令实现失败时给清晰错误文案，不破坏会话 |

## 四、验收标准（订阅用户视角）

- [ ] `/help` 中显示新增/解锁的命令
- [ ] `/au` Tab 出现 `/autofix-pr` 补全（已修，待验证）
- [ ] `/te` Tab 出现 `/teleport` 补全
- [ ] `/com` Tab 出现 `/commit` 和 `/commit-push-pr`
- [ ] `/init-verifiers` 跑出 verifier skill 创建提示
- [ ] `/env` 显示当前 env / config
- [ ] `bun run typecheck` 0 错误
- [ ] `bun test` 全过

## 变更日志

| 日期 | 改动 |
|---|---|
| 2026-04-29 | 初版规划（基于反向查阅 v2.1.123 + 代码残留扫描） |
