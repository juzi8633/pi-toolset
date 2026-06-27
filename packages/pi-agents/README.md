# @balaenis/pi-agents

Delegate tasks to specialized subagents from [Pi](https://github.com/earendil-works/pi). Each invocation spawns an isolated `pi` subprocess with its own context window, then streams structured updates back into the parent session.

## Features

- **Isolated context** — every subagent runs in a fresh `pi` process
- **Streaming output** — tool calls and progress arrive live
- **Three execution modes** — single, parallel (max 8, 4 concurrent), and chained
- **Structured chain outputs** — per-step `outputSchema` extracts and validates JSON before passing it forward as `{outputs.<name>}`
- **Dynamic fanout** — chain steps can expand a prior step's array output into parallel subtasks with a collected result
- **Package agents** — install agents from npm packages that declare `pi.agents`
- **Worktree isolation + setup hook** — run agents in a throw-away git worktree with an optional shell `worktreeSetupHook` and per-run diff metadata
- **Critical system reminder** — pair tool-level limits with a strong `<critical-system-reminder>` prompt block
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

**Package agents** are agents exposed by packages installed via pi (`pi install ...`). They are discovered from the `packages[]` entries in `~/.pi/agent/settings.json` (user scope) and `.pi/settings.json` (project scope), by reading each package's `package.json#pi.agents` field. They run with the same privileges as project agents and are gated by the same confirmation flow.

**Default behavior:** Loads **user-level agents** from `~/.pi/agent/agents` and **user-scope package agents** from packages listed in `~/.pi/agent/settings.json#packages`.

To additionally enable project-local and project-scope package agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust — user-scope packages load under `"user"` / `"both"`, project-scope packages load under `"project"` / `"both"`.

When running interactively, the tool prompts for confirmation before running project-local or package agents (any agent whose `source` is `project` or `package`). Set `confirmProjectAgents: false` to disable.

`worktreeSetupHook` is a shell command sourced from an agent definition and runs in the project on `isolation: worktree` agents. Treat it the same as any other agent body: only declare it for trusted sources, and pair it with the project/package confirmation prompt. `criticalSystemReminder` is a prompt-level constraint, not a runtime sandbox; capability limits still need `tools` / `excludeTools` / `maxSubagentDepth`.

### Tool Permissions

Agent permissions are expressed with two frontmatter fields that map directly onto the Pi CLI:

- `tools` → `--tools <list>` (allowlist; omit to inherit every tool the host exposes)
- `excludeTools` → `--exclude-tools <list>` (denylist; applied after the allowlist)

The child `pi` process receives the merged flags exactly as the parent would. Tool names are passed through after trimming and lower-cased only when the agent author writes them that way.

### Nested Agents and Depth Guard

The tool ships two layers of nesting control:

- **Global depth limit** — every spawned child carries `PI_AGENT_CHILD=1`, `PI_AGENT_DEPTH=<n>`, and `PI_AGENT_MAX_DEPTH=<n>` in its environment. The tool refuses to start a new child when `PI_AGENT_DEPTH >= PI_AGENT_MAX_DEPTH` (default `2`). Raise it by exporting `PI_AGENT_MAX_DEPTH` before launching `pi`.
- **Per-agent `maxSubagentDepth`** — an agent can declare how many additional nested `agent` delegations it is allowed to make. `maxSubagentDepth: 0` means the agent can be invoked but cannot itself call `agent`. The effective child max is `min(PI_AGENT_MAX_DEPTH, currentChildDepth + maxSubagentDepth)`; it can only narrow the global limit, never widen it.

When a child cannot delegate (because of depth, `tools`, `excludeTools`, or `maxSubagentDepth`), the parent:

1. Spawns the child with `--exclude-tools agent` (in addition to the agent's own `excludeTools`) so the model-visible toolset omits `agent`.
2. Sets `PI_AGENT_TOOL_AVAILABLE=0` in the child env as the runtime backstop.
3. Skips the `before_agent_start` "Available agent types" catalogue injection in the child, so the model is not told about agents it cannot reach.

Anything past depth `2` will lift the chance of runaway fan-out, so raise it carefully.

> **Threat model note:** `maxSubagentDepth` and `PI_AGENT_TOOL_AVAILABLE` are LLM-side guardrails for the `agent` tool. They prevent the model from invoking `agent` again, but they do not sandbox other tools. An agent that still has `bash` (or any other tool capable of starting `pi`) could spawn a new top-level `pi` process. Treat this field as a delegation-policy switch, not as a security boundary; for hostile prompts, also restrict `tools` accordingly.

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

### Structured chain output

A chain step can declare `outputSchema` to demand a JSON final assistant message. The orchestrator appends a JSON-only contract to the rendered task, parses the step's final output, validates it against the schema, and exposes the parsed value to later steps.

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
    {
      "agent": "planner",
      "task": "Plan changes for {outputs.context}."
    }
  ]
}
```

The schema supports a JSON Schema subset: `type`, `properties`, `required`, `items`, `enum`, `additionalProperties`, `minItems`, and `maxItems`. `integer` requires `Number.isInteger`. If the final output cannot be parsed or fails the schema, the step is marked failed with `stopReason: "structured_output_error"`, the chain stops, and the parent gets a description of the parse / validation error.

When a step has both `name` and `outputSchema`, the parsed value is also available on `details.outputs[name].structured`. `{outputs.<name>}` in later tasks is replaced with the step's text output, so for structured handoff write tasks that mention the JSON shape explicitly.

### Dynamic fanout

A chain can expand an array from a previous structured output and run one parallel task per item. The fanout step reads `expand.from.output`, applies a JSON Pointer `path`, renders `parallel.task` with `{item}`, then stores the collected results under `collect.name`.

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

If `parallel.outputSchema` is set, each fanout worker is parsed and validated like a structured chain step. The collected output's `structured` value is an array of each worker's `structuredOutput` when present, otherwise its final text. Fanout is capped by `MAX_FANOUT_ITEMS` (currently the same as the parallel task cap) and concurrency is capped by `MAX_CONCURRENCY`.

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
completionCheck: '## Completed, ## Files Changed, ## Validation'
maxSubagentDepth: 0
---

System prompt for the agent goes here.
```

