# How-to guides

Practical recipes for specific tasks. Each guide assumes you have [built and
loaded the extension](./tutorials.md#1-build-and-load-the-extension).

## Trigger agents with natural language

You don't have to write JSON - describe the delegation in plain language and Pi
calls the `agent` tool for you. Name the agent (and optionally inline per-call
overrides); the rest of the sentence becomes the task.

**Implement a plan with the worker agent:**

> Use the worker agent to implement the plan.

Pi invokes `worker` in single mode with your task.

**Implement a plan with the worker agent on the Grok ACP runtime:**

> Use the worker agent (runtime: grok-acp, model: grok-4.5, thinking: high) to
> implement the plan.

Pi passes `runtime`, `model`, and `thinking` as per-call overrides, so the
worker runs on Grok ACP with the `grok-4.5` model and `high` thinking for this
call only - the agent's own config is untouched. See
[Per-invocation overrides](./reference.md#per-invocation-overrides).

Natural-language triggers work in any language; what matters is naming the
agent and, optionally, the override fields.

## Run agents in parallel

Pass multiple `{ agent, task }` items under `tasks`:

```json
{
  "tasks": [
    { "agent": "explore", "task": "Find all model definitions." },
    { "agent": "explore", "task": "Find all provider implementations." }
  ]
}
```

Up to 8 tasks run concurrently, 4 at a time. Each task's final output returns to
the parent model, capped at 50 KB.

## Chain agents with template placeholders

```json
{
  "chain": [
    { "agent": "explore", "name": "context", "task": "Find auth-related code." },
    { "agent": "planner", "name": "plan", "task": "Plan changes for {previous}." },
    { "agent": "worker", "task": "Implement {outputs.plan}." }
  ]
}
```

- `{previous}` expands to the immediately preceding step's final output.
- `{outputs.<name>}` expands to any earlier step you named via `name`.
- A reference to a name that was not declared or did not run stops the chain with
  `stopReason: "template_error"` and `Unknown chain output: <name>`.

## Extract structured JSON from a chain step

Add an `outputSchema` to demand a JSON final message. The orchestrator appends a
JSON-only contract, parses the output, validates it, and exposes the value to
later steps:

```json
{
  "chain": [
    {
      "agent": "explore",
      "name": "context",
      "task": "List code files relevant to auth.",
      "outputSchema": {
        "type": "object",
        "required": ["files"],
        "properties": { "files": { "type": "array", "items": { "type": "string" } } }
      }
    },
    { "agent": "planner", "task": "Plan changes for {outputs.context}." }
  ]
}
```

The schema supports a JSON Schema subset: `type`, `properties`, `required`,
`items`, `enum`, `additionalProperties`, `minItems`, `maxItems`. `integer`
requires `Number.isInteger`. A parse or validation failure stops the chain with
`stopReason: "structured_output_error"`. When a step has both `name` and
`outputSchema`, the parsed value is also available on
`details.outputs[name].structured`.

## Run a dynamic fanout

Expand an array from a prior structured output into one parallel task per item:

```json
{
  "chain": [
    {
      "agent": "explore",
      "name": "context",
      "task": "Return files to process.",
      "outputSchema": {
        "type": "object",
        "required": ["items"],
        "properties": { "items": { "type": "array", "items": { "type": "string" } } }
      }
    },
    {
      "expand": { "from": { "output": "context", "path": "/items" } },
      "parallel": { "agent": "worker", "task": "Process {item}" },
      "collect": { "name": "results" }
    }
  ]
}
```

`expand.from.output` names a prior step; `path` is a JSON Pointer into its
structured output. `parallel.task` is rendered with `{item}` per entry, and
results are stored under `collect.name`. If `parallel.outputSchema` is set, each
worker is parsed and validated; the collected `structured` is an array of each
worker's `structuredOutput` (or its final text when absent). Fanout is capped by
`MAX_FANOUT_ITEMS` (8) and concurrency by `MAX_CONCURRENCY` (4).

## Isolate an agent in a git worktree

Set `isolation: "worktree"` so the child runs in a throw-away worktree under
`<repo>/.worktrees/`:

```json
{ "agent": "worker", "task": "Refactor the session store.", "isolation": "worktree" }
```

The tool runs `git worktree add --detach <path> HEAD`, executes the child with
that directory as `cwd`, then inspects `git status --porcelain` after it exits:

- **Clean** - the worktree is removed (path-guarded: only paths under
  `<repo>/.worktrees/` are deleted).
- **Dirty** - the worktree is kept and the absolute path is surfaced as
  `worktreePath` plus `worktreeDirty: true`.

Requires a git repo; otherwise the call fails with
`stopReason: "isolation_error"`. For chain and parallel modes, set `isolation`
per item (the top-level value only applies in single mode).

Run a setup command before the child starts with `worktreeSetupHook` in the
agent definition (e.g. `bun install`). A non-zero exit stops the step with
`stopReason: "worktree_setup_error"`.

## Restrict an agent's tools and skills

In an agent definition, allowlist tools with `tools` and denylist with
`excludeTools` (applied after the allowlist):

```markdown
---
name: safe-reviewer
description: Read-only reviewer
tools: read, grep, find, ls, bash
excludeTools: edit, write, agent
---
```

Restrict skills by name with `skills` - the child runs with `--no-skills` plus
one `--skill <path>` per resolved name, loading only those skills:

```markdown
---
name: my-agent
description: Only load these skills
skills: librarian, code-reviewer
---
```

Unresolvable names fail the step before spawn with `stopReason: "skill_error"`.

## Override an agent's config without editing source

Put a `config.json` in the Pi user or project config directory:

- User: `~/.pi/agent/@balaenis/pi-agents/config.json`
- Project: `<repo>/.pi/@balaenis/pi-agents/config.json`

```json
{
  "agents": {
    "explore": { "model": "gpt-5", "thinking": "high" },
    "@balaenis/pi-agents.reviewer": { "model": "claude-sonnet-4.5" }
  }
}
```

Project overrides user overrides frontmatter, field-level. Key is the full
catalogue name (package agents are namespaced as `<packageName>.<localName>`).
`name`, `systemPrompt`, `source`, and `filePath` are not overridable.

## Invoke agents via slash commands

Bypass the model and run a discovered agent directly:

```
/agent list
/agent:explore find all authentication code
/agent:@balaenis/pi-agents.reviewer review the recent changes
```

- `/agent list` enumerates every discovered agent (builtin, user, project,
  package) with source and description.
- `/agent:<name> <task...>` invokes a specific agent; `<name>` is the full
  catalogue name (package agents are namespaced, e.g.
  `@acme/pi-frontend.reviewer`).
- `/agent` only accepts the `list` subcommand. To invoke an agent, use the
  `/agent:<name>` form.

Slash invocations run in the foreground with live progress, then report the
final output via `ctx.ui.notify`. The per-agent `/agent:<name>` commands are
registered at extension load; add or remove agent files and run `pi reload` (or
restart) to refresh them.

## Run an agent in the background

Set `runInBackground: true` for long-running, independent work whose result the
parent does not need immediately:

```json
{
  "agent": "worker",
  "task": "Run the full test suite and report failures.",
  "runInBackground": true
}
```

The tool returns immediately with an `agent-bg-*` job id. On completion or
failure, a follow-up message (`customType:
pi-agents-background-result`) triggers a new turn. Cancelled jobs emit the same
message type but do not re-enter the model. At most four background jobs may be
in flight per session; the parent abort signal (Ctrl+C) does not cancel a
launched background job. Background mode is rejected in `json` and `print` host
modes.

## Use the Grok runtime

Set `runtime: "grok"` to spawn the [Grok Build CLI](https://docs.x.ai/build/cli)
(`grok -p --output-format streaming-json`) instead of `pi`:

```markdown
---
name: grok-reviewer
description: Code review powered by Grok
runtime: grok
model: grok-4.5
thinking: high
maxTurns: 10
systemPromptMode: append
---
```

Prerequisites: install the Grok CLI and authenticate with `grok login` or set
`XAI_API_KEY`. See [Explanation: Grok streaming-json vs ACP](./explanation.md#grok-streaming-json-vs-acp)
for caveats (no usage stats, no tool-call visibility, skills are no-ops, fork
context ignored).

## Use the Grok ACP runtime

Set `runtime: "grok-acp"` to speak the [Agent Client Protocol](https://agentclientprotocol.com)
over stdio (`grok agent … stdio`), which gives structured tool calls, usage, and
ACP cancellation:

```json
{ "agent": "worker", "task": "Read package.json and summarize scripts.", "runtime": "grok-acp" }
```

`maxTurns` is accepted at the config layer but ignored by `grok-acp`. See
[Explanation: Grok streaming-json vs ACP](./explanation.md#grok-streaming-json-vs-acp)
for the field mapping.

The bundled `/work-with-grok <task>` prompt is a shortcut for this: it
delegates the task to the `worker` agent with `runtime: "grok-acp"`,
`model: "grok-4.5"`, `thinking: "high"`.

## Use the bundled workflow prompts

The package ships three workflow prompts, available as slash commands:

| Prompt                          | Flow                         |
| ------------------------------- | ---------------------------- |
| `/implement <query>`            | explore -> planner -> worker |
| `/explore-and-plan <query>`     | explore -> planner           |
| `/implement-and-review <query>` | worker -> reviewer -> worker |

Each prompt instructs Pi to run a chain with named steps. The worker steps
require the final output to include `## Completed`, `## Files Changed`, and
`## Validation`. The reviewer step classifies findings under `## Critical (must
fix)`, `## Warnings (should fix)`, and `## Suggestions (consider)`, writing
`- None.` under Critical when empty.
