# LSP Startup Retry Policy Implementation Plan

**Goal:** Prevent repeated LSP startup attempts for permanent configuration/path failures while retrying transient or unknown startup failures with a bounded retry budget.

**Inputs:** User request on 2026-06-19: path errors or user configuration argument startup failures should not retry; unknown non-configuration failures should retry with a cap. Repository evidence from `src/index.ts`, `src/manager.ts`, `src/instance.ts`, `src/client.ts`, `src/tools.ts`, and `src/types.ts`.

**Assumptions:**

- “Path error” means errors caused by an invalid `command`, `cwd`/`workspaceFolder`, or executable permissions, identified by Node spawn error codes such as `ENOENT`, `ENOTDIR`, `EACCES`, and `EISDIR`.
- “User configuration parameter error” means startup-time server stderr or failure text clearly indicating invalid CLI arguments/options, missing argument values, invalid initialization settings, or unsupported transport/config fields.
- Failures that cannot be confidently classified as permanent should remain retryable, but only up to a configured cap.
- Default retry cap should reuse `maxRestarts ?? 3` unless a separate field is added; this keeps the first implementation small and avoids new config surface unless tests show ambiguity.

**Architecture:** Add a small startup-failure classifier and retry policy to the single-server state machine in `src/instance.ts`. `src/client.ts` will preserve enough structured startup failure evidence, especially spawn error codes and bounded stderr, so `instance.ts` can decide whether the next `ensureServerStarted()` should retry or immediately return the stored permanent failure. `manager.ts`, `index.ts`, and `tools.ts` keep their current lazy-start flow, but their user-facing messages should surface the non-retryable reason.

**Tech Stack:** TypeScript, Node child process spawn, `vscode-jsonrpc`, Vitest, existing `mise` tasks (`mise run typercheck`, `mise run test`, `mise run build`, `hk check`).

---

## File Map

- Create: `src/startup-errors.ts` — classify LSP startup failures as permanent or retryable and expose typed metadata used by `instance.ts`.
- Modify: `src/client.ts` — attach spawn error codes and bounded startup stderr to errors thrown during `start()` / initialization.
- Modify: `src/instance.ts` — track retry policy state, block known permanent failures, and cap retryable startup failures.
- Modify: `src/types.ts` — add startup failure/retry metadata types if they need to be shared with notifications or tool result details.
- Modify: `src/notifications.ts` — include clearer wording when a server is blocked because startup failure is permanent or retries are exhausted.
- Modify: `src/tools.ts` — keep the existing `server.state === 'error'` handling but display the new failure reason from `server.lastError`.
- Modify: `src/index.ts` — keep edit-sync best-effort behavior; no functional change expected unless notification wording needs the new metadata.
- Modify: `README.md` — document the retry policy, permanent failure classes, and how to recover from a blocked server.
- Test: `tests/startup-errors.test.ts` — unit coverage for classifier behavior.
- Test: `tests/instance-startup-retry.test.ts` — lifecycle coverage for retry cap and permanent failure blocking, using a lightweight fake client hook or injectable client factory.

## Failure Categories

### Permanent failures: do not retry automatically

These failures should leave the server in `error` and mark startup as non-retryable until the manager/session is reinitialized, the configuration changes, or an explicit future restart API clears the block.

- Missing executable: spawn error `code === 'ENOENT'`.
- Invalid executable path component: `ENOTDIR`, `EISDIR`, `ENAMETOOLONG`.
- Executable permission/format problems that require user action: `EACCES`, `EPERM`, `ENOEXEC`.
- Invalid `workspaceFolder` / spawn `cwd`: `ENOENT`, `ENOTDIR`, `EACCES` from spawn context.
- Clearly invalid CLI args/options from startup stderr or error message, using conservative patterns:
  - `unknown option`, `unrecognized option`, `invalid option`, `illegal option`, `bad option`
  - `missing required argument`, `option requires an argument`, `requires a value`
  - `unknown command`, `invalid command`, `unsupported option`
- Clearly invalid configuration/initialization failure from initialize response text:
  - `invalid initializationOptions`, `invalid configuration`, `unsupported transport`, `failed to parse config`

