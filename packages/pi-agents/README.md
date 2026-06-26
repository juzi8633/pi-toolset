# @balaenis/pi-agents

Delegate tasks to specialized subagents from [Pi](https://github.com/earendil-works/pi). Each invocation spawns an isolated `pi` subprocess with its own context window, then streams structured updates back into the parent session.

## Features

- **Isolated context** — every subagent runs in a fresh `pi` process
- **Streaming output** — tool calls and progress arrive live
- **Three execution modes** — single, parallel (max 8, 4 concurrent), and chained
- **Markdown rendering** — final output is rendered with proper formatting in the expanded view
- **Usage tracking** — turns, tokens, cost, and context shown per agent
- **Abort support** — Ctrl+C propagates and kills active subprocesses

## Installation

Install the package (once published):

```sh
pi install npm:@balaenis/pi-agents
```

For local development, build the package and load it with `-e`:

```sh
mise run build --package packages/subagent
pi -e ./packages/subagent/dist/index.js
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

### Tool Permissions

Agent permissions are expressed with two frontmatter fields that map directly onto the Pi CLI:

- `tools` → `--tools <list>` (allowlist; omit to inherit every tool the host exposes)
- `excludeTools` → `--exclude-tools <list>` (denylist; applied after the allowlist)

The child `pi` process receives the merged flags exactly as the parent would. Tool names are passed through after trimming and lower-cased only when the agent author writes them that way.

### Nested Agents and Depth Guard

Each spawned child carries `PI_AGENT_CHILD=1` and `PI_AGENT_DEPTH=<n>` in its environment. The tool refuses to start a new child when `PI_AGENT_DEPTH >= PI_AGENT_MAX_DEPTH` (default `2`).

The max depth can be raised by exporting `PI_AGENT_MAX_DEPTH` before launching `pi`. Anything past depth `2` will lift the chance of runaway fan-out, so raise it carefully.

## Usage

### Single agent

```
Use explore to find all authentication code
```

### Parallel execution

```
Run 2 explores in parallel: one to find models, one to find providers
```

### Chained workflow

```
Use a chain:
  - { agent: explore, name: context, task: "find the read tool" }
  - { agent: planner, name: plan, task: "suggest improvements using {previous}" }
  - { agent: worker,                  task: "implement {outputs.plan}" }
```

Each step's text may reference `{previous}` (the immediately preceding step's final output) or `{outputs.<name>}` (any earlier step named via the optional `name` field). A reference to an unknown name stops the chain before spawning the step and returns `Unknown chain output: <name>` with `stopReason: 'template_error'`.

### Workflow prompts

```
/implement add Redis caching to the session store
/explore-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode     | Parameter          | Description                                                      |
| -------- | ------------------ | ---------------------------------------------------------------- |
| Single   | `{ agent, task }`  | One agent, one task                                              |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent)           |
| Chain    | `{ chain: [...] }` | Sequential with `{previous}` and `{outputs.<name>}` placeholders |

## Output Display

**Collapsed view** (default):

- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):

- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:

- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):

- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
excludeTools: write, edit
model: claude-haiku-4-5
systemPromptMode: append
maxTurns: 8
noContextFiles: false
noSkills: false
defaultContext: fresh
isolation: none
completionGuard: false
---

