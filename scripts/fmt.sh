#!/usr/bin/env bash
#
# Format the Go source, or report what is unformatted.
#
# Usage:
#   scripts/fmt.sh                  # rewrite anything that needs it
#   scripts/fmt.sh -check           # change nothing; exit 1 if anything would

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${1:-}" = "-check" ] || [ "${1:-}" = "--check" ]; then
  # gofmt -l lists what it would rewrite and says nothing when there is
  # nothing, so the listing being non-empty is the whole check. It is what CI
  # runs, which is why this reports rather than rewriting: a build that
  # silently reformats the source hides the thing it was meant to catch.
  unformatted="$(gofmt -l . 2>/dev/null)"
  if [ -n "${unformatted}" ]; then
    echo "not gofmt'd:"
    echo "${unformatted}"
    exit 1
  fi
  exit 0
fi

exec go fmt ./...
