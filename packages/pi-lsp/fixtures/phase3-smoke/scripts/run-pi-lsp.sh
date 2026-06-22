#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${FIXTURE_DIR}/../.." && pwd)"
EXTENSION_PATH="${REPO_ROOT}/dist/index.js"

MODE="${1:-explicit}"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

if [[ ! -f "${EXTENSION_PATH}" ]]; then
  echo "Missing ${EXTENSION_PATH}. Run 'mise run build' from ${REPO_ROOT} first." >&2
  exit 1
fi

PI_BIN="${REPO_ROOT}/node_modules/.bin/pi"
if [[ ! -x "${PI_BIN}" ]]; then
  PI_BIN="$(command -v pi)"
fi

NODE_BIN="$(dirname "$(command -v node)")"
FIXTURE_BIN="${FIXTURE_DIR}/node_modules/.bin"
REPO_BIN="${REPO_ROOT}/node_modules/.bin"

cd "${FIXTURE_DIR}"

# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------

SETTINGS_FILE="${FIXTURE_DIR}/.pi/@balaenis/pi-lsp/config.json"
SETTINGS_BACKUP="${FIXTURE_DIR}/.pi/@balaenis/pi-lsp/config.backup.json"

backup_settings() {
  if [[ -f "${SETTINGS_FILE}" ]]; then
    cp "${SETTINGS_FILE}" "${SETTINGS_BACKUP}"
    echo "[smoke] backed up ${SETTINGS_FILE}" >&2
  fi
}

restore_settings() {
  if [[ -f "${SETTINGS_BACKUP}" ]]; then
    mv "${SETTINGS_BACKUP}" "${SETTINGS_FILE}"
    echo "[smoke] restored ${SETTINGS_FILE}" >&2
  elif [[ -f "${SETTINGS_FILE}" ]]; then
    rm -f "${SETTINGS_FILE}"
    echo "[smoke] removed ${SETTINGS_FILE}" >&2
  fi
}

write_settings() {
  mkdir -p "$(dirname "${SETTINGS_FILE}")"
  cat > "${SETTINGS_FILE}" <<'INNEREOF'
{
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript"
      },
      "startupTimeout": 15000,
      "shutdownTimeout": 5000
    },
    "python": {
      "command": "pyright-langserver",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".py": "python"
      },
      "startupTimeout": 15000,
      "shutdownTimeout": 5000
    }
  }
}
INNEREOF
  echo "[smoke] wrote default explicit settings" >&2
}

# ---------------------------------------------------------------------------
# PATH construction — never includes system PATH to avoid leaking host LSP installs.
# fd and rg are required by pi; symlink them into a temp dir so we don't need
# system paths.
# ---------------------------------------------------------------------------

TOOLS_TMPDIR=""

ensure_tools() {
  TOOLS_TMPDIR="$(mktemp -d)"
  for tool in fd rg; do
    local toolpath
    toolpath="$(command -v "${tool}" 2>/dev/null || true)"
    if [[ -z "${toolpath}" ]]; then
      echo "ERROR: ${tool} not found. Install it (e.g. pacman -S fd ripgrep) before running smoke tests." >&2
      rm -rf "${TOOLS_TMPDIR}"
      exit 1
    fi
    ln -s "${toolpath}" "${TOOLS_TMPDIR}/${tool}"
  done
  echo "[smoke] tools tmpdir: ${TOOLS_TMPDIR}" >&2
}

cleanup_tools() {
  if [[ -n "${TOOLS_TMPDIR}" ]] && [[ -d "${TOOLS_TMPDIR}" ]]; then
    rm -rf "${TOOLS_TMPDIR}"
  fi
}

cleanup_tmpbin() {
  local tmpbin_file="${FIXTURE_DIR}/.pi/.smoke-tmpbin"
  if [[ -f "${tmpbin_file}" ]]; then
    rm -rf "$(cat "${tmpbin_file}")"
    rm -f "${tmpbin_file}"
  fi
}

