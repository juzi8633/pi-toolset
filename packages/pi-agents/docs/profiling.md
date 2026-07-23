# pi-agents CPU 性能分析指南

## Startup import profiling

Extension **module import** and **agent execution** are different phases.

- `PI_AGENTS_CPU_PROFILE=1` starts sampling during agent execution only. It does **not** measure extension import time.
- `PI_TIMING=1` is the Pi host startup timer. The `module import` line covers recursive dependency loading inside `jiti.import()`; `factory` is reported separately when the extension factory runs.

### Deterministic fresh-process warm benchmark (local)

After `mise run build --package packages/pi-agents`:

```bash
cd packages/pi-agents
bun run scripts/benchmark-startup.ts --warmups 2 --samples 15 --max-median-ms 250
```

Each sample runs in a **fresh Bun process** (`scripts/benchmark-startup-worker.ts`). Host peers are virtualized outside the timer (`moduleCache: false`, `tryNative: false`). The worker starts its timer immediately before `jiti.import()` and validates that the default export is a function without invoking the extension factory.

This is a **fresh-process warm-disk** measurement: OS/Bun disk caches are warm, so filesystem/antivirus cold-cache effects are **not** represented. It is distinct from:

- same-process hot module-cache re-imports
- real disk-cold startup (`PI_TIMING=1` after reboot)
- extension factory timing
- first Grok ACP lazy-load latency (deferred until the first `runtime: "grok-acp"` call)

Optional worker timeout (default `30_000` ms):

```bash
bun run scripts/benchmark-startup.ts --samples 1 --worker-timeout-ms 30000
```

Postbuild structural gate is invoked by Mise build with a transient Bun metafile (`PI_BUILD_METAFILE`). Prefer:

```bash
mise run build --package packages/pi-agents
```

Direct `bun run ./scripts/postbuild.ts` requires `PI_BUILD_METAFILE` from the corresponding split build when `pi.build.splitting` is enabled.

**Deterministic gates**

- Fresh-process warm Jiti median `<= 250ms` (loose local guard; not the relative ship target)
- Startup static output closure `<= 1_325_000` bytes; total main-graph JS `<= 2_621_440` bytes
- No startup-static output contains `@agentclientprotocol/sdk` or bundled `zod` inputs
- At least one dynamic edge reaches an ACP SDK-containing output
- `effect` and `@agentclientprotocol/sdk` remain bundled; Pi host peers remain external

**Performance ship gates** (same machine and extension path, control vs candidate)

- Fresh-process warm Jiti median improves by at least **15%**
- Windows cold `module import` improves by at least **15%**
- Windows factory median regresses by no more than **10%**
- Both relative timing gates are mandatory; either failure blocks shipping splitting

### Windows cold/warm protocol

1. Build control and candidate artifacts with the same path and enabled-extension set (`mise run build --package packages/pi-agents`).
2. Ensure only one `pi-agents` extension instance is enabled.
3. Set `$env:PI_TIMING = '1'`.
4. Reboot before the cold sample for each artifact under test.
5. Start Pi, wait for the prompt, exit normally, and record the `pi-agents ... module import` line (and factory timing).
6. Repeat five launches without reboot and record the median warm import and factory median.
7. Compare control vs candidate: cold import ≥15% better, factory median ≤10% worse.

If either timing ship gate fails while structural checks pass, do not ship splitting; revert `pi.build.splitting` and keep only behavior-neutral source-boundary refactors.

### Postbuild report fields

Split builds print a JSON report including:

- `startupStaticFiles` / `startupStaticBytes`
- `dynamicReachableFiles` / `dynamicReachableBytes`
- `totalMainGraphBytes`
- `acpContainingOutputs`
- `externalPackages`
- `emittedChunkPaths`

Limits: `MAX_STARTUP_STATIC_GRAPH_BYTES = 1_325_000`, `MAX_TOTAL_MAIN_GRAPH_BYTES = 2_621_440`.

---

## 快速开始

```bash
# 默认模式：仅在 agent 执行期间采样，输出到 /tmp/pi-agents-profiles/
./scripts/profile-agent.sh

# 跑完后用 Chrome DevTools 打开生成的 .cpuprofile 文件
# DevTools → Performance → 点击 Upload 按钮（或拖入文件）
```

**即使 Ctrl+C 中断，火焰图也会自动写入磁盘。** 见下方「卡死时中断获取火焰图」。

---

## 四种分析模式

### 1. 程序化 profiling（默认，推荐）

通过 `PI_AGENTS_CPU_PROFILE` 环境变量触发 `profiler.ts`，**仅在 agent 执行期间采样**，结束自动写入文件。数据干净，只含 agent 运行时的热点。

```bash
./scripts/profile-agent.sh
```

等同于：

```bash
PI_AGENTS_CPU_PROFILE=1 pi
```

### 2. V8 `--cpu-prof`（全进程采样）

使用 Node.js 内置的 `--cpu-prof` 标志，**从 pi 启动到退出全程采样**。适合同时观察 pi host 和 agent 子进程的开销分布。

```bash
./scripts/profile-agent.sh --v8
```

### 3. `0x` 火焰图

生成独立的交互式 HTML 火焰图，比 Chrome DevTools 的 `.cpuprofile` 更直观，适合快速浏览热点函数。

```bash
./scripts/profile-agent.sh --0x
```

### 4. Clinic.js 综合诊断

生成 CPU、内存、事件循环三合一的 HTML 报告，适合全栈性能诊断。

```bash
./scripts/profile-agent.sh --clinic
```

---

## 环境变量

所有模式共用以下变量：

