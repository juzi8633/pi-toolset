# Reduced-heap soak 测试说明

本说明用于在真实 Pi 前台进程中，以 512 MiB V8 old-space 上限重复运行混合 subagent 工作流，验证 parent 进程不会因 child 原始 tool-result 被重复保留而发生堆耗尽，同时检查 compact parent presentation、durable `run.json`、fanout、interruption 和 resume 行为。

## 适用对象

本说明面向维护 `@balaenis/pi-agents` 的开发者。执行者应熟悉终端、Pi TUI 和基本 shell 命令，并已配置可用的模型凭据。

## 验收目标

测试至少覆盖 10 次顶层 `agent` 调用：

1. 一个长 Pi Single，反复执行 `read`、`grep` 和非破坏性 `bash`。
2. 一个八任务 Parallel。
3. 一个 structured-output seed → 八项 fanout → final collect Chain。
4. 一个后台 durable run，在执行中关闭 parent Pi，随后重启并 resume。
5. 其余调用使用较短的只读 Single，补足至少 10 次。

测试通过应满足：

- parent Pi 未出现 `JavaScript heap out of memory`。
- Parallel、Chain、fanout、interruption 和 resume 均达到正确终态。
- `run.json` 保留 final output、structured output、usage、status 和 session identity，但不重复保存 child 原始 tool-result body。
- parent session 和 `run.json` 的增长量与 compact presentation/final output 相符，而不是与全部 child tool output 总量相符。
- Ctrl+O 在运行中和终态下均能正确显示 retained presentation、final output、usage 和 run identity。

> `NODE_OPTIONS=--max-old-space-size=512` 限制的是 V8 old-space，不是整个进程 RSS。RSS 包含 native memory、代码、buffer 等，因此 RSS 偶尔超过 512 MiB 不直接表示失败。重点观察是否发生 V8 OOM，以及 RSS 是否随原始 tool output 持续近似线性增长。

## 1. 构建待测版本

所有命令都应从待测 worktree 执行。以下路径对应 `fix/subagent-memory-optimization` worktree：

```bash
cd /home/julian/workspace/my/pi-toolset/.worktrees/subagent-memory-optimization

mise run build --package packages/pi-agents
```

创建隔离的测试目录和 parent session 目录：

```bash
SOAK=$(mktemp -d /tmp/pi-agents-memory-soak.XXXXXX)
mkdir -p "$SOAK/parent-sessions"
touch "$SOAK/start-marker"

echo "SOAK=$SOAK"
```

记录输出的完整路径。后续终端必须使用同一个 `SOAK` 值。

隔离 parent session 有两个目的：

- 防止历史 Pi session 干扰 parent session 大小测量。
- interruption 后可以精确找到并重新打开同一个 parent session。

## 2. 启动 reduced-heap parent Pi

在终端 A 中执行：

```bash
sh -c '
  echo $$ > "$1/pi.pid"
  exec env \
    NODE_OPTIONS=--max-old-space-size=512 \
    PI_SKIP_VERSION_CHECK=1 \
    pi \
      --no-extensions \
      --approve \
      --name memory-soak \
      --session-dir "$1/parent-sessions" \
      -e ./packages/pi-agents/dist/index.js
' sh "$SOAK"
```

命令会：

- 将 parent Pi 的准确 PID 写入 `$SOAK/pi.pid`。
- 对 parent Pi 和其继承环境的 child Pi 应用 512 MiB old-space 上限。
- 禁用自动发现的 extension，只显式加载当前 worktree 的构建产物，避免误测已安装的旧版本。
- 将 parent session 写入 `$SOAK/parent-sessions`。

Pi 启动后保持终端 A 打开。

## 3. 采样 RSS 和序列化文件大小

打开终端 B，填入第 1 步输出的 `SOAK` 路径：

```bash
SOAK=/tmp/pi-agents-memory-soak.REPLACE_ME
RUNS="$HOME/.pi/agent/@balaenis/pi-agents/runs"
```

初始化采样文件：