### Retryable failures: retry with cap

These failures should retry on the next `ensureServerStarted()` until the startup retry cap is exhausted.

- Startup timeout from `startupTimeout`.
- JSON-RPC connection closed during startup without a permanent pattern.
- Server process exits during startup with non-zero code but no permanent stderr pattern.
- Initialize request rejects with an unknown or transient error.
- Any error without a known permanent spawn code or conservative permanent text pattern.

### Out of scope for this plan

- Adding an interactive command to reset a blocked server without session reload.
- Watching config files and automatically clearing permanent failure state when config changes.
- Per-server custom classifier rules.

## Tasks

### Task 1: Add typed startup failure classification

**Outcome:** Startup failures are classified consistently as permanent or retryable with a stable reason code.

**Files:**

- Create: `src/startup-errors.ts`
- Modify: `src/types.ts` only if exported/shared types are needed outside `startup-errors.ts`
- Test: `tests/startup-errors.test.ts`

**Steps:**

- [ ] Create `src/startup-errors.ts` with the required two `ABOUTME` lines.
- [ ] Define `StartupFailureKind` with values such as `permanent-path`, `permanent-arguments`, `permanent-configuration`, `retryable-timeout`, and `retryable-unknown`.
- [ ] Define `StartupFailureClassification` with `retryable: boolean`, `kind`, and `reason`.
- [ ] Implement `classifyStartupFailure(error: unknown): StartupFailureClassification`.
- [ ] Classify Node spawn errors by `code` before text matching.
- [ ] Match permanent CLI/config text conservatively against the error message and bounded stderr.
- [ ] Default unmatched errors to `{ retryable: true, kind: 'retryable-unknown' }`.
- [ ] Add tests in `tests/startup-errors.test.ts` for `ENOENT`, `EACCES`, invalid option stderr, initialization config text, timeout text, and unknown errors.

**Validation:**

- Run: `bun test tests/startup-errors.test.ts`
- Expected: all classifier cases pass, and unknown errors remain retryable.

### Task 2: Preserve structured startup error evidence in the client

**Outcome:** Errors thrown by `client.start()` and `client.initialize()` carry enough evidence for classification without parsing only generic wrapper messages.

**Files:**

- Modify: `src/client.ts`
- Test: `tests/startup-errors.test.ts` or `tests/instance-startup-retry.test.ts`

**Steps:**

- [ ] Add a small internal helper to attach metadata to errors without changing public API shape, for example `startupStderr`, `spawnCode`, and `phase`.
- [ ] Capture stderr in a bounded buffer, for example the last 8 KiB, while startup/initialization is in progress.
- [ ] Include the bounded stderr in errors thrown from failed initialize, early connection close, and early process exit.
- [ ] Preserve the original Node spawn error `code` for `ENOENT`, `EACCES`, and related path failures.
- [ ] Avoid logging or storing unbounded stderr; keep current debug logging behavior unchanged.
- [ ] Ensure `client.stop()` cleanup still clears process/connection resources after startup failure.

**Validation:**

- Run: `mise run typercheck`
- Expected: no TypeScript errors from the new metadata helper.

### Task 3: Enforce retry policy in the server instance state machine

**Outcome:** `ensureServerStarted()` retries retryable startup failures only up to the cap and never retries known permanent failures.

**Files:**

- Modify: `src/instance.ts`
- Possibly Modify: `src/types.ts`
- Test: `tests/instance-startup-retry.test.ts`

**Steps:**

- [ ] Add per-instance state for startup retry policy: `startupFailureClassification`, `startupAttemptCount`, and `startupRetryExhausted`.
- [ ] In `doStart()` before spawning, immediately throw `lastError` when the previous failure is non-retryable.
- [ ] In `doStart()` before spawning, immediately throw a clear “startup retry limit exceeded” error when retryable failures have reached the cap.
- [ ] Use `config.maxRestarts ?? 3` as the startup retry cap for the first implementation.
- [ ] Increment startup attempts only for actual startup attempts, not for calls blocked by permanent failure or exhausted retry budget.
- [ ] On successful startup, reset startup failure classification and attempt count.
- [ ] In the catch block, call `classifyStartupFailure(error)`, save the classification, update `lastError` to include the classification reason, and leave `state = 'error'`.
- [ ] Keep existing `crashRecoveryCount` behavior for post-start crashes, but do not let crash-recovery accounting hide startup retry accounting.
- [ ] Ensure concurrent startup callers still share `startingPromise` and do not double-count a single in-flight attempt.

