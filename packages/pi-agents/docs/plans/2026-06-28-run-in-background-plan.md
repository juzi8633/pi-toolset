# Run In Background Implementation Plan

**Goal:** Add `runInBackground` support to `@balaenis/pi-agents` so an agent invocation can return immediately and notify the parent session when the background workflow finishes.

**Inputs:** Request to implement “run in background”; repository evidence from `packages/pi-agents/src/index.ts`, `schema.ts`, `tool.ts`, `execution.ts`, `render.ts`, `types.ts`, `README.md`, and Pi extension documentation for `pi.sendMessage()` / custom messages.

**Assumptions:**

- Background execution applies to the whole `agent` tool invocation, not to individual `chain[]` steps or `tasks[]` items.
- Background jobs are session/process scoped. They survive the parent tool-call abort signal, but they do not survive Pi process restart.
- Background mode is supported only in long-lived `tui` and `rpc` modes. It is rejected in `json` and `print` modes because the host process may exit after the tool returns.
- Completion notifications are injected as custom messages with `triggerTurn: true` and `deliverAs: "followUp"`, so the parent model receives the result without polling.

**Architecture:** Add a session-scoped background manager that launches the existing foreground single/parallel/chain workflow in a detached promise with its own `AbortController`. The `agent` tool keeps the current synchronous path by default; when `runInBackground` is true it performs the same validation and project/package-agent confirmation, registers a background job, returns a launch result immediately, and sends a custom completion/failure message when the job settles.

**Tech Stack:** TypeScript, TypeBox schemas, Pi extension API (`registerTool`, `sendMessage`, `registerMessageRenderer`, `session_shutdown`), existing subprocess execution via `runSingleAgent()`.

---

## File Map

- Create: `packages/pi-agents/src/background.ts` — session-scoped background job manager, job ids, limits, launch result creation, completion/failure notification content, shutdown cancellation.
- Modify: `packages/pi-agents/src/schema.ts` — add `runInBackground?: boolean` to the public tool schema.
- Modify: `packages/pi-agents/src/types.ts` — add background launch/result detail types and allow `SubagentDetails.mode` to include `"background"`.
- Modify: `packages/pi-agents/src/tool.ts` — factor the current foreground execution into a reusable workflow function and add the background dispatch branch after validation/confirmation.
- Modify: `packages/pi-agents/src/index.ts` — instantiate the background manager, pass it into tool execution, add argument compatibility for `run_in_background`, register custom notification rendering, and cancel jobs on session shutdown.
- Modify: `packages/pi-agents/src/render.ts` — show background launch state in `renderCall` / `renderResult` and render completion custom messages compactly.
- Modify: `packages/pi-agents/README.md` — document `runInBackground`, notification behavior, limitations, and examples.
- Test: `packages/pi-agents/tests/background.test.ts` — unit coverage for manager launch, completion notification, failure notification, job limit, unsupported mode rejection, and shutdown cancellation.
- Test: `packages/pi-agents/tests/tool.test.ts` — integration-style unit coverage for `executeAgentTool()` background dispatch using an injected fake background manager and fake workflow runner.

## Tasks

### Task 1: Add background job manager primitives

**Outcome:** A reusable manager can start a detached workflow, return a background launch tool result immediately, notify the parent session on completion/failure, enforce a job limit, and cancel live jobs on shutdown.

**Files:**

