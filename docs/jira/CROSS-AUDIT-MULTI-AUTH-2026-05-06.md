# Cross-Audit: Multi-Auth PR-1/PR-2/PR-3/PR-4

- **Date:** 2026-05-06
- **Range:** `HEAD~9..HEAD` (commits a82de394, 656e6bc5, 70756362, 26634121, 633a425b, ffa33963, ca004a17, 69df7be2)
- **Scope:** ~5524 insertions / ~131 deletions across 59 files
- **Method:** Read-only static review; no source files modified
- **Files audited:** 28 source files (18 prod + 10 test, plus 4 P2 client diffs)

---

## Summary table (dimension x severity)

| Dim | CRITICAL | HIGH | MEDIUM | LOW | Total |
|-----|----------|------|--------|-----|-------|
| A. Silent failures | 0 | 1 | 3 | 1 | 5 |
| B. Resource leaks | 0 | 0 | 1 | 1 | 2 |
| C. Concurrency / race | 0 | 3 | 2 | 0 | 5 |
| D. Input validation / overflow | 0 | 2 | 4 | 1 | 7 |
| E. Path traversal / security | 1 | 1 | 2 | 1 | 5 |
| F. Crypto correctness | 0 | 2 | 1 | 0 | 3 |
| G. Error matrix / UX text | 0 | 0 | 2 | 2 | 4 |
| H. Duplication | 0 | 0 | 3 | 0 | 3 |
| I. Test coverage gap | 0 | 1 | 2 | 0 | 3 |
| J. Performance / edge | 0 | 0 | 2 | 1 | 3 |
| **TOTAL** | **1** | **10** | **22** | **7** | **40** |

---

## A. Silent failures

### A1. HIGH — `loadProviders()` corrupt file silently falls back to defaults
**File:** `src/services/providerRegistry/loader.ts:96-112`
The Zod-failure / JSON-parse-failure paths only call `logError()` and return `[...DEFAULT_PROVIDERS]`. A user who edited `providers.json` and broke it will see their custom providers silently disappear with only a stderr log line. They will assume their config works.
**Fix:** Surface a one-line warning to the user-facing channel (or the `/providers list` view should render a "config error" banner using `existsSync(filePath) && parseFailed`).

```ts
// In ProviderView when invoked, also surface load errors:
const loadResult = loadProvidersWithDiagnostic()  // {providers, error?: string}
```

### A2. MEDIUM — `readVaultFile()` swallows JSON parse error
**File:** `src/services/localVault/store.ts:178-180`
```ts
} catch {
  return {}
}
```
A corrupt `local-vault.enc.json` returns `{}`, masking data loss. `getSecret(...)` returns null instead of erroring. User thinks key was never set.
**Fix:** Differentiate ENOENT (return {}) from JSON-parse-error (throw `LocalVaultDecryptionError("vault file corrupt — restore from backup")`).

### A3. MEDIUM — `tryKeychain.list()` swallows corrupt index
**File:** `src/services/localVault/keychain.ts:93-96`
A corrupt `__index__` JSON returns `[]`. New entries via `_addToIndex` will rebuild the index losing all references to existing keys (in keychain but unindexed, undeletable via `delete`).
**Fix:** On parse failure, throw `KeychainUnavailableError("index corrupt; reset via …")` so caller can fall back rather than data-stranding.

### A4. MEDIUM — `chmodSync` failure is logged but flow continues with insecure file
**File:** `src/services/localVault/store.ts:83-93`
```ts
try { chmodSync(passphraseFile, 0o600) } catch { logError(...) }
```
On Windows the file is written with default ACL (often readable by all users in same group). `logError` is informational — the user has no way to act on it before encryption proceeds.
**Fix:** On Windows, recommend explicit ACL via `icacls` in the warning, OR strongly recommend `CLAUDE_LOCAL_VAULT_PASSPHRASE` env var as primary path.

### A5. LOW — `sendEventToRemoteSession` returns `false` on network/auth error
**File:** `src/utils/teleport/api.ts:442-445` (pre-existing pattern, not new but adjacent to PR scope) — not in PR diff, **excluded from finding count**.

---

## B. Resource leaks

