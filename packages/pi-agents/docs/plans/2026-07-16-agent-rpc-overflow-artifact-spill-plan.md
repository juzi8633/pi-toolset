# Agent RPC Overflow and Result Artifact Spill Implementation Plan

**Goal:** Preserve Pi RPC correctness for oversized replayable events and externalize oversized authoritative workflow results into validated run-local artifacts without changing Chain, fanout, resume, interactive continuation, or rendering semantics.

**Inputs:** The current `packages/pi-agents` source and tests; historical failed run `run-40cc88b2-52c6-4c7a-a1f4-ee9547a00f1d`; `packages/pi-agents/docs/todos/2026-07-16-subagent-memory-optimization-followups.md`; `packages/pi-agents/docs/analysis/reduced-heap-soak-2026-07-17.md`; installed Pi 0.80.9 RPC, extension, package, and session documentation; installed Pi 0.80.9 runtime source; and the user decision to use `"*"` for Pi peer dependencies while pinning every Pi development dependency to exact `0.80.9`.

**Assumptions:**

- Pi upstream is not modified. Exact-prefix projection remains local to `pi-agents` and is pinned to inspected Pi 0.80.9 producer order.
- `packages/pi-agents/package.json` changes all `@earendil-works/pi-*` peer ranges to `"*"`; existing Pi development dependencies in the root and package manifests become exact `0.80.9` entries.
- Native Pi `sessionFile` remains the sole authoritative transcript. Projected RPC records and disabled `get_messages` calls do not create a second transcript store.
- Production registration through `src/index.ts` provides a `RunStore` and `RunCoordinator`. A non-durable/test-only path cannot spill outside a run directory.
- Version 1 uses fixed limits: 8 MiB ordinary RPC record, 64 MiB canonical projectable RPC record, 16 KiB projected shell identity field, 256 KiB inline authoritative payload, 64 MiB artifact, and 48 KiB child-reader chunk.
- Existing Version 1 inline records remain readable. New reference fields are additive; no Version 2 migration or historical rewrite is introduced.
- JSON artifact bytes are `JSON.stringify(value, null, 2) + "\n"`; text artifacts are exact UTF-8 bytes. Threshold and digest checks use those exact persisted bytes.
- Invalid UTF-8 keeps the current `StringDecoder` replacement behavior and is then validated as decoded JSON. Raw-byte UTF-8 rejection is out of scope.
- Artifact garbage collection is out of scope. Version 1 retention deletes only an entire inactive run directory.

**Architecture:** The transport retains the ordinary 8 MiB fail-closed boundary, but an incremental validator grants a separate 64 MiB budget only to exact canonical replayable Pi 0.80.9 events and emits bounded omission shells. The interactive registry restores omitted authority directly from the owned native session inside the `agent_settled` transition. Separately, terminal workflow publication externalizes oversized authority into immutable content-addressed run artifacts, strictly persists references before terminal events or parent delivery, and resolves references only in trusted workflow paths; child agents receive a narrowly scoped reader only when a handoff requires it.

**Tech Stack:** TypeScript, Bun 1.3.14, Node.js streams and filesystem APIs, incremental JSON tokenization, SHA-256, strict LF JSONL, Pi 0.80.9 RPC/extension/session APIs, Mise, ESLint, Prettier, and HK.

---

## Repository Evidence

- `packages/pi-agents/src/pi-rpc-transport.ts` currently defines `MAX_STDOUT_RECORD_BYTES = 8 * 1024 * 1024`, accepts complete records through 8 MiB, and fails larger records with `stdout_overflow` / `RPC stdout record exceeded 8 MiB`.
- `packages/pi-agents/tests/pi-rpc-transport.test.ts` already covers above-2-MiB success, the exact 8 MiB boundary, terminated overflow, and unterminated overflow.
- `packages/pi-agents/src/result-snapshot.ts` already exports `snapshotSingleResult`, `snapshotResults`, and `copySnapshotShell`; compact snapshot work is complete, with 1026 package tests passing and the reduced-heap soak recorded as PASS.
- `packages/pi-agents/src/interactive-agent.ts` already has `projectFinalizedMessage`, lazy `SessionManager.open(sessionFile).getBranch()` hydration, endpoint transition queues, activation IDs, retention epochs, and deferred idle transcript eviction.
- Raw child RPC `agent_end` is metadata-only in `interactive-agent.ts`; `agent_settled` performs terminal reduction and emits `activation_settled`.
- `RunCoordinator.finishUnit()` is synchronous and fire-and-forgets terminal persistence; `RunCoordinator.finalizeRun()` is async but uses a best-effort write path.
- `RunStore` has no artifact APIs or strict write variants; its current file and directory sync helpers swallow errors.
- `SingleResult`, `ChainOutputEntry`, `WorkflowFanoutState`, and `InteractiveContinuationDetails` are inline-only. `inspectResume()` and `validateFanoutResumeState()` are synchronous.
- Installed Pi 0.80.9 documents strict LF JSONL, `get_messages`, `agent_settled`, `SessionManager.open()`, custom tools, and package peer dependencies. Installed runtime source emits `message_update` as `type`, `assistantMessageEvent`, then `message`; tests must pin runtime order even though the RPC documentation example shows another order.

## Requirement Coverage

| Requirement                                                                     | Planned task |
| ------------------------------------------------------------------------------- | ------------ |
| Align Pi peer/dev dependency policy with the user decision                      | Task 1       |
| Preserve the landed 8 MiB baseline and historical 2,320,362-byte regression     | Task 2       |
| Disable unbounded `get_messages` before request side effects                    | Task 2       |
| Fully validate and project only exact canonical replayable events               | Tasks 3–4    |
| Compact every delivered child `agent_end`                                       | Task 4       |
| Rehydrate omitted replayable authority before `agent_settled` publication       | Task 5       |
| Store immutable validated run-local artifacts                                   | Task 6       |
| Add additive Version 1 inline/reference contracts                               | Tasks 6–7    |
| Prevent provisional snapshots from exposing authority                           | Task 7       |
| Preserve child handoff semantics with a bounded dedicated reader                | Tasks 8–9    |
| Preserve Chain, JSON Pointer, fanout, collect, and resume behavior              | Tasks 9–10   |
| Preserve interactive continuation and rendering behavior                        | Task 11      |
| Publish artifact, `run.json`, terminal event, and parent output in strict order | Task 12      |
| Document limits, failure behavior, privacy, retention, and validation           | Task 13      |

## Scope

### Included

- The existing 8 MiB ordinary RPC record cap and exact error text.
- Streaming projection for exact canonical oversized replayable Pi 0.80.9 events.
- Settle-time direct native-session rehydrate for omitted message, turn, and tool payloads.
- Explicit `get_messages` rejection in `PiRpcTransport`.
- Immutable run-local text/JSON artifacts addressed by SHA-256.
- Artifact-first strict durable reference publication and awaited terminal ordering.
- Additive Version 1 inline-or-reference fields with legacy inline compatibility.
- Provisional snapshots without authoritative inline values or refs.
- Trusted lazy resolution for Chain, JSON Pointer, fanout, collect, and resume.
- A conditional child-only `pi_agents_read_artifact` extension for Pi handoffs.
- Artifact-aware continuation delivery, bounded descriptors, rendering, tests, and documentation.

### Out of Scope

- Patches to Pi, `pi-agent-core`, or `pi-coding-agent`.
- Configurable limits, a generic RPC proxy, binary/image artifacts, duplicate transcript artifacts, or an artifact-backed `get_messages` replacement.
- Artifact garbage collection, partial-run cleanup, durable schema Version 2, or automatic rewriting of existing run/session files.
- General filesystem capability for child agents beyond capabilities already granted by their selected agent configuration.
- Support guesses for uninspected future Pi event shapes; key-order drift falls back to the ordinary 8 MiB failure.

