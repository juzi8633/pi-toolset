# Pi Agents Optimization Implementation Plan

**Goal:** Refactor `@balaenis/pi-agents` into focused modules and incrementally add safer, more capable subagent patterns inspired by `pi-subagents` and Claude Code.

**Inputs:** User request from 2026-06-26; local files `packages/pi-agents/src/index.ts`, `packages/pi-agents/src/agents.ts`, `packages/pi-agents/agents/*.md`, `packages/pi-agents/prompts/*.md`, and `packages/pi-agents/README.md`; exploration findings from `/home/julian/workspace/source/pi-subagents` and `/home/julian/workspace/source/claude-code-2.1.88/package-src/src`; Pi CLI evidence from `@earendil-works/pi-coding-agent` showing support for `--tools`, `--exclude-tools`, `--append-system-prompt`, `--system-prompt`, `--no-context-files`, `--no-skills`, `--session`, `--fork`, and no `--max-turns` flag.

**Assumptions:**

- Keep `pi-agents` lightweight: do not implement Claude Code style persistent teammates, remote agents, background lifecycle, or full coordinator mode in this plan.
- Keep current behavior as the default: fresh `pi --mode json -p --no-session` subprocesses, user-scoped agents by default, project agents opt-in with confirmation, and single/parallel/chain modes.
- Implement `maxTurns` in the `pi-agents` execution layer by counting assistant `message_end` events and terminating the child process when the configured turn budget is exceeded, because Pi CLI currently has no `--max-turns` option.
- Implement forked context through `ctx.sessionManager.createBranchedSession(ctx.sessionManager.getLeafId())` and spawn the child with `--session <branched-session-file>` instead of `--no-session`.
- Generated code files must start with one `ABOUTME:` comment line and should keep comments minimal.

**Architecture:** Split the current monolithic `src/index.ts` into discovery, schemas, execution, rendering, output, security, context, and workflow modules while preserving the public extension entrypoint. After the refactor, add frontmatter-driven capabilities in small layers: tool denial and depth guards, context inheritance controls, optional fork context, optional worktree isolation, completion checks, and structured chain output templates. Each phase should be independently testable and should update `README.md` when user-facing configuration or behavior changes.

