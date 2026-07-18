# Agent RPC Overflow Review Fixes Round 2 Implementation Plan

**Goal:** Close the nine findings from the second scoped review without changing unrelated behavior or reworking the artifact/RPC architecture.

**Inputs:** The second reviewer report for `a98c7e8737cfebc10e6dbb45b0e58f6678b47a45..working tree`; the current uncommitted implementation; `2026-07-16-agent-rpc-overflow-artifact-spill-plan.md`; `2026-07-17-agent-rpc-overflow-review-fixes-plan.md`.

**Assumptions:**

- Existing Version 1 durable contracts and fixed budgets remain unchanged.
- Runtime-resolved artifact values never replace durable reference fields.
- The child artifact reader may use Node filesystem APIs only; it must fail closed when it cannot prove that the opened inode belongs to the expected run path.
- No unrelated cleanup, dependency update, migration, or new configuration is included.

**Architecture:** Preserve durable refs through restored Chain state and resolve them only at trusted use points. Make post-claim resume preparation a single verified transaction boundary before any durable mutation or coordinator registration. Complete generation-based relay freshness and fail-closed projection/reader validation, while enforcing strict terminal APIs and spill-before-clone ordering.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, SHA-256, Pi 0.80.9 RPC/types, Mise, and HK.

---

## Requirement Coverage

| Second-review finding                                                                           | Task   |
| ----------------------------------------------------------------------------------------------- | ------ |
| Collect externalizer is not passed and stores descriptors/refs as inline authority              | Task 1 |
| Restored sequential output overwrites refs with inline-only fields                              | Task 1 |
| Post-claim validation and `itemsRef` resolution do not use one fresh record or cleanup boundary | Task 2 |
| Relay can send after a newer activation starts and clears                                       | Task 3 |
| Projector does not record scalar token kinds                                                    | Task 4 |
| Reader does not prove intermediate-path containment and leaks root errors                       | Task 5 |
| Durable path snapshots before spill                                                             | Task 6 |
| Parallel parent output is not ref-aware                                                         | Task 6 |
| Restored TUI launch loses reader requirement                                                    | Task 6 |
| Strict terminal APIs still fall back to non-strict methods                                      | Task 6 |

## File Map

- Modify: `packages/pi-agents/src/chain.ts` — preserve/ref-resolve/externalize Chain output unions.
- Modify: `packages/pi-agents/src/resume.ts` — validate a supplied fresh record and return runtime-only resolved state.
- Modify: `packages/pi-agents/src/tool.ts` — transactional post-claim preparation, spill-before-clone, Parallel descriptors, and reader requirement persistence.
- Modify: `packages/pi-agents/src/run-types.ts` — additive persisted reader requirement if no existing durable field represents it.
- Modify: `packages/pi-agents/src/run-store.ts` — validate the additive reader requirement.
- Modify: `packages/pi-agents/src/run-coordinator.ts` — strict-only terminal writes and reader requirement propagation.
- Modify: `packages/pi-agents/src/run-persistence.ts` — strict-only terminal event append.
- Modify: `packages/pi-agents/src/interactive-agent.ts` — durable reader requirement restore and monotonic relay epoch.
- Modify: `packages/pi-agents/src/interactive-relay.ts` — exact post-I/O epoch comparison.
- Modify: `packages/pi-agents/src/pi-rpc-record-projector.ts` — scalar/container token-kind recording.
- Modify: `packages/pi-agents/src/artifact-reader-extension.ts` — opened-inode containment and complete error collapse.
- Test: focused suites for Chain, resume/tool, coordinator/store, interactive agent/relay, projector/transport, reader, output, and memory regression.

## Tasks

### Task 1: Preserve and Externalize Chain Authority Correctly

