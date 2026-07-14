# Agent Run Persistence and Resume Implementation Plan

**Goal:** Persist every `@balaenis/pi-agents` workflow under `~/.pi/agent/@balaenis/pi-agents/runs/`, expose its status, and resume interrupted work without rerunning completed workflow units.

**Inputs:** Request to make one-shot subagent work trackable and resumable; required storage root `~/.pi/agent/@balaenis/pi-agents/runs/`; repository evidence from `src/types.ts`, `execution.ts`, `tool.ts`, `chain.ts`, `context.ts`, `invocation.ts`, `background.ts`, `worktree.ts`, `schema.ts`, `index.ts`, and existing tests; Pi session documentation for `--session`, `SessionManager`, and JSONL session persistence.

**Assumptions:**

- A run is one logical invocation of single, parallel, or chain mode. Resuming keeps the same run ID and records a new attempt only for units that execute again.
- The initial release retains run data indefinitely. Automatic retention, pruning, and destructive deletion commands are out of scope.
- `runtime: "pi"` supports session-level continuation through Pi's persisted JSONL session. `grok` and `grok-acp` initially support workflow-level replay from the interrupted unit's beginning, not exact conversation continuation.
- Completed units are immutable during resume. Failed, cancelled, interrupted, and skipped units may be scheduled again according to workflow dependencies.
- Stored prompts, transcripts, and outputs may contain sensitive data; run directories use mode `0700` and files use mode `0600` where the platform supports POSIX permissions.
- The public run root is fixed to `~/.pi/agent/@balaenis/pi-agents/runs/`. Tests inject a temporary root and never write to the real home directory.
- Resume uses the current installed agent definition but refuses to start when a stored agent fingerprint differs from the current definition. A force-resume override is out of scope.

**Architecture:** Add a durable `RunStore` that owns versioned run snapshots, lifecycle events, per-run locking, and Pi session paths beneath the required global directory. Wrap existing single/parallel/chain updates with a coordinator that persists status transitions and active results, then add an `agent_job` tool and `/agent runs|status|resume` commands for inspection and recovery. Chain and parallel workflows restore completed outputs and schedule only incomplete units; Pi units reopen their original session and worktree, while non-Pi runtimes require explicit replay acknowledgement.

**Tech Stack:** TypeScript, Bun tests, TypeBox, Node.js `fs`/`path`/`os`/`crypto`, Pi `SessionManager`, existing Pi CLI subprocess execution and extension APIs.

---

## Scope and Resume Semantics

### Included

- Durable status for foreground and background single, parallel, and chain runs.
- Stable run and execution-unit identities.
- Recovery after tool abort, session shutdown, or Pi process termination.
- Status listing and detail lookup from both the parent model and the user.
- Step-boundary recovery for parallel and chain workflows.
- Session-level continuation for `runtime: "pi"`.
- Reuse of retained worktrees when an incomplete unit resumes.
- Explicit attempt history and replay capability reporting.

### Out of Scope

- Resuming an operating-system process at an instruction boundary.
- Reattaching to a child process that is still running in another Pi process.
- Automatic retry policies.
- Automatic cleanup or retention limits.
- Exact session continuation for `grok` or `grok-acp` until those runtimes expose and test a durable resume API.
- Editing stored run parameters before resume.
- Resuming a run whose agent definition, session file, or retained worktree fails compatibility checks.

### Runtime Capability Contract

| Runtime    | Stored capability | Resume behavior                                                                                                                             |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi`       | `session`         | Reopen the unit's persisted Pi session, reuse its worktree/cwd, and send a continuation instruction.                                        |
| `grok`     | `replay`          | Re-run the incomplete unit from its original task prompt; require `allowReplay: true`.                                                      |
| `grok-acp` | `replay`          | Re-run the incomplete unit from its original task prompt; require `allowReplay: true` until durable ACP session restoration is implemented. |

A replay never presents itself as exact continuation. The status response must show the capability before the caller requests resume.

## Persistent Layout

Resolve the root with `path.join(os.homedir(), ".pi", "agent", "@balaenis", "pi-agents", "runs")`:

```text
~/.pi/agent/@balaenis/pi-agents/runs/
└── <run-id>/
    ├── run.json
    ├── events.jsonl
    ├── claims/
    │   └── <16-digit-ticket>/
    │       ├── owner.json
    │       └── terminal.json
    └── sessions/
        └── <pi-generated-session>.jsonl
```

- `run.json` is the versioned authoritative snapshot. Write it through a same-directory temporary file, `fsync`, and atomic rename.
- `events.jsonl` contains coarse lifecycle events only: run creation, claim, unit start, unit terminal state, interruption, resume, and run terminal state. Do not append token deltas.
- `claims/` implements an append-only ticket lock. Every claimant atomically publishes a unique, never-reused `<16-digit-ticket>/` directory whose `owner.json` contains `runId`, `claimId`, `instanceId`, `pid`, and `acquiredAt`. The lowest unterminated live ticket wins. Claims are never deleted or reused; one atomically published `terminal.json` records either `released` or `abandoned`.
- Files beneath `sessions/` are native Pi session files with Pi-generated names. `RunUnitRecord.sessionFile` is the authoritative unit-to-session mapping; do not rename native files or invent a second transcript format for Pi continuation.
- Unit IDs contain only lowercase ASCII letters, digits, and hyphens. Generate IDs internally from immutable workflow positions: `single`, `parallel-0001`, `chain-0001`, and `chain-0002-fanout-0003`.

## Version 1 Data Contract

Create an internal schema equivalent to:

```ts
type RunStatus = 'queued' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

