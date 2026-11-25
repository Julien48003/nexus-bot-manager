'use strict';
/**
 * Update the three translation files:
 *   - the password policy is now 8 characters (mirrors auth.js
 *     MIN_PASSWORD_LENGTH and the wizard's client-side check);
 *   - the setup wizard gained a bootstrap-token field.
 *
 * Keys are nested: the i18n resolver walks a dot-path, so t('setup.tokenTitle')
 * reads DATA[lang].setup.tokenTitle — the new entries must therefore live
 * INSIDE the existing `setup:` object, not at the top level.
 */
const fs   = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'translations');

const EDITS = {
  en: {
    replace: { adminPwdHint: 'min. 8 characters', errPwdShort: 'Password too short (min. 8 chars).' },
    add: [
      ['tokenTitle',        'Setup token'],
      ['tokenPh',           'Paste the token printed in the server console'],
      ['tokenHint',         'Printed at server startup and stored in backend/data/setup-token (mode 0600). It is required once, then deleted.'],
      ['errTokenMissing',   'The setup token is required. It is printed in the server console at startup.']
    ]
  },
  fr: {
    replace: { adminPwdHint: 'min. 8 caractères', errPwdShort: 'Mot de passe trop court (min. 8 caractères).' },
    add: [
      ['tokenTitle',        'Jeton de configuration'],
      ['tokenPh',           'Collez le jeton affiché dans la console du serveur'],
      ['tokenHint',         'Affiché au démarrage du serveur et stocké dans backend/data/setup-token (mode 0600). Il est demandé une seule fois, puis supprimé.'],
      ['errTokenMissing',   'Le jeton de configuration est requis. Il est affiché dans la console du serveur au démarrage.']
    ]
  },
  de: {
    replace: { adminPwdHint: 'mind. 8 Zeichen', errPwdShort: 'Passwort zu kurz (mind. 8 Zeichen).' },
    add: [
      ['tokenTitle',        'Einrichtungstoken'],
      ['tokenPh',           'Token aus der Server-Konsole einfügen'],
      ['tokenHint',         'Wird beim Serverstart in der Konsole angezeigt und unter backend/data/setup-token (Modus 0600) gespeichert. Wird einmal abgefragt und danach gelöscht.'],
      ['errTokenMissing',   'Das Einrichtungstoken ist erforderlich. Es wird beim Serverstart in der Konsole angezeigt.']
    ]
  }
};

const q = (v) => "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

for (const [lang, spec] of Object.entries(EDITS)) {
  const file = path.join(DIR, `${lang}.js`);
  let src = fs.readFileSync(file, 'utf8');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';

  // 1. Replace existing values, line by line, so nothing else is touched.
  const lines = src.split(nl);
  for (let i = 0; i < lines.length; i++) {
    for (const [key, value] of Object.entries(spec.replace)) {
      const re = new RegExp(`^(\\s*${key}:\\s*)'[^']*',\\s*$`);
      if (re.test(lines[i])) {
        lines[i] = lines[i].replace(re, `$1${q(value)},`);
      }
    }
  }
  src = lines.join(nl);

  // 2. Insert the new keys immediately after errPwdMismatch, same indent.
  const idx = lines.findIndex(l => /^\s*errPwdMismatch:/.test(l));
  if (idx < 0) { console.error(`${lang}: errPwdMismatch anchor not found`); continue; }
  const indent = (lines[idx].match(/^\s*/) || [''])[0];
  const current = lines.slice();

  for (const [key, value] of spec.add) {
    if (new RegExp(`^\\s*${key}:`, 'm').test(current.join(nl))) continue;
    current.splice(idx + 1 + spec.add.findIndex(a => a[0] === key), 0, `${indent}${key}: ${q(value)},`);
  }
  fs.writeFileSync(file, current.join(nl), 'utf8');
  console.log(`${lang}.js updated`);
}