### B1. MEDIUM — `cipher`/`decipher` not explicitly disposed; AES key Buffer not zeroed
**File:** `src/services/localVault/store.ts:121-161`
`createCipheriv` / `createDecipheriv` return objects that hold internal state. Node will GC them, but the `key256: Buffer` derived from passphrase remains in heap until GC. For a long-running process, multiple calls to `setSecret` keep these in memory.
**Fix:** After encrypt/decrypt, `key256.fill(0)` to zero out the derived key. While JS GC makes this best-effort, it limits the window.

```ts
try {
  const enc = encrypt(value, key256)
  // ...
} finally {
  key256.fill(0)
}
```

### B2. LOW — `_resetKeychainModuleCache` is exported but only useful for tests
**File:** `src/services/localVault/keychain.ts:54-56`
Test-only export pollutes public API surface. Use a `__tests__/` re-export or `export internal`.

---

## C. Concurrency / race

### C1. HIGH — `localVault/store.ts` `setSecret` is non-atomic (TOCTOU on read-modify-write of vault file)
**File:** `src/services/localVault/store.ts:212-216`
```ts
const vaultData = await readVaultFile()      // ← read
vaultData[key] = encrypt(value, key256)
await writeVaultFile(vaultData)              // ← write  (lost-update on concurrent setSecret)
```
Two parallel `setSecret('a', 'A')` and `setSecret('b', 'B')` calls each read the same baseline; whichever writes last wins, dropping the other. Not theoretical — `/local-vault set` from two terminals or `Promise.all([setSecret(...), setSecret(...)])` triggers it.
**Fix:** Write to `<file>.tmp` then `renameSync` (atomic on POSIX), AND wrap with an in-process mutex (e.g. `proper-lockfile` or a queue). Cross-process safety requires file locking.

### C2. HIGH — `multiStore.ts` `setEntry` is non-atomic (no .tmp + rename)
**File:** `src/services/SessionMemory/multiStore.ts:106`
```ts
writeFileSync(entryPath, value, 'utf8')
```
A crash mid-write leaves a half-written `.md` file. A reader (`getEntry`) sees truncated content.
**Fix:** `writeFileSync(tmp, value); renameSync(tmp, entryPath)`.

### C3. HIGH — `loader.ts` `saveProviders()` overwrites without locking; lost-update race
**File:** `src/services/providerRegistry/loader.ts:148-178`
Same pattern as C1. Two `/providers add` invocations interleave: each loads current → adds its entry → writes. One loses.
**Fix:** Atomic write (.tmp + rename) plus advisory file lock. `/providers add` from REPL is rarely concurrent, but spec allows scripted use.

### C4. MEDIUM — `_addToIndex` / `_removeFromIndex` race
**File:** `src/services/localVault/keychain.ts:99-114`
`existing = await this.list()` then `setPassword(JSON.stringify([...existing, account]))`. Concurrent set/delete on different keys race the index.
**Fix:** Wrap index ops in a process-level Mutex (Bun has `Bun.lock` or use a small async-lock).

### C5. MEDIUM — `getOrCreatePassphrase` may double-write on first run
**File:** `src/services/localVault/store.ts:62-103`
Two parallel first-run `setSecret` calls each see `!existsSync(passphraseFile)`, both `randomBytes(32)` then both `writeFileSync` — different passphrases. The second wins; the first call's encrypted record is now undecryptable forever.
**Fix:** Use `writeFileSync(file, generated, { flag: 'wx' })` (exclusive create); on EEXIST re-read from file.

---

## D. Input validation / overflow

### D1. HIGH — `setSecret(key, value)` has no upper bound on value size
**File:** `src/services/localVault/store.ts:194-217`
A 100 MB value is loaded into memory, encrypted (~100 MB cipher buffer), JSON-stringified (~200 MB hex), then written. OS keychain typically rejects > 4 KB but the file fallback path accepts unlimited input → OOM on cheap machines.
**Fix:** Reject `value.length > 64 * 1024` with a clear error before encryption.

### D2. HIGH — `multiStore.setEntry` has no upper bound on `value` size
**File:** `src/services/SessionMemory/multiStore.ts:98-107`
Same problem; entries are user-facing notes but nothing prevents writing a 1 GB string.
**Fix:** Cap at 1 MB; document in `parseArgs.ts` USAGE.