```bash
printf 'timestamp\tpid\trss_kib\tparent_bytes\tnew_run_bytes\n' > "$SOAK/samples.tsv"
printf 'label\tpid\trss_kib\tparent_bytes\trun_id\trun_bytes\tstatus\n' > "$SOAK/checkpoints.tsv"
```

定义后台采样函数：

```bash
start_sampler() {
  local pid
  pid=$(cat "$SOAK/pi.pid")

  (
    while kill -0 "$pid" 2>/dev/null; do
      parent_bytes=$(
        find "$SOAK/parent-sessions" -type f -name '*.jsonl' \
          -printf '%s\n' 2>/dev/null |
          awk '{sum += $1} END {print sum + 0}'
      )

      run_bytes=$(
        find "$RUNS" -type f -name run.json -newer "$SOAK/start-marker" \
          -printf '%s\n' 2>/dev/null |
          awk '{sum += $1} END {print sum + 0}'
      )

      printf '%s\t%s\t%s\t%s\t%s\n' \
        "$(date -Iseconds)" \
        "$pid" \
        "$(ps -o rss= -p "$pid" | xargs)" \
        "$parent_bytes" \
        "$run_bytes" \
        >> "$SOAK/samples.tsv"

      sleep 2
    done
  ) &

  echo $! > "$SOAK/sampler.pid"
}

start_sampler
```

`ps -o rss=` 返回 KiB。`new_run_bytes` 是测试开始后所有新 `run.json` 的当前总大小。

定义逐次 checkpoint 函数：

```bash
record() {
  local label=$1
  local run_id=${2:-}
  local pid
  local parent_bytes
  local run_bytes=0
  local status=none

  pid=$(cat "$SOAK/pi.pid")
  parent_bytes=$(
    find "$SOAK/parent-sessions" -type f -name '*.jsonl' \
      -printf '%s\n' 2>/dev/null |
      awk '{sum += $1} END {print sum + 0}'
  )

  if [[ -n "$run_id" && -f "$RUNS/$run_id/run.json" ]]; then
    run_bytes=$(stat -c '%s' "$RUNS/$run_id/run.json")
    status=$(jq -r '.status' "$RUNS/$run_id/run.json")
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" \
    "$pid" \
    "$(ps -o rss= -p "$pid" | xargs)" \
    "$parent_bytes" \
    "${run_id:-none}" \
    "$run_bytes" \
    "$status" \
    | tee -a "$SOAK/checkpoints.tsv"
}

record baseline
```

每个 `agent` 调用完成后，从 expanded result 或 `/agent runs` 复制 `run-...` ID，再执行：

```bash
record 01-long-single run-REPLACE_ME
```

## 4. 执行 10 次混合调用

推荐矩阵：

| 序号 | 调用类型            | 目的                                            |
| ---: | ------------------- | ----------------------------------------------- |
|    1 | 长 Single           | 制造大量 child tool calls 和 tool results       |
|  2–5 | 四个短 Single       | 观察同一 parent 中重复调用后的增长趋势          |
|    6 | 八任务 Parallel     | 覆盖 aggregate copy-on-write 和 compact results |
|    7 | 短 Single           | 在大型 aggregate 后继续观察 parent 状态         |
|    8 | Chain + 八项 fanout | 覆盖 structured output、fanout 和 collect       |
|    9 | 后台长 Single       | 制造可恢复的 interruption                       |
|   10 | Resume 第 9 次      | 验证 durable session continuation               |

所有任务都应保持只读，避免 soak 测试修改工作区。

### 4.1 长 Single

在 Pi 中输入：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "memory soak long single",
  "task": "Memory soak only; do not modify files. Perform at least 30 tool calls across packages/pi-agents/src and packages/pi-agents/tests, alternating read, grep, and non-destructive bash commands such as git status, wc, and rg. Inspect a variety of files and symbols. Keep the final answer under 20 concise bullets."
}

