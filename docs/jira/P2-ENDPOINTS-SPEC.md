# P2 Endpoints — Reverse-Engineering Spec

**Date:** 2026-04-29
**Binary analyzed:** `C:\Users\12180\.local\bin\claude.exe` (Anthropic official v2.1.123, 253 MB Bun-compiled)
**Method:** `grep -ao` over the binary for path literals, function symbols, JSON keys, telemetry events, and surrounding code fragments.
**Goal:** Decide which P2 endpoints justify fork implementation and produce ready-to-execute plans for the high-value ones.

---

## /v1/skills

### 反向查阅证据

- **路径:**
  - `GET /v1/skills?beta=true` (list)
  - `GET /v1/skills/{skill_id}?beta=true` (get)
  - `GET /v1/skills/{skill_id}/versions?beta=true` (list versions)
  - `GET /v1/skills/{skill_id}/versions/{version}?beta=true` (get specific version)
  - `POST /v1/skills/{skill_id}/versions?beta=true` (publish new version) — `PNH({body:_,...})`
  - Beta gate: `?beta=true` on every call
- **函数符号 (官方 binary):**
  `CreateSkill`, `DeleteSkill`, `GetSkill`, `ListSkills`, `getPluginSkills`, `discoveredRemoteSkills`, `getSessionSkillAllowlist`, `formatSkillLoadingMetadata`, `addInvokedSkill`, `clearInvokedSkillsForAgent`, `cappedSkills`, `bundledSkills`, `dynamicSkillDirs`, `dynamicSkillDirTriggers`, `collectSkillDiscoveryPrefetch`
- **HTTP method 推断:** GET (list/get), POST (publish version) — DELETE/PATCH 在 binary 里没找到对应 path 字符串，疑似只读 marketplace + publish
- **Request 字段:** `allowed_tools`, `owner`, `owner_symbol`, `deprecated`（其他字段被 minify 字典化，未泄漏明文）
- **Response 字段:** 同上 + version metadata（推断含 `created_at`、`version` 字符串）
- **Telemetry:** `tengu_skill_loaded`, `tengu_skill_tool_invocation`, `tengu_skill_tool_slash_prefix`, `tengu_skill_file_changed` （**全部针对本地/bundled，无 marketplace 专属事件**）
- **Fork 已有 utility:**
  - `src/skills/bundled/` 21+ TS skills（不含 marketplace）
  - `src/skills/loadSkillsDir.ts`、`bundledSkills.ts`
  - `src/services/skill-search/`（DiscoverSkillsTool TF-IDF）
  - `src/services/skill-learning/`（自动学习闭环）
  - 缺：远程 marketplace fetch、远程 skill 安装到 `~/.claude/skills/`、版本管理

### 用途推断

`/v1/skills` 是 Anthropic 托管的 skill marketplace（类似 npm/cargo 但只读 + 受限 publish），让用户在 CLI 里浏览/安装/更新由社区或 Anthropic 官方发布的 markdown skill 包。Fork 当前只有 bundled TS skills，**完全没有 user-defined markdown skill 加载机制**（见 `reference_fork_skills_architecture.md` memory），即使复刻这个 endpoint 也需要先实施 markdown skill loader 才能消费下载的内容。

### Fork 是否值得实施

- **价值:** **P2-C（不建议）**
- **工作量估算:** ~1500 行（marketplace API client 300 + version diffing 200 + markdown skill loader 400 + install/update flow 250 + UI picker 200 + tests 150）
- **依赖订阅用户:** **是**（`?beta=true` + Anthropic-managed registry，需 Anthropic API key + 大概率需要 Claude.ai 账号才能拉到非空 list）
- **类比 fork 已有命令:** `/plugin`（plugin marketplace 已恢复，路径类似但 plugin 用本地 git 仓库 + manifest）
- **阻塞依赖:** 必须先实施 markdown skill loader（fork **架构上不存在**）；marketplace 内容需要订阅；社区注册表为空（即使能登录拿到的是 Anthropic-curated 的少数官方 skill）
- **替代方案:** 增强 `/plugin` 命令支持 skill 类型 plugin，用 git clone + 本地 markdown loader 实现等价能力（成本更低、不依赖 Anthropic 后端）

