/**
 * Build complete PoE1 craft knowledge base from RePoE + curated official lists.
 *
 * Source of truth for game-file data: https://repoe-fork.github.io/
 * Harvest list: https://poedb.tw/us/Horticrafting
 *
 * Run: npm run build:knowledge
 *
 * Does NOT invent crafts. Systems without reliable dumps are listed in
 * coverage.json with status "missing" or "partial".
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../public/data/knowledge');
const BASE = 'https://repoe-fork.github.io';

const INFLUENCE_KEYS = {
  shaper: 'Shaper',
  elder: 'Elder',
  crusader: 'Crusader',
  basilisk: 'Hunter',
  eyrie: 'Redeemer',
  adjudicator: 'Warlord',
};

/** Official Horticrafting Station reforge crafts only (PoEDB). */
const HARVEST_REFORGES_OFFICIAL = [
  { id: 'reforge-fire', name: 'Reforge Fire', detail: 'Reforge a Rare item with random modifiers, including a Fire modifier', lifeforce: { wild: 50 } },
  { id: 'reforge-cold', name: 'Reforge Cold', detail: 'Reforge a Rare item with random modifiers, including a Cold modifier', lifeforce: { vivid: 50 } },
  { id: 'reforge-lightning', name: 'Reforge Lightning', detail: 'Reforge a Rare item with random modifiers, including a Lightning modifier', lifeforce: { primal: 50 } },
  { id: 'reforge-physical', name: 'Reforge Physical', detail: 'Reforge a Rare item with random modifiers, including a Physical modifier', lifeforce: { vivid: 50 } },
  { id: 'reforge-life', name: 'Reforge Life', detail: 'Reforge a Rare item with random modifiers, including a Life modifier', lifeforce: { wild: 75 } },
  { id: 'reforge-defence', name: 'Reforge Defence', detail: 'Reforge a Rare item with random modifiers, including a Defence modifier', lifeforce: { primal: 75 }, notes: 'Covers Armour / Evasion / Energy Shield / Ward — there is NO separate Energy Shield reforge' },
  { id: 'reforge-chaos', name: 'Reforge Chaos', detail: 'Reforge a Rare item with random modifiers, including a Chaos modifier', lifeforce: { vivid: 100 } },
  { id: 'reforge-attack', name: 'Reforge Attack', detail: 'Reforge a Rare item with random modifiers, including an Attack modifier', lifeforce: { wild: 75 } },
  { id: 'reforge-caster', name: 'Reforge Caster', detail: 'Reforge a Rare item with random modifiers, including a Caster modifier', lifeforce: { primal: 75 } },
  { id: 'reforge-speed', name: 'Reforge Speed', detail: 'Reforge a Rare item with random modifiers, including a Speed modifier', lifeforce: { vivid: 150 } },
  { id: 'reforge-critical', name: 'Reforge Critical', detail: 'Reforge a Rare item with random modifiers, including a Critical modifier', lifeforce: { primal: 150 } },
];

const METACRAFTS_OFFICIAL = [
  { id: 'scbc', name: 'Suffixes Cannot Be Changed', cost: { 'Divine Orb': 2 }, locks: 'suffix' },
  { id: 'pcbc', name: 'Prefixes Cannot Be Changed', cost: { 'Divine Orb': 2 }, locks: 'prefix' },
  {
    id: 'cannot-roll-attack',
    name: 'Cannot roll Attack Modifiers',
    cost: { 'Divine Orb': 1 },
    blocked_tags: ['attack'],
  },
  {
    id: 'cannot-roll-caster',
    name: 'Cannot roll Caster Modifiers',
    cost: { 'Divine Orb': 1 },
    blocked_tags: ['caster'],
  },
  { id: 'can-have-multiple-crafted', name: 'Can have multiple Crafted Modifiers', cost: { 'Divine Orb': 2 } },
];

