# Release checklist

This document prepares a release. It does not tag, commit or publish anything.
Nexus Bot Manager must not be announced as released until every mandatory check
below has passed on a disposable Linux host.

## 1. Status of the release working tree

Run this checklist from the exact tag being released. A version is not a
tested release until every mandatory check below has passed on a disposable
Linux host; do not describe the working tree as a tested release before then.

The checks that can run without a tag are:

```bash
cd backend
npm ci --ignore-scripts
npm test
npm run check
npm run audit:handlers
npm audit --omit=dev
```

The archive and PM2 service unit tests are part of `npm test`. Linux-only
checks still need a disposable VM/LXC; see `docs/LINUX-TESTING.md`.

## 2. Choose and commit the version

Set a new version in `backend/package.json` (and refresh the lockfile with
`npm install --package-lock-only --ignore-scripts` if needed). The version in
that file is the single source of truth used by the panel and the installer.

Do this only after the full test matrix has passed. Then commit the release
content and create the tag with the normal Git process. This repository's
automation never commits or tags.

Use a **lightweight** tag (`git tag v<version>`, without `-a`) for releases
that must be installable by versions 1.1.5 and older. Those versions resolve
`git/ref/tags/<tag>` directly and fail on an annotated tag object. Version
1.1.7 and newer follow annotated tag objects correctly, but lightweight tags
remain the safest choice for a one-step upgrade from 1.1.5.

## 3. Build the script assets

```bash
bash scripts/build-release-assets.sh <version> dist/v<version>
```

The builder copies the exact scripts from the working tree and writes
`SHA256SUMS`. Its output directory must be treated as a staging directory, not
as a published release.

Verify the assets independently:

```bash
cd dist/v<version>
sha256sum -c SHA256SUMS
ls -l install.sh update.sh uninstall.sh SHA256SUMS
```

The release must attach the files listed by `SHA256SUMS`. If the release notes
only advertise `install.sh`, `update.sh` and `SHA256SUMS`, either attach
`uninstall.sh` too or adjust the builder and the notes together. Never publish
a hash for a file that is not attached, and never attach a file whose hash is
not listed.

## 4. Pin the source digest

The panel verifies the SHA-256 of the GitHub source tarball before applying an
update. Generate the value from the exact published tag, then commit it to
`backend/release-digests.json`:

```bash
VERSION=<version>
curl -fsSL -o "/tmp/nexus-v${VERSION}.tar.gz" \
  "https://api.github.com/repos/Julien48003/nexus-bot-manager/tarball/v${VERSION}"
sha256sum "/tmp/nexus-v${VERSION}.tar.gz"
```

Add only the hexadecimal digest, in a reviewed commit. Do not copy a digest
from an unreviewed source and do not publish an empty or placeholder value.
`scripts/build-release-assets.sh` does not create source digests.

## 5. Full installation test from the published tag

Use a disposable Debian/Ubuntu VM or LXC. Do not use production.

1. Download `install.sh` and `SHA256SUMS` from the release and verify the
   script hash before running it.
2. Clone the tag and verify its commit SHA against the release notes.
3. Run the installer with a test port and test directories:

```bash
VERSION=<version>
COMMIT=<40-hex from the release notes>
INSTALL_DIR=/opt/nexus-test
BOTS_ROOT=/opt/nexus-test-bots
PORT=3101
sudo env VERSION="${VERSION}" NEXUS_COMMIT_SHA="${COMMIT}" \
  INSTALL_DIR="${INSTALL_DIR}" BOTS_ROOT="${BOTS_ROOT}" PORT="${PORT}" \
  bash /tmp/nexus-install/scripts/install.sh
```

4. Verify:

- the pinned Node.js archive hash is checked;
- the tag resolves to the expected commit;
- `backend/package.json` version equals the tag;
- the global PM2 version equals `7.1.2`;
- `backend/.env` is `0600`, `backend/data` is `0700`;
- the setup token is printed and the first setup requires it;
- an administrator can log in;
- a bot can be created, edited and started;
- `pm2 save` records it and `pm2 resurrect` restores it after stopping the
  daemon;
- a real CT/VM reboot brings the panel and bot back if auto-start is enabled.

5. Create a bot, edit a file, export a backup and import it under a new name.
6. Stop and remove the test installation and its user/PM2 home. Do not reuse
   the test secrets.

If no tag exists, this test is impossible and must remain marked as **not
executed**. Creating a tag in a fork and testing there is acceptable only when
the script and source tree are byte-identical to the intended release; document
the fork and commit used.

## 6. Update test

Use the procedure in `docs/LINUX-TESTING.md` with a local source tree. Verify:

- a syntactically broken source tree is refused before the service stops;
- a valid tree updates the panel and preserves `.env`, data and bots;
- the digest check refuses an archive with no pinned digest;
- permissions remain `0600`/`0700`;
- `/api/health` returns 200 after the restart.

Repeat the test with PM2 7.1.2 because the release changes the PM2 major
version. The one-time daemon migration procedure is in
`docs/SECURITY-PRODUCTION.md` section 2.7. `update.sh` refuses a mismatch
between the global PM2 and the incoming lockfile before it stops the panel.

## 7. Non-root validation

Before offering non-root as the default production posture, run the procedure
in `docs/SECURITY-PRODUCTION.md` on a disposable host with a dedicated `nexus`
user and an independent `PM2_HOME`. The Phase 5 tree prepares this procedure
but the PM2 7.1.2 non-root + systemd + reboot combination has not been executed
in this session.

## 8. Publish only after validation

A release is ready only when:

- the full test suite and `npm audit --omit=dev` are clean;
- the source digest is pinned and reviewed;
- the assets pass `sha256sum -c`;
- a full install from the published tag succeeds;
- an update from the previous version succeeds and preserves data;
- non-root PM2 7.1.2 validation is recorded, or the release notes explicitly
  retain the root installation as the supported default.

Do not publish an official release from this working tree as-is.
