# Agent Output Rendering Contract

Collapsed views are compact status summaries with at most one latest activity.
Expanded views retain complete tasks, transcripts, final output, errors, and workflow progress.
The `subagent … [scope]` call title is not shown; the result view is the visible tool block.

Background launch and notification layouts are outside this redesign except where shared status types require compatibility.

## Status glyphs

| Status    | Glyph        | Notes                                                                                                                                                              |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| queued    | `·`          | Muted waiting glyph                                                                                                                                                |
| running   | `▫▪□■` / `⧗` | Outline-fill spinner only for live collapsed partial results; static `⧗` for expanded, background launch, history/final (`isPartial=false`), and non-TUI fallbacks |
| completed | `✔`          | Terminal success                                                                                                                                                   |
| failed    | `✗`          | Terminal failure                                                                                                                                                   |
| cancelled | `⊘`          | User abort / cancellation                                                                                                                                          |
| skipped   | `–`          | Muted; unstarted after failure                                                                                                                                     |

Collapsed running animation steps through `▫ ▪ □ ■` every 100ms via a single shared `setInterval` that `invalidate()`s every armed tool row. Tickers arm only when `ToolRenderResultOptions.isPartial === true` and the view is collapsed with running details; session/tree teardown and `tool_execution_end` clear them.

## Execution summary line

Common shape for a Single, Parallel task, or sequential Chain step:

```text
{glyph} {agent} ({task preview}) · {usage} {model} • {thinking}
```

- Task preview is truncated first when width is tight.
- Glyph, agent, and progress counters are preserved before truncating task text.
- Usage moves to a continuation line only when it cannot fit on the summary line.
- Aggregate multi-unit usage sums token/turn fields, uses the maximum `contextTokens` formatted as `ctx:max N`, and never includes model or thinking.

## Single

### Collapsed

Queued / empty (not yet started):

```text
· explore (pending task...) ·
(ctrl+o to expand)
```

Running (glyph animates through ▫ ▪ □ ■):

```text
▪ explore (探索当前项目的整体结构...) · 9 turns ↑20k ↓6.5k R148k ctx:9.4k grok-4.5 • high
  └─ read ~/workspace/my/pi-myagent/.gitignore
(ctrl+o to expand)
```

Completed (no latest activity, no final output in collapse):

```text
✔ explore (探索当前项目的整体结构...) · 9 turns ↑20k ↓6.5k R148k ctx:9.4k grok-4.5 • high
(ctrl+o to expand)
```

Failed (optional latest activity only when it explains the failure; error summary on its own line when present):

```text
✗ explore (探索当前项目的整体结构...) · 2 turns ↑1k ↓200 grok-4.5 • high
  Error: Agent exceeded maxTurns=2
(ctrl+o to expand)
```

Cancelled:

```text
⊘ explore (探索当前项目的整体结构...) · 1 turn ↑500 ↓100
(ctrl+o to expand)
```

Empty output when completed with no messages:

```text
✔ explore (empty task) · 0 turns
(ctrl+o to expand)
```

Rules:

- At most one latest-activity line while `running`.
- Completed results do not show latest activity or final output in collapse.
- Expand hint is always shown in collapse.

### Expanded

```text
─── Task ───
探索当前项目的整体结构，包括目录布局、主要文件、配置文件、源码组织方式、技术栈等

─── Output ───
→ read ~/workspace/my/pi-myagent/.gitignore
→ $ cd /home/julian/workspace/my/pi-myagent && for f in packages...
→ read ~/workspace/my/pi-myagent/packages/system-prompts/rules/system-append.gpt56.md

<continuing assistant text from earlier turns>

─── Final ───
<final assistant response once>

─── Error ───
(when failed or cancelled, full errorMessage / stopReason)

─── Worktree ───
(when retained: path, dirty flag, diff stat, changed files)

─── Structured output ───
(when structuredOutputError or validated structuredOutput is present)

✔ explore (探索当前项目的整体结构...) · 9 turns ↑20k ↓6.5k R148k ctx:9.4k grok-4.5 • high
```

Sections present only when relevant. Final assistant text appears exactly once under Final, not again under Output.

## Parallel

### Collapsed

One summary line per task in input order. At most one latest-activity line under each running task. Queued, completed, failed, cancelled, and skipped tasks show no activity history.

```text
✔ explore (探索项目结构...) · 5 turns ↑12k ↓2k grok-4.5 • high
▪ reviewer (审查模型服务...) · 4 turns ↑8k ↓1k openai-codex/gpt-5.6 • high
  └─ read src/services/models.rs
· general (queued task...) ·
Total: 1/2 completed · 9 turns ↑20k ↓3k R40k ctx:max 12k
(ctrl+o to expand)
```

