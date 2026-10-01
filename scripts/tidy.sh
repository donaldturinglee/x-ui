#!/usr/bin/env bash
#
# Tidy go.mod and go.sum.
#
# Usage:
#   scripts/tidy.sh

set -euo pipefail

cd "$(dirname "$0")/.."

exec go mod tidy
