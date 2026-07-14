---
description: General implements, reviewer reviews, general applies feedback
---

Use the `agent` tool with the chain parameter to execute this workflow:

1. First, use the "general" agent (named `implementation`) to implement: $@. Output must include `## Completed`, `## Files Changed`, and `## Validation`.
2. Then, use the "reviewer" agent (named `review`) to review `{outputs.implementation}` and classify findings under `## Critical (must fix)`, `## Warnings (should fix)`, and `## Suggestions (consider)`. When the Critical section is empty, the reviewer must write `## Critical (must fix)\n- None.`
3. Finally, use the "general" agent to address `{outputs.review}`. The general agent must:
   - Treat a Critical section consisting of exactly `- None.` as “no critical items” and proceed without manufacturing fixes.
   - Otherwise, resolve every item under `## Critical (must fix)` and explicitly report each fix.
   - Report any remaining `## Warnings (should fix)` items separately (fix or justify deferral).
   - If any Critical item cannot be fixed safely, stop and report the blocker instead of pretending completion.
   - End with `## Completed`, `## Files Changed`, and `## Validation`.

Execute as a chain. Name each step so later steps can reference earlier outputs via `{outputs.<name>}`.
