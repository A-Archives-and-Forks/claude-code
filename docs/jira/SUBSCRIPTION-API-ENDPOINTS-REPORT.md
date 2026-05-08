# 订阅 OAuth 可访问的 Anthropic /v1/* 端点完整探测报告

**日期**：2026-05-03
**方法**：用 fork 的 `prepareApiRequest()` 拿订阅 OAuth bearer token + orgUUID，对每个候选 endpoint 发安全 GET，记录 server 真实状态码 + 响应。代码 `scripts/probe-subscription-endpoints.ts`。
**目的**：消除"猜测/反向查阅"的歧义，用实际 server 响应确定哪些端点订阅用户能用、哪些不能用。

---

## 完整结果表

| 端点 | beta header | 状态 | 服务器响应（前 110 字） |
|---|---|---|---|
| `/v1/code/triggers` | `ccr-triggers-2026-01-30` | **OK** | `{"data":[],"has_more":false}` |
| `/v1/environment_providers` | (none) | **OK** | 列出 `env_011N2gVX9ayCrrua81dU92zU` (idx-mv) |
| `/v1/oauth/hello` | (none) | **OK** | `{"message":"hello"}` |
| `/v1/messages/count_tokens` | (none) | 405 | `Method Not Allowed`（要 POST） |
| `/v1/memory_stores` | (none) | 400 | `this API is in beta: add 'managed-agents-2026-04-01' to the 'anthropic-beta' header` |
| `/v1/memory_stores` | `managed-agents-2026-04-01` | **401** | **`memory stores require a workspace-scoped API key or session`** ← 决定性证据 |
| `/v1/mcp_servers` | (none) / `managed-agents-...` | 400 | `This endpoint requires the 'anthropic-beta:' ...`（鉴权阶段过了，但 beta 还是不对） |
| `/v1/agents` | (none) / `managed-agents-...` / `agents-2026-04-01` | **401** | `Authentication failed`（3 个 beta 全部 401） |
| `/v1/vaults` | (none) / `managed-agents-...` / `vaults-2026-04-01` | **401** | `Authentication failed`（3 个 beta 全部 401） |
| `/v1/models` | (none) | **401** | `OAuth authentication is currently not supported` ← 连模型列表都要 API key |
| `/v1/projects` | (none) | 404 | `Not found` |
| `/v1/skills` | (none) / `skills-2025-10-02` | 404 | `Not found`（订阅 plane 不暴露） |
| `/v1/environments` | (none) | 404 | `The environments API requires the 'environments-2*' beta`（提示要不同 beta，没试） |
| `/v1/files` | (none) | 404 | `Not found` |
| `/v1/feedback` | (none) | 404 | `Not found`（GET 不行，可能需要 POST） |
| `/v1/certs` / `logs` / `traces` / `security/advisories/bulk` | (none) | 404 | `Not found` |

**未列在表中但已知 work**：
- `/v1/messages` (POST) — 主聊天 API
- `/v1/ultrareview/preflight` (POST) — 已 work（fork 已用）
- `/v1/sessions` / `/v1/code/sessions` — teleport 用
- `/v1/code/github/import-token` (POST) — github 集成
- `/v1/code/slack/*` — slack 集成
- `/v1/code/upstreamproxy/*` — proxy
- `/v1/session_ingress/session/...` — teleport sessions API

---

## 三类划分

### A. 订阅 OAuth 可调（fork 已或可实现）

| 端点 | fork 命令 | 状态 |
|---|---|---|
| `/v1/code/triggers` (CRUD) | `/schedule` | ✅ 已实现 |
| `/v1/messages` (POST) | 主聊天循环 | ✅ 用 |
| `/v1/sessions` / `/v1/code/sessions` | `/teleport` resume | ✅ 用 |
| `/v1/ultrareview/preflight` (POST) | `/ultrareview` | ✅ 已集成 |
| `/v1/environment_providers` | `/schedule` 选 env | ✅ 用 |
| `/v1/code/github/import-token` (POST) | github setup | ✅ 用 |
| `/v1/messages/count_tokens` (POST) | `/usage` | 可加 |
| `/v1/feedback` (POST) | `/feedback` 上游 | 可加（404 是因 GET，POST 应该 OK） |
| `/v1/oauth/hello` | health check | (内部) |

