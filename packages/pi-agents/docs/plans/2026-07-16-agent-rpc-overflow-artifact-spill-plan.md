# Agent RPC Overflow and Result Artifact Spill Implementation Plan

**Goal:** Fail closed on oversized non-projectable Pi RPC records while safely projecting canonical replayable records, then externalize oversized authoritative result payloads into validated run-local artifacts without changing Chain, fanout, resume, interactive continuation, or rendering semantics.

**Inputs:** Current `packages/pi-agents` source and tests in this worktree; the historical failed run `run-40cc88b2-52c6-4c7a-a1f4-ee9547a00f1d`; the landed 8 MiB transport mitigation; the completed compact snapshot/memory optimization work; `packages/pi-agents/docs/todos/2026-07-16-subagent-memory-optimization-followups.md`; `packages/pi-agents/docs/analysis/reduced-heap-soak-2026-07-17.md`; installed Pi 0.80.9 RPC, extension, session, and SDK documentation; and installed `pi-agent-core` / `pi-coding-agent` 0.80.9 runtime source.

**Assumptions:**

- Pi upstream is not modified. Oversized replayable-event handling is implemented locally and remains deliberately coupled to exact installed runtime prefixes.
- `packages/pi-agents/package.json` continues to declare peer dependencies at `^0.80.6`; the canonical prefixes and lifecycle ordering used by this plan are verified against the installed 0.80.9 implementation and pinned by compatibility tests.
- Native Pi `sessionFile` remains the sole authoritative transcript. Projected RPC events and disabled `get_messages` calls do not create a second transcript artifact.
- Production registration through `src/index.ts` always provides a `RunStore` and `RunCoordinator`. An oversized authoritative result that reaches a non-durable/test-only path without a run-local store fails closed with a bounded artifact-store-unavailable error rather than being externalized outside a run or inlined above the fixed threshold.
- Fixed Version 1 limits are used: 8 MiB ordinary RPC records, 64 MiB structurally valid projectable RPC records, 256 KiB inline authoritative result payloads, and 64 MiB per artifact. No user-configurable limits are introduced.
- Existing Version 1 records with legacy inline fields remain readable. New reference fields are additive, and no durable Version 2 migration is introduced.

**Architecture:** Keep three authority boundaries separate. The transport performs exact-prefix, fully validating streaming projection only for canonical replayable Pi 0.80.9 event records; the interactive registry then performs a dedicated settle-time session rehydrate inside the endpoint transition before `activation_settled` publication and before deferred idle eviction. Terminal workflow publication writes immutable content-addressed artifacts first, strictly publishes Version 1 references to `run.json`, and only then emits terminal events or parent/continuation output; trusted workflow code resolves structured refs lazily, while child agents receive only a bounded, run-scoped artifact reader.

**Tech Stack:** TypeScript, Bun tests, Node.js streams and filesystem APIs, incremental JSON tokenization, SHA-256, strict LF JSONL, Pi RPC and extension APIs, Pi `SessionManager`, Mise, ESLint, Prettier, and HK.

---

## Current Baseline / Audit Verdict

### The 8 MiB transport mitigation is already landed

`packages/pi-agents/src/pi-rpc-transport.ts` currently defines a transport-local:

```ts
const MAX_STDOUT_RECORD_BYTES = 8 * 1024 * 1024;
```

and reports:

```text
RPC stdout record exceeded 8 MiB
```

`packages/pi-agents/tests/pi-rpc-transport.test.ts` already proves:

- A complete record above the former historical 2 MiB cap is accepted.
- A complete record exactly at 8 MiB is accepted.
- An unterminated record at 8 MiB plus one byte fails closed with `stdout_overflow` and the exact 8 MiB error text.
- A same-chunk, LF-terminated record at 8 MiB plus one byte fails before `JSON.parse` or listener delivery with the same structured transport exit.

This is the current baseline and immediate mitigation, not future work. Task 2 may move the constant to `src/constants.ts` beside projector constants, but it must preserve the 8 MiB value and error text.

The historical failed `agent_end` was 2,320,362 bytes across 143 messages (1 user, 50 assistant, 92 tool-result). It exceeded the former historical 2 MiB cap but is now below 8 MiB. Treat it as evidence that justified the landed mitigation and preserve a generated regression proving that exact historical shape succeeds under the current cap. It is not large enough to exercise the future projector.

Future projector regressions must cross the current cap:

- Generate a canonical aggregate `agent_end` between 8.2 MiB and 8.3 MiB.
- Generate a persisted assistant final message around 12 MiB, then emit its cumulative `message_update`, full `message_end`, `turn_end`, aggregate `agent_end`, and `agent_settled` sequence.
- Keep ordinary non-projectable records on the 8 MiB cap.
- Give only structurally valid canonical projectable records the separate 64 MiB cap.

### Compact snapshots and memory optimization are complete

`packages/pi-agents/src/result-snapshot.ts` exists and exports:

- `snapshotSingleResult`
- `snapshotResults`
- `copySnapshotShell`

The current `snapshotSingleResult` is phase-agnostic. It clears `messages`, derives and freeze-owns bounded presentation, re-bounds diagnostics, preserves full `finalOutput`, and clones/freezes full `structuredOutput`. That behavior is the starting point for Task 5, not a missing prerequisite.

Existing memory/presentation limits are already implemented:

| Existing budget                                |   Value | Purpose                                     |
| ---------------------------------------------- | ------: | ------------------------------------------- |
| `RESULT_PRESENTATION_MAX_BYTES`                | 512 KiB | Total non-authoritative result presentation |
| `RESULT_PRESENTATION_ITEM_MAX_BYTES`           |  64 KiB | One presentation item                       |
| `RESULT_DIAGNOSTIC_MAX_BYTES`                  |  64 KiB | Each diagnostic string                      |
| `INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES` |  64 KiB | Interactive non-authoritative payload item  |
| `INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES`        | 512 KiB | Warm idle retained transcript               |

`result-snapshot.test.ts`, `memory-regression.test.ts`, and `update-coalescer.test.ts` are present and must be extended where artifact work can regress snapshot memory, publication ordering, or deferred-update behavior.

The follow-up document is closed and records 1026 passing package tests with zero failures. The reduced-heap soak is a PASS. Do not gate this plan on the old compact snapshot plan or describe compact snapshots as pending.

### Interactive lifecycle ordering is already activation-scoped

`packages/pi-agents/src/interactive-agent.ts` now has:

- Registry-level `projectFinalizedMessage` retention projection.
- Frozen bounded finalized-message snapshots.
- Lazy transcript hydration through `SessionManager.open(sessionFile).getBranch()`.
- Idle transcript eviction/compaction after settled subscribers observe the full snapshot.
- Per-endpoint transition queues, stream-update coalescing, activation IDs, and retention epochs.

Transport projection and registry projection are independent:

- **Transport-level replayable-event projection** prevents one oversized JSONL record from exhausting the stdout record budget. It may omit a canonical event payload only when the payload is recoverable from the native session before settle.
- **Registry-level `projectFinalizedMessage` projection** runs after a real finalized message exists in memory or has been hydrated. It preserves authoritative assistant text while bounding non-authoritative presentation/retention fields.

Do not reuse `projectFinalizedMessage` as the transport projector, and do not describe it as transport overflow handling.

Raw child RPC `agent_end` still only updates `lastUsedAt` and publishes metadata. It does not inspect `messages`, clear tools/queues/streaming state, settle an activation, or trigger the continuation relay. `agent_settled` remains the only normal terminal event.

The new omission rehydrate must therefore run inside the same endpoint transition that reduces `agent_settled`, before the existing full `endpoint_updated` publication, before `activation_settled`, before activation clearing, and before `scheduleIdleTranscriptEviction`. It must not call `ensureTranscriptHydrated()` or wait on `awaitSessionLease()`: the live endpoint owns that session lease until transport disposal, so the ordinary lazy/detail hydration path would wait on its own writer or race the deferred eviction lifecycle.

### Durable terminal APIs are not yet artifact-safe

Current behavior is:

- `RunCoordinator.finishUnit(...): void` calls `snapshotSingleResult`, mutates the live unit/attempt state, appends `unit_terminal` fire-and-forget, and calls `persist({ flushNow: true })` through coalesced/best-effort persistence.
- `RunCoordinator.finalizeRun(...): Promise<void>` exists, but it mutates live terminal state, calls a `writeRun()` path that catches store errors, and unregisters the run itself.
- `RunStore` has no artifact APIs, no `updateRunStrict()`, and uses best-effort `fsyncFd` / `fsyncDir` helpers in the current atomic run writer.
- Fresh-run finalization in `run-persistence.ts` currently calls coordinator finalization, appends `run_terminal`, and then releases the claim in `finally`.
- Resume finalization duplicates that ordering in `tool.ts`.

