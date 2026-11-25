#!/usr/bin/env bash
# Build the scripts + SHA256SUMS to attach to a GitHub Release.
# This does not tag, commit or publish anything.
#
# Usage:
#   bash scripts/build-release-assets.sh [version] [output-dir]
#
# Example:
#   bash scripts/build-release-assets.sh 1.1.5 dist/v1.1.5

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
    VERSION="$(node -p "require('./backend/package.json').version")"
fi
VERSION="${VERSION#v}"
if [[ ! "${VERSION}" =~ ^[0-9]+(\.[0-9]+){1,2}([-+][0-9A-Za-z.-]+)?$ ]]; then
    echo "ERROR: invalid version: ${VERSION}" >&2
    exit 1
fi

PKG_VERSION="$(node -p "require('./backend/package.json').version")"
if [[ "${VERSION}" != "${PKG_VERSION}" ]]; then
    echo "ERROR: backend/package.json is ${PKG_VERSION}, not ${VERSION}." >&2
    echo "Set the release version in package.json/lockfile first." >&2
    exit 1
fi

command -v sha256sum >/dev/null 2>&1 || {
    echo "ERROR: sha256sum is required." >&2
    exit 1
}

OUT_DIR="${2:-dist/v${VERSION}}"
case "${OUT_DIR}" in
    [A-Za-z]:*)
        echo "ERROR: use a POSIX output path (for example dist/v${VERSION}); Windows drive paths are not supported by the release builder." >&2
        exit 1
        ;;
    /*) : ;;
    *) OUT_DIR="${ROOT_DIR}/${OUT_DIR}" ;;
esac

mkdir -p "${OUT_DIR}"
cp scripts/install.sh scripts/update.sh scripts/uninstall.sh "${OUT_DIR}/"

(
    cd "${OUT_DIR}"
    sha256sum install.sh update.sh uninstall.sh > SHA256SUMS
    sha256sum -c SHA256SUMS
    echo "Built release assets for v${VERSION} in ${OUT_DIR}:"
    cat SHA256SUMS
)

echo ""
echo "Attach install.sh, update.sh, uninstall.sh and SHA256SUMS to the"
echo "GitHub Release. The source tree is still installed by tag/commit;"
echo "these assets only provide the verified script entry point."
