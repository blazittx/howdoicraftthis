/**
 * V(S) = min expected additional cost to reach the target from have-set S (§3, §45).
 * Recombination physics stay in recombinatorModel (target-blind).
 */
import { makeState, makeAffix, affixKey, allAffixes } from '../craftState.js';
import {
  recombineCost,
  getRecombinatorModel,
  donorPartitions,
  modelMeta,
  unpredictableRecombine,
  predictableRecombine,
  OPERATOR_UNPREDICTABLE,
  OPERATOR_PREDICTABLE,
} from '../recombinatorModel.js';
import {
  harvestGoalOdds,
  harvestEligiblePool,
  unveilExpected,
  exaltExpected,
  multiGenEssenceFishExpected,
  collectOccupiedGroups,
  bestCannotRollAssist,
} from '../spawnWeights.js';
import { essenceExtraRollsByGen } from '../mechanics/affixCounts.js';
import {
  HARVEST_REFORGES,
  METACRAFT,
  modMatchesHarvest,
  harvestWithMetacraftCost,
  chaosCost,
  essencePriceKey,
} from '../craftKnowledge.js';
import { expectedAttempts } from '../expected.js';
import {
  smashResourceEconomics,
  buildRecombCostReport,
  formatPctPrecise,
  MIN_PRACTICAL_P_DONE,
  MAX_PRACTICAL_ATTEMPTS,
} from '../pricing/recombEconomics.js';
import { haveKey } from './stateKey.js';
import { MACRO_IDS, discoverEntropyChains } from './macros.js';
import { beamTrim, makeFrontierEntry } from './pruning.js';
import {
  lowerBound,
  rankCoupledSubsystems,
  completedSideBonus,
  analyzeTagSideClusters,
} from './heuristics.js';
import { donorMiniPlan as donorMiniPlanCore, donorSearch } from './donorSearch.js';

const MAX_DEPTH = 4;
const NODE_CAP = 4000;
const BEAM = 24;

export { MACRO_IDS };

export function roundEv(n) {
  if (n == null || !Number.isFinite(n)) return n;
  return Math.round(n);
}

function genOf(m) {
  return m.gen === 'suffix' ? 'suffix' : 'prefix';
}

export function modKey(m) {
  if (m.match || m.short || m.best || m.method) return affixKey(modsToAffix(m));
  return affixKey(m);
}

function keysOf(mods) {
  return mods.map(modKey).sort();
}

export function keyStr(keys) {
  return haveKey(keys);
}

function notBench(m) {
  return !m.crafted && m.method !== 'bench' && m.match?.source !== 'crafted';
}

/** Native unveil / essence-only finish; stuffing into recomb donors is last resort. */
export function nativeFinish(m) {
  if (m.veiled || m.match?.source === 'unveiled') return true;
  if (m.essenceOnly || m.match?.is_essence_only || m.match?.source === 'essence_only') return true;
  return false;
}

export function recombTransferable(m) {
  return notBench(m) && !nativeFinish(m);
}

function modsToAffix(m) {
  return makeAffix({
    id: m.match?.id ?? m.id,
    text: m.short ?? m.text,
    gen: genOf(m),
    groups: m.groups ?? [],
    tags: m.tags ?? [],
    tier: m.tier,
    spawnWeight: m.hitWeight ?? m.weight ?? 0,
    fractured: m.fractured,
    crafted: m.crafted,
    veiled: m.veiled,
    ofEssence: m.ofEssence,
    essenceOnly: !!(m.match?.is_essence_only || m.match?.source === 'essence_only'),
    source: m.match?.source ?? (m.crafted ? 'crafted' : m.veiled ? 'unveiled' : 'natural'),
    canNaturallyRoll: (m.hitWeight ?? m.weight ?? 0) > 0 && !m.crafted && !m.veiled,
  });
}

export function modsToState(mods, meta) {
  const prefixes = mods.filter((m) => genOf(m) === 'prefix').map(modsToAffix);
  const suffixes = mods.filter((m) => genOf(m) === 'suffix').map(modsToAffix);
  return makeState({
    itemClass: meta.itemClass,
    baseType: meta.baseType,
    itemLevel: meta.itemLevel,
    prefixes,
    suffixes,
    influence: meta.influence,
    fracturedItem: mods.some((m) => m.fractured) || meta.fracturedItem,
  });
}

function hasAffix(state, key) {
  return allAffixes(state).some((a) => affixKey(a) === key);
}

export function classifyVsTarget(state, neededKeys) {
  const have = neededKeys.filter((k) => hasAffix(state, k));
  const extra = allAffixes(state).filter((a) => !neededKeys.includes(affixKey(a)));
  return { have, extra };
}

function costBag(bag, prices) {
  const c = chaosCost(bag, prices);
  return c == null || !Number.isFinite(c) ? Infinity : c;
}

/** Physical smash amounts for EV/display. Prefers averageUnpredictable midpoints. Never 0. */
export function smashFloorBag(model, itemClass) {
  void itemClass;
  const avg = model?.cost?.averageUnpredictable;
  if (avg && ((avg.gold ?? 0) > 0 || (avg['thaumaturgic-dust'] ?? 0) > 0)) {
    return {
      gold: avg.gold ?? 0,
      'thaumaturgic-dust': avg['thaumaturgic-dust'] ?? 0,
      confidence: avg.confidence ?? 'approximate',
      source: avg.source,
      goldBand: avg.goldBand,
      dustBand: avg.dustBand,
    };
  }
  const samples = (model?.cost?.samples ?? []).filter(
    (s) => s.mode !== 'predictable' && ((s.gold ?? 0) > 0 || (s['thaumaturgic-dust'] ?? 0) > 0)
  );
  if (!samples.length) return null;
  const prefer =
    samples.find((s) => s.role === 'defaultAverage' || s.preferredForRanking === true) ?? samples[0];
  return {
    gold: prefer.gold ?? 0,
    'thaumaturgic-dust': prefer['thaumaturgic-dust'] ?? 0,
    confidence: prefer.confidence ?? 'anecdotal',
    source: prefer.source,
    goldBand: prefer.goldBand,
    dustBand: prefer.dustBand,
  };
}

/**
 * Chaos EV of one smash (legacy scalar). Prefer smashResourceEconomics —
 * gold is opportunity-labeled, never silently free or unlabeled market.
 */
export function pricedRecombBag(bag, prices, model, itemClass) {
  const known = Object.fromEntries(
    Object.entries(bag ?? {}).filter(
      ([k, n]) =>
        k !== 'confidence' &&
        k !== 'source' &&
        k !== 'goldBand' &&
        k !== 'dustBand' &&
        n != null &&
        n > 0
    )
  );
  const use = Object.keys(known).length ? known : smashFloorBag(model, itemClass);
  if (!use) return Infinity;
  const eco = smashResourceEconomics(use, prices, model);
  const c = eco.smashEconomicChaos;
  return c > 0 && Number.isFinite(c) ? c : Infinity;
}

/**
 * Compatibility before P(final)/EV: capacity, exclusives, fractured, sources.
 * Model physics stay target-blind; this is optimizer gating only.
 */
