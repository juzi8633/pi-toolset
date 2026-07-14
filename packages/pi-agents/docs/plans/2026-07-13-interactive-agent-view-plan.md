# Interactive Agent View Implementation Plan

**Goal:** Add a TUI-only, Claude Code-like agent navigator that lets users inspect current-session Pi subagent transcripts in real time and send messages without changing Pi core.

**Inputs:** User request for an approximate Claude Code subagent switching experience; prior Claude Code source analysis; current `@balaenis/pi-agents` durable-run, native-session, background, rendering, command, and worktree implementations; Pi 0.80.1 extension, TUI, SDK, RPC, session, and keybinding documentation and exported protocol types.

**Assumptions:**

- The first release targets Pi's interactive TUI mode. JSON, print, and RPC host modes keep the existing one-shot `--mode json -p` child execution path.
- Only Pi-runtime units are linked into the interactive navigator. Grok and Grok ACP viewing or messaging are deferred to a later plan.
- The approximation uses a below-editor status widget and one `ctx.ui.custom()` navigator/detail panel; it does not replace Pi's host transcript or switch the host `SessionManager`.
- `/agent view` and `Ctrl+Shift+A` open the navigator immediately, including while the host agent is busy.
- While a child is running, Enter sends a steering message and Alt+Enter queues a follow-up. When it is idle, detached, or recoverable after a process error, Enter reopens the same native Pi session and starts a new prompt.
- Interactive messages sent after the original durable unit completes extend the native child session but do not rewrite the completed run result, attempt history, or parent-model context.
- Child extension UI dialogs received over RPC are cancelled in Version 1 rather than forwarded into the host TUI. Child slash commands are rejected by the interactive input.
- A link custom entry and its durable unit share a random binding ID plus host session ID. The dual record proves that a link was created by this extension for this main session; RunStore remains authoritative for session path, cwd, runtime, configuration fingerprint, and launch reconstruction.
- Reattachment first compares the current raw agent-definition fingerprint with the stored durable fingerprint, then applies stored request-level overrides. A mismatch makes the endpoint unavailable instead of silently changing tools or instructions.
- Links are host-session scoped. A copied link in a newly forked/imported main session fails binding validation; launching or resuming a unit there creates a fresh binding.
- Cross-process attachment to the same child session is out of scope. The registry guarantees one writer per session inside the current Pi process and reports this limitation in documentation.
- Up to four idle Pi RPC children remain attached. Running children are never evicted; excess idle children detach while their persisted sessions remain available for lazy reopening.
- Clean worktrees belonging to linked interactive endpoints are retained rather than automatically removed. Version 1 prioritizes session continuity and documents manual cleanup/disk growth.
- Existing sessions created before this feature do not gain interactive links retroactively. Compatibility discovery from old tool results is deferred to reduce the first-release state matrix.

**Architecture:** Add a strict Pi RPC transport and a session-scoped `InteractiveAgentRegistry` keyed by `runId:unitId`. TUI-hosted Pi units persist a random binding in both the durable unit and a minimal branch-scoped main-session link before spawning, execute through RPC, and send every raw RPC event through one registry-owned reducer. The normal tool execution adapter consumes read-only activation snapshots from that registry, while the widget/custom view subscribes to the same endpoint state. Reattachment validates the dual binding, resolves launch metadata from RunStore, then recreates the child invocation from the stored request and matching current agent definition.

**Tech Stack:** TypeScript, Bun tests, Node.js child processes and streams, Pi exported RPC protocol types, Pi `SessionManager`, Pi extension lifecycle APIs, `@earendil-works/pi-tui` `SelectList`/`Input`/custom components, existing durable run and worktree infrastructure.

---

## Scope and UX Contract

### Included

- A compact below-editor widget whenever the active main-session branch contains at least one `pi-agents-interactive-link`:

  ```text
  ● main
  ○ explore — running · 1 queued
  ○ reviewer — idle
  /agent view or Ctrl+Shift+A
  ```

- A navigator containing `main` plus all valid Pi endpoints linked from the current active branch.
- A detail view with finalized history, current streaming text, active tool activity, queue counts, errors, and a single-line input.
- Live `steer`, queued `follow_up`, idle-session `prompt`, and current-turn `abort`.
- Lazy reopening of a detached/error Pi endpoint with its original session, effective cwd, model/thinking overrides, tools, skills, system prompt, and delegation constraints.
- Reconstruction after extension reload, main-session `/resume`, and `/tree` navigation, provided the durable run, child session, cwd/worktree, and agent fingerprint remain valid.
- Existing foreground/background, single/parallel/chain, durable-run, completion-check, max-turn, and abort semantics.

### Controls

