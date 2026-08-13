/**
 * Load official PoE1 knowledge base from /data/knowledge/
 * Planner must only use operators backed by these files.
 * Also attaches daily prices from /data/prices/daily.json (if present).
 */
import { loadDailyPrices, pricesFetchTip } from './prices.js';
import { applyOfficialHarvestCosts } from './craftKnowledge.js';

let kbPromise = null;

const FILES = [
  'mods-natural-prefix-suffix.json',
  'mods-essence-only.json',
  'mods-crafted-bench.json',
  'mods-unveiled.json',
  'mods-veiled-placeholders.json',
  'mods-influence.json',
  'mods-delve.json',
  'mods-eldritch-implicits.json',
  'mods-enchantments.json',
  'mods-jewels.json',
  'mods-flasks.json',
  'mods-remainder.json',
  'essences.json',
  'fossils.json',
  'crafting-bench.json',
  'base-items.json',
  'harvest-reforge-official.json',
  'harvest-menu-official.json',
  'beastcraft-official.json',
  'affix-count-distributions.json',
  'operators-preconditions.json',
  'metacrafts-official.json',
  'cannot-roll-official.json',
  'craft-operators-official.json',
  'operators.json',
  'recombinators-official.json',
  'coverage.json',
  'manifest.json',
];

/** Synthetic base tags encoding cannot-roll constraints for weightOnTags. */
export const BLOCK_TAG_PREFIX = '__block_tag__:';
export const BLOCK_MAX_LEVEL_PREFIX = '__max_req_level__:';

/** PoE influence → RePoE spawn tag suffix (quiver_adjudicator, boots_elder, …). */
export const INFLUENCE_TAG_KEY = {
  shaper: 'shaper',
  elder: 'elder',
  crusader: 'crusader',
  hunter: 'basilisk',
  redeemer: 'eyrie',
  warlord: 'adjudicator',
};
/** @deprecated use BLOCK_TAG_PREFIX + 'caster' */
export const BLOCK_CASTER_TAG = `${BLOCK_TAG_PREFIX}caster`;
/** @deprecated use BLOCK_TAG_PREFIX + 'attack' */
export const BLOCK_ATTACK_TAG = `${BLOCK_TAG_PREFIX}attack`;

async function fetchJson(path) {
  const r = await fetch(`/data/knowledge/${path}`);
  if (!r.ok) {
    // New category dumps may be absent until `npm run build:knowledge`
    if (/mods-(jewels|flasks|remainder)\.json$/.test(path)) return { count: 0, mods: [] };
    if (
      /harvest-menu-official|beastcraft-official|affix-count-distributions|operators-preconditions|operators\.json|manifest\.json/.test(
        path
      )
    ) {
      return path === 'manifest.json'
        ? null
        : { crafts: [], recipes: [], methods: {}, operators: [], sourceCompatibility: {}, count: 0 };
    }
    throw new Error(`Knowledge base missing ${path}. Run: npm run build:knowledge`);
  }
  return r.json();
}

/** Display (min-max) from mod text — prefer over raw RePoE stats (e.g. life regen /min). */
function displayRangeFromText(text) {
  const m = String(text ?? '').match(/\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\)/);
  if (!m) return { min: null, max: null };
  return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
}

function textToPattern(text) {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) =>
      line
        // Parenthetical ranges (incl. decimals) → single placeholder before digit wipe
        .replace(/\(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\)/g, '#')
        .replace(/\+#/g, '+#')
        .replace(/\d+(?:\.\d+)?%/g, '#%')
        .replace(/\d+(?:\.\d+)?/g, '#')
        .trim()
    )
    .join('|');
}

/** Drop parenthetical flavour / Advanced Description clutter for matching. */
function significantModLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\([^)]*\)\s*$/.test(l));
}

function patternMatch(pattern, text) {
  if (!pattern || !text) return false;
  const parts = pattern.split('|').map((p) => p.trim()).filter(Boolean);
  const lines = significantModLines(text);
  if (!parts.length || !lines.length) return false;

  // Multi-line hybrid: every pattern line must appear as some item line (order-flexible).
  if (parts.length > 1) {
    return parts.every((p) => lines.some((line) => patternMatchSingle(p, line)));
  }
  return patternMatchSingle(parts[0], lines[0]);
}

