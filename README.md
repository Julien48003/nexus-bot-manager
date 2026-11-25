# Nexus Bot Manager

Nexus Bot Manager is a self-hosted web panel for creating, editing, running and monitoring Node.js Discord bots. It manages bots through PM2, provides a browser-based file editor, and exposes system, backup and update operations from one interface.

The application is intended for a single administrative account on a private or reverse-proxied Linux host. It stores its data in a JSON file and keeps bot files under a configurable directory.

## Features

- Create bots from nine Discord.js templates, from a minimal starter to slash commands, tickets and moderation.
- Import an existing bot from a public GitHub repository; dependencies are installed without lifecycle scripts.
- Start, stop, restart and remove bots through PM2.
- View PM2 status, CPU, memory, uptime, restart count and logs.
- Edit bot files with Monaco, including per-file tabs and syntax highlighting.
- Open a Drive-style file manager: grid/list views, breadcrumbs, drag & drop from the OS or between folders, uploads, downloads (including folder ZIP), rename and delete.
- Customize each bot: display name, logo, startup file, memory limit, scheduled restart and start-on-boot.
- Edit `.env` variables from a masked key/value editor, and reinstall dependencies in one click.
- Install and remove npm packages per bot.
- Export and import bot backups as ZIP archives.
- Configure instance name, theme, language and monitoring options.
- Check for application updates and apply verified releases.
- Authenticate with JWT sessions and a one-time setup token.
- Use English, French or German in the interface.

## Requirements

- Linux (Debian 11/12/13 or Ubuntu 22.04/24.04 for the supplied installer).
- Node.js 20 or newer. Node.js 22 or 24 is recommended; Node.js 20 is end-of-life.
- npm.
- PM2.
- `git`, `curl`, `rsync`, `tar` and standard build tools for installation.
- A writable bot root directory. The default is `/opt`.

The installer installs a pinned Node.js 24.22.3 archive when a supported Node.js is not already present. It installs PM2 7.1.2 to match the dependency lock. The application does not require a database server.

## Technologies

- Node.js and Express 4
- Socket.IO for live logs and PM2 status
- PM2 for process management
- JSON file storage
- JWT (`jsonwebtoken`) and `bcryptjs`
- `archiver` for backup export and `yauzl` for bounded, streaming import extraction
- `systeminformation` for host metrics
- Vanilla JavaScript frontend with locally served Monaco and Tabler Icons
- Tests use the Node.js test runner

## Installation

Install from a pinned release tag and verify the commit before running the installer. Replace the placeholders with the version and commit published in the release notes.

```bash
VERSION=<version>
COMMIT=<40-hex commit from the release notes>

git clone --depth 1 --branch "v${VERSION}" \
  https://github.com/Julien48003/nexus-bot-manager.git /tmp/nexus-install
cd /tmp/nexus-install
test "$(git rev-parse HEAD)" = "${COMMIT}" || { echo "Commit mismatch"; exit 1; }

sudo env VERSION="${VERSION}" NEXUS_COMMIT_SHA="${COMMIT}" \
  bash scripts/install.sh
```

The installer:

- installs the required system packages;
- installs the pinned Node.js archive and verifies its SHA-256;
- installs PM2 7.1.2;
- downloads the selected release and verifies its tag, commit and package version;
- installs dependencies with `npm ci --ignore-scripts`;
- creates `backend/.env` with a random JWT secret and mode `0600`;
- creates `backend/data` with mode `0700`;
- registers and starts the `nexus-bot-manager` PM2 process.

If release assets are published, `install.sh` and `SHA256SUMS` can be downloaded and verified instead. Maintainers can generate those assets with:

```bash
bash scripts/build-release-assets.sh <version>
```

The installer runs as root by default. A non-root deployment procedure is described in [docs/SECURITY-PRODUCTION.md](docs/SECURITY-PRODUCTION.md).

## Initial configuration

After installation, open the panel at `http://<host>:3001` (or the configured `PORT`).

On first start, the server prints a one-time setup token in its console and writes the same token to:

```text
backend/data/setup-token
```

The file is mode `0600`. Paste the token into the setup wizard. The token is deleted after a successful setup. The wizard creates the first administrator account; passwords must be between 8 and 72 bytes.

