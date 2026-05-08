# 上游 v2.1.089 → v2.1.123 差异分析

> 调研日期：2026-04-29
> 数据源：
> - GitHub `anthropics/claude-code` `CHANGELOG.md`（WebFetch，主要数据源，覆盖 2.1.97 → 2.1.123）
> - 全局二进制 `C:\Users\12180\.local\bin\claude.exe`（v2.1.123，253MB Bun native binary，编译时间 2026-04-29）字符串反向查阅（telemetry 事件 / FEATURE flag / API endpoint / 注册命令名）
> - Fork 自身版本：`package.json` `claude-code-best@1.10.10`
>
> 注意：v2.1.89 的 changelog 条目在 GitHub 主仓库 `CHANGELOG.md` 中已被裁剪（Anthropic 滚动保留近 30 个版本），fetch 到该位置返回 truncation 提示。本报告 v2.1.89~v2.1.96 的内容 inferred from binary 字符串和 v2.1.97 的"Fixed"项倒推（标注 `[binary-only]`）。

---

## 摘要

- **版本号跨度**：v2.1.089 → v2.1.123，共 35 个 patch 版本（实际发布 ≈ 25 个，部分编号跳过：100/102/103/104/106/115）
- **核心新增方向**：
  1. **Auto Mode**（自治执行）从实验性走向正式：v2.1.111 起不再要求 `--enable-auto-mode`，v2.1.118 加 "Don't ask again"，v2.1.117 起 Pro/Max 默认 effort=high
  2. **Ultraplan / Ultrareview / Advisor**（新一代深度推理工作流）：v2.1.108~v2.1.120 持续完善，v2.1.120 加 `claude ultrareview <target>` headless 子命令
  3. **TUI/Fullscreen 重构**：v2.1.110 加 `/tui` 命令切换 flicker-free 渲染，v2.1.116 优化滚动，v2.1.121 滚动对话框可键盘+鼠标导航
  4. **Native binary 分发**：v2.1.113 起 CLI spawn native binary 代替 bundled JS（per-platform optional dep）
  5. **Voice Mode / Push Notifications**：v2.1.110 push 通知工具，v2.1.122 Caps Lock 报错提示
  6. **Skills 体系强化**：v2.1.108 起 model 可发现/调用内置 slash 命令；v2.1.117 listing cap 250→1536；v2.1.121 加 type-to-filter；v2.1.120 支持 `${CLAUDE_EFFORT}` 模板
  7. **MCP / OAuth 大量修复**：每版数十条
  8. **Plugin 体系**：v2.1.117~v2.1.121 依赖解析、版本约束、`plugin tag`、`plugin prune`、`alwaysLoad` 配置
