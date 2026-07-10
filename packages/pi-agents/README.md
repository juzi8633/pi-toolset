# @balaenis/pi-agents

Delegate tasks to specialized subagents from [Pi](https://github.com/earendil-works/pi). Each invocation spawns an isolated `pi` subprocess with its own context window, then streams structured updates back into the parent session.

## Features

- **Isolated context** — every subagent runs in a fresh `pi` process
- **Background agents** — long-running invocations can return immediately and notify the parent session via a custom message when they finish (`runInBackground: true`)
- **Streaming output** — tool calls and progress arrive live
- **Three execution modes** — single, parallel (max 8, 4 concurrent), and chained
- **Structured chain outputs** — per-step `outputSchema` extracts and validates JSON before passing it forward as `{outputs.<name>}`
- **Dynamic fanout** — chain steps can expand a prior step's array output into parallel subtasks with a collected result
- **Package agents** — install agents from npm packages that declare `pi.agents`
- **Slash-command invocation** — run any discovered agent directly from the prompt via `/agent:<name> <task>`; use `/agent list` to enumerate discovered agents
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

**Package agents** are agents exposed by packages installed via pi (`pi install ...`). They are discovered from the `packages[]` entries in `~/.pi/agent/settings.json` (user scope) and `.pi/settings.json` (project scope), by reading each package's `package.json#pi.agents` field. They run with the same privileges as project agents.

**Default behavior:** With no `agentScope` argument (`agentScope: "both"`), loads **user-level agents** from `~/.pi/agent/agents`, **user-scope package agents** from `~/.pi/agent/settings.json#packages`, **project-local agents** from `.pi/agents`, and **project-scope package agents** from `.pi/settings.json#packages`. Project agents override user agents with the same name.

Pass `agentScope: "user"` to skip project sources, or `agentScope: "project"` to skip user sources. Only enable the project sources for repositories you trust — user-scope packages load under `"user"` / `"both"`, project-scope packages load under `"project"` / `"both"`.

`worktreeSetupHook` is a shell command sourced from an agent definition and runs in the project on `isolation: worktree` agents. Treat it the same as any other agent body: only declare it for trusted sources.

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

### Slash Commands

Agents can also be invoked directly from the prompt as slash commands, without going through the model:

```
/agent list
/agent:explore find all authentication code
/agent:@balaenis/pi-agents.reviewer review the recent changes
```

- `/agent list` lists every discovered agent (builtin, user, project, and package) with its source and description.
- `/agent:<name> <task...>` invokes a specific agent and appears in slash autocomplete with the agent's description.

`<name>` is the full agent name as it appears in the catalogue. Package agents are namespaced, e.g. `@acme/pi-frontend.reviewer`. The per-agent `/agent:<name>` commands are registered once at extension load time; add or remove agent files and run `pi reload` (or restart pi) to refresh the shorthand command list. `/agent` only accepts the `list` subcommand (argument completions offer `list`); to invoke an agent, use the `/agent:<name>` form.

Command invocations are foreground: the command waits for the agent to finish streaming (`waitForIdle`), shows live progress in a temporary widget, then reports the agent's final output or error via `ctx.ui.notify`. Background invocation is available through the `agent` tool (`runInBackground: true`) rather than the slash commands.

## Tool Modes

| Mode     | Parameter          | Description                                                      |
| -------- | ------------------ | ---------------------------------------------------------------- |
| Single   | `{ agent, task }`  | One agent, one task                                              |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent)           |
| Chain    | `{ chain: [...] }` | Sequential with `{previous}` and `{outputs.<name>}` placeholders |

Any of the three modes can be wrapped with `runInBackground: true` to launch the workflow asynchronously. The tool returns immediately with an `agent-bg-*` job id. When the job completes or fails, a follow-up custom message is delivered to the parent session and triggers a new turn so the model can react. When the job is cancelled (for example by `session_shutdown`), the same custom message is recorded but the parent model is not re-entered.

### Per-invocation model / thinking / runtime override

The tool accepts optional top-level `model`, `thinking`, and `runtime` parameters that temporarily override each agent's configured `model` / `thinking` / `runtime` for the duration of a single tool call. They apply to every agent spawned by the call (single, parallel, chain, and fanout steps) and take precedence over both the agent frontmatter and any config-file overrides. Leave them unset to keep each agent's own configuration.

```json
{
  "agent": "worker",
  "task": "Refactor the session store.",
  "model": "gpt-5",
  "thinking": "high",
  "runtime": "pi"
}
```

This is intended as a dynamic adjustment point: the orchestrating agent (e.g. the `worker`) can pin a specific model, thinking level, or runtime for a particular run without editing agent definitions or config files.

