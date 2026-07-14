# Chain Fanout Durable Units Implementation Plan

**Goal:** Give every expanded chain fanout item its own canonical durable unit record, persist the original expansion before dispatch, and resume only incomplete items without recomputing or overwriting completed work.

**Inputs:** The original `packages/pi-agents/docs/plans/2026-07-13-agent-run-resume-plan.md` (especially Task 6), the reviewer finding about shared fanout unit identity, the worker analysis of the current flow, and repository evidence from `chain.ts`, `tool.ts`, `run-coordinator.ts`, `run-persistence.ts`, `run-types.ts`, `resume.ts`, and their tests at commit `5bb8eb4`.

**Assumptions:**

- Keep `RUN_RECORD_VERSION = 1`; `workflowState.fanouts`, `RunUnitRecord.step`, and `RunUnitRecord.fanoutIndex` already exist in the V1 contract, so this change completes intended semantics rather than introducing a new record version.
- New runs do not create executable placeholder records such as `chain-0002-fanout`. Fanout item records are created only after expansion determines the scheduled item count.
- `WorkflowFanoutState.items` stores the ordered, post-`maxItems` items that can actually be scheduled. The logical fanout step retains the original skipped count for rendering.
- A restored incomplete fanout with item results but no valid stored fanout mapping is unsafe to replay and is rejected with `stored_fanout_state_unavailable`; completed historical runs remain readable.
- `RunUnitRecord` is authoritative for item status, attempts, session/worktree paths, and terminal result. `SubagentDetails.results` remains the ordered presentation projection.
- Expansion persistence must complete successfully before the first fanout worker is scheduled. A persistence error fails the run without launching an item.
- Each implementation task is committed separately on `fix/run-resume-critical`; no commit is pushed unless explicitly requested.

**Architecture:** Keep `runChainWorkflow` independent of `RunStore` and `RunCoordinator` by adding an awaited fanout-expansion hook and propagating the zero-based item index through `ChainStepRequest`. Canonical ID helpers in `run-coordinator.ts` produce IDs directly from immutable one-based step and zero-based item positions. The durable adapter in `tool.ts` resolves the agent/runtime/cwd and calls a new coordinator expansion operation that atomically persists the ordered mapping and all queued item records before dispatch. Resume validates that mapping, treats per-item unit records as authoritative, restores completed results, and schedules only incomplete items.

**Tech Stack:** TypeScript, Bun tests, TypeBox-compatible persisted data, existing `RunStore` atomic `run.json` updates, and the current `RunCoordinator` active-record model.

---

## Scope

### Included

- Canonical IDs in the form `chain-<NNNN>-fanout-<NNNN>`.
- Dynamic creation of one `RunUnitRecord` per scheduled fanout item.
- Atomic persistence of `workflowState.fanouts[chain-<NNNN>-fanout]` and child units before worker dispatch.
- Per-item start, terminal, attempt, session, worktree, fingerprint, and result persistence.
- Selective resume using the stored expansion and per-item records.
- Empty source, `maxItems`, cancellation, out-of-order completion, and persistence-failure behavior.
- Documentation of durable fanout semantics and legacy incomplete-run refusal.

### Out of Scope

- Changing fanout concurrency limits or template syntax.
- Automatic migration or reconstruction of unsafe legacy partial fanout records.
- Background notification wording, `/agent resume` command UX, retention, or unrelated run-store cleanup.
- Introducing a second persisted schema version.

## File Map

