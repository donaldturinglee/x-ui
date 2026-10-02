#!/usr/bin/env bash
#
# Install or upgrade x-ui on a Linux host, from a published release.
#
# Run as root on the host the panel is to live on. It downloads the release
# archive for this host's CPU, checks it against the SHA256SUMS published beside
# it, and sets up the panel, local sing-box core and agent with a PostgreSQL database
# -- one it installs on this host unless it is pointed at another. Run again, it
# upgrades in place and keeps the database, the settings and the accounts.
#
# Usage:
#   bash <(curl -Ls https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh)
#   bash <(curl -Ls https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh) v1.2.0
#
# With X_UI_DATABASE_URL set, that database is used and PostgreSQL on
# this host is neither installed nor touched:
#   X_UI_DATABASE_URL='postgres://x_ui:...@db.example.com/x_ui?sslmode=require' \
#     bash <(curl -Ls https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh)
#
# The archives are the ones scripts/package.sh builds. What this leaves on the
# host:
#   /usr/local/x-ui/                      the binaries, the migrations and the panel
#   /usr/local/x-ui/configs/config.yaml   every setting it made, the secrets among them
#   /usr/bin/x-ui-cli                     the CLI, run with those settings
#   /usr/bin/x-ui                         the menu that manages the rest (x-ui.sh)
#   x-ui-api, x-ui-worker                 panel services, enabled under systemd
#   sing-box, x-ui-agent                  local node, statistics and configuration sync

set -euo pipefail

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

REPOSITORY="donaldturinglee/x-ui"

# Everything the install owns is below this directory, apart from the services
# and the CLI and the menu on the PATH, so an upgrade knows what it may replace
# and removing it removes the panel.
INSTALL_DIR="/usr/local/x-ui"
# Where the binaries look for their configuration when started in INSTALL_DIR,
# which is where the services start them.
CONFIG_DIR="${INSTALL_DIR}/configs"
CONFIG_FILE="${CONFIG_DIR}/config.yaml"
CLI="/usr/bin/x-ui-cli"
MENU="/usr/bin/x-ui"
SERVICES=(x-ui-api x-ui-worker)
ALL_SERVICES=(x-ui-api x-ui-worker sing-box x-ui-agent)
NODE_DIR="/etc/x-ui"
CORE_DIR="/etc/sing-box"
SERVICE_DIR="/etc/systemd/system"
BACKUP_ROOT="/usr/local/x-ui-backups"
backup_dir=""
rollback_required=false
database_backup_available=false
# Only a local database setup in this run has credentials to show after a successful install.
local_database_credentials_generated=false
release_tag=""

usage() {
  echo "Usage: install.sh [release-tag]"
  echo "  Installs the panel, sing-box and local node agent together."
}

for arg in "$@"; do
  case "${arg}" in
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: ${arg}" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -n "${release_tag}" || ! "${arg}" =~ ^[A-Za-z0-9._+-]+$ ]]; then
        echo "Expected one release tag (letters, digits, dot, underscore, plus or hyphen)" >&2
        usage >&2
        exit 1
      fi
      release_tag="${arg}"
      ;;
  esac
done

check_install_host() {
  if [[ ${EUID} -ne 0 ]]; then
    echo -e "${red}Please run this script with root privilege${plain}" >&2
    return 1
  fi
  local ID="" ID_LIKE=""
  if [[ -f /etc/os-release ]]; then
    source /etc/os-release
  elif [[ -f /usr/lib/os-release ]]; then
    source /usr/lib/os-release
  else
    echo -e "${red}Cannot identify this host: os-release is missing${plain}" >&2
    return 1
  fi
  release="${ID:-unknown}"
  release_like="${ID_LIKE:-}"
  echo "The OS release is: ${release}"
  if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    echo -e "${red}The complete panel and node installation requires systemd on this host${plain}" >&2
    return 1
  fi
  init_system="systemd"
  detect_package_manager || return 1
  # Reject unsupported node platforms before changing packages or services.
  if ! command -v sing-box >/dev/null 2>&1 && [[ "${packager}" != "apt" && "${packager}" != "dnf" ]]; then
    echo -e "${red}Automatic sing-box installation requires APT or DNF; install a compatible sing-box systemd package before retrying${plain}" >&2
    return 1
  fi
}

detect_package_manager() {
  local family manager="" families=()
  packager=""
  # Prefer ID, then the ordered ID_LIKE families. An unrelated package manager
  # on PATH must not determine how this distribution's packages are installed.
  read -r -a families <<<"${release} ${release_like:-}"
  for family in "${families[@]}"; do
    case "${family}" in
      debian | ubuntu) packager="apt"; manager="apt-get" ;;
      fedora | rhel | centos | rocky | almalinux | ol | amzn)
        if command -v dnf >/dev/null 2>&1; then
          packager="dnf"; manager="dnf"
        else
          packager="yum"; manager="yum"
        fi
        ;;
      opensuse* | suse | sles | sled) packager="zypper"; manager="zypper" ;;
      arch | archlinux | manjaro | endeavouros) packager="pacman"; manager="pacman" ;;
      *) continue ;;
    esac
    if ! command -v "${manager}" >/dev/null 2>&1; then
      dependency_error "native package manager ${manager} is missing"
      return 1
    fi
    return 0
  done
  dependency_error "unsupported distribution (ID_LIKE=${release_like:-none})"
  return 1
}

detect_architecture() {
  # Run after dependency preparation, so uname is available on minimal hosts.
  case "$(uname -m)" in
    x86_64 | x64 | amd64) arch="amd64" ;;
    i*86 | x86) arch="386" ;;
    armv8* | arm64 | aarch64) arch="arm64" ;;
    armv7* | arm) arch="armv7" ;;
    armv6*) arch="armv6" ;;
    armv5*) arch="armv5" ;;
    s390x) arch="s390x" ;;
    *) echo -e "${red}Unsupported CPU architecture!${plain}" >&2; return 1 ;;
  esac
  echo "arch: ${arch}"
}

# Services are enabled, started and stopped through these, so the steps below
# read the same under systemd and OpenRC.
enable_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-update add "$1" default
  else
    systemctl enable "$1"
  fi
}

start_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-service "$1" start
  else
    systemctl start "$1"
  fi
}

restart_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-service "$1" restart
  else
    systemctl restart "$1"
  fi
}

stop_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-service "$1" stop
  else
    systemctl stop "$1"
  fi
}

# random_hex prints n random bytes as hex: typed without trouble, and quoted
# without trouble in config.yaml, in a shell and in SQL.
random_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

