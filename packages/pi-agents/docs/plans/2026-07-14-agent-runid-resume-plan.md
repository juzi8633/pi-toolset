# Agent `runId` Resume Consolidation Implementation Plan

**Goal:** Remove the model-facing `agent_job` tool and make `agent({ runId, task?, allowReplay? })` the single model-facing entry point for resuming a durable run from its stored workflow and sessions.

**Inputs:** Request to remove `agent_job` from `packages/pi-agents/src/index.ts`, add `runId` to the `agent` tool, reopen the existing run sessions when `runId` is supplied, allow a new `task` prompt to be appended while retaining all other stored settings, and preserve explicit replay acknowledgement for Grok runtimes; repository evidence from `src/index.ts`, `schema.ts`, `tool.ts`, `resume.ts`, `run-types.ts`, `execution.ts`, `pi-rpc-execution.ts`, `invocation.ts`, `context.ts`, `command.ts`, `render.ts`, package documentation, and existing durable-run tests.

**Assumptions:**

- A call without `runId` retains the current fresh single, parallel, and chain behavior.
- A call with `runId` uses the stored request as the source of truth for mode, agents, task topology, scope, cwd, isolation, model, thinking, runtime, titles, and background behavior. The caller may supply only `task` as an additional continuation instruction and `allowReplay` as the replay safety acknowledgement; conflicting fresh-run fields are rejected rather than silently ignored.
- A non-empty continuation `task` applies uniformly to every incomplete execution unit. Completed units and their stored results remain immutable.
- Continuation instructions are recorded on the durable run so a replay-capable or never-started unit does not lose an earlier appended instruction after another interruption. This metadata is optional for backward compatibility with existing Version 1 records.
- Pi units that already own a session receive the standard resume instruction plus only the newly supplied continuation task. Pi units that never started, and Grok/Grok ACP replay units, receive their resolved original task followed by all recorded continuation instructions.
- Historical plans and analysis documents remain unchanged even when they describe the former `agent_job` design; current README, how-to, and reference documentation are updated.

**Architecture:** Resolve a public `runId` at the beginning of `executeAgentTool`, hydrate an effective workflow request from `run.json`, and carry a small resume descriptor through the existing durable-run and workflow paths. Keep `inspectResume`, claims, attempt increments, completed-unit restoration, worktree reopening, and session reuse unchanged. Centralize prompt composition so JSON Pi execution and TUI RPC execution use identical continuation semantics, while replay runtimes receive the accumulated task text from a fresh process.

**Tech Stack:** TypeScript, TypeBox, Pi extension APIs, Pi CLI/RPC session execution, durable JSON run records, Bun tests, `mise`, `hk`.

---

## Scope and Behavior Contract

### Public `agent` Calls

Fresh launch remains unchanged:

```ts
agent({ agent: 'general', task: 'Implement the change' });
agent({ tasks: [{ agent: 'explore', task: 'Inspect the code' }] });
agent({ chain: [{ agent: 'explore', task: 'Inspect' }] });
```

Resume uses the stored workflow and optionally appends a prompt:

```ts
agent({ runId: 'run-abc123' });
agent({ runId: 'run-abc123', task: 'Also verify the migration path.' });
agent({ runId: 'run-abc123', task: 'Retry safely.', allowReplay: true });
```

When `runId` is present, reject `agent`, `tasks`, `chain`, `agentScope`, `cwd`, `isolation`, `runInBackground`, `model`, `thinking`, `runtime`, and `title`. Their effective values come from the stored run, including `record.background` for background delivery. Return one concrete `resume_error` naming the conflicting fields.

### Prompt Delivery

Use a stable append format for fresh/replay execution:

```text
<resolved original task>

Additional instruction for this resumed run:
<continuation task>
```

For a Pi unit with an existing stored session, do not resend the original task or earlier continuation tasks. Send the standard safety-oriented continuation instruction and, when supplied by the current call, append:

```text
Additional instruction for this resumed run:
<current continuation task>
```

For a Pi unit without a session because it never started, send the resolved original task plus every continuation task recorded on the run. For Grok and Grok ACP units, do the same from a fresh process and continue requiring `allowReplay: true`.

### Durable Continuation Metadata

Add an optional field to `AgentRunRecordV1`:

```ts
continuationTasks?: string[];
```

