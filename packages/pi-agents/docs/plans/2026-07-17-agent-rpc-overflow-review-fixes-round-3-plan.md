# Agent RPC Overflow Review Fixes Round 3 Implementation Plan

**Goal:** Close the six findings from the third scoped review: correct restored fanout authority, durably preserve child reader requirements, eliminate relay epoch ABA, complete side-effect-free post-claim preparation, fail closed on unavailable file identity, and add missing orchestration regressions.

**Inputs:** The reviewer report limited to the Round 2 implementation; current uncommitted source/tests; the original artifact-spill plan and Round 1/2 fix plans.

**Assumptions:**

- Version 1 additive optional fields remain allowed.
- `requireArtifactReader` is monotonic per unit: absent/false may become true, but true is never removed during a run.
- Endpoint incarnation is runtime-only and unique for the registry lifetime.
- Test-only dependency seams remain narrow and cannot alter production behavior.

**Architecture:** Fix authority selection first, then persist reader capability before launch. Build all resumed runtime state against the verified post-claim record before any durable/live side effect. Strengthen relay epochs with a registry-unique incarnation and reader verification with mandatory file identity, then add orchestration-level tests for the publication and rendering contracts.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, Pi 0.80.9, Mise, and HK.

---

## Requirement Coverage

| Finding                                                                     | Task   |
| --------------------------------------------------------------------------- | ------ |
| Restored fanout `{previous}` uses the last child ref instead of collect ref | Task 1 |
| Render-time reader requirement is deleted/not restored                      | Task 2 |
| Endpoint generation has remove/recreate ABA                                 | Task 3 |
| Restored Chain construction occurs after resume side effects                | Task 4 |
| File identity falls back to same size                                       | Task 5 |
| Spill-before-clone and parent ref regressions are missing                   | Task 6 |

## File Map

- Modify: `packages/pi-agents/src/chain.ts` — choose collect authority for restored fanout previous output/ref.
- Modify: `packages/pi-agents/src/run-coordinator.ts` — strict monotonic reader-requirement persistence.
- Modify: `packages/pi-agents/src/tool.ts` — copy reader requirement in fresh/resume contexts and prepare restored state before side effects.
- Modify: `packages/pi-agents/src/interactive-agent.ts` — registry-unique endpoint incarnation and restored reader wiring.
- Modify: `packages/pi-agents/src/interactive-relay.ts` — compare full incarnation/transport/activation epoch.
- Modify: `packages/pi-agents/src/artifact-reader-extension.ts` — fail closed when inode identity is unavailable and expose a narrow test seam.
- Test: `chain.test.ts`, `run-coordinator.test.ts`, `tool.test.ts`, `interactive-agent.test.ts`, `interactive-relay.test.ts`, `artifact-reader-extension.test.ts`, `output.test.ts`, and `memory-regression.test.ts`.

## Tasks

### Task 1: Prefer Restored Fanout Collect Authority

**Outcome:** A completed restored fanout exposes its collected output/ref to the next step; individual child refs cannot replace collect authority.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] In previous-output/ref reconstruction, branch on `logical.kind` before inspecting step results.
- [ ] For fanout, read only `outputs.get(logical.collectName)` and use its `text` or `textRef` as `{previous}` authority.
- [ ] For sequential steps, continue preferring the presentation/durable sequential result and its `finalOutput`/`finalOutputRef`.
- [ ] Never select the last fanout child result as the fanout's previous ref.
- [ ] Add a restored fanout test where the collect `textRef` and last child `finalOutputRef` have different digests; assert the next Pi task descriptor contains the collect digest only.
- [ ] Add an inline collect control to preserve existing byte-compatible behavior.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/chain.test.ts)`
- Expected: restored fanout handoff always uses collect authority.

### Task 2: Persist Reader Requirement before Child Launch

**Outcome:** Once task rendering requires the artifact reader, the unit record durably stores `requireArtifactReader: true` before launch, and fresh/resumed/TUI restore contexts retain it.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`

**Steps:**

- [ ] Make `RunCoordinator.startUnit()` strictly persist `requireArtifactReader: true` in the same awaited pre-launch unit mutation when the rendered `UnitExecutionContext` requires it.
- [ ] Treat the field as monotonic in every live/disk merge: disk true or live true yields true; no merge may delete true because the other side is absent.
- [ ] Ensure `beginUnit/startUnit` completes before any child spawn or RPC activation.
- [ ] Copy the durable field into both fresh and resumed `unitFor()` contexts.
- [ ] Preserve the field through `ResolvedArtifacts` and both `registrationKind: 'restore'` launch-spec paths.
- [ ] Do not infer reader need from prompt text or a descriptor string.
- [ ] Test that a rendered referenced handoff sets the context flag, the strict store contains true before spawn, merge/finish cannot remove it, resume `unitFor()` returns it, and both restored TUI launch paths inject extension/tool/private env.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts tests/interactive-agent.test.ts)`
- Expected: reader need is durable before launch and survives every restore path.

### Task 3: Eliminate Relay Epoch ABA

**Outcome:** Removing and recreating an endpoint can never reproduce an earlier relay epoch.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/interactive-relay.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/interactive-relay.test.ts`

**Steps:**

