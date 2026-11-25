'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pm2 = require('../src/services/pm2.service');

test('PM2: getLogs reads the log directory selected by PM2_HOME', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-pm2-log-'));
  const oldHome = process.env.PM2_HOME;
  try {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'bot-out.log'), 'one\ntwo\nthree\n', 'utf8');
    fs.writeFileSync(path.join(logs, 'bot-error.log'), 'warning\n', 'utf8');

    process.env.PM2_HOME = root;
    const result = await pm2.getLogs('bot', 2);
    assert.deepStrictEqual(result.out, ['two', 'three']);
    assert.deepStrictEqual(result.err, ['warning']);
  } finally {
    if (oldHome === undefined) delete process.env.PM2_HOME;
    else process.env.PM2_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