# Base PATH: fixture binaries + repo pi + node runtime + fd/rg symlinks.
# No system paths.
base_path() {
  echo "${FIXTURE_BIN}:${REPO_BIN}:${NODE_BIN}:${TOOLS_TMPDIR}"
}

# Z2 PATH: temp dir with only typescript-language-server (no pyright), + repo pi + node + tools.
# No fixture bin so pyright-langserver from the fixture cannot leak in either.
missing_pyright_path() {
  local tmpbin
  tmpbin="$(mktemp -d)"
  echo "${tmpbin}" > "${FIXTURE_DIR}/.pi/.smoke-tmpbin"
  ln -s "${FIXTURE_BIN}/typescript-language-server" "${tmpbin}/typescript-language-server"
  echo "${tmpbin}:${REPO_BIN}:${NODE_BIN}:${TOOLS_TMPDIR}"
}

# ---------------------------------------------------------------------------
# Mode dispatch
# ---------------------------------------------------------------------------

# Symlink fd and rg into a temp dir so pi can find them without system PATH.
ensure_tools

SMOKE_PATH=""

case "${MODE}" in
  explicit)
    # Use the existing .pi/@balaenis/pi-lsp/config.json as-is (or write default if missing).
    if [[ ! -f "${SETTINGS_FILE}" ]]; then
      write_settings
    fi
    SMOKE_PATH="$(base_path)"
    ;;

  zero)
    # Move settings aside so only recipe autodetection drives the server set.
    backup_settings
    rm -f "${SETTINGS_FILE}"
    trap 'restore_settings; cleanup_tmpbin; cleanup_tools' EXIT
    SMOKE_PATH="$(base_path)"
    ;;

  missing-pyright)
    # Zero-config + PATH without pyright-langserver.
    backup_settings
    rm -f "${SETTINGS_FILE}"
    trap 'restore_settings; cleanup_tmpbin; cleanup_tools' EXIT
    SMOKE_PATH="$(missing_pyright_path)"
    ;;

  broken-python)
    # User config with a deliberately broken python command (path wrong).
    # Tests the ENOENT path: binary not on PATH → "failed to start: spawn ... ENOENT".
    backup_settings
    cat > "${SETTINGS_FILE}" <<'INNEREOF'
{
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": { ".ts": "typescript" },
      "startupTimeout": 15000,
      "shutdownTimeout": 5000
    },
    "python": {
      "command": "pyright-langserver-typo",
      "args": ["--stdio"],
      "extensionToLanguage": { ".py": "python" },
      "startupTimeout": 15000,
      "shutdownTimeout": 5000
    }
  }
}
INNEREOF
    trap 'restore_settings; cleanup_tmpbin; cleanup_tools' EXIT
    SMOKE_PATH="$(base_path)"
    ;;

  bad-args)
    # User config with valid command but invalid args. The binary IS on PATH
    # (spawns successfully), but it crashes immediately because it doesn't
    # recognize `--my-flag`. Tests the crash path: "failed to start: crashed
    # with exit code N".
    backup_settings
    cat > "${SETTINGS_FILE}" <<'INNEREOF'
{
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio", "--my-flag"],
      "extensionToLanguage": { ".ts": "typescript" },
      "startupTimeout": 15000,
      "shutdownTimeout": 5000
    },
    "python": {
      "command": "pyright-langserver",
      "args": ["--stdio"],
      "extensionToLanguage": { ".py": "python" },
      "startupTimeout": 15000,
      "shutdownTimeout": 5000
    }
  }
}
INNEREOF
    trap 'restore_settings; cleanup_tmpbin; cleanup_tools' EXIT
    SMOKE_PATH="$(base_path)"
    ;;

  all-invalid)
    # Both user entries are structurally invalid (missing command) — must fall
    # back to recipes. This matches the config.test.ts "falls back to recipes
    # when all user entries are invalid" test case.
    backup_settings
    cat > "${SETTINGS_FILE}" <<'INNEREOF'
{
  "servers": {
    "broken-ts": {
      "extensionToLanguage": { ".ts": "typescript" }
    },
    "broken-py": {
      "extensionToLanguage": { ".py": "python" }
    }
  }
}
INNEREOF
    trap 'restore_settings; cleanup_tmpbin; cleanup_tools' EXIT
    SMOKE_PATH="$(base_path)"
    ;;

  user-ts-only)
    # User covers TS with a custom name; Python must come from recipe.
    backup_settings
    cat > "${SETTINGS_FILE}" <<'INNEREOF'
{
  "servers": {
    "my-ts": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": { ".ts": "typescript" }
    }
  }
}
INNEREOF
    trap 'restore_settings; cleanup_tmpbin; cleanup_tools' EXIT
    SMOKE_PATH="$(base_path)"
    ;;

  name-collision)
    # User server named "typescript" collides with recipe name → recipe skipped.
    # The server uses valid args so it actually starts — this tests name
    # collision, not crash behavior.
    backup_settings
    cat > "${SETTINGS_FILE}" <<'INNEREOF'
{
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": { ".ts": "typescript" },
      "startupTimeout": 15000,
      "shutdownTimeout": 5000
    }
  }
}
INNEREOF
    trap 'restore_settings; cleanup_tmpbin; cleanup_tools' EXIT
    SMOKE_PATH="$(base_path)"
    ;;

  *)
    echo "Usage: $0 [explicit|zero|missing-pyright|broken-python|bad-args|all-invalid|user-ts-only|name-collision]" >&2
    echo "" >&2
    echo "Modes:" >&2
    echo "  explicit         Default. Uses .pi/@balaenis/pi-lsp/config.json as-is (A1-A5 prompts)." >&2
    echo "  zero             No config.json; recipe autodetection (Z0/Z1)." >&2
    echo "  missing-pyright  No config.json; PATH without pyright-langserver (Z2)." >&2
    echo "  broken-python    User config with wrong python command path (Z3/Z4/Z9)." >&2
    echo "  bad-args         User config with valid command but invalid args (Z10)." >&2
    echo "  all-invalid      Both user entries structurally invalid; recipe fallback (Z5)." >&2
    echo "  user-ts-only     User covers TS; recipe supplements Python (Z6)." >&2
    echo "  name-collision   User server named 'typescript' collides with recipe (Z7)." >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Validate PATH before launching
