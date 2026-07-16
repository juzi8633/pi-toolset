# Subagent Memory Optimization Follow-ups

**Branch:** `fix/subagent-memory-optimization`  
**Source:** independent re-review after remediation Rounds 1–8  
**Status:** closed — all deferred items resolved in Follow-up Closure / Review Round 9  
**Plan:** `packages/pi-agents/docs/plans/2026-07-16-subagent-memory-review-fix-plan.md`

## Context

Memory-optimization remediation Rounds 1–8 closed most Critical findings around compact snapshots, Interactive retention, claim cleanup, worktree metadata, and durable fail-closed validation. Residual review findings were deferred here and are now closed.

Package suite after closure: **1026 pass / 0 fail**.

## Closed Critical

### C1. Durable result status/exitCode consistency is under-validated — CLOSED

- **Where:** `packages/pi-agents/src/run-store.ts` `validateResultShell`; consumer Parallel restore skip in `packages/pi-agents/src/tool.ts`.
- **Resolution:** `validateResultShell` now validates message entries as non-null objects, optional status/exitCode types, and completed-unit consistency (`status` must be `completed` when present; `exitCode` must not be `-1`; status-less shells require `exitCode === 0`). Inconsistent completed shells and malformed messages fail as `corrupt_run` pre-claim.
- **Evidence:** `bun test packages/pi-agents/tests/run-store.test.ts -t "inconsistent result"` → pass; full package suite 1026 pass; existing Parallel skip-completed regression still green.

### C2. Details validation is not mode/topology-aware — CLOSED

- **Where:** `packages/pi-agents/src/run-store.ts` `validateSubagentDetails` / `validateRunRecord`.
- **Resolution:** Details validation receives record `mode` + request topology. When `mode === 'chain'`, output/step agent provenance is checked against `request.chain` so impossible high steps and wrong agents cannot poison later-step-wins. Single/Parallel may still carry ignored legacy `details.chain`/`outputs` presentation (documented; not a schema migration).
- **Evidence:** `bun test packages/pi-agents/tests/run-store.test.ts -t "impossible step"` → pass; legacy single-with-chain fixture still accepted.

### C3. Non-allowlisted AgentMessage roles skip projection — CLOSED

- **Where:** `packages/pi-agents/src/interactive-agent.ts` `projectFinalizedMessage`.
- **Resolution:** Every non-assistant role (including `bashExecution` and unknown roles) is projected with complete-item bounding of `output`/`content`/`details` and remaining top-level payloads. Authoritative assistant text/usage/model/stopReason preserved.
- **Evidence:** `bun test packages/pi-agents/tests/interactive-agent.test.ts -t "bashExecution and unknown"` → pass.

## Closed Warnings

### W1. Assistant text sibling identity fields remain unbounded — CLOSED

- **Where:** `packages/pi-agents/src/interactive-agent.ts` `boundAssistantContentPart` / `boundTextPartSiblings`.
- **Resolution:** Text remains exact even when huge. Identity siblings (`id`, `name`, `toolCallId`, `toolName`, `mimeType`) and unknown extras are complete-item budgeted and dropped until the non-text envelope fits the item cap.
- **Evidence:** `bun test packages/pi-agents/tests/interactive-agent.test.ts -t "text-part identity siblings"` → pass.

### W2. Truncated render summary may reintroduce ANSI reset injection — CLOSED

- **Where:** `packages/pi-agents/src/render.ts` `truncateDisplayToWidth`.
- **Resolution:** Restored wrapper strips pi-tui `truncateToWidth` SGR full-reset (`\x1b[0m`) around ellipsis so parent tool-result background is not cleared. Applied to summary preview, title clamp, and activity-line fit.
- **Evidence:** `bun test packages/pi-agents/tests/render.test.ts -t "SGR full-reset"` → 2 pass.

## Validation After Closure

| Gate                                                            | Result             |
| --------------------------------------------------------------- | ------------------ |
| Focused suite (interactive-agent / run-store / resume / render) | 231 pass / 0 fail  |
| `mise run typecheck --package packages/pi-agents`               | pass               |
| `mise run test --package packages/pi-agents`                    | 1026 pass / 0 fail |
| `hk check`                                                      | pass               |
| `mise run build --package packages/pi-agents`                   | pass               |
| `git diff --check`                                              | pass               |

## Explicitly Out Of Scope Here

- `packages/pi-lsp` findings from earlier mixed reviews.
- New public memory configuration.
- Durable schema Version 2.
- Optional reduced-heap soak unless requested.
