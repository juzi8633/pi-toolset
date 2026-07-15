# Grok ACP Session Resume and Agent View Restoration Implementation Plan

**Goal:** Add native ACP session persistence, `session/load` resume, and Agent View transcript restoration for `runtime: "grok-acp"` without changing the existing plain `grok` streaming-json runtime.

**Inputs:** User requirement to implement the ACP-only approach; current `pi-agents` durable-run and Agent View implementations; `@agentclientprotocol/sdk@1.2.1`; ACP v1 session setup contract; local Grok `0.2.101` capability probe showing `agentCapabilities.loadSession === true`; local `session/load` probe showing replayed user, thought, assistant, and tool-call updates before the load response.

**Assumptions:**

- Plain `runtime: "grok"` remains the current `grok -p --output-format streaming-json` path with replay semantics and an explicit `allowReplay` acknowledgement. It is not added to Agent View and its invocation/parser files remain unchanged.
- `runtime: "grok-acp"` continues to ignore `maxTurns`; this project does not introduce a client-side ACP turn limit.
- An attempted Grok ACP unit is resumable only when its ACP session ID was durably persisted. Missing IDs, missing Grok-side sessions, or unsupported `session/load` fail closed and never fall back to replaying the original task.
- A never-started `queued` or `skipped` Grok ACP unit may create its first session during durable-run resume and send the original task plus all durable continuation instructions.
- Existing Version 1 run records remain readable. The run schema receives optional additive fields and does not increment its version.
- Grok ACP V1 supports an idle/detached prompt and current-turn cancellation. It does not emulate Pi `steer` or `follow_up`; text input is disabled while a Grok ACP turn is starting or running.
- Grok sessions remain stored by Grok under its own user-home storage. `pi-agents` persists only the protocol session ID and original cwd/worktree metadata and never parses or records the private Grok session-file path.
- The existing one-shot `grok-acp` `SingleResult` parser and its message-grouping semantics remain unchanged. Session phase separation happens in the ACP client/transport before updates reach that parser; complete historical transcript projection is implemented separately.

**Architecture:** Refactor the ACP client into a reusable connection lifecycle that can create or load a session, expose replay and prompt phases, and remain alive for Agent View. Add a runtime-neutral interactive session artifact and transport contract so the existing single `InteractiveAgentRegistry` can own either Pi RPC or Grok ACP while remaining the only endpoint reducer. Persist the ACP session ID synchronously before the first prompt, use `session/load` notifications as the authoritative transcript source, and serialize every process touching a Grok session through a process-global lease keyed by runtime, canonical cwd, and protocol session ID.

**Tech Stack:** TypeScript, Node child processes and Web Streams, `@agentclientprotocol/sdk@1.2.1`, ACP v1 over NDJSON, Pi `AgentMessage` and TUI APIs, existing RunStore/RunCoordinator/Agent View infrastructure, Bun tests, mise, and hk.

---

## Scope

### In Scope

- Persist the `session/new` response ID for every durable Grok ACP unit.
- Change new Grok ACP units from `replay` to `session` resume capability.
- Resume interrupted Grok ACP units with `session/load` and a session-continuation prompt.
- Restore full Grok ACP history in Agent View through lazy ACP replay.
- Register initial TUI Grok ACP runs in Agent View and stream them through the registry.
- Keep one ACP connection alive for idle Agent View prompts and reopen detached sessions through `session/load`.
- Support `session/cancel`, detach, LRU disposal, shutdown, and process-global single ownership.
- Preserve and validate the original effective cwd/worktree required by Grok session lookup.
- Render replayed user messages, thoughts, assistant text, tool calls, and tool output.
- Update user documentation and the historical Grok ACP plan.

### Out of Scope

- Any invocation, parser, resume, or Agent View change for plain `runtime: "grok"`.
- Parsing, copying, relocating, deleting, or migrating files under `~/.grok/sessions`.
- Cross-machine Grok session restoration.
- Recovery after the user deletes Grok's own session storage.
- ACP `session/list`, `session/resume`, or `session/delete`; Grok `0.2.101` does not advertise them.
- Simulated steering or follow-up queues for Grok ACP.
- Automatic real-model calls in the test suite.
- A second Grok-specific interactive registry.

## Protocol and State Contracts

### Durable Unit Schema

Add an optional ACP session identifier to the existing Version 1 unit and result shapes:

```ts
interface RunUnitRecord {
  // existing fields
  acpSessionId?: string;
}

interface UnitExecutionContext {
  // existing fields
  acpSessionId?: string;
}

interface SingleResult {
  // existing fields
  acpSessionId?: string;
}
```

Rules:

- A present `acpSessionId` must be a trimmed, non-empty string.
- `resumeCapabilityForRuntime("grok-acp")` returns `session`.
- `resumeCapabilityForRuntime("grok")` continues to return `replay`.
- Pi remains `session` capable through its native session file.
- An attempted Grok ACP unit without `acpSessionId` is blocked with `acp_session_unavailable`, even when `allowReplay` is supplied.
- A never-started Grok ACP unit without an ID may create a new session.
- Legacy never-started Grok ACP units may still store `capability: "replay"`. On their first successful session-ID write, the same atomic update changes the unit capability to `session`; the in-memory unit context/result and subsequent run aggregate must use the normalized value.
- Legacy attempted Grok ACP units have no trustworthy session ID and remain unavailable; their stored capability is not normalized to make them replayable.
- Aggregate examples:
  - Pi + Grok ACP → `session`.
  - Pi + plain Grok → `mixed`.
  - Pi + Grok ACP + plain Grok → `mixed`.

### Early Session-ID Persistence

The first Grok ACP turn must follow this order:

```text
unit_started
→ spawn
→ initialize
→ authenticate
→ session/new
→ validate non-empty sessionId
→ acquire Grok session lease
→ await run.json sessionId flush
→ TUI: persist binding and append host link
→ session/prompt
```

The persistence operation must:

1. Cancel or bypass pending coalesced writes for the run.
2. Await an atomic `RunStore.updateRun()` write before resolving.
3. Be idempotent for the same unit/session ID.
4. Reject a different existing ID with `acp_session_conflict`.
5. Update in-memory unit context only after the disk write succeeds.
6. Propagate failure to the ACP owner, which disposes the process without sending a prompt.

Crash behavior:

- If Grok creates a session but the client never receives the ID, the unit remains attempted without an ID and cannot resume.
- If the ID callback or disk write fails, no prompt is sent and the unit cannot resume.
- If the ID is persisted but the process dies before the original prompt is confirmed, a later load with no replayed user history fails with `acp_session_history_empty`; the original task is not resent automatically.
- If a prompt ran but its response or continuation-delivery flush was lost, the continuation remains undelivered. ACP has no prompt idempotency key, so this narrow recovery window remains at-least-once and must be documented.

### ACP Load Lifecycle

A load-capable connection performs:

```text
spawn
→ initialize
→ authenticate
→ require agentCapabilities.loadSession === true
→ session/load({ sessionId, cwd, mcpServers: [] })
→ collect standard session/update replay notifications
→ receive matching session/load response
→ finalize transcript replay
→ either dispose (hydrate-only) or send session/prompt
```

The exact load request is:

```ts
{
  sessionId: unit.acpSessionId,
  cwd: unit.worktreePath ?? unit.effectiveCwd,
  mcpServers: [],
}
```

Rules:

- Check the top-level `agentCapabilities.loadSession` field. An empty `sessionCapabilities` object does not imply load support.
- `LoadSessionResponse` is not a message container. Only standard `session/update` notifications whose `sessionId` exactly matches the requested ID and which arrive before the matching response are historical replay; foreign-session notifications are ignored.
- The matching load response is the replay-complete barrier. No continuation prompt may be sent before it.
- Load-phase updates must not enter the current attempt's one-shot `SingleResult` baseline.
- Prompt-phase updates are live output for the current activation/attempt.
- Hydrate-only mode disposes after the load barrier without sending a prompt.
- Reopen mode keeps the loaded connection and then sends a prompt.

### Durable Resume Prompt

For an attempted unit with a stored ACP session, reuse the existing fixed session-continuation text through `buildSessionContinuationPrompt()` and append only that unit's undelivered continuation instructions. Do not include the original task or already delivered instructions.

For a never-started unit, create a new session and send the original resolved task plus all accumulated continuation instructions.

Continuation delivery rules:

- Mark instructions delivered only after the matching `session/prompt` response.
- Persist `deliveredCount` with an awaited strict write for Grok ACP.
- A later resume sends only the remaining slice.
- A crash before the prompt response leaves the instructions undelivered.
- Plain Grok keeps its existing replay behavior and accumulated-task prompt construction.

### Interactive Session Artifact

Replace the registry's unconditional `sessionFile` assumption with a discriminated artifact:

```ts
type InteractiveSessionArtifact =
  { runtime: 'pi'; sessionFile: string } | { runtime: 'grok-acp'; sessionId: string };
```

Rules:

- Endpoint, launch-spec, snapshot, trust resolution, lease, and hydrate paths use `sessionArtifact`.
- Pi keeps session-directory containment, realpath, planned-missing-file, and `SessionManager` rules.
- Grok ACP artifacts contain only a protocol session ID.
- `InteractiveAgentLinkV1` remains unchanged; links never contain session IDs or paths. RunStore remains authoritative.
- Host session ID, binding ID, binding timestamp, agent fingerprint, workflow overrides, cwd/worktree, and active-branch validation remain mandatory.
- Plain Grok remains rejected by interactive trust resolution.
- `restoreActiveBranch()` remains metadata-only for both runtimes.

### Process-Global Session Lease

Extract the current process-global lease implementation into a shared module while preserving `globalThis[Symbol.for(...)]` behavior across Jiti reloads.

The logical lease key is:

```text
<runtime>\0<canonical-effective-cwd>\0<session-identity>
```

- Pi identity: canonical native session-file path.
- Grok ACP identity: persisted protocol session ID.
- Cwd: realpath of the original existing effective cwd/worktree.
- The key must never contain a guessed `~/.grok/sessions` path.

The lease covers:

- A hydrate-only `session/load` process until confirmed disposal.
- A detached/reopen connection for its complete lifetime.
- A fresh TUI connection from session-ID acquisition through disposal.
- A non-TUI load/prompt/dispose lifecycle.
- Abort, LRU detach, extension shutdown, and unexpected-exit cleanup.

Dispose failure preserves the existing sticky fail-closed behavior.

### ACP Transcript Projection

Create a dedicated historical/live transcript projector rather than broadening the existing one-shot parser.

Required mappings:

| ACP update            | Agent View projection                                  |
| --------------------- | ------------------------------------------------------ |
| `user_message_chunk`  | Finalized user message                                 |
| `agent_thought_chunk` | Assistant thinking part                                |
| `agent_message_chunk` | Assistant text part                                    |
| `tool_call`           | Assistant tool-call part and active-tool start         |
| `tool_call_update`    | Merged tool metadata/activity and terminal tool result |
| `usage_update`        | Endpoint/current-turn usage                            |

Tool projection must merge by `toolCallId`:

- Prefer `_meta["x.ai/tool"].name`, then title, then `grok_tool`.
- Use object `rawInput` as tool-call arguments.
- Preserve raw input/output, title, kind, locations, content, and status in details.
- Prefer renderable ACP content; fall back to bounded textual/JSON `rawOutput`.
- Emit one finalized tool-result message for terminal `completed` or `failed` state.
- Mark failed results as errors.
- Flush non-terminal tools at the load barrier as unconfirmed/interrupted, never completed.
- Keep stored content complete; rely on the existing Agent View viewport truncation for display limits.

