/**
 * Layer B optimizer + §93 EV tests + Phase 5 pricing/schema. Run via scripts/test-phase1.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { essenceFishExpected } from '../src/lib/spawnWeights.js';
import { salvageValue } from '../src/lib/craftValue.js';
import { considerRecombinator } from '../src/lib/recombinatorSearch.js';
import { recombine } from '../src/lib/recombinatorModel.js';
import { makeState, makeAffix } from '../src/lib/craftState.js';
import { recommendInfluenceAcquisition } from '../src/lib/craftKnowledge.js';
import { multiDimensionCost, formatMultiCost, tradableChaosCost } from '../src/lib/pricing/costs.js';
import { lookupItemTradePrice } from '../src/lib/pricing/trade.js';
import { assemblePlan, buildConfidence, buildRejectedStrategies } from '../src/lib/planSchema.js';
import { classifyPlan } from '../src/lib/planClass.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function fakeMod(text, gen, extra = {}) {
  return {
    text,
    short: text,
    gen,
    groups: extra.groups ?? [extra.id ?? text],
    fractured: !!extra.fractured,
    ...extra,
  };
}

export async function runOptimizerTests(kb) {
  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const asGoal = kb.natural.find((m) => m.generation === 'suffix' && /Attack Speed/i.test(m.text || ''));
  if (asGoal) {
    const fish = essenceFishExpected(kb, tags, 85, 'suffix', [{ ...asGoal, gen: 'suffix', text: asGoal.text }], 2, []);
    if (fish.pAll > 0 && fish.pAll < 1) {
      const exact = 1 / fish.pAll;
      assert(
        Math.abs(fish.expected - Math.min(exact, 5000)) < 1e-6,
        `essence EV uses 1/p not ceil: expected=${fish.expected} 1/p=${exact}`
      );
      assert(fish.expected !== Math.ceil(exact) || exact === Math.ceil(exact), 'not forced to ceil unless already int');
    }
  }

  assert(salvageValue(100, 40) === 60, 'salvageValue = V(start)-V(S)');
  assert(salvageValue(100, 150) === 0, 'salvageValue floors at 0');

  const src = [
    readFileSync(join(root, 'src/lib/craftOperators.js'), 'utf8'),
    readFileSync(join(root, 'src/lib/craftSearch.js'), 'utf8'),
    readFileSync(join(root, 'src/lib/craftKnowledge.js'), 'utf8'),
  ].join('\n');
  assert(!/guessEssenceName/.test(src), 'guessEssenceName removed');
  assert(!/effectively guaranteed/.test(src), 'no hardcoded crit guaranteed');
  assert(!/INFLUENCED_BASE_PREMIUM/.test(src), 'no 50c influence premium constant');
  assert(!/\b(15|20|40) essences expected/.test(src), 'no fixed 15/20/40 essence counts');

  const acq = recommendInfluenceAcquisition(['Warlord'], { 'warlord-exalt': 180 });
  assert(acq.premiumTotal == null, 'no invented influence premium in ranked EV');
  assert(acq.recommend === 'orb', 'ranked EV uses priced orb, not fake 50c buy');

  const dims = multiDimensionCost(
    { divine: 2, gold: null, 'thaumaturgic-dust': null },
    { divine: 200 }
  );
  assert(dims.chaosEquivalent === 400, 'tradable chaos excludes gold/dust');
  assert(dims.gold == null && dims.thaumaturgicDust == null, 'unpublished smash stays null');
  assert(/400c \+ \? Gold \+ \? Dust/.test(formatMultiCost(dims)), 'multi-cost display');
  {
    const c = tradableChaosCost({ gold: 100, divine: 1 }, { gold: 1, divine: 10 });
    assert(c === 10, `gold excluded from chaos EV, got ${c}`);
  }
  const trade = lookupItemTradePrice({ baseName: 'Vaal Regalia', influences: ['Warlord'] });
  assert(trade.priceChaos == null && trade.status === 'unknown', 'trade stub returns unknown not 50c');

  const recombPlan = {
    method: 'recombinator',
    id: 'recombinator',
    name: 'Recombinator',
    steps: [{ operator: 'recombine', chance: 0.033, cost: { gold: null } }],
    costs: { gold: null, 'thaumaturgic-dust': null },
    totalCost: 100,
    experimental: true,
    alternatives: [{ id: 'seq', name: 'Sequential', totalCost: 50, why: 'cheaper' }],
  };
  assert(classifyPlan(recombPlan).id === 'probabilistic-recombination', 'recomb never deterministic');
  const conf = buildConfidence(recombPlan, kb);
  assert(conf.mechanics && conf.probabilities && conf.prices, 'confidence object present');
  const assembled = assemblePlan(recombPlan, {
    kb,
    unmatched: [{ text: '???' }],
    alternatives: recombPlan.alternatives,
  });
  assert(assembled.unsupported === true, 'unmatched → unsupported');
  assert(assembled.expectedTradableCost == null, 'no guessed EV for unsupported');
  assert(assembled.confidence, 'assembled has confidence');
  assert(assembled.rejectedStrategies?.length, 'rejectedStrategies with why');
  assert(assembled.tierMode === 'atLeast', 'default tierMode atLeast');
  assert(assembled.preserveSpecialSources === true, 'preserve special sources default');
  assert(assembled.stages?.length === 1 && assembled.stages[0].costFormulas, 'stages + raw cost formula');

  const rejected = buildRejectedStrategies({
    totalCost: 10,
    alternatives: [{ id: 'raw', name: 'Raw Exalt', totalCost: 96, why: 'target share 0.82%' }],
  });
  assert(/0\.82%|Lost by/.test(rejected[0].why), 'rejected why present');

  const fiveA = makeState({
    itemClass: 'Gloves',
    prefixes: [
      makeAffix({ id: 'a', text: 'A', gen: 'prefix', fractured: true }),
      makeAffix({ id: 'b', text: 'B', gen: 'prefix' }),
    ],
    suffixes: [makeAffix({ id: 'c', text: 'C', gen: 'suffix' })],
    fracturedItem: true,
  });
  const fiveB = makeState({
    itemClass: 'Gloves',
    prefixes: [makeAffix({ id: 'd', text: 'D', gen: 'prefix' })],
    suffixes: [makeAffix({ id: 'e', text: 'E', gen: 'suffix' }), makeAffix({ id: 'f', text: 'F', gen: 'suffix' })],
  });
  const dist = recombine(fiveA, fiveB, kb.recombinator);
  const fracA = fiveA.prefixes.filter((a) => a.fractured).length + fiveA.suffixes.filter((a) => a.fractured).length;
  for (const o of dist.outcomes) {
    const frac = [...o.state.prefixes, ...o.state.suffixes].filter((a) => a.fractured).length;
    assert(frac <= fracA, 'recomb cannot increase fractured count');
  }

  const mods5 = [
    fakeMod('P1', 'prefix', { id: 'p1', cost: 8 }),
    fakeMod('P2', 'prefix', { id: 'p2', cost: 8 }),
    fakeMod('S1', 'suffix', { id: 's1', cost: 8 }),
    fakeMod('S2', 'suffix', { id: 's2', cost: 8 }),
    fakeMod('S3', 'suffix', { id: 's3', cost: 8 }),
  ];
  const indep = considerRecombinator({
    mods: mods5,
    sequentialCost: 50000,
    sequentialName: 'Exalt slam',
    costOne: () => 8,
    itemMeta: { itemClass: 'Gloves', baseType: 'Warlock Gloves', itemLevel: 86, influence: [] },
    kb,
    prices: { chaos: 1, gold: 0.001, 'thaumaturgic-dust': 0.001 },
  });
  assert(indep.experimental, 'recomb EV experimental');
  assert(
    indep.won || indep.unranked || indep.comparison?.recombinator,
    '5-natural independence still considers recomb (may be experimental/unranked)'
  );

  console.log('OK: optimizer tests passed');
}
