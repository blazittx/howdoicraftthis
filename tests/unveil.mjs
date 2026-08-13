/**
 * Unveil / veiled exalt tests (§41).
 */
import { assert, skip } from './helpers/assert.js';
import { makeState, makeAffix } from '../src/lib/craftState.js';
import { veiledExalt } from '../src/lib/mechanics/transitions.js';
import { assertProbabilityMass } from '../src/lib/mechanics/prob.js';
import { unveilExpected } from '../src/lib/spawnWeights.js';

export async function runUnveilTests(kb) {
  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const state = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [makeAffix({ text: 'filler', gen: 'prefix', groups: ['IncreasedLife'] })],
    suffixes: [makeAffix({ text: 'as', gen: 'suffix', groups: ['IncreasedAttackSpeed'] })],
    baseTags: tags,
  });

  const vx = veiledExalt(state, kb, { generation: 'prefix' });
  assert(!vx.illegal, 'veiled exalt legal');
  assertProbabilityMass(vx.outcomes);
  assert(
    vx.outcomes.every((o) => [...o.state.prefixes, ...o.state.suffixes].some((a) => a.veiled)),
    'veiled placeholder added'
  );

  const unveilMods = kb.unveiled ?? kb.modsUnveiled ?? [];
  const pen = (Array.isArray(unveilMods) ? unveilMods : []).find((m) =>
    /Penetrate .+ Chaos Resistance/i.test(m.text || '')
  );
  if (!pen) {
    // Try natural+unveiled via kb fields
    const fromNatural = (kb.natural ?? []).find((m) => /Penetrate .+ Chaos/i.test(m.text || ''));
    if (!fromNatural && !kb.modById) {
      skip('no chaos-pen unveil mod in loaded KB for odds test');
    }
  }

  const goal = pen ?? {
    text: 'Attacks with this Weapon Penetrate 16% Chaos Resistance',
    generation: 'prefix',
    gen: 'prefix',
  };
  const u = unveilExpected(kb, tags, 85, goal, [], 3);
  if (u.unknown) {
    assert(u.expected === Infinity || !Number.isFinite(u.expected), 'unknown unveil stays unranked (not fake p)');
  } else {
    const p = u.pRoll ?? 0;
    assert(p > 0 && p <= 1, `unveil p in (0,1], got ${p}`);
    assert(u.expected >= 1, 'unveil EV ≥ 1');
  }

  console.log('OK: unveil tests passed');
}