The projector must produce complete `AgentMessage` objects expected by existing renderers. Historical assistant defaults are deterministic: `api: "grok-acp"`, `provider: "xai"`, model from load/prompt metadata or configured model (otherwise an empty string), zero-valued usage when no usage update exists, and `stopReason: "toolUse"` when the message owns a tool call or `"stop"` otherwise. User, assistant, and tool-result timestamps use a finite ACP metadata timestamp when present; otherwise they use an injected load-start timestamp plus monotonic replay sequence so ordering is stable in tests. Live prompt metadata overwrites these defaults when supplied.

### Runtime-Neutral Interactive Transport

Introduce a minimum shared contract:

```ts
interface InteractiveAgentTransport {
  readonly runtime: 'pi' | 'grok-acp';
  readonly runningInput: 'steer-follow-up' | 'unsupported';
  subscribe(listener: (event: InteractiveTransportEvent) => void): () => void;
  prompt(message: string): Promise<void>;
  steer?(message: string): Promise<void>;
  followUp?(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<InteractiveTransportState>;
  dispose(): Promise<void>;
  getStderr(): string;
}

interface InteractivePromptCompletedEvent {
  type: 'prompt_completed';
  stopReason: string;
  usage?: UsageStats;
  model?: string;
  responseMeta?: Record<string, unknown>;
}
```

- `prompt()` resolves at dispatch acceptance, not turn completion. The Pi adapter resolves after its existing prompt command response; the Grok adapter starts the SDK request, confirms the request was written/registered, and returns while retaining the matching response promise internally.
- Turn completion is reported separately through `prompt_completed` followed by the normalized settled boundary. Grok continuation delivery is persisted only from that matching completion event, never from `prompt()` resolution.
- A thin Pi adapter preserves current Pi RPC semantics and derives the same completion boundary from `agent_settled`.
- The Grok ACP transport owns initialize/auth/new-or-load/prompt/cancel/dispose and transcript projection.
- Both transports emit normalized registry events.
- The existing registry remains the sole endpoint reducer.
- TUI execution consumes registry activation snapshots and never independently reduces the same ACP stream.

### Grok ACP Agent View Input

- Idle, detached, and retryable-error endpoints accept a new prompt.
- Starting, running, or otherwise active Grok ACP endpoints reject all text input with `running_input_unsupported`.
- Rejected input is not sent and is not added to steering/follow-up queues.
- The detail view replaces or disables the input while running and shows:

```text
Grok ACP input is unavailable while running; wait or press Ctrl+X to cancel.
```

- Alt+Enter does not create a follow-up.
- Ctrl+X sends `session/cancel`, waits for the prompt response or cancel grace, then settles/disposes.
- Pi input behavior remains unchanged.

### Restore Failure Classification

| Condition                             | Endpoint state            | Error code                           | Behavior                                 |
| ------------------------------------- | ------------------------- | ------------------------------------ | ---------------------------------------- |
| Stored cwd missing/not a directory    | `unavailable`             | `cwd_missing`                        | Restore original path before retry       |
| Stored worktree missing/unregistered  | `unavailable`             | `worktree_unavailable`               | Restore original registered worktree     |
| Attempted unit missing ACP ID         | `unavailable`             | `acp_session_unavailable`            | Never replay original task               |
| `loadSession !== true`                | `unavailable`             | `acp_load_unsupported`               | Require compatible Grok version          |
| Grok reports `Path not found`         | `unavailable`             | `acp_session_not_found`              | Restore same-machine Grok storage        |
| Grok reports cwd/session mismatch     | `unavailable`             | `acp_cwd_mismatch`                   | Use original cwd; do not rewrite request |
| Load has no replayed user history     | `unavailable`             | `acp_session_history_empty`          | Do not resend original task              |
| Spawn/auth/timeout/connection failure | `error`                   | `transport_error` / `acp_load_error` | Retry on next hydrate/prompt             |
| Prompt failure after successful load  | `error`                   | `transport_error`                    | Reopen through load on next prompt       |
| Disposal cannot confirm process exit  | `error` plus sticky lease | `dispose_failed`                     | Fail closed in current process           |

Hydrate failures must update endpoint status and diagnostics instead of silently returning an empty transcript.

### Worktree and Portability

- Always load with `unit.worktreePath ?? unit.effectiveCwd` from the stored run.
- Validate the directory before spawning Grok.
- Validate stored worktrees with the existing Git worktree checks.
- Retain clean worktrees for linked Grok ACP endpoints, matching linked Pi behavior.
- Do not recreate or substitute a worktree during load.
- Do not claim cross-machine portability or recovery after Grok's session storage is deleted.

## File Map

### Create

- `packages/pi-agents/src/session-lease.ts` — Runtime/cwd/session keyed process-global lease extracted from the registry.
- `packages/pi-agents/src/interactive-transport.ts` — Runtime-neutral session artifact, transport, state, capabilities, and normalized events.
- `packages/pi-agents/src/interactive-execution.ts` — Shared registry activation-to-`SingleResult` projection for interactive runtimes.
- `packages/pi-agents/src/grok-acp-transcript.ts` — Full ACP replay/live transcript projector.
- `packages/pi-agents/src/grok-acp-interactive-transport.ts` — Long-lived ACP transport implementing new/load/prompt/cancel/dispose.
- `packages/pi-agents/tests/session-lease.test.ts` — Lease-key, ownership, ordering, and sticky-failure coverage.
- `packages/pi-agents/tests/interactive-execution.test.ts` — Runtime-neutral activation baseline and result projection coverage.
- `packages/pi-agents/tests/grok-acp-transcript.test.ts` — Historical/live message and tool-result projection coverage.
- `packages/pi-agents/tests/grok-acp-interactive-transport.test.ts` — Long-lived new/load/stream/cancel/dispose behavior.

### Modify Source

