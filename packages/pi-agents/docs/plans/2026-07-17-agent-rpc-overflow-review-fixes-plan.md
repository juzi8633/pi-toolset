# Agent RPC Overflow Review Fixes Implementation Plan

**Goal:** Fix the eleven confirmed review findings without unrelated refactoring, restoring the strict terminal barrier, artifact-backed Chain/resume authority, typed reader handoff, bounded parent delivery, and fail-closed transport and reader behavior.

**Inputs:** Reviewer findings for `5be71b158c6b5dcc0145e3c5fb69b560150bc208..a98c7e8737cfebc10e6dbb45b0e58f6678b47a45`; the current `packages/pi-agents` implementation and tests; `packages/pi-agents/docs/plans/2026-07-16-agent-rpc-overflow-artifact-spill-plan.md`; installed Pi 0.80.9 types and runtime behavior.

**Assumptions:**

- Durable schema Version 1, artifact reference contracts, fixed limits, and dependency versions remain unchanged.
- Projector shape checks follow Pi 0.80.9 types: `messages` and `toolResults` are arrays; `message` and `assistantMessageEvent` are non-array objects. Fields typed as `any` (`args`, `partialResult`, and `result`) remain unrestricted JSON values.
- Parent artifact descriptors are metadata-only and bounded to 2 KiB; they do not resolve artifact content.
- No artifact garbage collection, migration, new configuration, or Pi upgrade is included.
- Existing two-line `ABOUTME:` headers remain intact; no new TypeScript source file is required.

**Architecture:** First consolidate fresh and resumed run completion behind one strict durable barrier. Then restore artifact authority at trusted Chain and resume boundaries, including exact JSON byte accounting and pre/post-claim validation. Complete typed reader and parent handoff before independently hardening relay freshness, projector structural classification, and same-file-descriptor artifact reading.

**Tech Stack:** TypeScript, Bun 1.3.14, Node.js filesystem APIs, SHA-256, Pi 0.80.9 RPC/types, Mise, ESLint, Prettier, and HK.

---

## Requirement Coverage

| Review finding                                                        | Planned task |
| --------------------------------------------------------------------- | ------------ |
| Strict run finalization falls back to best-effort writes              | Task 1       |
| Fresh/resume paths duplicate `run_terminal` and mishandle claims      | Task 1       |
| Chain JSON Pointer/fanout/collect do not restore referenced authority | Task 2       |
| Resume does not verify all reachable refs before and after claim      | Task 2       |
| Fanout threshold does not use exact persisted JSON bytes              | Task 2       |
| TUI launch loses the artifact-reader requirement                      | Task 3       |
| Parent result renders referenced output as `(no output)`              | Task 3       |
| Oversized structured authority is cloned before spill selection       | Task 3       |
| Relay does not recheck endpoint/activation generations after I/O      | Task 4       |
| Projector omits canonical bulk-field shape validation                 | Task 5       |
| Child artifact reader has pathname TOCTOU and error leakage           | Task 6       |

## Scope

### Included

- Only production and test changes required by the eleven confirmed findings.
- Focused documentation correction for parent artifact descriptors when behavior changes.
- Regression tests that prove failure ordering and pre-dispatch fail-closed behavior.

### Out of Scope

- Unrelated cleanup, API redesign, schema migration, dependency updates, configurable limits, artifact GC, or broad filesystem abstractions.
- Restricting Pi fields typed as `any` beyond valid JSON and canonical key presence/order.

## File Map