**Tech Stack:** TypeScript, Bun test runner, Node `child_process`/`fs`/`os`/`path`, Pi extension API, TypeBox via `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, git worktree, `mise` tasks.

---

## File Map

- Modify: `packages/pi-agents/src/index.ts` — reduce to extension wiring: `before_agent_start`, tool registration, and exports from focused modules.
- Modify: `packages/pi-agents/src/agents.ts` — keep agent discovery here, then extend frontmatter parsing and normalization for new agent fields.
- Create: `packages/pi-agents/src/constants.ts` — shared limits, environment variable names, tool policy constants, and output caps.
- Create: `packages/pi-agents/src/types.ts` — shared runtime types such as `UsageStats`, `SingleResult`, `SubagentDetails`, execution modes, and extended `AgentConfig` helper types.
- Create: `packages/pi-agents/src/output.ts` — output extraction, failure detection, byte-safe truncation, display item extraction, token/usage formatting.
- Create: `packages/pi-agents/src/schema.ts` — TypeBox parameter schemas for single, parallel, chain, scope, context, and isolation parameters.
- Create: `packages/pi-agents/src/invocation.ts` — Pi command resolution, CLI argument construction, prompt temp-file management, and environment construction.
- Create: `packages/pi-agents/src/execution.ts` — `runSingleAgent`, concurrency-limited parallel execution, chain execution, updates, abort handling, and local `maxTurns` enforcement.
- Create: `packages/pi-agents/src/tool.ts` — tool execution orchestration, mode validation, project-agent confirmation, and result assembly.
- Create: `packages/pi-agents/src/render.ts` — `renderCall`, `renderResult`, and tool-call formatting for TUI output.
- Create: `packages/pi-agents/src/security.ts` — tool allow/deny merging, nested-agent depth checks, and project-agent trust helpers.
- Create: `packages/pi-agents/src/context.ts` — fresh/fork context strategy resolution and session file preparation.
- Create: `packages/pi-agents/src/worktree.ts` — optional git worktree creation, dirty-state detection, cleanup, and result details.
- Create: `packages/pi-agents/src/completion-check.ts` — output contract checks for agents with mutating capabilities.
- Create: `packages/pi-agents/src/template.ts` — chain placeholder expansion for `{previous}` and `{outputs.name}`.
- Create: `packages/pi-agents/tests/agents.test.ts` — frontmatter parsing, discovery precedence, and config normalization coverage.
- Create: `packages/pi-agents/tests/output.test.ts` — output helper and byte-safe truncation coverage.
- Create: `packages/pi-agents/tests/invocation.test.ts` — CLI argument and environment construction coverage.
- Create: `packages/pi-agents/tests/security.test.ts` — tool denylist and nested-depth guard coverage.
- Create: `packages/pi-agents/tests/template.test.ts` — chain placeholder replacement coverage.
- Create: `packages/pi-agents/tests/completion-check.test.ts` — output contract validation coverage.
- Create: `packages/pi-agents/tests/worktree.test.ts` — optional git worktree lifecycle coverage using a temporary repository.
- Modify: `packages/pi-agents/agents/reviewer.md` — align reviewer configuration with enforced read-only behavior.
- Modify: `packages/pi-agents/agents/worker.md` — require validation reporting for completion-check compatibility.
- Modify: `packages/pi-agents/prompts/implement.md` — document new acceptance expectations in the chain workflow.
- Modify: `packages/pi-agents/prompts/implement-and-review.md` — require reviewer findings to gate the final worker step.
- Modify: `packages/pi-agents/prompts/explore-and-plan.md` — keep plan-only behavior explicit under the refactored chain engine.
- Modify: `packages/pi-agents/README.md` — document new frontmatter fields, isolation options, depth guard behavior, worktree behavior, context modes, and validation expectations.

## Tasks

### Task 1: Extract stable runtime types, constants, and output helpers

**Outcome:** Pure formatting and result helper logic moves out of `index.ts` with no behavior change.

**Files:**

- Create: `packages/pi-agents/src/constants.ts`
- Create: `packages/pi-agents/src/types.ts`
- Create: `packages/pi-agents/src/output.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Create: `packages/pi-agents/tests/output.test.ts`

**Steps:**

- [x] Move `MAX_PARALLEL_TASKS`, `MAX_CONCURRENCY`, `COLLAPSED_ITEM_COUNT`, and `PER_TASK_OUTPUT_CAP` from `index.ts` into `constants.ts`.
- [x] Move `UsageStats`, `SingleResult`, `SubagentDetails`, and `DisplayItem` from `index.ts` into `types.ts`.
- [x] Move `formatTokens`, `formatUsageStats`, `getFinalOutput`, `isFailedResult`, `getResultOutput`, `truncateParallelOutput`, and `getDisplayItems` into `output.ts`.
- [x] Export all moved helpers with the same behavior and import them from `index.ts`.
- [x] Add an output test that `formatTokens(999)` returns `"999"`, `formatTokens(1500)` returns `"1.5k"`, and `formatTokens(1500000)` returns `"1.5M"`.
- [x] Add an output test that `getFinalOutput()` returns the last assistant text part from a message list and returns an empty string when no assistant text exists.
- [x] Add an output test that `truncateParallelOutput()` preserves strings under `PER_TASK_OUTPUT_CAP` and appends `"[Output truncated:"` for strings over the cap without exceeding the cap before the truncation notice.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: the new output tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.

### Task 2: Extract schemas, rendering, and tool-call formatting

**Outcome:** Parameter schemas and TUI rendering are isolated from execution logic, leaving `index.ts` closer to a thin extension entrypoint.

**Files:**

- Create: `packages/pi-agents/src/schema.ts`
- Create: `packages/pi-agents/src/render.ts`
- Modify: `packages/pi-agents/src/index.ts`

**Steps:**

