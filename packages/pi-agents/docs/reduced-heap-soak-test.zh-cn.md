# Reduced-heap soak 测试说明

本说明用于在真实 Pi 前台进程中，以 1024 MiB V8 old-space 上限重复运行混合 subagent 工作流，验证 parent 进程不会因 child 原始 tool-result 被重复保留而发生堆耗尽，同时检查 compact parent presentation、durable `run.json`、fanout、interruption 和 resume 行为。

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

> `NODE_OPTIONS=--max-old-space-size=1024` 限制的是 V8 old-space，不是整个进程 RSS。RSS 包含 native memory、代码、buffer 等，因此 RSS 偶尔超过 1024 MiB 不直接表示失败。重点观察是否发生 V8 OOM，以及 RSS 是否随原始 tool output 持续近似线性增长。实测表明 parent 空闲启动时 old-space 已接近 ~512 MiB，因此 `512` 无法启动；本说明采用 `1024` 作为 reduced-heap 上限。

---

## 准备工作

需要 **两个终端**，都先进入待测 worktree：

```bash
cd /home/julian/workspace/my/pi-toolset/.worktrees/subagent-memory-optimization
```

| 终端 | 用途 |
| --- | --- |
| **终端 A** | 只跑 parent Pi（前台 TUI）。不要在这里做采样或 record。 |
| **终端 B** | 跑所有 soak 脚本：setup / sampler / record / summary / cleanup。 |

脚本目录（下文用相对路径，均相对于 worktree 根）：

```text
./packages/pi-agents/scripts/soak/
```

`SOAK` 工作目录由 `setup.sh` 创建，并写入指针文件 `$XDG_RUNTIME_DIR/pi-agents-soak.current`（默认 `/tmp/pi-agents-soak.current`）。之后所有脚本自动读取该指针，**终端 B 不必再 `export SOAK`**。

所有任务保持只读，避免 soak 测试修改工作区。

---

## 逐步执行

### 步骤 1 — 构建并创建 SOAK 目录（终端 B）

```bash
./packages/pi-agents/scripts/soak/setup.sh
```

**做什么**：构建 `@balaenis/pi-agents`，创建 `/tmp/pi-agents-memory-soak.XXXXXX`，初始化 `parent-sessions/` 与 `start-marker`，写入指针。

**成功标志**：打印 `SOAK work dir ready: /tmp/pi-agents-memory-soak....`。记下该路径（验证结束后保留 artifacts 时要用）。

**参数**：无。可选环境变量见文末。

---

### 步骤 2 — 启动 reduced-heap parent Pi（终端 A）

```bash
./packages/pi-agents/scripts/soak/start-parent.sh
```

**做什么**：以 `NODE_OPTIONS=--max-old-space-size=1024` 启动 Pi；`--no-extensions` + 显式 `-e packages/pi-agents/dist/index.js`；session 写入 `$SOAK/parent-sessions`；PID 写入 `$SOAK/pi.pid`。

**成功标志**：进入 Pi TUI，无 `JavaScript heap out of memory`，无 extension path 错误。

**参数**：

| 参数 | 何时用 |
| --- | --- |
| （无） | 首次启动（本步） |
| `--resume` | 仅在步骤 6 重启时使用，不要在这里加 |

保持终端 A 打开，后续 Pi 输入都在这里完成。

---

### 步骤 3 — 启动采样并记录 baseline（终端 B）

先启动后台采样（需步骤 2 已写出 `pi.pid`）：

```bash
./packages/pi-agents/scripts/soak/start-sampler.sh
```

**做什么**：若尚无表头则创建 `samples.tsv` / `checkpoints.tsv`；后台每 2 秒采样 parent RSS、parent session 总字节、本次新 `run.json` 总字节；PID 写入 `$SOAK/sampler.pid`。

**成功标志**：打印 `Sampler started (pid ..., sampling pid ...)`。

然后立刻记一条基线：

```bash
./packages/pi-agents/scripts/soak/record.sh baseline
```

**参数**：

| 位置 | 含义 | 本步取值 |
| --- | --- | --- |
| `$1` label | checkpoint 名称 | 固定 `baseline` |
| `$2` run-id | 可选；对应 durable run | 本步省略 |

