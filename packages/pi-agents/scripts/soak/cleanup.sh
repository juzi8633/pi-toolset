#!/usr/bin/env bash
# ABOUTME: Stop the soak sampler and remove PID files. Keeps SOAK data and durable runs intact.
# ABOUTME: Implements the cleanup step of reduced-heap-soak-test.zh-cn.md (section 9).

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_soak

if [[ -f "$SOAK/sampler.pid" ]]; then
  spid="$(cat "$SOAK/sampler.pid")"
  if kill -0 "$spid" 2>/dev/null; then
    kill "$spid" 2>/dev/null || true
    echo "==> Stopped sampler (pid $spid)"
  fi
  rm -f "$SOAK/sampler.pid"
fi

rm -f "$SOAK/pi.pid"

echo "==> Cleanup done. SOAK data preserved at: $SOAK"
echo "    Durable runs preserved at: $(default_runs_dir)"
echo "    Remove them manually once validation is complete."
