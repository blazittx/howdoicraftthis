/**
 * Universal craft planner: candidate methods → cheapest consistent combo.
 *
 * For EVERY target mod we list legal forces from the knowledge base
 * (essence-by-item-class, harvest family, unveil, bench, alt, exalt).
 * Then we pick at most one essence, group harvest siblings, unveil, bench.
 *
 * This is how boots get Zeal→MS + Defence harvest→ES without hardcoding boots.
 */

import {
  loadKnowledgeBase,
  matchModInKnowledge,
  getBaseInfo,
  effectiveBaseTags,
  resolveCannotRoll,
  INFLUENCE_TAG_KEY,
} from './knowledgeLoader.js';
import {
  generationPoolWeight,
  essenceFishExpected,
  multiGenEssenceFishExpected,
  combineEssenceFishParts,
  harvestGoalOdds,
  altExpected,
  exaltExpected,
  influenceSlamExpected,
  eldritchSideExpected,
  unveilExpected,
  formatWeight,
  weightTierAndAbove,
  resolveNaturalMod,
  modForPoETier,
  bestBlockCraft,
  bestCannotRollAssist,
  poolWeightMinusGroups,
  collectOccupiedGroups,
  isNonOccupyingAffix,
  inferCraftGeneration,
} from './spawnWeights.js';
import {
  METACRAFT,
  HARVEST_REFORGES,
  chaosCost,
  formatCostBreakdown,
  harvestWithMetacraftCost,
  harvestCostBag,
  modMatchesHarvest,
  essencePriceKey,
  requiredInfluences,
  recommendInfluenceAcquisition,
  formatInfluenceBaseStep,
  INFLUENCE_EXALTS,
  normalizeInfluence,
} from './craftKnowledge.js';

const HARVEST_SPECIFICITY = {
  'reforge-critical': 100,
  'reforge-defence': 100,
  'reforge-speed': 95,
  'reforge-chaos': 85,
  'reforge-life': 80,
  'reforge-fire': 70,
  'reforge-cold': 70,
  'reforge-lightning': 70,
  'reforge-physical': 65,
  'reforge-attack': 25,
  'reforge-caster': 25,
};

/** User-facing mod label; keep hybrid / multi-line stats joined (not first line only). */
function short(t) {
  return String(t ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' | ');
}
function mergeCost(into, add) {
  for (const [k, v] of Object.entries(add ?? {})) into[k] = (into[k] ?? 0) + v;
}
function renumber(steps) {
  return steps.map((s, i) => ({ ...s, step: i + 1 }));
}
function pct(p) {
  if (p <= 0) return '0%';
  if (p >= 1) return '100%';
  if (p >= 0.1) return `${(p * 100).toFixed(1)}%`;
  if (p >= 0.01) return `${(p * 100).toFixed(2)}%`;
  if (p >= 0.0001) return `${(p * 100).toFixed(3)}%`;
  return `${(p * 100).toFixed(4)}%`;
}
function expectedAttempts(p) {
  return p <= 0 ? Infinity : Math.ceil(1 / p);
}
function step(operator, currency, action, detail, targetMods, cost, extra = {}) {
  return { operator, currency, action, detail, targetMods, cost, ...extra };
}

/** True when mid-craft has room for a temp bench block + the slam on this side. */
function canTempBlock(mods, benchMods, gen, target) {
  const permanent = mods.filter(
    (m) => m.gen === gen && m !== target && !m.crafted && !benchMods.includes(m)
  );
  return 3 - permanent.length >= 2;
}

function sideGroups(mods, benchMods, gen, target, { includeTarget = false, includeBench = false } = {}) {
  const g = new Set();
  for (const m of mods) {
    if (m.gen !== gen) continue;
    if (m === target && !includeTarget) continue;
    if ((m.crafted || benchMods.includes(m)) && !includeBench) continue;
    for (const x of m.groups ?? []) g.add(x);
  }
  return g;
}

/** Groups already filled on the item / earlier plan steps (optional generation filter). */
function occupiedGroupsNow(mods, gen = null) {
  return collectOccupiedGroups(
    mods.filter((m) => (m._done || m.fractured) && (!gen || m.gen === gen))
  );
}

function pickSlamBlock(kb, itemClass, baseTags, ilvl, mods, benchMods, target) {
  const gen = target.gen;
  if (!gen || !canTempBlock(mods, benchMods, gen, target)) return null;
  const avoid = sideGroups(mods, benchMods, gen, target, { includeTarget: true, includeBench: true });
  const occupied = sideGroups(mods, benchMods, gen, target);
  return bestBlockCraft(kb, itemClass, baseTags, ilvl, gen, avoid, occupied);
}

function blockActionPrefix(block) {
  if (!block) return '';
  const removedPct = ((block.blockedWeight / block.poolBefore) * 100).toFixed(0);
  return `Bench block ${block.text} (−${formatWeight(block.blockedWeight, block.poolBefore).replace(/^hit /, '')} ≈ ${removedPct}%) → `;
}

function blockDetail(block, forUnveil = false) {
  if (!block) return '';
  const oddsNote = forUnveil
    ? 'Occupies that mod group so natural junk cannot fill the open slot before veiled slam.'
    : `Pool ${block.poolBefore} → ${block.poolAfter} after block.`;
  return `Bench-block ${block.text} first (highest-weight non-goal group). ${oddsNote} `;
}

/**
 * Veiled Chaos + metacraft reforges the unlocked side (fractured stays; guarantees a veiled).
 * Prefer it when the other side is locked and this side has no non-fractured keepers to preserve.
 * Veiled Exalt only adds into an open slot without reforging — use when keepers must survive.
 */
function preferVeiledChaos(mods, unveilMod) {
  const gen = unveilMod.gen;
  if (!gen) return true;
  return !mods.some(
    (m) =>
      m !== unveilMod &&
      m.gen === gen &&
      !m.fractured &&
      !isBenchMod(m) &&
      !(m.veiled || m.match?.source === 'unveiled')
  );
}

function veiledOrbCost(attempts, useChaos) {
  const key = useChaos ? 'veiled-chaos' : 'veiled';
  return { [key]: attempts, divine: 2 * attempts };
}
function costOf(bag, prices) {
  const c = chaosCost(bag, prices);
  return c == null ? Infinity : c;
}

function rankCost(c) {
  return c == null || !Number.isFinite(c) ? Infinity : c;
}

function allHarvestsFor(mod) {
  const isEleResist =
    /Resistance/i.test(mod.text ?? '') &&
    !/Penetrate/i.test(mod.text ?? '') &&
    !/Chaos Resistance/i.test(mod.text ?? '');
  return HARVEST_REFORGES.filter((h) => {
    if (isEleResist && /reforge-(fire|cold|lightning)/.test(h.id)) return false;
    return modMatchesHarvest(mod, h);
  });
}

function bestSharedHarvest(mods) {
  let best = null;
  for (const h of HARVEST_REFORGES) {
    const covered = mods.filter((m) => modMatchesHarvest(m, h));
    if (!covered.length) continue;
    const score = covered.length * 1000 + (HARVEST_SPECIFICITY[h.id] ?? 0);
    if (!best || score > best.score) best = { harvest: h, covered, score };
  }
  return best;
}

/**
 * Harvest + metacraft: lock one affix side, reforge the other.
 * Keepers on the rerolled side are destroyed unless fractured / sought by this reforge / finished after.
 */
function harvestMetacraftSides(remaining, essenceTarget) {
  const sameSideAsEssence =
    !!essenceTarget && remaining.length > 0 && remaining.every((m) => m.gen === essenceTarget.gen);
  const meta = sameSideAsEssence
    ? essenceTarget.gen === 'suffix'
      ? METACRAFT.suffixesCannotBeChanged
      : METACRAFT.prefixesCannotBeChanged
    : remaining[0]?.gen === 'prefix'
      ? METACRAFT.suffixesCannotBeChanged
      : METACRAFT.prefixesCannotBeChanged;
  const lockSide = meta.locks;
  const rerollSide = lockSide === 'prefix' ? 'suffix' : 'prefix';
  return { meta, lockSide, rerollSide, sameSideAsEssence };
}

function isArmourItemClass(itemClass) {
  return ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(normalizeItemClass(itemClass));
}

/**
 * Affix gens that a later harvest / Eldritch Chaos will wipe.
 * Do not fish/require non-fractured keepers on those gens before the reforge.
 * skipMods: essence target / goals already covered by essence fish (no harvest wipe).
 */
function sideRerollGensAhead(mods, { essenceTarget, chosenEssence, itemClass, skipMods = [] }) {
  const gens = new Set();
  const armour = isArmourItemClass(itemClass);
  const skip = new Set(skipMods);
  if (essenceTarget) skip.add(essenceTarget);
  const harvestable = mods.filter(
    (m) =>
      !skip.has(m) &&
      !m._done &&
      !m.fractured &&
      !isBenchMod(m) &&
      !(m.veiled || m.match?.source === 'unveiled') &&
      m.harvests?.length &&
      !isInfluenceGoal(m) &&
      !m._skipHarvest
  );
  for (const side of ['suffix', 'prefix']) {
    const sideMods = harvestable.filter((m) => m.gen === side);
    if (!sideMods.length) continue;
    const shared = bestSharedHarvest(sideMods);
    if (!shared) continue;
    const remaining = shared.covered.filter((m) => !m._done);
    if (!remaining.length) continue;
    if (
      (shared.harvest.id === 'reforge-defence' || shared.harvest.id === 'reforge-life') &&
      chosenEssence &&
      armour
    ) {
      continue;
    }
    gens.add(harvestMetacraftSides(remaining, essenceTarget).rerollSide);
  }
  if (armour && chosenEssence) {
    if (mods.some((m) => !m._done && !m.fractured && m.gen === 'suffix' && !isBenchMod(m))) {
      gens.add('suffix');
    }
  }
  return gens;
}

/** Done keepers that a side-reroll would destroy (not fractured, not reforge targets). */
function unprotectedDoneKeepersOnSide(mods, rerollSide, allowedTargets = []) {
  const allow = new Set(allowedTargets);
  return mods.filter(
    (m) =>
      m.gen === rerollSide &&
      m._done &&
      !m.fractured &&
      !allow.has(m) &&
      !isBenchMod(m) &&
      !(m.veiled || m.match?.source === 'unveiled')
  );
}

/** Mark mod as harvest-acquired; weights use harvest-tagged pool only. */
function assignHarvestMethod(m, harvest, odds) {
  m.method = 'harvest';
  m.harvest = harvest;
  m.hitWeight = odds.hitWeight;
  m.poolWeight = odds.poolWeight;
  m.weightLine = formatWeight(odds.hitWeight, odds.poolWeight);
  m.chance = Math.min(0.95, Math.max(odds.pRoll ?? odds.chance ?? 0, 1e-12));
  m.poolShare = m.chance;
}

/** Essence-fished natural rolls keep the open generation pool (occupied groups excluded). */
function assignEssenceFishNatural(m, chance, note, weightLine = null) {
  m.method = 'natural';
  m.chance = chance;
  m.note = note;
  if (weightLine) {
    m.weightLine = weightLine;
    const hit = Number(String(weightLine).match(/hit (\d+)/)?.[1]);
    const pool = Number(String(weightLine).match(/pool (\d+)/)?.[1]);
    if (hit > 0) m.hitWeight = hit;
    if (pool > 0) m.poolWeight = pool;
  }
}

function normalizeItemClass(ic) {
  if (!ic) return null;
  const s = String(ic);
  // KB / essence tables use singular class keys (Belt, Wand, …); Boots stays plural.
  if (s === 'Body Armours') return 'Body Armour';
  if (s === 'Boots' || s === 'Boot') return 'Boots';
  if (s === 'Gloves' || s === 'Glove') return 'Gloves';
  const map = {
    Wands: 'Wand',
    Belts: 'Belt',
    Rings: 'Ring',
    Amulets: 'Amulet',
    Quivers: 'Quiver',
    Claws: 'Claw',
    Daggers: 'Dagger',
    Sceptres: 'Sceptre',
    Bows: 'Bow',
    Staves: 'Staff',
    Shields: 'Shield',
    Helmets: 'Helmet',
  };
  if (map[s]) return map[s];
  return s;
}

/** Essences that guarantee a mod matching this target on this item class. */
function essencesForTarget(kb, itemClass, target) {
  const out = [];
  const ic = normalizeItemClass(itemClass);
  if (!ic) return out;

  for (const ess of kb.essences) {
    // Prefer Deafening (highest tier)
    if ((ess.level ?? 0) < 7 && !/Deafening/i.test(ess.name)) continue;
    const modId = ess.mods_by_item_class?.[ic];
    if (!modId) continue;
    const granted = kb.modById.get(modId);
    if (!granted?.text) continue;
    const sameId = target.match?.id && target.match.id === modId;
    const textHit =
      kb.patternMatch(granted.pattern || kb.textToPattern(granted.text), target.text) ||
      kb.patternMatch(kb.textToPattern(target.text), granted.text);
    if (!sameId && !textHit) continue;
    out.push({ ess, granted, modId });
  }
  // Prefer deafening / highest level
  out.sort((a, b) => (b.ess.level ?? 0) - (a.ess.level ?? 0));
  return out;
}

function enrichMod(kb, item, rawMod, baseTags, ilvl) {
  const text = rawMod.text ?? '';
  const hints = {
    crafted: !!rawMod.crafted,
    ofEssence: !!rawMod.ofEssence,
    veiled: !!rawMod.veiled,
    fractured: !!rawMod.fractured,
    name: rawMod.name || null,
  };
  let match = matchModInKnowledge(kb, text, item, hints);

  if (!hints.crafted && !hints.ofEssence && !hints.fractured) {
    const asUnveil = matchModInKnowledge(kb, text, item, { veiled: true });
    if (asUnveil.matched && asUnveil.source === 'unveiled') {
      if (
        !match.matched ||
        (match.weight ?? 0) <= 0 ||
        (match.source !== 'natural' && match.source !== 'flask' && match.source !== 'jewel')
      ) {
        match = asUnveil;
        hints.veiled = true;
      }
    }
  }

  const rawGen = rawMod.type ?? rawMod.gen ?? null;
  const matchGen = match.generation ?? null;
  const tags = match.tags ?? rawMod.tags ?? [];
  const groups = match.groups ?? [];
  // Crafted RePoE mods are often generation "unique" — prefer paste Prefix/Suffix header.
  let gen = hints.crafted
    ? rawGen === 'prefix' || rawGen === 'suffix'
      ? rawGen
      : matchGen === 'prefix' || matchGen === 'suffix'
        ? matchGen
        : inferCraftGeneration(kb, match) || rawGen || 'prefix'
    : matchGen ?? rawGen;
  const poolW = gen === 'prefix' || gen === 'suffix' ? generationPoolWeight(kb, baseTags, ilvl, gen) : 10000;

  const affixSource =
    match.source === 'natural' || match.source === 'flask' || match.source === 'jewel' || match.source === 'influence';
  // Prefer matched id; if paste is above KB max (e.g. 120% ES), clamp to highest natural tier
  let resolved =
    match.matched && affixSource
      ? match
      : hints.crafted
        ? null
        : resolveNaturalMod(
            kb,
            { text, gen, match, groups, reqLevel: match.required_level, tier: rawMod.tier },
            gen || 'prefix'
          );
  if (resolved?.id && rawMod.tier != null) {
    resolved = modForPoETier(kb, resolved, baseTags, ilvl, rawMod.tier) || resolved;
  }
  const useMod = resolved?.id ? resolved : match;
  let hitW = 0;
  if (!hints.crafted && (useMod?.id || useMod?.groups)) {
    const tw = weightTierAndAbove(
      kb,
      {
        generation: useMod.generation ?? gen,
        groups: useMod.groups ?? groups,
        required_level: useMod.required_level ?? 1,
        text: useMod.text ?? text,
      },
      baseTags,
      ilvl
    );
    if (tw.weight > 0) hitW = tw.weight;
  }
  if (hitW <= 0 && (match.weight ?? 0) > 0) hitW = match.weight;
  // Do not invent fake weights for unmatched / zero-spawn naturals.
  const poolShare = hitW / Math.max(poolW, 1);
  let harvests = allHarvestsFor({
    text,
    tags: useMod.tags ?? tags,
    groups: useMod.groups ?? groups,
    meta: { groups: useMod.groups ?? groups },
  });
  if (match.source === 'unveiled' || hints.veiled || hints.crafted) harvests = [];

  return {
    text,
    short: short(text),
    gen: hints.crafted ? gen : useMod.generation ?? gen,
    weight: hitW,
    hitWeight: hitW,
    poolWeight: poolW,
    tags: useMod.tags ?? tags,
    groups: useMod.groups ?? groups,
    tier: rawMod.tier ?? null,
    reqLevel: useMod.required_level ?? match.required_level ?? 1,
    fractured: hints.fractured,
    crafted: hints.crafted,
    ofEssence: hints.ofEssence,
    veiled: hints.veiled || match.source === 'unveiled',
    match: match.matched ? { ...match, ...useMod, matched: true } : { ...match, ...(useMod.id ? { ...useMod, matched: true, source: 'natural' } : {}) },
    harvests,
    poolShare,
    weightLine: formatWeight(hitW, poolW),
    _done: false,
  };
}

