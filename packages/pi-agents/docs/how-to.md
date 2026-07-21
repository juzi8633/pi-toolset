# How-to guides

Practical recipes for specific tasks. Each guide assumes you have [built and
loaded the extension](./tutorials.md#1-build-and-load-the-extension).

## Trigger agents with natural language

You don't have to write JSON - describe the delegation in plain language and Pi
calls the `agent` tool for you. Name the agent (and optionally inline per-call
overrides); the rest of the sentence becomes the task.

**Implement a plan with the general agent:**

> Use the general agent to implement the plan.

Pi invokes `general` in single mode with your task.

**Implement a plan with the general agent on the Grok ACP runtime:**

> Use the general agent (runtime: grok-acp, model: grok-4.5, thinking: high) to
> implement the plan.

Pi passes `runtime`, `model`, and `thinking` as per-call overrides, so the
general agent runs on Grok ACP with the `grok-4.5` model and `high` thinking for this
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

## Give a step a short collapse title

Add a `title` (aim for ~30 characters; not a hard limit) to any single call,
parallel task, chain step, or fanout `parallel` block. The collapsed summary
shows the title instead of the task text; both are clamped to 30 terminal
columns. The expanded view still shows the complete task.

```json
{
  "tasks": [
    { "agent": "explore", "task": "Find all model definitions.", "title": "models" },
    { "agent": "explore", "task": "Find all provider implementations.", "title": "providers" }
  ]
}
```

```json
{
  "chain": [
    { "agent": "explore", "name": "context", "task": "Find auth code.", "title": "查认证" },
    { "agent": "planner", "name": "plan", "task": "Plan changes for {previous}.", "title": "计划" },
    {
      "expand": { "from": { "output": "plan", "path": "/items" } },
      "parallel": { "agent": "general", "task": "Process {item}", "title": "处理项" },
      "collect": { "name": "results" }
    }
  ]
}
```

Generate the title before the call and keep it concise. Length is guidance only —
longer titles still run and are clamped at render time. When omitted or blank,
the task text is used (also clamped to 30 columns). Background launches use the
first item's title as the launch summary.

## Chain agents with template placeholders

```json
{
  "chain": [
    { "agent": "explore", "name": "context", "task": "Find auth-related code." },
    { "agent": "planner", "name": "plan", "task": "Plan changes for {previous}." },
    { "agent": "general", "task": "Implement {outputs.plan}." }
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
      "parallel": { "agent": "general", "task": "Process {item}" },
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

Before any fanout worker starts, the scheduled item list (after `maxItems`) is
persisted as a durable expansion. Resume always uses that stored list; it does
not re-read the source step's current output.

## Resume an interrupted fanout

When a chain with a dynamic fanout is aborted or interrupted mid-step, completed
items stay completed and only incomplete items run again.

1. List runs and find the interrupted run (or read `runId` from a prior
   `agent` result):

   ```
   /agent runs
   ```

2. Inspect status and incomplete units:

   ```
   /agent status <run-id>
   ```

   Expect one unit per scheduled fanout item (for example
   `chain-0002-fanout-0001` …), not a single shared fanout placeholder.

3. Resume through the `agent` tool (stored workflow is authoritative):

   ```
   agent({ runId: "<run-id>" })
   agent({ runId: "<run-id>", task: "Also verify the remaining items." })
   ```

   Optional `task` appends a continuation instruction to every incomplete unit
   after placeholder/`{item}` resolution. Completed item results and original
   indexes are retained. Interrupted Pi and Grok ACP items continue their native
   sessions; never-started Pi/Grok ACP items receive the original resolved task
   plus all durable continuation instructions. Never-started items keep attempt
   `1`. Collection order remains the original expansion order.

### Blocking errors

If resume is refused, the blocking reason explains what to do:

| Reason prefix                     | Meaning                                                                 | What to do                                      |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `stored_fanout_state_unavailable` | Incomplete fanout work without a valid persisted expansion mapping      | Start a fresh chain; do not force-replay legacy |
| `stored_output_invalid`           | A completed child unit is missing a valid terminal result               | Start a fresh chain; completed output is unsafe |
| `fanout_state_conflict`           | A concurrent or conflicting expansion write tried to change the mapping | Rare; inspect the run and retry or re-invoke    |
| fingerprint / session / worktree  | Agent definition or artifacts changed or went missing                   | Restore the agent/session/worktree, then resume |
| `acp_session_unavailable`         | Attempted Grok ACP unit has no stored protocol session ID               | Not resumable; start a fresh run                |

Unsafe legacy partial fanouts (item results or unit fragments without a stored
`workflowState.fanouts` mapping) are never reconstructed automatically. Re-run
the chain from a new invocation.

## Isolate an agent in a git worktree

Set `isolation: "worktree"` so the child runs in a throw-away worktree under
`<repo>/.worktrees/`:

```json
{ "agent": "general", "task": "Refactor the session store.", "isolation": "worktree" }
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

## Edit agent config interactively (TUI)

Use `/agent config` (optional agent name) in TUI mode:

```
/agent config
/agent config explore
```

1. Select an agent from the discovered catalogue.
2. Edit fields; each row shows the effective value and a layer badge
   (`frontmatter` / `user` / `project` / `session`).
3. Edits apply immediately as **session overrides** (new launches only).
4. `Ctrl+D` unsets the selected field: effective value falls back to the agent
   `.md` frontmatter / built-in default **even if user or project config still
   has the key**. `Ctrl+S` / `Ctrl+P` then deletes that key from the
   corresponding `config.json`.
5. `Ctrl+S` writes **session fields of the current agent** to user
   `~/.pi/agent/@balaenis/pi-agents/config.json` (and applies pending unsets).
6. `Ctrl+P` writes those session fields/unsets to project
   `<repo>/.pi/@balaenis/pi-agents/config.json` (requires project trust).
7. After save, remaining session overrides stay; only unsaved (`*`) marks clear.
   Restart/restore keeps session fields saveable without re-editing them.

Session overrides persist on the host session branch as custom entry type
`pi-agents-agent-config` (version 1), so they survive `/tree` navigation within
the same branch. Disk `config.json` files remain manually editable.

`systemPrompt` is not editable here. Non-TUI modes notify that the editor is
TUI-only.

## Invoke agents via slash commands

Bypass the model and run a discovered agent directly:

```
/agent config
/agent:explore find all authentication code
/agent:@balaenis/pi-agents.reviewer review the recent changes
```

- `/agent config [name]` opens the TUI config editor (browse + session overrides + save).
- `/agent:<name> <task...>` invokes a specific agent; `<name>` is the full
  catalogue name (package agents are namespaced, e.g.
  `@acme/pi-frontend.reviewer`).

Slash invocations run in the foreground with live progress, then report the
final output via `ctx.ui.notify`. The per-agent `/agent:<name>` commands are
registered at extension load; add or remove agent files and run `pi reload` (or
restart) to refresh them.

## Run an agent in the background

Set `runInBackground: true` for long-running, independent work whose result the
parent does not need immediately:

```json
{
  "agent": "general",
  "task": "Run the full test suite and report failures.",
  "runInBackground": true
}
```

The tool returns immediately with an `agent-bg-*` job id. On completion or
failure, a follow-up message (`customType:
pi-agents-background-result`) triggers a new turn. Hosts must not sleep, poll,
or call `agent({ runId })` just to wait — continue other work or end the turn.
Cancelled jobs emit the same message type but do not re-enter the model. At most
four background jobs may be in flight per session; the parent abort signal
(Ctrl+C) does not cancel a launched background job. Background mode is rejected
in `json` and `print` host modes.

## Use the Grok ACP runtime

Set `runtime: "grok-acp"` to speak the [Agent Client Protocol](https://agentclientprotocol.com)
over stdio (`grok agent … stdio`), which gives structured tool calls, usage, and
ACP cancellation:

```json
{ "agent": "general", "task": "Read package.json and summarize scripts.", "runtime": "grok-acp" }
```

`maxTurns` is accepted at the config layer but ignored by `grok-acp`. See
[Explanation: Grok ACP runtime](./explanation.md#grok-acp-runtime)
for the field mapping.

The bundled `/work-with-grok <task>` prompt is a shortcut for this: it
delegates the task to the `general` agent with `runtime: "grok-acp"`,
`model: "grok-4.5"`, `thinking: "high"`.

### Resume and Agent View for Grok ACP

1. Start a durable Grok ACP unit (TUI or otherwise). The protocol session ID is
   persisted to `run.json` as `units.<id>.acpSessionId` before the first prompt.
2. If interrupted, resume with `agent({ runId })`. The client calls `session/load` with the stored ID and original cwd/worktree,
   then sends only the fixed continuation prompt plus undelivered instructions.
3. In TUI, open `/agent view` (or `Ctrl+Alt+Down`). Restored Grok ACP endpoints
   appear as detached metadata; open detail to lazy-hydrate the retained Agent View
   presentation (and raw complete native history when reloadable) via a
   hydrate-only `session/load` (no model prompt).
4. While idle, Enter sends a new prompt on the same ACP session. While starting
   or running, text input is disabled (no steer/follow-up). Ctrl+X cancels the
   current turn via `session/cancel`.
5. Cross-machine restore and recovery after deleting Grok's private session
   storage are unsupported. Linked clean worktrees are retained so Grok can
   still resolve the session cwd.

## Use the bundled workflow prompts

The package ships three workflow prompts, available as slash commands:

| Prompt                          | Flow                           |
| ------------------------------- | ------------------------------ |
| `/implement <query>`            | explore -> planner -> general  |
| `/explore-and-plan <query>`     | explore -> planner             |
| `/implement-and-review <query>` | general -> reviewer -> general |

Each prompt instructs Pi to run a chain with named steps. The general agent steps
must include `## Completed`, `## Files Changed`, and `## Validation` (also
enforced by general's `completionCheck`). Explore output uses
`## Files Retrieved` / `## Key Code` / `## Architecture` / `## Start Here`.
Planner output starts with `# Plan`. The reviewer step classifies findings under
`## Critical (must fix)`, `## Warnings (should fix)`, and
`## Suggestions (consider)`, writing `- None.` under Critical when empty, using
`path:line - [issue] — [why] — [fix or defer]` finding lines, and ending Summary
with `Verdict: Ship` / `Ship with fixes` / `Do not ship`.

## Interactive agent view

In TUI mode, Pi and Grok ACP subagents can be inspected and messaged without switching the host session.

### Open the navigator

While any host turn is running (or idle):

```
/agent view
```

or press `Ctrl+Alt+Down`. Outside TUI (print/JSON), the command is a no-op; RPC hosts may show a warning.

### Select and inspect

1. The list shows linked endpoints ordered by link creation time (full list: running, idle, detached, error, …).
2. Enter or Right on an endpoint opens its detail transcript (last 15 lines by default).
3. In detail, Ctrl+O expands the complete retained/bounded Agent View transcript; Ctrl+O again collapses to the last 15 lines at the tail.
4. Escape or Left returns from detail to the list, or closes the list. In detail, Left only returns when the prompt is empty; otherwise it moves the input cursor.
5. Grok ACP history hydrates lazily on first detail open via `session/load` replay (no model prompt). Raw complete native history is available only for reloadable sessions; non-reloadable omitted history is unrecoverable.

The below-editor chrome (when any agent is `starting`/`running`) shows a `◆ Agents` title and lists only those running endpoints; open `/agent view` for the full set.

### Input by runtime

| Runtime  | Child state             | Enter                                                       | Alt+Enter                               |
| -------- | ----------------------- | ----------------------------------------------------------- | --------------------------------------- |
| Pi       | Running / starting      | Steer (delivered after current tools, before next LLM call) | Queue follow-up after the child settles |
| Pi       | Idle / detached / error | New prompt on the same native session                       | Same as Enter (prompt)                  |
| Grok ACP | Running / starting      | Rejected (`running_input_unsupported`)                      | Rejected (no follow-up queue)           |
| Grok ACP | Idle / detached / error | New prompt after `session/load` reopen when detached        | Same as Enter (prompt only)             |

- Ctrl+X aborts/cancels only the selected child's current turn (Pi abort RPC or Grok ACP `session/cancel`).
- Ctrl+O toggles between the last-15-line preview and the complete retained/bounded Agent View transcript.
- The detail status line shows the durable `runId`. When the run is resumable and the endpoint is not live, it appends `(Ctrl+R resume)`. Ctrl+R closes Agent View and injects a host user message that asks the model to call `agent({ runId })` (no other launch fields).
- After idle, a new message continues the child session without replaying the original task prompt.
- Detached idle children reopen lazily on the next prompt (same session artifact, cwd/worktree, and fingerprint).

### Detach and retention

- Up to four idle children stay attached; excess idle endpoints detach but keep their session identity on disk (Pi session file or Grok ACP protocol ID).
- Linked clean worktrees are retained in Version 1 so reattach keeps a valid cwd (required for Grok session lookup). Clean them up manually when finished.
- `/tree` away from a link hides it from the navigator; navigating back restores the summary without auto-spawning.
- `/reload` and session switch dispose live transports, then restore links on the next session start.

### What does not happen

- The host `SessionManager` is never switched to the child.
- Post-completion interactive messages do not rewrite the completed durable unit result. After a normal completion they stay in the child session only. When the original tool-call activation was interrupted/cancelled, the next view continuation that settles is relayed back to the bound host model as a clearly-marked interactive continuation (once per activation); normal completed agents never relay.
- Child slash commands are rejected; child extension UI dialogs are cancelled.
- Private Grok session files under `~/.grok/sessions` are never parsed or displayed.

## Inspect run artifacts

After a unit spills oversized output, `run.json` carries `finalOutputRef` / `structuredOutputRef`
with `sha256`, `bytes`, and `mediaType`. Resolve the artifact path from the run metadata
(run ID + store root), not from a parent descriptor — parent descriptors are metadata-only,
bounded to 2 KiB, and never contain absolute paths or artifact content.

```sh
# Resolve the store root and derive the canonical digest path:
STORE="$HOME/.pi/agent/@balaenis/pi-agents/runs"
RUN_ID="<run-id>"
SHA="<sha256>"
# Path: <store>/<run-id>/artifacts/sha256/<first-2-chars>/<sha>.<txt|json>
PREFIX="${SHA:0:2}"
FILE="${STORE}/${RUN_ID}/artifacts/sha256/${PREFIX}/${SHA}.json"
jq . "$FILE"
```

## Read a handed-off artifact from a child agent

When a Chain handoff includes a child descriptor, repeat `pi_agents_read_artifact` with `nextOffsetBytes` until `eof: true`:

```
pi_agents_read_artifact({
  "runId": "run-...",
  "sha256": "<digest>",
  "mediaType": "text",
  "offsetBytes": 0
})
# then call again with offsetBytes = details.nextOffsetBytes
```

## Diagnose missing or corrupt artifact refs

| Symptom                                                 | Likely cause                                   | Action                                                                    |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `artifact_missing` / `artifact_corrupt` before dispatch | Tampered, cross-run, or incomplete publication | Do not redispatch completed work; inspect `run.json` and artifact digests |
| `hydrate_error` on settle                               | Session lag/missing after projected shells     | Check the unit `sessionFile`; re-run if the child crashed mid-write       |
| `get_messages_disabled`                                 | Disabled unbounded history RPC                 | Hydrate from `sessionFile` instead                                        |
| `artifact_store_unavailable`                            | Oversized result without durable run store     | Ensure production registration provides `RunStore`                        |