- Modify: `packages/pi-agents/src/run-coordinator.ts` — canonical chain/fanout ID helpers, positional unit metadata, dynamic expansion API, and strict awaited persistence.
- Modify: `packages/pi-agents/src/run-persistence.ts` — create only statically known initial units and keep `StartedRun` comments/semantics accurate after dynamic expansion.
- Modify: `packages/pi-agents/src/chain.ts` — fanout expansion hook, per-item index propagation, restored mapping validation/use, and terminal result post-processing metadata.
- Modify: `packages/pi-agents/src/tool.ts` — durable expansion adapter, canonical chain lookup, per-item lifecycle context, and structured-output finalization before durable terminalization.
- Modify: `packages/pi-agents/src/resume.ts` — validate persisted fanout state, reject unsafe legacy state, restore per-item results, and preserve attempt numbers for never-started items.
- Modify: `packages/pi-agents/src/run-types.ts` — document existing fanout-state and positional-field invariants; no version bump or incompatible field change.
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts` — canonical IDs, initial-unit generation, dynamic registration, idempotence, conflict, and strict persistence tests.
- Modify: `packages/pi-agents/tests/chain.test.ts` — expansion ordering, index propagation, empty/truncated input, and restored item selection tests.
- Modify: `packages/pi-agents/tests/resume.test.ts` — selective fanout retry, stored mapping validation, legacy refusal, output integrity, and attempt semantics.
- Modify: `packages/pi-agents/tests/tool.test.ts` — durable chain integration, concurrent item isolation, and terminal post-processing ordering.
- Modify: `packages/pi-agents/README.md` — state that chain fanout resume preserves the original expansion and retries only incomplete items.
- Modify: `packages/pi-agents/docs/how-to.md` — add a fanout interruption/resume procedure and blocking-error guidance.
- Modify: `packages/pi-agents/docs/reference.md` — document canonical IDs, `workflowState.fanouts`, per-item records, and new resume errors.
- Modify: `packages/pi-agents/docs/explanation.md` — explain the expansion durability boundary and why legacy partial fanouts are not reconstructed.

## Tasks

### Task 1: Canonicalize Fanout Identity and Initial Units

**Outcome:** Chain positions no longer depend on `unitIds` array ordering, fanout IDs have exactly one padded `fanout` suffix, and initial run creation contains only units whose cardinality is known.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/run-persistence.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Add failing tests for canonical helpers that map step `2` and item index `0` to `chain-0002-fanout-0001`, reject non-positive steps/negative indexes, and never emit `fanout-fanout` or unpadded suffixes.
- [ ] Add `chainStepUnitId(step)`, `chainFanoutStepId(step)`, and `chainFanoutUnitId(step, fanoutIndex)` to `run-coordinator.ts`. Treat `step` as one-based and `fanoutIndex` as zero-based at every call site.
- [ ] Change `generateUnitIds()` for chain mode to return only statically known sequential IDs. Do not create `chain-NNNN-fanout` as a `RunUnitRecord`; reserve that form as the `workflowState.fanouts` key.
- [ ] Change `collectResolvedUnits()` in `tool.ts` to omit fanout descriptors and record sequential `step` values as `i + 1`, keeping its count aligned with `generateUnitIds()`.
- [ ] Add optional `step` and `fanoutIndex` fields to `UnitExecutionContext`, and copy both fields in `createUnitRecord()` so persisted records retain immutable positions.
- [ ] Rewrite the chain branch of `resolveUnitId()` to call the canonical helpers directly. It must not index `Object.keys(units)` or derive child IDs from a placeholder string.
- [ ] Update the `StartedRun.unitIds` documentation to describe initial/static IDs rather than claiming it always matches all dynamically expanded `record.units` keys.
- [ ] Run the focused tests and confirm the previous placeholder expectation is replaced by sequential-only initial IDs.
- [ ] Commit as `refactor(pi-agents): canonicalize chain fanout unit identity`.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-coordinator.test.ts packages/pi-agents/tests/tool.test.ts`
- Expected: Canonical ID and initial-record tests pass; no generated ID contains duplicate `fanout` segments or an unpadded position.

### Task 2: Persist Fanout Expansion and Dynamic Unit Records Atomically

