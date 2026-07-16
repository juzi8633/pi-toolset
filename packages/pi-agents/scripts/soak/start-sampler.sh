#!/usr/bin/env bash
# ABOUTME: Launch the background RSS + serialized-size sampler for the soak test.
# ABOUTME: Ensures TSV headers exist, then spawns a detached loop (run with --loop internally).

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
resolve_soak
RUNS="$(default_runs_dir)"

if [[ "${1:-}" == "--loop" ]]; then
  pid="$2"
  samples="$SOAK/samples.tsv"
  while kill -0 "$pid" 2>/dev/null; do
    parent_bytes="$(
      find "$SOAK/parent-sessions" -type f -name '*.jsonl' -printf '%s\n' 2>/dev/null |
        awk '{sum += $1} END {print sum + 0}'
    )"
    run_bytes="$(
      find "$RUNS" -type f -name run.json -newer "$SOAK/start-marker" -printf '%s\n' 2>/dev/null |
        awk '{sum += $1} END {print sum + 0}'
    )"
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$(date -Iseconds)" "$pid" \
      "$(ps -o rss= -p "$pid" | xargs)" \
      "$parent_bytes" "$run_bytes" \
      >> "$samples"
    sleep 2
  done
  exit 0
fi

require_soak

samples="$SOAK/samples.tsv"
checkpoints="$SOAK/checkpoints.tsv"
[[ -s "$samples" ]] || printf 'timestamp\tpid\trss_kib\tparent_bytes\tnew_run_bytes\n' > "$samples"
[[ -s "$checkpoints" ]] || printf 'label\tpid\trss_kib\tparent_bytes\trun_id\trun_bytes\tstatus\n' > "$checkpoints"

if [[ ! -f "$SOAK/pi.pid" ]]; then
  echo "error: $SOAK/pi.pid missing. Start the parent Pi first (start-parent.sh)." >&2
  exit 1
fi
pid="$(cat "$SOAK/pi.pid")"

if [[ -f "$SOAK/sampler.pid" ]] && kill -0 "$(cat "$SOAK/sampler.pid")" 2>/dev/null; then
  echo "==> Sampler already running (pid $(cat "$SOAK/sampler.pid"))"
  exit 0
fi

nohup "$0" --loop "$pid" >/dev/null 2>&1 &
echo $! > "$SOAK/sampler.pid"
echo "==> Sampler started (pid $!), sampling pid $pid every 2s -> $samples"
