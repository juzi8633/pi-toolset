# Subagent Memory Optimization Review Fix Implementation Plan

**Goal:** Close every correctness, isolation, retention, resume-safety, ordering, test-coverage, and documentation issue found by the independent review of `fix/subagent-memory-optimization` without expanding the feature's public configuration surface.

**Inputs:** `packages/pi-agents/docs/plans/2026-07-16-subagent-memory-optimization-plan.md`, the branch diff against `main`, and the independent reviewer findings covering Interactive Agent View retention, compact snapshot ownership, durable resume validation and claim cleanup, restored Chain isolation, terminal postprocessing, fanout coalescer cleanup, abort origin preservation, regression coverage, and documentation accuracy.

**Assumptions:**

- Work continues directly in the existing `fix/subagent-memory-optimization` worktree and branch.
- No durable schema version bump is required; malformed Version 1 records must fail as `corrupt_run`, while valid legacy full-message results remain accepted and normalize only during active resume.
- Snapshot sharing is allowed only for payloads created and owned by `result-snapshot.ts`; externally frozen values do not establish ownership.
- Successful and failed Interactive Agent View activations must publish the complete settled snapshot synchronously before any deferred idle transcript eviction or non-reloadable compaction.
- The remediation must add focused regression coverage for every reviewed failure mode before the full package validation is considered complete.

**Architecture:** Introduce explicit internal ownership for compact result and finalized-message projections, then route all sharing and fast paths through that ownership rather than `Object.isFrozen()` heuristics. Consolidate terminal cleanup and postprocessing so durable writes observe the same authoritative state as parent details, and place resume normalization inside claim-safe error handling. Interactive transcript retention will use one settle-after-publication path for success and failure, followed by deferred reloadable eviction or published non-reloadable compaction.

**Tech Stack:** TypeScript, Bun tests, Pi extension APIs, Mise, ESLint, Prettier, and hk.

---

## Scope Boundaries

### Included

- All Critical and Improvement findings from the independent review.
- Focused regression tests required to prove each fix.
- Corrections to the reduced-heap guide and retention wording.
- Execution-record updates in this plan after every completed task.

### Excluded

- New user-facing memory configuration.
- Durable schema Version 2 or historical read-only record rewriting.
- Unrelated refactors, formatting cleanup, or feature changes.
- Running the optional interactive reduced-heap soak unless the local runtime prerequisites are available; deterministic automated gates remain mandatory.

## File Map

- Modify: `packages/pi-agents/src/interactive-agent.ts` — enforce projection ownership, complete non-authoritative payload bounding, settle ordering, idle eviction/compaction, publication, exact accounting, and transient-state retention limits.
- Modify: `packages/pi-agents/src/result-snapshot.ts` — replace freeze-based ownership detection with internal snapshot ownership and preserve bounded idempotent fast paths.
- Modify: `packages/pi-agents/src/run-store.ts` — validate the minimum `SingleResult` shape for unit and details results while preserving valid legacy records.
- Modify: `packages/pi-agents/src/tool.ts` — make active-resume normalization claim-safe, unify terminal postprocessing before durability, and preserve abort origin.
- Modify: `packages/pi-agents/src/chain.ts` — restore immutable snapshots, isolate emitted outputs, and guarantee fanout coalescer cleanup.
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts` — cover successful settle eviction, payload bypasses, byte accounting, publication, lazy hydration, and non-reloadable compaction.
- Modify: `packages/pi-agents/tests/interactive-view.test.ts` — cover omission/compaction rendering after projection and rehydration.
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts` — cover synchronous settled-consumer ordering before deferred retention transitions.
- Modify: `packages/pi-agents/tests/result-snapshot.test.ts` — cover externally frozen oversized compact-looking values and ownership-safe idempotence.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — reject primitive results, invalid `messages`, and malformed presentation-bearing result shells.
- Modify: `packages/pi-agents/tests/resume.test.ts` — cover active legacy normalization, read-only non-rewrite, and claim release after normalization/setup failure.
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts` — exercise coordinator-backed durable compaction and size behavior.
- Modify: `packages/pi-agents/tests/chain.test.ts` — cover restored result/output mutation isolation and coalescer cleanup after exceptional fanout failure.
- Modify: `packages/pi-agents/tests/tool.test.ts` — cover early-failure terminal identity/postprocessing and authoritative abort origin/result replacement.
- Modify: `packages/pi-agents/tests/execution.test.ts` — strengthen high-frequency Grok terminal ordering and coalescing coverage where needed.
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` — replace constant-only checks with integration-level retention and durable-size assertions.
- Modify: `packages/pi-agents/README.md` — qualify compact-retention statements for new and actively resumed records.
- Modify: `packages/pi-agents/docs/reference.md` — qualify legacy retention semantics and document ownership/retention behavior accurately.
- Modify: `packages/pi-agents/docs/reduced-heap-soak-test.zh-cn.md` — remove the unsupported top-level Parallel `concurrency` parameter.

## Tasks

### Task 1: Make Interactive Projection Ownership and Bounding Complete