### Frontmatter Fields

| Field                    | Type                  | Default      | Description                                                                                                                                                                                                                                                            |
| ------------------------ | --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | string                | (required)   | Agent identifier used by the `agent` tool.                                                                                                                                                                                                                             |
| `description`            | string                | (required)   | Shown to the parent model in the agent catalogue.                                                                                                                                                                                                                      |
| `tools`                  | comma list            | inherit all  | Allowlist passed to `pi --tools`.                                                                                                                                                                                                                                      |
| `excludeTools`           | comma list            | none         | Denylist passed to `pi --exclude-tools` (applied after the allowlist).                                                                                                                                                                                                 |
| `model`                  | string                | host default | Forwarded as `pi --model`.                                                                                                                                                                                                                                             |
| `thinking`               | string                | host default | Forwarded as `pi --thinking`.                                                                                                                                                                                                                                          |
| `systemPromptMode`       | `append` \| `replace` | `append`     | `replace` swaps the host system prompt with the agent body via `--system-prompt`; `append` uses `--append-system-prompt`.                                                                                                                                              |
| `maxTurns`               | positive integer      | unbounded    | Maximum assistant turns; the child is `SIGTERM`'d when exceeded and the result is marked with `stopReason: max_turns`.                                                                                                                                                 |
| `noContextFiles`         | boolean               | `false`      | When `true`, runs the child with `--no-context-files`.                                                                                                                                                                                                                 |
| `noSkills`               | boolean               | `false`      | When `true`, runs the child with `--no-skills`.                                                                                                                                                                                                                        |
| `defaultContext`         | `fresh` \| `fork`     | `fresh`      | `fork` branches the parent session via `SessionManager.createBranchedSession(getLeafId())` and runs the child with `--session <branched-file>`; `fresh` runs with `--no-session`. Requires a persisted parent session for `fork`.                                      |
| `isolation`              | `none` \| `worktree`  | `none`       | When `worktree`, the child runs in `<repo>/.worktrees/pi-agent-<safe-name>-<timestamp>-<index>/` created by `git worktree add --detach HEAD`. Clean worktrees are removed after the child exits; dirty worktrees are kept and reported on `SingleResult.worktreePath`. |
| `completionCheck`        | comma list            | none         | Required final-message headings. When set, each configured heading must appear as an exact line; otherwise the result is marked `stopReason: completion_check` with exit code `1`.                                                                                     |
| `maxSubagentDepth`       | non-negative integer  | unset        | Caps how many further `agent` delegations may happen from inside the spawned agent. `0` removes the `agent` tool and the catalogue prompt for that child. When unset, the global `PI_AGENT_MAX_DEPTH` limit applies as before.                                         |
| `worktreeSetupHook`      | non-empty string      | unset        | Shell command run inside the freshly created worktree before the child `pi` starts (only when `isolation: worktree`). Failure produces `stopReason: 'worktree_setup_error'` and stops the chain.                                                                       |
| `criticalSystemReminder` | non-empty string      | unset        | Prompt-only constraint appended to the child's system prompt inside a `<critical-system-reminder>` block. Pair with `excludeTools` / `tools` / `maxSubagentDepth` for actual capability limits.                                                                        |