**Outcome:** Once expansion succeeds, `run.json` contains the ordered item mapping and every queued child record before any item can execute.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`

**Steps:**

- [ ] Add a `FanoutExpansionInput` with `step`, scheduled `items`, resolved `AgentConfig`, effective `runtime`, and effective base cwd.
- [ ] Add an awaited `RunCoordinator.expandFanout(runId, input): Promise<WorkflowFanoutState>` operation. It generates canonical child IDs, creates queued `RunUnitRecord`s with `attempt: 1`, real fingerprints, runtime capability, one-based `step`, zero-based `fanoutIndex`, and no fabricated attempt history.
- [ ] Build the next `units` and `workflowState` snapshots without replacing the shared live `units` object. Persist the candidate snapshot through `RunStore.updateRun()` first; after success, mutate the shared object in place so `StartedRun.units`, the active record, and lifecycle hooks remain aliased.
- [ ] Cancel a pending coalesced timer before the strict expansion write. Do not use the best-effort/coalesced path for this boundary, and propagate write failures to the caller.
- [ ] Make later coordinator writes preserve `live.workflowState` so streaming updates and finalization cannot discard the expansion mapping.
- [ ] Make identical repeated expansion requests idempotent. Reject a different item list, step, unit mapping, or existing-unit collision with `fanout_state_conflict`.
- [ ] Define the empty expansion as a persisted state with `items: []` and `unitIds: []`; it creates no synthetic child record.
- [ ] Add tests proving the promise resolves only after the store contains both state and child records, strict write failure rejects, identical retries do not duplicate records, and conflicts do not mutate durable or live state.
- [ ] Commit as `feat(pi-agents): persist fanout expansion units atomically`.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-coordinator.test.ts`
- Expected: Dynamic child records and `workflowState.fanouts` are persisted together; persistence failures and conflicting re-expansions are deterministic and launch-independent.

### Task 3: Connect Chain Fanout Dispatch to Per-Item Lifecycle

**Outcome:** Every scheduled item uses its own existing unit record, and durable terminal state reflects the final schema-validated result rather than a pre-validation result.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Extend `ChainStepRequest` with `fanoutIndex?: number` and an optional idempotent terminal-result postprocessor used by the production adapter before worktree cleanup and `endUnit`.
- [ ] Extend `RunChainWorkflowOptions` with an optional awaited expansion hook carrying the `WorkflowFanoutState`, agent name, and effective base cwd. Keep the hook storage-agnostic; `chain.ts` must not receive a `RunStore` or `RunCoordinator` instance.
- [ ] In `runFanoutStep()`, resolve and validate the source, apply `maxItems`, render all tasks, build canonical ordered `unitIds`, and then await the expansion hook before creating running slots or calling `mapWithConcurrencyLimit()`.
- [ ] Invoke the expansion hook for an empty scheduled item list before returning the successful `0/0` result. Preserve the restored logical step's previous `skippedCount` instead of recomputing it from the already-truncated stored list.
- [ ] Pass the zero-based item index as `fanoutIndex` in every `opts.runStep()` call. Keep `onUnstarted` items queued in durable state; presentation may remain `skipped`, and these units must retain attempt `1` until first dispatch.
- [ ] Add `DurableRunContext.expandFanout()` in `tool.ts`. Resolve the exact requested agent (use a same-name synthetic config if discovery cannot resolve it; never substitute `agents[0]`), runtime override, and cwd, then delegate to `coordinator.expandFanout()`.
- [ ] Connect the chain expansion hook only when durability is active. Non-durable direct `runChainWorkflow()` callers continue using the same execution behavior without storage.
- [ ] Pass `req.fanoutIndex` to `durable.unitFor()` so `beginUnit`, session-file stamping, worktree stamping, `finishUnit`, and events target the corresponding child record.
- [ ] Move fanout schema validation and `step`/`fanout` metadata stamping into the terminal postprocessor that `runStepWithContext()` invokes before `finalizeWorktree()` and `endUnit()`. Keep the chain-side call idempotent so test stubs that ignore the optional callback still receive identical results.
- [ ] Add a test where three workers finish out of order and assert three distinct `unit_started`/`unit_terminal` identities and three independent terminal records; no result, session path, worktree path, or attempt may overwrite another item.
- [ ] Add tests proving expansion persistence completes before the first `runStep`, empty fanout persists an empty mapping, and `maxItems` creates records only for scheduled items.
- [ ] Commit as `fix(pi-agents): track chain fanout item lifecycle`.

