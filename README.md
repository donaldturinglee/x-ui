# x-ui

Control plane for a tunnel deployment: operator accounts, subscribers and their
quotas, listeners, reported traffic, and the background work that enforces
quotas and expiry.

Go, PostgreSQL, three binaries — an API server, a background worker and a CLI.

x-ui does not carry traffic. The proxy core runs elsewhere; this tells it
what to serve and records what it measured. See
[docs/architecture.md](docs/architecture.md) for why the pieces sit where they
do.

## Requirements

- Go 1.27 or newer
- PostgreSQL 13 or newer, or Docker to run one from `compose.yaml`
- Node 22 or newer, to build the panel (the server runs without it)
- bash, to run the scripts in `scripts/`

## Getting started

The database first. Either from the compose file, which brings one up under the
user and database name `configs/config.yaml` expects:

```sh
docker compose up -d
```

or by hand, against a PostgreSQL that is already running:

```sh
createdb x_ui
createuser x_ui --pwprompt
```

The password is not in the file, so it comes from the environment —
`x_ui` if the database came from the compose file:

```sh
export X_UI_DATABASE_PASSWORD=x_ui
```

Then the schema, the root account, and the server:

```sh
scripts/migrate.sh                            # apply the schema
X_UI_ROOT_USERNAME=operator \
X_UI_ROOT_PASSWORD='a-good-password' \
  scripts/seed.sh                             # create the account to sign in with
scripts/run.sh api
```

The API is then at <http://127.0.0.1:8000/api>, and the panel at
<http://127.0.0.1:8000/> once it has been built (`scripts/web.sh install &&
scripts/web.sh build` — see [The panel](#the-panel)). In another terminal, with
the same database password exported:

```sh
scripts/run.sh worker
```

There are no default credentials. If neither `scripts/seed.sh` nor
`x-ui-cli admin` has created an account, the API starts with none and
says so in the log — it also creates one itself at startup when both
`X_UI_ROOT_*` variables are set, which is the same thing `seed` does
without having to start the server to do it.

## Configuration

Two sources, the second overriding the first:

1. `configs/config.yaml`
2. `X_UI_*` environment variables

There is one configuration and no environment selecting between several. What
differs between a laptop and a deployment is a handful of values — an address,
a password, a session secret — and those come from the environment.

The file overrides the keys it names and nothing else, and the built-in defaults
are a complete configuration, so a container can run on environment variables
alone.

Secrets belong in the environment, never in the files kept with the source:

| Variable | Purpose |
|---|---|
| `X_UI_DATABASE_PASSWORD` | Database password |
| `X_UI_DATABASE_URL` | Full `postgres://` DSN; overrides the parts |
| `X_UI_SESSION_SECRET` | Signs the session cookie. Without it every session ends at restart |
| `X_UI_ROOT_USERNAME`, `X_UI_ROOT_PASSWORD` | Create the first account if there is none |

