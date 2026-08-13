/**
 * Spawn-weight / eligible-pool unit tests (§41).
 */
import { assert } from './helpers/assert.js';
import { makeState, makeAffix } from '../src/lib/craftState.js';
import {
  getEligibleMods,
  collectOccupiedGroups,
  essenceFishExpected,
  exaltExpected,
  harvestEligiblePool,
} from '../src/lib/spawnWeights.js';
import { HARVEST_REFORGES, modMatchesHarvest } from '../src/lib/craftKnowledge.js';
import { assertProbabilityMass } from '../src/lib/mechanics/prob.js';
import { exalt } from '../src/lib/mechanics/transitions.js';

export async function runWeightsTests(kb) {
  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const blank = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [],
    suffixes: [],
    baseTags: tags,
  });

  const suf = getEligibleMods(kb, blank, { generation: 'suffix' });
  assert(suf.total > 0 && suf.rows.length > 0, 'blank wand has suffix pool');
  const sumW = suf.rows.reduce((s, r) => s + r.weight, 0);
  assert(Math.abs(sumW - suf.total) < 1e-6, 'eligible rows weight sum = total');

  const crit = kb.natural.find(
    (m) => m.generation === 'suffix' && /Global Critical Strike Multiplier/i.test(m.text || '')
  );
  assert(crit, 'crit multi in natural');
  const after = getEligibleMods(kb, blank, {
    generation: 'suffix',
    occupiedGroups: crit.groups ?? [],
  });
  assert(after.total < suf.total, 'occupied group shrinks pool');

  const harvest = HARVEST_REFORGES.find((h) => h.id === 'reforge-critical');
  assert(harvest, 'reforge-critical overlay');
  const pool = harvestEligiblePool(kb, tags, 85, 'suffix', harvest, modMatchesHarvest, []);
  assert(pool.total > 0, 'harvest crit pool non-empty');
  assert(pool.rows.every((r) => modMatchesHarvest(r, harvest)), 'harvest pool rows match tag filter');

  const asGoal = kb.natural.find((m) => m.generation === 'suffix' && /Attack Speed/i.test(m.text || ''));
  if (asGoal) {
    const fish = essenceFishExpected(kb, tags, 85, 'suffix', [{ ...asGoal, gen: 'suffix', text: asGoal.text }], 2, []);
    if (fish.pAll > 0 && fish.pAll < 1) {
      assert(Math.abs(fish.expected - Math.min(1 / fish.pAll, 5000)) < 1e-6, 'essence EV = 1/p');
    }
  }

  const occupied = collectOccupiedGroups([
    makeAffix({ text: 'x', gen: 'suffix', groups: ['IncreasedAttackSpeed'] }),
  ]);
  assert(occupied.has('IncreasedAttackSpeed'), 'collectOccupiedGroups Set');

  const ex = exalt(blank, kb, { generation: 'suffix' });
  assertProbabilityMass(ex.outcomes);
  const exOdds = exaltExpected(
    kb,
    tags,
    85,
    { ...crit, gen: 'suffix', text: crit.text },
    []
  );
  assert(exOdds.pRoll > 0 && exOdds.pRoll < 1, 'exalt crit multi odds in (0,1)');

  console.log('OK: weights tests passed');
}
