// Tiny persistent JSON cache under azure-finops-map/.cache.
// Used to make Cost Management data resilient to API throttling across restarts,
// without requiring the (optional) Azure SQL cache.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache');
let _ready;
async function ensure() { if (!_ready) _ready = mkdir(dir, { recursive: true }).catch(() => {}); return _ready; }
function fileFor(key) { return join(dir, createHash('sha1').update(key).digest('hex') + '.json'); }

export async function getDisk(key, maxAgeMs) {
  try {
    await ensure();
    const o = JSON.parse(await readFile(fileFor(key), 'utf8'));
    if (Date.now() - o.t > maxAgeMs) return null;
    return o.v;
  } catch { return null; }
}

export async function setDisk(key, val) {
  try { await ensure(); await writeFile(fileFor(key), JSON.stringify({ t: Date.now(), v: val })); }
  catch { /* best-effort */ }
}
