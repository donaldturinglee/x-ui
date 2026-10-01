#!/usr/bin/env bash
#
# Remove build and coverage output.
#
# Only what a build produced: the database the panel was developed against and
# anything under configs/ is left alone.
#
# Usage:
#   scripts/clean.sh

set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${OUT:-bin}"
RELEASE_DIR="${RELEASE_DIR:-release}"

rm -rf "${OUT}" "${RELEASE_DIR}" coverage.out coverage.html web/build

echo "removed ${OUT}/, ${RELEASE_DIR}/, coverage output and web/build"