The artifact implementation needs a new strict barrier rather than rebranding the current `updateRun()` or `persist({ flushNow: true })` behavior as strict.

`snapshotSingleResult` is called from `execution.ts`, `pi-rpc-execution.ts`, `tool.ts`, `chain.ts`, `abort.ts`, and `run-coordinator.ts`. Because it currently preserves full authority fields, running and low-level terminal callbacks can still expose a very large `finalOutput` or cloned `structuredOutput` before artifact publication. Task 5 must add an explicit provisional snapshot API and update every externalization call site.

Current durable/runtime contracts are inline-only:

- `SingleResult.finalOutput?` and `structuredOutput?`
- `ChainOutputEntry.text` and `structured?`
- `WorkflowFanoutState.items`
- `InteractiveContinuationDetails.output`

`inspectResume()` and `validateFanoutResumeState()` are synchronous. Artifact-backed resume validation therefore requires an intentional async conversion and awaited pre-claim and post-claim call sites.

### Pi 0.80.9 evidence and compatibility rule

Installed Pi 0.80.9 documentation and runtime source establish:

- RPC framing is strict LF JSONL; clients strip one optional trailing CR and do not split on `U+2028` or `U+2029`.
- RPC exposes `get_messages` and emits replayable message, turn, and tool execution events.
- `agent_end` contains run messages and may be followed by retry, compaction retry, or queued continuation.
- `agent_settled` is emitted only after no automatic continuation remains.
- `SessionManager.open()` and `getBranch()` expose the persisted active branch.
- RPC mode serializes each event with `JSON.stringify(value)` and writes the resulting JSON plus LF without reordering keys.
- The installed `pi-agent-core` 0.80.9 producer constructs `message_update` in this order:

```ts
{
  type: 'message_update',
  assistantMessageEvent: event,
  message: { ...partialMessage },
}
```

Some documentation examples show `message` before `assistantMessageEvent`; the projector must follow the installed producer, not the example. Tests must pin the installed 0.80.9 order exactly.

AgentSession runs extension handlers before forwarding `agent_end` to RPC listeners, computes `willRetry`, and persists every finalized message on `message_end`. By `agent_settled`, the active session branch contains the finalized messages needed for rehydrate. Local removal of `agent_end.messages` therefore occurs after Pi extension/retry decisions and does not alter upstream behavior.

### Audit verdict: `agent_end.messages` is unused and `get_messages` should be disabled

`agent_end.messages` has no consumer in `packages/pi-agents`:

- `interactive-agent.ts` treats raw RPC `agent_end` as metadata only.
- `pi-rpc-execution.ts` consumes registry snapshots and `activation_settled`, not raw `agent_end.messages`.
- `execution.ts` handles non-RPC subprocess stream records independently.
- `index.ts` subscribes to the host extension API's `agent_end` only to stop spinners; that host event is not the child RPC stdout record.

Compact every delivered child RPC `agent_end`, including records below 8 MiB, to remove the unconsumed aggregate while retaining `willRetry` and explicit omission metadata.

`PiRpcTransport.getMessages()` also has no production caller. Pi Agent View and resume already use validated, lease-aware native session hydration. Disable both the convenience method and generic `request({ type: 'get_messages' })`; do not add a duplicate transcript artifact path.

## Scope Decisions

### Included

- Preserve the landed 8 MiB ordinary stdout record cap as the baseline.
- Fully validating streaming projection for exact canonical oversized replayable Pi events.
- Compact `agent_end.messages` for every delivered child RPC `agent_end`.
- Verified settle-time direct session rehydrate for omitted message/turn/tool event payloads.
- Explicit `get_messages` rejection in `PiRpcTransport`.
- Run-local immutable text/JSON artifacts addressed by SHA-256.
- Artifact-first strict durable reference publication and awaited terminal event ordering.
- Additive Version 1 inline-or-reference fields with legacy inline compatibility.
- Provisional snapshots that cannot expose authoritative inline values or refs.
- Lazy trusted structured resolution for Chain, JSON Pointer, fanout, and resume.
- A child-only bounded artifact reader loaded only for Pi artifact handoffs.
- Artifact-aware interactive continuation delivery and rendering.
- Focused tests, package validation, and user documentation.

### Excluded

- Any patch to `pi-mono`, `@earendil-works/pi-agent-core`, or `@earendil-works/pi-coding-agent`.
- Any ordinary RPC cap other than the current fixed 8 MiB value.
- A generic local proxy process between `pi-agents` and Pi.
- Configurable limits.
- Duplicate transcript artifacts or an artifact-backed `get_messages` replacement.
- Binary/image artifact formats.
- Automatic artifact garbage collection or partial-run cleanup.
- Durable schema Version 2 or deduplication of all Version 1 result copies.
- Upstream protocol changes or compatibility guesses for uninspected future Pi event shapes.

### Four independent safety budgets

| Boundary                            | Fixed budget | Behavior                                                                                                                                                   |
| ----------------------------------- | -----------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary RPC record                 |        8 MiB | Every response, UI record, queue/retry/compaction event, unknown event, and structurally non-canonical record fails closed above this size                 |
| Canonical projectable RPC record    |       64 MiB | Only exact-prefix, fully validated replayable event records may reach this cap; their large payloads are omitted from listener delivery                    |
| Inline authoritative result payload |      256 KiB | `finalOutput`, structured output, Chain text/structured output, fanout aggregate items, and continuation output stay inline only at or below this boundary |
| One run artifact                    |       64 MiB | Text or JSON bytes above this cap fail with `artifact_too_large`; the limit is not raised dynamically                                                      |

These are not presentation budgets. The existing 512 KiB total presentation, 64 KiB presentation item, 64 KiB diagnostic, 64 KiB interactive non-authoritative item, and 512 KiB idle transcript limits remain unchanged and continue to apply independently.

Projected shell identity strings have an additional fixed `RPC_PROJECTED_SHELL_FIELD_MAX_BYTES = 16 * 1024` UTF-8 sub-limit for `role`, `toolCallId`, and `toolName`. This bounds the retained shell; it is not a fifth record-size budget. A record with an oversized required shell field is non-projectable and remains subject to the ordinary 8 MiB cap.

### `get_messages` decision

Do not expose `get_messages` through this transport:

- It has no production caller.
- Its response is one unbounded JSONL record and is not a replayable event.
- It duplicates prompts and tool results already available from the validated native session.
- Agent View and resume have established `SessionManager.open(sessionFile)` paths.

`PiRpcTransport.request({ type: 'get_messages' })` must reject before request ID allocation, pending-map mutation, or stdin write with:

```text
code: get_messages_disabled
message: get_messages is disabled; hydrate the validated sessionFile instead
```

## Data Contracts

### Compact replayable RPC records

Listener-visible projected records are bounded shells:

```ts
export interface CompactPiRpcAgentEnd {
  type: 'agent_end';
  messages: [];
  messagesOmitted: true;
  willRetry: boolean;
}

export interface CompactPiRpcMessageEvent {
  type: 'message_start' | 'message_update' | 'message_end';
  payloadOmitted: true;
  role: string;
}

export interface CompactPiRpcToolEvent {
  type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end';
  payloadOmitted: true;
  toolCallId: string;
  toolName: string;
  isError?: boolean;
}

export interface CompactPiRpcTurnEnd {
  type: 'turn_end';
  payloadOmitted: true;
}
```

The 0.80.9 canonical top-level prefixes are:

```json
{"type":"agent_end","messages":[...],"willRetry":false}
{"type":"message_start","message":{"role":"assistant",...}}
{"type":"message_update","assistantMessageEvent":{...},"message":{"role":"assistant",...}}
{"type":"message_end","message":{"role":"assistant",...}}
{"type":"turn_end","message":{...},"toolResults":[...]}
{"type":"tool_execution_start","toolCallId":"...","toolName":"...","args":{...}}
{"type":"tool_execution_update","toolCallId":"...","toolName":"...","args":{...},"partialResult":{...}}
{"type":"tool_execution_end","toolCallId":"...","toolName":"...","result":{...},"isError":false}
```

Compatibility rules:

1. A record stays on the ordinary 8 MiB path until an exact installed-runtime prefix identifies an eligible event.
2. A key-order change, duplicate top-level key, missing required shell field, required shell string above 16 KiB UTF-8, or unrecognized prefix never broadens the ordinary cap. If the record exceeds 8 MiB, it fails closed without listener delivery.
3. Once classified, the projector still validates the complete JSON grammar, maximum nesting, canonical top-level order, and required bounded shell fields before emitting anything.
4. Malformed JSON fails as `malformed_json`. A canonical projected record above 64 MiB fails as `stdout_overflow`.
5. Small records continue through ordinary `JSON.parse`. Small `agent_end` records are then defensively compacted regardless of key order; other small records retain their payloads.
6. `agent_end.messages` omission alone does not request settle rehydrate because no local consumer lost data. Any oversized message, turn, or tool event omission marks the endpoint for verified settle rehydrate.

