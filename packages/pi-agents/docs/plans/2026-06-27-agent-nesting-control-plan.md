# Agent Nesting Control Implementation Plan

**Goal:** Add explicit per-agent nesting control and keep tool availability, runtime guards, and injected agent-catalogue prompts consistent when an agent cannot spawn further agents.

**Inputs:** User request to plan an implementation for explicit “cannot spawn subagents” configuration, plus the design question about removing the `agent` tool and the `before_agent_start` injected prompt when further spawning is blocked.

**Assumptions:**

- Use `maxSubagentDepth` as the frontmatter field, matching the terminology used by `pi-subagents`, but define it locally as the maximum number of additional `agent` delegations allowed from inside the spawned agent.
- `maxSubagentDepth: 0` means the spawned agent may still run, but it cannot invoke the `agent` tool itself.
- Omitted `maxSubagentDepth` preserves the current global-depth behavior controlled by `PI_AGENT_MAX_DEPTH` with default `2`.
- The existing `tools` / `excludeTools` fields also remain authoritative: if an agent’s effective tool config cannot include `agent`, the catalogue prompt should not be injected either.

**Architecture:** Introduce a single security/capability path that decides whether the current process may invoke the `agent` tool. Child processes receive environment flags derived from depth, per-agent `maxSubagentDepth`, and effective tool config. The same decision is used to exclude the `agent` tool from child CLI args, reject direct runtime calls, and skip the `before_agent_start` catalogue injection.

**Tech Stack:** TypeScript, Bun test runner, Pi extension hooks, Pi CLI `--tools` / `--exclude-tools`, existing `mise run test --package packages/pi-agents` and `mise run typecheck --package packages/pi-agents` validation commands.

---

## Design Decision: remove the tool and the injected prompt?

Yes. If an agent cannot spawn further agents, the implementation should remove both the model-visible `agent` tool and the injected “Available agent types for the `agent` tool” prompt block.

Evidence from the current implementation:

- `packages/pi-agents/src/index.ts` injects the catalogue for every agent start whenever agents are discoverable, without checking whether the current process can actually use the `agent` tool.
- `packages/pi-agents/src/security.ts` currently rejects only at execution time via `assertDepthAllowed(process.env)`.
- `packages/pi-agents/src/invocation.ts` currently passes `tools` / `excludeTools` through, but has no logic to force-remove `agent` when the child is at its nesting limit.
- Built-in agents such as `explore` and `planner` already use `tools:` allowlists that do not include `agent`, so their current child prompts can advertise an unavailable tool.

Planned behavior:

1. If the child process cannot delegate, spawn it with `--exclude-tools agent` in addition to any existing tool flags.
2. Set an environment marker so the child extension can skip the catalogue injection.
3. Keep the runtime depth/capability guard as a backstop if the tool is invoked anyway.
4. Do not add a replacement prompt such as “do not use agents”; absence of the tool and absence of the catalogue are clearer and cheaper.

## File Map

- Modify: `packages/pi-agents/src/constants.ts` — add a child capability environment variable constant, for example `PI_AGENT_TOOL_AVAILABLE`.
- Modify: `packages/pi-agents/src/agents.ts` — parse `maxSubagentDepth` from agent markdown frontmatter as a non-negative integer and add it to `AgentConfig`.
- Modify: `packages/pi-agents/src/security.ts` — centralize depth capping, effective `agent` tool availability, child env construction, and forced `agent` tool exclusion.
- Modify: `packages/pi-agents/src/invocation.ts` — accept an option to disable the `agent` tool for a child and pass it into the tool CLI argument builder.
- Modify: `packages/pi-agents/src/execution.ts` — compute the child env before spawning, derive whether that child may delegate, and pass both the env and tool-disable option consistently.
- Modify: `packages/pi-agents/src/tool.ts` — replace the depth-only execution guard with the new capability guard so direct calls are blocked when `PI_AGENT_TOOL_AVAILABLE=0`.
- Modify: `packages/pi-agents/src/index.ts` — skip `before_agent_start` catalogue injection when the current process cannot invoke `agent`.
- Modify: `packages/pi-agents/agents/explore.md` — add `maxSubagentDepth: 0` to make the no-fanout intent explicit.
- Modify: `packages/pi-agents/agents/planner.md` — add `maxSubagentDepth: 0` to make the no-fanout intent explicit.
- Modify: `packages/pi-agents/agents/reviewer.md` — add `maxSubagentDepth: 0` alongside the existing `excludeTools: edit, write, agent`.
- Modify: `packages/pi-agents/README.md` — document `maxSubagentDepth`, prompt suppression, CLI tool removal, and examples.
- Test: `packages/pi-agents/tests/agents.test.ts` — cover frontmatter parsing and invalid values.
- Test: `packages/pi-agents/tests/security.test.ts` — cover child env capping, capability flags, and forced `agent` exclusion.
- Test: `packages/pi-agents/tests/invocation.test.ts` — cover `buildPiArgs(..., { disableAgentTool: true })` behavior.
- Test: `packages/pi-agents/tests/execution.test.ts` — cover spawned child env and args for `maxSubagentDepth: 0`.