### 推荐 fork 命令外壳

**SKIP — 不实施。** 如果未来要做，路径是：
1. 先实施 markdown skill loader（`~/.claude/skills/<name>/SKILL.md` frontmatter 解析）— 单独 P1 项
2. 复刻 `/plugin` 风格的 `/skills` 命令但 backend 用 git URL 而非 Anthropic API
3. 把 marketplace endpoint 留给上游订阅用户

---

## /v1/code/triggers

### 反向查阅证据

- **路径:**
  - `GET /v1/code/triggers` (list)
  - `POST /v1/code/triggers` (create)
  - `GET /v1/code/triggers/{trigger_id}` (get)
  - `POST /v1/code/triggers/{trigger_id}` (update — **不是** PATCH/PUT)
  - `POST /v1/code/triggers/{trigger_id}/run` (manual fire)
  - DELETE 没在 binary 里看到独立 path（推断走 update 设 `enabled:false` 或独立 archive）
- **函数符号:** `RemoteTrigger`, `RemoteTriggerTool`, `createTrigger`, `RemoteAgentTask`, `RemoteAgentMetadata`, `RemoteAgentsSkill`, `registerScheduleRemoteAgentsSkill`, `addSessionCronTask`, `getRoutineCronTasks`, `getSessionCronTasks`, `removeSessionCronTasks`, `cancelAllPendingLoopSessionCrons`, `buildCronCreateDescription`, `buildCronCreatePrompt`, `buildCronListPrompt`, `buildCronDeletePrompt`, `getCronJitterConfig`, `isDurableCronEnabled`, `isKairosCronEnabled`
- **HTTP method 完整证据:**（binary 文档串）
  - `create: POST /v1/code/triggers`
  - `update: POST /v1/code/triggers/{trigger_id}`
  - `run: POST /v1/code/triggers/{trigger_id}/run`
  - `list: GET /v1/code/triggers`
  - `get: GET /v1/code/triggers/{trigger_id}`
- **Request 字段:** `cron`, `cron_expression`, `enabled`, `prompt`, `schedule`, `cron_hour`, `cron_minute`, `team_memory_enabled`, `agent_id`（推断，触发器关联到一个 agent）
- **Response 字段:** `trigger_id`, `next_run`, `last_run`, `enabled`, `scheduled_task_fire`（telemetry 名）
- **Telemetry:** **没有** `tengu_trigger_*` 专属事件（被 ultraplan/sedge 等其他系统的事件覆盖；`scheduled_task_fire` 是状态字符串，不是 telemetry）
- **关联 fork:**
  - `/agents-platform` 已实现（`agentsApi.ts` 调 `/v1/agents`）— **Triggers 是给 Agents 加 cron 调度，关系 = "trigger refs agent"**
  - `/schedule` skill（在 user `~/.claude/skills/` 列表里）= 这个 endpoint 的 user-facing 入口
  - 缺：fork **没有** `/schedule` 命令、没有 trigger CRUD client
- **关联 description / 错误文案:** `"Schedule a recurring cron that runs those tasks each tick"`, `"Scheduled recurring job"`, `"Scheduled token refresh for session"`

### 用途推断

让用户给已创建的 remote agent（`/v1/agents`）挂上 cron 调度：例如"每天早上 9 点跑这个 agent，给我一份昨天 PR 状态摘要"。是 `/agents-platform` 的姐妹功能，**没有它，agent 只能手动跑**。绑定到 Anthropic 后端 + Claude.ai 账号（订阅用户的 cloud 远程 agent，跟本地 cron 完全不同）。

### Fork 是否值得实施

