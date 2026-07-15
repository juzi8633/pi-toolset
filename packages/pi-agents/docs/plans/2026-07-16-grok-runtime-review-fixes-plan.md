# Grok Runtime Review Fixes Implementation Plan

**Goal:** Finish the plain Grok runtime removal without allowing unsupported persisted runtimes to fall through to Pi, and repair the skipped-unit and completed-fanout continuation defects identified by the full local-change review.

**Inputs:** The original requirement to retain only `pi` and `grok-acp`, remove `allowReplay` and replay compatibility, preserve Grok ACP `session/load` resume, and the two independent reviewer reports from 2026-07-16.

**Assumptions:**

- Version 1 records using removed `runtime: "grok"` or replay capability do not require migration or compatibility; the durable store must reject them as invalid current records.
- A run containing skipped units is not fully completed: skipped units remain selective resume targets, while completed siblings stay completed.
- A fully completed run may reopen all completed units only when the resume request includes a non-empty continuation task.
- Completed fanout continuation must reuse the frozen item-to-unit mapping but dispatch every reopened child instead of reusing stale completed presentation results.

**Architecture:** Enforce the current runtime/capability contract at durable-record validation, then make resume preflight and chain restoration follow durable unit status as the authority. Completed-fanout continuation will validate frozen mappings before mutation, reopen units, and create queued presentation slots for reopened children. Run metadata and documentation will be aligned with the resulting behavior.

**Tech Stack:** TypeScript, Bun tests, TypeBox schemas, Pi extension APIs, Grok ACP, Mise, ESLint, Prettier.

---

## File Map

- Modify: `packages/pi-agents/src/run-store.ts` — reject unsupported persisted request and unit runtimes.
- Modify: `packages/pi-agents/src/run-types.ts` — reduce the persisted resume capability contract to session-only.
- Modify: `packages/pi-agents/src/types.ts` — align public result metadata with session-only resume.
- Modify: `packages/pi-agents/src/run-coordinator.ts` — remove replay/mixed aggregation and report completed runs as continuation-resumable.
- Modify: `packages/pi-agents/src/tool.ts` — remove legacy Grok ACP replay normalization branches.
- Modify: `packages/pi-agents/src/interactive-agent.ts` — remove replay-specific compatibility comments and checks while preserving ACP session validation.
- Modify: `packages/pi-agents/src/render.ts` — remove replay warning rendering.
- Modify: `packages/pi-agents/src/resume.ts` — preflight skipped units, reopen only truly all-completed runs, and validate completed fanout mappings before continuation.
- Modify: `packages/pi-agents/src/chain.ts` — prevent stale presentation results from masking reopened durable fanout units.
- Modify: `packages/pi-agents/docs/reference.md` — describe Agent View support for Pi and Grok ACP.
- Modify: `packages/pi-agents/README.md` — remove the stale Pi-only Agent View limitation.
- Test: `packages/pi-agents/tests/run-store.test.ts` — unsupported persisted runtime rejection.
- Test: `packages/pi-agents/tests/resume.test.ts` — skipped-unit preflight and completed-fanout mapping/dispatch behavior.
- Test: `packages/pi-agents/tests/chain.test.ts` or `packages/pi-agents/tests/resume.test.ts` — authoritative reopened fanout slot restoration.
- Test: `packages/pi-agents/tests/run-coordinator.test.ts` — session-only capability and completed-run resumability metadata.
- Test: `packages/pi-agents/tests/tool.test.ts`, `packages/pi-agents/tests/interactive-agent.test.ts`, and `packages/pi-agents/tests/interactive-execution.test.ts` — remove legacy replay fixtures while retaining ACP session/load coverage.
- Test: `packages/pi-agents/tests/grok-acp-invocation.test.ts` — focused coverage for `getGrokInvocation()`.

## Tasks

### Task 1: Enforce the Current Runtime and Capability Contract

**Outcome:** Persisted records accept only absent/`pi`/`grok-acp` runtimes, no replay capability remains in production or current tests, and the extracted Grok command helper has direct coverage.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/render.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/interactive-execution.test.ts`
- Test: `packages/pi-agents/tests/grok-acp-invocation.test.ts`

**Steps:**

- [x] Add a shared local runtime allowlist check in durable-record validation and reject both `request.runtime` and `unit.runtime` values other than `pi` or `grok-acp`; absent runtime remains the Pi default.
- [x] Add `run-store.test.ts` cases proving `runtime: "grok"` and an unknown runtime produce `corrupt_run` instead of reaching resume or execution.
- [x] Reduce `ResumeCapability` and aggregate capability metadata to session-only, then remove replay/mixed branches, normalization code, renderer warnings, comments, and obsolete fixtures.
- [x] Preserve ACP requirements: attempted `grok-acp` units still need a trimmed `acpSessionId`; never-started ACP units may create their first session.
- [x] Add a focused assertion in `grok-acp-invocation.test.ts` that `getGrokInvocation(args)` returns the configured Grok binary and the unchanged argument array.
- [x] Confirm `packages/pi-agents/src/grok-command.ts` remains tracked by the final change set and retains its two-line ABOUTME header.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/run-coordinator.test.ts packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/interactive-agent.test.ts packages/pi-agents/tests/interactive-execution.test.ts packages/pi-agents/tests/grok-acp-invocation.test.ts`
- Expected: Unsupported runtimes fail as corrupt records; all session-only and ACP tests pass with no replay fixtures.