**成功标志**：终端打印一行 TSV（label=`baseline`，run_id=`none`），并追加到 `$SOAK/checkpoints.tsv`。

---

### 步骤 4 — 执行 10 次混合调用

推荐矩阵：

| 序号 | 调用类型 | 终端 A | 终端 B（完成后立刻 record） |
| ---: | --- | --- | --- |
| 1 | 长 Single | 粘贴 4.1 提示词 | `record.sh 01-long-single <runId>` |
| 2–5 | 四个短 Single | 粘贴 4.2 模板（换 `<AREA>`） | `record.sh 02-short` … `05-short` |
| 6 | 八任务 Parallel | 粘贴 4.3 提示词 | `record.sh 06-parallel <runId>` |
| 7 | 短 Single | 粘贴 4.4 提示词（output / memory-regression） | `record.sh 07-short <runId>` |
| 8 | Chain + fanout | 粘贴 4.5 提示词 | `record.sh 08-chain <runId>` |
| 9 | 后台长 Single | 粘贴 5 的提示词 | `record.sh 09-background-running <runId>` |
| 10 | Resume 第 9 次 | 步骤 6 中粘贴 resume | `record.sh 10-resume <runId>` |

**每次 agent 调用后如何取 `runId`**：

1. 在 Pi 中展开结果（Ctrl+O），或运行 `/agent runs`。
2. 复制形如 `run-...` 的 ID。
3. 在终端 B 执行对应 `record.sh`，把 `run-REPLACE_ME` 换成真实 ID。

`record.sh` 用法：

```bash
./packages/pi-agents/scripts/soak/record.sh <label> [run-id]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `<label>` | 是 | 本次 checkpoint 名，建议用表中固定标签 |
| `[run-id]` | 否 | durable run ID；省略则记为 `none` |

---

#### 4.1 长 Single（调用 1）

**终端 A** 输入：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "memory soak long single",
  "task": "Memory soak only; do not modify files. Perform at least 30 tool calls across packages/pi-agents/src and packages/pi-agents/tests, alternating read, grep, and non-destructive bash commands such as git status, wc, and rg. Inspect a variety of files and symbols. Keep the final answer under 20 concise bullets."
}

Return only a short summary of the agent result.
```

运行期间和完成后各按一次 **Ctrl+O**，确认：

- collapsed latest activity 正常更新。
- expanded view 显示 retained assistant/tool-call presentation。
- final output 只出现一次。
- usage 和 run identity 正常。
- 若达到 presentation 上限，omission marker 显示正确；若本次未自然触发，则由 deterministic presentation tests 覆盖，不要仅为制造 marker 消耗大量模型 token。

**终端 B**（把 `run-REPLACE_ME` 换成真实 ID）：

```bash
./packages/pi-agents/scripts/soak/record.sh 01-long-single run-REPLACE_ME
```

---

#### 4.2 四个短 Single（调用 2–5）

下面四条可直接粘贴，无需再改 `<AREA>`。每条跑完后在终端 B 用对应 label 记录。

##### 调用 2 — result snapshot / render（label `02-short`）

**终端 A**：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "memory soak short 02",
  "task": "Read-only memory soak. Inspect packages/pi-agents/src/result-snapshot.ts, packages/pi-agents/src/render.ts, packages/pi-agents/tests/result-snapshot.test.ts, and packages/pi-agents/tests/render.test.ts using 8-12 read, grep, and non-destructive bash tool calls. Do not modify files. Return a concise evidence-based summary of how compact presentation is built and tested."
}

Return only a short summary of the agent result.
```

**终端 B**：

```bash
./packages/pi-agents/scripts/soak/record.sh 02-short run-REPLACE_ME
```

##### 调用 3 — durable run store / coordinator（label `03-short`）

**终端 A**：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "memory soak short 03",
  "task": "Read-only memory soak. Inspect packages/pi-agents/src/run-store.ts, packages/pi-agents/src/run-coordinator.ts, packages/pi-agents/tests/run-store.test.ts, and packages/pi-agents/tests/run-coordinator.test.ts using 8-12 read, grep, and non-destructive bash tool calls. Do not modify files. Return a concise evidence-based summary of durable persistence and coordinator boundaries."
}

Return only a short summary of the agent result.
```

**终端 B**：

