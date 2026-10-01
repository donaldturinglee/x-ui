#!/usr/bin/env bash
#
# Manage x-ui on the host it is installed on, from a menu or a command.
#
# install.sh puts this at /usr/bin/x-ui, beside the x-ui-cli it
# drives. Run as root with no arguments, it shows a menu: installing, updating
# and removing the panel, its operator accounts and settings, and its two
# services. Given a command, it does that one thing, so a script can use it too:
#
#   x-ui                 the menu
#   x-ui start|stop|restart|status|enable|disable|log
#   x-ui install|update|uninstall
#   x-ui help
#
# It works on what install.sh set up -- the services, /usr/local/x-ui and
# the configuration in /usr/local/x-ui/configs/config.yaml -- and installs
# and updates by running the published install.sh.
#
# No set -e: a command that fails is reported, and the menu goes on rather than
# exiting under the operator.

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

REPOSITORY="donaldturinglee/x-ui"
INSTALLER_URL="https://raw.githubusercontent.com/${REPOSITORY}/main/install.sh"

# Where install.sh puts things.
INSTALL_DIR="/usr/local/x-ui"
CONFIG_FILE="${INSTALL_DIR}/configs/config.yaml"
CLI="/usr/bin/x-ui-cli"
SERVICES=(x-ui-api x-ui-worker sing-box x-ui-agent)

LOGI() {
  echo -e "${green}[INF] $*${plain}"
}

LOGE() {
  echo -e "${red}[ERR] $*${plain}"
}

if [[ ${EUID} -ne 0 ]]; then
  LOGE "ERROR: You must be root to run this script!"
  exit 1
fi

if [[ -f /etc/os-release ]]; then
  source /etc/os-release
elif [[ -f /usr/lib/os-release ]]; then
  source /usr/lib/os-release
else
  LOGE "Failed to check the system OS, please contact the author!"
  exit 1
fi
release="${ID:-unknown}"

# Detect the init system (systemd vs OpenRC used by Alpine)
if [[ "${release}" == "alpine" ]]; then
  init_system="openrc"
elif command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  init_system="systemd"
elif command -v rc-service >/dev/null 2>&1; then
  init_system="openrc"
else
  init_system="systemd"
fi

# Services are started, stopped and looked at through these, so everything
# below reads the same under systemd and OpenRC.
start_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-service "$1" start
  else
    systemctl start "$1"
  fi
}

stop_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-service "$1" stop
  else
    systemctl stop "$1"
  fi
}

restart_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-service "$1" restart
  else
    systemctl restart "$1"
  fi
}

enable_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-update add "$1" default
  else
    systemctl enable "$1"
  fi
}

disable_service() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-update del "$1" default
  else
    systemctl disable "$1"
  fi
}

# check_status says whether one service is running (0), installed but not
# running (1), or not installed at all (2).
check_status() {
  if [[ "${init_system}" == "openrc" ]]; then
    if [[ ! -f "/etc/init.d/$1" ]]; then
      return 2
    fi
    if rc-service "$1" status >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  if ! systemctl cat "$1.service" >/dev/null 2>&1; then
    return 2
  fi
  if systemctl is-active --quiet "$1"; then
    return 0
  fi
  return 1
}

check_enabled() {
  if [[ "${init_system}" == "openrc" ]]; then
    rc-update show default 2>/dev/null | awk -v service="$1" '$1 == service { found = 1 } END { exit !found }'
  else
    systemctl is-enabled --quiet "$1"
  fi
}

# The panel counts as installed while its API's service is: that is what the
# menu starts, stops and removes, and the worker is installed beside it.
check_install() {
  check_status x-ui-api
  if [[ $? -eq 2 ]]; then
    echo
    LOGE "Please install the panel first"
    return 1
  fi
}

check_uninstall() {
  check_status x-ui-api
  if [[ $? -ne 2 ]]; then
    echo
    LOGE "Panel is already installed, Please do not reinstall"
    return 1
  fi
}

show_enable_status() {
  if check_enabled "$1"; then
    echo -e "Start $1 automatically: ${green}Yes${plain}"
  else
    echo -e "Start $1 automatically: ${red}No${plain}"
  fi
}