## Tasks

### Task 1: Add `maxSubagentDepth` to agent discovery

**Outcome:** Agent markdown can declare `maxSubagentDepth: 0` or a positive integer, and invalid values are ignored.

**Files:**

- Modify: `packages/pi-agents/src/agents.ts`
- Test: `packages/pi-agents/tests/agents.test.ts`

**Steps:**

- [ ] Add `maxSubagentDepth?: number` to `AgentConfig`.
- [ ] Add a `parseNonNegativeInt(value: unknown): number | undefined` helper that accepts integer values `0`, `1`, `2`, etc. and rejects negative, fractional, blank, and non-numeric values.
- [ ] Set `maxSubagentDepth: parseNonNegativeInt(frontmatter.maxSubagentDepth)` in `loadAgentsFromDir()`.
- [ ] Extend the “parses all extended fields” test fixture with `maxSubagentDepth: 0` and assert `a!.maxSubagentDepth === 0`.
- [ ] Extend the invalid-value test fixture with `maxSubagentDepth: -1` and assert it is `undefined`.
- [ ] Add a dedicated case for string parsing, for example `maxSubagentDepth: "2"`, and assert it is parsed as `2`.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/agents.test.ts`
- Expected: all agent frontmatter parsing tests pass, including new `maxSubagentDepth` cases.

### Task 2: Centralize delegation capability checks

**Outcome:** A single helper path determines whether the current process can invoke `agent`, and child env construction can cap further delegation per agent.

**Files:**

- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/security.ts`
- Test: `packages/pi-agents/tests/security.test.ts`

**Steps:**

- [ ] Add `PI_AGENT_TOOL_AVAILABLE = 'PI_AGENT_TOOL_AVAILABLE'` to `constants.ts`.
- [ ] Add `isAgentToolName(name: string): boolean`, comparing trimmed lower-case names to `agent`.
- [ ] Add `agentToolAllowedByConfig(agent: AgentConfig): boolean` with these rules:
  - If `agent.excludeTools` contains `agent`, return `false`.
  - If `agent.tools` is defined and does not contain `agent`, return `false`.
  - Otherwise return `true`.
- [ ] Add `isAgentDelegationAllowed(env: EnvLike): boolean` with these rules:
  - If `env.PI_AGENT_TOOL_AVAILABLE === '0'`, return `false`.
  - Otherwise return `getCurrentAgentDepth(env) < getMaxAgentDepth(env)`.
- [ ] Replace or wrap `assertDepthAllowed()` with `assertAgentDelegationAllowed(env)`, preserving the existing depth error text for depth failures and returning a clear error for `PI_AGENT_TOOL_AVAILABLE=0`, such as `Agent tool is unavailable in this context`.
- [ ] Add `resolveChildMaxAgentDepth(parentEnv, childDepth, agentMaxSubagentDepth)`:
  - Start with the current parent max from `getMaxAgentDepth(parentEnv)`.
  - If `agentMaxSubagentDepth` is undefined, return the parent max.
  - Otherwise return `Math.min(parentMax, childDepth + agentMaxSubagentDepth)`.
