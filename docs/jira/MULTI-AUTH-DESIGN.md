# 多 Auth 模式设计：Workspace API key + 第三方 + 订阅 OAuth

**日期**：2026-05-04
**目标**：让被隐藏的 `/agents-platform` `/vault` `/memory-stores` 命令在用户**配置 workspace API key** 后启用；同时让 fork 支持**第三方 API provider**（如 Cerebras / Groq / 阿里通义 / 自建 OpenAI 兼容 endpoint）通过同一选择器接入。

---

## 1. Fork 现状盘点（不要从零起）

### 已有基础设施

| 模块 | 路径 | 功能 |
|---|---|---|
| 7 个 provider 流适配器 | `src/services/api/{claude,bedrockClient,gemini,grok,openai,...}.ts` | firstParty / bedrock / vertex / foundry / openai / gemini / grok（CLAUDE.md 已记录）|
| Provider 选择器 | `src/utils/model/providers.ts` | 优先级：modelType > 环境变量 > 默认 firstParty |
| API key auth 识别 | `src/cli/handlers/auth.ts:239` | 已读 `ANTHROPIC_API_KEY` env var + `apiKeySource` 字段 |
| OAuth subscription auth | `src/utils/teleport/api.ts:181` `prepareApiRequest()` | 拿 OAuth token + orgUUID（已 work for /v1/code/triggers） |
| Workspace API client（缺） | — | **没实现**：4 个 P2 client（vault/agents/memory-stores/skill-store）当前只走 OAuth |
| 第三方 API key env vars | CLAUDE.md 列了 `OPENAI_API_KEY` `GEMINI_API_KEY` `GROK_API_KEY` `OPENAI_BASE_URL` 等 | 用于聊天 endpoint 不是管理 endpoint |
| `/login` 命令 | `src/commands/login/*` | 已支持切 OAuth / API key 模式 |

### 不可逾越的约束

1. **第三方 provider 永远没有 vault/agents/memory_stores 等价端点** — 这是 Anthropic 私有功能，OpenAI/Gemini/Grok/Bedrock 没等价。所以"第三方支持"指的是**聊天/推理 endpoint**，不是管理 endpoint。
2. **workspace API key 只能调 Anthropic api.anthropic.com**，与第三方 host 不通。
3. **订阅 OAuth ≠ workspace API key**，必须双轨并存（不强制用户选一个）。

---

## 2. 三层 auth plane 设计

```
                       ┌─────────────────────────────────────┐
   User CLI              用户输入 / 命令派发                   │
                       └────────┬────────────────────────────┘
                                │
                ┌───────────────┼─────────────────┐
                ▼               ▼                 ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
      │ 推理 endpoint│  │ 订阅 endpoint│  │ workspace endpoint│
      │ (聊天/补全)  │  │ /v1/code/*   │  │ /v1/agents       │
      │              │  │ /v1/sessions │  │ /v1/vaults       │
      │              │  │ ultrareview  │  │ /v1/memory_stores│
      │              │  │ /schedule    │  │ /v1/skills       │
      └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘
             │                 │                   │
             ▼                 ▼                   ▼
   ┌─────────────────┐ ┌──────────────┐  ┌────────────────────┐
   │ Provider 选择器 │ │ Subscription │  │ Workspace API key  │
   │ ─────────────── │ │ OAuth bearer │  │ ────────────────── │
   │ firstParty (默)│ │ /login 拿到  │  │ ANTHROPIC_API_KEY  │
   │ bedrock        │ │ prepareApiReq│  │ (sk-ant-api03-*)   │
   │ vertex         │ │              │  │ console.anthropic  │
   │ foundry        │ │              │  │                    │
   │ openai (compat)│ │              │  │                    │
   │ gemini         │ │              │  │                    │
   │ grok           │ │              │  │                    │
   │ 第三方:        │ │              │  │ 第三方 workspace:  │
   │ - Cerebras     │ │              │  │ 不支持（这些 plane │
   │ - Groq         │ │              │  │ 是 Anthropic 私有）│
   │ - 通义/混元    │ │              │  │                    │
   │ - 自建 OpenAI  │ │              │  │                    │
   │   兼容 endpoint│ │              │  │                    │
   └────────────────┘ └──────────────┘  └────────────────────┘
```

### 3 个 auth plane 互不替换 — 用户可同时拥有