export function recombCompatibility(A, B, itemMeta = {}) {
  const reasons = [];
  const all = [...(A ?? []), ...(B ?? [])];
  const nP = all.filter((m) => genOf(m) === 'prefix').length;
  const nS = all.filter((m) => genOf(m) === 'suffix').length;
  if (nP > 6) reasons.push('prefix-pool-overflow');
  if (nS > 6) reasons.push('suffix-pool-overflow');

  const fracA = (A ?? []).filter((m) => m.fractured);
  const fracB = (B ?? []).filter((m) => m.fractured);
  if (fracA.length > 1 || fracB.length > 1) reasons.push('multi-fracture-same-donor');

  // Exclusive / essence-only groups cannot both be required on capacity-starved output
  const groups = new Map();
  for (const m of all) {
    for (const g of m.groups ?? []) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
  }
  for (const [, mods] of groups) {
    if (mods.length > 1 && mods.every((m) => genOf(m) === genOf(mods[0]))) {
      // Same group twice on same gen — impossible to keep both
      reasons.push(`exclusive-group:${mods[0].groups?.[0] ?? 'group'}`);
      break;
    }
  }

  // Bench/crafted goals are not transferable smash targets
  if (all.some((m) => m.crafted || m.method === 'bench' || m.match?.source === 'crafted')) {
    reasons.push('crafted-not-transferable');
  }

  if (itemMeta?.corrupted) reasons.push('corrupted');

  return { ok: reasons.length === 0, reasons };
}

function rollP(p) {
  if (!(p > 0)) return 0;
  return p >= 0.999 ? 1 : p;
}

function attemptsOf(p, cap = 200) {
  const r = rollP(p);
  if (r >= 1) return 1;
  if (!(r > 0)) return cap;
  return expectedAttempts(r, cap);
}

function sharedHarvest(mods) {
  let best = null;
  for (const h of HARVEST_REFORGES) {
    const covered = mods.filter((m) => modMatchesHarvest(m, h));
    if (!covered.length) continue;
    const score = covered.length * 1000;
    if (!best || score > best.score) best = { harvest: h, covered, score };
  }
  return best;
}

/** Same optimizer, shallow — wires sequentialRemaining into donorSearch. */
export function donorMiniPlan(mods, ctx) {
  return donorMiniPlanCore(mods, {
    ...ctx,
    sequentialRemaining,
    modKey,
  });
}

/** Credit of a worse state vs start. Do not subtract this on top of Q = C + E[V]. */
export function salvageValue(vStart, vState) {
  if (!Number.isFinite(vStart) || !Number.isFinite(vState)) return 0;
  return Math.max(0, vStart - vState);
}

/** Partitions from recombinatorModel (fracture-aware). */
export function partitions(mods) {
  return donorPartitions(mods);
}

/**
 * Greedy entropy-reducing finish from this exact have-set.
 * Rebuilds harvest/unveil/exalt pools from occupied groups after each add.
 */
export function sequentialRemaining(haveKeys, ctx) {
  const haveSet = new Set(haveKeys);
  const startKey = ctx.startKey;
  const usePlannerEv =
    keyStr(haveKeys) === (startKey ?? '') && ctx.sequentialCost != null && Number.isFinite(ctx.sequentialCost);

  const all = (ctx.mods ?? []).filter(notBench);
  const haveMods = all.filter((m) => m.fractured || haveSet.has(modKey(m)));
  let rem = all.filter((m) => !m.fractured && !haveSet.has(modKey(m)));
  if (!rem.length) return { ev: 0, ops: [], pools: [], macros: [], remaining: [], reachesTarget: true };

  const { kb, baseTags, prices } = ctx;
  const ilvl = ctx.ilvl ?? ctx.itemMeta?.itemLevel ?? 1;
  const tagClusters = ctx.tagClusters ?? analyzeTagSideClusters(rem);
  const macros = discoverEntropyChains(rem, { ...ctx, tagClusters });
  const harvestOrder = tagClusters.preferredLockSide
    ? tagClusters.sideOrder
    : ['suffix', 'prefix'];
  const exaltOrder = tagClusters.preferredLockSide
    ? tagClusters.sideOrder
    : ['prefix', 'suffix'];
  if (!kb || !baseTags) {
    return {
      ev: usePlannerEv ? ctx.sequentialCost : rem.reduce((s, m) => s + ctx.costOne(m), 0),
      ops: ['costOne'],
      pools: [],
      macros,
      remaining: [],
      reachesTarget: true,
    };
  }

  let occupied = collectOccupiedGroups(haveMods);
  let ev = 0;
  const ops = [];
  const pools = [];

  const essM = rem.find((m) => m.candidates?.some((c) => c.type === 'essence'));
  if (essM) {
    const ess = essM.candidates.find((c) => c.type === 'essence');
    const sibs = rem.filter((m) => m !== essM && m.gen === essM.gen && m.harvests?.length);
    const fish =
      sibs.length >= 2
        ? [sibs.slice().sort((a, b) => (b.hitWeight ?? 0) - (a.hitWeight ?? 0))[0]]
        : sibs;
    const occ = collectOccupiedGroups([...haveMods, essM]);
    const math = fish.length ? multiGenEssenceFishExpected(kb, baseTags, ilvl, fish, essenceExtraRollsByGen(kb, essM.gen || 'prefix'), occ) : null;
    const key = ess.essenceKey || essencePriceKey(ess.essenceName) || 'essence-deafening';
    const att = fish.length ? Math.min(math?.expected ?? 8, 500) : 2;
    ev += costBag({ [key]: att }, prices);
    ops.push('essence');
    rem = rem.filter((m) => m !== essM && !fish.includes(m));
    occupied = collectOccupiedGroups([...haveMods, essM, ...fish]);
  }

  for (const side of harvestOrder) {
    const sideRem = rem.filter((m) => m.gen === side && m.harvests?.length);
    if (!sideRem.length) continue;
    const shared = sharedHarvest(sideRem);
    if (!shared) continue;
    const lock = side === 'suffix' ? METACRAFT.prefixesCannotBeChanged : METACRAFT.suffixesCannotBeChanged;
    const covered = shared.covered.filter((m) => rem.includes(m));
    if (!covered.length) continue;

    // Same-side harvest wipes prior hits — EV = stepCost / P(all targets in one reforge), not Σ independent geometrics.
    const ps = covered.map((m) => {
      const o = harvestGoalOdds(kb, baseTags, ilvl, m, shared.harvest, modMatchesHarvest, occupied);
      return rollP(o.pRoll);
    });
    const pJoint = ps.reduce((a, p) => a * (p > 0 ? p : 0), 1);
    const divineSep = ctx.planOpts?.divineSeparate !== false;
    const oneBag = { ...harvestWithMetacraftCost(shared.harvest, 1) };
    if (divineSep && oneBag.divine) delete oneBag.divine;
    const stepCost = costBag(oneBag, prices);
    const att = attemptsOf(pJoint);
    ev += stepCost * att;
    const pool = harvestEligiblePool(kb, baseTags, ilvl, side, shared.harvest, modMatchesHarvest, occupied);
    pools.push({
      harvest: shared.harvest.id,
      total: pool.total,
      rows: pool.rows,
      p: pJoint,
      stateMachine: covered.length > 1,
      targetCount: covered.length,
      stepPs: ps,
    });
    ops.push(
      covered.length > 1
        ? `${lock.id}+${shared.harvest.id}×${covered.length}(joint)`
        : `${lock.id}+${shared.harvest.id}`
    );
    for (const m of covered) {
      rem = rem.filter((x) => x !== m);
      for (const g of m.groups ?? []) occupied.add(g);
    }
  }

  for (const m of rem.filter((x) => nativeFinish(x) && (x.veiled || x.match?.source === 'unveiled'))) {
    const u = unveilExpected(kb, baseTags, ilvl, m, occupied);
    const divineSep = ctx.planOpts?.divineSeparate !== false;
    ev += costBag({ 'veiled-chaos': u.expected, divine: divineSep ? 0 : 2 * u.expected }, prices);
    ops.push('protect+unveil');
    rem = rem.filter((x) => x !== m);
    for (const g of m.groups ?? []) occupied.add(g);
  }

  for (const gen of exaltOrder) {
    const goals = rem.filter((m) => m.gen === gen);
    if (!goals.length) continue;
    const preferBlocked = [];
    for (const c of tagClusters.clusters ?? []) {
      if (c.oppositeSide === gen) preferBlocked.push(...(c.cannotRollHints ?? []));
    }
    const assist = bestCannotRollAssist(kb, baseTags, ilvl, gen, goals, {
      occupiedGroups: occupied,
      preferBlockedTags: preferBlocked,
    });
    const divineSep = ctx.planOpts?.divineSeparate !== false;
    if (assist) {
      if (!divineSep) ev += costBag({ divine: 2 }, prices);
      ops.push(`cannotRoll+exalt:${assist.id}`);
    }
    for (const m of goals) {
      const x = exaltExpected(kb, assist?.tags ?? baseTags, ilvl, m, occupied);
      const bag = {
        exalt: x.expected,
        annul: Math.max(0, x.expected - 1),
        // §75: divine roll-perfecting stays out of craft EV when divineSeparate
        divine: divineSep || assist ? 0 : x.expected * 2,
      };
      ev += costBag(bag, prices);
      if (!assist) ops.push('exalt');
      pools.push({ p: rollP(x.pRoll), total: x.poolWeight, rows: [] });
      rem = rem.filter((x) => x !== m);
      for (const g of m.groups ?? []) occupied.add(g);
    }
  }

  // §15: finishing a completed side is slightly preferred (never invents cost).
  const neededByGen = {
    prefix: all.filter((m) => genOf(m) === 'prefix').map(modKey),
    suffix: all.filter((m) => genOf(m) === 'suffix').map(modKey),
  };
  const sideBonus = completedSideBonus(modsToState(haveMods, ctx.itemMeta ?? {}), neededByGen);
  if (sideBonus && Number.isFinite(ev)) ev = Math.max(0, ev - sideBonus * 0.5);

  return {
    ev: usePlannerEv ? ctx.sequentialCost : Number.isFinite(ev) ? ev : Infinity,
    ops,
    pools,
    macros,
    remaining: rem.map(modKey),
    reachesTarget: rem.length === 0,
  };
}

