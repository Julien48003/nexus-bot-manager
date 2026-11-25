#!/usr/bin/env bash
# -------------------------------------------------------------------
# Nexus Bot Manager — source digest for a published release
#
# Computes the SHA-256 of the exact GitHub source tarball the updater
# downloads (by commit SHA), and writes it to SOURCE_SHA256. Attach that
# file to the GitHub Release: the panel uses it when there is no local
# pin in backend/release-digests.json, so users never edit files on the
# server before an update.
#
# The local pin remains the stronger, reviewed value and takes precedence.
#
# Usage:
#   bash scripts/build-source-digest.sh v1.1.14 [output-dir]
# -------------------------------------------------------------------
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

command -v curl >/dev/null 2>&1 || {
  echo "ERROR: curl is required." >&2
  exit 1
}
command -v sha256sum >/dev/null 2>&1 || {
  echo "ERROR: sha256sum is required." >&2
  exit 1
}

TAG="v${VERSION}"
COMMIT="$(git rev-parse "${TAG}" 2>/dev/null || true)"
if [[ -z "${COMMIT}" ]]; then
  echo "ERROR: tag ${TAG} not found. Push the tag before building the digest." >&2
  exit 1
fi

OUT_DIR="${2:-dist/${TAG}}"
mkdir -p "${OUT_DIR}"

TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

URL="https://api.github.com/repos/Julien48003/nexus-bot-manager/tarball/${COMMIT}"
echo "Downloading ${URL}"
curl -fsSL \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: Nexus-Bot-Manager' \
  -o "${TMP_FILE}" \
  "${URL}"

DIGEST="$(sha256sum "${TMP_FILE}" | awk '{print $1}')"
printf '%s\n' "${DIGEST}" > "${OUT_DIR}/SOURCE_SHA256"

echo "SOURCE_SHA256 for ${TAG} (${COMMIT}):"
echo "  ${DIGEST}"
echo "Attach ${OUT_DIR}/SOURCE_SHA256 to the GitHub Release."
