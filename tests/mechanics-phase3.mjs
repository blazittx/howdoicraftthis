/**
 * Phase 3 mechanics tests (Harvest / Eldritch / Veiled / Fossils / Beasts / availability).
 */
import { makeState, makeAffix } from '../src/lib/craftState.js';
import { assertProbabilityMass } from '../src/lib/mechanics/prob.js';
import {
  exalt,
  annul,
  veiledExalt,
  veiledChaos,
  unveil,
  unveilOdds,
  harvestReforge,
  harvestAugmentRemove,
  harvestRemoveTagged,
  harvestResistanceSwap,
  setupDominance,
  eldritchChaos,
  eldritchAnnul,
  eldritchExalt,
  fossilCraft,
  fossilEligiblePool,
  findFossil,
  beastAddPrefixRemoveSuffix,
  beastAddSuffixRemovePrefix,
  beastSplit,
  essence,
  applyMetacraft,
  methodAvailable,
  sourcesCompatibleWithMethod,
  annulRemove,
} from '../src/lib/mechanics/index.js';
import { veiledExaltRemove, harvestRemove, beastRemove } from '../src/lib/mechanics/remove.js';
import { affixCountDistribution } from '../src/lib/mechanics/affixCounts.js';
import { HARVEST_REFORGES } from '../src/lib/craftKnowledge.js';
import { setRuleset, listRulesets, harvestRespectsCannotRoll, RULES_326 } from '../src/lib/ruleset.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