## Plan-Wide Implementation Rules

- Every new TypeScript source or test file starts with two `ABOUTME:` comment lines; preserve the existing two-line headers in modified code files.
- Generate multi-megabyte test fixtures in test code. Do not commit large JSONL or artifact fixtures.
- Keep production limits fixed. Injectable limits/depth are test seams only.
- Preserve strict LF framing, strip only one optional trailing CR, and never split on `U+2028` or `U+2029`.
- Presence checks use own-property semantics so `null`, `false`, `0`, and `""` remain valid JSON values.
- Never place a descriptor in an authoritative inline field, a ref object in `structuredOutput`, or hydrated artifact content back into durable ref fields.
- Small inline workflows remain byte-compatible unless a task explicitly changes an error path.

## Data Contracts

### Safety Budgets

| Boundary                               | Fixed budget | Behavior                                                                                                                        |
| -------------------------------------- | -----------: | ------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary RPC record                    |        8 MiB | Responses, UI records, queue/retry/compaction events, unknown events, and non-canonical records fail closed above this size     |
| Canonical projectable RPC record       |       64 MiB | Only exact-prefix, fully validated replayable events may reach this size; oversized payloads are omitted from listener delivery |
| Projected shell identity string        |       16 KiB | Oversized `role`, `toolCallId`, or `toolName` revokes projectability                                                            |
| Inline authoritative result payload    |      256 KiB | Larger text or exact JSON bytes spill before terminal publication                                                               |
| One run artifact                       |       64 MiB | Larger artifacts fail with `artifact_too_large`                                                                                 |
| Artifact content per child-reader call |       48 KiB | The text `content` contains at most 48 KiB of artifact bytes; continuation metadata is returned separately in bounded `details` |

Existing 512 KiB presentation, 64 KiB presentation-item, 64 KiB diagnostic, 64 KiB interactive non-authoritative item, and 512 KiB idle transcript budgets remain independent.

### Compact RPC Shells

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

Canonical Pi 0.80.9 top-level prefixes are:

```text
agent_end:              type -> messages -> willRetry
message_start:          type -> message
message_update:         type -> assistantMessageEvent -> message
message_end:            type -> message
turn_end:               type -> message -> toolResults
tool_execution_start:   type -> toolCallId -> toolName -> args
tool_execution_update:  type -> toolCallId -> toolName -> args -> partialResult
tool_execution_end:     type -> toolCallId -> toolName -> result -> isError
```

The projector API introduced in Task 3 is:

```ts
export interface PiRpcRecordProjector {
  push(chunk: Buffer | string): PiRpcProjectedRecord[];
  finish(): PiRpcProjectedRecord[];
}

export type PiRpcProjectedRecord =
  | { kind: 'ordinary'; line: string; bytes: number }
  | {
      kind: 'projected';
      event: CompactPiRpcReplayableEvent;
      bytes: number;
      requiresSettleRehydrate: boolean;
    };
```

Production construction uses fixed constants. Tests may inject ordinary/projectable byte caps, prefix probe bytes, shell-field bytes, and maximum depth.

### Run Artifact Reference

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

`RunStore` gains these exact methods:

```ts
writeTextArtifact(runId, payload, text): Promise<RunArtifactRefV1>
writeJsonArtifact(runId, payload, value): Promise<RunArtifactRefV1>
readTextArtifact(runId, ref): Promise<string>
readJsonArtifact(runId, ref): Promise<unknown>
resolveArtifactPath(runId, ref): Promise<string>
updateRunStrict(runId, mutate): Promise<AgentRunRecordV1>
appendEventStrict(runId, event): Promise<void>
```

Every trusted read validates run ID, payload/media type, lowercase digest, byte count, derived relative path, containment, `lstat`, `realpath`, regular-file/no-symlink status, and SHA-256.

### Additive Version 1 Rules

- `SingleResult`: at most one of `finalOutput` / `finalOutputRef`; at most one of `structuredOutput` / `structuredOutputRef`.
- `ChainOutputEntry`: exactly one of `text` / `textRef`; structured output is absent or exactly one of `structured` / `structuredRef`.
- `WorkflowFanoutState`: exactly one of `items` / `itemsRef`; `unitIds` remains inline and ordered.
- `InteractiveContinuationDetails`: when terminal text exists, exactly one of `output` / `outputRef`; both may be absent only for no-output terminal state.
- Legacy inline Version 1 run records remain valid. New both/neither result/Chain/fanout unions, malformed refs, and cross-run refs fail as `corrupt_run` before claim or dispatch.
- Continuation details are Pi custom-message data, not `AgentRunRecordV1`. Validate them in `interactive-relay.ts`; malformed inline/ref unions render or deliver one bounded `artifact_corrupt` status without resolving content.

### Snapshot Phases

```ts
snapshotProvisionalResult(result: SingleResult): SingleResult
snapshotSingleResult(result: SingleResult): SingleResult
externalizeTerminalResult(result: SingleResult, store: RunStore, runId: string): Promise<SingleResult>
```

- `snapshotProvisionalResult` clears `messages`, all authoritative inline/ref fields, and retains only bounded presentation, diagnostics, usage, identity, and status.
- `snapshotSingleResult` stays the terminal/legacy compact operation, becomes ref-aware, and never resolves refs.
- `externalizeTerminalResult` measures private authority, leaves values at or below 256 KiB inline, writes larger values first, and returns a terminal snapshot containing only inline values or validated refs.

### Child Artifact Reader

```ts
pi_agents_read_artifact({
  runId: 'run-...',
  sha256: '<64 lowercase hex>',
  mediaType: 'text', // 'text' | 'json'
  offsetBytes: 0,
  maxBytes: 48 * 1024,
});
```

The extension reads private `PI_AGENTS_RUN_ARTIFACT_DIR` and `PI_AGENTS_RUN_ID`, derives the `.txt` or `.json` path from digest plus `mediaType`, rejects caller paths and cross-run IDs, validates the artifact, and returns at most 48 KiB of UTF-8 artifact content plus bounded `offsetBytes`, `nextOffsetBytes`, `bytesReturned`, and `eof` details. `offsetBytes` must be an integer from 0 through the exact artifact byte length and must start on a UTF-8 code-point boundary; exact EOF returns empty content with `eof: true`, while a larger or mid-code-point offset fails as `invalid_artifact_offset`. `maxBytes` is an integer from 4 through 48 KiB; the reader retreats the chunk end to the preceding UTF-8 boundary and sets `nextOffsetBytes` to that exact end. Missing, corrupt, and unauthorized artifacts use one bounded child-visible `artifact_unavailable` error so the tool does not reveal path-existence details.

## File Map

### Create

- `packages/pi-agents/src/pi-rpc-record-projector.ts` — incremental LF JSONL framing, JSON validation, exact-prefix classification, and bounded shell projection.
- `packages/pi-agents/src/artifact-store.ts` — content-addressed atomic artifact writes, strict sync helpers, and verified reads.
- `packages/pi-agents/src/result-payload.ts` — exact byte measurement, terminal spill decisions, descriptors, and trusted resolvers.
- `packages/pi-agents/src/artifact-reader-extension.ts` — standalone child-only `pi_agents_read_artifact` Pi extension.
- `packages/pi-agents/tests/pi-rpc-record-projector.test.ts` — grammar, prefix, cap, chunk-boundary, and projection coverage.
- `packages/pi-agents/tests/artifact-store.test.ts` — atomicity, sync failure, deduplication, corruption, symlink, traversal, and crash-window coverage.
- `packages/pi-agents/tests/result-payload.test.ts` — thresholds, refs, descriptors, exact serialization, and resolver coverage.
- `packages/pi-agents/tests/artifact-reader-extension.test.ts` — schema, path derivation, validation, UTF-8 chunking, and bounded error coverage.