### Task 2: Restore Skipped-Unit Resume Preflight

**Outcome:** Skipped units are selective resume targets and receive cwd, agent fingerprint, session, and worktree preflight; completed siblings are not reopened unless every unit is completed and a continuation was supplied.

**Files:**

- Modify: `packages/pi-agents/src/resume.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [x] Define incomplete resume targets as every unit whose status is not `completed`, including `skipped`.
- [x] Keep the `completed_without_continuation` result only for runs where every unit is completed.
- [x] Change completed-unit reopening to run only when every unit is truly `completed`; a completed-plus-skipped run must selectively queue only skipped units.
- [x] Add a preflight test where a skipped attempted unit with a missing session artifact is blocked.
- [x] Add a selective-resume test where a skipped never-started unit is queued without incrementing its attempt and a completed sibling remains completed.

**Validation:**

- Run: `bun test packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/tool.test.ts`
- Expected: Skipped units cannot bypass preflight, and selective resume does not reopen completed siblings.

### Task 3: Repair Completed Fanout Continuation

**Outcome:** Fully completed fanouts resume only from a valid frozen mapping, and all reopened fanout children execute the continuation rather than being skipped because of stale completed presentation slots.

**Files:**

- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [x] Extend fanout preflight with an explicit option for completed-run continuation so completed logical fanout steps must have a frozen `workflowState.fanouts` mapping and all mapped children/results pass existing canonical validation.
- [x] Invoke the stricter fanout validation only when an all-completed run is being reopened with a continuation; preserve current selective-resume behavior for earlier completed fanout steps.
- [x] In restored fanout slot construction, treat a durable unit record as authoritative: if the unit exists and is not completed, create a queued slot and do not fall back to a stale completed presentation result.
- [x] Preserve current behavior for selectively resumed fanouts: durable completed children retain their terminal results and only incomplete children dispatch.
- [x] Add a missing-mapping test for a fully completed fanout resumed with continuation and expect `stored_fanout_state_unavailable` before claim mutation.
- [x] Add an end-to-end restored-chain test that reopens a fully completed fanout, dispatches every child exactly once with the continuation context, and replaces stale presentation results with new terminal results.

**Validation:**

- Run: `bun test packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/tool.test.ts`
- Expected: Missing mappings fail closed; completed fanout continuation dispatches reopened children; selective fanout resume remains unchanged.

### Task 4: Align Resume Metadata and Agent View Documentation

**Outcome:** Result metadata states that completed runs can be resumed with a continuation task, and current docs consistently describe Pi and Grok ACP Agent View support.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`

**Steps:**

- [x] Make `aggregateRun().resumable` true for completed runs because the public API accepts a non-empty continuation task; retain true for failed/cancelled/interrupted runs with resumable units.
- [x] Add aggregate metadata tests for completed, interrupted, and non-resumable states.
- [x] Replace Pi-only Agent View claims with Pi and Grok ACP support, including ACP lazy history hydration through `session/load` and the existing no-cross-process limitation.
- [x] Keep plain Grok absent from all current usage documentation.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-coordinator.test.ts`
- Expected: Metadata tests pass and documentation contains no contradictory Pi-only/Grok-deferred statements.

### Task 5: Close Final Review Fail-Closed Gaps

**Outcome:** Current durable records cannot bypass session preflight through an invalid capability or conflicting runtime, completed fanout continuation validates mappings even when presentation metadata is missing, and resumed in-memory state cannot restore a stale terminal timestamp.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/explanation.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [x] Reject missing, replay, or unknown persisted `unit.capability` values as `corrupt_run`; validate any persisted result capability metadata as session-only when present.
- [x] Reject records whose explicit `request.runtime` conflicts with a unit's effective persisted runtime, so preflight and dispatch cannot apply different runtime rules.
- [x] When completed-fanout mappings are required, derive fanout steps from durable units as well as optional chain presentation metadata and fail closed on missing/corrupt mappings.
- [x] Clear `finishedAt` on both disk and the in-memory record before registering a resumed run.
- [x] Update fanout documentation to distinguish selective resume (completed children preserved) from fully completed continuation (all completed children reopened and redispatched).
- [x] Remove stale production comments that refer to replay gates or fresh/replay execution.
- [x] Add focused corrupt-record, runtime-consistency, durable-only fanout, and stale-`finishedAt` regression tests.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/tool.test.ts`
- Expected: Invalid capabilities and runtime conflicts fail closed, durable-only completed fanouts require mappings, and resumed records remain non-terminal in memory and on disk.

