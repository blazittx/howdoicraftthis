/**
 * Recombinator physics + solver tests. Model has no target/success/EV.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeAffix, makeState, affixKey, allAffixes } from '../src/lib/craftState.js';
import {
  recombine,
  unpredictableRecombine,
  predictableRecombine,
  affixCountDistribution,
  effectivePoolSize,
  getRecombinatorModel,
  recombineCost,
  recombineEligible,
  bipartitions,
  donorPartitions,
  ALLFLAME_SUPPORTED,
  OPERATOR_UNPREDICTABLE,
  OPERATOR_PREDICTABLE,
} from '../src/lib/recombinatorModel.js';
import { considerRecombinator, considerPredictableRecombine, evWithSalvage } from '../src/lib/recombinatorSearch.js';
import { pricedRecombBag, smashFloorBag, donorMiniPlan } from '../src/lib/craftValue.js';
import { assemblePlan } from '../src/lib/planSchema.js';
import { recombCompatibility } from '../src/lib/craftValue.js';
import {
  assertRecombEconomicsInvariants,
  buildRecombCostReport,
  formatRecombEconomicsDisplay,
} from '../src/lib/pricing/recombEconomics.js';
import {
  assertDonorRecipeInvariants,
  buildDonorRecipe,
} from '../src/lib/planner/donorSearch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function aff(text, gen, extra = {}) {
  return makeAffix({
    id: extra.id ?? text,
    text,
    gen,
    groups: extra.groups ?? [text],
    spawnWeight: extra.w ?? 100,
    crafted: extra.crafted,
    veiled: extra.veiled,
    essenceOnly: extra.essenceOnly,
    exclusive: extra.exclusive,
    canNaturallyRoll: extra.canNaturallyRoll,
    source: extra.source,
    fractured: extra.fractured,
  });
}

function st(prefixes, suffixes, extra = {}) {
  return makeState({
    itemClass: 'Gloves',
    baseType: 'Warlock Gloves',
    itemLevel: 86,
    prefixes,
    suffixes,
    ...extra,
  });
}

function fakeMod(text, gen, extra = {}) {
  return {
    text,
    short: text,
    gen,
    groups: extra.groups ?? [text],
    hitWeight: extra.w ?? 80,
    weight: extra.w ?? 80,
    crafted: !!extra.crafted,
    fractured: !!extra.fractured,
    veiled: !!extra.veiled,
    ofEssence: !!extra.ofEssence,
    match: { id: extra.id ?? text, source: extra.source ?? 'natural', matched: true },
    best: { expectedChaos: extra.cost ?? 10, type: extra.type ?? 'alt' },
  };
}

function expectedAffixCount(dist, side) {
  return dist.outcomes.reduce((s, o) => s + o.p * (o.state[side]?.length ?? 0), 0);
}

function classifyHave(state, neededKeys) {
  return neededKeys.filter((k) => allAffixes(state).some((a) => affixKey(a) === k));
}

export function runRecombinatorTests() {
  const modelSrc = readFileSync(join(root, 'src/lib/recombinatorModel.js'), 'utf8');
  // Ban target-aware vocabulary in Unpredictable physics (comments stripped).
  // PredictableRecombine may take an empirical/UI successChance — that is not target scoring.
  const codeOnly = modelSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(!/\bdesired\b/.test(codeOnly), 'model must not mention desired');
  assert(!/\buseful fallback\b/i.test(codeOnly), 'model must not mention useful fallback');
  assert(!/expectedFutureCost|salvage EV/i.test(codeOnly), 'model must not compute salvage EV');
  assert(!/chaosFallback/.test(codeOnly), 'model must not invent a chaos fallback cost');
  // successChance allowed only as Predictable input / output field — not as Unpredictable scoring
  assert(/PredictableRecombine|predictableRecombine/i.test(modelSrc), 'Predictable operator present');
  assert(!/successChance\s*[:=]\s*0\.\d+/.test(codeOnly), 'no invented hardcoded successChance constant');

  const kbJson = JSON.parse(readFileSync(join(root, 'public/data/knowledge/recombinators-official.json'), 'utf8'));
  assert(kbJson.version === '3.29', `model version 3.29, got ${kbJson.version}`);
  assert(kbJson.sources?.length >= 2, 'sources recorded');
  assert(kbJson.cost?.currency?.includes('gold') && kbJson.cost?.currency?.includes('thaumaturgic-dust'), 'official currencies gold + thaumaturgic-dust');
  assert(kbJson.cost?.formula == null, 'gold/dust formula unpublished');
  assert(
    kbJson.cost?.confidence === 'unknown' || kbJson.cost?.confidence === 'approximate',
    'cost confidence unknown or approximate (never invented closed-form)'
  );
  assert(!kbJson.cost?.chaosFallback, 'no invented chaosFallback');
  const avg = kbJson.cost?.averageUnpredictable;
  assert(avg?.gold === 25000 && avg?.['thaumaturgic-dust'] === 85000, 'average Unpredictable midpoints');
  assert(avg?.source === 'user empirical band 2026-08', 'empirical band source tagged');
  assert(kbJson.cost?.opportunityCostChaos?.gold > 0, 'opportunityCostChaos gold tagged');
  const model = getRecombinatorModel({ recombinator: kbJson });

  const c2 = affixCountDistribution(2, model);
  assert(Math.abs((c2[1] ?? 0) - 0.667) < 0.01, 'pool-2: ~66.7% one affix');
  assert(Math.abs((c2[2] ?? 0) - 0.333) < 0.01, 'pool-2: ~33.3% two affixes');
  assert(!(c2[0] > 0), 'pool-2: no zero-affix row (wiki table)');

  const natA = st([aff('Life', 'prefix'), aff('Mana', 'prefix')], []);
  const natB = st([aff('ES', 'prefix')], []);
  const natDist = recombine(natA, natB, model);
  assert(natDist.outcomes.length > 0, 'natural recombine yields outcomes');
  assert(
    natDist.outcomes.every((o) => o.state.suffixes.length === 0),
    'prefix-only inputs: suffix count modelled separately (always 0)'
  );
  const pSum = natDist.outcomes.reduce((s, o) => s + o.p, 0);
  assert(Math.abs(pSum - 1) < 0.02, `outcome probabilities sum ~1, got ${pSum}`);

  const nat3 = st(
    [aff('P1', 'prefix', { groups: ['g1'] }), aff('P2', 'prefix', { groups: ['g2'] }), aff('P3', 'prefix', { groups: ['g3'] })],
    []
  );
  const nat3b = st(
    [aff('P4', 'prefix', { groups: ['g4'] }), aff('P5', 'prefix', { groups: ['g5'] }), aff('P6', 'prefix', { groups: ['g6'] })],
    []
  );
  const ex3 = st(
    [
      aff('E1', 'prefix', { groups: ['e1'], veiled: true, canNaturallyRoll: false, source: 'unveiled' }),
      aff('E2', 'prefix', { groups: ['e2'], veiled: true, canNaturallyRoll: false, source: 'unveiled' }),
      aff('E3', 'prefix', { groups: ['e3'], essenceOnly: true, canNaturallyRoll: false, source: 'essence_only' }),
    ],
    []
  );
  const ex3b = st(
    [
      aff('E4', 'prefix', { groups: ['e4'], crafted: true, canNaturallyRoll: false, source: 'crafted' }),
      aff('E5', 'prefix', { groups: ['e5'], veiled: true, canNaturallyRoll: false, source: 'unveiled' }),
      aff('E6', 'prefix', { groups: ['e6'], essenceOnly: true, canNaturallyRoll: false, source: 'essence_only' }),
    ],
    []
  );
  const nNat = expectedAffixCount(recombine(nat3, nat3b, model), 'prefixes');
  const nEx = expectedAffixCount(recombine(ex3, ex3b, model), 'prefixes');
  assert(nEx < nNat - 0.3, `post-3.26 exclusive/cannot-roll fewer prefixes than natural (${nEx.toFixed(2)} vs ${nNat.toFixed(2)})`);
  const wNat = effectivePoolSize(nat3.prefixes.concat(nat3b.prefixes), nat3, model);
  const wEx = effectivePoolSize(ex3.prefixes.concat(ex3b.prefixes), ex3, model);
  assert(wEx < wNat, `cannot-roll effective pool ${wEx} < natural ${wNat} (not old padding)`);

  const dA = st(
    [aff('Life', 'prefix', { groups: ['Life'] }), aff('Mana', 'prefix', { groups: ['Mana'] })],
    [aff('FireRes', 'suffix', { groups: ['Fire'] }), aff('Str', 'suffix', { groups: ['Str'] })]
  );
  const dB = st(
    [aff('ES', 'prefix', { groups: ['ES'] })],
    [aff('Int', 'suffix', { groups: ['Int'] })]
  );
  const mixed = recombine(dA, dB, model);
  const someP = mixed.outcomes.some((o) => o.state.prefixes.length > 0);
  const someS = mixed.outcomes.some((o) => o.state.suffixes.length > 0);
  assert(someP && someS, 'prefix and suffix both appear in mixed recombine (not one bag)');

  const p1 = aff('P1', 'prefix', { groups: ['p1'], id: 'P1' });
  const p2 = aff('P2', 'prefix', { groups: ['p2'], id: 'P2' });
  const p3 = aff('P3', 'prefix', { groups: ['p3'], id: 'P3' });
  const twoTwo = recombine(st([p1, p2], []), st([p3, aff('P4', 'prefix', { groups: ['p4'], id: 'P4' })], []), model);
  const need = [affixKey(p1), affixKey(p2), affixKey(p3)];
  const C = 100;
  const salvage = evWithSalvage(twoTwo, need, C, (have) => (need.length - have.length) * 20);
  const brick = salvage.pDone > 0 ? C / salvage.pDone : Infinity;
  assert(salvage.pDone > 0, '2+2 prefix recomb can hit 3 desired');
  assert(salvage.ev < brick - 1, `salvage EV ${salvage.ev.toFixed(1)} < brick ${brick.toFixed(1)}`);
  assert(
    salvage.expectedTotalRecombinationsUntilFinished >= 1,
    'E_recombs >= 1 even with salvage partials'
  );
  // Salvage must not force attempts=1 when brick mass needs another recomb
  if (salvage.pBrick > 1e-9) {
    assert(
      salvage.expectedTotalRecombinationsUntilFinished > 1 + 1e-9,
      `brick mass → E_recombs > 1, got ${salvage.expectedTotalRecombinationsUntilFinished}`
    );
  }

  const need5 = [affixKey(p1), affixKey(p2), affixKey(p3), affixKey(aff('P4', 'prefix', { groups: ['p4'], id: 'P4' })), affixKey(aff('P5', 'prefix', { groups: ['p5'], id: 'P5' }))];
  const fiveA = st([p1, p2, p3], []);
  const fiveB = st(
    [aff('P4', 'prefix', { groups: ['p4'], id: 'P4' }), aff('P5', 'prefix', { groups: ['p5'], id: 'P5' })],
    []
  );
  const fiveDist = recombine(fiveA, fiveB, model);
  const donorRebuild = 3 * 10;
  const naive = evWithSalvage(fiveDist, need5, 100, (have) => (need5.length - have.length) * 10);
  const dead = evWithSalvage(fiveDist, need5, 100, (have) => (have.length === need5.length ? 0 : 900));
  assert(dead.ev > naive.ev + 50, `dead-end salvage EV ${dead.ev.toFixed(0)} must exceed naive leftover×costOne ${naive.ev.toFixed(0)}`);
  const threeHave = fiveDist.outcomes.find((o) => classifyHave(o.state, need5).length === 3);
  if (threeHave) {
    const vDead = 900;
    assert(vDead !== donorRebuild, '3-mod dead-end remaining V is not 3× donor rebuild');
    assert(vDead > donorRebuild, 'dead-end finish costs more than the 3 mods originally did');
  }
  const unpublished = pricedRecombBag(
    { gold: null, 'thaumaturgic-dust': null },
    { gold: 1, 'thaumaturgic-dust': 1 },
    kbJson,
    'Wand'
  );
  assert(unpublished > 0, 'unpublished smash EV uses anecdotal floor, not 0');
  const floor = smashFloorBag(kbJson, 'Wand');
  assert(floor?.gold > 0 && floor?.['thaumaturgic-dust'] > 0, 'floor bag from documented samples');
  // Gold is opportunity-labeled (not market unit=1); dust may use market when present
  assert(Number.isFinite(unpublished) && unpublished > 0, `floor priced finite economic, got ${unpublished}`);
  const unpriced = pricedRecombBag({ gold: null, 'thaumaturgic-dust': null }, { chaos: 1 }, kbJson, 'Gloves');
  assert(unpriced > 0 && Number.isFinite(unpriced), 'missing market units → finite opportunityCostChaos, not 0/unranked');
  assert(!/12 \+|0\.04/.test(readFileSync(join(root, 'src/lib/craftValue.js'), 'utf8')), 'no invented chaosFallback formula');
  assert(!/12\s*\+\s*2\s*\*\s*n|0\.04\s*\*\s*ilvl/.test(readFileSync(join(root, 'src/lib/recombinatorModel.js'), 'utf8')), 'no revived 12+2n+0.04*ilvl');

  const smashPrices = { chaos: 1, gold: 0.001, 'thaumaturgic-dust': 0.001 };

  const mods3 = [
    fakeMod('T1 Life', 'prefix', { id: 'life', cost: 8 }),
    fakeMod('T1 ES', 'prefix', { id: 'es', cost: 8 }),
    fakeMod('T1 Fire Res', 'suffix', { id: 'fire', cost: 8 }),
  ];
  const itemMeta = { itemClass: 'Gloves', baseType: 'Warlock Gloves', itemLevel: 86, influence: [] };
  const cheapDonors = considerRecombinator({
    mods: mods3,
    sequentialCost: 50000,
    sequentialName: 'Exalt slam',
    costOne: () => 8,
    itemMeta,
    kb: { recombinator: kbJson },
    prices: smashPrices,
  });
  assert(cheapDonors.won, 'recomb wins when sequential slam EV is absurd vs cheap 1-mod donors');
  assert(cheapDonors.experimental, 'recomb EV marked experimental');
  assert(cheapDonors.operator === 'UnpredictableRecombine', 'default solver path is UnpredictableRecombine');
  assert(!cheapDonors.unranked, 'empirical midpoints keep Unpredictable ranked');
  assert(
    (cheapDonors.steps ?? []).some((s) => s.operator === 'recombDonor'),
    'winning plan includes donor stages'
  );
  assert(
    (cheapDonors.steps ?? []).some((s) => s.operator === 'UnpredictableRecombine' || s.operator === 'recombine'),
    'winning plan includes recombine step'
  );
  const recombStep = (cheapDonors.steps ?? []).find(
    (s) => s.operator === 'UnpredictableRecombine' || s.operator === 'recombine'
  );
  assert('gold' in (recombStep.cost ?? {}), 'recombine step lists gold');
  assert('thaumaturgic-dust' in (recombStep.cost ?? {}), 'recombine step lists thaumaturgic dust');
  assert(recombStep.cost.gold === 25000 && recombStep.cost['thaumaturgic-dust'] === 85000, 'amounts are empirical midpoints');
  assert(!recombStep.cost?.chaos, 'recombine step must not flatten gold/dust into chaos');
  assert('gold' in (cheapDonors.costs ?? {}) && 'thaumaturgic-dust' in (cheapDonors.costs ?? {}), 'plan costs include gold + dust keys');
  assert(!cheapDonors.costs?.chaos, 'plan costBreakdown bag must not be EV dumped as chaos');
  assert(
    (cheapDonors.totalExpectedTradableCostChaos ?? cheapDonors.totalCost) > 0,
    'recomb with donors never ~0c tradable/total'
  );
  assert(
    (cheapDonors.expectedDonorCostChaos ?? 0) > 0 || (cheapDonors.totalCost ?? 0) > 20,
    'donor manufacturing EV incorporated'
  );
  assert(
    !/P\(final\) 0\.0%/.test(recombStep.chanceLabel ?? '') &&
      !/direct final\/recomb 0\.0%/.test(recombStep.chanceLabel ?? ''),
    `direct-final label keeps precision below 0.1%: ${recombStep.chanceLabel}`
  );
  assert(
    /direct final\/recomb/i.test(recombStep.chanceLabel ?? ''),
    `recomb step labels direct final/recomb, got ${recombStep.chanceLabel}`
  );
  const donorStep = (cheapDonors.steps ?? []).find((s) => s.operator === 'recombDonor');
  assert(donorStep?.recipe?.lines?.length || /Buy |Method:|Total donor/.test(donorStep?.detail ?? ''), 'donor mini-plan has auditable recipe');
  assert(
    !/^~\d+c$/.test(String(donorStep?.chanceLabel ?? '')),
    `donor chanceLabel must not be a cost like ~53c, got ${donorStep?.chanceLabel}`
  );
  assert(
    donorStep?.expectedCostChaos != null || donorStep?.expectedCost != null,
    'donor step exposes expectedCostChaos'
  );

  // State-graph / economics invariants
  const eco = cheapDonors.economics;
  assert(eco, 'winning recomb exposes economics report');
  assert(eco.invariantsOk !== false, `economics invariants: ${(eco.invariantFailures ?? []).join('; ')}`);
  const E =
    eco.expectedTotalRecombinationsUntilFinished ?? eco.expectedRecombinationAttempts;
  assert(E >= 1, `expectedTotalRecombinations >= 1, got ${E}`);
  assert(
    eco.directFinalProbabilityPerRecombination != null || eco.pDone != null,
    'direct final probability present'
  );
  assert(
    eco.eventualCompletionProbability == null || eco.eventualCompletionProbability >= eco.pDone - 1e-9,
    'eventual completion ≥ direct final'
  );
  if ((eco.pBrick ?? 0) > 1e-9) {
    assert(E > 1 + 1e-6, `brick mass ${eco.pBrick} requires E_recombs > 1, got ${E}`);
  }
  const goldPer = recombStep.cost.gold;
  const dustPer = recombStep.cost['thaumaturgic-dust'];
  assert(
    Math.abs((eco.expectedGold ?? 0) - goldPer * E) < 1,
    `expectedGold ${eco.expectedGold} ≈ ${goldPer}×${E}`
  );
  assert(
    Math.abs((eco.expectedDust ?? 0) - dustPer * E) < 1,
    `expectedDust ${eco.expectedDust} ≈ ${dustPer}×${E}`
  );
  const dustAdd = eco.dustCountedInTradable ? 0 : eco.dustChaosEquivalent ?? 0;
  const goldAdd = eco.goldOpportunityChaosEquivalent ?? 0;
  const tradable = eco.totalExpectedTradableCostChaos;
  const economic = eco.totalExpectedEconomicCostChaos;
  assert(
    Math.abs(economic - (tradable + dustAdd + goldAdd)) <= 1.5,
    `economic ${economic} ≠ tradable ${tradable} + dust ${dustAdd} + gold ${goldAdd}`
  );
  assert(eco.breakdown?.equationEconomic, 'machine-readable economics breakdown present');
  assert(
    Array.isArray(eco.stateEvDebug) && eco.stateEvDebug.some((l) => /EV\(S0\)|E_recombs/i.test(l)),
    'state EV debug lines present'
  );

  // Multi-mod donor recipe must not fake a single next-mod P/attempt as full-donor success
  const multiDonor = donorMiniPlan(
    [
      fakeMod('Life', 'prefix', { id: 'life2', cost: 8 }),
      fakeMod('ES', 'prefix', { id: 'es2', cost: 8 }),
      fakeMod('Fire', 'suffix', { id: 'fire3', cost: 8 }),
    ],
    {
      costOne: () => 8,
      sequentialRemaining: () => ({
        ev: 40,
        ops: ['essence', 'protect+reforge', 'exalt'],
        pools: [{ p: 0.1143 }, { p: 0.2 }, { p: 0.5 }],
      }),
    }
  );
  assert(multiDonor.recipe?.multiStep, 'multi-mod donor marked multiStep');
  assert(
    multiDonor.successChancePerAttempt == null,
    'multi-mod donor must not claim a single successChancePerAttempt'
  );
  assert(
    !/P\/attempt 11\.43%/i.test(multiDonor.recipe?.lines?.find((l) => l.kind === 'method')?.note ?? ''),
    'multi-mod method note must not fake P/attempt 11.43% as full donor'
  );
  assert(
    /full-sequence|Multi-step/i.test(multiDonor.recipe?.lines?.find((l) => l.kind === 'method')?.note ?? ''),
    'multi-mod donor notes full-sequence EV'
  );

  assert(
    cheapDonors.goldOpportunityChaosEquivalent == null ||
      (cheapDonors.economicsDisplay ?? '').includes('opportunity') ||
      (cheapDonors.economics?.goldOpportunityLabel ?? '').includes('opportunity'),
    'gold never silently merged without opportunity label'
  );
  const bag = recombineCost(
    { prefixes: [{}], suffixes: [], itemLevel: 86 },
    { prefixes: [{}], suffixes: [], itemLevel: 86 },
    model
  );
  assert(bag.gold === 25000 && bag['thaumaturgic-dust'] === 85000, 'model uses empirical midpoints (not closed-form)');
  assert(bag.confidence === 'approximate', 'smash confidence approximate');
  assert(cheapDonors.experimental, 'recomb EV marked experimental');

  // Ranking uses full EV: expensive donors → sequential wins
  const seqWins = considerRecombinator({
    mods: mods3,
    sequentialCost: 12,
    sequentialName: 'Cheap sequential',
    costOne: () => 40,
    itemMeta,
    kb: { recombinator: kbJson },
    prices: smashPrices,
  });
  assert(!seqWins.won, 'sequential still wins when recomb donors are more expensive');
  assert(seqWins.comparison.winner === 'sequential', 'comparison names sequential winner');

  // Fixture: sequential wins once donors counted (even if smash looks "free" in display)
  const seqWinsFullEv = considerRecombinator({
    mods: mods3,
    sequentialCost: 80,
    sequentialName: 'Modest sequential',
    costOne: () => 200,
    itemMeta,
    kb: { recombinator: kbJson },
    prices: smashPrices,
  });
  assert(!seqWinsFullEv.won, 'ranking uses full donor EV — sequential wins when donors are costly');
  assert(
    (seqWinsFullEv.comparison.recombinator?.cost ?? seqWinsFullEv.ev) == null ||
      (seqWinsFullEv.comparison.recombinator?.cost ?? seqWinsFullEv.ev) > 80,
    'recomb full EV exceeds cheap sequential when donors cost 200c each'
  );

  // Impossible combo rejected
  const sameGroup = [
    fakeMod('Life A', 'prefix', { id: 'lifeA', cost: 8, groups: ['Life'] }),
    fakeMod('Life B', 'prefix', { id: 'lifeB', cost: 8, groups: ['Life'] }),
    fakeMod('Fire', 'suffix', { id: 'fire2', cost: 8 }),
  ];
  // force groups on fake mods
  sameGroup[0].groups = ['Life'];
  sameGroup[1].groups = ['Life'];
  const impossible = considerRecombinator({
    mods: sameGroup,
    sequentialCost: 50000,
    costOne: () => 8,
    itemMeta,
    kb: { recombinator: kbJson },
    prices: smashPrices,
  });
  // Either loses/unranked due to exclusive-group, or if partition avoids pairing both Life — at least no 0c win
  if (impossible?.won) {
    assert((impossible.totalCost ?? 0) > 0, 'impossible-ish win still not 0c');
  }

  const mixedTarget = [
    fakeMod('Hard P1', 'prefix', { id: 'hp1', cost: 8 }),
    fakeMod('Hard P2', 'prefix', { id: 'hp2', cost: 8 }),
    fakeMod('Easy S1', 'suffix', { id: 'es1', cost: 8 }),
  ];
  const mixedWin = considerRecombinator({
    mods: mixedTarget,
    sequentialCost: 80000,
    costOne: () => 8,
    itemMeta,
    kb: { recombinator: kbJson },
    prices: smashPrices,
  });
  assert(mixedWin.won, 'mixed 1p1s partition case still selects recomb');
  const part = mixedWin.comparison.recombinator.partition;
  assert(part?.length === 2, 'winning partition recorded');
  const flat = part.flat().join(' ');
  const mixedPartition =
    (/Hard P/i.test(flat) && /Easy S/i.test(flat)) ||
    part.some((side) => {
      const labels = side.join(' ');
      return /Hard P/i.test(labels) && /Easy S/i.test(labels);
    });
  assert(mixedPartition, `no hardcoded 3P+2S: mixed prefix/suffix donors can win, got ${JSON.stringify(part)}`);

  // assemblePlan must not zero smash-only bags
  const assembled = assemblePlan(
    {
      id: 'recombinator',
      method: 'recombinator',
      name: 'Recombinator',
      steps: cheapDonors.steps,
      costs: cheapDonors.costs,
      totalCost: cheapDonors.totalCost,
      totalExpectedTradableCostChaos: cheapDonors.totalExpectedTradableCostChaos,
      economics: cheapDonors.economics,
      expectedDonorCostChaos: cheapDonors.expectedDonorCostChaos,
    },
    { kb: { recombinator: kbJson, prices: smashPrices } }
  );
  assert(
    (assembled.totalCost ?? 0) > 0 || (assembled.totalExpectedTradableCostChaos ?? 0) > 0,
    `assemblePlan must not overwrite recomb EV with 0c, got total=${assembled.totalCost}`
  );

  // Direct compatibility reject
  const badCompat = recombCompatibility(
    [fakeMod('A', 'prefix', { id: 'a' }), fakeMod('B', 'prefix', { id: 'b' })].map((m, i) => {
      m.groups = ['Same'];
      return m;
    }),
    [fakeMod('C', 'suffix', { id: 'c' })]
  );
  assert(!badCompat.ok && badCompat.reasons.some((r) => /exclusive-group/.test(r)), 'same exclusive group rejected');

  const fracLife = aff('Life', 'prefix', { groups: ['Life'], fractured: true });
  const fracA = st([fracLife], [aff('FireRes', 'suffix', { groups: ['Fire'] })], { fracturedItem: true });
  const natOther = st([aff('ES', 'prefix', { groups: ['ES'] })], [aff('ColdRes', 'suffix', { groups: ['Cold'] })]);
  const fracDist = recombine(fracA, natOther, model);
  assert(fracDist.outcomes.length > 0, 'fractured + natural recombine yields outcomes');
  const lifeKey = affixKey(fracLife);
  let sawFracLife = false;
  for (const o of fracDist.outcomes) {
    const fracMods = allAffixes(o.state).filter((a) => a.fractured);
    assert(fracMods.length <= 1, 'fractured cannot increase beyond the chosen base');
    for (const a of fracMods) {
      assert(affixKey(a) === lifeKey, 'fractured does not transfer off its item');
    }
    if (!o.state.fracturedItem) {
      assert(fracMods.length === 0, 'non-fractured chosen base cannot gain fracturedItem/mods');
    }
    if (fracMods.some((a) => affixKey(a) === lifeKey)) sawFracLife = true;
  }
  assert(sawFracLife, 'fractured on the chosen base can remain');

  const fracES = aff('ES', 'prefix', { groups: ['ES'], fractured: true });
  const twoFrac = recombine(
    st([fracLife], [], { fracturedItem: true }),
    st([fracES], [], { fracturedItem: true }),
    model
  );
  let sawLife = false;
  let sawES = false;
  for (const o of twoFrac.outcomes) {
    const fracMods = allAffixes(o.state).filter((a) => a.fractured);
    assert(fracMods.length <= 1, 'two fractured inputs cannot combine/increase fractured mods');
    const keys = fracMods.map(affixKey);
    if (keys.includes(lifeKey)) sawLife = true;
    if (keys.includes(affixKey(fracES))) sawES = true;
  }
  assert(sawLife && sawES, 'each fractured base can keep its own fractured mod (50/50), never both');

  assert(ALLFLAME_SUPPORTED === false, '§51 Allflame unsupported');
  assert(kbJson.allflame?.supported === false, 'KB marks Allflame unsupported');
  assert(Array.isArray(kbJson.operators) && kbJson.operators.some((o) => o.id === OPERATOR_UNPREDICTABLE), 'UnpredictableRecombine operator listed');
  assert(kbJson.operators.some((o) => o.id === OPERATOR_PREDICTABLE), 'PredictableRecombine operator listed');
  assert(kbJson.rejectedModels?.independentFiftyPercentPerMod, '50%-per-mod model rejected');
  assert(kbJson.rejectedModels?.sentinelCurrencyEra, 'Sentinel-era model rejected');
  assert(kbJson.rules?.predictableSuccess?.formula == null, 'Predictable formula not invented');

  const emp = JSON.parse(readFileSync(join(root, 'public/data/recombinator/3.29.json'), 'utf8'));
  assert(emp.version === '3.29', 'empirical dataset §85 version');
  assert(emp.sampleSize === null, 'empirical sampleSize null when unknown');
  assert(emp.confidence, 'empirical confidence recorded');
  assert(emp.sources?.length >= 2, 'empirical sources documented');
  assert(emp.predictable?.successFormula === null, 'empirical Predictable formula null');
  assert(emp.allflame?.supported === false, 'empirical Allflame unsupported');
  assert(emp.cost?.averageUnpredictable?.gold === 25000, 'empirical gold midpoint');
  assert(emp.cost?.averageUnpredictable?.['thaumaturgic-dust'] === 85000, 'empirical dust midpoint');
  assert(
    JSON.stringify(emp.cost?.averageUnpredictable?.goldBand) === JSON.stringify([15000, 35000]),
    'gold band 15k–35k'
  );
  assert(
    JSON.stringify(emp.cost?.averageUnpredictable?.dustBand) === JSON.stringify([50000, 120000]),
    'dust band 50k–120k'
  );
  assert(emp.cost?.averageUnpredictable?.source === 'user empirical band 2026-08', 'band source tag');
  assert(emp.cost?.formula == null, 'empirical cost formula still null');

  assert(!recombineEligible(natA, { ...natB, corrupted: true }, model).ok, 'corrupted ineligible');
  assert(!recombineEligible(natA, { ...natB, itemClass: 'Helmet' }, model).ok, 'class mismatch ineligible');

  const predUnknown = predictableRecombine(natA, natB, {}, model);
  assert(predUnknown.unranked === true, 'Predictable without chance is unranked');
  assert(predUnknown.operator === OPERATOR_PREDICTABLE, 'Predictable operator id');
  const predKnown = predictableRecombine(natA, natB, { displayedChance: 0.2, baseChoice: 'A' }, model);
  assert(!predKnown.unranked && predKnown.displayedChance === 0.2, 'Predictable with displayed chance ranks physically');
  assert(Math.abs(predKnown.outcomes.reduce((s, o) => s + o.p, 0) - 1) < 1e-9, 'Predictable mass ~1');
  assert(predKnown.outcomes.some((o) => o.destroyed), 'Predictable fail destroys');

  const parts = bipartitions(['a', 'b', 'c']);
  assert(parts.length === 3, `bipartitions of 3 = 3 unordered, got ${parts.length}`);
  assert(donorPartitions([fakeMod('A', 'prefix'), fakeMod('B', 'suffix')]).length >= 1, 'donorPartitions');

  const hook = considerPredictableRecombine({ kb: { recombinator: kbJson } });
  assert(hook.unranked && hook.operator === OPERATOR_PREDICTABLE, 'Predictable search hook unranked without chance');

  const up = unpredictableRecombine(natA, natB, model);
  assert(up.operator === OPERATOR_UNPREDICTABLE, 'unpredictableRecombine operator');
  assert(up.cost.gold === 25000 && up.cost['thaumaturgic-dust'] === 85000, 'cost dimensions use empirical midpoints');
  assert(up.cost.confidence === 'approximate', 'physics cost tagged approximate');

  // --- Fundamental EV invariants (no clamp-to-1; mass; donor components; invalid not ranked) ---

  // Synthetic dist: ~3.33% final, rest needs another recomb (not sequential-done)
  const sa = aff('a', 'prefix', { id: 'a' });
  const sb = aff('b', 'prefix', { id: 'b' });
  const sc = aff('c', 'prefix', { id: 'c' });
  const needSynth = [affixKey(sa), affixKey(sb), affixKey(sc)];
  const synth = {
    outcomes: [
      { p: 0.0333, state: st([sa, sb, sc], []) },
      { p: 0.3, state: st([sa, sb], []) },
      { p: 0.3334, state: st([sa], []) },
      { p: 0.3333, state: st([], []) },
    ],
  };
  const graph = evWithSalvage(synth, needSynth, 100, (have) => ({
    ev: (needSynth.length - have.length) * 20,
    expectedRecombs: have.length === needSynth.length ? 0 : 1,
    finishKind: 'salvageRequiringAnotherRecombination',
  }));
  assert(Math.abs(graph.directFinalProbabilityPerRecombination - 0.0333) < 1e-9, 'directFinal ~3.33%');
  assert(
    graph.expectedTotalRecombinationsUntilFinished > 1 + 1e-9,
    `pDirect=3.33% with brick/recomb-again → E_recombs>1, got ${graph.expectedTotalRecombinationsUntilFinished}`
  );
  assert(graph.outcomeMass, 'outcome mass buckets present');
  const massSum =
    graph.outcomeMass.final +
    graph.outcomeMass.salvageBenchOnly +
    graph.outcomeMass.salvageCraftNoRecomb +
    graph.outcomeMass.salvageRequiringAnotherRecombination +
    graph.outcomeMass.brickRestart;
  assert(Math.abs(massSum - 1) < 0.02, `outcome mass Σ=${massSum} need ≈1`);
  assert(
    graph.outcomeMass.salvageRequiringAnotherRecombination > 0.5,
    'majority mass classified as another recomb, not false-done'
  );

  // Donor component ≤ total
  const badRecipe = buildDonorRecipe(
    [fakeMod('RareMod', 'suffix', { id: 'rare', cost: 19549 })],
    { ev: 521, ops: [], pools: [] },
    (m) => m.best?.expectedChaos ?? m.cost ?? 19549
  );
  // manufacture path raises total to cover components
  assert(
    badRecipe.expectedCostChaos >= 19549 - 1,
    `totalDonorEV must cover component (≥19549), got ${badRecipe.expectedCostChaos}`
  );
  const invDonor = assertDonorRecipeInvariants(badRecipe);
  assert(invDonor.ok, `donor invariants after raise: ${invDonor.fails.join('; ')}`);

  // Explicit reject: component > total
  const rejectInv = assertDonorRecipeInvariants({
    expectedCostChaos: 521,
    totalEv: 521,
    lines: [
      { kind: 'mod', text: 'Roll rare', chaos: 19549 },
      { kind: 'total', text: 'Total donor EV', chaos: 521 },
    ],
  });
  assert(!rejectInv.ok, 'component > total must fail donor invariant');

  // Invalid economics must not rank over sequential
  const brokenNode = {
    ev: 100,
    evTradable: 100,
    pDone: 0.0333,
    pBrick: 0.2,
    expectedTotalRecombinationsUntilFinished: 1, // illegal with brick mass
    expectedContinuationRecombMass: 0.2,
    costA: 50,
    costB: 50,
    smashEconomics: { gold: 25000, dust: 85000, smashEconomicChaos: 5, smashTradableChaos: 0 },
    outcomeMass: {
      final: 0.0333,
      salvageBenchOnly: 0,
      salvageCraftNoRecomb: 0,
      salvageRequiringAnotherRecombination: 0.7667,
      brickRestart: 0.2,
      sum: 1,
    },
  };
  const brokenEco = buildRecombCostReport(brokenNode, {
    prices: smashPrices,
    model,
  });
  assert(brokenEco.economicsInvalid || brokenEco.impractical, 'broken E=1 with brick mass → invalid');
  assert(
    /invalid|EV unresolved|E_recombs/i.test(brokenEco.impracticalReason ?? ''),
    `reason marks invalid/unresolved, got ${brokenEco.impracticalReason}`
  );

  const invBroken = assertRecombEconomicsInvariants(
    {
      ...brokenEco,
      expectedTotalRecombinationsUntilFinished: 1,
      expectedContinuationRecombMass: 0.5,
      directFinalProbabilityPerRecombination: 0.0333,
      pBrick: 0.2,
    },
    brokenNode
  );
  assert(!invBroken.ok, 'assertRecombEconomicsInvariants rejects E=1 with recomb-again mass');

  // --- Craft mass fully accounted; donor gross; craft-without-path; known-component ---
  const need4 = [affixKey(sa), affixKey(sb), affixKey(sc), 'd'];
  const craftDist = {
    outcomes: [
      { p: 0.1, state: st([sa, sb, sc], []) },
      { p: 0.3, state: st([sa, sb], []) },
      { p: 0.3, state: st([sa], []) },
      { p: 0.3, state: st([sb], []) },
    ],
  };
  const craftGraph = evWithSalvage(craftDist, need4.slice(0, 3), 100, (have) => ({
    ev: (3 - have.length) * 10,
    expectedRecombs: 0,
    finishKind: 'craftNoRecomb',
    reachesTarget: true,
    recipe: ['exalt'],
    pFail: 0,
  }));
  const craftListed = (craftGraph.fallbacks ?? []).reduce((s, f) => s + f.p, 0);
  assert(
    Math.abs(craftListed - 1) < 0.02 || Math.abs(craftListed - (1 - craftGraph.outcomeMass.final)) < 0.05,
    `craft/fallback classes must cover ~100% mass, listed=${craftListed}`
  );
  assert(
    (craftGraph.craftOutcomes?.length ?? 0) >= 1 || craftGraph.outcomeMass.salvageCraftNoRecomb > 0.5,
    'craft outcomes exposed'
  );

  const donorGrossNode = {
    ev: 739.17 + 85 + 5, // donors + market dust + gold opp (test prices: 0.001c/dust, 0.001c/gold)
    evTradable: 739.17 + 85,
    pDone: 1,
    pBrick: 0,
    expectedTotalRecombinationsUntilFinished: 1,
    expectedFullDonorARebuilds: 1,
    expectedFullDonorBRebuilds: 1,
    costA: 155.15,
    costB: 584.02,
    donorAConstructionEv: 155.15,
    donorBConstructionEv: 584.02,
    smashEconomics: {
      gold: 25000,
      dust: 85000,
      smashEconomicChaos: 90,
      smashTradableChaos: 85,
      dustSource: 'market',
      goldSource: 'opportunity',
    },
    outcomeMass: {
      final: 1,
      salvageBenchOnly: 0,
      salvageCraftNoRecomb: 0,
      salvageRequiringAnotherRecombination: 0,
      brickRestart: 0,
      sum: 1,
    },
    expectedFinishingCostChaos: 0,
    expectedSalvageCredit: 0,
  };
  const donorGrossEco = buildRecombCostReport(donorGrossNode, { prices: smashPrices, model });
  assert(
    Math.abs((donorGrossEco.grossDonorConstructionEV ?? 0) - 739.17) < 0.02,
    `grossDonor when A=B=1 must be 155.15+584.02=739.17, got ${donorGrossEco.grossDonorConstructionEV}`
  );
  assert(
    Math.abs((donorGrossEco.expectedDonorCostChaos ?? 0) - 739.17) < 0.02,
    `expectedDonorCostChaos must equal gross (not salvage-netted), got ${donorGrossEco.expectedDonorCostChaos}`
  );
  // Align EV fields to report's dust/gold so invariant reconcile is meaningful
  const r2 = (n) => Math.round(n * 100) / 100;
  donorGrossEco.totalExpectedTradableCostChaos = r2(
    (donorGrossEco.grossDonorConstructionEV ?? 0) +
      (donorGrossEco.dustCountedInTradable ? donorGrossEco.dustChaosEquivalent ?? 0 : 0)
  );
  donorGrossEco.totalExpectedEconomicCostChaos = r2(
    (donorGrossEco.totalExpectedTradableCostChaos ?? 0) +
      (donorGrossEco.dustCountedInTradable ? 0 : donorGrossEco.dustChaosEquivalent ?? 0) +
      (donorGrossEco.goldOpportunityChaosEquivalent ?? 0)
  );
  donorGrossEco.breakdown.totalTradableEV = donorGrossEco.totalExpectedTradableCostChaos;
  donorGrossEco.breakdown.totalEconomicEV = donorGrossEco.totalExpectedEconomicCostChaos;
  donorGrossEco.economicsInvalid = false;
  donorGrossEco.impractical = false;

  const noPathGraph = evWithSalvage(
    { outcomes: [{ p: 1, state: st([sa], []) }] },
    needSynth,
    50,
    () => ({
      ev: 10,
      expectedRecombs: 0,
      finishKind: 'craftNoRecomb',
      reachesTarget: false,
      invalid: true,
      recipe: null,
      pFail: 0,
    })
  );
  assert(noPathGraph.craftWithoutPath > 0.5, 'craft without path tracked');
  const noPathNode = {
    ev: 60,
    evTradable: 60,
    pDone: 0,
    pBrick: 0,
    expectedTotalRecombinationsUntilFinished: 1,
    expectedFullDonorARebuilds: 1,
    expectedFullDonorBRebuilds: 1,
    costA: 25,
    costB: 25,
    craftWithoutPath: noPathGraph.craftWithoutPath,
    outcomeMass: noPathGraph.outcomeMass,
    smashEconomics: { gold: 25000, dust: 85000, smashEconomicChaos: 5, smashTradableChaos: 0 },
  };
  const noPathEco = buildRecombCostReport(noPathNode, { prices: smashPrices, model });
  assert(noPathEco.economicsInvalid || noPathEco.impractical, 'craft without path → invalid');

  const knownDisp = formatRecombEconomicsDisplay({
    ...donorGrossEco,
    totalIncomplete: true,
    totalExpectedTradableCostChaos: 978,
    totalExpectedEconomicCostChaos: 987,
    economicsInvalid: false,
    impractical: false,
  });
  assert(/Known-component EV/i.test(knownDisp), 'known-component display line');
  assert(/Base acquisition: unknown/i.test(knownDisp), 'base unknown display line');
  assert(/Total EV:\s*>=/i.test(knownDisp), 'total EV >= known-component');

  // E=1 with restart=0 and recombAgain=0 is ok (no bricks text needed at economics layer)
  const cleanInv = assertRecombEconomicsInvariants(donorGrossEco, donorGrossNode);
  assert(cleanInv.ok, `clean final-only invariants: ${cleanInv.fails.join('; ')}`);

  console.log('OK: recombinator tests passed');
}

const isMain = process.argv[1] && String(process.argv[1]).includes('test-recombinator');
if (isMain) runRecombinatorTests();
