# Reverse-Engineered Spec: 7 Slash Commands

> **Source binary**: `C:\Users\12180\.local\bin\claude.exe` (Anthropic v2.1.123, 253 MB Bun-native)
> **Method**: `grep -aoE` against the binary for command names, `tengu_*` telemetry events, API endpoints, and function symbols.
> **Date**: 2026-04-29

## Summary of findings (TL;DR)

| Command | In v2.1.123 binary? | Evidence | Verdict |
|---|---|---|---|
| `/teleport` | YES — full impl | 17 `tengu_teleport_*` events, `name:"teleport",description:"Resume a Claude Code session from claude.ai",aliases:["tp"]`, `selectAndResumeTeleportTask`, `teleportToRemote`, `processMessagesForTeleportResume`, `TeleportRepoMismatchDialog`, etc. API: `/v1/code/sessions/{id}/events`, `/archive`, `/bridge` | **Full spec writeable** |
| `/share` | **NO** — renamed/removed | Zero `tengu_share_*`, zero `tengu_ccshare_*`, zero `name:"share"` command. `ccshare` literal: zero occurrences. Only `_share_url` substring exists (unrelated). The 14-day-old memory `project_ccshare_is_internal` is **outdated** — current binary has no ccshare anywhere. | **No upstream impl. Stub stays disabled.** |
| `/issue` | **PARTIAL** — under `/feedback` name | `name:"feedback",description:"Submit feedback about Claude Code"`. Telemetry: `tengu_bug_report_submitted`, `tengu_bug_report_failed`, `tengu_bug_report_description`. API: `/v1/feedback`. Functions: `submitFeedback`, `getFeedbackUnavailableReason`, `enteredFeedbackMode`. | **Implement as alias of `/feedback`** |
| `/ctx_viz` | **YES — renamed `/context`** | `name:"context",description:"Visualize current context usage as a colored grid",isEnabled:()=>!yq(),type:"local-jsx",thinClientDispatch:"control-request",load:()=>...rl7(),il7`. Second variant: `name:"context",supportsNonInteractive:!0,description:"Show current context usage",get isHidden(){return!yq()...}`. Two variants registered (jsx + plain local). | **Full spec writeable** |
| `/debug-tool-call` | **NO** | Zero hits for `debug-tool-call`, `debug_tool_call`, `tengu_debug_tool*`. Only `/debug` exists ("Enable debug logging for this session and help diagnose issues") — totally different feature. | **No upstream impl. Stub stays disabled or remove.** |
| `/perf-issue` | **NO** | Zero hits for `perf-issue`, `perf_issue`, `tengu_perf_*`. No performance-issue command in binary. | **No upstream impl. Stub stays disabled or remove.** |
| `/break-cache` | **NO** | Zero hits for `break-cache`, `break_cache`, `tengu_break_cache*`. The 3 `break.cache` regex matches in binary are MIPS opcode regex inside an embedded disassembler (`break|cache|d?eret|...|tlb(p|r|w[ir])`). Not a command. | **No upstream impl. Stub stays disabled or remove.** |

**Bottom line**: Only `/teleport`, `/issue` (as `/feedback`), and `/ctx_viz` (as `/context`) actually exist in the official binary. The other four are either stripped, renamed beyond recognition, or never existed at this command-name spelling.

---

## /teleport

### Reverse-engineering evidence

**Command registration** (literal from binary):

```
name:"teleport",description:"Resume a Claude Code session from claude.ai",
aliases:["tp"],
isEnabled:()=>S$()&&d_("allow_remote_sessions"),
get isHidden(){return!S$()||!d_("allow_remote_sessions")}
```

So: gated by `S$()` (likely `isAuthenticated()` or `hasFirstParty()`) AND GrowthBook flag `allow_remote_sessions`. Hidden when ineligible.

**Telemetry events (17)**:

```
tengu_teleport_bundle_mode
tengu_teleport_cancelled
tengu_teleport_error_branch_checkout_failed
tengu_teleport_error_git_not_clean
tengu_teleport_error_repo_mismatch_sessions_api
tengu_teleport_error_repo_not_in_git_dir_sessions_api
tengu_teleport_error_session_not_found_
tengu_teleport_errors_detected
tengu_teleport_errors_resolved
tengu_teleport_first_message_error
tengu_teleport_first_message_success
tengu_teleport_interactive_mode
tengu_teleport_print
tengu_teleport_resume_error
tengu_teleport_resume_session
tengu_teleport_source_decision
tengu_teleport_started
```

