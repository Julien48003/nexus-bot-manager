'use strict';
/**
 * Audit: assert that no ${esc(…)} interpolation survives inside an inline
 * event-handler attribute, because those are compiled as JavaScript after
 * HTML decoding and need escJs(), not esc().
 */
const fs   = require('fs');
const path = require('path');

// Default to the two files that build the panel's markup, so `npm run
// audit:handlers` works with no arguments.
const DEFAULT_FILES = ['app.js', 'editor.js'].map(
  f => require('path').join(__dirname, '..', '..', 'frontend', 'public', 'js', f)
);
const FILES = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES;
const ATTR_RE = /(\bon(?:click|contextmenu|input|change|submit|error|load|mouseover|mouseout|focus|blur|keyup|keydown)=)("(?:\\.|[^"\\])*")/g;

let problems = 0;
let handlers = 0;
let escJsUses = 0;

for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  src.replace(ATTR_RE, (match, prefix, value) => {
    handlers++;
    const body = value.slice(1, -1);
    escJsUses += (body.match(/escJs\(/g) || []).length;
    const bare = body.match(/(?<!escJs)\besc\(/g);
    if (bare) {
      problems += bare.length;
      const event = (prefix.match(/\bon(\w+)=/) || [])[1];
      const line = src.slice(0, src.indexOf(match)).split(/\r?\n/).length;
      console.log(`  PROBLEM ${path.basename(f)}:${line} — ${bare.length} bare esc() in on${event}`);
      console.log('    ' + body.trim().slice(0, 160));
    }
    return match;
  });
}

console.log(`handlers scanned: ${handlers}, escJs() uses inside them: ${escJsUses}, problems: ${problems}`);
process.exit(problems ? 1 : 0);