Append only a trimmed, non-empty current `task`, after resume preflight succeeds and the run claim is acquired. Persist it in the same `updateRun` operation that transitions the run to `running`; do not mutate a run when preflight or claim acquisition fails. Existing records without the field behave as `continuationTasks: []`.

## File Map

- Modify: `packages/pi-agents/src/schema.ts` — add public `runId` and `allowReplay` parameters and describe resume-only semantics.
- Modify: `packages/pi-agents/src/run-types.ts` — add optional durable continuation-task history.
- Modify: `packages/pi-agents/src/run-store.ts` — validate optional continuation-task history when loading Version 1 records.
- Modify: `packages/pi-agents/src/tool.ts` — validate resume calls, load and hydrate the stored workflow, persist continuation tasks, dispatch with resume context, and remove the internal `resumeRunId`/`allowReplay` bridge.
- Modify: `packages/pi-agents/src/invocation.ts` — centralize original-task append formatting and Pi session-continuation prompt construction.
- Modify: `packages/pi-agents/src/execution.ts` — accept resume prompt context and select session continuation versus fresh/replay task text.
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts` — use the shared continuation prompt builder for resumed TUI RPC sessions.
- Modify: `packages/pi-agents/src/index.ts` — remove `agent_job` registration/imports and document `runId` as the fourth `agent` execution mode.
- Delete: `packages/pi-agents/src/job-schema.ts` — obsolete model-facing job schema.
- Delete: `packages/pi-agents/src/job-tool.ts` — obsolete list/get/resume tool implementation.
- Modify: `packages/pi-agents/src/render.ts` — remove `renderJobCall` and replace resume hints with `agent({ runId: ... })`.
- Modify: `packages/pi-agents/src/command.ts` — retain human-facing run listing/status commands and update `/agent resume` guidance to the consolidated tool syntax.
- Modify: `packages/pi-agents/tests/tool.test.ts` — cover public `runId` hydration, validation, continuation persistence, selective resume, background restoration, replay gating, and errors.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — cover valid, missing, and malformed continuation-task history during record loading.
- Modify: `packages/pi-agents/tests/invocation.test.ts` — cover shared prompt composition with and without a new continuation task.
- Modify: `packages/pi-agents/tests/execution.test.ts` — cover existing-session, never-started Pi, and replay prompt selection.
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts` — cover resumed RPC prompt delivery with an appended task.
- Modify: `packages/pi-agents/tests/render.test.ts` — remove `agent_job` renderer tests and assert the new resume hint.
- Modify: `packages/pi-agents/tests/command.test.ts` — assert `/agent resume` emits `agent({ runId: ... })` guidance.
- Modify: `packages/pi-agents/tests/resume.test.ts` — verify continuation metadata is backward compatible and is not persisted on failed preflight.
- Delete: `packages/pi-agents/tests/job-tool.test.ts` — behavior moves to the `agent` tool tests; list/get behavior is no longer model-facing.
- Modify: `packages/pi-agents/README.md` — replace `agent_job` usage with `agent` resume usage and retain slash commands for inspection.
- Modify: `packages/pi-agents/docs/how-to.md` — update fanout resume steps and explain appended-task behavior.
- Modify: `packages/pi-agents/docs/reference.md` — document the new parameters, validation rules, continuation metadata, and replay errors.

## Tasks

### Task 1: Make `runId` a First-Class `agent` Resume Mode

**Outcome:** `executeAgentTool` can accept a public `runId`, recover the stored workflow without caller-supplied launch configuration, and enter the existing resume coordinator path.

**Files:**

- Modify: `packages/pi-agents/src/schema.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`

**Steps:**