- **价值:** **P2-A（高）**
- **工作量估算:** ~480 行（triggersApi.ts 130 + index.tsx 80 + launchSchedule.tsx 90 + ScheduleView.tsx 120 + parseArgs.ts 30 + tests 30）
- **依赖订阅用户:** **是**（POST /v1/code/triggers 需要 Bearer auth，订阅用户才有可见 trigger 列表）— 但 fork 已经接受这个前提（参考 `/agents-platform` 已上线）
- **类比 fork 已有命令:** `/agents-platform`（同 backend 家族 + 同 auth 模型 + 同 list/get/create/delete UI 模式）

### 推荐 fork 命令外壳

- **命令名:** `/schedule`
- **子命令:** `list` / `get <id>` / `create <args>` / `update <id> <args>` / `run <id>` / `delete <id>` / `enable <id>` / `disable <id>`
- **类型:** local-jsx
- **aliases:** `/cron`, `/triggers`
- **估算行数:**
  - `index.tsx` ~80（command def + `userFacingName`+ subcommand router）
  - `launchSchedule.tsx` ~90（router 选择 list/get/create/update/run/delete + JWT 注入）
  - `triggersApi.ts` ~130（5 个 CRUD + run，复用 `agentsApi.ts` 的 fetch + auth 模式）
  - `ScheduleView.tsx` ~120（trigger table、cron 解析显示 next_run、状态切换）
  - `parseArgs.ts` ~30（cron 表达式校验、agent_id 解析、`--enabled` flag）
  - `__tests__/schedule.test.ts` ~30
- **配套整合:** complementary skill 已存在（user `~/.claude/skills/schedule/`），fork 可在 launcher 里支持 `--from-skill` 调用 skill 的 prompt 然后落到这个 API

---

## /v1/memory_stores

### 反向查阅证据

- **路径:**
  - `POST /v1/memory_stores` (create)
  - `GET /v1/memory_stores` (list)
  - `GET /v1/memory_stores/{memory_store_id}` (get)
  - `POST /v1/memory_stores/{memory_store_id}/archive` (archive — soft delete)
  - `GET /v1/memory_stores/{memory_store_id}/memories` (list memories in store)
  - `PATCH /v1/memory_stores/{memory_store_id}/memories` (bulk patch)
  - `GET /v1/memory_stores/{memory_store_id}/memories/{memory_id}` (get individual memory)
  - `POST /v1/memory_stores/{memory_store_id}/memory_versions` (create version)
  - `GET /v1/memory_stores/{memory_store_id}/memory_versions/{version_id}` (get version)
  - `POST /v1/memory_stores/{memory_store_id}/memory_versions/{version_id}/redact` (PII redaction)
- **函数符号:** `CreateMemoryStore`, `GetMemoryStore`, `ListMemoryStores`, `UpdateMemoryStore`, `DeleteMemoryStore`, `ArchiveMemoryStore`
- **HTTP method:** GET / POST / PATCH（多动词，明文已泄漏在 `\r\n` 换行串里）
- **Request 字段:** `memories`（数组）, `namespace`, `redacted_thinking`（其他字段未泄漏）
- **Response 字段:** 推断含 `memory_store_id`, `memory_id`, `version_id`, `archived_at`, `redacted_at`
- **Telemetry:** `tengu_memory_survey_event`, `tengu_memory_threshold_crossed`, `tengu_memory_toggled`, `tengu_memory_write_survey_event` — **不是** memory_stores 专属，是本地 `extractMemories` / `SessionMemory` 服务的事件
- **关联 fork 已有 utility:**
  - `/memory` 命令已存在（`src/commands/memory/`）— 但管理本地 `~/.claude/memory/` 文件
  - `src/services/extractMemories/`（自动 extract）
  - `src/services/SessionMemory/`（session 级 memory）
  - **缺:** 远程 memory_stores（多 store 命名空间 + 版本控制 + 跨设备同步 + redact）

### 用途推断

