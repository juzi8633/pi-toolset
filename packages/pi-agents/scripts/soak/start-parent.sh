#!/usr/bin/env bash
# ABOUTME: Launch the reduced-heap parent Pi for the soak test.
# ABOUTME: Pass --resume to reopen the latest isolated parent session after /quit.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_soak

REPO="$(repo_root)"
# V8 old-space limit (MiB). 512 OOMs at startup (~512 MiB already used);
# 640 is the observed minimum that starts; 1024 leaves headroom for the soak matrix.
# Override with SOAK_MAX_OLD_SPACE.
HEAP="${SOAK_MAX_OLD_SPACE:-1024}"

session_args=()
name_args=(--name memory-soak)

if [[ "${1:-}" == "--resume" ]]; then
  SESSION="$(
    find "$SOAK/parent-sessions" -type f -name '*.jsonl' -printf '%T@\t%p\n' |
      sort -nr | head -1 | cut -f2-
  )"
  if [[ -z "${SESSION:-}" || ! -f "$SESSION" ]]; then
    echo "error: no parent session found in $SOAK/parent-sessions" >&2
    exit 1
  fi
  session_args=(--session "$SESSION")
  name_args=() # resumed session keeps its existing name
  echo "==> Resuming parent session: $SESSION"
else
  echo "==> Starting fresh parent Pi (heap=${HEAP}MiB, session-dir=$SOAK/parent-sessions)"
fi

cd "$REPO"

# echo $$ captures this shell's PID; exec preserves it for the pi process.
echo "$$" > "$SOAK/pi.pid"

exec env \
  NODE_OPTIONS="--max-old-space-size=$HEAP" \
  PI_SKIP_VERSION_CHECK=1 \
  pi \
    --no-extensions \
    --approve \
    "${name_args[@]}" \
    --session-dir "$SOAK/parent-sessions" \
    "${session_args[@]}" \
    -e ./packages/pi-agents/dist/index.js