Aggregate footer: completed count over total tasks, aggregate usage (`ctx:max N`, no model/thinking).

### Expanded

Available while running and after terminal settlement (not only when all tasks finish). For each task in input order: full task, complete transcript, final output, error/worktree/structured-output details, and per-task usage. Footer repeats aggregate progress and aggregate usage.

## Sequential Chain

Logical steps are authoritative. `results` are execution-unit snapshots; Chain progress never uses `results.length` as the step count.

### Collapsed

One line per started logical step. Queued future steps are omitted. At most one latest-activity line under the active sequential step.

```text
✔ 1. explore (分析当前实现...) · 5 turns ↑12k ↓2k grok-4.5 • high
▪ 2. planner (制定实施计划...) · 4 turns ↑8k ↓1k openai-codex/gpt-5.6 • high
  └─ read docs/spec.md
Chain: step 2/3 · 1 completed · 9 turns ↑20k ↓3k R40k ctx:max 12k
(ctrl+o to expand)
```

Completed:

```text
✔ 1. explore (分析当前实现...) · 5 turns ↑12k ↓2k grok-4.5 • high
✔ 2. planner (制定实施计划...) · 4 turns ↑8k ↓1k openai-codex/gpt-5.6 • high
✔ 3. general (implement the plan...) · 6 turns ↑10k ↓3k grok-4.5 • high
Chain: step 3/3 · 3 completed · 15 turns ↑30k ↓6k R40k ctx:max 14k
(ctrl+o to expand)
```

After failure or cancellation, the footer reports the terminal state and any skipped later steps:

```text
✔ 1. explore (分析当前实现...) · 5 turns ↑12k ↓2k grok-4.5 • high
✗ 2. planner (制定实施计划...) · 1 turn ↑1k ↓200
Chain: step 2/3 · 1 completed · failed · 1 skipped · 6 turns ↑13k ↓2.2k R20k ctx:max 10k
(ctrl+o to expand)
```

Cancelled active step:

```text
✔ 1. explore (分析当前实现...) · 5 turns ↑12k ↓2k grok-4.5 • high
⊘ 2. planner (制定实施计划...) · 1 turn ↑1k ↓100
Chain: step 2/3 · 1 completed · cancelled · 1 skipped · 6 turns ↑13k ↓2.1k R20k ctx:max 10k
(ctrl+o to expand)
```

Footer fields: current step, completed logical-step count, terminal failure/cancellation when applicable, skipped count when non-zero, aggregate usage.

### Expanded

Sequential steps in input order. Each step shows full task, ordered transcript, one final output, error/worktree/structured-output details, and usage. Chain footer uses logical totals.

## Fanout Chain

A fanout is one logical Chain step in collapse regardless of how many items execute. `collect` is metadata/named output on that step, not a separate executable step.

### Collapsed

```text
✔ 1. planner (生成审查目标...) · 4 turns ↑8k ↓1k grok-4.5 • high
▪ 2. reviewer fanout (审查每个目标...) · 3/8 done, 4 running, 1 queued · 12 turns ↑24k ↓4k
  └─ [5/8] read src/models.ts
Chain: step 2/3 · 1 completed · 16 turns ↑32k ↓5k R60k ctx:max 14k
(ctrl+o to expand)
```

Rules:

- One numbered logical-step summary with real done/running/queued/failed/skipped counts.
- Under a running fanout, only the globally latest fanout activity, prefixed with one-based `[item/total]`.
- Individual fanout items are not listed in collapse.
- Empty source array is a successful `0/0` fanout.
- Skipped source items (`maxItems`) appear in counts only; they do not receive fake results or usage.

Failed fanout after all items settle:

```text
✔ 1. planner (生成审查目标...) · 4 turns ↑8k ↓1k grok-4.5 • high
✗ 2. reviewer fanout (审查每个目标...) · 2/3 done, 1 failed · 8 turns ↑16k ↓3k
Chain: step 2/3 · 1 completed · failed · 1 skipped · 12 turns ↑24k ↓4k R40k ctx:max 12k
(ctrl+o to expand)
```

### Expanded

- Fanout logical step shows expand source, JSON Pointer path, task template, collect name, concurrency, skipped source count, and each executed item in original order.
- Each item: rendered task, status, transcript, final output, error details, usage.
- Collect completion is shown as fanout metadata (named output), not an extra Chain step.

## Compatibility fallback

Older session details without `chain` metadata or per-result `status`:

- Infer status conservatively: `exitCode === -1` → running; `stopReason === 'aborted'` → cancelled; failed exit/stop → failed; else completed.
- Render Chain steps from existing `results` and `step` values without inventing queued future steps or fanout counters that cannot be known.

## Empty / unknown tool results

When details are missing or `results` is empty, show the textual content payload (or `(no output)`) with no status glyph.
