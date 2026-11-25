'use strict';
/**
 * End-to-end smoke test: start the real server the way `npm start` does,
 * against a throwaway install, and walk the operator's first-run journey:
 * boot -> read the setup token from the console banner -> setup wizard ->
 * login -> use the panel -> logout.
 *
 * Complements the in-process suite: that one requires the app module, this
 * one exercises the actual process boot, the banner and the data directory
 * creation.
 */
const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const assert = require('node:assert');

const BACKEND = path.join(__dirname, '..');
const root    = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-boot-'));
const bots    = path.join(root, 'opt');
const data    = path.join(root, 'data');
fs.mkdirSync(bots, { recursive: true });
fs.mkdirSync(data,  { recursive: true });

// A real secret, as the installer writes it: 128 hex characters.
const JWT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' +
            '1a2b3c4d5e6f708192a3b4c5d6e7f809' +
            '0f1e2d3c4b5a69788796a5b4c3d2e1f0' +
            'deadbeefcafebabe0123456789abcdef';

// Do NOT write backend/.env from a test: this repository may contain a real
// one. dotenv never overrides variables already present in the environment,
// so passing them to the child gives it the same configuration safely.
const PORT = 34517;

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: BACKEND,
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'production',
    JWT_SECRET: JWT,
    JWT_EXPIRES_IN: '1h',
    BOTS_ROOT: bots,
    NEXUS_DATA_DIR: data
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => { out += d.toString(); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep 	(200);
  }
  throw new Error(`timeout waiting for ${label}\n--- output ---\n${out}`);
}

function api(method, endpoint, { token, body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

const results = [];
function check(name, fn) {
  return (async () => {
    try { await fn(); results.push(['PASS', name]); }
    catch (e) { results.push(['FAIL', `${name} :: ${e.message}`]); }
  })();
}

(async () => {
  try {
    // 1. The process must start, print its banner, and create its data dir.
    await waitFor(() => out.includes('Nexus Bot Manager v'), 'startup banner');
    await check('the process starts and prints its banner', () => {
      assert.ok(out.includes('Nexus Bot Manager v'), 'banner missing');
      assert.ok(out.includes('CONFIGURATION INITIALE REQUISE'),
        'the setup banner should be shown on a fresh instance');
    });

    // 2. The one-time setup token must be printed AND written 0600.
    let setupToken = null;
    await check('a one-time setup token is generated and printed', () => {
      const m = out.match(/Jeton de configuration[\s\S]*?-\s+([0-9a-f]{64})\s*\n/);
      assert.ok(m, 'the token must be printed in the banner:\n' + out);
      setupToken = m[1];
      const tokenFile = path.join(data, 'setup-token');
      assert.ok(fs.existsSync(tokenFile), 'data/setup-token must exist');
      assert.strictEqual(fs.readFileSync(tokenFile, 'utf8').trim(), setupToken);
    });

    // 3. Setup must be refused without the token, and accepted with it.
    let token = null;
    await check('setup is refused without the bootstrap token', async () => {
      const res = await api('POST', '/api/auth/setup', {
        body: { username: 'attacker', password: 'Attacker123' }
      });
      assert.strictEqual(res.status, 401);
    });

    await check('setup succeeds with the bootstrap token and returns a session', async () => {
      const res = await api('POST', '/api/auth/setup', {
        body: { instance_name: 'Boot Test', username: 'admin', password: 'Str0ngPassw0rd', language: 'en' },
        headers: { 'X-Setup-Token': setupToken }
      });
      assert.strictEqual(res.status, 200, await res.clone().text());
      const body = await res.json();
      assert.ok(body.token);
      token = body.token;
      assert.strictEqual(body.username, 'admin');
    });

    await check('the setup token is deleted after a successful setup', () => {
      assert.ok(!fs.existsSync(path.join(data, 'setup-token')), 'the token must be single-use');
    });

    // 4. The real login flow.
    await check('login works and the session is usable', async () => {
      const res = await api('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'Str0ngPassw0rd' }
      });
      assert.strictEqual(res.status, 200);
      token = (await res.json()).token;
      const me = await api('GET', '/api/auth/me', { token });
      assert.strictEqual(me.status, 200);
    });

    // 5. The frontend is actually served.
    await check('the SPA and its assets are served', async () => {
      const page = await fetch(`http://127.0.0.1:${PORT}/`);
      assert.strictEqual(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes('js/app.js'));
      assert.ok(html.includes('id="app"') || html.includes('setup-page'));
      for (const a of ['/js/app.js', '/js/api.js', '/js/editor.js', '/translations/fr.js', '/css/style.css']) {
        assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}${a}`)).status, 200, a);
      }
    });

    // 6. The Discord bot lifecycle over the real API.
    await check('a bot can be created, inspected, edited and deleted', async () => {
      const create = await api('POST', '/api/bots', {
        token, body: { name: 'bootbot', token: 'unit-test-token-not-a-discord-secret-123456' }
      });
      assert.strictEqual(create.status, 201, await create.clone().text());

      const list = await api('GET', '/api/bots', { token });
      assert.ok((await list.json()).some(b => b.name === 'bootbot'));

      const w = await api('PUT', '/api/files/bootbot/write', {
        token, body: { path: 'hello.js', content: 'console.log("hi")\n' }
      });
      assert.strictEqual(w.status, 200);
      const r = await api('GET', '/api/files/bootbot/read?path=hello.js', { token });
      assert.strictEqual((await r.json()).content, 'console.log("hi")\n');

      // The traversal that used to work must not.
      const escape = await api('POST', '/api/files/bootbot/create', {
        token, body: { name: 'evil.js', type: 'file', parentPath: '../bootbot2' }
      });
      assert.strictEqual(escape.status, 403);
      assert.ok(!fs.existsSync(path.join(bots, 'bootbot2', 'evil.js')));

      // The bot's .env carries its Discord token.
      if (process.platform !== 'win32') {
        const envMode = fs.statSync(path.join(bots, 'bootbot', '.env')).mode & 0o777;
        assert.strictEqual(envMode, 0o600, 'bot .env must be 0600');
      }

      const del = await api('DELETE', '/api/bots/bootbot', { token });
      assert.strictEqual(del.status, 200);
    });

    // 7. A database write is durable and correctly permissioned.
    await check('the database file is 0600 and holds the account', () => {
      if (process.platform === 'win32') return;   // POSIX modes not enforced on NTFS
      const dbFile = path.join(data, 'nexus.db.json');
      const mode = fs.statSync(dbFile).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
      const d = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      assert.strictEqual(d.users.length, 1);
      assert.ok(d.users[0].password_hash.startsWith('$2'), 'bcrypt hash stored');
    });

    // 8. Logout revokes the token server-side.
    await check('logout revokes the session', async () => {
      assert.strictEqual((await api('POST', '/api/auth/logout', { token })).status, 200);
      assert.strictEqual((await api('GET', '/api/auth/me', { token })).status, 401);
    });

  } catch (e) {
    results.push(['FAIL', `harness: ${e.message}`]);
  } finally {
    child.kill();
    await sleep(400);
    // This suite never writes backend/.env, so there is nothing to clean up
    // there: a real .env must survive a test run untouched.
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  let failed = 0;
  for (const [status, name] of results) {
    if (status === 'FAIL') failed++;
    console.log(`${status === 'PASS' ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(`\n${results.length - failed}/${results.length} boot checks passed`);
  process.exit(failed ? 1 : 0);
})();