### Run artifact reference

```ts
export type RunArtifactPayload =
  | 'final-output'
  | 'structured-output'
  | 'chain-output-text'
  | 'chain-output-structured'
  | 'fanout-items'
  | 'interactive-continuation';

export interface RunArtifactRefV1 {
  kind: 'run-artifact';
  version: 1;
  runId: string;
  payload: RunArtifactPayload;
  relativePath: string;
  sha256: string;
  bytes: number;
  mediaType: 'text/plain; charset=utf-8' | 'application/json';
}
```

`relativePath` is derived only from digest and media type:

```text
artifacts/sha256/<first-two-hex>/<64-hex-sha256>.txt
artifacts/sha256/<first-two-hex>/<64-hex-sha256>.json
```

Callers never provide paths. `runId`, payload kind, media type, extension, byte count, digest, containment, regular-file status, and no-symlink status are validated on every trusted resolution.

### Additive Version 1 inline-or-reference rules

- `SingleResult`: at most one of `finalOutput` / `finalOutputRef`; at most one of `structuredOutput` / `structuredOutputRef`. Both may be absent when no value exists.
- `ChainOutputEntry`: exactly one of `text` / `textRef`; structured output is absent or represented by exactly one of `structured` / `structuredRef`.
- `WorkflowFanoutState`: exactly one of `items` / `itemsRef`; `unitIds` remains inline and ordered.
- `InteractiveContinuationDetails`: when final text exists, exactly one of `output` / `outputRef`; both may be absent for a no-output terminal.
- Presence checks use own-property semantics so valid JSON values such as `null`, `false`, `0`, and `''` are not mistaken for absence.
- Legacy inline Version 1 records remain valid.
- New records containing both forms, malformed refs, or neither form where the value is required fail as `corrupt_run` before claim or dispatch.
- Hydrated runtime values are never written back over their durable refs.

### Snapshot phases

Use separate APIs rather than a boolean option hidden at call sites:

```ts
snapshotProvisionalResult(result: SingleResult): SingleResult
snapshotSingleResult(result: SingleResult): SingleResult
externalizeTerminalResult(
  result: SingleResult,
  store: RunStore,
  runId: string
): Promise<SingleResult>
```

- `snapshotProvisionalResult` clears `messages`, omits all authoritative inline/ref fields, retains bounded presentation/diagnostics/usage/status, and keeps the current assistant text only as a bounded presentation item when needed for live display.
- `snapshotSingleResult` remains the terminal/legacy compact shell operation and becomes ref-aware. It must not resolve refs.
- `externalizeTerminalResult` reads the private runtime authority, writes any oversized values first, and returns a terminal compact snapshot containing inline values or refs. It must avoid cloning a large structured value merely to decide that it spills.

### Child artifact reader

Pi child prompts containing an artifact handoff may use one dedicated tool:

```ts
pi_agents_read_artifact({
  runId: 'run-...',
  sha256: '<64 lowercase hex>',
  offsetBytes: 0,
  maxBytes: 48 * 1024,
});
```

The extension receives private `PI_AGENTS_RUN_ARTIFACT_DIR` and `PI_AGENTS_RUN_ID` environment values. It verifies the requested run ID, derives the content-addressed path from digest, rejects caller paths, checks regular-file/no-symlink/containment/size/digest, and returns a UTF-8-safe chunk no larger than 48 KiB plus `nextOffsetBytes` and `eof`. It supports long single-line text and JSON. It is loaded only for Pi steps with a handoff; Grok ACP fails before unit dispatch with `artifact_handoff_unsupported`.

## File Map

### RPC projection and lifecycle

- Create: `packages/pi-agents/src/pi-rpc-record-projector.ts` — incremental JSON grammar validator, exact-prefix classifier, omission state machine, and projected record result.
- Modify: `packages/pi-agents/src/constants.ts` — move the current 8 MiB ordinary record cap here and add fixed projector limits.
- Modify: `packages/pi-agents/src/pi-rpc-transport.ts` — integrate streaming projection, compact every `agent_end`, and disable `get_messages`.
- Modify: `packages/pi-agents/src/interactive-agent.ts` — track omitted replayable payloads and perform direct settle-time rehydrate inside the endpoint transition.
- Create: `packages/pi-agents/tests/pi-rpc-record-projector.test.ts` — grammar, prefix, chunk-boundary, cap, and projection tests.
- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts` — 8 MiB baseline, historical 2,320,362-byte success, 8.2–8.3 MiB aggregate, ordinary overflow, and `get_messages` rejection.
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts` — omission rehydrate, settle ordering, max-turn, coalescing, and eviction races.
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts` — activation-scoped settled projection after rehydrate.
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts` — no relay on `agent_end`; relay observes rehydrated pre-eviction settle.
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` — rehydrated oversized transcript is published once and then follows current deferred retention limits.
- Modify: `packages/pi-agents/tests/update-coalescer.test.ts` — sealed stream updates cannot overtake async settle rehydrate.

### Artifact storage and durable contracts

- Create: `packages/pi-agents/src/artifact-store.ts` — content-addressed atomic write, strict sync, validation, verified reads, and safe resolution helpers.
- Create: `packages/pi-agents/src/result-payload.ts` — exact byte accounting, terminal externalization, bounded descriptors, and trusted resolvers.
- Modify: `packages/pi-agents/src/run-types.ts` — `RunArtifactRefV1`, payload kinds, and inline/reference fanout state.
- Modify: `packages/pi-agents/src/types.ts` — result and Chain inline/reference unions while preserving legacy inline fields.
- Modify: `packages/pi-agents/src/run-store.ts` — artifact APIs, strict run/event writes, and reference validation.
- Modify: `packages/pi-agents/src/result-snapshot.ts` — provisional phase, ref-aware terminal copying, and no oversized authority in provisional snapshots.
- Create: `packages/pi-agents/tests/artifact-store.test.ts` — atomicity, sync failure, deduplication, corruption, symlink, traversal, and crash-window coverage.
- Create: `packages/pi-agents/tests/result-payload.test.ts` — thresholds, exact-one-of rules, descriptors, lazy resolution, and bounded failures.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — additive Version 1 ref validation and legacy compatibility.
- Modify: `packages/pi-agents/tests/result-snapshot.test.ts` — phase behavior, ref ownership, idempotence, and size limits.

### Terminal and workflow integration

- Modify: `packages/pi-agents/src/run-coordinator.ts` — async artifact-aware `finishUnit`, strict private-clone terminal writes, strict finalization, and ref-aware fanout merge/mirror/equality.
- Modify: `packages/pi-agents/src/run-persistence.ts` — shared success/failure claim finalization ordering for fresh and resumed runs.
- Modify: `packages/pi-agents/src/execution.ts` — provisional external updates only.
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts` — provisional external updates and authoritative terminal delivery only after the barrier.
- Modify: `packages/pi-agents/src/abort.ts` — preserve private abort authority without externalizing it through provisional callbacks.
- Modify: `packages/pi-agents/src/tool.ts` — await async terminal publication, await async resume inspection, and return bounded artifact-aware parent content.
- Modify: `packages/pi-agents/src/output.ts` — inline/ref-aware parent output and bounded handoff formatting without implicit artifact loads.
- Modify: `packages/pi-agents/src/completion-check.ts` — keep completion checks on private full output before externalization.
- Modify: `packages/pi-agents/src/chain.ts` — ref-aware outputs, trusted structured resolution, fanout items, collection, and resume.
- Modify: `packages/pi-agents/src/template.ts` — substitute bounded descriptors for referenced `{previous}` / `{outputs.<name>}` values.
- Modify: `packages/pi-agents/src/resume.ts` — async artifact validation and runtime-only resolved fanout mappings.
- Modify: `packages/pi-agents/src/interactive-relay.ts` — artifact-first continuation messages, in-flight deduplication, ref-aware rendering.
- Modify: `packages/pi-agents/src/index.ts` — inject `RunStore` into the relay and await tracked relay work on shutdown.
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts` — artifact-first strict ordering, private-clone failures, and no dangling refs.
- Modify: `packages/pi-agents/tests/tool.test.ts` — awaited unit barrier, bounded parent content, and fresh/resume claim failure ordering.
- Modify: `packages/pi-agents/tests/execution.test.ts` — provisional snapshots omit authority.
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts` — provisional/terminal separation after 12 MiB rehydrate.
- Modify: `packages/pi-agents/tests/chain.test.ts` — large previous/named/collected outputs and artifact-backed fanout behavior.
- Modify: `packages/pi-agents/tests/resume.test.ts` — async pre/post-claim artifact validation and no redispatch on corruption.
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts` — artifact-first continuation delivery and duplicate-settle races.
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` — explicit artifact-backed parent/durable serialized-size thresholds.
- Modify: `packages/pi-agents/tests/update-coalescer.test.ts` — pending provisional updates cannot publish after terminal cancellation.

