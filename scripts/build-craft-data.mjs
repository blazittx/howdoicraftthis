/**
 * Builds compact craft index from RePoE data.
 * Run: npm run build:data
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../public/data/craft-index.json');
const BASE = 'https://repoe-fork.github.io';

const INFLUENCE_MAP = {
  Shaper: 'shaper',
  Elder: 'elder',
  Crusader: 'crusader',
  Hunter: 'basilisk',
  Redeemer: 'eyrie',
  Warlord: 'adjudicator',
};

async function fetchJson(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json();
}

function textToPattern(text) {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/\(\d+-\d+\)/g, '#')
        .replace(/\+#/g, '+#')
        .replace(/\d+%/g, '#%')
        .replace(/\d+/g, '#')
        .trim()
    )
    .join('|');
}

function getInfluenceTags(spawnWeights) {
  const tags = [];
  for (const { tag, weight } of spawnWeights ?? []) {
    if (weight <= 0) continue;
    for (const [name, key] of Object.entries(INFLUENCE_MAP)) {
      if (tag.includes(key)) tags.push(name);
    }
  }
  return [...new Set(tags)];
}

function weightMap(spawnWeights) {
  const map = {};
  for (const { tag, weight } of spawnWeights ?? []) {
    if (weight > 0) map[tag] = weight;
  }
  return map;
}

async function main() {
  console.log('Fetching RePoE data...');
  const [modsRaw, essencesRaw, baseItems, itemClasses, benchRaw] = await Promise.all([
    fetchJson('mods.json'),
    fetchJson('essences.json'),
    fetchJson('base_items.json'),
    fetchJson('item_classes.json'),
    fetchJson('crafting_bench_options.json'),
  ]);

  const baseByName = {};
  for (const item of Object.values(baseItems)) {
    if (item.name) baseByName[item.name] = { tags: item.tags ?? [], itemClass: item.item_class };
  }

  const classInfluence = {};
  for (const [cls, data] of Object.entries(itemClasses)) {
    classInfluence[cls] = data.influence_tags ?? [];
  }

  const mods = [];
  for (const [id, mod] of Object.entries(modsRaw)) {
    if (mod.domain !== 'item') continue;
    if (!['prefix', 'suffix'].includes(mod.generation_type)) continue;
    // Keep essence-only even with empty spawn weights
    const hasWeight = mod.spawn_weights?.some((w) => w.weight > 0);
    if (!hasWeight && !mod.is_essence_only) continue;
    if (!mod.text) continue;

    const stat = mod.stats?.[0];
    mods.push({
      id,
      text: mod.text,
      pattern: textToPattern(mod.text),
      gen: mod.generation_type,
      groups: mod.groups ?? [],
      tags: mod.implicit_tags ?? [],
      min: stat?.min ?? null,
      max: stat?.max ?? null,
      statId: stat?.id ?? null,
      reqLevel: mod.required_level ?? 1,
      weights: weightMap(mod.spawn_weights),
      essenceOnly: !!mod.is_essence_only,
      influence: getInfluenceTags(mod.spawn_weights),
      name: mod.name,
    });
  }

  const essences = [];
  for (const data of Object.values(essencesRaw)) {
    for (const [itemClass, modId] of Object.entries(data.mods ?? {})) {
      essences.push({
        name: data.name,
        itemClass,
        modId,
        tier: data.type?.tier ?? data.level ?? 1,
        level: data.level ?? 1,
        ilvlReq: data.item_level_restriction ?? 0,
      });
    }
  }

  const bench = [];
  for (const opt of benchRaw) {
    if (!opt.actions?.add_explicit_mod) continue;
    const modId = opt.actions.add_explicit_mod;
    const mod = modsRaw[modId];
    if (!mod?.text) continue;
    bench.push({
      modId,
      text: mod.text.replace(/\(\d+-\d+\)/g, (m) => m),
      itemClasses: opt.item_classes ?? [],
      cost: Object.keys(opt.cost ?? {}),
    });
  }

  const index = {
    version: 1,
    mods,
    essences,
    bench,
    baseByName,
    classInfluence,
    influenceMap: INFLUENCE_MAP,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(index));
  console.log(`Wrote ${mods.length} mods, ${essences.length} essence mappings, ${bench.length} bench crafts`);
  console.log(`Output: ${OUT} (${(JSON.stringify(index).length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