### Modify: Package and Transport

- `package.json` — pin root Pi development dependencies to exact `0.80.9`.
- `bun.lock` — remove 0.80.6 Pi resolutions and record exact 0.80.9 development graph.
- `packages/pi-agents/package.json` — use `"*"` Pi peers, exact `0.80.9` Pi dev dependencies, export/package the child extension, and build it in `postbuild` without bundling peer SDKs.
- `packages/pi-agents/src/constants.ts` — centralize fixed RPC, artifact, and reader budgets.
- `packages/pi-agents/src/pi-rpc-transport.ts` — integrate the projector, compact every `agent_end`, and reject `get_messages`.
- `packages/pi-agents/src/interactive-agent.ts` — track projected omissions, settle-time rehydrate, and conditional reader injection for TUI RPC children.

### Modify: Artifact and Workflow Contracts

- `packages/pi-agents/src/run-types.ts` — artifact refs, payload kinds, and inline/reference fanout state.
- `packages/pi-agents/src/types.ts` — result and Chain inline/reference fields.
- `packages/pi-agents/src/run-store.ts` — artifact APIs, strict writes, and additive Version 1 validation.
- `packages/pi-agents/src/result-snapshot.ts` — provisional snapshots and ref-aware terminal snapshots.
- `packages/pi-agents/src/run-coordinator.ts` — strict async unit/run barriers and ref-aware fanout mirrors.
- `packages/pi-agents/src/run-persistence.ts` — shared success/failure finalization and claim ordering.
- `packages/pi-agents/src/execution.ts` — provisional callbacks and non-TUI child reader launch arguments.
- `packages/pi-agents/src/pi-rpc-execution.ts` — provisional callbacks and committed terminal delivery.
- `packages/pi-agents/src/abort.ts` — retain private abort authority until terminal publication.
- `packages/pi-agents/src/tool.ts` — await terminal barriers and async resume inspection.
- `packages/pi-agents/src/output.ts` — bounded inline/ref parent and handoff formatting.
- `packages/pi-agents/src/completion-check.ts` — run checks against private full output before spill.
- `packages/pi-agents/src/chain.ts` — ref-aware previous/named/collect output, structured resolution, fanout, and resume.
- `packages/pi-agents/src/template.ts` — bounded descriptor substitution for referenced values.
- `packages/pi-agents/src/resume.ts` — async ref validation and runtime-only resolved fanout state.
- `packages/pi-agents/src/security.ts` — force-include only the dedicated reader when required.
- `packages/pi-agents/src/invocation.ts` — shipped extension path and typed reader requirement.
- `packages/pi-agents/src/interactive-relay.ts` — artifact-aware continuation publication and in-flight deduplication.
- `packages/pi-agents/src/index.ts` — inject `RunStore` into the relay and await relay shutdown work.
- `packages/pi-agents/src/render.ts` — render ref metadata without loading artifact content.

### Modify: Tests

- `packages/pi-agents/tests/pi-rpc-transport.test.ts` — historical baseline, projector integration, caps, framing, compact `agent_end`, and disabled command.
- `packages/pi-agents/tests/interactive-agent.test.ts` — omission tracking, direct rehydrate, settle ordering, eviction races, and TUI reader injection.
- `packages/pi-agents/tests/pi-rpc-execution.test.ts` — provisional/terminal separation after rehydrate.
- `packages/pi-agents/tests/interactive-relay.test.ts` — `agent_settled` authority, artifact-first continuation, and duplicate/stale delivery races.
- `packages/pi-agents/tests/memory-regression.test.ts` — generated oversized transcript/result/fanout serialized-size thresholds.
- `packages/pi-agents/tests/update-coalescer.test.ts` — async settle and terminal cancellation ordering.
- `packages/pi-agents/tests/run-store.test.ts` — additive ref validation and legacy Version 1 compatibility.
- `packages/pi-agents/tests/result-snapshot.test.ts` — phase behavior, ref ownership, idempotence, and limits.
- `packages/pi-agents/tests/execution.test.ts` — provisional updates and non-TUI reader injection.
- `packages/pi-agents/tests/run-coordinator.test.ts` — strict artifact/run/event ordering and failure windows.
- `packages/pi-agents/tests/tool.test.ts` — awaited unit/run barriers, bounded parent output, and claim cleanup.
- `packages/pi-agents/tests/output.test.ts` — inline/ref descriptors and legacy output behavior.
- `packages/pi-agents/tests/completion-check.test.ts` — completion checks use private full output.
- `packages/pi-agents/tests/chain.test.ts` — previous/named/collect refs, fanout refs, and prompt parity.
- `packages/pi-agents/tests/resume.test.ts` — pre/post-claim artifact validation and no redispatch.
- `packages/pi-agents/tests/security.test.ts` — conditional dedicated reader inclusion without capability broadening.
- `packages/pi-agents/tests/invocation.test.ts` — shipped extension resolution and typed reader requirements.
- `packages/pi-agents/tests/render.test.ts` — collapsed/expanded inline/ref rendering.

### Modify: Documentation

- `packages/pi-agents/README.md` — limits, artifact layout, reader behavior, dependency support, privacy, retention, and validation commands.
- `packages/pi-agents/docs/reference.md` — RPC projection, refs, errors, limits, and disabled command.
- `packages/pi-agents/docs/explanation.md` — control-plane projection, session authority, artifact publication, and trust boundaries.
- `packages/pi-agents/docs/how-to.md` — inspect artifacts, read child handoffs, and diagnose missing/corrupt refs.

## Tasks

### Task 1: Align Pi Dependency and Package Contracts

**Outcome:** All Pi peer dependencies follow installed package guidance, all Pi development dependencies are exactly 0.80.9, and the lockfile contains no 0.80.6 Pi runtime.

**Files:**

- Modify: `package.json`
- Modify: `packages/pi-agents/package.json`
- Modify: `bun.lock`

**Steps:**

- [ ] Change root `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` development ranges from `^0.80.9` to exact `0.80.9`.
- [ ] Change every `@earendil-works/pi-*` peer in `packages/pi-agents/package.json` to `"*"`; leave `typebox` as `"*"`.
- [ ] Change the package-local `@earendil-works/pi-agent-core` development dependency to exact `0.80.9`.
- [ ] Run `bun install` from the repository root and verify `bun.lock` removes direct/nested Pi 0.80.6 resolutions.
- [ ] Do not change dependency metadata in `pi-lsp` or `pi-format`; they already use `"*"` Pi peers and declare no Pi development versions.

**Validation:**

- Run: `bun install --frozen-lockfile`
- Expected: install succeeds without modifying `bun.lock`.

- Run: `bun -e "const r=await Bun.file('package.json').json(); const a=await Bun.file('packages/pi-agents/package.json').json(); for (const n of ['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','@earendil-works/pi-tui']) if (r.devDependencies[n] !== '0.80.9') throw new Error(n); for (const [n,v] of Object.entries(a.peerDependencies)) if ((n.startsWith('@earendil-works/pi-') || n === 'typebox') && v !== '*') throw new Error(n); if (a.devDependencies['@earendil-works/pi-agent-core'] !== '0.80.9') throw new Error('pi-agent-core')"`
- Expected: exits 0 with no output.

- Run: `rg -n "@earendil-works/pi-(agent-core|ai|coding-agent|tui)@0\.80\.6|\^0\.80\.6" bun.lock package.json packages/pi-agents/package.json`
- Expected: no matches.