### Child reader, rendering, packaging, and docs

- Create: `packages/pi-agents/src/artifact-reader-extension.ts` — child-only `pi_agents_read_artifact` extension.
- Modify: `packages/pi-agents/src/security.ts` — force-include only the dedicated reader when a handoff requires it.
- Modify: `packages/pi-agents/src/invocation.ts` — resolve the shipped extension from `import.meta.url` and represent artifact-reader invocation requirements.
- Modify: `packages/pi-agents/src/execution.ts` — apply extension arguments and private run-scoped environment values to non-TUI Pi child launches.
- Modify: `packages/pi-agents/src/interactive-agent.ts` — apply the same requirements to independently constructed TUI RPC Pi child launches.
- Modify: `packages/pi-agents/package.json` — publish/export the built child extension and add the package-specific postbuild entry used by the existing Mise build wrapper.
- Create: `packages/pi-agents/tests/artifact-reader-extension.test.ts` — path derivation, chunking, UTF-8 boundary, digest, permission, and corruption tests.
- Modify: `packages/pi-agents/tests/security.test.ts` — conditional dedicated-tool inclusion and isolation.
- Modify: `packages/pi-agents/tests/invocation.test.ts` — artifact-reader invocation requirements and shipped path resolution.
- Modify: `packages/pi-agents/tests/execution.test.ts` — conditional extension/env arguments for non-TUI Pi children.
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts` — conditional extension/env arguments for TUI RPC Pi children.
- Modify: `packages/pi-agents/src/render.ts` — render artifact metadata without reading content.
- Modify: `packages/pi-agents/tests/render.test.ts` — inline/ref collapsed and expanded rendering.
- Modify: `packages/pi-agents/README.md` — limits, artifact layout, handoff behavior, retention, privacy, and validation commands.
- Modify: `packages/pi-agents/docs/reference.md` — protocol projection, schemas, limits, errors, and API behavior.
- Modify: `packages/pi-agents/docs/explanation.md` — control-plane projection versus session/result data planes and strict publication.
- Modify: `packages/pi-agents/docs/how-to.md` — inspect artifacts, use the child reader, and diagnose missing/corrupt refs.

## Tasks

### Task 1: Lock the Current 8 MiB Baseline and Consumption Contract

**Outcome:** Tests distinguish the already-landed mitigation from future projector behavior and prove that local lifecycle consumers do not require `agent_end.messages`.

**Files:**

- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`

**Steps:**

- [ ] Retain the existing tests accepting a complete record above the former historical 2 MiB cap and rejecting terminated/unterminated records above 8 MiB.
- [ ] Generate, rather than commit, a canonical 143-message `agent_end` with the historical 1/50/92 role distribution and exact serialized byte length 2,320,362. Assert it is accepted under the current 8 MiB cap and does not replace the preceding small model/context error with `stdout_overflow`.
- [ ] Generate a canonical `agent_end` between 8.2 MiB and 8.3 MiB and assert the current transport fails with `RPC stdout record exceeded 8 MiB` before listener delivery while still reporting the preceding small model/context error.
- [ ] Generate a fake-child sequence around a persisted 12 MiB assistant final message: cumulative canonical `message_update`, full `message_end`, `turn_end`, aggregate `agent_end`, then `agent_settled`. Assert the current transport fails at 8 MiB before a terminal activation snapshot is published.
- [ ] Keep lifecycle fixtures for `willRetry: true` and `willRetry: false`.
- [ ] Assert `agent_end` only updates metadata: it does not settle, clear active tools/queues/streaming state, complete a Pi RPC execution waiter, or trigger continuation relay.
- [ ] Assert `agent_settled` remains the only normal terminal signal.
- [ ] Record source-audit commands in Final Validation rather than adding brittle tests that scan implementation text.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-transport.test.ts tests/interactive-agent.test.ts tests/pi-rpc-execution.test.ts tests/interactive-relay.test.ts)`
- Expected: all tests pass; the historical 2,320,362-byte shape and exact 8 MiB boundary succeed, while the generated canonical 8.2–8.3 MiB aggregate and 12 MiB sequence encode the current `stdout_overflow` behavior for Task 2 to replace.

### Task 2: Implement Exact Canonical Projection and Settle-Time Rehydrate

**Outcome:** Exact canonical replayable event records may reach 64 MiB without retaining their omitted payloads, while every non-projectable record still fails above 8 MiB and terminal interactive snapshots contain verified session authority before publication.

**Files:**

- Create: `packages/pi-agents/src/pi-rpc-record-projector.ts`
- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/pi-rpc-transport.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Create: `packages/pi-agents/tests/pi-rpc-record-projector.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/tests/update-coalescer.test.ts`

**Steps:**

- [ ] Move `MAX_STDOUT_RECORD_BYTES = 8 * 1024 * 1024` into `constants.ts`; add `MAX_PROJECTABLE_RPC_RECORD_BYTES = 64 * 1024 * 1024`, `RPC_PREFIX_PROBE_BYTES = 512`, `RPC_JSON_MAX_DEPTH = 256`, and `RPC_PROJECTED_SHELL_FIELD_MAX_BYTES = 16 * 1024`. Preserve the exact 8 MiB overflow text.
- [ ] Give the projector injectable limits/depth only as test seams; production always uses the fixed constants.
- [ ] Replace whole-line buffering for eligible oversized records with one-record-at-a-time streaming state that preserves LF framing, optional trailing CR handling, `StringDecoder` split-code-point behavior, and record order.
- [ ] Implement complete decoded-JSON grammar validation: object/array state, keys/values, commas/colons, strings and escapes, four-hex-digit `\u` escapes, numbers, literals, maximum depth, record completion, and EOF behavior.
- [ ] Classify only exact installed 0.80.9 prefixes before the ordinary cap. Pin `message_update` as `type`, then `assistantMessageEvent`, then `message`, despite contrary documentation examples.
- [ ] For canonical `agent_end`, discard `messages`, validate/preserve boolean `willRetry`, and emit only after the entire record validates.
- [ ] For canonical message events, extract and validate the early `message.role`, discard the large payload, and emit the compact message shell.
- [ ] For canonical tool events, preserve bounded/validated `toolCallId`, `toolName`, and terminal `isError` when present; discard args/result payloads. For `turn_end`, retain only omission metadata.
- [ ] Track raw UTF-8 bytes seen even after payload discard. Fail a canonical projected record above 64 MiB as `stdout_overflow`.
- [ ] Revoke projectable treatment on any later canonical-order/shell violation. If the record has crossed 8 MiB, fail closed without listener delivery; never emit a synthetic event from a structurally non-canonical record.
- [ ] Fail malformed grammar as `malformed_json`; do not use omission to make invalid JSON valid.
- [ ] Preserve records after a projected LF in the same input chunk and preserve stdout ordering under backpressure.
- [ ] Keep ordinary `JSON.parse` for records at or below 8 MiB. Defensively rewrite every small valid `agent_end` to `messages: []` plus `messagesOmitted: true`; leave other small payloads unchanged.
- [ ] Add endpoint omission state scoped to the active transport generation/activation, including expected finalized message count and omitted assistant message-end count. `agent_end.messages` omission alone does not set this state.
- [ ] On compact message/tool/turn events, clear only unsafe transient streaming/tool rows and publish bounded omission metadata while the activation remains running.
- [ ] On compact assistant `message_end`, increment the activation's observed assistant count and enforce existing `maxTurns` immediately from the preserved role. Abort through the existing non-blocking path; do not defer the turn policy until disk hydration.
- [ ] Convert the relevant event reduction path to awaited transition work. Sealed coalesced stream events must reduce before their boundary event, and an async `agent_settled` rehydrate must complete before any later transition runs.
- [ ] Add a dedicated `rehydrateProjectedPiAtSettle` path that runs only for a live Pi endpoint with omission state. It directly opens the endpoint's already validated/owned `sessionFile` without `ensureTranscriptHydrated()` and without waiting on the endpoint's session lease.
- [ ] Read `SessionManager.open(sessionFile).getBranch()`, isolate/project finalized messages through the existing registry-level helpers, verify the branch contains the expected post-baseline finalized count and assistant count, replace the finalized view, set `transcriptHydrated`, and recompute endpoint usage/model/stop reason from the hydrated branch without adding to counters already observed from compact events.
- [ ] Only after successful rehydrate may normal `agent_settled` status reduction publish the full snapshot, emit `activation_settled`, clear the activation, schedule deferred idle eviction, and enforce idle LRU.
- [ ] On missing/malformed/path-mismatched/stale/incomplete session data, set `errorCode: 'hydrate_error'`, settle the activation as failed with a bounded error, and never publish a successful omission-only terminal snapshot.
- [ ] Add projector unit tests across every byte split for representative event prefixes, escaped quotes/backslashes, `\u2028`/`\u2029`, multibyte UTF-8, nested arrays/objects, CRLF, multiple records/chunk, EOF, invalid numbers/literals/escapes, trailing commas, duplicate/out-of-order keys, depth overflow, late shell invalidation, unknown events, and injected ordinary/projectable caps.
- [ ] Change the Task 1 overflow expectations into successful projection/rehydration expectations. Feed both generated fixtures through `FakeChild.stdout` and the real `PiRpcTransport`; route the 12 MiB case through the real registry reducer, and assert a following small record remains synchronized. Generate data in test code; do not commit multi-megabyte fixtures.
- [ ] Add oversized `role`, `toolCallId`, and `toolName` tests proving required shell strings above 16 KiB revoke projectability and fall back to the ordinary 8 MiB cap.
- [ ] Extend interactive memory/coalescer tests so the 12 MiB rehydrated snapshot reaches settled consumers once, then the existing deferred eviction path runs without racing a newer activation.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-record-projector.test.ts tests/pi-rpc-transport.test.ts tests/interactive-agent.test.ts tests/pi-rpc-execution.test.ts tests/interactive-relay.test.ts tests/memory-regression.test.ts tests/update-coalescer.test.ts)`
- Expected: the historical 2,320,362-byte shape succeeds; the 8.2–8.3 MiB aggregate projects; the 12 MiB final output is restored before settle; ordinary non-projectable records fail above 8 MiB; canonical projectable records fail above 64 MiB; and deferred eviction never precedes settled publication.

