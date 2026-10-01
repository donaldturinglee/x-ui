#!/usr/bin/env bash
#
# Create the root account through the CLI.
#
# The one step between a migrated database and being able to sign in. Safe to
# run again: an existing account is left exactly as it is, so a deploy script
# that runs this every time never rewrites a password an operator has since
# changed.
#
# Usage:
#   scripts/seed.sh                                  # from the environment
#   scripts/seed.sh -username operator -password ... # or from flags
#
# Without flags the credentials come from X_UI_ROOT_USERNAME and
# X_UI_ROOT_PASSWORD, which is the pair the API reads when it bootstraps
# at startup. Nothing is invented: with neither, this fails rather than picking
# a password.

set -euo pipefail

cd "$(dirname "$0")/.."

# Either name, because the one build.sh writes carries the host's executable
# suffix and this has to find it on Windows too.
for cli in "bin/x-ui-cli" "bin/x-ui-cli.exe"; do
  if [ -x "${cli}" ]; then
    exec "${cli}" seed "$@"
  fi
done

# No build yet: run from source rather than failing, so a fresh checkout can
# seed a development database without building first.
exec go run ./cmd/cli seed "$@"
