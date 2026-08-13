/**
 * Validate wipe rule + Honour Hold without full test suite.
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = [];
const say = (s) => {
  log.push(s);
  console.log(s);
};

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

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const honourHold = `Item Class: Gloves
Rarity: Rare
Honour Hold
Warlock Gloves
--------
Item Level: 85
--------
{ Prefix Modifier "Mirrored" (Tier: 4) — Defences, Energy Shield }
74(68-79)% increased Energy Shield
{ Prefix Modifier "Apprentice's" (Tier: 7) — Mana }
+35(30-35) to maximum Mana
{ Prefix Modifier "Protective" (Tier: 2) — Defences, Energy Shield }
+48(44-50) to maximum Energy Shield
{ Suffix Modifier "of Puhuarte" (Tier: 1) — Damage, Elemental, Cold, Resistance }
+25(21-25)% to Cold Resistance
(16-18)% chance to Avoid being Chilled
{ Suffix Modifier "of the Genius" (Tier: 1) — Attribute }
+48(43-50) to Intelligence
{ Master Crafted Suffix Modifier "of Craft" (Rank: 3) — Elemental, Cold, Lightning, Resistance }
+20(17-20)% to Cold and Lightning Resistances
`;

const onslaughtBolt = `Item Class: Quivers
Rarity: Rare
Onslaught Bolt
Broadhead Arrow Quiver
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

try {
  // Honour Hold parser + plan
  const hhItem = parseItem(honourHold);
  assert(hhItem.crafted?.length === 1, 'hh crafted count');
  assert(/Cold and Lightning/i.test(hhItem.crafted[0].text), 'hh crafted text');
  assert(!/Exarch|Eater|Redeemer|Warlord/i.test(hhItem.crafted[0].text), 'hh no footer glue');
  const hh = await generateCraftSteps(hhItem);
  say(`honourHold cost=${hh.totalCost}`);
  for (const s of hh.steps) say(`  ${s.step}. ${s.action}`);
  assert(
    hh.steps.some((s) => /Cold Resistance/i.test(s.action) && /Avoid being Chilled/i.test(s.action)),
    'hh fracture cold hybrid'
  );
  assert(!hh.steps.some((s) => s.operator === 'eldritchAnnul'), 'hh no annul when slot free');
  assert(hh.steps.at(-1)?.operator === 'bench', 'hh bench last');
  say('honourHold: GREEN');

  const plan = await generateCraftSteps(parseItem(onslaughtBolt));
  say(`\nonslaughtBolt method=${plan.methodName} cost=${plan.totalCost}`);
  for (const s of plan.steps) say(`  ${s.step}. [${s.chanceLabel ?? '-'}] ${s.action}`);
  const ess = plan.steps.find((s) => s.operator === 'essenceFish');
  const harvest = plan.steps.find((s) => s.operator === 'harvestFill');
  assert(ess && /Torment/i.test(ess.action), 'torment');
  assert(!/Lightning Resistance/i.test(ess.action), 'no light res fish');
  assert(!(ess.targetMods ?? []).some((t) => /Lightning Resistance/i.test(t)), 'no light res target');
  assert(harvest && /Prefixes Cannot Be Changed/i.test(harvest.action) && /Reforge Critical/i.test(harvest.action), 'pcbc crit');
  assert(ess.step < harvest.step, 'order');
  assert(
    plan.steps.some(
      (s) =>
        s.step > harvest.step &&
        (/Lightning Resistance/i.test(s.action) || (s.targetMods ?? []).some((t) => /Lightning Resistance/i.test(t)))
    ),
    'light res after harvest'
  );
  assert(!plan.steps.some((s) => /Redeemer|Warlord|Hunter|Crusader|Shaper|Elder/i.test(s.action)), 'no influence');
  say('onslaughtBolt: GREEN');
  say(`\nOK probe passed (EV ~${Math.round(plan.totalCost)}c)`);
  writeFileSync(join(root, 'scripts/_tmp-wipe-probe-out.txt'), log.join('\n'));
} catch (e) {
  say(String(e && e.stack ? e.stack : e));
  writeFileSync(join(root, 'scripts/_tmp-wipe-probe-out.txt'), log.join('\n'));
  process.exitCode = 1;
}