- **新增/移除命令**：见下方矩阵（净新增 ≥ 7 个：`/tui`、`/focus`、`/recap`、`/undo`(alias)、`/proactive`(alias)、`/ultrareview`、`/team-onboarding`、`/less-permission-prompts`、`/usage`(合并 `/cost`+`/stats`）；移除 0 个，但 `/cost` `/stats` 已合并）
- **新增 API endpoint**（v123 binary 反向查阅）：`/v1/agents`、`/v1/skills`、`/v1/code/triggers`、`/v1/code/sessions`、`/v1/code/upstreamproxy/ws`、`/v1/environments/bridge`、`/v1/memory_stores`、`/v1/security/advisories/bulk`、`/v1/ultrareview/preflight`、`/v1/vaults`、`/v2/ccr-sessions/`
- **新增 telemetry 事件**：v123 binary 共 1081 个 `tengu_*` 事件（包含 `tengu_advisor_*` 6、`tengu_ultraplan_*` 13、`tengu_kairos_*` 9、`tengu_amber_*` 10、`tengu_teleport_*` 17、`tengu_ccr_*` 5、`tengu_brief_*` 3、`tengu_powerup_*` 2、`tengu_skill_*` 4 等成簇出现）
- **新增 feature flag**：v123 binary `FEATURE_*` 字符串多为 Bun runtime 内置（`FEATURE_FLAG_DISABLE_*`），**Anthropic 业务 feature flag 在 v2.1.x 已切换到运行时配置/环境变量（`CLAUDE_CODE_*`），不再使用 `FEATURE_<NAME>` 命名空间**——这一点与 fork 当前的 `bun:bundle` `feature()` 模式存在分歧

---

## 详细变更

### 新增命令

| 命令 | 何时引入 | 描述 | fork 是否已有 |
|---|---|---|---|
| `/tui` | 2.1.110 | 切换 fullscreen / inline 渲染（`/tui fullscreen` 进入 flicker-free 模式，可在同一对话中切换）。设置项 `tui` | ❌ 无 |
| `/focus` | 2.1.110 | 单独的 focus view 切换（之前与 `Ctrl+O` 复用），仅显示 prompt+工具摘要+最终响应 | ❌ 无 |
| `/recap` | 2.1.108 | 返回 session 时提供上下文回顾，可在 `/config` 配置或手动调用，`CLAUDE_CODE_ENABLE_AWAY_SUMMARY` 可强制启用 | ❌ 无 |
| `/undo`（alias `/rewind`） | 2.1.108 | rewind 别名 | ⚠️ 需确认 `/rewind` 实现 |
| `/proactive`（alias `/loop`） | 2.1.105 | `/loop` 别名 | ⚠️ 需确认 `/loop` 实现 |
| `/ultrareview` | 2.1.111 | 云端并行多 agent 代码审查；无参审查当前分支，`/ultrareview <PR#>` 拉 GitHub PR 审查；v2.1.120 加 `claude ultrareview` headless | ❌ 无（cloud-only，需 `/v1/ultrareview/preflight` endpoint） |
| `/team-onboarding` | 2.1.101 | 从本地 Claude Code 使用情况生成 teammate ramp-up guide | ❌ 无 |
| `/less-permission-prompts` | 2.1.111 | 扫描历史 transcript，提议 `.claude/settings.json` 的优先级 allowlist | ❌ 无 |
| `/usage` | 2.1.118 | 合并 `/cost` + `/stats`，两者保留为别名 | ⚠️ 需确认 fork 状态 |
| `/effort`（无参 slider 模式） | 2.1.111 | 无参时打开交互 slider，`xhigh` 介于 `high` 和 `max` 之间（仅 Opus 4.7） | ⚠️ fork 有 `/effort` 但 slider/`xhigh` 未确认 |
| `/branch` | ≤2.1.116 | 从当前 session 分叉新对话（v2.1.116/v2.1.122 持续修 fix） | ⚠️ 需确认 fork 状态 |
| `/fork` | ≤2.1.118 | 类似 branch（与 branch 关系待查） | ⚠️ 需确认 |
| `/extra-usage` | 2.1.113 | 远程客户端可调用的额外用量信息 | ❌ 无 |
| `/insights` | 2.1.101 / 2.1.113 | 报告生成（v2.1.113 fixed Windows EBUSY） | ❌ 无 |
| `/loops`（注：复数，与 `/loop` 不同） | binary v123 | 命令名在二进制中独立出现 | ⚠️ 需对比 |
| `/powerup` | binary v123 | `tengu_powerup_lesson_*` 教学/onboarding | ❌ 无 |
| `/stickers` | binary v123 | description 残留 | ❌ 无 |
| `/btw` | binary v123 / 2.1.101 fix | "by the way" 类回顾命令；2.1.101 fix `/btw` 不再每次写整段对话到磁盘 | ❌ 无 |
| `/teleport`（含 `tp` alias）+ `--print` 模式 | 2.1.108~2.1.121 持续增强 | session resume from claude.ai；17 个 `tengu_teleport_*` 事件覆盖 first_message/source_decision/print/bundle_mode/interactive_mode 等分支 | ✅ fork 已恢复（`src/utils/teleport.tsx` + 第二批 stub recovery），但 `--print` 模式和 17 事件全覆盖待对比 |
| `/setup-bedrock` | 2.1.111 改进 | 显示 `CLAUDE_CONFIG_DIR` 实际路径，re-run 时 seed pin 候选，加 "with 1M context" 选项 | ⚠️ 需确认 fork 状态 |
| `/setup-vertex` | 2.1.98 加交互式 wizard | login 屏选 "3rd-party platform" 时 Vertex AI 配置向导 | ⚠️ 需确认 |
| `/team` 系列（`tengu_team_mem_*`, `tengu_team_artifact_*`, `tengu_team_onboarding_*`, `tengu_teammate_*`） | 2.1.101+ | 团队记忆同步 / artifact tip / onboarding 发现 | ❌ 无（v2.1.101 binary 字符串确认） |
| `/heapdump`、`/sharp`、`/pyright` | binary v123 | 诊断/类型工具命令 | ❌ 无 |
| `/keybindings` `/keybindings-help` | 2.1.101 | 加载 `~/.claude/keybindings.json` 自定义按键 | ⚠️ 需确认 |

### 移除/合并命令

| 命令 | 何时变更 | 处置 |
|---|---|---|
| `/cost` `/stats` | 2.1.118 | 合并为 `/usage`，二者保留为快捷别名打开对应 tab |
| `/cost` 直返 plain-text（VSCode）| 2.1.120 | VSCode 改为打开原生 Account & Usage dialog |
| `Glob` / `Grep` 工具（macOS/Linux native build） | 2.1.117 | 替换为 Bash 内嵌 `bfs` + `ugrep`（Windows 与 npm 版不变） |

### 新增 endpoint（binary v123 反向查阅）

| Endpoint | 推测用途 | fork 是否已有调用 |
|---|---|---|
| `/v1/agents`、`/v1/agents/` | Agents Platform（订阅可用，已确认） | ✅ 已恢复（`agents-platform.tsx`） |
| `/v1/skills`、`/v1/skills/` | Skills 上传/同步 | ❌ 无 |
| `/v1/code/triggers`、`/v1/code/triggers/` | Trigger（schedule cron-style 后端） | ⚠️ fork 有 `cron.ts` 本地实现，未确认远端 |
| `/v1/code/sessions`、`/v1/code/sessions/` | Session list（`teleportFromSessionsAPI` 用） | ✅ teleport 用到 |
| `/v1/code/github/import-token` | GitHub App 安装 token 导入 | ❌ 无 |
| `/v1/code/slack/` | Slack App 集成 | ❌ 无 |
| `/v1/code/upstreamproxy/ca-cert`、`/v1/code/upstreamproxy/ws` | 上游代理 WS 隧道（企业代理/CCR） | ❌ 无 |
| `/v1/environments`、`/v1/environments/`、`/v1/environments/bridge`、`/v1/environment_providers/cloud/create` | Cloud environment / Bridge（环境 provisioning，BYOC runner 关联） | ⚠️ fork 有 BYOC runner 入口，远端未对接 |
| `/v1/memory_stores`、`/v1/memory_stores/` | 共享记忆存储（团队记忆） | ❌ 无 |
| `/v1/security/advisories/bulk` | 安全公告批量 | ❌ 无 |
| `/v1/ultrareview/preflight` | Ultrareview 预检 | ❌ 无 |
| `/v1/vaults`、`/v1/vaults/` | 凭据保险库 | ❌ 无 |
| `/v1/session_ingress/session/`、`/v2/session_ingress/shttp/mcp/` | Session ingress（远端 session 接入） | ❌ 无 |
| `/v2/ccr-sessions/` | CCR session（Cloud Code Runner / cross-region） | ❌ 无 |
| `/v1/feedback` | 反馈提交 | ✅ fork 已恢复 `/feedback` |
| `/v1/toolbox/shttp/mcp/` | MCP toolbox 转发 | ❌ 无 |

### 新增 telemetry 事件（v123 binary 簇）

| 簇 | 事件数 | 代表事件 | fork 状态 |
|---|---|---|---|
| `tengu_teleport_*` | 17 | `_started`、`_resume_session`、`_first_message_success`、`_source_decision`、`_bundle_mode`、`_interactive_mode`、`_print` | ✅ fork 第二批 stub recovery 已发 17 事件覆盖 |
| `tengu_ultraplan_*` | 13 | `_launched`、`_dialog_choice`、`_plan_ready`、`_approved`、`_failed`、`_awaiting_input`、`_first_launch`、`_keyword`、`_prompt_identifier`、`_timeout_seconds` | ❌ fork 无 |
| `tengu_kairos_*` | 9 | `_brief`、`_cron`、`_cron_durable`、`_dream`、`_input_needed_push`、`_loop_dynamic`、`_loop_prompt`、`_push_notifications`、`_brief_config` | ❌ fork 无 |
| `tengu_amber_*` | 10 | `_anchor`、`_flint`、`_lark`、`_lynx`、`_prism`、`_redwood`、`_sentinel`、`_stoat`、`_wren`、`_json_tools` | ❓ 内部代号（动物名），可能是新一代 agent 工具集 |
| `tengu_advisor_*` | 6 | `_command`、`_dialog_shown`、`_strip_retry`、`_tool_call`、`_tool_interrupted`、`_tool_token_usage` | ❌ fork 无（v2.1.117 加 experimental 标签） |
| `tengu_ccr_*` | 5 | `_bridge`、`_bundle_max_bytes`、`_bundle_seed_enabled`、`_bundle_upload`、`_session_link`、`_unsupported_default_mode_ignored` | ❌ fork 无 |
| `tengu_powerup_*` | 2 | `_lesson_completed`、`_lesson_opened` | ❌ fork 无 |
| `tengu_brief_*` | 3 | `_mode_enabled`、`_mode_toggled`、`_send` | ❌ fork 无 |
| `tengu_skill_*` | 4 | `_loaded`、`_file_changed`、`_tool_invocation`、`_tool_slash_prefix` | ⚠️ fork 有 SkillTool 但事件覆盖未确认 |
| `tengu_extract_memories_*` | 5 | `_extraction`、`_coalesced`、`_skipped_*`、`_error` | ✅ fork 有 EXTRACT_MEMORIES feature flag |
| `tengu_team_*` | 14 | `_artifact_tip_shown`、`_created`、`_deleted`、`_mem_*`（accessed/edits/sync_pull/sync_push/secret_skipped/entries_capped/file_*）、`_onboarding_*`、`_memdir_disabled`、`_teammate_default_model_changed`、`_teammate_mode_changed` | ❌ fork 无 |

### 新增 feature flag

v123 binary 中 `FEATURE_*` 字符串全部为 Bun runtime 内部 flag（`FEATURE_FLAG_DISABLE_DNS_CACHE`、`FEATURE_FLAG_EXPERIMENTAL_BAKE`、`FEATURE_NOT_SUPPORTED` 等），**业务 feature 已迁移到环境变量+设置项命名空间**：

新增的业务开关（按 changelog 统计）：

| 名称 | 引入版本 | 作用 |
|---|---|---|
| `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` | 2.1.108 | 强制启用 recap（telemetry 关闭时） |
| `CLAUDE_CODE_FORK_SUBAGENT` | 2.1.117 / 2.1.121 | 外部 build 启用 forked subagent，2.1.121 起在非交互 session 也生效 |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | 2.1.111 | Win/Linux/macOS 启用 PowerShell tool |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 2.1.123 | 关闭实验 beta（v123 唯一 fix 围绕该项的 OAuth 401 循环） |
| `CLAUDE_CODE_HIDE_CWD` | 2.1.119 | 启动 logo 隐藏 CWD |
| `CLAUDE_CODE_CERT_STORE` | 2.1.101 | `bundled` 仅用 bundled CA |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | 2.1.98 | Linux PID namespace 子进程隔离 |
| `CLAUDE_CODE_SCRIPT_CAPS` | 2.1.98 | 每 session script 调用上限 |
| `CLAUDE_CODE_PERFORCE_MODE` | 2.1.98 | Edit/Write 在只读文件上失败并提示 `p4 edit` |
| `ENABLE_PROMPT_CACHING_1H` | 2.1.108 | 1 小时 prompt cache TTL |
| `FORCE_PROMPT_CACHING_5M` | 2.1.108 | 强制 5 分钟 TTL |
| `OTEL_LOG_RAW_API_BODIES` | 2.1.111 | 完整 API 请求/响应作为 OTEL 日志 |
| `OTEL_LOG_USER_PROMPTS` `OTEL_LOG_TOOL_DETAILS` `OTEL_LOG_TOOL_CONTENT` | 2.1.101+ | OTEL 敏感字段 opt-in |
| `ANTHROPIC_BEDROCK_SERVICE_TIER` | 2.1.122 | Bedrock service tier 选择 |
| `DISABLE_UPDATES` | 2.1.118 | 严格于 `DISABLE_AUTOUPDATER`，连手动 `claude update` 也阻断 |
| `wslInheritsWindowsSettings` | 2.1.118 | WSL 继承 Windows managed settings |

### 配置项

| Key | 引入 | 说明 |
|---|---|---|
| `tui` | 2.1.110 | fullscreen / inline 切换 |
| `autoScrollEnabled` | 2.1.110 | fullscreen 自动滚动开关 |
| `prUrlTemplate` | 2.1.119 | footer PR badge 自定义 URL |
| `sandbox.network.deniedDomains` | 2.1.113 | 黑名单覆盖 allowedDomains 通配 |
| `MCP server.alwaysLoad` | 2.1.121 | 跳过 ToolSearch 延迟，永远可用 |
| `autoMode.allow / soft_deny / environment` 中的 `"$defaults"` | 2.1.118 | 在内置 list 之上叠加，不替换 |
| `spinnerTipsOverride.excludeDefault` | 2.1.122 | 抑制 time-based spinner tips |

---

## 与 fork 差异

### Fork 应该跟进的

**P0（订阅用户能直接受益、本地能力可实现，且与 fork 已恢复的方向一致）：**

1. **`/usage` 合并**（v2.1.118）—— 把 fork 现有 `/cost`+`/stats` 合并为 `/usage`，保留 alias。零远端依赖，纯 UI 重构。
2. **`/recap` + `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`**（v2.1.108）—— 返回 session 时给摘要。fork 有 `AWAY_SUMMARY` feature flag 但未实现命令。
3. **`/tui` 命令 + flicker-free 渲染**（v2.1.110）—— 当前 fork 用 Ink，且 fork CLAUDE.md 里设计原则强调"考究"。flicker-free 切换是 high-impact UX 改进。
4. **`/focus` 单独命令**（v2.1.110）—— `Ctrl+O` 解耦 verbose 和 focus 两个职责。代码量小、收益清晰。
5. **`/effort` 无参 slider + `xhigh` 等级**（v2.1.111）—— fork 已有 `/effort`，加 slider 是 UI 升级。

**P1（需要后端但用户已订阅，对接到 `/v1/agents` 模式可行）：**

1. **`/team-onboarding`**（v2.1.101）—— 从本地 JSONL 生成 ramp-up guide，零远端依赖。
2. **`/less-permission-prompts`**（v2.1.111）—— 扫 transcript 推 allowlist，纯本地逻辑。
3. **`/branch` 增强**（v2.1.116/v2.1.122）—— fork 需先确认 `/branch` 现状。
4. **`/extra-usage`**（v2.1.113）—— 远程查询用量。

**P2（依赖云端 endpoint，订阅可达但工程量大）：**

1. **`/ultrareview`**（v2.1.111+）—— 需 `/v1/ultrareview/preflight` 后端，订阅应可达。
2. **Auto Mode 不再要求 `--enable-auto-mode`**（v2.1.111）—— fork 需对齐入口。
3. **MCP `alwaysLoad`、auto-retry 3 次**（v2.1.121）。
4. **Plugin 体系（`plugin tag`、`plugin prune`、依赖解析）**（v2.1.117~v2.1.121）。

### Fork 不需要跟进的

1. **`tengu_amber_*` 系列**（10 个）—— 内部代号（动物名），strong indicator 是 Anthropic 内部 dogfood agent / 实验工具集，订阅版本不会暴露给最终用户。
2. **Vertex/Bedrock 边角 fix**（如 application inference profile ARN、`thinking.type.enabled is not supported`）—— fork 用户主要通过 firstParty / OpenAI / Gemini / Grok provider，这些 fix 不影响。
3. **`tengu_ccr_*`（CCR session bundle）**—— 内部 cross-region session 链路，fork 无对应基础设施。
4. **Native binary 分发改造**（v2.1.113）—— fork 已用 Bun build，无必要切到 per-platform optional dep。
5. **`tengu_ultraplan_*` 直接对齐**—— fork CLAUDE.md 里 `ULTRAPLAN` 是 P1 feature flag，但 13 个事件覆盖（dialog/keyword/identifier/timeout/awaiting_input）是云后端流水线，本地实现性价比低。
6. **Stickers / heapdump / sharp / pyright 命令**—— 内部诊断/营销，无业务价值。
7. **`/install-github-app` `/install-slack-app`**—— 依赖 Anthropic 后端 OAuth callback。

---

## 推荐 fork 接下来做的事

### P0（一周内）

1. **合并 `/cost` + `/stats` 为 `/usage`**（保留 alias）—— 与上游 v2.1.118 对齐，纯 UI 改造，~150 行
2. **实现 `/recap` 命令 + 启用现有 AWAY_SUMMARY feature flag**—— fork 已有 flag，缺命令实现
3. **新增 `/tui` 命令**—— Ink fullscreen 切换，fork 已有 fullscreen 渲染基础

### P1（两周内）

1. **`/effort` 无参 slider + `xhigh` 等级**——  fork 已有 `/effort`，UI 增强
2. **`/focus` 单独命令**（拆分 `Ctrl+O`）
3. **`/team-onboarding`** + **`/less-permission-prompts`**（纯本地 transcript 扫描，与 fork 已恢复的 `/perf-issue` `/debug-tool-call` 思路一致）
4. **`/branch` `/fork`** 现状审查 + 对齐到 v2.1.122 fix（rewound timeline tool_use_id 配对）

### P2（长期）

1. **MCP `alwaysLoad` + 自动重连 3 次**（v2.1.121）—— 配置项扩展
2. **`Auto Mode` 默认开启路径对齐**（v2.1.111）+ "Don't ask again"（v2.1.118）
3. **Plugin 依赖解析增强**（v2.1.117~v2.1.121 的所有 plugin fix）
4. **Skills `${CLAUDE_EFFORT}` 模板替换**（v2.1.120）+ 描述上限 1536 字符（v2.1.105）

---

## 调研方法回顾

| 方法 | 是否 work | 备注 |
|---|---|---|
| WebFetch GitHub `CHANGELOG.md` | ✅ work | 最佳数据源。覆盖 v2.1.97~v2.1.123 完整条目；v2.1.89~v2.1.96 已被 Anthropic 滚动裁剪，需通过 binary 字符串补 |
| Binary string grep `tengu_*` 事件 | ✅ work | 1081 事件覆盖所有 feature surface；簇分析（`_advisor_*`、`_kairos_*`、`_ultraplan_*`）能识别新功能 |
| Binary `name:"..."`,description 命令名 | ✅ work | 133 个命令名，与 fork `commands.ts` 直接对比 |
| Binary `/v[0-9]+/...` endpoint | ✅ work | 65 个 endpoint，识别新后端 surface |
| Binary `FEATURE_*` 字符串 | ⚠️ 部分 work | Anthropic 业务 flag 已迁出 `FEATURE_<NAME>` 命名空间，binary 命中的全是 Bun runtime；业务 flag 走 `CLAUDE_CODE_*` env 与 settings key |
| WebFetch npm changelog | 未尝试 | 优先级低于 GitHub CHANGELOG，因主仓库一般同步 |
| WebFetch `changelog.anthropic.com` | 未尝试 | 同上 |

**关键限制**：v2.1.89~v2.1.96 的具体条目无公开来源，本报告对该段是"通过 v2.1.97 fix 列表反推 + binary 字符串"两层间接推断，置信度低于 v2.1.97+。如需精确，可：
1. 查 `npm view @anthropic-ai/claude-code@2.1.89` 获取发布元数据
2. `git log` Anthropic 公开 SDK / docs 仓库相关提交
3. 反向查阅更早版本的 binary（用户机器无 v2.1.89 二进制）
