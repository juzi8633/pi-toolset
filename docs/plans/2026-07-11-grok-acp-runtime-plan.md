# Grok ACP Runtime Implementation Plan

**Goal:** Add `runtime: grok-acp` as an ACP-based Grok execution path with structured messages, tool calls, usage, authentication, and cancellation while preserving the existing `runtime: grok` streaming-json implementation unchanged.

**Inputs:** User requirement to add an explicit `grok-acp` runtime; official xAI ACP/headless documentation; ACP v1 protocol documentation; empirical Grok 0.2.93 ACP probe results; existing `pi-agents` Grok runtime implementation.

**Assumptions:**

- `runtime: grok` remains the existing `grok -p --output-format streaming-json` path with its current flags, parser, `maxTurns` behavior, warnings, and tests.
- `runtime: grok-acp` uses `grok agent ... stdio` and does not silently fall back to `runtime: grok` when ACP initialization or execution fails.
- `maxTurns` is intentionally ignored in `grok-acp`: it is not sent to Grok, is not enforced client-side, does not trigger cancellation, and does not add a warning or error.
- `grok-acp` keeps the existing Grok runtime treatment of pi-specific `skills` and forked pi context: pi skills are ignored with the existing warning, and `defaultContext: fork` is treated as fresh with the existing warning.
- The initial implementation advertises no ACP client filesystem or terminal capabilities because Grok 0.2.93 can execute its own built-in tools and report them through ACP; this avoids implementing client-side filesystem and terminal RPC methods.
- The implementation uses the official `@agentclientprotocol/sdk` package (current verified version: `1.2.1`) for ACP framing, typed standard methods, request matching, and connection lifecycle. Grok-specific `x.ai/*` extensions remain optional and are handled through tolerant extension/unknown-notification paths rather than replacing the SDK transport.

**Architecture:** Add a third runtime constant and route it to a dedicated ACP stack. `grok-acp-invocation.ts` builds the long-lived agent command, environment, and ACP initialization/session payloads; `grok-acp-client.ts` adapts child-process streams to SDK `ndJsonStream` and owns the typed ACP lifecycle; `grok-acp-parser.ts` maps structured ACP updates and prompt completion metadata into existing `Message` and `SingleResult` shapes. `execution.ts` remains the orchestration boundary and delegates only `grok-acp` runs to the new stack.

**Tech Stack:** TypeScript, Node child processes and Web Streams adapters, `@agentclientprotocol/sdk@^1.2.1`, ACP protocol v1 over newline-delimited JSON, Bun tests, existing Pi `Message`/`SingleResult` types, mise/hk validation.

---

## Scope

### In Scope

- New runtime value: `grok-acp` in agent frontmatter, settings overrides, and the `agent` tool's runtime override.
- ACP lifecycle: spawn, initialize, authenticate, create session, prompt, stream updates, complete, cancel, and terminate.
- Structured assistant messages and tool calls.
- Usage extraction from ACP prompt result metadata and standard `usage_update` notifications.
- Existing completion checks, structured output checks, chain/parallel execution, worktree finalization, and rendering operating on ACP results without runtime-specific changes.
- Documentation for selection, capabilities, caveats, and ignored `maxTurns` semantics.

### Out of Scope

- Replacing or deleting `runtime: grok`.
- ACP session persistence across separate subagent invocations or mapping pi `defaultContext: fork` to `session/load`.
- Advertising or implementing ACP client filesystem or terminal capabilities.
- Rendering thought streams, plans, tool outputs, diffs, or live terminal content as new first-class TUI components.
- Exposing Grok-specific `x.ai/*` commands or extension methods through the public agent API.
- Enforcing `maxTurns` for `grok-acp`.

## Protocol Contract

### Process Invocation

Spawn a fresh isolated process per subagent run:

```text
grok agent [--model <model>] [--reasoning-effort <effort>] --always-approve --no-leader stdio
```

Build the child environment from the existing `buildChildAgentEnv()` output and add:

```text
GROK_DISABLE_AUTOUPDATER=1
GROK_MEMORY=0
GROK_SUBAGENTS=0
```

Do not emit `-p`, `--output-format`, `--max-turns`, `--no-memory`, `--no-subagents`, `--rules`, `--system-prompt-override`, `--tools`, or `--disallowed-tools` as ACP CLI flags.

### ACP Lifecycle