Return only a short summary of the agent result.
```

运行期间和完成后分别按一次 Ctrl+O，确认：

- collapsed latest activity 正常更新。
- expanded view 显示 retained assistant/tool-call presentation。
- final output 只出现一次。
- usage 和 run identity 正常。
- 若达到 presentation 上限，omission marker 显示正确；若本次未自然触发，则由 deterministic presentation tests 覆盖该行为，不要仅为制造 marker 消耗大量模型 token。

完成后在终端 B 执行：

```bash
record 01-long-single run-REPLACE_ME
```

### 4.2 四个短 Single

依次检查不同区域：

1. `src/result-snapshot.ts` 与 rendering tests。
2. `src/run-store.ts`、`src/run-coordinator.ts` 与 durable tests。
3. `src/chain.ts` 与 fanout tests。
4. `src/interactive-agent.ts` 与 interactive tests。

每次在 Pi 中使用以下模板，并替换 `<AREA>`：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "memory soak short",
  "task": "Read-only memory soak. Inspect <AREA> using 8-12 read, grep, and non-destructive bash tool calls. Do not modify files. Return a concise evidence-based summary."
}

Return only a short summary of the agent result.
```

每次完成后记录：

```bash
record 02-short run-REPLACE_ME
record 03-short run-REPLACE_ME
record 04-short run-REPLACE_ME
record 05-short run-REPLACE_ME
```

每条命令应使用对应调用的真实 `runId`。

### 4.3 八任务 Parallel

在 Pi 中输入：

```text
Call the agent tool exactly once using this parallel request. Do not modify files.

{
  "tasks": [
    {"agent":"explore","title":"inspect output","task":"Read-only: inspect output/result presentation code and tests using several tools; summarize."},
    {"agent":"explore","title":"inspect rendering","task":"Read-only: inspect collapsed/expanded rendering code and tests using several tools; summarize."},
    {"agent":"explore","title":"inspect runtime","task":"Read-only: inspect execution runtime snapshot boundaries and tests using several tools; summarize."},
    {"agent":"explore","title":"inspect durable","task":"Read-only: inspect run store/coordinator durability and tests using several tools; summarize."},
    {"agent":"explore","title":"inspect parallel","task":"Read-only: inspect Parallel copy-on-write aggregation and tests using several tools; summarize."},
    {"agent":"explore","title":"inspect chain","task":"Read-only: inspect Chain/fanout aggregation and tests using several tools; summarize."},
    {"agent":"explore","title":"inspect updates","task":"Read-only: inspect update coalescing and tests using several tools; summarize."},
    {"agent":"explore","title":"inspect interactive","task":"Read-only: inspect interactive transcript retention and tests using several tools; summarize."}
  ],
  "title": "memory soak parallel"
}
```

运行中和完成后使用 Ctrl+O 检查有序 task 状态、latest activity、usage、final output 和 run identity。

完成后记录：

```bash
record 06-parallel run-REPLACE_ME
```

检查该 run 的 durable 文件大小：

```bash
stat -c '%s bytes' "$RUNS/run-REPLACE_ME/run.json"
```

真实大小会受 final/structured output 影响。对于本说明的短 final output，Parallel `run.json` 应明显小于 native child session 总量；合成 regression 的 parent details 门槛为 2 MiB。

### 4.4 第七个短 Single

在 Parallel 后再执行一次 4.2 的短 Single 模板，并记录：

```bash
record 07-short run-REPLACE_ME
```

### 4.5 Structured seed + 八项 fanout Chain

在 Pi 中输入：

