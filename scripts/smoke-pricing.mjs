import { multiDimensionCost, formatMultiCost, tradableChaosCost } from '../src/lib/pricing/costs.js';
import { lookupItemTradePrice } from '../src/lib/pricing/trade.js';
import { classifyPlan } from '../src/lib/planClass.js';
import { assemblePlan } from '../src/lib/planSchema.js';
import { chaosCost } from '../src/lib/craftKnowledge.js';

function assert(c, m) {
  if (!c) throw new Error(m);
}

const dims = multiDimensionCost({ divine: 2, gold: null, 'thaumaturgic-dust': null }, { divine: 200 });
assert(dims.chaosEquivalent === 400, 'chaos');
assert(/400c \+ \? Gold \+ \? Dust/.test(formatMultiCost(dims)), 'fmt');
assert(chaosCost({ gold: 100, divine: 1 }, { gold: 1, divine: 10 }) === 10, 'chaosCost skips gold');
assert(tradableChaosCost({ gold: 100, divine: 1 }, { gold: 1, divine: 10 }) === 10, 'tradable');
assert(lookupItemTradePrice({}).priceChaos == null, 'trade');
assert(classifyPlan({ method: 'recombinator', steps: [{ operator: 'recombine', chance: 0.03 }] }).id === 'probabilistic-recombination', 'class');
const a = assemblePlan(
  {
    method: 'x',
    name: 'x',
    steps: [{ operator: 'exalt', chance: 0.5, cost: { exalt: 10 } }],
    costs: { exalt: 10 },
    totalCost: 50,
  },
  { unmatched: [{ text: 'bad' }], alternatives: [{ id: 'a', name: 'Alt', totalCost: 99, why: 'worse' }] }
);
assert(a.unsupported && a.expectedTradableCost == null, 'unsupported');
assert(a.confidence && a.rejectedStrategies?.length, 'schema');
console.log('PASS pricing-schema-smoke');
