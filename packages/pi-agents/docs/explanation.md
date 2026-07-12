# Explanation

Why `@balaenis/pi-agents` behaves the way it does. This section clarifies the
security model, nesting control, runtimes, and design decisions. For step-by-step
recipes see [How-to guides](./how-to.md); for field tables see
[Reference](./reference.md).

## Security model

Each invocation spawns a separate `pi` subprocess with a delegated system prompt
and tool/model configuration. The two prompt sources have different trust
levels.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can
instruct the model to read files, run bash, etc. They load under `agentScope:
"project"` or `"both"` (the default).

**Package agents** are agents exposed by packages installed via `pi install`.
They are discovered from the `packages[]` entries in `~/.pi/agent/settings.json`
(user scope) and `.pi/settings.json` (project scope), by reading each package's
`package.json#pi.agents` field. They run with the same privileges as project
agents.

The default `agentScope: "both"` loads user-level agents from
`~/.pi/agent/agents`, user-scope package agents from
`~/.pi/agent/settings.json#packages`, project-local agents from `.pi/agents`,
and project-scope package agents from `.pi/settings.json#packages`. Project
agents override user agents with the same name. Pass `agentScope: "user"` to
skip project sources, or `agentScope: "project"` to skip user sources. Only
enable project sources for repositories you trust.

`worktreeSetupHook` is shell input sourced from an agent definition and runs in
the project on `isolation: "worktree"` agents - treat it like any other agent
body and only declare it for trusted sources.

## Tool permissions

Agent permissions map directly onto the Pi CLI:

- `tools` -> `pi --tools <list>` (allowlist; omit to inherit every host tool)
- `excludeTools` -> `pi --exclude-tools <list>` (denylist, applied after the
  allowlist)

Tool names are passed through after trimming; lower-casing only happens when the
author writes them that way.

## Nested agents and the depth guard

The tool ships two layers of nesting control to prevent runaway fan-out.

**Global depth limit.** Every spawned child carries `PI_AGENT_CHILD=1`,
`PI_AGENT_DEPTH=<n>`, and `PI_AGENT_MAX_DEPTH=<n>` (default `2`). The tool
refuses to start a new child when `PI_AGENT_DEPTH >= PI_AGENT_MAX_DEPTH`. Raise
it by exporting `PI_AGENT_MAX_DEPTH` before launching `pi` - but do so carefully,
since anything past depth 2 increases the chance of runaway fan-out.

**Per-agent `maxSubagentDepth`.** An agent can declare how many additional
nested `agent` delegations it may make. `0` means the agent can be invoked but
cannot itself call `agent`. The effective child max is
`min(PI_AGENT_MAX_DEPTH, currentChildDepth + maxSubagentDepth)`; it can only
narrow the global limit, never widen it.

When a child cannot delegate (depth, `tools`, `excludeTools`, or
`maxSubagentDepth`), the parent:

1. Spawns the child with `--exclude-tools agent` (in addition to the agent's own
   `excludeTools`) so the model-visible toolset omits `agent`.
2. Sets `PI_AGENT_TOOL_AVAILABLE=0` in the child env as a runtime backstop.
3. Skips the `before_agent_start` "Available agent types" catalogue injection in
   the child, so the model is not told about agents it cannot reach.

> **Threat model note.** `maxSubagentDepth` and `PI_AGENT_TOOL_AVAILABLE` are
> LLM-side guardrails for the `agent` tool. They prevent the model from invoking
> `agent` again, but they do not sandbox other tools. An agent that still has
> `bash` (or any other tool capable of starting `pi`) could spawn a new
> top-level `pi` process. Treat this field as a delegation-policy switch, not a
> security boundary; for hostile prompts, also restrict `tools`.

## Completion check

`completionCheck` is an opt-in final-output contract. When set, it is treated as
a comma-separated list of required headings (e.g.
`completionCheck: "## Goal, ## Plan, ## Files to Modify, ## Risks"`). The check
inspects the final assistant message for each heading as an exact line
(case-insensitive, line-anchored). On failure it sets
`stopReason: "completion_check"`, fills `errorMessage` with the missing
headings, and forces exit code `1`. The check does not infer behavior from
`tools`/`excludeTools`/`edit`/`write`/`bash`; agents opt in explicitly.

Among the bundled agents, `planner` and `reviewer` declare `completionCheck`.
The `worker` agent does not; the bundled workflow prompts (`/implement`,
`/implement-and-review`) instead ask the worker to include the `## Completed`,
`## Files Changed`, `## Validation` headings via their task text.