```text
Call the agent tool exactly once using:

{
  "chain": [
    {
      "name": "seed",
      "agent": "explore",
      "title": "create file list",
      "task": "Return JSON only: {\"items\":[\"src/output.ts\",\"src/render.ts\",\"src/execution.ts\",\"src/run-store.ts\",\"src/run-coordinator.ts\",\"src/chain.ts\",\"src/update-coalescer.ts\",\"src/interactive-agent.ts\"]}",
      "outputSchema": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 8,
            "maxItems": 8
          }
        },
        "required": ["items"],
        "additionalProperties": false
      }
    },
    {
      "expand": {"from": {"output": "seed", "path": "/items"}, "maxItems": 8},
      "parallel": {
        "agent": "explore",
        "title": "inspect fanout item",
        "task": "Read-only: inspect packages/pi-agents/{item} and its relevant tests using read and grep. Return JSON only with file and summary. Do not edit.",
        "outputSchema": {
          "type": "object",
          "properties": {
            "file": {"type": "string"},
            "summary": {"type": "string"}
          },
          "required": ["file", "summary"],
          "additionalProperties": false
        }
      },
      "collect": {"name": "findings"},
      "concurrency": 4
    },
    {
      "agent": "explore",
      "title": "collect findings",
      "task": "Summarize these fanout findings without editing files: {outputs.findings}"
    }
  ],
  "title": "memory soak chain"
}
```

完成后记录：

```bash
record 08-chain run-REPLACE_ME
```

检查 seed structured output、八项 frozen fanout mapping、collect result 和 final step 均存在。

## 5. 制造 interruption

第 9 次调用使用后台模式和一个足够长的非破坏性 `sleep`，确保 parent 关闭时任务仍在运行。

在 Pi 中输入：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "interrupt soak",
  "task": "Read-only interruption soak. First run a non-destructive bash sleep for 120 seconds, then inspect packages/pi-agents using repeated read and grep calls. Do not modify files.",
  "runInBackground": true
}
```

后台调用会立即返回 `runId`。保存该 ID，然后记录运行中状态：

```bash
record 09-background-running run-REPLACE_ME
```

在 Pi 中确认该 run 仍为 running：

```text
/agent status run-REPLACE_ME
```

随后在 Pi 中执行：

```text
/quit
```

不要使用 `kill -9`。正常 `/quit` 会触发 extension 的 `session_shutdown`，使正在运行的 durable work 进入可恢复的 `interrupted` 状态。

parent 退出后，在终端 B 检查：

```bash
jq '{status, units}' "$RUNS/run-REPLACE_ME/run.json"
```

预期 run 或未完成 unit 的状态为 `interrupted`。

## 6. 重启 parent 并 resume

找到隔离目录中的 parent session：

```bash
SESSION=$(
  find "$SOAK/parent-sessions" -type f -name '*.jsonl' \
    -printf '%T@\t%p\n' |
    sort -nr |
    head -1 |
    cut -f2-
)

echo "$SESSION"
```

在终端 A 中，从相同 worktree 重启：

```bash
cd /home/julian/workspace/my/pi-toolset/.worktrees/subagent-memory-optimization

sh -c '
  echo $$ > "$1/pi.pid"
  exec env \
    NODE_OPTIONS=--max-old-space-size=512 \
    PI_SKIP_VERSION_CHECK=1 \
    pi \
      --no-extensions \
      --approve \
      --session-dir "$1/parent-sessions" \
      --session "$2" \
      -e ./packages/pi-agents/dist/index.js
' sh "$SOAK" "$SESSION"
```

重启后，终端 B 中原采样循环已随旧 PID 退出。重新调用：

```bash
start_sampler
```

在 Pi 中先检查 durable 状态：

```text
/agent status run-REPLACE_ME
```

然后执行第 10 次调用：

```text
Call the agent tool exactly once using:

{
  "runId": "run-REPLACE_ME"
}

Return only a short summary of the resumed result.
```

完成后记录：

```bash
record 10-resume run-REPLACE_ME
```

预期：

- attempt 已增加。
- 原有 session identity 得到保留。
- 未完成工作继续执行。
- 已完成 sibling 不会在 selective resume 中被错误重跑。
- final output、structured output 和 named/collected outputs 未丢失。
- 最终 durable 状态为 `completed`。

## 7. 汇总结果

格式化 checkpoint 表：

```bash
column -t -s $'\t' "$SOAK/checkpoints.tsv"
```

计算两个 parent 阶段中的最大 RSS：

```bash
awk -F '\t' '
  NR > 1 && $3 + 0 > max { max = $3 + 0 }
  END { printf "peak RSS: %.1f MiB\n", max / 1024 }
