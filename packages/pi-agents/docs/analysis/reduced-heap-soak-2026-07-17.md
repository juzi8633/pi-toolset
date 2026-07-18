# Reduced-heap soak results — 2026-07-17

## Verdict

**PASS.** Ten top-level `agent` calls completed under a 1024 MiB V8 old-space cap with no parent OOM, correct interrupt/resume, and compact durable/parent growth far below native child session volume.

## Environment

| Item        | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Worktree    | `fix/subagent-memory-optimization`                                                         |
| SOAK dir    | `/tmp/pi-agents-memory-soak.jWxrD4`                                                        |
| Parent PIDs | `3506850` (stage 1), `3534711` (stage 2 after resume)                                      |
| Heap cap    | `NODE_OPTIONS=--max-old-space-size=1024`                                                   |
| Runtime     | Node 26.3 / pi 0.80.9                                                                      |
| Artifacts   | `reduced-heap-soak-2026-07-17-checkpoints.tsv`, `reduced-heap-soak-2026-07-17-samples.tsv` |

## Call matrix

| Label                 | Status    | `run.json` | Notes                                   |
| --------------------- | --------- | ---------: | --------------------------------------- |
| baseline              | —         |          — | Startup RSS 771.8 MiB                   |
| 01-long-single        | completed |   54.5 KiB | `run-c930cb19-…`                        |
| 02-short              | completed |   33.4 KiB | `run-875851d6-…`                        |
| 03-short              | completed |   35.8 KiB | `run-982157b1-…`                        |
| 04-short              | completed |   30.9 KiB | `run-e8aad9bf-…`                        |
| 05-short              | completed |   41.6 KiB | `run-ef3dc0e2-…`                        |
| 06-parallel           | completed |  320.4 KiB | 8 units, `run-908b8d9a-…`               |
| 07-short              | completed |   36.0 KiB | `run-df341462-…`                        |
| 08-chain              | completed |  236.2 KiB | 10 units, `run-36a047be-…`              |
| 09-background-running | running   |    2.1 KiB | Pre-`/quit` snapshot, same run as 10    |
| 10-resume             | completed |   33.2 KiB | Same `run-07b5af2c-…`, unit `attempt=2` |

## Memory

| Metric         |                               Value |
| -------------- | ----------------------------------: |
| Peak RSS       | 880.7 MiB (resume cold-start spike) |
| Working RSS    |                        ~240–360 MiB |
| Final idle RSS |                            ~240 MiB |
| Sample count   |              ~1100+ at 2 s interval |

Observations:

- Startup spikes (~770–880 MiB) drop quickly to ~250 MiB; consistent with the measured ~512 MiB baseline old-space at idle start.
- Working RSS plateaus; no sustained linear climb tracking cumulative child tool output.
- Stage-2 parent after resume shows the same spike-then-settle pattern.

## Compact presentation / durable size

| Bucket                    |      Size | vs child sessions |
| ------------------------- | --------: | ----------------: |
| All native child sessions |  5.10 MiB |              100% |
| All `run.json`            |   822 KiB |         **15.7%** |
| Parent session (final)    | 560.8 KiB |         **10.7%** |

Per large aggregate:

| Run                               | `run.json` | Child sessions | Ratio |
| --------------------------------- | ---------: | -------------: | ----: |
| Parallel (8 tasks)                |  320.4 KiB |       1.68 MiB | 18.6% |
| Chain (seed + 8 fanout + collect) |  236.2 KiB |       1.10 MiB | 21.0% |

Parent session deltas per checkpoint (approx.):

| Step              | Δ parent session |
| ----------------- | ---------------: |
| Each short Single |       +26–35 KiB |
| Parallel          |         +205 KiB |
| Chain             |         +131 KiB |
| Final total       |          561 KiB |

If raw child tool history were re-embedded in parent/durable results, parent scale would approach the ~5 MiB child total. Observed parent is ~0.55 MiB.

### Raw-message check

`summary.sh` raw-message scan over all soak-era `run.json` files: **no hits**.

Sampled shapes:

- Parallel: `toolResultHits=0`, all result `messages` arrays length 0.
- Long Single: same.

## Interrupt / resume

1. Call 9 recorded as `running` with a 2.1 KiB `run.json` (background just started).
2. Parent `/quit` → stage-1 process ended; sampler followed old PID out.
3. `start-parent.sh --resume` + `start-sampler.sh` for stage 2.
4. Resume of `run-07b5af2c-1dad-4033-83ed-6ac640e1c311` finished `completed` with unit **`attempt=2`** (not a new run id).
5. Final durable size 33.2 KiB; unit result messages length 0.

## Acceptance checklist

| Criterion                                          | Result                          |
| -------------------------------------------------- | ------------------------------- |
| ≥10 top-level calls                                | Pass                            |
| No V8 heap OOM; parent stayed interactive          | Pass                            |
| Call 9 interruptible / call 10 resume completed    | Pass (`attempt=2`)              |
| `run.json` not growing with raw tool bodies        | Pass (15.7% of child)           |
| Parent growth matches compact presentation         | Pass (561 KiB vs 5.1 MiB child) |
| No raw messages rewritten into new durable results | Pass                            |
| RSS not linearly tracking raw tool output          | Pass                            |
| Ctrl+O manual checks                               | Pass (operator report)          |

## Non-blocking notes

1. **Startup RSS is high** under a 1024 MiB cap; 512 MiB cannot start on this host (idle old-space ~511 MiB). Documented in the soak guide.
2. **Long Single child session only ~0.15 MiB** — explore may have done fewer/lighter tool calls than the “≥30 tools” prompt. Compact conclusions still hold; tighten the prompt if a harsher load is needed next time.
3. **Parallel post-checkpoint RSS dipped to ~250 MiB**, below some short-single checkpoints — consistent with GC / child-exit reclamation, not data loss.

## Cleanup

- `cleanup.sh` stopped the sampler and removed PID files.
- SOAK data left at `/tmp/pi-agents-memory-soak.jWxrD4` (not deleted).
- Durable runs left under `~/.pi/agent/@balaenis/pi-agents/runs/`.
- Checkpoint/sample TSV copies stored next to this note for release review.