- [ ] Add optional `runId: string` to `SubagentParams` with a description stating that it resumes an existing durable run and restores the stored workflow and sessions.
- [ ] Add optional `allowReplay: boolean` to `SubagentParams` with the current duplicate-side-effect warning from `JobParams`.
- [ ] Update the execution-mode contract in code so a fresh call still requires exactly one of single, parallel, or chain, while a resume call requires `runId` and allows only optional `task` and `allowReplay` alongside it.
- [ ] Return `resume_error: conflicting parameters for runId: <sorted field list>` when a resume call supplies any fresh-run configuration field. Do not silently prefer caller values over persisted values.
- [ ] Add optional `continuationTasks?: string[]` to `AgentRunRecordV1`; treat a missing field as an empty array everywhere.
- [ ] Extend `RunStore` record validation so a present `continuationTasks` value must be an array of strings; return `corrupt_run` for malformed values while continuing to accept existing records where the field is absent.
- [ ] At the start of `executeAgentTool`, capture the caller's trimmed `task` as the current continuation instruction, load `runId` through the injected `RunStore`, and return `resume_error: run_not_found: ...` before workflow dispatch when loading fails.
- [ ] Hydrate effective `Params` from `record.request`, restore `runInBackground` from `record.background`, and derive mode and agent discovery scope from the stored values. Use typed conversion helpers instead of the `as any` casts currently in the `agent_job` callback.
- [ ] Replace `ExecuteAgentToolOptions.resumeRunId` and `ExecuteAgentToolOptions.allowReplay` with a local resume descriptor derived from public parameters. Keep options reserved for injected infrastructure and test seams.
- [ ] Pass the public `allowReplay` value into the existing `inspectResume` call. Preserve current errors for completed, active, missing-session, fingerprint-mismatched, invalid-fanout, and replay-blocked runs.
- [ ] After preflight and claim acquisition, append a non-empty current continuation task to `record.continuationTasks` and persist it atomically with the transition to `running`, incremented incomplete attempts, and updated timestamp. Release the claim and return `resume_setup_failed` if that persistence fails.
- [ ] Expose the accumulated continuation tasks and current continuation task on the restored durable context so every workflow mode receives the same resume metadata.
- [ ] Preserve completed results, original chain outputs, frozen fanout mappings, unit IDs, worktrees, session paths, and attempt behavior exactly as the current resume implementation does.
- [ ] Add tool tests for `runId` alone, `runId` plus a trimmed continuation task, `runId` plus `allowReplay`, unknown/completed/active runs, conflicting parameters, restored single/parallel/chain mode, original background behavior, and absence of a second durable run record.
- [ ] Add a failure test proving a continuation task is not written when preflight fails or another owner holds the claim.
- [ ] Add run-store tests proving an absent field loads, a string array round-trips, and non-array or non-string entries produce `corrupt_run`.
- [ ] Add a backward-compatibility test proving an existing Version 1 record without `continuationTasks` resumes as an empty history.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/tool.test.ts tests/resume.test.ts`
- Expected: Fresh invocation tests remain green; resume tests show the same run ID and stored workflow are reused, continuation metadata changes only after a successful claim, and replay still requires explicit acknowledgement.

### Task 2: Deliver Appended Prompts Correctly Across Pi and Grok Runtimes

**Outcome:** Every incomplete unit receives the additional task without resending completed work or duplicating the original task into an existing Pi session.

**Files:**

- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/invocation.test.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Add one shared helper that appends accumulated continuation tasks to an already resolved original task using the exact `Additional instruction for this resumed run:` delimiter. Ignore blank continuation entries without changing the original task.
- [ ] Add one shared helper that builds the Pi session-continuation prompt from the existing safety instruction plus the current call's non-empty continuation task. Export it for both JSON CLI and RPC execution.
- [ ] Replace `BuildPiArgsOptions.promptKind` with an explicit resume prompt option that distinguishes an existing-session continuation from a fresh invocation. Existing-session execution must still pass `--session <file>` and must not append `Task: <original task>`.
- [ ] Extend `RunSingleAgentOptions` and the corresponding RPC option type with resume prompt context without changing fresh-call defaults.
- [ ] In `runStepWithContext`, inspect the durable unit context after worktree/session restoration:
  - for a Pi unit with `unitContext.sessionFile`, keep the resolved original task in result metadata and send the shared session-continuation prompt with only the current continuation task;
  - for a Pi unit with no stored session, append all durable continuation tasks to the resolved original task and start a normal persisted session;
  - for Grok or Grok ACP, append all durable continuation tasks to the resolved original task and replay it from a fresh process after `allowReplay` preflight succeeds.
- [ ] Apply continuation text after chain placeholder and fanout `{item}` resolution so braces or output-like text in the new instruction are not interpreted as workflow templates.
- [ ] Thread the same resume descriptor through single, parallel, sequential-chain, and fanout dispatch. Skip completed units before prompt composition so their stored `SingleResult.task` and messages remain byte-for-byte unchanged.
- [ ] Replace the duplicated fixed resume string in `pi-rpc-execution.ts` with the shared prompt builder and assert RPC activation receives the same text as JSON Pi execution.
- [ ] Keep the current generic continuation prompt when `agent({ runId })` omits `task`.
- [ ] Add invocation tests proving an existing session receives no `Task: <original>` text, a current continuation is appended exactly once, and a blank continuation produces the current fixed prompt.
- [ ] Add execution tests for an attempted Pi unit with a session, a queued Pi unit without a session, Grok replay with accumulated continuation tasks, and a second interruption where an earlier persisted continuation remains available to fresh/replay units.
- [ ] Add chain and fanout coverage proving the continuation is appended after placeholder resolution and only incomplete units execute.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/invocation.test.ts tests/execution.test.ts tests/pi-rpc-execution.test.ts tests/tool.test.ts`
- Expected: JSON Pi and RPC Pi send equivalent continuation prompts, never-started/replay units receive original plus accumulated instructions, and completed units are not dispatched or modified.

