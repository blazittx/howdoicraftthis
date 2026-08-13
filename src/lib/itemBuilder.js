/**
 * Item builder — pick a base + eligible mods, emit a synthetic parseItem-shaped object
 * for generateCraftSteps / deterministicPlanner.
 */
import {
  INFLUENCE_TAG_KEY,
  effectiveBaseTags,
  resolveCannotRoll,
  getBaseInfo,
  matchModInKnowledge,
} from './knowledgeLoader.js';
import { inferCraftGeneration, modLineKey } from './spawnWeights.js';

/** Query token → alternate match sets (all parts of a set must appear). */
const SEARCH_TOKEN_ALTS = {
  max: [['max'], ['maximum']],
  maximum: [['maximum'], ['max']],
  es: [['energy', 'shield'], ['energy_shield']],
  res: [['res'], ['resistance']],
  resistance: [['resistance'], ['res']],
  life: [['life']],
  mana: [['mana']],
  regen: [['regen'], ['regeneration']],
  regeneration: [['regeneration'], ['regen']],
  dmg: [['dmg'], ['damage']],
  damage: [['damage'], ['dmg']],
  crit: [['crit'], ['critical']],
  critical: [['critical'], ['crit']],
  as: [['attack', 'speed']],
  ms: [['movement', 'speed']],
  str: [['str'], ['strength']],
  strength: [['strength'], ['str']],
  dex: [['dex'], ['dexterity']],
  dexterity: [['dexterity'], ['dex']],
  int: [['int'], ['intelligence']],
  intelligence: [['intelligence'], ['int']],
};

