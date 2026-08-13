/**
 * §70–71 sanity bounds + Σp=1 across mechanic transitions.
 */
import { assert } from './helpers/assert.js';
import { makeState, makeAffix } from '../src/lib/craftState.js';
import { probabilityMass, assertProbabilityMass } from '../src/lib/mechanics/prob.js';
import {
  exalt,
  annul,
  harvestReforge,
  essence,
  eldritchChaos,
  veiledExalt,
  recombineOp,
} from '../src/lib/mechanics/transitions.js';
import { HARVEST_REFORGES } from '../src/lib/craftKnowledge.js';
import { getRecombinatorModel, affixCountDistribution } from '../src/lib/recombinatorModel.js';
import { expectedAttempts } from '../src/lib/expected.js';

export async function runSanityTests(kb) {
  assert(expectedAttempts(0.25) === 4, 'EV 1/p');
  assert(expectedAttempts(0) === Infinity, 'p=0 → Infinity');

  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const blank = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [],
    suffixes: [],
    baseTags: tags,
  });

  const ops = [];
  ops.push(['exalt', exalt(blank, kb, { generation: 'suffix' })]);
  ops.push([
    'annul',
    annul(
      makeState({
        ...blank,
        prefixes: [makeAffix({ text: 'a', gen: 'prefix' })],
        suffixes: [makeAffix({ text: 'b', gen: 'suffix' })],
      })
    ),
  ]);
  const harvest = HARVEST_REFORGES.find((h) => h.id === 'reforge-critical');
  ops.push(['harvest', harvestReforge(blank, kb, harvest, { generation: 'suffix' })]);
  const zeal = (kb.essences ?? []).find((e) => /Deafening Essence of Zeal/i.test(e.name));
  ops.push(['essence', essence(blank, kb, zeal.name)]);
  ops.push([
    'eldritch',
    eldritchChaos(
      makeState({
        ...blank,
        eldritchDominance: 'eater',
        prefixes: [makeAffix({ text: 'p', gen: 'prefix' })],
      }),
      kb
    ),
  ]);
  ops.push([
    'veiledExalt',
    veiledExalt(
      makeState({
        ...blank,
        prefixes: [makeAffix({ text: 'p', gen: 'prefix' })],
        suffixes: [makeAffix({ text: 's', gen: 'suffix' })],
      }),
      kb
    ),
  ]);
  ops.push([
    'recomb',
    recombineOp(
      makeState({
        itemClass: 'Gloves',
        prefixes: [makeAffix({ text: 'p1', gen: 'prefix', groups: ['p1'] })],
        suffixes: [],
      }),
      makeState({
        itemClass: 'Gloves',
        prefixes: [makeAffix({ text: 'p2', gen: 'prefix', groups: ['p2'] })],
        suffixes: [],
      }),
      getRecombinatorModel(kb)
    ),
  ]);

  for (const [name, r] of ops) {
    if (r.illegal) continue;
    assert(r.outcomes?.length > 0, `${name} has outcomes`);
    assertProbabilityMass(r.outcomes);
    for (const o of r.outcomes) {
      assert(o.p >= 0 && o.p <= 1 + 1e-9, `${name} p in [0,1]`);
    }
    const mass = probabilityMass(r.outcomes);
    assert(Math.abs(mass - 1) < 1e-6, `${name} Σp=${mass}`);
  }

  const model = getRecombinatorModel(kb);
  for (const size of [1, 2, 3, 4, 5, 6]) {
    const dist = affixCountDistribution(size, model);
    const s = Object.values(dist).reduce((a, b) => a + b, 0);
    assert(Math.abs(s - 1) < 1e-6, `affixCountDistribution(${size}) Σp=${s}`);
  }

  console.log('OK: sanity / Σp=1 tests passed');
}
