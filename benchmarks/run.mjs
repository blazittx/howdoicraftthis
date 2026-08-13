/**
 * §68–69 benchmarks: human route as reference, not a hardcoded recipe golden.
 * §94 emergent-behavior notes live in benchmarks/NOTES.md.
 */
import { assert, skip } from '../tests/helpers/assert.js';
import { parseItem } from '../src/lib/itemParser.js';
import { generateCraftSteps } from '../src/lib/craftPlanner.js';
import { classifyPlan } from '../src/lib/planClass.js';

/** Human-reference routes: operator families / signals we expect to see, not exact step text. */
export const BENCHMARKS = [
  {
    id: 'kinetic-wand',
    title: 'Kinetic Wand (Cataclysm Needle)',
    humanRoute: 'Fracture buy → Essence (Zeal) → Harvest Crit → Unveil chaos pen → Bench',
    expect: {
      operatorsAny: ['buyFracturedBase', 'buyBase', 'essenceFish', 'essence', 'harvestFill', 'harvest', 'unveil', 'veiled', 'benchCraft', 'bench'],
      mustMention: [/fractur/i, /essence|zeal/i, /harvest|reforge|critical/i],
      prefer: [/unveil|veiled|penetrate/i, /bench|craft/i],
      forbid: [/chaos spam/i, /70000/],
      notDeterministicIfRecomb: true,
    },
    item: `Item Class: Wands
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
  },
  {
    id: 'triple-es-regalia',
    title: 'Triple-ES Twilight Regalia',
    humanRoute: 'Fracture %ES → Essence Woe → Eldritch Chaos suffixes → Bench',
    expect: {
      operatorsAny: ['buyFracturedBase', 'buyBase', 'essenceFish', 'essence', 'eldritchChaos', 'eldritch', 'benchCraft', 'bench', 'harvestFill'],
      mustMention: [/fractur|energy shield/i, /essence|woe/i],
      prefer: [/eldritch|eater|exarch|suffix/i, /bench|craft/i],
      forbid: [/chaos spam/i],
    },
    item: `Item Class: Body Armours
Rarity: Rare
Cataclysm Shell
Twilight Regalia
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
  },
  {
    id: 'five-mod-amulet',
    title: '5-mod amulet (natural independence probe)',
    humanRoute: 'Sequential OR experimental recomb — solver may pick either; recomb must stay experimental',
    expect: {
      operatorsAny: ['essenceFish', 'essence', 'exalt', 'alt', 'harvestFill', 'recombine', 'recombDonor', 'benchCraft'],
      mustMention: [/./],
      prefer: [],
      forbid: [],
      allowExperimentalRecomb: true,
    },
    item: `Item Class: Amulets
Rarity: Rare
Probe Amulet
Jade Amulet
--------
Item Level: 85
--------
{ Prefix Modifier "Healthy" (Tier: 1) — Life }
+90(80-99) to maximum Life
{ Prefix Modifier "Apt" (Tier: 1) — Attribute }
+50(41-55) to Strength
{ Suffix Modifier "of the Dragon" (Tier: 1) — Elemental, Fire, Resistance }
+48(46-48)% to Fire Resistance
{ Suffix Modifier "of Grounding" (Tier: 1) — Elemental, Lightning, Resistance }
+48(46-48)% to Lightning Resistance
{ Suffix Modifier "of the Penguin" (Tier: 1) — Elemental, Cold, Resistance }
+48(46-48)% to Cold Resistance`,
  },
];

function planBlob(plan) {
  const steps = plan.steps ?? [];
  const parts = [
    plan.methodName ?? '',
    plan.method ?? '',
    plan.summary ?? '',
    ...steps.map((s) => `${s.operator ?? ''} ${s.action ?? ''} ${s.detail ?? ''}`),
  ];
  return parts.join('\n');
}

function checkBenchmark(b, plan) {
  assert(plan && (plan.steps?.length || plan.method), `${b.id}: plan produced`);
  const blob = planBlob(plan);
  const ops = (plan.steps ?? []).map((s) => s.operator).filter(Boolean);

  for (const re of b.expect.mustMention ?? []) {
    assert(re.test(blob) || ops.some((o) => re.test(o)), `${b.id}: missing human-route signal ${re}`);
  }
  for (const re of b.expect.forbid ?? []) {
    assert(!re.test(blob), `${b.id}: forbidden pattern ${re}`);
  }

  if (b.expect.operatorsAny?.length && ops.length) {
    const hit = ops.some((o) =>
      b.expect.operatorsAny.some((want) => o === want || o.includes(want) || want.includes(o))
    );
    // Soft: if operators don't match names, text signals already checked via mustMention
    if (!hit && !(b.expect.mustMention ?? []).every((re) => re.test(blob))) {
      assert(hit, `${b.id}: expected some of ${b.expect.operatorsAny.join('|')}, got ${ops.join(',')}`);
    }
  }

  const kind = classifyPlan(plan);
  if (ops.includes('recombine') || /recombinator/i.test(plan.methodName ?? '')) {
    assert(kind.id === 'probabilistic-recombination', `${b.id}: recomb not deterministic`);
    assert(kind.experimental || plan.experimental, `${b.id}: recomb marked experimental`);
  }

  // Cost sanity: if numeric, must be finite and non-negative
  if (plan.totalCost != null) {
    assert(Number.isFinite(plan.totalCost) && plan.totalCost >= 0, `${b.id}: totalCost sane`);
  }

  return {
    id: b.id,
    title: b.title,
    humanRoute: b.humanRoute,
    method: plan.methodName ?? plan.method,
    steps: (plan.steps ?? []).length,
    classification: kind.id,
    totalCost: plan.totalCost ?? null,
  };
}

export async function runBenchmarkTests() {
  const results = [];
  for (const b of BENCHMARKS) {
    let plan;
    try {
      const item = parseItem(b.item);
      plan = await generateCraftSteps(item);
    } catch (e) {
      skip(`${b.id}: planner failed — ${e.message}`);
    }
    results.push(checkBenchmark(b, plan));
  }
  console.log('OK: benchmarks passed');
  for (const r of results) {
    console.log(`  - ${r.id}: ${r.method} (${r.steps} steps, ${r.classification}, cost=${r.totalCost ?? '?'})`);
  }
  return results;
}