# ---------------------------------------------------------------------------

echo "[smoke] mode: ${MODE}" >&2
echo "[smoke] PATH: ${SMOKE_PATH}" >&2

case "${MODE}" in
  missing-pyright)
    if PATH="${SMOKE_PATH}" command -v pyright-langserver &>/dev/null; then
      echo "ERROR: pyright-langserver leaked into smoke PATH" >&2
      exit 1
    fi
    echo "[smoke] confirmed: pyright-langserver not on PATH" >&2
    ;;
  zero|all-invalid)
    if ! PATH="${SMOKE_PATH}" command -v typescript-language-server &>/dev/null; then
      echo "ERROR: typescript-language-server not found on PATH. Run 'bun install' in ${FIXTURE_DIR}." >&2
      exit 1
    fi
    if ! PATH="${SMOKE_PATH}" command -v pyright-langserver &>/dev/null; then
      echo "ERROR: pyright-langserver not found on PATH. Run 'bun install' in ${FIXTURE_DIR}." >&2
      exit 1
    fi
    echo "[smoke] confirmed: both LSP binaries on PATH" >&2
    ;;
esac

# ---------------------------------------------------------------------------
# Launch pi
# ---------------------------------------------------------------------------

PI_LSP_LOG_LEVEL=debug \
  PATH="${SMOKE_PATH}" \
  "${PI_BIN}" -ne --approve -e "${EXTENSION_PATH}"