### Task 3: Disable the Unused `get_messages` Path

**Outcome:** No `pi-agents` transport call can request an unbounded transcript response; validated native session hydration remains the only history path.

**Files:**

- Modify: `packages/pi-agents/src/pi-rpc-transport.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`

**Steps:**

- [ ] Remove `PiRpcTransport.getMessages()` and the now-unused `AgentMessage` import.
- [ ] Guard public `request()` before `send()`: reject `type: 'get_messages'` with `PiRpcTransportError('get_messages_disabled', 'get_messages is disabled; hydrate the validated sessionFile instead')`.
- [ ] Assert rejection occurs before request ID allocation, pending-map mutation, timeout creation, or stdin write.
- [ ] Replace the request-correlation test's second `get_messages` request with another bounded command such as a second `get_state` request.
- [ ] Keep normal interactive lazy hydration and the new settle-only direct rehydrate as separate native-session consumers.
- [ ] Document that upstream Pi still supports `get_messages`, but this integration intentionally disables it because it is unbounded and redundant.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-transport.test.ts)`
- Expected: disabled requests produce `get_messages_disabled`, write no stdin, create no pending request, and all other request correlation tests pass.

- Run: `rg -n "getMessages\(|get_messages" packages/pi-agents/src packages/pi-agents/tests`
- Expected: source contains only the explicit disabled-command guard; tests contain only the rejection coverage; there is no callable production history request.

### Task 4: Add Run-Local Artifacts and Strict Store Primitives

**Outcome:** Immutable text/JSON artifacts are validated and durable before references can be strictly published.

**Files:**

- Create: `packages/pi-agents/src/artifact-store.ts`
- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Create: `packages/pi-agents/tests/artifact-store.test.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Add `RESULT_INLINE_PAYLOAD_MAX_BYTES = 256 * 1024` and `RUN_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024`.
- [ ] Add `RunArtifactPayload` and `RunArtifactRefV1` exactly as defined in Data Contracts.
- [ ] Extend `RunStore` with `writeTextArtifact`, `writeJsonArtifact`, `readTextArtifact`, `readJsonArtifact`, and `resolveArtifactPath`. Methods accept `runId`, semantic payload kind, and value/ref—not caller paths.
- [ ] Serialize text as exact UTF-8. Serialize JSON as deterministic two-space-indented JSON plus one trailing LF; reject cycles, `undefined`, non-finite numbers, unsupported non-JSON values, and bytes above 64 MiB.
- [ ] Hash the exact persisted bytes and derive destination path solely from SHA-256 and media type.
- [ ] Create `artifacts/sha256/<prefix>/` with private permissions (`0700` directories, `0600` files where supported).
- [ ] Write a same-filesystem private staging file, write all bytes, strictly `fsync` the file, atomically rename to the digest path, and strictly sync the containing directory chain on POSIX. Keep explicit Windows behavior: strict file flush and atomic rename, but no unsupported directory `fsync` claim.
- [ ] On an existing digest path, verify regular-file type, exact bytes, and digest before treating the write as deduplicated. Never trust `EEXIST` alone.
- [ ] Return a ref only after artifact publication completes. A crash may leave an unreferenced staging/content file, never a reference to an unpublished file.
- [ ] Resolve refs with strict run ID, payload/media type, lowercase digest, byte count, relative-path derivation, containment, `lstat`, `realpath`, regular-file, no-symlink, and SHA-256 checks. Use `O_NOFOLLOW` where supported and keep the realpath guard on every platform.
- [ ] Add strict filesystem helpers separate from current best-effort helpers. Add `RunStore.updateRunStrict()` and `appendEventStrict()` on the same per-run serial queue; strict variants propagate file and supported directory sync failures.
- [ ] Keep current `updateRun()` / `appendEvent()` behavior for existing non-terminal/coalesced paths until their call sites are intentionally migrated.
- [ ] Extend `validateRunRecord` and nested validators for result refs, Chain output refs, and fanout item refs. Accept legacy inline-only Version 1 records; reject both/neither invalid unions and malformed/cross-run refs as `corrupt_run`.
- [ ] Add narrow filesystem fault-injection seams for tests; do not expose them as user configuration.
- [ ] Leave unreferenced artifacts in place until the entire inactive run directory is manually removed. Do not implement GC.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/run-store.test.ts)`
- Expected: identical bytes deduplicate; strict sync failures propagate; refs are returned only after publication; tampered, missing, oversized, symlinked, path-escaping, wrong-run, wrong-size, and wrong-digest refs fail closed; legacy inline Version 1 records still load.

### Task 5: Make Result Snapshots Phase-Aware and Artifact-Ready

**Outcome:** Provisional updates remain bounded and authority-free, while terminal snapshots preserve authoritative values by inline field or immutable ref.

**Files:**

- Create: `packages/pi-agents/src/result-payload.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/result-snapshot.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Modify: `packages/pi-agents/src/completion-check.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/abort.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Create: `packages/pi-agents/tests/result-payload.test.ts`
- Modify: `packages/pi-agents/tests/result-snapshot.test.ts`
- Modify: `packages/pi-agents/tests/execution.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/tests/update-coalescer.test.ts`

**Steps:**

- [ ] Add `finalOutputRef` and `structuredOutputRef` to `SingleResult`, preserving the existing inline fields for small and legacy values.
- [ ] Add `textRef` and `structuredRef` to `ChainOutputEntry` and update `cloneSingleResult` / output-entry copy helpers to copy refs without resolving them.
- [ ] Implement exact UTF-8 byte measurement for text and for the exact JSON serialization used by the artifact store.
- [ ] Implement `snapshotProvisionalResult()`. It must clear messages, omit `finalOutput`, `structuredOutput`, `finalOutputRef`, and `structuredOutputRef`, retain existing bounded/frozen presentation and diagnostics, and preserve current live text only through a bounded presentation item.
- [ ] Keep `snapshotSingleResult()` as the compact terminal/legacy operation, make it copy/validate refs, and preserve current ownership/idempotence behavior for inline small values.
- [ ] Implement `externalizeTerminalResult()` so values at or below 256 KiB remain inline, values above 256 KiB are artifact-first and replaced by refs, and a large structured value is not deep-cloned before the spill decision.
- [ ] Preserve exact authority separation: never put a descriptor string in `finalOutput`, never put a ref object in `structuredOutput`, and never hydrate a ref merely to snapshot or render it.
- [ ] Add bounded parent and child handoff formatters (maximum 2 KiB). Parent descriptors may include the validated absolute path; child descriptors contain run ID, digest, bytes, payload kind, and explicit `pi_agents_read_artifact` instructions.
- [ ] Add trusted async resolvers for text/structured refs. Public rendering and ordinary parent result formatting use descriptors, not resolvers.
- [ ] Run final-output extraction, completion checks, structured JSON extraction/schema validation, status stamping, and worktree finalization against the private full runtime result before externalization.
- [ ] Update `execution.ts` and `pi-rpc-execution.ts` running and low-level terminal `onUpdate` paths to use `snapshotProvisionalResult`; no low-level callback may carry inline/ref authority.
- [ ] Update `tool.ts` Parallel/Single aggregate updates and `chain.ts` running/fanout aggregate updates to use provisional shells until the terminal barrier returns an artifact-aware result.
- [ ] Keep abort authority private inside `AgentAbortError` until `runStepWithContext` terminalizes it; do not replace the private abort result with a provisional authority-free shell before terminal processing.
- [ ] On artifact write failure, build a bounded `artifact_write_error` result containing status, error code/message, and native session/worktree identity, but neither the oversized value nor a dangling ref.
- [ ] On an oversized non-durable path without a run-local store, produce bounded `artifact_store_unavailable` failure rather than writing outside a run or exceeding the inline threshold.
- [ ] Extend snapshot and coalescer tests to prove pending provisional data cannot emit after terminal cancellation and provisional JSON never contains large inline values or refs.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/result-payload.test.ts tests/result-snapshot.test.ts tests/completion-check.test.ts tests/execution.test.ts tests/pi-rpc-execution.test.ts tests/tool.test.ts tests/chain.test.ts tests/memory-regression.test.ts tests/update-coalescer.test.ts)`
- Expected: small terminal values remain behavior-compatible; provisional updates contain no authority fields; large terminal values become verified refs; completion/schema checks use full private values; descriptor text is bounded; artifact failures do not leak the original payload.