- `packages/pi-agents/src/run-types.ts` — Add `acpSessionId` to Version 1 units.
- `packages/pi-agents/src/types.ts` — Expose optional ACP session identity on results.
- `packages/pi-agents/src/run-store.ts` — Validate optional ACP session IDs.
- `packages/pi-agents/src/run-coordinator.ts` — Runtime capability mapping and strict ACP session-ID persistence.
- `packages/pi-agents/src/resume.ts` — Runtime-specific session artifact preflight and replay acknowledgement.
- `packages/pi-agents/src/invocation.ts` — Make the fixed session-continuation helper runtime-neutral without changing text.
- `packages/pi-agents/src/grok-acp-invocation.ts` — Build exact ACP load parameters.
- `packages/pi-agents/src/grok-acp-client.ts` — Reusable connection, new/load phases, barriers, and callbacks.
- `packages/pi-agents/src/execution.ts` — Fresh/load routing, phase isolation, and interactive Grok ACP dispatch.
- `packages/pi-agents/src/tool.ts` — Durable ACP ID propagation, interactive registration, and worktree retention.
- `packages/pi-agents/src/interactive-agent.ts` — Runtime-neutral artifacts/transports, Grok trust, lazy hydrate, and reopen.
- `packages/pi-agents/src/pi-rpc-execution.ts` — Retain a Pi-specific wrapper over shared interactive execution.
- `packages/pi-agents/src/interactive-view.ts` — Runtime-aware input state plus thinking/tool-result rendering.
- `packages/pi-agents/src/index.ts` — Construct and shut down both transport kinds through one registry.
- `packages/pi-agents/src/render.ts` — Display ACP session identity without inventing a file path.
- `packages/pi-agents/src/command.ts` — Report runtime-specific resume capability and guidance.

### Modify Tests

- `packages/pi-agents/tests/run-store.test.ts`
- `packages/pi-agents/tests/run-coordinator.test.ts`
- `packages/pi-agents/tests/resume.test.ts`
- `packages/pi-agents/tests/invocation.test.ts`
- `packages/pi-agents/tests/grok-acp-invocation.test.ts`
- `packages/pi-agents/tests/grok-acp-client.test.ts`
- `packages/pi-agents/tests/execution.test.ts`
- `packages/pi-agents/tests/tool.test.ts`
- `packages/pi-agents/tests/interactive-agent.test.ts`
- `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- `packages/pi-agents/tests/interactive-view.test.ts`
- `packages/pi-agents/tests/lifecycle.test.ts`
- `packages/pi-agents/tests/render.test.ts`
- `packages/pi-agents/tests/command.test.ts`

### Modify Documentation

- `packages/pi-agents/README.md` — Runtime capability, resume, Agent View, and storage guidance.
- `packages/pi-agents/docs/how-to.md` — User workflow for Grok ACP interruption, resume, view hydration, prompt, and cancel.
- `packages/pi-agents/docs/reference.md` — Persisted schema, ACP load lifecycle, status/error codes, controls, and limits.
- `packages/pi-agents/docs/explanation.md` — Why replay notifications and a protocol-level projector are used instead of private files.
- `docs/plans/2026-07-11-grok-acp-runtime-plan.md` — Add a dated follow-up preserving the original historical decision.

### Explicitly Unchanged

- `packages/pi-agents/src/grok-invocation.ts`
- `packages/pi-agents/src/grok-parser.ts`
- `packages/pi-agents/tests/grok-invocation.test.ts`
- `packages/pi-agents/tests/grok-parser.test.ts`

## Tasks

### Task 1: Extend Durable State and Capability Resolution

**Outcome:** Grok ACP units are session-capable and have a strict, durable session-ID write path; plain Grok remains replay-capable.

**Files:**

- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/render.ts`
- Modify: `packages/pi-agents/src/command.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/render.test.ts`
- Test: `packages/pi-agents/tests/command.test.ts`

**Steps:**

- [ ] Add optional `acpSessionId` fields to `RunUnitRecord`, `UnitExecutionContext`, and `SingleResult`.
- [ ] Validate a present stored ACP ID as a trimmed non-empty string.
- [ ] Change `resumeCapabilityForRuntime()` so only plain Grok maps to `replay`; Grok ACP maps to `session`.
- [ ] Add a runtime-aware helper for replay acknowledgement so legacy stored capability labels cannot allow Grok ACP replay.
- [ ] Implement awaited `RunCoordinator.persistAcpSessionId({ runId, unitId, sessionId })` with disk-first update, same-ID idempotence, different-ID conflict, and pending-write cancellation.
- [ ] Update result metadata stamping to include `acpSessionId`.
- [ ] Update resume preflight to require `sessionFile` for attempted Pi units and `acpSessionId` for attempted Grok ACP units.
- [ ] Permit never-started Grok ACP units without an ID.
- [ ] Keep `allowReplay` required for incomplete plain Grok units only.
- [ ] Render the ACP session ID separately from a Pi session-file path.
- [ ] When a legacy never-started Grok ACP unit first stores an ID, atomically normalize its durable/in-memory capability from `replay` to `session`; do not normalize attempted legacy units without an ID.
- [ ] Add Pi/Grok/Grok ACP aggregate capability and mixed-run tests.
- [ ] Add same-ID, conflicting-ID, write-failure, legacy-record, and missing-attempted-ID tests.
- [ ] Add a queued legacy Grok ACP test proving first ID persistence normalizes the unit/result/run aggregate and then passes Agent View trust as session-capable.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-coordinator.test.ts tests/resume.test.ts tests/render.test.ts tests/command.test.ts`
- Expected: Grok ACP reports session capability, plain Grok still requires replay acknowledgement, and invalid/missing attempted ACP identities fail closed.

### Task 2: Add ACP Load Builders and Reusable Connection Lifecycle

**Outcome:** The ACP client can create or load a session, identify replay versus live updates, and enforce both session-ID and load-response barriers.

**Files:**

- Modify: `packages/pi-agents/src/grok-acp-invocation.ts`
- Modify: `packages/pi-agents/src/grok-acp-client.ts`
- Test: `packages/pi-agents/tests/grok-acp-invocation.test.ts`
- Test: `packages/pi-agents/tests/grok-acp-client.test.ts`

**Steps:**

- [ ] Add `buildGrokAcpSessionLoadParams(sessionId, cwd)` returning exactly `{ sessionId, cwd, mcpServers: [] }`.
- [ ] Split connection setup from the one-shot facade so a caller can retain the initialized/authenticated ACP process.
- [ ] Preserve `runGrokAcpClient()` as a compatibility facade for non-interactive one-shot calls.
- [ ] Add explicit `new` and `load` session modes.
- [ ] Require `initialize.agentCapabilities?.loadSession === true` before load.
- [ ] Validate `session/new` returns a non-empty session ID.
- [ ] Add and await `onSessionEstablished(sessionId)` before sending the first prompt.
- [ ] Tag update callbacks with `load`, `prompt`, or `idle` phase.
- [ ] Accept replay updates only when their notification `sessionId` matches the requested session; ignore foreign-session notifications.
- [ ] Resolve the load barrier only when the matching `session/load` response arrives.
- [ ] Define `prompt()` dispatch acceptance separately from the matching prompt response and emit a normalized completion event carrying stop reason, usage, model, and response metadata.
- [ ] Support hydrate-only disposal after the load barrier.
- [ ] Support keep-alive load followed by one or more sequential idle prompts.
- [ ] Preserve current permission handling, authentication, cancellation grace, stderr bounding, and hard-kill cleanup.
- [ ] Classify load capability absence, missing session, cwd mismatch, timeout, and transient connection errors.
- [ ] Extend the fake ACP server to replay updates before delaying its load response.
- [ ] Assert no prompt arrives while either the session-ID callback or load response is pending.
- [ ] Assert callback rejection disposes the process without prompting.
- [ ] Test blank IDs, foreign-session notification rejection, dispatch-versus-completion ordering, hydrate-only cleanup, keep-alive prompt, abort, and unexpected exit.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/grok-acp-invocation.test.ts tests/grok-acp-client.test.ts`
- Expected: The fake server observes `initialize → authenticate → load → replay → load response → prompt`, and both barriers prevent premature prompts.

