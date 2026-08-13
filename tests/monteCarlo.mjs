/**
 * §39 Monte Carlo vs analytic for essence / harvest / recomb / annul.
 * Default 100k trials (document via env MC_TRIALS=1000000 for 1M).
 */
import { assert } from './helpers/assert.js';
import { makeState, makeAffix } from '../src/lib/craftState.js';
import { annul, harvestReforge, essence, recombineOp } from '../src/lib/mechanics/transitions.js';
import { assertProbabilityMass } from '../src/lib/mechanics/prob.js';
import { HARVEST_REFORGES } from '../src/lib/craftKnowledge.js';
import { getRecombinatorModel } from '../src/lib/recombinatorModel.js';
import { mcTrials, monteCarloFrequencies, mcTolerance } from './helpers/monteCarlo.js';

export async function runMonteCarloTests(kb) {
  const n = mcTrials(100_000);
  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const blank = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [],
    suffixes: [],
    baseTags: tags,
  });

  // --- Annul: uniform among removable ---
  const annulState = makeState({
    ...blank,
    prefixes: [
      makeAffix({ id: 'a', text: 'A', gen: 'prefix', groups: ['ga'] }),
      makeAffix({ id: 'b', text: 'B', gen: 'prefix', groups: ['gb'] }),
    ],
    suffixes: [makeAffix({ id: 'c', text: 'C', gen: 'suffix', groups: ['gc'] })],
  });
  const an = annul(annulState);
  assertProbabilityMass(an.outcomes);
  assert(an.outcomes.length === 3, '3 removable affixes');
  {
    const { maxAbs } = monteCarloFrequencies(an.outcomes, n);
    const tol = mcTolerance(n, an.outcomes.length);
    assert(maxAbs <= tol, `annul MC max|Δ|=${maxAbs.toFixed(5)} ≤ tol ${tol.toFixed(5)} (n=${n})`);
  }

  // --- Harvest: weighted rows ---
  const harvest = HARVEST_REFORGES.find((h) => h.id === 'reforge-critical');
  assert(harvest, 'reforge-critical');
  const hr = harvestReforge(blank, kb, harvest, { generation: 'suffix' });
  assertProbabilityMass(hr.outcomes);
  // Cap MC on huge pools: collapse to top-K + other for speed, or sample subset.
  // For harvest, outcomes can be large — compare on a truncated view of top 20 + residual.
  {
    const sorted = [...hr.outcomes].sort((a, b) => b.p - a.p);
    const top = sorted.slice(0, 40);
    const restP = sorted.slice(40).reduce((s, o) => s + o.p, 0);
    const compact =
      restP > 1e-12
        ? [...top, { p: restP, state: null, _residual: true }]
        : top;
    assertProbabilityMass(compact);
    const trials = Math.min(n, 200_000);
    const { maxAbs } = monteCarloFrequencies(compact, trials);
    const tol = mcTolerance(trials, compact.length) * 1.5;
    assert(maxAbs <= tol, `harvest MC max|Δ|=${maxAbs.toFixed(5)} ≤ ${tol.toFixed(5)} (n=${trials})`);
  }

  // --- Essence: deterministic p=1 ---
  const zeal = (kb.essences ?? []).find((e) => /Deafening Essence of Zeal/i.test(e.name));
  assert(zeal, 'Zeal');
  const ess = essence(blank, kb, zeal.name);
  assertProbabilityMass(ess.outcomes);
  {
    const { freqs, maxAbs } = monteCarloFrequencies(ess.outcomes, Math.min(n, 10_000));
    assert(freqs[0] === 1 && maxAbs === 0, 'essence MC always hits guaranteed outcome');
  }

  // --- Recombinator ---
  const model = getRecombinatorModel(kb);
  const a = makeState({
    itemClass: 'Gloves',
    prefixes: [makeAffix({ id: 'p1', text: 'P1', gen: 'prefix', groups: ['p1'] })],
    suffixes: [makeAffix({ id: 's1', text: 'S1', gen: 'suffix', groups: ['s1'] })],
  });
  const b = makeState({
    itemClass: 'Gloves',
    prefixes: [makeAffix({ id: 'p2', text: 'P2', gen: 'prefix', groups: ['p2'] })],
    suffixes: [],
  });
  const re = recombineOp(a, b, model);
  assertProbabilityMass(re.outcomes);
  {
    const sorted = [...re.outcomes].sort((x, y) => y.p - x.p);
    const top = sorted.slice(0, 60);
    const restP = sorted.slice(60).reduce((s, o) => s + o.p, 0);
    const compact = restP > 1e-12 ? [...top, { p: restP, state: null }] : top;
    const trials = Math.min(n, 250_000);
    const { maxAbs } = monteCarloFrequencies(compact, trials);
    const tol = mcTolerance(trials, compact.length) * 1.5;
    assert(maxAbs <= tol, `recomb MC max|Δ|=${maxAbs.toFixed(5)} ≤ ${tol.toFixed(5)} (n=${trials})`);
  }

  console.log(`OK: monte carlo tests passed (n=${n}; set MC_TRIALS=1000000 for 1M)`);
}
