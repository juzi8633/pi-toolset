# Agent Output Rendering Implementation Plan

**Goal:** Redesign the `agent` tool output so collapsed views are compact status summaries with at most one latest activity, while expanded views retain complete tasks, transcripts, final output, errors, and workflow progress.

**Inputs:** `packages/pi-agents/docs/draft/render.md`, the current renderer and workflow implementation, and the product decisions made during review.

**Assumptions:**

- Remove the existing `subagent … [scope]` call-title block from `renderCall`; the result view becomes the visible tool block.
- A collapsed execution-unit status line includes status, agent name, a truncated task preview, usage, model, and thinking level.
- Single running results show at most one latest activity; completed results do not show latest activity.
- Parallel collapsed results show one summary per task and at most one latest activity under each running task.
- Chain collapsed results show one summary per started logical step; only the active sequential step or active fanout step shows one latest activity.
- A fanout is one logical chain step in collapsed output, regardless of the number of fanout items.
- Expanded output contains the complete task, all tool calls and assistant text, final output, error details, and usage.
- Aggregate usage sums token/turn fields, uses the maximum `contextTokens`, and does not display an aggregate model or thinking level.
- Existing background launch and notification layouts are outside this redesign except where shared status types require compatibility.

**Architecture:** Introduce explicit execution and logical-chain progress state so rendering does not infer workflow state from `exitCode` or `results.length`. Execution layers will emit complete ordered snapshots for Single, Parallel, sequential Chain, and fanout Chain. Pure output helpers will derive the latest activity and non-duplicated transcript, while `render.ts` will format compact collapsed summaries and complete expanded sections.

**Tech Stack:** TypeScript, Pi extension tool renderers, `@earendil-works/pi-tui`, Bun tests, Mise task runner, ESLint, and Prettier through `hk`.

---

## Target Layout

### Single Collapse

```text
⧗ explore (探索当前项目的整体结构...) · 9 turns ↑20k ↓6.5k R148k ctx:9.4k grok-4.5 • high
  └─ read ~/workspace/my/pi-myagent/.gitignore
(Ctrl+O to expand)
```

Completed:

```text
✔ explore (探索当前项目的整体结构...) · 9 turns ↑20k ↓6.5k R148k ctx:9.4k grok-4.5 • high
(Ctrl+O to expand)
```

### Parallel Collapse

```text
✔ explore (探索项目结构...) · 5 turns ↑12k ↓2k grok-4.5 • high
⧗ reviewer (审查模型服务...) · 4 turns ↑8k ↓1k openai-codex/gpt-5.6 • high
  └─ read src/services/models.rs
Total: 1/2 completed · 9 turns ↑20k ↓3k R40k ctx:max 12k
(Ctrl+O to expand)
```

### Sequential Chain Collapse

```text
✔ 1. explore (分析当前实现...) · 5 turns ↑12k ↓2k grok-4.5 • high
⧗ 2. planner (制定实施计划...) · 4 turns ↑8k ↓1k openai-codex/gpt-5.6 • high
  └─ read docs/spec.md
Chain: step 2/3 · 1 completed · 9 turns ↑20k ↓3k R40k ctx:max 12k
(Ctrl+O to expand)
```

### Fanout Chain Collapse

```text
✔ 1. planner (生成审查目标...) · 4 turns ↑8k ↓1k grok-4.5 • high
⧗ 2. reviewer fanout (审查每个目标...) · 3/8 done, 4 running, 1 queued · 12 turns ↑24k ↓4k
  └─ [5/8] read src/models.ts
Chain: step 2/3 · 1 completed · 16 turns ↑32k ↓5k R60k ctx:max 14k
(Ctrl+O to expand)
```

## File Map