**Outcome:** Only messages projected by `interactive-agent.ts` are reused, and all non-authoritative finalized and transient payloads are bounded without truncating authoritative assistant text, usage, model, stop reason, or finalized-message count.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-integration.test.ts`

**Steps:**

- [ ] Replace `Object.isFrozen(message)` as projection provenance with a module-private ownership mechanism such as a `WeakSet<object>` populated only after clone, projection, and deep freeze.
- [ ] Ensure hydrate, restore, append, and wholesale replacement project any frozen-but-unowned native message instead of reusing it.
- [ ] Bound every non-authoritative assistant content part except text, including thinking, tool arguments, images/base64, custom fields, and unknown content variants, using deterministic omission objects or text markers within `INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES`.
- [ ] Bound user, custom, and tool-result content/details recursively enough that no single retained non-authoritative part bypasses the per-item budget.
- [ ] Project or replace running `streamingMessage`, active-tool arguments/results, and other transient display payloads so active endpoints cannot retain unbounded non-authoritative objects.
- [ ] Preserve one finalized array element per native message and preserve complete assistant final text and aggregate usage needed by Pi RPC projection.
- [ ] Add tests using pre-frozen raw messages, large image/base64 content, unknown custom fields, large streaming/tool transient payloads, and complete assistant text.

**Validation:**

- Run: `bun test packages/pi-agents/tests/interactive-agent.test.ts packages/pi-agents/tests/pi-rpc-execution.test.ts packages/pi-agents/tests/pi-rpc-integration.test.ts`
- Expected: Frozen/raw and non-text payloads cannot bypass the 64 KiB presentation bound, active payloads remain bounded, message count and complete assistant final output/usage are preserved.

### Task 2: Unify Settled Publication and Deferred Idle Retention

**Outcome:** Successful, failed, and cancelled activations synchronously publish the settled snapshot before every deferred reloadable eviction or non-reloadable compaction, and all resulting Agent View state changes are published.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/interactive-view.test.ts`
- Test: `packages/pi-agents/tests/interactive-relay.test.ts`
- Test: `packages/pi-agents/tests/memory-regression.test.ts`

**Steps:**

- [ ] Introduce one post-settle retention scheduling path called after the synchronous full publish and `activation_settled` emission on success, error, and cancellation.
- [ ] Preserve ordering: settled subscribers receive an immutable pre-eviction snapshot; only a queued later transition may detach/evict or compact.
- [ ] For reloadable oversized idle endpoints, detach with transcript eviction and leave the endpoint unhydrated while retaining session identity and usage/status metadata.
- [ ] For non-reloadable oversized idle endpoints, compact oldest entries with role-preserving unrecoverable-history markers, preserve array length and the latest authoritative assistant message, recompute exact JSON-array byte accounting, and publish the new full snapshot.
- [ ] Ensure active or unsettled endpoints are never total-evicted.
- [ ] Verify lazy hydration awaits the existing transport disposal/session lease barrier and reapplies the same projection before publication.
- [ ] Add exact byte-accounting assertions including brackets and commas, successful-settle eviction, non-reloadable post-compaction publication, lazy hydration, LRU transcript eviction, synchronous relay ordering, and warm-retention ceiling coverage.

**Validation:**

- Run: `bun test packages/pi-agents/tests/interactive-agent.test.ts packages/pi-agents/tests/interactive-view.test.ts packages/pi-agents/tests/interactive-relay.test.ts packages/pi-agents/tests/memory-regression.test.ts`
- Expected: Settled consumers observe complete bounded state before deferred retention changes; oversized reloadable state becomes empty/unhydrated; non-reloadable compaction is published and satisfies its deterministic ceiling.

### Task 3: Establish Snapshot-Owned Fast Paths

**Outcome:** `snapshotSingleResult()` reuses immutable payloads only when they were created by the snapshot module, while externally frozen compact-looking data is reprojected and bounded.

**Files:**

- Modify: `packages/pi-agents/src/result-snapshot.ts`
- Test: `packages/pi-agents/tests/result-snapshot.test.ts`
- Test: `packages/pi-agents/tests/memory-regression.test.ts`

**Steps:**

- [ ] Add module-private ownership tracking for presentation and structured-output payloads created by `snapshotSingleResult()`.
- [ ] Make idempotent fast-path reuse require ownership rather than deep-freeze alone; externally frozen data must pass through derivation, cloning, caps, diagnostics bounding, and deep freeze.
- [ ] Preserve top-level shell copying and shared identity for genuinely snapshot-owned frozen payloads.
- [ ] Add tests for externally frozen oversized presentation items, oversized diagnostics, mutable nested structured payload attempts, and repeated snapshot identity/isolation.

**Validation:**

- Run: `bun test packages/pi-agents/tests/result-snapshot.test.ts packages/pi-agents/tests/memory-regression.test.ts`
- Expected: External freeze cannot bypass presentation or diagnostic caps; owned snapshots remain idempotent and share only frozen owned payloads.

### Task 4: Make Durable Resume Validation and Claim Cleanup Fail-Safe

**Outcome:** Malformed durable result shells fail as `corrupt_run` before execution, and any failure after claiming a run releases the claim without reserializing legacy raw transcripts.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`

**Steps:**

- [ ] Add a reusable minimum result-shell validator used for every `units[*].result` and `details.results[*]`; require a non-null non-array object and `messages` to be an array while retaining optional presentation validation and legacy populated messages.
- [ ] Reject primitive, array, `messages: null`, and non-array messages results as `corrupt_run` with the precise result path.
- [ ] Move post-claim normalization, staged unit cloning, attempt increments, continuation staging, event append, and initial running write into a cleanup boundary that releases the claim on every thrown or returned setup failure.
- [ ] Keep read-only runs/status inspection side-effect free and normalize valid legacy full-message results only during active resume before the first post-claim write.
- [ ] Add tests proving malformed records are rejected, injected normalization/setup failure releases the claim and permits a later claim, valid legacy records persist compact details/unit results on resume, read-only inspection does not rewrite files, and coordinator-backed 4 MiB duplicate fixtures compact below the documented threshold.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/run-coordinator.test.ts`
- Expected: Invalid shells report `corrupt_run`, setup failures leave no active claim, legacy active resume remains compatible and compact, and read-only paths leave files unchanged.

### Task 5: Restore Chain and Aggregate Isolation

**Outcome:** Restored results and named outputs never expose mutable shared presentation or structured data across updates, and fanout coalescers cannot emit after exceptional terminal exits.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] Normalize restored presentation results and durable unit results into snapshot-owned immutable results before storing them in workflow arrays.
- [ ] When identity/status fields require mutation, clone only a private working shell, apply changes, and resnapshot before aggregate sharing.
- [ ] Copy output entries for each emission and isolate structured output so mutation of an earlier `details.outputs` object cannot affect later templates, named outputs, or final details.
- [ ] Move `fanoutContentCoalescer.cancel()` into a `finally` path covering success, abort, and unexpected worker errors.
- [ ] Add tests retaining an early restored details object, mutating its results/output entries, then asserting later previous/named/structured inputs and final details remain unchanged.
- [ ] Add a fanout test where content is pending and a worker throws a non-abort exception; assert no timer emits a stale running update afterward.