| 变量                  | 默认值                    | 说明                           |
| --------------------- | ------------------------- | ------------------------------ |
| `PROFILE_DIR`         | `/tmp/pi-agents-profiles` | 输出目录                       |
| `PROFILE_INTERVAL_US` | `1000`                    | 采样间隔（微秒），越小精度越高 |

仅 `programmatic` 模式额外支持：

| 变量                                | 默认值          | 说明             |
| ----------------------------------- | --------------- | ---------------- |
| `PI_AGENTS_CPU_PROFILE_DURATION_MS` | `0`（手动停止） | 自动停止采样时间 |

示例：

```bash
PROFILE_DIR=/tmp/my-traces \
PROFILE_INTERVAL_US=500 \
PI_AGENTS_CPU_PROFILE_DURATION_MS=60000 \
  ./scripts/profile-agent.sh
```

---

## 分析火焰图

### 用 Chrome DevTools 打开 `.cpuprofile`

1. 打开 Chrome DevTools（F12 或 Ctrl+Shift+I）
2. 切换到 **Performance** 面板
3. 点击顶部工具栏的 **Upload** 按钮（或直接将 `.cpuprofile` 文件拖入面板）
4. 火焰图中 **宽度大的色块 = CPU 占比高的函数**

> 旧版 Chrome 中 `chrome://inspect` 下的 **CPU Profiler** 面板已废弃，现统一在 Performance 面板中加载。

### 用 Speedscope 在线查看

将 `.cpuprofile` 拖入 https://www.speedscope.app/，支持三种视图：

| 视图       | 用途                   |
| ---------- | ---------------------- |
| Time Order | 按时间线的函数调用栈   |
| Left Heavy | 火焰图（自底向上累加） |
| Sandwich   | 调用者/被调用者分离    |

### 用 `0x` 直接看 HTML

```bash
./scripts/profile-agent.sh --0x
# 浏览器会自动打开生成的 flamegraph.html
```

---

## 常见热点解读

基于代码分析的预期热点函数，在火焰图中可以验证：

| 函数 / 模块                            | 含义                                 | 正常占比                             |
| -------------------------------------- | ------------------------------------ | ------------------------------------ |
| `snapshotSingleResult`                 | 结果快照（UTF-8 截断 + JSON 序列化） | 高频调用，应关注 self time           |
| `handleSessionUpdate`（transcript）    | Grok ACP 通知 → AgentMessage 投影    | 每 chunk 触发一次                    |
| `handleGrokAcpSessionUpdate`（parser） | Grok ACP 通知 → SingleResult         | 同上                                 |
| `emitUpdate` / `emitRunningSnapshot`   | 每 150ms 的 TUI 更新                 | 合并调整 `RESULT_UPDATE_INTERVAL_MS` |
| `renderResult` / `formatSummaryLine`   | TUI 行渲染 + ANSI 截断               | 并行数多时累加                       |
| `JSON.parse`（stdout 行解析）          | Pi 子进程 stdout 行解析              | 量大但不重                           |
| `Buffer.byteLength`                    | UTF-8 字节长度计算                   | 在截断路径中被大量调用               |

### 优化方向

如果火焰图确认热点在上述模块，可考虑：

1. **降低更新频率**：调整 `constants.ts` 中的 `RESULT_UPDATE_INTERVAL_MS`（当前 150ms→300ms）
2. **缓存字节长度**：在 `snapshotSingleResult` 中缓存 `Buffer.byteLength` 结果
3. **减少数组拷贝**：`grok-acp-transcript.ts` 中 `publishStreaming()` 每次拷贝 content 数组
4. **合并 TUI invalidate**：同一 tick 内 spinner + content update 合并为一次重渲染

---

## 卡死时中断获取火焰图

当 pi 运行卡死、CPU 占满只能 Ctrl+C 中断时，**所有模式都会在退出前自动写入火焰图数据**：

| 模式                   | 中断后能否拿到火焰图 | 原理                                                                   |
| ---------------------- | -------------------- | ---------------------------------------------------------------------- |
| `programmatic`（默认） | ✅ 是                | `profiler.ts` 注册了 SIGINT/SIGTERM handler，在退出前同步 dump profile |
| `--v8`                 | ✅ 是                | Node.js `--cpu-prof` 在进程退出时（包括信号终止）自动写入              |
| `--0x`                 | ✅ 是                | 底层也是 `--cpu-prof`，同样在退出时写入                                |
| `--clinic`             | ⚠️ 部分              | Clinic 捕获 SIGINT，但超大数据时可能截断                               |

对于 `programmatic` 模式的具体实现：

```
用户按 Ctrl+C
  → SIGINT 送达 pi 进程
  → profiler.ts 的 dumpAndExit() 被调用
  → V8 Profiler.stop（in-process，callback 在事件循环结束前触发）
  → 写入 .cpuprofile 到磁盘
  → 打印路径到 stderr
  → process.exit()（2s 超时保护）
```

因此卡死时只需 Ctrl+C，控制台会看到：

```
[pi-agents] CPU profile written to /tmp/pi-agents-profiles/cpu-agent-2025-...cpuprofile
```

如果 Pi 卡死到连 SIGINT 都无法响应（极端情况），可以升级到 SIGTERM：

```bash
kill -TERM $(pgrep -f pi)
```

两种信号 profiler 都会拦截并 dump 数据。如果连 SIGKILL 都需要用，则无法拿到火焰图（内核直接杀进程，无用户态代码执行机会）。

---

## 传参给 pi

`--` 之后的参数透传给 pi：

```bash
# 指定工作目录
./scripts/profile-agent.sh --cwd /path/to/project

# 仅分析某个具体 agent 调用
./scripts/profile-agent.sh
# 然后在 pi 中执行 /agent 命令
```