- Create: `packages/pi-agents/src/background.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Test: `packages/pi-agents/tests/background.test.ts`

**Steps:**

- [ ] Define `BACKGROUND_MESSAGE_TYPE = "pi-agents-background-result"` in `background.ts`.
- [ ] Define `BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled"`.
- [ ] Define `BackgroundLaunchDetails` with `jobId`, `mode`, `status`, `agentScope`, `description`, `startedAt`, and `taskPreview`.
- [ ] Define `BackgroundNotificationDetails` with `jobId`, `mode`, `status`, `description`, `startedAt`, `finishedAt`, optional `durationMs`, optional `result`, and optional `error`.
- [ ] Extend `SubagentDetails.mode` in `types.ts` from `"single" | "parallel" | "chain"` to `"single" | "parallel" | "chain" | "background"` and add optional `background?: BackgroundLaunchDetails[]`.
- [ ] Implement `createBackgroundManager(pi, options?)` with `maxJobs` defaulting to `4`.
- [ ] Implement `launch(request)` where `request` includes `mode`, `agentScope`, `description`, `taskPreview`, and `run(signal)`.
- [ ] In `launch()`, reject when the running job count is at `maxJobs` and return an error tool result whose text includes `Too many background agent jobs`.
- [ ] In `launch()`, create a stable id like `agent-bg-${Date.now().toString(36)}-${randomSuffix}`.
- [ ] Start the workflow with a new `AbortController` and do not use the parent tool-call `signal`.
- [ ] On successful workflow completion, call `pi.sendMessage()` with `customType: BACKGROUND_MESSAGE_TYPE`, `display: true`, `triggerTurn: true`, `deliverAs: "followUp"`, and XML-like content containing job id, status, summary, and model-visible result text.
- [ ] On workflow rejection or `result.isError`, notify with `status="failed"` and include the error text in the message content.
- [ ] Implement `cancelAll(reason)` that aborts all running job controllers and marks them cancelled.
- [ ] Add `background.test.ts` tests with fake `pi.sendMessage()` verifying immediate launch result, completion message, failure message, max job rejection, and `cancelAll()` aborting the job signal.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- background.test.ts`
- Expected: Background manager tests pass; no unhandled promise rejection is emitted after tests finish.

### Task 2: Add public parameter and argument compatibility

**Outcome:** The `agent` tool schema exposes `runInBackground`, while resumed/Claude-style calls using `run_in_background` are normalized before validation.

**Files:**

- Modify: `packages/pi-agents/src/schema.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Add `runInBackground: Type.Optional(Type.Boolean({ description: "Run this agent workflow in the background. The tool returns immediately and the parent session is notified when it completes." }))` to `SubagentParams`.
- [ ] In `index.ts`, add `prepareArguments(args)` to the registered `agent` tool.
- [ ] In `prepareArguments(args)`, if `args` is an object and `run_in_background` is a boolean while `runInBackground` is undefined, return a copy with `runInBackground: args.run_in_background`.
- [ ] Do not add `run_in_background` to `SubagentParams`; keep compatibility outside the public schema.
- [ ] Add a `tool.test.ts` case that calls `prepareArguments()` through an exported helper or direct tool registration fixture and verifies `{ run_in_background: true }` becomes `{ runInBackground: true }`.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript accepts the new parameter and compatibility normalization without widening `SubagentParams` to `any`.

### Task 3: Wire background dispatch into tool execution

**Outcome:** `executeAgentTool()` still runs synchronously by default, but with `runInBackground: true` it launches the validated workflow through the background manager and returns immediately.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Introduce `ExecuteAgentToolOptions` with optional `backgroundManager` and optional `runWorkflow` test seam.
- [ ] Factor the current post-validation execution into `executeAgentWorkflow(params, signal, onUpdate, ctx, discovery, agents, makeDetails)` or an equivalent private helper that preserves current single/parallel/chain behavior.
- [ ] Keep `assertAgentDelegationAllowed()`, agent discovery, mode-count validation, and project/package-agent confirmation in `executeAgentTool()` before the background branch.
- [ ] Derive the requested mode once with a helper returning `"single"`, `"parallel"`, or `"chain"`.
- [ ] If `params.runInBackground` is true and `ctx.mode` is `"json"` or `"print"`, return an error result explaining that background agents require a long-lived TUI/RPC session.
- [ ] If `params.runInBackground` is true but no `backgroundManager` is available, return an error result explaining that background execution is unavailable.
- [ ] If `params.runInBackground` is true, call `backgroundManager.launch()` with a `run(signal)` callback that invokes the factored foreground workflow using a params copy with `runInBackground` removed and `onUpdate` set to `undefined`.
- [ ] Ensure background workflow receives the background job abort signal, not the parent tool-call signal.
- [ ] Ensure synchronous single/parallel/chain tests continue to exercise the same code path when `runInBackground` is absent or false.
- [ ] Add `tool.test.ts` cases for successful background launch, unsupported mode rejection, and confirmation still happening before launch for project/package agents.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tool.test.ts`
- Expected: Background dispatch tests pass and existing synchronous behavior remains unchanged in tested cases.

### Task 4: Render launch and notification states

**Outcome:** Users can distinguish a background launch from a completed foreground agent call, and completion notifications render with compact status, job id, and expandable details.

**Files:**

- Modify: `packages/pi-agents/src/render.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Modify: `packages/pi-agents/src/background.ts`
- Test: `packages/pi-agents/tests/background.test.ts`

**Steps:**