### Task 6: Make Fanout and Topology Restoration Canonical

**Outcome:** Fanout mappings form a complete canonical bijection with the requested fanout steps and durable children, restored chains always use frozen mappings even when presentation metadata is missing or shortened, and persisted unit agents match the request topology used for dispatch.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [x] Derive every fanout step, including empty fanouts, from `record.request.chain` when completed continuation requires frozen mappings.
- [x] Require each fanout mapping key to equal `chainFanoutStepId(mapping.step)` and require its unit IDs to form a complete canonical bijection with all durable children for that step/index; reject truncated, extra, duplicate, wrong-step, or missing mappings.
- [x] Build a complete restored logical-step array from the stored request topology, overlay trustworthy presentation state by step, and always attach frozen fanout mappings/units for chain resume even when `details.chain` is absent or shortened.
- [x] Reject persisted units whose `agent` does not match the single, parallel, sequential-chain, or fanout agent selected by the stored request topology, ensuring preflight and dispatch resolve the same agent/runtime.
- [x] Add focused tests for empty fanout missing mapping, wrong mapping key/step, truncated mapping, missing/short chain presentation restoration, and request/unit agent mismatch across applicable modes.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/tool.test.ts`
- Expected: Malformed topology and fanout records fail closed, while presentation-stale records with valid durable mappings restore and dispatch from the frozen expansion.

### Task 7: Run Full Validation and Independent Re-review

**Outcome:** The combined local state passes project checks and an independent reviewer finds no accidental removal of unrelated Pi, Grok ACP, persistence, chain, parallel, fanout, worktree, or interactive behavior.

**Files:**

- Review: all staged and unstaged changes under `packages/pi-agents`

**Steps:**

- [x] Format all modified package files.
- [x] Run package typecheck, all package tests, repository lint/format checks, package build, and `git diff --check`.
- [x] Search current source/tests/user documentation for `allowReplay`, plain `runtime: "grok"`, streaming-json parser/invocation imports, and replay capability metadata; allow only explicit negative assertions for rejected values and historical `docs/plans`/`docs/analysis` records.
- [x] Ask an independent reviewer to compare the final combined diff against HEAD and verify the previously reported findings are resolved without unrelated deletions.
- [x] Do not stage, commit, or overwrite unrelated local changes.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript passes.
- Run: `mise run test --package packages/pi-agents`
- Expected: Full package suite passes with zero failures.
- Run: `hk check`
- Expected: ESLint and Prettier pass.
- Run: `mise run build --package packages/pi-agents`
- Expected: Package bundles successfully.
- Run: `git diff --check`
- Expected: No whitespace errors.

### Task 8: Preserve Selective Chain State and Canonical Unit Identity

**Outcome:** Presentation-stale selective chain resume never redispatches completed sequential work, stable unit IDs—not object order or mutable position fields—select the durable session, and malformed alias fanout mappings fail closed.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/resume.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`

**Steps:**

