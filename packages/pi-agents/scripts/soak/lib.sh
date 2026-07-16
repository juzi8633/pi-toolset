# ABOUTME: Shared helpers for the reduced-heap soak test scripts.
# ABOUTME: Resolves the SOAK work dir, repo root, and durable runs dir.

SOAK_POINTER_DEFAULT="${XDG_RUNTIME_DIR:-/tmp}/pi-agents-soak.current"

soak_pointer() {
  printf '%s\n' "${SOAK_POINTER:-$SOAK_POINTER_DEFAULT}"
}

repo_root() {
  # scripts live at <repo>/packages/pi-agents/scripts/soak/ (4 levels deep)
  (cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../../../.." && pwd)
}

default_runs_dir() {
  printf '%s\n' "${SOAK_RUNS_DIR:-$HOME/.pi/agent/@balaenis/pi-agents/runs}"
}

resolve_soak() {
  if [[ -n "${SOAK:-}" ]]; then
    return 0
  fi
  local pointer
  pointer="$(soak_pointer)"
  if [[ -f "$pointer" ]]; then
    SOAK="$(cat "$pointer")"
    return 0
  fi
  cat >&2 <<EOF
error: SOAK is not set.
Run ./packages/pi-agents/scripts/soak/setup.sh first, or export SOAK=/tmp/pi-agents-memory-soak.XXXXXX
EOF
  return 1
}

require_soak() {
  resolve_soak
  if [[ ! -d "$SOAK" ]]; then
    echo "error: SOAK dir does not exist: $SOAK" >&2
    return 1
  fi
}