/** Official cannot-roll spawn constraints (tag blocks + legacy level cap). */
const CANNOT_ROLL_OFFICIAL = {
  source: 'PoE Wiki Metamod + RePoE (KineticWandImplicit). Curated — not invented.',
  built_for: 'poe1',
  notes: [
    'When active, mods whose tags intersect blocked_tags cannot spawn (exalt, harvest, essence extras, eldritch, alt/aug, etc.).',
    'Bench crafts and unveil choice pools are separate; this file covers natural spawn-weight exclusion.',
    'Prefixes/Suffixes Cannot Be Changed are side locks (metacrafts-official.json), not tag blocks.',
  ],
  constraints: [
    {
      id: 'cannot-roll-caster',
      name: 'Cannot roll Caster Modifiers',
      detect: ['Cannot roll Caster Modifiers'],
      blocked_tags: ['caster'],
      sources: ['metacraft', 'bench', 'implicit'],
      metacraft_id: 'cannot-roll-caster',
      base_implicit_ids: ['KineticWandImplicit'],
      example_bases: ['Kinetic Wand', 'Blasting Wand', 'Somatic Wand'],
      wiki: 'https://www.poewiki.net/wiki/Modifier:KineticWandImplicit',
    },
    {
      id: 'cannot-roll-attack',
      name: 'Cannot roll Attack Modifiers',
      detect: ['Cannot roll Attack Modifiers'],
      blocked_tags: ['attack'],
      sources: ['metacraft', 'bench'],
      metacraft_id: 'cannot-roll-attack',
      wiki: 'https://www.poewiki.net/wiki/Metamod',
    },
    {
      id: 'cannot-roll-above-level-28',
      name: 'Cannot roll Modifiers with Required Level above 28',
      detect: ['Cannot roll Modifiers with Required Level above 28'],
      max_required_level: 28,
      sources: ['metacraft_legacy'],
      legacy: true,
      notes: 'Legacy metamod — only on existing items in permanent leagues.',
      wiki: 'https://www.poewiki.net/wiki/Metamod',
    },
  ],
};

async function fetchJson(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`Failed ${path}: ${res.status}`);
  return res.json();
}