**Function symbols** found in binary:

- `selectAndResumeTeleportTask` — main entrypoint (logs: `"selectAndResumeTeleportTask: Starting teleport flow..."`)
- `teleportToRemote`, `teleportToRemoteWithErrorHandling`, `teleportWithProgress`
- `teleportFromSessionsAPI`, `teleportResumeCodeSession`
- `processMessagesForTeleportResume`
- `getTeleportedSessionInfo`, `setTeleportedSessionInfo`, `isTeleported`
- `checkOutTeleportedSessionBranch`
- `markFirstTeleportMessageLogged`
- `TeleportProgress`, `TeleportRepoMismatchDialog`, `TeleportResumeWrapper`, `TeleportAgent`, `TeleportOperationError`
- `teleport_generate_title`, `teleport_null`, `skipped_teleport`

**API endpoints** (from binary, all under `/v1/code/sessions/`):

- `GET  /v1/code/sessions` — list sessions (error: "Failed to fetch code sessions:")
- `GET  /v1/code/sessions/{id}` — fetch one (error: "Session not found:" / "Session expired. Please...")
- `GET  /v1/code/sessions/{id}/events?...&order=asc` — fetch event stream (error: "Failed to fetch session events:")
- `POST /v1/code/sessions/{id}/events` — push event ("Sending event to session")
- `POST /v1/code/sessions/{id}/archive` — archive (logs: "[archiveRemoteSession] archived")
- `      /v1/code/sessions/{id}/bridge` — bridge connection
- Auth header: `X-Trusted-Device-Token`

Also: a paginated event-fetch loop with classified error events: `teleport_events_bad_status`, `teleport_events_bad_token`, `teleport_events_fetch_fail`, `teleport_events_forbidden`, `teleport_events_invalid_shape`, `teleport_events_not_found`, `teleport_events_page_cap`.

### Inferred complete call chain

1. `parseArgs(slashArgs)` — accept optional `<session-id>` arg (positional). No flags inferred.
2. `isEnabled()` gate: `S$() && d_("allow_remote_sessions")`. Otherwise fail with friendly "not available" message.
3. `selectAndResumeTeleportTask(args)`:
   1. `emit('tengu_teleport_started', { source })`
   2. If no session-id: open **interactive picker** (Ink dialog listing sessions returned by `GET /v1/code/sessions`). Emit `tengu_teleport_interactive_mode`.
   3. If user cancels: `tengu_teleport_cancelled`, return.
   4. `teleportFromSessionsAPI(sessionId)`: validate the session belongs to current git repo; if not → `tengu_teleport_error_repo_mismatch_sessions_api`, show `TeleportRepoMismatchDialog`; if cwd not a git dir → `tengu_teleport_error_repo_not_in_git_dir_sessions_api`.
   5. Check git is clean; if dirty → `tengu_teleport_error_git_not_clean`, abort with friendly error.
   6. `checkOutTeleportedSessionBranch(branchName)`: `git checkout <branch>`. On failure → `tengu_teleport_error_branch_checkout_failed`.
   7. `teleportResumeCodeSession(sessionId)`: paginate `GET /v1/code/sessions/{id}/events?cursor=…&order=asc` until exhausted. Classify each error using the `teleport_events_*` event family.
   8. `processMessagesForTeleportResume(events)`: convert remote events into local message stream; track turn count; mark teleported via `setTeleportedSessionInfo`.
   9. Emit `tengu_teleport_resume_session` (success) or `tengu_teleport_resume_error` (failure).
   10. On first user message after resume: emit `tengu_teleport_first_message_success` (or `_error`); call `markFirstTeleportMessageLogged()` so it only fires once.
4. **Print mode**: when `--print`/`-p` headless, emit `tengu_teleport_print` and dump messages to stdout instead of REPL.
5. **Bundle mode**: when bundling local diff back to remote, emit `tengu_teleport_bundle_mode`.
6. **Source decision**: `tengu_teleport_source_decision` records whether session came from API list vs explicit ID arg vs claude.ai URL.