/** P(clear all fillers by annul without hitting a keeper) and E[annuls]. */
export function annulClearRisk(keepers, fillers) {
  if (!(fillers > 0)) return { expectedAnnuls: 0, pFail: 0, pSurvive: 1 };
  let k = keepers;
  let f = fillers;
  let pSurvive = 1;
  let expectedAnnuls = 0;
  while (f > 0) {
    const total = k + f;
    if (!(total > 0)) break;
    pSurvive *= f / total;
    expectedAnnuls += total / f;
    f -= 1;
  }
  return { expectedAnnuls, pFail: Math.max(0, 1 - pSurvive), pSurvive };
}

/**
 * Normalize continuation from remainingFromHave(...).
 * Number → sequential finish (0 further recombs). Object may carry nested recomb counts.
 * Craft requires a concrete path to exact target; pFail splits into recovery mass.
 */
function normalizeContinuation(raw) {
  if (raw == null) {
    return {
      ev: 0,
      expectedRecombs: 0,
      expectedDonorARebuilds: 0,
      expectedDonorBRebuilds: 0,
      finishKind: 'final',
      pFail: 0,
      reachesTarget: true,
    };
  }
  if (typeof raw === 'number') {
    return {
      ev: Number.isFinite(raw) ? raw : Infinity,
      expectedRecombs: 0,
      expectedDonorARebuilds: 0,
      expectedDonorBRebuilds: 0,
      finishKind: 'craftNoRecomb',
      pFail: 0,
      reachesTarget: Number.isFinite(raw),
      recipe: null,
    };
  }
  const expectedRecombs =
    raw.expectedRecombs ?? raw.expectedTotalRecombinations ?? raw.expectedRecombinationAttempts ?? 0;
  const finishKind =
    raw.finishKind ??
    (expectedRecombs > 0
      ? 'salvageRequiringAnotherRecombination'
      : raw.benchOnly
        ? 'bench'
        : 'craftNoRecomb');
  return {
    ev: raw.ev ?? 0,
    expectedRecombs,
    expectedDonorARebuilds: raw.expectedDonorARebuilds ?? raw.expectedFullDonorARebuilds ?? 0,
    expectedDonorBRebuilds: raw.expectedDonorBRebuilds ?? raw.expectedFullDonorBRebuilds ?? 0,
    finishKind,
    pFail: raw.pFail ?? 0,
    recovery: raw.recovery ?? null,
    evFail: raw.evFail ?? null,
    expectedRecombsFail: raw.expectedRecombsFail ?? null,
    expectedDonorARebuildsFail: raw.expectedDonorARebuildsFail ?? 0,
    expectedDonorBRebuildsFail: raw.expectedDonorBRebuildsFail ?? 0,
    reachesTarget: raw.reachesTarget !== false,
    recipe: raw.recipe ?? raw.ops ?? null,
    unwanted: raw.unwanted ?? raw.extra ?? null,
    finishingCost: raw.finishingCost ?? raw.ev ?? null,
    proof: raw.proof ?? null,
    invalid: !!raw.invalid,
  };
}

function roundMass(p) {
  return Math.round(p * 1e10) / 1e10;
}

/**
 * Salvage = remaining V from the outcome have-set (not donor rebuild, not remKeys×costOne).
 * State-graph expectations (never clamp E_recombs to 1 because salvage exists):
 *   E_recombs(final) = 0
 *   E_recombs(S) = 1 + Σ P(o)·E_recombs(o)   with bricks → S again → / (1−P(brick))
 * EV(S) = (attemptCost + Σ P(partial)×V(partial)) / (1 − P(brick))
 *
 * Outcome mass buckets (must sum to ~1):
 *   final | salvage bench-only | craft no-recomb | another recomb | brick/restart
 *
 * Craft = concrete path to exact target without another recomb/restart on the success branch.
 * Finishing fail mass (annul hits keeper, etc.) is classified as restart/recombAgain and recursed.
 */
