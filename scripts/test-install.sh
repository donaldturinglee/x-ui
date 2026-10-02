#!/usr/bin/env bash
# Exercise the real installer functions in a private filesystem with fake
# packages/services. No host services, database, client or inbound are created.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/x-ui-install-test.XXXXXXXX")"
cleanup() {
  local status=$?
  if [[ ${status} -ne 0 ]]; then
    for log in "${test_root}/"*.log; do
      if [[ -f "${log}" ]]; then tail -n 20 "${log}" >&2; fi
    done
    if [[ "${X_UI_TEST_KEEP_FAILURE:-false}" == true ]]; then
      echo "Retained failed test: ${test_root}" >&2
      return
    fi
  fi
  rm -rf -- "${test_root}"
}
trap cleanup EXIT
export X_UI_TEST_ROOT="${test_root}"
export X_UI_TEST_REAL_FLOCK="$(command -v flock)"
if [[ "${X_UI_TEST_TRACE:-false}" == true ]]; then set -x; fi
mkdir -p "${test_root}/tools" "${test_root}/state" "${test_root}/archive/x-ui/bin" "${test_root}/archive/x-ui/migrations" "${test_root}/archive/x-ui/web/build" "${test_root}/services" "${test_root}/core"

for script in install.sh x-ui.sh scripts/core-reload.sh scripts/package.sh; do
  bash -n "${repo}/${script}"
done
if bash "${repo}/install.sh" --with-node >"${test_root}/removed-option.log" 2>&1; then
  echo "Removed option was accepted" >&2
  exit 1
fi
grep -q 'Unknown option' "${test_root}/removed-option.log"

# Only source function definitions; the entry point is tested separately with
# fake host checks. All writable paths belong to this private test root.
awk '/^check_install_host\(\)/ { copying=1 } /^echo -e .*Executing/ { exit } copying { print }' "${repo}/install.sh" >"${test_root}/installer-functions.sh"
awk '/^echo -e .*Executing/ { copying=1 } copying { print }' "${repo}/install.sh" >"${test_root}/installer-entry.sh"