The runtime performs these operations in order:

1. Send `initialize` with `protocolVersion: 1`, empty `clientCapabilities`, and `clientInfo` identifying `pi-agents`.
2. Verify the returned protocol version is exactly `1`; otherwise fail with `stopReason: error` and a protocol-version message.
3. Select and call `authenticate` when the initialize response advertises authentication methods:
   - Prefer `_meta.defaultAuthMethodId` when it identifies an advertised method.
   - Otherwise prefer `xai.api_key` when `XAI_API_KEY` exists and that method is advertised.
   - Otherwise prefer `cached_token` when advertised.
   - Otherwise fail with an actionable message naming the advertised methods and instructing the user to run `grok login` or set `XAI_API_KEY`.
4. Send `session/new` with the effective working directory, `mcpServers: []`, and session `_meta` described below.
5. Send `session/prompt` with one text content block containing `Task: ${task}`.
6. Consume notifications and server-to-client requests until the matching `session/prompt` response arrives.
7. Close stdin and terminate the long-lived agent process after the prompt response; retain SIGTERM then SIGKILL fallback for shutdown failures.

### Session Metadata

Construct `session/new._meta` as follows:

- Append mode with a non-empty system prompt: `{ rules: agent.systemPrompt }`.
- Replace mode with a non-empty system prompt: `{ systemPromptOverride: agent.systemPrompt }`.
- If `agent.tools` or `agent.excludeTools` is configured, include an inline `agentProfile` JSON object with `tools` and/or `disallowedTools` arrays.
- Do not include `maxTurns` anywhere in CLI arguments, environment, session metadata, prompt content, or parser state.

### Permissions

Register a `session/request_permission` handler even though the process starts with `--always-approve`:

- Select the first option with `kind: allow_once`.
- If absent, select the first `allow_always` option.
- If neither exists, return `{ outcome: { outcome: "cancelled" } }`.
- After abort begins, respond to every pending or new permission request with `cancelled`.

### Cancellation and Shutdown

On `AbortSignal`:

1. Send the `session/cancel` notification if a session ID is available.
2. Resolve every pending permission request as cancelled.
3. Continue accepting ACP updates until the prompt response reports `cancelled` or the grace timeout expires.
4. Send SIGTERM after the grace timeout, then SIGKILL after the existing five-second hard-kill window.
5. Preserve the current public behavior: the surrounding run throws `Subagent was aborted` rather than returning a successful result.

If the process exits or stdout closes before the prompt response, reject all pending JSON-RPC requests and return an error containing bounded stderr plus the incomplete lifecycle stage.

## ACP-to-Pi Mapping

### Assistant Messages

Handle `session/update` notifications with `sessionUpdate: agent_message_chunk`:

- Append chunks sharing the same non-empty `messageId` to the same assistant `Message` text part.
- Start a new assistant message when `messageId` changes.
- Grok 0.2.93 may omit `messageId`; when absent, keep appending until a tool call occurs, then start a new assistant message for the first post-tool text chunk after that tool reaches a terminal status (`completed` or `failed`).
- Ignore `user_message_chunk` when building `SingleResult.messages`.
- Do not use `agent_thought_chunk` as a message boundary in ACP mode.

This ensures `getFinalOutput()` returns only the last assistant message while preserving pre-tool preambles as earlier messages.

### Tool Calls

Handle `tool_call` by adding a Pi assistant `toolCall` content part:

- `id`: ACP `toolCallId`.
- `name`: `_meta["x.ai/tool"].name` when present; otherwise `title`; otherwise `"grok_tool"`.
- `arguments`: `rawInput` when it is an object; otherwise `{}`.

Track calls by `toolCallId`. Handle `tool_call_update` by merging newer `title`, `kind`, `rawInput`, status, locations, and output into internal parser state. Update the corresponding Pi `toolCall` name/arguments when a later update provides better structured data. Do not create Pi `toolResult` messages in the first implementation because the existing renderer and result consumers expose assistant tool calls but do not consume tool-result messages.

Unknown update types, including `available_commands_update`, `config_option_update`, and Grok `x.ai/*` notifications, are ignored without logging an error or triggering `onUpdate` unless they affect usage or completion.

### Usage

Populate `SingleResult.usage` from the final `session/prompt` response `_meta` when present:

- `input` ← `inputTokens`.
- `output` ← `outputTokens`.
- `cacheRead` ← `cachedReadTokens`.
- `cacheWrite` ← `cachedWriteTokens`, defaulting to zero.
- `contextTokens` ← `totalTokens`.
- `cost` remains zero unless a standard ACP `usage_update.cost` is received.
- `turns` ← number of assistant messages created, with a minimum of one after a completed prompt.
- `model` ← `_meta.modelId` when present, otherwise the configured model.

For a standard `usage_update`, retain the latest `used` as `contextTokens` and numeric cost amount when currency is `USD`; final prompt metadata overwrites token fields when supplied.

### Stop Reasons

Map ACP prompt response values as follows:

| ACP stop reason                  | `SingleResult.stopReason` | Exit behavior                                                               |
| -------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| `end_turn`                       | `end`                     | success                                                                     |
| `max_turn_requests`              | `max_turns`               | failure with a Grok-reported limit message, not an `agent.maxTurns` message |
| `max_tokens`                     | `error`                   | failure with token-limit message                                            |
| `refusal`                        | `error`                   | failure with refusal message                                                |
| `cancelled` after caller abort   | `aborted`                 | caller abort path throws                                                    |
| `cancelled` without caller abort | `error`                   | failure with unexpected cancellation message                                |
| unknown value                    | `error`                   | failure with `Unknown ACP stop reason: <value>`                             |

The implementation must never mention `agent.maxTurns` in the `grok-acp` path.

## File Map

- Modify: `packages/pi-agents/src/constants.ts` — add `GROK_ACP_RUNTIME` while continuing to share `GROK_BINARY`.
- Modify: `packages/pi-agents/src/agents.ts` — add `grok-acp` to `Runtime` and `RUNTIME_VALUES` so frontmatter and config overrides accept it.
- Modify: `packages/pi-agents/src/schema.ts` — permit `grok-acp` in the runtime override schema and description.
- Create: `packages/pi-agents/src/grok-acp-invocation.ts` — build ACP CLI arguments, child environment overrides, initialize payload, authentication selection, session metadata, and prompt payload; explicitly omit `maxTurns`.
- Modify: `packages/pi-agents/package.json` — add `@agentclientprotocol/sdk` as a runtime dependency and add it to `pi.external` so the Node-target build leaves a runtime import instead of bundling the SDK.
- Modify: `bun.lock` — lock the selected ACP SDK version.
- Create: `packages/pi-agents/src/grok-acp-client.ts` — adapt Node child streams to SDK `ndJsonStream`, register typed standard ACP handlers, execute the connection lifecycle, and own timeout/cancellation/process shutdown policy.
- Create: `packages/pi-agents/src/grok-acp-parser.ts` — map ACP session updates and prompt completion metadata into `SingleResult.messages`, tool calls, usage, model, and stop reason.
- Modify: `packages/pi-agents/src/execution.ts` — dispatch `GROK_ACP_RUNTIME` to `runSingleAgentGrokAcp`, wire the client/parser callbacks to `onUpdate`, and preserve existing `grok` and pi paths.
- Modify: `packages/pi-agents/src/tool.ts` — treat `grok-acp` like `grok` for pi skill-resolution and fork-context warnings while preserving worktree behavior.
- Modify: `packages/pi-agents/README.md` — document runtime selection, ACP capabilities, configuration mapping, ignored `maxTurns`, and caveats.
- Modify: `docs/plans/plan-grok-runtime.md` — add a dated follow-up note that ACP is now implemented as a separate runtime rather than rewriting the historical decision.
- Test: `packages/pi-agents/tests/agents.test.ts` — frontmatter and settings override parsing for `grok-acp`.
- Test: `packages/pi-agents/tests/grok-acp-invocation.test.ts` — ACP arguments, environment, auth selection, session metadata, prompt payload, and `maxTurns` omission.
- Test: `packages/pi-agents/tests/grok-acp-client.test.ts` — JSON-RPC lifecycle, matching, permission requests, protocol errors, cancellation, and transport shutdown.
- Test: `packages/pi-agents/tests/grok-acp-parser.test.ts` — message grouping, no-messageId fallback, tool calls, unknown updates, usage, and stop reasons.
- Test: `packages/pi-agents/tests/execution.test.ts` — end-to-end fake-child ACP execution, runtime routing, progressive updates, abort, stderr, and process failure.
- Test: `packages/pi-agents/tests/tool.test.ts` — runtime override validation plus `grok-acp` skill/fork warning and context-selection behavior.

