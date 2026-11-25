# Linux test procedure

The development machine used for the Phase 2 audit has **no WSL distribution
and no Docker daemon**, so the POSIX assertions could not be executed here.
They are written as normal tests and are skipped/guarded on Windows. Use one
of the procedures below before a production release.

## 1. Automated suite on any Linux host

Requirements: Linux, Node.js >= 20, npm, tar, sha256sum. No root required.

```bash
git clone --depth 1 --branch <verified-tag> \
  https://github.com/Julien48003/nexus-bot-manager.git /tmp/nexus-test
cd /tmp/nexus-test
bash scripts/test-linux.sh
```

The script copies the working tree to a throwaway directory, excluding
`.git`, `backend/node_modules`, `backend/data` and `backend/.env`; runs
`npm ci --ignore-scripts` and `npm test`; then checks `bash -n` on every shell
script. It never touches a live installation.

What this proves on Linux (and cannot prove on Windows):

- database and data directory modes `0600` / `0700`;
- symlink containment, including a new file under a symlinked directory;
- TAR entry rejection and symlink rejection in update archives;
- ZIP path-traversal rejection and the symlink-attribute guard;
- the real boot smoke test (setup token, login, bot lifecycle, logout).

## 2. Full `update.sh` procedure on a disposable VM/LXC

Use a throwaway Debian 12/Ubuntu 24.04 VM. Do not use the production
instance for the first run.

1. Install a baseline release from a commit-verified tag in
   `/opt/nexus-test`, with `BOTS_ROOT=/opt/nexus-test-bots` and a test port.
2. Complete setup with the printed token, create a test bot, edit a file and
   verify `stat -c '%a'`:
   - `backend/.env` = `600`
   - `backend/data` = `700`
   - `backend/data/nexus.db.json` = `600`
   - `/opt/nexus-test-bots/<bot>/.env` = `600`
3. Clone the new target commit in `/tmp/nexus-new` and verify its commit SHA
   against the release notes.
4. Run the update with the new tree as source:

```bash
sudo env \
  INSTALL_DIR=/opt/nexus-test \
  NEXUS_UPDATE_SOURCE=/tmp/nexus-new \
  NEXUS_FROM_VERSION=<current> \
  NEXUS_TO_VERSION=<target> \
  PORT=<test-port> \
  NEXUS_PROGRESS_FILE=/tmp/nexus-update-progress.json \
  bash /tmp/nexus-new/scripts/update.sh --from-version <current>
```

5. Verify:
   - the service was **not stopped** if the new tree has a syntax error
     (deliberately break a copy first and confirm `pm2 status` still shows
     `online`);
   - `.env` content and data survive;
   - the test bot survives;
   - permissions remain `0600`/`0700`;
   - `curl -fsS http://127.0.0.1:<test-port>/api/health` returns 200;
   - the UI reports the new version.
6. Test the refusal paths:
   - `INSTALL_DIR=/` -> the script exits before any write;
   - a source tree with `../` or a symlink -> the update is refused;
   - a missing `PORT` or an invalid value -> the script exits.
7. Destroy the VM/LXC. Do not reuse test secrets.

## 3. Optional: install-script test

On a disposable VM with no Node.js installed:

```bash
# The script is root-only and installs system packages; use a throwaway VM.
VERSION=<tag> NEXUS_COMMIT_SHA=<40-hex> \
  sudo bash /tmp/nexus-test/scripts/install.sh
```

Verify:

- the pinned Node.js 24 archive is downloaded and its SHA-256 is checked;
- the tag resolves to the expected commit (or the script refuses);
- the backend `package.json` version equals the tag;
- `pm2` global version equals the lockfile (`7.1.2`) on a fresh install;
- `.env` is `600`, `backend/data` is `700`;
- the setup token is printed and the first setup requires it.

## 4. Phase 3 validation record

Executed on a disposable Debian 13.8 (trixie) LXC, x86_64, Node 24.22.3:

- `bash scripts/test-linux.sh`: **PASS**, 124/124 unit tests and 10/10 boot
  checks, including the POSIX permission, symlink, ZIP and TAR assertions.