A host set up by `install.sh` keeps them in a `config.yaml` of its own instead,
which only root can read — see [Installing a release](#installing-a-release).

Other common overrides: `X_UI_CONFIG_DIR`, `X_UI_SERVER_PORT`,
`X_UI_SERVER_LISTEN`, `X_UI_SERVER_TRUSTED_PROXIES`,
`X_UI_LOG_LEVEL`.

Startup refuses a configuration it cannot serve: a certificate without a key,
a port out of range, or `ssl_mode: disable` against a remote database. An empty
session secret is served, with a warning — every session then ends at restart.

`log.level: debug` also turns up the machinery underneath: the SQL behind every
query, and gin's route table.

### Behind a reverse proxy

Set `server.trusted_proxies` to the proxy's address. Left empty, no proxy is
trusted and every client is identified by the address it actually connected
from — which is the safe default, because an untrusted `X-Forwarded-For` lets a
client choose what goes into the sign-in log and into the rate limiter's key.

## The panel

The operator front end is a React application in `web`, served by the API
server itself. There is no second process and no second port: when
`web/build` exists, `x-ui-api` serves it from the root, `/`, and every
path that is not the API's falls through to the application so a reload of
`/clients` lands where it should. Without a build it says so in the log and
serves the API alone, which is a deployment in its own right — a node agent and
a script need no panel.

```sh
scripts/web.sh install     # once
scripts/web.sh build       # then start the API as usual
```

Working on it is the one case where two processes run. The dev server proxies
`/api` to the Go server rather than letting the browser call it directly —
the session is a cookie, and the API refuses a write whose `Origin` is not its
own `Host`, so the two have to look like one origin:

```sh
scripts/run.sh api         # :8000
scripts/web.sh dev         # :3000, the panel at http://localhost:3000/
```

```sh
scripts/web.sh check       # lint, types and unit tests
scripts/web.sh e2e         # Playwright, against a mocked API — no server needed
```

### Maintenance

Maintenance is a flag on the settings, switched from the overview page. It is
not a banner: a node that fetches its configuration while it is on gets a
document with **no inbounds at all**, so the core it feeds stops accepting
connections. Outbounds, WireGuard tunnels included, and everything the base
document carries are left in place, so routing is still whole and turning it off
again serves the same listeners as before.

The agent is told the difference between a quiet configuration and a withheld
one, so it can say so in its own log rather than reporting an empty deployment:

```
X-UI-Maintenance: true
```

`/api/load` reports the flag on every poll, so a panel already open finds
out without being told.

### Restarting the local proxy core

The Overview **sing-box** card shows the local service's actual state, PID and
uptime. **Restart sing-box** asks for confirmation because existing proxy
connections will close. Its separate task validates the service's current
configuration, restarts only `sing-box.service`, then confirms a new PID and a
healthy native statistics API. The panel remains available. **Logs** reads the
last 80 journal entries and shows any restart failure.

This control requires the root-managed systemd installation, its local agent,
native sing-box statistics and the updated core reload helper. The agent's
configuration application and manual restart share a file lock. Remote nodes
are not controlled by this card. Panel settings saved for a later restart are
not applied by restarting sing-box.

### Settings

The settings page, under General in the rail, is nine tabs:

- **Panel** — the panel's own listener, sessions and the worker's schedules,
  edited and saved to `configs/config.yaml`. Save validates the configuration
  and preserves other options and secrets. On a systemd installation, choose
  **Restart & Apply** after saving. A separate task restarts the API and worker,
  refreshes the locally managed agent connection when needed, and checks that
  the services are ready. Failed changes restore the previous Panel configuration;
  the proxy core keeps running. Other environments use their process manager
  (or `x-ui restart` on an installed host). Pending values survive
  a page reload; environment-controlled fields are locked and identified.
  Changing the listener, Web path, domain or TLS may change the sign-in URL.
- **Subscription** — the refresh interval and link options subscribers are
  served with, and the subscription listener as the configuration sets it.
- **Two-factor authentication** — the signed-in operator's own. Once it is on,
  signing in asks for the code an authenticator app shows after the password,
  and turning it off asks for one too.
- **Telegram Bot** — notifications to Telegram chats when an operator signs in
  and when the worker takes subscribers offline for quota or expiry. It needs a
  token from @BotFather and the ids of the chats; *Send a test message* tries
  them before anything depends on them. The bot only sends — nothing is
  answered from Telegram.
- **Sing Box** — the configuration a node fetches, assembled now, to copy or to
  download for a node set up by hand.
- **NTP** — the clock every node's core keeps, saved into the base document's
  `ntp` key.
- **HTTP Clients** — named clients used for remote downloads, saved into the
  base document's `http_clients` key independently of NTP.
- **Experimental** — the interfaces every node's core serves beside the proxy:
  its cache file, the V2Ray API and the Clash API, which is where a node's agent
  reads the traffic it reports. They are the base document's `experimental`
  key, and saved into it.
- **Logs** — what every node's core logs: whether it logs at all, the level,
  where to and whether lines are timestamped — the base document's `log` key.
  The panel's own log is read from the overview.

Where a tab offers *Restore defaults*, it puts back that tab's options and no other's.

## The API

Every endpoint answers with the same envelope:

```json
{ "success": true, "msg": "", "obj": { } }
```

The same endpoints are mounted twice:

- `/api` — session cookie, for a browser. Enforces same-origin on writes.
- `/apiv2` — `Token` header, for scripts and nodes.

`/healthz` is unauthenticated, for load balancers and the CLI probe.

The full specification is in [api/openapi.yaml](api/openapi.yaml).

```sh
# Sign in and list subscribers
curl -c jar -H 'Content-Type: application/json' \
  -d '{"username":"operator","password":"a-good-password"}' \
  http://127.0.0.1:8000/api/signin

curl -b jar http://127.0.0.1:8000/api/clients

# An account with two-factor authentication on is answered 401 with
# "obj": {"twoFactor": true} until the sign-in carries the app's code as well
curl -c jar -H 'Content-Type: application/json' \
  -d '{"username":"operator","password":"a-good-password","code":"123456"}' \
  http://127.0.0.1:8000/api/signin

# Or with a token
curl -H 'Token: <token>' http://127.0.0.1:8000/apiv2/clients
```

A panel front end runs on one endpoint, not eight:

```sh
# Everything, with a cursor
curl -b jar 'http://127.0.0.1:8000/api/load'

# Send the cursor back: a short reply when nothing has changed
curl -b jar 'http://127.0.0.1:8000/api/load?lu=417'
```

`onlines` and the maintenance flag come back on every poll, changed or not —
they are what moves between changes.

A node fetches the configuration it should serve. It is assembled on read from
the base document plus the inbounds and outbounds in the database, so a node
always gets what the database says now:

```sh
# Wrapped in the envelope, for a panel
curl -H 'Token: <token>' http://127.0.0.1:8000/apiv2/config

# The document itself, for a core that has to parse it
curl -H 'Token: <token>' -o config.json \
  http://127.0.0.1:8000/apiv2/config/download
```

A WireGuard outbound is written into `endpoints` rather than `outbounds`: the
core has run WireGuard as an endpoint since 1.11 and refuses it among its
outbounds since 1.13.

A listener carries its own TLS: `tls` among its options is the block the core
terminates with — plain TLS or Reality — and is written into the generated
document as it is. What a client is handed to meet it (the uTLS fingerprint, the
Reality public key, `insecure`) is no option the core takes on a listener, so it
is kept in the listener's `out_json.tls` and read only into the links and
subscriptions built for it. The panel's listener dialog sets both from its
Security choice: None, TLS or Reality.

The base document — `log`, `dns`, `route`, `experimental`, `services` and
anything else the core accepts — is edited at `/api/config/base`. It refuses
the managed keys (`inbounds`, `outbounds`, `endpoints`): those are filled in
during generation, so storing them there would look like it had taken effect and
never would.

An inbound TLS certificate can be supplied as a certificate and key file on
the node, or as PEM text in the listener's TLS block. The panel manages no
certificate providers, and refuses a listener whose TLS names one.

### Subscriptions

Subscribers fetch their configuration from a **second listener** (default port
8443), which has its own certificate, host check and proxy list. It is
unauthenticated: the subscription id is the credential.

```sh
# One URI per line, base64-encoded when the subEncode setting is on
curl http://127.0.0.1:8443/sub/alice

# A sing-box client configuration, or Clash/Mihomo YAML
curl 'http://127.0.0.1:8443/sub/alice?format=json'
curl 'http://127.0.0.1:8443/sub/alice?format=clash'

# Headers only: refresh the displayed quota without refetching everything
curl -I http://127.0.0.1:8443/sub/alice
```

`Subscription-Userinfo`, `Profile-Update-Interval` and `Profile-Title` are where
a client application reads the remaining quota, the refresh interval and the
profile name. Set `subscription.enabled: false` to serve none of this.

Nodes report traffic as **deltas since their last report**, never as running
totals:

```sh
curl -H 'Token: <token>' -H 'Content-Type: application/json' \
  -d '{"reports":[{"resource":"client","tag":"alice","up":1048576,"down":4194304}]}' \
  http://127.0.0.1:8000/apiv2/traffic
```

## Running a node

x-ui carries no traffic. A node runs a proxy core, and beside it runs the
agent — the only thing on that host that talks to the panel.

```sh
X_UI_AGENT_PANEL_URL=https://panel.example.com/apiv2 \
X_UI_AGENT_PANEL_TOKEN=your-token \
  x-ui-agent
```

It pulls the configuration, writes it where the core reads it (atomically, mode
`0600` — it carries every subscriber's credentials), runs the configured reload
command **only when the configuration actually changed**, and pushes back the
traffic the core measured. See `configs/agent.yaml`.

The release archive includes the agent binary, its systemd unit and a validated
core reload helper. The installer sets up the panel and local node together:

```sh
bash <(curl -Ls https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh)
```

The installer requires systemd and installs sing-box from its signed APT repository on Debian/Ubuntu, or
its DNF repository on supported Red Hat systems, if missing. Other systemd
hosts can use it after installing sing-box and its systemd service themselves.
It checks that the core supports the native statistics API (1.14+), creates a
persistent API token for the first operator, writes
`/etc/x-ui/agent.env` and `/etc/x-ui/agent.yaml` with mode `0600`, checks one
configuration sync, and enables the API, worker, sing-box and x-ui-agent.
It configures an authenticated, loopback-only native API for traffic statistics.
Later runs reuse valid tokens and statistics secrets and preserve operator
polling intervals and logging settings. The generated agent
configuration connects to the panel locally, using `server.domain` for the Host
header and TLS certificate name when configured. Reinstalling or using
`x-ui restart` refreshes the local URL when the panel's listener changes.
An existing agent targeting a remote panel is refused instead of redirected.

To inspect or refresh the local node setup without reinstalling:

```sh
x-ui-cli node -setup
# Restart the API after setup if it created a replacement token.
systemctl restart x-ui-api
x-ui-agent -config /etc/x-ui/agent.yaml -env-file /etc/x-ui/agent.env -sync-once
x-ui-cli node -check
```

The panel shows a token only at creation time under Admins > API tokens.
The installer creates or renews it through `x-ui-cli node -setup` and stores it
without printing it. The API loads
tokens when it starts.

The agent validates a private candidate before replacing its staging file.
The reload helper installs the validated configuration as root with the core
service's group and mode `0640`, then reloads the core. A failed reload restores
the previous file, and the agent retries failed changes. For manual nodes with
sing-box 1.14+, add a loopback
`api` service to the base configuration with `listen: 127.0.0.1`,
`listen_port: 9091`, `dashboard: false`, and a secret. Set the agent's
`stats.source: sing-box`, `stats.url: http://127.0.0.1:9091`, and
`X_UI_AGENT_STATS_SECRET` to the same secret. Its native API supplies the
authenticated user and inbound/outbound tags that its Clash API omits.
For other cores, `stats.source: clash` requires these metadata fields in
the Clash API. Until a supported API is configured, set `stats.source: none`.
With that setting, traffic quotas do not receive
usage reports from the node.

Reading counters through the sing-box Clash API has one known gap: a connection
that opens and closes entirely between two polls is never seen. The ten-second
default report interval is chosen for that, not for freshness.

## Commands

```sh
x-ui-api                     # serve
x-ui-worker                  # scheduled quota and retention work
x-ui-agent                   # run on a node, beside the proxy core

x-ui-cli admin -show
x-ui-cli admin -list
x-ui-cli admin -username operator -password 'a-good-password'
x-ui-cli admin -disable-two-factor operator
x-ui-cli seed                # create the root account if there is none
x-ui-cli migrate             # apply pending migrations
x-ui-cli migrate -status
x-ui-cli migrate -down 1     # roll back the newest (asks first)
x-ui-cli setting -show
x-ui-cli setting -reset
x-ui-cli backup                          # export to a timestamped file
x-ui-cli backup -exclude stats,changes   # configuration only
x-ui-cli backup -restore dump.json       # replace the data (asks first)
x-ui-cli healthcheck
x-ui-cli healthcheck -subscription
x-ui-cli node -setup         # configure the local node after migrate/seed
x-ui-cli node -check         # sync and authenticated statistics; no proxy traffic
x-ui-cli node -check-panel   # panel connection only, including legacy local agents
x-ui-cli database -check
x-ui-cli database -backup /private/path/database.dump
x-ui-cli database -restore /private/path/database.dump -yes
```

`admin` sets explicit credentials and is the account-recovery path. There is
deliberately no reset-to-default-password: a command that turns a live panel
into one with well-known credentials is not a recovery tool. For the same
reason it is how an operator who lost their authenticator gets back in:
`-disable-two-factor` turns the account's second factor off, which the panel
will do only for a code from that authenticator.

`seed` is the other half of that: the one step between an empty database and
being able to sign in, meant to run once after `migrate`. It reads
`X_UI_ROOT_USERNAME` and `X_UI_ROOT_PASSWORD` unless given
`-username` and `-password`, and it leaves an existing account exactly as it is
— so a deploy script that runs it every time never rewrites a password an
operator has since changed.

## Development

Everything is a script in `scripts/`, run from the repository root. There is no
Makefile: the commands are the shell they were always going to run, and each
one carries its own usage block at the top of the file.

```sh
scripts/help.sh            # every script and what it does
scripts/build.sh           # bin/x-ui-{api,worker,cli,agent}
scripts/test.sh            # unit tests; no database needed
scripts/check.sh           # formatting, vet and tests, as CI runs them
scripts/test-install.sh    # isolated install/upgrade/recovery regression checks
scripts/test-release.sh    # isolated release tagging and retry checks
scripts/test-database.sh   # optional integration checks; requires PostgreSQL
scripts/migrate.sh -status
```

`scripts/test.sh` runs without PostgreSQL: the quota and expiry state machine,
configuration precedence, the migration loader, password handling and
validation are all covered without one. `scripts/test-install.sh` also runs
without PostgreSQL or systemd, using private fixtures for packages and services.
The optional `scripts/test-database.sh` creates and removes a dedicated temporary
database and login to check local node initialization and schema/data recovery.
Run it as root on a PostgreSQL host, or supply `X_UI_TEST_DATABASE_ADMIN_URL`
and matching `X_UI_TEST_DATABASE_HOST` / `X_UI_TEST_DATABASE_PORT`. Set
`X_UI_TEST_CLI` if the built CLI is outside `bin/`. It does not create an inbound.

The panel has a toolchain of its own — Node 22 or newer — and is deliberately
not part of `scripts/build.sh` or `scripts/check.sh`, so a Go checkout stays
buildable without npm:

```sh
scripts/web.sh install
scripts/web.sh check       # lint, types and unit tests
scripts/web.sh e2e         # Playwright, against a mocked API
```

## Layout

```
cmd/api            HTTP server (panel + subscriptions)
cmd/worker         scheduled jobs
cmd/cli            administration
cmd/agent          node agent — runs beside the proxy core

internal/config    the config file and environment variables
internal/domain    entities, invariants, error vocabulary
internal/handler   HTTP: bind, authorise, respond
internal/service   business rules, transactions, audit
internal/repository queries, one type per aggregate
internal/database  connection, pool, migration runner
internal/middleware auth, CSRF, host check, request logging
internal/agent     config sync, traffic reporting, core stats adapters

pkg/httputil       response envelope
pkg/validator      field validation
pkg/logger         levelled logging with an in-memory ring for /api/logs

api/               OpenAPI specification
configs/           configuration: the panel's, and the node agent's
migrations/        SQL schema: the initialization, then each change, up and down
web/               the panel — React, built into web/build
scripts/           every command: build, run, migrate, seed, test, check, package
test/data/         fixtures
docs/              architecture notes
install.sh         installs a release on a Linux host, and upgrades it
x-ui.sh            the menu that manages it there, installed as x-ui
*.service          systemd units for the API, worker and agent
```

## Deploying

### Installing a release

On a Linux host, as root:

```sh
bash <(curl -Ls https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh)
```

The installer fetches the latest release for the host's CPU — amd64, arm64,
armv7, armv6, armv5, 386 or s390x — and refuses it unless it matches the
`SHA256SUMS` published beside it. It configures and enables the
`x-ui-api`, `x-ui-worker`, `sing-box` and `x-ui-agent` services under systemd,
puts `x-ui-cli` and the `x-ui` menu on the PATH, and prints the
addresses the panel is reached on. Run again, it upgrades in place. A tag on
the end installs that release rather than the latest:

```sh
bash <(curl -Ls https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh) v1.2.0
```

Every installation includes the local node. Repeating the command preserves
valid agent tokens and statistics secrets and refreshes the managed local
connection settings. Unsupported service managers and missing release
capabilities are rejected before replacing the panel.

Before switching releases, the installer keeps the previous binaries,
configuration and service state under `/usr/local/x-ui-backups/`. It stops
panel writers and takes a complete `pg_dump` archive, including the schema and
migration table. PostgreSQL client tools must be at least as new as the database.
Recovery resets user schemas and restores the archive in one transaction, so
tables introduced by a failed upgrade are removed as well. Use a dedicated
panel database whose role can restore its schemas.
Failed upgrades restore the database, files and previous service state; an
unsuccessful database restore leaves panel services stopped and retains the
backup for recovery. The private archive includes connection credentials.

Installation checks cover the panel and database, worker, subscription HTTP
listener, core configuration, agent sync, authenticated statistics reading and
startup settings. They do not create or connect to an inbound or generate
proxy traffic.

The database is a PostgreSQL on the same host unless the installer is told
otherwise. It installs the distribution's when there is none, and creates a
`x_ui` role, with a generated password, and a database of that name. After a
successful installation it prints those local database credentials. Upgrades
reuse the saved credentials without printing them again. The installer
changes nothing else about a server that was already there, except where the
distribution answers loopback connections with ident (the RHEL family and
openSUSE): two lines at the top of `pg_hba.conf` then let that one role sign in
with its password. To use a database elsewhere, name it, and PostgreSQL on the
host is left alone:

```sh
X_UI_DATABASE_URL='postgres://x_ui:...@db.example.com/x_ui?sslmode=require' \
  bash <(curl -Ls https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh)
```

The installer does not print credentials for an external database. Keep the
installation output private: a fresh local installation prints the database
password.

It offers to change the panel's port, the subscription port and path, and the
operator account. Declined, a fresh install gets an account with generated
credentials, printed once. The panel's Web path can be edited in Settings →
Panel; the server supplies that path to the assets, router and API at runtime.

What the installer chose is kept in
`/usr/local/x-ui/configs/config.yaml`, beside the database password and
the session secret, so only root reads it. The services, `x-ui-cli` and
the menu all read that file, and anything else under
[Configuration](#configuration) goes in it too; the installer and the menu
change only the keys they look after, in place. Restart the services after
changing it: `x-ui restart`.

### Managing an installed panel

`x-ui`, run as root, is a menu for everything around the panel on its
host:

- installing, updating to the latest release or to a chosen one, and removing
  it;
- the operator account: its credentials, and turning its two-factor
  authentication off;
- the panel port, the subscription port and path, and restoring the settings
  the panel keeps;
- starting, stopping and restarting all four services, their state and logs, and
  whether they start at boot.

Certificates for the panel and subscription listener are obtained and renewed
outside x-ui. Set each listener's `cert_file` and `key_file` in
`config.yaml` to serve HTTPS directly. The API loads them at startup, so restart
`x-ui-api` after a renewal. Existing certificate paths remain valid when
upgrading from a release whose menu issued them.

The services and the install are commands too:

```sh
x-ui start|stop|restart|status|enable|disable|log
x-ui update
x-ui uninstall
x-ui help
```

`x-ui uninstall` removes both services, `/usr/local/x-ui` and
`x-ui-cli`, and leaves the menu itself (`rm -f /usr/bin/x-ui`)
and the database, which a later install picks up again. It also stops and
removes the agent service and stops sing-box; its package and `/etc/x-ui/agent.*` remain for a later
install or manual cleanup. When the installer
made the database, and the data is not wanted either:

```sh
su postgres -c 'dropdb x_ui && dropuser x_ui'
```

### Packaging a release

The archives the installer downloads are built by `scripts/package.sh`: one per
platform, each holding the panel's three binaries and the node agent, the
migrations, the built panel, the menu and the systemd units, and a `SHA256SUMS`
beside them. Each archive includes `bin/x-ui-core-reload`. The installer
configures and enables the local node, as [Running a node](#running-a-node) describes.

```sh
bash scripts/release.sh --dry-run  # preview after committing and pushing main
bash scripts/release.sh            # v0.0.1 first, then increment the latest patch
bash scripts/release.sh v0.1.0      # choose an explicit stable version
```

The release script requires a clean checkout of `main` matching `origin/main`.
It reads the remote tags to choose the next stable version and pushes only that
tag. If a push fails, retry with the version printed by the script; its local
tag is retained. Published tags and tags for other commits are not replaced.

The tag starts `cd.yaml`, which runs CI, builds all seven archives with
`scripts/package.sh`, checks `SHA256SUMS`, and publishes the GitHub Release.
For a local package build, install the panel dependencies with
`scripts/web.sh install` and run `VERSION=v0.0.1 scripts/package.sh`.

The installer asks GitHub for the latest release, which leaves out drafts and
pre-releases, so a release is what it installs by default only once it is
published as neither.

### By hand

```sh
VERSION=1.0.0 GOOS=linux GOARCH=amd64 scripts/build.sh
scripts/web.sh build    # if the panel is being served
```

The panel is built separately and deployed as files beside the binary, not
embedded in it, so it can be rebuilt or left out without touching the server.

Binaries are static (`CGO_ENABLED=0`) with the version stamped in. Both the API
and the worker migrate on startup behind an advisory lock, so starting them
together is safe and no separate migration step is needed — though
`scripts/migrate.sh -status` before a deploy will tell you what is pending.

Run one worker. Several are safe, but they will contend for the same rows to do
the same work.
