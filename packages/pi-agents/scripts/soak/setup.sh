#!/usr/bin/env bash
# ABOUTME: Build @balaenis/pi-agents and create an isolated SOAK work dir for the soak test.
# ABOUTME: Records the SOAK path to a pointer file so the other soak scripts can find it.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REPO="$(repo_root)"
cd "$REPO"

echo "==> Building @balaenis/pi-agents in $REPO"
mise run build --package packages/pi-agents

SOAK="$(mktemp -d /tmp/pi-agents-memory-soak.XXXXXX)"
mkdir -p "$SOAK/parent-sessions"
: > "$SOAK/start-marker"

printf '%s\n' "$SOAK" > "$(soak_pointer)"

cat <<EOF

==> SOAK work dir ready: $SOAK
    Pointer: $(soak_pointer)

Next:
  Terminal A:  ./packages/pi-agents/scripts/soak/start-parent.sh
  Terminal B:  ./packages/pi-agents/scripts/soak/start-sampler.sh
               ./packages/pi-agents/scripts/soak/record.sh baseline

All soak scripts auto-detect SOAK via the pointer.
Set SOAK=... or SOAK_RUNS_DIR=... to override.
EOF