function patternMatchSingle(p, line) {
  const regex = new RegExp(
    '^' +
      p
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\#/g, '__NUM__')
        .replace(/#/g, '(\\+?\\d+(?:\\.\\d+)?)')
        .replace(/__NUM__/g, '#') +
      '$',
    'i'
  );
  return regex.test((line ?? '').trim());
}

function extractNumbers(text) {
  // Prefer rolled Advanced Desc value; drop leftover (min-max) ranges
  const cleaned = String(text)
    .replace(/(\d+(?:\.\d+)?)\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)/g, '$1')
    .replace(/\(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\)/g, ' ');
  return [...cleaned.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
}

function modTextBlob(item) {
  const parts = [];
  for (const list of [
    item?.implicits,
    item?.enchants,
    item?.explicitMods,
    item?.craftedMods ?? item?.crafted,
  ]) {
    for (const m of list ?? []) parts.push(typeof m === 'string' ? m : m?.text ?? '');
  }
  return parts.join('\n');
}

/**
 * Active cannot-roll constraints from KB + item text / base implicits.
 * @returns {{ active: object[], blockedTags: string[], maxRequiredLevel: number|null }}
 */
/** Fallback when KB constraints not yet threaded (mirrors cannot-roll-official.json). */
const DEFAULT_CANNOT_ROLL = [
  {
    id: 'cannot-roll-caster',
    detect: ['Cannot roll Caster Modifiers'],
    blocked_tags: ['caster'],
    base_implicit_ids: ['KineticWandImplicit'],
  },
  {
    id: 'cannot-roll-attack',
    detect: ['Cannot roll Attack Modifiers'],
    blocked_tags: ['attack'],
  },
  {
    id: 'cannot-roll-above-level-28',
    detect: ['Cannot roll Modifiers with Required Level above 28'],
    max_required_level: 28,
  },
];

/**
 * Active cannot-roll constraints from KB + item text / base implicits.
 * @returns {{ active: object[], blockedTags: string[], maxRequiredLevel: number|null }}
 */
export function resolveCannotRoll(item, base, constraints) {
  const list = constraints?.length ? constraints : DEFAULT_CANNOT_ROLL;
  const blob = modTextBlob(item);
  const baseImps = new Set(base?.implicits ?? []);
  const active = [];
  const blockedTags = new Set();
  let maxRequiredLevel = null;

  for (const c of list) {
    const byText = (c.detect ?? []).some((d) => blob.toLowerCase().includes(String(d).toLowerCase()));
    const byImplicit = (c.base_implicit_ids ?? []).some((id) => baseImps.has(id));
    if (!byText && !byImplicit) continue;
    active.push(c);
    for (const t of c.blocked_tags ?? []) blockedTags.add(t);
    if (c.max_required_level != null) {
      maxRequiredLevel =
        maxRequiredLevel == null
          ? c.max_required_level
          : Math.min(maxRequiredLevel, c.max_required_level);
    }
  }

  return { active, blockedTags: [...blockedTags], maxRequiredLevel };
}

/** @deprecated prefer resolveCannotRoll */
export function resolveRollFlags(item, base, constraints) {
  const { blockedTags, maxRequiredLevel } = resolveCannotRoll(item, base, constraints);
  return {
    noCaster: blockedTags.includes('caster'),
    noAttack: blockedTags.includes('attack'),
    maxRequiredLevel,
    blockedTags,
  };
}

/** Base tags plus synthetic cannot-roll flags for spawn-weight resolution. */
export function effectiveBaseTags(item, base, constraints) {
  const tags = [...(base?.tags ?? ['default'])];
  const list =
    constraints?.length
      ? constraints
      : item?._cannotRollConstraints?.length
        ? item._cannotRollConstraints
        : DEFAULT_CANNOT_ROLL;
  const { blockedTags, maxRequiredLevel } = resolveCannotRoll(item, base, list);
  for (const t of blockedTags) tags.push(`${BLOCK_TAG_PREFIX}${t}`);
  if (maxRequiredLevel != null) tags.push(`${BLOCK_MAX_LEVEL_PREFIX}${maxRequiredLevel}`);

  // Influenced bases also roll influence-tagged mods (quiver_adjudicator, …).
  for (const inf of item?.influenced ?? []) {
    const key = INFLUENCE_TAG_KEY[String(inf).toLowerCase()];
    if (!key) continue;
    tags.push(key);
    for (const t of base?.tags ?? []) {
      if (t === 'default' || t.startsWith('trade_')) continue;
      tags.push(`${t}_${key}`);
    }
  }
  return tags;
}

function blockedTagsFromBaseTags(baseTags) {
  const out = [];
  for (const t of baseTags ?? []) {
    if (t.startsWith(BLOCK_TAG_PREFIX)) out.push(t.slice(BLOCK_TAG_PREFIX.length));
    // legacy synthetic tags from earlier builds
    if (t === '__block_caster__') out.push('caster');
    if (t === '__block_attack__') out.push('attack');
  }
  return out;
}

function maxReqFromBaseTags(baseTags) {
  let max = null;
  for (const t of baseTags ?? []) {
    if (!t.startsWith(BLOCK_MAX_LEVEL_PREFIX)) continue;
    const n = Number(t.slice(BLOCK_MAX_LEVEL_PREFIX.length));
    if (!Number.isFinite(n)) continue;
    max = max == null ? n : Math.min(max, n);
  }
  return max;
}

/**
 * CoE / PoE / PoECraft spawn resolution:
 * walk spawn_weights in order; first tag present on the base wins (0 excludes).
 * Then apply first matching generation_weights as value/100 multiplier.
 * Also respects cannot-roll constraints encoded on baseTags.
 */
function weightOnTags(mod, baseTags) {
  const tags = baseTags ?? [];
  const blocked = blockedTagsFromBaseTags(tags);
  const modTags = mod.tags ?? [];
  if (blocked.some((t) => modTags.includes(t))) return 0;
  const maxReq = maxReqFromBaseTags(tags);
  if (maxReq != null && (mod.required_level ?? 0) > maxReq) return 0;

  let spawn = 0;
  let matched = false;
  for (const { tag, weight } of mod.spawn_weights ?? []) {
    if (!tags.includes(tag)) continue;
    spawn = weight ?? 0;
    matched = true;
    break;
  }
  if (!matched) return 0;
  if (spawn <= 0) return 0;
  for (const { tag, weight } of mod.generation_weights ?? []) {
    if (!tags.includes(tag)) continue;
    spawn = (spawn * (weight ?? 100)) / 100;
    break;
  }
  return spawn;
}

function indexMods(list, source) {
  return (list ?? []).map((m) => {
    const fromText = displayRangeFromText(m.text);
    const min = fromText.min ?? m.stats?.[0]?.min ?? null;
    const max = fromText.max ?? m.stats?.[0]?.max ?? null;
    return {
      ...m,
      source,
      pattern: textToPattern(m.text),
      min,
      max,
    };
  });
}

export async function loadKnowledgeBase() {
  if (kbPromise) return kbPromise;
  kbPromise = (async () => {
    const entries = await Promise.all(FILES.map(async (f) => [f, await fetchJson(f)]));
    const data = Object.fromEntries(entries);

    const natural = indexMods(data['mods-natural-prefix-suffix.json'].mods, 'natural');
    const essenceOnly = indexMods(data['mods-essence-only.json'].mods, 'essence_only');
    const crafted = indexMods(data['mods-crafted-bench.json'].mods, 'crafted');
    const unveiled = indexMods(data['mods-unveiled.json'].mods, 'unveiled');
    const influence = indexMods(data['mods-influence.json'].mods, 'influence');
    const delve = indexMods(data['mods-delve.json'].mods, 'delve');
    const eldritch = indexMods(data['mods-eldritch-implicits.json'].mods, 'eldritch');
    const enchantments = indexMods(data['mods-enchantments.json'].mods, 'enchantment');
    const jewels = indexMods(data['mods-jewels.json']?.mods, 'jewel');
    const flasks = indexMods(data['mods-flasks.json']?.mods, 'flask');
    // Remainder (uniques / implicits / monster…) — id lookup only, not paste-matched by default
    const remainder = data['mods-remainder.json']?.mods ?? [];

    const allMatchable = [
      ...natural,
      ...essenceOnly,
      ...crafted,
      ...unveiled,
      ...influence,
      ...delve,
      ...eldritch,
      ...enchantments,
      ...jewels,
      ...flasks,
    ];

    const modById = new Map();
    for (const m of allMatchable) {
      if (m.id && !modById.has(m.id)) modById.set(m.id, m);
    }
    for (const m of remainder) {
      if (m.id && !modById.has(m.id)) modById.set(m.id, { ...m, source: 'remainder' });
    }

    const basesByName = {};
    for (const b of data['base-items.json'].bases ?? []) {
      basesByName[b.name] = b;
    }

    const essences = data['essences.json'].essences ?? [];
    const essencesByModId = new Map();
    for (const e of essences) {
      for (const [itemClass, modId] of Object.entries(e.mods_by_item_class ?? {})) {
        if (!essencesByModId.has(modId)) essencesByModId.set(modId, []);
        essencesByModId.get(modId).push({ ...e, itemClass });
      }
    }
    applyOfficialHarvestCosts(data['harvest-reforge-official.json']);

    const benchByModId = new Map();
    for (const opt of data['crafting-bench.json'].options ?? []) {
      if (opt.add_explicit_mod?.modId) {
        benchByModId.set(opt.add_explicit_mod.modId, opt);
      }
    }

    const cannotRoll = data['cannot-roll-official.json']?.constraints ?? [];

    const pricePack = await loadDailyPrices();

    return {
      natural,
      essenceOnly,
      crafted,
      unveiled,
      influence,
      delve,
      eldritch,
      enchantments,
      jewels,
      flasks,
      remainder,
      allMatchable,
      modById,
      essences,
      essencesByModId,
      fossils: data['fossils.json'].fossils ?? [],
      bench: data['crafting-bench.json'].options ?? [],
      benchByModId,
      basesByName,
      harvest: data['harvest-reforge-official.json'],
      harvestMenu: data['harvest-menu-official.json'],
      beastcraft: data['beastcraft-official.json'],
      affixCounts: data['affix-count-distributions.json'],
      preconditions: data['operators-preconditions.json'],
      metacrafts: data['metacrafts-official.json'].crafts ?? [],
      cannotRoll,
      operators: data['craft-operators-official.json'],
      operatorsCanonical: data['operators.json'],
      recombinator: data['recombinators-official.json'],
      coverage: data['coverage.json'],
      manifest: data['manifest.json'],
      dataVersion: data['manifest.json']?.dataVersion ?? data['coverage.json']?.dataVersion ?? data['coverage.json']?.built_at,
      rulesetVersion: data['manifest.json']?.rulesetVersion ?? data['coverage.json']?.rulesetVersion ?? '3.29',
      versionWarnings: (() => {
        const warnings = [];
        const expected = '3.29';
        const repoeV = data['manifest.json']?.repoe?.gameVersion ?? data['coverage.json']?.repoe?.gameVersion;
        if (!repoeV) {
          warnings.push('RePoE snapshot game version not verified');
        } else if (String(repoeV) !== expected) {
          warnings.push(`RePoE data version ${repoeV} ≠ expected ${expected}`);
        }
        return warnings;
      })(),
      prices: pricePack.prices,
      priceSnapshot: pricePack.snapshot,
      priceStatus: pricePack.status,
      pricesTip: pricesFetchTip(),
      // helpers
      textToPattern,
      patternMatch,
      extractNumbers,
      weightOnTags,
      resolveCannotRoll: (item, base) => resolveCannotRoll(item, base, cannotRoll),
      effectiveBaseTags: (item, base) => effectiveBaseTags(item, base, cannotRoll),
    };
  })();
  return kbPromise;
}

/** For tests */
export function loadKnowledgeBaseFrom(obj) {
  applyOfficialHarvestCosts(obj?.harvest);
  kbPromise = Promise.resolve(obj);
  return kbPromise;
}

/**
 * Match a pasted mod line against the knowledge base.
 * @param {{ crafted?: boolean, ofEssence?: boolean, veiled?: boolean, fractured?: boolean, enchant?: boolean, implicit?: boolean }} [hints]
 */
export function matchModInKnowledge(kb, modText, item, hints = {}) {
  const base = getBaseInfo(kb, item.baseName) ?? kb.basesByName[item.baseName];
  const withConstraints = { ...item, _cannotRollConstraints: kb.cannotRoll };
  const baseTags = effectiveBaseTags(withConstraints, base, kb.cannotRoll);
  const ilvl = Math.max(item.itemLevel ?? 85, 1);
  const nums = kb.extractNumbers(
    String(modText)
      .split('\n')
      .filter((l) => l.trim() && !/^\([^)]*\)\s*$/.test(l.trim()))
      .join('\n')
  );
  const primary = nums[0] ?? null;
  const itemClass = base?.item_class ?? item.itemClass ?? null;
  const nameHint = (hints.name || '').toLowerCase().trim();

  // Base implicits (Heavy Belt Str, etc.): match remainder / modById by base implicit ids first
  if (hints.implicit && base?.implicits?.length) {
    let bestImp = null;
    for (const id of base.implicits) {
      const mod = kb.modById?.get(id);
      if (!mod?.text || !kb.patternMatch(mod.pattern || kb.textToPattern(mod.text), modText)) continue;
      let rangeFit = 0;
      const min = mod.min ?? mod.stats?.[0]?.min;
      const max = mod.max ?? mod.stats?.[0]?.max;
      if (primary != null && min != null && max != null) {
        if (primary < min - 1) continue;
        const mid = (min + max) / 2;
        rangeFit = 1000 - Math.abs(primary - mid);
      }
      const score = 8000 + rangeFit;
      if (!bestImp || score > bestImp._score) {
        bestImp = { ...mod, weight: 0, essences: [], bench: null, matched: true, source: 'implicit', _score: score };
      }
    }
    if (bestImp) {
      const { _score, ...rest } = bestImp;
      return rest;
    }
  }

  // Source order driven by paste signals — never treat natural rolls as bench/essence by default.
  let prefer;
  const icLower = String(itemClass ?? item.itemClass ?? '').toLowerCase();
  if (hints.enchant) prefer = ['enchantment'];
  else if (hints.implicit) prefer = ['eldritch', 'crafted'];
  else if (hints.crafted) prefer = ['crafted'];
  else if (hints.ofEssence) prefer = ['essence_only', 'natural'];
  else if (hints.veiled) prefer = ['unveiled', 'natural'];
  else if (/jewel/.test(icLower)) prefer = ['jewel', 'natural', 'unveiled', 'crafted'];
  else if (/flask/.test(icLower)) prefer = ['flask', 'natural', 'crafted'];
  else if ((item.influenced ?? []).length) prefer = ['influence', 'natural', 'unveiled', 'delve', 'essence_only', 'crafted'];
  else prefer = ['natural', 'unveiled', 'influence', 'delve', 'essence_only', 'crafted'];

  const pools = {
    natural: kb.natural,
    essence_only: kb.essenceOnly,
    crafted: kb.crafted,
    unveiled: kb.unveiled,
    influence: kb.influence,
    delve: kb.delve,
    eldritch: kb.eldritch,
    enchantment: kb.enchantments,
    jewel: kb.jewels,
    flask: kb.flasks,
  };

  let best = null;

  for (const source of prefer) {
    for (const mod of pools[source] ?? []) {
      if (!mod.text || !kb.patternMatch(mod.pattern, modText)) continue;
      if (primary != null && mod.min != null && mod.max != null) {
        // Hybrid pastes: first number may be a flat (10% bleed chance) while display
        // min/max come from a later (15-25)% line — accept if any extracted number fits.
        const inRange = nums.some((n) => n >= mod.min - 1 && n <= mod.max + 1);
        const above = nums.some((n) => n > mod.max + 1);
        if (!inRange && !above && primary < mod.min - 1) continue;
      }
      // Affix pools require positive spawn weight on this base (zeros exclude via first-tag rule)
      const weight = kb.weightOnTags(mod, baseTags);
      if ((source === 'natural' || source === 'influence' || source === 'flask' || source === 'jewel') && weight <= 0) {
        continue;
      }
      if (source !== 'enchantment' && source !== 'eldritch' && (mod.required_level ?? 0) > ilvl + 10) continue;

      // Prefer closer numeric fit + higher weight
      let rangeFit = 0;
      if (primary != null && mod.min != null && mod.max != null) {
        if (primary > mod.max + 1) rangeFit = 200 + mod.max;
        else {
          const mid = (mod.min + mod.max) / 2;
          rangeFit = 1000 - Math.abs(primary - mid);
        }
      }
      const nameBonus =
        nameHint && mod.name && String(mod.name).toLowerCase() === nameHint ? 4000 : 0;
      const sourceBonus =
        source === prefer[0] ? 5000 : source === 'natural' ? 3000 : source === 'unveiled' ? 2000 : 0;
      const score = sourceBonus + nameBonus + rangeFit + Math.min(weight, 2000);
      if (!best || score > best._score) {
        const essences = (kb.essencesByModId.get(mod.id) ?? []).filter((e) => {
          if (!itemClass) return true;
          const ic = String(itemClass);
          return (
            e.itemClass === ic ||
            e.itemClass === ic.replace(/s$/, '') ||
            `${e.itemClass}s` === ic ||
            e.itemClass.toLowerCase() === ic.toLowerCase()
          );
        });
        best = {
          ...mod,
          weight:
            weight ||
            (source === 'essence_only' ||
            source === 'crafted' ||
            source === 'unveiled' ||
            source === 'eldritch' ||
            source === 'enchantment'
              ? 100
              : 0),
          essences: essences.sort((a, b) => (b.level ?? 0) - (a.level ?? 0)),
          bench: kb.benchByModId.get(mod.id) ?? null,
          _score: score,
          matched: true,
          source,
        };
      }
    }
    // Stick with first strong natural/flask/jewel/crafted/unveil/implicit/influence hit
    if (
      best &&
      (hints.crafted ||
        hints.ofEssence ||
        hints.veiled ||
        hints.enchant ||
        hints.implicit ||
        source === 'natural' ||
        source === 'flask' ||
        source === 'jewel' ||
        (source === 'influence' && best.weight > 0))
    )
      break;
  }

  // Also attach essences that can guarantee this mod id even when matched as natural
  if (best?.id && !best.essences?.length) {
    const essences = (kb.essencesByModId.get(best.id) ?? []).filter(
      (e) =>
        !itemClass ||
        e.itemClass === itemClass ||
        e.itemClass === String(itemClass).replace(/s$/, '') ||
        `${e.itemClass}s` === itemClass
    );
    best.essences = essences.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  }

  // Bench recipe lookup by text for crafted hints when mod id mapping missed
  if (hints.crafted && best && !best.bench) {
    best.bench = kb.benchByModId.get(best.id) ?? { craft: true };
  }

  if (!best) {
    return {
      text: modText,
      matched: false,
      generation: null,
      weight: null,
      source: 'unknown',
      essences: [],
      bench: null,
    };
  }

  const { _score, ...rest } = best;
  return rest;
}