```bash
./packages/pi-agents/scripts/soak/record.sh 03-short run-REPLACE_ME
```

##### 调用 4 — chain / fanout（label `04-short`）

**终端 A**：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "memory soak short 04",
  "task": "Read-only memory soak. Inspect packages/pi-agents/src/chain.ts, packages/pi-agents/src/json-pointer.ts, packages/pi-agents/tests/chain.test.ts, and packages/pi-agents/tests/json-pointer.test.ts using 8-12 read, grep, and non-destructive bash tool calls. Do not modify files. Return a concise evidence-based summary of chain expand/collect and fanout mapping."
}

Return only a short summary of the agent result.
```

**终端 B**：

```bash
./packages/pi-agents/scripts/soak/record.sh 04-short run-REPLACE_ME
```

##### 调用 5 — interactive agent（label `05-short`）

**终端 A**：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "memory soak short 05",
  "task": "Read-only memory soak. Inspect packages/pi-agents/src/interactive-agent.ts, packages/pi-agents/src/interactive-view.ts, packages/pi-agents/tests/interactive-agent.test.ts, and packages/pi-agents/tests/interactive-view.test.ts using 8-12 read, grep, and non-destructive bash tool calls. Do not modify files. Return a concise evidence-based summary of interactive transcript retention and view updates."
}

Return only a short summary of the agent result.
```

**终端 B**：

```bash
./packages/pi-agents/scripts/soak/record.sh 05-short run-REPLACE_ME
```

---

#### 4.3 八任务 Parallel（调用 6）

**终端 A** 输入：

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

运行中和完成后用 **Ctrl+O** 检查有序 task 状态、latest activity、usage、final output 和 run identity。

**终端 B**：

```bash
./packages/pi-agents/scripts/soak/record.sh 06-parallel run-REPLACE_ME
```

可选：看该 run 的 durable 文件大小（`run.json` 应明显小于 native child session 总量；合成 regression 的 parent details 门槛为 2 MiB）：

```bash
stat -c '%s bytes' "$HOME/.pi/agent/@balaenis/pi-agents/runs/run-REPLACE_ME/run.json"
```

---

#### 4.4 第七个短 Single（调用 7）

Parallel 之后再跑一条不同区域的短 Single，观察大型 aggregate 后 parent 的增长。

**终端 A**：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "memory soak short 07",
  "task": "Read-only memory soak. Inspect packages/pi-agents/src/output.ts, packages/pi-agents/src/execution.ts, packages/pi-agents/tests/output.test.ts, and packages/pi-agents/tests/memory-regression.test.ts using 8-12 read, grep, and non-destructive bash tool calls. Do not modify files. Return a concise evidence-based summary of parent-facing output boundaries and memory-regression coverage."
}

Return only a short summary of the agent result.
```

**终端 B**：

```bash
./packages/pi-agents/scripts/soak/record.sh 07-short run-REPLACE_ME
```

---

#### 4.5 Structured seed + 八项 fanout Chain（调用 8）

**终端 A** 输入：

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

检查 seed structured output、八项 frozen fanout mapping、collect result 和 final step 均存在。

**终端 B**：

```bash
./packages/pi-agents/scripts/soak/record.sh 08-chain run-REPLACE_ME
```

---

### 步骤 5 — 制造 interruption（调用 9）

**终端 A** 输入（后台模式 + 足够长的 `sleep`，保证 `/quit` 时任务仍在跑）：

```text
Call the agent tool exactly once using:

{
  "agent": "explore",
  "title": "interrupt soak",
  "task": "Read-only interruption soak. First run a non-destructive bash sleep for 120 seconds, then inspect packages/pi-agents using repeated read and grep calls. Do not modify files.",
  "runInBackground": true
}
```

后台调用会立刻返回 `runId`。**先保存该 ID**（步骤 6 resume 还要用同一个）。

**终端 B** 记录运行中状态：

```bash
./packages/pi-agents/scripts/soak/record.sh 09-background-running run-REPLACE_ME
```

**终端 A** 确认仍在 running：

```text
/agent status run-REPLACE_ME
```

然后正常退出（不要 `kill -9`；`/quit` 会走 `session_shutdown`，使 durable work 进入可恢复的 `interrupted`）：

```text
/quit
```

**终端 B** 检查 durable 状态（预期 `interrupted`）：

```bash
jq '{status, units}' "$HOME/.pi/agent/@balaenis/pi-agents/runs/run-REPLACE_ME/run.json"
```

---

### 步骤 6 — 重启 parent 并 resume（调用 10）

原采样循环会随旧 parent PID 退出，需要重启 parent 再重启 sampler。

**终端 A**：

```bash
./packages/pi-agents/scripts/soak/start-parent.sh --resume
```

**参数**：必须带 `--resume`。脚本会自动选 `$SOAK/parent-sessions` 里最新的 `*.jsonl` 并用 `--session` 打开。

**成功标志**：回到同一 parent session 的 TUI，无 OOM。

**终端 B**（parent 起来后立刻重启采样）：

```bash
./packages/pi-agents/scripts/soak/start-sampler.sh
```

**终端 A** 先看 durable 状态，再 resume 第 9 次的同一个 `runId`：

```text
/agent status run-REPLACE_ME
```

```text
Call the agent tool exactly once using:

{
  "runId": "run-REPLACE_ME"
}

Return only a short summary of the resumed result.
```

**终端 B**：

```bash
./packages/pi-agents/scripts/soak/record.sh 10-resume run-REPLACE_ME
```

预期：

- attempt 已增加。
- 原有 session identity 得到保留。
- 未完成工作继续执行。
- 已完成 sibling 不会在 selective resume 中被错误重跑。
- final output、structured output 和 named/collected outputs 未丢失。
- 最终 durable 状态为 `completed`。

---

### 步骤 7 — 汇总结果（终端 B）

```bash
./packages/pi-agents/scripts/soak/summary.sh
```

**参数**：无。自动读取当前 `SOAK` 指针。

**输出内容**：

1. `checkpoints.tsv` 表格（10 次调用的 label / RSS / parent_bytes / run_id / run_bytes / status）
2. 两个 parent 阶段的 peak RSS
3. 本次产生的 `run.json` 大小列表
4. 每个 run 的 compact `run.json` vs native child sessions
5. 仍含 raw messages 的 run（新 compact run 通常应无输出）

对于本次新建并完成的 compact run，raw-message 检查通常应无输出。若有输出，确认是否为预期 legacy fixture，而不是新运行路径重新写入完整 transcript。

---

### 步骤 8 — 通过与失败判定

#### 通过

同时满足：

- 至少 10 次顶层调用已执行。
- 无 V8 heap OOM，parent Pi 始终可交互。
- 第 9 次正确进入 `interrupted`，第 10 次 resume 后完成。
- Parallel/fanout result 顺序、状态、usage、structured output 和 session identity 正确。
- Ctrl+O 在 Single、Parallel 和 fanout 的运行中及终态下显示正确。
- `run.json` 未按 child tool-result body 的体积增长。
- native child session 可以明显大于对应 `run.json`，说明 raw tool history 未被重复写入 parent/durable result。
- RSS 可以波动或阶梯式增长，但没有与每次 child 原始输出量一致的持续线性增长。

#### 失败

出现任一情况即保留 artifacts 并调查：

- `JavaScript heap out of memory` 或 parent 无响应。
- terminal snapshot 缺失 final output、structured output、usage、status 或 run identity。
- pending content update 覆盖 terminal state。
- resume 丢失 session identity、重复执行已完成 sibling，或 frozen fanout mapping 改变。
- 新 `run.json` 中重新出现大量 raw child `toolResult` messages。
- `run.json` 大小与 native child session 近似同步增长，且增长来自重复 transcript，而不是显式 structured output。

注意：`structuredOutput` 是 authoritative 数据，目前不会被自动截断。若测试任务主动生成巨大 structured output，`run.json` 变大不一定表示 compact presentation 回归。

---

### 步骤 9 — 保存报告并清理（终端 B）

建议保留：

- `$SOAK/samples.tsv`
- `$SOAK/checkpoints.tsv`
- 10 次调用的 run ID
- 每个 `run.json` 的最终字节数
- Parallel/Chain 的 Ctrl+O 人工检查结果
- interruption/resume 前后的 durable status 和 attempt
- parent 终端中是否出现 OOM、transport 或 terminal-state 错误

`SOAK` 路径可从指针读取：

```bash
cat "${XDG_RUNTIME_DIR:-/tmp}/pi-agents-soak.current"
```

在终端 A 退出最终 parent Pi 之后，在终端 B 清理采样器与 PID 文件（**不删除** SOAK 数据与 durable runs）：

```bash
./packages/pi-agents/scripts/soak/cleanup.sh
```

不要在验证结束前删除 `$SOAK` 或 durable run 目录。检查完成后再按项目数据保留策略处理；这些文件可能包含敏感 prompt、路径、final output 和 child 原始 tool results。

---

## 脚本一览（参数速查）

所有脚本路径均相对于 worktree 根：`./packages/pi-agents/scripts/soak/`。

| 顺序 | 终端 | 命令 | 参数 | 何时跑 |
| ---: | --- | --- | --- | --- |
| 1 | B | `setup.sh` | 无 | 开始时一次 |
| 2 | A | `start-parent.sh` | 无 | setup 之后；保持前台 |
| 3a | B | `start-sampler.sh` | 无 | parent 已启动后 |
| 3b | B | `record.sh baseline` | label 仅 | sampler 启动后立刻 |
| 4 | B | `record.sh <label> <runId>` | label + runId | 每次 agent 调用完成后 |
| 5 | A | `/quit` | （Pi 内） | 调用 9 已 record 之后 |
| 6a | A | `start-parent.sh --resume` | `--resume` | `/quit` 之后 |
| 6b | B | `start-sampler.sh` | 无 | resume 的 parent 起来后 |
| 6c | B | `record.sh 10-resume <runId>` | label + 同一 runId | resume 完成后 |
| 7 | B | `summary.sh` | 无 | 10 次调用全部结束后 |
| 9 | B | `cleanup.sh` | 无 | 最终 parent 退出后 |

### 环境变量（可选）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SOAK` | 指针文件内容 | 覆盖 SOAK 目录 |
| `SOAK_RUNS_DIR` | `$HOME/.pi/agent/@balaenis/pi-agents/runs` | durable runs 根目录 |
| `SOAK_MAX_OLD_SPACE` | `1024` | parent V8 old-space 上限（MiB） |
| `SOAK_POINTER` | `$XDG_RUNTIME_DIR/pi-agents-soak.current` | 指针文件路径 |

