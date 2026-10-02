#!/usr/bin/env bash
#
# Everything CI runs for the Go side: formatting, vet and the unit tests.
#
# The panel has a toolchain of its own and is checked by web.sh, so a Go
# checkout passes this without npm installed.
#
# Usage:
#   scripts/check.sh

set -euo pipefail

here="$(dirname "$0")"

"${here}/fmt.sh" -check
"${here}/vet.sh"
"${here}/test.sh"
"${here}/test-install.sh"
"${here}/test-release.sh"
