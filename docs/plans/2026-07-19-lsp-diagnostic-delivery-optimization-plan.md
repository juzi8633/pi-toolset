# LSP Diagnostic Delivery Optimization Implementation Plan

**Goal:** Eliminate repeated passive-diagnostic steering turns while preserving durable LLM delivery, latest-snapshot batching, and actionable cross-turn deduplication.

**Inputs:** User report and screenshot from 2026-07-19; repository evidence from `packages/pi-lsp/src/index.ts`, `packages/pi-lsp/src/diagnostics.ts`, `packages/pi-lsp/tests/diagnostics.test.ts`, `packages/pi-lsp/fixtures/phase2-diagnostics/README.md`, and commit `2e047e4`; Pi extension lifecycle and `sendMessage` semantics from `@earendil-works/pi-coding-agent` 0.80.10 `docs/extensions.md`.

**Assumptions:**

- Passive diagnostics are next-run context, not mid-run control instructions: diagnostics received during an active agent run are delivered on the next user-initiated `before_agent_start` event.
- Diagnostic messages must remain durable hidden custom messages in session history; ephemeral `context` mutation is not restored.
- An unchanged diagnostic must not be re-injected merely because its file was edited. A clean server report clears that server's delivered keys, allowing the same diagnostic to surface again if it is later reintroduced.
- No new configuration option or arbitrary debounce duration is introduced. Lifecycle batching replaces timer-based batching.

**Architecture:** LSP push and pull results continue to update the registry's latest `(server, URI)` snapshots. Registration no longer schedules `sendMessage(..., { deliverAs: "steer" })`; instead, `before_agent_start` drains all pending snapshots once and returns one durable hidden custom message. File edits invalidate stale pending snapshots but preserve delivered dedup keys until the originating server publishes a clean result.

**Tech Stack:** TypeScript, Bun test runner, Pi extension lifecycle hooks, `vscode-languageserver-types`, existing pi-lsp diagnostic registry.

---

## Scope

**In scope:** delivery timing, batching, durable message construction, edit-aware dedup invalidation, lifecycle tests, behavior documentation, and the existing real-server smoke fixture.

**Out of scope:** severity filtering, configurable debounce intervals, diagnostic filtering by `.gitignore` or current worktree, changes to per-file/global volume caps, and diagnostic-key normalization for line shifts. These can be evaluated separately because each may hide legitimate diagnostics.

## File Map

- Create: `packages/pi-lsp/src/diagnostic-delivery.ts` — construct one durable hidden diagnostic message from a registry drain.
- Modify: `packages/pi-lsp/src/index.ts` — replace reactive microtask steering with `before_agent_start` delivery and use pending-only invalidation after edits/writes.
- Modify: `packages/pi-lsp/src/diagnostics.ts` — remove registration callbacks and preserve delivered keys across edits while invalidating stale pending snapshots.
- Test: `packages/pi-lsp/tests/diagnostic-delivery.test.ts` — cover durable message creation and one-shot drain behavior.
- Test: `packages/pi-lsp/tests/index.test.ts` — cover lifecycle registration, batching, and absence of reactive `sendMessage` delivery.
- Test: `packages/pi-lsp/tests/diagnostics.test.ts` — cover pending-only invalidation, unchanged-diagnostic suppression, clean-report clearing, and later reintroduction.
- Modify: `packages/pi-lsp/README.md` — summarize next-run passive diagnostic delivery.
- Modify: `packages/pi-lsp/docs/explanation.md` — explain lifecycle batching and edit-aware dedup semantics.
- Modify: `packages/pi-lsp/docs/how-to.md` — clarify pending vs. delivered state and when pending diagnostics reach the LLM.
- Modify: `packages/pi-lsp/docs/reference.md` — update statusline lifetime semantics.
- Modify: `packages/pi-lsp/fixtures/phase2-diagnostics/README.md` — align smoke-test timing and unchanged-diagnostic expectations with the implementation.

## Tasks

### Task 1: Add durable diagnostic message construction

**Outcome:** Formatting and registry draining are isolated behind one typed helper that returns either one Pi custom message or no message.

**Files:**

- Create: `packages/pi-lsp/src/diagnostic-delivery.ts`
- Test: `packages/pi-lsp/tests/diagnostic-delivery.test.ts`

