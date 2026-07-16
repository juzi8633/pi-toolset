#!/usr/bin/env bash
# ABOUTME: Print the soak-test result summary: checkpoints, peak RSS, run.json sizes, raw-message check.
# ABOUTME: Implements section 7 of reduced-heap-soak-test.zh-cn.md.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_soak
RUNS="$(default_runs_dir)"

echo "===== checkpoints ====="
column -t -s $'\t' "$SOAK/checkpoints.tsv" 2>/dev/null || cat "$SOAK/checkpoints.tsv"

echo
echo "===== peak RSS (across both parent stages) ====="
awk -F '\t' 'NR>1 && $3+0>max{max=$3+0} END{printf "peak RSS: %.1f MiB\n", max/1024}' "$SOAK/samples.tsv"

echo
echo "===== run.json produced this soak ====="
find "$RUNS" -type f -name run.json -newer "$SOAK/start-marker" -printf '%s\t%p\n' |
  sort -n | numfmt --field=1 --to=iec

echo
echo "===== per-run: compact run.json vs native child sessions ====="
for run in "$RUNS"/run-*; do
  [[ -f "$run/run.json" ]] || continue
  [[ "$run/run.json" -nt "$SOAK/start-marker" ]] || continue
  echo "== $(basename "$run") =="
  du -h "$run/run.json"
  find "$run/sessions" -type f -printf '%s\n' 2>/dev/null |
    awk '{sum += $1} END {printf "child sessions: %.2f MiB\n", sum / 1048576}'
done

echo
echo "===== runs whose durable result still carries raw messages (expect none for new compact runs) ====="
find "$RUNS" -type f -name run.json -newer "$SOAK/start-marker" -print0 |
  xargs -0r jq -r '
    . as $run
    | [ (.details.results[]? | select((.messages // []) | length > 0)),
        (.units[]?.result? | select((.messages // []) | length > 0)) ]
    | select(length > 0)
    | $run.runId
  '