**Validation:**

- Run: `bun test packages/pi-agents/tests/chain.test.ts`
- Expected: Restored and emitted state is mutation-isolated, structured outputs remain intact, and no fanout content timer fires after any terminal error.

### Task 6: Complete Authoritative Terminal Finalization

**Outcome:** Every result-producing exit runs terminal identity/postprocessing before compaction and durability, and replacement abort errors preserve the original abort origin and authoritative result metadata.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/completion-check.test.ts`

**Steps:**

- [ ] Consolidate terminal postprocessing into the authoritative finalizer so unknown-agent, skill, context, cwd, isolation, registration, transport, completion-check, structured-output, cancellation, and synthesized failure exits apply it exactly once before snapshot creation and `endUnit()`.
- [ ] Prevent sequential/fanout fallback postprocessing from double-mutating already authoritative compact results.
- [ ] In abort replacement, prefer the original `AgentAbortError.origin`; fall back to injected lifecycle/signal origin only when the original origin is unavailable.
- [ ] Preserve worktree, session identity, error metadata, status, step, fanout, and structured-output validation in the replacement compact result.
- [ ] Add tests for early fanout/sequential setup failures persisted with canonical identity, non-durable signal abort retaining `user` origin, provisional low-level abort replacement, and compact completion-check behavior.
- [ ] Strengthen high-frequency Grok coverage to exercise approximately 1,000 content/tool/usage updates and prove one immediate terminal snapshot cannot be overtaken by pending running state.

**Validation:**

- Run: `bun test packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/execution.test.ts packages/pi-agents/tests/completion-check.test.ts`
- Expected: Every durable/parent terminal result has matching canonical metadata, abort origin is preserved, and pending updates cannot follow terminal delivery.

### Task 7: Correct Documentation and Complete Regression Gates

**Outcome:** Documentation matches actual legacy/new retention behavior and the automated regressions exercise real integration paths instead of constant-only or helper-only assertions.

**Files:**

- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/reduced-heap-soak-test.zh-cn.md`

**Steps:**

- [ ] Replace the constant-only interactive memory test with registry-backed projection, settle, eviction/compaction, and total warm-retained-byte assertions.
- [ ] Route the durable large-result fixture through coordinator/resume persistence rather than testing only `snapshotSingleResult()`.
- [ ] Ensure the fanout fixture verifies cumulative ordering, bounded aggregate update count, identity/usage/structured-output preservation, and retained early-update isolation.
- [ ] Qualify README/reference statements: newly written and actively resumed records are compact; inactive historical Version 1 records remain unchanged until active resume.
- [ ] Remove unsupported top-level `concurrency` from the Parallel reduced-heap soak example while retaining Chain fanout concurrency guidance.
- [ ] Search all changed docs for contradictory raw-history, retention, limit, and rehydration claims.

**Validation:**

- Run: `bun test packages/pi-agents/tests/memory-regression.test.ts`
- Expected: Integration-level memory fixtures enforce compact durable/parent details and bounded interactive retention.
- Run: `rg -n "raw tool|tool result|presentation|transcript|rehydrat|512 KiB|64 KiB|concurrency" packages/pi-agents/README.md packages/pi-agents/docs/{explanation,reference,tutorials,reduced-heap-soak-test.zh-cn}.md`
- Expected: Retention ownership, legacy behavior, limits, rehydration, and concurrency syntax are consistent.

## Execution Record

Update this table immediately after each task is completed. Record exact files changed, validation commands, outcomes, and any deliberate deviation from the task steps.

| Task                                             | Status   | Files changed                                                                                                                                                                                                      | Validation evidence                                                                                                                                                                                                                      | Notes / deviations                                                                                                                          |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Interactive projection ownership and bounding | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts`                                                                                                                | `bun test packages/pi-agents/tests/interactive-agent.test.ts packages/pi-agents/tests/pi-rpc-execution.test.ts packages/pi-agents/tests/pi-rpc-integration.test.ts` → 88 pass, 0 fail                                                    | Replaced `Object.isFrozen` reuse with `WeakSet` ownership; bounded image/unknown/custom fields; projected streaming + active-tool payloads. |
| 2. Settled publication and idle retention        | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts`, `packages/pi-agents/tests/interactive-view.test.ts`, `packages/pi-agents/tests/interactive-relay.test.ts`     | `bun test packages/pi-agents/tests/interactive-agent.test.ts packages/pi-agents/tests/interactive-view.test.ts packages/pi-agents/tests/interactive-relay.test.ts packages/pi-agents/tests/memory-regression.test.ts` → 133 pass, 0 fail | Success settle now schedules deferred eviction/compaction; non-reloadable compaction publishes full snapshot.                               |
| 3. Snapshot-owned fast paths                     | Complete | `packages/pi-agents/src/result-snapshot.ts`, `packages/pi-agents/tests/result-snapshot.test.ts`                                                                                                                    | `bun test packages/pi-agents/tests/result-snapshot.test.ts packages/pi-agents/tests/memory-regression.test.ts` → 23 pass, 0 fail                                                                                                         | Fast path requires WeakSet ownership; external freeze reprojects and bounds.                                                                |
| 4. Durable resume validation and claim cleanup   | Complete | `packages/pi-agents/src/run-store.ts`, `packages/pi-agents/src/tool.ts`, `packages/pi-agents/tests/run-store.test.ts`, `packages/pi-agents/tests/tool.test.ts`, `packages/pi-agents/tests/run-coordinator.test.ts` | `bun test packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/run-coordinator.test.ts` → 189 pass, 0 fail                                                                        | Min result-shell validation; claim-safe post-claim normalize/setup; legacy resume + claim-release tests.                                    |
| 5. Restored Chain and aggregate isolation        | Complete | `packages/pi-agents/src/chain.ts`, `packages/pi-agents/tests/chain.test.ts`                                                                                                                                        | `bun test packages/pi-agents/tests/chain.test.ts` → 52 pass, 0 fail                                                                                                                                                                      | Snapshot-owned restored results; isolated output entries; fanout coalescer cancel in finally.                                               |
| 6. Authoritative terminal finalization           | Complete | `packages/pi-agents/src/tool.ts`, `packages/pi-agents/tests/tool.test.ts`, `packages/pi-agents/tests/execution.test.ts`                                                                                            | `bun test packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/execution.test.ts packages/pi-agents/tests/completion-check.test.ts` → 126 pass, 0 fail                                                                         | Postprocess in finalizer; preserve AgentAbortError.origin; HF Grok coalescing coverage.                                                     |
| 7. Documentation and regression gates            | Complete | `packages/pi-agents/tests/memory-regression.test.ts`, `packages/pi-agents/README.md`, `packages/pi-agents/docs/reference.md`, `packages/pi-agents/docs/reduced-heap-soak-test.zh-cn.md`                            | `bun test packages/pi-agents/tests/memory-regression.test.ts` → 5 pass, 0 fail                                                                                                                                                           | Integration memory fixtures; legacy retention wording; removed unsupported Parallel concurrency.                                            |

