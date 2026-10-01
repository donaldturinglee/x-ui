#!/usr/bin/env bash
#
# Run one of the binaries from source.
#
# The version is stamped in the same way a built binary's is, so what the panel
# reports while it is being worked on is what it will report once it is built.
#
# Usage:
#   scripts/run.sh api               # the HTTP server
#   scripts/run.sh worker            # the scheduled jobs
#   scripts/run.sh agent             # the node agent
#
# Anything after the name is passed to the command:
#   scripts/run.sh agent -config configs/agent.yaml

set -euo pipefail

source "$(dirname "$0")/common.sh"

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/run.sh <api|worker|agent> [flags]" >&2
  exit 1
fi

cmd="$1"
shift

if [ ! -d "./cmd/${cmd}" ]; then
  echo "no such command: ${cmd}" >&2
  exit 1
fi

exec go run -ldflags "${LDFLAGS}" "./cmd/${cmd}" "$@"