cat >"${test_root}/run-dependency-checks.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "${X_UI_TEST_ROOT}/installer-functions.sh"
red='' green='' yellow='' plain=''
checks=0
fail() { echo "Dependency check failed: $*" >&2; exit 1; }
reset_fixture() {
  release=debian release_like='' packager=apt
  available_managers=(apt-get dnf yum zypper pacman)
  unavailable_commands=()
  package_calls=()
  ca_installed=true trust_bundle_ready=true
  fail_index=false fail_install=false keep_missing=false
  install_repairs_ca=true fail_ca_refresh=false
}
# Model availability independently of the packages the installer selects.
# Every package operation below is a shell function, never a host command.
command() {
  if [[ "${1:-}" != -v ]]; then builtin command "$@"; return; fi
  local name="$2" item
  for item in "${unavailable_commands[@]}"; do
    if [[ "${name}" == "${item}" ]]; then return 1; fi
  done
  case "${name}" in
    apt-get | dnf | yum | zypper | pacman)
      for item in "${available_managers[@]}"; do
        if [[ "${name}" == "${item}" ]]; then printf '/fixture/%s\n' "${name}"; return 0; fi
      done
      return 1 ;;
  esac
  printf '/fixture/%s\n' "${name}"
}
ca_trust_bundle_ready() { [[ "${trust_bundle_ready}" == true ]]; }
dpkg-query() { [[ "${ca_installed}" == true ]] && printf 'install ok installed'; }
rpm() { [[ "${ca_installed}" == true ]]; }
package_action() {
  local manager="$1"
  shift
  package_calls+=("${manager} $*")
  case " $* " in
    *' update '* | *' refresh '*) [[ "${fail_index}" == false ]]; return ;;
  esac
  if [[ "${fail_install}" == true ]]; then return 19; fi
  if [[ "${keep_missing}" == false ]]; then unavailable_commands=(); fi
  ca_installed=true
  if [[ "${install_repairs_ca}" == true ]]; then trust_bundle_ready=true; fi
}
apt-get() { package_action apt-get "$@"; }
dnf() { package_action dnf "$@"; }
yum() { package_action yum "$@"; }
zypper() { package_action zypper "$@"; }
pacman() {
  if [[ "${1:-}" == -Q ]]; then [[ "${ca_installed}" == true ]]; return; fi
  package_action pacman "$@"
}
update-ca-certificates() {
  package_calls+=("update-ca-certificates $*")
  if [[ "${fail_ca_refresh}" == true ]]; then return 21; fi
  trust_bundle_ready=true
}
update-ca-trust() {
  package_calls+=("update-ca-trust $*")
  if [[ "${fail_ca_refresh}" == true ]]; then return 21; fi
  trust_bundle_ready=true
}
assert_calls() {
  local expected i=0
  [[ ${#package_calls[@]} -eq $# ]] || fail "unexpected operations: ${package_calls[*]}"
  for expected in "$@"; do
    [[ "${package_calls[i]}" == "${expected}" ]] || fail "expected '${expected}', got '${package_calls[i]}'"
    i=$((i + 1))
  done
  checks=$((checks + 1))
}

# ID wins even when all package managers exist. Unknown derivatives use the
# ordered ID_LIKE families; a missing native manager must not choose a foreign one.
for distribution in debian ubuntu fedora rhel centos rocky almalinux ol amzn opensuse-leap opensuse-tumbleweed suse sles sled arch manjaro endeavouros; do
  reset_fixture
  release="${distribution}"
  release_like='debian'
  detect_package_manager
  case "${distribution}" in
    debian | ubuntu) expected=apt ;;
    opensuse* | suse | sles | sled) expected=zypper ;;
    arch | manjaro | endeavouros) expected=pacman ;;
    *) expected=dnf ;;
  esac
  [[ "${packager}" == "${expected}" ]] || fail "wrong manager for ${distribution}: ${packager}"
  checks=$((checks + 1))
done
reset_fixture
release=derivative release_like='unknown ubuntu debian rhel'
detect_package_manager
[[ "${packager}" == apt ]] || fail 'ID_LIKE order was ignored'
reset_fixture
release=centos available_managers=(apt-get yum zypper pacman)
detect_package_manager
[[ "${packager}" == yum ]] || fail 'legacy RPM host did not use yum'
reset_fixture
release=unknown
if detect_package_manager >"${X_UI_TEST_ROOT}/unknown-distro.log" 2>&1; then fail 'unknown distribution accepted'; fi
reset_fixture
release=ubuntu release_like=rhel available_managers=(dnf)
if detect_package_manager >"${X_UI_TEST_ROOT}/missing-manager.log" 2>&1; then fail 'foreign manager fallback accepted'; fi
assert_calls

# All dependencies ready: no index refresh or install on any backend.
for manager in apt dnf yum zypper pacman; do
  reset_fixture
  packager="${manager}"
  install_base
  assert_calls
done

# Missing commands select and deduplicate the exact native packages. Neither
# a working awk nor guaranteed Bash/curl is replaced (including curl-minimal).
for manager in apt dnf yum zypper pacman; do
  reset_fixture
  packager="${manager}"
  unavailable_commands=(tar gzip awk sha256sum uname mktemp install od tr grep sed flock su psql pg_dump pg_restore)
  ca_installed=false trust_bundle_ready=false
  install_base
  case "${manager}" in
    apt) assert_calls 'apt-get update -q' 'apt-get install -y -q tar gzip gawk coreutils grep sed util-linux postgresql-client ca-certificates' ;;
    dnf | yum) assert_calls "${manager} install -y -q tar gzip gawk coreutils grep sed util-linux postgresql ca-certificates" ;;
    zypper) assert_calls 'zypper -q refresh' 'zypper -q install -y tar gzip gawk coreutils grep sed util-linux postgresql ca-certificates-mozilla' ;;
    pacman) assert_calls 'pacman -Syu --noconfirm --needed tar gzip gawk coreutils grep sed util-linux postgresql ca-certificates' ;;
  esac
  # A second run must neither refresh indexes nor reinstall packages.
  package_calls=()
  install_base
  assert_calls