# x-ui.sh, the menu, has copies of config_value, set_config, ask_port,
# ask_path and show_uri for its settings options. A change to one belongs in
# both.

# config_value prints what config.yaml sets a key to, the key named the way the
# configuration names it -- server.port -- or nothing. It reads the file as
# set_config writes it: each key on a line of its own, indented under its
# section.
config_value() {
  if [[ -f "${CONFIG_FILE}" ]]; then
    awk -v section="${1%%.*}" -v key="${1#*.}" -v q="'" -v dq='"' '
      /^[^[:space:]#]/ {
        in_section = ($0 ~ ("^" section ":([[:space:]]|$)"))
        next
      }
      in_section && $0 ~ ("^[[:space:]]+" key ":([[:space:]]|$)") {
        value = $0
        sub("^[[:space:]]+" key ":[[:space:]]*", "", value)
        first = substr(value, 1, 1)
        if (first == q || first == dq) {
          value = substr(value, 2)
          value = substr(value, 1, index(value, first) - 1)
        } else {
          sub(/[[:space:]]+#.*$/, "", value)
          sub(/[[:space:]]+$/, "", value)
        }
        print value
        exit
      }
    ' "${CONFIG_FILE}"
  fi
}

# set_config writes one key into config.yaml: over the line that set it before,
# else as the last line of its section, else in a section of its own at the end.
# Nothing else in the file is touched, so what an operator adds to it stays. A
# value of digits alone is written as a number, which is what a port has to be,
# and anything else single-quoted, which YAML reads verbatim as long as it holds
# no quote or line break -- those are refused.
set_config() {
  local value="$2"
  if [[ "${value}" == *"'"* || "${value}" == *$'\n'* ]]; then
    echo -e "${red}$1 cannot contain a quote or a line break${plain}" >&2
    exit 1
  fi
  if [[ "$(config_value "$1")" == "${value}" ]]; then
    return 0
  fi
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    value="'${value}'"
  fi
  (
    umask 077
    # Two passes over the file: the first finds the section, the key's line in
    # it and the section's last line, and the second writes the file out again
    # with the key in place. The value goes through the environment, since awk
    # would read escapes in a -v one.
    VALUE="${value}" awk -v section="${1%%.*}" -v key="${1#*.}" '
      NR == FNR {
        if ($0 ~ /^[^[:space:]#]/) {
          in_section = ($0 ~ ("^" section ":([[:space:]]|$)"))
          if (in_section) {
            header = FNR
            last = FNR
          }
          next
        }
        if (in_section && $0 ~ /^[[:space:]]+[^[:space:]#]/) {
          last = FNR
          if (indent == "") {
            indent = $0
            sub(/[^[:space:]].*$/, "", indent)
          }
          if (!found && $0 ~ ("^[[:space:]]+" key ":([[:space:]]|$)")) {
            found = FNR
          }
        }
        next
      }
      FNR == found {
        sub(/[^[:space:]].*$/, "")
        print $0 key ": " ENVIRON["VALUE"]
        next
      }
      { print }
      !found && header && FNR == last {
        print (indent == "" ? "  " : indent) key ": " ENVIRON["VALUE"]
      }
      END {
        if (!header) {
          printf "\n%s:\n  %s: %s\n", section, key, ENVIRON["VALUE"]
        }
      }
    ' "${CONFIG_FILE}" "${CONFIG_FILE}" >"${CONFIG_FILE}.next"
    mv -f "${CONFIG_FILE}.next" "${CONFIG_FILE}"
  )
}

dependency_error() {
  echo -e "${red}Dependency preparation failed on ${release} (${packager:-unknown}): $*${plain}" >&2
}

add_dependency_package() {
  # Package names contain no whitespace. The default expansion also handles
  # empty arrays under nounset on older Bash versions used by YUM hosts.
  if [[ " ${missing_packages[*]-} " != *" $1 "* ]]; then
    missing_packages+=("$1")
  fi
}

require_dependency_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    missing_dependencies+=("$1")
    add_dependency_package "$2"
  fi
}

native_package_installed() {
  case "${packager}" in
    apt) [[ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" == "install ok installed" ]] ;;
    dnf | yum | zypper) rpm -q "$1" >/dev/null 2>&1 ;;
    pacman) pacman -Q "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

ca_trust_bundle_ready() {
  local bundle
  local bundles=(/etc/ssl/certs/ca-certificates.crt)
  case "${packager}" in
    dnf | yum) bundles=(/etc/pki/tls/certs/ca-bundle.crt /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem) ;;
    zypper) bundles=(/etc/ssl/ca-bundle.pem /var/lib/ca-certificates/ca-bundle.pem) ;;
  esac
  for bundle in "${bundles[@]}"; do
    if [[ -r "${bundle}" && -s "${bundle}" ]]; then return 0; fi
  done
  return 1
}

ca_certificates_ready() {
  native_package_installed "${ca_package}" && ca_trust_bundle_ready
}

collect_missing_dependencies() {
  local tool postgres_package="postgresql"
  missing_packages=()
  missing_dependencies=()
  ca_package="ca-certificates"
  if [[ "${packager}" == apt ]]; then postgres_package="postgresql-client"; fi
  if [[ "${packager}" == zypper ]]; then ca_package="ca-certificates-mozilla"; fi
  require_dependency_command tar tar
  require_dependency_command gzip gzip
  # Any existing awk (including mawk) is sufficient; do not replace it.
  require_dependency_command awk gawk
  for tool in basename cat chmod chown cp date df dirname id install mkdir mktemp mv od realpath rm sha256sum sleep tail touch tr uname; do
    require_dependency_command "${tool}" coreutils
  done
  require_dependency_command grep grep
  require_dependency_command sed sed
  require_dependency_command flock util-linux
  require_dependency_command su util-linux
  # These are needed for backup/restore even with an external database. Server
  # initialization and service changes remain part of local database setup.
  for tool in psql pg_dump pg_restore; do
    require_dependency_command "${tool}" "${postgres_package}"
  done
  if ! ca_certificates_ready; then
    missing_dependencies+=("CA certificates")
    add_dependency_package "${ca_package}"
  fi
}