- Modify: `packages/pi-agents/src/run-coordinator.ts` — strict run finalization and exact fanout byte accounting.
- Modify: `packages/pi-agents/src/run-persistence.ts` — shared terminal/claim barrier.
- Modify: `packages/pi-agents/src/tool.ts` — resume cleanup, reader propagation, parent output, and pre-spill ordering.
- Modify: `packages/pi-agents/src/chain.ts` — trusted ref resolution for JSON Pointer, fanout, collect, and restored outputs.
- Modify: `packages/pi-agents/src/resume.ts` — asynchronous pre/post-claim artifact verification.
- Modify: `packages/pi-agents/src/result-payload.ts` — Chain externalization and bounded descriptors.
- Modify: `packages/pi-agents/src/output.ts` — ref-aware parent output formatting.
- Modify: `packages/pi-agents/src/interactive-agent.ts` — typed reader requirement and relay epoch access.
- Modify: `packages/pi-agents/src/interactive-relay.ts` — post-I/O endpoint/activation freshness checks.
- Modify: `packages/pi-agents/src/pi-rpc-record-projector.ts` — canonical bulk-field token-kind validation.
- Modify: `packages/pi-agents/src/artifact-reader-extension.ts` — same-fd open/stat/read/hash verification.
- Modify: `packages/pi-agents/docs/how-to.md` — parent descriptor guidance.
- Test: `packages/pi-agents/tests/{run-coordinator,tool,chain,resume,result-payload,output,execution,interactive-agent,interactive-relay,pi-rpc-record-projector,pi-rpc-transport,artifact-reader-extension,memory-regression}.test.ts`.

## Tasks

### Task 1: Establish One Strict Terminal Barrier

**Outcome:** Fresh and resumed runs publish terminal authority once. Strict failures never fall back to best-effort writes; success releases the claim and failure abandons it.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/run-persistence.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Make `RunCoordinator.finalizeRun()` strictly persist the terminal `run.json` clone and return its committed status. It must not append `run_terminal`, unregister the run, release/abandon a claim, or fall back to `writeRun()`.
- [ ] Serialize active and inactive finalization through the existing durable queue. Do not mutate live terminal fields before `updateRunStrict()` succeeds; mirror the committed record only after success.
- [ ] Use one shared helper in `run-persistence.ts` for both fresh and resumed completion.
- [ ] Enforce success order: strict `finalizeRun()` -> one `appendEventStrict(run_terminal)` -> `unregisterRun()` -> `releaseRun()`.
- [ ] Enforce failure order: `unregisterRun()` -> `abandonRun()` -> rethrow. A release failure also enters the failure path.
- [ ] Remove duplicate resume/fresh `run_terminal` publication and unconditional release logic from `tool.ts`.
- [ ] Ensure parent/background success is not visible before the shared barrier resolves.
- [ ] Test active/inactive strict run-write failure, strict terminal-event failure, release failure, and fresh/resume success. Assert exactly one terminal event on success and an abandoned claim on every barrier failure.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts)`
- Expected: zero failures; no best-effort fallback; fresh and resume each append one `run_terminal`; success releases and failure abandons.

- Run: `test "$(rg -n "event: ['\"]run_terminal['\"]" packages/pi-agents/src/{run-coordinator,run-persistence,tool}.ts | wc -l)" -eq 1`
- Expected: exits 0; `run-persistence.ts` is the sole terminal-event publisher.

### Task 2: Restore Chain and Resume Artifact Authority

**Outcome:** Chain consumers recover verified authority at trusted use sites, collect outputs can spill again, and resume verifies every reachable ref both before and after claim without dispatching on corruption.