- [x] When reconstructing logical steps without complete presentation metadata, derive completed/incomplete state from authoritative durable units and frozen fanout mappings; distinguish selective resume from all-completed continuation so completed sequential steps are skipped only in the former.
- [x] Add an end-to-end restored-chain test with absent `details.chain` proving a completed seed is not dispatched while the incomplete later step resumes.
- [x] Resolve single and parallel unit IDs from canonical topology IDs (`single`, `parallel-N`) rather than object-key order, and validate canonical IDs/step/fanoutIndex fields plus exact statically known unit coverage at record load.
- [x] Add corrupt-record tests for swapped parallel positions, swapped chain steps, noncanonical unit IDs, and missing/extra static units.
- [x] Validate every persisted fanout mapping key independently, including alias keys for a step already validated through its canonical key.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/tool.test.ts`
- Expected: Selective resume never reruns completed work, unit sessions cannot be cross-wired by ordering or mutable positions, and alias mappings are rejected.

### Task 9: Close Runtime and Empty-Fanout Crash Windows

**Outcome:** Resume preflight validates the same effective runtime dispatch will use, empty fanout mappings never masquerade as completed output after a crash, malformed/non-fanout mappings fail safely, and queued terminal work is reported resumable.

**Files:**

- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [x] During resume preflight, compute the effective dispatch runtime from stored request override or the current fingerprint-matched agent and require it to equal the durable unit runtime after Pi-default normalization.
- [x] Treat a frozen empty fanout mapping without completed presentation/output evidence as queued, because expansion persistence precedes empty-output persistence; safely rerun the zero-worker fanout to recreate its collected output.
- [x] Require every mapping step to correspond to an actual fanout request step and validate mapping object/array/step shapes without throwing on malformed persisted data.
- [x] Include queued units when computing resumability for terminal failed/cancelled/interrupted runs while keeping active running/queued runs non-resumable.
- [x] Add focused wrong-current-runtime, empty-fanout crash-window, malformed/non-fanout mapping, and queued-terminal metadata tests.

**Validation:**

- Run: `bun test packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/run-coordinator.test.ts packages/pi-agents/tests/tool.test.ts`
- Expected: Runtime mismatch and malformed mappings fail closed, empty fanout output is reconstructed, and queued terminal runs report resumable.

### Task 10: Align Foreground Terminal Metadata and Durable Previous Output

**Outcome:** Foreground terminal results compute resumability from the terminal status being stamped, and restored chains use authoritative completed unit results when presentation results lag.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [x] Ensure `stampRunOnDetails` passes or temporarily applies `finalStatus` before `aggregateRun` computes resumability, so failed/cancelled/interrupted results with queued siblings report `resumable: true` on the real foreground path.
- [x] During restored-chain previous-output reconstruction and completed-step skipping, fall back to the authoritative durable sequential unit result when `details.results` is missing or stale.
- [x] Rehydrate named completed sequential outputs from durable unit results when presentation outputs lag, preserving `text` and `structuredOutput` for later `{outputs.<name>}` and fanout expansion.
- [x] Add real foreground terminal metadata and durable-result/presentation-lag chain tests.

**Validation:**

- Run: `bun test packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/chain.test.ts`
- Expected: Terminal queued work reports resumable and later chain steps receive durable previous/named output without redispatching completed work.

### Task 11: Preserve Later Duplicate Named Outputs on Restore

**Outcome:** Durable rehydration of an earlier completed sequential step cannot overwrite a same-named output produced by a later step.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [x] When rehydrating a named sequential output, preserve an existing output whose recorded step is later; replace only missing, same-step stale, or earlier-step entries.
- [x] Add a selective-resume regression where an earlier sequential name and later fanout collect name collide, proving downstream `{outputs.<name>}` receives the later fanout value.

**Validation:**

- Run: `bun test packages/pi-agents/tests/chain.test.ts`
- Expected: Duplicate-name restore follows normal later-step-wins semantics and all chain tests pass.

### Task 12: Validate Presentation Resume Capability

**Outcome:** Persisted presentation results cannot expose replay capability metadata after unit and aggregate capability have become session-only.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [x] Validate every `details.results[*].resumeCapability` as `session` when present, rejecting replay, mixed, or unknown values as `corrupt_run`.
- [x] Add a regression proving canonical session units with replay presentation metadata do not load.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-store.test.ts`
- Expected: Invalid presentation capability is rejected and all run-store tests pass.

## Final Validation

- Run: `mise run typecheck --package packages/pi-agents && mise run test --package packages/pi-agents && hk check && mise run build --package packages/pi-agents && git diff --check`
- Expected: Every command succeeds, unsupported runtimes fail closed, skipped units receive preflight, completed fanout continuation dispatches correctly, and Grok ACP session/load resume remains covered.

## Rollout Notes

- No migration is provided for development-era plain Grok or replay-capability records; they are rejected as corrupt current records and must be replaced by fresh `grok-acp` runs.
- The new branch is `fix/remove-plain-grok-runtime`; changes remain unstaged and uncommitted unless explicitly requested.
- Historical material under `docs/plans/` and `docs/analysis/` may retain old terminology when it documents superseded designs.

## Risks and Mitigations

- Strict durable validation can make old development records unreadable — intentional per the no-compatibility requirement; tests assert explicit `corrupt_run` behavior.
- Reopened fanouts can accidentally rerun only some or no children — use durable unit status as the slot authority and cover both fully completed and selective resume cases.
- Including skipped units can reopen completed siblings unintentionally — require every unit to be completed before bulk reopening and test completed-plus-skipped state.
- Removing replay metadata can weaken stale-identity tests if fixtures are deleted indiscriminately — convert invariant tests to session-capable fixtures when the invariant is unrelated to replay, and delete only replay-specific compatibility cases.
