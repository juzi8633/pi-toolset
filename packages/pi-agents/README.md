# @balaenis/pi-agents

Delegate tasks to specialized subagents from [Pi](https://github.com/earendil-works/pi). Each invocation spawns an isolated `pi` subprocess with its own context window, then streams structured updates back into the parent session.

## Features

- **Isolated context** - every subagent runs in a fresh `pi` process
- **Background agents** - long-running invocations return immediately and notify the parent via a custom message when they finish (`runInBackground: true`)
- **Streaming output** - tool calls and progress arrive live
- **Three execution modes** - single, parallel (max 8, 4 concurrent), and chained
- **Structured chain outputs** - per-step `outputSchema` extracts and validates JSON before passing it forward as `{outputs.<name>}`
- **Dynamic fanout** - chain steps expand a prior step's array output into parallel subtasks with a collected result
- **Package agents** - install agents from npm packages that declare `pi.agents`
- **Slash-command invocation** - `/agent:<name> <task>` runs a discovered agent directly; `/agent list` enumerates them
- **Interactive agent view (TUI)** - `/agent view` or `Ctrl+Alt+Down` opens a navigator for current-session Pi and Grok ACP subagents; Pi supports steer/follow-up, Grok ACP supports idle prompt and cancel
- **Worktree isolation + setup hook** - run agents in a throw-away git worktree with an optional shell `worktreeSetupHook` and per-run diff metadata
- **Completion check** - require final-message headings via frontmatter
- **Compact live rendering** - collapsed view is a status summary (glyph, agent, truncated task or a short `title`, usage, at most one latest activity); Ctrl+O expands full task/transcript/final output
- **Short collapse titles** - optional `title` (aim for ~30 characters) on single, parallel tasks, chain steps, and fanout steps replaces the task preview in the collapsed summary; longer values are accepted and clamped when rendered
- **Parallel & Chain progress** - ordered per-task summaries; Chain fanout is one logical step with real item counts and collect metadata
- **Usage tracking** - turns, tokens, and context per execution unit; aggregates sum tokens/turns and use `ctx:max` (no aggregate model/thinking); partial stats stream live for `grok-acp`
- **Abort support** - Ctrl+C propagates and kills active subprocesses
- **Durable runs** - every invocation persists a run record, unit state, and native Pi sessions under `~/.pi/agent/@balaenis/pi-agents/runs/`; interrupted runs can be inspected and resumed without re-running completed work
- **Resume** - `agent({ runId })` resumes a durable run from its stored workflow and sessions; optional `task` appends a continuation instruction (required to resume a fully completed run); Pi and Grok ACP units reopen native sessions
- **Reconciliation** - on session start, runs left running by a dead process are automatically marked interrupted

## Local development

The package is not published to a registry yet. Build it and load it with `-e`:

```sh
mise run build --package packages/pi-agents
# monorepo package.json loads packages/*/dist/index.js — rebuild after source changes
pi -e ./packages/pi-agents/dist/index.js
```

## Failure logging

Failed `agent` tool invocations record the complete tool call parameters, failure details, and any captured `Error.stack` / result `errorStack` in `~/.pi/@balaenis/pi-agents/default.log`. Set `PI_AGENTS_LOG_FILE` to override the path. Because task prompts and continuation instructions may contain sensitive information, protect or remove this log as appropriate.

## Durable runs and resume

Every validated invocation creates a durable run record under `~/.pi/agent/@balaenis/pi-agents/runs/<run-id>/`. The per-run layout:

```
<run-id>/
  run.json         # Versioned authoritative run snapshot
  events.jsonl     # Append-only event log (run_created, run_claimed, run_resumed, run_terminal, run_interrupted)
  claims/          # Per-ticket ownership claims
    <ticket>/
      owner.json    # Claim owner (instanceId, pid, acquiredAt)
      terminal.json # Terminal state (released/abandoned)
  sessions/        # Native Pi JSONL session files
```

### Statuses

| Status        | Resumable | Description                                        |
| ------------- | --------- | -------------------------------------------------- |
| `queued`      | Yes       | Created but not yet started                        |
| `running`     | Yes       | Actively executing                                 |
| `completed`   | With task | All units finished; a continuation can reopen them |
| `failed`      | Yes       | One or more units failed                           |
| `cancelled`   | Yes       | Aborted by the user (Ctrl+C)                       |
| `interrupted` | Yes       | Interrupted by session shutdown or process death   |

`cancelled` means the user explicitly aborted (Ctrl+C). `interrupted` means the session shut down or the owning process died. Both are resumable.

### Inspecting and resuming runs

Every successful `agent` result exposes its durable run ID on `details.run.runId`. List and inspect runs with slash commands (model-facing list/get actions are not provided):

```
/agent runs                    # list durable runs
/agent status <run-id>         # get detailed status
/agent resume <run-id>         # print resume guidance (does not start a run)
```

Resume through the same `agent` tool. Stored workflow configuration (mode, agents, tasks, scope, cwd, isolation, model, thinking, runtime, titles, background) is authoritative; conflicting fresh-launch fields are rejected.

```
agent({ runId: "run-abc123..." })
agent({ runId: "run-abc123...", task: "Also verify the migration path." })
```

Optional `task` is a continuation instruction appended for units that still run. On a partially finished run, completed sibling units stay immutable and are not re-dispatched. A fully `completed` run can be resumed only when a non-empty `task` is supplied: finished units are then reopened so the continuation can continue from stored sessions. Resuming a completed run with `runId` alone is rejected (`completed_without_continuation`). Continuation prompts are durable run data and may contain sensitive information.

### Pi and Grok ACP resume

| Runtime    | Capability | Resume behavior                         |
| ---------- | ---------- | --------------------------------------- |
| `pi`       | `session`  | Reopen native Pi session file           |
| `grok-acp` | `session`  | `session/load` with protocol session ID |

- **Pi-runtime units with a stored session** reopen the native Pi session with a safety-oriented continuation prompt plus every **undelivered** continuation instruction for that unit. Already-delivered continuations are not resent. The original task is not resent.
- **Grok ACP units with a stored `acpSessionId`** call ACP `session/load` with the original cwd/worktree, then send only the fixed continuation prompt plus undelivered instructions. The original task is never resent. Attempted units without a stored ID fail closed (`acp_session_unavailable`).
- **Never-started units** (Pi or Grok ACP, queued/skipped with no attempt history) create their first session and receive the resolved original task plus every continuation instruction recorded on the run.
- Continuation delivery is tracked per unit (`continuationDelivery`). Pi marks delivery after spawn/RPC activate accepts the prompt. **Grok ACP** marks delivery only after the matching `session/prompt` response (and awaits a strict durable write). Crash after claim, background-mode rejection, or partial dispatch leaves undelivered instructions for the next resume.
- Grok ACP run records store the protocol session ID and original cwd/worktree only — never private paths under `~/.grok/sessions`. Cross-machine restore and recovery after deleting Grok storage are unsupported.

### Chain fanout resume

When a chain step expands a structured array into parallel items, the expansion is frozen before any worker is scheduled. The ordered item list and one durable unit record per scheduled item are written to `run.json` under `workflowState.fanouts` and `units`. Resume never recomputes the expansion from mutable upstream output; it reuses the stored mapping.

Two resume modes apply:

- **Selective resume** (any incomplete unit, including skipped): completed fanout children keep their terminal results and are not re-dispatched; only incomplete children run, in original order.
- **Fully completed continuation** (every unit completed and a non-empty `task` is supplied): every completed fanout child is reopened and redispatched with the continuation; frozen mappings are still required and validated before claim. Stale completed presentation slots do not skip reopened children.

Each item has a canonical unit id such as `chain-0002-fanout-0003` (one-based step, one-based display position). Items that never started remain `queued` with attempt `1`; items that already ran advance their attempt on resume. Fanout runs that lack a valid stored mapping (including fully completed fanouts resumed with a continuation) are refused rather than reconstructed — start a fresh chain instead. See [How-to: Resume an interrupted fanout](./docs/how-to.md#resume-an-interrupted-fanout) and [Reference: Durable runs](./docs/reference.md#durable-runs).

### Interactive agent navigator (TUI)

In interactive TUI mode, Pi and Grok ACP units register a branch-scoped link so you can inspect them live (Pi over RPC; Grok ACP over a long-lived ACP transport):

```
/agent view              # open navigator (works while the host agent is busy)
Ctrl+Alt+Down            # same shortcut
```

`/agent view` opens in the input/editor area (non-overlay `ui.custom`, same surface as `/settings`) with a candidate list styled like the prompt autocomplete list. Escape restores the host editor; Enter on an endpoint opens its detail transcript.

The below-editor agent list appears only while at least one visible agent is `starting` or `running`, and **lists only those running endpoints** (plus the open hint). Idle, detached, error, and other non-running endpoints are omitted from the chrome and remain reachable from `/agent view`. While the navigator is open, that list (including the open hint) is hidden so it does not duplicate the navigator rows; it is restored after the navigator closes if any agent is still active.

List/widget status glyphs (Agent Nav uses the same mapping for every endpoint):

| State                                                             | Glyph | Theme color |
| ----------------------------------------------------------------- | ----- | ----------- |
| Running (`starting` / `running`)                                  | `◐`   | `warning`   |
| Completed (idle / detached / registered)                          | `●`   | `text`      |
| Interrupted (settled with `stopReason: aborted` or `interrupted`) | `⊘`   | `warning`   |
| Error (`error` / `unavailable`)                                   | `●`   | `error`     |

| Control (detail view) | Behavior                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Enter                 | Pi: steer when running, prompt when idle/detached/error. Grok ACP: prompt only when not running |
| Alt+Enter             | Pi: queue follow-up when running; prompt otherwise. Grok ACP: prompt only when not running      |
| Ctrl+X                | Abort/cancel only the selected child's current turn                                             |
| Ctrl+O                | Toggle last-15-line preview vs full transcript                                                  |
| Escape                | Return to the navigator list                                                                    |
| Up/Down / End         | Scroll transcript / resume tail-follow                                                          |

Detail opens in a **last-15-line** tail preview (fixed height, not terminal-row dependent). Use **Ctrl+O** to expand the full content; Ctrl+O again collapses to the last 15 lines and jumps back to the tail. Grok ACP history hydrates lazily on first detail open via a hydrate-only ACP `session/load` (no model prompt).

**Scope and limits (Version 1):**

- Pi and Grok ACP units linked to the current host session (no cross-process attachment; one writer per session inside the current Pi process)
- Links are host-session and active-branch scoped (forked/imported sessions do not inherit trusted links)
- Up to four idle children stay attached; others detach and reopen lazily (Pi RPC or Grok ACP `session/load`)
- Linked clean worktrees are retained (no automatic pruning) so interactive reattach keeps a valid cwd
- Child slash commands and extension UI dialogs are cancelled/rejected
- Post-completion interactive messages stay in the child session only — they do not rewrite the durable unit result or enter main-model context. The one exception is a continuation sent after the original tool-call activation was interrupted/cancelled: once that continuation settles, its final output is relayed back to the bound host model as a clearly-marked interactive continuation. Normal completed agents never relay.
- Sessions created before this feature have no interactive links

See [How-to: Interactive agent view](./docs/how-to.md#interactive-agent-view) and [Reference: Interactive agent view](./docs/reference.md#interactive-agent-view).

### Privacy and disk growth

Run records contain prompts, transcripts, outputs, cwd paths, and possibly sensitive tool results. Protect and manually remove them according to your retention policy. Version 1 performs no automatic pruning. To delete a run, remove its complete `<run-id>/` directory only when the run is not active. Linked interactive worktrees are also retained until you remove them manually.

## Documentation

- [Tutorial: Get started with subagents](./docs/tutorials.md) - load the extension and run your first agents
- [How-to guides](./docs/how-to.md) - parallel runs, chains, structured output, fanout, resume, worktree isolation, slash commands, background agents, Grok runtimes
- [Reference](./docs/reference.md) - frontmatter fields, config overrides, tool modes, durable runs, bundled agents, `stopReason` values, environment variables
- [Explanation](./docs/explanation.md) - security model, nesting control, durable fanout expansion, fork context, package-agent discovery, Grok runtimes

## Bundled agents

| Agent      | Purpose              | Tools                         | Nested agents                    |
| ---------- | -------------------- | ----------------------------- | -------------------------------- |
| `explore`  | Fast codebase recon  | `read, grep, find, ls, bash`  | disabled (`maxSubagentDepth: 0`) |
| `planner`  | Implementation plans | `read, grep, find, ls, write` | disabled (`maxSubagentDepth: 0`) |
| `reviewer` | Code review          | `read, grep, find, ls, bash`  | disabled (`maxSubagentDepth: 0`) |
| `general`  | General-purpose      | (all default)                 | follows `PI_AGENT_MAX_DEPTH`     |

The package also ships prompt templates: the `/implement`, `/explore-and-plan`, and `/implement-and-review` workflow prompts, plus `/work-with-grok` for delegating a task to the Grok ACP runtime. See [How-to guides](./docs/how-to.md#use-the-bundled-workflow-prompts).

## Development

```sh
mise run typecheck --package packages/pi-agents
mise run test --package packages/pi-agents
mise run build --package packages/pi-agents
hk check
```

## License

See [LICENSE](../../LICENSE).