### Task 2: Lock the Transport Baseline and Disable `get_messages`

**Outcome:** Permanent tests preserve the landed 8 MiB behavior and terminal lifecycle contract, while the unbounded history command is unavailable before request side effects.

**Files:**

- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/pi-rpc-transport.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`

**Steps:**

- [ ] Move `MAX_STDOUT_RECORD_BYTES = 8 * 1024 * 1024` to `constants.ts`; preserve `RPC stdout record exceeded 8 MiB` exactly.
- [ ] Generate a 143-message canonical `agent_end` with the historical 1 user / 50 assistant / 92 tool-result distribution and exact serialized length 2,320,362 bytes; assert it succeeds under 8 MiB and preserves the preceding small model/context error.
- [ ] Preserve exact-8-MiB success and 8-MiB-plus-one terminated/unterminated failure before `JSON.parse` or listener delivery.
- [ ] Assert raw `agent_end` only updates metadata and never settles an activation, clears active stream/tool/queue state, resolves Pi RPC execution, or triggers continuation relay.
- [ ] Assert `agent_settled` remains the only normal terminal signal.
- [ ] Remove `PiRpcTransport.getMessages()` and its unused `AgentMessage` import.
- [ ] Guard public `request()` before request ID allocation, pending-map mutation, timer creation, or stdin write. Reject `type: 'get_messages'` with code `get_messages_disabled` and message `get_messages is disabled; hydrate the validated sessionFile instead`.
- [ ] Replace any request-correlation fixture that used `get_messages` with a second bounded command such as `get_state`.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-transport.test.ts tests/interactive-agent.test.ts tests/pi-rpc-execution.test.ts tests/interactive-relay.test.ts)`
- Expected: all tests pass; the historical shape and exact boundary succeed, overflow remains fail-closed, `agent_end` remains non-terminal, and `get_messages` produces no write or pending request.

- Run: `rg -n "getMessages\(|get_messages" packages/pi-agents/src packages/pi-agents/tests`
- Expected: source contains only the disabled-command guard; tests contain only rejection coverage.

### Task 3: Implement the Incremental RPC Record Projector

**Outcome:** A standalone projector can validate and classify one strict LF JSONL stream without retaining eligible oversized payloads or broadening the ordinary cap.

**Files:**

- Create: `packages/pi-agents/src/pi-rpc-record-projector.ts`
- Modify: `packages/pi-agents/src/constants.ts`
- Create: `packages/pi-agents/tests/pi-rpc-record-projector.test.ts`

**Steps:**

- [ ] Add `MAX_PROJECTABLE_RPC_RECORD_BYTES = 64 * 1024 * 1024`, `RPC_PREFIX_PROBE_BYTES = 512`, `RPC_JSON_MAX_DEPTH = 256`, and `RPC_PROJECTED_SHELL_FIELD_MAX_BYTES = 16 * 1024`.
- [ ] Implement the `PiRpcRecordProjector` and `PiRpcProjectedRecord` API from Data Contracts. Keep a raw line buffer only through the ordinary 8 MiB boundary while concurrently validating/classifying the record.
- [ ] Preserve LF-only framing, strip one optional trailing CR, preserve records after an LF in the same chunk, and complete decoder state in `finish()`.
- [ ] Validate complete JSON grammar incrementally: containers, keys/values, separators, strings/escapes, four-hex-digit `\u` escapes, numbers, literals, duplicate top-level keys, maximum depth, complete record, and EOF.
- [ ] Classify only the exact Pi 0.80.9 top-level orders listed in Data Contracts. Any unknown type, reordered/duplicate key, missing shell field, or shell string above 16 KiB remains ordinary.
- [ ] Preserve only `willRetry`, `role`, `toolCallId`, `toolName`, and terminal `isError` in projected shells; discard large payload values after their syntax has been fully validated.
- [ ] Count exact UTF-8 bytes even after payload discard. Throw `stdout_overflow` at the ordinary or projectable boundary and `malformed_json` for invalid grammar.
- [ ] Revoke projectability on any late canonical-order or shell violation. If the record already crossed 8 MiB, fail without emitting a synthetic event.
- [ ] Use injected limits/depth only in tests; production construction always uses constants.
- [ ] Cover every byte split for representative prefixes, CRLF, multiple records/chunk, escaped quotes/backslashes, `U+2028`/`U+2029`, multibyte UTF-8, nested containers, EOF, invalid numbers/literals/escapes, trailing commas, duplicate/reordered keys, depth overflow, late invalidation, unknown events, and both cap branches.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-record-projector.test.ts)`
- Expected: all grammar, chunk-boundary, classification, omission, late-revocation, and independent-cap tests pass.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: the new projector contracts type-check without transport integration.

### Task 4: Integrate Projection into `PiRpcTransport`

**Outcome:** Oversized canonical replayable events reach listeners as bounded shells through 64 MiB, every delivered `agent_end` is compact, and all other records remain subject to 8 MiB.

**Files:**

- Modify: `packages/pi-agents/src/pi-rpc-transport.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts`

**Steps:**

- [ ] Replace whole-line stdout handling with the projector while preserving process failure, request correlation, listener order, backpressure, and same-chunk record order.
- [ ] Parse ordinary records at or below 8 MiB with the existing `JSON.parse` path.
- [ ] Defensively rewrite every small valid `agent_end`, regardless of key order, to `messages: []` and `messagesOmitted: true` while retaining boolean `willRetry`.
- [ ] Deliver projected shells only after the complete record validates. Never deliver partial or malformed records.
- [ ] Generate a canonical aggregate `agent_end` between 8.2 and 8.3 MiB; assert bounded delivery and synchronization of a following small record.
- [ ] Generate canonical oversized message, turn, and tool events; assert their bounded shell fields and `requiresSettleRehydrate` metadata.
- [ ] Test ordinary unknown/response/UI records at 8 MiB plus one, canonical records at 64 MiB plus one, late canonical invalidation after 8 MiB, and oversized required shell fields.
- [ ] Keep the Task 2 historical 2,320,362-byte and exact-8-MiB regressions green.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-record-projector.test.ts tests/pi-rpc-transport.test.ts)`
- Expected: 8.2–8.3 MiB canonical records project, ordinary records still fail above 8 MiB, projectable records fail above 64 MiB, compact `agent_end` never exposes messages, and following records remain synchronized.

### Task 5: Rehydrate Projected Interactive Activations at Settle

**Outcome:** An activation that lost replayable payloads publishes one verified terminal snapshot from its native session before `activation_settled` and before deferred eviction.

**Files:**

- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/tests/update-coalescer.test.ts`

**Steps:**

- [ ] Track omission state by endpoint transport generation and activation ID, including expected finalized-message and assistant-message counts. Compact `agent_end.messages` alone does not set rehydrate state because no local consumer used it.
- [ ] For compact message/tool/turn shells, clear only unsafe transient presentation rows and publish bounded omission metadata while keeping the activation running.
- [ ] On compact assistant `message_end`, enforce existing `maxTurns` immediately from the preserved role; use the existing non-blocking abort path.
- [ ] Await event reduction in the endpoint transition queue so sealed coalesced stream updates reduce before boundary events and no later transition overtakes settle rehydrate.
- [ ] Add `rehydrateProjectedPiAtSettle`. It runs only for a live Pi endpoint with omission state and directly calls `SessionManager.open(validatedSessionFile).getBranch()` inside the endpoint transition.
- [ ] Do not call `ensureTranscriptHydrated()` or wait on `awaitSessionLease()`; the live endpoint still owns the writer lease until transport disposal.
- [ ] Project hydrated messages through existing registry retention helpers, verify expected post-baseline finalized/assistant counts, replace the finalized view, mark `transcriptHydrated`, and recompute model/usage/stop reason without double-counting compact events.
- [ ] Complete successful rehydrate before full `endpoint_updated`, `activation_settled`, activation clearing, `scheduleIdleTranscriptEviction`, and idle LRU enforcement.
- [ ] On missing, malformed, path-mismatched, stale, or incomplete session data, settle failed with `errorCode: 'hydrate_error'` and a bounded message; never publish omission-only success.
- [ ] Generate a persisted 12 MiB assistant final message followed by cumulative `message_update`, full `message_end`, `turn_end`, aggregate `agent_end`, and `agent_settled`. Route it through the real transport and registry reducer; assert settled consumers observe complete authority once before existing eviction limits apply.
- [ ] Cover `willRetry`, max-turn abort, blocked transition queues, newer activation/retention epoch races, relay non-delivery on `agent_end`, and stale eviction suppression.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-agent.test.ts tests/pi-rpc-execution.test.ts tests/interactive-relay.test.ts tests/memory-regression.test.ts tests/update-coalescer.test.ts)`
- Expected: the 12 MiB sequence rehydrates before settle, `agent_end` remains non-terminal, failures become bounded `hydrate_error`, and eviction/coalescing cannot overtake the terminal snapshot.

### Task 6: Add Run-Local Artifacts and Strict Store Primitives

**Outcome:** Immutable text/JSON artifacts are durable and verified before refs are returned, and Version 1 records can validate additive inline/reference unions.

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
- [ ] Add the seven `RunStore` methods listed in Data Contracts; callers supply semantic values/refs, never paths.
- [ ] Serialize text as exact UTF-8 and JSON as two-space-indented JSON plus one LF. Reject cycles, `undefined`, non-finite numbers, unsupported non-JSON values, and artifacts above 64 MiB.
- [ ] Hash exact persisted bytes and derive the destination path only from digest and media type.
- [ ] Create run artifact directories with `0700` and files with `0600` where supported.
- [ ] Write a same-filesystem private staging file, write all bytes, strictly `fsync` the file, atomically rename, and strictly sync the containing directory chain on POSIX. On Windows, require file flush and atomic rename but do not claim unsupported directory sync.
- [ ] On an existing digest path, verify regular-file status, exact bytes, and digest before deduplicating; never trust `EEXIST` alone.
- [ ] Resolve every ref through run ID, payload/media type, lowercase digest, byte count, derived path, containment, `lstat`, `realpath`, regular-file/no-symlink, and SHA-256 checks. Use `O_NOFOLLOW` where supported and retain realpath checks on every platform.
- [ ] Add strict filesystem helpers separately from current best-effort helpers. `updateRunStrict` and `appendEventStrict` use the existing per-run serial queue and propagate supported file/directory sync failures.
- [ ] Extend `validateRunRecord` and nested validators for result, Chain, and fanout refs. Accept legacy inline Version 1 records and reject malformed/cross-run/both/neither unions as `corrupt_run`. Continuation custom-message validation belongs to Task 11, not `RunStore`.
- [ ] Add narrow fault-injection seams for tests only. A crash may leave an unreferenced staging/content file but never a ref to an unpublished file.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/run-store.test.ts)`
- Expected: identical bytes deduplicate; strict sync failures propagate; refs appear only after publication; tampered, missing, oversized, symlinked, path-escaping, wrong-run, wrong-size, and wrong-digest artifacts fail closed; legacy Version 1 records load.

### Task 7: Add Phase-Aware Snapshots and Payload Externalization

**Outcome:** Running updates are authority-free and bounded, while terminal helper APIs can produce inline values or verified refs without cloning oversized structured payloads first.

**Files:**

- Create: `packages/pi-agents/src/result-payload.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/result-snapshot.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/abort.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Modify: `packages/pi-agents/src/completion-check.ts`
- Create: `packages/pi-agents/tests/result-payload.test.ts`
- Modify: `packages/pi-agents/tests/result-snapshot.test.ts`
- Modify: `packages/pi-agents/tests/execution.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/tests/output.test.ts`
- Modify: `packages/pi-agents/tests/completion-check.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/tests/update-coalescer.test.ts`

**Steps:**

- [ ] Add `finalOutputRef` / `structuredOutputRef` to `SingleResult` and `textRef` / `structuredRef` to `ChainOutputEntry`; preserve legacy inline fields.
- [ ] Implement exact byte measurement using the same text/JSON serialization as the artifact store.
- [ ] Implement the three snapshot APIs from Data Contracts. `snapshotProvisionalResult` removes all authority fields and refs; `snapshotSingleResult` copies refs without resolving them; `externalizeTerminalResult` spills only values above 256 KiB.
- [ ] Decide spill before deep cloning a structured value. Freeze/own only the resulting compact inline value or ref shell.
- [ ] Add trusted async text/JSON resolvers and bounded parent/child descriptors capped at 2 KiB. Parent descriptors may show a validated absolute path; child descriptors contain run ID, digest, size, payload kind, reader `mediaType`, and explicit reader instructions.
- [ ] Keep final-output extraction, completion checks, schema validation, status stamping, and worktree finalization on the private full runtime result before externalization.
- [ ] Change running and low-level terminal `onUpdate` paths in `execution.ts` and `pi-rpc-execution.ts` to provisional snapshots.
- [ ] Change Single/Parallel aggregate updates in `tool.ts` and running/fanout aggregate updates in `chain.ts` to provisional shells until terminal publication returns committed authority.
- [ ] Keep abort authority private in `AgentAbortError` until the terminal path; do not replace it with a provisional shell prematurely.
- [ ] Define bounded failures: `artifact_write_error` for a failed artifact write and `artifact_store_unavailable` for an oversized non-durable path. Neither includes the original payload or a dangling ref.
- [ ] Prove pending provisional updates cannot publish after terminal cancellation and no provisional JSON contains inline/ref authority.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/result-payload.test.ts tests/result-snapshot.test.ts tests/completion-check.test.ts tests/execution.test.ts tests/pi-rpc-execution.test.ts tests/tool.test.ts tests/chain.test.ts tests/output.test.ts tests/memory-regression.test.ts tests/update-coalescer.test.ts)`
- Expected: small snapshots remain compatible; provisional updates contain no authority; large helper inputs become verified refs; checks use private full values; descriptors and failures remain bounded.

### Task 8: Ship the Bounded Child Artifact Reader

**Outcome:** Pi child launches can receive one run-scoped artifact reader without gaining new general filesystem tools, and the package ships that extension as a separate peer-externalized entry.

**Files:**

- Create: `packages/pi-agents/src/artifact-reader-extension.ts`
- Modify: `packages/pi-agents/src/security.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Modify: `packages/pi-agents/package.json`
- Create: `packages/pi-agents/tests/artifact-reader-extension.test.ts`
- Modify: `packages/pi-agents/tests/security.test.ts`
- Modify: `packages/pi-agents/tests/invocation.test.ts`
- Modify: `packages/pi-agents/tests/execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`

**Steps:**