## Tasks

### Task 1: Register the `grok-acp` Runtime

**Outcome:** Agent frontmatter, project/user overrides, and per-call runtime override accept `grok-acp` without changing `grok` behavior.

**Files:**

- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/agents.ts`
- Modify: `packages/pi-agents/src/schema.ts`
- Test: `packages/pi-agents/tests/agents.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Add `export const GROK_ACP_RUNTIME = 'grok-acp' as const` next to the existing runtime constants.
- [ ] Extend `Runtime` and `RUNTIME_VALUES` with `GROK_ACP_RUNTIME`; retain `DEFAULT_RUNTIME = 'pi'`.
- [ ] Extend `RuntimeSchema` with `grok-acp` and update its description to distinguish Grok streaming-json from Grok ACP.
- [ ] Add an agent frontmatter parsing case asserting `runtime: grok-acp` produces `AgentConfig.runtime === 'grok-acp'`.
- [ ] Add project/user override coverage asserting `runtime: grok-acp` participates in the existing precedence rules.
- [ ] Add tool-parameter validation coverage asserting `runtimeOverride: 'grok-acp'` is accepted while unknown runtime values remain rejected.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/agents.test.ts tests/tool.test.ts`
- Expected: All runtime parsing, precedence, and validation cases pass; existing `pi` and `grok` tests remain unchanged.

### Task 2: Build ACP Invocation and Session Configuration

**Outcome:** `grok-acp` can construct a deterministic process invocation and ACP startup payloads without reading or transmitting `maxTurns`.

**Files:**

- Create: `packages/pi-agents/src/grok-acp-invocation.ts`
- Test: `packages/pi-agents/tests/grok-acp-invocation.test.ts`

**Steps:**

- [ ] Start the source file with the required two-line `ABOUTME` comment.
- [ ] Reuse the current thinking-to-effort mapping by exporting it from `grok-invocation.ts` or moving it to a narrowly named shared helper; do not duplicate the mapping table.
- [ ] Implement `buildGrokAcpArgs(agent)` returning `['agent', ...agent options..., '--always-approve', '--no-leader', 'stdio']`, with `--model` and `--reasoning-effort` before `stdio`.
- [ ] Implement `buildGrokAcpEnv(baseEnv)` that copies the child environment and sets `GROK_DISABLE_AUTOUPDATER=1`, `GROK_MEMORY=0`, and `GROK_SUBAGENTS=0`.
- [ ] Implement builders for `initialize`, `session/new`, and `session/prompt` parameters using protocol version 1 and `Task: ${task}`.
- [ ] Implement session metadata mapping for `rules`, `systemPromptOverride`, and inline `agentProfile.tools` / `agentProfile.disallowedTools`.
- [ ] Implement deterministic auth selection from initialize response metadata, advertised methods, and `XAI_API_KEY` presence.
- [ ] Add tests with `agent.maxTurns` set and assert it does not affect args, env, session metadata, or prompt payload.
- [ ] Add tests asserting the input `AgentConfig` and base environment are not mutated.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/grok-acp-invocation.test.ts`
- Expected: Argument ordering and every payload shape match the protocol contract; no serialized output contains `maxTurns`, `max-turns`, or its configured numeric value.

### Task 3: Integrate the Official ACP TypeScript SDK

**Outcome:** A reusable, testable SDK adapter can drive one Grok ACP process through initialization, authentication, session creation, prompting, notifications, permissions, cancellation, and shutdown without maintaining a custom JSON-RPC protocol implementation.

**Files:**

- Modify: `packages/pi-agents/package.json`
- Modify: `bun.lock`
- Create: `packages/pi-agents/src/grok-acp-client.ts`
- Test: `packages/pi-agents/tests/grok-acp-client.test.ts`

**Steps:**

