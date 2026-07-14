---
description: Explore gathers context, planner creates implementation plan (no implementation)
---

Use the `agent` tool with the chain parameter to execute this workflow:

1. First, use the "explore" agent (named `context`) to find all code relevant to: $@
2. Then, use the "planner" agent (named `plan`) to create an implementation plan for "$@" using `{previous}` for the explore output.

Execute as a chain. Do NOT modify any files and do NOT invoke the general agent — return only the plan from step 2.