- [ ] In `renderCall()`, append a muted `[background]` marker when `args.runInBackground` is true.
- [ ] In `renderResult()`, add a `details.mode === "background"` branch that renders `⏳ background <jobId>` plus the description and “you will be notified when it completes”.
- [ ] Export `renderBackgroundMessage(message, options, theme)` from `background.ts` or a small render helper.
- [ ] In `index.ts`, call `pi.registerMessageRenderer(BACKGROUND_MESSAGE_TYPE, renderBackgroundMessage)`.
- [ ] For completed notifications, render `✓ background <jobId>` and show the result summary in collapsed view.
- [ ] For failed notifications, render `✗ background <jobId>` and show the error text in collapsed view.
- [ ] In expanded notification view, show description, status, duration, and the full final result or error.
- [ ] Add a `background.test.ts` assertion that completion notification details include enough data for the renderer: job id, mode, status, description, timestamps, and result/error.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- background.test.ts`
- Expected: Notification details are complete for both success and failure paths.

### Task 5: Update README usage and limitations

**Outcome:** Users and models know when to use background mode, how notifications work, and what is intentionally unsupported.

**Files:**

- Modify: `packages/pi-agents/README.md`

**Steps:**

- [ ] Add `runInBackground` to the feature list as “Background agents”.
- [ ] Add a usage example:

  ```json
  {
    "agent": "worker",
    "task": "Run the full test suite and report failures.",
    "runInBackground": true
  }
  ```

- [ ] Add guidance: use background only for independent work; use foreground when the parent needs the result before proceeding.
- [ ] State that completion is delivered automatically as a session message and the parent should not poll.
- [ ] State that background jobs are scoped to the current Pi process/session and are cancelled on session shutdown.
- [ ] State that `json` and `print` modes reject background execution.
- [ ] Add `runInBackground` to the Tool Modes or parameter reference section.
- [ ] Add a limitation that manual detaching of an already-running foreground agent is not part of this implementation.

**Validation:**

- Run: `bunx prettier --check packages/pi-agents/README.md packages/pi-agents/docs/plans/2026-06-28-run-in-background-plan.md`
- Expected: Markdown formatting check passes.

### Task 6: Full package validation

**Outcome:** The feature is type-safe, tested, documented, and does not regress existing `pi-agents` behavior.

**Files:**

- Modify: all files touched by Tasks 1-5

**Steps:**

- [ ] Run package tests.
- [ ] Run package typecheck.
- [ ] Run package build.
- [ ] If `hk check` is reasonably fast in the local environment, run it after package-level checks; otherwise state that package-level validation was used instead.
- [ ] Manually smoke test in TUI after building: launch `agent` with `runInBackground: true`, verify the tool returns immediately, and verify a completion custom message appears when the child process exits.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: All `pi-agents` tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: Package builds successfully.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: All package tests pass, including `background.test.ts` and `tool.test.ts`.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: `packages/pi-agents/dist/index.js` and related outputs are generated successfully.
- Run: `bunx prettier --check packages/pi-agents/src/background.ts packages/pi-agents/src/schema.ts packages/pi-agents/src/tool.ts packages/pi-agents/src/index.ts packages/pi-agents/src/render.ts packages/pi-agents/src/types.ts packages/pi-agents/README.md packages/pi-agents/docs/plans/2026-06-28-run-in-background-plan.md`
- Expected: Formatting check passes.

## Rollout Notes

- This is a behavior addition behind an explicit `runInBackground` parameter; default foreground behavior remains unchanged.
- Background jobs intentionally do not persist across Pi process restarts. If cross-restart persistence is later required, design a separate daemon/job-store feature instead of extending the in-memory manager implicitly.
- In TUI/RPC sessions, completion notifications trigger a follow-up turn. This is desirable for “notify me when done”, but users should avoid launching background agents for work that must not re-enter the model automatically.
- Package/project agent confirmation still occurs before a background job starts; background execution must not bypass the current trust prompt.

## Risks and Mitigations

- Risk: A background job keeps running after the user aborts the foreground turn. — Mitigation: Use an independent `AbortController` by design, and cancel all live background jobs on `session_shutdown`.
- Risk: Background jobs recursively spawn more agents and cause runaway work. — Mitigation: Keep existing `PI_AGENT_DEPTH` / `maxSubagentDepth` controls and add a `MAX_BACKGROUND_JOBS` limit.
- Risk: Completion notifications flood the model context with large outputs. — Mitigation: Reuse existing `getResultOutput()` / `truncateParallelOutput()` style truncation for notification content and store full details in `message.details` for rendering.
- Risk: `print`/`json` mode exits before detached work completes. — Mitigation: Reject background execution in those modes with a clear error.
- Risk: Project/package agent confirmation is skipped because the background workflow runs later. — Mitigation: Keep confirmation in `executeAgentTool()` before `backgroundManager.launch()`.
- Risk: Dirty worktrees from background jobs are cleaned up incorrectly after completion. — Mitigation: Reuse the existing foreground workflow so `finalizeWorktree()` and retention behavior remain unchanged.
- Risk: `run_in_background` calls from Claude-style prompts fail schema validation. — Mitigation: Add `prepareArguments()` compatibility while keeping the public schema camelCase.
