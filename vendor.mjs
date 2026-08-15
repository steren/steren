// Copy the browser modules this site loads out of node_modules and into
// vendor/, which is committed and served as plain static files.
//
// index.html resolves these through an import map, so the browser fetches them
// over HTTP and they have to be part of the deployed site. node_modules is not
// dependable for that: it belongs to npm, and hosts routinely drop it from a
// deployment (Vercel does, which is why the effect went missing on previews).
//
// Runs automatically after `npm install`.

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGES = {
  'rtx-on': ['rtx-on.js', 'LICENSE'],
  // webgl-path-tracing.js imports ./glUtils.js, which imports ./sylvester.src.js,
  // so those three have to stay next to each other.
  'webgl-path-tracing': ['webgl-path-tracing.js', 'glUtils.js', 'sylvester.src.js', 'LICENSE'],
};

// Report the files whose content actually changed. vendor/ is committed, so an
// upstream release — or a local edit made inside node_modules — shows up here
// and in `git status` rather than reaching the site unnoticed.
const changed = [];

for (const [name, files] of Object.entries(PACKAGES)) {
  await mkdir(join('vendor', name), { recursive: true });
  for (const file of files) {
    const from = join('node_modules', name, file);
    const to = join('vendor', name, file);
    const [source, current] = await Promise.all([
      readFile(from),
      readFile(to).catch(() => null),
    ]);
    if (!current?.equals(source)) {
      changed.push(to);
      await copyFile(from, to);
    }
  }
}

console.log(
  changed.length
    ? `vendor/ updated:\n  ${changed.join('\n  ')}\ncheck \`git diff\` before committing.`
    : 'vendor/ already up to date',
);