- **推理 endpoint**：每次 API call 都用，按 token 计费（API key）或包含在订阅
- **订阅 endpoint**：仅 `/login` 拿到 OAuth bearer 后能用，免费包含在订阅
- **workspace endpoint**：管理 agent/vault/memory store 等"组织资源"，只接受 workspace API key（`sk-ant-api03-*`），独立计费

---

## 3. 实施方案（分 4 个 PR）

### PR-1：Workspace API key 模式（让隐藏的 3 命令复活）

**目标**：用户设 `ANTHROPIC_API_KEY=sk-ant-api03-*` 后，`/vault` `/agents-platform` `/memory-stores` 启用。

**改动文件**：
- `src/utils/teleport/api.ts` 加 `prepareWorkspaceApiRequest(): { apiKey: string }`：
  ```ts
  export async function prepareWorkspaceApiRequest(): Promise<{ apiKey: string }> {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
    if (!apiKey) {
      throw new Error(
        'Workspace API key required. Set ANTHROPIC_API_KEY=sk-ant-api03-* (from https://console.anthropic.com/settings/keys). Subscription OAuth bearer cannot reach workspace endpoints.',
      )
    }
    if (!apiKey.startsWith('sk-ant-api03-')) {
      throw new Error('ANTHROPIC_API_KEY must start with sk-ant-api03- (workspace key, not subscription token).')
    }
    return { apiKey }
  }
  ```

- 4 个 P2 client `buildHeaders()` 改：
  ```ts
  async function buildHeaders(): Promise<Record<string, string>> {
    const { apiKey } = await prepareWorkspaceApiRequest()
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER, // 各文件原值
      'content-type': 'application/json',
    }
  }
  ```
  - `vault/vaultsApi.ts` / `memory-stores/memoryStoresApi.ts` / `agents-platform/agentsApi.ts` / `skill-store/skillsApi.ts`
  - 注意：**不再需要** `x-organization-uuid`（API key 自带 org 路由）

- 4 个 `index.ts` 改 `isHidden` 为动态：
  ```ts
  isHidden: !process.env.ANTHROPIC_API_KEY, // 有 key 自动显示，无 key 隐藏
  ```

- 4 个 `__tests__/api.test.ts` 改 mock：mock `prepareWorkspaceApiRequest` 而非 prepareApiRequest，断言 `x-api-key` header 而非 `Authorization`

**测试**：每个 client 加 1 测试确认 `x-api-key` header 被传 + 1 测试确认无 key 时抛清晰错。

**估算**：500 行（含测试），1 个 PR。

---

### PR-2：第三方 API provider 注册框架

**目标**：让用户接 Cerebras / Groq / 通义 / 自建 OpenAI-compatible endpoint，扩展现有 7-provider 列表为可注册。

**关键观察**：fork 已有 `CLAUDE_CODE_USE_OPENAI` `OPENAI_BASE_URL` `OPENAI_MODEL` 模式（文档化），可直接接任何 OpenAI 兼容 endpoint（含 Cerebras `https://api.cerebras.ai/v1` 和 Groq `https://api.groq.com/openai/v1`）。**无需新代码** — 已 work。

**真正缺的**：
1. 配置文件 `~/.claude/providers.json` 让用户存多个 provider 切换：
   ```json
   {
     "providers": [
       { "id": "cerebras", "kind": "openai-compat", "baseUrl": "https://api.cerebras.ai/v1", "apiKeyEnv": "CEREBRAS_API_KEY", "defaultModel": "llama-3.3-70b" },
       { "id": "groq", "kind": "openai-compat", "baseUrl": "https://api.groq.com/openai/v1", "apiKeyEnv": "GROQ_API_KEY", "defaultModel": "llama-3.3-70b-versatile" },
       { "id": "qwen", "kind": "openai-compat", "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "apiKeyEnv": "DASHSCOPE_API_KEY" },
       { "id": "deepseek", "kind": "openai-compat", "baseUrl": "https://api.deepseek.com/v1", "apiKeyEnv": "DEEPSEEK_API_KEY" }
     ],
     "default": "cerebras"
   }
   ```
2. `/provider` 命令切换：`/provider use cerebras` → 设 `CLAUDE_CODE_USE_OPENAI=1` `OPENAI_BASE_URL=https://api.cerebras.ai/v1` 然后重启。

**改动文件**：
- 新建 `src/services/providerRegistry/` 含 `loader.ts`、`switcher.ts`、`__tests__/`
- 新建 `src/commands/provider/index.ts` + `launchProvider.tsx`（Ink picker 列 provider，Enter 选）
- 注册到主 `COMMANDS`