- [x] Move `TaskItem`, `ChainItem`, `AgentScopeSchema`, and `SubagentParams` into `schema.ts`.
- [x] Export a `SubagentParams` schema value from `schema.ts` and import it in `index.ts` for `pi.registerTool({ parameters })`.
- [x] Move `formatToolCall`, `renderCall`, and `renderResult` into `render.ts`.
- [x] Export `renderCall` and `renderResult` functions that accept the same arguments currently received by `pi.registerTool` render callbacks.
- [x] Replace inline `renderCall(args, theme) { ... }` and `renderResult(result, options, theme) { ... }` in `index.ts` with references to the exported render functions.
- [x] Keep `getMarkdownTheme`, `Container`, `Markdown`, `Spacer`, and `Text` imports inside `render.ts`, not `index.ts`.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: Bun builds `dist/index.js` successfully.

### Task 3: Extract invocation and subprocess execution

**Outcome:** Child process invocation and JSON event handling live in testable modules, with no user-visible behavior change.

**Files:**

- Create: `packages/pi-agents/src/invocation.ts`
- Create: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Create: `packages/pi-agents/tests/invocation.test.ts`

**Steps:**

- [x] Move `writePromptToTempFile()` and `getPiInvocation()` into `invocation.ts`.
- [x] Add `buildPiArgs(agent, task, options)` in `invocation.ts` that returns the same arguments currently assembled in `runSingleAgent`: `--mode json -p --no-session`, optional `--model`, optional `--thinking`, optional `--tools`, optional `--append-system-prompt`, then `Task: <task>`.
- [x] Move `mapWithConcurrencyLimit()` and `runSingleAgent()` into `execution.ts`.
- [x] In `execution.ts`, keep the JSON event parsing behavior unchanged: process `message_end` events, process `tool_result_end` events, accumulate stderr, usage, model, stop reason, and error message.
- [x] Add an invocation test where an agent with `model`, `thinking`, `tools`, and a non-empty system prompt produces args containing `--model`, `--thinking`, `--tools`, `--append-system-prompt`, and `Task: <task>` in the same order as the current implementation.
- [x] Add an invocation test where an agent with no tools omits `--tools`.
- [x] Add an invocation test where `getPiInvocation()` returns `pi` when `process.execPath` is a generic runtime and the current script is not a real file.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: invocation tests pass and no existing behavior changes.
- Run: `mise run build --package packages/pi-agents`
- Expected: Bun builds successfully.

### Task 4: Extract tool orchestration and finish the `index.ts` refactor

**Outcome:** `index.ts` only registers the extension hook and the `agent` tool; mode validation, confirmations, chain, parallel, and single orchestration move to `tool.ts`.

**Files:**