## Review Round 2

Independent re-review residual defects closed after Round 1. Round 1 execution evidence above is preserved.

### Round 2 findings

1. **Critical — Complete interactive item budget not enforced** (`interactive-agent.ts` projection helpers): fields were bounded independently so multi-field image/custom/toolCall items and assistant top-level extras could exceed `INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES`.
2. **Critical — Some settle failure/cancel paths skip retention scheduling** (`interactive-agent.ts` activate prompt/spawn failure + starting cancellation): failure cleared activation without scheduling; cancel scheduled while status was still `starting`.
3. **Critical — Terminal postprocessing not exactly once** (`chain.ts` sequential/fanout fallback): production `runStep` postprocess was always re-applied via unconditional fallback.
4. **Warning — Grok successful terminal ordering** (`execution.ts`): success used `contentCoalescer.flush()` which emits `status: running`.
5. **Warning — Memory fanout regression helper-only** (`memory-regression.test.ts`): eight-item fixture did not exercise real Chain fanout/parent `onUpdate`/coalescer.
6. **Suggestion — Primitive structuredOutput fast path** (`result-snapshot.ts`): WeakSet ownership was required for all defined structuredOutput, blocking primitive idempotence.

### Round 2 execution record

| Item                                            | Status   | Files changed                                                                                       | Validation evidence                                                                                              | Notes / deviations                                                                                                                                                                    |
| ----------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 Complete non-authoritative item budget     | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test packages/pi-agents/tests/interactive-agent.test.ts -t "complete multi-field\|pre-frozen raw"` → 2 pass | Added `enforceNonAuthoritativeItemBudget` (shrink-to-fit then omit); bound assistant top-level non-authoritative fields; multi-field regression asserts complete serialized item cap. |
| R2-2 Settle failure/cancel retention scheduling | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test packages/pi-agents/tests/interactive-agent.test.ts -t "hydrated oversized"` → 2 pass                   | Prompt/spawn failure schedules after settled publish; starting cancel sets detached before settle so scheduling is not skipped.                                                       |
| R2-3 Terminal postprocess exactly-once          | Complete | `packages/pi-agents/src/chain.ts`, `packages/pi-agents/tests/chain.test.ts`                         | `bun test packages/pi-agents/tests/chain.test.ts` → 54 pass (incl. exactly-once suite)                           | Per-invocation flag; fallback only when callback not invoked. Sequential + fanout production-like and stub tests.                                                                     |
| R2-4 Grok successful terminal ordering          | Complete | `packages/pi-agents/src/execution.ts`, `packages/pi-agents/tests/execution.test.ts`                 | `bun test packages/pi-agents/tests/execution.test.ts` → 36 pass                                                  | Success uses `emitTerminal()` (cancel pending + terminal snapshot). Authoritative terminal also returned via result.                                                                  |
| R2-5 Memory fanout real workflow                | Complete | `packages/pi-agents/tests/memory-regression.test.ts`                                                | `bun test packages/pi-agents/tests/memory-regression.test.ts` → 6 pass                                           | Real `runChainWorkflow` eight-item fanout with parent `onUpdate`, coalescer seam, ordering/size/isolation asserts. Helper-only fixture retained.                                      |
| R2-6 Primitive structuredOutput fast path       | Complete | `packages/pi-agents/src/result-snapshot.ts`, `packages/pi-agents/tests/result-snapshot.test.ts`     | `bun test packages/pi-agents/tests/result-snapshot.test.ts` → pass incl. primitive idempotence                   | WeakSet ownership required only for non-null object structuredOutput.                                                                                                                 |

### Round 2 status

- Items R2-1 through R2-6 implemented with focused regression coverage.
- **Round 2 complete** after mandatory final validation:
  - Focused suite: **645 pass / 0 fail** (17 files)
  - `mise run typecheck --package packages/pi-agents`: pass
  - `mise run test --package packages/pi-agents`: **992 pass / 0 fail** (43 files)
  - `hk check`: pass (eslint + prettier)
  - `mise run build --package packages/pi-agents`: pass
  - `git diff --check`: pass

## Review Round 3

Independent re-review residual defects closed after Round 2. Round 1/2 execution evidence above is preserved.

### Round 3 findings

1. **Critical — Remaining unbounded Interactive Agent View payloads** (`interactive-agent.ts` projection helpers / `snapshotOf`): text-part siblings and top-level assistant extras (`errorMessage`, `responseId`, …) could remain unbounded; active-tool id/name/queues and nested args/results could be shared mutable through public snapshots.
2. **Critical — Detach/invalidate settle ordering** (`settleActivationError`, `detach`, `invalidateLiveTransport`): force-settle could emit `activation_settled` while status was still `running`, skipping retention scheduling, then synchronously clear the transcript in the same turn.
3. **Critical — Snapshot ownership and diagnostics bounding** (`result-snapshot.ts` `copySnapshotShell` / owned fast path): exported shell copy could share externally frozen unowned presentation/structured payloads; owned fast path could copy oversized mutated diagnostics without re-capping.
4. **Warning — Integration regressions too weak** (`memory-regression.test.ts`): fanout fixture could pass without multi-partial coalescing; durable fixture pre-snapshotted and manually assembled compact details instead of routing raw legacy records through resume/coordinator.