When a chain step declares `outputSchema`, `completionCheck` is bypassed for
that step because the contract requires JSON-only output.

## Worktree setup hook

`worktreeSetupHook` runs inside the freshly created worktree before the child
runtime starts (only when `isolation: "worktree"`). Typical uses are dependency
installs or generated-file builds the child relies on (`bun install`,
`pnpm install --frozen-lockfile`, `make bootstrap`).

- Launched with `spawnSync(command, { cwd: worktreePath, shell: true })`,
  inheriting the parent's environment.
- A non-zero exit or spawn error returns a synthetic failure with
  `stopReason: "worktree_setup_error"`, exit code `1`, and a truncated tail of
  stderr/stdout in `errorMessage` / `worktreeSetupError`.
- After a hook failure the worktree is removed when `git status --porcelain` is
  clean; otherwise it is retained and surfaced via `worktreePath` +
  `worktreeDirty: true`.

After a successful child run, dirty worktrees additionally expose
`worktreeDiffStat` (`git diff --stat --no-ext-diff HEAD`) and
`worktreeChangedFiles` (the union of `git diff --name-only --no-ext-diff HEAD`
and untracked files from `git ls-files --others --exclude-standard`).

## Fork context

`defaultContext: "fork"` lets an agent branch the parent session instead of
starting fresh:

1. Reads the parent session's leaf id and session file from `ctx.sessionManager`.
2. Opens it with `SessionManager.open()` and calls `createBranchedSession(leafId)`
   to materialize a new session file containing only the path to the current
   leaf.
3. Spawns the child `pi` with `--session <branched-file>` (the parent's session
   file is never passed directly).

Fork returns `stopReason: "context_error"` with one of these `stderr` messages
when prerequisites are missing:

- `Cannot fork parent context: parent session is not persisted`
- `Cannot fork parent context: parent session file does not exist: <path>`
- `Cannot fork parent context: current session has no leaf entry`

In `--no-session` parent runs, `fork` does not silently fall back to fresh
context.

## Skills resolution

`skills` is a comma-separated list of skill **names** (as they appear in the
host's `<available_skills>` catalogue), not paths. When non-empty, the child is
launched with `--no-skills` plus one `--skill <path>` per resolved name, so only
the listed skills load and default discovery is disabled.

Name-to-path resolution uses the skills the host already discovered. The
`before_agent_start` hook captures `event.systemPromptOptions.skills` and caches
the name-to-`filePath` mapping; the cache refreshes on every host agent loop and
before `/agent` slash-command invocation (which bypasses `before_agent_start`).
Resolved paths are the absolute `filePath` values reported by the host, so they
stay valid regardless of the child's working directory (including worktree
isolation).

`skills` takes precedence over `noSkills`: a non-empty list always emits
`--no-skills` + `--skill`, even when `noSkills: true`. Use `noSkills: true`
alone to disable all skills; use `skills` to allowlist specific ones.

## Package agents discovery

Any pi-installed package can publish agents by declaring a `pi.agents` field in
its `package.json`. The field can be a string or an array of strings, and each
entry may point to a directory of `.md` files or a single `.md` file relative to
the package root.

Packages are discovered from the `packages[]` arrays in pi's settings files
(user: `~/.pi/agent/settings.json`; project: nearest ancestor `.pi/settings.json`).
Sources resolve under `~/.pi/agent/{npm,git}/` (user) or `.pi/{npm,git}/`
(project). `npm:` and `git:` sources, bare `https://`/`ssh://`/`git://` URLs,
and local paths are accepted; SCP shorthand requires the explicit `git:` prefix.
When a package identity appears in both user and project settings, the project
entry wins.

Discovered package agents are namespaced by the package name. An agent declared
as `name: reviewer` inside `@acme/pi-frontend` is invocable as
`@acme/pi-frontend.reviewer`; the local name is preserved on
`AgentConfig.localName` and the publishing package on `AgentConfig.packageName`.
Package agents are not pulled from a project's `dependencies`/`node_modules`;
only packages explicitly listed in a pi settings file are considered.

## Grok streaming-json vs ACP

Two Grok runtimes are supported. They are opt-in and do not replace each other.

**`runtime: "grok"`** spawns `grok -p --output-format streaming-json` and remains
fully supported. Field mapping: `model` -> `--model`; `thinking` (downgraded to
3 levels) -> `--effort`; `maxTurns` -> `--max-turns`; `systemPrompt` (append) ->
`--rules`; `systemPrompt` (replace) -> `--system-prompt-override`; `tools` ->
`--tools`; `excludeTools` -> `--disallowed-tools`. Hardcoded flags:
`--no-auto-update`, `--always-approve`, `--output-format streaming-json`,
`--no-memory`, `--no-subagents`.

