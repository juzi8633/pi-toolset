# Completion Check Output Relay Implementation Plan

**Goal:** Preserve and return an agent's final output when `completionCheck` fails while clearly warning the parent model that the output did not satisfy the configured completion contract.

**Inputs:** User requirement from 2026-07-14; current `completionCheck` implementation in `packages/pi-agents/src/completion-check.ts`; failure formatting in `packages/pi-agents/src/output.ts`, `packages/pi-agents/src/tool.ts`, and `packages/pi-agents/src/chain.ts`; existing coverage in `packages/pi-agents/tests/completion-check.test.ts`.

**Assumptions:**

- A failed completion check remains a failed result (`status: "failed"`, `stopReason: "completion_check"`, non-zero exit code, and `isError: true`); only the parent-visible text changes.
- The warning must precede the preserved agent output so the parent model cannot mistake unchecked content for a validated result.
- Runtime, transport, cancellation, and non-`completion_check` failure formatting remain unchanged.

**Architecture:** Keep validation and failure classification unchanged. Special-case `completion_check` in the shared result-output formatter so single, parallel, and chain consumers all receive one consistent warning followed by the agent's final text, without duplicating logic across execution modes.

**Tech Stack:** TypeScript, Bun test runner, mise task runner, ESLint/Prettier through hk.

---

## File Map

- Modify: `packages/pi-agents/src/output.ts` — format failed completion-check results as a warning followed by preserved final output.
- Test: `packages/pi-agents/tests/completion-check.test.ts` — verify warning text, failure reason, original output preservation, and ordering.
- Modify: `packages/pi-agents/docs/explanation.md` — explain that a failed completion check still relays the unchecked output.
- Modify: `packages/pi-agents/docs/reference.md` — document the parent-visible behavior of `completion_check` failures.
- Modify if the configuration is already surfaced there: `packages/pi-agents/README.md` — keep user-facing completion-check behavior aligned with the implementation.

## Tasks

### Task 1: Preserve Failed Completion Output

**Outcome:** Every consumer of `getResultOutput` receives an explicit completion-check warning followed by the agent's original final output, while all other failure types retain their current formatting.

**Files:**

- Modify: `packages/pi-agents/src/output.ts`

**Steps:**

- [ ] Add a narrow `result.stopReason === "completion_check"` branch before the generic failed-result fallback.
- [ ] Build the message from the existing `errorMessage` and final assistant output; put the warning before the output and label the following text as unchecked agent output.
- [ ] Use the existing no-output fallback when the child produced no final assistant text.
- [ ] Leave `isFailedResult`, status resolution, exit codes, and generic error precedence unchanged.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript exits successfully with no new diagnostics.

### Task 2: Lock the Relay Contract with Tests

**Outcome:** Automated coverage proves that completion-check failures preserve child output and remain visibly marked as failures.

**Files:**

- Test: `packages/pi-agents/tests/completion-check.test.ts`

**Steps:**

- [ ] Extend the existing completion-check failure fixture through `getResultOutput`.
- [ ] Assert that the formatted text identifies the failed `completionCheck` and includes the missing-heading reason.
- [ ] Assert that the original final assistant output is present and appears after the warning.
- [ ] Add or retain an assertion showing the result remains `status: "failed"` with `stopReason: "completion_check"` and exit code `1`.
- [ ] Confirm an unrelated failure still uses the existing generic error-message precedence if current nearby coverage does not already guarantee it.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/completion-check.test.ts`
- Expected: All focused completion-check tests pass.

### Task 3: Document the Changed Failure Semantics

**Outcome:** User-facing documentation states that completion-check failure marks output as unchecked but does not hide it from the parent model.

**Files:**

- Modify: `packages/pi-agents/docs/explanation.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify if applicable: `packages/pi-agents/README.md`

**Steps:**

- [ ] Update the completion-check explanation to distinguish validation failure from output suppression.
- [ ] Update the `completion_check` reference entry to state that the warning and original final output are both returned.
- [ ] Add the same concise behavioral note to the README only if that file already presents completion-check configuration or failure behavior; do not create an unrelated new documentation section.

**Validation:**

- Run: `hk check`
- Expected: Repository lint and formatting checks pass.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: The full `pi-agents` test suite passes.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript type checking passes.
- Run: `hk check`
- Expected: ESLint and Prettier checks pass repository-wide.
- Inspect: completion-check failures remain failed in tool details while parent-visible content contains the warning before the preserved child output.

## Rollout Notes

- No migration or configuration change is required.
- Existing callers that inspect `status`, `stopReason`, `exitCode`, or `isError` continue to observe a failure.
- Callers that display `getResultOutput` will now expose the unchecked child text for `completion_check` failures.

## Risks and Mitigations

- Unchecked agent text could be mistaken for validated output — place an explicit warning and failure reason before a clearly introduced output block.
- A broad formatter change could alter unrelated errors — guard only on `stopReason === "completion_check"` and retain the generic fallback unchanged.
- Single, parallel, and chain modes could drift — implement through their shared `getResultOutput` helper and test the common contract.
