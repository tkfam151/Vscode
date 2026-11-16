// Gives every site file a version tag in its address (?v=...), so browsers
// load the new files right after an update instead of reusing old copies.
//
// Run after changing anything in docs/:   node tools/stamp-version.mjs
// The tag is made from the files' contents, so it only changes when they do.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const docs = path.resolve(new URL('../docs', import.meta.url).pathname);
const jsFiles = fs.readdirSync(path.join(docs, 'js')).filter((f) => f.endsWith('.js')).sort();
const hashed = [...jsFiles.map((f) => `js/${f}`), 'config.js', 'style.css', 'logo.png', 'favicon.png'].filter((f) => fs.existsSync(path.join(docs, f)));
const hash = crypto.createHash('sha256');
for (const f of hashed) hash.update(f).update(fs.readFileSync(path.join(docs, f)));
const v = hash.digest('hex').slice(0, 10);

// every module the pages load, mapped to its versioned address
const map = { './config.js': `./config.js?v=${v}` };
for (const f of jsFiles) map[`./js/${f}`] = `./js/${f}?v=${v}`;
const importMap = `<script type="importmap" id="cc-version">${JSON.stringify({ imports: map })}</script>`;

for (const page of fs.readdirSync(docs).filter((f) => f.endsWith('.html'))) {
  const file = path.join(docs, page);
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<script type="importmap" id="cc-version">.*?<\/script>\n?/s, '');
  html = html.replace(/href="style\.css(\?v=[^"]*)?"/g, `href="style.css?v=${v}"`);
  html = html.replace(/src="js\/([\w-]+\.js)(\?v=[^"]*)?"/g, (m, name) => `src="js/${name}?v=${v}"`);
  // the import map must come before the first module script
  const at = html.indexOf('<script type="module"');
  if (at >= 0) html = html.slice(0, at) + importMap + '\n' + html.slice(at);
  fs.writeFileSync(file, html);
}
console.log(`version ${v} stamped into ${fs.readdirSync(docs).filter((f) => f.endsWith('.html')).join(', ')}`);