### Task 3: Implement Full Grok ACP Transcript Projection

**Outcome:** Replay and live ACP updates produce complete Agent View user/assistant/thinking/tool-call/tool-result history without changing plain Grok or the one-shot parser contract.

**Files:**

- Create: `packages/pi-agents/src/grok-acp-transcript.ts`
- Create: `packages/pi-agents/tests/grok-acp-transcript.test.ts`
- Modify: `packages/pi-agents/src/interactive-view.ts`
- Test: `packages/pi-agents/tests/interactive-view.test.ts`

**Steps:**

- [ ] Start each new TypeScript file with the required two-line `ABOUTME:` comment.
- [ ] Define projector state for role/message grouping, assistant drafts, user drafts, tools, usage, model, and phase.
- [ ] Group chunks by role and message ID when available; use role/tool/barrier boundaries when IDs are absent.
- [ ] Map user chunks to finalized user messages.
- [ ] Map thought chunks to assistant thinking parts and agent-message chunks to text parts.
- [ ] Map tool calls to assistant tool-call parts and active-tool events.
- [ ] Merge tool updates by ID, including raw input/output, content, title, kind, location, and status.
- [ ] Emit exactly one tool-result message for a completed or failed tool.
- [ ] Render ACP text/diff/terminal content and fall back to bounded textual/JSON raw output.
- [ ] Flush drafts and mark unfinished tools unconfirmed at the load barrier.
- [ ] Attach prompt response model, usage, and stop reason to the final live assistant message.
- [ ] Add Agent View rendering for thinking and projected tool output while retaining existing display truncation.
- [ ] Test a complete user → thought → assistant → tool → result → final-assistant history.
- [ ] Test failed tools, duplicate terminal updates, content replacement, raw-output fallback, message IDs, and no-ID fallback.
- [ ] Run existing `grok-acp-parser` tests unchanged as a regression guard.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/grok-acp-transcript.test.ts tests/interactive-view.test.ts tests/grok-acp-parser.test.ts`
- Expected: Full history is renderable and existing one-shot parser snapshots retain their behavior.

### Task 4: Implement Durable Non-TUI Grok ACP Resume

**Outcome:** Interrupted Grok ACP units in non-TUI host modes continue through their native session without replay acknowledgement or original-task resend.

**Files:**

- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/invocation.test.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Generalize the documentation/name of the existing fixed session-continuation helper while preserving its exact prompt text.
- [ ] Add async durable-context operations for ACP session-ID persistence and strict continuation-delivery persistence.
- [ ] Capture whether an ACP session existed before agent-context preparation so a newly created ID is not mistaken for a resumed session.
- [ ] Use `session/new` for fresh/never-started units and `session/load` for attempted units with an ID.
- [ ] Await ID persistence before the fresh prompt.
- [ ] Route load replay to the transcript projector only; do not add it to current-attempt `SingleResult.messages`.
- [ ] After the load barrier, send only `buildSessionContinuationPrompt(undelivered)`.
- [ ] Reject loaded sessions without replayed user history and never resend the original task.
- [ ] Mark continuations delivered only after the prompt response and awaited persistence.
- [ ] For never-started resumed units, send original task plus all continuation tasks once.
- [ ] Preserve plain Grok's current `appendContinuationTasks(originalTask, allContinuations)` replay path.
- [ ] Test callback gating/failure, missing ID, empty history, prompt content, successful delivery idempotence, and response-before-crash behavior.
- [ ] Run existing plain Grok invocation/parser tests without fixture changes.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/invocation.test.ts tests/execution.test.ts tests/tool.test.ts tests/grok-invocation.test.ts tests/grok-parser.test.ts`
- Expected: Grok ACP uses native load and undelivered continuation text; plain Grok remains unchanged.

### Task 5: Extract Runtime-Neutral Lease, Transport, and Interactive Execution

**Outcome:** Pi RPC and Grok ACP share one interactive lifecycle contract and one registry without sharing protocol-specific process code.

**Files:**

