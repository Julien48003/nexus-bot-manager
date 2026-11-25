# Production security guide

This document describes the recommended production posture for Nexus Bot
Manager. It is deliberately **not** applied automatically: the installer
still runs the panel under PM2 as root, because migrating an existing
installation to a dedicated user changes process ownership and PM2 state and
must be validated on a disposable instance first.

## 1. What is already enforced by the application

- `POST /api/auth/setup` requires a one-time bootstrap token printed at boot
  and stored in `backend/data/setup-token` (`0600`).
- JWT sessions are pinned to `HS256` + issuer/audience, revalidated against
  the database on every request and on every Socket.IO poll, revocable by
  `jti` or by `token_version` after a password change.
- Login failures are limited per IP and per account (including a global
  per-account counter for distributed attempts), with exponential back-off.
- All non-auth API routers require the `admin` role, including read routes
  that expose source code, `.env`, logs and backups.
- File paths are checked after resolving symlinks, including the existing
  prefix of a not-yet-created file; archive imports reject `../`, absolute
  paths, symlinks and decompression bombs.
- The database is written atomically, `fsync`-ed and `chmod 0600`; the data
  directory is created `0700`.
- A bot's `.env` is created/edited/imported with mode `0600`.
- The panel `.env` is generated `0600`, and `JWT_SECRET_FILE` can point to a
  separate `0400`/`0600` secret file instead of storing the key inline.
- `npm install` for the panel and bots uses `--ignore-scripts` and an
  allowlisted child environment without `JWT_SECRET`.

## 2. Recommended: run the panel and PM2 under a dedicated user

### 2.1 Prepare a disposable test instance first

Do this on a test VM/LXC with a copy of the data. Never test ownership
changes directly on the only production instance.

```bash
# as root
useradd --system --create-home --home-dir /var/lib/nexus --shell /usr/sbin/nologin nexus
install -d -o nexus -g nexus -m 0750 /var/lib/nexus
```

### 2.2 Stop the old root-owned PM2 instance and back up

```bash
pm2 save --force
pm2 stop nexus-bot-manager
cp -a /opt/nexus-bot-manager/backend/.env /root/nexus.env.bak
cp -a /opt/nexus-bot-manager/backend/data /root/nexus.data.bak
```

### 2.3 Give the service user only what it needs

```bash
chown -R nexus:nexus /opt/nexus-bot-manager
chown -R nexus:nexus /opt/<bot-name>        # repeat for every managed bot
chmod 600 /opt/<bot-name>/.env              # repeat
chmod 700 /opt/nexus-bot-manager/backend/data
```

Do not `chown -R nexus:nexus /opt`: `/opt` may contain unrelated software.
Keep the bot root (`BOTS_ROOT`) owned by the service user so the panel can
create/delete bot folders.

### 2.4 Start PM2 as the service user

```bash
sudo -u nexus env PM2_HOME=/var/lib/nexus/.pm2 \
  pm2 start /opt/nexus-bot-manager/backend/src/server.js \
  --name nexus-bot-manager \
  --cwd /opt/nexus-bot-manager/backend \
  --env production --max-restarts 5 --restart-delay 3000

sudo -u nexus env PM2_HOME=/var/lib/nexus/.pm2 pm2 save
```

PM2 7.1.2 now writes `pm2.pid`, so the generated systemd unit is more likely
to work than the old PM2 5.4.3 one. It has not yet been validated on a
non-root Linux host in this phase. The following `Type=oneshot` unit was
tested successfully with PM2 5.4.3 (stop/start and a real CT reboot), and
remains the conservative procedure until the PM2 7 non-root run is recorded:

```ini
[Unit]
Description=PM2 process manager for Nexus (non-root)
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=nexus
Group=nexus
WorkingDirectory=/var/lib/nexus
Environment=PM2_HOME=/var/lib/nexus/.pm2
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/pm2 resurrect
ExecReload=/usr/local/bin/pm2 reload all
ExecStop=/usr/local/bin/pm2 kill

[Install]
WantedBy=multi-user.target
```

Install it as `/etc/systemd/system/pm2-nexus.service`, then:

```bash
systemctl daemon-reload
systemctl enable --now pm2-nexus.service
systemctl is-active pm2-nexus.service
```

Then disable/remove the old root PM2 startup entry. Verify the service and
every bot are owned by `nexus`, and that `pm2 status` run as `nexus` lists
them.

### 2.5 Alternative: systemd for the panel

If the panel is moved from PM2 to systemd, keep PM2 only for bots. A
hardened unit should include at least:

```ini
[Service]
User=nexus
Group=nexus
WorkingDirectory=/opt/nexus-bot-manager/backend
EnvironmentFile=/opt/nexus-bot-manager/backend/.env
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/nexus-bot-manager/backend/data /opt
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
```