### D3. MEDIUM — `parseLocalVaultArgs` `set <key> <value>` keys can be `--reveal` or any flag
**File:** `src/commands/local-vault/parseArgs.ts:39-54`
`set --reveal foo` is parsed as `key='--reveal', value='foo'` — accepted. Probably intended to error.
**Fix:** Validate `key` does not start with `-` (reserved for flags).

### D4. MEDIUM — `parseLocalVaultArgs` value-extraction breaks on key containing regex special chars or repeating substring
**File:** `src/commands/local-vault/parseArgs.ts:46`
```ts
const rest = trimmed.slice(trimmed.indexOf(key) + key.length).trim()
```
If `key = 'set'` (someone tries `set set value`) or key has the same substring as the subcmd, `indexOf` returns the subcmd position, slicing wrongly. Same fragility in `parseLocalMemoryArgs:68` (uses two-arg `indexOf` to mitigate but still string-search).
**Fix:** Use `tokens.slice(2).join(' ')` for value, not substring math.

### D5. MEDIUM — `prepareWorkspaceApiRequest` reveals first 13 chars of malformed key
**File:** `src/utils/teleport/api.ts:199`
```ts
`got prefix "${apiKey.slice(0, 13)}..."`
```
If a user pastes the **wrong** secret (e.g., a real OpenAI `sk-proj-…` or AWS key), the first 13 chars include high-entropy bits of the actual secret. Logged in error → potentially copied into bug report.
**Fix:** Reveal at most first 4 chars: `apiKey.slice(0, 4)`.

### D6. MEDIUM — `parseLocalMemoryArgs store <store> <key> <value>` value-extraction same fragility
**File:** `src/commands/local-memory/parseArgs.ts:68-69`
`indexOf(key, ...)` is fragile if key matches store name or appears earlier.
**Fix:** `tokens.slice(3).join(' ')`.

### D7. LOW — `parseProviderArgs`: `use cerebras extra args` silently ignores trailing tokens
**File:** `src/commands/provider/parseArgs.ts:45-46`
"Take only the first token as the id" — but does not warn user about extra tokens that may have been a typo.
**Fix:** If `rest.split(/\s+/).length > 1`, return `invalid` with hint.

---

## E. Path traversal / security

### E1. **CRITICAL** — `multiStore.setEntry` allows store=`..\..\X` via Windows path separator regex gap
**File:** `src/services/SessionMemory/multiStore.ts:34-46`
```ts
function getEntryPath(store: string, key: string): string {
  const safeKey = key.replace(/[/\\]/g, '_')   // ← key sanitized
  return join(getStoreDir(store), `${safeKey}.md`)  // ← store NOT sanitized here
}
function validateStoreName(store: string): void {
  if (!store || /[/\\]/.test(store) || store.startsWith('.')) { ... }  // ← rejects '../' but...
}
```
The validator rejects `/` `\\` and leading `.`, BUT does **not** reject `null bytes` (`store='x\0../etc'`), nor does it reject Windows drive prefixes (`store='C:foo'` → `join(base, 'C:foo')` resolves to `C:foo` on Windows, escaping `base`!), nor URL-encoded sequences. Also: `store='foo\u0000'` truncates the path on certain Node versions exposing `~/.claude/local-memory/foo`. Importantly `key` regex only strips `/` and `\\` — does **not** reject `..` segments after sanitisation: `key='..'` → safeKey='..' → entry path `…/store/...md` (no escape due to `.md` suffix), but `key='\0'` → safeKey='_' (ok). The store-name check is the bigger risk.
**Repro:** `/local-memory store C:hack k v` on Windows → writes to `C:hack/k.md` (workspace-relative, escapes `~/.claude/local-memory/`).
**Fix:** Add to validator: reject `\0`, reject `:`, reject `..`, normalize via `path.basename(store)` and assert `basename(store) === store`.

```ts
function validateStoreName(store: string): void {
  if (!store) throw new Error('empty')
  if (store !== path.basename(store)) throw new Error('path-like')
  if (/[/\\\0:]/.test(store)) throw new Error('illegal char')
  if (store.startsWith('.') || store === '..') throw new Error('reserved')
  if (store.length > 255) throw new Error('too long')
}
```

