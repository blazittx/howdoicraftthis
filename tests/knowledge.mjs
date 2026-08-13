/**
 * §65 static knowledge-base consistency.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { assert, skip } from './helpers/assert.js';
import { ROOT } from './helpers/harness.mjs';

function load(name) {
  const p = join(ROOT, 'public/data/knowledge', name);
  if (!existsSync(p)) skip(`KB file missing: ${name}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export async function runKnowledgeTests(kb) {
  const manifest = load('manifest.json');
  assert(manifest.game === 'poe1' || /poe1/i.test(String(manifest.game)), 'manifest game poe1');
  assert(Array.isArray(manifest.files) && manifest.files.length > 10, 'manifest lists files');

  const coverage = load('coverage.json');
  assert(coverage.game || coverage.fully_covered_from_repoe || coverage.category_counts, 'coverage.json structured');
  if (coverage.repoe_mod_total != null && coverage.knowledge_mod_total != null) {
    assert(coverage.repoe_mod_total <= coverage.knowledge_mod_total + 50, 'coverage totals sane');
  }

  const harvest = load('harvest-reforge-official.json');
  const crafts = harvest.crafts ?? harvest.reforge ?? harvest;
  assert(Array.isArray(crafts) ? crafts.length : Object.keys(crafts).length, 'harvest official non-empty');

  const essences = load('essences.json');
  assert((essences.essences ?? essences).length > 50, 'essences table populated');

  const fossils = load('fossils.json');
  assert((fossils.fossils ?? fossils).length > 20, 'fossils table populated');

  const natural = load('mods-natural-prefix-suffix.json');
  assert((natural.mods ?? []).length > 1000, 'natural mods present');

  const bases = load('base-items.json');
  assert((bases.bases ?? []).some((b) => b.name === 'Kinetic Wand'), 'Kinetic Wand in bases');
  assert((bases.bases ?? []).some((b) => b.name === 'Twilight Regalia'), 'Twilight Regalia in bases');

  assert(kb?.natural?.length > 1000, 'loaded kb.natural');
  assert(kb?.essences?.length > 50, 'loaded kb.essences');
  assert(kb?.basesByName?.['Kinetic Wand'], 'kb.basesByName Kinetic Wand');

  if (kb.harvest?.crafts) {
    const crit = kb.harvest.crafts.find((c) => c.id === 'reforge-critical');
    assert(crit, 'harvest reforge-critical in loaded KB');
  }

  const recomb = load('recombinators-official.json');
  assert(recomb.version === '3.29', 'recombinator model 3.29');
  assert(recomb.cost?.confidence === 'unknown' || recomb.cost?.formula == null, 'recomb cost unpublished/unknown');
  assert(recomb.cost?.averageUnpredictable?.gold === 25000, 'official KB gold midpoint');
  assert(recomb.cost?.averageUnpredictable?.['thaumaturgic-dust'] === 85000, 'official KB dust midpoint');
  assert(!recomb.cost?.chaosFallback, 'no invented chaosFallback in KB');

  // Operators catalog if sibling shipped it
  const opPath = join(ROOT, 'public/data/knowledge/craft-operators-official.json');
  if (existsSync(opPath)) {
    const ops = JSON.parse(readFileSync(opPath, 'utf8'));
    assert(ops.operators || ops.crafts || ops.version, 'operators.json has structure');
  }

  console.log('OK: knowledge consistency tests passed');
}