`ReadWritePaths` must include the bot root because the panel manages bot
folders. Do not copy this unit blindly: adjust paths and test on a copy.

### 2.6 Updates after the migration

For a non-root installation, run updates as `nexus`, not as root. Running
`update.sh` as root on a `nexus`-owned tree would copy root-owned files into
the install and break the next panel start.

The panel does this automatically: when its process is unprivileged, it sets
`NEXUS_ALLOW_NONROOT=1` for `update.sh`. For a manual update:

```bash
sudo -u nexus env \
  PM2_HOME=/var/lib/nexus/.pm2 \
  INSTALL_DIR=/opt/nexus-bot-manager \
  NEXUS_ALLOW_NONROOT=1 \
  NEXUS_UPDATE_SOURCE=/tmp/nexus-new \
  NEXUS_FROM_VERSION=<current> \
  NEXUS_TO_VERSION=<target> \
  bash /tmp/nexus-new/scripts/update.sh --from-version <current>
```

Before updating, back up `backend/.env`, `backend/data/` and the bot root as
`nexus`. Verify after the update that files are still owned by `nexus`, the
database is `0600`, the data directory is `0700`, and `pm2 status` (with the
same `PM2_HOME`) shows the panel and bots online. There is no automatic
rollback; keep the previous tree and data until the new version is verified.

PM2 logs live under `PM2_HOME/logs`, not necessarily `~/.pm2/logs`. The panel
now honours `PM2_HOME` when reading bot logs; command-line operators must set
the same variable.

### 2.7 One-time migration from PM2 5 to PM2 7

The Phase 5 lock requires PM2 7.1.2. `update.sh` refuses a cross-version
update before stopping the panel, so the daemon migration must be done
deliberately. Keep a full backup and a maintenance window.

For a root installation:

```bash
pm2 save
pm2 stop nexus-bot-manager
pm2 kill
npm install -g pm2@7.1.2 --ignore-scripts
pm2 resurrect                 # restore the panel and bots under the new daemon
pm2 status
sudo env \
  INSTALL_DIR=/opt/nexus-bot-manager \
  NEXUS_UPDATE_SOURCE=/tmp/nexus-new \
  NEXUS_FROM_VERSION=<current> \
  NEXUS_TO_VERSION=<target> \
  bash /tmp/nexus-new/scripts/update.sh --from-version <current>
```

For a non-root installation:

```bash
sudo -u nexus env PM2_HOME=/var/lib/nexus/.pm2 pm2 save
sudo -u nexus env PM2_HOME=/var/lib/nexus/.pm2 pm2 stop nexus-bot-manager
sudo -u nexus env PM2_HOME=/var/lib/nexus/.pm2 pm2 kill
# install pm2@7.1.2 globally as an administrator, then:
sudo -u nexus env PM2_HOME=/var/lib/nexus/.pm2 pm2 resurrect
sudo -u nexus env PM2_HOME=/var/lib/nexus/.pm2 pm2 status
sudo -u nexus env \
  PM2_HOME=/var/lib/nexus/.pm2 \
  INSTALL_DIR=/opt/nexus-bot-manager \
  NEXUS_ALLOW_NONROOT=1 \
  NEXUS_UPDATE_SOURCE=/tmp/nexus-new \
  NEXUS_FROM_VERSION=<current> \
  NEXUS_TO_VERSION=<target> \
  bash /tmp/nexus-new/scripts/update.sh --from-version <current>
```

The update script checks the global PM2 version against the incoming
`package-lock.json` before stopping anything. A mismatch is an error, not a
warning. After the migration, verify `pm2 status`, the panel health endpoint,
the bot lifecycle, `pm2 save` and a controlled `pm2 kill`/`resurrect` on the
test instance. Roll back by restoring the previous tree, `backend/data` and
`backend/.env`, reinstalling the previous global PM2, and starting the panel.

## 3. Stronger bot isolation (optional, requires a migration)

Running bots as the same user as the panel gives a compromised bot access to
the panel's `.env` and database. For stronger isolation:

- create one system user per bot (or one shared `bots` user, which is weaker);
- make each bot directory owned by that user, mode `0700`;
- start each bot with `setpriv`/`runuser` or a per-bot systemd unit;
- do not give bot users write access to the panel directory;
- keep each bot's token in its own `.env`, `0600`, owned by the bot user.

PM2 can switch `uid`/`gid` when started as root, but that keeps a root PM2
daemon and a root-owned process manager. A systemd unit per bot is easier to
audit, at the cost of managing more units.

Recommended isolation levels, from weakest to strongest:

1. **Current default**: one `nexus` user for the panel and every bot. Simple,
   but a compromised bot can read the panel `.env`, `backend/data` and every
   other bot `.env`.
2. **Shared bot user**: panel under a different user from bots, with separate
   PM2 homes. Better blast-radius separation, but bots can still read each
   other's tokens.
