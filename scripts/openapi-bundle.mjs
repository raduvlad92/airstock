/**
 * Joins docs/api/document.json and docs/api/operations/*.json into the single OpenAPI 3.1
 * document. Wrangler runs it before every build and dev session (`build` in wrangler.jsonc),
 * so the Worker serves the committed contract at /openapi.json. Plain JavaScript without
 * dependencies, so it runs anywhere Node does.
 *
 * Usage: node scripts/openapi-bundle.mjs [output file, default apps/worker/public/openapi.json]
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = fileURLToPath(new URL('../docs/api/', import.meta.url));
const out = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../apps/worker/public/openapi.json', import.meta.url));

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const document = await readJson(join(API_DIR, 'document.json'));
const entries = [];
for (const file of await readdir(join(API_DIR, 'operations'))) {
  if (!file.endsWith('.json')) continue;
  const fragment = await readJson(join(API_DIR, 'operations', file));
  for (const [path, item] of Object.entries(fragment)) {
    for (const [method, operation] of Object.entries(item))
      entries.push({ path, method, operation });
  }
}

// Sorted by path, then method, so the result does not depend on file names or registry order.
const key = (entry) => `${entry.path} ${entry.method}`;
entries.sort((a, b) => (key(a) < key(b) ? -1 : 1));
const paths = {};
for (const { path, method, operation } of entries) {
  paths[path] ??= {};
  if (paths[path][method]) throw new Error(`Two operations for ${method.toUpperCase()} ${path}`);
  paths[path][method] = operation;
}

const text = `${JSON.stringify({ ...document, paths }, null, 2)}\n`;
await mkdir(dirname(out), { recursive: true });
// Unchanged output is not rewritten, so `wrangler dev` does not see a change and rebuild.
if ((await readFile(out, 'utf8').catch(() => null)) !== text) await writeFile(out, text);
console.log(`OpenAPI document with ${entries.length} operations: ${out}`);