install_dependency_packages() {
  # Only refresh indexes when packages are needed. Arch's supported install
  # procedure includes a full upgrade to avoid partial system upgrades.
  case "${packager}" in
    apt)
      if ! apt-get update -q; then dependency_error "package index refresh failed"; return 1; fi
      if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${missing_packages[@]}"; then
        dependency_error "package installation failed: ${missing_packages[*]}"; return 1
      fi
      ;;
    dnf | yum)
      if ! "${packager}" install -y -q "${missing_packages[@]}"; then
        dependency_error "package installation failed: ${missing_packages[*]}"; return 1
      fi
      ;;
    zypper)
      if ! zypper -q refresh; then dependency_error "package index refresh failed"; return 1; fi
      if ! zypper -q install -y "${missing_packages[@]}"; then
        dependency_error "package installation failed: ${missing_packages[*]}"; return 1
      fi
      ;;
    pacman)
      if ! pacman -Syu --noconfirm --needed "${missing_packages[@]}"; then
        dependency_error "package installation failed: ${missing_packages[*]}"; return 1
      fi
      ;;
    *) dependency_error "unsupported package manager"; return 1 ;;
  esac
}

refresh_ca_certificates() {
  local updater="update-ca-certificates" args=()
  if [[ "${packager}" == dnf || "${packager}" == yum || "${packager}" == pacman ]]; then
    updater="update-ca-trust"
    args=(extract)
  fi
  if ! command -v "${updater}" >/dev/null 2>&1 || ! "${updater}" ${args[@]+"${args[@]}"}; then
    dependency_error "CA trust store refresh failed (${updater})"
    return 1
  fi
}

verify_dependencies() {
  collect_missing_dependencies
  if [[ -n "${missing_dependencies[*]-}" ]]; then
    dependency_error "still missing after installation: ${missing_dependencies[*]}"
    return 1
  fi
}

install_base() {
  collect_missing_dependencies
  if [[ -z "${missing_packages[*]-}" ]]; then
    echo -e "${green}Required dependencies are already available${plain}"
    return 0
  fi
  echo -e "${yellow}Installing missing packages with ${packager}: ${missing_packages[*]}${plain}"
  install_dependency_packages || return 1
  if ! ca_certificates_ready; then refresh_ca_certificates || return 1; fi
  verify_dependencies || return 1
}

# as_postgres runs a command as the postgres superuser: the one account a
# packaged PostgreSQL trusts on its own host without a password, over the socket
# and by the Unix user asking. From /, because psql complains about a working
# directory it cannot read, and the installer's is root's.
as_postgres() {
  (cd / && su postgres -s /bin/sh -c "$1")
}

postgresql_ready() {
  as_postgres "psql -X -At -c 'SELECT 1'" >/dev/null 2>&1
}

# wait_for_postgresql gives a server that has just been started the moment it
# takes to open its socket.
wait_for_postgresql() {
  local tries=0
  until postgresql_ready; do
    tries=$((tries + 1))
    if [[ ${tries} -ge 30 ]]; then
      return 1
    fi
    sleep 1
  done
}

# install_postgresql installs the distribution's PostgreSQL server, sets up its
# cluster where the package leaves that to the administrator, and starts it.
install_postgresql() {
  echo -e "${yellow}Installing PostgreSQL...${plain}"
  case "${packager}" in
    apt)
      # The package creates and starts a cluster of its own.
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql
      ;;
    dnf | yum)
      # The RHEL 8 family installs PostgreSQL 10 unless a newer stream is
      # chosen, and the schema calls gen_random_uuid(), which is built in from
      # 13. A host that already chose a stream keeps it.
      if [[ "${PLATFORM_ID:-}" == "platform:el8" ]]; then
        "${packager}" -y -q module enable postgresql:16 ||
          "${packager}" -y -q module enable postgresql:15 ||
          "${packager}" -y -q module enable postgresql:13 || true
      fi
      "${packager}" install -y -q postgresql-server
      if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
        postgresql-setup --initdb
      fi
      ;;
    zypper)
      # The service sets its cluster up the first time it starts.
      zypper -q install -y postgresql-server
      ;;
    pacman)
      pacman -S --noconfirm --needed postgresql
      # initdb trusts every connection from this host unless told otherwise,
      # which would let any user on it in as the superuser.
      if [[ ! -f /var/lib/postgres/data/PG_VERSION ]]; then
        as_postgres "initdb --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 -D /var/lib/postgres/data"
      fi
      ;;
    apk)
      apk add --no-cache postgresql
      # The service sets its cluster up the first time it starts, and its
      # initdb trusts every connection from this host unless told otherwise --
      # so it is told, before that start, the way the service reads it.
      if ! grep -q '^initdb_opts=' /etc/conf.d/postgresql; then
        {
          echo
          echo "# From x-ui's install.sh: no connection from this host goes unchecked."
          echo 'initdb_opts="-E UTF-8 --auth-local=peer --auth-host=scram-sha-256"'
        } >>/etc/conf.d/postgresql
      fi
      ;;
  esac
  enable_service postgresql
  start_service postgresql
}

password_sign_in() {
  PGPASSWORD="$1" psql -X -At -h 127.0.0.1 -p "$2" -U x_ui -d x_ui -c 'SELECT 1' >/dev/null 2>&1
}

# allow_password_sign_in makes sure the panel's role can sign in the way the
# panel does: with its password, over loopback. Debian's clusters allow that as
# packaged, and so do the Alpine and Arch ones set up above, but the RHEL family
# and openSUSE answer loopback with ident, which a role with no Unix account
# behind it never passes. Only then are two lines added -- at the top of
# pg_hba.conf, where they are matched first, and for this role and database
# alone -- and the server told to read the file again. Nothing else in it
# changes.
allow_password_sign_in() {
  local password="$1" port="$2" hba tries=0
  if password_sign_in "${password}" "${port}"; then
    return 0
  fi

  hba="$(as_postgres "psql -X -At -c 'SHOW hba_file'")"
  if ! grep -Eq "^host[[:space:]]+x_ui[[:space:]]+x_ui[[:space:]]" "${hba}"; then
    echo -e "${yellow}Letting the x_ui role sign in with its password in ${hba}...${plain}"
    {
      echo "# x-ui's own role signs in with its password over loopback (install.sh)"
      echo "host    x_ui    x_ui    127.0.0.1/32    scram-sha-256"
      echo "host    x_ui    x_ui    ::1/128         scram-sha-256"
      cat "${hba}"
    } >"${hba}.x-ui"
    # Written back into the file rather than renamed over it, so it keeps the
    # owner and mode the server expects of it.
    cat "${hba}.x-ui" >"${hba}"
    rm -f "${hba}.x-ui"
  fi
  as_postgres "psql -X -At -c 'SELECT pg_reload_conf()'" >/dev/null

  until password_sign_in "${password}" "${port}"; do
    tries=$((tries + 1))
    if [[ ${tries} -ge 10 ]]; then
      echo -e "${red}The x_ui role cannot sign in to PostgreSQL over 127.0.0.1 with its password; check ${hba}${plain}" >&2
      exit 1
    fi
    sleep 1
  done
}

