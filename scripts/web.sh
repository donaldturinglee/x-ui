#!/usr/bin/env bash
#
# Drive the panel's npm toolchain from the repository root.
#
# The panel is a separate toolchain and a Go checkout is expected to build and
# test without one, which is why nothing here is reached by check.sh: only this
# script needs npm.
#
# Usage:
#   scripts/web.sh install          # once
#   scripts/web.sh dev              # :3000, proxying the API
#   scripts/web.sh build            # into web/build, where the API serves it
#   scripts/web.sh check            # lint, types and unit tests, as CI runs them
#   scripts/web.sh e2e              # Playwright, against a mocked API

set -euo pipefail

cd "$(dirname "$0")/.."

WEB="web"

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/web.sh <install|dev|build|check|e2e>" >&2
  exit 1
fi

command="$1"
shift

cd "${WEB}"

case "${command}" in
  install)
    exec npm install "$@"
    ;;
  dev)
    exec npm run dev "$@"
    ;;
  build)
    exec npm run build "$@"
    ;;
  check)
    npm run lint
    npm run typecheck
    exec npm run test
    ;;
  e2e)
    exec npm run test:e2e "$@"
    ;;
  *)
    echo "no such command: ${command}" >&2
    echo "usage: scripts/web.sh <install|dev|build|check|e2e>" >&2
    exit 1
    ;;
esac