### E2. HIGH — `assertWorkspaceHost` URL parse permits `https://api.anthropic.com@evil.com/` (legacy URL credentials)
**File:** `src/services/auth/hostGuard.ts:25-42`
`new URL('https://api.anthropic.com@evil.com/x').hostname` → `'evil.com'` so this **is** caught. BUT: callers construct URLs by string concat: `${BASE_API_URL}/v1/agents`. If `BASE_API_URL` is influenced by env (e.g., `ANTHROPIC_BASE_URL` override or test override), a misconfiguration like `https://api.anthropic.com.evil.com` would be caught. So `hostname !== 'api.anthropic.com'` is sufficient *but* relies on `BASE_API_URL` always being trustworthy. There is no audit of where `getOauthConfig().BASE_API_URL` comes from in this layer.
**Fix:** Document that `BASE_API_URL` MUST NOT be user-controllable for workspace clients. Add a unit test that asserts `assertWorkspaceHost('https://api.anthropic.com.evil.com/')` throws (currently untested per `hostGuard.test.ts`).

### E3. MEDIUM — `getAuthStatus.maskApiKey` leaks last 2 chars of short keys
**File:** `src/commands/login/getAuthStatus.ts:82-87`
For a 14-char malformed key (e.g. user pasted only the prefix), preview shows `sk-a...3- (14 chars)` — 6 of 14 chars exposed (43%).
**Fix:** If `len < 20`, show `[redacted] (N chars)` only.

### E4. MEDIUM — `loader.saveProviders` round-trips full provider config through `JSON.stringify` for diff check
**File:** `src/services/providerRegistry/loader.ts:170`
```ts
if (defaultEntry && JSON.stringify(defaultEntry) !== JSON.stringify(p)) { ... }
```
Key-order in spread `{...p}` vs `DEFAULT_PROVIDERS` matters — JSON.stringify is order-sensitive. A semantically equivalent override that has different key order writes spuriously. Not a security issue but causes file churn / spurious diffs.
**Fix:** Compare by sorted keys or use a deep-equal helper.

### E5. LOW — `console.warn` for new passphrase file leaks file path to terminal log capture
**File:** `src/services/localVault/store.ts:95-100`
The path itself isn't sensitive but `console.warn` may end up in shell history or session capture — generally `logError` is preferred for consistency.
**Fix:** Use `logError` like elsewhere in the file, or document that this is a one-time first-run warning by design.

---

## F. Crypto correctness

### F1. HIGH — Key derivation uses single SHA-256 of passphrase (not PBKDF2/scrypt/argon2)
**File:** `src/services/localVault/store.ts:56-60`
```ts
return createHash('sha256').update(passphrase).digest()
```
Comment claims this is "intentionally simple" because file is on local FS. However:
- The *auto-generated* passphrase is 64 hex = 256 bits of entropy, which IS secure under SHA-256.
- The *user-provided* `CLAUDE_LOCAL_VAULT_PASSPHRASE` env var passphrase may be a low-entropy human-memorable string (`mypass123`). With SHA-256 (no salt, no work factor), brute force is trivial if attacker steals the file.
**Fix:** Use `scryptSync(passphrase, salt, 32)` with per-vault random `salt` stored alongside the encrypted blob. This is industry-standard for password-derived keys.

### F2. HIGH — No salt: same passphrase → same key for every file ever
**File:** `src/services/localVault/store.ts:56-60`
Combined with F1, an attacker who compromises one vault file can pre-compute a rainbow table for common passphrases that works for ALL users with the same passphrase.
**Fix:** Generate `salt = randomBytes(16)` on first encryption, store at top of vault file, use `scrypt(pass, salt, 32)`.

### F3. MEDIUM — IV is per-record, but no associated-data (AAD) binding
**File:** `src/services/localVault/store.ts:119-133`
GCM with no AAD means an attacker who can swap encrypted records (e.g., cross-user swap on shared filesystem) gets a successful decrypt with valid auth tag for the wrong key. Less of a real-world concern but plain best practice.
**Fix:** `cipher.setAAD(Buffer.from(key))` — bind the entry-key into the auth tag so swapping records fails decryption.