type ResumeCapability = 'session' | 'replay';

interface AgentRunRecordV1 {
  version: 1;
  runId: string;
  mode: 'single' | 'parallel' | 'chain';
  status: RunStatus;
  request: StoredRunRequest;
  background: boolean;
  agentScope: AgentScope;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  owner?: {
    claimId: string;
    ticket: number;
    instanceId: string;
    pid: number;
    acquiredAt: number;
  };
  details: SubagentDetails;
  units: Record<string, RunUnitRecord>;
  workflowState?: {
    fanouts: Record<
      string,
      {
        step: number;
        items: unknown[];
        unitIds: string[];
      }
    >;
  };
  eventsFile: 'events.jsonl';
  lastError?: string;
}

interface RunUnitRecord {
  unitId: string;
  agent: string;
  agentFingerprint: string;
  runtime: Runtime;
  capability: ResumeCapability;
  status: ExecutionStatus | 'interrupted';
  step?: number;
  fanoutIndex?: number;
  attempt: number;
  attempts: RunUnitAttempt[];
  sessionFile?: string;
  effectiveCwd: string;
  worktreePath?: string;
  result?: SingleResult;
}

interface RunUnitAttempt {
  attempt: number;
  status: ExecutionStatus | 'interrupted';
  startedAt: number;
  finishedAt?: number;
  stopReason?: string;
  errorMessage?: string;
}
```

`StoredRunRequest` is a JSON-safe normalized copy of the selected single, parallel, or chain request, including effective model, thinking, runtime, cwd, isolation, and agent scope. It excludes `runInBackground` as an execution transport concern but stores `background: boolean` separately.

Use a deterministic SHA-256 fingerprint of every `AgentConfig` field that affects behavior: name, source, system prompt and mode, runtime, model, thinking, tools, excluded tools, skills, `noSkills`, `noContextFiles`, context mode, isolation, setup hook, completion check, max turns, and max subagent depth. Exclude only descriptive/provenance fields that do not alter execution (`description`, `filePath`, `localName`, and `packageName`). Sort object keys and set-like arrays before hashing.

## File Map

- Create: `packages/pi-agents/src/run-types.ts` — versioned persisted run, unit, attempt, lock, event, status, and resume-capability types.
- Create: `packages/pi-agents/src/run-store.ts` — path resolution, permissions, atomic snapshots, event appends, list/get/create/update, ticket-claim acquisition/release, dead-claim checks, and corrupt-record handling.
- Create: `packages/pi-agents/src/run-coordinator.ts` — active-run registry, stable unit IDs, agent fingerprints, persistence throttling, status derivation, interruption handling, and wrapper callbacks around existing workflows.
- Create: `packages/pi-agents/src/resume.ts` — resume preflight, compatibility checks, completed-unit restoration, Pi continuation prompts, replay acknowledgement, and resumed workflow dispatch.
- Create: `packages/pi-agents/src/job-schema.ts` — TypeBox schema for `agent_job` list/get/resume actions.
- Create: `packages/pi-agents/src/job-tool.ts` — model-facing status/list/resume tool implementation and compact textual results.
- Modify: `packages/pi-agents/src/types.ts` — add `interrupted`, run metadata, unit identity, attempt number, session path, and resume capability to delivery details without breaking older stored sessions.
- Modify: `packages/pi-agents/src/schema.ts` — keep invocation schema compatible while documenting that every launch returns a run ID.
- Modify: `packages/pi-agents/src/context.ts` — allocate native Pi sessions inside the run's `sessions/` directory for fresh and fork contexts.
- Modify: `packages/pi-agents/src/invocation.ts` — distinguish initial task prompts from resume continuation prompts while continuing to pass `--session`.
- Modify: `packages/pi-agents/src/execution.ts` — stamp run/unit/attempt metadata on snapshots and preserve terminal abort information for persistence.
- Modify: `packages/pi-agents/src/tool.ts` — create/claim runs, supply unit execution context, persist foreground updates, restore chain state, and retain incomplete worktrees.
- Modify: `packages/pi-agents/src/chain.ts` — accept restored results/outputs/logical steps and skip completed sequential/fanout units.
- Modify: `packages/pi-agents/src/background.ts` — use the durable run ID as the background job ID, persist terminal state, and classify shutdown as interruption.
- Modify: `packages/pi-agents/src/worktree.ts` — validate and reopen a stored worktree instead of always creating a new one.
- Modify: `packages/pi-agents/src/command.ts` — add `/agent runs`, `/agent status <run-id>`, and `/agent resume <run-id>`.
- Modify: `packages/pi-agents/src/index.ts` — construct the store/coordinator, register `agent_job`, reconcile abandoned runs safely, and release owned claims on shutdown.
- Modify: `packages/pi-agents/src/render.ts` — show run ID, interrupted state, resume capability, and resume availability.
- Modify: `packages/pi-agents/README.md` — document persistence, commands, tool usage, runtime differences, privacy, and storage location.
- Modify: `packages/pi-agents/docs/how-to.md` — add interruption and resume procedures.
- Modify: `packages/pi-agents/docs/reference.md` — document schemas, statuses, storage layout, and resume errors.
- Modify: `packages/pi-agents/docs/explanation.md` — explain session continuation versus replay and concurrency safety.
- Test: `packages/pi-agents/tests/run-store.test.ts` — storage root injection, permissions, atomic writes, event log, listing, corruption, and locks.
- Test: `packages/pi-agents/tests/run-coordinator.test.ts` — IDs, fingerprints, status transitions, throttled updates, attempts, and interruption.
- Test: `packages/pi-agents/tests/resume.test.ts` — preflight, session continuation, replay gating, worktree/session failures, and attempt history.
- Test: `packages/pi-agents/tests/job-tool.test.ts` — list/get/resume schema and tool output.
- Modify test: `packages/pi-agents/tests/context.test.ts` — native session allocation under the run directory for fresh and fork modes.
- Modify test: `packages/pi-agents/tests/invocation.test.ts` — initial and resume prompt argument construction.
- Modify test: `packages/pi-agents/tests/execution.test.ts` — persisted metadata and abort snapshots.
- Modify test: `packages/pi-agents/tests/chain.test.ts` — restored outputs, selective sequential resume, and selective fanout resume.
- Modify test: `packages/pi-agents/tests/tool.test.ts` — foreground persistence, worktree retention, and resumed dispatch.
- Modify test: `packages/pi-agents/tests/background.test.ts` — durable IDs and shutdown interruption.
- Modify test: `packages/pi-agents/tests/render.test.ts` — run ID and interrupted/resumable rendering.
- Modify test: `packages/pi-agents/tests/lifecycle.test.ts` — shutdown flush and owned-claim release.

## Tasks

Every new `.ts` file in the tasks below must begin with the required two-line `ABOUTME:` comment, including test files.

### Task 1: Implement the Versioned Run Store

**Outcome:** Run records can be created, atomically updated, listed, loaded, and exclusively claimed beneath the required global root without tests touching the user's real home directory.

**Files:**

- Create: `packages/pi-agents/src/run-types.ts`
- Create: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Start both new source files with the required two-line `ABOUTME:` header.
- [ ] Define the Version 1 types from this plan, `RUN_RECORD_VERSION = 1`, and typed lifecycle event variants.
- [ ] Implement `getDefaultRunsRoot()` with `os.homedir()` and the exact segments `.pi/agent/@balaenis/pi-agents/runs`.
- [ ] Implement `createRunStore({ rootDir?, now?, randomUUID?, pid?, instanceId? })` so tests inject all nondeterministic inputs.
- [ ] Create the root and per-run directories recursively with mode `0700`; after creation, best-effort `chmod` them to `0700` to correct permissive umasks.
- [ ] Generate run IDs as `run-${crypto.randomUUID()}` and reject caller-provided IDs containing path separators or characters outside `[a-zA-Z0-9-]`.
- [ ] Write `run.json` as UTF-8 JSON with a trailing newline and mode `0600`. Use `<runDir>/.run.json.<instanceId>.tmp`, flush the file handle, close it, rename it over `run.json`, and best-effort fsync the containing directory.
- [ ] Serialize writes per run with an in-process promise queue so overlapping streaming updates cannot rename older snapshots over newer ones.
- [ ] Append only lifecycle events to `events.jsonl`; include `version`, `event`, `runId`, `timestamp`, and event-specific data.
- [ ] Validate loaded records structurally: supported version, matching directory/run ID, recognized statuses, object-shaped details/units, and session/worktree paths represented as strings. Return a typed `corrupt_run` error instead of throwing raw `JSON.parse` errors through the tool.
- [ ] Implement `listRuns()` by reading immediate child directories, loading valid `run.json` files, sorting by `updatedAt` descending, and returning corrupt entries as diagnostics rather than hiding the rest.
- [ ] Create `claims/` with mode `0700`. Build each claim first in a unique hidden staging directory `.staging-<claim-id>/`, write and fsync its immutable `owner.json`, then publish the complete claim with one atomic rename to the exact target `claims/<16-digit-ticket>/`.
- [ ] Allocate tickets by scanning every published numeric directory, including those with terminal state `released` or `abandoned`, and selecting `maxTicket + 1`. Concurrent claimants therefore compete for the same target pathname; exactly one rename succeeds, while losers choose the next number, update and fsync their staged owner payload, and retry.
- [ ] Never delete or reuse a published numeric claim directory. Fixed-width decimal tickets preserve lexical order, terminal markers preserve the high-water mark, and hidden staging directories never participate in ownership election.
- [ ] Implement one `publishClaimTerminal(ticket, claimId, state)` helper. Write and fsync a unique same-directory staged file containing `{ claimId, state: "released" | "abandoned", timestamp }`, then publish it with `fs.link(stagedPath, terminalPath)`. The hard-link creation is atomic and no-clobber: `EEXIST` means another terminal state won, so read and validate that winner; never use replace-capable `rename()` for `terminal.json`. Unlink the staged name after success or `EEXIST`, then best-effort fsync the ticket directory.
- [ ] Implement `claimRun(runId)` by listing published claims after publishing its own ticket. Ignore a lower claim only when it has a complete, valid `terminal.json`. When a lower owner PID is confirmed dead, publish `state: "abandoned"`; a malformed owner or terminal returns `claim_corrupt` and blocks automatic resume.
- [ ] If any lower live claim remains, publish `state: "released"` for the caller's own unused claim and return `run_active`. Once a claimant has the lowest eligible ticket, persist its `claimId` and ticket in `run.json` before workflow execution. Higher concurrent claimants observe that lower ticket and withdraw; future claims always receive a larger ticket and cannot outrank it.
- [ ] Implement `releaseRun(runId, claimId)` by resolving the exact ticket directory recorded by the caller, verifying its immutable owner payload, and publishing `state: "released"` through `publishClaimTerminal`. Never rename, unlink, or replace a published numeric claim path.
- [ ] Clean only abandoned hidden staging directories and staged terminal files as best-effort housekeeping. Published claim and terminal directories remain as the durable ticket high-water mark; report malformed claims or conflicting terminal states as diagnostics.
- [ ] Add deterministic interleaving tests for the exact default path, injected temporary root, directory/file modes on POSIX, atomic snapshot replacement, serialized competing updates, event order, list sorting, unsupported version, malformed JSON, atomic publication of fully written owner and terminal data, same-ticket contention with exactly one successful directory publish, `fs.link` no-clobber release-versus-abandon contention, monotonically increasing tickets across terminal claims, dead lower-claim termination, malformed published claim refusal, abandoned staging cleanup, claimant withdrawal, foreign claim release refusal, and proof that release cannot alter any later claim.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: All store tests pass using temporary directories; no test creates or modifies `~/.pi/agent/@balaenis/pi-agents/runs/`.

### Task 2: Add Run and Unit Metadata to Existing Results

**Outcome:** Every emitted snapshot identifies its durable run, execution unit, attempt, status, and resume capability while older session details remain renderable.

**Files:**

- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Create: `packages/pi-agents/src/run-coordinator.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify test: `packages/pi-agents/tests/execution.test.ts`