| Context      | Control         | Behavior                                                 |
| ------------ | --------------- | -------------------------------------------------------- |
| Host TUI     | `/agent view`   | Open the agent navigator without waiting for host idle.  |
| Host TUI     | `Ctrl+Shift+A`  | Open the same navigator without submitting text.         |
| Navigator    | Up/Down         | Move between `main` and linked subagents.                |
| Navigator    | Enter           | Close for `main`; open selected child detail otherwise.  |
| Navigator    | Escape          | Close and return to the host editor.                     |
| Child detail | PageUp/PageDown | Scroll one transcript viewport.                          |
| Child detail | End             | Resume tail-following of live output.                    |
| Child detail | Enter           | Send `prompt` when not running, or `steer` when running. |
| Child detail | Alt+Enter       | Send `follow_up` when running; send `prompt` otherwise.  |
| Child detail | Ctrl+X          | Abort only the selected child's current turn.            |
| Child detail | Escape          | Return to the navigator without aborting the child.      |

### Transcript Rendering Rules

- User messages render with a `You` label.
- Assistant text renders as wrapped text; the current partial assistant message follows finalized messages.
- Tool calls reuse exported `formatToolCall()` from `src/render.ts`.
- Tool results show at most five lines and 4 KB per result in the viewport, with a truncation marker. The child session retains the full result.
- Viewport height is `max(8, min(30, tui.terminal.rows - 10))`, leaving room for header, status, input, and help rows.
- New output follows the tail unless the user pages upward. End resumes tail-following.

### Explicitly Out of Scope

- Replacing Pi's main transcript, footer navigation model, or host `SessionManager`.
- Modifying Pi core or adding a public Pi extension API.
- Grok/Grok ACP entries in the interactive navigator.
- Forwarding child `ctx.ui.select/confirm/input/editor` requests.
- Cross-process live attachment or a global daemon.
- Retrofitting old sessions that have no interactive link entries.
- Automatically sending post-completion child conversations into main-model context.
- Automatic pruning of child sessions or retained interactive worktrees.

## Authoritative Metadata and Trust Boundary

The main session persists this invisible branch entry:

```ts
interface InteractiveAgentLinkV1 {
  version: 1;
  runId: string;
  unitId: string;
  bindingId: string;
  hostSessionId: string;
  createdAt: number;
}
```

The corresponding durable unit gains an optional binding map:

```ts
interface InteractiveAgentBindingV1 {
  bindingId: string;
  hostSessionId: string;
  createdAt: number;
}

interface RunUnitRecord {
  // existing fields
  interactiveBindings?: Record<string, InteractiveAgentBindingV1>;
}
```

Registration generates a cryptographically random binding ID, persists the binding in the durable unit and flushes it first, then appends the main-session link. A crash between those writes leaves only an unreachable durable binding; it never creates a trusted link. Use custom entry type `pi-agents-interactive-link`. Register an entry renderer that returns `undefined`, so links occupy no visible transcript row and never enter model context.

On restore or lazy attach, resolve every field from the durable run:

1. Load `RunStore.getRun(runId)` and require a valid Version 1 record.
2. Find `record.units[unitId]`, require `capability === "session"` and Pi runtime, and require `unit.interactiveBindings[bindingId]` to match the link's binding ID, host session ID, and creation timestamp.
3. Require `link.hostSessionId === ctx.sessionManager.getSessionId()`. Copied/imported/forked links from another host session therefore fail closed.
4. Require the stored child session path to be within that loaded run's `sessions/` directory. For restore, require a regular file whose resolved real path remains inside that directory.
5. Resolve effective cwd as `unit.worktreePath ?? unit.effectiveCwd`; require an existing directory. If a worktree path is present, validate it with `openAgentWorktree()` before spawning.
6. Rediscover the named raw agent definition under the stored `agentScope` and compare its existing canonical fingerprint with `unit.agentFingerprint` before applying any invocation overrides.
7. After the raw fingerprint matches, reconstruct effective runtime/model/thinking/isolation from the stored request and immutable workflow position.
8. Resolve current skill paths through the existing skill resolver and rebuild the system-prompt temporary file from the matching agent definition for each new RPC process.
9. Recreate child delegation environment with `buildChildAgentEnv()` and the reconstructed effective agent. Never persist or copy the parent process's secret-bearing environment into link data.

A fresh session path returned by `SessionManager.create()` is a valid planned path before the first child message creates the JSONL file. Initial registration therefore accepts a non-existent session file only when `registrationKind: "initial"` and immediately proceeds to spawn. Restore/lazy attach always requires the persisted file.

## Endpoint State and Serialization Contract

```ts
type InteractiveEndpointStatus =
  | 'registered'
  | 'starting'
  | 'running'
  | 'idle'
  | 'detached'
  | 'error'
  | 'unavailable';

interface InteractiveAgentEndpoint {
  key: `${string}:${string}`;
  hostSessionId: string;
  runId: string;
  unitId: string;
  agent: string;
  title?: string;
  sessionFile: string;
  effectiveCwd: string;
  worktreePath?: string;
  status: InteractiveEndpointStatus;
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  activeTools: Map<string, InteractiveToolActivity>;
  steeringQueue: string[];
  followUpQueue: string[];
  activation?: InteractiveActivation;
  transportReady?: Promise<PiRpcTransport>;
  lastError?: string;
  client?: PiRpcTransport;
  lastUsedAt: number;
}
```