function write(name, data) {
  const path = join(OUT_DIR, name);
  writeFileSync(path, JSON.stringify(data));
  const bytes = Buffer.byteLength(JSON.stringify(data));
  console.log(`  ${name}: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  return { file: name, bytes, count: Array.isArray(data) ? data.length : data.count ?? Object.keys(data).length };
}

function compactMod(id, m) {
  return {
    id,
    name: m.name ?? null,
    text: m.text ?? null,
    generation: m.generation_type,
    domain: m.domain,
    type: m.type ?? null,
    groups: m.groups ?? [],
    tags: m.implicit_tags ?? [],
    required_level: m.required_level ?? 1,
    is_essence_only: !!m.is_essence_only,
    stats: (m.stats ?? []).map((s) => ({ id: s.id, min: s.min, max: s.max })),
    // Keep weight-0 rows: PoE uses first matching tag (0 excludes before a later default).
    spawn_weights: m.spawn_weights ?? [],
    generation_weights: m.generation_weights ?? [],
    adds_tags: m.adds_tags ?? [],
  };
}

function detectInfluences(spawnWeights) {
  const found = new Set();
  for (const { tag, weight } of spawnWeights ?? []) {
    if (weight <= 0) continue;
    for (const [key, label] of Object.entries(INFLUENCE_KEYS)) {
      if (tag.includes(key)) found.add(label);
    }
  }
  return [...found];
}

async function main() {
  console.log('Fetching RePoE PoE1 data…');
  const [modsRaw, essencesRaw, fossilsRaw, benchRaw, basesRaw, itemClasses, modTypes, tags] = await Promise.all([
    fetchJson('mods.json'),
    fetchJson('essences.json'),
    fetchJson('fossils.json'),
    fetchJson('crafting_bench_options.json'),
    fetchJson('base_items.json'),
    fetchJson('item_classes.json'),
    fetchJson('mod_types.json'),
    fetchJson('tags.json'),
  ]);

  mkdirSync(OUT_DIR, { recursive: true });
  const files = [];

  // --- Categorize all mods ---
  const natural = [];
  const essenceOnly = [];
  const crafted = [];
  const unveiled = [];
  const veiledPlaceholders = [];
  const delve = [];
  const influence = [];
  const eldritchImplicits = [];
  const enchantments = [];
  const jewelMods = [];
  const flaskMods = [];
  const remainder = [];

  let genCounts = {};
  let domainCounts = {};

  const JEWEL_DOMAINS = new Set(['abyss_jewel', 'affliction_jewel']);

  for (const [id, m] of Object.entries(modsRaw)) {
    genCounts[m.generation_type] = (genCounts[m.generation_type] || 0) + 1;
    domainCounts[m.domain] = (domainCounts[m.domain] || 0) + 1;

    const row = compactMod(id, m);
    const influences = detectInfluences(m.spawn_weights);
    if (influences.length) row.influences = influences;

    if (m.generation_type === 'searing_exarch_implicit' || m.generation_type === 'eater_of_worlds_implicit') {
      eldritchImplicits.push(row);
      continue;
    }
    if (m.generation_type === 'enchantment' || String(m.generation_type).includes('enchantment')) {
      enchantments.push(row);
      continue;
    }
    if (m.domain === 'crafted') {
      crafted.push(row);
      continue;
    }
    if (m.domain === 'unveiled') {
      unveiled.push(row);
      continue;
    }
    if (m.domain === 'veiled') {
      veiledPlaceholders.push(row);
      continue;
    }
    if (m.domain === 'delve') {
      delve.push(row);
      continue;
    }
    if (JEWEL_DOMAINS.has(m.domain) && ['prefix', 'suffix'].includes(m.generation_type)) {
      jewelMods.push(row);
      continue;
    }
    if (m.domain === 'flask' && ['prefix', 'suffix'].includes(m.generation_type)) {
      flaskMods.push(row);
      continue;
    }
    if (m.domain === 'item' && ['prefix', 'suffix'].includes(m.generation_type)) {
      if (m.is_essence_only) essenceOnly.push(row);
      else if (influences.length) influence.push(row);
      else natural.push(row);
      continue;
    }
    // Everything else (uniques, implicits, monster/area/maps, …) — full dump for completeness
    remainder.push(row);
  }

  console.log('Writing knowledge files…');
  files.push(write('mods-natural-prefix-suffix.json', { count: natural.length, mods: natural }));
  files.push(write('mods-essence-only.json', { count: essenceOnly.length, mods: essenceOnly }));
  files.push(write('mods-crafted-bench.json', { count: crafted.length, mods: crafted }));
  files.push(write('mods-unveiled.json', { count: unveiled.length, mods: unveiled }));
  files.push(write('mods-veiled-placeholders.json', { count: veiledPlaceholders.length, mods: veiledPlaceholders }));
  files.push(write('mods-influence.json', { count: influence.length, mods: influence }));
  files.push(write('mods-delve.json', { count: delve.length, mods: delve }));
  files.push(write('mods-eldritch-implicits.json', { count: eldritchImplicits.length, mods: eldritchImplicits }));
  files.push(write('mods-enchantments.json', { count: enchantments.length, mods: enchantments }));
  files.push(write('mods-jewels.json', { count: jewelMods.length, mods: jewelMods, note: 'abyss_jewel + affliction_jewel prefix/suffix' }));
  files.push(write('mods-flasks.json', { count: flaskMods.length, mods: flaskMods }));
  files.push(
    write('mods-remainder.json', {
      count: remainder.length,
      note: 'All RePoE mods not in craft-planner categories (unique item mods, base implicits, monster/area/map domains, etc.)',
      mods: remainder,
    })
  );

  // Essences — full dump
  const essences = Object.entries(essencesRaw).map(([id, e]) => ({
    id,
    name: e.name,
    level: e.level,
    tier: e.type?.tier ?? null,
    corruption_only: !!e.type?.is_corruption_only,
    item_level_restriction: e.item_level_restriction ?? null,
    spawn_level_min: e.spawn_level_min ?? null,
    mods_by_item_class: e.mods ?? {},
  }));
  files.push(write('essences.json', { count: essences.length, essences }));

  // Fossils
  const fossils = Object.entries(fossilsRaw).map(([id, f]) => ({
    id,
    name: f.name,
    descriptions: f.descriptions ?? {},
    positive_mod_weights: f.positive_mod_weights ?? [],
    negative_mod_weights: f.negative_mod_weights ?? [],
    added_mods: f.added_mods ?? [],
    forced_mods: f.forced_mods ?? [],
    forbidden_tags: f.forbidden_tags ?? [],
    allowed_tags: f.allowed_tags ?? [],
    changes_quality: !!f.changes_quality,
    mirrors: !!f.mirrors,
    rolls_lucky: !!f.rolls_lucky,
    rolls_white_sockets: !!f.rolls_white_sockets,
    corrupted_essence_chance: f.corrupted_essence_chance ?? 0,
  }));
  files.push(write('fossils.json', { count: fossils.length, fossils }));

  // Crafting bench — every option
  const bench = benchRaw.map((opt, i) => ({
    index: i,
    master: opt.master ?? null,
    bench_tier: opt.bench_tier ?? null,
    item_classes: opt.item_classes ?? [],
    cost: opt.cost ?? {},
    actions: opt.actions ?? {},
    // Resolve crafted mod text when present
    add_explicit_mod: opt.actions?.add_explicit_mod
      ? {
          modId: opt.actions.add_explicit_mod,
          text: modsRaw[opt.actions.add_explicit_mod]?.text ?? null,
          name: modsRaw[opt.actions.add_explicit_mod]?.name ?? null,
          generation: modsRaw[opt.actions.add_explicit_mod]?.generation_type ?? null,
          required_level: modsRaw[opt.actions.add_explicit_mod]?.required_level ?? null,
        }
      : null,
  }));
  files.push(write('crafting-bench.json', { count: bench.length, options: bench }));

  // Bases (equipment-ish) — art is RePoE visual_identity.dds_file for CDN icons
  const bases = Object.entries(basesRaw)
    .filter(([, b]) => b.release_state === 'released' && b.name)
    .map(([id, b]) => ({
      id,
      name: b.name,
      item_class: b.item_class,
      tags: b.tags ?? [],
      drop_level: b.drop_level,
      implicits: b.implicits ?? [],
      art: b.visual_identity?.dds_file ?? null,
      w: b.inventory_width ?? 1,
      h: b.inventory_height ?? 1,
    }));
  files.push(write('base-items.json', { count: bases.length, bases }));

  files.push(write('item-classes.json', itemClasses));
  files.push(write('tags.json', { count: Array.isArray(tags) ? tags.length : Object.keys(tags).length, tags }));
  files.push(write('mod-types.json', { count: Object.keys(modTypes).length, note: 'Fossil-relevant mod types from RePoE', types: modTypes }));

  // Curated official lists (not invented)
  files.push(
    write('harvest-reforge-official.json', {
      source: 'https://poedb.tw/us/Horticrafting',
      note: 'Only official "Reforge including X" crafts. Defence includes ES — no separate ES reforge.',
      crafts: HARVEST_REFORGES_OFFICIAL,
    })
  );
  files.push(write('metacrafts-official.json', { crafts: METACRAFTS_OFFICIAL }));
  files.push(write('cannot-roll-official.json', CANNOT_ROLL_OFFICIAL));

  // Craft operators — curated (Eldritch, fossils patterns, buyout). Keep in sync with public file if edited by hand.
  const { readFileSync: readFs } = await import('fs');
  const opsPath = join(OUT_DIR, 'craft-operators-official.json');
  try {
    const existing = JSON.parse(readFs(opsPath, 'utf8'));
    files.push(write('craft-operators-official.json', existing));
  } catch {
    console.warn('  craft-operators-official.json missing — run once after creating it');
  }

  // Coverage — honest about gaps
  const categorizedModCount =
    natural.length +
    essenceOnly.length +
    crafted.length +
    unveiled.length +
    veiledPlaceholders.length +
    influence.length +
    delve.length +
    eldritchImplicits.length +
    enchantments.length +
    jewelMods.length +
    flaskMods.length +
    remainder.length;
  const coverage = {
    game: 'Path of Exile 1 only',
    repoE_version_hint: 'repoe-fork.github.io (live export)',
    built_at: new Date().toISOString(),
    repoe_mod_total: Object.keys(modsRaw).length,
    knowledge_mod_total: categorizedModCount,
    note:
      'knowledge_mod_total should equal repoe_mod_total — every RePoE mod is written into a category file (remainder holds uniques/implicits/monster/area/etc.).',
    fully_covered_from_repoe: [
      'Natural prefix/suffix mods + spawn weights',
      'Essence-only mods',
      'All essences + per-item-class guaranteed mods',
      'All fossils + tag weights',
      'Crafting bench options (mods, sockets, enchants)',
      'Crafted (bench) mod domain',
      'Unveiled mod outcomes (Jun)',
      'Veiled placeholders',
      'Influence mods (Shaper/Elder/Conqueror) via spawn tags',
      'Delve mods',
      'Eldritch implicits (Exarch/Eater)',
      'Enchantments',
      'Jewel prefix/suffix (abyss + cluster/affliction)',
      'Flask prefix/suffix',
      'Remainder dump (unique mods, base implicits, non-item domains)',
      'Base items + item classes + tags',
    ],
    curated_official_lists: [
      'Harvest reforge crafts (PoEDB Horticrafting Station)',
      'Common metacrafts (Prefixes/Suffixes Cannot Be Changed, etc.)',
      'Cannot-roll constraints (caster/attack tag blocks + legacy level-28 cap) — cannot-roll-official.json',
      'Craft operators (Eldritch chaos/annul/exalt, Dense/Hollow fossils, veiled, buyout heuristic) — craft-operators-official.json',
    ],
    missing_or_partial: [
      {
        system: 'Harvest add/remove (sacred lifeforce) & non-reforge harvest',
        status: 'partial',
        note: 'Reforges curated; full harvest menu (augments, enchant body, resist swap) not yet imported as structured data',
      },
      {
        system: 'Recombinators',
        status: 'partial',
        note: 'Operator documented in craft-operators-official.json; exclusive-mod tables incomplete',
      },
      {
        system: 'Allflame / Kingsmarch boat crafting (Settlers)',
        status: 'missing',
        note: 'Needs dedicated datamine / community dump — not in standard RePoE export listed above',
      },
      {
        system: 'Beastcrafting recipes',
        status: 'partial',
        note: 'Split/6-link documented; full PoEDB recipe table not imported yet',
      },
      {
        system: 'Hellscape / Scourge / Crucible / Necropolis special crafts',
        status: 'partial',
        note: 'Mods exist in mods-remainder.json / generation_types; operator recipes not curated',
      },
      {
        system: 'Live trade market prices',
        status: 'missing',
        note: 'Buyout heuristic uses craft EV threshold only until trade API wired',
      },
    ],
    generation_type_counts: genCounts,
    domain_counts: domainCounts,
    category_counts: {
      natural_prefix_suffix: natural.length,
      essence_only: essenceOnly.length,
      crafted: crafted.length,
      unveiled: unveiled.length,
      veiled_placeholders: veiledPlaceholders.length,
      influence: influence.length,
      delve: delve.length,
      eldritch_implicits: eldritchImplicits.length,
      enchantments: enchantments.length,
      jewels: jewelMods.length,
      flasks: flaskMods.length,
      remainder: remainder.length,
      essences: essences.length,
      fossils: fossils.length,
      crafting_bench: bench.length,
      bases: bases.length,
    },
  };
  files.push(write('coverage.json', coverage));

  const manifest = {
    built_at: coverage.built_at,
    game: 'poe1',
    files: files.map((f) => f.file),
    category_counts: coverage.category_counts,
    missing_or_partial: coverage.missing_or_partial.map((m) => m.system),
  };
  write('manifest.json', manifest);

  console.log('\nDone. Knowledge base at public/data/knowledge/');
  console.log('See coverage.json for what is fully covered vs still missing.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