**估算**：800 行，1 个 PR。**前提**：PR-1 先合（保持 commit 顺序）。

---

### PR-3：本地等价物（无 workspace key 用户的兜底）

**目标**：没 workspace API key 的订阅用户也能用 vault/memory-stores 的核心功能（管 secret / 跨 session 持久化），通过 fork 本地实现。

- `/local-vault`（aliases `/lv` `/local-secret`）：
  - 用 OS keychain（`@napi-rs/keyring`）存 secret，fallback `~/.claude/local-vault.enc.json` AES-256-GCM
  - 子命令：`list / set <key> <value> / get <key> / delete <key>`
  - 命令名独立 — 与 `/vault`（workspace）不冲突
- `/local-memory`（aliases `/lm`）：
  - 复用 fork 已有 `src/services/SessionMemory/`，扩展为多 store
  - 子命令：`list / create <name> / store <name> <key> <value> / fetch <name> <key>`

**估算**：1000 行，1 个 PR。**P3 优先级**（用户没明确要本地版，可跳过）。

---

### PR-4：`/login` UX 升级

**目标**：让 `/login` 让用户看清 3 个 auth plane 各自状态 + 一键配置。

UI 大约：
```
Anthropic auth status:
  ☑ Subscription (claude.ai)         pro plan
  ☐ Workspace API key                not set
       To enable /vault /agents-platform /memory-stores:
       1. Open https://console.anthropic.com/settings/keys
       2. Create a key (sk-ant-api03-*)
       3. Set ANTHROPIC_API_KEY=<paste>
       4. Restart Claude Code

Third-party providers:
  ✓ cerebras   (CEREBRAS_API_KEY set, 5 models)
  ☐ groq       (GROQ_API_KEY not set)
  ☐ qwen       (DASHSCOPE_API_KEY not set)

Press 1 to switch active provider, 2 to add a third-party, q to quit.
```

**估算**：400 行，1 个 PR。

---

## 4. 安全设计（每 PR 都要满足）

| 风险 | 缓解 |
|---|---|
| API key 写到日志 | `sanitizeErrorMessage()` 已实现（mask `sk-ant-*` `sk-*` 等）— 4 个 P2 client 的 catch 块都已 reuse |
| API key 误传到第三方 endpoint | switcher.ts 严格验证 `apiKeyEnv` 与 `baseUrl` 配对，配置文件加 schema 校验 |
| OS keychain 不可用环境（headless / CI） | local-vault 自动 fallback AES-256-GCM 加密文件，密码从 `~/.claude/local-vault.passphrase`（gitignore）读 |
| 用户误把订阅 OAuth 当 workspace key 配 | `prepareWorkspaceApiRequest()` 检查 `apiKey.startsWith('sk-ant-api03-')`，不是的话明确报错 |

---

## 5. 实施顺序 + 测试

| Step | PR | 工作量 | 测试 | 依赖 |
|---|---|---|---|---|
| 1 | PR-1 workspace API key | ~500 行 | mock prepareWorkspaceApiRequest + 4 client 各 5 测试 + 1 集成 | 无 |
| 2 | PR-2 provider registry | ~800 行 | loader.ts schema test + switcher.ts 4 测试 + provider 命令 8 测试 | PR-1 |
| 3 | PR-4 /login UI | ~400 行 | Ink render test 5 测试 | PR-1 + PR-2 |
| 4 | PR-3 local-vault / local-memory | ~1000 行 | keyring mock + crypto test 12 测试 | 无（独立可做） |

**总**：约 2700 行 + 60 测试，4 个 PR。

---

## 6. 推荐先做哪个

**最小 viable** = **PR-1** 单做。
- 让 `/vault` `/agents-platform` `/memory-stores` 在用户配 workspace API key 后立即启用
- 零破坏（无 key 时仍隐藏）
- ~500 行可周末完成
- 高优先级：直接解决用户当前痛点

**P2 = PR-2**（第三方 provider 切换）—— 第三方推理 endpoint 已 work（CLAUDE.md），缺的是注册管理 UI。

**P3 = PR-4**（`/login` UI 升级）—— nice-to-have，等前 2 个稳定后做。

**P4 = PR-3**（本地 vault/memory）—— 用户没明确要，可跳。

---

## 7. 反向问题

