#!/usr/bin/env bash
#
# Package a release: the archives install.sh downloads, and their checksums.
#
# One archive per Linux platform, x-ui-linux-<platform>.tar.gz, each a
# x-ui/ directory holding the api, worker, cli and agent binaries in bin/, the
# migrations, and the built panel in web/build -- what install.sh puts under
# /usr/local/x-ui -- and beside them the x-ui.sh menu and the three
# systemd units, which it installs as /usr/bin/x-ui and the services. The
# installer configures and enables the panel, core and agent together.
# SHA256SUMS beside the archives is what install.sh checks a download against,
# and it refuses an archive the file does not list, so it goes up with every
# release.
#
# Usage:
#   VERSION=v1.2.0 scripts/package.sh            # every platform install.sh knows
#   VERSION=v1.2.0 scripts/package.sh amd64 arm64
#   gh release create v1.2.0 release/*           # then publish them
#
# The version is the release's tag: install.sh downloads from the release of
# that name, and the binaries report it. The archives land in release/, or in
# RELEASE_DIR when that is set, replacing whatever an earlier run left there.
#
# The panel is built here too -- a release without it would install a server
# with nothing to sign in to -- so this, unlike build.sh, needs the panel's
# dependencies installed (scripts/web.sh install). It is built into a scratch
# directory, never over web/build.

set -euo pipefail

source "$(dirname "$0")/common.sh"

# The names install.sh asks for, from what `uname -m` says on the host.
PLATFORMS=(amd64 arm64 armv7 armv6 armv5 386 s390x)
if [ "$#" -gt 0 ]; then
  PLATFORMS=("$@")
fi

RELEASE_DIR="${RELEASE_DIR:-release}"

# Checked before anything is built, so a mistyped name fails now rather than
# after the panel's build.
for platform in "${PLATFORMS[@]}"; do
  case "${platform}" in
    amd64 | arm64 | armv7 | armv6 | armv5 | 386 | s390x) ;;
    *)
      echo "no such platform: ${platform} (one of: amd64 arm64 armv7 armv6 armv5 386 s390x)" >&2
      exit 1
      ;;
  esac
done

if [ ! -d web/node_modules ]; then
  echo "the panel's dependencies are not installed: run scripts/web.sh install first" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

# The panel is the same on every platform, so it is built once.
echo "building the panel"
(cd web && npm run build -- --outDir "${STAGE}/panel" --emptyOutDir)

mkdir -p "${RELEASE_DIR}"
rm -f "${RELEASE_DIR}"/x-ui-linux-*.tar.gz "${RELEASE_DIR}/SHA256SUMS"

for platform in "${PLATFORMS[@]}"; do
  root="${STAGE}/${platform}"
  dir="${root}/x-ui"
  mkdir -p "${dir}/migrations" "${dir}/web"

  # The ARM archives differ in GOARM alone: the instruction set the oldest board
  # they run on understands.
  # The CLI includes the independent Panel restart task runner; it must be
  # shipped with the API and worker for Restart & Apply to be available.
  goarch="${platform}"
  goarm=""
  case "${platform}" in
    armv*)
      goarch="arm"
      goarm="${platform#armv}"
      ;;
  esac
  GOOS=linux GOARCH="${goarch}" GOARM="${goarm}" OUT="${dir}/bin" VERSION="${VERSION}" \
    scripts/build.sh api worker cli agent

  cp scripts/core-reload.sh "${dir}/bin/x-ui-core-reload"

  cp migrations/*.sql "${dir}/migrations/"
  cp -R "${STAGE}/panel" "${dir}/web/build"
  cp x-ui.sh x-ui-api.service x-ui-worker.service x-ui-agent.service "${dir}/"

  # Owned by root and writable by root alone, whoever built it. tar restores the
  # owner an archive records when root unpacks it, and a binary left owned by the
  # build machine's uid is one whichever user has that uid on the host can
  # replace. The binaries and the menu are marked executable here rather than
  # trusted to carry the bit, which a build on Windows does not record.
  tarball="${RELEASE_DIR}/x-ui-linux-${platform}.tar"
  tar --create --file "${tarball}" --sort=name --owner=0 --group=0 --numeric-owner \
    --mode='u=rwx,go=rx' -C "${root}" x-ui/bin x-ui/x-ui.sh
  tar --append --file "${tarball}" --sort=name --owner=0 --group=0 --numeric-owner \
    --mode='u=rwX,go=rX' -C "${root}" x-ui/migrations x-ui/web \
    x-ui/x-ui-api.service x-ui/x-ui-worker.service \
    x-ui/x-ui-agent.service
  gzip -9 -n -f "${tarball}"
  echo "packaged ${tarball}.gz"
done

# Of this run's archives alone, so the file never lists one that is not beside it.
(
  cd "${RELEASE_DIR}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum x-ui-linux-*.tar.gz >SHA256SUMS
  else
    shasum -a 256 x-ui-linux-*.tar.gz >SHA256SUMS
  fi
)
echo "wrote ${RELEASE_DIR}/SHA256SUMS"

echo "done: publish everything in ${RELEASE_DIR}/ as the ${VERSION} release"