/**
 * List acquisition candidates for one mod. Each has expectedChaos.
 * `occupiedGroups` = groups already filled (fractured / prior steps).
 * `allMods` = full goal list (needed to pick Veiled Chaos vs Exalt).
 */
function candidatesFor(kb, itemClass, baseTags, ilvl, mod, occupiedGroups = [], allMods = null) {
  const list = [];
  const occupied = occupiedGroups;
  const prices = kb.prices;

  if (mod.fractured) {
    list.push({
      type: 'fractured',
      expectedChaos: 0,
      chance: 1,
      label: 'Buy fractured',
    });
    return list;
  }

  if (mod.crafted || mod.match?.source === 'crafted') {
    list.push({ type: 'bench', expectedChaos: 0, chance: 1, label: 'Crafting bench' });
    return list;
  }

  if (mod.veiled || mod.match?.source === 'unveiled') {
    const u = unveilExpected(kb, baseTags, ilvl, mod, occupied);
    const attempts = u.expected;
    const useChaos = preferVeiledChaos(allMods ?? [mod], mod);
    const bag = veiledOrbCost(attempts, useChaos);
    list.push({
      type: 'unveil',
      expectedChaos: costOf(bag, prices),
      chance: u.pRoll,
      cost: bag,
      attempts,
      hitWeight: u.hitWeight,
      poolWeight: u.poolWeight,
      weightLine: u.weightLine,
      label: useChaos ? 'Veiled Chaos unveil (3 rolls)' : 'Veiled Exalt unveil (3 rolls)',
      veiledChaos: useChaos,
    });
    return list;
  }

  // Influence mods: slam/exalt after influence exists — never essence/harvest fish.
  if (isInfluenceGoal(mod) || mod.match?.source === 'influence') {
    const exalt = exaltExpected(kb, baseTags, ilvl, mod, occupied);
    const bag = {
      exalt: exalt.expected,
      annul: Math.max(0, exalt.expected - 1),
      divine: Math.ceil(exalt.expected) * 2,
    };
    list.push({
      type: 'exalt',
      expectedChaos: costOf(bag, prices),
      chance: exalt.pRoll,
      cost: bag,
      attempts: exalt.expected,
      label: `Exalt (${exalt.weightSummary}) — post-influence`,
      detail: `~${exalt.expected} Exalts after influence. ${exalt.weightSummary} tier+higher.`,
      weightLine: exalt.weightSummary,
      hitWeight: exalt.hitWeight,
      poolWeight: exalt.poolWeight,
      gen: mod.gen,
      postInfluence: true,
    });
    return list;
  }

  // Essence guarantees for this item class (even if paste didn't say ofEssence)
  for (const { ess } of essencesForTarget(kb, itemClass, mod).slice(0, 3)) {
    const key = essencePriceKey(ess.name);
    const bag = { [key]: 1 };
    list.push({
      type: 'essence',
      essenceName: ess.name,
      essenceKey: key,
      expectedChaos: costOf(bag, prices),
      chance: 1,
      cost: bag,
      label: `${ess.name} (guarantees this mod)`,
      gen: mod.gen,
    });
  }

  // Harvest family fills — juice × amount; metacraft Divines separate
  for (const h of mod.harvests) {
    const odds = harvestGoalOdds(kb, baseTags, ilvl, mod, h, modMatchesHarvest, occupied);
    if (!(odds.hitWeight > 0) || !(odds.poolWeight > 0)) continue;
    const p = Math.min(0.95, Math.max(odds.pRoll, 1e-12));
    const attempts = Math.min(expectedAttempts(p), 200);
    const bag = harvestWithMetacraftCost(h, attempts);
    const wl = formatWeight(odds.hitWeight, odds.poolWeight);
    list.push({
      type: 'harvest',
      harvest: h,
      expectedChaos: costOf(bag, prices),
      chance: p,
      cost: bag,
      attempts,
      label: `${h.name} (${wl})`,
      weightLine: wl,
      hitWeight: odds.hitWeight,
      poolWeight: odds.poolWeight,
      gen: mod.gen,
    });
  }

  // Alt for common fillers (resists/attrs) even mid-weight — these are lock-side mods
  const isLockFiller =
    (/Resistance/i.test(mod.text) && !/Penetrate/i.test(mod.text)) ||
    /to (Strength|Dexterity|Intelligence)\b/i.test(mod.text);
  const canEssence = essencesForTarget(kb, itemClass, mod).length > 0;
  if (
    (isLockFiller && (mod.poolShare ?? 0) >= 0.012) ||
    ((mod.poolShare ?? 0) >= 0.04 && !mod.harvests.length && !canEssence)
  ) {
    const alt = altExpected(kb, baseTags, ilvl, mod, occupied);
    const attempts = Math.min(alt.expected, 1200);
    const bag = { transmute: 1, alteration: attempts };
    list.push({
      type: 'alt',
      expectedChaos: costOf(bag, prices),
      chance: alt.pRoll,
      cost: bag,
      attempts,
      label: `Alt spam (${alt.weightSummary})`,
      weightLine: alt.weightSummary,
      hitWeight: alt.hitWeight,
      poolWeight: alt.poolWeight,
      gen: mod.gen,
    });
  }

  // Exalt last resort — generation pool minus occupied groups
  const exalt = exaltExpected(kb, baseTags, ilvl, mod, occupied);
  const bag = {
    exalt: exalt.expected,
    annul: Math.max(0, exalt.expected - 1),
    divine: Math.ceil(exalt.expected) * 2,
  };
  list.push({
    type: 'exalt',
    expectedChaos: costOf(bag, prices),
    chance: exalt.pRoll,
    cost: bag,
    attempts: exalt.expected,
    label: `Exalt fallback (${exalt.weightSummary})`,
    detail: `~${exalt.expected} Exalts. ${exalt.weightSummary} tier+higher vs open ${mod.gen} pool.`,
    weightLine: exalt.weightSummary,
    hitWeight: exalt.hitWeight,
    poolWeight: exalt.poolWeight,
    gen: mod.gen,
  });

  const rank = { fractured: 0, bench: 1, essence: 2, unveil: 3, harvest: 4, alt: 5, exalt: 6 };
  list.sort((a, b) => {
    const ca = rankCost(a.expectedChaos);
    const cb = rankCost(b.expectedChaos);
    if (Math.abs(ca - cb) < 30) {
      return (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
    }
    return ca - cb;
  });
  return list;
}

function minIlvlFromMods(mods) {
  let min = 1;
  const drivers = [];
  for (const m of mods) {
    const req = m.reqLevel ?? 1;
    if (req > min) {
      min = req;
      drivers.length = 0;
      drivers.push({ text: m.short, req });
    } else if (req === min && req > 1) {
      drivers.push({ text: m.short, req });
    }
  }
  return { minIlvl: min, drivers };
}

function isBenchMod(m) {
  return !!(m?.crafted || m?.match?.source === 'crafted' || m?.best?.type === 'bench' || m?.method === 'bench');
}

/** Natural prefix/suffix goals that can be bought fractured (not craft/veil/essence/influence). */
function isFractureEligible(m, essenceTarget = null, opts = {}) {
  if (!m || m.fractured || m._done) return false;
  if (isBenchMod(m) || m.crafted || m.veiled) return false;
  if (m === essenceTarget || m.ofEssence) return false;
  if (m.match?.is_essence_only || m.match?.source === 'essence') return false;
  if (m.gen !== 'prefix' && m.gen !== 'suffix') return false;
  if (isInfluenceGoal(m) || m.match?.source === 'influence') return false;
  const src = m.match?.source;
  if (src && src !== 'natural') return false;
  return (m.hitWeight ?? m.weight ?? 0) > 0;
}

function fracturePRoll(m) {
  const hit = m.hitWeight ?? m.weight ?? 0;
  const pool = m.poolWeight ?? 0;
  if (hit > 0 && pool > 0) return hit / pool;
  if (typeof m.poolShare === 'number' && m.poolShare > 0) return m.poolShare;
  if (typeof m.pRoll === 'number' && m.pRoll > 0) return m.pRoll;
  return Infinity;
}

/** Prefer rarest fracture lock: lowest hitWeight → lower pRoll → hybrids / lower pool share → harder heuristics. */
function fractureSortKey(a, b) {
  const wa = a.hitWeight ?? a.weight ?? Infinity;
  const wb = b.hitWeight ?? b.weight ?? Infinity;
  if (wa !== wb) return wa - wb;
  const pa = fracturePRoll(a);
  const pb = fracturePRoll(b);
  if (pa !== pb) return pa - pb;
  // Hybrids (multi-stat) are harder / more specific — prefer more '|' segments
  const ha = (a.short.match(/\|/g) || []).length;
  const hb = (b.short.match(/\|/g) || []).length;
  if (ha !== hb) return hb - ha;
  const sa = a.poolShare ?? pa;
  const sb = b.poolShare ?? pb;
  if (sa !== sb) return sa - sb;
  // Harder: higher required level / better (lower) PoE tier number
  const ra = a.reqLevel ?? a.match?.required_level ?? 0;
  const rb = b.reqLevel ?? b.match?.required_level ?? 0;
  if (ra !== rb) return rb - ra;
  const ta = a.tier ?? 99;
  const tb = b.tier ?? 99;
  if (ta !== tb) return ta - tb;
  // Longer label usually means more specific hybrid text
  if (a.short.length !== b.short.length) return b.short.length - a.short.length;
  return a.short.localeCompare(b.short);
}

/** Rarest fracture target (lowest hitWeight; ties → lower pRoll / hybrids / harder).
 *  With preferSlamGen (influence exalt path): prefer naturals on the slam side first. */
function pickLeastWeightFractureMod(mods, essenceTarget = null, opts = {}) {
  const eligible = (mods ?? []).filter((m) => isFractureEligible(m, essenceTarget, opts));
  if (!eligible.length) return null;
  if (opts.preferSlamGen) {
    const onSlam = eligible.filter((m) => m.gen === opts.preferSlamGen);
    if (onSlam.length) {
      onSlam.sort(fractureSortKey);
      return onSlam[0];
    }
  }
  eligible.sort(fractureSortKey);
  return eligible[0];
}

function isInfluenceGoal(m) {
  return m?.match?.source === 'influence';
}

function influenceNameForMod(m) {
  const list = m?.match?.influences ?? m?.match?.influence ?? [];
  for (const inf of Array.isArray(list) ? list : [list]) {
    const n = normalizeInfluence(inf);
    if (n) return n;
  }
  return null;
}

/** Ensure baseTags include influence spawn tags for slam odds. */
function withInfluenceTags(baseTags, influence) {
  const key = INFLUENCE_TAG_KEY[String(influence ?? '').toLowerCase()];
  if (!key) return baseTags;
  if ((baseTags ?? []).includes(key)) return baseTags;
  const out = [...(baseTags ?? []), key];
  for (const t of baseTags ?? []) {
    if (t === 'default' || t.startsWith('trade_') || t.startsWith('__')) continue;
    if (t.includes('_')) continue;
    const tagged = `${t}_${key}`;
    if (!out.includes(tagged)) out.push(tagged);
  }
  return out;
}

/**
 * Lowest-weight influence goal → mid-craft influence exalt slam target.
 * Score = hit/influence-pool (harder first).
 */
function pickInfluenceSlamTarget(mods, kb, baseTags, ilvl) {
  const goals = (mods ?? []).filter(
    (m) =>
      isInfluenceGoal(m) &&
      !m.fractured &&
      !m._done &&
      (m.gen === 'prefix' || m.gen === 'suffix') &&
      influenceNameForMod(m)
  );
  if (!goals.length) return null;
  let best = null;
  for (const m of goals) {
    const influence = influenceNameForMod(m);
    const tags = withInfluenceTags(baseTags, influence);
    const math = influenceSlamExpected(kb, tags, ilvl, m, influence, []);
    if (!(math.hitWeight > 0)) continue;
    if (
      !best ||
      math.pRoll < best.math.pRoll - 1e-12 ||
      (Math.abs(math.pRoll - best.math.pRoll) < 1e-12 && math.hitWeight < best.math.hitWeight)
    ) {
      best = { mod: m, influence, math, tags };
    }
  }
  return best;
}

function pushInfluenceSlamPipeline(steps, costs, slam) {
  const { mod, influence, math } = slam;
  const orb = INFLUENCE_EXALTS[influence];
  const gen = mod.gen;
  const fillSide = gen === 'suffix' ? 'prefix' : 'suffix';
  const fillLabel = fillSide === 'prefix' ? 'prefixes' : 'suffixes';
  const slamLabel = gen === 'prefix' ? 'prefixes' : 'suffixes';
  const slamOne = gen;
  const meta = gen === 'suffix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
  const attempts = Math.max(1, math.expected);
  const prepCost = { alchemy: 1, regal: 1 };
  const slamCost = { [orb.key]: attempts, annul: Math.max(0, attempts - 1) };
  const cleanCost = { ...meta.cost, scour: 1 };
  mergeCost(costs, prepCost);
  mergeCost(costs, slamCost);
  mergeCost(costs, cleanCost);

  steps.push(
    step(
      'influencePrep',
      'regal',
      `Fill ${fillLabel} (Regal + multimod/bench fillers) — leave ${slamLabel} open for ${orb.name}`,
      `Rare with ${fillLabel} filled (bench fillers / multimod). Slam side keeps only fracture/alt keepers + open slots for ${orb.name}. Do not essence after this slam — essence remakes the rare and wipes influence.`,
      [mod.short],
      prepCost,
      { chance: 1, chanceLabel: '100%' }
    )
  );
  steps.push(
    step(
      'influenceSlam',
      orb.key,
      `${orb.name} ×~${attempts} for ${mod.short}`,
      `Slam ${orb.name} into an open ${slamOne} slot. Influence pool (${influence} ${slamLabel} only): ${math.weightSummary} → ~${pct(math.pRoll)}/hit (~${attempts} expected). On miss: annul the junk ${slamOne} and re-slam.`,
      [mod.short],
      slamCost,
      {
        chance: math.pRoll,
        chanceLabel: `~${attempts} · ${pct(math.pRoll)}/hit · ${math.weightSummary}`,
        weightLine: math.weightSummary,
        influence: [influence],
      }
    )
  );
  steps.push(
    step(
      'influenceClean',
      'divine',
      `${meta.name} → clean ${fillSide} fillers`,
      `Lock the ${influence} ${slamOne}, then remove crafted / filler ${fillLabel} (bench remove or scour). Finish remaining goals with exalt/harvest under the lock — never essence (wipes influence).`,
      [mod.short],
      cleanCost,
      { chance: 1, chanceLabel: '100%', influence: [influence] }
    )
  );

  mod._done = true;
  mod.method = 'influenceSlam';
  mod.chance = math.pRoll;
  mod.weightLine = math.weightSummary;
  mod.note = `${orb.name} slam (${math.weightSummary}).`;
}

/** Metacraft divine cost from KB (Divine Orb → divine key). */
function metacraftCostBag(kb, metacraftId) {
  const meta = (kb.metacrafts ?? []).find((c) => c.id === metacraftId);
  if (!meta?.cost) return { divine: 1 };
  const out = {};
  for (const [k, v] of Object.entries(meta.cost)) {
    if (/divine/i.test(k)) out.divine = (out.divine ?? 0) + v;
    else if (/exalted/i.test(k)) out.exalt = (out.exalt ?? 0) + v;
  }
  return Object.keys(out).length ? out : { divine: 1 };
}

/** Open-slot exalt (add + annul misses) — no per-hit SCBC/PCBC Divines. */
function exaltOpenSlotBag(exalt) {
  return {
    exalt: exalt.expected,
    annul: Math.max(0, exalt.expected - 1),
  };
}

/** Exalt while locking the other side each attempt (2 Divines × expected). */
function exaltMetacraftBag(exalt) {
  return {
    exalt: exalt.expected,
    annul: Math.max(0, exalt.expected - 1),
    divine: Math.ceil(exalt.expected) * 2,
  };
}

/** EV to exalt every goal in order with shrinking occupied groups. */
function multiExaltBagEv(kb, tags, ilvl, goals, prices, { openSlot = true, occupied = [] } = {}) {
  let occ = [...occupied];
  let total = 0;
  const bags = [];
  for (const m of goals) {
    const exalt = exaltExpected(kb, tags, ilvl, m, occ);
    const bag = openSlot ? exaltOpenSlotBag(exalt) : exaltMetacraftBag(exalt);
    bags.push({ m, exalt, bag });
    total += costOf(bag, prices);
    occ = [...occ, ...(m.groups ?? [])];
  }
  return { total, bags };
}

/**
 * Before harvest fills: if cannot-roll shrinks the pool and blocked open-slot exalt
 * beats harvest (and plain exalt) for every remaining goal on that gen, commit assist
 * and mark goals so harvest is skipped.
 */
function applyCannotRollExaltAssist(kb, baseTags, ilvl, openMods, influence, steps, costs, prices, allMods) {
  const byGen = { prefix: [], suffix: [] };
  for (const m of openMods) {
    if (!m.gen || isBenchMod(m) || m._done) continue;
    if (byGen[m.gen]) byGen[m.gen].push(m);
  }
  const tagsBase = influence ? withInfluenceTags(baseTags, influence) : baseTags;
  const modList = allMods ?? openMods;
  for (const gen of ['prefix', 'suffix']) {
    const goals = byGen[gen];
    if (goals.length < 1) continue;
    const occ = occupiedGroupsNow(modList, gen);
    const assist = bestCannotRollAssist(kb, tagsBase, ilvl, gen, goals, {
      minFraction: 0.25,
      occupiedGroups: occ,
    });

    const plain = multiExaltBagEv(kb, tagsBase, ilvl, goals, prices, {
      openSlot: !!influence,
      occupied: occ,
    });

    let harvestEv = Infinity;
    const harvestable = goals.filter((m) => m.harvests?.length && !isInfluenceGoal(m));
    if (harvestable.length) {
      const shared = bestSharedHarvest(harvestable);
      if (shared) {
        const covered = shared.covered.filter((m) => goals.includes(m));
        let attempts = 0;
        for (const m of covered) {
          const o = harvestGoalOdds(kb, tagsBase, ilvl, m, shared.harvest, modMatchesHarvest, occ);
          attempts += expectedAttempts(Math.min(0.95, Math.max(o.pRoll, 1e-12)));
        }
        attempts = Math.max(1, Math.min(attempts, 200));
        harvestEv = costOf(harvestWithMetacraftCost(shared.harvest, attempts), prices);
        const rest = goals.filter((m) => !covered.includes(m));
        if (rest.length) {
          harvestEv += multiExaltBagEv(kb, tagsBase, ilvl, rest, prices, {
            openSlot:
              !!influence || rest.some((m) => m._openSlotExalt || m._finishAfterReroll),
            occupied: [...occ, ...covered.flatMap((m) => m.groups ?? [])],
          }).total;
        }
      }
    }

    let blockedEv = Infinity;
    let blocked = null;
    if (assist) {
      const metaBag = metacraftCostBag(kb, assist.metacraftId);
      blocked = multiExaltBagEv(kb, assist.tags, ilvl, goals, prices, {
        openSlot: true,
        occupied: occ,
      });
      blockedEv = costOf(metaBag, prices) + blocked.total;
    }

    const best = Math.min(blockedEv, harvestEv, plain.total);
    // Prefer cannot-roll + exalt when it wins (or ties harvest within noise).
    if (!(assist && blocked && Number.isFinite(blockedEv) && blockedEv <= best + 1)) continue;

    const bag = metacraftCostBag(kb, assist.metacraftId);
    mergeCost(costs, bag);
    const removedPct = ((assist.fraction || 0) * 100).toFixed(0);
    steps.push(
      step(
        'cannotRollAssist',
        'divine',
        `Bench ${assist.name} (−${removedPct}% ${gen} pool) → exalt remaining`,
        `${assist.name} blocks [${assist.blockedTags.join(', ')}] while every remaining ${gen} goal still has weight. Pool ${assist.poolBefore} → ${assist.poolAfter}. Open-slot exalt EV ~${Math.round(blockedEv)}c beats harvest/plain for: ${goals.map((m) => m.short).join('; ')}.`,
        goals.map((m) => m.short),
        bag,
        {
          chance: 1,
          chanceLabel: `−${removedPct}% pool`,
          weightLine: `pool ${assist.poolBefore} → ${assist.poolAfter}`,
          cannotRoll: assist.id,
          blockedTags: assist.blockedTags,
        }
      )
    );
    for (const m of goals) {
      m._exaltTags = assist.tags;
      m._cannotRollAssist = assist.id;
      m._openSlotExalt = true;
      m._skipHarvest = true;
    }
  }
}

/**
 * When preferFracture is off (or keeper not locked): alt the slam-side natural
 * keeper before influencePrep so it is not harvested after the exalt slam.
 */
function pushSlamSideKeeperAlt(
  steps,
  costs,
  kb,
  baseTags,
  ilvl,
  mods,
  influenceSlam,
  preferFracture,
  preferFractureEnabled
) {
  if (!influenceSlam) return;
  const slamGen = influenceSlam.mod.gen;
  const keeper =
    preferFracture?.mod?.gen === slamGen
      ? preferFracture.mod
      : pickLeastWeightFractureMod(
          mods.filter((m) => m.gen === slamGen),
          null,
          { preferSlamGen: slamGen }
        );
  if (!keeper || keeper._done || keeper.fractured) return;
  if (preferFractureEnabled && preferFracture?.mod === keeper) return;

  const occupied = occupiedGroupsNow(mods);
  const alt = altExpected(kb, baseTags, ilvl, keeper, occupied);
  const attempts = Math.min(Math.max(alt.expected, 1), 1200);
  const bag = { transmute: 1, alteration: attempts };
  mergeCost(costs, bag);
  steps.push(
    step(
      'altSpam',
      'alteration',
      `Alt for ${keeper.short} (slam-side keeper before influence)`,
      `Land ${keeper.short} on magic before filling the opposite side and slamming ${influenceSlam.influence}. ${alt.weightSummary} → ~${attempts} alts. Do not harvest this after influence.`,
      [keeper.short],
      bag,
      {
        chance: alt.pRoll,
        chanceLabel: `~${attempts} alts · ${alt.weightSummary}`,
        weightLine: alt.weightSummary,
      }
    )
  );
  keeper._done = true;
  keeper.method = 'natural';
  keeper.chance = alt.pRoll;
  keeper.weightLine = alt.weightSummary;
  keeper.hitWeight = alt.hitWeight;
  keeper.poolWeight = alt.poolWeight;
  keeper.note = 'Alt before influence slam (slam-side keeper).';
}

function preferFractureWeightLine(fm) {
  return fm.weightLine || formatWeight(fm.hitWeight ?? fm.weight, fm.poolWeight);
}

/**
 * Pick a consistent plan: ≤1 essence, harvest groups, unveil, bench, alt leftovers.
 */
function affixGen(m) {
  const g = m?.gen;
  return g === 'prefix' || g === 'suffix' ? g : null;
}

function isFillerSideMod(m) {
  if (!m || m.fractured || m.ofEssence || m.method === 'essence' || m.veiled) return false;
  if (m.method === 'unfittable') return false;
  return (
    (/Resistance/i.test(m.text) && !/Penetrate/i.test(m.text)) ||
    /to (Strength|Dexterity|Intelligence)\b/i.test(m.text) ||
    /maximum Mana/i.test(m.text) ||
    m.fallback === true
  );
}

/** Rare max 3/3 — leave open slots for final bench crafts on that generation. */
function canUseEldritchAnnul(item, itemClass, steps) {
  const ic = normalizeItemClass(itemClass);
  if (['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(ic)) return true;
  const eld = item?.eldritch || item?.implicits || [];
  const blob = [...(Array.isArray(eld) ? eld : []), ...(item?.implicits ?? [])]
    .map((x) => (typeof x === 'string' ? x : x?.text ?? ''))
    .join(' ');
  if (/Eater of Worlds|Searing Exarch|eldritch/i.test(blob)) return true;
  if ((item?.influenced ?? []).some((x) => /eater|exarch|eldritch/i.test(String(x)))) return true;
  return (steps ?? []).some((s) => String(s.operator ?? '').startsWith('eldritch'));
}

/**
 * When final bench craft has no free prefix/suffix slot, insert Eldritch Annul or
 * metacraft+annul before the craft (with hit odds on fillers vs keepers).
 */
function buildAnnulForBenchSpace(item, mods, benchMods, steps, costs, itemClass) {
  const out = [];
  const seen = new Set();

  /** Essence fish often packs junk fillers on that side; Eldritch Chaos for 1 target usually leaves open slots. */
  const sidePackedByEssence = (gen) =>
    (steps ?? []).some((s) => {
      if (s.operator !== 'essenceFish') return false;
      return (s.targetMods ?? []).some((t) => {
        const mod = mods.find((m) => m.short === t || m.text === t);
        return affixGen(mod) === gen;
      });
    });

  for (const craft of benchMods) {
    const gen = affixGen(craft);
    if (!gen || seen.has(gen)) continue;
    const craftsOnSide = benchMods.filter((m) => affixGen(m) === gen);
    const keepers = mods.filter((m) => affixGen(m) === gen && !isBenchMod(m) && m.method !== 'unfittable');
    const open = Math.max(0, 3 - keepers.length);
    const needsSlot = open < craftsOnSide.length;
    // Only assume a junk filler occupies the craft slot after essence packing — not after Eldritch.
    const tightExact =
      !needsSlot &&
      keepers.length >= 2 &&
      keepers.length + craftsOnSide.length >= 3 &&
      sidePackedByEssence(gen);
    if (!needsSlot && !tightExact) continue;
    seen.add(gen);

    const needFree = Math.max(needsSlot ? craftsOnSide.length - open : 1, 1);
    const removable = keepers.filter((m) => !m.fractured);
    let n;
    let pFiller;
    let pValuable;
    let remList;
    if (needsSlot) {
      // Side already has 3 listed keepers — must annul one of them
      n = Math.max(removable.length, 1);
      const preferred = removable.filter(isFillerSideMod);
      pFiller = preferred.length / n;
      pValuable = (n - preferred.length) / n;
      remList = removable.map((m) => m.short).join('; ') || '(none)';
    } else {
      // Exact 2 keepers + craft after essence/eldritch — expect 1 RNG junk occupying the craft slot
      n = removable.length + 1;
      pFiller = 1 / n;
      pValuable = removable.length / n;
      remList =
        (removable.map((m) => m.short).join('; ') || '(keepers)') + '; (RNG filler on this side)';
    }
    const pAnyOpen = Math.max(pFiller, 1 / n);
    const attempts = Math.min(Math.max(expectedAttempts(pAnyOpen), 1), 20);
    const craftLabel = craftsOnSide.map((m) => m.short).join('; ');

    if (canUseEldritchAnnul(item, itemClass, steps)) {
      const dominance = gen === 'suffix' ? 'Eater' : 'Exarch';
      const emberKey = gen === 'suffix' ? 'eldritch-ichor' : 'eldritch-ember';
      const other = gen === 'suffix' ? 'prefixes' : 'suffixes';
      const bag = { [emberKey]: 1, 'eldritch-annul': attempts };
      mergeCost(costs, bag);
      out.push(
        step(
          'eldritchAnnul',
          'eldritch-annul',
          `${dominance} dominant → Eldritch Annul ×~${attempts} (free ${gen} for bench)`,
          `Need ${needFree} open ${gen} slot(s) for: ${craftLabel}. ${dominance} dominance makes Eldritch Annul strip ${gen}s only (${other} protected). Removable ${gen}s: ${remList}. ≈${pct(pFiller)} hit a filler vs ≈${pct(pValuable)} hit a keeper (equal among ${n}). Then bench-craft.`,
          craftsOnSide.map((m) => m.short),
          bag,
          {
            chance: pAnyOpen,
            chanceLabel: `~${attempts} · filler ${pct(pFiller)} / keeper ${pct(pValuable)}`,
            weightLine: `annul among ${n} ${gen}s (uniform)`,
          }
        )
      );
    } else {
      const meta = gen === 'prefix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
      const bag = { ...meta.cost, annul: attempts };
      mergeCost(costs, bag);
      out.push(
        step(
          'annulForSpace',
          'annul',
          `${meta.name} → Annul ×~${attempts} (free ${gen} for bench)`,
          `Need ${needFree} open ${gen} slot(s) for: ${craftLabel}. Lock the other side, then annul until an unwanted ${gen} is removed. Removable: ${remList}. ≈${pct(pFiller)} hit filler vs ≈${pct(pValuable)} hit keeper (1/${n} each). Then Crafting Bench.`,
          craftsOnSide.map((m) => m.short),
          bag,
          {
            chance: pAnyOpen,
            chanceLabel: `~${attempts} · filler ${pct(pFiller)} / keeper ${pct(pValuable)}`,
            weightLine: `annul among ${n} ${gen}s (uniform)`,
          }
        )
      );
    }
  }
  return out;
}

function assignAndBuild(item, mods, kb, baseTags, minIlvl, drivers, itemClass, opts = {}) {
  const preferFractureEnabled = opts.preferFracture !== false;
  const prices = kb.prices;
  const costs = {};
  let steps = [];
  const tips = [];
  const alternatives = [];
  let preferFracture = null;

  for (const m of mods) {
    m.candidates = candidatesFor(kb, itemClass, baseTags, minIlvl, m, occupiedGroupsNow(mods), mods);
    m.best = m.candidates[0];
  }

  const fractured = mods.filter((m) => m.fractured);
  // Crafted/bench mods are reserved until the end so RNG steps keep a free slot.
  const benchMods = mods.filter(isBenchMod);
  const unveilMods = mods.filter((m) => m.veiled || m.best?.type === 'unveil');
  const open = () =>
    mods.filter((m) => !m._done && !m.fractured && !isBenchMod(m) && !unveilMods.includes(m));

  // 1. Base (+ influence: mid-craft slam for hard influence goals, else buy-vs-orb)
  const needInf = requiredInfluences(item, mods);
  const influenceSlam =
    needInf.length === 1 && !fractured.some((m) => isInfluenceGoal(m))
      ? pickInfluenceSlamTarget(mods, kb, baseTags, minIlvl)
      : null;
  // Prefer fracturing rarest natural on the slam side (keepers allowed; influence exalt needs open slots, not empty side).
  const fracOpts = influenceSlam ? { preferSlamGen: influenceSlam.mod.gen } : {};
  const infAcq = recommendInfluenceAcquisition(needInf, prices, {
    preferMidCraftSlam: !!influenceSlam,
  });
  const infStep = formatInfluenceBaseStep(item.baseName, minIlvl, infAcq, {
    fractured: fractured.length > 0,
    fracturedMods: fractured.map((m) => m.short),
  });
  if (infAcq && infStep?.cost) mergeCost(costs, infStep.cost);

  if (fractured.length) {
    for (const m of fractured) {
      m._done = true;
      m.method = 'fractured';
      m.chance = 1;
      m.weightLine = 'N/A (fractured)';
      m.note = 'Buy fractured.';
    }
    steps.push(
      step(
        'buyFractured',
        'quality',
        infStep?.action ??
          `Buy fractured ${item.baseName} (ilvl ${minIlvl}+) with: ${fractured.map((m) => m.short).join(', ')}`,
        [
          `Fractured anchors. ${drivers.map((d) => `${d.text} needs ilvl ${d.req}`).join('; ')}`,
          infStep?.detail,
        ]
          .filter(Boolean)
          .join(' '),
        fractured.map((m) => m.short),
        infStep?.cost ?? {},
        { chance: 1, chanceLabel: '100% (trade)', influence: infAcq?.influences }
      )
    );
  } else {
    steps.push(
      step(
        'buyBase',
        'quality',
        infStep?.action ?? `Acquire ${item.baseName} (ilvl ${minIlvl}+)`,
        infStep?.detail ?? `Min ilvl from knowledge-base required_level.`,
        drivers.map((d) => d.text),
        infStep?.cost ?? {},
        { chance: 1, chanceLabel: '100%', influence: influenceSlam ? [] : infAcq?.influences }
      )
    );
  }

  // Influence slam runs AFTER pre-influence essence/alt (essence remakes rares and wipes influence).
  // Pipeline is pushed later — see post-essence block.

  // 2. Choose at most ONE essence — the one that saves the most vs next-best non-essence option
  let chosenEssence = null;
  let essenceTarget = null;
  {
    const canEldritchArmour = ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(
      normalizeItemClass(itemClass)
    );
    const defenceEssAvailable =
      canEldritchArmour &&
      open().some((m) =>
        m.candidates.some(
          (c) =>
            c.type === 'essence' &&
            /Woe|Doubt|Dread|Loathing|Spite|Misery|Envy/i.test(c.essenceName ?? '')
        )
      );
    let bestSave = 0;
    for (const m of open()) {
      if (isInfluenceGoal(m)) continue; // influence = slam/exalt after influence exists
      if (influenceSlam) {
        const slamGen = influenceSlam.mod.gen;
        const fillGen = slamGen === 'suffix' ? 'prefix' : 'suffix';
        // Clean scours the fill side — don't essence keepers there before slam.
        if (m.gen === fillGen) continue;
        // Slam-side naturals are fracture/alt keepers, not essence lead
        if (m.gen === slamGen && isFractureEligible(m, null, fracOpts)) continue;
      }
      const ess = m.candidates.find((c) => c.type === 'essence');
      if (!ess) continue;
      // Don't burn the single essence slot on a resist/attribute filler
      const isFiller =
        (/Resistance/i.test(m.text) && !/Penetrate/i.test(m.text) && !m.ofEssence) ||
        (/to (Strength|Dexterity|Intelligence)\b/i.test(m.text) && !m.ofEssence);
      if (isFiller) continue;
      // Armour with Woe/Doubt/Dread available: never burn the slot on Greed — fish life instead
      if (defenceEssAvailable && /Greed/i.test(ess.essenceName ?? '')) continue;

      const alt =
        m.candidates.find((c) => c.type === 'harvest' || c.type === 'exalt' || c.type === 'unveil') ??
        m.candidates.find((c) => c.type !== 'essence') ?? { expectedChaos: 99999 };
      let save = alt.expectedChaos - ess.expectedChaos;
      // Prefer essence on harvestable hard mods (MS, ES, crit, etc.)
      if (m.harvests.length) save += 2000;
      // Prefer defence guarantees (enables fish-all) over other harvest families
      if (canEldritchArmour && m.harvests.some((h) => h.id === 'reforge-defence')) save += 800;
      if (save > bestSave && save > 20) {
        bestSave = save;
        chosenEssence = ess;
        essenceTarget = m;
      }
    }
    // Also: if paste marked ofEssence, force that essence
    const forced = open().find((m) => m.ofEssence);
    if (forced) {
      const ess = forced.candidates.find((c) => c.type === 'essence') || {
        type: 'essence',
        essenceName: forced.candidates.find((c) => c.essenceName)?.essenceName || 'Deafening Essence',
        essenceKey: 'essence-deafening',
        expectedChaos: 8,
        chance: 1,
        cost: { 'essence-deafening': 1 },
      };
      if (!ess.essenceName && /attack speed|movement speed/i.test(forced.text)) {
        ess.essenceName = 'Deafening Essence of Zeal';
        ess.essenceKey = essencePriceKey(ess.essenceName);
      }
      chosenEssence = { ...ess, essenceName: ess.essenceName || 'Deafening Essence of Zeal' };
      if (!chosenEssence.essenceKey) chosenEssence.essenceKey = essencePriceKey(chosenEssence.essenceName);
      essenceTarget = forced;
    }
  }

  if (chosenEssence && essenceTarget) {
    const others = open().filter((m) => m !== essenceTarget);
    const sameSideHarv = others.filter((m) => m.gen === essenceTarget.gen && m.harvests.length);
    const fishShared = bestSharedHarvest(sameSideHarv);
    let fishSet = fishShared?.covered?.length ? [...fishShared.covered] : [...sameSideHarv];
    const canEldritch = ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(
      normalizeItemClass(itemClass)
    );
    // Defence essence on armour: also fish same-side life (and other harvest prefixes)
    if (
      canEldritch &&
      fishShared?.harvest?.id === 'reforge-defence'
    ) {
      for (const m of others) {
        if (m.gen === essenceTarget.gen && m.harvests.length && !fishSet.includes(m)) {
          fishSet.push(m);
        }
      }
    }
    // Same-side attr/resist fillers: fold into essence fish (item becomes rare — no late alts).
    // Opposite-side fillers: also fish during essence on non-armour (Eldritch covers armour).
    if (!canEldritch) {
      for (const m of others) {
        if (
          m.gen === essenceTarget.gen &&
          !fishSet.includes(m) &&
          m.candidates.some((c) => c.type === 'alt')
        ) {
          fishSet.push(m);
        }
      }
    }
    let fishAlts = canEldritch
      ? []
      : others.filter(
          (m) => m.gen !== essenceTarget.gen && m.candidates.some((c) => c.type === 'alt')
        );

    // Defence on armour: fish ALL targets during essence (weight math). Crit weapons: fish one + harvest.
    const fishAllFamily =
      fishSet.length >= 1 && fishShared && fishShared.harvest.id === 'reforge-defence';

    // Never fish mods with no spawn weight on this base (influence mismatch, etc.).
    // Never fish influence goals during essence — they need an influenced item.
    // Never fish keepers on a side a later harvest/eldritch will wipe (finish those after).
    // Skip essence-fish goals: they are not harvested, so they must not imply a wipe.
    const wipeGens = sideRerollGensAhead(mods, {
      essenceTarget,
      chosenEssence,
      itemClass,
      skipMods: [...fishSet, ...fishAlts],
    });
    fishSet = fishSet.filter(
      (m) =>
        (m.hitWeight ?? m.weight ?? 0) > 0 &&
        !isInfluenceGoal(m) &&
        !wipeGens.has(m.gen)
    );
    fishAlts = fishAlts.filter(
      (m) =>
        (m.hitWeight ?? m.weight ?? 0) > 0 &&
        !isInfluenceGoal(m) &&
        !wipeGens.has(m.gen)
    );
    // Keepers deferred off a wiped side finish after the reforge (open-slot exalt / cannot-roll).
    for (const m of mods) {
      if (m._done || m.fractured || isBenchMod(m) || !wipeGens.has(m.gen)) continue;
      if (m.harvests?.length && !m._skipHarvest && !isInfluenceGoal(m)) continue;
      m._openSlotExalt = true;
      m._finishAfterReroll = true;
    }

    const EXTRA_ROLLS = 2; // guarantee uses 1 prefix slot; ~2 more natural prefixes on a rare
    let fishMath = null;
    let fishPoolGen = essenceTarget.gen || 'prefix';
    let fishP = 0.05;
    let attempts = 2;
    let fullFishAttempts = 0;
    let fullFishChaos = 0;
    // Essence guarantee + fractured/done occupy groups; fish goals stay eligible.
    // Implicits/enchants never occupy (handled inside collectOccupiedGroups).
    const fishOccupied = collectOccupiedGroups([
      ...mods.filter((m) => m.fractured || m._done),
      essenceTarget,
    ]);

    const fishGoalsAll = () => [...fishSet, ...fishAlts];
    const computeFishMath = (goals, occupied) => {
      if (!goals?.length) return { expected: 2, pAll: 1, goals: [], pool: 0, weightSummary: '' };
      const math = multiGenEssenceFishExpected(kb, baseTags, minIlvl, goals, EXTRA_ROLLS, occupied);
      if (!math) return { expected: 2, pAll: 1, goals: [], pool: 0, weightSummary: '' };
      // Drop zero-weight goals (occupied group / wrong gen / unmatched) and recompute.
      if ((math.goals ?? []).some((g) => !(g.hitWeight > 0))) {
        const keep = goals.filter((m) => {
          const g = math.goals.find(
            (x) => x.short === m.short || x.short === short(m.text) || x.short === m.text
          );
          return g && g.hitWeight > 0;
        });
        // Nothing left to fish → guarantee-only essence (not 5000 @ 0%).
        if (!keep.length) return { expected: 2, pAll: 1, goals: [], pool: math.pool, weightSummary: '' };
        return multiGenEssenceFishExpected(kb, baseTags, minIlvl, keep, EXTRA_ROLLS, occupied);
      }
      return math;
    };

    fishMath = computeFishMath(fishGoalsAll(), fishOccupied);
    if (fishMath) {
      fishPoolGen = fishSet[0]?.gen || fishAlts[0]?.gen || essenceTarget.gen || 'prefix';
      fishP = fishMath.pAll;
      attempts = Math.min(Math.max(fishMath.expected, 1), 5000);
    }

    const key = chosenEssence.essenceKey || essencePriceKey(chosenEssence.essenceName);
    const essUnit = prices?.[key] ?? 8;
    fullFishAttempts = attempts;
    fullFishChaos = attempts * essUnit;

    // Prefer fractured base locking the lowest-weight natural goal (not essence guarantee).
    if (!fractured.length) {
      let fracMod = pickLeastWeightFractureMod(mods, essenceTarget, fracOpts);
      // Armour + defence essence: keep fishable prefixes free — fracture a low-weight suffix instead
      // (Eldritch savings) when it's not much rarer than the prefix pick.
      if (canEldritch && fishSet.length && fracMod && fishSet.includes(fracMod)) {
        const suffixFrac = pickLeastWeightFractureMod(
          mods.filter((m) => m.gen === 'suffix'),
          essenceTarget,
          fracOpts
        );
        const pw = fracMod.hitWeight ?? fracMod.weight ?? Infinity;
        const sw = suffixFrac?.hitWeight ?? suffixFrac?.weight ?? Infinity;
        if (suffixFrac && sw <= pw * 1.5) fracMod = suffixFrac;
      }
      if (fracMod) {
        let saveEss = 0;
        let saveChaos = 0;
        let withFishSet = fishSet;
        let withFishAlts = fishAlts;
        let withFishMath = fishMath;
        let withFishP = fishP;
        let withAttempts = attempts;
        if (fishSet.includes(fracMod)) {
          withFishSet = fishSet.filter((m) => m !== fracMod);
        } else if (fishAlts.includes(fracMod)) {
          withFishAlts = fishAlts.filter((m) => m !== fracMod);
        }
        if (fishSet.includes(fracMod) || fishAlts.includes(fracMod)) {
          const fracOccupied = collectOccupiedGroups([
            ...mods.filter((m) => m.fractured || m._done),
            essenceTarget,
            fracMod,
          ]);
          const remaining = [...withFishSet, ...withFishAlts];
          // Also drop fish goals that share an exclusive group with the fracture lock.
          const fracGroups = new Set(fracMod.groups ?? []);
          const remainingOpen = remaining.filter(
            (m) => m === fracMod || !(m.groups ?? []).some((g) => fracGroups.has(g))
          );
          withFishSet = withFishSet.filter((m) => remainingOpen.includes(m));
          withFishAlts = withFishAlts.filter((m) => remainingOpen.includes(m));
          withFishMath = remainingOpen.length ? computeFishMath(remainingOpen, fracOccupied) : null;
          withFishP = remainingOpen.length ? withFishMath?.pAll ?? 1 : 1;
          withAttempts = remainingOpen.length
            ? Math.min(Math.max(withFishMath?.expected ?? 2, 1), 5000)
            : 2;
          saveEss = fullFishAttempts - withAttempts;
          saveChaos = saveEss * essUnit;
        }
        preferFracture = {
          mod: fracMod,
          saveEss,
          saveChaos,
          weightLine: preferFractureWeightLine(fracMod),
          fishAllFamily,
          essName: chosenEssence.essenceName,
        };

        // If fracture wasn't in the essence fish set, estimate Eldritch Chaos savings when useful.
        if (saveChaos <= 0 && canEldritch && (fracMod.gen === 'prefix' || fracMod.gen === 'suffix')) {
          const gen = fracMod.gen;
          const sideGoals = mods.filter(
            (m) =>
              m.gen === gen &&
              !m.fractured &&
              !isBenchMod(m) &&
              m !== essenceTarget &&
              ((/Resistance/i.test(m.text) && !/Penetrate/i.test(m.text)) ||
                /to (Strength|Dexterity|Intelligence)\b/i.test(m.text) ||
                m.candidates.some((c) => c.type === 'alt'))
          );
          if (sideGoals.includes(fracMod) && sideGoals.length >= 2) {
            const without = sideGoals.filter((m) => m !== fracMod);
            const occFull = collectOccupiedGroups([
              ...mods.filter((m) => m.fractured || m._done),
              essenceTarget,
            ]);
            const occFrac = collectOccupiedGroups([
              ...mods.filter((m) => m.fractured || m._done),
              essenceTarget,
              fracMod,
            ]);
            const mathFull = eldritchSideExpected(kb, baseTags, minIlvl, gen, sideGoals, undefined, occFull);
            const mathFrac = eldritchSideExpected(kb, baseTags, minIlvl, gen, without, undefined, occFrac);
            const unit = prices?.['eldritch-chaos'];
            const saveEc = Math.max(0, mathFull.expected - mathFrac.expected);
            const saveEcChaos = unit != null ? saveEc * unit : 0;
            if (unit != null && (saveEc >= 10 || saveEcChaos >= 150)) {
              preferFracture.saveEldritch = saveEc;
              preferFracture.saveChaos = saveEcChaos;
              preferFracture.eldritchFull = mathFull.expected;
              preferFracture.eldritchWith = mathFrac.expected;
              preferFracture.saveKind = 'eldritch';
            }
          }
        }

        if (preferFractureEnabled) {
          fishSet = withFishSet;
          fishAlts = withFishAlts;
          fishMath = withFishMath;
          fishP = withFishP;
          attempts = withAttempts;
        }
      }
    }

    const fishLabels = [...fishSet, ...fishAlts].map((m) => m.short);
    const needFish = fishLabels.length > 0;
    if (!needFish) attempts = 2;

    // Crit harvest siblings: only need ANY one before harvest. Mixed fish (fillers) → fish all.
    const harvestOnlyFish = fishSet.length >= 2 && fishSet.every((m) => m.harvests.length);
    if (!fishAllFamily && harvestOnlyFish && fishMath) {
      const easiest = [...fishMath.goals].sort((a, b) => (b.hitWeight ?? b.weight) - (a.hitWeight ?? a.weight))[0];
      fishP = easiest.pHave;
      attempts = Math.min(Math.max(Math.ceil(1 / Math.max(fishP, 1e-12)), 1), 500);
    }

    if (preferFracture) {
      const fm = preferFracture.mod;
      const wl = preferFracture.weightLine;
      const withAttempts =
        preferFracture.saveEss > 0 ? Math.max(1, fullFishAttempts - preferFracture.saveEss) : attempts;
      if (preferFractureEnabled) {
        fm._done = true;
        fm.method = 'fractured';
        fm.chance = 1;
        fm.weightLine = wl;
        fm.note = 'Prefer buy fractured (lowest natural weight).';
      }
      const buyIdx = steps.findIndex((s) => s.operator === 'buyBase');
      const infOnFracture = infAcq
        ? formatInfluenceBaseStep(item.baseName, minIlvl, infAcq, {
            fractured: true,
            fracturedMods: [fm.short],
          })
        : null;
      const saveLines =
        preferFracture.saveEss > 0
          ? [
              `Without fracture: ~${fullFishAttempts} ess (~${fullFishChaos != null ? Math.round(fullFishChaos) : '?'}c) fishing the same goals.`,
              `With fracture: ~${withAttempts} ess (~${essUnit != null ? Math.round(withAttempts * essUnit) : '?'}c) — saves ~${preferFracture.saveEss} ess (~${Math.round(preferFracture.saveChaos)}c EV).`,
              'Fractured base premium is not priced here; EV is craft-currency delta only.',
            ]
          : preferFracture.saveKind === 'eldritch' && preferFracture.saveChaos > 0
            ? [
                `Without fracture: ~${preferFracture.eldritchFull} Eldritch Chaos for this side.`,
                `With fracture: ~${preferFracture.eldritchWith} Eldritch Chaos — saves ~${preferFracture.saveEldritch} (~${Math.round(preferFracture.saveChaos)}c EV).`,
                'Fractured base premium is not priced here; EV is craft-currency delta only.',
              ]
            : [];
      const fracAction = preferFractureEnabled
        ? (infOnFracture?.action ?? `Prefer fractured ${item.baseName} (ilvl ${minIlvl}+) with: ${fm.short}`)
        : (infStep?.action ?? `Acquire ${item.baseName} (ilvl ${minIlvl}+) — optional fracture: ${fm.short}`);
      const fracDetail = preferFractureEnabled
        ? [
            `Lowest natural spawn weight among goals: ${fm.short} (${wl} tier+higher).`,
            `Fracture locks ${fm.short} so craft skips rolling it.`,
            fishSet.length || fishAlts.length
              ? `${chosenEssence.essenceName.replace('Deafening Essence of ', '')} then still needs: ${[
                  ...fishSet,
                  ...fishAlts,
                ]
                  .map((m) => m.short)
                  .join(' + ') || 'essence guarantee only'}.`
              : `${chosenEssence.essenceName} guarantee covers ${essenceTarget.short}; fracture holds the rarest other natural.`,
            ...saveLines,
            infOnFracture?.detail,
          ]
            .filter(Boolean)
            .join(' ')
        : [
            `Prefer fracture is off — craft rolls ${fm.short} (${wl} tier+higher) instead of locking it.`,
            ...saveLines,
            infStep?.detail,
          ]
            .filter(Boolean)
            .join(' ');
      const fracStep = step(
        'preferFracture',
        'quality',
        fracAction,
        fracDetail,
        [fm.short],
        preferFractureEnabled ? (infOnFracture?.cost ?? {}) : (infStep?.cost ?? {}),
        {
          chance: 1,
          chanceLabel: 'fracture alt',
          fractureSave: preferFracture.saveChaos,
          weightLine: wl,
          influence: infAcq?.influences,
          preferEnabled: preferFractureEnabled,
        }
      );
      if (buyIdx >= 0) steps[buyIdx] = fracStep;
      else steps.unshift(fracStep);
    }

    mergeCost(costs, { [key]: attempts });

    const weightDetail = fishMath
      ? fishMath.goals
          .map((g) => `${g.short}: ${formatWeight(g.hitWeight ?? g.weight, g.poolWeight ?? g.pool)} tier+higher`)
          .join('; ')
      : '';
    const weightLine = fishMath ? `pool ${fishMath.pool} · ${weightDetail}` : '';

    steps.push(
      step(
        'essenceFish',
        key,
        `Spam ${chosenEssence.essenceName} until ${essenceTarget.short}${
          fishSet.length
            ? fishAllFamily || !harvestOnlyFish
              ? ` + ${[...fishSet, ...fishAlts].map((m) => m.short).join(' + ')}`
              : ` + any of: ${fishSet.map((m) => m.short).join(' OR ')}`
            : fishAlts.length
              ? ` + ${fishAlts.map((m) => m.short).join(' + ')}`
              : ''
        }`,
        [
          `${chosenEssence.essenceName} always grants ${essenceTarget.short}.`,
          preferFracture && preferFractureEnabled
            ? `${preferFracture.mod.short} is fractured — not fished.`
            : preferFracture && !preferFractureEnabled
              ? `Prefer fracture off — fishing includes ${preferFracture.mod.short}.`
              : '',
          fishMath
            ? `Fish goals use natural spawn weights on this base at ilvl ${minIlvl}+. Model: ~${EXTRA_ROLLS} extra rolls per affix side per essence.`
            : '',
          weightDetail,
          fishMath && needFish
            ? `P(all fish goals on one essence) ≈ ${(fishMath.pAll * 100).toFixed(3)}% → expected ~${attempts} Deafening essences.`
            : needFish
              ? `Expected ~${attempts} essences (${(fishP * 100).toFixed(2)}% per essence for the fish goal).`
              : `~${attempts} applications.`,
          canEldritch ? 'Then Eldritch Chaos (Eater dominant) for suffixes.' : '',
          attempts > 150 ? 'Exact-tier multi-prefix essence fish is expensive — fracture a hard prefix when possible.' : '',
        ]
          .filter(Boolean)
          .join(' '),
        [essenceTarget.short, ...fishLabels],
        { [key]: attempts },
        {
          chance: needFish ? fishP : 1,
          chanceLabel: needFish
            ? `~${attempts} ess · ${pct(fishP)}/hit · ${weightDetail || weightLine}`
            : '100% guarantee',
          weightLine,
          weightMath: fishMath,
        }
      )
    );

    essenceTarget._done = true;
    essenceTarget.method = 'essence';
    essenceTarget.chance = 1;
    essenceTarget.note = `${chosenEssence.essenceName} on ${itemClass}.`;
    essenceTarget.essenceName = chosenEssence.essenceName;

    if (fishAllFamily) {
      for (const m of fishSet) {
        m._done = true;
        const g = fishMath?.goals?.find((x) => x.short === m.short);
        assignEssenceFishNatural(
          m,
          g?.pRoll ?? fishP,
          fishMath
            ? `Natural weight tier+: see essence step (${m.short}).`
            : `Fished during ${chosenEssence.essenceName}.`,
          g ? formatWeight(g.hitWeight, g.poolWeight) : null
        );
      }
    } else if (harvestOnlyFish) {
      const caught = [...fishSet].sort((a, b) => (b.weight || 0) - (a.weight || 0))[0];
      caught._done = true;
      caught._fished = true;
      const g = fishMath?.goals?.find((x) => x.short === caught.short);
      assignEssenceFishNatural(
        caught,
        fishP,
        `Fished during essence; sibling via harvest.`,
        g ? formatWeight(g.hitWeight, g.poolWeight) : fishMath ? `pool ${fishMath.pool}` : null
      );
    } else {
      for (const m of fishSet) {
        m._done = true;
        const g = fishMath?.goals?.find((x) => x.short === m.short);
        assignEssenceFishNatural(
          m,
          g?.pRoll ?? fishP,
          `Fished during ${chosenEssence.essenceName}.`,
          g ? formatWeight(g.hitWeight, g.poolWeight) : null
        );
      }
    }
    for (const m of fishAlts) {
      m._done = true;
      const g = fishMath?.goals?.find((x) => x.short === m.short);
      assignEssenceFishNatural(
        m,
        m.poolShare,
        `Fished during ${chosenEssence.essenceName}.`,
        g ? formatWeight(g.hitWeight, g.poolWeight) : null
      );
    }

    if (preferFracture) {
      const fm = preferFracture.mod;
      const hasEssSave = preferFracture.saveEss > 0;
      const hasEldSave = preferFracture.saveKind === 'eldritch' && preferFracture.saveChaos > 0;
      if (preferFractureEnabled) {
        alternatives.push({
          id: 'no-fracture-essence-fish',
          name: hasEssSave
            ? `No fracture → full ${chosenEssence.essenceName.replace('Deafening Essence of ', '')} fish`
            : hasEldSave
              ? `No fracture → full Eldritch ${fm.gen} fish`
              : `No fracture → normal ${item.baseName}`,
          description: hasEssSave
            ? `Fish without locking ${fm.short} (~${fullFishAttempts} ess). Fracture saves ~${preferFracture.saveEss} ess (~${Math.round(preferFracture.saveChaos)}c).`
            : hasEldSave
              ? `Eldritch Chaos without locking ${fm.short} (~${preferFracture.eldritchFull}). Fracture saves ~${preferFracture.saveEldritch} (~${Math.round(preferFracture.saveChaos)}c).`
              : `Craft on a non-fractured base; roll ${fm.short} instead of locking it (${preferFracture.weightLine}).`,
          totalCost: null,
          _extraChaos: hasEssSave || hasEldSave ? preferFracture.saveChaos : 0,
          costs: hasEssSave
            ? { [key]: fullFishAttempts }
            : hasEldSave
              ? { 'eldritch-chaos': preferFracture.eldritchFull }
              : { ...costs },
        });
      } else if (hasEssSave || hasEldSave) {
        alternatives.push({
          id: 'with-fracture-essence-fish',
          name: hasEssSave
            ? `Prefer fracture → lock ${fm.short}`
            : `Prefer fracture → lock ${fm.short} (Eldritch)`,
          description: hasEssSave
            ? `Lock ${fm.short}; fish drops to ~${Math.max(1, fullFishAttempts - preferFracture.saveEss)} ess (saves ~${preferFracture.saveEss} / ~${Math.round(preferFracture.saveChaos)}c).`
            : `Lock ${fm.short}; Eldritch drops to ~${preferFracture.eldritchWith} (saves ~${preferFracture.saveEldritch} / ~${Math.round(preferFracture.saveChaos)}c).`,
          totalCost: null,
          _extraChaos: -(preferFracture.saveChaos || 0),
          costs: hasEssSave
            ? { [key]: Math.max(1, fullFishAttempts - preferFracture.saveEss) }
            : { 'eldritch-chaos': preferFracture.eldritchWith },
        });
      }
    }
  }

  // Non-essence plans: still propose lowest-weight fracture when nothing is fractured yet.
  if (!fractured.length && !preferFracture) {
    const fracMod = pickLeastWeightFractureMod(mods, null, fracOpts);
    if (fracMod) {
      const wl = preferFractureWeightLine(fracMod);
      preferFracture = { mod: fracMod, saveEss: 0, saveChaos: 0, weightLine: wl };
      if (preferFractureEnabled) {
        fracMod._done = true;
        fracMod.method = 'fractured';
        fracMod.chance = 1;
        fracMod.weightLine = wl;
        fracMod.note = 'Prefer buy fractured (lowest natural weight).';
      }
      const buyIdx = steps.findIndex((s) => s.operator === 'buyBase');
      const infOnFracture = infAcq
        ? formatInfluenceBaseStep(item.baseName, minIlvl, infAcq, {
            fractured: true,
            fracturedMods: [fracMod.short],
          })
        : null;
      const fracAction = preferFractureEnabled
        ? (infOnFracture?.action ?? `Prefer fractured ${item.baseName} (ilvl ${minIlvl}+) with: ${fracMod.short}`)
        : (infStep?.action ?? `Acquire ${item.baseName} (ilvl ${minIlvl}+) — optional fracture: ${fracMod.short}`);
      const fracDetail = preferFractureEnabled
        ? [
            `Lowest natural spawn weight among goals: ${fracMod.short} (${wl} tier+higher).`,
            `Fracture locks ${fracMod.short} so later steps skip rolling it.`,
            infOnFracture?.detail,
          ]
            .filter(Boolean)
            .join(' ')
        : [
            `Prefer fracture is off — craft rolls ${fracMod.short} (${wl} tier+higher) instead of locking it.`,
            infStep?.detail,
          ]
            .filter(Boolean)
            .join(' ');
      const fracStep = step(
        'preferFracture',
        'quality',
        fracAction,
        fracDetail,
        [fracMod.short],
        preferFractureEnabled ? (infOnFracture?.cost ?? {}) : (infStep?.cost ?? {}),
        {
          chance: 1,
          chanceLabel: 'fracture alt',
          weightLine: wl,
          influence: infAcq?.influences,
          preferEnabled: preferFractureEnabled,
        }
      );
      if (buyIdx >= 0) steps[buyIdx] = fracStep;
      else steps.unshift(fracStep);
      if (preferFractureEnabled) {
        alternatives.push({
          id: 'no-fracture-base',
          name: `No fracture → normal ${item.baseName}`,
          description: `Craft on a non-fractured base; roll ${fracMod.short} instead of locking it (${wl}).`,
          totalCost: null,
          _extraChaos: 0,
          costs: {},
        });
      } else {
        alternatives.push({
          id: 'with-fracture-base',
          name: `Prefer fracture → lock ${fracMod.short}`,
          description: `Buy fractured ${fracMod.short} (${wl}); later steps skip rolling it.`,
          totalCost: null,
          _extraChaos: 0,
          costs: {},
        });
      }
    }
  }

  // Mid-craft influence exalt AFTER any essence/fracture prep (essence remakes rares → wipes influence).
  if (influenceSlam) {
    pushSlamSideKeeperAlt(
      steps,
      costs,
      kb,
      baseTags,
      minIlvl,
      mods,
      influenceSlam,
      preferFracture,
      preferFractureEnabled
    );
    pushInfluenceSlamPipeline(steps, costs, influenceSlam);
  }

  // Alterations only work on magic — strip once essence/rare path is chosen
  const itemIsRare = !!(
    chosenEssence ||
    steps.some((s) =>
      ['essenceFish', 'harvestFill', 'eldritchChaos', 'alchemy', 'regal', 'influencePrep', 'influenceSlam'].includes(
        s.operator
      )
    )
  );
  if (itemIsRare || chosenEssence) {
    for (const m of mods) {
      if (!m.candidates?.length) continue;
      m.candidates = m.candidates.filter((c) => c.type !== 'alt');
      if (m.best?.type === 'alt') m.best = m.candidates[0] ?? null;
    }
  }

  // 3. Eldritch Chaos suffix (or prefix) finish — armour only, cheap vs metacraft
  {
    const canEldritch = ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(
      normalizeItemClass(itemClass)
    );
    const prefOff = !!(preferFracture && !preferFractureEnabled);
    // All open natural suffixes (resists, life regen, attrs, …) — not only alt-fillers
    const suffixLeft = open().filter((m) => m.gen === 'suffix');
    const prefixAnchor =
      !!(chosenEssence || fractured.length || mods.some((m) => m._done && m.gen === 'prefix')) ||
      (prefOff && preferFracture.mod.gen === 'prefix');

    if (
      canEldritch &&
      suffixLeft.length &&
      (prefixAnchor || (prefOff && preferFracture.mod.gen === 'suffix'))
    ) {
      const wiped = unprotectedDoneKeepersOnSide(mods, 'suffix', suffixLeft);
      if (wiped.length) {
        tips.push(
          `Skipped Eldritch Chaos suffixes — would wipe: ${wiped.map((m) => m.short).join('; ')}.`
        );
      } else {
        const occupied = occupiedGroupsNow(mods, 'suffix');
        const math = eldritchSideExpected(kb, baseTags, minIlvl, 'suffix', suffixLeft, undefined, occupied);
        const attempts = Math.max(math.expected, 1);
        mergeCost(costs, { 'eldritch-ichor': 1, 'eldritch-chaos': attempts });
        steps.push(
          step(
            'eldritchChaos',
            'eldritch-chaos',
            `Eater dominant → Eldritch Chaos ×~${attempts} for suffixes`,
            [
              'Apply Eldritch Ichor so Eater of Worlds is dominant (higher tier than Exarch).',
              'Eldritch Chaos Orb then rerolls SUFFIXES only — defence prefixes stay.',
              `Target: ${suffixLeft.map((m) => m.short).join('; ')}.`,
              `Suffix pool = ${math.pool}. CoE AND-columns (tier+higher): ${math.weightSummary}.`,
              `Model: ${math.rolls} sequential suffix draws without replacement. P(all) ≈ ${pct(math.pAll)} → ~${attempts} expected.`,
              'Source: craft-operators-official.json / PoE Wiki Eldritch Chaos Orb; weights = RePoE first-match tags.',
            ].join(' '),
            suffixLeft.map((m) => m.short),
            { 'eldritch-ichor': 1, 'eldritch-chaos': attempts },
            {
              chance: math.pAll,
              chanceLabel: `~${attempts} Eldritch Chaos · ${pct(math.pAll)}/hit · ${math.weightSummary}`,
              weightLine: `pool ${math.pool} · ${math.weightSummary}`,
              combo: 'eldritch-suffix-finish',
              rerollSide: 'suffix',
            }
          )
        );
        for (const m of suffixLeft) {
          m._done = true;
          m.method = 'natural';
          m.chance = math.goals.find((g) => g.short === m.short)?.pRoll ?? math.pAll;
          m.note = 'Eldritch Chaos (Eater dominant) suffix finish.';
        }
      }
    }

    const prefixLeftNow = open().filter(
      (m) => m.gen === 'prefix' && m.harvests.length === 0 && m.candidates.some((c) => c.type === 'alt')
    );
    const suffixDone = mods.some((m) => m._done && m.gen === 'suffix');
    // Prefix eldritch when suffixes anchored; skip if we already used prefix-anchor→suffix path
    // (those prefixes finish via harvest). Prefer-off + suffix fracture target does both sides.
    if (canEldritch && prefixLeftNow.length && suffixDone && !prefixAnchor) {
      const wiped = unprotectedDoneKeepersOnSide(mods, 'prefix', prefixLeftNow);
      if (wiped.length) {
        tips.push(
          `Skipped Eldritch Chaos prefixes — would wipe: ${wiped.map((m) => m.short).join('; ')}.`
        );
      } else {
        const occupied = occupiedGroupsNow(mods, 'prefix');
        const math = eldritchSideExpected(kb, baseTags, minIlvl, 'prefix', prefixLeftNow, undefined, occupied);
        const attempts = Math.max(math.expected, 1);
        mergeCost(costs, { 'eldritch-ember': 1, 'eldritch-chaos': attempts });
        steps.push(
          step(
            'eldritchChaos',
            'eldritch-chaos',
            `Exarch dominant → Eldritch Chaos ×~${attempts} for prefixes`,
            [
              'Ember dominant → Eldritch Chaos rerolls prefixes only; suffixes safe.',
              `Prefix pool = ${math.pool}. Weights: ${math.weightSummary}.`,
              `Model: ~${math.rolls} prefix rolls per Chaos. P(all) ≈ ${pct(math.pAll)} → ~${attempts} expected.`,
            ].join(' '),
            prefixLeftNow.map((m) => m.short),
            { 'eldritch-ember': 1, 'eldritch-chaos': attempts },
            {
              chance: math.pAll,
              chanceLabel: `~${attempts} Eldritch Chaos · ${pct(math.pAll)}/hit · ${math.weightSummary}`,
              weightLine: `pool ${math.pool} · ${math.weightSummary}`,
              rerollSide: 'prefix',
            }
          )
        );
        for (const m of prefixLeftNow) {
          m._done = true;
          m.method = 'natural';
          m.chance = math.goals.find((g) => g.short === m.short)?.pRoll ?? math.pAll;
          m.note = 'Eldritch Chaos (Exarch dominant) prefix finish.';
        }
      }
    }
  }

  // 4. Cannot-roll + exalt when cheaper than harvest (before harvest commits).
  if (influenceSlam || open().some((m) => m.candidates?.some((c) => c.type === 'exalt'))) {
    applyCannotRollExaltAssist(
      kb,
      influenceSlam ? withInfluenceTags(baseTags, influenceSlam.influence) : baseTags,
      minIlvl,
      open(),
      influenceSlam?.influence ?? null,
      steps,
      costs,
      prices,
      mods
    );
  }

  // 5. Harvest fills — ONLY when Eldritch/essence-fish-all cannot finish (e.g. weapons)
  for (const side of ['suffix', 'prefix']) {
    const sideMods = open().filter(
      (m) => m.gen === side && m.harvests.length && !isInfluenceGoal(m) && !m._skipHarvest
    );
    if (!sideMods.length) continue;
    const shared = bestSharedHarvest(sideMods);
    if (!shared) continue;
    const { harvest, covered } = shared;
    const remaining = covered.filter((m) => !m._done);
    if (!remaining.length) continue;

    // Never metacraft-hunt exact T1 defence/life after essence on armour — Eldritch is the cheap path
    if (
      (harvest.id === 'reforge-defence' || harvest.id === 'reforge-life') &&
      chosenEssence &&
      ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(normalizeItemClass(itemClass))
    ) {
      tips.push(
        `Skipped Prefixes Cannot Be Changed → ${harvest.name} for exact tiers — that is often 50–100+ Divines. Prefer essence fish-all / Eldritch Chaos or buy the item.`
      );
      for (const m of remaining) {
        m._done = true;
        assignEssenceFishNatural(
          m,
          m.poolShare,
          'Accept from essence fish / Eldritch / buy — exact harvest skipped.'
        );
      }
      continue;
    }

    const other = side === 'prefix' ? 'suffix' : 'prefix';
    const lockNats = open().filter(
      (m) => m.gen === other && !m.harvests.length && m.candidates.some((c) => c.type === 'alt')
    );
    if (lockNats.length && !chosenEssence) {
      const occupied = occupiedGroupsNow(mods);
      const altMaths = lockNats.map((m) => altExpected(kb, baseTags, minIlvl, m, occupied));
      const hardest = [...altMaths].sort((a, b) => a.pRoll - b.pRoll)[0];
      const attempts = Math.min(
        hardest.expected * Math.min(1 + lockNats.length, 5),
        1500
      );
      const weightLine = altMaths.map((a) => `${a.short}: ${a.weightSummary}`).join('; ');
      mergeCost(costs, { transmute: 1, alteration: attempts });
      steps.push(
        step(
          'altSpam',
          'alteration',
          `Alt for (${other}): ${lockNats.map((m) => m.short).join(' + ')}`,
          `Lock ${other}s before Harvest ${harvest.name}. ${weightLine}. ~${attempts} alts.`,
          lockNats.map((m) => m.short),
          { transmute: 1, alteration: attempts },
          {
            chance: hardest.pRoll,
            chanceLabel: `~${attempts} alts · ${hardest.weightSummary}`,
            weightLine,
          }
        )
      );
      for (const m of lockNats) {
        m._done = true;
        m.method = 'natural';
        m.chance = m.poolShare;
      }
    }

    // Same side as essence keepers → lock THAT side so harvest can fill an open slot (wand crits).
    // Opposite side → lock the essence side (protect finished prefixes/suffixes; reforge the harvest side).
    const { meta: metaFinal, rerollSide } = harvestMetacraftSides(remaining, essenceTarget);
    const wouldWipe = unprotectedDoneKeepersOnSide(mods, rerollSide, remaining);
    if (wouldWipe.length) {
      tips.push(
        `Skipped ${harvest.name} — would wipe unprotected ${rerollSide}s already obtained: ${wouldWipe
          .map((m) => m.short)
          .join('; ')}. Finish harvest goals without reforging that side (exalt / cannot-roll), or obtain those keepers after the reforge.`
      );
      continue;
    }

    const chances = remaining.map((m) => {
      const occupied = occupiedGroupsNow(mods);
      const o = harvestGoalOdds(kb, baseTags, minIlvl, m, harvest, modMatchesHarvest, occupied);
      return {
        m,
        p: Math.min(0.95, Math.max(o.pRoll, 1e-12)),
        hitWeight: o.hitWeight,
        poolWeight: o.poolWeight,
        weightLine: formatWeight(o.hitWeight, o.poolWeight),
      };
    });
    let attempts = 0;
    for (const { p } of [...chances].sort((a, b) => a.p - b.p)) attempts += expectedAttempts(p);
    attempts = Math.max(1, Math.min(attempts, 200));
    const bag = harvestWithMetacraftCost(harvest, attempts);
    mergeCost(costs, bag);
    const weightLine = chances.map((c) => `${c.m.short}: ${c.weightLine}`).join('; ');
    const juiceLine = Object.entries(harvestCostBag(harvest, 1))
      .map(([k, n]) => `${n} ${k.replace('-lifeforce', '')}`)
      .join('+');

    steps.push(
      step(
        'harvestFill',
        'harvest',
        `${metaFinal.name} → ${harvest.name} ×~${attempts}`,
        [
          `Protect finished mods with metacraft, then ${harvest.name} (reforges ${rerollSide}s only).`,
          `Targets: ${remaining.map((m) => m.short).join('; ')}.`,
          `Non-fractured ${rerollSide} keepers other than these targets are finished after this step.`,
          `Harvest-tagged pool weights (tier+higher): ${weightLine}.`,
          `~${attempts}× (${juiceLine} lifeforce each) + ${bag.divine} Divines expected.`,
        ].join(' '),
        remaining.map((m) => m.short),
        bag,
        {
          chance: chances[0]?.p ?? 0.1,
          chanceLabel: `~${attempts} · ${chances.map((c) => c.weightLine).join(' / ')}`,
          weightLine,
          harvestOfficial: harvest.id,
          rerollSide,
        }
      )
    );
    for (const m of remaining) {
      const c = chances.find((x) => x.m === m);
      m._done = true;
      assignHarvestMethod(m, harvest, {
        hitWeight: c?.hitWeight ?? m.hitWeight,
        poolWeight: c?.poolWeight ?? m.poolWeight,
        pRoll: c?.p ?? 0.1,
      });
      m.note = `${harvest.name}; ${c?.weightLine ?? pct(m.chance)}.`;
    }
  }

  // 6. Unveil — metacraft-lock other side; prefer Veiled Chaos when unlock side can be reforged
  for (const m of unveilMods) {
    if (m._done) continue;
    const lockMeta =
      m.gen === 'prefix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
    const useChaos = preferVeiledChaos(mods, m);
    const block = useChaos ? null : pickSlamBlock(kb, itemClass, baseTags, minIlvl, mods, benchMods, m);
    const occupied = occupiedGroupsNow(mods, m.gen);
    const u = unveilExpected(kb, baseTags, minIlvl, m, occupied);
    const attempts = u.expected;
    const p = u.pRoll;
    const bag = veiledOrbCost(attempts, useChaos);
    mergeCost(costs, bag);
    const orbName = useChaos ? 'Veiled Chaos' : 'Veiled Exalt';
    const detail = useChaos
      ? `${lockMeta.name} locks finished ${m.gen === 'prefix' ? 'suffixes' : 'prefixes'}. ${orbName} reforges ${m.gen}es (fractured stays; guarantees a veiled). Unveil ${m.short}: ${u.weightLine}.`
      : `${blockDetail(block, true)}${u.weightLine}. Free ${m.gen} slot required (adds without reforging keepers).`;
    steps.push(
      step(
        'unveil',
        useChaos ? 'veiled-chaos' : 'veiled',
        `${lockMeta.name} → ${blockActionPrefix(block)}${orbName} → unveil ${m.short}`,
        detail,
        [m.short],
        bag,
        {
          chance: p,
          chanceLabel: u.weightLine,
          weightLine: u.weightLine,
        }
      )
    );
    m._done = true;
    m.method = 'unveil';
    m.chance = p;
    m.weightLine = u.weightLine;
    m.note = useChaos ? 'Veiled Chaos unveil (3 rolls).' : 'Veiled Exalt unveil (3 rolls).';
  }

  // 7. Leftovers — cheapest remaining candidate (never bench; crafts stay free until the end)
  // Never altSpam here if item is already rare (essence / harvest / eldritch).
  const rareNow = !!(
    chosenEssence ||
    steps.some((s) =>
      [
        'essenceFish',
        'harvestFill',
        'eldritchChaos',
        'alchemy',
        'regal',
        'influencePrep',
        'influenceSlam',
        'altSpam',
        'cannotRollAssist',
      ].includes(s.operator)
    )
  );
  for (const m of open()) {
    const gen = affixGen(m);
    // Reserve final bench-craft slots — never exalt into the craft's last open affix.
    const claimed = mods.filter(
      (x) => affixGen(x) === gen && !isBenchMod(x) && (x._done || x.fractured || x === m)
    ).length;
    const craftSlots = benchMods.filter((b) => affixGen(b) === gen).length;
    if (gen && claimed + craftSlots > 3) {
      m._done = true;
      m.method = 'unfittable';
      m.chance = 0;
      m.note = `No free ${gen} slot — reserved for bench craft.`;
      tips.push(`Skipped ${m.short}: ${gen}s full once bench craft is reserved.`);
      continue;
    }

    const exaltTags =
      m._exaltTags ||
      (isInfluenceGoal(m) && influenceSlam
        ? withInfluenceTags(baseTags, influenceSlam.influence)
        : baseTags);
    const occupied = occupiedGroupsNow(mods);
    const openSlot = !!m._openSlotExalt || !!m._cannotRollAssist || !!influenceSlam;

    // Score harvest vs exalt (blocked tags if assist) vs alt — pick cheapest.
    const options = [];
    if (!rareNow && m.candidates.some((c) => c.type === 'alt') && !m._skipHarvest) {
      const alt = altExpected(kb, baseTags, minIlvl, m, occupied);
      const attempts = Math.min(alt.expected, 1200);
      const cost = { transmute: 1, alteration: attempts };
      options.push({
        type: 'alt',
        chance: alt.pRoll,
        attempts,
        cost,
        expectedChaos: costOf(cost, prices),
        weightLine: alt.weightSummary,
        hitWeight: alt.hitWeight,
        poolWeight: alt.poolWeight,
        label: `Alt spam (${alt.weightSummary})`,
      });
    }
    if (!m._skipHarvest) {
      for (const h of m.harvests ?? []) {
        const odds = harvestGoalOdds(kb, exaltTags, minIlvl, m, h, modMatchesHarvest, occupied);
        if (!(odds.hitWeight > 0)) continue;
        const p = Math.min(0.95, Math.max(odds.pRoll, 1e-12));
        const attempts = Math.min(expectedAttempts(p), 200);
        const cost = harvestWithMetacraftCost(h, attempts);
        options.push({
          type: 'harvest',
          harvest: h,
          chance: p,
          attempts,
          cost,
          expectedChaos: costOf(cost, prices),
          weightLine: formatWeight(odds.hitWeight, odds.poolWeight),
          hitWeight: odds.hitWeight,
          poolWeight: odds.poolWeight,
          label: `${h.name} (${formatWeight(odds.hitWeight, odds.poolWeight)})`,
        });
      }
    }
    {
      const exalt = exaltExpected(kb, exaltTags, minIlvl, m, occupied);
      const cost = openSlot ? exaltOpenSlotBag(exalt) : exaltMetacraftBag(exalt);
      options.push({
        type: 'exalt',
        chance: exalt.pRoll,
        attempts: exalt.expected,
        cost,
        expectedChaos: costOf(cost, prices),
        weightLine: exalt.weightSummary,
        hitWeight: exalt.hitWeight,
        poolWeight: exalt.poolWeight,
        detail: `~${exalt.expected} Exalts. ${exalt.weightSummary} tier+higher vs open ${m.gen} pool${m._cannotRollAssist ? ' (cannot-roll reduced)' : ''}.`,
        label: `Exalt (${exalt.weightSummary})`,
      });
    }
    // Drop harvest options that would wipe already-obtained unprotected keepers on the reroll side.
    const safeOptions = options.filter((o) => {
      if (o.type !== 'harvest') return true;
      const meta = m.gen === 'prefix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
      const rerollSide = meta.locks === 'prefix' ? 'suffix' : 'prefix';
      return unprotectedDoneKeepersOnSide(mods, rerollSide, [m]).length === 0;
    });
    safeOptions.sort((a, b) => rankCost(a.expectedChaos) - rankCost(b.expectedChaos));
    const c = safeOptions[0];
    if (!c || c.type === 'bench' || isBenchMod(m)) continue;

    if (c.type === 'alt') {
      mergeCost(costs, c.cost);
      steps.push(
        step('altSpam', 'alteration', `Alt for ${m.short}`, c.label, [m.short], c.cost, {
          chance: c.chance,
          chanceLabel: `~${c.attempts} alts · ${c.weightLine || formatWeight(m.hitWeight, m.poolWeight)}`,
          weightLine: c.weightLine || m.weightLine,
        })
      );
      m.method = 'natural';
      m.chance = c.chance;
      m.note = c.label;
    } else if (c.type === 'harvest') {
      mergeCost(costs, c.cost);
      const meta = m.gen === 'prefix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
      const rerollSide = meta.locks === 'prefix' ? 'suffix' : 'prefix';
      steps.push(
        step(
          'harvestFill',
          'harvest',
          `${meta.name} → ${c.harvest.name} ×~${c.attempts}`,
          `${c.label}. ${c.weightLine || ''} (reforges ${rerollSide}s).`,
          [m.short],
          c.cost,
          {
            chance: c.chance,
            chanceLabel: `~${c.attempts} · ${c.weightLine || pct(c.chance)}`,
            weightLine: c.weightLine,
            rerollSide,
          }
        )
      );
      assignHarvestMethod(m, c.harvest, {
        hitWeight: c.hitWeight ?? m.hitWeight,
        poolWeight: c.poolWeight ?? m.poolWeight,
        pRoll: c.chance,
      });
      m.note = c.label;
    } else {
      mergeCost(costs, c.cost);
      const assistNote = m._cannotRollAssist ? ' (cannot-roll pool)' : '';
      steps.push(
        step(
          'exaltFallback',
          'exalt',
          `${m._cannotRollAssist || openSlot ? 'Exalt' : 'LAST RESORT: Exalt'} for ${m.short}${assistNote}`,
          c.detail || c.label,
          [m.short],
          c.cost,
          {
            chance: c.chance,
            chanceLabel: c.weightLine || pct(c.chance),
            weightLine: c.weightLine,
            fallback: !m._cannotRollAssist,
          }
        )
      );
      m.method = 'natural';
      m.chance = c.chance;
      if (!m._cannotRollAssist) tips.push(`Exalt fallback on ${m.short} — consider relaxing tier.`);
    }
    m._done = true;
  }

  // 8. Free a slot if needed, then Bench ALWAYS last
  for (const m of [...benchMods, ...mods.filter(isBenchMod)]) {
    if (m.fractured || m._done) continue;
    m._done = true;
    m.method = 'bench';
    m.chance = 1;
    m.weightLine = 'N/A (bench)';
    m.note = 'Bench last — keeps affix slot free for earlier RNG.';
  }
  const annulSpace = buildAnnulForBenchSpace(item, mods, benchMods, steps, costs, itemClass);
  if (annulSpace.length) steps = [...steps, ...annulSpace];
  steps = ensureFinalBenchSteps(mods, steps);

  tips.push(
    'Each mod is scored against KB forces (essence-by-class, harvest, eldritch, unveil, bench).',
    'Armour: defence prefixes via Woe/Dense fish-all, then Eldritch Chaos (Eater) for suffixes — not metacraft harvest for exact T1.',
    ...mods
      .filter((m) => m.candidates?.length)
      .slice(0, 3)
      .map((m) => `${m.short}: best=${m.best?.label ?? '?'} (${Math.round(m.best?.expectedChaos ?? 0)}c)`)
  );

  const nameParts = [];
  if (preferFracture && preferFractureEnabled) nameParts.push(`Fracture ${preferFracture.mod.short.slice(0, 28)}`);
  else if (fractured.length) nameParts.push('Fracture buy');
  if (influenceSlam) {
    nameParts.push(
      `${influenceSlam.influence} Exalt ${String(influenceSlam.mod.short).slice(0, 24)}`
    );
  }
  if (chosenEssence) nameParts.push(chosenEssence.essenceName.replace('Deafening Essence of ', ''));
  if (steps.some((s) => s.operator === 'eldritchChaos')) nameParts.push('Eldritch Chaos');
  if (steps.some((s) => s.operator === 'harvestFill')) nameParts.push('Harvest');
  if (unveilMods.length) nameParts.push('Unveil');
  if (benchMods.length) nameParts.push('Bench');

  const totalCost = chaosCost(costs, prices);
  for (const a of alternatives) {
    if (a._extraChaos != null && totalCost != null) {
      a.totalCost = Math.round((totalCost + a._extraChaos) * 100) / 100;
      delete a._extraChaos;
    } else if (a._extraChaos != null) {
      a.totalCost = null;
      delete a._extraChaos;
    }
    a.costBreakdown = formatCostBreakdown(a.costs ?? {}, prices);
  }
  if (kb.priceStatus?.missing || !prices) {
    tips.unshift(kb.pricesTip || 'Run npm run fetch-prices — EV needs a daily price snapshot.');
  } else if (kb.priceStatus?.stale && kb.priceStatus?.message) {
    tips.unshift(kb.priceStatus.message);
  } else if (totalCost == null) {
    tips.unshift(`Price snapshot incomplete for this craft's currencies. ${kb.pricesTip || 'Run npm run fetch-prices'}`);
  }
  if (preferFracture && preferFractureEnabled) {
    const tip =
      preferFracture.saveEss > 0
        ? `Fracture ${preferFracture.mod.short} (${preferFracture.weightLine}) — lowest natural weight; saves ~${preferFracture.saveEss} ess (~${Math.round(preferFracture.saveChaos)}c) vs rolling it.`
        : preferFracture.saveKind === 'eldritch' && preferFracture.saveChaos > 0
          ? `Fracture ${preferFracture.mod.short} (${preferFracture.weightLine}) — lowest natural weight; saves ~${preferFracture.saveEldritch} Eldritch Chaos (~${Math.round(preferFracture.saveChaos)}c).`
          : `Fracture ${preferFracture.mod.short} (${preferFracture.weightLine}) — lowest natural spawn weight among goals.`;
    tips.unshift(tip);
  } else if (preferFracture && !preferFractureEnabled) {
    tips.unshift(
      `Prefer fracture off — rolling ${preferFracture.mod.short} (${preferFracture.weightLine}) in craft instead of locking it.`
    );
  }
  if (infAcq) {
    tips.unshift(
      `${infAcq.influences.join('+')} influence: ${
        infAcq.recommend === 'buy'
          ? 'buy influenced base'
          : infAcq.recommend === 'slam'
            ? 'mid-craft influence exalt slam (uninfluenced base)'
            : 'apply influence exalt'
      } (${infAcq.reason}).`
    );
  }

  return {
    id: 'candidate-search',
    name: nameParts.length ? nameParts.join(' → ') : 'KB candidate plan',
    description:
      preferFracture && preferFractureEnabled
        ? preferFracture.saveChaos > 0
          ? `Fractured ${preferFracture.mod.short} (lowest weight) + KB combo (saves ~${Math.round(preferFracture.saveChaos)}c vs non-fractured).`
          : `Prefer fractured ${preferFracture.mod.short} (lowest natural weight: ${preferFracture.weightLine}) + cheapest KB combo.`
        : 'Cheapest consistent combo from per-mod KB candidates + Eldritch operators.',
    steps: renumber(steps),
    costs,
    totalCost,
    costBreakdown: formatCostBreakdown(costs, prices),
    tips,
    classified: mods,
    alternatives,
    preferFractureAvailable: !!preferFracture,
    preferFractureEnabled: preferFracture ? preferFractureEnabled : null,
    priceStatus: kb.priceStatus,
    pricesTip: kb.pricesTip,
  };
}

export async function planDeterministic(item, onProgress, opts = {}) {
  onProgress?.({ phase: 'loading-knowledge' });
  const kb = await loadKnowledgeBase();
  const base = getBaseInfo(kb, item.baseName);
  if (base?.name && base.name !== item.baseName) {
    item = { ...item, baseName: base.name };
  }
  const baseTags = effectiveBaseTags(item, base, kb.cannotRoll);
  const cannotRoll = resolveCannotRoll(item, base, kb.cannotRoll);
  const itemClass = base?.item_class ?? normalizeItemClass(item.itemClass);

  onProgress?.({ phase: 'matching-knowledge' });
  const sourceMods =
    item.enrichedMods?.length || item.enrichedCrafted?.length
      ? [
          ...(item.enrichedMods ?? []),
          ...(item.enrichedCrafted ?? []).map((m) =>
            typeof m === 'string' ? { text: m, crafted: true } : { ...m, crafted: true }
          ),
        ]
      : [
          ...(item.explicitMods ?? [])
            .map((m) => (typeof m === 'string' ? { text: m } : m))
            .filter((m) => !m.crafted),
          ...(item.craftedMods ?? item.crafted ?? item.explicitMods?.filter((m) => m.crafted) ?? []).map(
            (m) => (typeof m === 'string' ? { text: m, crafted: true } : { ...m, crafted: true })
          ),
        ];

  const ilvl = Math.max(item.itemLevel ?? 1, 1);
  let mods = sourceMods.map((m) => enrichMod(kb, item, m, baseTags, Math.max(ilvl, 86)));
  const { minIlvl, drivers } = minIlvlFromMods(mods);
  // Odds use the higher of paste ilvl and required min (alts on an ilvl 15 flask ≠ ilvl 1 pool)
  const weightIlvl = Math.max(ilvl, minIlvl);
  mods = sourceMods.map((m) => enrichMod(kb, item, m, baseTags, weightIlvl));

  onProgress?.({ phase: 'building-plan' });
  const best = assignAndBuild(item, mods, kb, baseTags, weightIlvl, drivers, itemClass, opts);

  return {
    best,
    alternatives: best.alternatives ?? [],
    minIlvl,
    drivers,
    classified: best.classified,
    coverage: kb.coverage,
    cannotRoll,
    baseTags,
  };
}

/** Stable key for hit toggles: match id when known, else normalized mod text. */
export function modStableKey(m) {
  if (m == null) return '';
  if (typeof m === 'string') {
    return `t:${String(m)
      .toLowerCase()
      .replace(/\s*\|\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()}`;
  }
  if (m.match?.id) return `id:${m.match.id}`;
  if (m.id) return `id:${m.id}`;
  return modStableKey(m.short ?? m.text ?? '');
}

function isCraftedClassified(m) {
  return !!(m && !m.fractured && (m.crafted || m.method === 'bench' || m.match?.source === 'crafted'));
}

function benchFullLabel(m) {
  return short(m?.short || m?.text || '');
}

function makeBenchStep(m) {
  const label = benchFullLabel(m);
  return step(
    'bench',
    'bench',
    `Crafting Bench: ${label}`,
    'Apply last so slots stay free during harvest/unveil/eldritch.',
    [label],
    { bench: 1 },
    { chance: 1, chanceLabel: '100%', hideWhenDone: false }
  );
}

/**
 * Guarantee every crafted mod has a final Crafting Bench step with full hybrid text.
 * Never drop these during leftovers/replan — always contiguous at the end.
 */
function ensureFinalBenchSteps(classified, steps) {
  const crafted = (classified ?? []).filter(isCraftedClassified);
  const nonBench = (steps ?? []).filter((s) => s.operator !== 'bench');
  const priorBench = (steps ?? []).filter((s) => s.operator === 'bench');

  if (!crafted.length) {
    // Still keep any prior bench steps at end if classified lost crafted flags
    return priorBench.length ? [...nonBench, ...priorBench] : steps ?? [];
  }

  const used = new Set();
  const benchSteps = [];
  for (const m of crafted) {
    const label = benchFullLabel(m);
    const keys = [modStableKey(m), modStableKey(label)].filter(Boolean);
    if (keys.some((k) => used.has(k))) continue;
    for (const k of keys) used.add(k);

    const existing = priorBench.find((s) =>
      (s.targetMods ?? []).some(
        (t) => keys.includes(modStableKey(t)) || modStableKey(t) === modStableKey(label)
      )
    );
    if (existing) {
      benchSteps.push({
        ...existing,
        action: `Crafting Bench: ${label}`,
        detail: existing.detail || 'Apply last so slots stay free during harvest/unveil/eldritch.',
        targetMods: [label],
        hideWhenDone: false,
        chance: existing.chance ?? 1,
        chanceLabel: existing.progressDone
          ? existing.chanceLabel || 'hit ✓'
          : existing.chanceLabel || '100%',
      });
    } else {
      benchSteps.push(makeBenchStep(m));
    }
  }
  // Preserve any unmatched prior bench steps (safety)
  for (const s of priorBench) {
    const lab = (s.targetMods ?? [])[0];
    if (lab && benchSteps.some((b) => modStableKey((b.targetMods ?? [])[0]) === modStableKey(lab))) {
      continue;
    }
    if (!lab && benchSteps.length) continue;
    benchSteps.push({ ...s, hideWhenDone: false });
  }
  return [...nonBench, ...benchSteps];
}

function findClassifiedByLabel(classified, label) {
  const textKey = modStableKey(label);
  return (
    classified.find((m) => modStableKey(m.short ?? '') === textKey) ||
    classified.find((m) => modStableKey(m.text ?? '') === textKey) ||
    classified.find((m) => modStableKey(m) === textKey)
  );
}

function labelHit(hitKeys, text, mod) {
  if (mod && hitKeys.has(modStableKey(mod))) return true;
  if (hitKeys.has(modStableKey(text))) return true;
  if (mod?.short && hitKeys.has(modStableKey(mod.short))) return true;
  return false;
}

function occupiedFromHits(classified, hitKeys) {
  const occupied = new Set();
  for (const m of classified) {
    if (isNonOccupyingAffix(m)) continue;
    if (!labelHit(hitKeys, m.short ?? m.text, m)) continue;
    for (const g of m.groups ?? []) occupied.add(g);
  }
  return occupied;
}

/**
 * Rebuild plan when prefer-fracture toggles, then apply hit progress like replanFromProgress.
 * @param {object} item
 * @param {object} plan — prior UI plan (keeps art / display fields)
 * @param {{ preferFracture?: boolean, hitKeys?: Iterable<string> }} [options]
 */
export async function replanWithOptions(item, plan, options = {}) {
  const preferFracture = options.preferFracture !== false;
  const hitKeys = options.hitKeys ?? options.hitKeySet ?? [];
  const canPrefer =
    !!plan.preferFractureAvailable ||
    (plan.steps ?? []).some((s) => s.operator === 'preferFracture');

  let working = plan;
  if (canPrefer) {
    const result = await planDeterministic(item, null, { preferFracture });
    const best = result.best;
    const styleCurrency = (key) => {
      if (key && typeof key === 'object') return key;
      const CURRENCY = {
        quality: { name: 'Base', short: 'Base', color: '#aaa' },
        essence: { name: 'Essence', short: 'Essence', color: '#56ccf2' },
        harvest: { name: 'Harvest', short: 'Harvest', color: '#6fcf97' },
        bench: { name: 'Crafting Bench', short: 'Bench', color: '#6fcf97' },
        exalt: { name: 'Exalted Orb', short: 'Exalt', color: '#d4af37' },
        alteration: { name: 'Orb of Alteration', short: 'Alteration', color: '#7eb8da' },
        regal: { name: 'Regal Orb', short: 'Regal', color: '#d4af37' },
        veiled: { name: 'Veiled Exalt', short: 'Veiled', color: '#c9a0dc' },
        'veiled-chaos': { name: 'Veiled Chaos', short: 'Veiled Chaos', color: '#c9a0dc' },
        'eldritch-chaos': { name: 'Eldritch Chaos Orb', short: 'Eldritch Chaos', color: '#e8a838' },
        annul: { name: 'Orb of Annulment', short: 'Annul', color: '#c9a0dc' },
      };
      const k = String(key ?? '');
      let base;
      if (CURRENCY[k]) base = CURRENCY[k];
      else if (k.startsWith('essence')) base = CURRENCY.essence;
      else if (k.startsWith('eldritch')) base = CURRENCY['eldritch-chaos'];
      else base = { name: k, short: k, color: '#aaa' };
      return { ...base, key: k };
    };
    const classified = (best.classified ?? []).map((m) => ({
      text: m.text,
      short: m.short,
      gen: m.gen,
      groups: m.groups ?? [],
      method: m.method,
      ofEssence: m.ofEssence,
      crafted: m.crafted,
      fractured: m.fractured,
      veiled: m.veiled,
      match: m.match?.id ? { id: m.match.id, source: m.match.source ?? null } : null,
      hitWeight: m.hitWeight,
      poolWeight: m.poolWeight,
      reqLevel: m.reqLevel,
      tags: m.tags,
      harvests: m.harvests,
      weight: m.weight,
      tier: m.tier,
    }));
    working = {
      ...plan,
      method: best.id,
      methodName: best.name,
      summary: `Deterministic plan: ${best.name} — ~${best.totalCost}c expected (min base ilvl ${result.minIlvl})`,
      steps: best.steps.map((raw) => ({
        step: raw.step,
        currency: styleCurrency(raw.currency),
        action: raw.action,
        detail: raw.detail,
        targetMods: raw.targetMods ?? [],
        cost: raw.cost ?? {},
        operator: raw.operator,
        chance: raw.chance,
        chanceLabel: raw.chanceLabel,
        weightLine: raw.weightLine,
        fallback: raw.fallback,
        harvestOfficial: raw.harvestOfficial,
        preferEnabled: raw.preferEnabled,
        fractureSave: raw.fractureSave,
      })),
      costs: best.costs,
      costBreakdown: best.costBreakdown ?? formatCostBreakdown(best.costs ?? {}, null),
      totalCost: best.totalCost,
      minIlvl: result.minIlvl,
      ilvlDrivers: result.drivers,
      baseTags: result.baseTags,
      classified,
      alternatives: (best.alternatives ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        totalCost: a.totalCost,
        costBreakdown: a.costBreakdown ?? [],
      })),
      tips: [
        `Recommended base ilvl ${result.minIlvl}+ (from mod required_level in knowledge base).`,
        ...(best.tips ?? []).slice(0, 4),
      ],
      preferFractureAvailable: true,
      preferFractureEnabled: preferFracture,
      priceStatus: best.priceStatus,
      pricesTip: best.pricesTip,
      modAnalysis: (best.classified ?? []).map((m) => ({
        text: m.text,
        matched: !!m.match?.matched,
        id: m.match?.id ?? null,
        kbSource: m.match?.source ?? null,
        kbText: m.match?.matched ? m.match?.text ?? null : null,
        min: m.match?.matched ? m.match?.min ?? m.match?.stats?.[0]?.min ?? null : null,
        max: m.match?.matched ? m.match?.max ?? m.match?.stats?.[0]?.max ?? null : null,
        type: m.gen,
        tier: m.match?.name,
        reqLevel: m.reqLevel,
        fractured: m.fractured,
        crafted: m.crafted,
        veiled: m.veiled,
        ofEssence: m.ofEssence,
        essence: m.essenceName,
        tags: m.match?.matched ? m.tags ?? m.match?.tags ?? [] : [],
        weight: m.weight,
        hitWeight: m.hitWeight,
        poolWeight: m.poolWeight,
        weightLine: m.weightLine,
        method: m.method,
        chance: m.chance,
        chanceLabel: m.weightLine
          ? m.weightLine
          : m.chance != null
            ? `${(m.chance * 100).toFixed(2)}%`
            : null,
        note: m.note,
        source: m.fractured
          ? 'fractured'
          : m.crafted
            ? 'crafted'
            : m.ofEssence
              ? 'essence'
              : m.veiled
                ? 'veiled'
                : m.match?.source === 'influence'
                  ? 'influence'
                  : m.match?.source === 'unveiled'
                    ? 'unveiled'
                    : m.method === 'harvest'
                      ? 'harvest'
                      : 'natural',
      })),
    };
  }

  const view = await replanFromProgress(item, working, hitKeys);
  return { ...view, plan: working };
}

/**
 * Lightweight progress replan: keep original steps, mark hits, and recalculate
 * remaining RNG steps (essence fish / harvest / eldritch) with occupied groups.
 */
export async function replanFromProgress(item, plan, hitKeySet) {
  const hitKeys = hitKeySet instanceof Set ? hitKeySet : new Set(hitKeySet ?? []);
  const classified = plan.classified ?? [];
  if (!classified.length || !hitKeys.size) {
    const annotated = annotatePlanHits(plan, hitKeys);
    return {
      ...annotated,
      steps: renumber(ensureFinalBenchSteps(classified.length ? classified : annotated.classified, annotated.steps)),
    };
  }

  const kb = await loadKnowledgeBase();
  const base = getBaseInfo(kb, item.baseName);
  const baseTags = plan.baseTags ?? effectiveBaseTags(item, base, kb.cannotRoll);
  const minIlvl = plan.minIlvl ?? Math.max(item.itemLevel ?? 1, 86);
  const occupied = occupiedFromHits(classified, hitKeys);
  // Essence guarantees always occupy their groups (locked present, not toggleable).
  for (const m of classified) {
    if (!(m.method === 'essence' || m.ofEssence) || isNonOccupyingAffix(m)) continue;
    for (const g of m.groups ?? []) occupied.add(g);
  }

  const steps = (plan.steps ?? []).map((s) => {
    const labels = s.targetMods ?? [];
    const targetMeta = labels.map((text, i) => {
      const mod = findClassifiedByLabel(classified, text);
      const key = mod ? modStableKey(mod) : modStableKey(text);
      const hit = labelHit(hitKeys, text, mod);
      const guaranteed =
        mod?.method === 'essence' ||
        (s.operator === 'essenceFish' && (i === 0 || !!mod?.ofEssence));
      return { text, key, hit, guaranteed: !!guaranteed, mod };
    });

    const remaining = targetMeta.filter((t) => !t.hit && !t.guaranteed);
    const allHit = labels.length > 0 && remaining.length === 0;

    if (s.operator === 'harvestFill' || (s.operator === 'exaltFallback' && s.harvestOfficial)) {
      // Crit fish "any of": harvest siblings = essence-fish secondaries ∪ harvest targets
      const ess = (plan.steps ?? []).find((x) => x.operator === 'essenceFish');
      const fishSiblings = (ess?.targetMods ?? []).slice(1); // skip essence guarantee
      const siblingLabels = [...new Set([...(s.targetMods ?? []), ...fishSiblings])];
      const siblingMeta = siblingLabels.map((text) => {
        const mod = findClassifiedByLabel(classified, text);
        const key = mod ? modStableKey(mod) : modStableKey(text);
        return {
          text,
          key,
          hit: labelHit(hitKeys, text, mod),
          guaranteed: false,
          mod,
        };
      });
      const remSiblings = siblingMeta.filter((t) => !t.hit);
      const allSibHit = siblingMeta.length > 0 && remSiblings.length === 0;
      return replanHarvestStep(
        s,
        remSiblings.length ? remSiblings : remaining,
        occupied,
        kb,
        baseTags,
        minIlvl,
        allSibHit,
        siblingMeta.length ? siblingMeta : targetMeta
      );
    }
    if (s.operator === 'essenceFish') {
      return replanEssenceFishStep(s, targetMeta, occupied, kb, baseTags, minIlvl, allHit);
    }
    if (s.operator === 'eldritchChaos') {
      return replanEldritchStep(s, remaining, occupied, kb, baseTags, minIlvl, allHit, targetMeta);
    }

    return {
      ...s,
      targetMeta,
      // Keep full target list for toggling on early steps; later steps filter below
      targetMods: labels,
      progressDone: allHit,
      chanceLabel: allHit ? 'hit ✓' : s.chanceLabel,
    };
  });

  // Keep every original step visible. Completed ones stay greyed (progressDone) with
  // full target lists so hits can be unchecked to undo. Bench always last.
  const viewSteps = steps.map((s) => {
    if (s.operator === 'bench') {
      const rem = (s.targetMeta ?? []).filter((t) => !t.hit);
      const done = (s.targetMeta ?? []).length > 0 && rem.length === 0;
      return {
        ...s,
        hideWhenDone: false,
        progressDone: done,
        targetMods: labelsFor(s),
        targetMeta: s.targetMeta ?? [],
        chanceLabel: done ? 'hit ✓' : s.chanceLabel,
      };
    }
    if (
      s.operator === 'harvestFill' ||
      s.operator === 'eldritchChaos' ||
      s.operator === 'unveil' ||
      s.operator === 'altSpam' ||
      s.operator === 'exaltFallback'
    ) {
      const meta = s.targetMeta ?? [];
      const rem = meta.filter((t) => !t.hit && !t.guaranteed);
      if (meta.length && !rem.length) {
        return {
          ...s,
          progressDone: true,
          hideWhenDone: false,
          targetMods: meta.map((t) => t.text),
          targetMeta: meta,
          chanceLabel: 'hit ✓',
        };
      }
    }
    return s;
  });

  const annotated = viewSteps;
  const finalSteps = renumber(ensureFinalBenchSteps(classified, annotated));
  // Keep summary EV in sync with replanned essence/harvest costs.
  const costs = {};
  for (const s of finalSteps) {
    if (s.progressDone) continue;
    for (const [k, n] of Object.entries(s.cost ?? {})) {
      if (!n) continue;
      costs[k] = (costs[k] ?? 0) + n;
    }
  }
  const totalCost = chaosCost(costs, kb.prices);
  return {
    ...plan,
    steps: finalSteps,
    costs,
    totalCost: totalCost ?? plan.totalCost,
    costBreakdown: totalCost != null ? formatCostBreakdown(costs, kb.prices) : plan.costBreakdown,
    summary:
      totalCost != null
        ? `Deterministic plan: ${plan.methodName} — ~${totalCost}c expected (min base ilvl ${plan.minIlvl})`
        : plan.summary,
  };
}

function labelsFor(s) {
  if (s.targetMods?.length) return s.targetMods;
  return (s.targetMeta ?? []).map((t) => t.text).filter(Boolean);
}

function annotatePlanHits(plan, hitKeys) {
  const classified = plan.classified ?? [];
  const steps = (plan.steps ?? []).map((s) => {
    const targetMeta = (s.targetMods ?? []).map((text, i) => {
      const mod = findClassifiedByLabel(classified, text);
      const key = mod ? modStableKey(mod) : modStableKey(text);
      const guaranteed =
        mod?.method === 'essence' ||
        (s.operator === 'essenceFish' && (i === 0 || !!mod?.ofEssence)) ||
        !!mod?.ofEssence;
      return {
        text,
        key,
        hit: labelHit(hitKeys, text, mod),
        guaranteed: !!guaranteed,
        softHit: false,
        mod,
      };
    });
    const need = targetMeta.filter((t) => !t.guaranteed);
    const done = need.length > 0 && need.every((t) => t.hit);
    return {
      ...s,
      targetMeta,
      progressDone: done,
      hideWhenDone: false,
      chanceLabel: done ? 'hit ✓' : s.chanceLabel,
    };
  });
  return { ...plan, steps: ensureFinalBenchSteps(classified, steps) };
}

function replanHarvestStep(s, remaining, occupied, kb, baseTags, minIlvl, allHit, targetMeta) {
  const fullMods = (targetMeta ?? []).map((t) => t.text);
  if (allHit || !remaining.length) {
    return {
      ...s,
      targetMeta,
      targetMods: fullMods,
      progressDone: true,
      hideWhenDone: false,
      chanceLabel: 'hit ✓',
      weightLine: '',
      detail: 'All harvest targets hit — skip this step.',
    };
  }

  const harvest =
    HARVEST_REFORGES.find((h) => h.id === s.harvestOfficial) ||
    HARVEST_REFORGES.find((h) => (s.action ?? '').includes(h.name));
  if (!harvest) {
    return {
      ...s,
      targetMeta,
      targetMods: fullMods,
      progressDone: false,
    };
  }

  // Occupied = hits on same generation as remaining goals (siblings already on item)
  const gen = remaining[0]?.mod?.gen;
  const sideOcc = new Set(occupied);
  for (const t of targetMeta) {
    if (!t.hit || !t.mod) continue;
    if (gen && t.mod.gen !== gen) continue;
    for (const g of t.mod.groups ?? []) sideOcc.add(g);
  }

  const chances = remaining.map((t) => {
    const m = t.mod;
    const o = harvestGoalOdds(kb, baseTags, minIlvl, m || { text: t.text }, harvest, modMatchesHarvest, sideOcc);
    return {
      t,
      p: Math.min(0.95, Math.max(o.pRoll, 1e-12)),
      hitWeight: o.hitWeight,
      poolWeight: o.poolWeight,
      weightLine: formatWeight(o.hitWeight, o.poolWeight),
    };
  });
  let attempts = 0;
  for (const { p } of [...chances].sort((a, b) => a.p - b.p)) attempts += expectedAttempts(p);
  attempts = Math.max(1, Math.min(attempts, 200));
  const bag = harvestWithMetacraftCost(harvest, attempts);
  const weightLine = chances.map((c) => `${c.t.text}: ${c.weightLine}`).join('; ');
  const metaMatch = (s.action ?? '').match(/^(.+?)\s*→/);
  const metaName = metaMatch?.[1]?.trim() || 'Metacraft';
  const juiceLine = Object.entries(harvestCostBag(harvest, 1))
    .map(([k, n]) => `${n} ${k.replace('-lifeforce', '')}`)
    .join('+');

  return {
    ...s,
    targetMeta,
    targetMods: fullMods,
    progressDone: false,
    action: `${metaName} → ${harvest.name} ×~${attempts}`,
    detail: [
      `Protect finished mods with metacraft, then ${harvest.name}.`,
      `Remaining: ${remaining.map((t) => t.text).join('; ')}.`,
      sideOcc.size ? `Pool excludes ${sideOcc.size} occupied group(s).` : '',
      `Harvest-tagged pool weights (tier+higher): ${weightLine}.`,
      `~${attempts}× (${juiceLine} lifeforce each) + ${bag.divine} Divines expected.`,
    ]
      .filter(Boolean)
      .join(' '),
    cost: bag,
    chance: chances[0]?.p ?? 0.1,
    chanceLabel: `~${attempts} · ${chances.map((c) => c.weightLine).join(' / ')}`,
    weightLine,
    harvestOfficial: harvest.id,
  };
}

function replanEssenceFishStep(s, targetMeta, occupied, kb, baseTags, minIlvl, allHit) {
  const isGuarantee = (t) => t.guaranteed || t.mod?.method === 'essence';
  // Essence guarantee always occupies its groups once on this path (not toggleable).
  const occ = new Set(occupied);
  for (const t of targetMeta) {
    if (!isGuarantee(t) || !t.mod || isNonOccupyingAffix(t.mod)) continue;
    for (const g of t.mod.groups ?? []) occ.add(g);
  }

  if (allHit) {
    return {
      ...s,
      targetMeta,
      targetMods: targetMeta.map((t) => t.text),
      progressDone: true,
      chanceLabel: 'hit ✓',
    };
  }

  const fishSlots = targetMeta.filter((t) => !isGuarantee(t));
  const anyOf = /any of:/i.test(s.action ?? '') || /\bOR\b/.test(s.action ?? '');
  const fishHit = fishSlots.some((t) => t.hit);

  // Crit-style "any of": one fished sibling is enough — harvest covers the rest
  if (anyOf && fishHit) {
    return {
      ...s,
      targetMeta,
      targetMods: targetMeta.map((t) => t.text),
      progressDone: true,
      chanceLabel: 'fish done ✓',
      weightLine: '',
      detail: `${(s.detail ?? '').split('.')[0]}. Fish goal hit — continue to harvest/unveil for remaining mods.`,
    };
  }

  const fishGoals = fishSlots.filter((t) => !t.hit);
  const EXTRA_ROLLS = 2;

  if (!fishGoals.length) {
    return {
      ...s,
      targetMeta,
      targetMods: targetMeta.map((t) => t.text),
      progressDone: true,
      chanceLabel: 'hit ✓',
      weightLine: '',
    };
  }

  const fishMods = fishGoals.map((t) => t.mod).filter(Boolean);
  if (!fishMods.length) {
    return { ...s, targetMeta, targetMods: targetMeta.map((t) => t.text), progressDone: false };
  }

  // Per-generation pools — never score suffix Str against the prefix pool.
  let fishMath = multiGenEssenceFishExpected(kb, baseTags, minIlvl, fishMods, EXTRA_ROLLS, occ);
  const zero = (fishMath?.goals ?? []).filter((g) => !(g.hitWeight > 0));
  if (zero.length) {
    const keep = fishMods.filter((m) => {
      const g = fishMath.goals.find((x) => x.short === m.short || x.short === short(m.text));
      return g && g.hitWeight > 0;
    });
    if (!keep.length) {
      return {
        ...s,
        targetMeta,
        targetMods: targetMeta.map((t) => t.text),
        progressDone: true,
        chanceLabel: 'guarantee only ✓',
        weightLine: '',
        detail: `${(s.detail ?? '').split('.')[0]}. Remaining fish goals have hit weight 0 (blocked/unmatched) — essence guarantee only.`,
        cost: { [Object.keys(s.cost ?? {}).find((k) => k.startsWith('essence')) || 'essence-deafening']: 2 },
      };
    }
    fishMath = multiGenEssenceFishExpected(kb, baseTags, minIlvl, keep, EXTRA_ROLLS, occ);
  }
  const useAny = anyOf || /any of:/i.test(s.action ?? '');
  const positiveGoals = (fishMath?.goals ?? []).filter((g) => (g.hitWeight ?? 0) > 0);
  if (!positiveGoals.length) {
    return {
      ...s,
      targetMeta,
      targetMods: targetMeta.map((t) => t.text),
      progressDone: true,
      chanceLabel: 'guarantee only ✓',
      weightLine: '',
      detail: `${(s.detail ?? '').split('.')[0]}. No positive-weight fish goals left.`,
      cost: { [Object.keys(s.cost ?? {}).find((k) => k.startsWith('essence')) || 'essence-deafening']: 2 },
    };
  }
  const easiest = [...positiveGoals].sort((a, b) => (b.hitWeight ?? b.weight) - (a.hitWeight ?? a.weight))[0];
  const fishP = useAny || positiveGoals.length === 1 ? easiest?.pHave ?? fishMath.pAll : fishMath.pAll;
  const attempts = Math.min(Math.max(Math.ceil(1 / Math.max(fishP, 1e-12)), 1), 5000);
  const weightDetail = positiveGoals
    .map((g) => `${g.short}: ${formatWeight(g.hitWeight ?? g.weight, g.poolWeight ?? g.pool)} tier+higher`)
    .join('; ');
  const weightLine = `pool · ${weightDetail}`;
  const essKey = Object.keys(s.cost ?? {}).find((k) => k.startsWith('essence')) || 'essence-deafening';
  const needLabel = anyOf
    ? fishGoals.map((t) => t.text).join(' OR ')
    : fishGoals.map((t) => t.text).join(' + ');

  return {
    ...s,
    targetMeta,
    targetMods: targetMeta.map((t) => t.text),
    progressDone: false,
    cost: { [essKey]: attempts },
    chance: fishP,
    chanceLabel: `~${attempts} ess · ${pct(fishP)}/hit · still need: ${needLabel}`,
    weightLine,
    weightMath: fishMath,
    detail: [
      (s.detail ?? '').split('.')[0] + '.',
      `Still missing: ${needLabel}.`,
      occ.size ? `Occupied groups excluded from pool.` : '',
      weightDetail,
      zero.length ? `Skipped zero-weight: ${zero.map((g) => g.short).join(', ')}.` : '',
      `Expected ~${attempts} essences (${pct(fishP)} per essence).`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function replanEldritchStep(s, remaining, occupied, kb, baseTags, minIlvl, allHit, targetMeta) {
  const fullMods = (targetMeta ?? []).map((t) => t.text);
  if (allHit || !remaining.length) {
    return {
      ...s,
      targetMeta,
      targetMods: fullMods,
      progressDone: true,
      hideWhenDone: false,
      chanceLabel: 'hit ✓',
    };
  }
  const mods = remaining.map((t) => t.mod).filter(Boolean);
  if (!mods.length) {
    return { ...s, targetMeta, targetMods: fullMods };
  }
  const gen = mods[0].gen || 'suffix';
  const withOcc = essenceFishExpected(kb, baseTags, minIlvl, gen, mods, Math.max(3, mods.length), occupied);
  const attempts = Math.max(Math.ceil(1 / Math.max(withOcc.pAll, 1e-15)), 1);
  const weightSummary = withOcc.weightSummary;
  return {
    ...s,
    targetMeta,
    targetMods: fullMods,
    progressDone: false,
    action: s.action.replace(/×~\d+/, `×~${attempts}`),
    cost: { ...(s.cost ?? {}), 'eldritch-chaos': attempts },
    chance: withOcc.pAll,
    chanceLabel: `~${attempts} Eldritch Chaos · ${pct(withOcc.pAll)}/hit · ${weightSummary}`,
    weightLine: `pool ${withOcc.pool} · ${weightSummary}`,
    detail: [
      `Remaining: ${remaining.map((t) => t.text).join('; ')}.`,
      `Pool ${withOcc.pool}. Weights: ${weightSummary}.`,
      `P(all) ≈ ${pct(withOcc.pAll)} → ~${attempts} expected.`,
    ].join(' '),
  };
}

export { formatCostBreakdown, chaosCost };