- `model` / `thinking` are forwarded to the child as `pi --model` / `pi --thinking` (or `grok --model` / `grok --effort` for the grok runtime) and recorded on the result's `model` / `thinking` fields.
- `runtime` selects which CLI is spawned: `"pi"` (default) or `"grok"`. Overriding it switches the child between the pi and Grok runtimes, so all runtime-dependent behavior (skill resolution, context preparation, invocation flags) follows the effective runtime for that call. See [Grok runtime](#grok-runtime) for the grok-specific flag and thinking→effort mapping.

### Background agents

```json
{
  "agent": "worker",
  "task": "Run the full test suite and report failures.",
  "runInBackground": true
}
```

Guidance:

- Use background mode for independent, long-running work whose result the parent does not need immediately. For anything the parent must wait on before proceeding, keep the call foreground.
- Completion and failure are delivered as a session message (`customType: pi-agents-background-result`) with `triggerTurn: true` and `deliverAs: "followUp"`. Cancelled jobs emit the same message type with `triggerTurn: false`. The parent should not poll for results.
- Background jobs are scoped to the current Pi process / session. They are cancelled when the session shuts down (`quit`, `reload`, `resume`, `fork`, `new`) and do not survive a Pi restart.
- The parent abort signal (`Ctrl+C` on the current turn) does **not** cancel a launched background job; it owns an independent abort controller.
- `runInBackground` is rejected in `json` and `print` modes because those host processes exit when the tool returns. The tool returns an error explaining the limitation instead of silently dropping the work.
- At most four jobs may be in flight per session. Additional launches return an error containing `Too many background agent jobs` until one finishes.
- For Claude-style tool calls, `run_in_background` (snake_case) is accepted as a compatibility alias and normalized to `runInBackground` before schema validation.
- Detaching an already-running foreground agent is intentionally not supported in this implementation.

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
skills: librarian, code-reviewer
defaultContext: fresh
isolation: none
completionCheck: '## Completed, ## Files Changed, ## Validation'
maxSubagentDepth: 0
runtime: pi
---

System prompt for the agent goes here.
```

### Frontmatter Fields

| Field               | Type                  | Default      | Description                                                                                                                                                                                                                                                                                           |
| ------------------- | --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | string                | (required)   | Agent identifier used by the `agent` tool.                                                                                                                                                                                                                                                            |
| `description`       | string                | (required)   | Shown to the parent model in the agent catalogue.                                                                                                                                                                                                                                                     |
| `tools`             | comma list            | inherit all  | Allowlist passed to `pi --tools`.                                                                                                                                                                                                                                                                     |
| `excludeTools`      | comma list            | none         | Denylist passed to `pi --exclude-tools` (applied after the allowlist).                                                                                                                                                                                                                                |
| `model`             | string                | host default | Forwarded as `pi --model`.                                                                                                                                                                                                                                                                            |
| `thinking`          | string                | host default | Forwarded as `pi --thinking`.                                                                                                                                                                                                                                                                         |
| `systemPromptMode`  | `append` \| `replace` | `append`     | `replace` swaps the host system prompt with the agent body via `--system-prompt`; `append` uses `--append-system-prompt`.                                                                                                                                                                             |
| `maxTurns`          | positive integer      | unbounded    | Maximum assistant turns; the child is `SIGTERM`'d when exceeded and the result is marked with `stopReason: max_turns`.                                                                                                                                                                                |
| `noContextFiles`    | boolean               | `false`      | When `true`, runs the child with `--no-context-files`.                                                                                                                                                                                                                                                |
| `noSkills`          | boolean               | `false`      | When `true`, runs the child with `--no-skills`.                                                                                                                                                                                                                                                       |
| `skills`            | comma list            | none         | Skill **names** to allowlist for the child. When set, the child runs with `--no-skills` plus one `--skill <path>` per resolved name, loading only those skills. Names resolve against the host's discovered skills (see [Skills](#skills)). Unresolvable names fail with `stopReason: 'skill_error'`. |
| `defaultContext`    | `fresh` \| `fork`     | `fresh`      | `fork` branches the parent session via `SessionManager.createBranchedSession(getLeafId())` and runs the child with `--session <branched-file>`; `fresh` runs with `--no-session`. Requires a persisted parent session for `fork`.                                                                     |
| `isolation`         | `none` \| `worktree`  | `none`       | When `worktree`, the child runs in `<repo>/.worktrees/pi-agent-<safe-name>-<timestamp>-<index>/` created by `git worktree add --detach HEAD`. Clean worktrees are removed after the child exits; dirty worktrees are kept and reported on `SingleResult.worktreePath`.                                |
| `completionCheck`   | comma list            | none         | Required final-message headings. When set, each configured heading must appear as an exact line; otherwise the result is marked `stopReason: completion_check` with exit code `1`.                                                                                                                    |
| `maxSubagentDepth`  | non-negative integer  | unset        | Caps how many further `agent` delegations may happen from inside the spawned agent. `0` removes the `agent` tool and the catalogue prompt for that child. When unset, the global `PI_AGENT_MAX_DEPTH` limit applies as before.                                                                        |
| `worktreeSetupHook` | non-empty string      | unset        | Shell command run inside the freshly created worktree before the child runtime starts (only when `isolation: worktree`). Applies to both `pi` and `grok`. Failure produces `stopReason: 'worktree_setup_error'` and stops the chain.                                                                  |
| `runtime`           | `pi` \| `grok`        | `pi`         | Which CLI binary to spawn for the agent. `pi` (default) spawns `pi --mode json -p`; `grok` spawns `grok -p --output-format streaming-json`. See [Grok Runtime](#grok-runtime) for prerequisites and caveats.                                                                                          |

Invalid values (unknown enums, non-positive integers for `maxTurns`, negative or non-integer values for `maxSubagentDepth`, non-boolean strings) are ignored and fall back to the default (`append`, `fresh`, `none`) for enum fields and to `undefined` for boolean / numeric fields. Empty comma lists are ignored.

> Runtime behavior currently wired up: `tools`, `excludeTools`, `model`, `thinking`, `systemPromptMode`, `maxTurns`, `noContextFiles`, `noSkills`, `skills`, `defaultContext`, `isolation`, `completionCheck`, `maxSubagentDepth`, `worktreeSetupHook`, `runtime`. Every frontmatter field is now active.

### Config Overrides

You can override fields of any discovered agent (builtin, package, user, or project) without editing its source markdown via a `config.json` under the Pi user or project config directory:

- User scope: `~/.pi/agent/@balaenis/pi-agents/config.json`
- Project scope: `<repo>/.pi/@balaenis/pi-agents/config.json`

Merging is field-level: project scope overrides only the fields it specifies; any field omitted in project config falls back to the user value, and any field omitted in both falls back to the agent's frontmatter.

```json
{
  "agents": {
    "explore": {
      "model": "gpt-5",
      "thinking": "high",
      "systemPromptMode": "replace"
    },
    "@balaenis/pi-agents.reviewer": {
      "model": "claude-sonnet-4.5"
    }
  }
}
```

Key is the full agent name as it appears in the catalogue (package agents are namespaced as `<packageName>.<localName>`). Allowed fields match the frontmatter set above: `description`, `model`, `thinking`, `tools`, `excludeTools`, `systemPromptMode`, `maxTurns`, `noContextFiles`, `noSkills`, `skills`, `defaultContext`, `isolation`, `completionCheck`, `maxSubagentDepth`, `worktreeSetupHook`, `runtime`. `name`, `systemPrompt` (the markdown body), `source`, and `filePath` are not overridable. Invalid values are dropped using the same rules as frontmatter parsing.

### Worktree Setup Hook

Agents with `isolation: worktree` can declare a `worktreeSetupHook` shell command that runs inside the newly created worktree before the child `pi` is spawned. Typical uses are dependency installs or generated-file builds the child relies on (`bun install`, `pnpm install --frozen-lockfile`, `make bootstrap`).

Behavior:

- The hook is launched with `spawnSync(command, { cwd: worktreePath, shell: true })` and inherits the parent's environment.
- A non-zero exit code or spawn error returns a synthetic failure with `stopReason: 'worktree_setup_error'`, exit code `1`, and a truncated tail of stderr/stdout in `errorMessage` / `worktreeSetupError`.
- After a hook failure the worktree is removed when `git status --porcelain` is clean; otherwise it is retained and surfaced via `worktreePath` + `worktreeDirty: true`.
- The hook is shell input from the agent definition. Only declare it in agents from sources you trust.

After a successful child run, dirty worktrees additionally expose:

- `worktreeDiffStat` — output of `git diff --stat --no-ext-diff HEAD`.
- `worktreeChangedFiles` — union of `git diff --name-only --no-ext-diff HEAD` and untracked files reported by `git ls-files --others --exclude-standard`.

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

### Skills

An agent can restrict the child to a specific set of skills by **name** via the `skills` frontmatter field:

```markdown
---
name: my-agent
description: only load these skills
skills: librarian, code-reviewer
---
```

Behavior:

- `skills` is a comma-separated list of skill **names** (as they appear in the host's `<available_skills>` catalogue), not paths.
- When non-empty, the child is launched with `--no-skills` plus one `--skill <path>` per resolved name, so only the listed skills are loaded — the child's default skill discovery is disabled.
- Name→path resolution uses the skills the host already discovered. The `before_agent_start` hook captures `event.systemPromptOptions.skills` and caches the name→`filePath` mapping; the cache refreshes on every host agent loop and before `/agent` slash-command invocation (which bypasses `before_agent_start`).
- Unresolvable names fail the step before the child is spawned, with `stopReason: 'skill_error'` and a message listing the missing names plus the available ones.
- `skills` takes precedence over `noSkills`: a non-empty list always emits `--no-skills` + `--skill`, even when `noSkills: true`. Use `noSkills: true` alone to disable all skills; use `skills` to allowlist specific ones.
- Resolved paths are the skill `filePath` values reported by the host (absolute), so they stay valid regardless of the child's working directory, including worktree isolation.

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

Package agents run with the same privileges as project agents. They are not pulled from a project's `dependencies` / `node_modules`; only packages explicitly listed in a pi settings file are considered.

### Grok Runtime

When an agent declares `runtime: grok`, the tool spawns the [Grok Build CLI](https://docs.x.ai/build/cli) (`grok -p --output-format streaming-json`) instead of `pi`. This lets you route specific subagent types to xAI models (Grok 4.5, etc.) for different cost/quality trade-offs.

**Prerequisites:**

- Install the Grok CLI and authenticate with `grok login` or set `XAI_API_KEY` in your environment.
- If `grok` is not on `PATH`, the spawn fails with a clear error.

**Example agent definition:**

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

You are a code review specialist. Analyze the provided code for correctness, security, and maintainability.
```

**Field mapping** (pi -> Grok native flags):

| AgentConfig field                    | Grok CLI flag                            |
| ------------------------------------ | ---------------------------------------- |
| `model`                              | `--model <value>`                        |
| `thinking` (see downgrade map below) | `--effort <value>`                       |
| `maxTurns`                           | `--max-turns <value>`                    |
| `systemPrompt` (append mode)         | `--rules <inline text>`                  |
| `systemPrompt` (replace mode)        | `--system-prompt-override <inline text>` |
| `tools`                              | `--tools <csv>`                          |
| `excludeTools`                       | `--disallowed-tools <csv>`               |
| (always)                             | `--no-subagents`                         |

Hardcoded flags: `--no-auto-update`, `--always-approve`, `--output-format streaming-json`, `--no-memory`, `--no-subagents`.

**thinking -> effort downgrade** (pi has 7 levels, Grok has 3):

| pi `thinking` | Grok `effort` |
| ------------- | ------------- |
| `off`         | (omitted)     |
| `minimal`     | `low`         |
| `low`         | `low`         |
| `medium`      | `medium`      |
| `high`        | `high`        |
| `xhigh`       | `high`        |
| `max`         | `high`        |

**Caveats and limitations:**

- **No usage stats** - Grok's streaming-json does not expose token counts or cost. `SingleResult.usage` is all zeros; only `turns` is set (to 1 on completion).
- **No tool call visibility** - Grok handles tools transparently. Tool executions are not in the output stream, so `SingleResult.messages` contains only the final assistant text.
- **stopReason mapping** - Grok's `EndTurn` maps to pi's `end`; `Cancelled` (max turns reached, exit code 1) maps to `max_turns`.
- **Skills are no-ops** - pi skills are not transferable to Grok. Skill name resolution is skipped for Grok agents (a warning is emitted if `skills` is set). Use `pi` runtime if skills are needed.
- **`worktreeSetupHook` still runs** - when `isolation: worktree`, the setup hook runs inside the worktree before the Grok child is spawned (same as the pi path).
- **Fork context is ignored** - `defaultContext: fork` is treated as `fresh` for Grok agents (Grok manages sessions independently). A warning is emitted at invoke time.
- **Tool names are runtime-specific** - pi tool names (`read`, `bash`, `edit`, etc.) may not match Grok's built-in tool names. Tool lists are passed through as-is; restrictions may be silently ignored by Grok.
- **System prompt replace mode** - `--system-prompt-override` may not fully suppress Grok's default behavior; project-level `.grok/` config may still influence output. Prefer `append` mode (`--rules`) unless full replacement is explicitly required.
- **No nested Grok subagents** - Grok ignores `PI_AGENT_DEPTH` / nesting env vars. Every Grok spawn always passes `--no-subagents` so Grok cannot fan out further.

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
- **stopReason "skill_error"**: an agent declared `skills` but one or more names could not be resolved against the host's discovered skills; the child was not spawned
- **Chain mode**: stops at the first failing step and reports which step failed

## Limitations

- Output truncated to the last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- Dynamic fanout expands at most `MAX_FANOUT_ITEMS` items and uses the same concurrency cap as parallel execution
- `outputSchema` uses a JSON Schema subset (type, properties, required, items, enum, additionalProperties, minItems, maxItems); it is not a full JSON Schema implementation
- When a chain step declares `outputSchema`, the agent's `completionCheck` is bypassed for that step because the contract requires JSON-only output
- Background agents are in-memory and per-session: they do not persist across Pi process restarts, and there is no API to detach an already-running foreground agent