### Task 6: Make Unit and Run Finalization an Async Strict Barrier

**Outcome:** No terminal callback, durable terminal event, claim release, or continuation message can observe a ref before its artifact and strict authoritative record exist.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/run-persistence.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/interactive-relay.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/execution.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`
- Modify: `packages/pi-agents/tests/update-coalescer.test.ts`

**Steps:**

- [ ] Change `RunCoordinator.finishUnit()` to `Promise<SingleResult>`. It returns the committed artifact-aware terminal snapshot used by workflow callers and parent delivery.
- [ ] Change durable `endUnit` plumbing to return/await that promise. Make `runStepWithContext`'s terminal finalizer async and update every success, abort, early failure, and thrown-error return path to await it.
- [ ] Keep terminal postprocessing exactly once. If artifact or durable publication throws, recognize the typed publication error and do not recursively call `finishUnit` a second time from the outer catch.
- [ ] In `finishUnit`, cancel the pending coalesced timer, externalize authority first, and construct the terminal unit/attempt mutation on a private clone of the latest live/disk-authoritative state.
- [ ] Strictly publish the cloned unit result through the coordinator's existing per-run durable queue using `store.updateRunStrict()`. Preserve current disk-authoritative session, ACP, binding, attempt, fanout, and continuation merge rules.
- [ ] Do not mutate live state before strict `run.json` success. On strict write failure, leave live state non-terminal, throw `durable_write_error`, and ensure no later coalesced flush can see the rejected private terminal clone.
- [ ] After strict `run.json` success, append `unit_terminal` with `appendEventStrict()`, then mirror the committed unit/attempt/result into live state and return the snapshot. If event append fails after the authoritative run write, mirror the committed disk state but still throw `durable_write_error`; never report parent success.
- [ ] Keep `RunCoordinator.finalizeRun(): Promise<void>`, but make it construct a private final run clone and use `updateRunStrict()` without the current swallow-all `writeRun()` path.
- [ ] Externalize any final Chain collect outputs before strict run finalization. A successful final record may contain only inline values below 256 KiB or verified refs.
- [ ] Remove unregistration from `RunCoordinator.finalizeRun()`. The claim owner must control final event, unregistration, and claim terminal ordering.
- [ ] Consolidate fresh `run-persistence.ts` and resume `tool.ts` finalization through one helper. Success ordering is: strict coordinator finalization -> strict `run_terminal` append -> coordinator unregister -> `releaseRun`.
- [ ] Failure ordering is: cancel/remove the live registration (which cancels pending timers) -> `abandonRun` -> rethrow. Do not release a failed finalization claim and do not leave a registered run without its claim.
- [ ] Cover failures before artifact publication, during strict unit write, during `unit_terminal`, during Chain collect spill, during strict run write, and during `run_terminal`. Assert no path reports success or later persists a dangling ref.
- [ ] Emit the authoritative parent terminal update only after awaited `finishUnit`. Low-level execution terminal emissions remain provisional and bounded.
- [ ] Make continuation relay artifact-aware. Inject `RunStore`, reserve `endpointKey + activationId` in an in-flight set before artifact I/O, spill output above 256 KiB, and call `pi.sendMessage` only after artifact publication.
- [ ] Because artifact publication adds an async gap, immediately before `sendMessage` recheck relay disposal, current host session ID, exact branch binding link, registry active-branch membership, endpoint generation, and activation ID. If `/tree`, session switch, detach, or a newer activation invalidates trust while I/O is pending, suppress delivery without leaking the output.
- [ ] On continuation artifact failure, send at most a bounded error/status message without the original output. Remove the in-flight reservation appropriately so a later distinct activation may proceed, while duplicate settle for the same activation cannot double-write/double-send.
- [ ] Track relay promises and add `waitForIdle()`. In `index.ts`, await relay idle work during session shutdown before disposing the relay and registry.
- [ ] Add controlled-promise ordering tests for artifact -> strict run write -> strict terminal event -> live/parent/relay publication, including duplicate settle during artifact I/O, `/tree` or host-session changes while relay artifact I/O is blocked, and a rejected terminal clone followed by a stale timer fire.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts tests/execution.test.ts tests/pi-rpc-execution.test.ts tests/chain.test.ts tests/interactive-relay.test.ts tests/update-coalescer.test.ts)`
- Expected: terminal publication is fully awaited; no parent/relay success precedes artifact and strict run authority; success releases only after unregister; failures unregister then abandon; stale coalesced updates cannot publish rejected authority.

### Task 7: Preserve Chain, Fanout, Resume, and Child Handoff Semantics

**Outcome:** Referenced values preserve existing workflow behavior without injecting megabytes into prompts or trusting durable paths.

**Files:**

