#!/usr/bin/env bash
#
# Check release tagging against isolated local Git repositories.
#
# Usage:
#   bash scripts/test-release.sh
#
# All commits, tags and pushes belong to temporary repositories. No GitHub
# connection, host configuration or changes to this checkout are needed.

set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
test_root="$(mktemp -d "${test_parent}/x-ui-release-test.XXXXXXXX")"
resolved_root="$(realpath "${test_root}")"
cleanup() {
  local result=$?
  if [[ "$(realpath "${test_root}")" != "${resolved_root}" || "${resolved_root}" != "${test_parent}"/x-ui-release-test.* ]]; then
    echo "Refusing to remove an unexpected test directory: ${test_root}" >&2
    return 1
  fi
  rm -rf -- "${resolved_root}"
  return "${result}"
}
trap cleanup EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME='Release test' GIT_AUTHOR_EMAIL='release-test@example.invalid'
export GIT_COMMITTER_NAME="${GIT_AUTHOR_NAME}" GIT_COMMITTER_EMAIL="${GIT_AUTHOR_EMAIL}"
fixture="${test_root}/checkout with spaces"
remote="${test_root}/origin.git"
log="${test_root}/output.log"
checks=0

git init --quiet --bare --initial-branch=main "${remote}"
git init --quiet --initial-branch=main "${fixture}"
mkdir "${fixture}/scripts"
cp "${repo}/scripts/release.sh" "${fixture}/scripts/release.sh"
git -C "${fixture}" add scripts/release.sh
git -C "${fixture}" commit --quiet -m Initial
git -C "${fixture}" remote add origin "${remote}"
git -C "${fixture}" push --quiet origin main
initial="$(git -C "${fixture}" rev-parse HEAD)"

run_expected() {
  local expected="$1" pattern="$2" result
  shift 2
  if (cd "${test_parent}" && bash "${fixture}/scripts/release.sh" "$@") >"${log}" 2>&1; then result=0; else result=$?; fi
  if [[ "${result}" -ne "${expected}" ]] || ! grep -Fq -- "${pattern}" "${log}"; then
    cat "${log}" >&2
    echo "Release check failed: ${pattern} (exit ${result}, expected ${expected})" >&2
    exit 1
  fi
  checks=$((checks + 1))
}

publish_fixture_tag() {
  git -C "${fixture}" tag -a "$1" -m "Fixture $1"
  git -C "${fixture}" push --quiet origin "refs/tags/$1:refs/tags/$1"
}

bash -n "${repo}/scripts/release.sh"
run_expected 0 'Usage:' --help
run_expected 1 'Unknown option:' --unknown
run_expected 1 'Specify at most one' v0.0.1 v0.0.2
for invalid in 0.0.1 v0.00.1 v0.0.01 'v0.0.1;echo'; do
  run_expected 1 'Use a version such as' "${invalid}"
done
run_expected 0 'Release version: v0.0.1' --dry-run
[[ -z "$(git -C "${fixture}" tag --list)" ]]
[[ -z "$(git --git-dir="${remote}" tag --list)" ]]

# Unpublished local tags and remote prereleases do not advance the first stable
# release; pushing one version must leave unrelated tags local.
git -C "${fixture}" tag v9.9.9
publish_fixture_tag v1.0.0-beta.1
run_expected 0 'Pushed v0.0.1.'
[[ "$(git --git-dir="${remote}" rev-parse 'refs/tags/v0.0.1^{commit}')" == "${initial}" ]]
[[ "$(git --git-dir="${remote}" cat-file -t refs/tags/v0.0.1)" == tag ]]
[[ -z "$(git --git-dir="${remote}" tag --list v9.9.9)" ]]
run_expected 1 'v0.0.1 already exists on origin' v0.0.1

# Compare numeric versions, not lexical order or the order tags were created.
publish_fixture_tag v0.0.10
publish_fixture_tag v0.0.9
run_expected 0 'Release version: v0.0.11' --dry-run

# Refuse tracked edits, untracked files, other branches and detached HEAD.
echo '# uncommitted' >>"${fixture}/scripts/release.sh"
run_expected 1 'uncommitted changes' --dry-run
git -C "${fixture}" restore scripts/release.sh
touch "${fixture}/untracked"
run_expected 1 'uncommitted changes' --dry-run
rm -f -- "${fixture}/untracked"
git -C "${fixture}" switch --quiet -c topic
run_expected 1 'main branch' --dry-run
git -C "${fixture}" switch --quiet --detach
run_expected 1 'main branch' --dry-run
git -C "${fixture}" switch --quiet main

# A local commit must already be on origin/main; a stale checkout must not
# release the previous commit after another operator updates main.
git -C "${fixture}" commit --quiet --allow-empty -m 'Local change'
run_expected 1 'main must match origin/main' --dry-run
git -C "${fixture}" push --quiet origin main
peer="${test_root}/peer"
git clone --quiet "${remote}" "${peer}"
git -C "${peer}" commit --quiet --allow-empty -m 'Remote change'
git -C "${peer}" push --quiet origin main
run_expected 1 'main must match origin/main' --dry-run
git -C "${fixture}" pull --quiet --ff-only origin main

# Preserve a failed push's tag and reuse it on retry rather than reserving a
# different version. A different commit's local tag is never overwritten.
cat >"${remote}/hooks/pre-receive" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "${remote}/hooks/pre-receive"
run_expected 1 'Retry: bash scripts/release.sh v0.1.0' v0.1.0
pending="$(git -C "${fixture}" rev-parse refs/tags/v0.1.0)"
[[ -z "$(git --git-dir="${remote}" tag --list v0.1.0)" ]]
rm -f -- "${remote}/hooks/pre-receive"
run_expected 0 'Pushed v0.1.0.' v0.1.0
[[ "$(git --git-dir="${remote}" rev-parse refs/tags/v0.1.0)" == "${pending}" ]]
run_expected 0 'Release version: v0.1.1' --dry-run
git -C "${fixture}" tag v0.1.1 "${initial}"
run_expected 1 'Local tag v0.1.1 points to another commit' --dry-run
[[ "$(git -C "${fixture}" rev-parse refs/tags/v0.1.1)" == "${initial}" ]]
[[ -z "$(git --git-dir="${remote}" tag --list v0.1.1)" ]]

echo "Release regression checks passed (${checks} checks: initial version, version order, clean published main, exact tag pushes and failed-push recovery)."