Anthropic 托管的 memory 持久化层，跟本地 `auto_memory_*.md` 文件的关系类似：本地文件 = 单机 markdown，memory_stores = 跨设备/跨 session 的命名空间化 + 版本化 + PII redact 服务。订阅用户在不同机器之间同步 memory；redact endpoint 让用户主动删除已存储的敏感信息（GDPR 合规）。

### Fork 是否值得实施

- **价值:** **P2-B（中）**
- **工作量估算:** ~600 行（memoryStoresApi.ts 200 + index.tsx 90 + launchMemoryStore.tsx 120 + MemoryStoreView.tsx 130 + parseArgs.ts 30 + tests 30）
- **依赖订阅用户:** **是**（cloud 持久化必须有 Anthropic auth）
- **类比 fork 已有命令:** `/memory`（本地）+ `/agents-platform`（远程 CRUD 模式）
- **价值降级理由:** fork 现在有非常强的本地 memory 体系（`~/.claude/projects/<project>/memory/*.md` + `extractMemories` + 7-day staleness），90% 用户场景不需要远程 store。Marginal value 主要给"多机器同步"用户。

### 推荐 fork 命令外壳

- **命令名:** `/memory-stores`（避免冲突现有 `/memory`）
- **子命令:** `list` / `get <id>` / `create <name>` / `archive <id>` / `memories <store_id>` / `memory <store_id> <memory_id>` / `version <store_id> <version_id>` / `redact <store_id> <version_id>`
- **类型:** local-jsx
- **aliases:** `/ms`, `/remote-memory`
- **估算行数:**
  - `index.tsx` ~90
  - `launchMemoryStore.tsx` ~120（subcommand router）
  - `memoryStoresApi.ts` ~200（10 个端点，复用 agentsApi 模式）
  - `MemoryStoreView.tsx` ~130（store list + drill-down）
  - `parseArgs.ts` ~30
  - tests ~30
- **配套整合:** 在 `/memory` 命令里加 `--push` flag 把本地 memory 推到默认 store（联动）— 单独跟进项

---

## /v1/vaults

### 反向查阅证据

- **路径:**
  - `GET /v1/vaults` (list — POST 推断为 create)
  - `GET /v1/vaults/{vault_id}` (get)
  - `POST /v1/vaults/{vault_id}/archive` (archive)
  - `GET /v1/vaults/{vault_id}/credentials` (list credentials in vault)
  - `GET /v1/vaults/{vault_id}/credentials/{credential_id}` (get credential)
  - `POST /v1/vaults/{vault_id}/credentials/{credential_id}/archive` (archive credential)
- **函数符号:** `CreateVault`, `GetVault`, `ListVaults`, `UpdateVault`, `DeleteVault`, `ArchiveVault`, `nVaults`（数量统计）
- **HTTP method 推断:** GET（list/get）+ POST（archive）+ 推断 POST（create/update credentials）
- **Request 字段:** `kind`, `secret`, `vault_ids`（其他字段未泄漏；secret 推断是 credential value，类型 enum 含 `kind`）
- **Response 字段:** 推断 `vault_id`, `credential_id`, `archived_at`, `kind`（不返回 secret 明文，仅 metadata）
- **Telemetry:** **零** `tengu_vault_*` 事件（保护 secret 路径不上报 telemetry，符合安全最佳实践）
- **关联 fork:** **完全无** vault 相关代码

### 用途推断

Anthropic 托管的 secrets vault，让 remote agents（`/v1/agents`）+ triggers（`/v1/code/triggers`）在 cloud 执行时安全地拿到 API key、SSH key、OAuth token 等敏感信息。**不是给本地 CLI 用户管 secret 的** — fork 本地 CLI 已经能直接读环境变量。这是 cloud-first 体验的依赖项。

### Fork 是否值得实施