> **堆上限实测（Node 26.3 / pi 0.80.9）**：`512` 在 parent 启动阶段即 OOM（old-space 已达 ~511.6 MiB）。`≤600` 无法启动；`≥640` 可启动。默认 `1024` 给 10 次混合调用留约 500 MiB 余量。更紧可用 `SOAK_MAX_OLD_SPACE=768`。

### 端到端命令骨架（复制用）

```bash
# ========== 终端 B ==========
cd /home/julian/workspace/my/pi-toolset/.worktrees/subagent-memory-optimization
./packages/pi-agents/scripts/soak/setup.sh

# ========== 终端 A ==========
cd /home/julian/workspace/my/pi-toolset/.worktrees/subagent-memory-optimization
./packages/pi-agents/scripts/soak/start-parent.sh
# 保持此 TUI 打开；按步骤 4 粘贴提示词

# ========== 终端 B ==========
./packages/pi-agents/scripts/soak/start-sampler.sh
./packages/pi-agents/scripts/soak/record.sh baseline

# 调用 1–8 每次完成后：
./packages/pi-agents/scripts/soak/record.sh 01-long-single run-REPLACE_ME
# ... 02-short … 08-chain ...

# 调用 9（后台）后：
./packages/pi-agents/scripts/soak/record.sh 09-background-running run-REPLACE_ME
# 然后在终端 A: /agent status …  →  /quit

# ========== 终端 A ==========
./packages/pi-agents/scripts/soak/start-parent.sh --resume
# /agent status run-…  →  粘贴 resume 提示词

# ========== 终端 B ==========
./packages/pi-agents/scripts/soak/start-sampler.sh
./packages/pi-agents/scripts/soak/record.sh 10-resume run-REPLACE_ME
./packages/pi-agents/scripts/soak/summary.sh
# 终端 A 退出 Pi 后：
./packages/pi-agents/scripts/soak/cleanup.sh
```