- Modify: `packages/pi-agents/docs/draft/render.md` — finalize layouts and state semantics for Single, Parallel, sequential Chain, fanout Chain, errors, cancellation, and empty output.
- Modify: `packages/pi-agents/src/constants.ts` — remove the old collapsed history count if it has no remaining consumers.
- Modify: `packages/pi-agents/src/types.ts` — add explicit execution status, fanout item identity, and logical Chain progress metadata.
- Modify: `packages/pi-agents/src/execution.ts` — assign running/final status to Single results emitted by each runtime.
- Modify: `packages/pi-agents/src/tool.ts` — maintain ordered Single/Parallel snapshots and attach Chain progress details.
- Modify: `packages/pi-agents/src/chain.ts` — maintain logical-step state, cumulative sequential partials, cumulative fanout item state, real fanout counts, and cancellation-safe partial results.
- Modify: `packages/pi-agents/src/output.ts` — derive latest activity and a complete transcript without duplicating final output.
- Modify: `packages/pi-agents/src/render.ts` — remove the visible call title and implement the new collapsed and expanded layouts.
- Modify: `packages/pi-agents/tests/output.test.ts` — cover latest-activity and transcript extraction.
- Modify: `packages/pi-agents/tests/execution.test.ts` — cover Single status transitions emitted by Pi, Grok, and Grok ACP runtimes.
- Modify: `packages/pi-agents/tests/tool.test.ts` — cover ordered Parallel status snapshots and aggregate progress.
- Modify: `packages/pi-agents/tests/chain.test.ts` — cover logical Chain state, cumulative sequential updates, fanout concurrency, failure, skip, and cancellation.
- Modify: `packages/pi-agents/tests/render.test.ts` — cover exact information density and state-specific rendering for every mode.
- Modify: `packages/pi-agents/README.md` — document collapsed/expanded behavior and Chain fanout progress.

## Tasks

### Task 1: Finalize the Rendering Contract

**Outcome:** The draft specifies the exact visible information and state semantics needed by implementation and tests.

**Files:**

- Modify: `packages/pi-agents/docs/draft/render.md`

**Steps:**

- [ ] Remove the `subagent … [scope]` title from every target example.
- [ ] Define the collapsed Single layout for queued/running/completed/failed/cancelled and empty-output states.
- [ ] Define the collapsed Parallel rule: one status line per task, one latest line only for running tasks, followed by aggregate progress and usage.
- [ ] Define the sequential Chain rule: one line per started logical step, one latest line only for the active step, and a footer that distinguishes current step from completed-step count.
- [ ] Define fanout as one logical Chain step in collapsed output and show one globally latest fanout activity prefixed with `[item/total]`.
- [ ] Define expanded sections for task, complete output transcript, final output, errors, worktree retention, structured-output validation, and usage.
- [ ] Define terminal-width priorities: preserve glyph, agent, and progress; truncate task preview first; move usage to a continuation line only when it cannot fit.
- [ ] Correct terminology from “Extend” to “Expanded” and correct inconsistent model spelling.

**Validation:**

- Run: `grep -n "subagent\|## .*Agent\|fanout\|cancel" packages/pi-agents/docs/draft/render.md`
- Expected: No target example contains the removed call title, and the document contains explicit fanout and cancellation examples.

### Task 2: Add Explicit Execution and Chain Progress Types

**Outcome:** Renderers receive authoritative status and logical workflow progress instead of inferring it from exit codes and result counts.

**Files:**

