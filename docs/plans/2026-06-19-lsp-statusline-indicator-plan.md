# LSP StatusLine Indicator Implementation Plan

**Goal:** Show a passive, non-interactive LSP health indicator in Pi's statusLine that reflects the current snapshot of lazily-started LSP servers — how many are running, starting, or failed — and updates in real time as server states change (including async crash-restart and backoff-retry transitions).

**Inputs:** User request on 2026-06-19 (UX discussion). Display format like `LSP 2`. Constraints from the user: non-interactive (pure status display); servers are passively/lazily started (only discovered after editing a matching file triggers startup); a failed server *will* be retried, so its state can change over time — the indicator must therefore be a live snapshot, not a tombstone. Repository evidence from `src/types.ts`, `src/instance.ts`, `src/manager.ts`, `src/index.ts`.

**Assumptions:**

- There is no meaningful "total server count" to display as a denominator: because discovery is passive, the set of known servers grows over the session as new file types are edited, and is never known up front. The indicator shows only what has been discovered so far, never `ready/total`.
- The indicator counts the running set as the primary number, surfaces failures as a separate `✗N` count (red), and optionally surfaces in-flight startups as `…N` (dim).
- `stopped` and `stopping` are transient/non-interesting states for display purposes and are not counted.
- When zero servers are known (session start, before any matching file is edited), the indicator is hidden entirely (clear the status key) rather than showing `LSP 0`, to avoid noise.
- The statusLine renderer supports per-segment color and Unicode glyphs via `ctx.ui.setStatus(key, text)`. **Confirmed:** the built-in footer (`dist/modes/interactive/components/footer.js`) renders extension status strings raw — it only sanitizes control chars, does NOT strip ANSI, and does NOT wrap the text in a flat theme color. The TUI is ANSI-aware (`docs/tui.md`). So per-segment color is achieved by embedding ANSI via `ctx.ui.theme.fg(colorName, text)` directly in the `setStatus` string — **no `setFooter` custom component is required.**

**Architecture:** The single-server state machine in `src/instance.ts` currently mutates a closure-local `let state` at 7 sites with no notification when state changes. The core change is to route every state mutation through a single `setState()` setter that fires an `onStateChange` callback. `src/manager.ts` aggregates per-instance state-change signals into a single manager-level subscription (`onServersChanged`). `src/index.ts` (the Pi extension entry) subscribes to that signal and renders the aggregated counts via `ctx.ui.setStatus('lsp', …)`. This is genuinely event-driven and requires no polling — critically, it captures the async `restartOnCrash` (`instance.ts:97`) and `-32801` backoff-retry transitions that do NOT occur on any file-edit/tool-result event path, so a failed→retry→running recovery updates the statusLine without waiting for the next user edit.

**Tech Stack:** TypeScript, Pi extension API (`ctx.ui.setStatus`), Vitest, existing `mise` tasks (`mise run typercheck`, `mise run test`, `mise run build`, `hk check`).

---

## State → Display Mapping

| Display bucket | Renders as | `LspServerState` (`src/types.ts:6`) | Color |
|---|---|---|---|
| ready (primary count) | `LSP N` | `running` | default |
| starting (in-flight) | `…N` suffix | `starting` | dim |
| failed | `✗N` suffix | `error` | red |
| (not counted) | — | `stopped`, `stopping` | — |

### Render rules

```
LSP 2          only running                         steady state, plain
LSP 2 …1       at least one starting                transient, self-updating
LSP 2 ✗1       at least one error                   red ✗, disappears when retry succeeds
(hidden)       zero known servers                   setStatus('lsp', undefined)
```

The failed count is a *live snapshot*: because a failed server is retried (crash auto-restart or `error → starting → running`), `✗1` must disappear once recovery succeeds. This is why event-driven refresh (not edit-triggered refresh) is required.

---

## File Map