**Validation:**

- Run: `bun test packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/run-coordinator.test.ts`
- Expected: Each dispatched item carries the expected padded unit ID and index; out-of-order completion cannot overwrite another item; no worker starts before expansion persistence resolves.

### Task 4: Restore and Retry Fanout Items Selectively

**Outcome:** Resume uses the stored expansion and child records as authoritative state, reuses completed results in original order, and dispatches only incomplete items.

**Files:**

- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] Add a fanout-state validator used by `inspectResume()`. For every incomplete fanout step, require a stored mapping whose `step` matches, whose `items.length` equals `unitIds.length`, whose IDs are unique and canonical, and whose IDs resolve to records with matching `step`/`fanoutIndex`.
- [ ] Reject partial/legacy fanout evidence without a mapping as `stored_fanout_state_unavailable`. Reject a completed child record without a completed terminal `result` as `stored_output_invalid`; do not rerun it silently.
- [ ] On restored fanout execution, use `restoredFanout.items` directly and do not re-read the source output or reapply `maxItems`. Validate task rendering against the immutable stored request before dispatch.
- [ ] Populate completed slots from `restored.units[unitId].result`, then restore the current `step`, `fanout.index`, `fanout.count`, and item task metadata. Treat `details.results` as a presentation fallback only for completed historical runs, not as selective-resume authority.
- [ ] Schedule only units whose durable status is not `completed`; preserve result ordering by mapping every stored item index to its stored unit ID.
- [ ] Update `incrementIncompleteAttempts()` so `queued` and `skipped` units that never started are reset to `queued` without incrementing. Increment and close stale running attempts only for units that have evidence of a prior execution attempt.
- [ ] Ensure queued Pi fanout items remain valid without a session file, while interrupted/failed Pi items still require their persisted session file and worktree preflight.
- [ ] Add a selective resume test with four items: two completed, one interrupted, and one never started. Assert only the latter two dispatch, the interrupted item advances to attempt `2`, the never-started item remains attempt `1`, and final collection preserves indexes `0..3`.
- [ ] Add tests proving mutated upstream output cannot change restored items, completed output corruption blocks resume, canonical mapping mismatches block resume, and an all-completed fanout is not dispatched.
- [ ] Commit as `fix(pi-agents): resume incomplete fanout items selectively`.

**Validation:**

- Run: `bun test packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/chain.test.ts`
- Expected: Completed item call counts remain zero; incomplete items execute once with correct attempt/session semantics; restored collection order and source items remain unchanged.

### Task 5: Cover Terminal and Edge-Case Durability

**Outcome:** The complete fanout lifecycle remains correct across cancellation, empty/truncated input, output validation failure, and run finalization.

**Files:**

- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/tests/resume.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Add a cancellation test with concurrency lower than item count. Assert completed children stay completed, started aborted children become interrupted/cancelled according to lifecycle origin, unstarted children remain queued with no attempt entry, and resume schedules only non-completed children.
- [ ] Add a structured-output failure test proving `RunUnitRecord.status` and `RunUnitRecord.result.status` are both `failed` after validation, and a clean worktree is retained rather than removed before that failure is known.
- [ ] Add an empty-source integration test proving the persisted fanout mapping is empty, no child event is emitted, and the containing run can finish `completed` without a placeholder left `queued`.
- [ ] Add a `maxItems` resume test proving only the originally scheduled subset is restored and the logical step keeps its original skipped count.
- [ ] Add an expansion-write failure test proving zero item tasks start, the run finalizes failed, and its claim is released by the existing finalization path.
- [ ] Add assertions that final `run.json` has no `chain-NNNN-fanout` placeholder in `units`, every child record has the correct fingerprint/runtime/capability/position, and `details.results` agrees with each child's terminal result.
- [ ] Commit as `test(pi-agents): cover durable fanout edge cases`.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: All package tests pass, including new concurrency, cancellation, empty-source, truncation, persistence-failure, and selective-resume cases.