- **价值:** **P2-C（不建议）**
- **工作量估算:** ~550 行（vaultsApi.ts 180 + index.tsx 90 + launch 110 + view 120 + parseArgs 25 + tests 25）
- **依赖订阅用户:** **是**（强依赖，core feature is cloud secret injection — 本地用户根本用不到）
- **类比 fork 已有命令:** 无；最接近 `/agents-platform`
- **价值降级理由:**
  1. fork 用户主要在本地跑 CLI，secret = 环境变量 / `.env` / OS keyring，**不需要 cloud vault**
  2. 没有 `/v1/code/triggers` 实装时，vault 没有消费方
  3. Vault binary 里 0 telemetry → 上游也认为这是 plumbing 不是 hero feature
  4. 安全敏感路径（参 `~/.claude/rules/deep-debug/security.md`），CLI client 实施 cloud secret 操作风险高
- **替代方案:** 不实施；如果用户有跨命令复用 secret 需求，推荐用 `gh auth` / `pass` / OS keyring 集成（独立 P3 项）

### 推荐 fork 命令外壳

**SKIP — 不实施。** 等到 `/schedule` + `/memory-stores` 上线后用户提出真实需求再考虑。

---

## /v1/ultrareview/preflight

### 反向查阅证据

- **路径:** `POST /v1/ultrareview/preflight`（仅一个端点，不像其他端点是完整 CRUD 家族）
- **函数符号:** `fetchUltrareviewPreflight`, `launchUltrareview`, `hasSeenUltrareviewTerms`, `UltrareviewPreflight`, `UltrareviewTerms`, `ultrareviewHandler`
- **HTTP method:** POST（headers `{...Lf(q),...}`，body 推断含 PR 引用）
- **Request 字段:** 推断 `pr_url` / `pr_number` / `repo` / `confirm` flag (从 `launchUltrareview(H, q?.confirm??false)` 推断)
- **Response 字段:** Zod schema 已泄漏明文：
  ```js
  vq.object({
    action: vq.enum(["proceed", "confirm", "blocked"]),
    billing_note: vq.string().nullable().optional(),
    // ...其他字段被截断
  })
  ```
- **Telemetry:** `tengu_review_overage_blocked`, `tengu_review_remote_teleport_failed`, `ultrareview_launch`（subtype）
- **关联错误文案:**
  - `"Ultrareview is currently unavailable."`
  - `"Ultrareview is unavailable for your organization."`
  - `"Ultrareview requires a Claude.ai account. Run /login to authenticate."`
  - `"Repo is too large. Push a PR and use /ultrareview <PR#> instead."`
  - `"Ultrareview runs in Claude Code on the web and is unavailable when essential-traffic-only mode is active."`
  - `"Ultrareview launched for ${j} (${Sl()}, runs in the cloud). Track: ${J}"`
- **关联 fork 已有 utility:**
  - `src/commands/review/ultrareviewCommand.tsx` — 命令骨架已存在
  - `src/commands/review/ultrareviewEnabled.ts` — feature gate
  - `src/commands/review/UltrareviewOverageDialog.tsx` — overage UI
  - `src/services/api/ultrareviewQuota.ts` — quota check
  - `src/commands/review/reviewRemote.ts` — remote launch
  - **缺:** preflight call **没接进 launch 流程**（fork 直接 launch，跳过 confirm/blocked 分流）

### 用途推断

`/preflight` 在 launch 之前问 Anthropic 后端三件事：(1) 当前 PR 大小是否超 quota → `blocked`；(2) 当前用量是否进入收费区间 → `confirm` + `billing_note`（"this run will cost ~$3"）；(3) 一切 OK → `proceed`。Fork 当前直接 launch 会让用户在使用超额时被静默扣钱或失败，体验不好但不致命。

### Fork 是否值得实施

- **价值:** **P2-A（高）**
- **工作量估算:** ~250 行（preflightApi.ts 80 + 扩展 ultrareviewCommand 60 + PreflightDialog.tsx 80 + tests 30）
- **依赖订阅用户:** **是** — 但 fork 已经把整个 ultrareview 当成订阅功能（非订阅用户走 `ultrareviewEnabled.ts` 早 return）
- **类比 fork 已有命令:** `/ultrareview`（本身已存在，preflight 只是补缺失的步骤）