- Modify: `packages/pi-agents/src/types.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] Add `ExecutionStatus` with `queued`, `running`, `completed`, `failed`, `cancelled`, and `skipped`.
- [ ] Add `status` to `SingleResult` and update all result constructors and test fixtures in the same change.
- [ ] Add optional fanout identity to `SingleResult`: zero-based `index`, actual executed `count`, and rendered item task.
- [ ] Add `ChainExecutionDetails` to `SubagentDetails`, containing fixed `totalSteps` and ordered logical-step entries.
- [ ] Define sequential logical-step metadata: step number, agent, original task, and status.
- [ ] Define fanout logical-step metadata: step number, agent, task template, status, source output/pointer, collect name, executed count, completed/failed/running/queued counts, skipped count, and latest fanout index.
- [ ] Keep `results` as the ordered execution-unit snapshots and `chain.steps` as logical workflow state; document that a fanout produces many results but counts as one Chain step.
- [ ] Keep new detail fields additive so existing serialized sessions without them can render through a conservative fallback.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Every `SingleResult` constructor supplies a valid status and all Chain details satisfy the new types.

### Task 3: Implement Latest Activity and Transcript Helpers

**Outcome:** Collapsed output can select one latest activity, while expanded output shows the complete transcript without repeating the final assistant response.

**Files:**

- Modify: `packages/pi-agents/src/output.ts`
- Test: `packages/pi-agents/tests/output.test.ts`

**Steps:**

- [ ] Add `getLatestActivity(messages)` that returns the last displayable tool call or assistant text item.
- [ ] Add a transcript helper that returns ordered tool calls and assistant text plus a separately identified final output.
- [ ] Exclude the assistant text selected as final output from the transcript portion so Expanded output renders it once.
- [ ] Preserve earlier assistant text blocks as continuing output rather than discarding them.
- [ ] Define empty-message behavior as no latest activity and an empty transcript/final output.
- [ ] Keep `getFinalOutput()` unchanged for workflow and non-UI callers.
- [ ] Add tests for tool-call latest, text latest, interleaved messages, multiple assistant turns, final-output de-duplication, and empty messages.

**Validation:**

- Run: `bun test packages/pi-agents/tests/output.test.ts`
- Expected: Latest selection follows message order and final assistant output appears exactly once in the derived transcript.

### Task 4: Emit Stable Single and Parallel Status Snapshots

**Outcome:** Single and Parallel updates carry explicit, ordered execution states suitable for the compact renderer.

**Files:**

- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Initialize a Single execution as `running`, then finalize it as `completed`, `failed`, or `cancelled` from its stop reason and process result.
- [ ] Ensure Pi, Grok, and Grok ACP partial callbacks expose the same status semantics.
- [ ] Initialize Parallel task slots in input order as `queued` with zero usage and empty messages.
- [ ] Change a task to `running` immediately before its worker starts and emit an update.
- [ ] Replace the corresponding slot with every full partial snapshot; do not append duplicate task entries.
- [ ] Finalize each slot as completed, failed, or cancelled and emit a complete ordered snapshot.
- [ ] Derive Parallel aggregate counts from explicit status rather than `exitCode === -1`.
- [ ] Clone result/message arrays when emitting snapshots so later mutation cannot alter previously delivered updates.
- [ ] Preserve the existing maximum of eight Parallel tasks and concurrency limit of four.

**Validation:**

- Run: `bun test packages/pi-agents/tests/execution.test.ts packages/pi-agents/tests/tool.test.ts`
- Expected: Updates show queued → running → terminal transitions, preserve input order, and never duplicate a task.

### Task 5: Model Sequential Chain Progress and Partial Updates

**Outcome:** Sequential Chain rendering has one authoritative logical step state and one current result snapshot per step.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] Initialize all logical steps as queued before entering the Chain loop.
- [ ] Mark the active logical step running before template rendering or agent execution and emit the state snapshot.
- [ ] Upsert the current sequential partial result by stable step number instead of appending it after completed results.
- [ ] Replace the running snapshot with its terminal result when the step completes.
- [ ] Mark a successful step completed and advance the next logical step to running.
- [ ] Mark template, schema, context, isolation, skill, worktree, runtime, and completion-check failures as failed.
- [ ] Mark all unstarted later logical steps skipped after a terminal Chain failure.
- [ ] Catch Chain cancellation, preserve completed and current results, mark the current step cancelled and later steps skipped, and return details suitable for rendering.
- [ ] Compute Chain progress from logical steps; never use `results.length` as the step count.
- [ ] Preserve named output and structured-output behavior unchanged.

**Validation:**

- Run: `bun test packages/pi-agents/tests/chain.test.ts`
- Expected: Repeated partials replace one current step, completed results remain stable, failures/cancellation retain partial history, and the denominator always equals the input Chain length.

### Task 6: Make Fanout Updates Cumulative and Counted Correctly

**Outcome:** A fanout Chain step exposes accurate queued/running/completed/failed/skipped state and one identifiable latest activity.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] After resolving the expand source, create one ordered execution slot for every item that will actually run.
- [ ] Record separately how many source items were skipped by `maxItems`; skipped source items do not receive fake results or usage.
- [ ] Assign each slot a stable fanout index/count and rendered task.
- [ ] Mark a slot running when its worker starts; leave concurrency-limited items queued.
- [ ] Replace `onUpdate: undefined` with a fanout-item partial callback that upserts the corresponding slot and updates the logical fanout step’s latest index.
- [ ] Emit every fanout partial as a complete ordered snapshot containing prior sequential results and all fanout slots.
- [ ] Increment completed/failed counts from slot status, never from `index + 1`.
- [ ] Preserve original item order even when completion order differs.
- [ ] Mark the fanout logical step completed only when all executed items succeed; mark it failed after all items settle if any fail, preserving all item results.
- [ ] Handle an empty source array as a successful `0/0` fanout and collect an empty array.
- [ ] Keep collect as metadata and named output on the fanout logical step, not as a separate executable Chain step.
- [ ] Generate progress content from real counts, for example `2/5 done, 2 running, 1 queued`.

**Validation:**

- Run: `bun test packages/pi-agents/tests/chain.test.ts`
- Expected: If item 3 finishes first, progress reports `1/N done`; queued/running states respect concurrency; all partial snapshots are cumulative and ordered; empty, truncated, failed, and cancelled fanouts retain correct metadata.

### Task 7: Implement Single and Parallel Rendering

**Outcome:** Single and Parallel match the compact Collapse and complete Expanded contracts.

**Files:**

- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/render.ts`
- Test: `packages/pi-agents/tests/render.test.ts`