**Steps:**

- [ ] Create `packages/pi-lsp/src/diagnostic-delivery.ts` with the required two-line `ABOUTME` header.
- [ ] Move `DIAGNOSTIC_CUSTOM_TYPE = 'lsp-diagnostics'` from `src/index.ts` into the new module and export it.
- [ ] Import `BeforeAgentStartEventResult` from `@earendil-works/pi-coding-agent` and define the helper return type as `NonNullable<BeforeAgentStartEventResult['message']>`.
- [ ] Add `drainDiagnosticMessage(cwd: string)` that calls `diagnostics.drain(cwd)`, returns `undefined` for a null drain, and otherwise returns:

  ```ts
  {
    customType: DIAGNOSTIC_CUSTOM_TYPE,
    content: block,
    display: false,
    details: { source: 'pi-lsp' },
  }
  ```

- [ ] Keep timestamps out of the helper; Pi assigns message metadata when it persists the `before_agent_start` result.
- [ ] Add test setup/teardown that calls `diagnostics.resetAll()` so module-global registry state cannot leak between tests.
- [ ] Test that one registered diagnostic produces the expected custom type, hidden display flag, source detail, formatted path, and diagnostic text.
- [ ] Test that no pending diagnostics returns `undefined`.
- [ ] Test that a second helper call after one successful drain returns `undefined`.

**Validation:**

- Run: `cd packages/pi-lsp && bun test tests/diagnostic-delivery.test.ts tests/diagnostics.test.ts`
- Expected: the new helper tests and existing registry tests pass with no duplicate second drain.

### Task 2: Replace reactive steering with lifecycle batching

**Outcome:** Diagnostic registration never queues a steering message; the next user-initiated agent run receives at most one durable diagnostic message containing the latest pending snapshots.

**Files:**

- Modify: `packages/pi-lsp/src/index.ts`
- Modify: `packages/pi-lsp/src/diagnostics.ts`
- Test: `packages/pi-lsp/tests/index.test.ts`

**Steps:**

- [ ] In `src/index.ts`, remove `unsubscribeDiagnosticRegistered`, `diagnosticFlushScheduled`, `diagnosticFlushGeneration`, and `scheduleDiagnosticFlush()`.
- [ ] Remove the `session_start` subscription to `diagnostics.onDiagnosticRegistered()` and the corresponding `session_shutdown` cleanup/generation invalidation.
- [ ] Remove the direct `pi.sendMessage(..., { deliverAs: 'steer' })` diagnostic path entirely. Do not replace it with `followUp` or `nextTurn`; both create separate queue semantics that lifecycle injection does not need.
- [ ] Import `drainDiagnosticMessage()` and register one `before_agent_start` handler:

  ```ts
  pi.on('before_agent_start', (_event, ctx) => {
    const message = drainDiagnosticMessage(ctx.cwd);
    if (!message) return;
    logForDebugging(`diagnostics: injecting durable block for ${ctx.cwd}`);
    return { message };
  });
  ```

- [ ] In `src/diagnostics.ts`, remove `diagnosticRegisteredListeners`, `notifyOnDiagnosticRegistered()`, and the exported `onDiagnosticRegistered()` API. `register()` must only update registry state, status listeners, and logs.
- [ ] Create `tests/index.test.ts` with the required two-line `ABOUTME` header and a minimal fake `ExtensionAPI` that records `on()` handlers, `sendMessage()` calls, and accepts tool/command registration.
- [ ] Invoke the extension factory and assert it registers `before_agent_start` but does not register diagnostic delivery through `context`.
- [ ] Register several snapshots before invoking `before_agent_start`: replace one server/file snapshot multiple times and add a second server snapshot. Assert the handler returns one message containing only each server/file's latest snapshot.
- [ ] Assert registration and microtask flushing produce zero `sendMessage()` calls.
- [ ] Invoke `before_agent_start` again without new diagnostics and assert it returns `undefined`.

**Validation:**

- Run: `cd packages/pi-lsp && bun test tests/index.test.ts tests/diagnostic-delivery.test.ts`
- Expected: one `before_agent_start` delivery contains the batched latest snapshots, no reactive custom messages are sent, and a second lifecycle call has nothing to deliver.