- Create: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/index.ts`

**Steps:**

- [x] Move the body of `execute()` from `index.ts` into `executeAgentTool(params, signal, onUpdate, ctx)` in `tool.ts`.
- [x] Move mode detection (`hasChain`, `hasTasks`, `hasSingle`, `modeCount`) into `tool.ts`.
- [x] Move project-agent confirmation logic into `tool.ts` without changing the prompt title or message.
- [x] Move single, parallel, and chain result assembly into `tool.ts`.
- [x] Keep `pi.on('before_agent_start', ...)` and `pi.registerTool(...)` in `index.ts`.
- [x] Ensure `index.ts` imports `SubagentParams` from `schema.ts`, `executeAgentTool` from `tool.ts`, and render callbacks from `render.ts`.
- [x] Check that `index.ts` remains below 120 lines after formatting.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: Bun builds successfully.

### Task 5: Extend agent frontmatter parsing and README documentation

**Outcome:** Agent definitions can declare incremental behavior controls while old agent files continue to load unchanged.

**Files:**

- Modify: `packages/pi-agents/src/agents.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Create: `packages/pi-agents/tests/agents.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] Add these optional fields to `AgentConfig`: `excludeTools?: string[]`, `systemPromptMode?: 'append' | 'replace'`, `maxTurns?: number`, `noContextFiles?: boolean`, `noSkills?: boolean`, `defaultContext?: 'fresh' | 'fork'`, `isolation?: 'none' | 'worktree'`, and `completionCheck?: boolean`. Field names that map directly onto Pi CLI flags must match the flag name in camelCase (`--exclude-tools` → `excludeTools`, `--no-context-files` → `noContextFiles`, `--no-skills` → `noSkills`).
- [x] Parse `excludeTools` as a comma-separated list with trimming and empty-item removal.
- [x] Parse `systemPromptMode`; accept only `append` or `replace`; default to `append` when omitted.
- [x] Parse `maxTurns` as a positive integer; ignore invalid values and leave it undefined.
- [x] Parse `noContextFiles`, `noSkills`, and `completionCheck` from `true` or `false`; default `noContextFiles` and `noSkills` to `false` (inherit by default), and leave `completionCheck` undefined when omitted.
- [x] Parse `defaultContext`; accept only `fresh` or `fork`; default to `fresh`.
- [x] Parse `isolation`; accept only `none` or `worktree`; default to `none`.
- [x] Add an agents test where a markdown file containing all new fields normalizes to the expected `AgentConfig` values.
- [x] Add an agents test where invalid enum and integer values are ignored or defaulted exactly as described above.
- [x] Add README documentation for every new frontmatter field with a complete markdown example.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: agent parsing tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.

### Task 6: Enforce tool denylist and nested-agent depth guard

**Outcome:** Agent tool permissions become explicit and recursive agent spawning is bounded.

**Files:**

- Create: `packages/pi-agents/src/security.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/agents/reviewer.md`
- Create: `packages/pi-agents/tests/security.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] Add `PI_AGENT_CHILD`, `PI_AGENT_DEPTH`, and `PI_AGENT_MAX_DEPTH` constants to `constants.ts`.
- [x] Add `getCurrentAgentDepth(env)` in `security.ts`; it reads `PI_AGENT_DEPTH`, treats missing or invalid values as `0`, and returns a non-negative integer.
- [x] Add `assertDepthAllowed(env)` in `security.ts`; it reads `PI_AGENT_MAX_DEPTH`, defaults to `2`, and throws `Agent nesting depth exceeded: <depth>/<max>` when `depth >= max`.
- [x] Call `assertDepthAllowed(process.env)` at the start of `executeAgentTool()` before agent discovery.
- [x] Add `buildChildAgentEnv(parentEnv)` in `security.ts`; it sets `PI_AGENT_CHILD=1`, increments `PI_AGENT_DEPTH` by one, and preserves an existing valid `PI_AGENT_MAX_DEPTH` or sets it to `2`.
- [x] Pass the child environment to `spawn()` in `execution.ts`.
- [x] Add `buildToolCliArgs(agent)` in `security.ts`; it returns `--tools <tools>` when `agent.tools` is non-empty and `--exclude-tools <excludeTools>` when `agent.excludeTools` is non-empty.
- [x] Update `buildPiArgs()` to use `buildToolCliArgs(agent)` instead of appending only `--tools`.
- [x] Update `packages/pi-agents/agents/reviewer.md` frontmatter to include `excludeTools: edit, write, agent` while keeping `bash` available for read-only git commands.
- [x] Add a security test that missing depth env allows execution and produces child depth `1`.
- [x] Add a security test that `PI_AGENT_DEPTH=2` and `PI_AGENT_MAX_DEPTH=2` throws `Agent nesting depth exceeded: 2/2`.
- [x] Add a security test that an agent with `tools: read, bash` and `excludeTools: write, edit` produces both `--tools read,bash` and `--exclude-tools write,edit`.
- [x] Document depth guard behavior and `excludeTools` in README.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: security tests pass.
- Run: `mise run build --package packages/pi-agents`
- Expected: Bun builds successfully.

### Task 7: Add context inheritance controls and local `maxTurns`

**Outcome:** Read-only agents can avoid unnecessary project context/skills, and long-running child agents can be bounded per agent.

**Files:**

- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/agents/explore.md`
- Modify: `packages/pi-agents/agents/planner.md`
- Create or modify: `packages/pi-agents/tests/invocation.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] In `buildPiArgs()`, when `agent.systemPromptMode === 'replace'`, pass `--system-prompt <tmpPromptPath>` instead of `--append-system-prompt <tmpPromptPath>`.
- [x] In `buildPiArgs()`, when `agent.noContextFiles === true`, append `--no-context-files`.
- [x] In `buildPiArgs()`, when `agent.noSkills === true`, append `--no-skills`.
- [x] In `execution.ts`, after each assistant `message_end`, increment `currentResult.usage.turns` exactly once as currently done.
- [x] In `execution.ts`, if `agent.maxTurns` is set and `currentResult.usage.turns >= agent.maxTurns`, set `currentResult.stopReason = 'max_turns'`, set `currentResult.errorMessage = 'Agent exceeded maxTurns=<value>'`, terminate the child process with `SIGTERM`, and return exit code `1` if the process does not exit cleanly.
- [x] Update `explore.md` frontmatter to set `noSkills: true` and `maxTurns: 8`.
- [x] Update `planner.md` frontmatter to set `noSkills: true` and `maxTurns: 8`.
- [x] Add an invocation test where `systemPromptMode: replace` uses `--system-prompt` and does not include `--append-system-prompt`.
- [x] Add an invocation test where `noContextFiles: true` adds `--no-context-files`.
- [x] Add an invocation test where `noSkills: true` adds `--no-skills`.
- [x] Add a subprocess execution test with an injected fake child process stream that emits two assistant `message_end` events for an agent with `maxTurns: 1`; expected result has `stopReason: 'max_turns'` and an error message containing `maxTurns=1`.
- [x] Document `systemPromptMode`, `noContextFiles`, `noSkills`, and `maxTurns` in README.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: invocation and max-turn tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.

### Task 8: Add fresh/fork context strategy

**Outcome:** Agents can optionally inherit the parent session branch while fresh isolated execution remains the default.

**Files:**

- Create: `packages/pi-agents/src/context.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Create or modify: `packages/pi-agents/tests/invocation.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] Add `prepareAgentContext(agent, ctx)` in `context.ts`.
- [x] For `agent.defaultContext === 'fresh'`, return `{ mode: 'fresh', sessionFile: undefined, cleanup: async () => {} }`.
- [x] For `agent.defaultContext === 'fork'`, read `const leafId = ctx.sessionManager.getLeafId()`.
- [x] If `leafId` is missing for `fork`, throw `Cannot fork parent context: current session has no leaf entry`.
- [x] Open the parent session file with `SessionManager.open(parentSessionFile, getSessionDir?.())` and call `createBranchedSession(leafId)` on the opened manager (the readonly `ctx.sessionManager` does not expose this method; pattern borrowed from `pi-subagents/src/shared/fork-context.ts`).
- [x] If `createBranchedSession()` returns undefined, throw `Cannot fork parent context: parent session is not persisted`.
- [x] In `buildPiArgs()`, use `--session <sessionFile>` when a fork session file is provided; otherwise use `--no-session`.
- [x] Ensure fork child sessions do not overwrite the parent session file by always using the branched file returned by `createBranchedSession()`.
- [x] Add an invocation test where fresh context includes `--no-session`.
- [x] Add an invocation test where fork context includes `--session /tmp/fork.jsonl` and omits `--no-session`.
- [x] Add a context test that successfully forks a real `SessionManager` and returns a populated `sessionFile`.
- [x] Document `defaultContext: fresh | fork`, the persisted-session requirement, the explicit error messages, and the `stopReason: context_error` classification in README.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: context strategy tests pass.
- Run: `mise run build --package packages/pi-agents`
- Expected: Bun builds successfully.

### Task 9: Add optional git worktree isolation

**Outcome:** Mutating agents can run in isolated git worktrees to reduce parallel edit conflicts.

**Files:**