**Steps:**

- [ ] Make `renderCall()` return a zero-line component so `subagent … [scope]` and its task preview are no longer visible.
- [ ] Add a shared execution-summary formatter for glyph, agent, truncated task preview, usage, model, and thinking.
- [ ] Map statuses consistently: queued to a muted waiting glyph, running to `⧗`, completed to `✔`, failed to `✗`, cancelled to `⊘`, and skipped to a muted skip glyph.
- [ ] Implement Single Collapse as one summary line, one optional latest line only while running or when needed to explain failure, and the expand hint.
- [ ] Do not render completed Single latest activity or final output in Collapse.
- [ ] Implement Single Expanded with full task, ordered transcript, one final output, error details, worktree retention details when present, structured-output validation details, and the terminal summary.
- [ ] Implement Parallel Collapse with one summary line per task, one latest line under each running task, aggregate progress/usage, and the expand hint.
- [ ] Do not show activity history under queued, completed, failed, cancelled, or skipped Parallel tasks.
- [ ] Implement Parallel Expanded for both running and terminal states; remove the current restriction that expanded layout only appears after all tasks finish.
- [ ] Preserve input task order in both layouts.
- [ ] Remove the old multi-item collapsed history and delete `COLLAPSED_ITEM_COUNT` if no remaining code uses it.
- [ ] Format aggregate context as `ctx:max N`; do not pass model or thinking to aggregate usage formatting.
- [ ] Add narrow-width tests that verify task preview truncates before status and usage fields are lost.

**Validation:**

- Run: `bun test packages/pi-agents/tests/render.test.ts`
- Expected: Collapsed layouts contain no call title, show no more than the allowed latest lines, completed Single output stays hidden until expansion, and aggregate usage excludes model/thinking.

### Task 8: Implement Sequential and Fanout Chain Rendering

**Outcome:** Chain output distinguishes logical steps from execution units and remains compact in Collapse while complete in Expanded.

**Files:**

- Modify: `packages/pi-agents/src/render.ts`
- Test: `packages/pi-agents/tests/render.test.ts`

**Steps:**

- [ ] Render sequential started steps in logical order with numbered summaries.
- [ ] Show one latest line only under the currently running sequential step.
- [ ] Omit queued future steps from Collapse; represent skipped count in the Chain footer after failure or cancellation.
- [ ] Render the Chain footer as current step, completed logical-step count, terminal failure/cancellation when applicable, and aggregate usage.
- [ ] Render a fanout as one numbered logical-step summary with actual done/running/queued/failed/skipped counts.
- [ ] Under a running fanout summary, show only the latest activity across all fanout items, prefixed with its one-based `[item/total]` identity.
- [ ] Do not list every fanout item in Collapse.
- [ ] In Expanded, render sequential and fanout logical steps in input order.
- [ ] For a sequential step, show full task, transcript, final output, error/worktree/structured-output details, and usage.
- [ ] For a fanout step, show expand source, pointer, task template, collect name, concurrency, skipped source count, and each executed item in original order.
- [ ] For each expanded fanout item, show rendered task, status, transcript, final output, error details, and usage.
- [ ] Show named collect completion as fanout metadata rather than an extra Chain step.
- [ ] Provide a compatibility fallback for older details without `chain` metadata, using existing `step` values without claiming queued/fanout counts that cannot be known.