### Implementation guidance for the fork

Most of this is **already implemented** in this fork: see `src/utils/teleport.tsx` (`teleportToRemote` at line 947, `teleportToRemoteWithErrorHandling` at line 721) and the recovery memory `reference_remote_ccr_infrastructure.md`. The piece that still needs writing is the **slash command launcher** that wires these utilities to `name:"teleport"`.

- **Command type**: `local-jsx` (interactive picker UI uses Ink)
- **Aliases**: `["tp"]`
- **isEnabled gate**: same shape — auth check + GrowthBook `allow_remote_sessions`
- **Required imports** (from this fork):
  - `selectAndResumeTeleportTask` (or implement on top of `teleportToRemote` from `src/utils/teleport.tsx:947`)
  - `getRemoteTaskSessionUrl`, `formatPreconditionError` from `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`
  - Telemetry: emit via the project's existing `tengu_*` logger (see `src/services/statsig.ts` or equivalent)

- **Skeleton (pseudocode)**:

```ts
// src/commands/teleport/index.ts
import type { Command } from 'src/commands/types';
import { feature } from 'bun:bundle';

const teleport: Command = {
  name: 'teleport',
  aliases: ['tp'],
  description: 'Resume a Claude Code session from claude.ai',
  type: 'local-jsx',
  isEnabled: () => isAuthenticated() && getGrowthbookFlag('allow_remote_sessions'),
  get isHidden() { return !this.isEnabled(); },
  async load() {
    const mod = await import('./TeleportLauncher');
    return mod.default;
  },
};
export default teleport;
```

- **Failure paths** (all already represented as discrete telemetry events — implement matching error UIs):
  - `git_not_clean` → "Working tree has uncommitted changes. Stash or commit before teleporting."
  - `repo_mismatch_sessions_api` → render `TeleportRepoMismatchDialog`, offer to switch dir.
  - `repo_not_in_git_dir_sessions_api` → "Run from inside the git repo of the session."
  - `branch_checkout_failed` → show git stderr, offer manual checkout.
  - `session_not_found` → "Session expired or no longer accessible."

- **Test points**: parser + arg validation; eligibility gate; mock `GET /v1/code/sessions` 200 + 404; repo-mismatch dialog rendering; first-message telemetry only fires once per resume.

---

## /share

### Reverse-engineering evidence

- **Zero** `tengu_share_*` events in the binary.
- **Zero** `tengu_ccshare_*` events.
- **Zero** `name:"share"` command registrations.
- The literal `ccshare` does **not** appear anywhere in v2.1.123 (this contradicts a 14-day-old project memory; the official build has dropped or never had this feature).
- Only the substring `_share_url` exists, inside unrelated symbols (`literacyShareF`, `populationShareF`, etc. — these are statistical share/proportion variables).

### Verdict

**No upstream implementation exists in v2.1.123.** The 14-day-old `project_ccshare_is_internal` memory describing `https://api.anthropic.com/v1/code/ccshare/<id>` reflects an older binary; the current `v2.1.123` binary has stripped it. There is nothing to reverse-engineer.

### Implementation guidance

- Keep `src/commands/share/index.ts` as a **disabled stub** (`isEnabled: () => false, isHidden: true`), as documented in `reference_remote_ccr_infrastructure.md`.
- If a future user requests `/share` functionality, build it as a **new feature** based on a generic "export conversation to URL" pattern — do not pretend ccshare exists.

---

## /issue

### Reverse-engineering evidence

There is **no command literally named `issue`** in the binary. The closest match is `/feedback`:

```
name:"feedback",description:"Submit feedback about Claude Code"
```

Telemetry events confirm "issue/bug report" semantics:

```
tengu_bug_report_
tengu_bug_report_description
tengu_bug_report_failed
tengu_bug_report_submitted
```

API endpoint:
```
POST /v1/feedback
```

Function symbols (selected from `*Feedback*` corpus):
- `submitFeedback`, `getFeedbackUnavailableReason`
- `acceptFeedback`, `enteredFeedbackMode`, `entered_feedback_mode`
- `allow_product_feedback` (GrowthBook flag)
- `bad_feedback_survey`, `good_feedback_survey`
- `claude_cli_feedback`
- `handleSurveyRequestFeedback`, `feedbackOnRequestFeedback`
- `minTimeBeforeFeedbackMs`, `minTimeBetweenFeedbackMs`, `minUserTurnsBeforeFeedback`, `minUserTurnsBetweenFeedback`, `minTimeBetweenGlobalFeedbackMs`
- `missing_feedback_id`, `noFeedbackModeEntered`