- [ ] Register only `pi_agents_read_artifact` with `typebox`; limit the text `content` to 48 KiB of artifact data and keep continuation metadata in bounded `details`, below Pi's 50 KiB custom-tool content guidance.
- [ ] Validate private env root/run ID, input run ID, lowercase digest, `mediaType: 'text' | 'json'`, offset, and `4..48 KiB` max bytes. Derive `.txt` or `.json` from digest plus media type; accept no caller path.
- [ ] Reuse artifact verification rules and hash the complete file before returning content. Accept offsets only in `0..bytes` on UTF-8 code-point boundaries; exact EOF returns empty content, while larger/mid-code-point offsets throw `invalid_artifact_offset`. Retreat chunk end to a valid boundary and return exact `offsetBytes`, `nextOffsetBytes`, `bytesReturned`, and `eof` details.
- [ ] Collapse missing, corrupt, and unauthorized child-visible failures to bounded `artifact_unavailable`; log no artifact content or private root.
- [ ] Resolve `dist/artifact-reader-extension.js` from `import.meta.url` and represent reader need as a typed invocation requirement.
- [ ] Extend `buildToolCliArgs` narrowly: when required, force-include `pi_agents_read_artifact` in an existing `--tools` allowlist and remove only that tool name from excludes. Do not add `read`, `bash`, or other filesystem tools.
- [ ] Apply `--extension <resolved-dist-path>` and private env values to both Pi launch paths: non-TUI child launches in `execution.ts` and TUI RPC child launches in `interactive-agent.ts`.
- [ ] Add package `exports` for the child entry and `scripts.postbuild` that runs `bun build ./src/artifact-reader-extension.ts --outdir dist --target node` with all Pi/typebox peers externalized.
- [ ] Keep the extension out of `pi.extensions` so it is not loaded into the parent by default; load it only through explicit child `--extension` arguments.
- [ ] Test long single-line text, JSON, text/JSON media-type path selection, exact EOF, offset past EOF, mid-code-point offset rejection, end-boundary retreat, digest mismatch, symlink/path escape, wrong run, permission failure, tool allow/exclude combinations, both launch paths, and non-reader launch parity.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts tests/security.test.ts tests/invocation.test.ts tests/execution.test.ts tests/interactive-agent.test.ts)`
- Expected: only required Pi launches receive the reader/env; artifact text content stays at or below 48 KiB and UTF-8 boundaries; offset/media-type rules are deterministic; invalid access yields one bounded error; existing capabilities do not broaden.

- Run: `mise run build --package packages/pi-agents`
- Expected: both `packages/pi-agents/dist/index.js` and `packages/pi-agents/dist/artifact-reader-extension.js` exist, with Pi/typebox packages externalized.

- Run: `(cd packages/pi-agents && bun pm pack --dry-run 2>&1 | rg "dist/artifact-reader-extension\.js")`
- Expected: the packed file list includes `dist/artifact-reader-extension.js`.

### Task 9: Preserve Sequential Chain and Template Semantics

**Outcome:** Inline Chain prompts remain byte-compatible, referenced text/structured outputs resolve only in trusted workflow code, and child prompts receive bounded reader handoffs rather than megabytes.

**Files:**

- Modify: `packages/pi-agents/src/result-payload.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/template.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/tests/output.test.ts`
- Modify: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/tests/invocation.test.ts`

**Steps:**

- [ ] Preserve exact inline substitution for `{previous}` and `{outputs.<name>}`.
- [ ] For text refs, substitute the bounded child descriptor and mark the next Pi invocation as requiring the reader.
- [ ] For trusted `readJsonPointer`, output-schema consumers, and internal Chain structured reads after externalization, resolve and verify refs at point of use.
- [ ] Keep schema extraction/validation on private structured output before unit externalization; never store a descriptor as structured authority.
- [ ] Reuse a unit artifact's digest/media type for named Chain outputs when content is identical. Revalidate the ref and change only semantic payload kind; do not read/rewrite bytes solely for naming.
- [ ] Externalize oversized named and collected Chain text/structured values before they enter externally visible details or final run state.
- [ ] Reject Grok ACP handoffs with `artifact_handoff_unsupported` before `beginUnit`, registration, or process dispatch.
- [ ] Test byte-for-byte small prompt parity, large previous output, large named text/structured output, JSON Pointer resolution, collect spill, Pi reader requirements, and pre-dispatch Grok rejection.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/output.test.ts tests/chain.test.ts tests/invocation.test.ts tests/execution.test.ts)`
- Expected: small prompts are unchanged; large Pi handoffs are bounded and reader-enabled; trusted structured reads verify refs; Grok rejects before side effects.

### Task 10: Preserve Fanout and Resume Semantics

**Outcome:** Frozen fanout mappings may spill as aggregate refs, resume verifies every reachable authority ref before scheduling, and completed work is never redispatched because an artifact is corrupt.

**Files:**

- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/tests/resume.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Convert `WorkflowFanoutState` to exact `items` / `itemsRef` alternatives and add runtime-only `ResolvedWorkflowFanoutState` with verified inline `items`; never serialize the runtime type.
- [ ] Reject an individual fanout item above 256 KiB exact JSON bytes with `fanout_item_too_large`; preserve the existing inline `{item}` contract.
- [ ] Permit the ordered aggregate list to spill above 256 KiB. Publish `itemsRef`, then strictly persist mapping and queued child units atomically before scheduling any worker.
- [ ] Resolve each referenced fanout result lazily while building collected arrays and reverify at point of use.
- [ ] Update coordinator equality, idempotence, merge, disk/live mirror, and capture logic for inline/ref unions. Compare verified digest/media type, not path text.
- [ ] Convert `validateFanoutResumeState()` and `inspectResume()` to async.
- [ ] During read-only pre-claim inspection and again after claim against a fresh record, verify `itemsRef` plus every result/Chain ref resumed execution may read.
- [ ] Return post-claim runtime-only `resolvedFanouts` and verified completed-output metadata to `RestoredChainState`; keep durable state ref-only.
- [ ] On missing, tampered, unparsable, wrong-run, or oversized artifacts, fail `artifact_missing` / `artifact_corrupt` before dispatch. Never mark completed work incomplete, redispatch it, or recompute a frozen mapping.
- [ ] Test inline/ref idempotence, aggregate spill, individual rejection, current/resumed fanout, runtime hydration not persisted, pre/post-claim corruption, claim race, and no duplicate dispatch.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-coordinator.test.ts tests/chain.test.ts tests/resume.test.ts tests/tool.test.ts)`
- Expected: aggregate mappings spill and resolve only in runtime; every reachable ref is verified before scheduling; corrupt refs stop before worker side effects; completed units are never redispatched.

### Task 11: Preserve Interactive Continuation and Rendering Semantics

**Outcome:** Continuation messages externalize oversized output before delivery, stale activations cannot send after async I/O, and UI rendering shows metadata without loading artifacts.

**Files:**

- Modify: `packages/pi-agents/src/interactive-relay.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Modify: `packages/pi-agents/src/render.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`
- Modify: `packages/pi-agents/tests/render.test.ts`

**Steps:**

- [ ] Add `outputRef` to `InteractiveContinuationDetails` with the Version 1 exact-one-of rule. Add a relay-local validator for this Pi custom-message data; malformed both/neither refs produce one bounded `artifact_corrupt` status and are never resolved.
- [ ] Inject `RunStore` into the relay. Reserve `endpointKey + activationId` in an in-flight set before artifact I/O and spill output above 256 KiB before `pi.sendMessage`.
- [ ] Immediately before send, recheck relay disposal, host session ID, branch binding, active-branch membership, endpoint generation, and activation ID. Suppress delivery if `/tree`, session switch, detach, or a newer activation invalidated trust.
- [ ] On spill failure, send at most one bounded status/error message without original output. Duplicate settle for the same activation cannot double-write or double-send.
- [ ] Track relay promises and expose `waitForIdle()`. Await it from `index.ts` during session shutdown before relay/registry disposal.
- [ ] Preserve collapsed rendering. Expanded ref rendering shows payload kind, formatted bytes, validated path when available, and digest prefix; it never synchronously reads content.
- [ ] Test duplicate settle during blocked artifact I/O, stale branch/session/activation changes, shutdown wait, legacy inline parity, malformed continuation inline/ref unions, bounded error delivery, and collapsed/expanded ref rendering.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-relay.test.ts tests/render.test.ts)`
- Expected: artifact publication precedes continuation delivery; stale/duplicate sends are suppressed; shutdown waits for tracked work; rendering remains bounded and performs no artifact read.