### Round 3 execution record

| Item                                    | Status   | Files changed                                                                                       | Validation evidence                                                                                                          | Notes / deviations                                                                                                                                 |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-1 Unbounded Interactive payloads     | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test packages/pi-agents/tests/interactive-agent.test.ts -t "text-part siblings"` → 1 pass                               | Text siblings + top-level allowlist; bound tool id/name/queues; freeze/clone active tools + streaming in `snapshotOf`; adversarial isolation test. |
| R3-2 Detach/invalidate settle ordering  | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test … -t "detach during running"` and `… -t "transport invalidation during"` → 2 pass                                  | Terminal non-running status before settle; deferred eviction after open-activation detach; no duplicate settle.                                    |
| R3-3 Snapshot ownership + diagnostics   | Complete | `packages/pi-agents/src/result-snapshot.ts`, `packages/pi-agents/tests/result-snapshot.test.ts`     | `bun test packages/pi-agents/tests/result-snapshot.test.ts -t "copySnapshotShell reprojects\|owned snapshot shell"` → 2 pass | Private `copyOwnedSnapshotShell`; public entry reprojects unowned; always re-bound diagnostics on owned fast path.                                 |
| R3-4 Strengthen integration regressions | Complete | `packages/pi-agents/tests/memory-regression.test.ts`                                                | `bun test packages/pi-agents/tests/memory-regression.test.ts -t "eight-item chain fanout\|legacy durable"` → 2 pass          | Concurrent multi-partial same-interval coalesce assert; raw legacy resume via `executeAgentTool` + read-only unchanged.                            |

### Round 3 status

- Items R3-1 through R3-4 implemented with focused regression coverage.
- **Round 3 complete** after mandatory final validation:
  - Focused suite: **650 pass / 0 fail** (17 files)
  - `mise run typecheck --package packages/pi-agents`: pass
  - `mise run test --package packages/pi-agents`: **997 pass / 0 fail** (43 files)
  - `hk check`: pass (eslint + prettier)
  - `mise run build --package packages/pi-agents`: pass
  - `git diff --check`: pass

## Review Round 4

Independent re-review residual defects closed after Round 3. Round 1/2/3 execution evidence above is preserved.

### Round 4 findings

1. **Critical — Deferred invalidation retention ordering** (`interactive-agent.ts` `applyUnavailable` / transport invalidation): running invalidation published `activation_settled` then cleared the transcript in the same call stack.
2. **Critical — Unbounded activeTools Map key** (`reduceEvent` tool rows): raw `toolCallId` was used as the Map key, so a huge ID survived even when the displayed value was bounded.
3. **Critical — Public snapshot nested-reference isolation** (`snapshotOf` / `listItemOf`): `sessionArtifact`, `activation.policy`, and `usage` could be shared mutable with the live endpoint.
4. **Critical — Late fanout callback can restart coalescer after exceptional terminal exit** (`chain.ts` `runFanoutStep` finally): permanent terminal gate was not set before cancel on unexpected non-abort errors.
5. **Warning — Durable details/results container shape** (`run-store.ts` `validateRunRecord`): array `details` and non-array `details.results` were not rejected as `corrupt_run`.
6. **Warning — Documentation wording** (`docs/reference.md`): “full result kept in child session” / “Full transcript” needed reloadable-session and Agent View qualification.

### Round 4 execution record