Invalid values (unknown enums, non-positive integers for `maxTurns`, negative or non-integer values for `maxSubagentDepth`, non-boolean strings) are ignored and fall back to the default (`append`, `fresh`, `none`) for enum fields and to `undefined` for boolean / numeric fields. Empty comma lists are ignored.

> Runtime behavior currently wired up: `tools`, `excludeTools`, `model`, `thinking`, `systemPromptMode`, `maxTurns`, `noContextFiles`, `noSkills`, `defaultContext`, `isolation`, `completionCheck`, `maxSubagentDepth`, `worktreeSetupHook`, `criticalSystemReminder`. Every frontmatter field is now active.

### Worktree Setup Hook

Agents with `isolation: worktree` can declare a `worktreeSetupHook` shell command that runs inside the newly created worktree before the child `pi` is spawned. Typical uses are dependency installs or generated-file builds the child relies on (`bun install`, `pnpm install --frozen-lockfile`, `make bootstrap`).

Behavior:

- The hook is launched with `spawnSync(command, { cwd: worktreePath, shell: true })` and inherits the parent's environment.
- A non-zero exit code or spawn error returns a synthetic failure with `stopReason: 'worktree_setup_error'`, exit code `1`, and a truncated tail of stderr/stdout in `errorMessage` / `worktreeSetupError`.
- After a hook failure the worktree is removed when `git status --porcelain` is clean; otherwise it is retained and surfaced via `worktreePath` + `worktreeDirty: true`.
- The hook is shell input from the agent definition. Only declare it in agents from sources you trust; project-local and package agents go through the same confirmation prompt as before.

After a successful child run, dirty worktrees additionally expose:

- `worktreeDiffStat` — output of `git diff --stat --no-ext-diff HEAD`.
- `worktreeChangedFiles` — union of `git diff --name-only --no-ext-diff HEAD` and untracked files reported by `git ls-files --others --exclude-standard`.

### Critical System Reminder

`criticalSystemReminder` lets an agent author append a strong prompt-level constraint to the spawned child's system prompt. The text is wrapped in a `<critical-system-reminder>` block and concatenated after the existing system prompt (or used alone when no body is provided).

This is not a runtime sandbox. It influences model behavior but does not remove tool capabilities. Combine it with `tools` / `excludeTools` for the reviewer / verifier pattern: reviewer-style agents pair the reminder ("do not edit files") with `excludeTools: edit, write, agent` so both the prompt-level intent and the actual tool surface agree.

The bundled `reviewer.md` ships with a `criticalSystemReminder` that reinforces its read-only contract.

### Completion Check

Agents can declare their own final-output contract in frontmatter. The check:

- Runs only when `completionCheck` is set.
- Treats `completionCheck` as a comma-separated list of required headings, for example `completionCheck: "## Completed, ## Files Changed, ## Validation"`.
- Inspects the final assistant message for each configured heading as an exact line (case-insensitive, line-anchored).
- Does not infer behavior from `tools`, `excludeTools`, `edit`, `write`, or `bash`; agents opt in by configuration.
- On failure, sets `stopReason: 'completion_check'`, fills `errorMessage` with the missing headings, and forces exit code `1`. Failures propagate the same way other agent failures do (single-mode returns `isError`, chain-mode stops at the failing step).

