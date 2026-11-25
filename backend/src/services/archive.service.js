'use strict';
/**
 * Safe ZIP extraction for bot backups.
 *
 * extract-zip 2.0.1 has no patched release for symlink/path traversal
 * advisories. This module uses yauzl 3.x with streaming extraction and keeps
 * its own application-level checks instead of trusting archive metadata:
 *
 *  - only regular files and directories are accepted;
 *  - absolute paths, parent segments, backslashes and control characters are
 *    refused;
 *  - symlink, device, FIFO and other special Unix modes are refused;
 *  - duplicate paths, encrypted entries and unsupported compression methods
 *    are refused;
 *  - declared and actual uncompressed sizes are bounded (zip-bomb guard);
 *  - every path is contained in the fresh destination directory and every
 *    parent is checked with lstat before a write;
 *  - files are created with O_EXCL (no overwrite, no following symlinks) and
 *    fixed 0600 permissions; directories are 0700;
 *  - the extracted tree is walked again and any symlink is refused.
 *
 * The caller must pass a new, empty directory. It is removed by the caller on
 * any error, exactly like the temporary upload file.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

const DEFAULTS = {
  maxEntries: 10000,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxPathBytes: 1024,
  fileMode: 0o600,
  dirMode: 0o700
};

function unsafe(message) {
  const err = new Error(message);
  err.code = 'ARCHIVE_UNSAFE';
  return err;
}

function invalid(message) {
  const err = new Error(message);
  err.code = 'ARCHIVE_INVALID';
  return err;
}

function displayName(name) {
  return JSON.stringify(String(name).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 160));
}

function normalizeEntryName(rawName, isDirectory, maxPathBytes) {
  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw invalid('Entrée d\'archive sans nom');
  }
  if (rawName.includes('\u0000')) {
    throw unsafe('Nom d\'entrée invalide dans l\'archive');
  }
  if (rawName.length > maxPathBytes || Buffer.byteLength(rawName, 'utf8') > maxPathBytes) {
    throw unsafe(`Nom d\'entrée trop long dans l\'archive : ${displayName(rawName)}`);
  }
  if (rawName.startsWith('/') || rawName.startsWith('\\') || /^[A-Za-z]:/.test(rawName)) {
    throw unsafe(`Chemin absolu interdit dans l'archive : ${displayName(rawName)}`);
  }
  if (rawName.includes('\\')) {
    throw unsafe(`Séparateur de chemin interdit dans l'archive : ${displayName(rawName)}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(rawName)) {
    throw unsafe(`Caractère de contrôle interdit dans l'archive : ${displayName(rawName)}`);
  }

  const trimmed = isDirectory && rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
  if (!trimmed) throw invalid('Entrée d\'archive sans nom');
  const parts = trimmed.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw unsafe(`Traversée de répertoire interdite dans l'archive : ${displayName(rawName)}`);
    }
  }
  return parts.join('/');
}

function fileTypeOf(entry) {
  // Unix mode bits live in the high 16 bits of externalFileAttributes.
  // DOS-created archives usually leave this at 0.
  const mode = (entry.externalFileAttributes || 0) >>> 16;
  return mode & 0xF000;
}

function checkEntryMetadata(entry, isDirectory) {
  if (typeof entry.isEncrypted === 'function' && entry.isEncrypted()) {
    throw unsafe('Entrée chiffrée interdite dans l\'archive');
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw unsafe('Méthode de compression non supportée dans l\'archive');
  }

  const type = fileTypeOf(entry);
  if (type === 0xA000) {
    throw unsafe(`Lien symbolique interdit dans l'archive : ${displayName(entry.fileName)}`);
  }
  if (type !== 0 && type !== 0x4000 && type !== 0x8000) {
    throw unsafe(`Type de fichier interdit dans l'archive : ${displayName(entry.fileName)}`);
  }
  if (type === 0x4000 && !isDirectory) {
    throw unsafe(`Entrée de répertoire incohérente dans l'archive : ${displayName(entry.fileName)}`);
  }
  if (type === 0x8000 && isDirectory) {
    throw unsafe(`Entrée de fichier incohérente dans l'archive : ${displayName(entry.fileName)}`);
  }
  if (isDirectory && entry.uncompressedSize !== 0) {
    throw unsafe(`Répertoire avec des données dans l'archive : ${displayName(entry.fileName)}`);
  }
}

async function ensureDirectory(root, relativeDir, dirMode) {
  let current = root;
  for (const segment of relativeDir.split('/')) {
    if (!segment) throw unsafe('Chemin d\'extraction invalide');
    current = path.join(current, segment);

    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await fsp.mkdir(current, { mode: dirMode });
      stat = await fsp.lstat(current);
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafe(`Chemin d'extraction invalide : ${displayName(relativeDir)}`);
    }
  }
}

async function extractFile(zipfile, entry, destination, relativeName, options, state) {
  const parent = path.posix.dirname(relativeName);
  if (parent !== '.') await ensureDirectory(destination, parent, options.dirMode);

  const target = path.join(destination, ...relativeName.split('/'));
  if (!target.startsWith(destination + path.sep)) {
    throw unsafe(`Chemin hors du dossier d'extraction : ${displayName(relativeName)}`);
  }

  let readStream;
  try {
    readStream = await zipfile.openReadStreamPromise(entry);
  } catch (err) {
    throw invalid(`Entrée illisible dans l'archive : ${displayName(relativeName)}`);
  }

  let written = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      written += chunk.length;
      if (state.totalWritten + written > options.maxTotalBytes) {
        callback(unsafe('Archive trop volumineuse une fois décompressée'));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      readStream,
      counter,
      fs.createWriteStream(target, { flags: 'wx', mode: options.fileMode })
    );
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw unsafe(`Chemin déjà présent dans l'archive : ${displayName(relativeName)}`);
    }
    if (err && err.code === 'ARCHIVE_UNSAFE') throw err;
    if (err && ['EACCES', 'ENOSPC', 'EROFS'].includes(err.code)) throw err;
    throw invalid(`Extraction impossible pour ${displayName(relativeName)}`);
  }

  if (written !== entry.uncompressedSize) {
    throw invalid(`Taille incohérente dans l'archive : ${displayName(relativeName)}`);
  }
  state.totalWritten += written;
  state.files += 1;
}

async function assertTreeSafe(root) {
  const realRoot = await fsp.realpath(root);
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) {
        throw unsafe(`Lien symbolique interdit dans l'archive : ${displayName(entry.name)}`);
      }
      const real = await fsp.realpath(full);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw unsafe(`Chemin hors du dossier d'extraction : ${displayName(entry.name)}`);
      }
      if (stat.isDirectory()) {
        try { await fsp.chmod(full, 0o700); } catch (_) {}
        stack.push(full);
      } else if (stat.isFile()) {
        try { await fsp.chmod(full, 0o600); } catch (_) {}
      } else {
        throw unsafe(`Type de fichier interdit dans l'archive : ${displayName(entry.name)}`);
      }
    }
  }
}

/**
 * Extract a ZIP into an empty directory.
 *
 * @param {string} zipPath
 * @param {string} destination
 * @param {{maxEntries?: number, maxTotalBytes?: number, maxPathBytes?: number}} [options]
 * @returns {Promise<{entries: number, files: number, directories: number, bytes: number}>}
 */