**Depends on:** Task 1.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/result-payload.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/result-payload.test.ts`

**Steps:**

- [ ] Wire the existing Chain artifact resolver to `RunStore.readTextArtifact()` or `readJsonArtifact()` according to media type and expected authority.
- [ ] Resolve and verify `structuredRef` before JSON Pointer or fanout source use. Missing resolver, wrong media type, cross-run, missing, or corrupt refs must fail before worker dispatch.
- [ ] Build collected arrays from verified child `structuredOutputRef` or `finalOutputRef` values. Delete `__runArtifact` placeholder authority.
- [ ] Add a focused Chain-output externalizer using existing exact text/pretty-JSON-plus-LF serialization and the 256 KiB threshold. Persist only exact inline/ref unions.
- [ ] Externalize collected text/structured outputs before storing `details.outputs` or passing them as later `{previous}`/named outputs.
- [ ] Make `inspectResume()` asynchronous and validate all reachable refs in `units[*].result`, `details.results[*]`, `details.outputs[*]`, and `workflowState.fanouts[*].itemsRef`.
- [ ] Verify once during read-only preflight and again against the fresh post-claim record. Return resolved fanout items only as runtime state; never write hydration back to durable refs.
- [ ] Move artifact reads and restored-state construction before running-status mutation, attempt changes, coordinator registration, or process dispatch.
- [ ] On any post-claim failure, unregister idempotently and abandon the claim; do not release, redispatch completed work, or rewrite frozen mappings.
- [ ] Replace compact `JSON.stringify()` fanout item/aggregate threshold checks with the artifact store's exact pretty JSON plus LF byte measurement.
- [ ] Test a value whose compact JSON is below 256 KiB but persisted JSON exceeds it: individual items reject; aggregate mappings spill to `itemsRef`.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/chain.test.ts tests/resume.test.ts tests/tool.test.ts tests/run-coordinator.test.ts tests/result-payload.test.ts)`
- Expected: verified values reach JSON Pointer/fanout/collect; collect can spill; all refs are checked pre/post-claim; corruption causes no registration, attempt mutation, or dispatch.

- Run: `! rg -n "__runArtifact|Buffer\.byteLength\(JSON\.stringify\(input\.items" packages/pi-agents/src/{chain,run-coordinator}.ts`
- Expected: exits 0.

### Task 3: Complete Reader Handoff and Bounded Parent Delivery

**Outcome:** Artifact-reader need reaches TUI Pi launches through typed state, referenced parent output renders a bounded descriptor, and spill selection precedes deep cloning.

**Depends on:** Tasks 1-2.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Modify: `packages/pi-agents/src/result-payload.ts`
- Modify: `packages/pi-agents/docs/how-to.md`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/output.test.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/memory-regression.test.ts`

**Steps:**

- [ ] Add `requireArtifactReader?: boolean` to `InteractiveLaunchSpec` and propagate it from `UnitExecutionContext` when creating/restoring Pi launch specs.
- [ ] Remove the type assertion in `interactive-agent.ts`; use the typed field to inject private run env, the child extension, and the reader tool only when required.
- [ ] Add a ref-aware parent output helper: inline text wins; `finalOutputRef` produces a metadata-only descriptor capped at 2 KiB; only absent authority produces `(no output)`.
- [ ] Use the helper for Single, Parallel, and Chain terminal parent delivery. Do not resolve artifact content or include an unbounded absolute path.
- [ ] Update `docs/how-to.md` so inspection uses run metadata rather than assuming the parent descriptor contains an absolute path.
- [ ] Reorder terminal processing so private full authority reaches awaited durable externalization before `snapshotSingleResult()` can clone oversized structured output.
- [ ] Preserve snapshotting for non-durable paths and compact committed results after spill.
- [ ] Add a real TUI registration/launch regression asserting reader extension, tool allowlist, and owning run environment are present for an artifact handoff and absent otherwise.
- [ ] Test oversized final text parent output is bounded, contains ref metadata, excludes payload sentinel, and is not `(no output)`.
- [ ] Test oversized structured authority is not cloned before spill; small inline structured values remain owned/frozen.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/output.test.ts tests/interactive-agent.test.ts tests/execution.test.ts tests/memory-regression.test.ts)`
- Expected: typed reader propagation works in TUI and non-TUI paths; parent descriptors remain bounded; large structured values spill before clone.

- Run: `! rg -n "as \{ requireArtifactReader\?: boolean \}" packages/pi-agents/src/interactive-agent.ts`
- Expected: exits 0.

### Task 4: Revalidate Relay Freshness after Artifact I/O

