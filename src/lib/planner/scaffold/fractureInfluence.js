/**
 * Scaffold fracture + influence slam pipeline.
 */
import { INFLUENCE_TAG_KEY } from '../../knowledgeLoader.js';
import { influenceSlamExpected } from '../../spawnWeights.js';
import {
  METACRAFT,
  INFLUENCE_EXALTS,
  normalizeInfluence,
} from '../../craftKnowledge.js';
import {
  mergeCost,
  step,
  pct,
  isBenchMod,
  isInfluenceGoal,
} from './helpers.js';

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

/**
 * §80 fracture ranking: prefer higher standalone acquisition EV (downstream V proxy),
 * not raw rarity/hitWeight. Ties break on harder pool share / hybrids.
 */
function fractureSortKey(a, b) {
  const ca = a.best?.expectedChaos;
  const cb = b.best?.expectedChaos;
  if (ca != null && cb != null && ca !== cb) return cb - ca;
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

/** Fracture target by EV proxy (§80). With preferSlamGen: prefer slam-side naturals first. */
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

export {
  isFractureEligible,
  fracturePRoll,
  fractureSortKey,
  pickLeastWeightFractureMod,
  influenceNameForMod,
  withInfluenceTags,
  pickInfluenceSlamTarget,
  pushInfluenceSlamPipeline,
};