Transitions:

```text
initial register ─► registered ─► starting ─► running ─► idle
restore ──────────► detached ────► starting ─► running ─► idle
error + new prompt ──────────────► starting ─► running ─► idle
starting/running ───────────────────────────────────────► error
missing/tampered metadata or artifacts ────────────────► unavailable
idle LRU eviction ─────────────────────────────────────► detached
```

The registry is the only raw RPC event reducer. `pi-rpc-execution.ts` must not independently append messages, update queues, or reduce tools. It starts an activation with a finalized-message baseline, subscribes to immutable registry snapshots/events for that activation, and projects only post-baseline messages into `SingleResult`.

All endpoint mutations use one serialized transition queue, including raw RPC events. Command writes use three phases to avoid deadlock:

1. Queue a pre-send transition and allocate an activation ID. If no transport exists, create exactly one shared `transportReady` attach/spawn/`get_state` handshake promise and set status `starting`.
2. Send/await the RPC command outside the endpoint transition queue. The activation's first message waits for `transportReady` and sends `prompt`; concurrent messages see the existing activation, wait for the same barrier, then send `steer` or `follow_up` in accepted order. They never start another process or issue a second prompt.
3. Queue acceptance or failure tagged with that activation ID; never overwrite a newer `agent_start`, `agent_settled`, crash, or replacement activation.

The existence of an activation—not only status `running`—causes subsequent default sends to use steering semantics. This preserves stdout event order, gives starting endpoints a writable barrier, and prevents attach, `agent_settled`, and response races.

## File Map

- Create: `packages/pi-agents/src/pi-rpc-transport.ts` — strict JSONL transport, typed command/response correlation, event delivery, UI-request cancellation, bounded diagnostics, abort, and process disposal.
- Create: `packages/pi-agents/src/pi-rpc-execution.ts` — project registry activations into `SingleResult`, usage, max-turn, abort, and existing `onUpdate` semantics.
- Create: `packages/pi-agents/src/interactive-agent.ts` — link/endpoint types, authoritative RunStore resolution, branch reconstruction, canonical RPC reducer, activation serialization, messaging, subscriptions, and idle LRU eviction.
- Create: `packages/pi-agents/src/interactive-view.ts` — below-editor widget and custom navigator/detail/input components.
- Modify: `packages/pi-agents/src/invocation.ts` — add RPC argument construction without `-p` or an argv prompt.
- Modify: `packages/pi-agents/src/execution.ts` — dispatch eligible TUI Pi units through `pi-rpc-execution.ts`; preserve all existing paths elsewhere.
- Modify: `packages/pi-agents/src/run-types.ts` — add optional durable interactive binding records without invalidating existing Version 1 runs.
- Modify: `packages/pi-agents/src/run-coordinator.ts` — persist/flush a unit binding before its main-session link is appended.
- Modify: `packages/pi-agents/src/tool.ts` — register endpoints after context/worktree resolution, pass registry handles into execution, and retain clean linked worktrees.
- Modify: `packages/pi-agents/src/command.ts` — add immediate `/agent view`, completion, and an injected UI-controller test seam.
- Modify: `packages/pi-agents/src/index.ts` — construct the registry/UI controller, register shortcut/link renderer, and install session lifecycle hooks.
- Modify: `packages/pi-agents/README.md` — document navigator controls, Pi-only support, persistence, and limitations.
- Modify: `packages/pi-agents/docs/how-to.md` — viewing, steering, detaching, reopening, and aborting child sessions.
- Modify: `packages/pi-agents/docs/reference.md` — statuses, link schema, RPC behavior, controls, caps, and errors.
- Modify: `packages/pi-agents/docs/explanation.md` — view/input routing versus true host-session switching.
- Create: `packages/pi-agents/tests/pi-rpc-transport.test.ts` — framing, requests, events, UI cancellation, bounded stderr, exit, and abort.
- Create: `packages/pi-agents/tests/pi-rpc-integration.test.ts` — real local Pi startup/get-state/planned-session/stop without a model request.
- Create: `packages/pi-agents/tests/pi-rpc-execution.test.ts` — activation projection, streaming, usage, max turns, settle, and cancellation.
- Create: `packages/pi-agents/tests/interactive-agent.test.ts` — links, trust validation, resolution, messaging, serialization, LRU, and recovery.
- Create: `packages/pi-agents/tests/interactive-view.test.ts` — widget/list/detail rendering, scrolling, input controls, and cleanup.
- Modify test: `packages/pi-agents/tests/invocation.test.ts` — RPC argv construction.
- Modify test: `packages/pi-agents/tests/execution.test.ts` — TUI RPC dispatch and non-TUI JSON regressions.
- Modify test: `packages/pi-agents/tests/run-coordinator.test.ts` — durable binding ordering, idempotence, and flush failures.
- Modify test: `packages/pi-agents/tests/tool.test.ts` — endpoint registration timing and clean-worktree retention.
- Modify test: `packages/pi-agents/tests/command.test.ts` — busy-host `/agent view`, completion, and non-TUI no-op.
- Modify test: `packages/pi-agents/tests/lifecycle.test.ts` — branch rebuild, reload/session replacement, shutdown, and child disposal ordering.