export function getBaseInfo(kb, baseName) {
  if (!baseName) return null;
  if (kb.basesByName[baseName]) return kb.basesByName[baseName];
  // Magic paste may still include affix words — peel until a known base matches
  let s = String(baseName).replace(/\s+of\s+.+$/i, '').trim();
  if (kb.basesByName[s]) return kb.basesByName[s];
  const parts = String(baseName).split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    for (let ofStrip of [false, true]) {
      let cand = parts.slice(i).join(' ');
      if (ofStrip) cand = cand.replace(/\s+of\s+.+$/i, '').trim();
      if (cand && kb.basesByName[cand]) return kb.basesByName[cand];
    }
  }
  return null;
}

/** Clipboard / display name → poecdn gen/image influence flags. */
export const ART_INFLUENCE_FLAG = {
  Shaper: 'shaper',
  Elder: 'elder',
  Crusader: 'crusader',
  Redeemer: 'redeemer',
  Hunter: 'hunter',
  Warlord: 'warlord',
  // Eldritch (not conqueror influence, but distinct inventory glow)
  Exarch: 'searing',
  Searing: 'searing',
  'Searing Exarch': 'searing',
  Eater: 'tangled',
  Tangled: 'tangled',
  'Eater of Worlds': 'tangled',
};

function artPathToF(art) {
  return String(art)
    .replace(/\\/g, '/')
    .replace(/^Art\//i, '')
    .replace(/\.dds$/i, '');
}

/** Normalize paste influences → sorted CDN flag keys (shaper, warlord, searing, …). */
export function artInfluenceFlags(influences = []) {
  const flags = {};
  for (const raw of influences ?? []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const flag =
      ART_INFLUENCE_FLAG[name] ??
      ART_INFLUENCE_FLAG[name.replace(/ Item$/i, '')] ??
      ART_INFLUENCE_FLAG[name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()];
    if (flag) flags[flag] = true;
  }
  return flags;
}

function ggpkArtUrl(base) {
  const dds = base?.art;
  if (!dds) return null;
  const path = String(dds).replace(/\\/g, '/');
  return `https://image.ggpk.exposed/poe1/${path}?format=png`;
}

/**
 * Official trade-CDN pattern:
 *   https://web.poecdn.com/gen/image/{base64([25,14,{f,w,h,scale,shaper?,warlord?,…}])}/{hash}/{file}.png
 * Hash is opaque (GGG-issued); only works when base.artHashes[flagKey] or base.artHash is set.
 */
export function poecdnGenArtUrl(base, flags = {}) {
  if (!base?.art) return null;
  const f = artPathToF(base.art);
  const payload = [25, 14, { f, w: base.w ?? 1, h: base.h ?? 1, scale: 1, ...flags }];
  const json = JSON.stringify(payload);
  const b64 = (
    typeof btoa === 'function' ? btoa(json) : Buffer.from(json, 'utf8').toString('base64')
  ).replace(/=+$/, '');
  const flagKey = Object.keys(flags).sort().join('+') || 'plain';
  const hash = base.artHashes?.[flagKey] ?? (flagKey === 'plain' ? base.artHash : null);
  if (!hash) return null;
  return `https://web.poecdn.com/gen/image/${b64}/${hash}/${f.split('/').pop()}.png`;
}

/**
 * Inventory icon URL. Prefer poecdn gen (with influence flags) when a matching art hash
 * exists; otherwise plain gen/ggpk + UI glow/badges.
 * @returns {{ url: string, fallbackUrl: string|null, flags: Record<string, true>, glow: boolean } | null}
 */
export function itemArtUrl(base, influences = []) {
  if (!base?.art) return null;
  const flags = artInfluenceFlags(influences);
  const plainGgpk = ggpkArtUrl(base);
  const genExact = poecdnGenArtUrl(base, flags);
  if (genExact) return { url: genExact, fallbackUrl: plainGgpk, flags, glow: false };
  // No influence-specific hash: use plain CDN art when available; UI adds glow/badges
  const genPlain = poecdnGenArtUrl(base, {});
  return {
    url: genPlain ?? plainGgpk,
    fallbackUrl: genPlain ? plainGgpk : null,
    flags,
    glow: Object.keys(flags).length > 0,
  };
}

export function poolWeight(kb, baseTags, ilvl, generation, blockedGroups = []) {
  let total = 0;
  for (const mod of kb.natural) {
    if (mod.generation !== generation) continue;
    if (mod.required_level > ilvl) continue;
    if (blockedGroups.some((g) => (mod.groups ?? []).includes(g))) continue;
    total += kb.weightOnTags(mod, baseTags);
  }
  return total;
}

export function harvestPoolWeight(kb, baseTags, ilvl, generation, harvestMatcher) {
  let total = 0;
  let target = 0;
  for (const mod of [...kb.natural, ...kb.essenceOnly]) {
    if (mod.generation !== generation) continue;
    if (mod.required_level > ilvl) continue;
    if (!harvestMatcher(mod)) continue;
    const w = kb.weightOnTags(mod, baseTags) || (mod.is_essence_only ? 0 : 0);
    // essence-only don't naturally harvest-roll usually
    if (mod.is_essence_only) continue;
    const ww = kb.weightOnTags(mod, baseTags);
    if (ww <= 0) continue;
    total += ww;
  }
  return total;
}

export { textToPattern, patternMatch, displayRangeFromText };