export function evWithSalvage(dist, neededKeys, C, remainingFromHave) {
  let pBrick = 0;
  let salvage = 0;
  let pDone = 0;
  let finishMass = 0;
  let sumP_Er = 0;
  let sumP_Ea = 0;
  let sumP_Eb = 0;
  let continuationRecombMass = 0;
  let pBenchOnly = 0;
  let pCraftNoRecomb = 0;
  let pNeedsRecomb = 0;
  let outcomeMass = 0;
  let craftWithoutPath = 0;
  const outcomeLines = [];
  const classMap = new Map();

  function addClass(row) {
    const key = [
      row.kind,
      row.have?.slice().sort().join(',') ?? '',
      (row.unwanted ?? []).length,
      row.recipe?.join?.('→') ?? row.recipe ?? '',
      row.finishKind ?? '',
    ].join('|');
    const prev = classMap.get(key);
    if (prev) {
      prev.p += row.p;
      return;
    }
    classMap.set(key, { ...row });
  }

  for (const o of dist.outcomes) {
    outcomeMass += o.p;
    const destroyed = o.destroyed || o.state == null;
    const { have, extra } = destroyed
      ? { have: [], extra: [] }
      : classifyVsTarget(o.state, neededKeys);
    const unwanted = (extra ?? []).map((a) => a.text ?? affixKey(a));

    if (!destroyed && have.length === neededKeys.length) {
      pDone += o.p;
      addClass({ p: o.p, kind: 'FINAL', have, unwanted, ev: 0, expectedRecombs: 0, pFail: 0 });
      continue;
    }
    if (destroyed || !have.length) {
      pBrick += o.p;
      addClass({ p: o.p, kind: 'BRICK', have, unwanted, ev: null, expectedRecombs: null, pFail: 1 });
      continue;
    }

    // Support (have) and (have, detail) call shapes
    let rawCont;
    try {
      rawCont = remainingFromHave(have, { extra, unwanted, state: o.state, neededKeys });
    } catch {
      rawCont = remainingFromHave(have);
    }
    const cont = normalizeContinuation(rawCont);

    const pFail = Math.max(0, Math.min(1, cont.pFail ?? 0));
    const pOk = 1 - pFail;
    const isCraftish =
      cont.finishKind === 'bench' ||
      cont.finishKind === 'craftNoRecomb' ||
      (cont.expectedRecombs <= 0 && cont.finishKind !== 'salvageRequiringAnotherRecombination');

    if (isCraftish && cont.expectedRecombs <= 0) {
      if (!cont.reachesTarget || cont.invalid || !(Number.isFinite(cont.ev) || cont.ev === 0)) {
        craftWithoutPath += o.p * pOk;
      }
      // Success branch → craft/bench
      if (pOk > 1e-15) {
        const mass = o.p * pOk;
        salvage += mass * (cont.ev ?? 0);
        finishMass += mass;
        if (cont.finishKind === 'bench') pBenchOnly += mass;
        else pCraftNoRecomb += mass;
        addClass({
          p: mass,
          kind: cont.finishKind === 'bench' ? 'BENCH' : 'CRAFT',
          have,
          unwanted,
          remaining: neededKeys.filter((k) => !have.includes(k)),
          ev: cont.ev,
          finishingCost: cont.finishingCost ?? cont.ev,
          expectedRecombs: 0,
          finishKind: cont.finishKind,
          recipe: cont.recipe,
          pFail: 0,
          reachesTarget: cont.reachesTarget,
          proof: cont.proof,
        });
      }
      // Fail branch → restart or another recomb
      if (pFail > 1e-15) {
        const mass = o.p * pFail;
        if (cont.recovery === 'recombAgain' && Number.isFinite(cont.evFail)) {
          salvage += mass * cont.evFail;
          finishMass += mass;
          sumP_Er += mass * (cont.expectedRecombsFail ?? 1);
          sumP_Ea += mass * (cont.expectedDonorARebuildsFail ?? 1);
          sumP_Eb += mass * (cont.expectedDonorBRebuildsFail ?? 0);
          continuationRecombMass += mass;
          pNeedsRecomb += mass;
          addClass({
            p: mass,
            kind: 'RECOMB_AGAIN',
            have,
            unwanted,
            remaining: neededKeys.filter((k) => !have.includes(k)),
            ev: cont.evFail,
            expectedRecombs: cont.expectedRecombsFail ?? 1,
            finishKind: 'salvageRequiringAnotherRecombination',
            pFail: 1,
            recovery: 'recombAgain',
            recipe: cont.recipe,
          });
        } else {
          pBrick += mass;
          addClass({
            p: mass,
            kind: 'BRICK',
            have,
            unwanted,
            ev: null,
            expectedRecombs: null,
            pFail: 1,
            recovery: cont.recovery ?? 'restart',
            recipe: cont.recipe,
          });
        }
      }
      continue;
    }

    // Another recomb (or craft with nested recombs on the primary path)
    salvage += o.p * cont.ev;
    finishMass += o.p;
    sumP_Er += o.p * cont.expectedRecombs;
    sumP_Ea += o.p * cont.expectedDonorARebuilds;
    sumP_Eb += o.p * cont.expectedDonorBRebuilds;
    if (cont.expectedRecombs > 0) {
      continuationRecombMass += o.p;
      pNeedsRecomb += o.p;
    } else if (cont.finishKind === 'bench') {
      pBenchOnly += o.p;
    } else {
      pCraftNoRecomb += o.p;
      if (!cont.reachesTarget || cont.invalid) craftWithoutPath += o.p;
    }
    addClass({
      p: o.p,
      kind:
        cont.expectedRecombs > 0
          ? 'RECOMB_AGAIN'
          : cont.finishKind === 'bench'
            ? 'BENCH'
            : 'CRAFT',
      have,
      unwanted,
      remaining: neededKeys.filter((k) => !have.includes(k)),
      ev: cont.ev,
      finishingCost: cont.finishingCost ?? cont.ev,
      expectedRecombs: cont.expectedRecombs,
      finishKind: cont.finishKind,
      recipe: cont.recipe,
      pFail,
      recovery: cont.recovery,
      reachesTarget: cont.reachesTarget,
      proof: cont.proof,
    });
  }

  void outcomeLines;
  const fallbacks = [...classMap.values()].sort((a, b) => b.p - a.p);
  const craftClasses = fallbacks.filter((f) => f.kind === 'CRAFT' || f.kind === 'BENCH');
  const listedCraftMass = craftClasses.reduce((s, f) => s + f.p, 0);

  if (pBrick >= 0.999) {
    return {
      ev: Infinity,
      pDone: 0,
      pBrick: 1,
      fallbacks: [],
      craftOutcomes: [],
      expectedAttempts: Infinity,
      expectedTotalRecombinationsUntilFinished: Infinity,
      expectedFullDonorARebuilds: Infinity,
      expectedFullDonorBRebuilds: Infinity,
      expectedPartialStateReuses: 0,
      directFinalProbabilityPerRecombination: 0,
      eventualCompletionProbability: 0,
      expectedContinuationRecombMass: 0,
      craftWithoutPath: 0,
      outcomeMass: {
        final: 0,
        salvageBenchOnly: 0,
        salvageCraftNoRecomb: 0,
        salvageRequiringAnotherRecombination: 0,
        brickRestart: 1,
        sum: 1,
      },
      stateEvDebug: ['State: all mass bricks — EV diverges'],
    };
  }

  const denom = 1 - pBrick;
  const expectedTotalRecombinations = (1 + sumP_Er) / denom;
  const expectedFullDonorARebuilds = (1 + sumP_Ea) / denom;
  const expectedFullDonorBRebuilds = (1 + sumP_Eb) / denom;
  const expectedPartialStateReuses = finishMass / denom;
  const ev = (C + salvage) / denom;
  // With brick retries, absorption at final = 1 iff every non-brick path reaches target (from graph).
  const eventualFromGraph =
    denom > 0 && Number.isFinite(ev) && craftWithoutPath < 1e-9
      ? 1
      : denom > 0 && Number.isFinite(ev)
        ? Math.max(0, 1 - craftWithoutPath / Math.max(denom, 1e-12))
        : 0;

  const mass = {
    final: roundMass(pDone),
    salvageBenchOnly: roundMass(pBenchOnly),
    salvageCraftNoRecomb: roundMass(pCraftNoRecomb),
    salvageRequiringAnotherRecombination: roundMass(pNeedsRecomb),
    brickRestart: roundMass(pBrick),
    sum: roundMass(pDone + pBenchOnly + pCraftNoRecomb + pNeedsRecomb + pBrick),
    rawOutcomeSum: roundMass(outcomeMass),
    craftListedMass: roundMass(listedCraftMass),
    craftWithoutPath: roundMass(craftWithoutPath),
  };

  // Keep-count aggregates so unexplained craft mass is visible
  const byKeep = new Map();
  for (const f of craftClasses) {
    const k = f.have?.length ?? 0;
    byKeep.set(k, (byKeep.get(k) ?? 0) + f.p);
  }
  const keepAgg = [...byKeep.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, p]) => `${formatPctPrecise(p)} craft keep ${k}/${neededKeys.length}`);

  const top = fallbacks.slice(0, 12);
  const stateEvDebug = [
    `State S0: need ${neededKeys.length} desired`,
    `attempt cost: ${Number.isFinite(C) ? Math.round(C * 100) / 100 : C}`,
    ...top.map((row) => {
      const pct = formatPctPrecise(row.p);
      if (row.kind === 'FINAL') return `${pct} -> FINAL`;
      if (row.kind === 'BRICK') return `${pct} -> restart`;
      if (row.kind === 'BENCH') {
        return `${pct} -> bench only (keep ${row.have.length}/${neededKeys.length}; recipe ${(row.recipe ?? []).join?.('→') ?? row.recipe ?? 'bench'})`;
      }
      if (row.kind === 'CRAFT') {
        const rec = Array.isArray(row.recipe) ? row.recipe.join('→') : row.recipe ?? '?';
        const un = (row.unwanted ?? []).length ? `; unwanted ${(row.unwanted ?? []).length}` : '';
        const fail = row.pFail > 0 ? `; P(fail)=${formatPctPrecise(row.pFail)}` : '';
        return `${pct} -> craft (keep ${row.have.length}/${neededKeys.length}; ~${Math.round(row.ev ?? 0)}c; ${rec}${un}${fail})`;
      }
      const er =
        row.expectedRecombs > 0 ? ` +${Math.round(row.expectedRecombs * 100) / 100} recombs` : '';
      return `${pct} -> another recomb (keep ${row.have.length}/${neededKeys.length}${er})`;
    }),
    keepAgg.length ? `Craft by keep-count: ${keepAgg.join('; ')}` : null,
    `Listed classes cover ${formatPctPrecise(fallbacks.reduce((s, f) => s + f.p, 0))} (need ~100%)`,
    `${formatPctPrecise(mass.final)} -> FINAL`,
    `${formatPctPrecise(mass.salvageBenchOnly)} -> bench only`,
    `${formatPctPrecise(mass.salvageCraftNoRecomb)} -> craft, no recomb`,
    `${formatPctPrecise(mass.salvageRequiringAnotherRecombination)} -> another recomb`,
    `${formatPctPrecise(mass.brickRestart)} -> restart`,
    `Expected recombs ${Math.round(expectedTotalRecombinations * 100) / 100} / Donor A constructions ${Math.round(expectedFullDonorARebuilds * 100) / 100} / Donor B constructions ${Math.round(expectedFullDonorBRebuilds * 100) / 100}`,
    `E_recombs(S0)=${Math.round(expectedTotalRecombinations * 100) / 100}; directFinal=${formatPctPrecise(pDone)}; eventual≈${formatPctPrecise(eventualFromGraph)} (from graph)`,
    `EV(S0) = (attemptCost + Σ P×EV(next)) / (1-pBrick) = ${Number.isFinite(ev) ? Math.round(ev) : ev}`,
    craftWithoutPath > 1e-9
      ? `INVALID: craft mass without path to exact target ${formatPctPrecise(craftWithoutPath)}`
      : null,
  ].filter(Boolean);

  return {
    ev,
    pDone,
    pBrick,
    salvage,
    finishMass,
    expectedAttempts: expectedTotalRecombinations,
    expectedTotalRecombinationsUntilFinished: expectedTotalRecombinations,
    expectedFullDonorARebuilds,
    expectedFullDonorBRebuilds,
    expectedPartialStateReuses,
    directFinalProbabilityPerRecombination: pDone,
    eventualCompletionProbability: eventualFromGraph,
    expectedContinuationRecombMass: continuationRecombMass,
    outcomeMass: mass,
    stateEvDebug,
    craftWithoutPath,
    craftOutcomes: craftClasses,
    fallbacks,
  };
}