- Create: `packages/pi-agents/src/artifact-reader-extension.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/result-payload.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/template.ts`
- Modify: `packages/pi-agents/src/security.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/package.json`
- Create: `packages/pi-agents/tests/artifact-reader-extension.test.ts`
- Modify: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/tests/security.test.ts`
- Modify: `packages/pi-agents/tests/invocation.test.ts`
- Modify: `packages/pi-agents/tests/execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Modify: `packages/pi-agents/tests/resume.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Convert `ChainOutputEntry` and `WorkflowFanoutState` to the exact inline/reference unions in Data Contracts. Add a runtime-only `ResolvedWorkflowFanoutState` with verified inline `items`; never serialize it as durable state.
- [ ] Reuse a unit result's text/structured refs for named Chain outputs when media type/digest match. Do not read and rewrite identical authority solely to change semantic payload kind; construct a validated ref with the new payload kind and same content address.
- [ ] For `{previous}` and `{outputs.<name>}`, keep exact existing substitution for inline text. For refs, substitute a bounded child handoff descriptor and mark the step invocation as requiring the artifact reader.
- [ ] Keep `outputSchema` extraction and validation before unit externalization. For internal `readJsonPointer`, fanout source expansion, or collect operations after externalization, resolve structured refs through `RunStore` and verify them first.
- [ ] Resolve each artifact-backed fanout result lazily when building the collected array and verify it again at the point of use. Externalize collected Chain text/structured values above 256 KiB before they enter externally visible details or final run state.
- [ ] Before fanout expansion persistence, reject any individual item whose exact JSON bytes exceed 256 KiB with `fanout_item_too_large`; preserve the established inline `{item}` template contract.
- [ ] Permit the aggregate ordered item list to spill when several individually valid items exceed 256 KiB together. Publish `itemsRef` first, then strictly persist the mapping and queued child units atomically before scheduling any worker.
- [ ] Update coordinator fanout equality, idempotence, disk/live mirror, merge, and capture logic for inline/ref unions. When a fresh inline candidate is compared with a stored ref, hash/externalize the candidate and compare verified digest/media type; do not trust path text or hydrate merely for equality.
- [ ] Change `validateFanoutResumeState()` and `inspectResume()` to async. During read-only pre-claim inspection and again after claim against the freshly loaded record, resolve and verify every `itemsRef` plus every ref reachable from completed unit results and persisted Chain outputs that resumed execution may read.
- [ ] Update `preflightAndClaim()` and direct `tool.ts` pre/post-claim inspection call sites to await the async API. No worker may be scheduled until the post-claim verification of all reachable authority refs succeeds.
- [ ] Return runtime-only `resolvedFanouts` and verified completed-output metadata from successful post-claim inspection and thread them into `RestoredChainState`. `chain.ts` consumes runtime state; `run.json` and coordinator mirrors retain refs. Reverify the artifact at each lazy content read so a post-inspection replacement cannot be trusted.
- [ ] On missing, tampered, unparsable, wrong-run, or oversized artifacts, fail with `artifact_missing` / `artifact_corrupt` before dispatch. Never downgrade a completed unit to incomplete, redispatch completed work, or recompute a frozen mapping from mutable upstream output.
- [ ] Implement `artifact-reader-extension.ts` as a standalone default Pi extension that registers only `pi_agents_read_artifact` with the fixed input contract and 48 KiB output cap.
- [ ] Verify the private env run ID/root, derive the digest path, reject any path-like input, stream/hash the regular file, and return a code-point-safe chunk with continuation metadata.
- [ ] Resolve the shipped extension path from `import.meta.url` and carry a typed artifact-reader requirement through `invocation.ts`. Apply explicit `--extension <dist/artifact-reader-extension.js>` and private env only when a rendered Pi task contains a handoff, in both independent launch paths: non-TUI Pi children in `execution.ts` and TUI RPC Pi children in `interactive-agent.ts`.
- [ ] Extend `buildToolCliArgs` with a narrow force-include mechanism: when the reader is required, include `pi_agents_read_artifact` in an existing `--tools` allowlist and remove only that name from excludes. The feature adds no new general `read`, `bash`, or filesystem capability; capabilities already granted by the selected agent configuration remain unchanged.
- [ ] Reject Grok ACP handoff before `beginUnit`/registration/dispatch with `artifact_handoff_unsupported`.
- [ ] Build/publish `dist/artifact-reader-extension.js` as a separate entry without bundling a second host SDK. Keep the Bun package test suite independent of ignored `dist/`; verify the pack manifest only after the package build in Final Validation.
- [ ] Test small workflow byte-for-byte prompt parity, large sequential previous output, large named text/structured output, large collect output, aggregate fanout spill, individual item rejection, current/resumed fanout, runtime hydration not persisted, inline/ref idempotence, pre/post-claim corruption, no duplicate dispatch, Pi reader injection, and Grok rejection.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts tests/chain.test.ts tests/security.test.ts tests/invocation.test.ts tests/execution.test.ts tests/interactive-agent.test.ts tests/run-coordinator.test.ts tests/run-store.test.ts tests/resume.test.ts tests/tool.test.ts)`
- Expected: small prompts are unchanged; handoffs add the bounded reader to both Pi launch paths without adding general filesystem tools; preconfigured agent capabilities remain unchanged; Grok rejects before dispatch; aggregate mappings spill and hydrate only in runtime; every reachable completed ref is verified before worker scheduling; corrupt refs stop before side effects; completed units are never redispatched.

### Task 8: Update Rendering and Documentation

**Outcome:** Users can distinguish authority from descriptors, inspect artifacts safely, and understand fixed limits and retention behavior.

**Files:**

- Modify: `packages/pi-agents/src/render.ts`
- Modify: `packages/pi-agents/src/interactive-relay.ts`
- Modify: `packages/pi-agents/tests/render.test.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`
- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`
- Modify: `packages/pi-agents/docs/how-to.md`

**Steps:**

- [ ] Preserve current collapsed status/task/usage behavior. For a referenced output, show a short artifact indicator rather than loading content.
- [ ] In expanded rendering, show payload kind, formatted byte count, validated path when available, and digest prefix. Do not synchronously read artifact content.
- [ ] Render interactive continuation refs with the same metadata; inline continuation output keeps current rendering.
- [ ] Add `artifacts/sha256/...` and its private/content-addressed semantics to the durable run directory documentation.
- [ ] Document the four independent limits: 8 MiB ordinary RPC, 64 MiB canonical projectable RPC, 256 KiB authoritative inline, and 64 MiB artifact.
- [ ] Separately document existing 512 KiB/64 KiB presentation and interactive-retention budgets so users do not treat them as artifact or transport caps.
- [ ] State that the historical 2,320,362-byte `agent_end` exceeded the former historical cap but is mitigated by the landed 8 MiB baseline; future projector coverage starts above 8 MiB.
- [ ] Document exact-prefix compatibility and that a future canonical key-order change falls back to the 8 MiB ordinary failure until inspected and pinned.
- [ ] State peer support accurately: package floor `^0.80.6`, behavior inspected and tested against installed Pi 0.80.9.
- [ ] Explain transport omission versus registry-level `projectFinalizedMessage`, direct settle-time rehydrate, `agent_settled` terminal authority, and why the ordinary lazy hydration path is not reused at settle.
- [ ] Document disabled `get_messages`, additive Version 1 ref fields, exact-one-of validation, error codes, artifact-first publication, claim failure ordering, Chain descriptors, fanout refs, and async resume validation.
- [ ] Add parent/user inspection examples using the displayed validated path and ordinary `read`, plus child examples using repeated `pi_agents_read_artifact` calls and `nextOffsetBytes` for long single-line content.
- [ ] Document privacy and retention: artifacts may contain sensitive model/tool output, remain with the run directory, receive no automatic GC, and are removed only with the complete inactive run directory.
- [ ] Add the focused test, package test, typecheck, build, and `hk check` commands to README test guidance where appropriate.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/render.test.ts tests/interactive-relay.test.ts)`
- Expected: inline rendering remains compatible; refs render metadata without loading content; continuation rows remain bounded.

- Run: `rg -n "8 MiB|64 MiB|256 KiB|512 KiB|get_messages|agent_settled|projectFinalizedMessage|artifact|sha256|pi_agents_read_artifact|0\.80\.9|\^0\.80\.6" packages/pi-agents/README.md packages/pi-agents/docs/{reference,explanation,how-to}.md`
- Expected: limits, authority boundaries, compatibility version, reader usage, retention, and disabled command are documented consistently.

## Final Validation