**Outcome:** Restored and collected Chain outputs keep valid inline/reference unions; descriptors are used only for child prompt text, never as structured or durable authority.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/result-payload.test.ts`

**Steps:**

- [ ] Destructure `externalizeChainOutput` from `RunChainWorkflowOptions` and pass it through every `StepShared` construction, including `runSequentialStep()` and `runFanoutStep()`.
- [ ] Replace the inline-only output reconstruction in `rehydrateCompletedSequentialFromDurable()` with `chainOutputFromResult()`, preserving `text|textRef` and `structured|structuredRef`.
- [ ] Preserve `previousRef` when the last completed restored step has `textRef`; do not collapse it to empty text.
- [ ] Resolve `structuredRef` only for JSON Pointer/fanout/collect runtime use. Resolve `textRef` only when trusted code needs content; child prompt handoff continues to use a bounded descriptor and marks reader need.
- [ ] Change collect externalization to produce one `ChainOutputEntry` with strict unions: exactly one of `text`/`textRef`; structured data absent or exactly one of `structured`/`structuredRef`.
- [ ] Keep the full collected text/JSON in local runtime variables until externalization returns. Store returned refs in `textRef`/`structuredRef`, never in `text`/`structured`.
- [ ] Add skipped-item notes without converting a referenced authoritative collect to inline descriptor authority. If the note changes authoritative text, externalize the final text including the note.
- [ ] Set `previousOutput` to inline final text or a child descriptor derived from `textRef`; set `previousRef` when referenced.
- [ ] Test restored named `structuredRef` followed by JSON Pointer/fanout, restored `textRef` followed by `{previous}`, oversized collect exact unions, and absence of descriptor/ref objects in structured authority.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/chain.test.ts tests/result-payload.test.ts)`
- Expected: restored refs remain reachable; collect stores exact unions; descriptors appear only in prompts/content.

### Task 2: Make Resume Verification and Preparation Transactional

**Outcome:** Pre-claim and post-claim checks validate the exact records later consumed; all runtime fanout resolution and restored-state construction finish before mutation, registration, or dispatch; every post-claim failure abandons the claim.

**Files:**

- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Split resume inspection into a loader wrapper and a record-based verifier, for example `inspectResumeRecord(record, store, options)`. The verifier must not reread `run.json`.
- [ ] Make the normal preflight load once and verify that loaded record.
- [ ] After claim, load one fresh record, verify that same object, resolve every `itemsRef`, verify the resolved value is an array with length matching `unitIds`, and build all restored Chain/runtime state from that object.
- [ ] Validate all reachable result/output refs and parse JSON refs before any `run_resumed` event, status/attempt mutation, `updateRun`, coordinator registration, or worker dispatch.
- [ ] Move normalization, unit staging, resolved fanouts, logical-step construction, and restored output construction inside one post-claim `try` that begins immediately after claim.
- [ ] On every error in that boundary, call `unregisterRun()` idempotently, `safeAbandon()`, and return an error. Never release the claim or leave a live registration.
- [ ] Only after all verification/runtime construction succeeds may the code append `run_resumed`, write running state, and register the coordinator.
- [ ] Keep resolved fanout items runtime-only; durable records retain `itemsRef`.
- [ ] Test valid-JSON non-array `itemsRef`, length mismatch, ref corruption between preflight and claim, failure during restored-state construction, and no event/mutation/register/dispatch on each failure.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/resume.test.ts tests/tool.test.ts)`
- Expected: all post-claim failures abandon cleanly and leave durable status/attempts/fanout refs unchanged.

### Task 3: Use a Persistent Monotonic Relay Epoch

**Outcome:** A continuation is sent only if transport and activation generations are unchanged, even when a newer activation starts and settles during artifact I/O.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/interactive-relay.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/interactive-relay.test.ts`

**Steps:**

