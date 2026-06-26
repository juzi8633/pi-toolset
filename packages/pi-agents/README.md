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
Use a chain: first have explore find the read tool, then have planner suggest improvements
```

### Workflow prompts

```
/implement add Redis caching to the session store
/explore-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode     | Parameter          | Description                                            |
| -------- | ------------------ | ------------------------------------------------------ |
| Single   | `{ agent, task }`  | One agent, one task                                    |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain    | `{ chain: [...] }` | Sequential with `{previous}` placeholder               |

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

| Field              | Type                  | Default               | Description                                                                                                               |
| ------------------ | --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `name`             | string                | (required)            | Agent identifier used by the `agent` tool.                                                                                |
| `description`      | string                | (required)            | Shown to the parent model in the agent catalogue.                                                                         |
| `tools`            | comma list            | inherit all           | Allowlist passed to `pi --tools`.                                                                                         |
| `excludeTools`     | comma list            | none                  | Denylist passed to `pi --exclude-tools` (applied after the allowlist).                                                    |
| `model`            | string                | host default          | Forwarded as `pi --model`.                                                                                                |
| `thinking`         | string                | host default          | Forwarded as `pi --thinking`.                                                                                             |
| `systemPromptMode` | `append` \| `replace` | `append`              | `replace` swaps the host system prompt with the agent body via `--system-prompt`; `append` uses `--append-system-prompt`. |
| `maxTurns`         | positive integer      | unbounded             | Maximum assistant turns; the child is terminated when exceeded.                                                           |
| `noContextFiles`   | boolean               | `false`               | When `true`, runs the child with `--no-context-files`.                                                                    |
| `noSkills`         | boolean               | `false`               | When `true`, runs the child with `--no-skills`.                                                                           |
| `defaultContext`   | `fresh` \| `fork`     | `fresh`               | `fork` branches the parent session; `fresh` runs in `--no-session`.                                                       |
| `isolation`        | `none` \| `worktree`  | `none`                | When `worktree`, the child runs in an isolated git worktree.                                                              |
| `completionGuard`  | boolean               | inferred from `tools` | When enabled, the final message must include `## Completed`, `## Files Changed`, and `## Validation`.                     |

Invalid values (unknown enums, non-positive integers, non-boolean strings) are ignored and fall back to the default (`append`, `fresh`, `none`) for enum fields and to `undefined` for boolean / numeric fields.

> Frontmatter fields are parsed and exposed on every `AgentConfig` today. Runtime effects for `systemPromptMode`, `maxTurns`, `noContextFiles`, `noSkills`, `defaultContext`, `isolation`, and `completionGuard` land in later tasks; until then they only show up on the config object and have no observable behavior change.

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

| Prompt                          | Flow                       |
| ------------------------------- | -------------------------- |
| `/implement <query>`            | explore → planner → worker |
| `/explore-and-plan <query>`     | explore → planner          |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: user abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: stops at the first failing step and reports which step failed

## Limitations

- Output truncated to the last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