3. **One user per bot**: separate system users, directories, `.env` and
   systemd units. This is the only level that meaningfully isolates Discord
   tokens and bot code from another bot. It requires a migration tool for
   existing bots.

Whatever option is chosen, plan a migration and keep a rollback: stop the old
bot, copy its directory with ownership, start it as the new user, verify logs,
then remove the old PM2 entry. Do not grant bot users write access to the
panel directory, and do not put tokens in unit files.

The panel still reads every bot directory, so per-bot users must be combined
with a privileged, narrowly scoped helper (or a panel running as a user that
can read those directories) to keep editing and logs working. A true
multi-user design is a larger change than this phase.

## 4. Secrets

- Prefer `JWT_SECRET_FILE=/etc/nexus/jwt.secret` with mode `0400`, owned by
  the service user. The service refuses a file readable by group/other.
- Rotate `JWT_SECRET` by replacing the file and restarting. This revokes all
  sessions (all tokens fail verification).
- Rotate the admin password from the UI after any suspected exposure; it
  revokes all sessions.
- Bot Discord tokens are stored in each bot's `.env` (`0600`). Do not put
  them in unit files, shell history or the panel's `.env`.
- Back up `backend/data/` and bot `.env` files encrypted; they contain
  credentials.
- Never commit `backend/.env`, `backend/data/` or bot folders.

## 5. Network and reverse proxy

- Use a TLS-terminating reverse proxy (Caddy, nginx, Traefik) and keep the
  panel on `HOST=127.0.0.1` unless direct LAN access is intentional.
- Set `TRUST_PROXY=1` only when a reverse proxy is in front; otherwise a
  client can forge `X-Forwarded-For` and weaken rate limiting.
- If the panel is served from a different origin, list it in
  `CORS_ORIGIN`; otherwise keep same-origin.
- Restrict the panel port to the proxy/management network; do not expose
  the PM2/Node port to the Internet.
- Keep the CSP enabled. If a legacy browser/tool breaks, use
  `CSP_ENABLED=false` temporarily and investigate; do not leave it off.

## 6. Backups, updates and monitoring

- Back up `backend/data/nexus.db.json`, `backend/.env` and bot folders before
  every update. The updater also keeps three `.env` backups under
  `data/backups`, but that is not a full backup.
- Publish the SHA-256 of each release tarball as a `SOURCE_SHA256` asset on
  the release, or pin it in `backend/release-digests.json`; otherwise the
  panel refuses unverified updates by design. A local pin takes precedence.
- Install from a commit-verified tag, not from a floating branch.
- GitHub imports are cloned from a public repository and their dependencies
  are installed with `--ignore-scripts`; review the code before starting the
  bot for the first time. The Discord token is written to the bot's `.env`
  (mode 0600), never executed as part of the import.
- Monitor failed logins, `login_failed` activity, PM2 restarts and disk use.
- Keep Node.js on a supported LTS (22/24). Node.js 20 is EOL; the installer
  installs a checksummed Node.js 24 LTS when no supported Node is present.

## 7. Dependency status

The Phase 5 lock uses:

- `pm2` 7.1.2, with `js-yaml` 4.3.2 and without the former
  `@pm2/agent`/`proxy-agent`/`basic-ftp` chain;
- `yauzl` 3.4.0 for streaming ZIP import extraction;
- no `extract-zip`.

`npm audit --omit=dev` reports **0 vulnerabilities** on the locked production
tree. A full `npm audit` (including dev dependencies) still reports 3
advisories in `nodemon`'s `minimatch`/`brace-expansion` tree; those packages
are development-only and are not installed in production. Upgrade Nodemon
when a compatible release fixes them. Do not run `npm audit fix --force`: it
can replace a pinned major version without the Linux staging test. If a future
advisory appears, review its reachability in this application before applying
a broad fix.

The PM2 7.1.2 API lifecycle was exercised on an isolated Windows PM2 home
(connect, start, restart, logs, stop, dump, delete, resurrect, kill). The
non-root Linux systemd/reboot path still needs to be recorded on a disposable
host before it is presented as validated.

## 8. Residual risks that code cannot remove

- The panel runs as root until the migration above is performed.
- Bots running as the same user as the panel can read the panel's secrets.
- A residual XSS could still act as the admin during the session; the token
  is in `localStorage` (SEC-04) and is not an `httpOnly` cookie.
- Monaco is served locally from `node_modules`. Tabler and Google Fonts still
  come from CDNs and are not SRI-pinned; the CSP allows only their exact HTTPS
  origins. Serving those assets locally is the long-term fix. The editor
  workers are same-origin and no longer depend on a cross-origin CDN.
- ZIP import is bounded and rejects symlinks/special entries, but a bug in
  the extractor remains a high-impact path; keep the archive parser patched
  and keep the unit tests in `backend/test/archive.test.js` passing.
- HTTP deployments without TLS expose the Bearer token on the wire.
