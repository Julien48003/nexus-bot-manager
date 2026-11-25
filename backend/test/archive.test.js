'use strict';
/**
 * ZIP extractor security tests.
 *
 * These fixtures are built by hand so they do not depend on a zip utility
 * being installed. Each test gets a fresh destination directory.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeZip } = require('./helpers');
const archive = require('../src/services/archive.service');
const archiver = require('archiver');

function makeArchiverZip(zipPath, files) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const zip = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    zip.on('error', reject);
    zip.pipe(output);
    for (const [name, data] of Object.entries(files)) zip.append(data, { name });
    zip.finalize().catch(reject);
  });
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-zip-'));
  return {
    root,
    zipPath: path.join(root, 'archive.zip'),
    dest: path.join(root, 'extract'),
    write(entries) {
      fs.writeFileSync(this.zipPath, makeZip(entries));
      fs.mkdirSync(this.dest, { mode: 0o700 });
      return this.zipPath;
    },
    cleanup() {
      fs.rmSync(this.root, { recursive: true, force: true });
    }
  };
}

test('ZIP-01: a valid bot archive extracts with safe permissions', async () => {
  const sb = sandbox();
  try {
    sb.write([
      { name: 'bot/', data: '' },
      { name: 'bot/index.js', data: '// hello\n' },
      { name: 'bot/lib/util.js', data: 'module.exports = 1;\n' },
      { name: 'bot/package.json', data: '{"name":"bot"}\n' }
    ]);
    const stats = await archive.extractZipSafe(sb.zipPath, sb.dest);
    assert.strictEqual(stats.files, 3);
    assert.strictEqual(stats.directories, 1);
    assert.strictEqual(fs.readFileSync(path.join(sb.dest, 'bot/index.js'), 'utf8'), '// hello\n');
    assert.strictEqual(fs.readFileSync(path.join(sb.dest, 'bot/lib/util.js'), 'utf8'), 'module.exports = 1;\n');

    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.join(sb.dest, 'bot/index.js')).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.join(sb.dest, 'bot/lib')).mode & 0o777, 0o700);
    }
  } finally {
    sb.cleanup();
  }
});

test('ZIP-02: an absolute entry path is refused', async () => {
  const sb = sandbox();
  try {
    sb.write([{ name: '/etc/passwd', data: 'root' }]);
    await assert.rejects(() => archive.extractZipSafe(sb.zipPath, sb.dest), /archive|chemin|invalide/i);
  } finally {
    sb.cleanup();
  }
});

test('ZIP-03: a parent-directory entry is refused', async () => {
  const sb = sandbox();
  try {
    sb.write([
      { name: 'bot/index.js', data: 'ok' },
      { name: 'bot/../../escaped.txt', data: 'escaped' }
    ]);
    await assert.rejects(() => archive.extractZipSafe(sb.zipPath, sb.dest), /archive|travers|invalide/i);
    assert.ok(!fs.existsSync(path.join(sb.root, 'escaped.txt')));
  } finally {
    sb.cleanup();
  }
});

test('ZIP-04: a backslash path is refused', async () => {
  const sb = sandbox();
  try {
    sb.write([{ name: 'bot\\..\\escaped.txt', data: 'escaped' }]);
    await assert.rejects(() => archive.extractZipSafe(sb.zipPath, sb.dest), /archive|séparateur|invalide/i);
    assert.ok(!fs.existsSync(path.join(sb.root, 'escaped.txt')));
  } finally {
    sb.cleanup();
  }
});

test('ZIP-05: a symlink entry is refused', async () => {
  const sb = sandbox();
  try {
    sb.write([
      { name: 'bot/index.js', data: 'ok' },
      {
        name: 'bot/leak',
        data: '/etc/passwd',
        externalAttributes: 0xA1FF0000,
        versionMadeBy: 0x031E
      }
    ]);
    await assert.rejects(() => archive.extractZipSafe(sb.zipPath, sb.dest), /symbolique|symlink|lien/i);
    assert.ok(!fs.existsSync(path.join(sb.dest, 'bot/leak')));
  } finally {
    sb.cleanup();
  }
});

test('ZIP-06: a special Unix file type is refused', async () => {
  const sb = sandbox();
  try {
    sb.write([{
      name: 'bot/pipe',
      data: '',
      externalAttributes: 0x11FF0000,
      versionMadeBy: 0x031E
    }]);
    await assert.rejects(() => archive.extractZipSafe(sb.zipPath, sb.dest), /type de fichier|fichier interdit/i);
  } finally {
    sb.cleanup();
  }
});

test('ZIP-07: duplicate entry paths are refused', async () => {
  const sb = sandbox();
  try {
    sb.write([
      { name: 'bot/index.js', data: 'first' },
      { name: 'bot/index.js', data: 'second' }
    ]);
    await assert.rejects(() => archive.extractZipSafe(sb.zipPath, sb.dest), /dupliqu/i);
  } finally {
    sb.cleanup();
  }
});

test('ZIP-08: the total uncompressed size is bounded', async () => {
  const sb = sandbox();
  try {
    sb.write([{ name: 'bot/big.txt', data: 'x'.repeat(2048) }]);
    await assert.rejects(
      () => archive.extractZipSafe(sb.zipPath, sb.dest, { maxTotalBytes: 128 }),
      /volumineuse/i
    );
    assert.ok(!fs.existsSync(path.join(sb.dest, 'bot/big.txt')));
  } finally {
    sb.cleanup();
  }
});

test('ZIP-09: the entry count is bounded', async () => {
  const sb = sandbox();
  try {
    sb.write([
      { name: 'bot/a.js', data: 'a' },
      { name: 'bot/b.js', data: 'b' }
    ]);
    await assert.rejects(
      () => archive.extractZipSafe(sb.zipPath, sb.dest, { maxEntries: 1 }),
      /trop d'entrées/i
    );
  } finally {
    sb.cleanup();
  }
});

test('ZIP-10: a directory entry carrying data is refused', async () => {
  const sb = sandbox();
  try {
    sb.write([{ name: 'bot/', data: 'not-empty' }]);
    await assert.rejects(() => archive.extractZipSafe(sb.zipPath, sb.dest), /répertoire|données/i);
  } finally {
    sb.cleanup();
  }
});

test('ZIP-11: a real archiver export remains importable', async () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(sb.dest, { mode: 0o700 });
    await makeArchiverZip(sb.zipPath, {
      'bot/index.js': '// archived bot\n',
      'bot/package.json': '{"name":"bot"}\n',
      'bot/lib/util.js': 'module.exports = 1;\n'
    });
    const stats = await archive.extractZipSafe(sb.zipPath, sb.dest);
    assert.strictEqual(stats.files, 3);
    assert.strictEqual(fs.readFileSync(path.join(sb.dest, 'bot/index.js'), 'utf8'), '// archived bot\n');
  } finally {
    sb.cleanup();
  }
});