- Create: `packages/pi-agents/src/worktree.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/schema.ts`
- Create: `packages/pi-agents/tests/worktree.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] Extend `TaskItem`, `ChainItem`, and single-mode params with optional `isolation: 'none' | 'worktree'` where task-level isolation overrides agent frontmatter isolation.
- [x] Add `resolveIsolation(agent, params)` that returns task-level isolation when provided, otherwise `agent.isolation`, otherwise `none`.
- [x] Add `getGitRoot(cwd)` in `worktree.ts`; run `git -C <cwd> rev-parse --show-toplevel` and return the trimmed path.
- [x] If worktree isolation is requested and `getGitRoot()` fails, return an agent error result with `stderr: 'Worktree isolation requires a git repository.'`.
- [x] Add `createAgentWorktree(repoRoot, agentName, index)` that creates `.worktrees/pi-agent-<safe-agent-name>-<timestamp>-<index>` under the repo root using `git -C <repoRoot> worktree add --detach <path> HEAD`.
- [x] Run the child process with `cwd` set to the worktree path when worktree isolation is active.
- [x] Add `getWorktreeDirtyStatus(worktreePath)` that runs `git -C <worktreePath> status --porcelain`.
- [x] After the child exits, if dirty status is empty, remove the worktree with `git -C <repoRoot> worktree remove <worktreePath> --force` and delete the directory if it remains.
- [x] After the child exits, if dirty status is non-empty, keep the worktree and add `worktreePath` plus `worktreeDirty: true` to `SingleResult`.
- [x] Add a worktree test using a temporary git repository where an unchanged worktree is removed after cleanup.
- [x] Add a worktree test using a temporary git repository where a modified file causes the worktree to be kept and reported.
- [x] Document `isolation: worktree`, task-level override, cleanup behavior, and retained-worktree path reporting in README.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: worktree tests pass on a machine with `git` available; if `git` is unavailable, tests skip with a clear message.
- Run: `mise run build --package packages/pi-agents`
- Expected: Bun builds successfully.

### Task 10: Add completion check for mutating agents

**Outcome:** Agents with mutating capability must produce a usable handoff summary and validation status before being treated as successful.

**Files:**

- Create: `packages/pi-agents/src/completion-check.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/agents/worker.md`
- Create: `packages/pi-agents/tests/completion-check.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] Add `agentCanMutate(agent)` in `completion-check.ts`; return true when `agent.tools` is undefined, or when `agent.tools` includes `edit`, `write`, or `bash` and those tools are not excluded by `excludeTools`.
- [x] Add `isCompletionCheckEnabled(agent)`; return whether `agent.completionCheck` is set and non-empty.
- [x] Add `validateCompletionOutput(agent, output)`; when no headings are configured return success.
- [x] When headings are configured, require the final output to contain each heading as an exact line.
- [x] If required headings are missing, mark the result failed by setting `stopReason = 'completion_check'`, `errorMessage = 'Completion check failed: missing <headings>'`, and `exitCode = 1`.
- [x] Update `worker.md` output format to include `## Validation` with either commands run and pass/fail results or `Not run: <specific reason>`.
- [x] Add a completion-check test where a mutating worker output missing `## Validation` fails with `completion_check`.
- [x] Add a completion-check test where a reviewer with `excludeTools: edit, write, agent` and explicit `completionCheck: false` is not checked.
- [x] Add a completion-check test where valid worker output passes.
- [x] Document completion check defaults, required headings, and opt-out behavior in README.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: completion-check tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.

### Task 11: Add named chain outputs and safer template expansion

**Outcome:** Chain workflows can reference earlier named outputs instead of relying only on the immediately previous result.

**Files:**

