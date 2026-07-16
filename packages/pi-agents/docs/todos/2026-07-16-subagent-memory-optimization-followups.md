# Subagent Memory Optimization Follow-ups

**Branch:** `fix/subagent-memory-optimization`  
**Source:** independent re-review after remediation Rounds 1–8  
**Status:** deferred — remaining items for a later session  
**Plan:** `packages/pi-agents/docs/plans/2026-07-16-subagent-memory-review-fix-plan.md`

## Context

Memory-optimization remediation Rounds 1–8 closed most Critical findings around compact snapshots, Interactive retention, claim cleanup, worktree metadata, and durable fail-closed validation. Package suite last reported **1020 pass / 0 fail**.

This file captures residual review findings that were **not closed** when work paused. Treat them as optimization/hardening items, not blockers for unrelated work, unless a later merge decision reclassifies them.

## Open Critical

### C1. Durable result status/exitCode consistency is under-validated

- **Where:** `packages/pi-agents/src/run-store.ts` result-shell validation; consumer `packages/pi-agents/src/tool.ts` Parallel restoration/status skip.
- **Issue:** Validation only requires `messages` to be an array. A durable unit can be marked completed while its `result.status` is still `running`/`failed` or `exitCode: -1`. Parallel restoration can copy that result and later redispatch an already-completed unit.
- **Impact:** Incorrect resume skip/redispatch; post-claim snapshot may throw on malformed message entries instead of pre-claim `corrupt_run`.
- **Next step:**
  - Validate minimum status/exitCode/message-entry consistency for unit results and `details.results`.
  - Reject contextual contradictions as `corrupt_run` before claim.
  - Add resume/Parallel tests for completed unit with inconsistent result shell and malformed message entries.

### C2. Details validation is not mode/topology-aware

- **Where:** `packages/pi-agents/src/run-store.ts` details validator; consumers `packages/pi-agents/src/resume.ts`, `packages/pi-agents/src/chain.ts`.
- **Issue:** Validator does not receive record mode/request topology. Chain details can appear on Single runs; output entries can carry impossible step/agent provenance. In Chain restore, an invalid high step can win later-step-wins and poison downstream templates.
- **Impact:** Corrupt provenance survives claim/restore; wrong named output can drive later tasks.
- **Next step:**
  - Pass mode + request topology into details validation.
  - Require Chain details only for chain mode; reject impossible step/agent/output provenance.
  - Keep valid legacy fixtures accepted; add mode-mismatch and bad-provenance regressions.

### C3. Non-allowlisted AgentMessage roles skip projection

- **Where:** `packages/pi-agents/src/interactive-agent.ts` finalized-message projection / hydrate path.
- **Issue:** Valid Pi roles outside assistant/user/toolResult/custom (notably `bashExecution`) receive no payload projection. Hydrated shell `output` can remain unbounded in active and settled Agent View.
- **Impact:** Bypasses documented per-item/active retention caps.
- **Next step:**
  - Project every known and unknown role with complete-item bounding.
  - Preserve only documented authoritative assistant text/usage/model/stopReason.
  - Add hydrate tests with large `bashExecution.output` and other unknown roles.

## Open Warnings

### W1. Assistant text sibling identity fields remain unbounded

- **Where:** `packages/pi-agents/src/interactive-agent.ts` assistant content-part projection.
- **Issue:** Authoritative text is preserved, but oversized sibling fields such as `id`, `name`, `toolCallId`, `toolName`, or `mimeType` on text parts may skip complete-item budgeting.
- **Next step:** Keep text exact; bound/strip sibling non-authoritative fields under the complete-item cap; add multi-field text-part regressions.

### W2. Truncated render summary may reintroduce ANSI reset injection

- **Where:** `packages/pi-agents/src/render.ts` truncated summary/activity lines.
- **Issue:** Reviewer reports raw `truncateToWidth()` can restore a known `\x1b[0m` injection that clears parent tool-result background; prior reset-stripping helper/test may have been removed.
- **Next step:** Confirm against current render helpers and parent TUI contract; restore reset-stripping if still needed and re-add the regression.

## Validation Baseline At Pause

Recorded by remediation work before pause (not re-run in this note):

| Gate | Last reported result |
| --- | --- |
| Focused suite (incl. resume/worktree) | 685 pass / 0 fail |
| `mise run typecheck --package packages/pi-agents` | pass |
| `mise run test --package packages/pi-agents` | 1020 pass / 0 fail |
| `hk check` | pass |
| `mise run build --package packages/pi-agents` | pass |
| `git diff --check` | pass |

## Suggested Next Session Order

1. Close **C3** first if memory bounds remain the primary goal.
2. Close **C1** + **C2** before relying on durable resume of untrusted/hand-edited records.
3. Then **W1** and **W2**.
4. Re-run full package suite + independent review against this list.

## Explicitly Out Of Scope Here

- `packages/pi-lsp` findings from earlier mixed reviews.
- New public memory configuration.
- Durable schema Version 2.
- Optional reduced-heap soak unless requested.