### 推荐 fork 命令外壳

**不需要新命令** — 增强已有 `/ultrareview`：

- 文件改动:
  - 新增 `src/services/api/ultrareviewPreflight.ts` ~80（fetchUltrareviewPreflight + Zod schema for `{action, billing_note}`）
  - 修改 `src/commands/review/ultrareviewCommand.tsx` +50（在 `launch` 之前 await preflight，分流 proceed/confirm/blocked）
  - 新增 `src/commands/review/UltrareviewPreflightDialog.tsx` ~80（confirm 状态时显示 billing_note + Yes/No）
  - 修改 `src/components/PromptInput/PromptInput.tsx` 已有 ultrareview hook，可能需小调整
  - tests `src/services/api/__tests__/ultrareviewPreflight.test.ts` ~30
- **重要:** `blocked` 状态显示 binary 里的明文文案（保持与官方一致），不要自创错误信息

---

## 总优先级表

| Endpoint | 价值 | 估算行数 | 依赖订阅 | 推荐顺序 | fork 命令 |
|----------|:---:|:---:|:---:|:---:|---|
| `/v1/code/triggers` | **P2-A** | ~480 | 是 | **1** | `/schedule` (new) |
| `/v1/ultrareview/preflight` | **P2-A** | ~250 | 是 | **2** | enhance `/ultrareview` |
| `/v1/memory_stores` | P2-B | ~600 | 是 | 3（可选） | `/memory-stores` (new) |
| `/v1/skills` | P2-C | ~1500 | 是 | SKIP | — |
| `/v1/vaults` | P2-C | ~550 | 是 | SKIP | — |

**P2-A 总投入:** ~730 行（triggers 480 + preflight 250），约 1-2 工作日，无 commands.ts 冲突（两个改动是独立目录 + 一个增强已有命令）。

**实施推荐顺序（避免 commands.ts 冲突）:**
1. **先做 `/v1/ultrareview/preflight`**（不新增 commands.ts 条目，仅增强 ultrareviewCommand → 零冲突，立刻可上线）
2. **再做 `/v1/code/triggers`** as `/schedule`（新增 commands.ts 1 条，参考 `/agents-platform` 模式）
3. **`/v1/memory_stores`** 视用户反馈再上 — 实施前先设计如何与 `/memory` 联动避免认知混淆
4. **`/v1/skills` 和 `/v1/vaults` SKIP** — 前者依赖 markdown skill loader（fork 架构缺失），后者本地用户不需要

---

## 实施 Plan A — `/v1/ultrareview/preflight`（P2-A 第 1 优先）

### 范围

补全 fork `/ultrareview` 命令的 preflight 检查：launch 前调 `POST /v1/ultrareview/preflight`，根据 `action` 分流 `proceed` / `confirm` / `blocked`，对齐官方 v2.1.123 行为。

### 上游证据

- 函数 `fetchUltrareviewPreflight`、`launchUltrareview(H,q?.confirm??false)`
- Zod schema: `{action: enum(["proceed","confirm","blocked"]), billing_note: string().nullable().optional()}`
- 错误文案表（见上）

### 文件清单（按此精确改）

| 文件 | 改动类型 | 行数估计 |
|---|---|---|
| `src/services/api/ultrareviewPreflight.ts` | NEW | ~80 |
| `src/services/api/__tests__/ultrareviewPreflight.test.ts` | NEW | ~30 |
| `src/commands/review/ultrareviewCommand.tsx` | EDIT | +50 |
| `src/commands/review/UltrareviewPreflightDialog.tsx` | NEW | ~80 |
| `src/commands/review/__tests__/ultrareviewCommand.test.tsx` | EDIT | +20 |

### 实施步骤