### Task 3: Preserve cross-edit deduplication

**Outcome:** Editing a file discards stale pending results but does not make unchanged delivered diagnostics new again; clean server reports still reset the relevant delivered history.

**Files:**

- Modify: `packages/pi-lsp/src/diagnostics.ts`
- Modify: `packages/pi-lsp/src/index.ts`
- Test: `packages/pi-lsp/tests/diagnostics.test.ts`

**Steps:**

- [ ] Replace `clearForFile(uri)` with `invalidatePendingForFile(uri)` in `src/diagnostics.ts` and all call sites.
- [ ] Implement `invalidatePendingForFile()` by deleting every pending `(server, URI)` entry for the URI, leaving `deliveredDiagnostics` unchanged, logging the invalidation, and preserving existing `notifyIfChanged()` transition behavior.
- [ ] Update comments to state that edit invalidation removes stale pre-edit snapshots while cross-turn history is cleared only by a clean server publish or `resetAll()`.
- [ ] In the edit/write `tool_result` handler in `src/index.ts`, call `invalidatePendingForFile(uri)` immediately before LSP synchronization. Keep synchronization best-effort and do not drain from this handler.
- [ ] Update the existing multi-server invalidation test to assert pending entries from every server are removed.
- [ ] Add a test sequence: register diagnostic → drain → invalidate pending → register the identical diagnostic → drain returns `null`.
- [ ] Extend that sequence with an empty publish from the same server, then register the identical diagnostic again and assert it is delivered. This proves fix-then-reintroduce remains observable.
- [ ] Add a multi-server test proving a clean publish clears delivered keys only for the publishing server while another server's delivered keys remain deduplicated.
- [ ] Update status-presence tests: pending invalidation must not clear a delivered diagnostic; a clean publish or reset must clear the final state.

**Validation:**

- Run: `cd packages/pi-lsp && bun test tests/diagnostics.test.ts`
- Expected: unchanged diagnostics remain suppressed across edits, pending snapshots are invalidated for all servers, and clean-report/reintroduction behavior passes.

### Task 4: Document delivery and status semantics

**Outcome:** User-facing and maintainer documentation matches next-run durable batching and clean-report-based dedup clearing.

**Files:**

- Modify: `packages/pi-lsp/README.md`
- Modify: `packages/pi-lsp/docs/explanation.md`
- Modify: `packages/pi-lsp/docs/how-to.md`
- Modify: `packages/pi-lsp/docs/reference.md`
- Modify: `packages/pi-lsp/fixtures/phase2-diagnostics/README.md`

**Steps:**

- [ ] In `README.md`, state that passive diagnostics are batched into one hidden durable message on the next user-initiated agent run and do not steer an active run.
- [ ] In `docs/explanation.md`, document the state flow: push/pull registration → latest snapshot pending → `before_agent_start` drain → delivered dedup → clean publish clearing.
- [ ] In `docs/how-to.md`, clarify that `Pending` means waiting for the next user-initiated agent run and `Delivered` means persisted and retained for deduplication.
- [ ] In `docs/reference.md`, replace “until the file is edited” statusline wording with “until the originating server reports the diagnostic clean or diagnostic state is reset.”
- [ ] In the smoke fixture README, keep the two-turn timing contract, replace stale references to edit-cleared dedup, and add an explicit observation that the first edit turn must not generate a chain of `[lsp-diagnostics]` steering responses.
- [ ] Document that an LSP publish arriving after `before_agent_start` remains pending for the following user run rather than interrupting the active run.
- [ ] Do not add configuration documentation because no configuration surface changes.

**Validation:**

- Run: `hk check`
- Expected: ESLint and Prettier checks pass repo-wide, including Markdown formatting.

### Task 5: Run regression and real-server validation

**Outcome:** The optimized pipeline passes automated checks and demonstrates one-batch, next-run behavior against a real TypeScript language server.

**Files:**

- Test: `packages/pi-lsp/fixtures/phase2-diagnostics/README.md`

**Steps:**