- [ ] Change `buildChildAgentEnv(parentEnv, agent?)` to set `PI_AGENT_DEPTH`, `PI_AGENT_MAX_DEPTH`, `PI_AGENT_CHILD`, and `PI_AGENT_TOOL_AVAILABLE` using both depth and `agentToolAllowedByConfig(agent)`.
- [ ] Keep the current behavior that invalid `PI_AGENT_MAX_DEPTH` falls back to `DEFAULT_AGENT_MAX_DEPTH`; do not make global `PI_AGENT_MAX_DEPTH=0` valid in this task.
- [ ] Update existing `buildChildAgentEnv` tests to pass without an agent argument and still get depth `1`, max `2`, and `PI_AGENT_TOOL_AVAILABLE='1'`.
- [ ] Add tests for `maxSubagentDepth: 0`: parent env empty, child depth `1`, child max `1`, and `PI_AGENT_TOOL_AVAILABLE='0'`.
- [ ] Add tests for `maxSubagentDepth: 1`: parent env `PI_AGENT_MAX_DEPTH=5`, child depth `1`, child max `2`, and `PI_AGENT_TOOL_AVAILABLE='1'`.
- [ ] Add tests for `tools: ['read']`, `excludeTools: ['agent']`, and `tools: ['agent']` to verify the capability flag is `0`, `0`, and `1` respectively when depth permits.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/security.test.ts`
- Expected: all security helper tests pass; the new tests prove that per-agent max depth and tool config both control child capability.

### Task 3: Force-remove the `agent` tool from blocked children

**Outcome:** When a child cannot delegate, the spawned Pi CLI receives flags that remove the `agent` tool from model-visible tools.

**Files:**

- Modify: `packages/pi-agents/src/security.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Test: `packages/pi-agents/tests/security.test.ts`
- Test: `packages/pi-agents/tests/invocation.test.ts`

**Steps:**

- [ ] Change `buildToolCliArgs(agent)` to accept an options object: `buildToolCliArgs(agent, { disableAgentTool?: boolean } = {})`.
- [ ] When `disableAgentTool` is false or omitted, preserve current output exactly.
- [ ] When `disableAgentTool` is true, append `agent` to the effective `excludeTools` list if it is not already present.
- [ ] Do not remove `agent` from `tools`; rely on Pi’s existing allowlist-then-denylist behavior so `tools: agent` plus `excludeTools: agent` results in no usable `agent` tool instead of accidentally inheriting all tools.
- [ ] Change `BuildPiArgsOptions` to include `disableAgentTool?: boolean`.
- [ ] Pass the option from `buildPiArgs()` into `buildToolCliArgs()`.
- [ ] Add a security test that `buildToolCliArgs(makeAgent(), { disableAgentTool: true })` returns `['--exclude-tools', 'agent']`.
- [ ] Add a security test that existing `excludeTools: ['write', 'agent']` does not duplicate `agent`.
- [ ] Add an invocation test that `buildPiArgs(makeAgent({ tools: ['agent'] }), 'go', { disableAgentTool: true })` includes both `--tools agent` and `--exclude-tools agent`.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/security.test.ts tests/invocation.test.ts`
- Expected: all security and invocation tests pass, and existing CLI arg ordering remains stable except where `disableAgentTool` is explicitly enabled.

### Task 4: Wire capability into child spawning and runtime execution

**Outcome:** Child env, child CLI flags, and runtime execution guard all agree on whether delegation is allowed.

**Files:**

- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`

**Steps:**

- [ ] In `runSingleAgent()`, compute `const childEnv = buildChildAgentEnv(process.env, agent)` before building Pi args.
- [ ] Compute `const disableAgentTool = !isAgentDelegationAllowed(childEnv)`.
- [ ] Pass `disableAgentTool` to `buildPiArgs()`.
- [ ] Pass `childEnv` to `spawnFn(..., { env: childEnv, ... })` instead of calling `buildChildAgentEnv(process.env)` inline.
- [ ] In `executeAgentTool()`, replace `assertDepthAllowed(process.env)` with `assertAgentDelegationAllowed(process.env)`.
- [ ] Keep the returned error shape the same as today: `content` text, empty results, and `isError: true`.
- [ ] Extend the fake spawn in `execution.test.ts` or add a small capture helper so tests can inspect the spawn args and options.
- [ ] Add a test using `makeAgent({ maxSubagentDepth: 0 })` that asserts the child receives `PI_AGENT_DEPTH='1'`, `PI_AGENT_MAX_DEPTH='1'`, `PI_AGENT_TOOL_AVAILABLE='0'`, and args include `--exclude-tools agent`.
- [ ] Add a test using `makeAgent({ tools: ['read'] })` that asserts `PI_AGENT_TOOL_AVAILABLE='0'` and args include `--exclude-tools agent`.
- [ ] Add a test using `makeAgent({ tools: ['agent'] })` with default depth that asserts `PI_AGENT_TOOL_AVAILABLE='1'` and args do not include forced `--exclude-tools agent`.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/execution.test.ts`
- Expected: all execution tests pass; new tests prove that spawn env and CLI args are consistent.

### Task 5: Suppress the injected agent catalogue when unavailable

**Outcome:** Agents that cannot delegate no longer receive the `before_agent_start` “Available agent types” block.

**Files:**

- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/security.test.ts` or a new focused test if hook logic is extracted

