#!/usr/bin/env bash
# ABOUTME: Record one soak-test checkpoint (label + optional runId) to checkpoints.tsv.
# ABOUTME: Usage: record.sh <label> [run-id]   e.g. record.sh 01-long-single run-abc123

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_soak
RUNS="$(default_runs_dir)"

label="${1:?usage: record.sh <label> [run-id]}"
run_id="${2:-}"

if [[ -f "$SOAK/pi.pid" ]]; then
  pid="$(cat "$SOAK/pi.pid")"
else
  pid="-"
fi

parent_bytes="$(
  find "$SOAK/parent-sessions" -type f -name '*.jsonl' -printf '%s\n' 2>/dev/null |
    awk '{sum += $1} END {print sum + 0}'
)"

run_bytes=0
status=none
if [[ -n "$run_id" && -f "$RUNS/$run_id/run.json" ]]; then
  run_bytes="$(stat -c '%s' "$RUNS/$run_id/run.json")"
  status="$(jq -r '.status' "$RUNS/$run_id/run.json")"
fi

if [[ "$pid" != "-" ]] && kill -0 "$pid" 2>/dev/null; then
  rss="$(ps -o rss= -p "$pid" | xargs)"
else
  rss="-"
fi

printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$label" "$pid" "$rss" "$parent_bytes" \
  "${run_id:-none}" "$run_bytes" "$status" \
  | tee -a "$SOAK/checkpoints.tsv"
