#!/usr/bin/env bash
#
# Push a release tag, starting at v0.0.1 and increasing the patch version.
#
# Usage:
#   bash scripts/release.sh                  # next published patch version
#   bash scripts/release.sh v0.1.0           # choose a new version
#   bash scripts/release.sh --dry-run        # check and preview without tagging
#
# Run after committing and pushing main. The existing tag workflow runs CI,
# builds the archives and publishes the GitHub Release. No GitHub CLI is needed.

set -euo pipefail

usage() {
  echo "Usage: bash scripts/release.sh [--dry-run] [vMAJOR.MINOR.PATCH]"
  echo "Without a version, start at v0.0.1 or increment the latest remote patch."
}

fail() { echo "$*" >&2; exit 1; }

version=""
dry_run=false
for argument in "$@"; do
  case "${argument}" in
    --dry-run) dry_run=true ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; fail "Unknown option: ${argument}" ;;
    *)
      [[ -z "${version}" ]] || fail "Specify at most one release version."
      version="${argument}"
      ;;
  esac
done

version_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if [[ -n "${version}" && ! "${version}" =~ ${version_pattern} ]]; then
  fail "Use a version such as v0.0.1, without leading zeroes or a suffix."
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ "$(git rev-parse --is-inside-work-tree)" == true ]] || fail "Run from an x-ui checkout."
[[ "$(git symbolic-ref --quiet --short HEAD || true)" == main ]] || fail "Release from the main branch."
[[ -z "$(git status --porcelain)" ]] || fail "Commit or remove uncommitted changes before releasing."
head="$(git rev-parse HEAD)"

# Read remote refs rather than assuming the checkout has fetched every tag.
# Remote stable versions determine the next number; prereleases are ignored.
if ! remote_refs="$(git ls-remote --refs --sort=-version:refname origin refs/heads/main 'refs/tags/v*')"; then
  fail "Could not read origin. No release tag was created."
fi
remote_head=""
latest_version=""
while read -r commit ref; do
  if [[ "${ref}" == refs/heads/main ]]; then remote_head="${commit}"; fi
  candidate="${ref#refs/tags/}"
  if [[ -z "${latest_version}" && "${candidate}" =~ ${version_pattern} ]]; then
    latest_version="${candidate}"
  fi
done <<<"${remote_refs}"
[[ -n "${remote_head}" && "${head}" == "${remote_head}" ]] || fail "main must match origin/main. Push or update main before releasing."

if [[ -z "${version}" ]]; then
  if [[ -z "${latest_version}" ]]; then
    version=v0.0.1
  else
    version="${latest_version%.*}.$((10#${latest_version##*.} + 1))"
  fi
fi
while read -r commit ref; do
  [[ "${ref}" != "refs/tags/${version}" ]] || fail "${version} already exists on origin. Choose a new version."
done <<<"${remote_refs}"

# A failed push leaves the local tag available for an explicit retry. Never
# replace a tag that identifies another commit, or push unrelated local tags.
reuse_tag=false
if git show-ref --verify --quiet "refs/tags/${version}"; then
  [[ "$(git rev-parse --verify "refs/tags/${version}^{commit}")" == "${head}" ]] || fail "Local tag ${version} points to another commit. Choose a new version."
  reuse_tag=true
fi
printf 'Release version: %s\nCommit: %s\n' "${version}" "${head}"
if [[ "${dry_run}" == true ]]; then
  echo "Dry run: would push ${version} and trigger Continuous deployment."
  exit 0
fi
if [[ "${reuse_tag}" == false ]]; then
  git tag -a "${version}" -m "Release ${version}" "${head}"
fi
if ! git push origin "refs/tags/${version}:refs/tags/${version}"; then
  echo "Push failed; the local ${version} tag was retained." >&2
  echo "Retry: bash scripts/release.sh ${version}" >&2
  exit 1
fi
echo "Pushed ${version}. Follow Continuous deployment in GitHub Actions for the release result."