## Tasks

Every new `.ts` file below must start with the repository-required two-line `ABOUTME:` comment.

### Task 1: Implement the Pi RPC Transport

**Outcome:** A child Pi process can be driven through the documented protocol with strict framing, complete UI cancellation envelopes, and deterministic cleanup.

**Files:**

- Create: `packages/pi-agents/src/pi-rpc-transport.ts`
- Create: `packages/pi-agents/tests/pi-rpc-transport.test.ts`
- Create: `packages/pi-agents/tests/pi-rpc-integration.test.ts`

**Steps:**

- [ ] Import and reuse Pi's exported `RpcCommand`, `RpcResponse`, `RpcExtensionUIRequest`, and `RpcExtensionUIResponse` types instead of duplicating the protocol unions.
- [ ] Implement a package-local transport rather than Pi's exported `RpcClient`, because this feature needs injected spawn/invocation seams, raw UI-response writes, bounded stderr, write backpressure, and failure-closed framing not exposed by that class.
- [ ] Implement `PiRpcTransport.spawn()` with injected `spawnFn`, command/args, cwd, env, clock, request-ID generator, and kill timeout.
- [ ] Use `stdio: ['pipe', 'pipe', 'pipe']`. Parse stdout by LF only with Node `StringDecoder`, preserving UTF-8 code points split across Buffer chunks and stripping one trailing CR.
- [ ] Limit an unterminated stdout record to 2 MiB measured as accumulated bytes. On overflow or malformed JSON, reject pending requests, emit one protocol failure, and dispose the child rather than continuing with a desynchronized stream.
- [ ] Retain only the final 1 MiB of stderr, with a leading truncation marker when older bytes are dropped. Do not mirror child stderr directly to host stderr.
- [ ] Correlate responses by generated IDs and expose `request`, `prompt`, `steer`, `followUp`, `abort`, `getState`, and `getMessages`.
- [ ] Await writable-stream drain when `stdin.write()` returns false and reject writes after close.
- [ ] Publish non-response records through `subscribe(listener)` in stdout order.
- [ ] Reply to dialog UI requests with the complete envelope and original ID: `{"type":"extension_ui_response","id":...,"cancelled":true}` for select/input/editor and `{"type":"extension_ui_response","id":...,"confirmed":false}` for confirm. Forward fire-and-forget UI requests as diagnostics without a response.
- [ ] On process error/close, include bounded stderr in the typed error, reject every pending request once, flush `StringDecoder`, and remove listeners/subscriptions.
- [ ] Implement RPC `abort()` as a turn command only. Implement explicit `dispose()` as SIGTERM followed by SIGKILL after five seconds; keep both idempotent.
- [ ] Unit-test split/multiple records, CRLF, Unicode separators inside JSON strings, a multibyte code point split across chunks, byte limits, stderr truncation, out-of-order responses, event order, backpressure, malformed JSON, all UI methods/envelopes, pending rejection, abort without process exit, and repeated disposal.
- [ ] Add a mandatory no-model integration test that launches the installed Pi 0.80.1 CLI in RPC mode, uses a `SessionManager.create()` planned path that does not yet exist, receives `get_state`, verifies the reported session path/ID, and stops cleanly. The test must not send `prompt` or require an API key.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/pi-rpc-transport.test.ts tests/pi-rpc-integration.test.ts`
- Expected: Transport unit tests and local Pi startup/get-state/stop integration pass without network or model access.

### Task 2: Build the Interactive Endpoint Registry and Trust Resolution

**Outcome:** The extension has one branch-aware, trusted authority for endpoint metadata, client ownership, transcript state, and messages.

**Files:**

- Create: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Create: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`

**Steps:**

