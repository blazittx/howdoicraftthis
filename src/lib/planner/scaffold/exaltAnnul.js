/**
 * Scaffold exalt / cannot-roll assist / annul-for-bench-space.
 */
import { normalizeItemClass } from '../../itemClass.js';
import {
  exaltExpected,
  altExpected,
  harvestGoalOdds,
  bestCannotRollAssist,
  formatWeight,
} from '../../spawnWeights.js';
import { harvestWithMetacraftCost, modMatchesHarvest } from '../../craftKnowledge.js';
import {
  mergeCost,
  step,
  pct,
  costOf,
  expectedAttemptsEv,
  clampRoll,
  occupiedGroupsNow,
  bestSharedHarvest,
  isBenchMod,
  isInfluenceGoal,
} from './helpers.js';
import { withInfluenceTags, pickLeastWeightFractureMod } from './fractureInfluence.js';

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
    divine: exalt.expected * 2,
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
          attempts += expectedAttemptsEv(clampRoll(o.pRoll));
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
 * Bench crafts need free slots on their affix side. Metacrafts that protect the
 * *other* side occupy *this* side:
 *   SCBC (Suffixes Cannot Be Changed) = crafted PREFIX
 *   PCBC (Prefixes Cannot Be Changed) = crafted SUFFIX
 * So if keepers + benches ≤ 3, an open slot already exists for the bench — SCBC/PCBC
 * can only *temporarily* sit in that same slot and then be replaced by the bench.
 * Never invent SCBC+annul just because essence ran earlier.
 *
 * Annul-for-space only when permanent keepers leave too few opens for the benches.
 * Prefer Eldritch Annul when available (doesn't need a free craft slot first).
 * Else plain Annul — SCBC/PCBC cannot be applied on a full side (no open craft slot).
 */
function buildAnnulForBenchSpace(item, mods, benchMods, steps, costs, itemClass) {
  const out = [];
  const seen = new Set();

  for (const craft of benchMods) {
    const gen = affixGen(craft);
    if (!gen || seen.has(gen)) continue;
    const craftsOnSide = benchMods.filter((m) => affixGen(m) === gen);
    const keepers = mods.filter(
      (m) => affixGen(m) === gen && !isBenchMod(m) && m.method !== 'unfittable'
    );
    const open = Math.max(0, 3 - keepers.length);
    // Reserved opens cover the benches — no annul. Metacraft would use that same open.
    if (open >= craftsOnSide.length) continue;
    seen.add(gen);

    const needFree = craftsOnSide.length - open;
    const removable = keepers.filter((m) => !m.fractured);
    if (!removable.length) continue;

    const preferred = removable.filter(isFillerSideMod);
    const n = removable.length;
    const pFiller = preferred.length / n;
    const pValuable = (n - preferred.length) / n;
    // Need `needFree` successful removals of non-keepers; approx geometric on filler share.
    const pUseful = Math.max(pFiller, preferred.length ? preferred.length / n : 1 / n);
    const attempts = Math.min(Math.max(expectedAttemptsEv(pUseful) * needFree, needFree), 20);
    const remList = removable.map((m) => m.short).join('; ') || '(none)';
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
          `${dominance} dominant → Eldritch Annul ×~${Math.ceil(attempts)} (free ${gen} for bench)`,
          `Keepers (${keepers.length}) + bench (${craftsOnSide.length}) exceed 3 ${gen}s — need ${needFree} open. ${dominance} Eldritch Annul strips ${gen}s only (${other} safe; no metacraft slot required). Removable: ${remList}. ≈${pct(pFiller)} filler vs ≈${pct(pValuable)} keeper. Then replace with: ${craftLabel}.`,
          craftsOnSide.map((m) => m.short),
          bag,
          {
            chance: pUseful,
            chanceLabel: `~${Math.ceil(attempts)} · filler ${pct(pFiller)} / keeper ${pct(pValuable)}`,
            weightLine: `annul among ${n} ${gen}s (uniform)`,
          }
        )
      );
    } else {
      // Side is full — cannot craft SCBC/PCBC first (those need an open slot on this gen).
      const bag = { annul: attempts };
      mergeCost(costs, bag);
      out.push(
        step(
          'annulForSpace',
          'annul',
          `Annul ×~${Math.ceil(attempts)} (free ${gen} for bench)`,
          `Keepers (${keepers.length}) + bench (${craftsOnSide.length}) exceed 3 ${gen}s — need ${needFree} open for: ${craftLabel}. Cannot apply Suffixes/Prefixes Cannot Be Changed first: that metacraft is itself a ${gen} and needs the open slot the bench will use. Annul unwanted ${gen}s (Removable: ${remList}; ≈${pct(pFiller)} filler / ≈${pct(pValuable)} keeper), then Crafting Bench into the freed slot.`,
          craftsOnSide.map((m) => m.short),
          bag,
          {
            chance: pUseful,
            chanceLabel: `~${Math.ceil(attempts)} · filler ${pct(pFiller)} / keeper ${pct(pValuable)}`,
            weightLine: `annul among ${n} ${gen}s (uniform)`,
          }
        )
      );
    }
  }
  return out;
}

export {
  metacraftCostBag,
  exaltOpenSlotBag,
  exaltMetacraftBag,
  multiExaltBagEv,
  applyCannotRollExaltAssist,
  pushSlamSideKeeperAlt,
  preferFractureWeightLine,
  affixGen,
  isFillerSideMod,
  canUseEldritchAnnul,
  buildAnnulForBenchSpace,
};