### Inferred call chain (treating `/issue` as alias of `/feedback`)

1. Open `FeedbackInput` Ink screen (multiline). Emit `entered_feedback_mode`.
2. Capture description, optional rating (`good_feedback_survey` / `bad_feedback_survey`).
3. Build payload: `{ description, sessionId, model, version, transcript?, telemetry? }`. Emit `tengu_bug_report_description` with metadata only (no content).
4. `POST /v1/feedback` with bearer token; rate-limited by `minTimeBetweenFeedbackMs` & `minUserTurnsBetweenFeedback` (server returns `feedback_id`).
5. On 2xx → `tengu_bug_report_submitted` + show feedback_id to user. On error → `tengu_bug_report_failed` (categorize: `missing_feedback_id`, network, 4xx, 5xx).
6. `getFeedbackUnavailableReason()` short-circuits the flow when product feedback is disabled (`allow_product_feedback` GrowthBook flag false, or auth missing).

### Implementation guidance

- **Command type**: `local-jsx` (multiline input UI)
- **Don't reinvent**: implement `/issue` as an **alias** that points to the existing `/feedback` command (or a thin wrapper that pre-fills `kind: "bug"`).
- **Required imports**: existing fork's auth client, telemetry emitter.
- **Skeleton**:

```ts
// src/commands/issue/index.ts
import feedbackCmd from 'src/commands/feedback';

const issue: Command = {
  ...feedbackCmd,
  name: 'issue',
  description: 'File a bug/issue (alias of /feedback)',
  aliases: ['bug'],
};
```

- **Failure paths**: rate-limit hit (show "Please wait Ns"); offline (queue or just fail); GrowthBook `allow_product_feedback=false` (fall back to "Open issues at github.com/anthropics/claude-code/issues" — print URL).
- **Test**: rate-limit gate; payload shape contains description; on success surface returned id; on failure user sees actionable error.

---

## /ctx_viz  →  Renamed `/context`

### Reverse-engineering evidence

Two registrations in v2.1.123 binary:

```
// Variant A (interactive grid):
name:"context",
description:"Visualize current context usage as a colored grid",
isEnabled:()=>!yq(),
type:"local-jsx",
thinClientDispatch:"control-request",
load:()=>Promise.resolve().then(()=>(rl7(),il7))

// Variant B (non-interactive print):
{type:"local",
 name:"context",
 supportsNonInteractive:!0,
 description:"Show current context usage",
 get isHidden(){return!yq()}, ...}
```

So there are **two `/context` commands** distinguished by interactive vs non-interactive surface. `yq()` is the gate — likely "is in a TTY/has-context-bar" check.

No `tengu_context_*` or `tengu_ctx_viz_*` events found — visualizer is a pure-render command, no telemetry.

`thinClientDispatch:"control-request"` indicates that in thin-client/web mode the command dispatches a control message to the host instead of rendering directly.

### Inferred behavior

Visualize current context-window usage:
- Read current `messageTokenCounts` and `maxContextTokens` from app state.
- Render a colored grid (each cell = a fixed token bucket; color encodes message kind: user / assistant / tool result / cached / system / free).
- Show: total used, free, % used, breakdown by category, model context size.
- In non-interactive (`-p`) mode: print plain summary instead of grid.

### Implementation guidance

- **Command type**: register **two variants**:
  - `type: "local-jsx"` for the interactive Ink grid.
  - `type: "local", supportsNonInteractive: true` for headless `-p`.
- **isEnabled**: gate behind `!isThinClient()` or whatever `yq()` decompiles to in this fork.
- **thinClientDispatch**: `"control-request"` — hand off to thin-client host when running there.
- **Required imports** (from this fork):
  - Token-count selectors from `src/state/selectors.ts`
  - `MessageRow` types from `src/types/message.ts`
  - Theme tokens from `packages/@ant/ink/theme`
- **Render outline**:

```ts
// 1. Collect tokens-per-message via getMessageTokens(state)
// 2. Bin them into a 40x10 grid (or terminal-width-adaptive)
// 3. Color cells:
//    - user: orange (Claude brand)
//    - assistant: blue
//    - tool_result: gray
//    - cached: dim green
//    - system/CLAUDE.md: yellow
//    - free: black/dim
// 4. Print summary row: "Used 73,412 / 200,000 tokens (37%)"
```

- **Failure paths**: no messages yet → render empty grid + hint. Model context size unknown → fall back to 200k.
- **Test**: token-bucketing math; grid sizing for narrow/wide terminals; non-interactive mode prints all required fields.

---

## /debug-tool-call

### Reverse-engineering evidence

- Zero hits for `debug-tool-call`, `debug_tool_call`, `tengu_debug_tool*`, or any function symbol containing `DebugToolCall`.
- The only `debug` command in v2.1.123 is `name:"debug",description:"Enable debug logging for this session and help diagnose issues"` — a logging toggle, not a tool-call inspector.

### Verdict

**No upstream implementation.** Either renamed beyond recognition, stripped from this build, or never existed.

### Implementation guidance

- Keep `src/commands/debug-tool-call/` stubbed (`isEnabled: () => false`) until a user actually requests this feature.
- If implementing from scratch (out of scope for "upstream parity"), it would be a `local-jsx` command that opens an inspector listing recent `ToolUseMessage` + `ToolResultMessage` pairs with raw inputs/outputs and timing — but **no upstream contract exists** to match.

---

## /perf-issue

### Reverse-engineering evidence

- Zero hits for `perf-issue`, `perf_issue`, `tengu_perf_*`.
- No "performance issue report" command anywhere in binary.

### Verdict

**No upstream implementation.** Likely stripped. Could be a thin wrapper over `/feedback` with `kind: "perf"`, but binary contains no evidence of such categorization.

### Implementation guidance

- Keep `src/commands/perf-issue/` stubbed.
- If wanted, implement as `/feedback` alias with auto-attached perf metrics (FPS, CPU, memory, recent slow tool calls). But again — **no upstream contract**, so this is new feature work, not parity.

---

## /break-cache

### Reverse-engineering evidence

- 3 binary hits for `break.cache`, **all 3 are MIPS instruction-set regex** inside an embedded disassembler:
  ```
  break|cache|d?eret|[de]i|ehb|mfc0|mtc0|pause|prefx?|rdhwr|rdpgpr|sdbbp|ssnop|synci?|syscall|teqi?|tgei?u?|tlb(p|r|w[ir])|tlti?u?|tnei?|wait|wrpgpr
  ```
  These are MIPS opcodes (`break`, `cache`, `eret`, `tlbp`, `syscall`, ...). Not a slash command.
- Zero `tengu_break_cache*` events.
- Zero `name:"break-cache"` command registration.

### Verdict

**No upstream implementation.** The string match was a red herring.

### Implementation guidance

- Keep `src/commands/break-cache/` stubbed.
- If a user genuinely needs to force a prompt-cache miss for testing, the **right way** is to add an in-conversation cache-break by inserting a unique sentinel at the start of the next user message — this is a 5-line helper, not a slash command. But it's new work; nothing to copy from upstream.

---

## Cross-cutting notes

1. **Outdated memory warning**: the 14-day-old project memory `project_ccshare_is_internal.md` claimed `https://api.anthropic.com/v1/code/ccshare/<id>` exists. **The current v2.1.123 binary has zero `ccshare` strings.** Either Anthropic stripped it from public builds or the older memory was based on an internal build. Do not rely on that endpoint without re-verifying.
2. **Command discovery pattern**: every real slash command in the binary follows the literal shape `name:"<lower-kebab>",description:"..."`. Searching for that exact regex is the most reliable way to enumerate the upstream command surface (full list of ~80+ commands captured during this investigation — see binary).
3. **Telemetry-only is a real verdict**: the 17 `tengu_teleport_*` events plus the `tengu_bug_report_*` quartet are the only command-specific telemetry families in the binary. Any "telemetry-rich" claim about other commands (debug-tool-call, perf-issue, break-cache) is not supported by evidence.
4. **`thinClientDispatch`** values seen: `"control-request"`, `"post-text"`. Useful when wiring fork-side commands that must also work in thin-client/web mode.