- [ ] Define Version 1 link, endpoint status/state, launch specification, activation, tool activity, outbound mode, registry event, and stable error-code contracts.
- [ ] Key endpoints by `${runId}:${unitId}` and reject a second in-process key resolving to the same session file.
- [ ] Extend `RunUnitRecord` with optional `interactiveBindings` and add a coordinator method that idempotently writes one binding, flushes the run snapshot, and reports failure before link append. Existing Version 1 records without the optional field remain valid.
- [ ] Implement initial registration with explicit authoritative metadata supplied by `tool.ts`. Accept a planned missing session path only for `registrationKind: 'initial'`; set status `registered` and require immediate activation.
- [ ] Before appending a link, inspect the current `ctx.sessionManager.getBranch()`. Append when that active branch does not already contain the same run/unit link. Generate a fresh binding, persist/flush it through the coordinator first, then append the link. Do not use whole-session deduplication, so a resumed unit on another branch receives a reachable binding there.
- [ ] Implement `restoreActiveBranch(ctx)` by scanning only valid `pi-agents-interactive-link` custom entries on the active branch. Do not infer links from old tool results or global run listings.
- [ ] Treat link fields as untrusted claims. Require the dual durable binding and current host session ID before resolving RunStore/unit/session/cwd/runtime/request/agent details through the Authoritative Metadata rules above.
- [ ] Validate link schema/version, missing run/unit, non-Pi capability, run session-directory containment, regular-file/realpath containment, cwd/worktree availability, agent discovery, fingerprint equality, stored workflow-position overrides, and skill resolution.
- [ ] Reject missing/mismatched binding IDs, host-session mismatches, symlink escapes, link/run path mismatches, edited/imported links, and unit IDs that do not belong to the loaded run.
- [ ] Hydrate detached/error history from `SessionManager.open(sessionFile).getBranch()` after validation, preserving user, assistant, custom, and tool-result messages on the active child branch.
- [ ] Expose `listVisible`, `get`, `subscribe`, `activate`, `send`, `abort`, `detach`, `restoreActiveBranch`, and `shutdown`.
- [ ] Make the registry the sole reducer for message, tool, queue, agent, compaction, retry, UI diagnostic, and process lifecycle records.
- [ ] Serialize every endpoint transition, including raw events. Apply pre-send, transport-send, and activation-tagged post-send phases as specified in the serialization contract.
- [ ] Create one attach/spawn barrier per starting endpoint. Concurrent sends share it; only the activation's first message may issue `prompt`, and later messages wait for readiness before issuing steer/follow-up in order.
- [ ] Route subsequent sends by activation existence while startup is in progress, then by running status after `agent_start`. Never require a not-yet-created transport to be writable.
- [ ] Permit a normal prompt from `idle`, `detached`, or `error`. For `error`, dispose the failed transport, revalidate artifacts/configuration, hydrate the persisted transcript, create the shared readiness barrier, and transition to starting before spawn.
- [ ] When running, map default send to steer and explicit follow-up to follow-up. Reject blank messages, slash-prefixed messages, unavailable endpoints, and sends after shutdown.
- [ ] Track queue updates, current partial message, finalized messages, active tools, errors, activation baseline/sequence, max-turn policy/terminal override, and settle state; publish immutable snapshots after mutation.
- [ ] When the canonical reducer finalizes an assistant message that reaches an activation's max-turn budget, atomically set terminal override `max_turns` before any following `agent_settled` record can settle it, then schedule RPC abort outside the transition queue.
- [ ] Keep at most four idle transports; detach least-recently-used idle endpoints after settle and never evict starting/running endpoints.
- [ ] Test binding persist-before-link ordering, binding flush failure, active-branch link deduplication, fresh bindings on divergent branches, planned missing initial session acceptance, restored missing session rejection, host-session/binding/path/symlink validation, raw fingerprint matching with legal overrides, override reconstruction, skill failure, history hydration, shared startup barrier, prompt acceptance before `agent_start`, event/response order permutations, settle/send races, error recovery first/second concurrent sends, max-turn message immediately followed by settled, one-writer enforcement, queues, immutable subscriber ordering, LRU, and shutdown refusal.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/interactive-agent.test.ts tests/run-coordinator.test.ts`
- Expected: Registry/binding tests pass with temporary run/session stores and fake transports.

### Task 3: Add TUI-Only Pi RPC Execution Projection

**Outcome:** TUI Pi units remain steerable while preserving current `runSingleAgent()` results, usage, durable identity, completion checks, and abort classification.

**Files:**

- Create: `packages/pi-agents/src/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Create: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/invocation.test.ts`
- Modify: `packages/pi-agents/tests/execution.test.ts`

**Steps:**

- [ ] Add `buildPiRpcArgs()` using `--mode rpc` plus the same session, model, thinking, tool, context-file, skill, and system-prompt flags as the current Pi invocation. Do not include `-p`, an argv prompt, or `--no-session`.
- [ ] Extend `RunSingleAgentOptions` with host mode and an optional registered endpoint handle.
- [ ] Dispatch to `runSingleAgentPiRpc()` only when effective runtime is Pi, host mode is `tui`, a persisted/planned session path exists, and the registry supplied an endpoint. Keep JSON, Grok, and Grok ACP branches unchanged.
- [ ] Recreate the system-prompt temporary file for each RPC process. Keep it until the transport completes a successful `get_state` startup handshake, proving Pi parsed startup arguments/resources; on failure, dispose the process before removing the file.
- [ ] Start an initial activation with baseline sequence/message count, then send `Task: <task>` through registry `activate(..., 'prompt')`.
- [ ] Consume registry activation snapshots only; do not subscribe directly to raw transport events or mutate endpoint state.
- [ ] Project finalized post-baseline messages into `SingleResult.messages`, current usage/model/stop reason into result fields, and registry tool/message changes into existing renderer-compatible `onUpdate` snapshots.
- [ ] Count finalized post-baseline assistant messages exactly once for usage and turns. Ignore hydrated history and user messages.
- [ ] Resolve initial execution only after that activation's `agent_settled`, so steering/follow-up queued during the original tool call is included before the parent receives its result.
- [ ] Pass `maxTurns` into activation policy. Let the registry's canonical message reducer atomically set `max_turns` before settle and trigger abort; the execution projection reads that terminal override, preserves existing error text, and disposes only if the protocol does not settle within ten seconds.
- [ ] Forward incoming tool/run abort through registry abort, await `agent_settled`, emit the terminal cancelled/interrupted snapshot, and throw existing `AgentAbortError`. Escalate to transport disposal only on timeout/protocol failure; do not wait for normal RPC process exit.
- [ ] Preserve completion checks, structured-output postprocessing, status derivation, durable metadata, and coordinator callbacks above execution.
- [ ] Test RPC argv parity, activation baseline exclusion, initial prompt, partial text, tools, queue updates, usage, compaction/retry rendering state, settle timing, max turns, abort origin, settle timeout disposal, spawn failure, registry error, and JSON fallback for every non-TUI host mode.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/pi-rpc-execution.test.ts tests/invocation.test.ts tests/execution.test.ts`
- Expected: TUI RPC projection passes and existing one-shot paths retain prior behavior.

