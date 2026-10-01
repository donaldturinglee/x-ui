#!/usr/bin/env bash
# Optional PostgreSQL integration check. It creates a random, dedicated database
# and login, then removes both. It never creates an inbound or starts a service.
# Usage: X_UI_TEST_CLI=/path/to/x-ui-cli bash scripts/test-database.sh
# Use X_UI_TEST_DATABASE_ADMIN_URL when PostgreSQL is not local to root/postgres.
set -euo pipefail
umask 077
repo="$(cd "$(dirname "$0")/.." && pwd)"
cli="${X_UI_TEST_CLI:-${repo}/bin/x-ui-cli}"
[[ -x "${cli}" ]] || { echo "Build x-ui-cli before running the database check" >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/x-ui-database-test.XXXXXXXX")"
name="x_ui_install_test_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
admin_psql() {
  if [[ -n "${X_UI_TEST_DATABASE_ADMIN_URL:-}" ]]; then
    psql -X --no-password -v ON_ERROR_STOP=1 --dbname="${X_UI_TEST_DATABASE_ADMIN_URL}" "$@"
  elif [[ "$(id -u)" == 0 ]]; then
    runuser -u postgres -- psql -X --no-password -v ON_ERROR_STOP=1 --dbname=postgres "$@"
  else
    psql -X --no-password -v ON_ERROR_STOP=1 --dbname=postgres "$@"
  fi
}
cleanup() {
  local status=$?
  set +e
  admin_psql -v test_name="${name}" <<'SQL' >/dev/null
SELECT format('DROP DATABASE IF EXISTS %I', :'test_name') \gexec
SELECT format('DROP ROLE IF EXISTS %I', :'test_name') \gexec
SQL
  rm -rf -- "${work}"
  exit "${status}"
}
trap cleanup EXIT
admin_psql -v test_name="${name}" -v test_password="${password}" <<'SQL' >/dev/null
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'test_name', :'test_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'test_name', :'test_name') \gexec
SQL
export PGPASSWORD="${password}"
host="${X_UI_TEST_DATABASE_HOST:-127.0.0.1}"
port="${X_UI_TEST_DATABASE_PORT:-5432}"
# The URL is persisted in the backup metadata, independent of later overrides.
export X_UI_DATABASE_URL="postgresql://${name}:${password}@${host}:${port}/${name}?sslmode=disable"
export X_UI_CONFIG_DIR="${work}/configs"
export X_UI_DATABASE_MIGRATIONS_DIR="${repo}/migrations"
export X_UI_ROOT_USERNAME=installer-test
export X_UI_ROOT_PASSWORD="${password}"
mkdir -p "${X_UI_CONFIG_DIR}"
psql_test() { psql -X --no-password -v ON_ERROR_STOP=1 --dbname="postgresql://${name}@${host}:${port}/${name}?sslmode=disable" "$@"; }
"${cli}" database -check
"${cli}" migrate
"${cli}" seed >/dev/null
"${cli}" node -setup -directory "${work}/node"
cp "${work}/node/agent.env" "${work}/credentials.before"
base_before="$(psql_test -Atc "SELECT value FROM settings WHERE key='config'")"
"${cli}" node -setup -directory "${work}/node"
cmp "${work}/credentials.before" "${work}/node/agent.env"
[[ "$(psql_test -Atc 'SELECT count(*) FROM tokens')" == 1 ]]
[[ "$(psql_test -Atc "SELECT value FROM settings WHERE key='config'")" == "${base_before}" ]]
printf 'X_UI_AGENT_PANEL_URL=http://127.0.0.1:8000/apiv2\nX_UI_AGENT_STATS_SOURCE=none\nX_UI_AGENT_SYNC_INTERVAL=45s\n' >>"${work}/node/agent.env"
X_UI_SERVER_PORT=18088 "${cli}" node -setup -directory "${work}/node"
grep -q 'url: http://127.0.0.1:18088/apiv2' "${work}/node/agent.yaml"
grep -q '^X_UI_AGENT_SYNC_INTERVAL=45s$' "${work}/node/agent.env"
if grep -qE '^X_UI_AGENT_(PANEL_URL|STATS_SOURCE)=' "${work}/node/agent.env"; then
  echo 'Stale connection overrides were retained' >&2
  exit 1
fi
cp "${work}/node/agent.env" "${work}/credentials.before"
# Validate the newly initialized document with the real core when available.
# A fresh database has no inbounds; only its base and seeded direct/block routes
# are composed here, without starting the core or generating traffic.
if command -v sing-box >/dev/null 2>&1; then
  psql_test -Atc "SELECT jsonb_pretty((SELECT value::jsonb FROM settings WHERE key='config') || jsonb_build_object('inbounds', '[]'::jsonb, 'outbounds', (SELECT jsonb_agg(jsonb_build_object('type', type, 'tag', tag) || COALESCE(options, '{}'::jsonb) ORDER BY id) FROM outbounds)))" >"${work}/generated.json"
  sing-box check -c "${work}/generated.json"
fi
psql_test <<'SQL' >/dev/null
CREATE TABLE install_original (id integer PRIMARY KEY, value text);
INSERT INTO install_original VALUES (1, 'before');
SQL
"${cli}" database -backup "${work}/database.dump"
[[ "$(stat -c '%a' "${work}/database.dump")" == 600 ]]
[[ "$(stat -c '%a' "${work}/database.dump.connection.json")" == 600 ]]
psql_test <<'SQL' >/dev/null
CREATE TABLE install_new_dependency (parent_id integer REFERENCES install_original(id));
INSERT INTO install_new_dependency VALUES (1);
ALTER TABLE install_original ADD COLUMN introduced_by_upgrade text;
UPDATE install_original SET value='after';
CREATE SCHEMA install_new_schema;
CREATE TABLE install_new_schema.extra (id integer);
SQL
# A restore must use the original saved connection, even if current settings
# point elsewhere, and undo schema additions along with changed rows.
X_UI_DATABASE_URL='postgresql://missing@127.0.0.1:1/missing' "${cli}" database -restore "${work}/database.dump" -yes
[[ "$(psql_test -Atc 'SELECT value FROM install_original WHERE id=1')" == before ]]
[[ "$(psql_test -Atc "SELECT to_regclass('install_new_dependency') IS NULL")" == t ]]
[[ "$(psql_test -Atc "SELECT count(*) FROM pg_namespace WHERE nspname='install_new_schema'")" == 0 ]]
[[ "$(psql_test -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='install_original' AND column_name='introduced_by_upgrade'")" == 0 ]]
# Make valid archive SQL fail after the schema reset. The single transaction
# must preserve the pre-restore tables and their rows on this failure.
psql_test -c "UPDATE install_original SET value='keep-on-failure'" >/dev/null
mkdir "${work}/tools"
real_pg_restore="$(command -v pg_restore)"
cat >"${work}/tools/pg_restore" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
"${X_UI_TEST_REAL_PG_RESTORE}" "$@"
for argument in "$@"; do
  if [[ "${argument}" == --file=* ]]; then
    printf '\nSELECT missing_x_ui_restore_function();\n' >>"${argument#--file=}"
  fi
done
SH
chmod +x "${work}/tools/pg_restore"
if PATH="${work}/tools:${PATH}" X_UI_TEST_REAL_PG_RESTORE="${real_pg_restore}" "${cli}" database -restore "${work}/database.dump" -yes >"${work}/failed-restore.log" 2>&1; then
  echo 'A failed restore was accepted' >&2
  exit 1
fi
[[ "$(psql_test -Atc 'SELECT value FROM install_original WHERE id=1')" == keep-on-failure ]]
# Revoked local tokens are replaced, while the statistics secret remains stable.
psql_test -c "DELETE FROM tokens" >/dev/null
"${cli}" node -setup -directory "${work}/node"
[[ "$(psql_test -Atc 'SELECT count(*) FROM tokens')" == 1 ]]
old_secret="$(sed -n '/^X_UI_AGENT_STATS_SECRET=/p' "${work}/credentials.before")"
[[ "$(sed -n '/^X_UI_AGENT_STATS_SECRET=/p' "${work}/node/agent.env")" == "${old_secret}" ]]
if cmp -s "${work}/credentials.before" "${work}/node/agent.env"; then
  echo 'Revoked agent token was reused' >&2
  exit 1
fi
echo 'PostgreSQL checks passed (idempotent node bootstrap, local URL refresh, revoked tokens, schema/data recovery and atomic failed restore).'