- [ ] Add `@agentclientprotocol/sdk` at `^1.2.1` to `packages/pi-agents.dependencies`, add `"external": ["@agentclientprotocol/sdk"]` under the existing `pi` object, and update `bun.lock`; verify the build leaves a runtime import that npm installs normally.
- [ ] Start both new source/test files with the required two-line `ABOUTME` comment.
- [ ] Convert `ChildProcess.stdin` and `ChildProcess.stdout` to Web Streams with Node's `Writable.toWeb()` and `Readable.toWeb()` adapters, then construct the ACP transport with SDK `ndJsonStream()`.
- [ ] Build an SDK client app with `client({ name: 'pi-agents' })` and register typed `session/request_permission` and `session/update` handlers.
- [ ] Use `connectWith(stream, async (ctx) => ...)` to scope connection lifetime and call typed SDK methods for `initialize`, `authenticate`, `session/new`, and `session/prompt`.
- [ ] Use SDK protocol constants and standard method registries rather than hard-coded standard ACP method strings where exposed.
- [ ] Route standard `session/update` notifications to a provided callback and tolerate Grok-specific `x.ai/*` notifications through SDK extension/unknown-notification hooks without failing the connection.
- [ ] Handle server-to-client permission requests with allow-once/allow-always selection and cancellation behavior.
- [ ] Wrap SDK requests with lifecycle-stage timeouts so failures identify initialize, authenticate, session creation, or prompting; do not reimplement request IDs, response matching, or NDJSON line buffering.
- [ ] On stdout close/process exit, rely on SDK connection closure to reject in-flight requests, then enrich the surfaced error with lifecycle stage and bounded stderr.
- [ ] Implement ACP cancellation through the SDK notification API and make it idempotent.
- [ ] Implement process cleanup outside the SDK: graceful connection close followed by SIGTERM/SIGKILL deadlines, idempotent across success, failure, abort, and spawn error.
- [ ] Test the adapter using SDK-compatible in-memory streams or a fake child process: interleaved notifications, permission requests during a pending prompt, process exit, cancellation, unknown xAI notifications, and double cleanup.
- [ ] Add a dependency import/build assertion so ESM or Web Streams incompatibility is caught before the real smoke test.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/grok-acp-client.test.ts`
- Expected: SDK-driven lifecycle completes; no request hangs; permission/cancellation shapes are ACP-compliant; unknown xAI extensions do not break the connection.

### Task 4: Map ACP Updates into Pi Results

**Outcome:** Structured ACP messages, tools, usage, model, and stop reasons produce correct `SingleResult` data and a clean final assistant output.

**Files:**

- Create: `packages/pi-agents/src/grok-acp-parser.ts`
- Test: `packages/pi-agents/tests/grok-acp-parser.test.ts`

**Steps:**

- [ ] Start both new files with the required two-line `ABOUTME` comment.
- [ ] Define `GrokAcpParserState` containing message-ID mapping, current assistant message, pending tool calls, post-tool boundary state, latest standard usage, and configured model.
- [ ] Map `agent_message_chunk` text into assistant message text parts using `messageId` when present.
- [ ] Implement the no-messageId fallback verified against Grok 0.2.93: text before a tool remains in the pre-tool message, and first text after a completed/failed tool begins a new assistant message.
- [ ] Map `tool_call` into an assistant `toolCall` part using `toolCallId`, xAI metadata name/title fallback, and object `rawInput`.
- [ ] Merge `tool_call_update` data into tracked calls and enrich the Pi part when improved name/input becomes available.
- [ ] Ignore thought, user-message, available-command, config-option, plan, and unknown updates for message construction; only standard usage updates affect usage.
- [ ] Map final prompt metadata into `UsageStats` and model according to the protocol contract.
- [ ] Map all documented stop reasons, map unknown values to `stopReason: error` with `Unknown ACP stop reason: <value>`, and produce stable messages without consulting `agent.maxTurns`.
- [ ] Ensure end metadata is attached only to the final assistant message and `getFinalOutput()` returns the last response rather than accumulated preambles.
- [ ] Add a completion-check regression fixture where pre-tool text is followed by a tool call and a final `## Completed` message; assert `validateCompletionOutput()` succeeds.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/grok-acp-parser.test.ts tests/completion-check.test.ts`
- Expected: Exact message/tool/usage snapshots pass, unknown updates are harmless, and the `## Completed` regression is fixed without thought-boundary heuristics.

### Task 5: Integrate ACP Execution and Runtime Routing

**Outcome:** Selecting `runtime: grok-acp` runs the new ACP lifecycle, streams progressive updates, and returns through the existing workflow machinery.

**Files:**

- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Add a dedicated `effectiveRuntime === GROK_ACP_RUNTIME` branch before the existing `GROK_RUNTIME` branch; do not merge the two paths.
- [ ] Implement `runSingleAgentGrokAcp()` as an orchestration adapter using the invocation builders, ACP client, and parser.
- [ ] Build the child environment through `buildChildAgentEnv()` before applying ACP-specific environment overrides.
- [ ] Emit `onUpdate` after assistant text, tool-call creation/enrichment, usage updates, and final prompt completion; continue using `makeDetails([currentResult])`.
- [ ] Preserve model/thinking overrides when constructing the effective agent and invocation.
- [ ] On successful prompt completion, wait for cleanup and return the populated `SingleResult` with the child exit code normalized to success.
- [ ] On protocol, authentication, session, prompt, spawn, or premature-exit failure, set `stopReason: error`, `exitCode: 1`, stable `errorMessage`, and bounded stderr.
- [ ] Wire `AbortSignal` to ACP cancellation first and process termination second, preserving the existing thrown abort behavior.
- [ ] Do not inspect `agent.maxTurns` anywhere in `runSingleAgentGrokAcp()` and do not synthesize the existing `Agent exceeded maxTurns=...` message.
- [ ] Extend Grok-specific skill/fork-context branches in `runStepWithContext()` to recognize both `grok` and `grok-acp`, with runtime-correct warning text.
- [ ] Keep worktree creation, setup hook, dirty-state finalization, completion checks, structured output checks, chain, parallel, and background execution unchanged.
- [ ] Add fake-child tests for the full initialize/auth/session/prompt flow, progressive text/tool updates, token metadata, runtime overrides, permission handling, cancelled abort, malformed protocol, and process exit.
- [ ] Add a test configuring `maxTurns: 1` with multiple ACP tool/message cycles and assert the run completes without cancellation and without a max-turn error.
- [ ] Retain every existing `runSingleAgentGrok` test unchanged to prove the legacy runtime remains compatible.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/execution.test.ts tests/tool.test.ts`
- Expected: New ACP cases pass; all existing pi and Grok streaming-json cases pass without fixture changes.

### Task 6: Document Runtime Selection and Operational Differences

**Outcome:** Users can intentionally select the correct Grok protocol and understand ACP capabilities and limitations.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `docs/plans/plan-grok-runtime.md`

**Steps:**

- [ ] Extend runtime configuration examples and tables with `grok-acp`.
- [ ] Add a dedicated `Grok ACP Runtime` subsection showing frontmatter and per-call override examples.
- [ ] State explicitly that `grok` remains streaming-json and `grok-acp` is opt-in ACP.
- [ ] Document ACP authentication requirements, structured tool visibility, token/cache/reasoning usage, graceful cancellation, and lack of client fs/terminal capability advertisement.
- [ ] Document that `maxTurns` is accepted at the shared config layer but ignored entirely by `grok-acp`, while remaining active for `pi` and `grok`.
- [ ] Document mapping of system prompt mode and tool filters through `session/new._meta`.
- [ ] Update the Grok caveat table so streaming-json limitations are not incorrectly attributed to ACP.
- [ ] Add a dated follow-up note to the historical plan explaining that ACP was added as a separate runtime after real output-boundary and tool-visibility limitations were observed; do not rewrite the original decision as if it had never been made.

**Validation:**

- Run: `hk check packages/pi-agents/README.md docs/plans/plan-grok-runtime.md`
- Expected: Markdown formatting passes and examples use only valid runtime values and implemented behavior.

### Task 7: Perform Full Validation and Real ACP Smoke Test

**Outcome:** The implementation passes repository checks and a real Grok ACP process demonstrates the intended message/tool/usage behavior.

**Files:**

- No production file changes expected; fix only failures caused by this feature.

**Steps:**

- [ ] Run the focused ACP tests first and resolve all failures.
- [ ] Run the full pi-agents test suite and confirm legacy Grok tests remain green.
- [ ] Run package typecheck and build.
- [ ] Run repo lint/format checks.
- [ ] Run a real read-only `runtime: grok-acp` smoke task in a temporary directory that requires one file-read tool call and ends with the configured completion heading.
- [ ] Verify the captured `SingleResult` contains separate pre-tool/final assistant messages, one rendered tool call with arguments, non-zero input/output/cache usage where returned, `stopReason: end`, and a passing completion check.
- [ ] Run the same smoke task with `maxTurns: 1` and verify ACP does not include or enforce that value.
- [ ] Remove temporary files and terminate all spawned Grok processes.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: Entire package test suite passes.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript reports no errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: Package builds successfully; `dist/index.js` keeps `@agentclientprotocol/sdk` as an external runtime import and the package manifest declares it in `dependencies`.
- Run: `hk check`
- Expected: Repo-wide eslint and prettier checks pass.
- Run: `ps -ef | grep '[g]rok agent'`
- Expected: No Grok ACP process from the smoke test remains running.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: All existing and new tests pass, including legacy `grok` behavior and ACP completion-check regression coverage.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: `@balaenis/pi-agents` builds successfully.
- Run: `hk check`
- Expected: Repo-wide lint and formatting pass.
- Manual: Invoke a worker with `runtime: grok-acp`, a read-only tool task, and `maxTurns: 1`.
- Expected: ACP handshake/auth/session/prompt succeeds; tool call is visible; final output is a separate message; usage is populated; completion check passes; `maxTurns` has no effect.
- Manual: Invoke the same worker with `runtime: grok`.
- Expected: Existing streaming-json invocation and parser behavior remain unchanged.

## Rollout Notes

- This is additive and opt-in. Existing agent files continue using `pi` by default or `grok` when explicitly configured.
- Do not automatically migrate existing `runtime: grok` configurations; users must choose `grok-acp`.
- Keep the thought-boundary fix in `grok-parser.ts` because it remains required by the legacy streaming-json runtime.
- ACP creates a persistent process only for the duration of one subagent invocation; session reuse can be evaluated separately after the one-shot lifecycle is stable.
- `grok-acp` intentionally ignores `maxTurns`. This semantic difference must be visible in README configuration documentation and tests.
- If a future Grok release changes its ACP framing or required capabilities, fail with an explicit protocol error rather than falling back to streaming-json.

## Risks and Mitigations

- **Grok emits standard and proprietary updates not covered by SDK types** — Use official typed handlers for standard ACP and SDK extension/unknown-notification hooks for `x.ai/*`; never fork or patch the SDK solely to recognize optional Grok metadata.
- **Grok omits optional ACP `messageId`** — Use explicit tool lifecycle events as the fallback message boundary; retain regression tests based on the observed 0.2.93 stream.
- **Server-to-client requests deadlock the prompt** — Register required client request handlers before connecting, always answer permission requests, and let the SDK reject unsupported methods according to JSON-RPC semantics.
- **Long-lived stdio process leaks after prompt completion** — Centralize idempotent cleanup and test success, error, abort, spawn failure, and premature-close paths.
- **Authentication differs between OAuth and API-key environments** — Select only advertised methods, honor Grok's advertised default, and produce actionable failure text.
- **Agent tool-name mismatch between pi and Grok** — Preserve current pass-through semantics in inline agent profiles and document that Grok native tool IDs are required.
- **Shared `maxTurns` config creates false expectations** — Explicitly omit it from every ACP payload, add serialization/behavior tests, and document that only `grok-acp` ignores it.
- **ACP prompt metadata fields are xAI extensions** — Keep a narrow local type guard around `_meta` while using SDK types for the standard response; retain standard `usage_update` support and leave missing fields at zero.
- **SDK API or framing behavior changes across versions** — Pin the compatible range, use only documented `client`, `connectWith`, `ndJsonStream`, and standard method APIs, and cover stream closure plus unknown extensions with focused tests.
- **Protocol logs include benign Grok stderr noise** — Treat non-empty stderr as diagnostic unless process/protocol failure occurs; do not mark successful prompt completion failed solely because stderr contains warnings.
- **Historical design documentation contradicts the new runtime** — Add a dated follow-up note while preserving the original decision record.

## Follow-up (2026-07-15)

Native ACP session resume and Agent View restoration for `runtime: "grok-acp"` are
implemented in
[`packages/pi-agents/docs/plans/2026-07-15-grok-acp-session-resume-agent-view-plan.md`](../../packages/pi-agents/docs/plans/2026-07-15-grok-acp-session-resume-agent-view-plan.md).

That work is deliberately ACP-only: plain `runtime: "grok"` remains replay-only
with `allowReplay`. The original out-of-scope statement in this plan — that ACP
session reuse would be evaluated separately after the one-shot lifecycle was
stable — is preserved here as historical context. Session identity is the
protocol session ID only; private Grok storage under `~/.grok/sessions` is never
parsed.