If the setup token is no longer available in the console, read `backend/data/setup-token` as the service user. If the file is missing while setup is not complete, restart the service and read the new token from the startup log.

Optional secret-file support:

```env
JWT_SECRET_FILE=/etc/nexus/jwt.secret
```

The file must be a regular file with mode `0400` or `0600`. When set and `JWT_SECRET` is empty, the server reads the signing key from the file.

## Start, stop and logs

The installer registers the process as `nexus-bot-manager`:

```bash
pm2 status nexus-bot-manager
pm2 logs nexus-bot-manager
pm2 restart nexus-bot-manager
pm2 stop nexus-bot-manager
```

To restore the saved PM2 process list after a reboot:

```bash
pm2 resurrect
```

The installer's root startup step uses `pm2 startup systemd`. For a non-root service, use the tested `Type=oneshot` unit in [docs/SECURITY-PRODUCTION.md](docs/SECURITY-PRODUCTION.md). PM2 7.1.2 writes `pm2.pid`, so its generated unit may also work, but the oneshot unit remains the documented and previously tested procedure until a non-root PM2 7 systemd run is recorded.

## Bot management

The sidebar provides these pages:

- **Dashboard**: host metrics, bot status and recent activity.
- **My Bots**: bot list with start, stop, restart, logs, editor and delete actions.
- **New Bot**: create a bot from a template, a Discord token and optional npm packages.
- **Templates**: browse the nine built-in templates.
- **Editor**: Monaco-based file editor and file tree.
- **Logs & Errors**: PM2 stdout/stderr with diagnostic hints.
- **npm Dependencies**: inspect, install and remove packages.
- **Backups**: export and import bot archives.
- **Settings**: instance, theme, language, monitoring and account settings.
- **Help**: quick start and troubleshooting notes.

A bot is created under `BOTS_ROOT/<bot-name>` with `index.js`, `package.json` and a `.env` file. The bot `.env` contains the Discord token and is mode `0600`. The panel writes and manages this file; it is not stored in the application database.

Bot processes are named after the bot in PM2. The PM2 process list is the source of truth for running state; the panel reconciles it with the bot list on load.

## Project structure

```text
backend/
  src/
    server.js                 HTTP, Socket.IO, startup validation
    db/                       JSON data store
    middleware/               authentication, security headers, path checks
    routes/                   auth, bots, files, backups, system, update
    services/                 PM2, filesystem, bot host/autostart, ZIP extraction, templates, updates, versions
  test/                       security, functional and boot tests
  scripts/                    syntax and inline-handler checks
  .env.example                environment template
  package.json
  package-lock.json
frontend/
  public/
    index.html
    js/                       API client, application, editor, Drive file manager, i18n, theme
    css/                      application styles
    translations/             English, French and German strings
    assets/                   logos and icons
scripts/
  install.sh                  production installer
  update.sh                   verified update procedure
  uninstall.sh                guarded uninstall
  dev-install.sh              development installer
  test-linux.sh               Linux test helper
  build-release-assets.sh     release asset generation
  build-source-digest.sh      SOURCE_SHA256 generation for a release
docs/
  SECURITY-PRODUCTION.md      deployment and privilege guidance
  LINUX-TESTING.md            Linux test procedure and phase records
  RELEASE.md                  release checklist and test-tag procedure
backend/release-digests.json  pinned release SHA-256 values
```

## Environment variables

The application reads `backend/.env`. The template is [backend/.env.example](backend/.env.example).

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | HTTP port. |
| `NODE_ENV` | No | `production` | Node environment. |
| `HOST` | No | `0.0.0.0` | Listen address. Set `127.0.0.1` behind a local reverse proxy. |
| `JWT_SECRET` | Yes | none | JWT signing secret. At least 32 bytes; a 128-character hex value is recommended. |
| `JWT_EXPIRES_IN` | No | `24h` | Session lifetime. |
| `JWT_SECRET_FILE` | No | none | Read the signing secret from a `0400`/`0600` file instead of `JWT_SECRET`. |
| `CORS_ORIGIN` | No | same-origin | Comma-separated extra origins allowed to call the API. |
| `TRUST_PROXY` | No | off | Set to `1` only when the panel is behind a reverse proxy. |
| `NEXUS_UPDATE_ALLOW_UNVERIFIED` | No | off | Set to `1` to allow updates without a pinned digest. Not recommended. |
| `CSP_ENABLED` | No | `true` | Set to `false` only to disable the Content Security Policy. |
| `BOTS_ROOT` | No | `/opt` | Absolute POSIX path where bot folders are created. |
| `INSTANCE_NAME` | No | `Nexus Bot Manager` | Display name shown in the interface. |

