---
description: Full implementation workflow - explore gathers context, planner creates plan, general implements
---

Use the `agent` tool with the chain parameter to execute this workflow:

1. First, use the "explore" agent (named `context`) to find all code relevant to: $@
2. Then, use the "planner" agent (named `plan`) to create an implementation plan for "$@" using `{previous}` for the explore output.
3. Finally, use the "general" agent to implement `{outputs.plan}`.

Execute as a chain. Name each step so later steps can reference earlier outputs via `{outputs.<name>}`. The general agent's final output **must** include `## Completed`, `## Files Changed`, and `## Validation` (commands run + pass/fail, or `Not run: <reason>`).