### Task 4: Wire Registration, Durable Metadata, and Interactive Worktree Retention

**Outcome:** Every eligible TUI Pi unit becomes visible before spawn and can be reopened with the same durable configuration and filesystem context.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/lifecycle.test.ts`

**Steps:**

- [ ] Add `interactiveRegistry` to `ExecuteAgentToolOptions` and pass it through foreground, parallel, chain, fanout, background, and durable-resume workflows.
- [ ] In `runStepWithContext()`, register only Pi units in TUI mode after effective cwd/worktree and native session resolution, after durable session-path stamping, and before `beginUnit()` or child spawn.
- [ ] Supply current effective agent configuration, stored request/run/unit identity, resolved skills, session path, effective cwd, worktree path, title, and abort metadata to initial registration; this in-memory launch spec is authoritative for the first process.
- [ ] Persist and flush the random durable binding, then append the matching link only after RunStore/unit identity and current branch are known. If either write fails, synthesize `context_error` and do not spawn.
- [ ] Pass host mode and endpoint handle to `runSingleAgent()`.
- [ ] Preserve canonical unit IDs for parallel/chain/fanout so duplicate agent names remain independently addressable.
- [ ] Extend `finalizeWorktree()` with `retainClean` and set it for linked TUI units. Stamp retained clean worktree path/dirty=false on the result; retain existing cleanup in non-TUI paths.
- [ ] Do not automatically remove linked worktrees on reload, session switch, fork, or quit. Document manual cleanup and rely on existing stored path validation on reattach.
- [ ] Keep durable semantics unchanged: messages sent before initial activation settles contribute to the original unit result; later activations mutate only the child session.
- [ ] Test binding/link persistence before begin/spawn, every workflow shape, duplicate names/unit IDs, background registration, fresh binding on resume in a new branch, planned session path, binding/link failure, TUI clean-worktree retention, non-TUI cleanup, and retained dirty metadata.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/tool.test.ts tests/lifecycle.test.ts`
- Expected: Endpoint/link creation precedes child spawn and worktree behavior changes only for linked TUI units.

### Task 5: Implement Navigator, Transcript View, and Input Routing

**Outcome:** Users can select main or a child, inspect live/history output, send messages, abort a child turn, and return without altering the host session.

**Files:**