' "$SOAK/samples.tsv"
```

列出本次产生的 `run.json`：

```bash
find "$RUNS" -type f -name run.json -newer "$SOAK/start-marker" \
  -printf '%s\t%p\n' |
  sort -n |
  numfmt --field=1 --to=iec
```

比较每个 run 的 compact `run.json` 和 native child sessions：

```bash
for run in "$RUNS"/run-*; do
  [[ "$run/run.json" -nt "$SOAK/start-marker" ]] || continue

  echo "== $(basename "$run") =="
  du -h "$run/run.json"

  find "$run/sessions" -type f -printf '%s\n' 2>/dev/null |
    awk '{sum += $1} END {printf "child sessions: %.2f MiB\n", sum / 1048576}'
done
```

检查所有新 durable results 是否仍含 raw messages：

```bash
find "$RUNS" -type f -name run.json -newer "$SOAK/start-marker" -print0 |
  xargs -0 jq -r '
    . as $run
    | [
        (.details.results[]? | select((.messages // []) | length > 0)),
        (.units[]?.result? | select((.messages // []) | length > 0))
      ]
    | select(length > 0)
    | $run.runId
  '
```

对于本次新建并完成的 compact run，该命令通常应无输出。若有输出，检查它是否为预期 legacy fixture，而不是新运行路径重新写入完整 transcript。

## 8. 通过与失败判定

### 通过

同时满足以下条件：

- 至少 10 次顶层调用已执行。
- 无 V8 heap OOM，parent Pi 始终可交互。
- 第 9 次正确进入 `interrupted`，第 10 次 resume 后完成。
- Parallel/fanout result 顺序、状态、usage、structured output 和 session identity 正确。
- Ctrl+O 在 Single、Parallel 和 fanout 的运行中及终态下显示正确。
- `run.json` 未按 child tool-result body 的体积增长。
- native child session 可以明显大于对应 `run.json`，说明 raw tool history 未被重复写入 parent/durable result。
- RSS 可以波动或阶梯式增长，但没有与每次 child 原始输出量一致的持续线性增长。

### 失败

出现任一情况即应保留 artifacts 并调查：

- `JavaScript heap out of memory` 或 parent 无响应。
- terminal snapshot 缺失 final output、structured output、usage、status 或 run identity。
- pending content update 覆盖 terminal state。
- resume 丢失 session identity、重复执行已完成 sibling，或 frozen fanout mapping 改变。
- 新 `run.json` 中重新出现大量 raw child `toolResult` messages。
- `run.json` 大小与 native child session 近似同步增长，且增长来自重复 transcript，而不是显式 structured output。

注意：`structuredOutput` 是 authoritative 数据，目前不会被自动截断。若测试任务主动生成巨大 structured output，`run.json` 变大不一定表示 compact presentation 回归。

## 9. 保存报告和清理

建议保留以下材料用于 release review：

- `$SOAK/samples.tsv`
- `$SOAK/checkpoints.tsv`
- 10 次调用的 run ID
- 每个 `run.json` 的最终字节数
- Parallel/Chain 的 Ctrl+O 人工检查结果
- interruption/resume 前后的 durable status 和 attempt
- parent 终端中是否出现 OOM、transport 或 terminal-state 错误

退出最终 parent Pi 后，停止仍存活的 sampler 并删除 PID 文件：

```bash
if [[ -f "$SOAK/sampler.pid" ]]; then
  kill "$(cat "$SOAK/sampler.pid")" 2>/dev/null || true
fi

rm -f "$SOAK/pi.pid" "$SOAK/sampler.pid"
```

不要在验证结束前删除 `$SOAK` 或 durable run 目录。检查完成后，再依据项目的数据保留策略处理 parent session、native child sessions 和 run records；这些文件可能包含敏感 prompt、路径、final output 和 child 原始 tool results。
