/**
 * Probe Onslaught Bolt craft plan (Broadhead Arrow Quiver).
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/data/prices/daily.json')) {
    const path = join(root, 'public/data/prices/daily.json');
    if (existsSync(path)) {
      return { ok: true, json: async () => JSON.parse(readFileSync(path, 'utf8')) };
    }
    return {
      ok: true,
      json: async () => ({
        fetchedAt: new Date().toISOString(),
        league: 'test',
        prices: {
          chaos: 1,
          divine: 200,
          exalt: 15,
          alteration: 0.1,
          transmute: 0.01,
          annul: 0.5,
          alchemy: 0.05,
          regal: 0.15,
          'essence-deafening': 8,
          'essence-shrieking': 1.5,
          'eldritch-chaos': 25,
          harvest: 40,
          veiled: 50,
          'veiled-chaos': 40,
        },
      }),
    };
  }
  if (u.includes('/data/prices/')) return { ok: false, status: 404 };
  const m = u.match(/\/data\/knowledge\/(.+)$/);
  if (!m) throw new Error(`unexpected fetch ${url}`);
  const path = join(root, 'public/data/knowledge', m[1]);
  if (!existsSync(path)) {
    if (/mods-(jewels|flasks|remainder)\.json$/.test(m[1])) return { ok: false, status: 404 };
    throw new Error(`missing ${path}`);
  }
  return { ok: true, json: async () => JSON.parse(readFileSync(path, 'utf8')) };
};

const { parseItem } = await import('../src/lib/itemParser.js');
const { generateCraftSteps } = await import('../src/lib/craftPlanner.js');

const text = `Item Class: Quivers
Rarity: Rare
Onslaught Bolt
Broadhead Arrow Quiver
--------
Requirements:
Level: 45
--------
Item Level: 85
--------
{ Implicit Modifier — Attack, Speed }
8(8-10)% increased Attack Speed
--------
{ Prefix Modifier "Sizzling" (Tier: 3) — Damage, Elemental, Lightning, Attack }
Adds 3(1-4) to 67(62-70) Lightning Damage to Attacks
{ Suffix Modifier "of Destruction" (Tier: 5) — Damage, Critical }
+(13-16)% to Critical Strike Multiplier with Bows
{ Fractured Suffix Modifier "of the Polar Bear" (Tier: 1) — Elemental, Cold, Resistance }
+46(46-48)% to Cold Resistance
{ Suffix Modifier "of Grounding" (Tier: 2) — Elemental, Lightning, Resistance }
+42(42-45)% to Lightning Resistance
--------
Fractured Item`;

const item = parseItem(text);
console.log('influences:', item.influenced);
console.log('explicits:');
for (const m of item.explicits ?? []) {
  console.log(' -', { gen: m.generationType ?? m.gen, frac: !!m.fractured, text: (m.text ?? '').slice(0, 70) });
}
const plan = await generateCraftSteps(item);
console.log('\nmethod:', plan.methodName);
console.log('cost:', plan.totalCost);
console.log('\nmodAnalysis:');
for (const m of plan.modAnalysis ?? []) {
  console.log(' -', m.method, '|', (m.text ?? '').split('\n')[0].slice(0, 70));
}
console.log('\nsteps:');
for (const s of plan.steps ?? []) {
  console.log(`  ${s.step}. [${s.chanceLabel ?? '-'}] ${s.action}`);
  if (s.detail) console.log('     ', s.detail.slice(0, 200));
}
if (plan.alternatives?.length) {
  console.log('\nalternatives:');
  for (const a of plan.alternatives) {
    console.log(`  - ${a.name} (~${a.totalCost}c) ${(a.description ?? '').slice(0, 140)}`);
  }
}
console.log('\ntips:', (plan.tips ?? []).slice(0, 5));
