# Cross-Audit 2026-04-29 — Stub Recovery Bugs

Scope: ~3.8k lines across 10 commands + claude.ts break-cache integration. Read-only audit.

## A. Silent failures

- **HIGH** `src/commands/break-cache/index.ts:60-62` — `readStats` swallows ALL errors (parse error, EACCES, EISDIR) and returns defaults. A corrupt stats file silently masks `totalBreaks`. Fix: log the error path, or rename file with `.corrupt-<ts>` suffix on JSON.parse failure.
- **MEDIUM** `src/commands/share/index.ts:113-121, 117` — `buildSummaryContent` outer try/catch returns `''` on read failure; caller treats `''` as "no content found" and emits a misleading message. Fix: throw to let the caller surface the real error.
- **MEDIUM** `src/commands/issue/index.ts:96-98, 121-123` — `repoHasIssuesEnabled` and `detectIssueTemplate` return `null` on any error including auth/network; user sees no signal that issue-template detection failed.
- **LOW** `src/commands/perf-issue/index.ts:386-391` — `analyzed = null` on parse error → silently produces an all-zero report indistinguishable from a fresh session. Fix: include a `parse_error` note in the report.
- **LOW** `src/services/api/claude.ts:1462-1466` — `unlinkSync` once-marker `catch {}` is intentional; safe but should log via `debug`.

## B. Resource leaks

- **MEDIUM** `src/commands/autofix-pr/launchAutofixPr.ts:255-263` — On teleport throw, `clearActiveMonitor(taskId)` is called which DOES abort the controller — OK. But if `registerRemoteAgentTask` throws (line 289), the remote CCR session is already created with no abort path; only local lock is released. Document or surface a "remote session orphaned, cancel from claude.ai" hint.
- **LOW** `src/commands/autofix-pr/monitorState.ts:42-47` — `clearActiveMonitor` aborts the controller but never removes any registered listeners on the signal. Acceptable for a singleton with process-lifetime scope.
- **PASS** — `share/index.ts` `mkdtempSync` cleanup uses `finally` block; correct.

## C. Concurrency / race

- **HIGH** `src/commands/break-cache/index.ts:71-78, 169, 190` — `incrementBreakCount` and writes to `break-cache-stats.json` / `.break-cache-always` are NOT atomic. Two concurrent `/break-cache once` invocations lose one increment (read-modify-write race) and may also race with the unlinkSync in claude.ts:1463. Fix: write to a temp file then rename, or accept the race and document.
- **PASS** `monitorState.ts:21-25` — `trySetActiveMonitor` is atomic in single-threaded JS event loop. Comment in launchAutofixPr.ts:166-169 correctly notes the await-free synchronous CAS.
- **MEDIUM** `agents-platform/agentsApi.ts:102-121` — `withRetry` retries on 5xx but does NOT honor `Retry-After` headers; under sustained 5xx storm three concurrent `listAgents` calls will all hammer at exponential 0.5/1/2s.

## D. Input validation / overflow

- **HIGH** `src/commands/ctx_viz/index.ts:362-367` — `--max-tokens=N` accepts any positive int; passing `--max-tokens=999999999999` produces `slotSize ≈ 2e7` and `Math.round(cacheRead/slotSize)` underflows to 0; harmless but `BAR_WIDTH` math in `renderPerTurnBreakdown` (line 321 `Math.max(1, Math.round(...))`) emits at least 1 cell of color even for zero-token turns — misleading. Cap at e.g. `1e9`.
- **MEDIUM** `src/commands/perf-issue/index.ts:97` — `readFileSync(logPath, 'utf8')` reads the entire JSONL into memory; for long-running sessions transcripts can reach hundreds of MB → OOM risk. Same pattern in `share/index.ts:88`, `issue/index.ts:143`, `ctx_viz/index.ts:226`, `debug-tool-call/index.ts:88`. Fix: stream line-by-line via `readline`.
- **MEDIUM** `src/commands/agents-platform/parseArgs.ts:29` — `tokens.length < 6` requires at least 1 prompt token, but a multi-line prompt with quoted whitespace gets shredded (single-quote/double-quote not respected). Cron `"0 9 * * 1"` arg is split on spaces, producing 5 cron + N prompt tokens — user must NOT quote. Document or implement shell-style quoting.
- **LOW** `src/commands/issue/index.ts:56-62` — owner/repo regex `[\w.-]+` admits leading `.` / `..`; combined with the URL fallback at line 354 produces `https://github.com/.../...issues/new`. Browsers tolerate it but a malformed remote URL leaks into the analytics event at line 441.
- **LOW** `src/commands/share/index.ts:166-167` — `if (!url.startsWith('https://'))` rejects only obvious failures; a gh subprocess that prints `https://attacker.example.com\nhttps://gist.github.com/...` would pass since `result.stdout.trim()` keeps multi-line. Use `.split('\n')[0].trim()`.

## E. Path traversal / security

