# Tutorial: Get started with subagents

This tutorial walks a newcomer from a built extension to a running multi-agent
workflow. You will load the extension, invoke a single agent, read its output,
then try parallel and chained execution.

It assumes you are familiar with [Pi](https://github.com/earendil-works/pi) and
have the repo checked out locally.

## Prerequisites

- The `pi` CLI installed and on `PATH`.
- This repo checked out.
- [`mise`](https://mise.jdx.dev) and [`bun`](https://bun.sh) for building.

## 1. Build and load the extension

The package is not published to a registry yet, so load it from a local build:

```sh
mise run build --package packages/pi-agents
pi -e ./packages/pi-agents/dist/index.js
```

Pi now has the `agent` tool and the `/agent` slash command.

## 2. Invoke your first agent

Ask Pi to delegate a read-only task to the bundled `explore` agent:

```
Use explore to find all authentication code
```

Pi calls the `agent` tool, which spawns an isolated `pi` subprocess with the
`explore` system prompt and the tools it declares (`read`, `grep`, `find`, `ls`,
`bash`). The agent works in its own context window and streams progress back.

## 3. Read the output

While the agent runs, the collapsed view is a compact live summary: status
glyph, agent name, truncated task preview (or a short `title`), usage, and at
most one latest activity line. Pass an optional `title` (aim for ~30 characters;
longer values are accepted and clamped when rendered) on a single call,
parallel task, chain step, or fanout step to label it in the collapsed summary; see
[How-to: collapse titles](./how-to.md#give-a-step-a-short-collapse-title).

- **Collapsed view** (default): one status line (`✔`/`✗`/outline-fill spinner
  `▫▪□■` while a live partial run is collapsed/`⧗` static fallback/`⊘`/`·`),
  agent, truncated task or a short `title`, usage (fields appear as they become
  known - for `grok-acp`, ctx can stream mid-turn), and a single latest tool/text
  line while running. The spinner is driven by one shared 100ms ticker across
  concurrent agent tool calls and stops when the result is final, expanded, or
  the session/tree tears down. Completed runs hide activity and final output
  until you expand.
- **Expanded view** (Ctrl+O): complete retained compact presentation plus final
  output — full task text, bounded assistant/tool-call presentation, final
  response once, error/worktree/structured-output details when present, and
  usage. The Agent View transcript is bounded retained history, not a raw dump.
  Raw/full native child history is available only for reloadable native sessions
  (Pi `sessionFile` or Grok ACP `session/load`). Running expanded rows use the
  static `⧗` glyph (no continuous invalidate).

When the agent finishes, its final output is returned to the parent model so it
can act on the findings.

## 4. Run agents in parallel

Give Pi several independent tasks at once:

```
Run 2 explores in parallel: one to find models, one to find providers
```

The parallel collapsed view shows one summary line per task (latest activity
only under running tasks) and a `Total: n/m completed` footer with aggregate
usage. Expand with Ctrl+O for each task's complete retained/bounded Agent View
presentation plus final output. Each completed task's final output is returned
to the parent, capped at 50 KB per task.

## 5. Chain agents together

Chain steps pass earlier outputs to later steps with `{previous}` (the
immediately preceding step) or `{outputs.<name>}` (any earlier named step):

```
Use a chain:
  - { agent: explore, name: context, task: "find the read tool" }
  - { agent: planner, name: plan, task: "suggest improvements using {previous}" }
  - { agent: general,                 task: "implement {outputs.plan}" }
```

Each step runs in order. A reference to an unknown name stops the chain before
the step spawns and returns `Unknown chain output: <name>`.

## Next steps

- [How-to guides](./how-to.md) for specific tasks like worktree isolation,
  structured outputs, and background agents.
- [Reference](./reference.md) for the full frontmatter field table, tool modes,
  and `stopReason` values.
- [Explanation](./explanation.md) for the security model, nesting control, and
  runtime design.
