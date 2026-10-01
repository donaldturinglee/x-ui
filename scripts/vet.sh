#!/usr/bin/env bash
#
# Run go vet over every package.
#
# Usage:
#   scripts/vet.sh
#   scripts/vet.sh ./internal/...   # or over part of it

set -euo pipefail

cd "$(dirname "$0")/.."

args=("$@")
if [ "${#args[@]}" -eq 0 ]; then
  args=(./...)
fi

exec go vet "${args[@]}"
