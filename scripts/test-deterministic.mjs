/**
 * Quick node smoke test for deterministic planner (mocks fetch → disk).
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
    // Stub snapshot so method selection + EV work without a live fetch.
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
const { replanFromProgress, modStableKey } = await import('../src/lib/deterministicPlanner.js');
const { collectOccupiedGroups } = await import('../src/lib/spawnWeights.js');

const samples = {
  gloves: `Item Class: Gloves
Rarity: Rare
Doom Palm
Warlock Gloves
--------
Quality: +20% (augmented)
Energy Shield: 95 (augmented)
--------
Requirements:
Level: 69
Int: 101
--------
Sockets: B-B B
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
{ Suffix Modifier "of the Magma" (Tier: 1) — Elemental, Fire, Resistance / Elemental, Lightning, Resistance / Elemental, Cold, Resistance }
+(16-20)% to Fire and Lightning Resistances (crafted)`,

  // Cataclysm Shell–style: Woe flat + hybrid stun/block + Unfaltering %ES + resists
  chest: `Item Class: Body Armours
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
{ Prefix Modifier "Unfaltering" (Tier: 1) — Defences, Energy Shield }
102(101-110)% increased Energy Shield
{ Prefix Modifier "Seraphim's" (Tier: 1) — Defences, Energy Shield }
42(39-42)% increased Energy Shield
(16-17)% increased Stun and Block Recovery
{ Prefix Modifier "Unassailable" (Tier: 1) — Defences, Energy Shield }
+85(80-91) to maximum Energy Shield
{ Suffix Modifier "of the Dragon" (Tier: 2) — Elemental, Fire, Resistance }
+45(42-45)% to Fire Resistance
{ Suffix Modifier "of Grounding" (Tier: 3) — Elemental, Lightning, Resistance }
+36(36-41)% to Lightning Resistance
{ Suffix Modifier "of the Magma" — Elemental, Cold, Resistance / Elemental, Lightning, Resistance }
+(16-20)% to Cold and Lightning Resistances (crafted)`,

  cataclysm: `Item Class: Wands
Rarity: Rare
Cataclysm Needle
Kinetic Wand
--------
Item Level: 85
--------
{ Implicit Modifier }
Cannot roll Caster Modifiers
--------
{ Fractured Prefix Modifier "Zaffre" (Tier: 1) — Mana }
+156(140-159) to maximum Mana
{ Prefix Modifier "Chosen" (Tier: 1) — Damage, Chaos, Attack }
Attacks with this Weapon Penetrate 16(14-16)% Chaos Resistance
{ Master Crafted Prefix Modifier "Upgraded" — Damage, Chaos, Caster }
50(46-50)% increased Spell Damage
Gain 4% of Non-Chaos Damage as extra Chaos Damage
{ Suffix Modifier "of the Essence" — Attack, Speed }
18(17-18)% increased Attack Speed
{ Suffix Modifier "of Ferocity" (Tier: 2) — Damage, Critical }
+31(30-34)% to Global Critical Strike Multiplier
{ Suffix Modifier "of Incision" (Tier: 1) — Attack, Critical }
36(35-38)% increased Critical Strike Chance
--------
Fractured Item`,

  boots: `Item Class: Boots
Rarity: Rare
Gloom March
Warlock Boots
--------
Item Level: 85
--------
{ Prefix Modifier "Essences" — Defences, Energy Shield }
+44(38-45) to maximum Energy Shield
{ Prefix Modifier "Cheetah's" (Tier: 2) — Speed }
30% increased Movement Speed
{ Master Crafted Prefix Modifier "Upgraded" — Mana }
+54(45-54) to maximum Mana
{ Fractured Suffix Modifier "of the Underground" (Tier: 1) }
Has 1 Abyssal Socket
(Only Abyss Jewels can be Socketed in Abyssal Sockets)
{ Suffix Modifier "of the Magma" (Tier: 2) — Elemental, Fire, Resistance }
+42(42-45)% to Fire Resistance
{ Suffix Modifier "of the Virtuoso" (Tier: 2) — Attribute }
+45(43-50) to Intelligence
--------
Fractured Item`,

  warlordQuiver: `Item Class: Quivers
Rarity: Rare
Doom Strike
Broadhead Arrow Quiver
--------
Requirements:
Level: 45
--------
Item Level: 84
--------
Warlord Item
--------
{ Prefix Modifier "Tyrannical" (Tier: 1) — Damage, Physical, Attack }
Adds 21(16-22) to 38(32-38) Physical Damage to Attacks
{ Prefix Modifier "Sharpshooter's" (Tier: 1) — Damage, Critical }
+(35-38)% to Global Critical Strike Multiplier
{ Suffix Modifier "of Skill" (Tier: 1) — Attack, Speed }
(13-14)% increased Attack Speed
{ Suffix Modifier "of the Dragon" (Tier: 2) — Elemental, Fire, Resistance }
+(42-45)% to Fire Resistance
{ Master Crafted Suffix Modifier "of Crafting" }
Can have up to 3 Crafted Modifiers (crafted)
`,

  // Rapture Spear: Doubt + bleed hybrid + fire + dex — must not late-alt after essence
  raptureSpear: `Item Class: Quivers
Rarity: Rare
Rapture Spear
Broadhead Arrow Quiver
--------
Requirements:
Level: 54
--------
Item Level: 85
--------
{ Implicit Modifier — Attack, Speed }
9(8-10)% increased Attack Speed
--------
{ Prefix Modifier "Blasting" (Tier: 2) — Damage, Elemental, Fire, Attack }
Adds 27(27-35) to 60(53-62) Fire Damage to Attacks
{ Suffix Modifier "of the Conquest" (Tier: 2) — Damage, Physical, Attack, Ailment }
Attacks have 10% chance to cause Bleeding
(Bleeding deals Physical Damage over time, based on the base Physical Damage of the Skill. Damage is 200% higher while moving)
24(15-25)% increased Damage with Bleeding
{ Suffix Modifier "of the Marksman" (Tier: 3) — Attack }
+341(251-350) to Accuracy Rating
{ Suffix Modifier "of the Fox" (Tier: 8) — Attribute }
+21(18-22) to Dexterity
--------
Warlord Item`,

  // 3 prefix goals + prefix craft — leftover must not steal craft slot; annul/eldritch before bench if needed
  fullPrefixCraft: `Item Class: Gloves
Rarity: Rare
Doom Palm
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
{ Master Crafted Prefix Modifier "Upgraded" — Mana }
+54(45-54) to maximum Mana
`,

  // Honour Hold: Master Crafted uses (Rank: N) and no (crafted) on the value line
  honourHold: `Item Class: Gloves
Rarity: Rare
Honour Hold
Warlock Gloves
--------
Quality: +20% (augmented)
Energy Shield: 95 (augmented)
--------
Requirements:
Level: 69
Int: 101
--------
Sockets: B-B B
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
Searing Exarch Item
Eater of Worlds Item
`,

  // Heavy Belt: implicit Str must NOT zero explicit Str fish weight
  behemothStrap: `Item Class: Belts
Rarity: Rare
Behemoth Strap
Heavy Belt
--------
Requirements:
Level: 35
--------
Item Level: 86
--------
{ Implicit Modifier — Attribute }
+35(25-35) to Strength
--------
{ Prefix Modifier "Fortified" (Tier: 5) — Defences, Armour }
+113(61-138) to Armour
{ Prefix Modifier "Cerulean" (Tier: 7) — Mana }
+38(35-39) to maximum Mana
{ Suffix Modifier "of the Penguin" (Tier: 6) — Elemental, Cold, Resistance }
+18(18-23)% to Cold Resistance
{ Suffix Modifier "of the Wrestler" (Tier: 9) — Attribute }
+15(13-17) to Strength
`,

  // Magic utility flask: strip affix name from base; Crystal suffix must match with real weights
  quicksilverFlask: `Item Class: Utility Flasks
Rarity: Magic
Quicksilver Flask of the Crystal
--------
Quality: +20%
--------
Requires Level: 4
--------
Item Level: 15
--------
{ Enchantment Modifier }
Used when Charges reach full
--------
{ Suffix Modifier "of the Crystal" (Tier: 3) — Elemental, Resistance }
14(12-14)% additional Elemental Resistances during Effect
`,

  // Hunter quiver: influence DoT multi → mid-craft Hunter exalt; natural DoT + bow/life/MS leftovers
  hunterQuiver: `Item Class: Quivers
Rarity: Rare
Doom Strike
Broadhead Arrow Quiver
--------
Requirements:
Level: 45
--------
Item Level: 86
--------
Hunter Item
--------
{ Prefix Modifier "Archer's" (Tier: 1) — Damage }
50% increased Damage with Bow Skills
{ Prefix Modifier "Prioritising" (Tier: 1) — Life }
+129 to maximum Life
{ Suffix Modifier "of Haemophilia" (Tier: 1) — Damage, Ailment }
+26% to Damage over Time Multiplier with Attack Skills
{ Suffix Modifier "of the Basilisk" (Tier: 1) — Damage, Chaos, Attack, Ailment }
+25% to Chaos Damage over Time Multiplier with Attack Skills
{ Prefix Modifier "Hunter's" (Tier: 1) — Speed }
10% increased Movement Speed
{ Suffix Modifier "of Skill" (Tier: 1) — Attack, Speed }
{crafted}
12% increased Attack Speed
`,

  // Onslaught Bolt: cold fracture + Torment lightning dmg + harvest bow crit multi + lightning res after
  // (must NOT fish lightning res before PCBC → Reforge Critical — that wipes non-fractured suffixes)
  onslaughtBolt: `Item Class: Quivers
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
Fractured Item`,
};

const results = {};
for (const [name, text] of Object.entries(samples)) {
  const item = parseItem(text);
  const plan = await generateCraftSteps(item, null, { skipRecombinator: true });
  results[name] = plan;
  console.log('\n====', name, '====');
  console.log('method:', plan.methodName);
  console.log('minIlvl:', plan.minIlvl, 'cost:', plan.totalCost);
  console.log(
    'mods:',
    plan.modAnalysis.map((m) => `${m.method}:${m.text.split('\n')[0].slice(0, 40)}`).join(' | ')
  );
  for (const s of plan.steps) {
    console.log(`  ${s.step}. [${s.chanceLabel ?? '-'}] ${s.action}`);
  }
  if (plan.alternatives?.length) {
    console.log('alternatives:');
    for (const a of plan.alternatives) {
      console.log(`  - ${a.name} (~${a.totalCost}c) ${a.description}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

// No trade buyout / buyInstead on any sample
for (const [name, plan] of Object.entries(results)) {
  const actions = plan.steps.map((s) => s.action).join('\n');
  assert(!/Buy check/i.test(plan.methodName), `${name}: method must not include Buy check`);
  assert(!/Consider buying this item on trade/i.test(actions), `${name}: no buyInstead trade tip`);
  assert(!plan.steps.some((s) => s.operator === 'buyInstead'), `${name}: no buyInstead step`);
  assert(
    !/compare to buying this item on trade/i.test((plan.tips ?? []).join(' ')),
    `${name}: tips must not push trade buyout`
  );
}

// Chest (multi defence prefix fish): prefer fracture of lowest-weight natural
{
  const plan = results.chest;
  const frac = plan.steps.find((s) => s.operator === 'preferFracture' || /Prefer fractured/i.test(s.action));
  assert(frac, 'chest: should recommend preferFracture');
  assert(frac.preferEnabled !== false, 'chest: preferFracture defaults on');
  // Equal hitWeight defence prefixes: hybrid %ES+stun wins over pure 102% / flat ES
  assert(
    /42% increased Energy Shield/i.test(frac.action) && /Stun and Block Recovery/i.test(frac.action),
    `chest: fracture hybrid defence prefix on equal weight, got: ${frac.action}`
  );
  assert(/hit \d+/i.test(frac.detail ?? ''), `chest: preferFracture detail should show weight, got: ${frac.detail}`);
  assert(/Fracture/i.test(plan.methodName), `chest: method should mention Fracture, got ${plan.methodName}`);
  assert(plan.alternatives?.length >= 1, 'chest: should expose non-fractured alternative');
  const ess = plan.steps.find((s) => /Spam Deafening Essence of Woe/i.test(s.action));
  if (ess) {
    assert(!/\+ 102%.*\+ 42%|\+ 42%.*\+ 102%/i.test(ess.action), 'chest: should not fish both hard prefixes after fracture');
  }

  // Toggle off: preferFracture step stays; craft includes the locked mod again
  const chestItem = parseItem(samples.chest);
  const off = await generateCraftSteps(chestItem, null, { preferFracture: false, skipRecombinator: true });
  const fracOff = off.steps.find((s) => s.operator === 'preferFracture');
  assert(fracOff && fracOff.preferEnabled === false, 'chest: preferFracture step remains when toggled off');
  const essOff = off.steps.find((s) => s.operator === 'essenceFish');
  if (ess && essOff) {
    assert(
      /42%|Stun and Block|Energy Shield/i.test(essOff.action),
      `chest: off fish should include fracture mod, got: ${essOff.action}`
    );
  }
}

// Non-fractured gloves / Honour Hold: prefer fracture of lowest-weight natural (excl. essence flat ES)
{
  for (const name of ['gloves', 'honourHold']) {
    const plan = results[name];
    const frac = plan.steps.find((s) => s.operator === 'preferFracture' || /Prefer fractured/i.test(s.action));
    assert(frac, `${name}: should recommend preferFracture`);
    // Int and cold hybrid both hit 1000; hybrid wins on tie (more specific / multi-stat)
    assert(
      /Cold Resistance/i.test(frac.action) && /Avoid being Chilled|Chilled/i.test(frac.action),
      `${name}: fracture cold hybrid over equal-weight Int, got: ${frac.action}`
    );
    assert(!/Intelligence/i.test(frac.action), `${name}: must not fracture Int when hybrid is equal/rarer`);
    assert(/hit \d+/i.test(frac.detail ?? ''), `${name}: detail should include weight line`);
    assert(!plan.steps.some((s) => s.operator === 'buyFractured'), `${name}: not already fractured`);
    assert(plan.alternatives?.length >= 1, `${name}: non-fractured alternative`);
  }
}

// Already-fractured boots: keep fracture-buy, no preferFracture rewrite
{
  const plan = results.boots;
  assert(plan.steps.some((s) => /Buy fractured/i.test(s.action)), 'boots: keep buy fractured step');
  assert(!plan.steps.some((s) => s.operator === 'preferFracture'), 'boots: no preferFracture when already fractured');
}

// Fractured wand: buy fractured only — no second preferFracture propose
{
  const plan = results.cataclysm;
  assert(plan.steps.some((s) => /Buy fractured/i.test(s.action)), 'cataclysm: keep buy fractured');
  assert(
    !plan.steps.some((s) => s.operator === 'preferFracture' || /Prefer fractured/i.test(s.action)),
    'cataclysm: no extra preferFracture when already fractured'
  );
}

// Cataclysm Needle: hybrid bench full text + harvest-scoped crit weights
{
  const plan = results.cataclysm;
  const bench = plan.steps.find((s) => s.operator === 'bench');
  assert(bench, 'cataclysm: has bench step');
  assert(
    /Extra Chaos Damage/i.test(bench.action) && /Spell Damage/i.test(bench.action),
    `cataclysm: bench action must include full hybrid craft, got: ${bench.action}`
  );
  assert(
    bench.targetMods?.some((t) => /Extra Chaos Damage/i.test(t)),
    `cataclysm: bench targets must include Extra Chaos Damage, got: ${JSON.stringify(bench.targetMods)}`
  );
  const harvestMod = plan.modAnalysis.find((m) => m.method === 'harvest');
  assert(harvestMod, 'cataclysm: one crit should be harvest-acquired');
  assert(
    harvestMod.poolWeight > 0 &&
      harvestMod.poolWeight < 12000 &&
      (harvestMod.hitWeight ?? 0) > 0,
    `cataclysm: harvest pool excludes fished crit multi (expect pool < 12000), got: ${harvestMod.weightLine}`
  );
  const essFish = plan.modAnalysis.find(
    (m) => m.method === 'natural' && /Critical Strike Multiplier/i.test(m.text)
  );
  assert(essFish, 'cataclysm: fished crit multi stays natural (essence fish)');
  assert(
    (essFish.poolWeight ?? 0) > 50000 && (essFish.hitWeight ?? 0) > 0,
    `cataclysm: essence-fished crit has real suffix pool weight, got: ${essFish.weightLine}`
  );
  const unveil = plan.steps.find((s) => s.operator === 'unveil');
  assert(unveil, 'cataclysm: unveil step');
  assert(
    /Veiled Chaos/i.test(unveil.action) && !/Veiled Exalt/i.test(unveil.action),
    `cataclysm: unveil should use Veiled Chaos (suffixes locked, fractured mana only), got: ${unveil.action}`
  );
  assert(!/Bench block/i.test(unveil.action), `cataclysm: no bench block with Veiled Chaos, got: ${unveil.action}`);
  assert(
    /Suffixes Cannot Be Changed/i.test(unveil.action),
    `cataclysm: unveil should SCBC then Veiled Chaos, got: ${unveil.action}`
  );
  assert(unveil.cost?.['veiled-chaos'] > 0, 'cataclysm: cost uses veiled-chaos key');
  assert(!unveil.cost?.veiled, 'cataclysm: should not charge veiled exalt');
  assert(
    /3×|3x/i.test(unveil.chanceLabel ?? '') || /%\/unveil/i.test(unveil.chanceLabel ?? ''),
    `cataclysm: unveil odds show 3× rolls formula, got: ${unveil.chanceLabel}`
  );
}

// Crafted / Master Crafted mods must always be the final step(s)
for (const [name, plan] of Object.entries(results)) {
  const crafted = (plan.modAnalysis ?? []).filter((m) => m.crafted || m.method === 'bench');
  if (!crafted.length) continue;
  assert(plan.steps.length > 0, `${name}: expected steps when crafted mods present`);
  const last = plan.steps[plan.steps.length - 1];
  assert(last.operator === 'bench', `${name}: last step must be bench craft, got ${last.operator}: ${last.action}`);
  assert(/Crafting Bench/i.test(last.action), `${name}: last step should be Crafting Bench`);
  // All bench steps contiguous at the end
  const firstBench = plan.steps.findIndex((s) => s.operator === 'bench');
  assert(
    plan.steps.slice(firstBench).every((s) => s.operator === 'bench'),
    `${name}: all bench crafts must be contiguous at end`
  );
  for (const m of crafted) {
    assert(
      plan.steps.some((s) => s.operator === 'bench' && s.action.includes(m.text.split('\n')[0].slice(0, 24))),
      `${name}: crafted mod must appear in a bench step: ${m.text.split('\n')[0]}`
    );
  }
}

// Harvest method weights use harvest-tagged pool minus occupied groups
{
  const plan = results.cataclysm;
  const harvestMods = (plan.modAnalysis ?? []).filter((m) => m.method === 'harvest');
  assert(harvestMods.length >= 1, 'cataclysm: at least one harvest mod');
  for (const m of harvestMods) {
    assert(/Critical/i.test(m.text), `cataclysm harvest mod should be crit: ${m.text}`);
    assert(
      m.poolWeight > 0 && m.poolWeight < 12000,
      `cataclysm harvest pool should be Reforge Critical minus occupied crit multi (<12000), got ${m.poolWeight} for ${m.text}`
    );
    assert(
      !/pool 12000/.test(m.weightLine ?? '') && !/pool 87959/.test(m.weightLine ?? ''),
      `cataclysm harvest must not use full crit/suffix pool: ${m.weightLine}`
    );
  }
  const fill = plan.steps.find((s) => s.operator === 'harvestFill');
  assert(fill, 'cataclysm: harvestFill step');
  assert(
    /pool \d+/.test(fill.weightLine || fill.chanceLabel || '') &&
      !/pool 12000/.test(fill.weightLine || fill.chanceLabel || ''),
    'cataclysm harvestFill uses reduced tagged pool'
  );
  // Essence fish excludes Zeal AS group from the open suffix pool
  const ess = plan.steps.find((s) => /Essence of Zeal/i.test(s.action));
  assert(ess, 'cataclysm: Zeal essence step');
  assert(
    /pool \d{4,}/.test(ess.chanceLabel || ess.weightLine || ''),
    'cataclysm essence fish reports suffix pool weight'
  );
  // Multi-line bench craft shows full text
  const bench = plan.steps.find((s) => s.operator === 'bench');
  assert(/Gain 4% of Non-Chaos/i.test(bench.action), 'cataclysm bench shows full crafted mod text');
}

// replanFromProgress must never strip the final bench craft (even if marked hit)
{
  const { replanFromProgress, modStableKey } = await import('../src/lib/deterministicPlanner.js');
  const plan = results.cataclysm;
  const keys = new Set();
  const ess = plan.steps.find((s) => s.operator === 'essenceFish');
  for (const t of (ess?.targetMods ?? []).slice(1)) {
    const m = plan.classified.find((c) => c.short === t);
    keys.add(modStableKey(m || t));
  }
  const har = plan.steps.find((s) => s.operator === 'harvestFill');
  for (const t of har?.targetMods ?? []) {
    const m = plan.classified.find((c) => c.short === t);
    keys.add(modStableKey(m || t));
  }
  const item = parseItem(samples.cataclysm);
  const view = await replanFromProgress(item, plan, keys);
  const last = view.steps[view.steps.length - 1];
  assert(last?.operator === 'bench', 'replan fish hits: last step still bench');
  assert(
    /Spell Damage/i.test(last.action) && /Extra Chaos Damage/i.test(last.action),
    `replan fish hits: full hybrid bench text, got: ${last.action}`
  );

  const craft = plan.classified.find((m) => m.crafted || m.method === 'bench');
  keys.add(modStableKey(craft));
  const view2 = await replanFromProgress(item, plan, keys);
  const last2 = view2.steps[view2.steps.length - 1];
  assert(last2?.operator === 'bench', 'replan after bench hit: bench step must remain');
  assert(/Extra Chaos Damage/i.test(last2.action), 'replan after bench hit: full hybrid text remains');
  assert(last2.targetMods?.some((t) => /Extra Chaos/i.test(t)), 'replan after bench hit: targets kept');
  assert(last2.progressDone, 'replan after bench hit: bench marked done');
  // Completed steps stay in the list (greyed in UI), never stripped
  assert(view2.steps.length >= plan.steps.length, 'replan never drops steps when done');
  const doneHar = view2.steps.find((s) => s.operator === 'harvestFill');
  assert(doneHar?.progressDone, 'harvest marked done stays present');
  assert((doneHar?.targetMeta ?? []).length > 0, 'done harvest keeps targets for undo');
}

// Occupied-group exclusion: Reforge Critical pool shrinks when crit multi is already present
{
  const { loadKnowledgeBase, getBaseInfo, effectiveBaseTags } = await import('../src/lib/knowledgeLoader.js');
  const { harvestPoolWeight, collectOccupiedGroups } = await import('../src/lib/spawnWeights.js');
  const { HARVEST_REFORGES, modMatchesHarvest } = await import('../src/lib/craftKnowledge.js');
  const kb = await loadKnowledgeBase();
  const base = getBaseInfo(kb, 'Kinetic Wand');
  const tags = effectiveBaseTags({ implicits: [{ text: 'Cannot roll Caster Modifiers' }] }, base, kb.cannotRoll);
  const h = HARVEST_REFORGES.find((x) => x.id === 'reforge-critical');
  const fullCrit = harvestPoolWeight(kb, tags, 85, 'suffix', h, modMatchesHarvest);
  const multi = kb.natural.find(
    (m) => m.generation === 'suffix' && /Global Critical Strike Multiplier/i.test(m.text || '')
  );
  assert(multi, 'probe: found crit multi mod');
  const reduced = harvestPoolWeight(
    kb,
    tags,
    85,
    'suffix',
    h,
    modMatchesHarvest,
    collectOccupiedGroups([multi])
  );
  assert(fullCrit > 0, `full crit harvest pool expected >0, got ${fullCrit}`);
  assert(reduced > 0 && reduced < fullCrit, `after multi occupied, crit pool shrinks: ${reduced} vs ${fullCrit}`);
  assert(reduced < fullCrit, 'occupied multi must shrink Reforge Critical pool');
}

// Cannot-roll Caster on Kinetic Wand: pools exclude caster-tagged mods
{
  const { loadKnowledgeBase, effectiveBaseTags, resolveCannotRoll } = await import(
    '../src/lib/knowledgeLoader.js'
  );
  const { generationPoolWeight, harvestPoolWeight } = await import('../src/lib/spawnWeights.js');
  const { modMatchesHarvest, HARVEST_REFORGES } = await import('../src/lib/craftKnowledge.js');

  const item = parseItem(samples.cataclysm);
  assert(item.implicits.some((i) => /Cannot roll Caster Modifiers/i.test(i.text)), 'parser: caster implicit present');
  assert(item.cannotRoll.blockedTags.includes('caster'), 'parser: cannotRoll.blockedTags has caster');

  const kb = await loadKnowledgeBase();
  assert(kb.cannotRoll?.length >= 2, 'KB: cannot-roll constraints loaded');
  const base = kb.basesByName['Kinetic Wand'];
  const cr = resolveCannotRoll(item, base, kb.cannotRoll);
  assert(cr.blockedTags.includes('caster'), 'resolveCannotRoll: caster blocked');
  assert(cr.active.some((c) => c.id === 'cannot-roll-caster'), 'resolveCannotRoll: caster constraint active');

  const withBlock = effectiveBaseTags(item, base, kb.cannotRoll);
  const raw = [...(base.tags ?? [])];
  const sufRaw = generationPoolWeight(kb, raw, 85, 'suffix');
  const sufBlocked = generationPoolWeight(kb, withBlock, 85, 'suffix');
  const crit = HARVEST_REFORGES.find((h) => h.id === 'reforge-critical');
  const critRaw = harvestPoolWeight(kb, raw, 85, 'suffix', crit, modMatchesHarvest);
  const critBlocked = harvestPoolWeight(kb, withBlock, 85, 'suffix', crit, modMatchesHarvest);

  assert(sufBlocked < sufRaw, `suffix pool drops with cannot-roll: ${sufBlocked} vs raw ${sufRaw}`);
  assert(critBlocked < critRaw, `crit pool drops with cannot-roll: ${critBlocked} vs raw ${critRaw}`);
  // Absolute pool sizes drift with KB rebuilds; keep relative + no-caster invariant.
  assert(sufBlocked > 0 && critBlocked > 0, 'blocked pools must be positive');
  assert(critRaw === 18000 || critRaw > critBlocked, `crit raw should exceed blocked, raw=${critRaw} blocked=${critBlocked}`);

  let casterInPool = 0;
  for (const mod of kb.natural) {
    if (mod.generation !== 'suffix') continue;
    if ((mod.required_level ?? 0) > 85) continue;
    if (!(mod.tags ?? []).includes('caster')) continue;
    if (kb.weightOnTags(mod, withBlock) > 0) casterInPool++;
  }
  assert(casterInPool === 0, `no caster-tagged suffix mods remain in pool, got ${casterInPool}`);
  console.log(
    `cannot-roll pools ilvl85: suffix ${sufRaw}→${sufBlocked}, crit ${critRaw}→${critBlocked}`
  );
}

// Warlord paste: both buy/slam options; ranked EV uses known-cost orb (no fake 50c premium)
{
  const item = parseItem(samples.warlordQuiver);
  assert(item.influenced?.includes('Warlord'), 'warlordQuiver: parser sees Warlord Item');
  const plan = results.warlordQuiver;
  const base = plan.steps[0];
  assert(base, 'warlordQuiver: has base step');
  assert(/Warlord/i.test(base.action), `warlordQuiver: base action mentions Warlord, got: ${base.action}`);
  assert(/Option A:/i.test(base.detail) && /Option B:/i.test(base.detail), 'warlordQuiver: both options in detail');
  assert(/Warlord'?s Exalted Orb/i.test(base.detail), 'warlordQuiver: Option B names Warlord\'s Exalted Orb');
  assert(/\[recommended\]/i.test(base.action), 'warlordQuiver: marks recommended choice');
  assert(
    /Exalted Orb/i.test(base.action),
    `warlordQuiver: recommend known-cost orb, not fake 50c buy, got: ${base.action}`
  );
  assert(
    !/typical influence premium|INFLUENCED_BASE_PREMIUM/i.test(base.detail ?? ''),
    'warlordQuiver: no invented influence premium in copy'
  );
  assert(!plan.steps.some((s) => /Warlord'?s Exalted Orb/i.test(s.action) && s.operator !== 'buyBase'), 'warlordQuiver: no separate late influence-exalt spam step');
}

// Uninfluenced gloves: no conqueror influence acquisition
{
  const plan = results.gloves;
  const base = plan.steps[0];
  assert(!/Warlord|Redeemer|Crusader|Hunter|Shaper|Elder/i.test(base.action), 'gloves: no influence in base action');
  assert(!/Option A:.*influence/i.test(base.detail ?? ''), 'gloves: no influence options');
}

// Rapture Spear: Warlord bleed via influence slam; no late alt; no essence after slam
{
  const plan = results.raptureSpear;
  assert(plan, 'raptureSpear: plan exists');
  const slamIdx = plan.steps.findIndex((s) => s.operator === 'influenceSlam');
  const essIdx = plan.steps.findIndex((s) => s.operator === 'essenceFish');
  assert(slamIdx >= 0, 'raptureSpear: influenceSlam for Warlord bleed');
  assert(/Warlord'?s Exalted Orb/i.test(plan.steps[slamIdx].action), 'raptureSpear: Warlord exalt');
  assert(
    essIdx < 0 || essIdx < slamIdx,
    `raptureSpear: no essence after influence slam, ess@${essIdx} slam@${slamIdx}`
  );
  assert(
    plan.steps.every((s) => s.operator !== 'altSpam'),
    'raptureSpear: no altSpam once rare/influence path'
  );
  const bleed = (plan.modAnalysis ?? []).find((m) => /Bleeding/i.test(m.text));
  assert(bleed, 'raptureSpear: bleed hybrid in analysis');
  assert(bleed.method === 'influenceSlam', `raptureSpear: bleed via influenceSlam, got ${bleed.method}`);
  assert(
    (bleed.hitWeight ?? 0) > 0 || !/hit 0\b/.test(bleed.weightLine ?? ''),
    `raptureSpear: bleed must have real weight, got ${bleed.weightLine}`
  );
  const dex = (plan.modAnalysis ?? []).find((m) => /Dexterity/i.test(m.text));
  assert(dex, 'raptureSpear: dex present');
  assert(
    dex.method === 'natural' ||
      dex.method === 'fractured' ||
      /essence|fish|exalt|harvest/i.test(dex.method ?? ''),
    `raptureSpear: dex not via late alt, method=${dex.method}`
  );
}

// fullPrefixCraft: 3p goals + prefix craft → reserve craft slot (no blocking exalt); bench last;
// eldritch annul (or metacraft annul) before bench when side is tight after fishing
{
  const plan = results.fullPrefixCraft;
  assert(plan, 'fullPrefixCraft: plan exists');
  const last = plan.steps[plan.steps.length - 1];
  assert(last.operator === 'bench', `fullPrefixCraft: last step bench, got ${last.operator}`);
  assert(/Crafting Bench/i.test(last.action) && /\+54 to maximum Mana/i.test(last.action), 'fullPrefixCraft: mana craft in bench');
  assert(
    !plan.steps.some((s) => s.operator === 'exaltFallback' && /\+35 to maximum Mana/i.test(s.action)),
    'fullPrefixCraft: must not exalt natural mana into the craft slot'
  );
  const space = plan.steps.find((s) => s.operator === 'eldritchAnnul' || s.operator === 'annulForSpace');
  assert(space, 'fullPrefixCraft: annul/eldritch-annul before bench when prefix side tight');
  const spaceIdx = plan.steps.indexOf(space);
  const benchIdx = plan.steps.findIndex((s) => s.operator === 'bench');
  assert(spaceIdx >= 0 && spaceIdx < benchIdx, 'fullPrefixCraft: space-making step before bench');
  assert(/filler|keeper|Annul/i.test(space.detail ?? ''), 'fullPrefixCraft: annul detail explains filler vs keeper odds');
}

// Boots: prefix craft + 2 prefix keepers after essence → Eldritch Annul then bench
{
  const plan = results.boots;
  const last = plan.steps[plan.steps.length - 1];
  assert(last.operator === 'bench', 'boots: last is bench');
  const space = plan.steps.find((s) => s.operator === 'eldritchAnnul' || s.operator === 'annulForSpace');
  assert(space, 'boots: eldritch/annul for craft slot after essence fish');
  assert(plan.steps.indexOf(space) < plan.steps.findIndex((s) => s.operator === 'bench'), 'boots: space before bench');
}

// Rapture Spear (no crafted mod): no bench step
{
  assert(
    !results.raptureSpear.steps.some((s) => s.operator === 'bench'),
    'raptureSpear: no bench when item has no crafted mod'
  );
}

// Honour Hold: (Rank: N) Master Crafted without (crafted) on value line must still be bench
{
  const item = parseItem(samples.honourHold);
  assert(item.crafted?.length === 1, `honourHold: parser must flag 1 crafted mod, got ${item.crafted?.length}`);
  assert(
    /Cold and Lightning/i.test(item.crafted[0].text),
    `honourHold: crafted text is cold+lightning, got ${item.crafted[0].text}`
  );
  assert(
    !/Searing Exarch|Eater of Worlds/i.test(item.crafted[0].text),
    `honourHold: crafted text must not include influence footers, got ${item.crafted[0].text}`
  );
  const plan = results.honourHold;
  const crafted = (plan.modAnalysis ?? []).filter((m) => m.crafted || m.method === 'bench');
  assert(crafted.length >= 1, 'honourHold: ModAnalysis has crafted/bench entry');
  assert(
    crafted.some((m) => /Cold and Lightning/i.test(m.text)),
    'honourHold: crafted entry is cold+lightning resist'
  );
  const last = plan.steps[plan.steps.length - 1];
  assert(last.operator === 'bench', `honourHold: last step bench, got ${last.operator}: ${last.action}`);
  assert(
    /Crafting Bench/i.test(last.action) && /Cold/i.test(last.action) && /Lightning/i.test(last.action),
    `honourHold: bench must craft cold+lightning, got: ${last.action}`
  );
  // Fractured hybrid + Eldritch Int leave a free suffix → no Eldritch Annul before bench
  assert(
    !plan.steps.some((s) => s.operator === 'eldritchAnnul' || s.operator === 'annulForSpace'),
    'honourHold: skip annul when suffix has open slot after fracture + one Eldritch keeper'
  );
  // Mana may exalt on the prefix side, but must never replace/skip the suffix bench
  assert(
    plan.steps.some((s) => s.operator === 'bench'),
    'honourHold: bench step present even if mana is exalted separately'
  );
}

// Behemoth Strap: implicit Str must not zero explicit Str; Dread fish has real Str weight
{
  const plan = results.behemothStrap;
  assert(plan, 'behemothStrap: plan exists');
  const ess = plan.steps.find((s) => s.operator === 'essenceFish');
  assert(ess, `behemothStrap: essenceFish step, got ${plan.steps.map((s) => s.operator).join(',')}`);
  assert(/Dread/i.test(ess.action), `behemothStrap: Dread essence, got ${ess.action}`);
  const str = (plan.classified ?? []).find((m) => /\+15 to Strength/i.test(m.text));
  assert(str, 'behemothStrap: explicit +15 Str classified');
  assert((str.hitWeight ?? 0) > 0, `behemothStrap: explicit Str hitWeight > 0, got ${str.hitWeight}`);
  assert(
    !/hit 0\b/.test(ess.weightLine ?? '') && !/hit 0\b/.test(ess.chanceLabel ?? ''),
    `behemothStrap: essence fish must not show hit 0, got ${ess.chanceLabel} / ${ess.weightLine}`
  );
  assert(
    /Strength/i.test(ess.action) || /Strength/i.test(ess.weightLine ?? '') || /Strength/i.test(ess.chanceLabel ?? ''),
    `behemothStrap: fish mentions Strength, got ${ess.action}`
  );
  // Prefer fracture cold (or other low-weight natural) — not nonsense 5000 ess at 0%
  const attempts = Number(String(ess.chanceLabel ?? '').match(/~(\d+)/)?.[1] ?? 9999);
  assert(attempts < 500, `behemothStrap: essence attempts sane (<500), got ${attempts}`);

  // Implicit Str groups must not occupy for pool math; explicit Str still does
  const occImp = collectOccupiedGroups([
    { text: '+35 to Strength', groups: ['Strength'], implicit: true, method: 'implicit' },
  ]);
  assert(!occImp.has('Strength'), `behemothStrap: implicit must not occupy Strength, got ${[...occImp]}`);
  const occExp = collectOccupiedGroups([
    { text: '+15 to Strength', groups: ['Strength'], method: 'natural' },
  ]);
  assert(occExp.has('Strength'), 'behemothStrap: explicit Str still occupies');

  // Progress: mark fracture hit — Str must keep positive weight (not scored on prefix pool)
  const frac = plan.steps.find((s) => s.operator === 'preferFracture');
  assert(frac, 'behemothStrap: preferFracture step');
  const fracMod = (plan.classified ?? []).find(
    (m) => m.short === frac.targetMods?.[0] || m.text === frac.targetMods?.[0]
  );
  const hitKeys = new Set([modStableKey(fracMod || frac.targetMods?.[0])]);
  const view = await replanFromProgress(parseItem(samples.behemothStrap), plan, hitKeys);
  const ess2 = view.steps.find((s) => s.operator === 'essenceFish');
  assert(ess2, 'behemothStrap: essenceFish after fracture progress');
  assert(
    !/hit 0\b/.test(ess2.weightLine ?? '') && !/hit 0\b/.test(ess2.chanceLabel ?? ''),
    `behemothStrap: after fracture progress no hit 0, got ${ess2.chanceLabel} / ${ess2.weightLine}`
  );
  const att2 = Number(String(ess2.chanceLabel ?? '').match(/~(\d+)/)?.[1] ?? 9999);
  assert(att2 < 500, `behemothStrap: after progress attempts sane, got ${att2}`);
}

// Magic Quicksilver Flask: baseName strip, Crystal hit/pool, enchant stays enchant
{
  const item = parseItem(samples.quicksilverFlask);
  assert(item.baseName === 'Quicksilver Flask', `quicksilverFlask: baseName, got ${item.baseName}`);
  assert(
    item.enchants?.some((e) => /Used when Charges reach full/i.test(e.text)),
    'quicksilverFlask: enchant parsed'
  );
  assert(
    !item.explicitMods.some((m) => /Used when Charges/i.test(m.text)),
    'quicksilverFlask: enchant not in explicits'
  );
  const plan = results.quicksilverFlask;
  assert(plan, 'quicksilverFlask: plan exists');
  const crystal = (plan.modAnalysis ?? []).find((m) => /Elemental Resistances during Effect/i.test(m.text));
  assert(crystal?.matched, 'quicksilverFlask: Crystal matched');
  assert((crystal.hitWeight ?? 0) > 0, `quicksilverFlask: hitWeight > 0, got ${crystal.hitWeight}`);
  assert((crystal.poolWeight ?? 0) > crystal.hitWeight, `quicksilverFlask: pool > hit, got ${crystal.weightLine}`);
  assert(/hit 750\b/.test(crystal.weightLine ?? ''), `quicksilverFlask: Crystal weight 750, got ${crystal.weightLine}`);
  const enchant = (plan.modAnalysis ?? []).find((m) => m.type === 'enchant' || m.enchant);
  assert(enchant && /Used when Charges reach full/i.test(enchant.text), 'quicksilverFlask: enchant in analysis');
  assert(
    plan.steps.some((s) => s.operator === 'altSpam' || /Alt for/i.test(s.action ?? '')),
    'quicksilverFlask: alt for Crystal'
  );
  assert(
    !plan.steps.some((s) => /Quicksilver Flask of the Crystal/i.test(s.action ?? '')),
    'quicksilverFlask: steps use stripped base name'
  );
}

// No planned fish/harvest goal should advertise hit 0 as a success path
{
  for (const [name, plan] of Object.entries(results)) {
    for (const s of plan.steps ?? []) {
      if (!/essenceFish|harvestFill|eldritchChaos/.test(s.operator ?? '')) continue;
      if (s.progressDone) continue;
      const blob = `${s.chanceLabel ?? ''} ${s.weightLine ?? ''} ${s.detail ?? ''}`;
      assert(
        !/100%\/hit/.test(blob) || !/hit 0\b/.test(blob),
        `${name} ${s.operator}: must not claim 100% with hit 0`
      );
      // Active fish with only hit 0 goals should be skipped (label), not spammed to 5000
      if (/hit 0\b/.test(blob) && /~5000/.test(blob)) {
        throw new Error(`${name} ${s.operator}: must not plan ~5000 for hit-0 goals: ${s.chanceLabel}`);
      }
    }
  }
}

// Hunter quiver: influence exalt slam before harvest; never preferFracture the influence mod / buy Hunter fractured
{
  const plan = results.hunterQuiver;
  assert(plan, 'hunterQuiver: plan exists');
  const slamIdx = plan.steps.findIndex((s) => s.operator === 'influenceSlam');
  const prepIdx = plan.steps.findIndex((s) => s.operator === 'influencePrep');
  const cleanIdx = plan.steps.findIndex((s) => s.operator === 'influenceClean');
  const harvestIdx = plan.steps.findIndex((s) => s.operator === 'harvestFill');
  const essIdx = plan.steps.findIndex((s) => s.operator === 'essenceFish');
  const crIdx = plan.steps.findIndex((s) => s.operator === 'cannotRollAssist');
  assert(slamIdx >= 0, 'hunterQuiver: has influenceSlam step');
  assert(prepIdx >= 0 && prepIdx < slamIdx, 'hunterQuiver: influencePrep before slam');
  assert(cleanIdx > slamIdx, 'hunterQuiver: influenceClean after slam');
  assert(
    harvestIdx < 0 || slamIdx < harvestIdx,
    'hunterQuiver: influence exalt before harvest'
  );
  assert(
    essIdx < 0 || essIdx < slamIdx,
    `hunterQuiver: no essenceFish after influenceSlam (essence wipes influence), got ess@${essIdx} slam@${slamIdx}`
  );
  assert(/Hunter'?s Exalted Orb/i.test(plan.steps[slamIdx].action), 'hunterQuiver: Hunter exalt named');
  assert(
    /Chaos Damage over Time Multiplier with Attack/i.test(plan.steps[slamIdx].action),
    'hunterQuiver: slam targets chaos DoT multi'
  );
  assert(/hit 500 \/ pool 4500/i.test(plan.steps[slamIdx].weightLine ?? plan.steps[slamIdx].chanceLabel ?? ''), 
    `hunterQuiver: influence-only pool odds, got ${plan.steps[slamIdx].chanceLabel}`);
  const base = plan.steps[0];
  assert(
    /uninfluenced/i.test(base.action) && !/Buy (fractured )?Hunter/i.test(base.action),
    `hunterQuiver: uninfluenced base (not buy Hunter), got: ${base.action}`
  );
  const frac = plan.steps.find((s) => s.operator === 'preferFracture');
  if (frac) {
    assert(
      !/Chaos Damage over Time Multiplier/i.test((frac.targetMods ?? []).join(' ')),
      'hunterQuiver: preferFracture must not lock influence DoT multi'
    );
    assert(/uninfluenced/i.test(frac.action), `hunterQuiver: fracture stays uninfluenced, got: ${frac.action}`);
    assert(
      /Damage over Time Multiplier with Attack Skills/i.test(frac.action),
      `hunterQuiver: prefer slam-side natural DoT multi fracture, got: ${frac.action}`
    );
  }
  const dot = (plan.modAnalysis ?? []).find((m) => /Chaos Damage over Time Multiplier with Attack/i.test(m.text));
  assert(dot && dot.method === 'influenceSlam', `hunterQuiver: DoT via influenceSlam, got ${dot?.method}`);
  const natDot = (plan.modAnalysis ?? []).find(
    (m) => /Damage over Time Multiplier with Attack Skills/i.test(m.text) && !/Chaos/i.test(m.text)
  );
  assert(
    natDot && (natDot.method === 'fractured' || natDot.method === 'natural'),
    `hunterQuiver: natural DoT locked before/with slam (not harvest), got ${natDot?.method}`
  );
  assert(
    !plan.steps.some(
      (s) =>
        s.operator === 'harvestFill' &&
        /Damage over Time Multiplier with Attack Skills/i.test((s.targetMods ?? []).join(' '))
    ),
    'hunterQuiver: no harvestFill for natural DoT multi after slam'
  );
  assert(crIdx > cleanIdx, `hunterQuiver: cannot-roll assist after influence clean, got cr@${crIdx} clean@${cleanIdx}`);
  assert(/Cannot roll Attack/i.test(plan.steps[crIdx].action), `hunterQuiver: cannot-roll attack named, got ${plan.steps[crIdx].action}`);
  const exaltAfter = plan.steps.filter((s) => s.step > crIdx && s.operator === 'exaltFallback');
  assert(exaltAfter.length >= 2, `hunterQuiver: exalt leftovers after cannot-roll, got ${exaltAfter.length}`);
  assert(
    plan.steps.some((s) => s.operator === 'bench' && /Attack Speed/i.test(s.action)),
    'hunterQuiver: bench AS last'
  );
  assert(
    plan.totalCost == null || plan.totalCost < 20000,
    `hunterQuiver: total cost should drop below harvest-divine ~52k, got ${plan.totalCost}`
  );

  // preferFracture off: explicit alt for natural DoT before influencePrep
  const off = await generateCraftSteps(parseItem(samples.hunterQuiver), null, { preferFracture: false, skipRecombinator: true });
  const altIdx = off.steps.findIndex(
    (s) =>
      s.operator === 'altSpam' &&
      /Damage over Time Multiplier with Attack Skills/i.test(s.action) &&
      /slam-side keeper/i.test(s.action)
  );
  const offPrep = off.steps.findIndex((s) => s.operator === 'influencePrep');
  assert(altIdx >= 0 && altIdx < offPrep, `hunterQuiver off: alt DoT before prep, alt@${altIdx} prep@${offPrep}`);
  assert(
    !off.steps.some(
      (s) =>
        s.operator === 'harvestFill' &&
        /Damage over Time Multiplier with Attack Skills/i.test((s.targetMods ?? []).join(' '))
    ),
    'hunterQuiver off: no harvest for DoT multi'
  );
  const offCr = off.steps.findIndex((s) => s.operator === 'cannotRollAssist');
  const offClean = off.steps.findIndex((s) => s.operator === 'influenceClean');
  assert(offCr > offClean, 'hunterQuiver off: cannot-roll after clean');
}

// Onslaught Bolt: cold fracture → Torment (prefix only) → harvest/block crit → finish light res after
{
  const plan = results.onslaughtBolt;
  assert(plan, 'onslaughtBolt: plan exists');
  const ess = plan.steps.find((s) => s.operator === 'essenceFish');
  const harvest = plan.steps.find((s) => s.operator === 'harvestFill');
  const cannotRoll = plan.steps.find((s) => s.operator === 'cannotRollAssist');
  assert(ess, 'onslaughtBolt: Torment essence step');
  assert(/Torment/i.test(ess.action), `onslaughtBolt: Torment essence, got: ${ess.action}`);
  assert(
    !/Lightning Resistance/i.test(ess.action) &&
      !(ess.targetMods ?? []).some((t) => /Lightning Resistance/i.test(t)),
    `onslaughtBolt: must not fish Lightning Res before a suffix wipe, got: ${ess.action}`
  );
  // Crit via harvest (PCBC→Reforge Critical) OR cannot-roll + exalt — never fish it away then wipe
  assert(
    (harvest && /Prefixes Cannot Be Changed/i.test(harvest.action) && /Reforge Critical/i.test(harvest.action)) ||
      cannotRoll,
    `onslaughtBolt: expected harvest crit or cannot-roll assist, got harvest=${!!harvest} cannotRoll=${!!cannotRoll}`
  );
  if (harvest) assert(ess.step < harvest.step, 'onslaughtBolt: essence before harvest');
  const afterGate = harvest?.step ?? cannotRoll?.step ?? ess.step;
  const lightAfter = plan.steps.find(
    (s) =>
      s.step > afterGate &&
      (/Lightning Resistance/i.test(s.action) ||
        (s.targetMods ?? []).some((t) => /Lightning Resistance/i.test(t)))
  );
  assert(lightAfter, 'onslaughtBolt: Lightning Res finished after reforge/block gate');
  assert(
    !plan.steps.some((s) => /Redeemer|Warlord|Hunter|Crusader|Shaper|Elder/i.test(s.action)),
    'onslaughtBolt: no phantom influence recommendation'
  );
  assert(
    plan.steps.some((s) => /Buy fractured/i.test(s.action) && /Cold Resistance/i.test(s.action)),
    'onslaughtBolt: buy fractured cold'
  );
}

// Regression: never list a wiped-side keeper as a pre-reforge fish target
{
  for (const [name, plan] of Object.entries(results)) {
    for (const h of plan.steps ?? []) {
      if (h.operator !== 'harvestFill' && h.operator !== 'eldritchChaos') continue;
      if (h.progressDone) continue;
      const wipeGen =
        h.rerollSide ||
        (/Prefixes Cannot Be Changed/i.test(h.action)
          ? 'suffix'
          : /Suffixes Cannot Be Changed/i.test(h.action)
            ? 'prefix'
            : /for suffixes/i.test(h.action)
              ? 'suffix'
              : /for prefixes/i.test(h.action)
                ? 'prefix'
                : null);
      if (!wipeGen) continue;
      for (const s of plan.steps ?? []) {
        if (s.step >= h.step) continue;
        if (s.operator !== 'essenceFish') continue;
        for (const t of s.targetMods ?? []) {
          const mod = (plan.modAnalysis ?? []).find((m) => shortMatch(m, t));
          const gen =
            mod?.type === 'prefix' || mod?.gen === 'prefix'
              ? 'prefix'
              : mod?.type === 'suffix' || mod?.gen === 'suffix'
                ? 'suffix'
                : inferGenFromAnalysis(plan, t);
          if (gen === wipeGen) {
            throw new Error(
              `ASSERT: ${name}: essenceFish targets "${t}" on ${wipeGen}s before ${h.operator} that wipes that side`
            );
          }
        }
      }
    }
  }
}

function shortMatch(m, t) {
  const a = String(m?.text ?? '').split('\n')[0].trim();
  const b = String(t ?? '').trim();
  return a && b && (a.includes(b.slice(0, 24)) || b.includes(a.slice(0, 24)));
}

function inferGenFromAnalysis(plan, t) {
  const m = (plan.modAnalysis ?? []).find((x) => shortMatch(x, t));
  if (!m) return null;
  if (m.gen === 'prefix' || m.gen === 'suffix') return m.gen;
  // Heuristic from common suffix labels when gen missing on analysis
  if (/Resistance|Critical|Attack Speed|Intelligence|Dexterity|Strength|Accuracy/i.test(t)) return 'suffix';
  return null;
}

console.log('\nOK: sequential assertions passed');

{
  const plan = await generateCraftSteps(parseItem(samples.gloves));
  assert(plan.methodComparison, 'gloves recomb: methodComparison present');
  assert(plan.methodComparison.sequential && plan.methodComparison.recombinator, 'gloves recomb: both methods scored');
  if (plan.method === 'recombinator' || /Recombinator/i.test(plan.methodName ?? '')) {
    assert(
      plan.steps.some((s) => s.operator === 'recombDonor'),
      'gloves recomb: donor stages in plan'
    );
    assert(
      plan.steps.some((s) => s.operator === 'recombine'),
      'gloves recomb: recombine step'
    );
    assert(plan.steps.some((s) => s.operator === 'bench'), 'gloves recomb: bench last still present');
  }
}

{
  const plan = await generateCraftSteps(parseItem(samples.honourHold));
  const last = plan.steps[plan.steps.length - 1];
  assert(last.operator === 'bench', 'honourHold recomb path: bench last');
  assert(/Cold/i.test(last.action) && /Lightning/i.test(last.action), 'honourHold recomb path: hybrid bench text');
}

{
  const plan = await generateCraftSteps(parseItem(samples.onslaughtBolt));
  assert(plan.methodComparison, 'onslaughtBolt: comparison present');
}

{
  const { harvestEligiblePool } = await import('../src/lib/spawnWeights.js');
  const { HARVEST_REFORGES, modMatchesHarvest } = await import('../src/lib/craftKnowledge.js');
  const { loadKnowledgeBase, getBaseInfo, effectiveBaseTags } = await import('../src/lib/knowledgeLoader.js');
  const item = parseItem(samples.cataclysm);
  const plan = await generateCraftSteps(item);
  assert(plan.methodComparison, 'wand-like: methodComparison present');
  const recombWon = plan.method === 'recombinator' || /Recombinator/i.test(plan.methodName ?? '');
  const seqCost = plan.methodComparison.sequential?.cost;
  const recCost = plan.methodComparison.recombinator?.cost;
  assert(
    !recombWon,
    `wand-like: sequential/entropy chain should win vs recomb (seq=${seqCost} recomb=${recCost} method=${plan.methodName})`
  );
  assert(
    /sequential|fracture/i.test(plan.methodComparison.winner ?? ''),
    `wand-like: winner sequential/fracture, got ${plan.methodComparison.winner}`
  );
  assert(
    /anecdotal|floor|\?×|unveil|entropy|protect|pool collapse/i.test(plan.methodComparison.recombinator?.why ?? ''),
    `wand-like: recomb loss reason from V, got ${plan.methodComparison.recombinator?.why}`
  );
  assert(
    !plan.steps.some(
      (s) =>
        s.operator === 'recombDonor' &&
        /Penetrate .+ Chaos|Chaos Resistance/i.test(`${s.action} ${(s.targetMods ?? []).join(' ')}`)
    ),
    'wand-like: Chaos Pen must not be stuffed into a recomb donor'
  );
  const unveil = plan.steps.find((s) => s.operator === 'unveil');
  assert(unveil, 'wand-like: Chaos Pen via unveil');
  assert(/Penetrate .+ Chaos|Chaos Resistance/i.test(unveil.action), `wand-like: unveil targets chaos pen, got ${unveil.action}`);
  const fill = plan.steps.find((s) => s.operator === 'harvestFill');
  assert(fill, 'wand-like: harvestFill present');
  assert(/eligible .*\bpool\b/i.test(fill.detail ?? ''), `wand-like: harvest prints eligible pool, got ${fill.detail}`);
  assert((fill.eligiblePool?.length ?? 0) > 0, 'wand-like: eligiblePool candidates listed');

  const kb = await loadKnowledgeBase();
  const base = getBaseInfo(kb, item.baseName);
  const tags = effectiveBaseTags(item, base, kb.cannotRoll);
  const harvest = HARVEST_REFORGES.find((h) => h.id === 'reforge-critical');
  const critMulti = (plan.classified ?? []).find((m) => /Critical Strike Multiplier/i.test(m.text));
  const occ = collectOccupiedGroups([critMulti].filter(Boolean));
  const before = harvestEligiblePool(kb, tags, 85, 'suffix', harvest, modMatchesHarvest, []);
  const after = harvestEligiblePool(kb, tags, 85, 'suffix', harvest, modMatchesHarvest, occ);
  assert(
    after.total < before.total,
    `wand-like: occupied crit family shrinks harvest pool ${before.total} → ${after.total}`
  );
  assert(
    !after.rows.some((r) => /Critical Strike Multiplier/i.test(r.text)),
    'wand-like: occupied crit multi line removed from current-state pool'
  );
  const pChance =
    after.total > 0
      ? after.rows.filter((r) => /Critical Strike Chance/i.test(r.text)).reduce((s, r) => s + r.weight, 0) /
        after.total
      : 0;
  if (after.rows.length && after.rows.every((r) => /Critical Strike Chance/i.test(r.text))) {
    assert(pChance > 0.98, `wand-like: collapsed crit pool P(other crit)=${pChance}`);
  }
  assert(
    !/Deterministic/i.test(plan.summary ?? ''),
    `wand-like: must not be labeled Deterministic, got ${plan.summary}`
  );
  assert(plan.rulesetVersion, 'wand-like: plan reports ruleset version');
  assert(plan.methodComparison.recombinator?.experimental, 'wand-like: recomb EV marked experimental');
  assert(
    !/50c typical|INFLUENCED_BASE_PREMIUM/.test(`${plan.summary} ${plan.steps.map((s) => s.detail).join(' ')}`),
    'wand-like: no 50c influence premium in ranked copy'
  );
}

{
  const det = [
    readFileSync(join(root, 'src/lib/deterministicPlanner.js'), 'utf8'),
    readFileSync(join(root, 'src/lib/planner/scaffold/assignAndBuild.js'), 'utf8'),
    readFileSync(join(root, 'src/lib/planner/scaffold/helpers.js'), 'utf8'),
    readFileSync(join(root, 'src/lib/planner/scaffold/replan.js'), 'utf8'),
  ].join('\n');
  const val = readFileSync(join(root, 'src/lib/craftValue.js'), 'utf8');
  assert(!/Kinetic Wand|Cataclysm Needle|3P\+2S/.test(det + val), 'no hardcoded wand / 3P+2S recipe');
}

const { runRecombinatorTests } = await import('./test-recombinator.mjs');
runRecombinatorTests();
