# Reference

Technical lookup for `@balaenis/pi-agents`.

## Agent definition frontmatter

Agents are markdown files with YAML frontmatter. Locations:

- `~/.pi/agent/agents/*.md` - user-level (always loaded)
- `.pi/agents/*.md` - project-level (only with `agentScope: "project"` or `"both"`)
- Package agents from `package.json#pi.agents` of packages listed in
  `~/.pi/agent/settings.json` (user scope) or the nearest ancestor
  `.pi/settings.json` (project scope).

| Field               | Type                         | Default      | Description                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`              | string                       | (required)   | Agent identifier used by the `agent` tool.                                                                                                                                                                                                                                     |
| `description`       | string                       | (required)   | Shown to the parent model in the agent catalogue.                                                                                                                                                                                                                              |
| `tools`             | comma list                   | inherit all  | Allowlist passed to `pi --tools`.                                                                                                                                                                                                                                              |
| `excludeTools`      | comma list                   | none         | Denylist passed to `pi --exclude-tools` (applied after the allowlist).                                                                                                                                                                                                         |
| `model`             | string                       | host default | Forwarded as `pi --model`.                                                                                                                                                                                                                                                     |
| `thinking`          | string                       | host default | Forwarded as `pi --thinking`.                                                                                                                                                                                                                                                  |
| `systemPromptMode`  | `append` \| `replace`        | `append`     | `replace` swaps the host system prompt via `--system-prompt`; `append` uses `--append-system-prompt`.                                                                                                                                                                          |
| `maxTurns`          | positive integer             | unbounded    | Max assistant turns for `pi` and `grok` (streaming-json); the child is `SIGTERM`'d when exceeded (`stopReason: "max_turns"`). Ignored entirely by `grok-acp`.                                                                                                                  |
| `noContextFiles`    | boolean                      | `false`      | When `true`, runs the child with `--no-context-files`.                                                                                                                                                                                                                         |
| `noSkills`          | boolean                      | `false`      | When `true`, runs the child with `--no-skills`.                                                                                                                                                                                                                                |
| `skills`            | comma list                   | none         | Skill names to allowlist. When set, the child runs with `--no-skills` plus one `--skill <path>` per resolved name. Unresolvable names fail with `stopReason: "skill_error"`.                                                                                                   |
| `defaultContext`    | `fresh` \| `fork`            | `fresh`      | `fork` branches the parent session and runs the child with `--session <branched-file>`; `fresh` runs with `--no-session`. Requires a persisted parent session for `fork`.                                                                                                      |
| `isolation`         | `none` \| `worktree`         | `none`       | When `worktree`, the child runs in `<repo>/.worktrees/pi-agent-<safe-name>-<timestamp>-<index>-<rand>/` via `git worktree add --detach HEAD`. Clean worktrees are removed; dirty ones are kept and reported on `worktreePath`.                                                 |
| `completionCheck`   | comma list                   | none         | Required final-message headings. Each configured heading must appear as an exact line; otherwise `stopReason: "completion_check"`, exit code `1`, `status: "failed"`. Parent-visible text is a failure warning (with missing headings) followed by the unchecked final output. |
| `maxSubagentDepth`  | non-negative integer         | unset        | Caps further `agent` delegations from inside the spawned agent. `0` removes the `agent` tool and catalogue prompt for that child. When unset, the global `PI_AGENT_MAX_DEPTH` limit applies.                                                                                   |
| `worktreeSetupHook` | non-empty string             | unset        | Shell command run inside the new worktree before the child runtime starts (only when `isolation: worktree`). Applies to `pi`, `grok`, and `grok-acp`. Failure produces `stopReason: "worktree_setup_error"`.                                                                   |
| `runtime`           | `pi` \| `grok` \| `grok-acp` | `pi`         | Which CLI/protocol to spawn. `pi` -> `pi --mode json -p`; `grok` -> `grok -p --output-format streaming-json`; `grok-acp` -> `grok agent … stdio` (ACP).                                                                                                                        |

Invalid values (unknown enums, non-positive `maxTurns`, negative/non-integer
`maxSubagentDepth`, non-boolean strings) are ignored and fall back to the
default (`append`, `fresh`, `none`) for enums and `undefined` for boolean /
numeric fields. Empty comma lists are ignored.

## Config overrides

Override fields of any discovered agent without editing its source via a
`config.json`:

- User scope: `~/.pi/agent/@balaenis/pi-agents/config.json`
- Project scope: `<repo>/.pi/@balaenis/pi-agents/config.json`

Merge is field-level: project overrides only the fields it specifies; omitted
fields fall back to the user value, then to the agent's frontmatter. Key is the
full catalogue name (package agents are namespaced `<packageName>.<localName>`).
Allowed fields match the frontmatter set above. `name`, `systemPrompt` (the
markdown body), `source`, and `filePath` are not overridable. Invalid values are
dropped with the same rules as frontmatter parsing.

## Tool modes

| Mode     | Parameter          | Description                                          |
| -------- | ------------------ | ---------------------------------------------------- |
| Single   | `{ agent, task }`  | One agent, one task.                                 |
| Parallel | `{ tasks: [...] }` | Multiple agents concurrently (max 8, 4 at a time).   |
| Chain    | `{ chain: [...] }` | Sequential with `{previous}` and `{outputs.<name>}`. |

Any mode can be wrapped with `runInBackground: true` to run asynchronously.

### Collapse titles

Every mode accepts an optional `title` (max 30 characters) that replaces the
task preview in the collapsed summary. Provide it on the top-level single
call, on each parallel `tasks[]` item, on each sequential chain step, and on
`parallel` inside a fanout step. Generate the title before the call and keep
it concise (for example `探索结构`, `fix lint`). When omitted or blank, the
task preview is used. The shown width is clamped to 30 terminal columns, so
CJK and emoji titles never overflow the summary line.

```json
{ "agent": "explore", "task": "Find all authentication code.", "title": "查认证" }
```

Background launches use the first item's `title` as the launch summary,
falling back to a 30-column task preview when no title is set. Expanded view
(Ctrl+O) always shows the complete task regardless of `title`.

## Per-invocation overrides

Optional top-level `model`, `thinking`, and `runtime` parameters override each
agent's configured values for one tool call. They apply to every agent spawned
by the call (single, parallel, chain, fanout) and take precedence over
frontmatter and config overrides.

```json
{
  "agent": "general",
  "task": "Refactor the session store.",
  "model": "gpt-5",
  "thinking": "high",
  "runtime": "pi"
}
```

- `model` / `thinking` are forwarded as `pi --model` / `pi --thinking` (or
  `grok --model` / `grok --effort` / `grok --reasoning-effort` depending on
  runtime) and recorded on the result.
- `runtime` selects the CLI: `"pi"` (default), `"grok"` (streaming-json), or
  `"grok-acp"` (ACP over stdio).

## Background agents

| Property              | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Job id                | `agent-bg-*`                                                               |
| Completion message    | `customType: pi-agents-background-result`, `triggerTurn: true`             |
| Cancelled message     | same `customType`, `triggerTurn: false`                                    |
| Max in-flight jobs    | 4 (additional launches error with `Too many background agent jobs`)        |
| Lifetime              | in-memory, per-session; cancelled on `quit`/`reload`/`resume`/`fork`/`new` |
| Parent abort (Ctrl+C) | does not cancel a launched background job                                  |
| `json`/`print` modes  | rejected (those host processes exit when the tool returns)                 |
| Snake_case alias      | `run_in_background` normalized to `runInBackground` before validation      |
| Foreground detach     | not supported                                                              |

## Structured output

`outputSchema` on a chain step (or `parallel.outputSchema` on a fanout) demands
a JSON final message. Supported JSON Schema subset: `type`, `properties`,
`required`, `items`, `enum`, `additionalProperties`, `minItems`, `maxItems`.
`integer` requires `Number.isInteger`. When a step has both `name` and
`outputSchema`, the parsed value is also available on
`details.outputs[name].structured`.

When a chain step declares `outputSchema`, the agent's `completionCheck` is
bypassed for that step (the contract requires JSON-only output).

## Dynamic fanout

| Constant             | Value | Meaning                                       |
| -------------------- | ----- | --------------------------------------------- |
| `MAX_PARALLEL_TASKS` | 8     | Max parallel tasks / max fanout items.        |
| `MAX_FANOUT_ITEMS`   | 8     | Max items expanded from a structured array.   |
| `MAX_CONCURRENCY`    | 4     | Max concurrent workers (parallel and fanout). |

`expand.from.output` names a prior step; `path` is a JSON Pointer into its
structured output. `parallel.task` is rendered with `{item}`. Collected results
go under `collect.name`; the `structured` value is an array of each worker's
`structuredOutput` when present, otherwise its final text.

## Durable runs

Every validated invocation persists under
`~/.pi/agent/@balaenis/pi-agents/runs/<run-id>/`:

| Path              | Role                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `run.json`        | Versioned authoritative snapshot (`AgentRunRecordV1`)                |
| `events.jsonl`    | Append-only lifecycle events                                         |
| `claims/<ticket>` | Ownership claim (`owner.json`) and terminal marker (`terminal.json`) |
| `sessions/`       | Native Pi JSONL session files per unit                               |

### Unit identity

Unit ids are generated from immutable workflow positions (lowercase letters,
digits, hyphens only):

| Form                     | Meaning                                               |
| ------------------------ | ----------------------------------------------------- |
| `single`                 | Single-mode execution unit                            |
| `parallel-NNNN`          | Parallel task (1-based padded index)                  |
| `chain-NNNN`             | Sequential chain step (1-based padded step)           |
| `chain-NNNN-fanout-MMMM` | Fanout item (1-based step, 1-based padded item index) |
| `chain-NNNN-fanout`      | **Not** a unit id — key for `workflowState.fanouts`   |

Fanout child unit records are created only after expansion succeeds. New runs
never create an executable placeholder unit named `chain-NNNN-fanout`.

### `workflowState.fanouts`

```ts
workflowState.fanouts: {
  "chain-0002-fanout": {
    step: 2,                    // one-based chain step
    items: [ /* scheduled */ ], // ordered list after maxItems truncation
    unitIds: [                  // parallel array; unitIds[i] for items[i]
      "chain-0002-fanout-0001",
      "chain-0002-fanout-0002"
    ]
  }
}
```

`items` is the post-`maxItems` scheduled subset only. The logical fanout step on
`details.chain` retains the original skipped count for rendering. Expansion is
written atomically with every queued child `RunUnitRecord` before the first
worker is scheduled. Empty sources persist `{ items: [], unitIds: [] }` with no
child units.

### Per-item unit records

Each fanout item has its own `RunUnitRecord` with immutable `step` (one-based)
and `fanoutIndex` (zero-based), plus status, attempt, session/worktree paths,
fingerprint, runtime capability, and terminal `result`. Unit records are
authoritative on resume; `details.results` is the ordered presentation
projection.

### Resume errors

Blocking reasons returned by resume inspection (and related coordinator errors):

| Prefix / code                     | When                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `stored_fanout_state_unavailable` | Incomplete fanout without a valid, canonical persisted mapping  |
| `stored_output_invalid`           | Completed child unit missing a completed terminal result        |
| `fanout_state_conflict`           | Expansion request conflicts with an existing mapping or unit id |
| `session_unavailable`             | Pi unit that already started is missing its session file        |
| fingerprint mismatch              | Current agent definition differs from the stored fingerprint    |
| requires replay                   | Replay-capable unit and `allowReplay` was not set               |

Completed historical runs remain listable and inspectable even when they predate
per-item fanout records. Incomplete legacy fanouts without a mapping cannot be
resumed safely — start a new invocation.

## Bundled agents

| Agent      | Purpose              | Tools                         | Extras                                                                           |
| ---------- | -------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `explore`  | Fast codebase recon  | `read, grep, find, ls, bash`  | `noSkills`, `maxSubagentDepth: 0`                                                |
| `planner`  | Implementation plans | `read, grep, find, ls, write` | `noSkills`, `maxSubagentDepth: 0`, `completionCheck` set                         |
| `reviewer` | Code review          | `read, grep, find, ls, bash`  | `excludeTools: edit, write, agent`, `maxSubagentDepth: 0`, `completionCheck` set |
| `general`  | General-purpose      | (all default tools)           | follows `PI_AGENT_MAX_DEPTH`                                                     |

## Workflow prompts

| Prompt                          | Flow                           | Acceptance contract                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/implement <query>`            | explore -> planner -> general  | Steps named `context`, `plan`; general references `{outputs.plan}`. General final output must include `## Completed`, `## Files Changed`, `## Validation` (commands run + pass/fail, or `Not run: <reason>`).                                       |
| `/explore-and-plan <query>`     | explore -> planner             | Steps named `context`, `plan`. Plan-only; no file changes; no general agent.                                                                                                                                                                        |
| `/implement-and-review <query>` | general -> reviewer -> general | Steps named `implementation`, `review`. Reviewer must emit `## Critical (must fix)\n- None.` when empty. Final general resolves every Critical item, reports remaining Warnings, and stops with the blocker if any Critical cannot be fixed safely. |