done
reset_fixture
unavailable_commands=(sha256sum uname od)
install_base
assert_calls 'apt-get update -q' 'apt-get install -y -q coreutils'
reset_fixture
X_UI_DATABASE_URL='postgres://external.invalid/x_ui?sslmode=require'
unavailable_commands=(psql pg_dump pg_restore)
install_postgresql() { fail 'external database caused server installation'; }
setup_local_database() { fail 'external database caused local initialization'; }
install_base
assert_calls 'apt-get update -q' 'apt-get install -y -q postgresql-client'
unset X_UI_DATABASE_URL

# An installed CA package with a missing bundle still requires repair.
for manager in apt dnf yum zypper pacman; do
  reset_fixture
  packager="${manager}"
  trust_bundle_ready=false install_repairs_ca=false
  install_base
  case "${manager}" in
    apt) assert_calls 'apt-get update -q' 'apt-get install -y -q ca-certificates' 'update-ca-certificates ' ;;
    dnf | yum) assert_calls "${manager} install -y -q ca-certificates" 'update-ca-trust extract' ;;
    zypper) assert_calls 'zypper -q refresh' 'zypper -q install -y ca-certificates-mozilla' 'update-ca-certificates ' ;;
    pacman) assert_calls 'pacman -Syu --noconfirm --needed ca-certificates' 'update-ca-trust extract' ;;
  esac
done

# Explicit error returns must work even inside an if, where errexit is disabled.
for manager in apt zypper; do
  reset_fixture
  packager="${manager}" unavailable_commands=(tar) fail_index=true
  if install_base >"${X_UI_TEST_ROOT}/dependency-index-${manager}.log" 2>&1; then fail 'index failure ignored'; fi
  if [[ "${manager}" == apt ]]; then assert_calls 'apt-get update -q'; else assert_calls 'zypper -q refresh'; fi
done
for manager in apt dnf yum zypper pacman; do
  reset_fixture
  packager="${manager}" unavailable_commands=(tar) fail_install=true
  if install_base >"${X_UI_TEST_ROOT}/dependency-install-${manager}.log" 2>&1; then fail 'package failure ignored'; fi
  checks=$((checks + 1))
done
reset_fixture
unavailable_commands=(tar) keep_missing=true
if install_base >"${X_UI_TEST_ROOT}/dependency-verify.log" 2>&1; then fail 'missing command after success ignored'; fi
reset_fixture
trust_bundle_ready=false install_repairs_ca=false fail_ca_refresh=true
if install_base >"${X_UI_TEST_ROOT}/dependency-ca.log" 2>&1; then fail 'CA refresh failure ignored'; fi

# Run the real entry point in a separate process. A package failure must stop
# before architecture detection, release downloads or panel replacement.
cat >"${X_UI_TEST_ROOT}/run-failing-preparation.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
source "${X_UI_TEST_ROOT}/installer-functions.sh"
red='' green='' yellow='' plain='' release_tag=''
check_install_host() { release=debian; packager=apt; }
ca_certificates_ready() { return 0; }
command() {
  if [[ "${1:-}" == -v && "$2" == tar ]]; then return 1; fi
  if [[ "${1:-}" == -v ]]; then return 0; fi
  builtin command "$@"
}
apt-get() { [[ "$1" == update ]]; }
detect_architecture() { touch "${X_UI_TEST_ROOT}/preparation-proceeded"; }
install_x_ui() { touch "${X_UI_TEST_ROOT}/preparation-proceeded"; }
source "${X_UI_TEST_ROOT}/installer-entry.sh"
INNER
if bash "${X_UI_TEST_ROOT}/run-failing-preparation.sh" >"${X_UI_TEST_ROOT}/dependency-entry.log" 2>&1; then fail 'entry point ignored preparation failure'; fi
[[ ! -e "${X_UI_TEST_ROOT}/preparation-proceeded" ]] || fail 'entry point continued after preparation failure'
echo "Dependency regression checks passed (${checks} checks: distribution selection, missing-only installation, CA repair, external database clients and early failure)."
EOF
bash "${test_root}/run-dependency-checks.sh" >"${test_root}/dependencies.log" 2>&1
cat "${test_root}/dependencies.log"