The bundled `worker.md` template declares `completionCheck: "## Completed, ## Files Changed, ## Validation"`; the `## Validation` section asks for the commands actually run plus their pass/fail status (or an explicit `Not run: <reason>`).

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
- Package agents from `package.json#pi.agents` of packages listed in `~/.pi/agent/settings.json` (user scope, loaded under `"user"` / `"both"`) or in the nearest ancestor `.pi/settings.json` (project scope, loaded under `"project"` / `"both"`).

Project agents override user agents with the same name when `agentScope: "both"`.

### Package Agents

Any pi-installed package can publish agents by declaring a `pi.agents` field in its `package.json`:

```json
{
  "name": "@acme/pi-frontend",
  "pi": {
    "agents": ["./agents"]
  }
}
```

The field can be a string or an array of strings, and each entry may point to a directory of `.md` files or a single `.md` file relative to the package root.

Packages are discovered from the `packages[]` arrays in pi's settings files:

- `~/.pi/agent/settings.json` → user scope. `npm:` and `git:` sources resolve under `~/.pi/agent/{npm,git}/`. Bare `https://` / `ssh://` / `git://` URLs are also accepted as git sources; SCP shorthand (`git@host:path`) is only accepted with the explicit `git:` prefix, in line with pi's convention. Local sources accept absolute paths, `~`, `~/...`, `file:` / `file://`, or relative paths against `~/.pi/agent/`. As a final fallback for `npm:` sources, the global npm root (`npm root -g`) is consulted. Loaded under `agentScope: "user"` or `"both"` (default).
- `.pi/settings.json` in the nearest ancestor of `cwd` → project scope. Sources resolve against `.pi/{npm,git}/`. Loaded under `agentScope: "project"` or `"both"`.

When a package identity (`npm:<name>`, `git:<host>/<path>`, or `local:<absolute>`) appears in both user and project settings, the project entry wins.

Discovered package agents are namespaced by the package name. An agent declared as `name: reviewer` inside `@acme/pi-frontend` is invocable as `@acme/pi-frontend.reviewer`. The original local name is preserved on `AgentConfig.localName`, and the publishing package name is on `AgentConfig.packageName`.

Package agents go through the same confirmation prompt as project agents because they run with the same privileges. They are not pulled from a project's `dependencies` / `node_modules`; only packages explicitly listed in a pi settings file are considered.

## Bundled Agents

| Agent      | Purpose              | Tools                                            | Nested agents                    |
| ---------- | -------------------- | ------------------------------------------------ | -------------------------------- |
| `explore`  | Fast codebase recon  | read, grep, find, ls, bash                       | disabled (`maxSubagentDepth: 0`) |
| `planner`  | Implementation plans | read, grep, find, ls                             | disabled (`maxSubagentDepth: 0`) |
| `reviewer` | Code review          | read, grep, find, ls, bash (no edit/write/agent) | disabled (`maxSubagentDepth: 0`) |
| `worker`   | General-purpose      | (all default)                                    | follows `PI_AGENT_MAX_DEPTH`     |

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
- **stopReason "completion_check"**: an agent's final message is missing one of its configured `completionCheck` headings (see _Completion Check_)
- **stopReason "template_error"**: a chain step's task referenced `{outputs.<name>}` for a step that did not run or was not named
- **stopReason "structured_output_error"**: a chain step with `outputSchema` produced output that could not be parsed or failed schema validation
- **stopReason "fanout_error"**: a dynamic fanout step could not read an array from a structured output or render its item tasks
- **stopReason "worktree_setup_error"**: an agent declared `worktreeSetupHook` and the command exited non-zero, leaving a dirty worktree retained for inspection
- **Chain mode**: stops at the first failing step and reports which step failed

## Limitations

- Output truncated to the last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- Dynamic fanout expands at most `MAX_FANOUT_ITEMS` items and uses the same concurrency cap as parallel execution
- `outputSchema` uses a JSON Schema subset (type, properties, required, items, enum, additionalProperties, minItems, maxItems); it is not a full JSON Schema implementation
- When a chain step declares `outputSchema`, the agent's `completionCheck` is bypassed for that step because the contract requires JSON-only output