**Steps:**

- [ ] Extend `ExecutionStatus` with `interrupted`; preserve renderer fallbacks for older details where `status` is absent.
- [ ] Add optional `runId`, `unitId`, `attempt`, `sessionFile`, and `resumeCapability` fields to `SingleResult` so old serialized results remain compatible.
- [ ] Add optional `run` metadata to `SubagentDetails` containing `runId`, durable status, `resumable`, and aggregate capability (`session`, `replay`, or `mixed`).
- [ ] Define `UnitExecutionContext` in `run-coordinator.ts` and pass it into `runSingleAgent()` rather than adding separate positional parameters.
- [ ] Generate deterministic unit IDs from immutable workflow position. Assert uniqueness before execution and fail run creation with `duplicate_unit_id` if a future workflow shape produces a collision.
- [ ] Implement canonical agent serialization and SHA-256 fingerprinting over the behavior-affecting fields named in the Version 1 contract.
- [ ] Stamp every running and terminal snapshot with the same `runId`, `unitId`, current `attempt`, session path, and capability.
- [ ] Implement run status derivation: any active unit means `running`; all completed means `completed`; an interrupted unit makes the run `interrupted`; otherwise terminal failures produce `failed`; explicit user cancellation produces `cancelled`.
- [ ] Preserve each terminal attempt summary before incrementing `attempt` on resume. Never overwrite the previous attempt's timestamps, stop reason, or error.
- [ ] Add a persistence wrapper around `onUpdate` that forwards every UI update immediately but coalesces `run.json` writes to at most one every 250 ms. Flush immediately on unit start, every terminal transition, run interruption, and run completion.
- [ ] Test stable IDs for all modes, fingerprint determinism and sensitivity for every behavior-affecting `AgentConfig` field, metadata propagation through clones, status derivation, attempt history, coalescing with a fake clock, and mandatory terminal flush.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/execution.test.ts`
- Expected: Metadata and state-transition tests pass, including abort snapshots with durable identity.

### Task 3: Persist New Foreground and Background Runs

**Outcome:** Every validated invocation creates its durable record before child execution starts, keeps it current during streaming, and terminates its ownership claim only after the terminal snapshot is durable.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/background.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Modify test: `packages/pi-agents/tests/tool.test.ts`
- Modify test: `packages/pi-agents/tests/background.test.ts`
- Modify test: `packages/pi-agents/tests/lifecycle.test.ts`

**Steps:**

- [ ] Instantiate one `RunStore` and `RunCoordinator` in `index.ts` and inject them into foreground tool execution and the background manager.
- [ ] Create the run only after mode validation, delegation-depth authorization, and agent discovery succeed; invalid calls that never launch a workflow do not create run directories. Do not add a new project/package trust policy as part of persistence.
- [ ] Normalize the request, store whether it was launched in background mode, and resolve effective runtime/model/thinking/isolation before writing the initial `queued` snapshot.
- [ ] Claim the run, write `run_created` and `run_claimed`, transition it to `running`, then spawn the first child. If persistence fails, return `run_store_error` and do not spawn a child that cannot be tracked.
- [ ] From the moment a claim is published, guard the launch path with `try/finally`; every exit before child spawn and every workflow-settlement path must publish that claim's terminal state even when snapshot/event persistence fails. Report the persistence error separately and never leave a live extension process holding an unterminated claim.
- [ ] Wrap existing workflow `onUpdate` callbacks with the coordinator's persistence callback while preserving current TUI streaming behavior.
- [ ] On normal completion or failure, flush the terminal `run.json`, append the terminal event, then atomically publish `terminal.json` with state `released` for the coordinator's unique ticket claim.
- [ ] Define `RunAbortOrigin = "user" | "session_shutdown" | "owner_process_missing" | "unknown"` and carry it in `AgentAbortError` and lifecycle events.
- [ ] Give every active run a coordinator-owned `AbortController` plus a mutable abort-origin field. Forward the tool's incoming abort signal as `user`; make `session_shutdown` set `session_shutdown` before aborting. Do not let foreground and background paths construct unreasoned aborts.
- [ ] Define origin precedence so `session_shutdown` overrides a previously observed `user` abort while shutdown is draining. Keep the run registered until the awaited shutdown flush completes, allowing the shutdown handler to reclassify an already-produced cancellation snapshot before lock release.
- [ ] On `AgentAbortError`, persist the final carried origin: `user` becomes `cancelled`; `session_shutdown` and `owner_process_missing` become `interrupted`; `unknown` becomes `interrupted` with a diagnostic rather than being mislabeled as user cancellation.
- [ ] Allocate the run ID before background launch and use it as the existing background `jobId`, eliminating separate identities for the same work.
- [ ] Change background shutdown handling from unconditional cancellation to interruption through the coordinator-owned controller: abort children with `session_shutdown`, flush their latest snapshots as `interrupted`, send a non-triggering interruption notification if the host can still deliver it, and atomically publish terminal markers for owned claims.
- [ ] Make the existing `session_shutdown` listener async and await interruption, snapshot flush, child cancellation, and owned-claim tombstoning. Rely on Pi's documented graceful shutdown event for Ctrl+C, Ctrl+D, SIGHUP, and SIGTERM; do not add process-global `beforeExit` or `exit` listeners.
- [ ] Add tests proving a run exists before the fake child starts, updates are persisted, terminal state precedes claim termination, pre-spawn and terminal persistence failures still terminate the claim, persistence failure prevents spawn, foreground user abort records `cancelled`, foreground/background shutdown records `interrupted`, unknown abort origins are not mislabeled, background job ID equals run ID, and awaited shutdown records interruption.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/tool.test.ts tests/background.test.ts tests/lifecycle.test.ts`
- Expected: Foreground and background persistence tests pass without regressing existing dispatch and notification behavior.