cat >"${test_root}/tools/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="${X_UI_TEST_ROOT}"
action="$1"
shift
name="${*: -1}"
name="${name%.service}"
case "${action}" in
  is-active) [[ -f "${root}/state/${name}.active" ]] ;;
  is-enabled) [[ -f "${root}/state/${name}.enabled" ]] ;;
  start|restart|reload-or-restart)
    if [[ "${action}" == reload-or-restart && "${X_UI_TEST_CORE_RELOAD_FAIL:-false}" == true ]] && grep -q '"new"' "${root}/core/config.json"; then
      exit 19
    fi
    touch "${root}/state/${name}.active" ;;
  stop) rm -f "${root}/state/${name}.active" ;;
  enable) touch "${root}/state/${name}.enabled"; if [[ " $* " == *' --now '* ]]; then touch "${root}/state/${name}.active"; fi ;;
  disable) rm -f "${root}/state/${name}.enabled" ;;
  cat) [[ "${name}" == "sing-box" || -f "${root}/services/${name}.service" ]] ;;
  show) echo root ;;
  daemon-reload|reset-failed) : ;;
  *) echo "Unexpected service operation: ${action}" >&2; exit 1 ;;
esac
EOF
cat >"${test_root}/tools/sing-box" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == check ]]
echo "core-check" >>"${X_UI_TEST_ROOT}/events"
if [[ "${X_UI_TEST_CORE_INVALID:-false}" == true ]]; then exit 7; fi
EOF
cat >"${test_root}/tools/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${X_UI_TEST_CORE_BUSY:-false}" == true ]]; then exit 1; fi
exec "${X_UI_TEST_REAL_FLOCK}" "$@"
EOF
cat >"${test_root}/tools/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"${test_root}/tools/install" <<'EOF'
#!/usr/bin/env bash
# Keep real copying and permission changes, but omit privileged owner changes
# when this test runs as a CI user rather than root.
set -euo pipefail
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "${args[@]}"
EOF
cat >"${test_root}/tools/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then output="$2"; shift 2; else url="$1"; shift; fi
done
case "${url}" in
  */x-ui-linux-amd64.tar.gz) cp "${X_UI_TEST_ROOT}/release.tar.gz" "${output}" ;;
  */SHA256SUMS) cp "${X_UI_TEST_ROOT}/SHA256SUMS" "${output}" ;;
  *) exit 1 ;;
