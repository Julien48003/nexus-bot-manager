'use strict';
/**
 * Shared test harness.
 *
 * Every suite runs against a throwaway BOTS_ROOT and a throwaway data
 * directory so nothing touches a real install, and so a suite can create
 * the sibling directories ("monbot2") the traversal tests need.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const REPO_BACKEND = path.join(__dirname, '..');

/** Isolated sandbox: BOTS_ROOT + data dir + a strong JWT secret. */
function makeSandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `nbm-test-${name}-`));
  const botsRoot = path.join(root, 'opt');
  const dataDir  = path.join(root, 'data');
  fs.mkdirSync(botsRoot, { recursive: true });
  fs.mkdirSync(dataDir,  { recursive: true });

  // Must be set before ../src/db/db is required: the module resolves its
  // data directory at load time.
  process.env.NEXUS_DATA_DIR = dataDir;
  process.env.BOTS_ROOT    = botsRoot;
  // Same shape the installer generates: 128 hex characters, which is what
  // assertStrongSecret() in server.js requires.
  process.env.JWT_SECRET   =
    'a1b2c3d4e5f60718293a4b5c6d7e8f90' +
    '1a2b3c4d5e6f708192a3b4c5d6e7f809' +
    '0f1e2d3c4b5a69788796a5b4c3d2e1f0' +
    'deadbeefcafebabe0123456789abcdef';
  process.env.JWT_EXPIRES_IN = '1h';
  process.env.NODE_ENV     = 'test';
  delete process.env.INSTALL_DIR;    // do not read a version from a real install dir

  return {
    root,
    botsRoot,
    dataDir,
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

/** Create a bot directory with an index.js and a package.json. */
function makeBot(botsRoot, botName, extra = {}) {
  const dir = path.join(botsRoot, botName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), '// bot entry point\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: botName, version: '1.0.0', main: 'index.js', dependencies: { 'discord.js': '^14.0.0' }
  }, null, 2), 'utf8');
  for (const [name, content] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

/** A syntactically valid zip, built by hand (no archive dependency needed). */
function makeZip(entries) {
  const zlib = require('zlib');
  const crc32 = (buf) => {
    let c, crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xFF;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
      crc = c ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const local = [], central = [];
  let offset = 0;
  for (const { name, data, externalAttributes = 0, versionMadeBy = 20 } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(Buffer.from(data, 'utf8'));
    const sum = crc32(Buffer.from(data, 'utf8'));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(sum, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(Buffer.from(data, 'utf8').length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(versionMadeBy, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14); ch.writeUInt32LE(sum, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(Buffer.from(data, 'utf8').length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((externalAttributes >>> 0), 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

module.exports = { makeSandbox, makeBot, makeZip, REPO_BACKEND };