- Create: `packages/pi-agents/src/session-lease.ts`
- Create: `packages/pi-agents/src/interactive-transport.ts`
- Create: `packages/pi-agents/src/interactive-execution.ts`
- Create: `packages/pi-agents/src/grok-acp-interactive-transport.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts`
- Create: `packages/pi-agents/tests/session-lease.test.ts`
- Create: `packages/pi-agents/tests/interactive-execution.test.ts`
- Create: `packages/pi-agents/tests/grok-acp-interactive-transport.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`

**Steps:**

- [ ] Start every new TypeScript file with the required two-line `ABOUTME:` comment.
- [ ] Move the existing process-global lease store, canonicalization, acquisition tails, and sticky-failure behavior into `session-lease.ts`.
- [ ] Preserve planned-missing Pi file canonicalization and temporary compatibility re-exports for existing tests/callers.
- [ ] Add runtime + canonical cwd + session identity lease keys for Grok ACP.
- [ ] Define the artifact, transport, transport-state, running-input, and normalized-event contracts.
- [ ] Wrap `PiRpcTransport` with a thin adapter rather than changing its wire implementation.
- [ ] Implement a long-lived Grok ACP transport with new/load, projector, sequential prompt, cancel, settle, stderr, exit, and dispose behavior.
- [ ] Normalize Grok updates into registry message/tool/usage/start/settled/exit events.
- [ ] Extract activation subscription, baseline projection, settle wait, abort, and terminal-result mapping from `pi-rpc-execution.ts` into shared interactive execution.
- [ ] Keep `runSingleAgentPiRpc()` as a Pi policy wrapper over the shared helper.
- [ ] Add a Grok ACP policy with no max-turn enforcement and no running input.
- [ ] Acquire leases before load processes; acquire a fresh-session lease immediately after receiving the ID and before persistence/prompt.
- [ ] Release leases only after confirmed process disposal; retain sticky failures.
- [ ] Test same-session serialization, cross-registry global sharing, cwd symlink aliases, different IDs/runtimes, and absence of private Grok paths.
- [ ] Test live text/tools, prompt settle, cancel, double dispose, unexpected exit, and post-baseline result projection for both runtimes.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/session-lease.test.ts tests/interactive-execution.test.ts tests/grok-acp-interactive-transport.test.ts tests/pi-rpc-execution.test.ts`
- Expected: Both runtimes satisfy the common lifecycle, and one Grok session has only one process owner.

### Task 6: Generalize Agent View Trust and Lazy Hydration

**Outcome:** Trusted Grok ACP links restore as detached metadata and hydrate complete history only when the detail view or activation needs it.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/interactive-view.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/interactive-view.test.ts`

**Steps:**

- [ ] Replace generic endpoint/launch-spec/snapshot/list `sessionFile` fields with `sessionArtifact`; add a registry-local `piSessionFile(artifact)` helper used only by Pi validation, lease, spawn, and hydrate paths.
- [ ] Include runtime and artifact-safe status in snapshots/list items; display a shortened ACP session ID, never a private path.
- [ ] Keep dual host link/binding, active branch, timestamp, agent fingerprint, request override, and skill validation.
- [ ] Keep Pi session-directory and realpath containment checks unchanged.
- [ ] Allow Grok ACP only when the durable unit has the expected runtime, session capability, and non-empty ACP ID.
- [ ] Continue rejecting plain Grok.
- [ ] Validate the original cwd/worktree before load.
- [ ] Restore Grok ACP endpoints as detached metadata without invoking the ACP factory.
- [ ] Switch `ensureTranscript()` by artifact: `SessionManager` for Pi, hydrate-only `session/load` for Grok ACP.
- [ ] Hold the lease through replay and disposal.
- [ ] Replace the full finalized transcript only after the load barrier; do not append duplicate replay.
- [ ] Avoid publishing stale hydrate output after branch removal or endpoint replacement.
- [ ] Mark successful hydrate only after complete projection.
- [ ] Apply the documented unavailable versus retryable-error classification.
- [ ] Reopen detached Grok ACP endpoints by loading, replacing history, establishing the activation baseline, and then prompting.
- [ ] Test metadata-only branch restore, first-detail load, repeated detail reads, reopen load, stale-race disposal, and all failure classes.
- [ ] Test copied/forged links cannot use a valid session ID without the matching durable binding.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/interactive-agent.test.ts tests/interactive-view.test.ts`
- Expected: Restore never spawns; detail lazy hydration waits for the load barrier; history replacement and failure states are deterministic.

### Task 7: Register and Stream Initial TUI Grok ACP Runs

**Outcome:** A fresh TUI Grok ACP run becomes a trusted Agent View endpoint before its first prompt and has one ACP event-reduction path.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/lifecycle.test.ts`

**Steps:**

- [ ] Change interactive eligibility from non-Grok-family to explicit Pi or Grok ACP; continue excluding plain Grok.
- [ ] Keep current pre-spawn Pi registration unchanged.
- [ ] Add provisional Grok ACP registration that is not branch-visible until a valid session ID exists.
- [ ] Mark the unit started before `session/new` so crash reconciliation sees an attempted unit.
- [ ] On the `session/new` response, acquire the lease and await durable session-ID persistence.
- [ ] Persist the interactive binding, append the host link, grant the trusted branch, and publish the endpoint before the first prompt.
- [ ] Keep the same ACP transport for the initial prompt.
- [ ] On ID, binding, or link persistence failure, send no prompt, dispose the process, remove the provisional endpoint, and preserve fail-closed durable diagnostics.
- [ ] Route TUI Grok ACP through shared interactive execution when registry/endpoint data is present.
- [ ] Add the TUI durable-resume path for an attempted unit with `acpSessionId`: register the stored artifact and host binding/link without creating a new session, activate through `session/load`, wait for replay completion, send only the fixed continuation prompt plus undelivered instructions, and strictly persist delivery from `prompt_completed`.
- [ ] Add the TUI legacy never-started path: create the first session, atomically persist the ID plus capability normalization, then send original task plus accumulated continuations.
- [ ] Keep non-TUI Grok ACP on the one-shot facade.
- [ ] Ensure the transport/projector is the only ACP reducer in TUI mode; execution consumes registry snapshots only.
- [ ] Preserve completion checks, structured output, attempt/result persistence, background execution, and relay behavior above the shared execution layer.
- [ ] Test the strict ordering `unit_started → new response → ID flush → binding flush → link append → prompt`.
- [ ] Test session-ID failure produces no link and no prompt.
- [ ] Test TUI `agent({ runId, task })` with an existing ID performs load rather than new, excludes the original task, sends only undelivered continuation text, and advances delivery only after `prompt_completed`.
- [ ] Test a second TUI resume does not redeliver the confirmed continuation and a response-before-crash fixture leaves it undelivered.
- [ ] Test initial live user/thinking/text/tool-result history appears once in Agent View and once in the parent result projection.
- [ ] Run Pi interactive and non-TUI ACP regression cases.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/tool.test.ts tests/execution.test.ts tests/interactive-agent.test.ts tests/lifecycle.test.ts`
- Expected: The initial prompt cannot precede durable identity/link persistence, and no update is reduced twice.

### Task 8: Enforce Running-Input, Cancel, Disposal, and Worktree Policies

**Outcome:** Grok ACP interaction exposes only supported behavior and cleans up sessions/worktrees predictably.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/interactive-view.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/interactive-view.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/lifecycle.test.ts`
- Test: `packages/pi-agents/tests/grok-acp-interactive-transport.test.ts`

