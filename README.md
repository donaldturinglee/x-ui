<a id="readme-top"></a>

<div align="center">
  <h1>x-ui</h1>

  <p>
    A control panel for tunnel deployments, subscriptions, traffic quotas and sing-box nodes.
  </p>

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stars][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![License][license-shield]][license-url]

  <p>
    <a href="docs/architecture.md">Architecture</a>
    &middot;
    <a href="api/openapi.yaml">API specification</a>
    &middot;
    <a href="https://github.com/donaldturinglee/x-ui/releases">Releases</a>
    &middot;
    <a href="https://github.com/donaldturinglee/x-ui/issues/new?labels=bug">Report a bug</a>
    &middot;
    <a href="https://github.com/donaldturinglee/x-ui/issues/new?labels=enhancement">Suggest a feature</a>
  </p>
</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#contributors">Contributors</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgements">Acknowledgements</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

## About The Project

x-ui helps operators manage subscribers, listeners, subscriptions and traffic
limits from a web panel. PostgreSQL stores the configuration and usage data;
a worker enforces quotas and expiry, while node agents synchronize proxy
configuration and report traffic. The proxy core carries the traffic.

Key features:

- Operator accounts, two-factor authentication and API tokens.
- Subscriber management, subscription links, traffic quotas and expiry.
- A React panel served by the Go API, with separate panel and subscription listeners.
- sing-box node configuration, synchronization and authenticated native statistics.
- Administration, database migrations, backup and recovery through the CLI.
- Linux release archives and an installer that sets up the panel and a local node.

The project ships four binaries: `x-ui-api`, `x-ui-worker`, `x-ui-cli` and
`x-ui-agent`. See [the architecture notes](docs/architecture.md) for their roles.

### Built With