- [ ] Add a registry-level monotonic endpoint incarnation counter that is incremented for every endpoint object creation and never reset/reused during the registry lifetime.
- [ ] Store `endpointIncarnation` on each endpoint independently of transport and activation generations.
- [ ] Return `{ endpointIncarnation, transportGeneration, activationGeneration }` from `getEndpointEpoch()`.
- [ ] Capture and compare the complete exact epoch around artifact I/O; missing endpoint or any changed field suppresses send.
- [ ] Keep activation generation monotonic after settle/clear.
- [ ] Add a blocked-I/O regression: remove endpoint, recreate it, activate and settle it, then release the old I/O. Assert no continuation is sent even if transport/activation counters numerically match the old endpoint.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-agent.test.ts tests/interactive-relay.test.ts)`
- Expected: remove/recreate ABA and all generation changes suppress stale sends.

### Task 4: Complete Post-Claim Runtime Preparation before Side Effects

**Outcome:** The exact verified post-claim record is transformed into all runtime-only resume state before any event, run mutation, coordinator registration, or dispatch.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] After claim, keep one `try/catch` from fresh record load through all verification, fanout resolution, unit cloning, logical-step building, restored output construction, project/runtime context construction, durable writes, and registration.
- [ ] Before `run_resumed`, `updateRun`, or `registerRun`, compute `resolvedFanouts`, `logicalSteps`, and the complete `RestoredChainState` from the verified fresh record and staged local unit clones.
- [ ] Perform no disk/live mutation while building this state. Mutating local clones is allowed.
- [ ] Only after all throwable runtime preparation succeeds may the function append the resume event, write running state, and register.
- [ ] On every failure, unregister idempotently, abandon the claim, and return an error; do not release.
- [ ] Add a narrow test-only builder seam if necessary to force restored-state construction failure after ref validation but before side effects. The production default must call the real builder.
- [ ] Assert forced failure produces no `run_resumed`, no running update, no attempt/status mutation, no registration/dispatch, and one abandon.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: all restored-state failures are side-effect-free and abandon the claim.

### Task 5: Fail Closed without Stable File Identity

**Outcome:** The child reader never treats equal size as proof that the opened fd and digest path name the same file.

**Files:**

- Modify: `packages/pi-agents/src/artifact-reader-extension.ts`
- Test: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Change identity comparison to require stable `dev` and `ino` values on both stats and exact equality. If either identity is unavailable or unusable, return false and fail `artifact_unavailable`.
- [ ] Retain size/digest checks as additional validation, never as identity fallback.
- [ ] Add a narrow filesystem-ops parameter/default so tests can substitute `fstat/lstat` results without creating a production mock mode.
- [ ] Test missing identity fields, equal-size different inode, path swap after open, and the normal same-inode path.
- [ ] Assert every mismatch returns exact `artifact_unavailable` without path/native error text.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts)`
- Expected: unavailable/mismatched identity always fails closed.

### Task 6: Add Orchestration-Level Publication Regressions

**Outcome:** Tests prove spill selection precedes snapshot cloning and every parent mode renders referenced output as bounded metadata.

**Files:**

- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/output.test.ts`
- Test: `packages/pi-agents/tests/memory-regression.test.ts`

**Steps:**

- [ ] Add a durable orchestration test that sends oversized structured authority through `runStepWithContext`/`finishUnit`, instruments the clone boundary with a narrow test seam or observable value, and proves no oversized private structure is cloned before artifact publication.
- [ ] Assert the committed result contains `structuredOutputRef`, excludes the payload sentinel, and remains bounded.
- [ ] Add direct `getResultParentOutput()` tests for inline output, ref-only output, empty output, and the 2 KiB cap.
- [ ] Add Single, Parallel, and Chain terminal integration tests with `finalOutputRef`; each must show bounded run-artifact metadata, never `(no output)`, and never artifact content.
- [ ] Keep failure-result formatting unchanged.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/output.test.ts tests/memory-regression.test.ts)`
- Expected: clone ordering and all parent modes are covered.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/chain.test.ts tests/run-coordinator.test.ts tests/tool.test.ts tests/interactive-agent.test.ts tests/interactive-relay.test.ts tests/artifact-reader-extension.test.ts tests/output.test.ts tests/memory-regression.test.ts)`
- Expected: all Round 3 regressions pass.

- Run: `mise run test --package packages/pi-agents`
- Expected: complete package suite passes.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: persisted reader and relay epoch contracts type-check.

- Run: `mise run build --package packages/pi-agents`
- Expected: both package entries build.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both entries are packaged.

- Run: `hk check`
- Expected: ESLint and Prettier pass.

- Run: `git diff --check`
- Expected: no whitespace errors.

## Failure Behavior

| Failure                                    | Required behavior                                    |
| ------------------------------------------ | ---------------------------------------------------- |
| Restored fanout has child and collect refs | Collect ref is authoritative for `{previous}`.       |
| Reader requirement persistence fails       | Do not launch the child.                             |
| Endpoint is removed/recreated during spill | Suppress the old continuation.                       |
| Restored-state builder fails post-claim    | No durable/live side effect; unregister and abandon. |
| File identity is unavailable or differs    | `artifact_unavailable`; no content.                  |
| Parent result is ref-only                  | Bounded metadata in Single, Parallel, and Chain.     |

## Privacy and Security

- Child reader capability is persisted explicitly, not inferred from prompt content.
- Relay incarnation prevents stale sensitive continuation delivery after endpoint replacement.
- File identity must be proven; equal size is never sufficient.
- Artifact content remains absent from parent descriptors and durable presentation shells.

## Risks and Mitigations

- **Reader requirement persistence adds a pre-launch strict write.** — Await it and fail before spawn; monotonic true avoids downgrade races.
- **Registry incarnation grows for process lifetime.** — Use a safe integer counter and fail before overflow; practical endpoint counts remain far below the limit.
- **Resume preparation moves more work before running status.** — Keep values local and cover controlled failures with zero-side-effect assertions.

## Open Questions

**Open Questions:** None.