/**
 * Score Unpredictable and Predictable as separate O.
 * Missing displayedChance → Predictable unranked (never invent %).
 * Ranking EV = full economic (donors + smash resources labeled + finish − salvage path).
 */
function scoreRecombOp(op, A, B, vA, vB, needKeys, ctx, itemMeta, model, remainingFromHave) {
  const compat = recombCompatibility(A, B, itemMeta);
  if (!compat.ok) {
    return {
      ev: Infinity,
      unranked: true,
      operator: op,
      reason: `incompatible:${compat.reasons.join(',')}`,
      compatibility: compat,
    };
  }

  const mode = op === OPERATOR_PREDICTABLE ? 'predictable' : 'unpredictable';
  const stateA = modsToState(A, itemMeta);
  const stateB = modsToState(B, itemMeta);
  const bag = recombineCost(stateA, stateB, model, mode);
  const smashEco = smashResourceEconomics(bag, ctx.prices, model, ctx.planOpts ?? {});
  const donorCost = (vA.ev ?? 0) + (vB.ev ?? 0);
  if (!Number.isFinite(donorCost)) {
    return { ev: Infinity, unranked: true, operator: op, reason: 'unpriced-donors' };
  }
  if (!(smashEco.smashEconomicChaos > 0) && !(smashEco.gold > 0 || smashEco.dust > 0)) {
    return { ev: Infinity, unranked: true, operator: op, reason: 'unpriced-smash' };
  }

  // Attempt cost: donor rebuild + smash economic (dust eq + gold opportunity).
  // Tradable-only variant excludes gold opportunity (labeled separately in report).
  const Ceconomic = donorCost + smashEco.smashEconomicChaos;
  const Ctradable = donorCost + (smashEco.smashTradableChaos ?? 0);

  let dist;
  if (op === OPERATOR_PREDICTABLE) {
    const chance = ctx.displayedChance ?? ctx.predictableChance ?? ctx.pDisplay;
    dist = predictableRecombine(
      stateA,
      stateB,
      { displayedChance: chance, selected: ctx.predictableSelected, baseChoice: ctx.baseChoice ?? 'either' },
      model
    );
    if (dist.unranked || !dist.outcomes?.length) {
      return {
        ev: Infinity,
        unranked: true,
        operator: op,
        reason: dist.reason ?? 'unknown-displayed-chance',
        recombCost: smashEco.smashEconomicChaos,
        recombBag: bag,
        smashEconomics: smashEco,
        experimental: true,
      };
    }
  } else {
    dist = unpredictableRecombine(stateA, stateB, model);
    if (!dist.outcomes?.length) {
      return { ev: Infinity, unranked: true, operator: op, reason: 'empty-dist' };
    }
  }

  const combEco = evWithSalvage(dist, needKeys, Ceconomic, remainingFromHave);
  const combTrad = evWithSalvage(dist, needKeys, Ctradable, remainingFromHave);

  if (
    !(combEco.pDone > MIN_PRACTICAL_P_DONE) ||
    combEco.expectedTotalRecombinationsUntilFinished > MAX_PRACTICAL_ATTEMPTS
  ) {
    return {
      ev: Infinity,
      unranked: true,
      operator: op,
      reason:
        !(combEco.pDone > MIN_PRACTICAL_P_DONE)
          ? `impractical-pDone:${formatPctPrecise(combEco.pDone)}`
          : 'impractical-attempts',
      pDone: combEco.pDone,
      pBrick: combEco.pBrick,
      directFinalProbabilityPerRecombination: combEco.directFinalProbabilityPerRecombination,
      expectedTotalRecombinationsUntilFinished: combEco.expectedTotalRecombinationsUntilFinished,
      recombBag: bag,
      smashEconomics: smashEco,
      experimental: true,
    };
  }

  // Salvage-aware EV already satisfies EV ≥ smash × E_recombs; do not raise by 1/pDone.
  const ev = combEco.ev;
  const evTradable = combTrad.ev;

  // Finishing EV embedded in salvage path; isolate expected finish mass contribution
  const expectedFinishing =
    combEco.finishMass > 0 && Number.isFinite(combEco.salvage)
      ? combEco.salvage / (1 - combEco.pBrick)
      : 0;

  // Salvage credit vs ignoring partials: not subtracted from donor gross
  const expectedSalvageCredit = 0;

  const node = {
    ev,
    evTradable,
    unranked: false,
    operator: op,
    method: op === OPERATOR_PREDICTABLE ? 'predictableRecombine' : 'recombine',
    partition: [A, B],
    left: vA,
    right: vB,
    costA: vA.ev,
    costB: vB.ev,
    // Gross one-time donor construction (recipe/scoring EV) — never net of post-recomb salvage
    donorAConstructionEv: vA.ev,
    donorBConstructionEv: vB.ev,
    baseAcquisitionUnknown: !!(
      vA.baseAcquisitionUnknown ||
      vB.baseAcquisitionUnknown ||
      vA.mini?.baseAcquisitionUnknown ||
      vB.mini?.baseAcquisitionUnknown ||
      vA.recipe?.baseAcquisitionUnknown ||
      vB.recipe?.baseAcquisitionUnknown
    ),
    recombCost: smashEco.smashEconomicChaos,
    recombBag: bag,
    smashEconomics: smashEco,
    pDone: combEco.pDone,
    pBrick: combEco.pBrick,
    directFinalProbabilityPerRecombination: combEco.directFinalProbabilityPerRecombination,
    eventualCompletionProbability: combEco.eventualCompletionProbability,
    expectedRecombinationAttempts: combEco.expectedTotalRecombinationsUntilFinished,
    expectedTotalRecombinationsUntilFinished: combEco.expectedTotalRecombinationsUntilFinished,
    expectedFullDonorARebuilds: combEco.expectedFullDonorARebuilds,
    expectedFullDonorBRebuilds: combEco.expectedFullDonorBRebuilds,
    expectedPartialStateReuses: combEco.expectedPartialStateReuses,
    expectedContinuationRecombMass: combEco.expectedContinuationRecombMass,
    outcomeMass: combEco.outcomeMass,
    expectedFinishingCostChaos: expectedFinishing,
    expectedSalvageChaos: combEco.salvage,
    expectedSalvageCredit,
    craftWithoutPath: combEco.craftWithoutPath ?? 0,
    craftOutcomes: combEco.craftOutcomes ?? [],
    stateEvDebug: combEco.stateEvDebug,
    fallbacks: combEco.fallbacks,
    risk: {
      canBrickKeeper: (combEco.pBrick ?? 0) > 0.05,
      canDestroyInputs: true,
      restartRequiredProbability: combEco.pBrick ?? 0,
    },
    displayedChance: dist.displayedChance ?? null,
    experimental: true,
    compatibility: compat,
  };
  node.economics = buildRecombCostReport(node, {
    prices: ctx.prices,
    model,
    ...(ctx.planOpts ?? {}),
  });
  // Invariant / reconcile failure → do not rank
  if (node.economics?.economicsInvalid || node.economics?.impractical) {
    node.ev = Infinity;
    node.unranked = true;
    node.reason = node.economics?.impracticalReason ?? 'economics-invalid';
  }
  if ((combEco.craftWithoutPath ?? 0) > 1e-6) {
    node.ev = Infinity;
    node.unranked = true;
    node.reason = 'craft-without-path';
  }
  // Rank on full economic EV; never allow ~0 when donors cost > 0
  if ((donorCost > 1 || smashEco.smashEconomicChaos > 1) && !(node.ev > 0) && !node.unranked) {
    node.ev = Infinity;
    node.unranked = true;
    node.reason = 'zero-ev-with-positive-donors';
  }
  return node;
}

