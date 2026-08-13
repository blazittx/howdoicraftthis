/**
 * Scaffold helpers — costs, blocks, harvest assignment.
 */
import { expectedAttempts as attemptsExact, formatAttemptsDisplay } from '../../expected.js';
import { normalizeItemClass } from '../../itemClass.js';
import { classifyPlan } from '../../planClass.js';
import { rulesetVersion } from '../../ruleset.js';
import { validatePlan } from '../../mechanics/validatePlan.js';
import {
  METACRAFT,
  HARVEST_REFORGES,
  chaosCost,
  modMatchesHarvest,
} from '../../craftKnowledge.js';
import {
  formatWeight,
  collectOccupiedGroups,
  bestBlockCraft,
} from '../../spawnWeights.js';

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
/** Display-round expected attempts; keep full float for EV math. */
function formatAttempts(n) {
  return formatAttemptsDisplay(n);
}
function expectedAttemptsEv(p) {
  const r = clampRoll(p);
  return r <= 0 ? Infinity : r >= 1 ? 1 : attemptsExact(r);
}
function clampRoll(p) {
  if (!(p > 0)) return 0;
  return p >= 0.999 ? 1 : p;
}
function stampPlan(plan, kb) {
  const stamped = {
    ...plan,
    rulesetVersion: plan.rulesetVersion ?? rulesetVersion(),
    experimental: !!(
      plan.experimental ||
      plan.id === 'recombinator' ||
      plan.methodComparison?.recombinator?.experimental
    ),
  };
  const classified = classifyPlan(stamped);
  return {
    ...stamped,
    classification: classified,
    validation: validatePlan(stamped, kb),
    // schema fields filled fully in craftPlanner.assemblePlan; keep stubs for direct callers
    confidence: stamped.confidence ?? {
      mechanics: 'high',
      probabilities: stamped.experimental ? 'medium' : 'high',
      prices: kb?.priceStatus?.missing ? 'unknown' : kb?.priceStatus?.stale ? 'medium' : 'high',
    },
    rejectedStrategies: stamped.rejectedStrategies ?? [],
  };
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
  m.chance = clampRoll(odds.pRoll ?? odds.chance ?? 0);
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

function isBenchMod(m) {
  return !!(m?.crafted || m?.match?.source === 'crafted' || m?.best?.type === 'bench' || m?.method === 'bench');
}

function isInfluenceGoal(m) {
  return m?.match?.source === 'influence';
}

/** Stable key for hit toggles: match id when known, else normalized mod text. */
function modStableKey(m) {
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

export {
  HARVEST_SPECIFICITY,
  short,
  mergeCost,
  renumber,
  pct,
  formatAttempts,
  expectedAttemptsEv,
  clampRoll,
  stampPlan,
  step,
  canTempBlock,
  sideGroups,
  occupiedGroupsNow,
  pickSlamBlock,
  blockActionPrefix,
  blockDetail,
  preferVeiledChaos,
  veiledOrbCost,
  costOf,
  rankCost,
  allHarvestsFor,
  bestSharedHarvest,
  harvestMetacraftSides,
  isArmourItemClass,
  sideRerollGensAhead,
  unprotectedDoneKeepersOnSide,
  assignHarvestMethod,
  assignEssenceFishNatural,
  isBenchMod,
  isInfluenceGoal,
  modStableKey,
  isCraftedClassified,
  benchFullLabel,
  makeBenchStep,
  ensureFinalBenchSteps,
};
