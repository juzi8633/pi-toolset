#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${FIXTURE_DIR}/../.." && pwd)"
EXTENSION_PATH="${REPO_ROOT}/dist/index.js"

if [[ ! -f "${EXTENSION_PATH}" ]]; then
  echo "Missing ${EXTENSION_PATH}. Run 'mise run build' from ${REPO_ROOT} first." >&2
  exit 1
fi

PI_BIN="${REPO_ROOT}/node_modules/.bin/pi"
if [[ ! -x "${PI_BIN}" ]]; then
  PI_BIN="$(command -v pi)"
fi

cd "${FIXTURE_DIR}"

# PI_LSP_LOG_LEVEL=debug logs the diagnostic registry lifecycle (register/drain/reset)
# and LSP protocol events to ~/.pi/@balaenis/pi-lsp/default.log (override with PI_LSP_LOG_FILE).
# Remove it once you trust the pipeline.
PI_LSP_LOG_LEVEL=debug \
  PATH="${FIXTURE_DIR}/node_modules/.bin:${REPO_ROOT}/node_modules/.bin:${PATH}" \
  "${PI_BIN}" -ne --approve -e "${EXTENSION_PATH}"