# setup_local_database gives the panel a role and a database of its own on a
# PostgreSQL on this host, installing one first when there is none. The role's
# password is generated here, saved in config.yaml, and shown after success.
setup_local_database() {
  if ! command -v psql >/dev/null 2>&1 || ! id postgres >/dev/null 2>&1; then
    install_postgresql
  elif ! postgresql_ready; then
    # A server installed some other way may run under another service name,
    # which the wait below then reports on.
    start_service postgresql || true
  fi
  if ! wait_for_postgresql; then
    echo -e "${red}PostgreSQL on this host is not accepting connections. Start it, or give the installer another database with X_UI_DATABASE_URL${plain}" >&2
    exit 1
  fi

  local version password port provider=""
  version="$(as_postgres "psql -X -At -c 'SHOW server_version_num'")"
  if [[ "${version}" -lt 130000 ]]; then
    echo -e "${red}x-ui needs PostgreSQL 13 or newer, and this host runs $(as_postgres "psql -X -At -c 'SHOW server_version'")${plain}" >&2
    exit 1
  fi

  echo -e "${yellow}Creating the x_ui role and database...${plain}"
  password="$(random_hex 24)"
  # Handed to psql on its input rather than its command line, where the
  # password would be in the process table for every user on the host to read.
  # SCRAM is asked for by name because PostgreSQL 13 still stores md5 unless
  # told otherwise.
  as_postgres "psql -X -q -v ON_ERROR_STOP=1" <<SQL
SET password_encryption = 'scram-sha-256';
DO \$\$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'x_ui') THEN
    ALTER ROLE x_ui WITH LOGIN PASSWORD '${password}';
  ELSE
    CREATE ROLE x_ui WITH LOGIN PASSWORD '${password}';
  END IF;
END
\$\$;
SQL
  # UTF-8 whatever locale the cluster was made in -- in a container that is
  # often C, which makes SQL_ASCII the default -- and ordered by code point,
  # which no update to the host's collation rules can change under an index.
  # From 15 a cluster can default to ICU, which has no C locale, so libc's is
  # asked for by name.
  if [[ "${version}" -ge 150000 ]]; then
    provider="--locale-provider=libc"
  fi
  if [[ -z "$(as_postgres "psql -X -At -c \"SELECT 1 FROM pg_database WHERE datname = 'x_ui'\"")" ]]; then
    as_postgres "createdb --owner=x_ui --encoding=UTF8 ${provider} --locale=C --template=template0 x_ui"
  fi

  set_config database.user "x_ui"
  set_config database.password "${password}"
  port="$(as_postgres "psql -X -At -c 'SHOW port'")"
  if [[ "${port}" != "5432" ]]; then
    set_config database.port "${port}"
  fi
  allow_password_sign_in "${password}" "${port}"
}

# setup_database settles which database the panel uses, the first time: the
# one X_UI_DATABASE_URL names when the installer is given one, and one on
# this host otherwise. Once config.yaml says, an upgrade leaves it be.
setup_database() {
  if [[ -n "${X_UI_DATABASE_URL:-}" ]]; then
    echo -e "${yellow}Using the database X_UI_DATABASE_URL names; PostgreSQL on this host is left alone${plain}"
    set_config database.url "${X_UI_DATABASE_URL}"
  elif [[ -z "$(config_value database.url)" && -z "$(config_value database.password)" ]]; then
    setup_local_database
    local_database_credentials_generated=true
  fi
}

# write_config_file creates config.yaml the first time, and brings up to date
# what the install itself owns in it: where the migrations and the panel are.
# The paths are absolute, so the services and the CLI agree whichever directory
# they are started in.
write_config_file() {
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    (
      umask 077
      cat >"${CONFIG_FILE}" <<EOF
# x-ui on this host, as install.sh set it up.
#
# Read by the x-ui-api and x-ui-worker services and by
# ${CLI}, so all three reach the same database. It is merged
# over the built-in defaults, so a key left out keeps its default; every key
# there is, and what it does, is in configs/config.yaml in x-ui's
# repository. Restart the services after changing it: x-ui restart.
#
# install.sh and the menu, ${MENU}, change the keys they look after
# in place -- the ports and the subscription path -- so keep
# each key on a line of its own, indented under its section.
#
# It holds the database password and the session secret, so only root reads
# it. Running install.sh again keeps it.
EOF
    )
  fi
  # Whoever made the file, it holds the secrets from here on.
  chmod 600 "${CONFIG_FILE}"
  set_config server.web_dir "${INSTALL_DIR}/web"
  set_config database.migrations_dir "${INSTALL_DIR}/migrations"

  # Generated once and kept. Without one the API makes a new secret every time
  # it starts, and every restart and upgrade signs every operator out.
  if [[ -z "$(config_value session.secret)" ]]; then
    set_config session.secret "$(random_hex 32)"
  fi
}

# install_cli puts the CLI on the PATH. It is a script rather than a link to the
# binary: the CLI looks for its configuration below the directory it is started
# in, and pointing it at the services' own means `x-ui-cli admin -show`
# works from any directory, as the README writes it, and reaches their database.
install_cli() {
  cat >"${CLI}" <<EOF
#!/bin/sh
#
# x-ui-cli, run with the configuration the x-ui services run with.
# Written by install.sh, and replaced by every run of it.

X_UI_CONFIG_DIR="${CONFIG_DIR}"
export X_UI_CONFIG_DIR
exec "${INSTALL_DIR}/bin/x-ui-cli" "\$@"
EOF
  chmod 755 "${CLI}"
}

# install_menu puts the release's menu on the PATH as x-ui, from the
# unpacked archive in $1. It is renamed into place rather than copied over the
# old one: `x-ui update` runs this installer from inside that script, and
# bash reads a script as it runs it, so a file rewritten under it would hand the
# rest of the old run whatever now lies at the same place in the new one.
install_menu() {
  cp "$1/x-ui.sh" "${MENU}.new"
  chmod 755 "${MENU}.new"
  mv -f "${MENU}.new" "${MENU}"
}

# install_openrc_service writes the OpenRC service for one of the two binaries,
# on Alpine and other OpenRC systems.
install_openrc_service() {
  local name="$1" description="$2"
  cat >"/etc/init.d/${name}" <<EOF
#!/sbin/openrc-run

description="${description}"
command="${INSTALL_DIR}/bin/${name}"
command_background=true
# configs/config.yaml below it is the configuration, as under systemd.
directory="${INSTALL_DIR}"
pidfile="/run/${name}.pid"
output_log="/var/log/${name}.log"
error_log="/var/log/${name}.log"
respawn_delay=10
supervisor=supervise-daemon

depend() {
    need localmount
    use net dns logger firewall postgresql
    after net firewall postgresql
}
EOF
  chmod +x "/etc/init.d/${name}"
}