### Task 6: Document Durable Fanout Resume

**Outcome:** User and maintainer documentation matches the implemented safety and persistence contract.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/how-to.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`

**Steps:**

- [ ] Document that fanout expansion is frozen before worker dispatch and resume never recomputes it from mutable upstream output.
- [ ] Document canonical item IDs, the `workflowState.fanouts` mapping, per-item session/replay capability, and selective retry behavior.
- [ ] Document `stored_fanout_state_unavailable`, `fanout_state_conflict`, and `stored_output_invalid`, including that unsafe legacy partial fanout runs require a fresh invocation rather than automatic reconstruction.
- [ ] Add a how-to scenario showing interruption after partial completion and confirming that completed items are retained while incomplete items resume in original order.
- [ ] Commit as `docs(pi-agents): document durable fanout resume`.

**Validation:**

- Run: `hk check`
- Expected: Markdown and changed TypeScript files satisfy repository formatting and lint rules.

## Final Validation

Run from the repository root in this order:

1. Run: `mise run test --package packages/pi-agents`
   - Expected: All tests pass with zero failures; selective fanout resume and edge cases are covered.
2. Run: `mise run typecheck --package packages/pi-agents`
   - Expected: No TypeScript errors; the new callback and coordinator interfaces are fully typed.
3. Run: `mise run build --package packages/pi-agents`
   - Expected: `@balaenis/pi-agents` builds successfully.
4. Run: `hk check`
   - Expected: ESLint and Prettier pass for all changed files.
5. Run: `git status --short`
   - Expected: The worktree is clean after the six scoped commits; nothing is staged or pushed unexpectedly.

## Rollout Notes

- No data migration runs automatically. Existing completed V1 records remain listable and inspectable.
- Existing incomplete sequential and parallel runs keep their current resume behavior.
- Existing incomplete fanout runs without a valid persisted mapping are blocked rather than reconstructed, because their item identity, attempt, session, and side-effect history cannot be proven.
- The first durable boundary is the awaited expansion write. Once it succeeds, crash recovery can safely distinguish completed, started, and never-started items.
- The change does not alter command syntax, storage root, claim protocol, or runtime replay acknowledgement.

## Risks and Mitigations

- **Active-record alias breaks when child units are inserted.** — Persist a candidate snapshot first, then mutate the existing shared `units` object in place; never replace the object held by `StartedRun` and lifecycle closures.
- **A coalesced write races with expansion and drops state.** — Cancel the pending timer, perform the expansion through an awaited serialized store update, and preserve `workflowState` in subsequent coordinator writes.
- **`details.results` and `RunUnitRecord.result` diverge.** — Make unit records authoritative on resume, run terminal post-processing before `endUnit`, and assert agreement in integration tests.
- **Schema validation changes a result after the worktree was removed.** — Execute the chain terminal postprocessor before completion cleanup and durable terminalization.
- **Object-key ordering changes after dynamic insertion.** — Resolve chain IDs directly from canonical step/index helpers; never use `Object.keys(units)` as a positional map.
- **Empty fanout leaves a queued placeholder.** — Stop creating placeholders and persist an empty mapping with no child units.
- **`maxItems` changes restored input or skipped counts.** — Persist only scheduled items, use them directly on resume, and preserve skipped count from stored logical-step metadata.
- **Cancellation increments attempts for work that never started.** — Leave unstarted records queued with no attempt entry and do not increment queued/skipped records during resume setup.
- **Legacy partial state is replayed with ambiguous side effects.** — Block it with a specific error instead of guessing item identity or rerunning completed work.
