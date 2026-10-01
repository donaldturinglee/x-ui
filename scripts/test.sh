#!/usr/bin/env bash
#
# Run the Go tests.
#
# They need no database: everything covered is reachable without one, which is
# what lets a fresh checkout run the suite before it has a PostgreSQL to point
# anything at.
#
# Usage:
#   scripts/test.sh
#   scripts/test.sh -run TestLoad ./internal/config/

set -euo pipefail

cd "$(dirname "$0")/.."

args=("$@")
if [ "${#args[@]}" -eq 0 ]; then
  args=(./...)
fi

exec go test "${args[@]}"