System prompt for the agent goes here.
```

### Frontmatter Fields

| Field              | Type                  | Default               | Description                                                                                                                                                                                                                                                                                          |
| ------------------ | --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | string                | (required)            | Agent identifier used by the `agent` tool.                                                                                                                                                                                                                                                           |
| `description`      | string                | (required)            | Shown to the parent model in the agent catalogue.                                                                                                                                                                                                                                                    |
| `tools`            | comma list            | inherit all           | Allowlist passed to `pi --tools`.                                                                                                                                                                                                                                                                    |
| `excludeTools`     | comma list            | none                  | Denylist passed to `pi --exclude-tools` (applied after the allowlist).                                                                                                                                                                                                                               |
| `model`            | string                | host default          | Forwarded as `pi --model`.                                                                                                                                                                                                                                                                           |
| `thinking`         | string                | host default          | Forwarded as `pi --thinking`.                                                                                                                                                                                                                                                                        |
| `systemPromptMode` | `append` \| `replace` | `append`              | `replace` swaps the host system prompt with the agent body via `--system-prompt`; `append` uses `--append-system-prompt`.                                                                                                                                                                            |
| `maxTurns`         | positive integer      | unbounded             | Maximum assistant turns; the child is `SIGTERM`'d when exceeded and the result is marked with `stopReason: max_turns`.                                                                                                                                                                               |
| `noContextFiles`   | boolean               | `false`               | When `true`, runs the child with `--no-context-files`.                                                                                                                                                                                                                                               |
| `noSkills`         | boolean               | `false`               | When `true`, runs the child with `--no-skills`.                                                                                                                                                                                                                                                      |
| `defaultContext`   | `fresh` \| `fork`     | `fresh`               | `fork` branches the parent session via `SessionManager.createBranchedSession(getLeafId())` and runs the child with `--session <branched-file>`; `fresh` runs with `--no-session`. Requires a persisted parent session for `fork`.                                                                    |
| `isolation`        | `none` \| `worktree`  | `none`                | When `worktree`, the child runs in `<repo>/.worktrees/pi-agent-<safe-name>-<timestamp>-<index>/` created by `git worktree add --detach HEAD`. Clean worktrees are removed after the child exits; dirty worktrees are kept and reported on `SingleResult.worktreePath`.                               |
| `completionGuard`  | boolean               | inferred from `tools` | When enabled, the final assistant message must include `## Completed`, `## Files Changed`, and `## Validation`; otherwise the result is marked `stopReason: completion_guard` with exit code `1`. Default: enabled when the agent's tools include `edit`, `write`, or `bash` (after `excludeTools`). |

Invalid values (unknown enums, non-positive integers, non-boolean strings) are ignored and fall back to the default (`append`, `fresh`, `none`) for enum fields and to `undefined` for boolean / numeric fields.

> Runtime behavior currently wired up: `tools`, `excludeTools`, `model`, `thinking`, `systemPromptMode`, `maxTurns`, `noContextFiles`, `noSkills`, `defaultContext`, `isolation`, `completionGuard`. Every frontmatter field is now active.

### Completion Guard

Agents that can mutate the workspace must produce a structured handoff so the parent model and downstream chain steps can validate the change. The guard:

- Considers an agent mutating when `tools` is undefined (inherit all) or when `tools` includes `edit`, `write`, or `bash` after applying `excludeTools`.
- Defaults `completionGuard` to that inferred value; set `completionGuard: false` to opt out (used by the bundled `reviewer` agent), or `completionGuard: true` to enforce on read-only agents.
- Inspects the final assistant message for top-level headings `## Completed`, `## Files Changed`, and `## Validation` (case-insensitive, line-anchored).
- On failure, sets `stopReason: 'completion_guard'`, fills `errorMessage` with the missing headings, and forces exit code `1`. Failures propagate the same way other agent failures do (single-mode returns `isError`, chain-mode stops at the failing step).

The bundled `worker.md` template already follows the required shape; the `## Validation` section asks for the commands actually run plus their pass/fail status (or an explicit `Not run: <reason>`).

### Isolation: Git Worktree

When `isolation: worktree` is set on an agent (or `isolation: 'worktree'` is passed per task/chain/single), the tool:

1. Resolves the repo root via `git rev-parse --show-toplevel`. If the agent is not inside a git repo, the call fails with `stopReason: 'isolation_error'` and `stderr: 'Worktree isolation requires a git repository.'`
2. Creates `<repo>/.worktrees/pi-agent-<safe-name>-<timestamp>-<index>-<rand>` via `git worktree add --detach <path> HEAD` and runs the child `pi` with that directory as `cwd`. The random suffix avoids collisions when concurrent invocations happen in the same millisecond.
3. After the child exits (or throws / aborts), runs `git status --porcelain` in the worktree.
   - **Clean**: `git worktree remove --force` plus a recursive delete clean it up. Removal is path-guarded — worktrees outside `<repo>/.worktrees/` are never deleted.
   - **Dirty**: the worktree is left in place and the absolute path is surfaced as `worktreePath` plus `worktreeDirty: true` on the result.
   - **Status check failed**: the worktree is treated as dirty for safety, retained, and `stderr` records the failure.
4. On abort or unhandled error, the helper still attempts a status check; only verifiably clean worktrees are deleted, dirty/unknown ones are kept for inspection.

Task-level `isolation` (in `chain[]`, `tasks[]`, or single-mode params) overrides the agent's frontmatter value. The top-level `isolation` parameter only applies in single mode; per-item `isolation` is required for chain and parallel modes.

### Fork Context

When an agent declares `defaultContext: fork`, the tool:

1. Reads the parent session's leaf id and session file from `ctx.sessionManager`.
2. Opens that file with `SessionManager.open()` and calls `createBranchedSession(leafId)` to materialize a new session file containing only the path to the current leaf.
3. Spawns the child `pi` with `--session <branched-file>` (the parent's session file is never passed directly).

Fork mode returns an error result with `stopReason: context_error` and one of these `stderr` messages when prerequisites are missing:

- `Cannot fork parent context: parent session is not persisted` — the parent ran with `--no-session`, or `createBranchedSession` returned undefined.
- `Cannot fork parent context: parent session file does not exist: <path>` — the recorded session file is gone from disk.
- `Cannot fork parent context: current session has no leaf entry` — the session has no current leaf to fork from.

In `--no-session` parent runs, `fork` does **not** silently fall back to fresh context.

**Locations:**

- `~/.pi/agent/agents/*.md` — user-level (always loaded)
- `.pi/agents/*.md` — project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Bundled Agents

| Agent      | Purpose              | Tools                                            |
| ---------- | -------------------- | ------------------------------------------------ |
| `explore`  | Fast codebase recon  | read, grep, find, ls, bash                       |
| `planner`  | Implementation plans | read, grep, find, ls                             |
| `reviewer` | Code review          | read, grep, find, ls, bash (no edit/write/agent) |
| `worker`   | General-purpose      | (all default)                                    |

## Workflow Prompts

| Prompt                          | Flow                       | Acceptance contract                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/implement <query>`            | explore → planner → worker | Steps named `context`, `plan`, and the worker references `{outputs.plan}`. Worker must end with `## Completed`, `## Files Changed`, and `## Validation` (commands run + pass/fail, or `Not run: <reason>`).                                                                            |
| `/explore-and-plan <query>`     | explore → planner          | Steps named `context` and `plan`. Plan-only; no file changes; no worker invocation.                                                                                                                                                                                                    |
| `/implement-and-review <query>` | worker → reviewer → worker | Steps named `implementation` and `review`. Reviewer must emit `## Critical (must fix)\n- None.` when empty. Final worker resolves every Critical item, reports remaining Warnings, and stops with the blocker if any Critical cannot be fixed safely instead of pretending completion. |

## Error Handling

- **Exit code != 0**: tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: user abort (Ctrl+C) kills subprocess, throws error
- **stopReason "max_turns"**: an agent exceeded its `maxTurns` budget; the child is `SIGTERM`'d
- **stopReason "context_error"**: fork-context preparation failed before the child started (see _Fork Context_)
- **stopReason "isolation_error"**: worktree isolation failed before the child started (see _Isolation: Git Worktree_)
- **stopReason "completion_guard"**: a mutating agent's final message is missing one of `## Completed`, `## Files Changed`, or `## Validation` (see _Completion Guard_)
- **stopReason "template_error"**: a chain step's task referenced `{outputs.<name>}` for a step that did not run or was not named
- **Chain mode**: stops at the first failing step and reports which step failed

## Limitations

- Output truncated to the last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