### Task 4: Allocate Native Pi Sessions in the Run Directory

**Outcome:** Every Pi execution unit has a native JSONL session beneath its run directory, and an interrupted Pi unit can reopen that exact session.

**Files:**

- Modify: `packages/pi-agents/src/context.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify test: `packages/pi-agents/tests/context.test.ts`
- Modify test: `packages/pi-agents/tests/invocation.test.ts`
- Modify test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Change context preparation to accept `effectiveCwd`, `runId`, `unitId`, and the coordinator-provided session directory.
- [ ] Select/create the worktree before creating the Pi session so the session header cwd matches the actual child cwd.
- [ ] For `defaultContext: "fresh"`, create a persisted native session with `SessionManager.create(effectiveCwd, runSessionsDir)` and record its resulting `getSessionFile()` path.
- [ ] For `defaultContext: "fork"`, open the parent session with the run session directory override and create a branch from the captured parent leaf. Verify the resulting file lives beneath `<runDir>/sessions/`; fail with `context_error` before spawn if Pi creates it elsewhere or the branch file is missing.
- [ ] Retain Pi's generated session basename and persist the exact `getSessionFile()` path in the unit record. Do not rename or copy the native JSONL file after `SessionManager` creates it.
- [ ] Keep Grok-family units sessionless and assign `resumeCapability: "replay"`.
- [ ] Extend invocation options with `promptKind: "initial" | "resume"`. Initial execution sends `Task: <original task>`; resume sends a fixed continuation instruction that tells the agent to inspect filesystem/git state, treat any unfinished tool call as unconfirmed, continue the original task, and run validation before completion.
- [ ] Continue passing `--session <stored path>` for both initial and resumed Pi execution. Never fall back to `--no-session` for a tracked Pi run.
- [ ] Add tests that fresh and fork sessions are real files under an injected `<runDir>/sessions`, session headers use the effective cwd, fork context contains the expected parent branch, initial arguments contain the original task once, and resume arguments reuse the same session without resending the original task as a new task.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/context.test.ts tests/invocation.test.ts tests/tool.test.ts`
- Expected: Native Pi session allocation and invocation tests pass for fresh, fork, worktree, and resume cases.