- Create: `packages/pi-agents/src/interactive-view.ts`
- Modify: `packages/pi-agents/src/command.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Create: `packages/pi-agents/tests/interactive-view.test.ts`
- Modify: `packages/pi-agents/tests/command.test.ts`

**Steps:**

- [ ] Implement `AgentNavigationWidget` as a registry subscriber rendered below the editor. Show main, ordered visible endpoints, status, queue count, and the open hint; clear it when the active branch has no links.
- [ ] Order endpoints by link creation time. Use title, then agent name, then unit ID as label; append a short unit suffix on collisions.
- [ ] Implement one `ctx.ui.custom()` component with internal list/detail modes rather than nested custom dialogs.
- [ ] Use `SelectList` in list mode with main first and endpoint descriptions containing status, run suffix, model, and queue count.
- [ ] Implement detail as a focusable container that propagates focus to pi-tui `Input`, formats transcript lines under the rendering rules, and derives viewport height from `tui.terminal.rows`.
- [ ] Subscribe while custom UI is open and call `tui.requestRender()` on immutable registry updates. Unsubscribe and clear references when closed.
- [ ] Implement tail-follow, PageUp/PageDown, End, Escape, Ctrl+X, Enter, and Alt+Enter exactly as specified.
- [ ] Clear input only after registry acceptance. On rejection, retain text and show the stable error in the detail status row.
- [ ] Show outbound steering/follow-up messages as queued rows until canonical queue/message events consume them.
- [ ] Add `/agent view` before the existing unconditional `ctx.waitForIdle()` in `/agent` parsing. It must open while the host agent/tool is running; other `/agent` subcommands retain current idle waiting.
- [ ] Add `view` argument completion. Outside TUI, return without opening custom UI; RPC clients may observe a warning through extension UI, while print/JSON modes remain silent as documented TUI-only behavior.
- [ ] Register `Ctrl+Shift+A` with the same controller. Ignore repeated open requests while a view is already active.
- [ ] Register the link entry renderer to return `undefined`.
- [ ] Test widget empty/populated state, main/agent rows, duplicate labels, status/queue updates, viewport/truncation, scrolling/tail, focus propagation, all key controls, send-mode selection, retained input on failure, unsubscribe/close, busy-host immediate `/agent view`, unchanged wait behavior for other commands, shortcut reentrancy, and non-TUI no custom UI calls.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/interactive-view.test.ts tests/command.test.ts`
- Expected: Fake TUI/terminal/theme/keybinding tests pass, including opening while host is busy.

### Task 6: Restore Branch Links and Harden Lifecycle

**Outcome:** Agent views survive reload/session/tree transitions without orphan writers, stale UI, or unsafe automatic reattachment.

**Files:**

- Modify: `packages/pi-agents/src/index.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/lifecycle.test.ts`

**Steps:**

- [ ] On `session_start`, create fresh runtime state, restore/validate links from the active branch, hydrate endpoint summaries, and install the widget only in TUI mode.
- [ ] On `session_tree`, rescan the active branch and update visible endpoints. Do not spawn clients merely because a link becomes visible.
- [ ] On every `session_shutdown` reason (`reload`, `new`, `resume`, `fork`, `quit`), abort running RPC turns, await settle with timeout, dispose all transports, clear widget/status, and release subscriptions. Retained sessions/worktrees remain on disk for future main-session resume.
- [ ] Coordinate background cancellation and registry disposal in one ordered handler: stop spinners, cancel durable background runs, await their settlement, then dispose remaining registry transports.
- [ ] Make duplicate aborts from tool signals, background cancellation, Ctrl+X, and shutdown converge on one activation terminal state.
- [ ] Keep invalid restored links visible as `unavailable` with a stable diagnostic; never auto-spawn from an unvalidated link.
- [ ] On child process failure during an activation, mark `error`, reject that activation once, retain session identity, and permit the next prompt to execute the validated error-recovery path.
- [ ] Refuse attachment when a different live in-process endpoint already owns the session; return `session_busy`.
- [ ] Test startup reconstruction, link validation failure, `/tree` before/after link, reload disposal then restore, new/resume/fork transitions, quit disposal, running/idle shutdown, background ordering, duplicate aborts, crash/reopen, session-busy refusal, widget cleanup, and zero remaining fake process/timer/listener handles.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/interactive-agent.test.ts tests/lifecycle.test.ts`
- Expected: Lifecycle tests pass with deterministic cleanup and no automatic attach during restoration.

### Task 7: Document and Manually Verify the Interaction Model

**Outcome:** Users understand how to use the view, what persists, and how native-session interaction differs from durable-run resume.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/how-to.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`

**Steps:**

- [ ] Add the interactive navigator to README features and document `/agent view` plus `Ctrl+Shift+A`.
- [ ] Add a how-to covering launch, open, select, steer, follow-up, abort current child turn, return to main, detach, and reopen.
- [ ] Document controls, statuses, errors, the four-idle-client cap, branch-scoped links, and Pi-only scope in reference.
- [ ] Explain that the extension routes its own view/input and never changes the host session.
- [ ] Explain dual binding/host-session validation, authoritative RunStore resolution, raw-definition fingerprint refusal before overrides, session/cwd/worktree validation, and why link entries contain no trusted paths.
- [ ] Explain that post-completion child messages persist in the child JSONL but do not alter the completed durable result or main-model context.
- [ ] Document child slash-command/dialog restrictions and cross-process attachment limits.
- [ ] Document that linked clean worktrees are retained with no automatic pruning in Version 1; include privacy/disk-growth and manual cleanup guidance.
- [ ] State that pre-feature sessions have no links and are not retrofitted.
- [ ] Complete the manual drill and correct implementation or documentation for every deviation.

**Validation:**

- Run: `bunx prettier --check packages/pi-agents/README.md packages/pi-agents/docs/how-to.md packages/pi-agents/docs/reference.md packages/pi-agents/docs/explanation.md packages/pi-agents/docs/plans/2026-07-13-interactive-agent-view-plan.md`
- Expected: Markdown formatting passes and documented controls/statuses/limits match implementation.