esac
EOF
cat >"${test_root}/archive/x-ui/bin/x-ui-cli" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="${X_UI_TEST_ROOT}"
command="$1"
shift
echo "cli:${command}:$*" >>"${root}/events"
case "${command}" in
  version) echo 'x-ui fixture' ;;
  help)
    printf '    node configure\n    database backup\n'
    # Help producers must finish successfully, even when the matching line is
    # followed by more output than fits in a pipe (grep -q/SIGPIPE regression).
    for ((i=0; i<1000; i++)); do printf '    other explanatory help text\n'; done ;;
  database)
    case "$1" in
      -check) : ;;
      -backup) cp "${root}/database" "$2"; printf '{}' >"$2.connection.json" ;;
      -restore) cp "$2" "${root}/database" ;;
      *) exit 1 ;;
    esac ;;
  migrate)
    echo migrated >"${root}/database"
    if [[ "${X_UI_TEST_FAIL:-}" == migrate ]]; then exit 17; fi ;;
  seed) echo 'created operator fixture' ;;
  node)
    case "$1" in
      -setup)
        directory="$3"
        mkdir -p "${directory}"
        if [[ ! -f "${directory}/agent.env" ]]; then
          printf 'X_UI_AGENT_PANEL_TOKEN="fixture-token"\nX_UI_AGENT_STATS_SECRET="fixture-secret"\n' >"${directory}/agent.env"
        fi
        echo 'stats: native' >"${directory}/agent.yaml"
        echo native-config >"${root}/database" ;;
      -check)
        if [[ "${X_UI_TEST_FAIL:-}" == statistics ]]; then exit 18; fi
        cmp "${root}/node/config.json" "${root}/core/config.json"
        echo native-statistics-read >>"${root}/events" ;;
      *) exit 1 ;;
    esac ;;
  healthcheck)
    [[ "$*" == '-subscription' || "$#" == 0 ]] ;;
  *) echo "Unexpected CLI operation: ${command}" >&2; exit 1 ;;
esac
EOF
cat >"${test_root}/archive/x-ui/bin/x-ui-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == -h ]]; then echo '-env-file -sync-once'; exit 0; fi
echo '{"services":[]}' >"${X_UI_TEST_ROOT}/node/config.json"
cp "${X_UI_TEST_ROOT}/node/config.json" "${X_UI_TEST_ROOT}/core/config.json"
touch "${X_UI_TEST_ROOT}/state/sing-box.active"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' >"${test_root}/archive/x-ui/x-ui.sh"
for binary in x-ui-api x-ui-worker x-ui-core-reload; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"${test_root}/archive/x-ui/bin/${binary}"
done
for service in x-ui-api x-ui-worker x-ui-agent; do
  printf '[Service]\n' >"${test_root}/archive/x-ui/${service}.service"
done
echo migration >"${test_root}/archive/x-ui/migrations/001_fixture.up.sql"
echo panel >"${test_root}/archive/x-ui/web/build/index.html"
chmod +x "${test_root}/tools/"* "${test_root}/archive/x-ui/bin/"* "${test_root}/archive/x-ui/x-ui.sh"
tar -czf "${test_root}/release.tar.gz" -C "${test_root}/archive" x-ui
printf '%s  x-ui-linux-amd64.tar.gz\n' "$(sha256sum "${test_root}/release.tar.gz" | cut -d ' ' -f 1)" >"${test_root}/SHA256SUMS"
export PATH="${test_root}/tools:${PATH}"
echo initial >"${test_root}/database"

cat >"${test_root}/run-install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "${X_UI_TEST_ROOT}/installer-functions.sh"
red='' green='' yellow='' plain=''
INSTALL_DIR="${X_UI_TEST_ROOT}/panel"
CONFIG_DIR="${INSTALL_DIR}/configs"
CONFIG_FILE="${CONFIG_DIR}/config.yaml"
CLI="${X_UI_TEST_ROOT}/cli"
MENU="${X_UI_TEST_ROOT}/menu"
NODE_DIR="${X_UI_TEST_ROOT}/node"
CORE_DIR="${X_UI_TEST_ROOT}/core"
SERVICE_DIR="${X_UI_TEST_ROOT}/services"
BACKUP_ROOT="${X_UI_TEST_ROOT}/backups"
SERVICES=(x-ui-api x-ui-worker)
ALL_SERVICES=(x-ui-api x-ui-worker sing-box x-ui-agent)
REPOSITORY=fixture/release
arch=amd64
init_system=systemd
packager=apt
backup_dir=''
rollback_required=false
database_backup_available=false
local_database_credentials_generated=false
setup_local_database() { set_config database.password fixture-password; }
show_uri() { :; }
install_x_ui fixture </dev/null
EOF