| Item                                            | Status   | Files changed                                                                                       | Validation evidence                                                                       | Notes / deviations                                                                                                                                                                 |
| ----------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-1 Deferred invalidation retention ordering   | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test … -t "transport invalidation\|applyUnavailable bumps"` → 2 pass                 | Settled consumers + internal endpoint retain transcript through sync settled turn; cleanup via microtask + `enqueueTransition`. Strengthened internal-at-settled/deferred asserts. |
| R4-2 Unbounded activeTools Map key              | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test … -t "huge activeTools"` → 1 pass                                               | `activeToolMapKey` hashes IDs > 256 UTF-8 bytes (sha256 hex); start/update/end lookup preserved; retained Map key size bounded.                                                    |
| R4-3 Public snapshot nested-reference isolation | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test … -t "isolate sessionArtifact"` → 1 pass                                        | `isolateSessionArtifact` / `isolateActivation` / `isolateUsage` clone+freeze nested metadata in `snapshotOf`/`listItemOf`.                                                         |
| R4-4 Late fanout callback terminal gate         | Complete | `packages/pi-agents/src/chain.ts`, `packages/pi-agents/tests/chain.test.ts`                         | `bun test packages/pi-agents/tests/chain.test.ts -t "late fanout worker"` → 1 pass        | `fanoutTerminal = true` before coalescer cancel in `finally` on every exit; late callback cannot schedule/emit.                                                                    |
| R4-5 Durable details/results container shape    | Complete | `packages/pi-agents/src/run-store.ts`, `packages/pi-agents/tests/run-store.test.ts`                 | `bun test packages/pi-agents/tests/run-store.test.ts -t "wrong details/results"` → 1 pass | Reject array/null/primitive `details` and non-array `details.results` as `corrupt_run` with precise messages; valid legacy empty results still load.                               |
| R4-6 Documentation wording                      | Complete | `packages/pi-agents/docs/reference.md`                                                              | doc-only                                                                                  | Qualify raw/full history as reloadable-native only; Agent View is complete retained/bounded presentation.                                                                          |

### Round 4 status

- Items R4-1 through R4-6 implemented with focused regression coverage.
- **Round 4 complete** after mandatory final validation:
  - Focused suite: **654 pass / 0 fail** (17 files)
  - `mise run typecheck --package packages/pi-agents`: pass
  - `mise run test --package packages/pi-agents`: **1001 pass / 0 fail** (43 files)
  - `hk check`: pass (eslint + prettier)
  - `mise run build --package packages/pi-agents`: pass
  - `git diff --check`: pass

## Review Round 5

Independent re-review residual defects closed after Round 4. Round 1–4 execution evidence above is preserved.

### Round 5 findings

1. **Critical — Active-tool complete entry can exceed 64 KiB** (`interactive-agent.ts` `projectActiveToolEntry`): args and partial result could each be under the per-field cap while the complete serialized entry (id/name/args/result + JSON overhead) exceeded `INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES`; fallback could return the oversized entry unchanged.
2. **Critical — Worktree finalization precedes terminal postprocessing** (`tool.ts` success path): a clean worktree could be deleted as completed before Chain structured-output validation/postprocess flipped the result to failed, leaving durable unit metadata pointing at a missing worktree.
3. **Warning — Under-budget array tool arguments retained by reference and frozen** (`interactive-agent.ts` `projectToolArgs` / `boundUnknownPayload`): under-budget arrays/objects could be frozen in place on transport-owned data.
4. **Warning — Warm-retention regression is not one-registry LRU coverage** (`memory-regression.test.ts`): separate registries/eight-endpoint ceiling did not exercise single-registry `MAX_IDLE_TRANSPORTS` LRU + oversized eviction.
5. **Warning — Remaining inaccurate “Full transcript/content” docs** (`README.md`, `docs/tutorials.md`): expanded view and Ctrl+O wording still implied raw/full history rather than complete retained/bounded Agent View presentation.

### Round 5 execution record

| Item                                               | Status   | Files changed                                                                                       | Validation evidence                                                           | Notes / deviations                                                                                                                                                                                                                     |
| -------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5-1 Active-tool complete-entry cap                | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test … -t "caps complete active-tool"` → 1 pass                          | Deterministic shrink: omit partialResult → bound identity to 256 → omit args → drop partialResult → minimal args → binary identity shrink until complete JSON bytes ≤ cap. ID/name/display bounded; start/update/end lookup preserved. |
| R5-2 Worktree finalization after postprocess       | Complete | `packages/pi-agents/src/tool.ts`, `packages/pi-agents/tests/tool.test.ts`                           | `bun test … -t "clean worktree retained\|successful clean worktree"` → 2 pass | `pendingWorktreeFinalization` runs inside `finalizeTerminalResult` after postprocess and before snapshot/endUnit. Abort/early-failure paths keep their own worktree handling. Real chain+schema-fail + successful clean path tests.    |
| R5-3 Clone under-budget non-authoritative payloads | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts` | `bun test … -t "clones under-budget array"` → 1 pass                          | `boundUnknownPayload` / `projectToolArgs` always `structuredClone` under-budget objects/arrays before freeze; source remains unfrozen and mutation-isolated.                                                                           |
| R5-4 One-registry warm LRU regression              | Complete | `packages/pi-agents/tests/memory-regression.test.ts`                                                | `bun test … -t "one-registry LRU"` → 1 pass                                   | Single registry with `MAX_IDLE_TRANSPORTS + 2` reloadable idle endpoints + one oversized; asserts settle projection, warm bytes ≤ `MAX_IDLE_TRANSPORTS * INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES`, oversized empty, identities retained. |
| R5-5 Docs: expanded/Agent View wording             | Complete | `packages/pi-agents/README.md`, `packages/pi-agents/docs/tutorials.md`                              | doc-only                                                                      | Ctrl+O / expanded view = complete retained compact presentation + final output; Agent View is bounded retained transcript; raw/full native history only for reloadable native sessions. Aligned with reference/explanation.            |

### Round 5 status

- Items R5-1 through R5-5 implemented with focused regression coverage.
- **Round 5 complete** after mandatory final validation:
  - Focused suite: **658 pass / 0 fail** (17 files)
  - `mise run typecheck --package packages/pi-agents`: pass
  - `mise run test --package packages/pi-agents`: **1005 pass / 0 fail** (43 files)
  - `hk check`: pass (eslint + prettier)
  - `mise run build --package packages/pi-agents`: pass
  - `git diff --check`: pass

## Review Round 6

Independent re-review residual defects closed after Round 5. Round 1–5 execution evidence above is preserved.

### Round 6 findings

1. **Critical — Early post-beginUnit worktree deletion/persisted-path corruption** (`tool.ts` early failure paths after `beginUnit`): setup/context/skill/transport failures could delete a clean owned worktree while durable unit metadata still retained the path from `startUnit`, so resume blocked on a missing worktree.
2. **Critical — Deferred oversized/LRU cleanup activation race** (`interactive-agent.ts` retention scheduling / detach): cleanup was not activation/epoch-scoped; a chained detach after schedule could force-settle a newer turn. Non-reloadable compaction and reloadable detach needed the serialized transition queue plus revalidation.
3. **Warning — One-registry LRU regression too weak** (`memory-regression.test.ts`): assertions were permissive/OR-shaped and warm transcripts were too small to exercise real LRU eviction semantics.
4. **Warning — Remaining inaccurate “full transcript/history” docs** (`docs/how-to.md`, `docs/reference.md`): Ctrl+O / hydrate wording still implied raw full history rather than retained/bounded Agent View presentation.

### Round 6 execution record

| Item                                          | Status   | Files changed                                                                                                          | Validation evidence                                                                                                    | Notes / deviations                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-1 Early post-begin worktree path authority | Complete | `packages/pi-agents/src/tool.ts`, `packages/pi-agents/src/run-coordinator.ts`, `packages/pi-agents/tests/tool.test.ts` | `bun test … -t "early post-begin\|clean worktree retained\|successful clean worktree\|worktree strict stamp"` → 4 pass | Authoritative order: postprocess → worktree finalize → sync unitContext path from result → snapshot → endUnit. `finishUnit` clears/sets `unit.worktreePath` from terminal result. Early clean remove clears result+unitContext path. Added resume-preflight regression.                                    |
| R6-2 Deferred cleanup activation/epoch race   | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/memory-regression.test.ts`                    | `bun test … -t "deferred oversized\|idle oversized"` → 2 pass                                                          | `idleRetentionEpoch` bumped on new activation; schedule captures epoch and runs only inside transition queue; detach accepts `retentionEpoch`/`requireIdle` so chained retention/LRU detach cannot force-settle a newer turn; non-reloadable compaction also epoch-guarded. Race + idle-evict regressions. |
| R6-3 Strengthen one-registry LRU regression   | Complete | `packages/pi-agents/tests/memory-regression.test.ts`                                                                   | `bun test … -t "one-registry LRU"` → 1 pass                                                                            | One registry, `MAX_IDLE_TRANSPORTS+2` warm endpoints with ~96 KiB transcripts, deterministic clock/`lastUsedAt`, exact victim/retained keys, transport count, warm byte ceiling, oversized empty+detached, identities retained, lazy `ensureTranscript` rehydrate. No permissive OR asserts.               |
| R6-4 Docs: full transcript/history wording    | Complete | `packages/pi-agents/docs/how-to.md`, `packages/pi-agents/docs/reference.md`                                            | doc-only                                                                                                               | Ctrl+O / hydrate wording = complete retained/bounded Agent View; raw complete history only for reloadable native sessions; non-reloadable omitted history unrecoverable.                                                                                                                                   |