### Task 12: Enforce the Async Strict Terminal Barrier

**Outcome:** Production terminal paths activate externalization, and no terminal callback, durable event, claim release, parent output, or continuation can observe a ref before artifact and strict run authority exist.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/run-persistence.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/abort.ts`
- Modify: `packages/pi-agents/src/tool.ts`
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

- [ ] Change `RunCoordinator.finishUnit()` to `Promise<SingleResult>` and return the committed artifact-aware terminal snapshot.
- [ ] Make `endUnit` and every success, abort, early-failure, and thrown-error terminal path await the promise exactly once. Typed publication errors must not recursively call `finishUnit`.
- [ ] Cancel pending coalesced writes, externalize private authority first, and build unit/attempt terminal mutation on a private clone of latest disk/live authority.
- [ ] Strictly publish the private clone with `updateRunStrict`. Do not mutate live state before success; a rejected clone must remain unreachable to stale timers.
- [ ] After strict `run.json` success, append `unit_terminal` with `appendEventStrict`, mirror committed disk state into live state, and return the snapshot.
- [ ] If the event append fails after `run.json` commits, mirror the authoritative disk state but throw `durable_write_error`; never report parent success.
- [ ] Make `finalizeRun` use a private final clone and `updateRunStrict`; remove coordinator unregistration from this method.
- [ ] Externalize final Chain collect outputs before strict run finalization.
- [ ] Consolidate fresh and resumed finalization through one helper. Success order is strict run finalization -> strict `run_terminal` -> coordinator unregister -> `releaseRun`.
- [ ] Failure order is cancel/unregister live state -> `abandonRun` -> rethrow. Never release a failed finalization claim or leave a registered run without ownership.
- [ ] Emit authoritative parent and relay terminal updates only after awaited `finishUnit`; low-level updates remain provisional.
- [ ] Cover failures before artifact publication, during strict unit write, `unit_terminal`, collect spill, strict run write, and `run_terminal`; no path may publish success or a dangling ref.
- [ ] Use controlled promises to prove artifact -> strict `run.json` -> strict event -> live/parent/relay publication order and to prove stale timer/activation suppression.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts tests/execution.test.ts tests/pi-rpc-execution.test.ts tests/chain.test.ts tests/interactive-relay.test.ts tests/update-coalescer.test.ts)`
- Expected: terminal publication is awaited; refs never precede artifact/run authority; success unregisters before release; failure unregisters before abandon; stale updates cannot publish rejected authority.

### Task 13: Document the Feature and Run End-to-End Gates

**Outcome:** Users can reason about authority, limits, compatibility, retention, and recovery, and the complete package passes focused and repository validation.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`
- Modify: `packages/pi-agents/docs/how-to.md`

**Steps:**

- [ ] Document all fixed RPC, shell, inline, artifact, child-reader, presentation, diagnostic, and idle-retention budgets as separate boundaries.
- [ ] Explain the historical 2,320,362-byte failure, the already-landed 8 MiB mitigation, and why projector regression fixtures start above 8 MiB.
- [ ] Document exact-prefix Pi 0.80.9 compatibility, runtime/documentation `message_update` order disagreement, `agent_settled` authority, and fail-closed behavior on future key-order drift.
- [ ] State dependency policy accurately: Pi peers are `"*"`; development and compatibility tests use exact Pi 0.80.9.
- [ ] Explain transport omission versus registry `projectFinalizedMessage`, direct settle rehydrate, and why the ordinary lazy hydration path is not used at settle.
- [ ] Document disabled `get_messages`, additive Version 1 refs, exact-one-of rules, error codes, artifact-first publication, claim cleanup, Chain/fanout/resume behavior, and child reader use.
- [ ] Add parent inspection examples using the validated displayed path and child examples that repeat `pi_agents_read_artifact` with `nextOffsetBytes` for long single-line content.
- [ ] Document privacy and retention: artifacts may contain sensitive model/tool output, use private run storage, can be exposed only to explicitly handed-off child runs, receive no automatic GC, and are removed with the entire inactive run directory.
- [ ] Add focused tests, package test, typecheck, build, pack dry-run, and `hk check` commands to README validation guidance.

**Validation:**

- Run: `rg -n "8 MiB|64 MiB|16 KiB|256 KiB|48 KiB|512 KiB|get_messages|agent_settled|projectFinalizedMessage|artifact|sha256|pi_agents_read_artifact|0\.80\.9|peer" packages/pi-agents/README.md packages/pi-agents/docs/{reference,explanation,how-to}.md`
- Expected: all limits, authority boundaries, dependency policy, reader usage, retention, and disabled command are documented consistently.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: no TypeScript errors, including async terminal/resume signatures and inline/reference unions.

- Run: `mise run test --package packages/pi-agents`
- Expected: the complete package suite passes with zero failures; the count is greater than the pre-change 1026-test baseline.

- Run: `mise run build --package packages/pi-agents`
- Expected: both package entries build without bundling a second Pi/typebox SDK instance.

- Run: `(cd packages/pi-agents && bun pm pack --dry-run 2>&1 | rg "dist/(index|artifact-reader-extension)\.js")`
- Expected: both built entries are present in the package file list.

- Run: `hk check`
- Expected: repository ESLint and Prettier checks pass.

- Run: `git diff --check`
- Expected: no whitespace errors.

## Final Validation

### Transport and Lifecycle

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-record-projector.test.ts tests/pi-rpc-transport.test.ts tests/interactive-agent.test.ts tests/pi-rpc-execution.test.ts tests/interactive-relay.test.ts tests/memory-regression.test.ts tests/update-coalescer.test.ts)`
- Expected: historical and exact-8-MiB baselines pass; 8.2–8.3 MiB canonical records project; 12 MiB authority rehydrates before settle; ordinary/projectable cap failures remain independent; eviction and relay ordering pass.

### Artifact and Workflow

- Run: `(cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/result-payload.test.ts tests/result-snapshot.test.ts tests/run-store.test.ts tests/run-coordinator.test.ts tests/tool.test.ts tests/output.test.ts tests/completion-check.test.ts tests/chain.test.ts tests/resume.test.ts tests/artifact-reader-extension.test.ts tests/security.test.ts tests/invocation.test.ts tests/execution.test.ts tests/render.test.ts)`
- Expected: artifact durability, refs, provisional snapshots, strict barriers, Chain/fanout/resume, child reader, and rendering suites all pass.

### Memory and Serialized Size

Extend `tests/memory-regression.test.ts` with generated values and require:

- A 12 MiB final text plus large structured output produces verified artifacts; terminal `SingleResult` JSON remains below 1 MiB and contains no 64-byte payload sentinel.
- Pretty-printed `run.json`, including `details.results` and `units[*].result`, remains below 2 MiB for the 12 MiB fixture.
- An eight-item fanout with 4 MiB final text and 4 MiB structured output per item stores authority only in artifacts/refs; combined parent details and `run.json` each remain below 2 MiB and contain no raw sentinel.
- Every artifact is at or below 64 MiB and verifies exact byte count/digest.
- Every provisional update contains no authoritative inline value or ref and remains inside existing presentation/diagnostic budgets.
- Every child reader call returns at most 48 KiB of artifact data, keeps metadata bounded, and never starts or ends inside a UTF-8 code point.