bash "${test_root}/run-install.sh" >"${test_root}/fresh.log" 2>&1
for service in x-ui-api x-ui-worker sing-box x-ui-agent; do
  [[ -f "${test_root}/state/${service}.active" && -f "${test_root}/state/${service}.enabled" ]]
done
grep -q native-statistics-read "${test_root}/events"
grep -q 'cli:healthcheck:-subscription' "${test_root}/events"
cp "${test_root}/node/agent.env" "${test_root}/credentials.before"
bash "${test_root}/run-install.sh" >"${test_root}/repeat.log" 2>&1
cmp "${test_root}/credentials.before" "${test_root}/node/agent.env"

# An existing panel-only installation must receive the node without an option.
rm -f "${test_root}/state/sing-box.active" "${test_root}/state/sing-box.enabled" "${test_root}/state/x-ui-agent.active" "${test_root}/state/x-ui-agent.enabled"
bash "${test_root}/run-install.sh" >"${test_root}/panel-only.log" 2>&1
for service in sing-box x-ui-agent; do
  [[ -f "${test_root}/state/${service}.active" && -f "${test_root}/state/${service}.enabled" ]]
done

# A late failure must restore the original files and database together.
echo original-version >>"${test_root}/panel/bin/x-ui-api"
cp "${test_root}/panel/bin/x-ui-api" "${test_root}/binary.before"
cp "${test_root}/database" "${test_root}/database.before"
for failure in migrate statistics; do
  set +e
  X_UI_TEST_FAIL="${failure}" bash "${test_root}/run-install.sh" >"${test_root}/${failure}.log" 2>&1
  result=$?
  set -e
  [[ ${result} -ne 0 ]]
  cmp "${test_root}/binary.before" "${test_root}/panel/bin/x-ui-api"
  cmp "${test_root}/database.before" "${test_root}/database"
  cmp "${test_root}/credentials.before" "${test_root}/node/agent.env"
  for service in x-ui-api x-ui-worker sing-box x-ui-agent; do
    [[ -f "${test_root}/state/${service}.active" && -f "${test_root}/state/${service}.enabled" ]]
  done
  grep -q 'Previous installation and service state restored' "${test_root}/${failure}.log"
done

# Exercise the actual reload helper with private files and simulated service
# failure. Both validation and rollback happen without any inbound.
source_path="${test_root}/node/helper-candidate.json"
target_path="${test_root}/core/config.json"
echo '{"old":true}' >"${target_path}"
echo '{"new":true}' >"${source_path}"
cp "${test_root}/events" "${test_root}/events.before-lock"
if X_UI_TEST_CORE_BUSY=true bash "${repo}/scripts/core-reload.sh" "${source_path}" "${target_path}" >"${test_root}/busy-core.log" 2>&1; then
  echo 'Core application ignored the restart lock' >&2
  exit 1
fi
grep -q '"old"' "${target_path}"
cmp "${test_root}/events.before-lock" "${test_root}/events"
if X_UI_TEST_CORE_INVALID=true bash "${repo}/scripts/core-reload.sh" "${source_path}" "${target_path}" >"${test_root}/invalid-core.log" 2>&1; then
  echo 'Invalid candidate was applied' >&2
  exit 1
fi
grep -q '"old"' "${target_path}"
if X_UI_TEST_CORE_RELOAD_FAIL=true bash "${repo}/scripts/core-reload.sh" "${source_path}" "${target_path}" >"${test_root}/core-rollback.log" 2>&1; then
  echo 'Failed reload was accepted' >&2
  exit 1
fi
grep -q '"old"' "${target_path}"
bash "${repo}/scripts/core-reload.sh" "${source_path}" "${target_path}"
cmp "${source_path}" "${target_path}"
[[ "$(stat -c '%a' "${target_path}")" == 640 ]]
echo 'Installer regression checks passed (fresh/repeated/panel-only installs, migration/statistics failure recovery, core restart lock, validation and reload rollback).'
