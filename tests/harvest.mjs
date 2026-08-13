/**
 * Harvest mechanic tests (§41).
 */
import { assert } from './helpers/assert.js';
import { makeState, makeAffix } from '../src/lib/craftState.js';
import { assertProbabilityMass } from '../src/lib/mechanics/prob.js';
import { harvestReforge, applyMetacraft } from '../src/lib/mechanics/transitions.js';
import { HARVEST_REFORGES, modMatchesHarvest } from '../src/lib/craftKnowledge.js';

export async function runHarvestTests(kb) {
  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const blank = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [],
    suffixes: [],
    baseTags: tags,
  });

  const harvest = HARVEST_REFORGES.find((h) => h.id === 'reforge-critical');
  assert(harvest, 'reforge-critical');
  const hr = harvestReforge(blank, kb, harvest, { generation: 'suffix' });
  assert(!hr.illegal, 'harvest legal on blank');
  assertProbabilityMass(hr.outcomes);
  assert(hr.outcomes.every((o) => o.state.suffixes.length === 1), 'reforge leaves one suffix');
  assert(
    hr.outcomes.every((o) => modMatchesHarvest(o.state.suffixes[0], harvest)),
    'rolled mod matches harvest filter'
  );

  const keep = makeAffix({
    id: 'as',
    text: '18% increased Attack Speed',
    gen: 'suffix',
    groups: ['IncreasedAttackSpeed'],
  });
  const locked = applyMetacraft(
    makeState({
      ...blank,
      suffixes: [keep],
      prefixes: [makeAffix({ text: 'filler', gen: 'prefix', groups: ['IncreasedLife'] })],
      baseTags: tags,
    }),
    'Suffixes Cannot Be Changed'
  ).outcomes[0].state;

  const life = HARVEST_REFORGES.find((h) => h.id === 'reforge-life') ?? harvest;
  const protectedHr = harvestReforge(locked, kb, life);
  assertProbabilityMass(protectedHr.outcomes);
  for (const o of protectedHr.outcomes) {
    assert(
      o.state.suffixes.length === 1 && o.state.suffixes[0].text === keep.text,
      'SCBC protects suffixes'
    );
  }

  const official = kb.harvest?.crafts?.find((c) => c.id === 'reforge-critical');
  if (official?.lifeforce) {
    assert(official.lifeforce.primal === 150 || official.lifeforce.primal > 0, 'official juice cost');
  }

  console.log('OK: harvest tests passed');
}
