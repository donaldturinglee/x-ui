#!/usr/bin/env bash
#
# List the scripts beside it and what each one does.
#
# The summary it prints is the third line of each script -- the one after the
# shebang and its blank comment -- so a script documents itself in the place its
# reader already looks, and there is no list here to fall out of date.
#
# Usage:
#   scripts/help.sh

set -euo pipefail

cd "$(dirname "$0")/.."

echo "Usage: scripts/<script>.sh [flags]"
echo
echo "Scripts:"

for script in scripts/*.sh; do
  name="$(basename "${script}")"
  # common.sh is sourced by the others rather than run, so it is not a command
  # and does not belong in a list of them.
  if [ "${name}" = "common.sh" ]; then
    continue
  fi
  summary="$(sed -n '3s/^# \{0,1\}//p' "${script}")"
  printf "  %-14s %s\n" "${name}" "${summary}"
done

echo
echo "Every script carries a usage block at the top of the file. Configuration is"
echo "read from X_UI_CONFIG_DIR (default: configs), and any X_UI_*"
echo "variable overrides what configs/config.yaml says."
