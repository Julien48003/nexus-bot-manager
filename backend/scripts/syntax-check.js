'use strict';
/**
 * Syntax check for every backend source file.
 *
 * There is no bundler in this project, so `npm run check` is the closest
 * thing to a build step: it parses each file the way Node will at require
 * time, and fails on the first syntax error. Used by CI and by the
 * post-hardening verification, because a partially applied security patch
 * that does not even parse is the fastest way to break a running install.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const TEST = path.join(__dirname, '..', 'test');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = [...walk(SRC), ...walk(TEST)];
let failed = 0;

for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file);
  try {
    // Same wrapping Node uses for CommonJS modules.
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(file, 'utf8')}\n})`, {
      filename: file
    });
    console.log(`  ok   ${rel}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${rel}: ${e.message}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} fichier(s) analysés sans erreur de syntaxe.`);
process.exit(failed ? 1 : 0);
