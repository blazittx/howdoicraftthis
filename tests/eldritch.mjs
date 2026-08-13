/**
 * Eldritch chaos / dominance tests (§41).
 */
import { assert } from './helpers/assert.js';
import { makeState, makeAffix } from '../src/lib/craftState.js';
import { eldritchChaos } from '../src/lib/mechanics/transitions.js';
import { assertProbabilityMass, probabilityMass } from '../src/lib/mechanics/prob.js';

export async function runEldritchTests(kb) {
  const tags = kb.basesByName['Twilight Regalia']?.tags ?? ['int_armour', 'body_armour', 'default'];
  const blank = {
    itemClass: 'Body Armour',
    baseType: 'Twilight Regalia',
    itemLevel: 86,
    baseTags: tags,
  };

  const eater = makeState({
    ...blank,
    eldritchDominance: 'eater',
    prefixes: [makeAffix({ text: 'keepP', gen: 'prefix', groups: ['IncreasedEnergyShield'] })],
    suffixes: [makeAffix({ text: 'oldS', gen: 'suffix', groups: ['FireResistance'] })],
  });
  const eat = eldritchChaos(eater, kb);
  assert(!eat.illegal, 'eater chaos legal');
  if (eat.outcomes.length) {
    assertProbabilityMass(eat.outcomes);
    for (const o of eat.outcomes) {
      assert(o.state.prefixes.some((a) => a.text === 'keepP'), 'Eater leaves prefixes');
    }
  }

  const exarch = makeState({
    ...blank,
    eldritchDominance: 'exarch',
    prefixes: [makeAffix({ text: 'oldP', gen: 'prefix' })],
    suffixes: [makeAffix({ text: 'keepS', gen: 'suffix', groups: ['FireResistance'] })],
  });
  const exa = eldritchChaos(exarch, kb);
  assert(!exa.illegal, 'exarch chaos legal');
  if (exa.outcomes.length) {
    assert(Math.abs(probabilityMass(exa.outcomes) - 1) < 1e-6, 'exarch Σp=1');
    for (const o of exa.outcomes) {
      assert(o.state.suffixes.some((a) => a.text === 'keepS'), 'Exarch leaves suffixes');
    }
  }

  const none = eldritchChaos(makeState({ ...blank, prefixes: [], suffixes: [] }), kb);
  assert(none.illegal, 'eldritch without dominance illegal');

  console.log('OK: eldritch tests passed');
}