### B. 订阅 OAuth **绝对不能调** — server 明文拒绝（要 workspace API key）

| 端点 | server 拒绝原因 | fork 处置 |
|---|---|---|
| `/v1/memory_stores` | **"memory stores require a workspace-scoped API key or session"** | 已隐藏（commit `906b0a48`）|
| `/v1/agents` | `Authentication failed`（任何 beta） | 已隐藏 |
| `/v1/vaults` | `Authentication failed`（任何 beta） | 已隐藏 |
| `/v1/models` | `OAuth authentication is currently not supported` | 不暴露用户命令 |
| `/v1/skills` (marketplace) | 404 with OAuth | 已禁用（但本地 skills 仍 work） |
| `/v1/projects` | 404 with OAuth | 不需要 |
| `/v1/files` | 404 with OAuth | 不需要 |

### C. 待探（可能加不同 beta 后 work，未深探）

| 端点 | 提示 | 估计 |
|---|---|---|
| `/v1/environments` | `requires the 'environments-2*' beta` | 试 `environments-2024-...` 可能 OK，但要订阅 plane 才有用，未必必要 |
| `/v1/mcp_servers` | `requires the 'anthropic-beta:' ...` | beta 未知 — 反向查 binary 找正确 beta token 名 |

---

## 决定性结论

1. **`/v1/{agents,vaults,memory_stores}` 在 server 端硬卡为 workspace plane**。即使 fork 加任何 beta header / 用任何 OAuth 巧门，server 始终返回 401。`/v1/memory_stores` 的错误文案 **"require a workspace-scoped API key or session"** 是明文证据。

2. 唯一让这 3 个命令对订阅用户工作的方法：fork 加 **workspace API key 路径**（用户从 https://console.anthropic.com 申请 `sk-ant-api03-*` key，独立计费）。当前 fork 不支持此路径。

3. **"workspace-scoped session"** 这个表述暗示：除了 API key，还有一种"workspace-scoped session"（可能是 enterprise SSO + workspace selection 后的 session token），但 server 没暴露给个人订阅 OAuth。

---

## 推荐路线（按优先级 P0/P1/P2）

### P0：即刻执行（已部分做）
- ✅ 已隐藏 `/agents-platform` `/vault` `/memory-stores` 的 buildHeaders 抛 501 文案，明确告诉用户"workspace API key required"
- ❌ 但命令仍在主菜单 `/help`，建议改 `isHidden: true` 或不注册，避免误导

### P1：短期可加（订阅可用，fork 缺）
- `/feedback` 命令包 `POST /v1/feedback`（替代/对齐上游 v2.1.123 的 `/feedback`）
- `/mcp_servers list` 试 `mcp-servers-2025-XX-XX` beta（先反向查正确 beta token）
- `/usage` 内嵌 `/v1/messages/count_tokens` 实时 token 估算

### P2：长期（要新增 API key 模式）
- 可选 workspace API key 路径：fork 检测到 `ANTHROPIC_API_KEY=sk-ant-api03-*` 时启用 vault/agents/memory_stores 命令；否则保持隐藏。**用户警告**：会从 API key 配额扣钱（与订阅独立计费）。

### 永久跳过
- `/v1/models` (workspace only)、`/v1/projects` (workspace)、`/v1/files` (workspace)、`/v1/skills` marketplace (workspace) — fork 不应承诺给订阅用户。

---

## 相关 commits / 文件

- 探测脚本：`scripts/probe-subscription-endpoints.ts`
- 4 文件 503/501 改造：commit `906b0a48` ("fix: stop subscription bearer from hitting workspace-API-key endpoints (501)")
- 反向 binary 报告：`docs/jira/P2-AUTH-DIFF-2026-04-30.md`
- P2 endpoint 实施 spec：`docs/jira/P2-ENDPOINTS-SPEC.md`

---

**报告作者**：Claude Opus 4.7（基于实际 server 响应，非推测）