function tokenizeSearch(query) {
  return String(query ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Lowercase alphanumeric-only string for contiguous matching across punctuation. */
function normalizeSearchText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Needle matches the start of a word (after a non-alphanumeric boundary). */
function isWordPrefix(hayLower, needle) {
  if (!needle) return true;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}`).test(hayLower);
}

/**
 * One alternate part vs haystack:
 * - length ≥ 3: contiguous substring (raw or alphanumeric-normalized)
 * - length 1–2: word prefix only
 */
function partMatchesHaystack(hayLower, hayNorm, part) {
  const p = String(part ?? '').toLowerCase();
  if (!p) return true;
  if (p.length <= 2) return isWordPrefix(hayLower, p);
  return hayLower.includes(p) || hayNorm.includes(normalizeSearchText(p));
}

function tokenMatchesHaystack(hayLower, hayNorm, token) {
  const alts = SEARCH_TOKEN_ALTS[token] ?? [[token]];
  return alts.some((parts) =>
    parts.every((p) => partMatchesHaystack(hayLower, hayNorm, p))
  );
}

/** Every whitespace token must match (order free). Aliases expand first. */
function fuzzyQueryMatches(haystackRaw, query) {
  const tokens = tokenizeSearch(query);
  if (!tokens.length) return true;
  const hayLower = String(haystackRaw ?? '').toLowerCase();
  const hayNorm = normalizeSearchText(hayLower);
  return tokens.every((t) => tokenMatchesHaystack(hayLower, hayNorm, t));
}

/** Case-insensitive: every whitespace token matches text|name|tags|family label. */
export function modMatchesSearch(mod, query) {
  const family = familyDisplayText(mod);
  return fuzzyQueryMatches(
    `${mod.name ?? ''} ${mod.text ?? ''} ${family} ${(mod.tags ?? []).join(' ')}`,
    query
  );
}

/** Display pattern for an affix family, e.g. "+# to maximum Energy Shield". */
export function familyDisplayText(mod) {
  return String(mod.text ?? '')
    .split('\n')[0]
    .replace(/\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\)/g, '#')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .trim();
}

/**
 * Group filtered mods into affix families (same groups + line pattern).
 * Tiers sorted by required_level descending (best first).
 */
export function groupModsByFamily(mods) {
  const map = new Map();
  for (const mod of mods) {
    const line = modLineKey(mod);
    const key = `${mod._section || ''}::${line}`;
    let fam = map.get(key);
    if (!fam) {
      fam = {
        key,
        section: mod._section || null,
        label: familyDisplayText(mod),
        generation:
          mod.generation === 'prefix' || mod.generation === 'suffix'
            ? mod.generation
            : mod._gen || '',
        line,
        tiers: [],
      };
      map.set(key, fam);
    }
    fam.tiers.push(mod);
  }
  for (const fam of map.values()) {
    fam.tiers.sort(
      (a, b) =>
        (b.required_level ?? 0) - (a.required_level ?? 0) ||
        String(a.name).localeCompare(String(b.name)) ||
        String(a.id).localeCompare(String(b.id))
    );
  }
  return [...map.values()].sort(
    (a, b) =>
      String(a.section || '').localeCompare(String(b.section || '')) ||
      String(a.generation).localeCompare(String(b.generation)) ||
      a.label.localeCompare(b.label)
  );
}

/** Item classes that can be rare-crafted (equipment / jewels / flasks). */
export const CRAFTABLE_CLASSES = new Set([
  'Amulet',
  'Ring',
  'Claw',
  'Dagger',
  'Rune Dagger',
  'Wand',
  'One Hand Sword',
  'Thrusting One Hand Sword',
  'One Hand Axe',
  'One Hand Mace',
  'Sceptre',
  'Bow',
  'Staff',
  'Warstaff',
  'Two Hand Sword',
  'Two Hand Axe',
  'Two Hand Mace',
  'Quiver',
  'Belt',
  'Gloves',
  'Boots',
  'Body Armour',
  'Helmet',
  'Shield',
  'Jewel',
  'AbyssJewel',
  'LifeFlask',
  'ManaFlask',
  'HybridFlask',
  'UtilityFlask',
  'UtilityFlaskCritical',
  'Tincture',
  'Trinket',
]);

export const INFLUENCE_NAMES = ['Warlord', 'Redeemer', 'Crusader', 'Hunter', 'Shaper', 'Elder'];

const INFLUENCE_LABEL = {
  Warlord: 'Warlord',
  Redeemer: 'Redeemer',
  Crusader: 'Crusader',
  Hunter: 'Hunter',
  Shaper: 'Shaper',
  Elder: 'Elder',
};

/** Prefer max of (min-max) so matchModInKnowledge sees a concrete roll. */
export function rolledModText(text) {
  return String(text ?? '')
    .replace(/\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\)/g, '$2')
    .trim();
}

const RANGE_IN_TEXT = /\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\)(%?)/;

function formatRangeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) && Number.isInteger(x) ? String(x) : String(n);
}

/** Compact PoE-style tier range, e.g. `(91-100)` or `(56-67)%`. */
export function modRangeLabel(mod) {
  if (!mod) return '';
  const text = String(mod.text ?? '');
  const m = text.match(RANGE_IN_TEXT);
  if (m) return `(${formatRangeNum(m[1])}-${formatRangeNum(m[2])})${m[3] || ''}`;
  const min = mod.min ?? mod.stats?.[0]?.min;
  const max = mod.max ?? mod.stats?.[0]?.max;
  if (min == null || max == null) return '';
  if (Number(min) === Number(max)) return '';
  const line = text.split('\n')[0] || '';
  const pct = /%/.test(line);
  return `(${formatRangeNum(min)}-${formatRangeNum(max)})${pct ? '%' : ''}`;
}

/** UI display: keep KB `(min-max)` ranges (never collapse to rolled max). */
export function modDisplayText(mod) {
  return String(mod?.text ?? '').trim();
}

/** Append tier range when rolled/paste text omits `(min-max)`. */
export function textWithTierRange(text, rangeSource) {
  const t = String(text ?? '');
  const label = typeof rangeSource === 'string' ? rangeSource : modRangeLabel(rangeSource);
  if (!label || !t || RANGE_IN_TEXT.test(t)) return t;
  return `${t} ${label}`;
}

export function listCraftableBases(kb) {
  const out = [];
  for (const b of Object.values(kb.basesByName ?? {})) {
    if (!b?.name || !CRAFTABLE_CLASSES.has(b.item_class)) continue;
    out.push(b);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function searchBases(bases, query, limit = 40) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return bases.slice(0, limit);
  const tokens = tokenizeSearch(q);
  const scored = [];
  for (const b of bases) {
    const name = b.name.toLowerCase();
    const cls = String(b.item_class ?? '').toLowerCase();
    if (!fuzzyQueryMatches(`${name} ${cls}`, q)) continue;
    // Prefer full-query prefix / contiguous, then all tokens in name.
    const score = name.startsWith(q)
      ? 0
      : name.includes(q)
        ? 1
        : tokens.every((t) => name.includes(t) || (t.length <= 2 && isWordPrefix(name, t)))
          ? 2
          : 3;
    scored.push({ b, score });
  }
  scored.sort((a, c) => a.score - c.score || a.b.name.localeCompare(c.b.name));
  return scored.slice(0, limit).map((x) => x.b);
}

function tagsForInfluence(base, influenceName) {
  const tags = [...(base?.tags ?? ['default'])];
  const key = INFLUENCE_TAG_KEY[String(influenceName).toLowerCase()];
  if (!key) return tags;
  tags.push(key);
  for (const t of base?.tags ?? []) {
    if (t === 'default' || t.startsWith('trade_')) continue;
    tags.push(`${t}_${key}`);
  }
  return tags;
}

function passesFilters(mod, { gen, search, tag }) {
  if (gen === 'prefix' || gen === 'suffix') {
    const g = mod.generation === 'prefix' || mod.generation === 'suffix' ? mod.generation : mod._gen;
    if (g && g !== gen) return false;
  }
  if (tag) {
    const tags = mod.tags ?? [];
    if (!tags.some((t) => String(t).toLowerCase() === tag || String(t).toLowerCase().includes(tag))) {
      return false;
    }
  }
  if (search && !modMatchesSearch(mod, search)) return false;
  return true;
}

function sortMods(mods) {
  return mods.sort(
    (a, b) =>
      String(a.generation).localeCompare(String(b.generation)) ||
      (b.required_level ?? 0) - (a.required_level ?? 0) ||
      String(a.name).localeCompare(String(b.name))
  );
}

function withWeight(mod, weight, extra = {}) {
  return { ...mod, _weight: weight, ...extra };
}

/**
 * Eligible mods for a base, grouped by source category.
 * Influence sections include mods that would roll if that influence were present.
 */
export function eligibleModsByCategory(kb, base, itemHints = {}) {
  if (!base) {
    return {
      natural: [],
      influence: {},
      unveiled: [],
      crafted: [],
      essence: [],
      eldritch: [],
      enchant: [],
    };
  }

  const stub = {
    baseName: base.name,
    itemClass: base.item_class,
    itemLevel: itemHints.itemLevel ?? 86,
    influenced: itemHints.influenced ?? [],
    implicits: itemHints.implicits ?? [],
    explicitMods: itemHints.explicitMods ?? [],
    enchants: itemHints.enchants ?? [],
  };
  const baseTags = effectiveBaseTags(stub, base, kb.cannotRoll);
  const natural = [];
  for (const mod of kb.natural ?? []) {
    const w = kb.weightOnTags(mod, baseTags);
    if (w > 0) natural.push(withWeight(mod, w));
  }

  const influence = {};
  for (const name of INFLUENCE_NAMES) {
    const tags = tagsForInfluence(base, name);
    const list = [];
    for (const mod of kb.influence ?? []) {
      const infs = mod.influences ?? [];
      if (infs.length && !infs.some((i) => String(i).toLowerCase() === name.toLowerCase())) continue;
      const w = kb.weightOnTags(mod, tags);
      if (w > 0) list.push(withWeight(mod, w, { _influence: name }));
    }
    if (list.length) influence[name] = sortMods(list);
  }

  const unveiled = [];
  for (const mod of kb.unveiled ?? []) {
    const w = kb.weightOnTags(mod, baseTags);
    if (w > 0) unveiled.push(withWeight(mod, w));
  }

  const itemClass = base.item_class;
  const crafted = [];
  const seenCraft = new Set();
  for (const opt of kb.bench ?? []) {
    const add = opt.add_explicit_mod;
    if (!add?.modId) continue;
    if (!(opt.item_classes ?? []).includes(itemClass)) continue;
    if (seenCraft.has(add.modId)) continue;
    seenCraft.add(add.modId);
    const mod = kb.modById?.get(add.modId) ?? kb.crafted?.find((m) => m.id === add.modId);
    if (!mod) continue;
    const gen =
      add.generation === 'prefix' || add.generation === 'suffix'
        ? add.generation
        : inferCraftGeneration(kb, mod) ?? 'prefix';
    crafted.push(
      withWeight(
        { ...mod, generation: gen, text: add.text || mod.text },
        100,
        { _gen: gen, _bench: opt }
      )
    );
  }

  const essence = [];
  for (const mod of kb.essenceOnly ?? []) {
    const ess = (kb.essencesByModId?.get(mod.id) ?? []).filter((e) => {
      const ic = String(itemClass);
      return (
        e.itemClass === ic ||
        e.itemClass === ic.replace(/s$/, '') ||
        `${e.itemClass}s` === ic ||
        String(e.itemClass).toLowerCase() === ic.toLowerCase()
      );
    });
    if (!ess.length) continue;
    essence.push(withWeight(mod, 100, { _essences: ess }));
  }

  const eldritch = [];
  for (const mod of kb.eldritch ?? []) {
    const w = kb.weightOnTags(mod, baseTags);
    if (w > 0) eldritch.push(withWeight(mod, w));
  }

  const enchant = [];
  for (const mod of kb.enchantments ?? []) {
    const w = kb.weightOnTags(mod, baseTags);
    if (w > 0) enchant.push(withWeight(mod, w));
  }

  return {
    natural: sortMods(natural),
    influence,
    unveiled: sortMods(unveiled),
    crafted: sortMods(crafted),
    essence: sortMods(essence),
    eldritch: sortMods(eldritch),
    enchant: sortMods(enchant),
  };
}

/** Flatten + filter categories for the browser UI. */
export function filterCategoryMods(categories, categoryKey, filters = {}) {
  const gen = filters.gen || '';
  const search = String(filters.search ?? '').trim().toLowerCase();
  const tag = String(filters.tag ?? '').trim().toLowerCase();
  const opts = { gen, search, tag };

  if (categoryKey === 'influence') {
    const out = [];
    for (const [inf, list] of Object.entries(categories.influence ?? {})) {
      for (const mod of list) {
        if (!passesFilters(mod, opts)) continue;
        out.push({ ...mod, _category: 'influence', _section: inf });
      }
    }
    return out;
  }

  const list = categories[categoryKey] ?? [];
  return list
    .filter((m) => passesFilters(m, opts))
    .map((m) => ({ ...m, _category: categoryKey }));
}

export function collectTags(mods, limit = 24) {
  const counts = new Map();
  for (const m of mods) {
    for (const t of m.tags ?? []) {
      if (!t || t === 'default' || t.startsWith('__')) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/**
 * Build a parseItem-compatible object from base + selected KB mods.
 * @param {{ base, mods: object[], itemLevel?: number, influences?: string[] }} opts
 */
export function buildSyntheticItem({ base, mods = [], itemLevel = 86, influences = [] }) {
  if (!base?.name) throw new Error('Pick a base first.');
  if (!mods.length) throw new Error('Add at least one mod to plan.');

  const explicitMods = [];
  const implicits = [];
  const enchants = [];
  const infSet = new Set(
    (influences ?? []).map((i) => INFLUENCE_LABEL[i] || i).filter((i) => INFLUENCE_NAMES.includes(i))
  );

  for (const mod of mods) {
    const cat = mod._category || mod.source;
    const text = rolledModText(mod.text);
    const gen =
      mod.generation === 'prefix' || mod.generation === 'suffix'
        ? mod.generation
        : mod._gen === 'prefix' || mod._gen === 'suffix'
          ? mod._gen
          : null;

    if (cat === 'enchant' || mod.source === 'enchantment') {
      enchants.push({ text, enchant: true, name: mod.name || null });
      continue;
    }
    if (cat === 'eldritch' || mod.source === 'eldritch') {
      implicits.push({ text, implicit: true, eldritch: true, name: mod.name || null });
      continue;
    }

    if (cat === 'crafted' || mod.source === 'crafted') {
      explicitMods.push({
        text,
        crafted: true,
        gen: gen || 'prefix',
        type: gen || 'prefix',
        name: mod.name || null,
        id: mod.id,
      });
      continue;
    }

    if (cat === 'unveiled' || mod.source === 'unveiled') {
      explicitMods.push({
        text,
        veiled: true,
        gen: gen || 'prefix',
        type: gen || 'prefix',
        name: mod.name || null,
        id: mod.id,
        source: 'unveiled',
      });
      continue;
    }

    if (cat === 'essence' || mod.source === 'essence_only' || mod.is_essence_only) {
      explicitMods.push({
        text,
        ofEssence: true,
        gen: gen || 'prefix',
        type: gen || 'prefix',
        name: mod.name || null,
        id: mod.id,
      });
      continue;
    }

    if (cat === 'influence' || mod.source === 'influence') {
      for (const i of mod.influences ?? []) {
        if (INFLUENCE_NAMES.includes(i)) infSet.add(i);
      }
      if (mod._influence && INFLUENCE_NAMES.includes(mod._influence)) infSet.add(mod._influence);
      explicitMods.push({
        text,
        gen: gen || 'suffix',
        type: gen || 'suffix',
        name: mod.name || null,
        id: mod.id,
        source: 'influence',
      });
      continue;
    }

    // natural / default
    explicitMods.push({
      text,
      gen: gen || 'prefix',
      type: gen || 'prefix',
      name: mod.name || null,
      id: mod.id,
    });
  }

  const prefixes = explicitMods.filter((m) => m.gen === 'prefix' && !m.crafted);
  const suffixes = explicitMods.filter((m) => m.gen === 'suffix' && !m.crafted);
  const crafted = explicitMods.filter((m) => m.crafted);

  return {
    game: 'poe1',
    itemClass: base.item_class,
    rarity: 'Rare',
    itemName: null,
    baseName: base.name,
    itemLevel: Math.max(1, Number(itemLevel) || 86),
    quality: null,
    requirements: null,
    sockets: null,
    corrupted: false,
    synthesised: false,
    fracturedItem: false,
    influenced: [...infSet],
    implicits,
    enchants,
    explicitMods,
    prefixes,
    suffixes,
    unknown: [],
    crafted,
    cannotRoll: { noCaster: false, noAttack: false },
    modCount: explicitMods.filter((m) => !m.crafted).length,
    advancedFormat: false,
    built: true,
  };
}

function normModText(t) {
  return rolledModText(t)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceToCategory(source, flags = {}) {
  if (flags.enchant || source === 'enchantment' || source === 'enchant') return 'enchant';
  if (flags.eldritch || source === 'eldritch') return 'eldritch';
  if (flags.crafted || source === 'crafted' || source === 'bench') return 'crafted';
  if (flags.veiled || source === 'unveiled' || source === 'veiled') return 'unveiled';
  if (flags.ofEssence || source === 'essence_only' || source === 'essence') return 'essence';
  if (source === 'influence') return 'influence';
  if (source === 'flask' || source === 'jewel' || source === 'fractured' || source === 'natural') return 'natural';
  return 'natural';
}

function flattenEligible(categories) {
  const out = [];
  for (const m of categories.natural ?? []) out.push({ ...m, _category: 'natural' });
  for (const [inf, list] of Object.entries(categories.influence ?? {})) {
    for (const m of list) {
      out.push({ ...m, _category: 'influence', _section: inf, _influence: m._influence || inf });
    }
  }
  for (const key of ['unveiled', 'crafted', 'essence', 'eldritch', 'enchant']) {
    for (const m of categories[key] ?? []) out.push({ ...m, _category: key });
  }
  return out;
}

function planRowId(row) {
  return row?.match?.id || row?.id || null;
}

function planRowSource(row) {
  return row?.match?.source || row?.kbSource || row?.source || row?.method || null;
}

/**
 * Map a pasted / planned item onto builder state (base, mods, ilvl, influences).
 * Prefers KB ids from plan.classified / plan.modAnalysis; falls back to text / matchModInKnowledge.
 */
export function hydrateBuilderFromItem(kb, item, plan = null) {
  const itemLevel = Math.max(1, Number(item?.itemLevel) || 86);
  const influences = (item?.influenced ?? [])
    .map((i) => INFLUENCE_LABEL[i] || i)
    .filter((i) => INFLUENCE_NAMES.includes(i));

  if (!kb || !item?.baseName) {
    return { base: null, mods: [], itemLevel, influences };
  }

  const base = getBaseInfo(kb, item.baseName) ?? kb.basesByName?.[item.baseName] ?? null;
  if (!base) {
    return { base: null, mods: [], itemLevel, influences };
  }

  const byText = new Map();
  const indexRow = (row) => {
    if (!row?.text) return;
    const key = normModText(row.text);
    if (!byText.has(key)) byText.set(key, row);
    if (row.short) {
      const sk = normModText(row.short);
      if (!byText.has(sk)) byText.set(sk, row);
    }
  };
  for (const m of plan?.classified ?? []) indexRow(m);
  for (const m of plan?.modAnalysis ?? []) indexRow(m);

  const categories = eligibleModsByCategory(kb, base, { itemLevel, influenced: influences });
  const pool = flattenEligible(categories);
  const byId = new Map();
  for (const m of pool) {
    if (m.id && !byId.has(m.id)) byId.set(m.id, m);
  }

  const selected = [];
  const seen = new Set();

  const tryAdd = (mod, categoryHint) => {
    if (!mod?.id || seen.has(mod.id)) return false;
    seen.add(mod.id);
    const cat = categoryHint || mod._category || sourceToCategory(mod.source);
    const entry = { ...mod, _category: cat };
    if (cat === 'influence') {
      const inf =
        mod._influence ||
        (mod.influences ?? []).find((i) => INFLUENCE_NAMES.includes(i)) ||
        null;
      if (inf) {
        entry._influence = inf;
        entry._section = inf;
      }
    }
    selected.push(entry);
    return true;
  };

  const resolveOne = (raw, hints = {}) => {
    const text = typeof raw === 'string' ? raw : raw?.text;
    if (!text) return;

    const planRow = byText.get(normModText(text));
    const flags = {
      crafted: !!(raw?.crafted || planRow?.crafted || hints.crafted),
      ofEssence: !!(raw?.ofEssence || planRow?.ofEssence || hints.ofEssence),
      veiled: !!(raw?.veiled || planRow?.veiled || hints.veiled),
      enchant: !!(raw?.enchant || planRow?.enchant || hints.enchant),
      eldritch: !!(raw?.eldritch || hints.eldritch || planRow?.source === 'eldritch'),
    };
    const src = planRowSource(planRow);
    const wantCat = sourceToCategory(src, flags);
    const matchId = planRowId(planRow);

    if (matchId) {
      const fromPool = byId.get(matchId);
      if (fromPool) {
        tryAdd(fromPool, src ? wantCat : fromPool._category);
        return;
      }
      const fromKb = kb.modById?.get(matchId);
      if (fromKb) {
        tryAdd({ ...fromKb, source: src || fromKb.source }, wantCat);
        return;
      }
    }

    const nt = normModText(text);
    let hit =
      pool.find((m) => m.id && !seen.has(m.id) && m._category === wantCat && normModText(m.text) === nt) ||
      pool.find((m) => m.id && !seen.has(m.id) && normModText(m.text) === nt);

    if (!hit) {
      const match = matchModInKnowledge(
        kb,
        text,
        { ...item, itemClass: base.item_class ?? item.itemClass },
        {
          crafted: flags.crafted,
          ofEssence: flags.ofEssence,
          veiled: flags.veiled,
          enchant: flags.enchant,
          implicit: !!hints.implicit,
          name: (typeof raw === 'object' && raw?.name) || null,
        }
      );
      if (match?.matched && match.id) {
        const fromPool = byId.get(match.id);
        const cat = sourceToCategory(match.source, flags);
        if (fromPool) {
          tryAdd(fromPool, cat);
          return;
        }
        tryAdd(match, cat);
        return;
      }
    }

    if (hit) tryAdd(hit, hit._category);
  };

  for (const m of item.enchants ?? []) resolveOne(m, { enchant: true });
  for (const m of item.implicits ?? []) {
    // Skip base implicits; only hydrate craftable eldritch implicits.
    if (!m?.eldritch && planRowSource(byText.get(normModText(m?.text))) !== 'eldritch') continue;
    resolveOne(m, { implicit: true, eldritch: true });
  }
  for (const m of item.explicitMods ?? []) resolveOne(m);

  const infSet = new Set(influences);
  for (const m of selected) {
    if (m._category !== 'influence') continue;
    for (const i of m.influences ?? []) {
      if (INFLUENCE_NAMES.includes(i)) infSet.add(i);
    }
    if (m._influence && INFLUENCE_NAMES.includes(m._influence)) infSet.add(m._influence);
  }

  return {
    base,
    mods: selected,
    itemLevel,
    influences: [...infSet],
  };
}

/** Active cannot-roll constraints for UI banner. */
export function cannotRollNotice(kb, base, selectedMods = []) {
  if (!base || !kb) return null;
  const implicits = [];
  for (const id of base.implicits ?? []) {
    const mod = kb.modById?.get(id);
    if (mod?.text) implicits.push({ text: mod.text, implicit: true });
  }
  for (const m of selectedMods) {
    if (m._category === 'crafted' || m.source === 'crafted') {
      const t = String(m.text ?? '');
      if (/cannot roll/i.test(t)) implicits.push({ text: rolledModText(t) });
    }
  }
  const item = {
    baseName: base.name,
    implicits,
    explicitMods: selectedMods.map((m) => ({ text: rolledModText(m.text) })),
    enchants: [],
  };
  const { active, blockedTags, maxRequiredLevel } = resolveCannotRoll(item, base, kb.cannotRoll);
  if (!active.length) return null;
  return {
    labels: active.map((c) => c.name || c.id),
    blockedTags,
    maxRequiredLevel,
  };
}

/** Equipment that supports a full rare (3p/3s) — jewels/flasks cannot fit 5 goals. */
const RANDOM_BUILD_CLASSES = new Set(
  [...CRAFTABLE_CLASSES].filter(
    (c) => !/Flask|Jewel|Tincture|Trinket/i.test(c)
  )
);

function modSide(mod) {
  if (mod.generation === 'prefix' || mod.generation === 'suffix') return mod.generation;
  if (mod._gen === 'prefix' || mod._gen === 'suffix') return mod._gen;
  return null;
}

function isMetaBenchCraft(mod) {
  const t = String(mod.text ?? '').toLowerCase();
  return /cannot be changed|multiple crafted|cannot roll/.test(t);
}

function pickRng(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function shuffleRng(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function claimGroups(used, mod) {
  for (const g of mod.groups ?? []) used.add(g);
}

function conflictsGroups(used, mod) {
  return (mod.groups ?? []).some((g) => used.has(g));
}

/**
 * Random realistic rare goals: 4 natural affixes + 1 bench craft (5 total),
 * with prefix/suffix room for the bench side. Uses KB-eligible mods only.
 * @returns {{ base, mods: object[], itemLevel: number, influences: string[] }}
 */
export function pickRandomBuild(kb, { rng = Math.random } = {}) {
  const bases = shuffleRng(
    listCraftableBases(kb).filter((b) => RANDOM_BUILD_CLASSES.has(b.item_class)),
    rng
  );
  const tries = Math.min(bases.length, 48);

  for (let i = 0; i < tries; i++) {
    const base = bases[i];
    const itemLevel = 84 + Math.floor(rng() * 3); // 84–86
    const cats = eligibleModsByCategory(kb, base, { itemLevel });

    const natural = (cats.natural ?? []).filter((m) => (m.required_level ?? 0) <= itemLevel);
    const crafted = (cats.crafted ?? []).filter(
      (m) => (modSide(m) === 'prefix' || modSide(m) === 'suffix') && !isMetaBenchCraft(m)
    );
    const natFamilies = groupModsByFamily(natural).filter(
      (f) => f.generation === 'prefix' || f.generation === 'suffix'
    );
    const craftFamilies = groupModsByFamily(crafted).filter(
      (f) => f.generation === 'prefix' || f.generation === 'suffix'
    );
    if (natFamilies.length < 4 || craftFamilies.length < 1) continue;

    const craftFam = pickRng(craftFamilies, rng);
    const craftTiers = craftFam.tiers;
    const craftPick = pickRng(craftTiers.slice(0, Math.max(1, Math.ceil(craftTiers.length / 2))), rng);
    const craftMod = { ...craftPick, _category: 'crafted', _gen: modSide(craftPick) };
    const benchGen = modSide(craftMod);
    if (!benchGen) continue;

    let maxP = benchGen === 'prefix' ? 2 : 3;
    let maxS = benchGen === 'suffix' ? 2 : 3;
    const used = new Set(craftMod.groups ?? []);
    const selected = [];
    let p = 0;
    let s = 0;

    for (const fam of shuffleRng(natFamilies, rng)) {
      if (selected.length >= 4) break;
      const gen = fam.generation;
      if (gen === 'prefix' && p >= maxP) continue;
      if (gen === 'suffix' && s >= maxS) continue;
      const tiers = fam.tiers.filter((t) => (t.required_level ?? 0) <= itemLevel);
      if (!tiers.length) continue;
      const top = tiers.slice(0, Math.min(3, tiers.length));
      const mod = pickRng(top, rng);
      if (conflictsGroups(used, mod)) continue;
      claimGroups(used, mod);
      selected.push({ ...mod, _category: 'natural' });
      if (gen === 'prefix') p++;
      else s++;
    }

    if (selected.length < 4) continue;

    return {
      base,
      itemLevel,
      mods: [...selected, craftMod],
      influences: [],
    };
  }

  throw new Error('Could not generate a random craftable item.');
}