## Manual Validation Drill

1. Build and launch:

   ```sh
   mise run build --package packages/pi-agents
   pi -e ./packages/pi-agents/dist/index.js
   ```

2. Launch a background Pi `explore` agent that performs reads and a delayed command.
3. Verify the widget shows main and explore while the host editor remains usable.
4. Open Ctrl+Shift+A during the running host turn, select explore, and verify history plus new tool activity update live.
5. Submit Enter while the child runs and verify one steering message queues and is consumed before initial settlement.
6. Submit Alt+Enter and verify the follow-up runs only after current child work finishes.
7. Escape to main, continue the host conversation, reopen `/agent view`, and verify child history is unchanged.
8. After the child idles, send another message and verify a new activation uses the same session without repeating the original task prompt.
9. Press Ctrl+X during that activation and verify only the child turn aborts; prompt it again successfully from error/idle state.
10. Launch two parallel Pi agents and verify distinct unit identities and independent views.
11. Execute `/tree` to a point before a link and verify it disappears; navigate back and verify it returns without auto-spawning.
12. Run `/reload` and verify clients dispose, links restore, and the next child message lazily reattaches.
13. Switch away with `/resume`, return to the original main session, and verify child history reconstructs from its session.
14. Launch a worktree-isolated child, complete it cleanly, continue it interactively, restart Pi, and verify the retained worktree/session remain usable.
15. Launch Pi in print and JSON modes and verify child execution keeps the one-shot JSON path with no link/widget calls.
16. Edit a copied main session link to point at another run/unit or symlinked session and verify restore marks it unavailable without reading/spawning from the forged path.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: New transport/registry/execution/UI tests and all existing regressions pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Protocol types, endpoint state, TUI components, and test seams have no TypeScript errors.
- Run: `mise run build --package packages/pi-agents`
- Expected: Package builds with existing tools plus the navigator command/shortcut/lifecycle.
- Run: `hk check`
- Expected: Repository-wide ESLint and Prettier validation passes.
- Inspect: active main session JSONL and one linked child session JSONL.
- Expected: Main session contains invisible minimal link entries; child messages live in child session; no host-session switch or duplicate writer occurred.

## Rollout Notes

- TUI Pi execution changes to RPC; non-TUI automation retains the current child invocation, limiting rollout risk.
- Link schema is independently versioned and dual-bound to one host session. Unknown versions or copied/forked/imported links without a matching durable binding remain unavailable rather than coerced.
- Existing sessions without links remain unchanged and do not show historical agents in the navigator.
- Clean linked worktrees no longer receive automatic successful-run cleanup. This is an intentional continuity tradeoff and must be prominent in release notes.
- No new user configuration ships initially. Usage evidence should guide whether shortcut, idle cap, transcript caps, or worktree retention become settings.

## Risks and Mitigations

- **Fresh session file does not exist at registration.** — Permit only initial planned paths, require immediate activation, and require a real validated file for restore/reattach.
- **Reattached child silently uses changed instructions/tools.** — Resolve from RunStore, reconstruct stored overrides, verify current agent fingerprint, and fail unavailable on mismatch.
- **A forged link targets another valid run/unit.** — Persist a random binding in both the durable unit and host-session link, require matching host session identity, then enforce RunStore session-directory/realpath and worktree boundaries.
- **Two reducers duplicate messages or usage.** — Make registry the sole raw-event reducer; execution consumes activation snapshots only.
- **Concurrent sends race before a transport exists.** — Create one shared startup/handshake barrier, route by activation existence, allow only the first prompt, and serialize later steer/follow-up writes.
- **RPC event/response races settle an activation incorrectly.** — Serialize every mutation, tag post-send transitions, set terminal overrides in the canonical reducer, and test all order permutations.
- **RPC abort is mistaken for process exit.** — Wait for `agent_settled`; dispose only on timeout/protocol failure or explicit lifecycle shutdown.
- **RPC framing corrupts UTF-8 or grows unbounded.** — Use `StringDecoder`, byte caps, bounded stderr, strict LF framing, and failure-closed protocol errors.
- **Child extension UI blocks forever.** — Send complete cancellation response envelopes with the original request ID.
- **Idle children consume memory.** — Retain at most four idle transports and lazily reopen detached sessions; never evict running clients.
- **Large histories slow the TUI.** — Render one bounded viewport, cap displayed tool-result payloads, cache width-dependent lines, and invalidate on endpoint/view changes only.
- **Main and child contexts appear synchronized.** — Display run/unit identity and document that post-completion interaction does not enter main context automatically.
- **Interactive worktrees accumulate.** — Document retention/manual cleanup and defer automatic pruning to a separate design rather than breaking session cwd continuity.
- **A child crashes after external side effects.** — Keep session/cwd identity, mark error, and require a new activation; never claim the interrupted operation completed.
- **IME input is misplaced.** — Implement `Focusable`, propagate focus to `Input`, and test focus/cursor behavior.