async function extractZipSafe(zipPath, destination, options = {}) {
  const config = { ...DEFAULTS, ...options };
  for (const key of ['maxEntries', 'maxTotalBytes', 'maxPathBytes']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new TypeError(`Invalid archive option: ${key}`);
    }
  }

  const root = path.resolve(destination);
  const rootStat = await fsp.lstat(root).catch(err => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw unsafe('Dossier d\'extraction invalide');
  }
  if ((await fsp.readdir(root)).length !== 0) {
    throw unsafe('Le dossier d\'extraction doit être vide');
  }

  const state = {
    entries: 0,
    files: 0,
    directories: 0,
    declaredBytes: 0,
    totalWritten: 0,
    paths: new Set()
  };

  let zipfile;
  try {
    zipfile = await yauzl.openPromise(zipPath, {
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    });
  } catch (err) {
    throw invalid('Archive ZIP invalide ou illisible');
  }

  try {
    for await (const entry of zipfile.eachEntry()) {
      state.entries += 1;
      if (state.entries > config.maxEntries) {
        throw unsafe('Trop d\'entrées dans l\'archive');
      }

      const isDirectory = entry.fileName.endsWith('/');
      const name = normalizeEntryName(entry.fileName, isDirectory, config.maxPathBytes);
      checkEntryMetadata(entry, isDirectory);

      if (state.paths.has(name)) {
        throw unsafe(`Entrée dupliquée dans l'archive : ${displayName(name)}`);
      }
      state.paths.add(name);

      if (isDirectory) {
        await ensureDirectory(root, name, config.dirMode);
        state.directories += 1;
        continue;
      }

      if (state.declaredBytes + entry.uncompressedSize > config.maxTotalBytes) {
        throw unsafe('Archive trop volumineuse une fois décompressée');
      }
      state.declaredBytes += entry.uncompressedSize;
      await extractFile(zipfile, entry, root, name, config, state);
    }
  } catch (err) {
    if (err && (err.code === 'ARCHIVE_UNSAFE' || err.code === 'ARCHIVE_INVALID')) throw err;
    throw invalid('Archive ZIP invalide ou corrompue');
  } finally {
    try { zipfile.close(); } catch (_) {}
  }

  await assertTreeSafe(root);
  return {
    entries: state.entries,
    files: state.files,
    directories: state.directories,
    bytes: state.totalWritten
  };
}

module.exports = { extractZipSafe };