export async function runPhase3MechanicsTests(kb) {
  assert(listRulesets().includes('3.26') && listRulesets().includes('3.29'), 'rulesets 3.26–3.29');
  assert(harvestRespectsCannotRoll() === true, '3.29 harvest respects cannot-roll');
  setRuleset('3.26');
  assert(harvestRespectsCannotRoll() === false, '3.26 harvest does not respect cannot-roll');
  setRuleset('3.29');

  assert(kb.harvestMenu?.crafts?.length > 20, 'full harvest menu loaded');
  assert(kb.beastcraft?.recipes?.length >= 3, 'beast recipes loaded');
  assert(kb.affixCounts?.methods?.chaos, 'affix-count distributions loaded');
  assert(kb.preconditions?.operators?.essence, 'operator preconditions loaded');

  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const blank = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [],
    suffixes: [],
    baseTags: tags,
  });

  // §19 distinct remove kinds
  const stuffed = makeState({
    ...blank,
    prefixes: [
      makeAffix({ text: 'p1', gen: 'prefix', groups: ['A'] }),
      makeAffix({ text: 'p2', gen: 'prefix', groups: ['B'] }),
    ],
    suffixes: [
      makeAffix({ text: 's1', gen: 'suffix', groups: ['C'] }),
      makeAffix({ text: 's2', gen: 'suffix', groups: ['D'], crafted: true }),
    ],
  });
  const a = annulRemove(stuffed);
  const v = veiledExaltRemove(stuffed);
  assert(a.kind === 'annul' && v.kind === 'veiled-exalt-remove', 'annul ≠ veiled-exalt-remove kinds');
  assert(a.outcomes.length === 4, 'annul can remove crafted');
  assert(v.outcomes.length === 3, 'veiled exalt remove skips crafted');
  assertProbabilityMass(a.outcomes);
  assertProbabilityMass(v.outcomes);

  const harvestLife = HARVEST_REFORGES.find((h) => h.id === 'reforge-life');
  const lifeOn = makeState({
    ...blank,
    prefixes: [makeAffix({ text: '+80 to maximum Life', gen: 'prefix', groups: ['IncreasedLife'], tags: ['life'] })],
    suffixes: [makeAffix({ text: 'AS', gen: 'suffix', groups: ['IncreasedAttackSpeed'] })],
  });
  const hr = harvestRemove(lifeOn, harvestLife);
  assert(hr.kind === 'harvest-remove', 'harvest remove kind');
  if (hr.outcomes.length) assertProbabilityMass(hr.outcomes);

  const br = beastRemove(stuffed, 'suffix');
  assert(br.kind === 'beast-remove', 'beast remove kind');

  // §8 / §20 harvest menu
  const aug = kb.harvestMenu.crafts.find((c) => c.id === 'augment-remove-fire');
  assert(aug?.kind === 'augment-remove', 'augment-remove in menu');
  const openRare = makeState({
    ...blank,
    prefixes: [makeAffix({ text: 'life', gen: 'prefix', groups: ['IncreasedLife'], tags: ['life'] })],
    suffixes: [makeAffix({ text: 'res', gen: 'suffix', groups: ['FireResistance'], tags: ['fire'] })],
  });
  const augR = harvestAugmentRemove(openRare, kb, aug);
  if (!augR.illegal && augR.outcomes.length) assertProbabilityMass(augR.outcomes);

  const swap = kb.harvestMenu.crafts.find((c) => c.id === 'res-swap-fire-to-cold');
  const swapR = harvestResistanceSwap(openRare, kb, swap);
  if (!swapR.illegal && swapR.outcomes.length) assertProbabilityMass(swapR.outcomes);

  const locked = applyMetacraft(
    makeState({
      ...blank,
      itemClass: 'Body Armour',
      suffixes: [makeAffix({ text: 'keep', gen: 'suffix', groups: ['X'] })],
      prefixes: [makeAffix({ text: 'filler', gen: 'prefix', groups: ['Y'] })],
      baseTags: kb.basesByName['Simple Robe']?.tags ?? ['body_armour', 'default'],
    }),
    'Suffixes Cannot Be Changed'
  ).outcomes[0].state;
  const reforge = harvestReforge(locked, kb, harvestLife);
  assertProbabilityMass(reforge.outcomes);
  for (const o of reforge.outcomes) {
    assert(o.state.suffixes.some((a) => a.text === 'keep'), 'SCBC protects on harvest reforge');
  }

  // §16 Eldritch
  const helm = makeState({
    itemClass: 'Helmet',
    baseType: 'Bone Helmet',
    itemLevel: 85,
    prefixes: [makeAffix({ text: 'p', gen: 'prefix' })],
    suffixes: [makeAffix({ text: 's', gen: 'suffix' })],
    baseTags: ['helmet', 'armour', 'default'],
  });
  const dom = setupDominance(helm, { emberTier: 0, ichorTier: 2 });
  assert(dom.outcomes[0].state.eldritchDominance === 'eater', 'ichor dominant → eater');
  const ec = eldritchChaos(dom.outcomes[0].state, kb);
  assert(!ec.illegal, 'eldritch chaos legal with dominance');
  if (ec.outcomes.length) assertProbabilityMass(ec.outcomes);
  const ea = eldritchAnnul(dom.outcomes[0].state);
  assertProbabilityMass(ea.outcomes);
  const ee = eldritchExalt(dom.outcomes[0].state, kb);
  if (ee.outcomes.length && !ee.outcomes[0].blocked) assertProbabilityMass(ee.outcomes);

  // §17 Veiled Chaos ≠ Veiled Exalted; no fake 1/13
  const ve = veiledExalt(stuffed, kb);
  assertProbabilityMass(ve.outcomes);
  assert(ve.cost.veiled === 1, 'veiled exalt cost key');
  const vc = veiledChaos(
    makeState({
      ...blank,
      prefixes: [makeAffix({ text: 'a', gen: 'prefix', fractured: true, groups: ['F'] })],
      suffixes: [],
      fracturedItem: true,
    }),
    kb
  );
  assert(vc.cost['veiled-chaos'] === 1, 'veiled chaos distinct cost');
  if (vc.outcomes.length) assertProbabilityMass(vc.outcomes);

  const withVeiled = makeState({
    ...blank,
    prefixes: [makeAffix({ text: 'Veiled Prefix', gen: 'prefix', veiled: true, source: 'veiled' })],
  });
  const uv = unveil(withVeiled, kb);
  if (uv.unknown) {
    assert(uv.illegal || !uv.outcomes.length, 'unknown unveil is not fake 1/13');
  } else if (uv.outcomes.length) {
    assertProbabilityMass(uv.outcomes);
    assert(uv.outcomes.length !== 13 || uv.outcomes.some((o) => o.p !== 1 / 13), 'not uniform fake 1/13');
  }
  const odds = unveilOdds(kb, blank, { gen: 'suffix', text: 'Impossible Unlikely Mod XYZ' });
  assert(odds.unknown || odds.expected === Infinity || !(odds.pRoll > 0), 'missing unveil target → unknown, not 1/13');

  // §22 fossils
  const dense = findFossil(kb, 'Dense Fossil');
  assert(dense, 'Dense Fossil in RePoE');
  const scorched = findFossil(kb, 'Scorched Fossil');
  assert(scorched, 'Scorched Fossil in RePoE — generic simulator');
  const pool = fossilEligiblePool(kb, blank, [scorched]);
  assert(pool.total > 0, 'fossil pool non-empty');
  // Prefer pool query for weight math; full rare expansion is capped
  const fc = fossilCraft(
    makeState({
      ...blank,
      prefixes: [makeAffix({ text: 'frac', gen: 'prefix', fractured: true, groups: ['FracP'] })],
      fracturedItem: true,
    }),
    kb,
    ['Scorched Fossil'],
    { sockets: 1 }
  );
  assert(!fc.illegal, 'fossil craft legal');
  assert(fc.outcomes.length <= 48, 'fossil outcomes capped');
  if (fc.outcomes.length) assertProbabilityMass(fc.outcomes);

  // §21 beasts
  const rareOpen = makeState({
    ...blank,
    prefixes: [makeAffix({ text: 'p', gen: 'prefix', groups: ['P1'] })],
    suffixes: [
      makeAffix({ text: 's1', gen: 'suffix', groups: ['S1'] }),
      makeAffix({ text: 's2', gen: 'suffix', groups: ['S2'] }),
    ],
  });
  const wolf = beastAddPrefixRemoveSuffix(rareOpen, kb);
  if (!wolf.illegal && wolf.outcomes.length) assertProbabilityMass(wolf.outcomes);
  const lynx = beastAddSuffixRemovePrefix(
    makeState({
      ...blank,
      prefixes: [
        makeAffix({ text: 'p1', gen: 'prefix', groups: ['P1'] }),
        makeAffix({ text: 'p2', gen: 'prefix', groups: ['P2'] }),
      ],
      suffixes: [makeAffix({ text: 's', gen: 'suffix', groups: ['S1'] })],
    }),
    kb
  );
  if (!lynx.illegal && lynx.outcomes.length) assertProbabilityMass(lynx.outcomes);

  const six = makeState({
    ...blank,
    prefixes: [1, 2, 3].map((i) => makeAffix({ text: `p${i}`, gen: 'prefix', groups: [`P${i}`] })),
    suffixes: [1, 2, 3].map((i) => makeAffix({ text: `s${i}`, gen: 'suffix', groups: [`S${i}`] })),
  });
  const split2 = beastSplit(six, kb, { parts: 2 });
  assert(!split2.illegal, 'split-two legal');
  assert(split2.outcomes[0].state.split === true, 'split flag set');
  const split3 = beastSplit(six, kb, { parts: 3 });
  assert(!split3.illegal && split3.parts === 3, 'split-three on 6 mods');

  // §58–59 / §82
  assert(sourcesCompatibleWithMethod('unveiled', 'unveil', kb), 'unveil compatible with unveiled source');
  assert(!sourcesCompatibleWithMethod('crafted', 'exalt', kb), 'crafted not via exalt');
  const essAvail = methodAvailable(applyMetacraft(blank, 'SCBC').outcomes[0].state, 'essence', kb);
  assert(essAvail.illegal || !essAvail.ok, 'essence unavailable after metamod');

  // §73
  const dist = affixCountDistribution(kb, 'chaos');
  const sum = (dist.byTotal ?? []).reduce((s, r) => s + r.p, 0);
  assert(Math.abs(sum - 1) < 0.02, `chaos affix-count Σp≈1 got ${sum}`);

  // §83
  const bad = essence(applyMetacraft(blank, 'Suffixes Cannot Be Changed').outcomes[0].state, kb, 'Deafening Essence of Zeal');
  assert(bad.illegal === 'essence after metamod', '§83 essence+metamod illegal');

  // §18 bench blockers shrink exalt pool
  const blocked = makeState({
    ...blank,
    metacrafts: ['Cannot roll Attack Modifiers'],
  });
  const exNormal = exalt(blank, kb, { generation: 'suffix' });
  const exBlocked = exalt(blocked, kb, { generation: 'suffix' });
  if (exNormal.outcomes.length && exBlocked.outcomes.length) {
    assert(exBlocked.outcomes.length <= exNormal.outcomes.length, 'cannot-roll attack shrinks exalt pool');
  }
  assertProbabilityMass(annul(stuffed).outcomes);

  console.log('OK: phase3 mechanics tests passed');
}