---

## G. Error matrix / UX text

### G1. MEDIUM — `prepareWorkspaceApiRequest` error mentions "Subscription OAuth … cannot reach these endpoints" — confusing for first-time users
**File:** `src/utils/teleport/api.ts:191-202`
The error implies user did something wrong; really they just don't have a workspace key yet. PR-4 adds a nice setup guide in `WorkspaceKeyInstructions` UI but the API-layer error is shown for non-`/login` paths.
**Fix:** Refer the user to `/login` to see setup instructions: `… run /login to see how to enable workspace endpoints.`

### G2. MEDIUM — 4 P2 clients duplicate identical 401/403/404/429 messages with copy-paste; one off-by-one
**Files:** `agentsApi.ts:80-98`, `vaultsApi.ts:114-138`, `memoryStoresApi.ts`, `skillsApi.ts`
agents: no 429 handler; vaults/memory/skills: have 429 handler. Inconsistent UX.
**Fix:** Extract `classifyWorkspaceApiError(err, resourceName, id?)` to one helper.

### G3. LOW — `switchProvider` warning is plain text; user sees it once via `logError` then forgets
**File:** `src/services/providerRegistry/switcher.ts:45`
`assertNoAnthropicEnvForOpenAI()` only logs to stderr. The CLI render of `/providers use cerebras` does not surface this warning to the Ink view.
**Fix:** `switchProvider()` should include the warning in `result.warnings` rather than relying on side-channel logging.

### G4. LOW — `LocalVaultDecryptionError` message says "wrong passphrase or tampered data" but does not direct user to recovery
**File:** `src/services/localVault/store.ts:158-160`
**Fix:** Append: `Restore from your backup of ~/.claude/.local-vault-passphrase, or delete ~/.claude/local-vault.enc.json to reset (DESTROYS ALL SECRETS).`

---

## H. Duplication

### H1. MEDIUM — 4× `buildHeaders()`, `classifyError()`, `withRetry()`, `parseRetryAfterMs()`, `sanitizeId()` duplicated across vaultsApi/agentsApi/memoryStoresApi/skillsApi
**Files:** `src/commands/{vault,agents-platform,memory-stores,skill-store}/*Api.ts`
Each file has its own `class XxxApiError`, identical `withRetry` body (60+ lines), identical `parseRetryAfterMs`. Total duplication ~400 lines.
**Fix:** Extract `src/services/auth/workspaceApiClient.ts` exporting `createWorkspaceClient(resourcePath, betaHeader)` returning `{ list, get, post, archive, withRetry, classifyError }`.

### H2. MEDIUM — 6 commands (vault, memory-stores, agents-platform, skill-store, local-vault, local-memory, provider) all share parseArgs / launch / View shape
Each implements ~60 lines of `parseArgs.ts`, ~120 lines of `launch*.tsx`, ~120 lines of `View.tsx`.
**Fix:** Add `src/commands/_shared/launchCommand.ts` taking a `{ parse, dispatch, render }` triple — cuts boilerplate in half.

### H3. MEDIUM — `sanitizeId` defined identically in 4 P2 client files
**Fix:** Move to `src/services/auth/sanitize.ts`.

---

## I. Test coverage gap

### I1. HIGH — No test asserts secret value never appears in any log stream
**Files:** `src/services/localVault/__tests__/*.test.ts`, `src/commands/local-vault/__tests__/*.test.ts`
The test suite has happy-path round-trip (encrypt → decrypt = original) but no assertion like:
```ts
expect(logErrorMock.mock.calls.flat().join(' ')).not.toContain(SECRET_VALUE)
expect(consoleWarnMock.mock.calls.flat().join(' ')).not.toContain(SECRET_VALUE)
```
This is the security invariant the design claims; without explicit grep-style tests it can regress silently.
**Fix:** Add `tests/security-invariants/local-vault-no-leak.test.ts`.

### I2. MEDIUM — No test for AES-GCM tamper detection
**File:** `src/services/localVault/__tests__/store.test.ts`
Should include: (1) flip a byte in `data` → expect `LocalVaultDecryptionError`; (2) flip a byte in `tag` → same; (3) swap IVs between records → same.