## Slash commands

| Command                         | Action                                                   |
| ------------------------------- | -------------------------------------------------------- |
| `/agent list`                   | List every discovered agent with source and description. |
| `/agent:<name> <task...>`       | Invoke a specific agent in the foreground.               |
| `/agent runs`                   | List durable runs.                                       |
| `/agent status <run-id>`        | Show detailed status for a durable run.                  |
| `/agent resume <run-id>`        | Resume guidance for an interrupted run.                  |
| `/implement <query>`            | Run the explore -> planner -> general chain.             |
| `/explore-and-plan <query>`     | Run the explore -> planner chain.                        |
| `/implement-and-review <query>` | Run the general -> reviewer -> general chain.            |
| `/work-with-grok <task>`        | Delegate a task to general on the Grok ACP runtime.      |

`/agent:<name>` uses the full catalogue name; package agents are namespaced
(e.g. `@acme/pi-frontend.reviewer`). Per-agent commands are registered at load
time; run `pi reload` (or restart) after adding/removing agent files.

## Environment variables

| Variable                  | Default | Meaning                                                                                        |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `PI_AGENT_CHILD`          | unset   | Set to `1` on every spawned child.                                                             |
| `PI_AGENT_DEPTH`          | unset   | Current nesting depth, incremented per child.                                                  |
| `PI_AGENT_MAX_DEPTH`      | `2`     | Global nesting limit. A new child is refused when `depth >= max`. Raise before launching `pi`. |
| `PI_AGENT_TOOL_AVAILABLE` | unset   | Set to `0` as a runtime backstop when the `agent` tool is removed from a child.                |

