/**
 * Layer A mechanics tests. Run via scripts/test-phase1.mjs
 */
import { makeState, makeAffix, cloneState } from '../src/lib/craftState.js';
import { getEligibleMods } from '../src/lib/spawnWeights.js';
import { assertProbabilityMass } from '../src/lib/mechanics/prob.js';
import {
  exalt,
  annul,
  harvestReforge,
  essence,
  eldritchChaos,
  applyMetacraft,
} from '../src/lib/mechanics/transitions.js';
import { validatePlan } from '../src/lib/mechanics/validatePlan.js';
import { HARVEST_REFORGES, modMatchesHarvest } from '../src/lib/craftKnowledge.js';
import { expectedAttempts, expectedAttemptsDisplay } from '../src/lib/expected.js';
import { classifyPlan } from '../src/lib/planClass.js';
import { rulesetVersion } from '../src/lib/ruleset.js';
import { normalizeItemClass } from '../src/lib/itemClass.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

export async function runMechanicsTests(kb) {
  assert(expectedAttempts(0.4) === 2.5, `EV uses 1/p, got ${expectedAttempts(0.4)}`);
  assert(expectedAttemptsDisplay(0.4) === 3, `display ceils, got ${expectedAttemptsDisplay(0.4)}`);
  assert(normalizeItemClass('Wands') === 'Wand', 'Wands → Wand centralized');
  assert(normalizeItemClass('Body Armours') === 'Body Armour', 'Body Armours → Body Armour');
  assert(rulesetVersion() === '3.29', 'active ruleset 3.29');

  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const blank = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [],
    suffixes: [],
    baseTags: tags,
  });

  const crit = kb.natural.find(
    (m) => m.generation === 'suffix' && /Global Critical Strike Multiplier/i.test(m.text || '')
  );
  assert(crit, 'found crit multi');
  const before = getEligibleMods(kb, blank, { generation: 'suffix' });
  const afterOcc = getEligibleMods(kb, blank, {
    generation: 'suffix',
    occupiedGroups: crit.groups ?? [],
  });
  assert(
    afterOcc.total < before.total,
    `occupied group shrinks suffix pool ${before.total} → ${afterOcc.total}`
  );
  assert(
    !afterOcc.rows.some((r) => (r.groups ?? []).some((g) => (crit.groups ?? []).includes(g))),
    'occupied group cannot roll again'
  );

  const suffixKeep = makeAffix({
    id: 'keep-as',
    text: '25% increased Attack Speed',
    gen: 'suffix',
    groups: ['IncreasedAttackSpeed'],
  });
  const locked = makeState({
    ...blank,
    suffixes: [suffixKeep],
    prefixes: [makeAffix({ text: 'filler life', gen: 'prefix', groups: ['IncreasedLife'] })],
    metacrafts: ['Suffixes Cannot Be Changed'],
    baseTags: tags,
  });
  const harvest = HARVEST_REFORGES.find((h) => h.id === 'reforge-life');
  const hr = harvestReforge(locked, kb, harvest);
  assertProbabilityMass(hr.outcomes);
  for (const o of hr.outcomes) {
    assert(
      o.state.suffixes.length === 1 && o.state.suffixes[0].text === suffixKeep.text,
      'SCBC protects suffixes on reforge'
    );
  }

  const armourTags = kb.basesByName['Twilight Regalia']?.tags ?? ['int_armour', 'body_armour', 'default'];
  const armourBlank = makeState({
    itemClass: 'Body Armour',
    baseType: 'Twilight Regalia',
    itemLevel: 86,
    prefixes: [],
    suffixes: [],
    baseTags: armourTags,
  });
  const eater = makeState({
    ...armourBlank,
    eldritchDominance: 'eater',
    prefixes: [makeAffix({ text: 'p', gen: 'prefix' })],
  });
  const exarch = makeState({
    ...armourBlank,
    eldritchDominance: 'exarch',
    suffixes: [makeAffix({ text: 's', gen: 'suffix' })],
  });
  const eat = eldritchChaos(eater, kb);
  const exa = eldritchChaos(exarch, kb);
  assert(!eat.illegal, 'eater dominance legal on Body Armour');
  assert(!exa.illegal, 'exarch dominance legal on Body Armour');
  if (eat.outcomes.length) assertProbabilityMass(eat.outcomes);
  const keepP = eater.prefixes[0];
  for (const o of eat.outcomes) {
    assert(o.state.prefixes.some((a) => a.text === keepP.text), 'Eater chaos leaves prefixes (rolls suffixes)');
  }
  const wandEld = eldritchChaos(
    makeState({ ...blank, eldritchDominance: 'eater', prefixes: [makeAffix({ text: 'p', gen: 'prefix' })] }),
    kb
  );
  assert(wandEld.illegal, 'eldritch illegal on Wand');

  const zeal = (kb.essences ?? []).find((e) => /Deafening Essence of Zeal/i.test(e.name));
  assert(zeal, 'Deafening Zeal in RePoE tables');
  const wandMod = zeal.mods_by_item_class?.Wand;
  assert(wandMod, 'Zeal grants a mod on Wand');
  const ess = essence(blank, kb, zeal.name);
  assert(!ess.illegal, 'essence on blank is legal');
  assert(ess.outcomes[0].state.suffixes.length + ess.outcomes[0].state.prefixes.length >= 1, 'essence guaranteed mod');
  const granted = kb.modById.get(wandMod);
  const got = [...ess.outcomes[0].state.prefixes, ...ess.outcomes[0].state.suffixes];
  assert(
    got.some((a) => a.id === wandMod || (granted && a.text === granted.text)),
    'essence guaranteed mod on correct class'
  );

  const ex = exalt(blank, kb, { generation: 'suffix' });
  assertProbabilityMass(ex.outcomes);
  const an = annul(
    makeState({
      ...blank,
      prefixes: [makeAffix({ text: 'a', gen: 'prefix' })],
      suffixes: [makeAffix({ text: 'b', gen: 'suffix' })],
    })
  );
  assertProbabilityMass(an.outcomes);

  const withMeta = applyMetacraft(blank, 'Suffixes Cannot Be Changed').outcomes[0].state;
  const badEss = essence(withMeta, kb, zeal.name);
  assert(badEss.illegal === 'essence after metamod', 'essence after metamod is illegal at mechanics layer');

  const replay = validatePlan(
    {
      itemClass: 'Wand',
      baseTags: tags,
      minIlvl: 85,
      steps: [
        { operator: 'harvestFill', action: 'Suffixes Cannot Be Changed → Harvest Reforge Critical' },
        { operator: 'essenceFish', action: 'Spam Deafening Essence of Zeal' },
      ],
    },
    kb
  );
  assert(!replay.ok, 'replay rejects illegal essence-after-metamod');
  assert(
    replay.errors.some((e) => /essence after metamod/i.test(e.reason)),
    `replay reason, got ${JSON.stringify(replay.errors)}`
  );

  const recombPlan = { method: 'recombinator', methodName: 'Recombinator', steps: [{ operator: 'recombine', chance: 0.03 }] };
  const kind = classifyPlan(recombPlan);
  assert(kind.id === 'probabilistic-recombination', `3% recomb is not deterministic, got ${kind.id}`);
  assert(!/deterministic/i.test(kind.label), 'never call recomb deterministic');

  const harvestJs = HARVEST_REFORGES.find((h) => h.id === 'reforge-critical');
  const official = kb.harvest?.crafts?.find((c) => c.id === 'reforge-critical');
  assert(official?.lifeforce?.primal === 150, 'harvest juice from generated JSON');
  assert(harvestJs.lifeforce?.primal === 150, 'JS matching overlay consumed JSON costs');

  console.log('OK: mechanics tests passed');
}