### Task 3: Remove `agent_job` and Consolidate User-Facing Guidance

**Outcome:** The extension registers only `agent` for model-facing durable resume, while human slash commands continue to provide run discovery and status inspection.

**Files:**

- Modify: `packages/pi-agents/src/index.ts`
- Delete: `packages/pi-agents/src/job-schema.ts`
- Delete: `packages/pi-agents/src/job-tool.ts`
- Modify: `packages/pi-agents/src/render.ts`
- Modify: `packages/pi-agents/src/command.ts`
- Delete: `packages/pi-agents/tests/job-tool.test.ts`
- Modify: `packages/pi-agents/tests/render.test.ts`
- Modify: `packages/pi-agents/tests/command.test.ts`

**Steps:**

- [ ] Remove `JobParams`, `executeJobTool`, `renderJobCall`, `Theme`, and `Component` imports that are used only by `agent_job` registration.
- [ ] Delete the entire `pi.registerTool({ name: 'agent_job', ... })` block from `index.ts`; the `agent` executor should pass public parameters directly to `executeAgentTool` with the existing store, coordinator, background manager, and interactive registry.
- [ ] Update the `agent` tool description to define four mutually exclusive entry forms: single, parallel, chain, or durable resume via `runId`; state that resume may append `task`, and `allowReplay` is required for replay-capable units.
- [ ] Delete `job-schema.ts`, `job-tool.ts`, and `job-tool.test.ts` after their resume behavior is covered by `tool.test.ts`. Do not move list/get actions into `agent`.
- [ ] Remove `renderJobCall` and its renderer-context comment reference from `render.ts`.
- [ ] Change expanded durable-run guidance to `agent({ runId: "<id>" })`. Keep the existing run ID, attempt, capability, and session details.
- [ ] Retain `/agent runs` and `/agent status <run-id>` as human-facing inspection paths. Change `/agent resume <run-id>` to display `agent({ runId: "<id>" })` and mention `allowReplay: true` only when the stored units include replay capability.
- [ ] Remove the `agent_job rendering` test block, retain the generic empty-details fallback only if another registered path still uses it, and add an assertion for the new expanded result hint.
- [ ] Extend command tests to cover session-only and replay-capable resume guidance without starting a run from the slash command.
- [ ] Search current source, tests, README, and current documentation for `agent_job`; after this task, only historical plans/analysis may contain the name.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/render.test.ts tests/command.test.ts`
- Expected: Rendering and slash-command tests pass, no `agent_job` tool is registered or imported, and resume guidance points to `agent({ runId: ... })`.

### Task 4: Update Current Documentation and Complete Regression Validation

**Outcome:** Users and models see one resume API, understand appended prompt behavior, and retain a documented path for run inspection and replay acknowledgement.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/how-to.md`
- Modify: `packages/pi-agents/docs/reference.md`

**Steps:**