## `stopReason` values

| `stopReason`              | Meaning                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `end`                     | Normal completion.                                                                                                                                        |
| `error`                   | LLM error propagated with an error message.                                                                                                               |
| `aborted`                 | User abort (Ctrl+C) killed the subprocess.                                                                                                                |
| `max_turns`               | Agent exceeded its `maxTurns` budget; child was `SIGTERM`'d. (`grok-acp` does not enforce this.)                                                          |
| `context_error`           | Fork-context preparation failed before the child started.                                                                                                 |
| `cwd_error`               | The requested working directory is missing, inaccessible, or not a directory.                                                                             |
| `isolation_error`         | Worktree isolation failed before the child started (e.g. not in a git repo).                                                                              |
| `completion_check`        | Final message is missing a configured `completionCheck` heading. Result stays failed; parent-visible text is the warning plus the unchecked final output. |
| `template_error`          | A chain step referenced `{outputs.<name>}` for a step that did not run or was not named.                                                                  |
| `structured_output_error` | A step with `outputSchema` produced output that could not be parsed or failed validation.                                                                 |
| `fanout_error`            | A fanout step could not read an array from a structured output or render its item tasks.                                                                  |
| `worktree_setup_error`    | A declared `worktreeSetupHook` exited non-zero; dirty worktree retained for inspection.                                                                   |
| `skill_error`             | An agent declared `skills` but a name could not be resolved; the child was not spawned.                                                                   |