1. **创建 `ultrareviewPreflight.ts`:**
   - export `fetchUltrareviewPreflight(args: {pr_url?: string, pr_number?: number, repo: string, confirm?: boolean}): Promise<{action: 'proceed'|'confirm'|'blocked', billing_note: string|null} | null>`
   - 调 `POST /v1/ultrareview/preflight` 复用 `src/services/api/claude.ts` 的 auth header 注入（参考已有 `ultrareviewQuota.ts`）
   - Zod schema 校验响应；mismatch 时 log warning + return null（不抛错）
2. **创建 `UltrareviewPreflightDialog.tsx`:**
   - props: `{billingNote: string|null, onConfirm(), onCancel()}`
   - Ink 组件，显示 billing_note + 两个按钮 `Proceed` / `Cancel`
   - 复用 `src/components/design-system/Dialog`
3. **修改 `ultrareviewCommand.tsx`:**
   - 在调 `reviewRemote.ts` launch 之前 `await fetchUltrareviewPreflight(...)`
   - `action === 'blocked'`: 显示 `"Ultrareview is currently unavailable."`（或 `billing_note` 如果有），return
   - `action === 'confirm'`: 渲染 `<UltrareviewPreflightDialog>` → 用户点 Proceed 后才 launch
   - `action === 'proceed'`: 直接 launch
   - preflight 返回 null（schema mismatch / network）: fallback 到当前直接 launch 行为 + warning toast
4. **测试:**
   - `ultrareviewPreflight.test.ts`: schema 校验 3 个 case（valid proceed / valid blocked / invalid → null）
   - `ultrareviewCommand.test.tsx`: mock fetchUltrareviewPreflight 三种返回，断言分流正确

### 验证命令

```bash
cd E:/Source_code/Claude-code-bast-autofix-pr && bun run typecheck && bun test src/services/api/__tests__/ultrareviewPreflight.test.ts src/commands/review/__tests__/ultrareviewCommand.test.tsx
```

### 边界条件

- 网络失败 / 超时 / 401: 返回 null，fallback 到直接 launch（保持当前行为，不破坏现有用户）
- `billing_note` 为 null but action='confirm': 显示通用文案 `"This run may incur additional cost."`
- 用户通过 `--confirm` flag 显式跳过 dialog：直接传 `confirm:true` 给 preflight

### 不做

- 不改 `ultrareviewQuota.ts`（独立机制，preflight 是 quota 的上层）
- 不改 telemetry（fork 没有上报 ultrareview 事件，保持）
- 不本地化错误文案（与官方保持英文一致）

### 输出格式

implementer 报告：(1) 5 个文件 diff 摘要；(2) typecheck 输出；(3) test pass count；(4) 三种 action 各跑一次手动验证截图（如能）。

### SKIP 路径

如果发现 fork 的 `ultrareviewQuota.ts` 已经做了等价 preflight 检查 → 报告并停止；不要重复实现。

---

## 实施 Plan B — `/v1/code/triggers` as `/schedule`（P2-A 第 2 优先）

### 范围

新增 `/schedule` 命令实现 cloud-side trigger CRUD，让用户给 `/v1/agents` 创建/管理/触发 cron 调度。复用 `/agents-platform` 的 API client + UI 模式。

### 上游证据

- 完整 CRUD verb 表（见上）：`create POST /v1/code/triggers` / `update POST /v1/code/triggers/{id}` / `run POST .../run` / `list GET` / `get GET .../{id}`
- 函数 `RemoteTrigger`, `RemoteTriggerTool`, `createTrigger`, `RemoteAgentsSkill`, `addSessionCronTask`, `buildCronCreatePrompt`
- 字段 `cron`, `cron_expression`, `enabled`, `prompt`, `cron_hour`, `cron_minute`, `team_memory_enabled`
- 命令字面量: `"schedule",aliases:[...]`

### 文件清单

