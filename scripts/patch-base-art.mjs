/**
 * One-shot: merge RePoE visual_identity.dds_file into existing base-items.json
 * without a full knowledge rebuild. Prefer `npm run build:knowledge` long-term.
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '../public/data/knowledge/base-items.json');
const REPOE = 'https://repoe-fork.github.io/base_items.min.json';

const raw = await (await fetch(REPOE)).json();
const artByName = new Map();
for (const b of Object.values(raw)) {
  if (b.release_state !== 'released' || !b.name) continue;
  const art = b.visual_identity?.dds_file ?? null;
  if (!art) continue;
  // Prefer first released art if duplicate names
  if (!artByName.has(b.name)) {
    artByName.set(b.name, {
      art,
      w: b.inventory_width ?? 1,
      h: b.inventory_height ?? 1,
    });
  }
}

const data = JSON.parse(readFileSync(outPath, 'utf8'));
let n = 0;
for (const b of data.bases ?? []) {
  const hit = artByName.get(b.name);
  if (!hit) continue;
  b.art = hit.art;
  b.w = hit.w;
  b.h = hit.h;
  n++;
}
writeFileSync(outPath, JSON.stringify(data));
console.log(`Patched art onto ${n}/${data.bases?.length ?? 0} bases → ${outPath}`);
