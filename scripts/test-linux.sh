#!/usr/bin/env bash
# Nexus Bot Manager — Linux verification helper.
#
# Runs the test suite on a disposable copy of the working tree, so the
# developer's real backend/.env, backend/data/ and bots are never touched.
# This is the script to run on a Linux host/CI when the POSIX assertions
# (0600/0700, symlinks, tar extraction) are skipped on Windows.
#
# Usage:
#   bash scripts/test-linux.sh
#
# It does NOT need root and does NOT install/start PM2. The full update.sh
# procedure is documented in docs/LINUX-TESTING.md.

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "ERROR: this script must run on Linux (current: $(uname -s))." >&2
    exit 1
fi

for cmd in node npm tar sha256sum; do
    command -v "$cmd" >/dev/null 2>&1 || {
        echo "ERROR: missing command: $cmd" >&2
        exit 1
    }
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "[test-linux] Copying the working tree to ${WORK_DIR} (no .env, no data/)..."
(
    cd "${ROOT_DIR}"
    tar \
        --exclude='./.git' --exclude='./.git/*' \
        --exclude='./backend/node_modules' --exclude='./backend/node_modules/*' \
        --exclude='./backend/data' --exclude='./backend/data/*' \
        --exclude='./backend/.env' \
        --exclude='./backend/server.out.log' \
        --exclude='./backend/server.err.log' \
        -cf - .
) | tar -xf - -C "${WORK_DIR}"

cd "${WORK_DIR}/backend"

echo "[test-linux] npm ci (pinned lockfile, lifecycle scripts disabled)..."
npm ci --ignore-scripts --no-audit --no-fund

echo "[test-linux] Running the full unit + boot suite..."
npm test

echo "[test-linux] Checking every shell script parses..."
for script in "${WORK_DIR}"/scripts/*.sh; do
    bash -n "${script}"
done

echo "[test-linux] Optional audit snapshot (non-fatal)..."
npm audit --omit=dev || true

echo ""
echo "[test-linux] PASS. The POSIX permission, symlink and tar tests ran"
echo "              against ${WORK_DIR}/backend."
echo "              For the full update.sh path, follow docs/LINUX-TESTING.md."