**Outcome:** Continuations are sent only when endpoint transport and activation generations are unchanged across asynchronous spill I/O.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/interactive-relay.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/interactive-relay.test.ts`

**Steps:**

- [ ] Expose a read-only relay epoch containing transport generation and a monotonic activation generation. Keep it runtime-only.
- [ ] Capture the epoch after reserving the activation and before artifact I/O.
- [ ] Immediately before `pi.sendMessage()`, rerun existing session/binding/branch checks and require both epoch values to match.
- [ ] Suppress and release the reservation if the endpoint was removed/reopened or a newer activation began. Preserve exactly-once delivery and shutdown `waitForIdle()`.
- [ ] Use blocked artifact writes to test transport-generation and activation-generation races, plus an unchanged-epoch success control.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-relay.test.ts tests/interactive-agent.test.ts)`
- Expected: stale transport or activation suppresses delivery; valid delivery, deduplication, and shutdown draining remain correct.

### Task 5: Validate Projected Bulk-Field Shapes

**Outcome:** Only Pi 0.80.9 canonical records with the expected bulk-field container types receive the 64 MiB projectable budget.

**Files:**

- Modify: `packages/pi-agents/src/pi-rpc-record-projector.ts`
- Test: `packages/pi-agents/tests/pi-rpc-record-projector.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-transport.test.ts`

**Steps:**

- [ ] Track the token kind at each canonical top-level bulk value without retaining its payload.
- [ ] Require `agent_end.messages` and `turn_end.toolResults` to be arrays.
- [ ] Require message-event `message`, `message_update.assistantMessageEvent`, and `turn_end.message` to be non-array objects.
- [ ] Preserve existing bounded-string and boolean checks for shell fields.
- [ ] Keep `args`, `partialResult`, and `result` unrestricted valid JSON because Pi 0.80.9 types declare them as `any`.
- [ ] Revoke projectability on a wrong structural type. At or below 8 MiB the record remains ordinary; above 8 MiB it fails `stdout_overflow` without listener delivery.
- [ ] Add wrong-type oversized regressions for each constrained field and positive scalar/null controls for `any` fields.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-record-projector.test.ts tests/pi-rpc-transport.test.ts)`
- Expected: wrong shapes never receive the projectable budget; legal Pi 0.80.9 records still project; `any` fields are not over-restricted.

### Task 6: Verify and Read Child Artifacts through One File Descriptor

**Outcome:** The child reader opens the digest-derived artifact with no-follow semantics and performs stat, read, size/digest checks, and chunking against the same file descriptor; child-visible filesystem errors are uniformly bounded.

**Files:**

- Modify: `packages/pi-agents/src/artifact-reader-extension.ts`
- Test: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Keep private env/run ID and digest-derived path rules; continue rejecting caller paths.
- [ ] Open the final artifact with `O_RDONLY | O_NOFOLLOW` where supported. On the current POSIX production target, missing no-follow support must fail closed rather than use pathname reads.
- [ ] Use the same fd for `fstat`, full read, SHA-256, and a post-read `fstat`; require a regular file, exact stable size, and expected digest.
- [ ] Compute UTF-8 offsets and returned chunks only from the verified buffer.
- [ ] Close the fd in `finally`; close errors must not replace an existing security error.
- [ ] Convert root/path/open/stat/read/hash/race/permission/symlink failures to the exact bounded `artifact_unavailable` child error without absolute paths or native error text.
- [ ] Preserve `invalid_artifact_offset` only for valid artifacts with an out-of-range or mid-code-point offset.
- [ ] Add deterministic pathname-swap/TOCTOU, operation-order, symlink, permission, and absolute-path-error regressions.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts)`
- Expected: pathname replacement cannot change bytes read after open; all filesystem/security failures collapse to `artifact_unavailable`; existing UTF-8 semantics pass.

## Final Validation