# install_services puts both services in place, enables them, and starts them
# on what was just installed. The systemd units come in the release, from the
# unpacked archive in $1, so they always match the binaries they run; the
# OpenRC ones are written here, as the reference writes its own.
install_services() {
  local service
  if [[ "${init_system}" == "openrc" ]]; then
    install_openrc_service x-ui-api "x-ui API"
    install_openrc_service x-ui-worker "x-ui worker"
  else
    for service in "${SERVICES[@]}"; do
      cp -f "$1/${service}.service" "${SERVICE_DIR}/${service}.service"
    done
    if [[ -f "$1/x-ui-agent.service" ]]; then
      cp -f "$1/x-ui-agent.service" "${SERVICE_DIR}/x-ui-agent.service"
    fi
    systemctl daemon-reload
  fi
  for service in "${SERVICES[@]}"; do
    enable_service "${service}"
    restart_service "${service}"
  done
}

# Install sing-box only when it is missing. Its package service is needed for
# reload-or-restart, and an upgrade must leave its version and config alone.
install_sing_box() {
  if ! command -v sing-box >/dev/null 2>&1; then
    echo -e "${yellow}Installing sing-box...${plain}"
    case "${packager}" in
      apt)
        install -d -m 755 /etc/apt/keyrings /etc/apt/sources.list.d
        curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
        chmod 644 /etc/apt/keyrings/sagernet.asc
        cat >/etc/apt/sources.list.d/sagernet.sources <<'EOF'
Types: deb
URIs: https://deb.sagernet.org/
Suites: *
Components: *
Enabled: yes
Signed-By: /etc/apt/keyrings/sagernet.asc
EOF
        apt-get update -q
        DEBIAN_FRONTEND=noninteractive apt-get install -y -q sing-box
        ;;
      dnf)
        if dnf config-manager addrepo --help >/dev/null 2>&1; then
          dnf config-manager addrepo --from-repofile=https://sing-box.app/sing-box.repo
        else
          dnf install -y -q dnf-plugins-core
          dnf config-manager --add-repo https://sing-box.app/sing-box.repo
        fi
        dnf install -y -q sing-box
        ;;
      *)
        echo -e "${red}Install a compatible sing-box systemd package before retrying${plain}" >&2
        return 1
        ;;
    esac
    # Packages may start their example configuration. The first validated sync
    # below owns startup for a newly installed core.
    systemctl stop sing-box.service
    systemctl disable sing-box.service
  fi
  if ! systemctl cat sing-box.service >/dev/null 2>&1; then
    echo -e "${red}sing-box is installed but has no systemd sing-box.service${plain}" >&2
    return 1
  fi
  cat >"${workdir}/core-api-check.json" <<'EOF'
{"services":[{"type":"api","tag":"x-ui-stats-api","listen":"127.0.0.1","listen_port":9091,"secret":"compatibility-check","dashboard":false}]}
EOF
  if ! sing-box check -c "${workdir}/core-api-check.json"; then
    echo -e "${red}This sing-box build does not support the native statistics API; install a compatible version (1.14+)${plain}" >&2
    return 1
  fi
}

# Keep existing secrets and operator-edited agent configuration on upgrades.
# Panel Restart & Apply uses the installed CLI's connection-only refresh,
# rather than this initial statistics/core setup.
# A fresh token is minted before x-ui-api starts, so its token cache sees it.
setup_agent_files() {
  "${CLI}" node -setup -directory "${NODE_DIR}"
}

start_node() {
  local service
  echo -e "${yellow}Checking the first agent sync and sing-box configuration...${plain}"
  if ! "${INSTALL_DIR}/bin/x-ui-agent" -config "${NODE_DIR}/agent.yaml" -env-file "${NODE_DIR}/agent.env" -sync-once; then
    echo -e "${red}Agent sync failed. Check /etc/x-ui/agent.yaml and the panel log before enabling the node.${plain}" >&2
    return 1
  fi
  sing-box check -C "${CORE_DIR}"
  systemctl enable --now sing-box.service
  systemctl enable x-ui-agent.service
  systemctl restart x-ui-agent.service
  # Type=simple reports a service as started before it has read its config.
  # Catch an immediate crash instead of printing a false success message.
  sleep 2
  for service in "${ALL_SERVICES[@]}"; do
    if ! systemctl is-active --quiet "${service}.service" || ! systemctl is-enabled --quiet "${service}.service"; then
      echo -e "${red}${service} is not active and enabled; inspect journalctl -u ${service}${plain}" >&2
      return 1
    fi
  done
  "${CLI}" healthcheck -subscription
  "${CLI}" node -check -directory "${NODE_DIR}"
  echo -e "${green}Panel, worker, core and agent checks passed; configuration sync and statistics are ready${plain}"
}