`thinking` -> `effort` downgrade: `off` -> omitted; `minimal`/`low` -> `low`;
`medium` -> `medium`; `high`/`xhigh`/`max` -> `high`.

Streaming-json caveats: no usage stats (usage is all zeros; `turns` reflects
assistant turns detected via thought boundaries); no tool-call visibility
(`messages` has no `toolCall` parts; text is split into one assistant message
per turn); `EndTurn` -> `end`, `Cancelled` -> `max_turns`; skills are no-ops (a
warning is emitted if `skills` is set); `worktreeSetupHook` still runs;
`defaultContext: "fork"` is treated as `fresh` with a warning; tool names are
runtime-specific and passed through as-is; `--system-prompt-override` may not
fully suppress Grok's defaults; Grok ignores nesting env vars and always passes
`--no-subagents`.

**`runtime: "grok-acp"`** spawns `grok agent … stdio` and speaks ACP v1 over
NDJSON. Process invocation:
`grok agent [--model <model>] [--reasoning-effort <effort>] --always-approve --no-leader stdio`,
with `GROK_DISABLE_AUTOUPDATER=1`, `GROK_MEMORY=0`, `GROK_SUBAGENTS=0` in the
env. Configuration is passed via `session/new._meta`: `systemPrompt` (append) ->
`_meta.rules`; (replace) -> `_meta.systemPromptOverride`; `tools`/`excludeTools`
-> `_meta.agentProfile.tools`/`.disallowedTools`; `maxTurns` is **ignored** (not
sent in CLI, env, session meta, or prompt).

ACP behavior: after `initialize`, the client selects an auth method
(`_meta.defaultAuthMethodId` when valid, else `xai.api_key` when `XAI_API_KEY` is
set, else `cached_token`, else fails with instructions); `tool_call`/
`tool_call_update` events become assistant `toolCall` parts; token/cache fields
from prompt-response `_meta` and `usage_update` notifications populate
`SingleResult.usage` (cost when currency is `USD`); `AbortSignal` sends
`session/cancel`, cancels pending permissions, then SIGTERM/SIGKILL (the public
run still throws `Subagent was aborted`); the client advertises empty
`clientCapabilities` so Grok uses its own built-in tools. Skills and fork context
behave as in streaming-json (ignored/treated as fresh with a warning).

**Progressive usage (grok-acp):** During a turn, standard `usage_update`
notifications may set `cost` and/or `contextTokens` while input/output/cache
fields are still unknown (zeros). Cost is collected but not shown; the UI shows
only the other fields that are already known (e.g. `ctx:111 model`). When the
`session/prompt` response `_meta` arrives at turn end, the full breakdown
(`turns`, `↑input`, `↓output`, cache read/write, ctx, model) is shown together.
Zero/unknown fields are never printed as misleading zeros.

## Output display

Collapsed output is intentionally a compact live summary: status glyph
(outline-fill spinner ▫▪□■ while a live partial result is collapsed and
running; static ⧗ for expanded running views, background launch notices, and
history/final renders; ✔ completed, ✗ failed, ⊘ cancelled, · queued), agent
name, truncated task preview, usage, and at most one latest activity line
while running. Animation advances every 100ms through a single shared ticker
that invalidates all armed tool rows; it never starts from restored or
non-partial renders even if details still say running. Completed Single
results hide activity and final output until expanded. Use Ctrl+O for the
full task, ordered transcript, final output (once), and
error/worktree/structured-output details. Tool-call formatting mimics Pi's
built-in tools (`$ command` for bash, `read ~/path:1-10` for read,
`grep /pattern/ in ~/path` for grep, etc.).

Parallel mode shows one summary line per task in input order, latest activity
only under running tasks, and a `Total: n/m completed` footer. Aggregate usage
sums token/turn fields, uses the maximum execution-unit context as `ctx:max N`,
and never includes model or thinking (those stay per execution unit).

Chain mode tracks logical steps separately from execution units. Sequential
steps appear as numbered summaries; a fanout is one logical step with real
done/running/queued/failed counts and a single latest activity prefixed
`[item/total]`. Collect names are fanout metadata, not extra Chain steps.
The footer reports current step, completed logical-step count, and aggregate
usage.