- Run:

  ```sh
  (cd packages/pi-agents && bun test \
    tests/run-coordinator.test.ts \
    tests/chain.test.ts \
    tests/resume.test.ts \
    tests/tool.test.ts \
    tests/result-payload.test.ts \
    tests/output.test.ts \
    tests/execution.test.ts \
    tests/interactive-agent.test.ts \
    tests/interactive-relay.test.ts \
    tests/pi-rpc-record-projector.test.ts \
    tests/pi-rpc-transport.test.ts \
    tests/artifact-reader-extension.test.ts \
    tests/memory-regression.test.ts)
  ```

  Expected: all regressions for the eleven findings pass with zero failures.

- Run: `mise run test --package packages/pi-agents`
- Expected: the complete package suite passes with zero failures.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: async resume, shared finalizer, Chain callbacks, typed launch state, and relay epoch type-check.

- Run: `mise run build --package packages/pi-agents`
- Expected: `dist/index.js` and `dist/artifact-reader-extension.js` build successfully without bundling peer SDKs.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both package entries appear in the dry-run file list.

- Run: `hk check`
- Expected: repository ESLint and Prettier checks pass.

- Run: `git diff --check`
- Expected: no whitespace errors.

## Failure Behavior

| Failure                                                     | Required behavior                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Strict final `run.json` write fails                         | No fallback, terminal event, or parent success; unregister, abandon, and rethrow.                          |
| Strict `run_terminal` append fails after `run.json` commits | Keep `run.json` authoritative; do not report success; unregister, abandon, and rethrow.                    |
| Claim release fails                                         | Attempt abandon and report failure; never silently retain an owner claim.                                  |
| Pre-claim ref is missing or corrupt                         | Fail read-only inspection without claim, mutation, or dispatch.                                            |
| Ref changes after claim                                     | Unregister and abandon without attempt/status/fanout mutation or dispatch.                                 |
| Chain ref cannot be verified                                | Fail before JSON Pointer, fanout, or downstream dispatch; never substitute a descriptor as JSON authority. |
| Parent result contains only `finalOutputRef`                | Return bounded metadata, not `(no output)` and not artifact content.                                       |
| Relay epoch changes during artifact I/O                     | Suppress delivery and release the in-flight reservation.                                                   |
| Projectable bulk field has the wrong type                   | Revoke projectability; ordinary cap remains authoritative.                                                 |
| Reader filesystem/path/hash validation fails                | Return exact bounded `artifact_unavailable` without path-existence details.                                |
| Reader offset is invalid for a verified artifact            | Return `invalid_artifact_offset` without content.                                                          |

## Privacy and Security

- Chain and resume resolve refs only through the owning `RunStore`; no caller path or cross-run reference is accepted.
- Parent and child descriptors contain no artifact content and remain bounded.
- The reader derives paths from digest and validates/reads one opened file descriptor with no-follow semantics.
- Child-visible reader failures do not reveal artifact roots, absolute paths, native errors, existence, or permission distinctions.
- Relay trust is revalidated after asynchronous I/O to prevent sensitive continuation delivery into a newer endpoint or activation.
- Projectable transport budgets remain limited to fully parsed canonical records with validated key order and structural field types.

## Rollout Notes

- Apply Tasks 1-3 sequentially because they overlap `tool.ts`, `chain.ts`, and terminal publication contracts.
- Tasks 4-6 may follow independently, but the final reviewer must inspect the complete fix diff as one review scope.
- Do not release unless all focused and final gates pass.

## Risks and Mitigations

- **Pre/post-claim validation reads large artifacts twice.** — Accept the cost to preserve fail-closed claim races; do not add a streaming verifier refactor in this fix.
- **`run.json` may commit before terminal-event failure.** — Treat `run.json` as authority, report failure, unregister, and abandon instead of reporting success.
- **Pi event type contracts may drift.** — Pin behavior to the installed Pi 0.80.9 runtime and tests; unknown future shapes remain on the ordinary 8 MiB boundary.
- **No-follow support differs by platform.** — Preserve strict POSIX behavior and add an explicit fail-closed path rather than an unsafe pathname fallback.

## Open Questions

**Open Questions:** None.