- [ ] Replace the README feature text and durable-run examples so `agent({ runId })` resumes, optional `task` adds instructions, and optional `allowReplay` acknowledges replay risk.
- [ ] Keep `/agent runs` and `/agent status` as the documented discovery/inspection route now that model-facing list/get actions are removed; describe that a fresh `agent` result also exposes its run ID.
- [ ] Document that all stored workflow configuration remains authoritative on resume and conflicting launch fields are rejected.
- [ ] Document continuation behavior for existing Pi sessions, never-started Pi units, Grok/Grok ACP replay, parallel runs, chains, and frozen fanout items.
- [ ] Update the fanout how-to steps to inspect through slash commands and resume through `agent({ runId, task?, allowReplay? })`.
- [ ] Add `runId`, `task`-on-resume, `allowReplay`, `continuationTasks`, conflict errors, and current blocking reasons to the reference documentation.
- [ ] Preserve privacy guidance and explicitly state that appended continuation prompts are durable run data and may contain sensitive information.
- [ ] Do not edit `docs/plans/2026-07-13-agent-run-resume-plan.md` or `docs/analysis/agent-job-openai-schema-compatibility.md`; they are historical records of the previous architecture.
- [ ] Run a repository search and verify no current source, tests, README, how-to, or reference page instructs callers to use `agent_job`.

**Validation:**

- Run: `! grep -R "agent_job" packages/pi-agents/src packages/pi-agents/tests packages/pi-agents/README.md packages/pi-agents/docs/how-to.md packages/pi-agents/docs/reference.md`
- Expected: The negated search exits successfully because there are no matches.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript completes without errors after removing the obsolete tool types and imports.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: The complete package test suite passes, including fresh launch, durable resume, fanout restoration, background execution, rendering, commands, JSON Pi, RPC Pi, Grok, and Grok ACP coverage.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: `packages/pi-agents/dist/` builds with `agent` registered and no `agent_job` registration.
- Run: `hk check`
- Expected: Repository-wide ESLint and Prettier checks pass.
- Manual check: Start a Pi run, interrupt it after its session file is persisted, then call `agent({ runId, task: "Finish and rerun validation." })`.
- Expected: The same run ID, session file, cwd/worktree, stored agent configuration, and workflow topology are reused; the additional instruction appears once in the resumed session; completed units do not rerun; the attempt increments only for previously started incomplete units.
- Manual check: Resume an interrupted Grok run first without and then with `allowReplay: true`.
- Expected: The first call is non-mutating and reports replay acknowledgement is required; the second replays only incomplete units from their resolved original task plus all durable continuation instructions.

## Rollout Notes

- This is a model-facing breaking API change: prompts or integrations that explicitly call `agent_job` must switch to `agent({ runId, task?, allowReplay? })`.
- Existing durable run directories remain compatible because `continuationTasks` is optional and all existing request, unit, session, worktree, and fanout fields retain their meaning.
- Human inspection remains available through `/agent runs` and `/agent status <run-id>`; no storage migration or deletion is required.
- Reload or restart Pi after rebuilding the extension so the provider tool schema drops `agent_job` and exposes the new `agent` parameters.

## Risks and Mitigations

- **A caller supplies new launch configuration with `runId` and assumes it overrides the run.** — Reject every conflicting field and list it in the error; never silently mix stored and caller configuration.
- **An appended task is lost after a second interruption of a queued or replay unit.** — Persist trimmed continuation tasks on the run after claim acquisition and include the full accumulated history for fresh/replay execution.
- **An existing Pi session receives the original task twice.** — Select session continuation from the presence of the stored unit session and send only the shared resume prompt plus the current new instruction.
- **A continuation string is mistaken for a chain placeholder or fanout template.** — Append continuation text only after the chain engine resolves the original unit task.
- **Replay duplicates filesystem, command, or network side effects.** — Preserve `allowReplay: true` as an explicit gate and keep preflight non-mutating when acknowledgement is absent.
- **Resume mutates the run before discovering a missing session, fingerprint mismatch, active owner, or corrupt fanout mapping.** — Run inspection first, acquire the claim second, and persist continuation metadata only with the successful running-state transition.
- **Restoring original background behavior surprises a caller expecting a synchronous result.** — Document that all non-task settings, including background delivery, remain stored-run behavior and cannot be overridden in a `runId` call.
- **Deleting `agent_job` removes model-facing run discovery.** — Preserve run IDs in `agent` results and retain `/agent runs` plus `/agent status` for human inspection; do not add unrelated list/get actions to the consolidated tool.