Generate a signing secret with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Do not commit `backend/.env`, `backend/data/`, bot `.env` files or bot folders to version control.

## Backups and restore

Bot backups are ZIP archives managed from the **Backups** page.

- Export creates an archive of the bot directory, including source, `package.json`, assets and `.env`.
- Import accepts a ZIP up to 200 MB compressed and creates a bot from its top-level directory.
- Imported archives are validated before extraction: absolute paths, `..` entries, symbolic links and oversized decompression are refused.
- Imported bot `.env` files are set to mode `0600`.

Store backups outside the server and treat them as credentials because they contain Discord tokens. The application keeps the imported archive only during the request and removes the temporary files afterwards.

## Updates

The preferred update path is **Settings > Software** in the panel. The panel:

1. resolves the release tag to an immutable commit;
2. downloads the release archive by commit SHA;
3. verifies its SHA-256 against `backend/release-digests.json` or the
   `SOURCE_SHA256` asset attached to the GitHub Release;
4. refuses the update if neither digest is available;
5. stops the service, applies the tree, installs dependencies with `npm ci --ignore-scripts`, restarts PM2 and checks `/api/health`.

A local pin in `backend/release-digests.json` is the stronger, reviewed value
and takes precedence. When it is absent, the panel reads the `SOURCE_SHA256`
asset published with the release, so a normal update does not require editing
a file on the server.

To publish the asset for a release:

```bash
bash scripts/build-source-digest.sh v<VERSION>
```

Attach the generated `SOURCE_SHA256` file to the GitHub Release. Maintainers
who want the strongest guarantee can also compute the digest and add it to
`backend/release-digests.json` in a reviewed commit.

For a self-hosted fork that does not publish releases, `NEXUS_UPDATE_ALLOW_UNVERIFIED=1` permits an unverified update with a warning in the log. Do not enable it on an Internet-facing instance.

The command-line path is `scripts/update.sh`; the procedure and tested failure cases are described in [docs/LINUX-TESTING.md](docs/LINUX-TESTING.md). Running `update.sh` by hand skips the panel's digest check and activity log; prefer the web interface.

The updater preserves `backend/.env`, `backend/data/` and `node_modules/`. It validates the new backend syntax before stopping the service. There is no automatic rollback; keep a backup of `backend/.env`, `backend/data/` and the bot root before applying an update.

## Release preparation

The release process is:

1. choose the version in `backend/package.json` and commit it;
2. run `npm ci --ignore-scripts`, `npm test`, `npm run audit:handlers` and `npm audit --omit=dev`;
3. build the script assets with `bash scripts/build-release-assets.sh <version> dist/v<version>`;
4. verify `SHA256SUMS` before attaching the assets to the GitHub Release;
5. generate the source digest with `bash scripts/build-source-digest.sh <version>` and attach `SOURCE_SHA256` to the release; optionally add the same value to `backend/release-digests.json` as a reviewed local pin;
6. test a full install and an update on a disposable Linux host before announcing the release.

The asset builder never tags, commits or publishes anything. See [docs/RELEASE.md](docs/RELEASE.md) for the full checklist and the test-tag procedure.

## Security and permissions

The application applies the following controls:

- a one-time setup token for the first administrator account;
- JWT verification pinned to `HS256`, issuer and audience;
- server-side session revalidation against the database on every request and Socket.IO poll;
- token revocation on logout and password change;
- per-IP and per-account login lockouts with exponential back-off;
- admin-only access to data routes, including file, log and backup reads;
- same-origin CORS by default and an `Origin` check on state-changing requests;
- path containment checks that resolve symbolic links, including for new files;
- a Content Security Policy, `X-Content-Type-Options`, `Referrer-Policy: no-referrer` and `X-Frame-Options`;
- `backend/.env` mode `0600`, `backend/data` mode `0700`, database mode `0600` and bot `.env` mode `0600`;
- `npm install --ignore-scripts` for panel and bot dependencies;
- a child-process environment allowlist that excludes `JWT_SECRET`;
- pinned update digests and release commit verification;
- a bounded, symlink-rejecting ZIP extractor for backup imports.

The locked production dependency tree is audited with `npm audit --omit=dev`; PM2 7.1.2 and yauzl 3.4.0 replace the previously vulnerable PM2 5 and extract-zip paths.

The panel does not provide multi-user roles, MFA, an HTTP-only session cookie or built-in TLS. Run it behind a TLS reverse proxy, restrict the listening address, and follow [docs/SECURITY-PRODUCTION.md](docs/SECURITY-PRODUCTION.md) before exposing it to a network. The default installation runs PM2 and bots as root; that is documented as a migration target, not a permanent security boundary.

For non-root operation, use a dedicated user, a separate `PM2_HOME`, correct ownership of the install and bot roots, and a tested systemd unit. Bots running as the same user as the panel can read the panel's `.env` and database; use per-bot users or isolated units where that risk is unacceptable.

## Development and tests

From `backend/`:

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run audit:handlers
npm audit --omit=dev
```

`npm test` runs the syntax check, the security and functional suites, and a boot smoke test. On Linux, `bash scripts/test-linux.sh` runs the suite in a disposable copy of the working tree and exercises the POSIX permission, symlink and archive tests. See [docs/LINUX-TESTING.md](docs/LINUX-TESTING.md).

For local development:

```bash
cd backend
npm run dev
```

`npm run dev` uses nodemon and does not configure PM2 or the production frontend. The production process is started through PM2 by the installer.

## Troubleshooting

### The service exits with `[FATAL] JWT_SECRET`

`JWT_SECRET` is missing, too short, too repetitive or still a published placeholder. Generate a new secret, set it in `backend/.env` or `JWT_SECRET_FILE`, and restart the service.

### The setup page asks for a token

The token is printed in the service console at startup and stored in `backend/data/setup-token` with mode `0600`. Read it as the service user. If setup already completed, the endpoint returns `409`.

### The panel is unreachable

Check `pm2 status`, then `pm2 logs nexus-bot-manager`. Verify `PORT` and `HOST` in `backend/.env`, the reverse proxy target and the local firewall. Do not expose the Node.js port directly to the Internet.

### Login fails after an upgrade

Tokens issued before the JWT issuer/audience hardening are intentionally rejected. Log in again. A password change revokes all sessions.

### An update is refused

The target version has neither a local SHA-256 pin in `backend/release-digests.json` nor a `SOURCE_SHA256` asset on its GitHub Release. Publish the asset with `bash scripts/build-source-digest.sh <version>`, or add a reviewed local pin. For a non-published fork, use the explicit `NEXUS_UPDATE_ALLOW_UNVERIFIED=1` override only after reviewing the source.

### File or bot access is denied

Check that the service user owns the install directory, `backend/data`, `BOTS_ROOT` and bot directories. The panel refuses symlinks that leave a bot directory and refuses file names containing `..`, quotes or control characters.

### Backup import fails

The archive must be a ZIP up to 200 MB compressed, contain one top-level bot directory, and must not contain absolute paths, `..` entries or symbolic links. The uncompressed limit is 1 GB.

### CORS or Origin errors

The default policy is same-origin. If a reverse proxy rewrites the origin, add the public origin to `CORS_ORIGIN`. Set `TRUST_PROXY=1` only when the proxy is trusted.

## Documentation

- [Production security guide](docs/SECURITY-PRODUCTION.md)
- [Linux test procedure and phase results](docs/LINUX-TESTING.md)
- [Release checklist](docs/RELEASE.md)
- [Environment template](backend/.env.example)
- [Pinned release digests](backend/release-digests.json)

The project currently has no license file. Do not assume a license for redistribution; contact the maintainer for terms.