show_status() {
  local service
  for service in "${SERVICES[@]}"; do
    check_status "${service}"
    case $? in
      0)
        echo -e "${service} state: ${green}Running${plain}"
        show_enable_status "${service}"
        ;;
      1)
        echo -e "${service} state: ${yellow}Not Running${plain}"
        show_enable_status "${service}"
        ;;
      2)
        echo -e "${service} state: ${red}Not Installed${plain}"
        ;;
    esac
  done
}

# confirm asks a yes-or-no question and returns 0 for yes. With a second
# argument, that is the answer an empty line gives.
confirm() {
  local answer
  if [[ $# -gt 1 ]]; then
    echo && read -r -p "$1 [Default $2]: " answer || answer=""
    answer="${answer:-$2}"
  else
    read -r -p "$1 [y/n]: " answer || answer=""
  fi
  [[ "${answer}" == "y" || "${answer}" == "Y" ]]
}

confirm_restart() {
  if confirm "Restart x-ui for the change to take effect" "y"; then
    restart_panel
  fi
}

before_show_menu() {
  echo && echo -n -e "${yellow}Press enter to return to the main menu: ${plain}"
  read -r _ || exit 0
}

# config_value, set_config, ask_port, ask_path and show_uri are install.sh's
# own, kept alike, so the menu reads and writes config.yaml just as the
# installer that made it does.

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
    LOGE "$1 cannot contain a quote or a line break"
    return 1
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

# run_installer runs install.sh as the main branch has it, for the tag given or,
# with none, the latest release. It is downloaded whole before it runs rather
# than piped into bash: a download cut off halfway would otherwise run the part
# of the script that did arrive, and one that failed outright would run nothing
# and report success.
run_installer() {
  local installer status
  installer="$(mktemp "${TMPDIR:-/tmp}/x-ui-install.XXXXXXXX")" || return 1
  if ! curl -fsSL -o "${installer}" "${INSTALLER_URL}"; then
    LOGE "Failed to download install.sh, Please check whether the machine can connect Github"
    rm -f "${installer}"
    return 1
  fi
  bash "${installer}" "$@"
  status=$?
  rm -f "${installer}"
  return "${status}"
}

# update_panel reinstalls the latest release over the one installed. The menu
# ends afterwards: what is running is the script the update has just replaced.
update_panel() {
  if ! confirm "This function will forcefully reinstall the latest version, and the data will not be lost. Do you want to continue?" "n"; then
    LOGE "Cancelled"
    return 0
  fi
  if run_installer "$@"; then
    LOGI "Update is complete; the panel and node passed installation checks"
    exit 0
  fi
  return 1
}

custom_version() {
  local tag
  echo "Enter the panel version (like v1.2.0):"
  read -r tag || tag=""
  if [[ -z "${tag}" ]]; then
    LOGE "Panel version cannot be empty"
    return 1
  fi
  # Part of a download URL, where anything but a tag's characters would name
  # something else.
  if [[ ! "${tag}" =~ ^[A-Za-z0-9._+-]+$ ]]; then
    LOGE "${tag} is not a release tag"
    return 1
  fi
  echo "Downloading and installing panel version ${tag}..."
  if run_installer "${tag}"; then
    exit 0
  fi
  return 1
}

# uninstall_panel removes what install.sh installed, apart from this script and
# the database. The data is PostgreSQL's rather than a file under
# /usr/local/x-ui, and an uninstall is no reason to lose it: installing
# again picks it up, and dropping it is one command, printed at the end.
uninstall_panel() {
  local service
  if ! confirm "Are you sure you want to uninstall the panel?" "n"; then
    return 0
  fi
  for service in x-ui-agent sing-box x-ui-worker x-ui-api; do
    if [[ "${init_system}" == "openrc" ]]; then
      rc-service "${service}" stop
      rc-update del "${service}" default
      if [[ "${service}" != "sing-box" ]]; then rm -f "/etc/init.d/${service}"; fi
    else
      systemctl stop "${service}"
      systemctl disable "${service}"
      if [[ "${service}" != "sing-box" ]]; then rm -f "/etc/systemd/system/${service}.service"; fi
    fi
  done
  if [[ "${init_system}" == "systemd" ]]; then
    systemctl daemon-reload
    systemctl reset-failed
  fi
  rm -rf "${INSTALL_DIR}" "${CLI}"

  echo ""
  echo -e "Uninstalled Successfully, If you want to remove this script, then after exiting the script run ${green}rm -f /usr/bin/x-ui${plain} to delete it."
  echo -e "The database is kept, and installing the panel again picks it up. When the installer made it on this host and the data is not wanted either:"
  echo -e "${green}su postgres -c 'dropdb x_ui && dropuser x_ui'${plain}"
  echo ""
}

# disable_two_factor turns an operator's two-factor authentication off, for one
# who has lost the authenticator the panel would want a code from. It stands
# where the reference resets the credentials to defaults, which x-ui
# deliberately cannot do: a panel with well-known credentials is not a recovery.
disable_two_factor() {
  local account
  "${CLI}" admin -list || return 1
  read -r -p "Turn two-factor authentication off for which account? " account || account=""
  if [[ -z "${account}" ]]; then
    LOGE "Cancelled"
    return 0
  fi
  "${CLI}" admin -disable-two-factor "${account}"
}

set_admin() {
  local account password
  # -s so the password does not end up on screen or in the scrollback of a
  # shared terminal.
  read -r -p "Please set up your username: " account || account=""
  read -r -s -p "Please set up your password: " password || password=""
  echo
  if [[ -z "${account}" || -z "${password}" ]]; then
    LOGE "Username and password can not be empty."
    return 1
  fi
  # `admin` takes them on its command line, where they sit in the process table
  # for as long as it runs -- a moment.
  "${CLI}" admin -username "${account}" -password "${password}"
}

view_admin() {
  "${CLI}" admin -show
}

# reset_setting restores the settings the panel keeps in its database. The CLI
# asks before it does. The ports and the subscription path are not among them:
# they are startup configuration, in config.yaml, which option 9 changes.
reset_setting() {
  "${CLI}" setting -reset
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

set_setting() {
  local before
  before="$(cat "${CONFIG_FILE}" 2>/dev/null)"
  # No panel path. The panel is built to be served from the root, /, and loads
  # its scripts from there, so anywhere else it would be a page that never
  # draws.
  ask_port "panel port" server.port 8000 subscription.port 8443
  ask_port "subscription port" subscription.port 8443 server.port 8000
  ask_path "subscription path" subscription.base_path /sub/
  if [[ "$(cat "${CONFIG_FILE}" 2>/dev/null)" == "${before}" ]]; then
    LOGI "Nothing changed"
    return 0
  fi
  confirm_restart
}

# show_setting prints one line of view_setting: what config.yaml sets the key
# to, else the default, and nothing for an unset one with no default.
show_setting() {
  local label="$1" key="$2" fallback="${3:-}" value
  value="$(config_value "${key}")"
  value="${value:-${fallback}}"
  if [[ -n "${value}" ]]; then
    echo -e "\t${label}:\t ${value}"
  fi
}

# view_setting shows the two listeners as config.yaml sets them, and where the
# panel is reached. The settings the panel keeps in its database are on its
# settings page.
view_setting() {
  echo -e "Current panel settings:"
  show_setting "Panel port" server.port 8000
  show_setting "Panel path" server.base_path /
  show_setting "Panel IP" server.listen
  show_setting "Panel Domain" server.domain
  show_setting "Panel Cert" server.cert_file
  echo
  echo -e "Current subscription settings:"
  show_setting "Sub port" subscription.port 8443
  show_setting "Sub path" subscription.base_path /sub/
  show_setting "Sub IP" subscription.listen
  show_setting "Sub Domain" subscription.domain
  show_setting "Sub Cert" subscription.cert_file
  show_setting "Sub URI" subscription.public_url
  echo
  view_uri
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

# show_uri prints the addresses the panel is reached on, as install.sh does at
# the end of an install: this host's own, and the one the internet reaches it
# by -- which on most cloud hosts is on none of its interfaces.
show_uri() {
  local port domain listen scheme="http" suffix addresses address public
  port="$(config_value server.port)"
  port="${port:-8000}"
  domain="$(config_value server.domain)"
  listen="$(config_value server.listen)"
  if [[ -n "$(config_value server.cert_file)" ]]; then
    scheme="https"
  fi
  suffix=":${port}"
  if [[ "${scheme}:${port}" == "http:80" || "${scheme}:${port}" == "https:443" ]]; then
    suffix=""
  fi

  if [[ -n "${domain}" || -n "${listen}" ]]; then
    echo -e "${green}${scheme}://${domain:-${listen}}${suffix}/${plain}"
    return 0
  fi
  addresses="$(local_addresses)"
  if [[ -n "${addresses}" ]]; then
    echo -e "Local address:"
    for address in ${addresses}; do
      if [[ "${address}" == *:* ]]; then
        address="[${address}]"
      fi
      echo -e "${green}${scheme}://${address}${suffix}/${plain}"
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
    echo -e "${green}${scheme}://${public}${suffix}/${plain}"
  fi
}

view_uri() {
  LOGI "You may access the Panel with following URL(s):"
  show_uri
}

# start_panel starts whichever of the two services is not running, then gives
# them the two seconds a start takes before saying how it went.
start_panel() {
  local service started=() failed=0
  for service in "${SERVICES[@]}"; do
    if check_status "${service}"; then
      echo ""
      LOGI "${service} is running, No need to start again, If you need to restart, please select restart"
    else
      start_service "${service}"
      started+=("${service}")
    fi
  done
  if [[ ${#started[@]} -eq 0 ]]; then
    return 0
  fi
  sleep 2
  for service in "${started[@]}"; do
    if check_status "${service}"; then
      LOGI "${service} Started Successfully"
    else
      LOGE "Failed to start ${service}, Probably because it takes longer than two seconds to start, Please check the log information later"
      failed=1
    fi
  done
  return "${failed}"
}

stop_panel() {
  local service i stopped=() failed=0
  for ((i=${#SERVICES[@]}-1; i>=0; i--)); do
    service="${SERVICES[i]}"
    if check_status "${service}"; then
      stop_service "${service}"
      stopped+=("${service}")
    else
      echo ""
      LOGI "${service} stopped, No need to stop again!"
    fi
  done
  if [[ ${#stopped[@]} -eq 0 ]]; then
    return 0
  fi
  sleep 2
  for service in "${stopped[@]}"; do
    if check_status "${service}"; then
      LOGE "Failed to stop ${service}, Probably because the stop time exceeds two seconds, Please check the log information later"
      failed=1
    else
      LOGI "${service} stopped successfully"
    fi
  done
  return "${failed}"
}

restart_panel() {
  local service failed=0
  # Refresh the locally managed URL after changes to the panel's listener.
  # New tokens must be created before the API reloads its authentication cache.
  if ! "${CLI}" node -setup; then return 1; fi
  for service in "${SERVICES[@]}"; do
    restart_service "${service}"
  done
  sleep 2
  for service in "${SERVICES[@]}"; do
    if check_status "${service}"; then
      LOGI "${service} Restarted successfully"
    else
      LOGE "Failed to restart ${service}, Probably because it takes longer than two seconds to start, Please check the log information later"
      failed=1
    fi
  done
  return "${failed}"
}

panel_status() {
  local service
  if [[ "${init_system}" == "openrc" ]]; then
    for service in "${SERVICES[@]}"; do
      rc-service "${service}" status
    done
  else
    systemctl status "${SERVICES[@]}" -l --no-pager
  fi
}

enable_panel() {
  local service failed=0
  for service in "${SERVICES[@]}"; do
    if enable_service "${service}"; then
      LOGI "Set ${service} to boot automatically on startup successfully"
    else
      LOGE "Failed to set ${service} Autostart"
      failed=1
    fi
  done
  return "${failed}"
}

disable_panel() {
  local service failed=0
  for service in "${SERVICES[@]}"; do
    if disable_service "${service}"; then
      LOGI "Autostart ${service} Cancelled successfully"
    else
      LOGE "Failed to cancel ${service} autostart"
      failed=1
    fi
  done
  return "${failed}"
}

# show_log follows the panel and node services' logs. Ctrl-C ends the log rather than the
# menu: the trap takes the interrupt that would otherwise end this script along
# with the log.
show_log() {
  trap ':' INT
  if [[ "${init_system}" == "openrc" ]]; then
    tail -n 200 -f /var/log/x-ui-api.log /var/log/x-ui-worker.log /var/log/sing-box.log /var/log/x-ui-agent.log
  else
    journalctl -u x-ui-api -u x-ui-worker -u sing-box -u x-ui-agent -e --no-pager -f
  fi
  trap - INT
}

show_usage() {
  echo -e "x-ui Control Menu Usage"
  echo -e "------------------------------------------"
  echo -e "SUBCOMMANDS:"
  echo -e "x-ui              - Admin Management Script"
  echo -e "x-ui start        - Start x-ui"
  echo -e "x-ui stop         - Stop x-ui"
  echo -e "x-ui restart      - Restart x-ui"
  echo -e "x-ui status       - Current Status of x-ui"
  echo -e "x-ui enable       - Enable Autostart on OS Startup"
  echo -e "x-ui disable      - Disable Autostart on OS Startup"
  echo -e "x-ui log          - Check x-ui Logs"
  echo -e "x-ui update [release-tag]  - Update the panel and local node"
  echo -e "x-ui install [release-tag] - Install the panel and local node"
  echo -e "x-ui uninstall    - Uninstall"
  echo -e "x-ui help         - Control Menu Usage"
  echo -e "------------------------------------------"
  echo -e "x-ui-cli help     - Accounts, settings, backups and migrations"
}

# show_menu runs until 0 is chosen, or its input ends. It loops rather than
# calling itself again after each option, so a long session does not stack up
# one menu inside another.
show_menu() {
  local num
  while true; do
    echo -e "
  ${green}x-ui Admin Management Script ${plain}
————————————————————————————————
  ${green}0.${plain} Exit
————————————————————————————————
  ${green}1.${plain} Install
  ${green}2.${plain} Update
  ${green}3.${plain} Custom Version
  ${green}4.${plain} Uninstall
————————————————————————————————
  ${green}5.${plain} Turn off admin two-factor authentication
  ${green}6.${plain} Set admin credentials
  ${green}7.${plain} View admin credentials
————————————————————————————————
  ${green}8.${plain} Reset Panel Settings
  ${green}9.${plain} Set Panel settings
  ${green}10.${plain} View Panel Settings
————————————————————————————————
  ${green}11.${plain} x-ui Start
  ${green}12.${plain} x-ui Stop
  ${green}13.${plain} x-ui Restart
  ${green}14.${plain} x-ui Check State
  ${green}15.${plain} x-ui Check Logs
  ${green}16.${plain} x-ui Enable Autostart
  ${green}17.${plain} x-ui Disable Autostart
————————————————————————————————
 "
    show_status
    echo && read -r -p "Please enter your selection [0-17]: " num || exit 0

    case "${num}" in
      0) exit 0 ;;
      1) check_uninstall && run_installer ;;
      2) check_install && update_panel ;;
      3) check_install && custom_version ;;
      4) check_install && uninstall_panel ;;
      5) check_install && disable_two_factor ;;
      6) check_install && set_admin ;;
      7) check_install && view_admin ;;
      8) check_install && reset_setting ;;
      9) check_install && set_setting ;;
      10) check_install && view_setting ;;
      11) check_install && start_panel ;;
      12) check_install && stop_panel ;;
      13) check_install && restart_panel ;;
      14) check_install && panel_status ;;
      15) check_install && show_log ;;
      16) check_install && enable_panel ;;
      17) check_install && disable_panel ;;
      *) LOGE "Please enter the correct number [0-17]" ;;
    esac
    before_show_menu
  done
}

if [[ $# -gt 0 ]]; then
  case "$1" in
    start) check_install && start_panel ;;
    stop) check_install && stop_panel ;;
    restart) check_install && restart_panel ;;
    status) check_install && panel_status ;;
    enable) check_install && enable_panel ;;
    disable) check_install && disable_panel ;;
    log) check_install && show_log ;;
    update) shift; check_install && update_panel "$@" ;;
    install) shift; check_uninstall && run_installer "$@" ;;
    uninstall) check_install && uninstall_panel ;;
    help) show_usage ;;
    *)
      show_usage
      exit 1
      ;;
  esac
else
  show_menu
fi