- Modify: `src/instance.ts` — route all 7 `state = …` mutations through a single `setState(next)` setter; add an optional `onStateChange` callback wired in via the factory and exposed so the manager can subscribe.
- Modify: `src/manager.ts` — when constructing each `LSPServerInstance`, subscribe to its state changes; expose a manager-level `onServersChanged(listener)` subscription plus a `getStateCounts()` helper that returns `{ running, starting, error }` over `getAllServers()`.
- Modify: `src/index.ts` — on `session_start`, subscribe to `onServersChanged` and render `ctx.ui.setStatus('lsp', …)`; clear it on session teardown.
- Create: `src/statusline.ts` — pure formatter: given `{ running, starting, error }` and a `theme.fg`-style color function, return the display string (or `undefined` when all zero). Keeps formatting testable; the color function is injected so the formatter has no hard dependency on the TUI. (ABOUTME header required.)
- Modify: `README.md` — document the LSP statusLine indicator, its format, the meaning of `…N` / `✗N`, and that it is a passive live snapshot.
- Test: `tests/statusline.test.ts` — unit coverage for the formatter across all bucket combinations (zero → hidden, running-only, with starting, with error, mixed). Inject an identity/marker `fg` stub so assertions verify which segment got which color without depending on real ANSI codes.
- Test: `tests/instance-state-change.test.ts` — verify `onStateChange` fires on each transition (start success, start failure, stop, crash→error).

## Implementation Detail

### `src/instance.ts` — single state mutation funnel

Replace the bare `let state` with a setter so all transitions notify exactly once:

```ts
let state: LspServerState = 'stopped';
let onStateChange: ((state: LspServerState) => void) | undefined;
function setState(next: LspServerState): void {
  if (next === state) return;
  state = next;
  onStateChange?.(next);
}
```

Then replace each of the 7 assignment sites (`instance.ts:98, 161, 253, 261, 281, 295, 298`) with `setState('…')`. Expose registration, e.g. an `onStateChange(listener)` method on `LSPServerInstance`, or accept the callback as a third factory arg from the manager. Prefer the factory arg to keep the public instance surface minimal.

### `src/manager.ts` — aggregation + subscription

- On server creation, pass a state-change callback that calls the manager's internal `notifyServersChanged()`.
- Add `getStateCounts(): { running: number; starting: number; error: number }` iterating `servers.values()`.
- Add `onServersChanged(listener: () => void): () => void` (returns an unsubscribe). Keep a simple listener set; no external deps.

### `src/index.ts` — render

```ts
pi.on('session_start', (_event, ctx) => {
  const manager = getManager();
  const fg = ctx.ui.theme.fg.bind(ctx.ui.theme);
  const render = () => ctx.ui.setStatus('lsp', formatLspStatus(manager.getStateCounts(), fg));
  const unsubscribe = manager.onServersChanged(render);
  render(); // initial (hidden when zero)
  // unsubscribe + ctx.ui.setStatus('lsp', undefined) on teardown
});
```

`formatLspStatus(counts, fg)` lives in `src/statusline.ts` and returns `undefined` when all counts are zero (so `setStatus` clears the segment). It colors only the failure segment, e.g. `` `LSP ${running} ${fg('error', `✗${error}`)}` ``, and dims the starting segment via `fg('dim', `…${starting}`)`. The confirmed footer behavior (raw ANSI passthrough, no flat color wrapper) makes this work in the built-in footer with no `setFooter`. Mirrors the official `examples/extensions/preset.ts` / `status-line.ts` pattern (`theme.fg(color, text)` per segment, concatenated).

## Validation

- `mise run typercheck` — types compile.
- `mise run test` — new formatter and state-change tests pass, existing suite green.
- `hk check` — eslint + prettier clean.
- Manual: edit a file matching a configured server → indicator appears as `LSP 1` (or `…1` then `LSP 1`); edit a file whose server is misconfigured → `✗1` in red; confirm a recovering server clears `✗` without further edits.

## Open Questions / Decisions Deferred

- Whether to render `starting` at all, or only count it once `running` (simpler, but loses the "it's coming" affordance). Plan keeps `…N` but it is the easiest piece to drop.
- Exact glyphs (`…` / `✗`) vs ASCII fallbacks — depends on confirmed statusLine font/Unicode support; formatter centralizes this so it is a one-line change.
- ~~Color application via `setStatus` vs `setFooter`.~~ **Resolved:** per-segment color works through `setStatus` by embedding `ctx.ui.theme.fg(color, text)` ANSI; the built-in footer passes ANSI through untouched. No `setFooter` needed.

## Stop Rules

- This document is a plan only; no source changes made yet.
- Color/Unicode capability of `setStatus` confirmed against `@earendil-works/pi-coding-agent` (footer renders raw ANSI; `theme.fg` per-segment coloring works). Ready to implement.