**Steps:**

- [ ] Import `isAgentDelegationAllowed` from `security.ts` into `index.ts`.
- [ ] At the start of the `before_agent_start` handler, return without modification when `!isAgentDelegationAllowed(process.env)`.
- [ ] Keep discovery and catalogue construction unchanged when delegation is allowed.
- [ ] If direct testing of the extension hook is awkward, extract a pure helper such as `shouldInjectAgentCatalogue(env)` and test that helper with depth-allowed, depth-blocked, and `PI_AGENT_TOOL_AVAILABLE='0'` env inputs.
- [ ] Do not inject a replacement warning prompt.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/security.test.ts`
- Expected: helper tests prove catalogue injection is skipped for unavailable delegation contexts.

### Task 6: Mark bundled no-fanout agents explicitly

**Outcome:** Built-in read/planning/review agents declare that they should not spawn nested agents.

**Files:**

- Modify: `packages/pi-agents/agents/explore.md`
- Modify: `packages/pi-agents/agents/planner.md`
- Modify: `packages/pi-agents/agents/reviewer.md`

**Steps:**

- [ ] Add `maxSubagentDepth: 0` to `explore.md` frontmatter.
- [ ] Add `maxSubagentDepth: 0` to `planner.md` frontmatter.
- [ ] Add `maxSubagentDepth: 0` to `reviewer.md` frontmatter.
- [ ] Leave `worker.md` unchanged so it preserves the current default behavior and can delegate until the global depth limit is reached.
- [ ] Do not change `tools` / `excludeTools` for these agents in this task; the new field documents and reinforces the intended behavior without broadening or narrowing unrelated tools.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/agents.test.ts`
- Expected: built-in agent discovery still succeeds and no frontmatter parsing tests regress.

### Task 7: Update README documentation

**Outcome:** Users can understand how per-agent nesting control works and when prompts/tools are suppressed.

**Files:**

- Modify: `packages/pi-agents/README.md`

**Steps:**

- [ ] Update “Nested Agents and Depth Guard” to explain both global `PI_AGENT_MAX_DEPTH` and per-agent `maxSubagentDepth`.
- [ ] Document the local semantics: `maxSubagentDepth` counts additional nested `agent` calls allowed from inside the spawned agent; `0` means no further delegation.
- [ ] Document that if delegation is unavailable because of depth, `tools`, `excludeTools`, or `maxSubagentDepth`, the child is spawned with `agent` excluded and the catalogue prompt is not injected.
- [ ] Add `maxSubagentDepth: 0` to the frontmatter example.
- [ ] Add `maxSubagentDepth` to the frontmatter fields table.
- [ ] Update the bundled agents table to note that `explore`, `planner`, and `reviewer` cannot spawn nested agents, while `worker` follows the global depth limit.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: typecheck passes after README-adjacent code changes.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: all package tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript typecheck passes with no errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: package builds successfully.
- Optional repo-wide check if time permits: `hk check`
- Expected: eslint and prettier pass repo-wide.

## Rollout Notes

- This is backward-compatible for agents that omit `maxSubagentDepth`; they keep the current global depth behavior.
- Built-in `explore`, `planner`, and `reviewer` become explicitly no-fanout agents, matching their current practical tool restrictions.
- Existing user/project agents that rely on nested delegation should either omit `maxSubagentDepth` or set it to a positive value.
- Existing user/project agents with `tools` allowlists that omit `agent` will now stop receiving the injected agent catalogue, which is a behavior improvement but can change model-visible prompt text.

## Risks and Mitigations

- Risk: The new `maxSubagentDepth` semantics could be confused with absolute `PI_AGENT_MAX_DEPTH` semantics. — Mitigation: README examples must state that the field controls additional delegation levels from inside the spawned agent; tests should encode `maxSubagentDepth: 0` as child depth `1`, child max `1`.
- Risk: Tool availability and prompt injection could drift if they use separate logic. — Mitigation: both should call `isAgentDelegationAllowed(env)` and use the child env generated by `buildChildAgentEnv()`.
- Risk: Forcing `--exclude-tools agent` could interact unexpectedly with `tools: agent`. — Mitigation: keep the allowlist unchanged and add denylist `agent`, relying on the documented allowlist-then-denylist behavior already described in the README.
- Risk: Direct hook testing may be difficult through the Pi extension API. — Mitigation: extract pure helpers for availability and prompt-injection decisions and cover them with unit tests.
