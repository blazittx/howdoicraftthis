/**
 * §42–43 regression strategy invariants (not exact essence counts).
 * - never label 3%-class recomb as deterministic
 * - never treat gold/dust as 0c when unknown
 * - never treat unknown/experimental recomb as exact
 * - no hardcoded fixed essence-count goldens in production EV
 */
import { assert } from './helpers/assert.js';
import { readSrc } from './helpers/harness.mjs';
import { classifyPlan } from '../src/lib/planClass.js';
import { pricedRecombBag, smashFloorBag } from '../src/lib/craftValue.js';
import { getRecombinatorModel, recombineCost } from '../src/lib/recombinatorModel.js';
import { makeState, makeAffix } from '../src/lib/craftState.js';
import { recommendInfluenceAcquisition } from '../src/lib/craftKnowledge.js';

export async function runRegressionTests(kb) {
  // --- no deterministic-on-3%-recomb ---
  const recombPlan = {
    method: 'recombinator',
    methodName: 'Recombinator',
    steps: [{ operator: 'recombine', chance: 0.03 }],
  };
  const kind = classifyPlan(recombPlan);
  assert(kind.id === 'probabilistic-recombination', `got ${kind.id}`);
  assert(!/deterministic/i.test(kind.label), 'never call recomb deterministic');
  assert(kind.experimental === true, 'recomb classification experimental');

  const lowChance = {
    method: 'harvest',
    steps: [{ operator: 'harvestFill', chance: 0.03 }],
  };
  const hv = classifyPlan(lowChance);
  assert(hv.id !== 'guaranteed-finishing', '3% harvest not guaranteed');
  assert(!/deterministic/i.test(hv.label ?? ''), 'no deterministic label on 3% step');

  // --- no gold-as-0c ---
  const model = getRecombinatorModel(kb);
  const bag = recombineCost(
    makeState({ prefixes: [makeAffix({ text: 'a', gen: 'prefix' })], suffixes: [] }),
    makeState({ prefixes: [makeAffix({ text: 'b', gen: 'prefix' })], suffixes: [] }),
    model
  );
  assert(bag.gold == null || bag.gold > 0, 'unpublished gold is null or positive, never 0 invented');
  const unpriced = pricedRecombBag(
    { gold: null, 'thaumaturgic-dust': null },
    { chaos: 1 },
    model,
    'Gloves'
  );
  assert(unpriced === Infinity || unpriced > 0, `unknown gold/dust not 0c, got ${unpriced}`);
  const zeroGoldPrices = pricedRecombBag(
    { gold: null, 'thaumaturgic-dust': null },
    { chaos: 1, gold: 0, 'thaumaturgic-dust': 0 },
    model,
    'Wand'
  );
  // Even if unit prices are 0, floor amounts must be >0 so cost isn't "free smash"
  const floor = smashFloorBag(model, 'Wand');
  if (floor) {
    assert(floor.gold > 0 && floor['thaumaturgic-dust'] > 0, 'anecdotal floor amounts > 0');
    assert(zeroGoldPrices === 0 || zeroGoldPrices > 0 || zeroGoldPrices === Infinity, 'priced floor defined');
    // Spec: never treat smash as free — if both units are 0, still not a "known free" strategy
    assert(!(zeroGoldPrices === 0 && floor.confidence === 'unknown'), 'unknown recomb not exact free');
  } else {
    assert(unpriced === Infinity, 'no floor → Infinity, not 0');
  }

  // --- no unknown-recomb-as-exact ---
  assert(model.cost?.confidence === 'unknown' || model.cost?.formula == null, 'cost confidence unknown');
  assert(model.confidence === 'mixed' || model.confidence !== 'exact', 'model not exact');

  // --- no fixed essence count goldens in production sources ---
  const src = [
    readSrc('src/lib/craftOperators.js'),
    readSrc('src/lib/craftSearch.js'),
    readSrc('src/lib/craftKnowledge.js'),
    readSrc('src/lib/deterministicPlanner.js'),
    readSrc('src/lib/planner/scaffold/helpers.js'),
    readSrc('src/lib/planner/scaffold/candidates.js'),
    readSrc('src/lib/planner/scaffold/fractureInfluence.js'),
    readSrc('src/lib/planner/scaffold/exaltAnnul.js'),
    readSrc('src/lib/planner/scaffold/assignAndBuild.js'),
    readSrc('src/lib/planner/scaffold/planDeterministic.js'),
    readSrc('src/lib/planner/scaffold/replan.js'),
  ].join('\n');
  assert(!/\b(15|20|40) essences expected\b/i.test(src), 'no fixed 15/20/40 essence counts');
  assert(!/guessEssenceName/.test(src), 'guessEssenceName removed');
  assert(!/INFLUENCED_BASE_PREMIUM/.test(src), 'no influence premium constant');

  const acq = recommendInfluenceAcquisition(['Warlord'], { 'warlord-exalt': 180 });
  assert(acq.premiumTotal == null, 'no invented influence premium');

  // Strategy-shape invariant (not exact counts): Kinetic-like plan class must allow essence/harvest/unveil operators in vocabulary
  assert(/essenceFish|essence|harvest|unveil|recombine/.test(src), 'planner still knows core operators');

  // Bench slot: 2 prefix keepers + 1 prefix bench → open slot already reserved.
  // SCBC is itself a prefix — must NOT insert SCBC+annul "to free space".
  const { buildAnnulForBenchSpace } = await import('../src/lib/planner/scaffold/exaltAnnul.js');
  const costs = {};
  const noAnnul = buildAnnulForBenchSpace(
    { class: 'One Hand Sword', itemClass: 'One Hand Sword' },
    [
      { short: 'flat phys', text: 'Adds Physical', gen: 'prefix', type: 'prefix' },
      { short: 'flat light', text: 'Adds Lightning', gen: 'prefix', type: 'prefix' },
      { short: 'str', text: '+Strength', gen: 'suffix', type: 'suffix', fractured: true },
    ],
    [{ short: 'chaos pen', text: 'Penetrate Chaos', gen: 'prefix', type: 'prefix', crafted: true, method: 'bench' }],
    [
      {
        operator: 'essenceFish',
        targetMods: ['flat phys', 'flat light'],
      },
    ],
    costs,
    'One Hand Sword'
  );
  assert(noAnnul.length === 0, `2 keepers + bench must not SCBC/annul for space, got ${noAnnul.length}`);
  assert(!costs.annul && !costs.divine, 'no annul/divine for reserved bench slot');

  // 3 prefix keepers + prefix bench → must annul (no metacraft-first on full side)
  const costs2 = {};
  const needAnnul = buildAnnulForBenchSpace(
    { class: 'One Hand Sword', itemClass: 'One Hand Sword' },
    [
      { short: 'a', gen: 'prefix', type: 'prefix' },
      { short: 'b', gen: 'prefix', type: 'prefix' },
      { short: 'c', gen: 'prefix', type: 'prefix' },
    ],
    [{ short: 'bench', gen: 'prefix', type: 'prefix', crafted: true, method: 'bench' }],
    [],
    costs2,
    'One Hand Sword'
  );
  assert(needAnnul.length === 1, '3 keepers + bench needs space');
  assert(needAnnul[0].operator === 'annulForSpace', `got ${needAnnul[0]?.operator}`);
  assert(!/Cannot Be Changed/i.test(needAnnul[0].action ?? ''), 'full side: no SCBC before open slot exists');

  console.log('OK: regression invariant tests passed');
}