### Focused suites

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-record-projector.test.ts tests/pi-rpc-transport.test.ts tests/interactive-agent.test.ts tests/pi-rpc-execution.test.ts tests/interactive-relay.test.ts tests/memory-regression.test.ts tests/update-coalescer.test.ts)`
- Expected: all transport, 8.2+ MiB projection, 12 MiB settle rehydrate, activation ordering, eviction, relay, and memory regressions pass.

- Run: `(cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/result-payload.test.ts tests/result-snapshot.test.ts tests/run-store.test.ts tests/run-coordinator.test.ts tests/tool.test.ts tests/chain.test.ts tests/resume.test.ts tests/artifact-reader-extension.test.ts tests/security.test.ts tests/invocation.test.ts tests/execution.test.ts tests/interactive-agent.test.ts tests/render.test.ts)`
- Expected: all artifact, strict durability, snapshot phase, Chain/fanout/resume, both Pi reader launch paths, and rendering regressions pass.

### Package gates

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: no TypeScript errors, including async resume/finalization signatures and exact inline/reference unions.

- Run: `mise run test --package packages/pi-agents`
- Expected: the complete package suite passes with zero failures. The pre-change compact-memory baseline was 1026 pass / 0 fail; the new count may be higher because this plan adds tests.

- Run: `mise run build --package packages/pi-agents`
- Expected: `packages/pi-agents/dist/index.js` and `packages/pi-agents/dist/artifact-reader-extension.js` build, and the child entry does not bundle a second Pi SDK instance.

- Run: `(cd packages/pi-agents && npm pack --dry-run --json | jq -e '.[0].files | map(.path) | index("dist/artifact-reader-extension.js") != null')`
- Expected: the post-build package manifest contains `dist/artifact-reader-extension.js`; this check runs after build rather than making package tests depend on ignored `dist/`.

- Run: `hk check`
- Expected: repository ESLint and Prettier checks pass.

### Source audits

- Run: `rg -n "MAX_STDOUT_RECORD_BYTES|MAX_PROJECTABLE_RPC_RECORD_BYTES|RPC_PROJECTED_SHELL_FIELD_MAX_BYTES|RESULT_INLINE_PAYLOAD_MAX_BYTES|RUN_ARTIFACT_MAX_BYTES|RPC stdout record exceeded" packages/pi-agents/src packages/pi-agents/tests`
- Expected: production values are consistently 8 MiB ordinary, 64 MiB projectable, 16 KiB per projected shell identity string, 256 KiB inline, and 64 MiB artifact; overflow text says 8 MiB.

- Run: `rg -n "getMessages\(|request\(\{ type: ['\"]get_messages" packages/pi-agents/src`
- Expected: no callable `get_messages` production path remains.

- Run: `rg -n "case ['\"]agent_end|\.messages" packages/pi-agents/src/interactive-agent.ts packages/pi-agents/src/pi-rpc-execution.ts packages/pi-agents/src/interactive-relay.ts`
- Expected: raw RPC `agent_end` consumers do not inspect its messages; transcript authority comes from message events or verified session rehydrate.

- Run: `rg -n "snapshotSingleResult|snapshotProvisionalResult|externalizeTerminalResult" packages/pi-agents/src/{execution,pi-rpc-execution,tool,chain,abort,run-coordinator,result-snapshot,result-payload}.ts`
- Expected: external running/low-level terminal updates use provisional snapshots; authority externalization occurs only at the awaited terminal boundary.

- Run: `rg -n "updateRunStrict|appendEventStrict|unit_terminal|run_terminal|abandonRun|unregisterRun|releaseRun" packages/pi-agents/src/{run-store,run-coordinator,run-persistence,tool}.ts`
- Expected: artifact refs are strictly written before terminal events; success unregisters before release; failed finalization unregisters before abandon.

### Integration fixtures

- Run the generated historical regression with an exact 2,320,362-byte canonical `agent_end` following the small persisted context-window error.
- Expected: it succeeds under the 8 MiB baseline, preserves the model error, and delivers compact `agent_end` metadata without `stdout_overflow`.

- Run the generated canonical aggregate integration at 8.2–8.3 MiB.
- Expected: it receives the 64 MiB projectable budget, emits a bounded compact `agent_end`, preserves subsequent record synchronization, and never retains the aggregate messages locally.

- Run the generated 12 MiB final-output integration with cumulative `message_update`, full `message_end`, `turn_end`, aggregate `agent_end`, persisted native session data, and `agent_settled`.
- Expected: every oversized canonical replayable event projects; the endpoint directly rehydrates the complete finalized branch inside the settle transition; `activation_settled` contains the 12 MiB authoritative final message before deferred eviction; the terminal result then spills it to a verified artifact before parent/durable publication.

- Run an ordinary unknown/response record at 8 MiB plus one byte and a canonical projectable record at 64 MiB plus one byte (the latter may use injected test limits for the hard-cap branch).
- Expected: both fail closed as `stdout_overflow` at their independent caps, with no listener delivery.

### Artifact memory and size thresholds

Extend `tests/memory-regression.test.ts` with generated values and require:

- A 12 MiB final text plus a large structured value produces verified artifacts; the terminal `SingleResult` JSON remains below 1 MiB and contains no 64-byte sentinel from either authority payload.
- A pretty-printed single-run `run.json`, including both `details.results` and `units[*].result`, remains below 2 MiB for the 12 MiB final-output fixture.
- An eight-item fanout with 4 MiB final text and 4 MiB structured output per item produces only artifacts/refs for authority; combined parent details and pretty `run.json` each remain below 2 MiB and contain no raw payload sentinel.
- Every individual artifact is at or below 64 MiB and verifies exact byte count/digest.
- Every provisional update contains no authoritative inline value or ref and remains bounded by the existing presentation/diagnostic budgets.
- Every child reader response contains at most 48 KiB of artifact data and advances `nextOffsetBytes` without splitting a UTF-8 code point.

- Run: `(cd packages/pi-agents && bun test tests/memory-regression.test.ts tests/result-snapshot.test.ts tests/result-payload.test.ts tests/artifact-reader-extension.test.ts)`
- Expected: all explicit serialized-size, no-sentinel, digest, provisional-budget, and chunk-size thresholds pass.

## Rollout Notes

1. The 8 MiB ordinary cap is already landed. Do not present Task 1 or Task 2 as the immediate cap increase.
2. Tasks 1–3 form the transport/lifecycle hardening layer. The projector is not complete until the 8.2+ MiB and 12 MiB integrations pass.
3. The compact snapshot/memory optimization is complete; Tasks 4–8 build on its existing APIs, tests, 1026-pass baseline, and successful reduced-heap soak.
4. Tasks 4–7 should merge together or remain on an internal branch until strict terminal ordering, Chain/fanout, async resume, and child reader tests all pass. A durable ref without all resolvers/barriers is unsafe.
5. No durable schema bump or rewrite is required. Existing inline Version 1 records remain readable; actively resumed records may acquire additive refs when they next cross a strict publication boundary.
6. Do not rewrite historical `run.json`, parent sessions, or native child sessions automatically.
7. A future Pi key-order change intentionally loses the projectable exception and returns to the ordinary 8 MiB failure. Treat that as a compatibility signal to inspect the new runtime and update pinned tests, not permission to broaden matching.
8. Package compatibility remains `^0.80.6`; release notes must state that canonical projector behavior was verified against installed Pi 0.80.9.
9. Artifact retention is operationally simple in Version 1: retain or delete the complete inactive run directory. Do not add partial cleanup or GC during rollout.

## Risks and Mitigations

- **Exact-prefix projection is coupled to Pi runtime object construction.** — Pin installed 0.80.9 producer order, require an exact early prefix, validate the full record, and fall back to the ordinary 8 MiB cap on drift.
- **Documentation and runtime disagree on `message_update` order.** — Treat installed source plus RPC `JSON.stringify` forwarding as authority and include a regression for `assistantMessageEvent` before `message`.
- **A custom scanner could accept malformed JSON.** — Implement complete incremental grammar/state validation, depth limits, duplicate/order checks, EOF handling, and exhaustive chunk-boundary/malformed tests.
- **Projection could reorder coalesced stream and terminal events.** — Keep one record state, seal stream cells at boundaries, await reducer work in the endpoint transition queue, and test blocked-queue ordering.
- **Settle rehydrate could deadlock on the endpoint's own lease.** — Use a dedicated direct `SessionManager.open` path only inside the live Pi settle transition; never call ordinary lazy hydration or await the held lease there.
- **Settle rehydrate could race idle eviction or a newer activation.** — Complete verification before `activation_settled`, preserve activation/generation checks, and schedule existing epoch-scoped eviction only afterward.
- **The session could be incomplete when `agent_settled` arrives.** — Verify expected post-baseline finalized/assistant counts and fail with `hydrate_error` instead of publishing omission metadata as success.
- **Registry-level retention projection could be confused with transport projection.** — Keep separate functions/contracts/tests and document that `projectFinalizedMessage` acts only on real/hydrated messages.
- **Artifact refs could become durable before files.** — Strictly publish and verify artifact bytes first, then strictly write `run.json`, then strictly append terminal events, then publish parent/relay state.
- **A strict terminal write could fail after artifact publication.** — Leave an unreferenced immutable artifact, keep the rejected clone out of live state, surface `durable_write_error`, unregister, and abandon the claim.
- **A terminal event append could fail after `run.json` commits.** — Treat `run.json` as authoritative, mirror committed disk state, report failure, unregister, and abandon rather than reporting success or releasing normally.
- **Artifact paths could escape the run or follow symlinks.** — Derive paths from digest only and validate run ID, containment, `lstat`/`realpath`, regular-file status, extension/media type, byte count, and digest on every resolution.
- **Externalization could break Chain prompt semantics.** — Keep small inline substitutions byte-compatible, use bounded descriptors only for refs, guarantee the dedicated reader for Pi, and reject unsupported runtimes before dispatch.
- **Lazy structured resolution could persist hydrated data and restore memory growth.** — Keep runtime-only resolved values/maps, preserve refs in snapshots/mirrors, and add no-hydration-persisted tests.
- **Fanout refs could change frozen mapping identity.** — Validate individual items before expansion, content-address aggregate mappings, compare digest/media type for idempotence, and never recompute a stored mapping.
- **Async resume inspection could introduce a claim race.** — Verify refs both before claim and after claim, then thread only the post-claim resolved map into restored runtime state.
- **Claim cleanup could leave an active registration without ownership.** — Centralize fresh/resume finalization; success is strict final -> event -> unregister -> release, failure is unregister -> abandon -> rethrow.
- **Continuation relay could double-send or deliver to a stale branch while artifact I/O is pending.** — Reserve activation IDs before async work, revalidate host/session/binding/active-branch trust immediately before delivery, track promises, and test duplicate settle plus branch/session changes during blocked I/O.
- **Artifact-reader injection could be mistaken for a sandbox.** — Add only the dedicated reader capability required by a handoff; do not add general filesystem tools, and document that capabilities already granted by the agent configuration remain available.
- **Artifacts increase privacy and disk exposure.** — Use private run directories/files, avoid transcript duplication, document sensitive content and manual whole-run deletion.
- **Fixed 64 MiB caps may reject future workloads.** — Return explicit errors and collect evidence before any limit change; do not add configuration or silently raise caps.
- **`StringDecoder` replaces invalid UTF-8 before JSON validation.** — Define projector validation over the decoded stream, preserve current transport behavior, and add deterministic invalid-byte coverage; raw-byte UTF-8 rejection remains outside scope.
