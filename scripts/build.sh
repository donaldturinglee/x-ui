#!/usr/bin/env bash
#
# Build the binaries into bin/.
#
# Usage:
#   scripts/build.sh                 # every binary, for this host
#   scripts/build.sh api cli         # only these
#   GOOS=linux GOARCH=arm64 scripts/build.sh
#   VERSION=1.4.0 scripts/build.sh

set -euo pipefail

source "$(dirname "$0")/common.sh"

CMDS=(api worker cli agent)
if [ "$#" -gt 0 ]; then
  CMDS=("$@")
fi

mkdir -p "${OUT}"

# Asked of the toolchain rather than worked out from GOOS, which is unset when
# building for the host -- so a native Windows build used to land on a name
# Windows will not execute.
EXE="$(go env GOEXE)"

for cmd in "${CMDS[@]}"; do
  if [ ! -d "./cmd/${cmd}" ]; then
    echo "no such command: ${cmd}" >&2
    exit 1
  fi
  name="x-ui-${cmd}${EXE}"
  echo "building ${OUT}/${name} (${VERSION})"
  go build \
    -trimpath \
    -ldflags "${LDFLAGS}" \
    -o "${OUT}/${name}" \
    "./cmd/${cmd}"
done

echo "done"
