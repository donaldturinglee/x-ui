#!/usr/bin/env bash
#
# Shared setup for the scripts beside it.
#
# Not a command of its own: every script sources this instead of repeating the
# version stamping. That has to agree between a binary built by build.sh and one
# run from source by run.sh, because a version that differs between the two is a
# bug report nobody can place.

# Every script works from the repository root, so a relative path means the same
# thing wherever the script was called from.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODULE="github.com/donaldturinglee/x-ui"
OUT="${OUT:-bin}"

# The version is stamped in rather than compiled from a constant, so a binary
# reports the commit it was actually built from. Falls back to the git
# description, then to "dev" outside a checkout.
if [ -z "${VERSION:-}" ]; then
  VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo dev)"
fi

# -s -w drop the symbol table and DWARF. They are of no use in a deployed
# service and are a third of the binary.
LDFLAGS="-s -w -X ${MODULE}/internal/config.Version=${VERSION}"

# CGO buys nothing here -- the Postgres driver is pure Go -- and turning it off
# is what makes the binaries portable across the distributions they are
# deployed on.
export CGO_ENABLED="${CGO_ENABLED:-0}"