### Task 5: Preserve and Reopen Incomplete Worktrees

**Outcome:** An interrupted or failed isolated unit retains its original filesystem state, and resume never silently substitutes a fresh worktree.

**Files:**

- Modify: `packages/pi-agents/src/worktree.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify test: `packages/pi-agents/tests/tool.test.ts`
- Modify test: `packages/pi-agents/tests/resume.test.ts`

**Steps:**

- [ ] Add `openAgentWorktree(repoRoot, storedPath)` that resolves both paths, verifies the candidate remains beneath `<repo>/.worktrees/`, verifies it is a registered worktree using `git worktree list --porcelain`, and returns a typed error rather than creating a replacement.
- [ ] Stamp worktree path and dirty/diff metadata onto abort results before rethrowing `AgentAbortError` so the coordinator can persist them.
- [ ] Change cleanup policy: remove clean worktrees only for `completed` units. Retain clean or dirty worktrees for `failed`, `cancelled`, and `interrupted` units because their Pi session cwd must remain valid for resume.
- [ ] On resume, reopen the stored worktree and use it as `effectiveCwd`; do not rerun `worktreeSetupHook`, because the hook belongs to initial creation and may be destructive or expensive.
- [ ] If the stored path is missing, outside the expected root, no longer registered, or belongs to a different repository, return `worktree_unavailable`, leave the run unchanged, and do not spawn the agent.
- [ ] After a resumed unit completes, apply the existing dirty-worktree reporting and clean-worktree cleanup behavior.
- [ ] Test interrupted clean retention, interrupted dirty retention, successful reopen, missing and unregistered rejection, setup-hook non-repetition, and completed clean cleanup.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/tool.test.ts tests/resume.test.ts`
- Expected: Worktree tests prove resume uses the original path and never recreates missing state.

