/**
 * List Harvest Reforge Critical pool for Kinetic Wand (suffix, ilvl 85).
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

globalThis.fetch = async (url) => {
  const m = String(url).match(/\/data\/knowledge\/(.+)$/);
  if (!m) throw new Error(`unexpected fetch ${url}`);
  const path = join(root, 'public/data/knowledge', m[1]);
  const body = readFileSync(path, 'utf8');
  return { ok: true, json: async () => JSON.parse(body) };
};

const { loadKnowledgeBase, effectiveBaseTags } = await import('../src/lib/knowledgeLoader.js');
const { HARVEST_REFORGES, modMatchesHarvest } = await import('../src/lib/craftKnowledge.js');
const { harvestPoolWeight, generationPoolWeight } = await import('../src/lib/spawnWeights.js');
const { parseItem } = await import('../src/lib/itemParser.js');
const { generateCraftSteps } = await import('../src/lib/craftPlanner.js');

const kb = await loadKnowledgeBase();
const harvest = HARVEST_REFORGES.find((h) => h.id === 'reforge-critical');
const base = kb.basesByName['Kinetic Wand'];
const ilvl = 85;
const generation = 'suffix';

const item = parseItem(`Item Class: Wands
Rarity: Rare
Cataclysm Needle
Kinetic Wand
--------
Item Level: 85
--------
{ Implicit Modifier }
Cannot roll Caster Modifiers
--------
{ Fractured Prefix Modifier "Zaffre" (Tier: 1) — Mana }
+156(140-159) to maximum Mana
{ Prefix Modifier "Chosen" (Tier: 1) — Damage, Chaos, Attack }
Attacks with this Weapon Penetrate 16(14-16)% Chaos Resistance
{ Master Crafted Prefix Modifier "Upgraded" — Damage, Chaos, Caster }
50(46-50)% increased Spell Damage
Gain 4% of Non-Chaos Damage as Extra Chaos Damage
{ Suffix Modifier "of the Essence" — Attack, Speed }
18(17-18)% increased Attack Speed
{ Suffix Modifier "of Ferocity" (Tier: 2) — Damage, Critical }
+31(30-34)% to Global Critical Strike Multiplier
{ Suffix Modifier "of Incision" (Tier: 1) — Attack, Critical }
36(35-38)% increased Critical Strike Chance
--------
Fractured Item`);

const baseTags = effectiveBaseTags(item, base);
const rawTags = base.tags;

const listPool = (tags) => {
  const rows = [];
  for (const mod of kb.natural) {
    if (mod.generation !== generation) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    if (!modMatchesHarvest(mod, harvest)) continue;
    const w = kb.weightOnTags(mod, tags);
    if (w <= 0) continue;
    rows.push({
      id: mod.id,
      name: mod.name,
      req: mod.required_level,
      w,
      text: (mod.text ?? '').split('\n')[0],
      tags: mod.tags,
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
};

const fixed = listPool(baseTags);
const broken = listPool(rawTags);
const lines = [];
lines.push('=== DEFINITION ===');
lines.push('harvestPoolWeight: natural mods where generation matches, required_level <= ilvl,');
lines.push('modMatchesHarvest(reforge-critical), weightOnTags > 0');
lines.push(`modMatchesHarvest: tags includes "critical" OR groups in [${harvest.groups.join(', ')}]`);
lines.push('OR textHints /critical strike chance|multiplier/');
lines.push(`baseTags (effective): ${JSON.stringify(baseTags)}`);
lines.push('');
lines.push(`BROKEN (raw tags only): count=${broken.length} total=${broken.reduce((s, r) => s + r.w, 0)}`);
lines.push(`FIXED (no caster): count=${fixed.length} total=${fixed.reduce((s, r) => s + r.w, 0)}`);
lines.push(`harvestPoolWeight()=${harvestPoolWeight(kb, baseTags, ilvl, generation, harvest, modMatchesHarvest)}`);
lines.push(`full suffix pool=${generationPoolWeight(kb, baseTags, ilvl, generation)}`);
lines.push('');
lines.push('=== FIXED CRIT POOL ===');
for (const r of fixed) {
  lines.push(`${r.w}\treq${r.req}\t${r.id}\t${r.name}\t${(r.tags || []).join(',')}\t${r.text}`);
}
lines.push('');
lines.push('=== EXCLUDED (caster, were wrongly included) ===');
for (const r of broken) {
  if (fixed.some((f) => f.id === r.id)) continue;
  lines.push(`${r.w}\treq${r.req}\t${r.id}\t${r.name}\t${(r.tags || []).join(',')}\t${r.text}`);
}

const plan = await generateCraftSteps(item);
const harvestMods = (plan.modAnalysis ?? []).filter((m) => m.method === 'harvest');
lines.push('');
lines.push('=== PLANNER ===');
for (const m of harvestMods) {
  lines.push(`${m.short}: poolWeight=${m.poolWeight} ${m.weightLine}`);
}
const ess = plan.steps.find((s) => /Zeal/i.test(s.action));
lines.push(`essence step: ${ess?.chanceLabel}`);

const out = lines.join('\n');
writeFileSync(join(root, 'scripts/diag-crit-pool.txt'), out);
console.log(out);
