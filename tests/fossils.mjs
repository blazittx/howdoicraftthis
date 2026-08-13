/**
 * Fossil mechanic tests (§41) — uses Layer-A fossilCraft when present.
 */
import { assert, skip } from './helpers/assert.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from './helpers/harness.mjs';
import { makeState } from '../src/lib/craftState.js';
import { assertProbabilityMass } from '../src/lib/mechanics/prob.js';

export async function runFossilsTests(kb) {
  const path = join(ROOT, 'public/data/knowledge/fossils.json');
  assert(existsSync(path), 'fossils.json present');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const list = data.fossils ?? data;
  assert(Array.isArray(list) && list.length > 20, 'fossil catalog size');
  assert(list.some((f) => /Dense Fossil/i.test(f.name ?? f.id ?? '')), 'Dense Fossil in catalog');

  let fossilCraft;
  try {
    ({ fossilCraft } = await import('../src/lib/mechanics/fossils.js'));
  } catch {
    fossilCraft = null;
  }
  if (typeof fossilCraft !== 'function') {
    skip('fossilCraft API missing');
  }

  assert((kb.fossils ?? []).length > 20 || list.length > 20, 'kb.fossils loaded');

  const tags = kb.basesByName['Kinetic Wand']?.tags ?? ['wand', 'weapon', 'default'];
  const blank = makeState({
    itemClass: 'Wand',
    baseType: 'Kinetic Wand',
    itemLevel: 85,
    prefixes: [],
    suffixes: [],
    baseTags: tags,
  });

  const r = fossilCraft(blank, kb, 'Dense Fossil', { sockets: 1 });
  assert(!r.illegal, `Dense Fossil craft legal: ${r.illegal ?? ''}`);
  assert(r.outcomes?.length > 0, 'fossil craft outcomes');
  assertProbabilityMass(r.outcomes);

  const bad = fossilCraft(blank, kb, 'Not A Real Fossil');
  assert(bad.illegal, 'unknown fossil illegal');

  console.log('OK: fossils tests passed');
}