### I3. MEDIUM — No test for `multiStore` path traversal attempts
**File:** `src/services/SessionMemory/__tests__/multiStore.test.ts`
Should test: `setEntry('..', 'k', 'v')`, `setEntry('a/b', ...)`, `setEntry('C:hack', ...)`, `setEntry('foo\\u0000', ...)`.

---

## J. Performance / edge

### J1. MEDIUM — `loadProviders()` does fresh disk read on every `findProvider()` call
**File:** `src/services/providerRegistry/loader.ts:133-138`
Hot path: `getAuthStatus()` → `loadProviders()` → 4 file reads in `/login` flow alone. Not crippling but unnecessary.
**Fix:** Memoize per-process with file mtime invalidation.

### J2. MEDIUM — `setSecret` reads entire vault file, parses JSON, writes entire file every call
**File:** `src/services/localVault/store.ts:194-217`
For users with 100+ secrets each call is O(N). At 1000 entries x 1KB = 1MB read+write per `setSecret`.
**Fix:** OS keychain primary path is O(1), so only file-fallback users hit this. Acceptable for v1; document scale limit (~100 entries) in README.

### J3. LOW — `applyCompatRule()` deep-copies messages array (`.map` returning new objects)
**File:** `src/services/providerRegistry/providerCompatMatrix.ts:132-176`
Per chat completion, ~messages.length object allocations. For 100-turn conversations this is 100 small alloc per request — probably negligible vs network latency.
**Fix:** None for now; revisit if profiler shows hot.

---

## OVERALL VERDICT

- **Total findings:** 40 (1 CRITICAL · 10 HIGH · 22 MEDIUM · 7 LOW)
- **Net assessment:** Code is functional, well-tested at the unit level, and safer than the cross-audit baseline (2026-04-29 found 0/5/13). However, the **single CRITICAL (E1: Windows path traversal in `multiStore`) is a real escalation surface** — a user on Windows can write to arbitrary locations via `/local-memory store C:foo k v`. The 3 concurrency HIGHs (C1/C2/C3) are correctness issues that will bite in scripted use. The crypto HIGHs (F1/F2) reduce the security promise of the file-fallback path under low-entropy passphrases.

### TOP 5 must-fix (recommended for PR-5)

1. **E1 (CRITICAL)** — Strengthen `multiStore.validateStoreName` to reject `:`, `..`, null bytes, drive prefixes, and assert `store === basename(store)`. Add path-traversal regression tests (I3). **~40 LOC + 10 tests.**
2. **C1 + C2 + C3 (HIGH x3)** — Atomic `.tmp` + rename for `localVault/store.ts`, `multiStore.ts`, `providerRegistry/loader.ts` writes; add in-process mutex for `setSecret` and `saveProviders`. **~80 LOC + 6 tests.**
3. **F1 + F2 (HIGH x2)** — Replace SHA-256 KDF with scryptSync + per-vault random salt. **~30 LOC + 3 tests.** Backward compat: detect old-format files (no `salt` field) and migrate on first decrypt.
4. **D1 + D2 (HIGH x2)** — Add `MAX_VALUE_BYTES` (64KB local-vault, 1MB local-memory) checks at write entry points. **~20 LOC + 4 tests.**
5. **I1 (HIGH)** — Add explicit no-leak grep tests for local-vault and local-memory paths (assert SECRET never in any mock log/warn/onDone capture). **~50 LOC of test code.**

### Estimated PR-5 fix workload

- **TOP-5 critical/high fixes:** ~220 LOC source + ~150 LOC tests across ~6 files → 1 PR
- **Remaining 9 HIGH (G1, H1-H3 dedup, I2-I3, J1-J2, A1, A4):** ~400 LOC refactor / dedup → 1 PR
- **22 MEDIUM:** mostly small UX/validation tightening → 2 PRs

**Total estimated work:** ~770 LOC source + ~250 LOC tests → 4 PRs over ~2 days.

The code overall demonstrates sound engineering discipline (immutable patterns in `applyCompatRule`, hostGuard early-detection, per-IV randomization, secret-never-in-onDone in launch files). The findings here are mostly tightening the perimeter rather than rewrites.