### Round 6 status

- Items R6-1 through R6-4 implemented with focused regression coverage.
- **Round 6 complete** after mandatory final validation:
  - Focused suite: **661 pass / 0 fail** (17 files)
  - `mise run typecheck --package packages/pi-agents`: pass
  - `mise run test --package packages/pi-agents`: **1008 pass / 0 fail** (43 files)
  - `hk check`: pass (eslint + prettier)
  - `mise run build --package packages/pi-agents`: pass
  - `git diff --check`: pass

## Review Round 7

Independent re-review residual defects closed after Round 6. Round 1–6 execution evidence above is preserved.

### Round 7 findings

1. **Critical — Dirty failed setup-hook worktree is force-deleted** (`tool.ts` setup-hook caller / `runHookOrSynthesizeFailure`): after a dirty hook failure retained the worktree, the caller unconditionally force-removed it, deleting hook-created modifications while result/unit paths still pointed at the missing directory.
2. **Warning — Cleanup clears metadata without checking `removeAgentWorktree().removed`** (`tool.ts` context-path cleanup and `maybeRemoveOwnedCleanWorktree`): successful-looking clean removals cleared result/unit path metadata even when removal failed, hiding orphaned worktrees from durability/resume.
3. **Warning — Durable V1 unit core fields insufficiently validated** (`run-store.ts` unit loop): unsupported `status`, non-integer/negative `attempt`, non-array/malformed `attempts`, and wrong-typed `effectiveCwd`/`agentFingerprint` could pass load and throw later in `inspectResume`.
4. **Warning — Finalized message identity fields bypass payload cap** (`interactive-agent.ts` top-level projection allowlist): `toolCallId`, `toolName`, `timestamp`, and `customType` on user/toolResult/custom messages were preserved unbound and could retain huge non-authoritative values.

### Round 7 execution record

| Item                                                    | Status   | Files changed                                                                                                          | Validation evidence                                                                                   | Notes / deviations                                                                                                                                                                                                 |
| ------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R7-1 Dirty setup-hook force-delete                      | Complete | `packages/pi-agents/src/tool.ts`, `packages/pi-agents/tests/worktree.test.ts`, `packages/pi-agents/tests/tool.test.ts` | `bun test …worktree -t "runHookOrSynthesizeFailure"` + `…tool -t "setup-hook"` → pass                 | Caller no longer force-removes after hook decision. Dirty hook retains path+diff metadata and on-disk mods; clean hook removes only when `removed===true`. Coordinator integration asserts durable path agreement. |
| R7-2 Cleanup must honor `removeAgentWorktree().removed` | Complete | `packages/pi-agents/src/tool.ts`, `packages/pi-agents/tests/tool.test.ts`, `packages/pi-agents/tests/worktree.test.ts` | `bun test … -t "removal failure\|clean removal fails\|context-path\|post-begin clean removal"` → pass | Context-path cleanup and `maybeRemoveOwnedCleanWorktree` clear metadata only after confirmed removal; failure stamps path + stderr. Injected spy regressions for both paths + hook helper.                         |
| R7-3 Durable unit core field validation                 | Complete | `packages/pi-agents/src/run-store.ts`, `packages/pi-agents/tests/run-store.test.ts`                                    | `bun test …run-store -t "invalid unit status"` → 1 pass                                               | Validate unit `status`, non-negative integer `attempt`, `attempts` array + per-attempt shape, optional `effectiveCwd`/`agentFingerprint` types as `corrupt_run`. Valid legacy attempt history still loads.         |
| R7-4 Finalized identity field payload bound             | Complete | `packages/pi-agents/src/interactive-agent.ts`, `packages/pi-agents/tests/interactive-agent.test.ts`                    | `bun test … -t "huge finalized-message identity"` → 1 pass                                            | Bound `toolCallId`/`toolName`/`customType`/`timestamp` as complete non-authoritative items; source transport objects unchanged; adversarial user/toolResult/custom coverage.                                       |

### Round 7 status

- Items R7-1 through R7-4 implemented with focused regression coverage.
- **Round 7 complete** after mandatory final validation:
  - Focused suite: **681 pass / 0 fail** (18 files, includes worktree)
  - `mise run typecheck --package packages/pi-agents`: pass
  - `mise run test --package packages/pi-agents`: **1016 pass / 0 fail** (43 files)
  - `hk check`: pass (eslint + prettier)
  - `mise run build --package packages/pi-agents`: pass
  - `git diff --check`: pass

## Review Round 8

Independent re-review residual defects closed after Round 7. Round 1–7 execution evidence above is preserved.

### Round 8 findings