**Validation:**

- Run: `bun test packages/pi-agents/tests/render.test.ts`
- Expected: Sequential Collapse shows latest only for the active step; fanout Collapse occupies one logical step plus one latest line; Expanded preserves every fanout item and collect metadata; progress uses logical Chain steps.

### Task 9: Update User Documentation and Run Full Validation

**Outcome:** User-facing documentation matches the implemented behavior and the package passes all validation.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/draft/render.md`

**Steps:**

- [ ] Document that collapsed output is intentionally a compact live summary and that `Ctrl+O` reveals the complete task and output.
- [ ] Document Parallel and Chain progress semantics, including fanout item counts and collect naming.
- [ ] Document aggregate usage semantics: token/turn fields are summed, context is the maximum execution-unit context, and model/thinking remain per execution unit.
- [ ] Ensure examples use the actual glyphs and contain no removed `subagent … [scope]` title.
- [ ] Run all package tests, type checking, build, lint, formatting, and diff whitespace validation.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: All package tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: The package bundles successfully.
- Run: `hk check`
- Expected: ESLint and Prettier pass for all modified files.
- Run: `git diff --check`
- Expected: No whitespace errors.

## Final Validation

- Run: `bun test packages/pi-agents/tests/output.test.ts packages/pi-agents/tests/execution.test.ts packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/render.test.ts`
- Expected: All focused output, state-transition, Chain, fanout, and rendering tests pass.
- Run: `mise run test --package packages/pi-agents && mise run typecheck --package packages/pi-agents && mise run build --package packages/pi-agents && hk check && git diff --check`
- Expected: The complete package and repository checks pass with no known regressions.
- Manual check: Run a long Single agent, an eight-task Parallel workflow, a three-step sequential Chain, and a Chain containing a fanout followed by a collecting step; toggle `Ctrl+O` while running and after completion.
- Expected: Collapse remains compact, Expanded retains complete output, task and fanout ordering remain stable, counts are accurate under out-of-order completion, and no timer-driven redraw occurs.

## Rollout Notes

- No configuration migration is required.
- New `SubagentDetails.chain` and result status fields must remain backward-compatible when loading older session details; the renderer must use the documented fallback.
- The visible tool output changes substantially, so the README and draft examples should ship in the same release.
- Do not commit generated build output unless it is already tracked by the repository.

## Risks and Mitigations

- **Fanout snapshots currently lose previously completed items during partial updates.** — Maintain ordered fanout slots and emit a complete cloned snapshot on every partial and terminal transition.
- **Fanout currently reports `index + 1` as completed count.** — Derive counts exclusively from explicit item statuses and test out-of-order completion.
- **A fanout creates many results but only one logical Chain step.** — Store logical progress separately in `SubagentDetails.chain` and never derive Chain progress from `results.length`.
- **Runtime partial objects are mutated in place.** — Clone result and message arrays at snapshot boundaries so earlier updates remain stable.
- **Expanded transcript may duplicate the last assistant response.** — Derive transcript and final output together and test exact de-duplication.
- **Long task preview and usage may wrap unpredictably.** — Use width-aware truncation with explicit priority and narrow-terminal tests.
- **Removing `renderCall` may leave spacing or an empty shell in Pi’s tool component.** — Use a zero-line component, inspect actual TUI output, and adjust only the renderer contract rather than Pi internals.
- **Cancellation currently may discard partial Chain state.** — Catch cancellation at the Chain workflow boundary, emit retained details, and mark current/later logical steps cancelled/skipped.
- **Explicit status fields affect many fixtures and runtime constructors.** — Introduce the type and update all constructors in one task, then run focused execution tests before rendering work.
- **Showing full Parallel output while running can update earlier task sections.** — Accept this only in Expanded mode; Collapse remains the stable, compact operational view.