- [ ] Run the complete pi-lsp test suite, type check, and build.
- [ ] From `packages/pi-lsp/fixtures/phase2-diagnostics`, run the documented reset/check commands and launch Pi with the rebuilt extension.
- [ ] Perform the existing two-turn TypeScript diagnostic scenario.
- [ ] During Turn 1, confirm no sequence of hidden `[lsp-diagnostics]` steering messages causes repeated assistant acknowledgements.
- [ ] During Turn 2, confirm exactly one diagnostic block is present and includes the final TypeScript diagnostic snapshot.
- [ ] Make an unrelated edit that leaves the same diagnostic unchanged, start another user run, and confirm the identical diagnostic is not injected again.
- [ ] Fix the diagnostic, wait for a clean publish, reintroduce the identical issue, and confirm it is injected again on the following user run.
- [ ] Record real-server validation results in the implementation summary; do not add generated logs to the repository.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: all pi-lsp tests pass.
- Run: `mise run typecheck --package packages/pi-lsp`
- Expected: TypeScript reports no errors.
- Run: `mise run build --package packages/pi-lsp`
- Expected: `packages/pi-lsp/dist/index.js` and the generated schema build successfully.
- Run: `hk check`
- Expected: repository lint and formatting checks pass.
- Run: `cd packages/pi-lsp/fixtures/phase2-diagnostics && bun run reset && bun run check`
- Expected: the fixture baseline is restored and its static check passes before and after manual testing.

## Final Validation

- Run: `mise run test --package packages/pi-lsp && mise run typecheck --package packages/pi-lsp && mise run build --package packages/pi-lsp && hk check`
- Expected: the full package suite, type check, build, schema generation, lint, and formatting all pass.
- Manual: execute the TypeScript two-turn smoke scenario in `packages/pi-lsp/fixtures/phase2-diagnostics/README.md`.
- Expected: zero diagnostic steering flood during the edit run, one batched durable block on the next user run, unchanged diagnostics suppressed across edits, and clean-then-reintroduced diagnostics delivered again.

## Failure Behavior

- **No pending diagnostics at `before_agent_start`:** return `undefined`; no custom message is persisted.
- **Diagnostics arrive after `before_agent_start`:** retain them in pending state for the next user-initiated run; never interrupt the current run.
- **Edit/write synchronization fails:** stale pending entries for the edited file remain invalidated, delivered dedup keys remain intact, the tool result is not disrupted, and future server publishes can repopulate pending state.
- **One server publishes an empty result:** clear only that server's pending and delivered keys for the URI; other servers remain unaffected.
- **Session shutdown/reload:** unsubscribe status listeners, shut down servers, and call `resetAll()` as today; no timers or queued diagnostic steering messages remain to cancel.

## Privacy and Security

- Diagnostic messages can contain project paths, source-derived text, and toolchain messages. They already enter Pi's LLM context and persisted session history; this plan changes timing and batching but adds no new destination or external write.
- Hidden delivery (`display: false`) is retained. `/lsp diagnostics` remains the explicit human inspection path.
- `.gitignore` and worktree filtering are intentionally not changed in this plan because silently dropping diagnostics changes the trust boundary and requires a separate product decision.

## Rollout Notes

- No migration or configuration change is required.
- Historical `lsp-diagnostics` custom messages remain in existing session files.
- Reloading the extension clears in-memory pending/delivered state as it does today; subsequent LSP publishes repopulate the registry.
- The behavior change is intentional: passive diagnostics no longer attempt same-run self-correction and instead match the fixture's documented next-query model.

## Risks and Mitigations

- **Next-run delivery reduces immediate self-correction.** This is the explicit tradeoff for eliminating forced steering loops; users can inspect current state with `/lsp diagnostics`, and the next prompt receives a durable batch.
- **A server may publish after the next run begins.** Keep the result pending rather than introducing a timing delay into every prompt.
- **Delivered status may remain red if a server never sends a clean report.** Preserve `/lsp diagnostics` visibility and session reset behavior; do not erase dedup state on arbitrary edits.
- **Range changes can make an otherwise similar diagnostic appear new.** Existing key semantics are retained; normalization is out of scope to avoid merging distinct issues.
- **Workspace or `.worktrees` diagnostics may still be noisy within one batch.** The flood is removed, but scope filtering remains a separate follow-up because filtering can hide valid generated or ignored-file diagnostics.

## Open Questions

**None for this implementation.** Severity policy and worktree/gitignore filtering should be evaluated only after measuring the lifecycle-batched behavior.
