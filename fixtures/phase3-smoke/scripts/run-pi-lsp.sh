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

if [[ ! -x "${FIXTURE_DIR}/node_modules/.bin/typescript-language-server" ]]; then
  echo "Missing local typescript-language-server. Run 'bun install' in ${FIXTURE_DIR} first." >&2
  exit 1
fi

PI_BIN="${REPO_ROOT}/node_modules/.bin/pi"
if [[ ! -x "${PI_BIN}" ]]; then
  PI_BIN="$(command -v pi)"
fi

cd "${FIXTURE_DIR}"

# PI_LSP_DEBUG=1 prints the manager lifecycle, LSP protocol events, and
# gitignore filter decisions to stderr. Drop it once you trust the pipeline.
# -ne --no-extensions: load ONLY the local extension via -e, so built-in
# extension discovery cannot shadow it. --approve trusts .pi/settings.json.
PI_LSP_DEBUG=1 \
  PATH="${FIXTURE_DIR}/node_modules/.bin:${REPO_ROOT}/node_modules/.bin:${PATH}" \
  "${PI_BIN}" -ne --approve -e "${EXTENSION_PATH}" "$@"
