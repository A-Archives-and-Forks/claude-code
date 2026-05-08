# AUTH-LOGIN-UI — /login Auth Plane Summary UI

**PR:** PR-4 (MULTI-AUTH-DESIGN.md)  
**Status:** Implemented

## Overview

Running `/login` without arguments now shows an auth status summary before
entering the OAuth flow. Users can immediately see which authentication
planes are configured and which require setup.

## Screen Simulation

```
Login
─────────────────────────────────────────────────────────────────────

Anthropic auth status:
  ☑ Subscription (claude.ai)         logged in  pro plan
  ☐ Workspace API key                not set
       To enable /vault /agents-platform /memory-stores:
       1. Open https://console.anthropic.com/settings/keys
       2. Create a key (sk-ant-api03-*)
       3. Set ANTHROPIC_API_KEY=<paste>
       4. Restart Claude Code

Third-party providers:
  ✓ Cerebras    (CEREBRAS_API_KEY set)  (active)
  ☐ Groq        (GROQ_API_KEY not set)
  ☐ Qwen        (DASHSCOPE_API_KEY not set)
  ☐ DeepSeek    (DEEPSEEK_API_KEY not set)

[OAuth flow continues below…]
```

## Auth Plane States

### Subscription (claude.ai OAuth)

| Icon | Condition | Meaning |
|------|-----------|---------|
| `☑` | OAuth token present | Logged in; plan label shown |
| `☐` | No token | Not logged in |

### Workspace API Key (`ANTHROPIC_API_KEY`)

| Icon | Condition | Meaning |
|------|-----------|---------|
| `☑` | Set + prefix `sk-ant-api03-` | Valid workspace key |
| `☐` | Not set | Not configured; setup guide shown when subscription active |
| `⚠` | Set but wrong prefix | Invalid format; correct prefix shown |

Key preview format: `sk-a...67 (48 chars)` — first 4 chars + `...` + last 2 chars + length.
Raw key value is **never displayed**.

### Third-Party Providers

| Icon | Condition | Meaning |
|------|-----------|---------|
| `✓` | API key env var set | Provider configured |
| `☐` | API key env var not set | Provider not configured |
| `(active)` | `CLAUDE_CODE_USE_OPENAI=1` + matching `OPENAI_BASE_URL` | Currently active provider |

## Implementation

| File | Purpose |
|------|---------|
| `src/commands/login/getAuthStatus.ts` | Pure function — reads env + OAuth file, no network calls |
| `src/commands/login/AuthPlaneSummary.tsx` | Ink component — renders 3-plane status table |
| `src/commands/login/login.tsx` | Modified — passes `authStatus` to `Login` component |

## Security Constraints

- `ANTHROPIC_API_KEY`: only masked preview exposed (first4 + `...` + last2 + length)
- Third-party API keys: only boolean presence flag; values never read or displayed
- `accountEmail`: reserved field, always `null` — email not included in any output

## Testing

```bash
# Run regression tests
bun test src/commands/login/__tests__/

# Expected output: 16 tests pass, 0 fail
```

Test coverage:
- `getAuthStatus.test.ts`: 9 tests covering subscription on/off, workspace key
  valid/missing/wrong-prefix, third-party env vars, `isActive` detection
- `AuthPlaneSummary.test.tsx`: 7 Ink render tests covering all 4 mode
  combinations + provider ✓/☐ icons + `(active)` label

## Interaction Flow

```
/login (no args)
  ↓
getAuthStatus() — pure snapshot (no network)
  ↓
<Login authStatus={…}> renders:
  <AuthPlaneSummary status={authStatus} />   ← NEW: 3-plane display
  <ConsoleOAuthFlow …/>                       ← unchanged OAuth flow
```

Existing subcommand paths (`/login api-key`, `/login claude-ai`,
`/login console`) are not modified — they bypass `call()` entrypoint.

## What Is Not Implemented (v1)

- Interactive key switching (press 1 to switch provider) — deferred to v2
- Interactive third-party add (press 2) — use `/provider add` from PR-2
- PR-3 local vault / local memory — separate PR