1. **workspace API key 是否有 spending cap？** 用户配后会不会被恶意 prompt 大量调用？
   → fork 应在每次调用前 log 一次 estimated cost，超阈值（如 $1/call）警告
2. **订阅用户配 API key 后调聊天会优先用哪个？**
   → 现有 `prepareApiRequest()` 优先 OAuth；workspace API key 仅用于 P2 管理 endpoint。需要在文档明确不混用
3. **Cerebras / Groq 等只能 OpenAI-compat 吗？还是 Anthropic-compat？**
   → 调研：截至 2026-05，主要是 OpenAI Chat Completions 兼容；Anthropic-compat 只有 Anthropic 自己 + Bedrock + Vertex
4. **本地 vault 如何处理 git rotate**？
   → AES key 不进 git；`~/.claude/.local-vault-rotate-log` 记录最近 rotation

---

**报告作者**：Claude Opus 4.7
**Codex 验证**：完成 2026-05-04（codex CLI v0.125.0）

---

## 8. Codex 反馈合入

### Q1 → CONFIRM
PR-1 header shape **正确**。引用 `https://platform.claude.com/docs/en/api/beta/agents/create` + API Overview：官方 `/v1/agents` 请求只需 `Content-Type / anthropic-version / anthropic-beta: managed-agents-2026-04-01 / X-Api-Key`，**不**含 `x-organization-uuid`（org 由 server 在 response 里通过 `anthropic-organization-id` 返回）。**采纳：4 P2 client 删 x-organization-uuid 行**。

### Q2 → EXPAND（PR-2 兼容性风险）
PR-2 不只是 config UI。第三方"OpenAI 兼容"实际有差异，需要 per-provider 回归测试：

| Provider | 已知差异 |
|---|---|
| **DeepSeek** | `reasoning_content` 跨模式行为不一致（thinking-only / thinking+tools / 普通），fork 当前"always preserve reasoning_content"对 DeepSeek 需针对性测试 |
| **严格"兼容"endpoint** | 可能拒绝 `stream_options: { include_usage: true }` 和额外 `thinking` 字段 — 需要 graceful drop |
| **Groq / Cerebras** | 主流 streaming + tool_calls 应该 OK（fork 已支持），但要测试新模型名（如 Groq llama-3.3-70b-versatile） |

**采纳：PR-2 加一个 `providerCompatMatrix.ts`，每个 provider 配置允许传的 fields**（whitelist 模式而非 dump 全部）。

### Q3 → EXPAND（route/header coupling 守卫）
**主漏点不是 plane 共存，是 route/header 错配**。Codex 验证：
- ✓ 订阅 bearer **不会**到 Cerebras（`getOpenAIClient()` 只读 `OPENAI_*` env）
- ⚠️ **workspace key 可达 `/v1/messages`** — 技术合法但 billing intent 惊喜（用户以为只用订阅，workspace key 也扣钱）

**采纳：必加 3 个硬边界守卫**：

```ts
// src/services/auth/hostGuard.ts (新建)
export function assertWorkspaceHost(url: string): void {
  if (!url.startsWith('https://api.anthropic.com')) {
    throw new Error(`Workspace API key only callable to api.anthropic.com, got ${new URL(url).host}`)
  }
}
export function assertNoAnthropicEnvForOpenAI(): void {
  // OpenAI-compat client should never read ANTHROPIC_* — guard at construct time
  const leaked = Object.keys(process.env).filter(k => k.startsWith('ANTHROPIC_') && process.env[k])
  if (leaked.length > 0) {
    // not throw — just warn (user may still legit have workspace key)
    console.warn(`[OpenAI client] ANTHROPIC_* env vars present (${leaked.join(',')}) — these are NOT used by this provider; check intent`)
  }
}
export function assertSubscriptionBaseUrl(url: string): void {
  if (!url.startsWith('https://api.anthropic.com')) {
    throw new Error(`Subscription OAuth helpers must not use arbitrary base URL, got ${url}`)
  }
}
```

3 个 client 工厂调用入口处 invoke 这些 guard。

### 综合采纳总结

| Codex 反馈 | 设计调整 |
|---|---|
| header shape CONFIRM | 直接采用，不改设计 |
| PR-2 compat | 新增 `providerCompatMatrix.ts` + per-provider 测试套 |
| host guard | 新增 `src/services/auth/hostGuard.ts` 三方法，PR-1 立即用 |

