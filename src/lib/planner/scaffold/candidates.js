/**
 * Scaffold candidates — essence match, enrich, acquisition candidates.
 */
import { matchModInKnowledge } from '../../knowledgeLoader.js';
import {
  generationPoolWeight,
  harvestGoalOdds,
  altExpected,
  exaltExpected,
  unveilExpected,
  formatWeight,
  weightTierAndAbove,
  resolveNaturalMod,
  modForPoETier,
  inferCraftGeneration,
} from '../../spawnWeights.js';
import { normalizeItemClass } from '../../itemClass.js';
import {
  harvestWithMetacraftCost,
  essencePriceKey,
  modMatchesHarvest,
} from '../../craftKnowledge.js';
import {
  short,
  costOf,
  rankCost,
  clampRoll,
  expectedAttemptsEv,
  preferVeiledChaos,
  veiledOrbCost,
  allHarvestsFor,
  isInfluenceGoal,
} from './helpers.js';

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
      divine: exalt.expected * 2,
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
    const p = clampRoll(odds.pRoll);
    const attempts = Math.min(expectedAttemptsEv(p), 200);
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
    divine: exalt.expected * 2,
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

export {
  essencesForTarget,
  enrichMod,
  candidatesFor,
  minIlvlFromMods,
};
