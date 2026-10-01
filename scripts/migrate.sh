#!/usr/bin/env bash
#
# Run database migrations through the CLI.
#
# The API and the worker both migrate on startup, so this is for the cases
# where that is not what you want: inspecting what is pending before a deploy,
# rolling one back, or migrating from a job that runs before anything starts.
#
# Usage:
#   scripts/migrate.sh              # apply everything pending
#   scripts/migrate.sh -status      # list migrations and their state
#   scripts/migrate.sh -down 1      # roll back the newest one (asks first)
#
# The configuration comes from configs/config.yaml, and any X_UI_*
# variable overrides it:
#   X_UI_DATABASE_URL=postgres://... scripts/migrate.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# Either name, because the one build.sh writes carries the host's executable
# suffix and this has to find it on Windows too.
for cli in "bin/x-ui-cli" "bin/x-ui-cli.exe"; do
  if [ -x "${cli}" ]; then
    exec "${cli}" migrate "$@"
  fi
done

# No build yet: run from source rather than failing, so a fresh checkout can
# migrate a development database without building first.
exec go run ./cmd/cli migrate "$@"
