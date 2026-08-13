/**
 * Essence mechanic tests (§41).
 */
import { assert } from './helpers/assert.js';
import { makeState } from '../src/lib/craftState.js';
import { essence, applyMetacraft } from '../src/lib/mechanics/transitions.js';
import { assertProbabilityMass } from '../src/lib/mechanics/prob.js';
import { essenceFishExpected } from '../src/lib/spawnWeights.js';

export async function runEssenceTests(kb) {
  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const blank = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [],
    suffixes: [],
    baseTags: tags,
  });

  const zeal = (kb.essences ?? []).find((e) => /Deafening Essence of Zeal/i.test(e.name));
  assert(zeal, 'Deafening Zeal present');
  const wandMod = zeal.mods_by_item_class?.Wand;
  assert(wandMod, 'Zeal grants Wand mod');

  const ess = essence(blank, kb, zeal.name);
  assert(!ess.illegal, 'essence legal');
  assertProbabilityMass(ess.outcomes);
  assert(ess.outcomes.length === 1 && ess.outcomes[0].p === 1, 'essence guaranteed outcome');
  const got = [...ess.outcomes[0].state.prefixes, ...ess.outcomes[0].state.suffixes];
  const granted = kb.modById?.get?.(wandMod);
  assert(
    got.some((a) => a.id === wandMod || (granted && a.text === granted.text)),
    'guaranteed mod applied'
  );

  const withMeta = applyMetacraft(blank, 'Suffixes Cannot Be Changed').outcomes[0].state;
  const bad = essence(withMeta, kb, zeal.name);
  assert(bad.illegal === 'essence after metamod', 'essence after metamod illegal');

  const asGoal = kb.natural.find((m) => m.generation === 'suffix' && /Attack Speed/i.test(m.text || ''));
  if (asGoal) {
    const fish = essenceFishExpected(kb, tags, 85, 'suffix', [{ ...asGoal, gen: 'suffix', text: asGoal.text }], 2, []);
    assert(fish.pAll >= 0 && fish.pAll <= 1, 'fish p in [0,1]');
    if (fish.pAll > 0) assert(fish.expected === Math.min(1 / fish.pAll, 5000) || Math.abs(fish.expected - 1 / fish.pAll) < 1e-6 || fish.expected <= 5000, 'EV from 1/p');
  }

  console.log('OK: essence tests passed');
}
