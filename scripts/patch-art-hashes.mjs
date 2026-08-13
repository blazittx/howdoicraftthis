/**
 * Optional: attach plain poecdn gen hashes from Awakened PoE Trade items.ndjson
 * so itemArtUrl can prefer official CDN. Influenced variants still need per-flag
 * hashes (opaque); UI falls back to glow+badges without them.
 *
 * Usage: node scripts/patch-art-hashes.mjs [path/to/items.ndjson]
 */
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '../public/data/knowledge/base-items.json');
const ndjson =
  process.argv[2] ||
  join(__dirname, '_tmp-apt-items.ndjson');

if (!existsSync(ndjson)) {
  console.error('Missing', ndjson, '— pass path to APT items.ndjson');
  process.exit(1);
}

const hashByName = new Map();
const rl = createInterface({ input: createReadStream(ndjson), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  if (row.namespace !== 'ITEM' || !row.icon || !row.name) continue;
  const m = String(row.icon).match(/gen\/image\/([^/]+)\/([^/]+)\//);
  if (!m) continue;
  // Only store plain (no influence flags in payload)
  const payload = Buffer.from(m[1], 'base64').toString();
  if (/"(shaper|elder|crusader|redeemer|hunter|warlord|searing|tangled)"\s*:/.test(payload)) continue;
  hashByName.set(row.refName || row.name, m[2]);
}

const data = JSON.parse(readFileSync(outPath, 'utf8'));
let n = 0;
for (const b of data.bases ?? []) {
  const h = hashByName.get(b.name);
  if (!h) continue;
  b.artHash = h;
  n++;
}
writeFileSync(outPath, JSON.stringify(data));
console.log(`Patched artHash onto ${n}/${data.bases?.length ?? 0} bases → ${outPath}`);