# ask_port asks for one of the two listeners' ports and writes the answer into
# config.yaml. A blank answer keeps the one there is; the other listener's is
# refused, because two on one port is a panel that does not start.
ask_port() {
  local label="$1" key="$2" fallback="$3" other_key="$4" other_fallback="$5"
  local current other answer
  current="$(config_value "${key}")"
  current="${current:-${fallback}}"
  other="$(config_value "${other_key}")"
  other="${other:-${other_fallback}}"
  while true; do
    echo -e "${yellow}Enter the ${label} (leave blank to keep ${current}):${plain}"
    read -r answer || answer=""
    if [[ -z "${answer}" ]]; then
      return 0
    fi
    if [[ ! "${answer}" =~ ^[0-9]{1,5}$ ]] || ((10#${answer} < 1 || 10#${answer} > 65535)); then
      echo -e "${red}A port is a number from 1 to 65535${plain}"
    elif ((10#${answer} == 10#${other})); then
      echo -e "${red}${other} is the other listener's port${plain}"
    else
      set_config "${key}" "$((10#${answer}))"
      return 0
    fi
  done
}

# ask_path asks for the path subscriptions are served under, and writes it into
# config.yaml with a slash at either end, which is how the server reads it.
ask_path() {
  local label="$1" key="$2" fallback="$3" current answer
  current="$(config_value "${key}")"
  current="${current:-${fallback}}"
  while true; do
    echo -e "${yellow}Enter the ${label} (leave blank to keep ${current}):${plain}"
    read -r answer || answer=""
    if [[ -z "${answer}" ]]; then
      return 0
    fi
    answer="/${answer#/}"
    if [[ "${answer}" != */ ]]; then
      answer="${answer}/"
    fi
    if [[ "${answer}" =~ ^/([A-Za-z0-9._~-]+/)*$ ]]; then
      set_config "${key}" "${answer}"
      return 0
    fi
    echo -e "${red}A path is made of letters, digits and . _ ~ - between slashes${plain}"
  done
}

# set_credentials asks for the operator account's credentials until the CLI
# accepts them. `admin` takes them on its command line, where they sit in the
# process table for as long as it runs -- a moment, on a host root is setting up.
set_credentials() {
  local account password
  while true; do
    # -s so the password does not end up on screen or in the scrollback of a
    # shared terminal.
    if ! read -r -p "Please set up your username: " account ||
      ! read -r -s -p "Please set up your password: " password; then
      echo -e "\n${red}Username and password can not be empty.${plain}"
      exit 1
    fi
    echo
    if [[ -z "${account}" || -z "${password}" ]]; then
      echo -e "${red}Username and password can not be empty.${plain}"
      continue
    fi
    echo -e "${yellow}Initializing, please wait...${plain}"
    if "${CLI}" admin -username "${account}" -password "${password}"; then
      return 0
    fi
    echo -e "${red}Failed to set the admin credentials.${plain}"
  done
}

# seed_random_admin gives a panel with no operator account one with generated
# credentials, and prints them. On a panel that has one -- an upgrade, or a
# database that came with its accounts -- it changes nothing and returns 1.
#
# seed rather than admin: seed reads the credentials from its environment, so
# they never appear on a command line.
seed_random_admin() {
  local username password output
  username="$(random_hex 4)"
  password="$(random_hex 8)"
  if ! output="$(X_UI_ROOT_USERNAME="${username}" X_UI_ROOT_PASSWORD="${password}" "${CLI}" seed)"; then
    echo -e "${red}Failed to set the admin credentials.${plain}"
    exit 1
  fi
  if [[ "${output}" != created* ]]; then
    return 1
  fi
  echo -e "this is a fresh installation, will generate random login info for security concerns:"
  echo -e "###############################################"
  echo -e "${green}username:${username}${plain}"
  echo -e "${green}password:${password}${plain}"
  echo -e "###############################################"
  echo -e "${red}if you forget them, type x-ui for the configuration menu, which sets new ones${plain}"
}

config_after_install() {
  echo -e "${yellow}Migrating the database...${plain}"
  if ! "${CLI}" migrate; then
    echo -e "${red}Migrating the database failed. Check the database settings in ${CONFIG_FILE}${plain}"
    exit 1
  fi

  local config_confirm="" admin_confirm=""
  echo -e "${yellow}Install/update finished! For security it's recommended to modify panel settings${plain}"
  read -r -p "Do you want to continue with the modification [y/n]? " config_confirm || true
  if [[ "${config_confirm}" == "y" || "${config_confirm}" == "Y" ]]; then
    # The panel path is also editable through Settings -> Panel.
    ask_port "panel port" server.port 8000 subscription.port 8443
    ask_port "subscription port" subscription.port 8443 server.port 8000
    ask_path "subscription path" subscription.base_path /sub/

    read -r -p "Do you want to change admin credentials [y/n]? " admin_confirm || true
    if [[ "${admin_confirm}" == "y" || "${admin_confirm}" == "Y" ]]; then
      set_credentials
    elif ! seed_random_admin; then
      echo -e "${yellow}Your current admin credentials:${plain}"
      "${CLI}" admin -show
    fi
  else
    echo -e "${red}cancel...${plain}"
    if ! seed_random_admin; then
      echo -e "${red}this is your upgrade, will keep old settings. If you forgot your login info, you can type x-ui for configuration menu${plain}"
    fi
  fi
}

# verify_checksum checks the downloaded archive against the SHA256SUMS file the
# release publishes. The reference installs a release without one, so that
# versions built before it had them can still be rolled back to; every
# x-ui release has one -- scripts/package.sh writes it beside the
# archives -- so here a missing sum stops the install like a wrong one.
verify_checksum() {
  local archive="$1" sums="$2" name expected actual
  name="$(basename "${archive}")"

  if ! command -v sha256sum >/dev/null 2>&1; then
    echo -e "${red}sha256sum is needed to check the download, and this host has none${plain}"
    return 1
  fi
  if [[ ! -s "${sums}" ]]; then
    echo -e "${red}No SHA256SUMS published for this release; refusing an archive that cannot be checked${plain}"
    return 1
  fi

  # Matched by filename, and the leading * that sha256sum writes for a binary
  # entry is accepted. Comparing the hashes directly rather than piping into
  # `sha256sum -c` keeps this independent of the working directory, which the
  # paths in a SHA256SUMS file are relative to.
  expected="$(awk -v f="${name}" '$2 == f || $2 == "*" f { print $1; exit }' "${sums}")"
  if [[ -z "${expected}" ]]; then
    echo -e "${red}SHA256SUMS does not list ${name}; refusing an archive that cannot be checked${plain}"
    return 1
  fi

  actual="$(sha256sum "${archive}" | awk '{ print $1 }')"
  if [[ "${expected}" != "${actual}" ]]; then
    echo -e "${red}Checksum does NOT match. The download may be corrupt or tampered with. Aborting.${plain}"
    return 1
  fi
  echo -e "${green}Checksum verified.${plain}"
}

local_addresses() {
  if command -v ip >/dev/null 2>&1; then
    ip -o addr show up scope global 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }' || true
  elif command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' || true
  fi
}

public_address() {
  local api address
  for api in https://api64.ipify.org https://icanhazip.com https://ifconfig.me/ip; do
    address="$(curl -fsS --max-time 3 "${api}" 2>/dev/null | tr -d '[:space:]')" || continue
    if [[ "${address}" =~ ^[0-9A-Fa-f:.]+$ ]]; then
      echo "${address}"
      return 0
    fi
  done
}

# show_uri prints the addresses the panel is reached on, as the reference's
# `uri` command does: this host's own, and the one the internet reaches it by --
# which on most cloud hosts is on none of its interfaces.
show_uri() {
  local port domain listen scheme="http" suffix addresses address public panel_path
  port="$(config_value server.port)"
  port="${port:-8000}"
  domain="$(config_value server.domain)"
  listen="$(config_value server.listen)"
  panel_path="$(config_value server.base_path)"
  panel_path="/${panel_path#/}"
  [[ "${panel_path}" == */ ]] || panel_path="${panel_path}/"
  if [[ -n "$(config_value server.cert_file)" ]]; then
    scheme="https"
  fi
  suffix=":${port}"
  if [[ "${scheme}:${port}" == "http:80" || "${scheme}:${port}" == "https:443" ]]; then
    suffix=""
  fi

  if [[ -n "${domain}" || -n "${listen}" ]]; then
    echo -e "${green}${scheme}://${domain:-${listen}}${suffix}${panel_path}${plain}"
    return 0
  fi
  addresses="$(local_addresses)"
  if [[ -n "${addresses}" ]]; then
    echo -e "Local address:"
    for address in ${addresses}; do
      if [[ "${address}" == *:* ]]; then
        address="[${address}]"
      fi
      echo -e "${green}${scheme}://${address}${suffix}${panel_path}${plain}"
    done
  fi
  public="$(public_address)"
  if [[ -n "${public}" ]]; then
    if [[ "${public}" == *:* ]]; then
      public="[${public}]"
    fi
    if [[ -n "${addresses}" ]]; then
      echo
    fi
    echo -e "Global address:"
    echo -e "${green}${scheme}://${public}${suffix}${panel_path}${plain}"
  fi
}

# Retain the previous release and service state until all checks pass. The
# database archive includes the schema and migration table, so binary rollback
# is paired with database rollback rather than crossing schema versions.
snapshot_path() {
  local name="$1" path="$2"
  if [[ -e "${path}" || -L "${path}" ]]; then
    cp -a -- "${path}" "${backup_dir}/${name}"
  fi
}

prepare_rollback() {
  local part service path
  for path in "${INSTALL_DIR}" "${CONFIG_DIR}" "${NODE_DIR}" "${CORE_DIR}"; do
    if [[ -L "${path}" ]]; then
      echo "Refusing symlinked installation directory: ${path}" >&2
      return 1
    fi
  done
  install -d -m 700 "${BACKUP_ROOT}"
  backup_dir="$(mktemp -d "${BACKUP_ROOT}/install-$(date -u +%Y%m%d-%H%M%S).XXXXXXXX")"
  mkdir -m 700 "${backup_dir}/units"
  for part in bin migrations web configs; do
    snapshot_path "${part}" "${INSTALL_DIR}/${part}"
  done
  snapshot_path cli "${CLI}"
  snapshot_path menu "${MENU}"
  snapshot_path node "${NODE_DIR}"
  snapshot_path core "${CORE_DIR}"
  for service in "${ALL_SERVICES[@]}"; do
    if systemctl is-active --quiet "${service}.service"; then touch "${backup_dir}/${service}.active"; fi
    if systemctl is-enabled --quiet "${service}.service"; then touch "${backup_dir}/${service}.enabled"; fi
    if [[ "${service}" != "sing-box" ]]; then
      snapshot_path "units/${service}.service" "${SERVICE_DIR}/${service}.service"
    fi
  done
  rollback_required=true
  # Keep the core serving its current configuration while panel writes stop.
  for service in x-ui-agent "${SERVICES[@]}"; do
    if systemctl is-active --quiet "${service}.service"; then
      systemctl stop "${service}.service"
      if systemctl is-active --quiet "${service}.service"; then return 1; fi
    fi
  done
}

restore_path() {
  local name="$1" path="$2"
  rm -rf -- "${path:?}"
  if [[ -e "${backup_dir}/${name}" || -L "${backup_dir}/${name}" ]]; then
    cp -a -- "${backup_dir}/${name}" "${path}"
  fi
}

rollback_install() {
  local service part failed=false
  echo -e "${yellow}Installation failed; restoring the previous installation from ${backup_dir}${plain}" >&2
  for service in x-ui-agent "${SERVICES[@]}"; do
    systemctl stop "${service}.service" >/dev/null 2>&1 || true
  done
  if [[ "${database_backup_available}" == "true" ]]; then
    if ! "${workdir}/x-ui/bin/x-ui-cli" database -restore "${backup_dir}/database.dump" -yes; then
      echo "Database restore failed; panel services remain stopped. Backup: ${backup_dir}" >&2
      failed=true
    fi
  fi
  for part in bin migrations web configs; do
    restore_path "${part}" "${INSTALL_DIR}/${part}" || failed=true
  done
  restore_path cli "${CLI}" || failed=true
  restore_path menu "${MENU}" || failed=true
  restore_path node "${NODE_DIR}" || failed=true
  restore_path core "${CORE_DIR}" || failed=true
  for service in "${SERVICES[@]}" x-ui-agent; do
    restore_path "units/${service}.service" "${SERVICE_DIR}/${service}.service" || failed=true
  done
  systemctl daemon-reload || failed=true
  for service in "${ALL_SERVICES[@]}"; do
    if [[ -f "${backup_dir}/${service}.enabled" ]]; then
      systemctl enable "${service}.service" >/dev/null 2>&1 || failed=true
    else
      systemctl disable "${service}.service" >/dev/null 2>&1 || true
    fi
    if [[ "${service}" == "sing-box" ]]; then
      if [[ -f "${backup_dir}/${service}.active" ]]; then
        systemctl reload-or-restart "${service}.service" || failed=true
      else
        systemctl stop "${service}.service" >/dev/null 2>&1 || true
      fi
    elif [[ "${failed}" == "false" && -f "${backup_dir}/${service}.active" ]]; then
      systemctl start "${service}.service" || failed=true
    fi
  done
  if [[ "${failed}" == "true" ]]; then
    echo "Automatic recovery was incomplete. Retained backup: ${backup_dir}" >&2
    return 1
  fi
  echo "Previous installation and service state restored. Backup: ${backup_dir}" >&2
}

finish_install() {
  local status=$?
  trap - EXIT
  set +e
  if [[ ${status} -ne 0 && "${rollback_required}" == "true" ]]; then rollback_install; fi
  if [[ -n "${workdir:-}" ]]; then rm -rf -- "${workdir}"; fi
  exit "${status}"
}

install_x_ui() {
  # A private directory, not /tmp itself. On a shared host a predictable path
  # lets another user put an archive or an unpacked tree of their own where root
  # is about to install from.
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/x-ui-install.XXXXXXXX")"
  trap finish_install EXIT
  cd "${workdir}"

  local archive="${workdir}/x-ui-linux-${arch}.tar.gz"
  local sums="${workdir}/SHA256SUMS"
  local tag part tries=0 database_name cli_help agent_help

  if [[ $# -eq 0 ]]; then
    tag="$(curl -Ls "https://api.github.com/repos/${REPOSITORY}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')" || true
    if [[ -z "${tag}" ]]; then
      echo -e "${red}Failed to fetch x-ui version, it maybe due to Github API restrictions, please try it later${plain}"
      exit 1
    fi
    echo -e "${green}Got x-ui latest version: ${tag}, beginning the installation...${plain}"
  else
    tag="$1"
    echo -e "Beginning the installation of x-ui ${tag}"
  fi

  # No --insecure. Anyone able to intercept an unauthenticated download chooses
  # the binary that then runs as root.
  local base="https://github.com/${REPOSITORY}/releases/download/${tag}"
  if ! curl -fL --progress-bar -o "${archive}" "${base}/x-ui-linux-${arch}.tar.gz"; then
    if [[ $# -eq 0 ]]; then
      echo -e "${red}Downloading x-ui failed, please be sure that your server can access Github${plain}"
    else
      echo -e "${red}Downloading x-ui ${tag} failed, please check the version exists${plain}"
    fi
    exit 1
  fi
  curl -fsSL -o "${sums}" "${base}/SHA256SUMS" 2>/dev/null || true
  verify_checksum "${archive}" "${sums}" || exit 1

  if ! tar zxf "${archive}" -C "${workdir}" --no-same-owner; then
    echo -e "${red}Extracting x-ui failed, the archive may be corrupt or the disk is full${plain}"
    df -h "${workdir}" 2>/dev/null || true
    exit 1
  fi
  rm -f "${archive}"
  if [[ ! -d x-ui/bin || ! -d x-ui/migrations || ! -f x-ui/web/build/index.html ]]; then
    echo -e "${red}The archive is not an x-ui release: it has no binaries, migrations or panel${plain}"
    exit 1
  fi
  if [[ ! -f x-ui/x-ui.sh || ! -f x-ui/x-ui-api.service || ! -f x-ui/x-ui-worker.service ]]; then
    echo -e "${red}The archive is not an x-ui release: it has no menu or no service units${plain}"
    exit 1
  fi
  chmod +x x-ui/bin/*
  # Capture help before matching: with pipefail, grep -q can close its pipe
  # early and make a compatible binary fail with SIGPIPE while printing help.
  if [[ ! -f x-ui/bin/x-ui-api || ! -f x-ui/bin/x-ui-worker || ! -f x-ui/bin/x-ui-cli ||
        ! -f x-ui/bin/x-ui-agent || ! -f x-ui/bin/x-ui-core-reload || ! -f x-ui/x-ui-agent.service ]] ||
    ! cli_help="$(x-ui/bin/x-ui-cli help 2>/dev/null)" ||
    ! agent_help="$(x-ui/bin/x-ui-agent -h 2>&1)" ||
    ! grep -q '    node ' <<<"${cli_help}" ||
    ! grep -q '    database ' <<<"${cli_help}" ||
    ! grep -q -- '-env-file' <<<"${agent_help}"; then
    echo -e "${red}This release cannot install the complete panel and node; use a release with node bootstrap and native statistics support${plain}" >&2
    exit 1
  fi

  # Each part is copied in beside the one it replaces, and the new binary is
  # tried there, before anything installed is touched: a full disk or a broken
  # archive stops the install with the running version still whole and still
  # running.
  mkdir -p "${INSTALL_DIR}"
  for part in bin migrations web; do
    rm -rf "${INSTALL_DIR:?}/${part}.new"
    if ! cp -R "x-ui/${part}" "${INSTALL_DIR}/${part}.new"; then
      echo -e "${red}Copying x-ui into ${INSTALL_DIR} failed, the disk may be full${plain}"
      df -h "${INSTALL_DIR}" 2>/dev/null || true
      rm -rf "${INSTALL_DIR:?}/bin.new" "${INSTALL_DIR:?}/migrations.new" "${INSTALL_DIR:?}/web.new"
      exit 1
    fi
  done
  # The rest of the unpacked tree -- the menu and the units -- stays where it is
  # until the steps below install it, and goes with the working directory.
  if ! "${INSTALL_DIR}/bin.new/x-ui-cli" version >/dev/null 2>&1; then
    echo -e "${red}The installed x-ui binary does not run, the installation is incomplete${plain}"
    rm -rf "${INSTALL_DIR:?}/bin.new" "${INSTALL_DIR:?}/migrations.new" "${INSTALL_DIR:?}/web.new"
    exit 1
  fi

  install_sing_box
  prepare_rollback
  for part in bin migrations web; do
    rm -rf "${INSTALL_DIR:?}/${part}"
    mv "${INSTALL_DIR}/${part}.new" "${INSTALL_DIR}/${part}"
  done
  mkdir -p "${CONFIG_DIR}"
  # Renamed into place, the files keep the SELinux label they were given under
  # their temporary names, which is not the one a service may be run from.
  if command -v restorecon >/dev/null 2>&1; then
    restorecon -R "${INSTALL_DIR}" || true
  fi

  install_cli
  install_menu "${workdir}/x-ui"
  write_config_file
  setup_database
  "${CLI}" database -check
  "${CLI}" database -backup "${backup_dir}/database.dump"
  database_backup_available=true
  config_after_install
  setup_agent_files
  install_services "${workdir}/x-ui"

  # Asked of the panel rather than of the init system: a service that has been
  # started is not yet one that answers, and one that cannot reach its database
  # exits a moment later.
  until "${CLI}" healthcheck >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [[ ${tries} -ge 20 ]]; then
      echo -e "${red}x-ui ${tag} is installed, but the panel is not answering. Its log will say why: x-ui log${plain}"
      exit 1
    fi
    sleep 1
  done

  start_node
  rollback_required=false

  echo -e "${green}x-ui ${tag}${plain} installation finished, it is up and running now..."
  echo "Installation backup: ${backup_dir}"
  echo -e "You may access the Panel with following URL(s):"
  show_uri
  echo -e ""
  "${MENU}" help

  if [[ "${local_database_credentials_generated}" == "true" ]]; then
    database_name="$(config_value database.name)"
    echo -e "${yellow}Local PostgreSQL credentials (save them securely):${plain}"
    printf 'Database: %s\nUsername: %s\nPassword: %s\n\n' \
      "${database_name:-x_ui}" "$(config_value database.user)" "$(config_value database.password)"
  fi
}

echo -e "${green}Executing...${plain}"
check_install_host
install_base
detect_architecture
if [[ -n "${release_tag}" ]]; then
  install_x_ui "${release_tag}"
else
  install_x_ui
fi