- **MEDIUM** `src/commands/perf-issue/index.ts:379` — `${sessionId.slice(0, 8)}` is interpolated into the report filename; if a malicious session id contained `../`, `mkdirSync({recursive:true})` would happily traverse. Mitigated by `getSessionId()` returning a trusted UUID, but defensive: `sanitizePath(sessionId.slice(0,8))`.
- **MEDIUM** `src/commands/share/index.ts:179` — `curl -F 'file=@${filePath}'`: `filePath` is `mkdtempSync` output so trusted; OK for now.
- **MEDIUM** `src/commands/share/index.ts:42-69` — Secret-mask regex `\b(sk-[A-Za-z0-9]{20,})` is greedy and may mask non-secret strings (any base64 token starting with `sk-`). And the `[0-9a-f]{32,64}` MD5/SHA pattern (line 65) will mask legitimate git SHAs in the conversation, garbling the share. Acceptable trade-off but document.
- **HIGH** `src/commands/issue/index.ts:343-376` — When `gh` is missing, `body` from session transcript is URL-encoded into a browser link with `encodeURIComponent`. Browsers cap URL length ~8000 chars; `getTranscriptSummary(5)` slices to 200 chars per turn × 10 entries + errors — fits, but no hard cap. Fix: clamp body to ~3000 chars before encode.
- **MEDIUM** `src/commands/env/index.ts:34-46` — `KAIROS` allowlist (no underscore) matches any env var starting with `KAIROS` (e.g., `KAIROSE_INTERNAL_TOKEN`). Should be `KAIROS_`.
- **MEDIUM** `src/commands/env/index.ts:25-32` — `maskValue` shows first 4 chars of secrets ≥ 9 chars; `sk-ant-…` prefix leak (4 chars) is borderline. Acceptable; but `<= 8` falls back to `***` which is fine.

## F. Error matrix

- **MEDIUM** `src/commands/teleport/launchTeleport.ts:133-162` — Three error branches (`forbidden|401|403`, `not found|404`, `token|unauthorized`) overlap. A 403 response with body `"unauthorized token"` would match the `forbidden` branch first (correct) but tests don't cover the priority. Document priority.
- **LOW** `src/commands/agents-platform/agentsApi.ts:85-88` — 403 message hardcodes "Pro/Max/Team" — diverges from upstream subscription tiers; LOW since string.
- **PASS** — `autofix-pr` covers `session_create_failed`, `repo_mismatch`, `teleport_failed`, `registration_failed`, `rc_already_monitoring_other`, `exception` — comprehensive.
- **MEDIUM** `src/commands/issue/index.ts:459-477` — `gh issue create` failure surfaces full stderr to user; if gh embeds the title (which can contain user-supplied content) into error message, no info leak per se but `msg.slice(0, 200)` is logged to analytics — confirm analytics field is not PII-tagged.

## G. Production risk

- **HIGH** `src/commands/perf-issue/index.ts:13-19` — `COST_RATES` hardcoded to Claude 3.7 Sonnet rates. As of 2026-04-29 with Sonnet 4.6 and Opus 4.5 in use, the cost estimate is wrong. Fix: read from a constants file or remove cost estimate altogether.
- **HIGH** `src/commands/perf-issue/index.ts:128-148` — Tool durations use `Date.now()` AT PARSE TIME (when /perf-issue is run), not log timestamp. Every tool will have `durationMs ≈ same value` (the time between consecutive parse iterations, microseconds). The output is meaningless. Fix: read `entry.timestamp` for both tool_use and tool_result and subtract; or remove the tool-duration table.
- **MEDIUM** `src/services/api/claude.ts:1455` + `break-cache/index.ts` — Nonce is `randomUUID()` (128 bits crypto-random), correctly cache-busts since the `<!-- cache-break nonce: X -->` line forces prefix-hash differ. PASS.
- **MEDIUM** `src/commands/agents-platform/agentsApi.ts:141` — Hardcoded `timezone: 'UTC'` despite `AgentTrigger.timezone` being a field. User cron expressions interpreted in UTC regardless of locale → silent surprise for users in non-UTC TZ. Fix: accept `--tz` flag or use `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- **MEDIUM** `src/commands/perf-issue/index.ts:374` — Filename uses `new Date().toISOString().replace(/[:.]/g,'-')` — UTC-based, but local users may expect local time. Document or use local TZ.
- **LOW** `src/commands/share/index.ts:340` — `mkdtempSync(join(tmpdir(), 'cc-share-'))` plus immediate write to `claude-session.jsonl`: tmp file may persist if process is SIGKILLed mid-upload (rmSync in finally won't run). Acceptable for share; note it.

---

## OVERALL-VERDICT: NEEDS_FIX

- **CRITICAL**: 0
- **HIGH**: 5 (break-cache atomicity, ctx_viz max-tokens, issue body cap, perf cost rates stale, perf tool durations meaningless)
- **MEDIUM**: 13
- **LOW**: 5

Top three to fix before merge: (1) perf-issue tool-duration timestamps (G), (2) break-cache stats RMW atomicity (C), (3) issue browser-fallback body length cap (E).
