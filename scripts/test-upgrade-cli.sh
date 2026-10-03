#!/usr/bin/env bash
# Check installer/CLI lock inheritance in an isolated configuration directory.
# Usage: X_UI_TEST_CLI=/path/to/linux-cli bash scripts/test-upgrade-cli.sh
set -euo pipefail
umask 077
cli="${X_UI_TEST_CLI:?Set X_UI_TEST_CLI to the built Linux CLI}"
if [[ -n "${X_UI_TEST_SERVICE:-}" ]]; then
  "${X_UI_TEST_SERVICE}" -test.run "${X_UI_TEST_PATTERN:-Upgrade|ReleaseArchive|InterruptedUpgrade|GithubUpgrade|PanelRestart|CoreRestart|SubscriptionSettings|PanelSettings|Maintenance}" -test.timeout="${X_UI_TEST_TIMEOUT:-120s}" -test.v
fi
test_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
work="$(mktemp -d "${test_parent}/x-ui-upgrade-cli.XXXXXXXX")"
cleanup() {
  if [[ "${work}" != "${test_parent}"/x-ui-upgrade-cli.* ]]; then return 1; fi
  rm -rf -- "${work}"
}
trap cleanup EXIT
export X_UI_CONFIG_DIR="${work}/configs"
mkdir -p "${X_UI_CONFIG_DIR}/.host-maintenance"
gate="${X_UI_CONFIG_DIR}/.host-maintenance/gate.lock"
exec {installer_fd}>"${gate}"
flock -n "${installer_fd}"
if "${cli}" database -unknown >"${work}/blocked.log" 2>&1; then exit 1; fi
grep -q 'being applied' "${work}/blocked.log"
export X_UI_INSTALLER_LOCK_FD="${installer_fd}"
if "${cli}" database -unknown >"${work}/inherited.log" 2>&1; then exit 1; fi
grep -q 'flag provided but not defined' "${work}/inherited.log"
export X_UI_INSTALLER_LOCK_FD=0
if "${cli}" database -unknown >"${work}/invalid.log" 2>&1; then exit 1; fi
grep -q 'being applied' "${work}/invalid.log"
echo 'Upgrade CLI lock checks passed (blocked writes, inherited installer lock, invalid descriptor).'