## Limitations

- Collapsed view shows a compact status summary with at most one latest activity
  per running unit; expand (Ctrl+O) for the full transcript.
- Parallel model-visible output is capped at 50 KB per task; full results stay
  in tool details.
- Agents are discovered fresh on each invocation (editable mid-session).
- Parallel mode: max 8 tasks, 4 concurrent.
- Fanout: max `MAX_FANOUT_ITEMS` (8) items, same concurrency cap as parallel.
- `outputSchema` is a JSON Schema subset, not a full implementation.
- When a chain step declares `outputSchema`, its `completionCheck` is bypassed.
- Background agents are in-memory and per-session; they do not persist across Pi
  restarts, and there is no API to detach an already-running foreground agent.

## Interactive agent view

TUI-only navigator for Pi-runtime durable units linked to the active main-session branch.

### Controls

| Context   | Control         | Behavior                                        |
| --------- | --------------- | ----------------------------------------------- |
| Host TUI  | `/agent view`   | Open navigator immediately (no `waitForIdle`)   |
| Host TUI  | `Ctrl+Alt+Down` | Same as `/agent view`                           |
| Navigator | Up/Down         | Move between `main` and linked endpoints        |
| Navigator | Enter           | Close for `main`; open child detail otherwise   |
| Navigator | Escape          | Close to host editor                            |
| Detail    | PageUp/PageDown | Scroll transcript viewport                      |
| Detail    | End             | Resume tail-following                           |
| Detail    | Enter           | `prompt` when not running; `steer` when running |
| Detail    | Alt+Enter       | `follow_up` when running; `prompt` otherwise    |
| Detail    | Ctrl+X          | Abort current child turn only                   |
| Detail    | Ctrl+O          | Toggle last-15-line preview vs full transcript  |
| Detail    | Escape          | Return to navigator                             |