- [Go](https://go.dev/), [Gin](https://github.com/gin-gonic/gin) and [GORM](https://gorm.io/)
- [PostgreSQL](https://www.postgresql.org/)
- [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/) and [Vite](https://vite.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [sing-box](https://github.com/SagerNet/sing-box)

[Back to top](#readme-top)

## Getting Started

Install a published release on a Linux host, or run the project from source for
development.

### Prerequisites

For a release installation:

- A Linux host running systemd, with root access, Bash and curl already available.
- The distribution's native package manager: APT, DNF/YUM, Zypper or Pacman.
- PostgreSQL 13 or newer, installed locally by the installer or supplied externally.
- sing-box with native statistics support (1.14 or newer) and its systemd service.
  The installer can install it through APT or DNF; other hosts must provide it first.

The installer checks dependencies before downloading release archives. It installs
only missing utilities and PostgreSQL client tools, using the distribution's
package manager, and verifies the CA trust bundle. Working Bash, curl and awk are
kept. Arch package installation uses `pacman -Syu` to avoid a partial system upgrade.
PostgreSQL client tools must be at least as new as the database server for backups.

For development:

- Git and Bash.
- Go 1.27.1 or newer, as specified in [go.mod](go.mod).
- Node.js 22 or newer and npm for the web panel.
- PostgreSQL 13 or newer, or Docker Compose to run [compose.yaml](compose.yaml).

### Installation

#### Install a release

Run as root on the target host:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh)
```

Append a release tag to select a version:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh) v0.0.1
```

The installer supports `amd64`, `arm64`, `armv7`, `armv6`, `armv5`, `386` and
`s390x`. It verifies the archive against `SHA256SUMS`, configures the database and
local node, and enables the `x-ui-api`, `x-ui-worker`, `sing-box` and `x-ui-agent`
services. It prints the panel address and initial operator credentials.

To use an external database:

```sh
X_UI_DATABASE_URL='postgres://x_ui:password@db.example.com/x_ui?sslmode=require' \
  bash <(curl -fsSL https://raw.githubusercontent.com/donaldturinglee/x-ui/main/install.sh)
```

The installer still prepares client tools for backup and restore. It does not
initialize or start a local PostgreSQL server when an external URL is supplied.
Use a dedicated database whose role can restore its schemas.

Run the installer again to upgrade. Existing configuration and valid node secrets
are preserved. Before replacing an existing installation, it saves files and a
database archive under `/usr/local/x-ui-backups/`; a failed upgrade attempts to
restore the previous installation. Save installation output and backups securely:
they can contain credentials.

#### Run from source

1. Clone the repository and enter its directory.

   ```sh
   git clone https://github.com/donaldturinglee/x-ui.git
   cd x-ui
   ```

2. Start the development database and set the configuration.

   ```sh
   docker compose up -d --wait
   export X_UI_DATABASE_PASSWORD=x_ui
   export X_UI_SESSION_SECRET='replace-with-a-long-random-secret'
   ```

   The Compose database credentials are for local development. To use an existing
   database, configure [configs/config.yaml](configs/config.yaml) or set
   `X_UI_DATABASE_URL` instead.

3. Apply migrations and create the first operator account.

   ```sh
   bash scripts/migrate.sh
   X_UI_ROOT_USERNAME=operator X_UI_ROOT_PASSWORD='choose-a-strong-password' \
     bash scripts/seed.sh
   ```

4. Install and build the web panel, then start the API.

   ```sh
   bash scripts/web.sh install
   bash scripts/web.sh build
   bash scripts/run.sh api
   ```

   Open <http://127.0.0.1:8000/> and sign in with the account created above.
   In another terminal, start the worker with the same database configuration:

   ```sh
   X_UI_DATABASE_PASSWORD=x_ui bash scripts/run.sh worker
   ```

   For frontend development, use `bash scripts/web.sh dev` and open
   <http://localhost:3000/>. The development server proxies `/api` to the Go API.

[Back to top](#readme-top)

## Usage

On an installed host, run `x-ui` as root to open the management menu. Commands
also support routine administration:

```sh
x-ui status
x-ui restart
x-ui update
x-ui log
```

Use the CLI to inspect settings, manage accounts and check the installation:

```sh
x-ui-cli setting -show
x-ui-cli admin -list
x-ui-cli admin -username operator -password 'choose-a-strong-password'
x-ui-cli healthcheck
x-ui-cli node -check
x-ui-cli database -check
```

`healthcheck` checks the panel and database. `node -check` verifies configuration
sync and native statistics without generating proxy traffic. `x-ui-cli help`
lists the available commands.

Installed services read `/usr/local/x-ui/configs/config.yaml`. In a source
checkout, configuration comes from [configs/config.yaml](configs/config.yaml),
with `X_UI_*` environment variables taking precedence. Common settings include:

| Variable | Purpose |
| --- | --- |
| `X_UI_DATABASE_URL` | PostgreSQL connection URL; overrides individual database settings |
| `X_UI_DATABASE_PASSWORD` | Database password |
| `X_UI_SESSION_SECRET` | Stable secret for session cookies |
| `X_UI_ROOT_USERNAME`, `X_UI_ROOT_PASSWORD` | Create the first operator when no account exists |
| `X_UI_SERVER_PORT` | Panel port; defaults to `8000` |
| `X_UI_SERVER_TRUSTED_PROXIES` | Addresses of trusted reverse proxies |

Restart the services after editing their configuration. To serve HTTPS directly,
configure each listener's `cert_file` and `key_file`; certificates are issued and
renewed outside x-ui.

The API uses `/api` for browser sessions and `/apiv2` with a `Token` header for
scripts and nodes. Read [the OpenAPI specification](api/openapi.yaml),
[the node configuration example](configs/agent.yaml) and
[the architecture notes](docs/architecture.md) for further details.

[Back to top](#readme-top)

## Roadmap

Implemented capabilities:

- [x] PostgreSQL storage, migrations and account administration.
- [x] Web panel, subscriptions, traffic quotas and scheduled expiry.
- [x] Node synchronization and sing-box native statistics.
- [x] Linux release packaging, installation and upgrade recovery.

Track proposed work and known problems in the
[issue tracker](https://github.com/donaldturinglee/x-ui/issues).

[Back to top](#readme-top)

## Contributing

Use issues to discuss bugs and proposals. To submit a change:

1. Fork the repository.
2. Create a branch: `git checkout -b feature/feature-name`.
3. Make your changes and run the relevant checks:

   ```sh
   bash scripts/check.sh       # Go formatting, vet, tests and shell regression checks
   bash scripts/web.sh check   # frontend lint, types and unit tests
   bash scripts/web.sh e2e     # Playwright checks with a mocked API
   ```

4. Commit using the [Udacity Git style guide](https://udacity.github.io/git-styleguide/),
   for example: `git commit -m "fix: Restore installation checks"`.
5. Push your branch: `git push origin feature/feature-name`.
6. Open a pull request describing the change and how you verified it.

Run `bash scripts/help.sh` for the available maintenance scripts. Database
integration checks are available through `bash scripts/test-database.sh` and
require a PostgreSQL test host.

### Publishing a release

After committing and pushing `main`, use the release script at the repository root:

```sh
bash release.sh --dry-run
bash release.sh
bash release.sh v0.1.0
```

The checkout must be clean and match `origin/main`. Without an explicit version,
the script starts at `v0.0.1` or increments the latest remote stable patch version.
It pushes only the selected tag, which starts the GitHub Actions release workflow.
A failed push retains the local tag and prints a retry command.

For a local package build, install the frontend dependencies and run:

```sh
bash scripts/web.sh install
VERSION=v0.0.1 bash scripts/package.sh
```

[Back to top](#readme-top)

## Contributors

Thanks to everyone who has helped improve this project.

<a href="https://github.com/donaldturinglee/x-ui/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=donaldturinglee/x-ui" alt="x-ui contributors" />
</a>

[Back to top](#readme-top)

## Contact

<a href="https://github.com/donaldturinglee">
  <img src="https://github.com/donaldturinglee.png" alt="Donald Lee" width="64" height="64" />
</a>

<p>
  Donald Lee &middot; <a href="https://github.com/donaldturinglee">GitHub</a>
  <br />
  Project: <a href="https://github.com/donaldturinglee/x-ui">donaldturinglee/x-ui</a>
</p>

[Back to top](#readme-top)

## Acknowledgements

- [sing-box](https://github.com/SagerNet/sing-box) for the proxy core and statistics API.
- [The BASIC README template](https://github.com/donaldturinglee/awesome-readme/blob/main/templates/BASIC.md) for this document's structure.
- [Shields.io](https://shields.io/) for the repository badges.
- [contrib.rocks](https://contrib.rocks/) for the contributors image.

[Back to top](#readme-top)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for the terms.

[Back to top](#readme-top)

[contributors-shield]: https://img.shields.io/github/contributors/donaldturinglee/x-ui.svg?style=for-the-badge
[contributors-url]: https://github.com/donaldturinglee/x-ui/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/donaldturinglee/x-ui.svg?style=for-the-badge
[forks-url]: https://github.com/donaldturinglee/x-ui/network/members
[stars-shield]: https://img.shields.io/github/stars/donaldturinglee/x-ui.svg?style=for-the-badge
[stars-url]: https://github.com/donaldturinglee/x-ui/stargazers
[issues-shield]: https://img.shields.io/github/issues/donaldturinglee/x-ui.svg?style=for-the-badge
[issues-url]: https://github.com/donaldturinglee/x-ui/issues
[license-shield]: https://img.shields.io/github/license/donaldturinglee/x-ui.svg?style=for-the-badge
[license-url]: https://github.com/donaldturinglee/x-ui/blob/main/LICENSE