### Task 6: Restore Chain and Parallel Workflow State

**Outcome:** Resume skips completed execution units, reconstructs named outputs and fanout inputs, and schedules only units that did not complete successfully.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify test: `packages/pi-agents/tests/chain.test.ts`
- Modify test: `packages/pi-agents/tests/resume.test.ts`

**Steps:**

- [ ] Extend `RunChainWorkflowOptions` with an optional restored state containing cloned `results`, named `outputs`, logical chain steps, and persisted unit records.
- [ ] Validate restored state against the immutable stored request: same mode, same step count/kinds, expected unit IDs, and no completed result missing its required named output or structured output.
- [ ] Initialize `results`, `outputs`, `previousOutput`, and logical step statuses from restored state instead of empty containers.
- [ ] For a completed sequential step, do not call `runStep`; restore its final/structured output and continue template substitution for later steps.
- [ ] For an interrupted/failed/cancelled sequential step, create the next attempt and execute it. Reset later `skipped` logical steps to `queued` only after resume preflight succeeds.
- [ ] For fanout, write the originally expanded item array and ordered item-to-unit mapping to `AgentRunRecordV1.workflowState.fanouts[unitStepId]` before scheduling any item. Do not re-expand from mutable current output during resume.
- [ ] Skip completed fanout units, retry only incomplete fanout units under the requested concurrency limit, and collect results in original item order.
- [ ] If any required completed output is absent or fails the stored output schema on reload, reject resume with `stored_output_invalid` rather than rerunning an upstream completed unit silently.
- [ ] For parallel mode, skip completed tasks and retry incomplete tasks; preserve original result ordering and aggregate usage from the latest successful attempt per unit.
- [ ] For single mode, retry the sole incomplete unit and reject resume when it is already completed.
- [ ] Add chain tests for completed-prefix skipping, named-output restoration, `{previous}` restoration, retrying the interrupted middle step, selective fanout retry, original fanout ordering, missing-output rejection, and all-completed no-op rejection.
- [ ] Add parallel tests for selective retry, stable ordering, and mixed `session`/`replay` capability.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/chain.test.ts tests/resume.test.ts`
- Expected: Call-count assertions prove completed units never execute again and all restored outputs remain available downstream.

### Task 7: Implement Resume Preflight and Runtime Dispatch

**Outcome:** A resumable run is safely claimed, checked for configuration and artifact compatibility, and continued according to its declared runtime capability.

**Files:**

- Create: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`

**Steps:**

- [ ] Implement `inspectResume(runId)` returning current status, incomplete units, capability per unit, replay requirement, and blocking reasons without mutating the run.
- [ ] Reject resume for `completed` runs, unknown/corrupt records, unsupported schema versions, or runs with no incomplete units.
- [ ] Rediscover agents with the stored `agentScope`, require every incomplete unit's agent to exist, and compare the stored fingerprint with the current effective configuration.
- [ ] Re-run the same delegation-depth and discovery checks used by a new invocation. Persistence must not silently broaden agent scope. Project/package trust policy changes are out of scope; if a shared trust gate is added separately, both initial launch and resume must call it.
- [ ] Verify stored cwd, Pi session file, and worktree artifacts before changing the run from its current state.
- [ ] Require `allowReplay: true` when any scheduled unit has `resumeCapability: "replay"`; otherwise return a non-mutating response that names those units and warns that their task starts again from the beginning.
- [ ] Only after every read-only preflight and acknowledgement succeeds, acquire the lowest eligible ticket claim. If another live process owns a lower claim, terminate the new unused claim as `released`, return `run_active`, and do not signal or attach to that process.
- [ ] Guard all post-claim work with `try/finally`. On any failure before or during resumed execution, persist the best available run error when possible and always publish the owned claim's terminal state; claim cleanup must not depend on successful `run.json` or event writes.
- [ ] For Pi units, call the existing execution path with the stored session path, original effective options, retained worktree/cwd, and `promptKind: "resume"`.
- [ ] For replay units, call the existing execution path with the original task, incremented attempt, retained worktree/cwd when present, and no fabricated prior message history.
- [ ] Append `run_resumed` only after all preflight checks pass, then transition selected units to `queued` and the run to `running` in one atomic snapshot.
- [ ] On a second interruption, preserve both prior attempt summaries and leave the latest attempt resumable.
- [ ] Add tests for every rejection path, proof that read-only preflight failures create no claim or state change, post-claim failure cleanup, delegation-depth revalidation, fingerprint mismatch, replay acknowledgement, Pi session reuse, no fabricated Grok context, attempt increment, and repeated interruption.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/resume.test.ts`
- Expected: Resume tests pass and every failed preflight leaves `run.json`, attempts, and event history unchanged except for read diagnostics.

### Task 8: Add `agent_job` and User Commands

**Outcome:** The parent model and user can list durable runs, inspect detailed status, and request a safe resume.

**Files:**

- Create: `packages/pi-agents/src/job-schema.ts`
- Create: `packages/pi-agents/src/job-tool.ts`
- Modify: `packages/pi-agents/src/command.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/job-tool.test.ts`

**Steps:**

- [ ] Start both new source files with the required two-line `ABOUTME:` header.
- [ ] Define an `agent_job` TypeBox union with exactly these actions, using `StringEnum` from `@earendil-works/pi-ai` for Google-compatible string enums:

  ```ts
  { action: 'list'; status?: RunStatus; limit?: number }
  { action: 'get'; runId: string }
  { action: 'resume'; runId: string; allowReplay?: boolean }
  ```

- [ ] Clamp `limit` to `1..100`, default it to `20`, and reject unknown status values through schema validation.
- [ ] Register `agent_job` in `index.ts` with a description that tells the model to inspect a run before replay and to set `allowReplay` only after accepting duplicate-side-effect risk.
- [ ] Make list output include run ID, mode, status, updated time, completed/total unit counts, and aggregate capability. Do not include full prompts or transcripts in list output.
- [ ] Make get output include original task preview, per-unit status/attempt/runtime/capability, blocking artifacts, worktree path when retained, and last error. Keep full `AgentRunRecordV1` in tool details for rendering, not in model-visible text.
- [ ] Apply the existing 50 KB/2000-line tool-output limits to model-visible list/get/resume text and state clearly when output is truncated; never truncate the persisted record.
- [ ] Make resume delegate to `resume.ts` and stream the resumed workflow through the existing renderer-compatible result shape.
- [ ] Extend `/agent` with `/agent runs`, `/agent status <run-id>`, and `/agent resume <run-id>`. For replay-only runs, the command asks for UI confirmation before invoking resume with replay allowed.
- [ ] Ensure `/agent:<name>` remains unchanged and command parsing distinguishes agent names from the new reserved subcommands.
- [ ] Add tests for schema validation, status filtering, limits, compact/redacted list output, detail output, unknown/corrupt run errors, session resume, replay refusal, and command routing.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/job-tool.test.ts`
- Expected: Tool and command tests pass; list responses do not expose complete stored prompts or transcripts.