- [ ] Store a monotonic activation generation on the endpoint independently of the optional active activation object. Increment it whenever a new activation is created; do not reset it when activation settles/clears.
- [ ] Expose one registry method returning `{ transportGeneration, activationGeneration }` for an existing endpoint.
- [ ] Capture the exact epoch before artifact I/O and require the endpoint to exist with an exactly equal epoch immediately before send.
- [ ] Remove the conditional comparison that skips activation validation when `postSnap.activation` is absent.
- [ ] Preserve session, binding, branch, duplicate, and shutdown checks.
- [ ] Test blocked spill where a new activation starts and remains active, starts then settles/clears, endpoint reopens, endpoint disappears, and unchanged epoch sends once.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-agent.test.ts tests/interactive-relay.test.ts)`
- Expected: every stale epoch suppresses delivery; unchanged epoch preserves exactly-once send.

### Task 4: Record Scalar Token Kinds in the Projector

**Outcome:** Wrong scalar/container shapes revoke projectability before the record crosses the ordinary 8 MiB boundary.

**Files:**

- Modify: `packages/pi-agents/src/pi-rpc-record-projector.ts`
- Test: `packages/pi-agents/tests/pi-rpc-record-projector.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-transport.test.ts`

**Steps:**

- [ ] Extend the recorded token kind to include `object`, `array`, `string`, `number`, `boolean`, and `null`.
- [ ] Record the kind when any top-level canonical bulk-field value begins, not only for `{` and `[`.
- [ ] Require `messages`/`toolResults` to be arrays and `message`/`assistantMessageEvent` to be objects before granting or retaining the projectable budget.
- [ ] Keep `args`, `partialResult`, and `result` unrestricted among valid JSON token kinds.
- [ ] Revoke projectability immediately on a constrained wrong kind; records at/below 8 MiB remain ordinary, records above fail `stdout_overflow`, and no shell is delivered.
- [ ] Add oversized scalar regressions for string, number, boolean, and null plus legal `any` controls.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-record-projector.test.ts tests/pi-rpc-transport.test.ts)`
- Expected: no wrong-shaped record receives the 64 MiB budget.

### Task 5: Prove Opened Artifact Containment and Collapse All Errors

**Outcome:** The child reader accepts bytes only when the opened inode matches the digest-derived path inside the owning run and no path component is a symlink; every filesystem/security failure is `artifact_unavailable`.

**Files:**

- Modify: `packages/pi-agents/src/artifact-reader-extension.ts`
- Test: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Move `realpathSync(root)` and all path work into the single error-collapse boundary.
- [ ] Validate every intermediate component from the trusted root through `artifacts/sha256/<prefix>` with `lstat` before open and after read; reject symlinks and non-directories.
- [ ] Open the final file with `O_NOFOLLOW`, then compare `fstat` identity (`dev`/`ino` where available) with a post-open `lstat` of the digest-derived path.
- [ ] Resolve the opened path after open and require its real path to be contained under the real run root and to correspond to the expected digest-derived location. If the platform cannot prove identity/containment, fail closed.
- [ ] Read/hash through the same fd, repeat `fstat`, path identity, and intermediate-component checks after read, then return the verified buffer.
- [ ] Ensure root missing, parent symlink, final symlink, path swap, permission, open/stat/read/hash, containment, and close failures expose only `artifact_unavailable`; preserve `invalid_artifact_offset` only after successful verification.
- [ ] Add deterministic parent-directory symlink and swap regressions, root-error path leakage assertions, and same-fd identity tests.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts)`
- Expected: intermediate symlinks and swaps fail closed; no child-visible error contains a path or native filesystem message.

### Task 6: Finish Strict Publication, Spill Ordering, Parent Output, and Restore Wiring

**Outcome:** Strict terminal APIs are mandatory, durable results spill before snapshot cloning, all parent modes render refs, and restored TUI children retain reader access.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/run-persistence.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/output.test.ts`
- Test: `packages/pi-agents/tests/memory-regression.test.ts`

**Steps:**

- [ ] Remove `updateRun()` fallback from `RunCoordinator.finalizeRun()` and `appendEvent()` fallback from `finalizeDurableRun()`. Missing strict APIs must throw a bounded durable-write failure before success publication.
- [ ] Keep the unique order: strict run write -> one strict terminal event -> unregister -> release; failure -> unregister -> abandon -> rethrow.
- [ ] In durable `runStepWithContext`, pass the private unsnapshotted result to `endUnit()` so `finishUnit()` externalizes before `snapshotSingleResult()`. Snapshot directly only for non-durable paths or after receiving the committed compact result.
- [ ] Keep postprocessing, completion/schema checks, status stamping, and worktree finalization on private authority before externalization.
- [ ] Use `getResultParentOutput()` for successful Parallel items as well as Single/Chain; preserve existing failure formatting.
- [ ] Persist `requireArtifactReader?: true` in the unit record when a unit handoff requires it, validate it as an additive Version 1 boolean, and copy it into initial and both restore `InteractiveLaunchSpec` paths. Do not infer the capability from untrusted prompt text.
- [ ] Ensure resumed `UnitExecutionContext` receives the persisted reader requirement.
- [ ] Test missing strict methods fail closed, oversized structured output is not cloned before artifact publication, Parallel ref output is bounded and not `(no output)`, and restored/reopened TUI Pi launches include extension/tool/env only when the durable requirement is true.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts tests/run-store.test.ts tests/interactive-agent.test.ts tests/output.test.ts tests/memory-regression.test.ts)`
- Expected: strict-only publication, spill-before-clone, ref-aware parent output, and reader restore all pass.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/chain.test.ts tests/result-payload.test.ts tests/resume.test.ts tests/tool.test.ts tests/run-coordinator.test.ts tests/run-store.test.ts tests/interactive-agent.test.ts tests/interactive-relay.test.ts tests/pi-rpc-record-projector.test.ts tests/pi-rpc-transport.test.ts tests/artifact-reader-extension.test.ts tests/output.test.ts tests/memory-regression.test.ts)`
- Expected: all second-review regressions pass with zero failures.

