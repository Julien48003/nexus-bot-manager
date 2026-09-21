#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * Nexus Bot Manager — i18n coverage audit
 *
 * Verifies that every key present in en.js is also present in fr.js and de.js
 * (so users never see a raw dotted key like "settings.foo.bar" in production).
 *
 * Usage:    node scripts/audit-i18n.js
 * Exits 0 when all keys are present, 1 otherwise.
 */

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..', 'frontend', 'public', 'translations');

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function load(lang) {
  const fp = path.join(ROOT, `${lang}.js`);
  const src = fs.readFileSync(fp, 'utf8');
  // The translation files use `window.NexusI18n.register('en', {...})`.
  // We inject a stub NexusI18n.register into a sandbox window so the call
  // simply captures the dictionary.
  const captured = {};
  const sandbox = {
    window: {
      NexusI18n: {
        register(l, dict) { captured[l] = dict; }
      }
    }
  };
  const fn = new Function('window', src);
  fn(sandbox.window);
  if (!captured[lang]) {
    throw new Error(`Translation file ${lang}.js did not call NexusI18n.register('${lang}', ...)`);
  }
  return flatten(captured[lang]);
}

const en = load('en');
const fr = load('fr');
const de = load('de');

const enKeys = Object.keys(en);
const frKeys = Object.keys(fr);
const deKeys = Object.keys(de);

const frMissing = enKeys.filter(k => !(k in fr));
const deMissing = enKeys.filter(k => !(k in de));

const frOrphan = frKeys.filter(k => !(k in en));
const deOrphan = deKeys.filter(k => !(k in en));

// Detect empty/placeholder values in fr/de
function isPlaceholder(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return s === '' || /^\{[^}]+\}$/.test(s);
}

const frEmpty = enKeys.filter(k => k in fr && isPlaceholder(fr[k]));
const deEmpty = enKeys.filter(k => k in de && isPlaceholder(de[k]));

const total = enKeys.length;

function pct(n) {
  return ((n / total) * 100).toFixed(2);
}

const rows = [
  ['EN keys (baseline)', total, '100.00%'],
  ['FR keys present',   frKeys.length, pct(frKeys.length) + '%'],
  ['DE keys present',   deKeys.length, pct(deKeys.length) + '%'],
  ['FR missing',        frMissing.length, pct(frMissing.length) + '%'],
  ['DE missing',        deMissing.length, pct(deMissing.length) + '%'],
  ['FR orphan',         frOrphan.length, pct(frOrphan.length) + '%'],
  ['DE orphan',         deOrphan.length, pct(deOrphan.length) + '%'],
  ['FR empty/placeholder', frEmpty.length, pct(frEmpty.length) + '%'],
  ['DE empty/placeholder', deEmpty.length, pct(deEmpty.length) + '%'],
];

console.log('');
console.log('Nexus Bot Manager — i18n coverage audit');
console.log('==========================================');
console.log('');
console.log('Metric                       Count    Coverage');
console.log('----------------------------  -------  --------');

for (const [label, count, cov] of rows) {
  console.log(label.padEnd(28), String(count).padStart(7), '  ' + cov);
}
console.log('');

if (frMissing.length) {
  console.log(`Missing in FR (${frMissing.length}):`);
  frMissing.forEach(k => console.log('  - ' + k));
  console.log('');
}

if (deMissing.length) {
  console.log(`Missing in DE (${deMissing.length}):`);
  deMissing.forEach(k => console.log('  - ' + k));
  console.log('');
}

if (frOrphan.length) {
  console.log(`Orphan in FR (${frOrphan.length}, not present in EN baseline):`);
  frOrphan.forEach(k => console.log('  - ' + k));
  console.log('');
}

if (deOrphan.length) {
  console.log(`Orphan in DE (${deOrphan.length}, not present in EN baseline):`);
  deOrphan.forEach(k => console.log('  - ' + k));
  console.log('');
}

if (frEmpty.length) {
  console.log(`Empty/placeholder in FR (${frEmpty.length}):`);
  frEmpty.forEach(k => console.log('  - ' + k + ' = ' + JSON.stringify(fr[k])));
  console.log('');
}

if (deEmpty.length) {
  console.log(`Empty/placeholder in DE (${deEmpty.length}):`);
  deEmpty.forEach(k => console.log('  - ' + k + ' = ' + JSON.stringify(de[k])));
  console.log('');
}

const ok = frMissing.length === 0 && deMissing.length === 0 && frEmpty.length === 0 && deEmpty.length === 0;
console.log(ok ? '✓ All keys present and non-empty.' : '✗ Translation coverage has gaps. See above.');
process.exit(ok ? 0 : 1);