### Task 9: Reconcile Interrupted Runs and Render Resume State

**Outcome:** Runs abandoned by a dead process become visibly interrupted without stealing work from another live Pi process, and all tool views expose recovery information.

**Files:**

- Modify: `packages/pi-agents/src/index.ts`
- Modify: `packages/pi-agents/src/render.ts`
- Modify test: `packages/pi-agents/tests/render.test.ts`
- Modify test: `packages/pi-agents/tests/lifecycle.test.ts`

**Steps:**

- [ ] Register an async `session_start` handler that inspects records whose durable status is `running` or `queued`. Do not start reconciliation timers or other long-lived resources directly from the extension factory.
- [ ] If the lowest eligible ticket claim belongs to a live PID, leave the run untouched because another Pi process may own it.
- [ ] If the lowest unterminated claim has a confirmed-dead owner PID, atomically publish its terminal state as `abandoned`, then acquire a new lowest eligible ticket before modifying `run.json`. Only the process that wins that successor claim may mark running units/the run `interrupted` and append `run_interrupted`; a losing reconciler leaves state mutation to the winner.
- [ ] After the interrupted snapshot and event are durable, publish the reconciliation successor's terminal state as `released`. Put this release in `finally`; if state persistence fails, record/report the failure but still terminate the reconciliation claim so a live extension process cannot block later resume attempts.
- [ ] Treat inaccessible lock files and permission errors as diagnostics; do not rewrite the associated run.
- [ ] Extend collapsed result rendering with a short `run:<suffix>` label and an interrupted glyph consistent with `docs/draft/render.md` conventions.
- [ ] In expanded rendering, show full run ID, durable status, attempt, capability, session/worktree artifact availability, and a concrete `agent_job({ action: "resume", ... })` hint.
- [ ] Render replay capability with a warning that the incomplete task restarts and may repeat external side effects.
- [ ] Stop spinner state for interrupted units and ensure aggregate counts treat `interrupted` as terminal-but-resumable rather than running.
- [ ] Add tests for live-owner preservation, dead-owner reconciliation, successor-claim release after both successful and failed reconciliation persistence, an interleaving where resume wins the successor claim and the losing reconciler never mutates `run.json`, permission diagnostics, collapsed run ID, expanded resume hint, interrupted count/glyph, and replay warning.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/render.test.ts tests/lifecycle.test.ts`
- Expected: Reconciliation and rendering tests pass without modifying records owned by a simulated live PID.

### Task 10: Document Storage, Status, and Recovery

**Outcome:** Users understand where data is stored, how to inspect/resume runs, what each runtime guarantees, and the privacy/disk-growth implications.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/how-to.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`

**Steps:**

- [ ] Add persistent/resumable runs to the README feature list and replace the statement that every invocation is merely an isolated one-shot process.
- [ ] Document the exact storage root `~/.pi/agent/@balaenis/pi-agents/runs/` and the per-run layout.
- [ ] Add model-facing examples for `agent_job` list, get, Pi resume, and replay resume with `allowReplay: true`.
- [ ] Add user-facing examples for `/agent runs`, `/agent status <run-id>`, and `/agent resume <run-id>`.
- [ ] Explain statuses, especially the distinction between `cancelled` and `interrupted`, and state which ones are resumable.
- [ ] Explain that Pi resume continues a persisted session but cannot resume a currently executing OS process or assume an interrupted tool call completed.
- [ ] Explain that Grok-family replay can duplicate edits, commands, network writes, or other side effects and therefore requires explicit acknowledgement.
- [ ] Document worktree retention and the exact failures produced when a session/worktree is missing or an agent fingerprint changed.
- [ ] Add privacy guidance: run records contain prompts, transcripts, outputs, cwd paths, and possibly sensitive tool results; users must protect and manually remove them according to their own retention policy.
- [ ] State that Version 1 performs no automatic pruning and that manual deletion must target a complete `<run-id>/` directory only when that run is not active.