### Endpoint statuses

| Status        | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `registered`  | Link created; first activation about to start    |
| `starting`    | RPC process spawning / handshake                 |
| `running`     | Child agent turn in progress                     |
| `idle`        | Settled; transport may remain attached           |
| `detached`    | Transport disposed; session file retained        |
| `error`       | Process/protocol failure; new prompt may recover |
| `unavailable` | Trust/validation failed; no spawn                |

### Link schema (Version 1)

Host-session custom entry type `pi-agents-interactive-link`:

```ts
{
  version: 1;
  runId: string;
  unitId: string;
  bindingId: string;
  hostSessionId: string;
  createdAt: number;
}
```

The durable unit stores the matching dual binding under `interactiveBindings[bindingId]`. RunStore remains authoritative for session path, cwd, runtime, fingerprint, and launch reconstruction. Link fields are untrusted claims.

### Caps and errors

| Cap / error                | Value / meaning                                                |
| -------------------------- | -------------------------------------------------------------- |
| Idle transport cap         | 4 idle attached RPC children (LRU detach)                      |
| Tool result viewport       | 5 lines and 4 KB displayed (full result kept in child session) |
| Detail default preview     | Last 15 content lines (fixed; not terminal-row dependent)      |
| Detail expanded (Ctrl+O)   | Full transcript; collapse restores last 15 at the tail         |
| Transcript viewport height | Collapsed: 15; expanded: all content lines                     |
| `blank_message`            | Empty send rejected                                            |
| `slash_message`            | Child slash commands rejected                                  |
| `session_busy`             | Another in-process endpoint owns the session file              |
| `unavailable`              | Binding/host/path/fingerprint/cwd validation failed            |
| `host_session_mismatch`    | Link host session id ≠ current main session                    |

### Scope

- Pi runtime only; Grok/Grok ACP deferred.
- No cross-process attachment; one writer per session inside the current Pi process.
- Pre-feature sessions have no links and are not retrofitted.
- Linked clean worktrees are retained (no automatic pruning in Version 1).

### Continuation relay

When the original `agent` tool-call activation terminates interrupted/cancelled, the next interactive view continuation that settles is relayed back to the bound host model as a clearly-marked `pi-agents-interactive-continuation` custom message (via the Pi Extension API `sendMessage` with `triggerTurn: true`, delivered as `followUp` so a streaming host turn queues it). The relay carries agent/run/unit identity, continuation status, and the post-baseline final output (or a status line when the turn produced no text).

- Exactly-once per activation (`endpointKey` + `activationId` dedup); multiple results may queue as separate activations.
- Normal completed agents never relay; only interrupted/cancelled tool-call activations gate the next view continuation.
- A new `tool_call` activation clears the gate.
- The relay is scoped to the same host session and active branch; if the host session or branch changes first, no content is injected (a content-free notification may be recorded). The detail-panel send never blocks waiting for the relay — the relay coordinator observes settle independently in the registry/index lifecycle layer.
- The relay is additive metadata; it never rewrites the original tool call or the durable interrupted result.