- Create: `packages/pi-agents/src/template.ts`
- Modify: `packages/pi-agents/src/schema.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Create: `packages/pi-agents/tests/template.test.ts`
- Modify: `packages/pi-agents/prompts/implement.md`
- Modify: `packages/pi-agents/prompts/implement-and-review.md`
- Modify: `packages/pi-agents/prompts/explore-and-plan.md`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] Extend `ChainItem` with optional `name: string`.
- [x] Add `renderTaskTemplate(template, context)` in `template.ts`.
- [x] Replace every `{previous}` with the prior successful step output.
- [x] Replace every `{outputs.<name>}` with the output stored for a previous chain step whose `name` equals `<name>`.
- [x] If a template references an unknown `{outputs.<name>}`, stop the chain before spawning the step and return an error result with `Unknown chain output: <name>`.
- [x] Store named outputs only after a step succeeds.
- [x] Add a template test where `{previous}` and `{outputs.plan}` are both replaced.
- [x] Add a template test where `{outputs.missing}` returns the unknown-output error.
- [x] Update `/implement` to name the explore step `context`, the planner step `plan`, and the worker step to reference `{outputs.plan}`.
- [x] Update `/implement-and-review` to name the first worker step `implementation`, reviewer step `review`, and final worker step to reference `{outputs.review}`.
- [x] Update README chain examples to show `name` and `{outputs.name}`.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: template and chain tests pass.
- Run: `mise run build --package packages/pi-agents`
- Expected: Bun builds successfully.

### Task 12: Add workflow acceptance guidance without implementing full coordinator mode

**Outcome:** Built-in prompts guide agents through explore-plan-implement-review loops with explicit validation and review gates, without adding persistent coordinator infrastructure.

**Files:**

- Modify: `packages/pi-agents/prompts/implement.md`
- Modify: `packages/pi-agents/prompts/implement-and-review.md`
- Modify: `packages/pi-agents/prompts/explore-and-plan.md`
- Modify: `packages/pi-agents/agents/reviewer.md`
- Modify: `packages/pi-agents/agents/worker.md`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] Update `/implement` prompt to require the worker final output to include `## Completed`, `## Files Changed`, and `## Validation`.
- [x] Update `/implement-and-review` prompt so the final worker step must address every reviewer item under `## Critical (must fix)` and report remaining warnings separately.
- [x] Update `/implement-and-review` prompt so if the reviewer reports any Critical item that cannot be fixed safely, the final worker stops and reports the blocker instead of pretending completion.
- [x] Update `/explore-and-plan` prompt to state that no files should be modified and no worker should be invoked.
- [x] Update `reviewer.md` to explicitly classify an empty Critical section as `## Critical (must fix)\n- None.`.
- [x] Update `worker.md` to include validation command output or a precise reason validation was skipped.
- [x] Document these workflow acceptance expectations in README under Workflow Prompts.

**Validation:**

- Run: `mise run build --package packages/pi-agents`
- Expected: package builds successfully after markdown/package inclusion changes.
- Run: `hk check`
- Expected: eslint and prettier checks pass for the repository.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: all `pi-agents` tests pass, including output, agent parsing, invocation, security, template, completion check, and worktree tests.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: Bun builds `packages/pi-agents/dist/index.js` successfully with peer dependencies externalized.
- Run: `hk check`
- Expected: repo-wide eslint and prettier checks pass.

## Rollout Notes

- This plan preserves current defaults, so existing user agents should keep working unless they opt into new fields.
- `excludeTools`, `noContextFiles`, `noSkills`, `defaultContext`, `isolation`, and `completionCheck` are user-facing configuration options and must be documented in `packages/pi-agents/README.md` in the same change that implements them.
- Worktree isolation creates paths under `<repo>/.worktrees/`; dirty worktrees are intentionally retained and must be surfaced in tool details so the parent agent can inspect or merge them.
- Fork context requires a persisted parent session. In `--no-session` parent runs, fork mode must fail with the explicit persisted-session error rather than silently falling back to fresh context.
- The plan intentionally excludes background agents, remote agents, dynamic fan-out, and persistent teammate/coordinator mode; those can be planned later after the core tool is modular and guarded.

## Risks and Mitigations

- Refactor regression in the monolithic `index.ts` behavior — Mitigate by moving code in pure extraction tasks first, adding tests for helpers before changing runtime semantics, and running build/typecheck after each phase.
- Tool-name casing mismatch between frontmatter and Pi CLI — Mitigate by preserving current lowercase built-in tool names in bundled agents and documenting that names are passed to Pi CLI exactly after trimming.
- `maxTurns` termination could drop the final buffered JSON line — Mitigate by processing any remaining stdout buffer in the `close` handler before returning the result.
- Fork context could mutate the parent session if the wrong session file is passed — Mitigate by using only the file returned from `createBranchedSession()` and never passing the parent `ctx.sessionManager.getSessionFile()` directly.
- Worktree cleanup could remove useful changes — Mitigate by checking `git status --porcelain` before cleanup and only removing clean worktrees.
- Completion check could reject valid non-standard outputs — Mitigate by making it default only for mutating agents and allowing `completionCheck: false` for specialized agents.
- README drift from implemented behavior — Mitigate by requiring README updates in the same task that adds each user-facing field.