1. **Warning — Durable details/Chain shapes can escape validation and throw during preflight/resume** (`run-store.ts` details validation; consumers in `resume.ts` / `chain.ts`): `details.results` could be absent, `details.chain.steps` could be non-array, and null/primitive `details.outputs` entries could reach restore after claim.
2. **Warning — Required unit fields still permit runtime throws or unsafe resume decisions** (`run-store.ts` unit validation; `resume.ts` `existsSync(effectiveCwd)` / `sessionPromptEstablished` checks): missing `effectiveCwd` reached fs APIs; non-boolean `sessionPromptEstablished` (e.g. string `"false"`) bypassed crash-window handling.

### Round 8 schema/compatibility choices

- Require `details.results` as an array on every valid V1 record (empty array remains valid; absent is `corrupt_run`).
- When `details.outputs` is present: non-null non-array object; each entry is a non-null object with `text: string`, `agent: string`, `step: positive integer`; optional `structured` accepts any JSON value including `null`.
- When `details.chain` is present: non-null object with `totalSteps` non-negative integer and `steps` array; each step validates kind-specific required fields/types/status and fanout counters enough that resume/restore cannot throw. Absent `chain`/`outputs` remains valid (presentation optional).
- Require `unit.effectiveCwd` as a non-empty string for every unit. Evidence: writers always set it; no valid V1 fixture omits it. No normalize/derive path.
- Validate optional `sessionPromptEstablished` strictly as boolean; reject other types as `corrupt_run`. Absent remains valid legacy (established-by-sessionFile).
- Adjacent session fields: `sessionFile` / `worktreePath` must be non-empty strings when present; `acpSessionId` remains trimmed non-empty string.

### Round 8 execution record

| Item                                              | Status   | Files changed                                                                                                                  | Validation evidence                                     | Notes / deviations                                                                                                                                                        |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R8-1 Durable details/chain/outputs validation     | Complete | `packages/pi-agents/src/run-store.ts`, `packages/pi-agents/tests/run-store.test.ts`, `packages/pi-agents/tests/resume.test.ts` | `bun test …run-store.test.ts …resume.test.ts` → 91 pass | Added `validateSubagentDetails` + chain step/output entry validators; preflight/claim never throw or write on corrupt details.                                            |
| R8-2 Unit effectiveCwd + sessionPromptEstablished | Complete | `packages/pi-agents/src/run-store.ts`, `packages/pi-agents/tests/run-store.test.ts`, `packages/pi-agents/tests/resume.test.ts` | same focused suite → pass                               | Require non-empty `effectiveCwd`; boolean-only `sessionPromptEstablished`; non-empty `sessionFile`/`worktreePath` when present. Explicit false crash-window still blocks. |

### Round 8 status

- Items R8-1 and R8-2 implemented with focused regression coverage.
- **Round 8 complete** after mandatory final validation:
  - Focused suite: **685 pass / 0 fail** (18 files, includes worktree + resume)
  - `mise run typecheck --package packages/pi-agents`: pass
  - `mise run test --package packages/pi-agents`: **1020 pass / 0 fail** (43 files)
  - `hk check`: pass (eslint + prettier)
  - `mise run build --package packages/pi-agents`: pass
  - `git diff --check`: pass

## Pause After Round 8

Remediation paused by request after Round 8 validation. Residual independent-review findings were not fixed in this session and are tracked as deferred optimization items in:

- `packages/pi-agents/docs/todos/2026-07-16-subagent-memory-optimization-followups.md`

Open at pause:

- Critical: durable result status/exitCode consistency under-validation
- Critical: details validation not mode/topology-aware
- Critical: non-allowlisted AgentMessage roles (e.g. `bashExecution`) skip projection
- Warning: assistant text sibling identity fields may remain unbounded
- Warning: truncated render summary may reintroduce ANSI reset injection

Do not treat the branch as final-approval-ready until those follow-ups are closed and re-reviewed.

## Final Validation

- Run: `bun test packages/pi-agents/tests/result-snapshot.test.ts packages/pi-agents/tests/update-coalescer.test.ts packages/pi-agents/tests/memory-regression.test.ts packages/pi-agents/tests/output.test.ts packages/pi-agents/tests/render.test.ts packages/pi-agents/tests/execution.test.ts packages/pi-agents/tests/pi-rpc-execution.test.ts packages/pi-agents/tests/pi-rpc-integration.test.ts packages/pi-agents/tests/interactive-agent.test.ts packages/pi-agents/tests/interactive-view.test.ts packages/pi-agents/tests/interactive-relay.test.ts packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/run-coordinator.test.ts packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/completion-check.test.ts`
- Expected: All focused memory, isolation, ordering, rendering, resume, coordinator/store, and Interactive Agent View tests pass with zero failures.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript type checking passes.
- Run: `mise run test --package packages/pi-agents`
- Expected: The complete `pi-agents` package suite passes with zero failures.
- Run: `hk check`
- Expected: ESLint and Prettier checks pass repository-wide.
- Run: `mise run build --package packages/pi-agents`
- Expected: The package builds successfully.
- Run: `git diff --check`
- Expected: No whitespace errors.

## Rollout Notes

- No configuration or durable schema migration is introduced.
- Existing inactive Version 1 run files remain untouched; they compact only when actively resumed and rewritten.
- Raw native child-session history remains subject to the runtime/session identity rules documented by the original feature plan.
- Do not stage or commit these changes unless explicitly requested.

## Risks and Mitigations

- **Ownership tracking may accidentally reject valid idempotent reuse** — cover repeated snapshots, aggregate shell copies, restored records, and structured-output identity with focused tests.
- **Deferred eviction may race activation consumers or lazy hydration** — preserve synchronous settled emission and test relay ordering plus disposal/session lease barriers.
- **Stricter durable validation may reject valid legacy records** — validate only the minimum result shell required by the runtime and retain legacy populated-message acceptance tests.
- **Moving postprocessing into the finalizer may double-apply schema/status stamping** — make postprocessing idempotent or track execution explicitly and assert exact terminal metadata in sequential/fanout tests.
- **Recursive payload bounding may truncate authoritative assistant data** — exempt assistant text and verify exact final text/usage preservation in Pi RPC tests.