| 文件 | 改动类型 | 行数估计 |
|---|---|---|
| `src/commands/schedule/triggersApi.ts` | NEW | ~130 |
| `src/commands/schedule/index.tsx` | NEW | ~80 |
| `src/commands/schedule/launchSchedule.tsx` | NEW | ~90 |
| `src/commands/schedule/ScheduleView.tsx` | NEW | ~120 |
| `src/commands/schedule/parseArgs.ts` | NEW | ~30 |
| `src/commands/schedule/__tests__/schedule.test.ts` | NEW | ~30 |
| `src/commands.ts` | EDIT | +1 行注册 |

### 实施步骤

1. **复制 `src/commands/agents-platform/agentsApi.ts` → `triggersApi.ts`**:
   - 替换路径 `/v1/agents` → `/v1/code/triggers`
   - 5 个方法：`listTriggers`, `getTrigger(id)`, `createTrigger(body)`, `updateTrigger(id, body)`, `runTrigger(id)`
   - 类型 `Trigger = {trigger_id, cron_expression, enabled, prompt, agent_id, last_run?, next_run?}`
2. **`parseArgs.ts`:**
   - 解析 subcommand：`list | get <id> | create <args> | update <id> <args> | run <id> | enable <id> | disable <id>`
   - cron 表达式校验（reuse `cron-parser` 或 fork 现有 utility，如果有）
3. **`ScheduleView.tsx`:**
   - 复用 `AgentsPlatformView.tsx` 的 table 风格
   - 列：trigger_id (truncated), agent_id, cron, enabled, next_run
   - 详情 drill-down 显示完整 prompt
4. **`launchSchedule.tsx`:**
   - subcommand router 调对应 API method
   - create 时 prompt 用户输入 agent_id（或从 `/agents-platform` list 选）
   - enable/disable = update 改 `enabled` 字段
5. **`index.tsx`:**
   - command def `userFacingName: 'schedule'`, aliases `['cron','triggers']`, type `local-jsx`
6. **`commands.ts`:**
   - 在主 `COMMANDS = memoize([...])` 数组加 `scheduleCommand`（不要放 `INTERNAL_ONLY_COMMANDS` — 见 `project_stub_recovery_2026_04_29.md` memory）

### 验证命令

```bash
cd E:/Source_code/Claude-code-bast-autofix-pr && bun run typecheck && bun test src/commands/schedule/__tests__/schedule.test.ts
```

### 边界条件

- 401 / 订阅过期: 显示 `"Schedule requires a Claude.ai subscription. Run /login."`（与 ultrareview 文案对齐）
- 空 trigger 列表: 友好提示 + 推荐 `--help`
- 无效 cron 表达式: 客户端 parse 失败立即报错，不打 API
- agent_id 不存在: API 返回 404，显示 `"Agent {id} not found. Use /agents-platform to verify."`

### 不做

- 不实施本地 cron daemon（fork 已有 `daemon` 模块但跟这个 cloud trigger 是独立体系）
- 不实施 `team_memory_enabled` 字段 UI（先支持核心 cron + prompt + agent，team memory 留 follow-up）
- 不实现 trigger DELETE（binary 里 path 不明确，先用 archive 或 enabled:false）

### 输出格式

implementer 报告：(1) 7 个文件 diff；(2) typecheck 输出；(3) test pass；(4) 手动 list/create/run 端到端验证（如有 Anthropic API key + 测试账号）。

### SKIP 路径

- 如果发现 binary 里 trigger DELETE 端点存在的更明确证据，可加 deleteTrigger；否则只支持 archive。
- 如果 fork 已有用 `RemoteTriggerTool`（按 grep 提示 `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` 引用），先 read 确认无重叠，避免重写。

---

**End of spec.** 实施 Plan A 和 B 可独立并行（无 commands.ts 顺序依赖：Plan A 不动 commands.ts；Plan B 加一行）。Plan A 优先因为它是 *enhancement* 不是 *new command*，破坏面更小。