- Run: `mise run test --package packages/pi-agents`
- Expected: complete package suite passes.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: all new async/runtime-only/persisted contracts type-check.

- Run: `mise run build --package packages/pi-agents`
- Expected: both package entries build.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both entries appear in the dry-run package.

- Run: `hk check`
- Expected: ESLint and Prettier pass.

- Run: `git diff --check`
- Expected: no whitespace errors.

## Failure Behavior

| Failure                                              | Required behavior                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Chain ref cannot resolve                             | Fail before JSON Pointer/fanout/dispatch; never persist a descriptor as authority. |
| Post-claim ref/fanout/runtime construction fails     | No resume event/mutation/register/dispatch; unregister and abandon.                |
| Relay epoch changes or endpoint disappears           | Suppress send and release reservation.                                             |
| Constrained RPC bulk field is scalar/wrong container | Revoke projectability and enforce ordinary cap.                                    |
| Reader cannot prove opened inode containment         | `artifact_unavailable`, no content or path details.                                |
| Strict terminal method is unavailable/fails          | No fallback or parent success; unregister and abandon.                             |
| Referenced parent result                             | Bounded descriptor in Single, Parallel, and Chain.                                 |

## Privacy and Security

- Descriptors never become structured authority and never contain artifact content.
- Resume verifies refs before side effects and keeps hydrated values runtime-only.
- Relay compares persistent monotonic generations after artifact I/O.
- Reader verifies intermediate components, opened inode identity, containment, size, and digest while collapsing path details.
- Strict publication cannot silently downgrade to best-effort durability.

## Risks and Mitigations

- **Persisting reader need changes Version 1 records additively.** — Use an optional boolean, validate it strictly, and retain legacy absence as false.
- **Path validation cannot be fully atomic without `openat`.** — Combine no-follow final open, pre/post intermediate checks, opened-fd identity comparison, and fail-closed platform behavior.
- **Post-claim preparation is broad.** — Keep all throwable preparation before durable mutation and cover every failure with the same abandon boundary.

## Open Questions

**Open Questions:** None.