function considerBothOps(A, B, vA, vB, needKeys, ctx, itemMeta, model, remainingFromHave) {
  const u = scoreRecombOp(OPERATOR_UNPREDICTABLE, A, B, vA, vB, needKeys, ctx, itemMeta, model, remainingFromHave);
  const p = scoreRecombOp(OPERATOR_PREDICTABLE, A, B, vA, vB, needKeys, ctx, itemMeta, model, remainingFromHave);
  const ranked = [u, p].filter((x) => !x.unranked && Number.isFinite(x.ev));
  ranked.sort((a, b) => a.ev - b.ev);
  return { best: ranked[0] ?? null, unpredictable: u, predictable: p };
}

/**
 * Memoized V(S)=min Q. Beam + Pareto over recomb partitions; LB prune; sanity floor.
 */
export function solveValue(ctx) {
  const model = getRecombinatorModel(ctx.kb);
  const all = (ctx.mods ?? []).filter(notBench);
  const transfer = all.filter(recombTransferable);
  const native = all.filter((m) => nativeFinish(m));
  const byKey = new Map(all.map((m) => [modKey(m), m]));
  const itemMeta = ctx.itemMeta;
  const neededAll = keysOf(all);
  const neededTransfer = keysOf(transfer);
  const startHave = keysOf(all.filter((m) => m.fractured));
  ctx.startKey = keyStr(startHave);
  ctx.sequentialRemaining = sequentialRemaining;
  ctx.modKey = modKey;

  const memoT = new Map();
  const memoM = new Map();
  let nodes = 0;

  const coupled = rankCoupledSubsystems(transfer, ctx.costOne);

  function modsFromKeys(keys) {
    return keys.map((k) => byKey.get(k)).filter(Boolean);
  }

  function Vmake(keys, depth) {
    const rng = modsFromKeys(keys).filter(notBench);
    const k = keyStr(keysOf(rng));
    if (!rng.length) return { ev: 0, method: 'done' };
    if (memoM.has(k)) return memoM.get(k);

    const mini = donorMiniPlan(rng, ctx);
    const deep = donorSearch(rng, ctx, 0);
    let best = {
      ev: Math.min(mini.ev, deep.ev),
      method: deep.ev < mini.ev ? deep.method : mini.method,
      mods: rng,
      mini: deep.ev < mini.ev ? deep : mini,
      recipe: (deep.ev < mini.ev ? deep : mini).recipe,
      baseAcquisitionUnknown: !!(deep.ev < mini.ev ? deep : mini).baseAcquisitionUnknown,
      lb: lowerBound(rng.filter((m) => !m.fractured), ctx.costOne),
    };
    if (rng.length === 1) {
      const one = Math.min(ctx.costOne(rng[0]), best.ev);
      best = {
        ...best,
        ev: one,
        method: one < best.ev - 1e-9 ? 'manufacture' : best.method,
        mods: rng,
      };
      memoM.set(k, best);
      return best;
    }
    memoM.set(k, best);
    if (depth >= MAX_DEPTH || nodes > NODE_CAP) return best;

    const frontier = [];
    for (const [A, B] of donorPartitions(rng)) {
      nodes++;
      const vA = Vmake(keysOf(A), depth + 1);
      const vB = Vmake(keysOf(B), depth + 1);
      const bag = recombineCost(modsToState(A, itemMeta), modsToState(B, itemMeta), model);
      const rc = pricedRecombBag(bag, ctx.prices, model, itemMeta?.itemClass);
      const C = vA.ev + vB.ev + rc;
      const lb = (vA.lb ?? 0) + (vB.lb ?? 0) + (Number.isFinite(rc) ? rc : 0);
      if (!(C < best.ev) && !(lb < best.ev)) continue;
      frontier.push(
        makeFrontierEntry(modsToState([...A, ...B], itemMeta), keysOf(rng), C, lb, {
          A,
          B,
          vA,
          vB,
          bag,
          rc,
        })
      );
    }

    for (const e of beamTrim(frontier, BEAM)) {
      const scored = considerBothOps(e.A, e.B, e.vA, e.vB, keysOf(rng), ctx, itemMeta, model, (have) => {
        const v = Vmake(have, depth + 1);
        return {
          ev: v.ev,
          expectedRecombs: v.expectedTotalRecombinationsUntilFinished ?? v.expectedRecombinationAttempts ?? 0,
          expectedDonorARebuilds: v.expectedFullDonorARebuilds ?? 0,
          expectedDonorBRebuilds: v.expectedFullDonorBRebuilds ?? 0,
          reachesTarget: true,
          recipe: v.ops ?? v.mini?.ops ?? null,
        };
      });
      if (scored.best && scored.best.ev < best.ev) {
        best = {
          ...scored.best,
          neededN: rng.length,
          lb: e.lb,
          whySplit: 'Lowest donor + realistic salvage EV for this subset.',
          altOp:
            scored.best.operator === OPERATOR_UNPREDICTABLE ? scored.predictable : scored.unpredictable,
        };
      }
    }
    memoM.set(k, best);
    return best;
  }

  function Vtarget(haveKeys, depth) {
    const k = keyStr(haveKeys);
    if (memoT.has(k)) return memoT.get(k);
    const haveSet = new Set(haveKeys);
    const missing = neededAll.filter((x) => !haveSet.has(x));
    if (!missing.length) {
      const done = { ev: 0, method: 'done' };
      memoT.set(k, done);
      return done;
    }
    const seq = sequentialRemaining(haveKeys, ctx);
    const lb = lowerBound(
      missing.map((x) => byKey.get(x)).filter(Boolean),
      ctx.costOne
    );
    let best = {
      ev: seq.ev,
      method: 'sequential',
      seq,
      ops: seq.ops,
      pools: seq.pools,
      macros: seq.macros,
      lb,
    };
    let recombAlt = null;
    let predictableAlt = null;
    memoT.set(k, best);
    const atStart = keyStr(haveKeys) === ctx.startKey;
    if (!atStart || depth >= MAX_DEPTH || nodes > NODE_CAP) return best;

    // Prefer exploring highly coupled subsystems first (§14).
    const preferred = new Set(
      coupled
        .slice(0, 4)
        .flatMap((c) => c.mods.map(modKey))
    );
    const parts = [...donorPartitions(transfer)].sort((a, b) => {
      const score = (pair) => pair.flat().reduce((s, m) => s + (preferred.has(modKey(m)) ? 1 : 0), 0);
      return score(b) - score(a);
    });

    const frontier = [];
    for (const [A, B] of parts) {
      nodes++;
      const vA = Vmake(keysOf(A), depth + 1);
      const vB = Vmake(keysOf(B), depth + 1);
      const bag = recombineCost(modsToState(A, itemMeta), modsToState(B, itemMeta), model);
      const rc = pricedRecombBag(bag, ctx.prices, model, itemMeta?.itemClass);
      const C = vA.ev + vB.ev + rc;
      if (!Number.isFinite(C)) continue;
      const partLb = (vA.lb ?? vA.ev) + (vB.lb ?? vB.ev) + rc;
      if (partLb >= best.ev) continue;
      frontier.push(
        makeFrontierEntry(modsToState([...A, ...B], itemMeta), neededAll, C, partLb, {
          A,
          B,
          vA,
          vB,
          bag,
          rc,
        })
      );
    }

    for (const e of beamTrim(frontier, BEAM)) {
      const scored = considerBothOps(
        e.A,
        e.B,
        e.vA,
        e.vB,
        neededAll,
        ctx,
        itemMeta,
        model,
        (have, detail = {}) => {
          const haveSet = new Set(have);
          const missingKeys = neededAll.filter((k) => !haveSet.has(k));
          if (!missingKeys.length) {
            const extras = detail.extra ?? [];
            if (extras.length) {
              // Exact desired set present but fillers remain — annul to clean, risk keepers
              const risk = annulClearRisk(have.length, extras.length);
              const annulUnit = costBag({ annul: 1 }, ctx.prices);
              const finishCost = (risk.expectedAnnuls || 0) * (Number.isFinite(annulUnit) ? annulUnit : 0);
              if (risk.pFail > 1e-9) {
                return {
                  ev: finishCost,
                  finishingCost: finishCost,
                  expectedRecombs: 0,
                  pFail: risk.pFail,
                  recovery: 'restart',
                  finishKind: 'craftNoRecomb',
                  reachesTarget: true,
                  recipe: ['annul-fillers'],
                  unwanted: detail.unwanted ?? extras.map((a) => a.text ?? affixKey(a)),
                  proof: {
                    retained: have,
                    unwanted: detail.unwanted,
                    recipe: ['annul-fillers'],
                    finishingCost: finishCost,
                    pFail: risk.pFail,
                    recovery: 'restart',
                  },
                };
              }
            }
            return { ev: 0, expectedRecombs: 0, finishKind: 'final', reachesTarget: true, pFail: 0 };
          }
          const missingMods = missingKeys.map((k) => byKey.get(k)).filter(Boolean);
          const transferMiss = missingMods.filter(recombTransferable);
          const seq = sequentialRemaining(have, ctx);
          const benchOnly =
            missingMods.length > 0 &&
            missingMods.every((m) => m.crafted || m.method === 'bench') &&
            !(detail.extra ?? []).length;
          const extras = detail.extra ?? [];
          const risk = annulClearRisk(have.length, extras.length);
          const annulUnit = costBag({ annul: 1 }, ctx.prices);
          const annulCost =
            (risk.expectedAnnuls || 0) * (Number.isFinite(annulUnit) ? annulUnit : 0);
          const recipe = [...(extras.length ? ['annul-fillers'] : []), ...(seq.ops ?? [])];
          const reaches = !!seq.reachesTarget && Number.isFinite(seq.ev);

          const finishBase = {
            unwanted: detail.unwanted ?? extras.map((a) => a.text ?? affixKey(a)),
            recipe,
            reachesTarget: reaches,
            finishingCost: reaches ? (seq.ev ?? 0) + annulCost : null,
            proof: {
              retained: have,
              unwanted: detail.unwanted ?? extras.map((a) => a.text ?? affixKey(a)),
              recipe,
              finishingCost: reaches ? (seq.ev ?? 0) + annulCost : null,
              pFail: risk.pFail,
              recovery: risk.pFail > 0 ? 'restart' : null,
            },
          };

          if (!transferMiss.length) {
            if (!reaches) {
              return {
                ...finishBase,
                ev: Infinity,
                expectedRecombs: 0,
                finishKind: 'craftNoRecomb',
                invalid: true,
                reachesTarget: false,
                pFail: 0,
              };
            }
            return {
              ...finishBase,
              ev: (seq.ev ?? 0) + annulCost,
              expectedRecombs: 0,
              expectedDonorARebuilds: 0,
              expectedDonorBRebuilds: 0,
              finishKind: benchOnly ? 'bench' : 'craftNoRecomb',
              pFail: risk.pFail,
              recovery: risk.pFail > 0 ? 'restart' : null,
            };
          }

          // Missing transferable mods: another recomb unless sequential finish is strictly cheaper
          // AND proven to reach target. Annul-risk fail mass → restart (not silent craft).
          const vMiss = Vmake(keysOf(transferMiss), depth + 1);
          const floor = smashFloorBag(model, itemMeta?.itemClass);
          const rc = floor ? pricedRecombBag(floor, ctx.prices, model, itemMeta?.itemClass) : Infinity;
          const nestedE =
            vMiss.expectedTotalRecombinationsUntilFinished ?? vMiss.expectedRecombinationAttempts;
          const recombAgainEv =
            Number.isFinite(vMiss.ev) && Number.isFinite(rc) ? vMiss.ev + rc : Infinity;
          const seqEv = reaches ? (seq.ev ?? 0) + annulCost : Infinity;

          if (Number.isFinite(seqEv) && seqEv + 1e-6 < recombAgainEv) {
            return {
              ...finishBase,
              ev: seqEv,
              expectedRecombs: 0,
              expectedDonorARebuilds: 0,
              expectedDonorBRebuilds: 0,
              finishKind: 'craftNoRecomb',
              pFail: risk.pFail,
              recovery: risk.pFail > 0 ? 'restart' : null,
              evFail: recombAgainEv,
              expectedRecombsFail: Number.isFinite(nestedE) && nestedE > 0 ? nestedE : 1,
              expectedDonorARebuildsFail: vMiss.expectedFullDonorARebuilds ?? 1,
              expectedDonorBRebuildsFail: vMiss.expectedFullDonorBRebuilds ?? 0,
            };
          }

          return {
            ...finishBase,
            ev: Number.isFinite(recombAgainEv) ? recombAgainEv : seqEv,
            expectedRecombs: Number.isFinite(nestedE) && nestedE > 0 ? nestedE : 1,
            expectedDonorARebuilds: vMiss.expectedFullDonorARebuilds ?? 1,
            expectedDonorBRebuilds: vMiss.expectedFullDonorBRebuilds ?? 0,
            finishKind: 'salvageRequiringAnotherRecombination',
            pFail: 0,
            reachesTarget: true,
            recipe: ['recomb-missing', ...(vMiss.ops ?? [])],
          };
        }
      );
      const nP = e.A.filter((m) => genOf(m) === 'prefix').length;
      const nS = e.A.filter((m) => genOf(m) === 'suffix').length;
      const why =
        nP > 0 && nS > 0
          ? 'Mixed prefix/suffix donors were cheaper to manufacture than a same-side split.'
          : 'This partition had the lowest donor + salvage EV.';

      if (!scored.unpredictable.unranked) {
        const u = {
          ...scored.unpredictable,
          neededN: neededTransfer.length,
          lb: e.lb,
          whySplit: why,
          seq,
          macros: seq.macros,
        };
        if (!recombAlt || u.ev < recombAlt.ev) recombAlt = u;
        if (u.ev < best.ev) best = u;
      }
      if (!scored.predictable.unranked) {
        const pNode = {
          ...scored.predictable,
          neededN: neededTransfer.length,
          lb: e.lb,
          whySplit: why,
          seq,
          macros: seq.macros,
        };
        if (!predictableAlt || pNode.ev < predictableAlt.ev) predictableAlt = pNode;
        if (pNode.ev < best.ev) best = pNode;
      } else if (!predictableAlt) {
        predictableAlt = scored.predictable;
      }
    }

    if (best.method === 'sequential') {
      if (recombAlt) best.recombAlt = recombAlt;
      if (predictableAlt) best.predictableAlt = predictableAlt;
    } else if (best.operator === OPERATOR_UNPREDICTABLE && predictableAlt) {
      best.predictableAlt = predictableAlt;
    } else if (best.operator === OPERATOR_PREDICTABLE && recombAlt) {
      best.recombAlt = recombAlt;
    }
    memoT.set(k, best);
    return best;
  }

  const best = Vtarget(startHave, 0);
  return {
    best,
    model,
    meta: modelMeta(model),
    startHave,
    neededAll,
    neededTransfer,
    native,
    transfer,
    sequential: sequentialRemaining(startHave, ctx),
    coupled,
    memoSize: memoT.size + memoM.size,
    nodes,
    operatorsCompeting: [OPERATOR_UNPREDICTABLE, OPERATOR_PREDICTABLE],
  };
}

export { OPERATOR_UNPREDICTABLE, OPERATOR_PREDICTABLE };