**Steps:**

- [ ] Check the transport's running-input capability before selecting prompt/steer/follow-up.
- [ ] Reject Grok ACP text input during starting/running/active states with `running_input_unsupported`.
- [ ] Verify rejection does not write to the transport, mutate queues, or allocate a second activation.
- [ ] Disable/replace the detail input and show the wait-or-cancel message while running.
- [ ] Route idle/detached/retryable-error Enter to prompt, loading first when detached.
- [ ] Send one `session/cancel` for abort and coalesce repeated abort/shutdown requests.
- [ ] Wait for the real response or cancel grace before terminal settlement and disposal.
- [ ] Dispose Grok connections during LRU eviction, detach, branch removal, and extension shutdown.
- [ ] Retain linked clean Grok ACP worktrees like linked Pi worktrees.
- [ ] Keep existing non-interactive clean-worktree cleanup behavior.
- [ ] Test unsupported Enter/Alt+Enter, idle prompt, cancel, grace timeout, double abort, LRU, shutdown budget, and sticky dispose failure.
- [ ] Test linked worktree retention and missing/unregistered worktree rejection before spawn.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/interactive-agent.test.ts tests/interactive-view.test.ts tests/tool.test.ts tests/lifecycle.test.ts tests/grok-acp-interactive-transport.test.ts`
- Expected: No Grok ACP steer/follow-up is sent or queued; cancellation, disposal, leases, and worktrees follow the stated contract.

### Task 9: Update Documentation and Historical Decision Record

**Outcome:** Users can distinguish plain Grok replay from Grok ACP native resume and understand Agent View capabilities and limitations.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/how-to.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`
- Modify: `docs/plans/2026-07-11-grok-acp-runtime-plan.md`

**Steps:**

- [ ] Update capability tables: Pi session, Grok replay, Grok ACP session.
- [ ] State that Grok ACP `agent({ runId, task? })` no longer needs `allowReplay`; plain Grok still does.
- [ ] Explain the fixed continuation prompt and per-unit undelivered continuation behavior.
- [ ] Document the never-started-unit first-delivery exception.
- [ ] Update Agent View scope to Pi and Grok ACP only.
- [ ] Document idle prompt, disabled running input, absence of steer/follow-up, and Ctrl+X cancellation.
- [ ] Add a how-to flow covering creation, interruption, durable resume, lazy detail hydration, idle continuation, and cancel.
- [ ] Reference `acpSessionId`, artifact union, load request/barrier, lease identity, statuses, and error codes.
- [ ] Explain why replay notifications are authoritative and private Grok files are not parsed.
- [ ] Document cwd/worktree dependence and linked-worktree retention.
- [ ] State that cross-machine restore and recovery after deleting Grok storage are unsupported.
- [ ] Document that run records contain a session ID and cwd but no Grok private session path.
- [ ] Append `## Follow-up (2026-07-15)` to the historical ACP plan, link this plan, and preserve its original out-of-scope statement as historical context.

**Validation:**

- Run: `hk check`
- Expected: Markdown formatting passes, and no current documentation describes Grok ACP as replay-only or Agent View as Pi-only.

### Task 10: Run Full Automated Validation

**Outcome:** The full package and repository checks verify the feature and plain Grok regression boundary.

**Files:**

- All files listed above.

**Steps:**

- [ ] Confirm fake ACP coverage for replay order and load-response barrier.
- [ ] Confirm early session-ID flush, conflict, failure, and crash-window coverage.
- [ ] Confirm continuation delivery and redelivery-window coverage in both non-TUI and TUI durable resume.
- [ ] Confirm legacy queued Grok ACP capability normalization and mixed Pi/Grok/Grok ACP capability coverage.
- [ ] Confirm branch restore/lazy hydrate and session-lease coverage.
- [ ] Confirm cwd/worktree validation and linked retention coverage.
- [ ] Confirm unsupported running input, cancel, disposal, and shutdown coverage.
- [ ] Confirm initial live streaming and tool-output rendering coverage.
- [ ] Confirm existing plain Grok tests and fixtures remain unchanged.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: All package tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: The package builds successfully and keeps the ACP SDK as its declared runtime external dependency.
- Run: `hk check`
- Expected: Repo-wide ESLint and Prettier checks pass.

### Task 11: Perform an Authorized Real Grok ACP Smoke Test

**Outcome:** After explicit user authorization, two real Grok processes prove cross-process load replay and continuation behavior.

**Files:**

- No production or automated-test files.
- Temporary workspace and captured protocol summaries only.

**Steps:**