**Validation:**

- Run: `bun test tests/instance-startup-retry.test.ts`
- Expected:
  - permanent spawn/path failure attempts exactly once, then later starts are blocked without calling the client again;
  - retryable unknown failure attempts up to `maxRestarts ?? 3`, then later starts are blocked;
  - successful startup after a retryable failure clears the failure state;
  - concurrent callers await one startup attempt.

### Task 4: Surface clear user-facing failure messages

**Outcome:** Tool and edit-triggered notifications explain whether the server is blocked permanently or retry-limited, and what the user should do next.

**Files:**

- Modify: `src/notifications.ts`
- Modify: `src/tools.ts`
- Modify: `src/index.ts` only if notification call arguments need the new reason

**Steps:**

- [ ] Update failed-start formatting to include the classifier reason when present, for example “not retrying because the executable was not found” or “retry limit exceeded after 3 startup attempts”.
- [ ] Keep the existing missing-server path separate from configured-but-failed-server path.
- [ ] For edit-triggered sync failures, continue swallowing exceptions so edits are not disrupted.
- [ ] Ensure repeated edits after a permanent failure do not spam different messages; reuse existing notification dedup behavior if present.

**Validation:**

- Run: `mise run typercheck`
- Expected: user-facing message code compiles and no call sites lose required arguments.

### Task 5: Document configuration and recovery behavior

**Outcome:** Users know which startup failures are retried, which require action, and how to recover.

**Files:**

- Modify: `README.md`

**Steps:**

- [ ] Add a short “Startup failures and retries” section.
- [ ] Document permanent failures: missing executable, invalid command path, permission errors, and invalid CLI arguments.
- [ ] Document retryable failures: timeout, unknown early process exit, unknown initialization error.
- [ ] Document that fixing permanent failures currently requires correcting config/PATH and reloading or restarting the session.
- [ ] Document that `maxRestarts` also caps startup retries unless a separate config field is introduced later.

**Validation:**

- Run: `hk check`
- Expected: markdown and TypeScript formatting/lint checks pass.

## Final Validation

- Run: `bun test tests/startup-errors.test.ts tests/instance-startup-retry.test.ts`
- Expected: classifier and retry policy tests pass.
- Run: `mise run typercheck`
- Expected: TypeScript check passes.
- Run: `mise run build`
- Expected: package builds successfully.
- Run: `hk check`
- Expected: eslint and prettier checks pass.

## Rollout Notes

- This changes behavior for broken LSP configurations: after a permanent failure, later edits of the same file type will not keep spawning the same failing process.
- Users who fix PATH/config during the same Pi session may need to reload/restart the session because this plan intentionally does not add live config watching or an explicit reset command.
- Reusing `maxRestarts` for startup retries avoids a new config option, but it means one setting covers both crash recovery and startup retry caps. If this proves confusing, add a later `maxStartupRetries` field with `maxRestarts` as fallback.

## Risks and Mitigations

- **Risk:** Text matching could incorrectly classify a transient failure as permanent. — **Mitigation:** Only classify permanent text with conservative, explicit CLI/config patterns; default unmatched failures to retryable.
- **Risk:** Server stderr may contain sensitive project paths or arguments. — **Mitigation:** Store only a bounded buffer and surface a concise classifier reason rather than dumping full stderr in normal user-facing messages.
- **Risk:** Reusing `maxRestarts` may mix crash and startup semantics. — **Mitigation:** Keep the implementation simple first and document the behavior; add `maxStartupRetries` only if users need separate controls.
- **Risk:** Tests may require dependency injection into `createLSPServerInstance`. — **Mitigation:** Add the smallest internal optional client factory parameter or test-only helper without changing the public extension API.
