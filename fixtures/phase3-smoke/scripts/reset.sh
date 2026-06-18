#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cp "${FIXTURE_DIR}/templates/main.baseline.ts.txt" "${FIXTURE_DIR}/src/main.ts"
cp "${FIXTURE_DIR}/templates/ignored.baseline.ts.txt" "${FIXTURE_DIR}/src/ignored.ts"

echo "Phase 3 smoke fixture source files restored."