- The TAR traversal fixture was corrected: GNU tar rewrites a normal
  `../` member during creation, so the test now forces a real `../` entry
  with `tar --transform`. This was a test-fixture bug, not a guard bug.
- `update.sh` was tested on an isolated install:
  - a tree with a deliberate syntax error is refused **before** the panel is
    stopped; the panel stayed healthy;
  - a valid tree updated successfully, preserved `.env`, data and bots, and
    restarted the panel.
  - The progress writer was fixed to pass `PROGRESS_FILE` in the environment
    (`PROGRESS_FILE=... node -e ...`), not as a script argument.
- Two isolated panels were tested with PM2 5.4.3 and PM2 7.1.2: setup, bot
  creation, editor write, start/restart/logs/stop, permissions, `pm2 save`
  and a real CT reboot followed by `pm2 resurrect` all worked. No PM2 API
  incompatibility was observed.
- A non-root `nexus` installation worked for panel and bot; `.env` was
  `0600`, data `0700`, DB `0600`, editor/logs/backup export worked, and a
  tested `Type=oneshot` systemd unit survived a real CT reboot.
- The PM2 5.4.3 generated non-root systemd unit fails because it expects
  `pm2.pid`; use the oneshot unit in `SECURITY-PRODUCTION.md`.

All test installs, `.env`/database files, PM2 homes, the `nexus` user and
temporary tokens were removed from the CT after the run.

## 5. Phase 5 validation record

### Executed in the Phase 5 working tree

On Windows 11 with Node.js 24.19, using isolated temporary directories and a
dedicated `PM2_HOME`:

- `npm test`: **140/140 unit tests**, including 11 ZIP extractor tests, the
  PM2 log-path test, the PM2 migration/non-root guards and the annotated-tag
  resolution tests; **10/10 boot checks**.
- PM2 **7.1.2** direct API lifecycle: connect, start, restart, describe,
  logs, stop, dump, delete, disconnect, resurrect and kill.
- Nexus `pm2.service.js` lifecycle against PM2 7.1.2: start, restart, logs,
  stop and remove.
- `npm audit --omit=dev`: **0 vulnerabilities**. A full audit (including dev
  dependencies) still reports 3 Nodemon-only advisories; they are not shipped.
- Release asset builder: `SHA256SUMS` generated and verified with
  `sha256sum -c` in a disposable output directory.

### Not executed in this session

The following checks require a disposable Linux host and, for the install
test, a published tag. They are **not** claimed as passed:

- PM2 7.1.2 as the non-root `nexus` user with systemd and a real CT reboot.
- A full `install.sh` run from a tag containing the Phase 5 changes. No such
  tag exists in this working tree and no release was published.
- `update.sh` end-to-end with PM2 7.1.2. The Phase 3 update record above used
  PM2 5.4.3.

The SSH test container used in Phase 3 is no longer reachable from this
session (key authentication refused), so the Linux run must be repeated by an
operator with access to a disposable VM/LXC.

### Procedure still required before production

1. Create a disposable Debian 13 VM/LXC and a `nexus` user with an independent
   `PM2_HOME`, data directory and bot root. Do not use production.
2. Install the working tree as `nexus` (or run the published installer on a
   test tag), run `npm ci --ignore-scripts`, and start the panel under
   `PM2_HOME=/var/lib/nexus/.pm2`.
3. Complete setup with the one-time token; create a bot, edit a file, start,
   restart and stop it, read its logs, export/import a backup, and verify
   `stat -c '%a'` is `600`/`700` on the documented paths.
4. Run `pm2 save`, reboot the CT, verify `pm2 resurrect` restored the panel
   and bot, then stop/start the systemd unit.
5. Run `update.sh` as `nexus` with `NEXUS_ALLOW_NONROOT=1`, a local source tree
   and a target version; verify ownership, data and health after the restart.
6. Run `bash scripts/test-linux.sh` and record the exact counts.

For the full install test from a tag, follow `docs/RELEASE.md`. It cannot be
run before a test tag exists; do not describe the working tree as a tested
release.

## 6. CI option

A future GitHub Actions workflow can run `bash scripts/test-linux.sh` on
`ubuntu-24.04` with Node 22 and Node 24. The full `update.sh` test still needs
a disposable VM/LXC because it stops PM2 and expects a root-owned
installation.
