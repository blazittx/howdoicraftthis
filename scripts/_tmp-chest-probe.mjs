/**
 * Focused probe: chest sample via same fetch mock as test-deterministic.mjs
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
      const body = readFileSync(path, 'utf8');
      return { ok: true, json: async () => JSON.parse(body) };
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
          'warlord-exalt': 180,
          'crusader-exalt': 180,
          'hunter-exalt': 180,
          'redeemer-exalt': 180,
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
  const body = readFileSync(path, 'utf8');
  return { ok: true, json: async () => JSON.parse(body) };
};

const { parseItem } = await import('../src/lib/itemParser.js');
const { generateCraftSteps } = await import('../src/lib/craftPlanner.js');

const chest = `Item Class: Body Armours
Rarity: Rare
Cataclysm Shell
Twilight Regalia
--------
Energy Shield: 400 (augmented)
--------
Requirements:
Level: 65
Int: 197
--------
Item Level: 86
--------
{ Prefix Modifier "Unfaltering" (Tier: 1) - Defences, Energy Shield }
102(101-110)% increased Energy Shield
{ Prefix Modifier "Seraphim's" (Tier: 1) - Defences, Energy Shield }
42(39-42)% increased Energy Shield
(16-17)% increased Stun and Block Recovery
{ Prefix Modifier "Unassailable" (Tier: 1) - Defences, Energy Shield }
+85(80-91) to maximum Energy Shield
{ Suffix Modifier "of the Dragon" (Tier: 2) - Elemental, Fire, Resistance }
+45(42-45)% to Fire Resistance
{ Suffix Modifier "of Grounding" (Tier: 3) - Elemental, Lightning, Resistance }
+36(36-41)% to Lightning Resistance
{ Suffix Modifier "of the Magma" - Elemental, Cold, Resistance / Elemental, Lightning, Resistance }
+(16-20)% to Cold and Lightning Resistances (crafted)`;

const item = parseItem(chest);
const plan = await generateCraftSteps(item, null);

console.log('=== methodName ===');
console.log(plan.methodName);
console.log('=== totalCost ===');
console.log(plan.totalCost);

const alts = (plan.alternatives ?? []).map((a) => ({
  id: a.id,
  name: a.name,
  description: a.description,
  totalCost: a.totalCost,
  ...('_extraChaos' in a ? { _extraChaos: a._extraChaos } : {}),
}));
console.log('=== alternatives JSON ===');
console.log(JSON.stringify(alts, null, 2));

const fracTips = (plan.tips ?? []).filter((t) => /fracture|preferFracture/i.test(String(t)));
const fracSteps = (plan.steps ?? []).filter(
  (s) => s.operator === 'preferFracture' || /Prefer fractured/i.test(s.action ?? '')
);
console.log('=== preferFracture tips ===');
console.log(JSON.stringify(fracTips, null, 2));
console.log('=== preferFracture steps ===');
console.log(
  JSON.stringify(
    fracSteps.map((s) => ({
      operator: s.operator,
      action: s.action,
      detail: s.detail,
      preferEnabled: s.preferEnabled,
    })),
    null,
    2
  )
);

const essenceMention = (plan.alternatives ?? []).some((a) =>
  /essence|save|saving/i.test(`${a.name ?? ''} ${a.description ?? ''}`)
);
console.log('=== any alternative mentions essence savings ===');
console.log(essenceMention);
console.log('alt texts:');
for (const a of plan.alternatives ?? []) {
  console.log(`  - ${a.name}: ${a.description}`);
}