- Run: `(cd packages/pi-agents && bun test tests/memory-regression.test.ts tests/result-snapshot.test.ts tests/result-payload.test.ts tests/artifact-reader-extension.test.ts)`
- Expected: all explicit serialized-size, no-sentinel, digest, provisional-budget, and chunk-size thresholds pass.

### Source Audits

- Run: `rg -n "MAX_STDOUT_RECORD_BYTES|MAX_PROJECTABLE_RPC_RECORD_BYTES|RPC_PROJECTED_SHELL_FIELD_MAX_BYTES|RESULT_INLINE_PAYLOAD_MAX_BYTES|RUN_ARTIFACT_MAX_BYTES|RPC stdout record exceeded" packages/pi-agents/src packages/pi-agents/tests`
- Expected: values are consistently 8 MiB ordinary, 64 MiB projectable, 16 KiB shell string, 256 KiB inline, and 64 MiB artifact; overflow text remains exact.

- Run: `rg -n "snapshotSingleResult|snapshotProvisionalResult|externalizeTerminalResult" packages/pi-agents/src/{execution,pi-rpc-execution,tool,chain,abort,run-coordinator,result-snapshot,result-payload}.ts`
- Expected: external running/low-level updates use provisional snapshots; terminal externalization occurs only at awaited publication boundaries.

- Run: `rg -n "updateRunStrict|appendEventStrict|unit_terminal|run_terminal|abandonRun|unregisterRun|releaseRun" packages/pi-agents/src/{run-store,run-coordinator,run-persistence,tool}.ts`
- Expected: artifacts precede strict run refs, strict terminal events precede publication, success unregisters before release, and failure unregisters before abandon.

- Run: `rg -n "case ['\"]agent_end|\.messages" packages/pi-agents/src/{interactive-agent,pi-rpc-execution,interactive-relay}.ts`
- Expected: raw child `agent_end` consumers do not inspect aggregate messages; authority comes from ordinary message events or verified session rehydrate.

## Failure Behavior

| Failure                                                         | Required behavior                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Ordinary/non-canonical record exceeds 8 MiB                     | `stdout_overflow`; no listener delivery                                              |
| Canonical projectable record exceeds 64 MiB                     | `stdout_overflow`; no listener delivery                                              |
| Projected record has malformed JSON or late canonical violation | `malformed_json` or ordinary-cap failure; never emit a synthetic event               |
| Settle-time session is missing, stale, malformed, or incomplete | Activation fails with bounded `hydrate_error`; no successful terminal snapshot       |
| `get_messages` requested                                        | `get_messages_disabled` before request ID, pending state, timer, or stdin write      |
| Artifact exceeds 64 MiB                                         | `artifact_too_large`; no ref                                                         |
| Oversized result has no run-local store                         | Bounded `artifact_store_unavailable`; no external write or oversized inline fallback |
| Artifact write/sync fails                                       | Bounded `artifact_write_error`; unreferenced files may remain, dangling refs may not |
| Trusted artifact ref is missing/corrupt/cross-run               | `artifact_missing` / `artifact_corrupt` before use or dispatch                       |
| Child artifact is missing/corrupt/unauthorized                  | One bounded `artifact_unavailable` tool error without path-existence detail          |
| Child offset is past EOF or inside a UTF-8 code point           | Bounded `invalid_artifact_offset`; no content                                        |
| Continuation custom-message inline/ref union is malformed       | Bounded `artifact_corrupt`; do not resolve or render authority                       |
| Strict `run.json` or terminal event write fails                 | `durable_write_error`; no parent/relay success; unregister then abandon claim        |
| Grok ACP receives an artifact handoff                           | `artifact_handoff_unsupported` before unit registration or dispatch                  |
| Async continuation becomes stale during artifact I/O            | Suppress send and release in-flight reservation without exposing output              |

## Privacy and Security

- Artifacts can contain sensitive model output, tool results, and structured data. Store them only under the owning run directory with private permissions where supported.
- Artifact paths are derived from digest; no trusted or child API accepts a caller-supplied path.
- Every trusted resolution verifies containment, file type, symlink status, byte count, digest, media type, payload kind, and run identity.
- The child reader receives only one run ID/root through private environment values and returns bounded chunks. Child-visible errors do not distinguish missing from corrupt/unauthorized paths.
- Reader injection does not remove capabilities already granted by the selected agent, but it must not add general `read`, `bash`, or filesystem tools.
- Descriptors must not contain artifact content. Parent descriptors may contain a validated path; child descriptors contain only run ID, digest, byte count, payload kind, and reader instructions.
- Do not log artifact content, private artifact roots, or full sensitive refs in error paths.

## Rollout Notes

1. Task 1 intentionally updates compatibility metadata before runtime work: Pi peers become `"*"`, while development and projector compatibility tests pin exact 0.80.9.
2. Tasks 2–5 form the transport/lifecycle layer and can land before artifact externalization. The projector is incomplete until the 8.2+ MiB and 12 MiB integrations pass.
3. Tasks 6–11 add storage and all ref consumers while production terminal publication remains inline-compatible. Task 12 activates artifact-backed terminal publication only after those consumers are ready.
4. Do not release a build containing durable refs unless Tasks 6–12 and all final gates pass together.
5. Existing inline Version 1 records remain readable; no migration or rewrite is required.
6. A future Pi key-order change intentionally returns affected oversized records to the ordinary 8 MiB failure until runtime source and compatibility tests are updated.
7. Artifact retention is whole-run retention. Do not add partial cleanup or GC during this rollout.

## Risks and Mitigations

- **Exact-prefix projection is coupled to Pi runtime construction.** — Pin exact 0.80.9 development versions and producer order; fully validate records; fall back to 8 MiB on drift.
- **RPC documentation and runtime disagree on `message_update` key order.** — Treat installed runtime plus `JSON.stringify` forwarding as authority and document the discrepancy.
- **A custom scanner could accept malformed JSON.** — Implement full grammar/depth/duplicate/order validation and exhaustive split/malformed tests.
- **Projection could reorder stream and terminal events.** — Keep one record state, preserve same-chunk order, await endpoint transitions, and test blocked queues.
- **Settle rehydrate could deadlock on the endpoint writer lease.** — Use only direct `SessionManager.open()` inside settle; never use ordinary lazy hydration there.
- **Session persistence could lag `agent_settled`.** — Verify finalized/assistant counts and fail `hydrate_error` instead of publishing omission-only success.
- **Artifact refs could become durable before files.** — Publish/verify artifact, strictly write `run.json`, strictly append terminal event, then publish parent/relay state.
- **Strict event append could fail after `run.json` commits.** — Treat `run.json` as authority, mirror it, report failure, and abandon rather than reporting success.
- **Artifact paths could escape or follow symlinks.** — Derive paths from digest and validate containment, `lstat`, `realpath`, regular-file status, size, and digest on every read.
- **Ref hydration could restore memory growth or leak into persistence.** — Keep resolved values runtime-only, reverify lazily, and test that durable mirrors retain refs.
- **Async resume inspection could race claim acquisition.** — Verify reachable refs both before and after claim; dispatch only from post-claim verified state.
- **Child reader injection could be mistaken for a sandbox.** — Add only the dedicated tool and state clearly that pre-existing agent capabilities remain unchanged.
- **Continuation I/O could deliver to a stale branch.** — Reserve activation identity, revalidate trust immediately before send, track promises, and suppress stale delivery.
- **Fixed limits may reject future workloads.** — Return explicit errors and gather evidence before changing constants; do not add configuration or silently raise caps.

## Open Questions

**Open Questions:** None. The peer/dev dependency policy, fixed limits, Version 1 compatibility, Pi 0.80.9 canonical order, child-reader scope, and retention policy are decided for this plan.
