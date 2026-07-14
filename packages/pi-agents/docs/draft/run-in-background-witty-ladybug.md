# Add `run_in_background` to the `agent` tool (pi-agents)

## Context

`@balaenis/pi-agents` exposes one `agent` tool with three modes (single / parallel / chain). Today **every** call is fully synchronous: `executeAgentTool` awaits the mode dispatch, which awaits `runSingleAgent` (`src/execution.ts:142`) — a `pi` child process whose stdout JSON event stream the parent reads to completion. There is no background/async/registry infrastructure anywhere in the package.

We want a `run_in_background` option so a delegated agent can be launched and control returned to the caller immediately, with a push notification waking the parent LLM when the work finishes. This lets the model fire off long-running delegation and keep working (or end its turn) instead of blocking.

**Chosen shape (confirmed with Mr. Julian):**

- **Architecture:** in-process fire-and-forget (like Claude Code), not detached subprocess. The background job lives as long as the `pi` session; it dies when the session exits. Minimal change, reuses the existing spawn/stream path.
- **Control surface:** push-only. On completion we inject one notification via `pi.sendMessage(..., { triggerTurn: true })` and tell the model not to poll. No list/status/cancel tool.
- **Scope:** top-level flag, applies to all modes (single/parallel/chain). The whole call is one background unit with one summary notification.

## Key facts grounding the design

- `pi` (ExtensionAPI) has `sendMessage(msg, { triggerTurn })` and `events` (`types.d.ts:867`, `:970`). The `ctx` (ExtensionContext) passed to `execute` does **not** have `sendMessage` — so `pi` must be threaded from `index.ts` into the execute path.
- `runSingleAgent` already keeps running after its caller stops awaiting: its child stdout `'data'` listeners keep the event loop engaged and accumulate into `currentResult` until the child `close`. We only need to _not await_ it and _not_ reuse the per-call `onUpdate`/`signal`.
- The per-call `signal` is tied to the tool-call/turn and may be aborted at the turn boundary. The background run must use a **fresh `AbortController`**, never the incoming `signal`.
- Reference (read-only, do not depend on): `pi-subagents` `notify.ts` shows the exact `pi.sendMessage({ customType, content, display: true }, { triggerTurn: true })` completion pattern.

## Implementation

### 1. Schema — `src/schema.ts`

Add to `SubagentParams` (after `isolation`, ~line 96):

```ts
run_in_background: Type.Optional(
  Type.Boolean({
    description:
      'Launch the agent(s) in the background and return immediately. You are notified when the work completes. Do not poll or sleep waiting for it — continue other work or end your turn.',
  })
),
```

`Params = Static<typeof SubagentParams>` picks it up automatically.

### 2. New module — `src/background.ts`

In-process job registry + launch + notify. Holds:

- `const jobs = new Map<string, BackgroundJob>()` where `BackgroundJob = { id, label, controller: AbortController, startedAt }`.
- `launchBackgroundAgent(pi, label, makeDetails, run): AgentResult`:
  - generate short `id` (`randomUUID().slice(0, 8)` from `node:crypto`),
  - create a fresh `AbortController`, register the job,
  - fire `void (async () => { try { const r = await run(controller.signal); notify(pi, ...) } catch (e) { notifyError(pi, ...) } finally { jobs.delete(id) } })()` — **not awaited**,
  - return immediately a "launched" `AgentResult`: `content` = a short message (`Background agent launched: <label> [<id>]. Runs detached; you'll be notified on completion. Do not poll — continue other work or end your turn.`), `details` = `makeDetails([])` (reuse the empty-results details factory).
- `notify(pi, id, label, result)`: flatten `result.content` text, status = `result.isError ? 'failed' : 'completed'`, call
  `pi.sendMessage({ customType: 'agent-background-notify', content: '...summary...', display: true }, { triggerTurn: true })`.
- `notifyError(pi, id, label, err)`: same channel with the error message.
- Enforce a simple cap `MAX_BACKGROUND_JOBS` (add to `src/constants.ts`, default 8): if `jobs.size >= cap`, return an error `AgentResult` instead of launching.

No persistent `pi.events` handler is registered (notify is inline at completion), so there is no stale-handler-on-reload concern.

### 3. Dispatch wiring — `src/tool.ts`

- Extract the mode-dispatch tail (current `tool.ts:149-167`, the `runChain`/`runParallel`/`runSingle` selection) into a helper `dispatchAgentMode(ctx, agents, params, signal, onUpdate, makeDetails): Promise<AgentResult>`.
- Add `pi: ExtensionAPI` as a parameter to `executeAgentTool`. Keep all existing validation + the project/package-agent confirmation block **before** branching (the user must still approve elevated agents synchronously).
- After confirmation:
  - if `params.run_in_background`: `return launchBackgroundAgent(pi, <label>, makeDetails(mode), (sig) => dispatchAgentMode(ctx, agents, params, sig, undefined, makeDetails))`. Pass `onUpdate: undefined` for the background run (the foreground tool row is already finalized once we return).
  - else: `return dispatchAgentMode(ctx, agents, params, signal, onUpdate, makeDetails)` (unchanged behavior).
- `<label>` = the agent name (single), `"N tasks"` (parallel), or `"chain (N steps)"` — derived from `params`.

### 4. Entry — `src/index.ts`

Thread `pi` into the call:

```ts
async execute(_toolCallId, params, signal, onUpdate, ctx) {
  return executeAgentTool(params, signal, onUpdate, ctx, pi);
}
```

Optional hardening: in a session-shutdown lifecycle hook, abort all in-flight jobs. Not essential (children die with the parent `pi` process); note but skip unless trivial.

### 5. Render (optional polish) — `src/render.ts`

`makeDetails([])` yields empty `results`; confirm `renderResult` renders an empty-results launched call without error. If it looks bare, add a one-line "launched in background" affordance. Do not over-engineer.

## Files touched

- `src/schema.ts` — new `run_in_background` param
- `src/background.ts` — **new** registry + launch + notify
- `src/tool.ts` — extract `dispatchAgentMode`, add `pi` param, background branch
- `src/index.ts` — pass `pi` into `executeAgentTool`
- `src/constants.ts` — `MAX_BACKGROUND_JOBS`
- `tests/background.test.ts` — **new**
- `README.md` — document the option

## Tests — `tests/background.test.ts` (Bun, mirror existing patterns)

With a fake `pi` (spy on `sendMessage`) and a deferred `run`:

- `launchBackgroundAgent` returns the "launched" result **before** `run` resolves (assert content + id present, `run` not yet settled).
- On `run` resolve → `pi.sendMessage` called once with `triggerTurn: true` and the result text/status.
- On `run` reject → error notification sent.
- The background run receives a **fresh** signal: aborting the incoming per-call `signal` does not abort the job (assert the controller passed into `run` is independent).
- Registry cleanup: job removed from `jobs` after settle; `MAX_BACKGROUND_JOBS` cap returns an error result when exceeded.

## Validation

1. `mise run typecheck --package packages/pi-agents`
2. `mise run test --package packages/pi-agents`
3. `hk check` (eslint + prettier)
4. Manual end-to-end: run `pi` in the repo, invoke the `agent` tool with `run_in_background: true` (single mode). Confirm the tool returns a "launched" message immediately, the turn continues/ends, and a `agent-background-notify` message arrives and wakes the LLM when the child finishes. Repeat once for a `tasks` (parallel) call to confirm the summary notification.
