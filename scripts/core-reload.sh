#!/usr/bin/env bash
# Apply an agent candidate only after validation, and restore the previous
# core configuration if starting or reloading fails.
set -euo pipefail
umask 077

source_path="${1:-/etc/x-ui/config.json}"
target_path="${2:-/etc/sing-box/config.json}"
target_dir="$(dirname "${target_path}")"
[[ "${source_path}" == /* && "${target_path}" == /* ]]
[[ "$(realpath "${source_path}")" == "${source_path}" ]]
[[ "$(realpath "${target_dir}")" == "${target_dir}" ]]
[[ ! -L "${target_path}" ]]
# The Overview restart helper uses this same lock while validating/restarting
# the service. Hold it before validating or replacing the applied configuration.
lock_path="${target_dir}/.x-ui-core.lock"
[[ ! -L "${lock_path}" ]]
exec 9>"${lock_path}"
flock -w 25 9
sing-box check -c "${source_path}"

core_user="$(systemctl show sing-box.service --property=User --value)"
core_group="$(systemctl show sing-box.service --property=Group --value)"
if [[ -z "${core_group}" ]]; then
  core_group="$(id -gn "${core_user:-root}")"
fi
was_active=false
if systemctl is-active --quiet sing-box.service; then was_active=true; fi
previous="$(mktemp "${target_dir}/.x-ui-previous.XXXXXXXX")"
candidate="$(mktemp "${target_dir}/.x-ui-candidate.XXXXXXXX")"
had_previous=false
keep_previous=false
cleanup() {
  rm -f -- "${candidate}"
  if [[ "${keep_previous}" == "false" ]]; then rm -f -- "${previous}"; fi
}
trap cleanup EXIT
if [[ -f "${target_path}" ]]; then
  cp -p -- "${target_path}" "${previous}"
  had_previous=true
fi
install -o root -g "${core_group}" -m 640 "${source_path}" "${candidate}"
mv -f -- "${candidate}" "${target_path}"

failed=false
if ! systemctl reload-or-restart sing-box.service; then
  failed=true
else
  sleep 2
  if ! systemctl is-active --quiet sing-box.service; then failed=true; fi
fi
if [[ "${failed}" == "true" ]]; then
  keep_previous=true
  if [[ "${had_previous}" == "true" ]]; then
    mv -f -- "${previous}" "${target_path}"
  else
    rm -f -- "${target_path}"
  fi
  keep_previous=false
  if [[ "${was_active}" == "true" ]]; then
    systemctl reload-or-restart sing-box.service || true
  else
    systemctl stop sing-box.service || true
  fi
  echo "Core reload failed; the previous configuration was restored." >&2
  exit 1
fi