**Validation:**

- Run: `bunx prettier --check packages/pi-agents/README.md packages/pi-agents/docs/how-to.md packages/pi-agents/docs/reference.md packages/pi-agents/docs/explanation.md packages/pi-agents/docs/plans/2026-07-13-agent-run-resume-plan.md`
- Expected: Markdown formatting passes and all documented names/paths match the implementation plan.

### Task 11: Full Package Validation and Manual Recovery Drill

**Outcome:** Persistence and resume behavior is type-safe, tested, buildable, and verified against a real interrupted Pi subagent.

**Files:**

- Modify: all files touched by Tasks 1-10

**Steps:**

- [ ] Run all package tests and confirm temporary test roots are cleaned up.
- [ ] Run package typecheck and build.
- [ ] Run repository lint/format validation.
- [ ] Build the extension and launch Pi with `pi -e ./packages/pi-agents/dist/index.js`.
- [ ] Start a Pi-runtime worker that makes an observable file change and then runs a long command. Record the returned run ID.
- [ ] Interrupt the parent tool call, run `/agent status <run-id>`, and verify the unit is cancelled/interrupted, its session exists under the required global run root, and its worktree or cwd change remains present.
- [ ] Run `/agent resume <run-id>` and verify the same session and worktree paths are used, the attempt increments, completed work is not repeated, and final validation succeeds.
- [ ] Start a two-step chain, interrupt the second step, resume it, and verify the first step is not invoked again while its named output is restored.
- [ ] Start a parallel run, interrupt after one unit completes, resume it, and verify only incomplete units start new attempts.
- [ ] Start a replay-capability runtime, verify resume is refused without acknowledgement, then explicitly allow replay and verify the UI/tool output labels it as replay.
- [ ] Simulate process death by terminating Pi after a run starts, restart Pi, and verify dead-owner reconciliation marks the run interrupted and permits resume.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: All `pi-agents` tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: The package builds successfully and emits the updated extension and tool code.
- Run: `hk check`
- Expected: ESLint and Prettier checks pass repository-wide.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: Store, coordinator, resume, job tool, execution, chain, background, render, lifecycle, and existing regression tests all pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Persisted schemas, TypeBox tool parameters, and injected test seams have no TypeScript errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: `packages/pi-agents/dist/` builds successfully with both `agent` and `agent_job` registered.
- Run: `hk check`
- Expected: Repository lint and formatting pass.
- Inspect: `~/.pi/agent/@balaenis/pi-agents/runs/<manual-run-id>/run.json`
- Expected: Version 1 record has the correct run status, stable units, attempt history, native session path, and retained worktree metadata; the completed owner's ticket has a valid `terminal.json` with state `released`.

## Rollout Notes

- This is an additive persistence feature, but it changes every successful launch by writing sensitive state to disk. Documentation must call out the behavior before release.
- Existing historical tool results have no run ID and cannot be resumed. Renderers continue to display them using optional-field fallbacks.
- Version 1 run records are read-only when their `version` is unsupported. Future versions must add explicit migration code rather than silently coercing old data.
- No automatic cleanup ships initially. Disk usage will grow with transcripts and native sessions until a separately designed retention policy is implemented.
- Multiple Pi processes may share the run root. Exclusive per-run locks prevent duplicate resume; list/get remain read-only and available concurrently.
- A package upgrade that changes an agent's behavior fingerprint blocks existing incomplete runs. The user receives a precise mismatch error instead of an unsafe continuation under different instructions or tools.
- Background session shutdown now produces `interrupted` rather than permanently `cancelled` work so a later Pi process can resume it.

## Risks and Mitigations

- Sensitive prompts and tool results are persisted globally. — Create private directories/files, avoid full transcripts in list output, and document the exact data and retention implications.
- High-frequency streaming updates cause excessive disk writes. — Forward UI updates immediately but throttle snapshot persistence to 250 ms, with synchronous ordering and mandatory terminal flushes.
- A crash occurs between a child-side session write and `run.json` update. — Treat the native Pi session as conversation authority; reconciliation marks the unit interrupted and resume reopens the session even if the display snapshot lags slightly.
- A crash occurs during `run.json` replacement. — Write, fsync, and atomically rename a same-directory temporary file; ignore and report leftover temp files during listing.
- Two Pi processes resume the same run. — Publish claims by atomically competing for a numeric ticket path; only the lowest unterminated live ticket executes, terminal markers are atomically published, and reconciliation must win a successor claim before mutating run state.
- PID reuse makes a stale lock appear live. — Include instance and acquisition metadata, never reclaim a recently created live-PID lock, and surface the lock for manual inspection rather than risking duplicate execution.
- Completed chain work is accidentally repeated. — Restore immutable completed unit records and assert via call-count tests that `runStep` is not invoked for them.
- Fanout inputs change between interruption and resume. — Persist the original expanded item array and unit mapping; never recompute fanout from mutable current data.
- Pi session and filesystem state diverge. — Create sessions after effective cwd/worktree selection, retain all incomplete worktrees, and reject resume when the stored cwd artifact is unavailable.
- An interrupted tool call had external side effects before its result was saved. — The Pi continuation prompt treats unfinished calls as unconfirmed; replay runtimes require explicit acknowledgement and display duplicate-side-effect warnings.
- Agent configuration changes between attempts. — Persist a deterministic behavior fingerprint and refuse resume on mismatch.
- Corrupt or future-version records break all run listing. — Isolate errors per run, return diagnostics for corrupt entries, and continue listing valid records.