- [ ] After automated validation passes, stop and request explicit authorization because this smoke test calls an external model, may incur cost, and writes Grok session state under the user's home directory.
- [ ] After authorization, run the complete smoke body inside an explicit `try/finally`; the `finally` block terminates every recorded child process and removes the temporary workspace even when an assertion fails.
- [ ] Inside that guarded body, create a temporary workspace with one read-only fixture.
- [ ] Start the first `grok agent ... stdio` process and perform initialize/auth/session/new.
- [ ] Record the returned session ID through the same persistence callback path.
- [ ] Send a read-only prompt that reads the fixture and returns recognizable text.
- [ ] Record standard user/thought/assistant/tool notifications and the prompt response without logging credentials or raw MCP server URLs.
- [ ] Dispose the first process.
- [ ] Start a new Grok ACP process, initialize, and verify `loadSession === true`.
- [ ] Call `session/load` with the recorded ID, original cwd, and `mcpServers: []`.
- [ ] Verify historical standard updates arrive before the matching load response.
- [ ] After the barrier, send one session-continuation prompt without the original task.
- [ ] Verify a new assistant response and clean process shutdown.
- [ ] Remove the temporary workspace and verify no Grok agent process remains.
- [ ] Do not inspect, modify, or delete Grok's private session files. Note before authorization that Grok may retain the created session because it does not advertise standard session deletion.

**Validation:**

- Manual expected sequence: `new → record ID → prompt → dispose → new process → load replay → load response → continuation → response → dispose`.
- Run after cleanup: `ps -ef | grep '[g]rok agent'`
- Expected: No process created by the smoke test remains.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: All new and existing tests pass, including unchanged plain Grok regression coverage.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: ACP SDK, artifact, transport, projector, and durable types compile without errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: `@balaenis/pi-agents` builds successfully.
- Run: `hk check`
- Expected: Repository linting and formatting pass.
- Manual, only after explicit authorization: execute the real two-process read-only Grok ACP smoke test.
- Expected: The second process replays history before the load response, accepts a continuation afterward, and exits cleanly.

## Deferred Follow-ups

The items below are **not** completed in the current hard-fix pass (Pi original-prompt establishment + worktree retain-on-failure). Track them as later optimizations; do not treat them as open blockers for this pass unless a serious fix already closed one (mark closed in that case).

- **Durable worktreePath cleanup after successful new-worktree removal** — After a newly created clean worktree is deleted, strictly clear the durable `worktreePath` (and related dirty/diff fields), or unify on a begin-then-retain policy so live and disk never retain a path to a removed tree.
- **Abort result worktree diagnostics before markEnd** — On abort, persist `worktreePath` / `worktreeDirty` / diff summary onto the abort result **before** `markEnd` so durable terminal state always carries reopen metadata (partial stamping may already exist on some paths).
- **finalizeWorktree explicit ownership** — Give `finalizeWorktree` an explicit ownership/retain contract so stored/resume worktrees are always forced to retain, independent of `createdNewWorktree` call-site branching.
- **End-to-end await of async continuation-delivery callbacks** — `execution` / `pi-rpc` continuation-delivery callbacks that return promises need end-to-end `await` and error projection into the unit result (today original-prompt establishment is awaited fail-closed; continuation delivery may still be fire-and-forget on some Pi paths).

## Rollout Notes

- This changes only explicit `runtime: "grok-acp"`; no plain Grok configuration is migrated.
- Newly created Grok ACP units advertise session capability.
- Legacy attempted Grok ACP units without a stored session ID become non-resumable and cannot use `allowReplay` as an escape hatch.
- Legacy never-started Grok ACP units may create their first session; the first successful ID write atomically normalizes their stored and in-memory capability to `session`.
- `InteractiveAgentLinkV1` and run record version remain unchanged; `acpSessionId` is additive.
- The existing idle transport limit is shared across Pi and Grok ACP endpoints.
- Lazy Grok transcript hydration starts a short-lived local Grok ACP process but sends no model prompt.
- Linked Grok ACP worktrees are retained and may require manual cleanup.
- Moving the run to another machine, removing the original cwd/worktree, or deleting Grok's session storage makes the endpoint unavailable rather than triggering replay.

## Risks and Mitigations

- **Grok creates a session before `pi-agents` persists its ID.** — Await disk persistence before any prompt and fail closed when an attempted unit has no ID.
- **The ID is persisted but the original prompt was never sent.** — Require replayed user history after load; reject an empty session rather than guessing or resending.
- **A continuation ran but delivery confirmation was lost.** — Persist delivery only after the prompt response and document the remaining ACP at-least-once window.
- **The load response is mistaken for a message payload.** — Consume only response-preceding standard updates and test the response as an explicit barrier.
- **Historical projection changes one-shot result boundaries.** — Keep a dedicated transcript projector and regression-test the existing parser unchanged.
- **Execution and Agent View reduce the same update twice.** — Make the interactive transport/registry the sole TUI ACP reducer; execution projects snapshots only.
- **Two processes touch one Grok session.** — Hold a runtime/canonical-cwd/session-ID process-global lease through full disposal.
- **The implementation couples to private Grok storage.** — Use only protocol IDs and `session/load`; never construct or parse private file paths.
- **Grok cannot find a session after cwd/worktree cleanup.** — Retain linked worktrees and validate the original cwd/worktree before load.
- **Users expect Pi steering semantics.** — Advertise running input as unsupported, disable it in the UI, and never queue or send fake steering commands.
- **A Grok upgrade removes load support or changes errors.** — Require the capability exactly, classify known permanent failures, keep transient errors retryable, and never fall back to replay.
- **Repeated loads duplicate endpoint history.** — Replace the finalized transcript after each complete replay, then compute the activation baseline.
- **Tool output exists only in raw ACP metadata.** — Preserve raw details and project renderable terminal tool-result messages with focused tests.
- **Protocol diagnostics expose secrets in MCP URLs or custom notifications.** — Do not log raw initialize/custom-notification payloads; redact URLs and credentials in tests and smoke summaries.
- **The real smoke test causes external writes or cost.** — Keep it manual, request explicit authorization, explain side effects, and run it only after automated validation.
