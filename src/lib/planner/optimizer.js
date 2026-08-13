/**
 * Layer B optimizer — strategy lives here only (§1–5).
 * Production entry: craftPlanner → optimizeCraft (not recipe generators).
 */
import { loadKnowledgeBase, getBaseInfo, effectiveBaseTags, resolveCannotRoll } from '../knowledgeLoader.js';
import { normalizeItemClass } from '../itemClass.js';
import { rulesetVersion } from '../ruleset.js';
import { classifyPlan, planSummaryLine } from '../planClass.js';
import { recommendInfluenceAcquisition, formatCostBreakdown, chaosCost } from '../craftKnowledge.js';
import { considerRecombinator } from '../recombinatorSearch.js';
import { solveValue, roundEv, modKey, sequentialRemaining } from './valueFunction.js';
import { fractureByEv, defaultPlanOptions, baseAcquisitionOp, rankCoupledSubsystems } from './heuristics.js';
import { terminalEquivalent } from './stateKey.js';
import { discoverEntropyChains } from './macros.js';

/**
 * Legacy sequential step materializer — strategy decisions do NOT live there.
 * Imported lazily to avoid circular init with sideCompletionPlanner shims.
 */
async function materializeSequential(item, onProgress, opts) {
  const { planDeterministic } = await import('../deterministicPlanner.js');
  return planDeterministic(item, onProgress, { ...opts, skipRecombinator: true });
}

function stampMeta(plan, kb, extra = {}) {
  const classification = classifyPlan(plan);
  return {
    ...plan,
    classification,
    rulesetVersion: plan.rulesetVersion ?? rulesetVersion(),
    ...extra,
  };
}

/**
 * Prefer fracture by downstream EV (§80), not rarity.
 */
function pickFractureByEv(mods, ctx) {
  const cands = (mods ?? []).filter(
    (m) =>
      !m.fractured &&
      !m.crafted &&
      m.method !== 'bench' &&
      !m.veiled &&
      !m.ofEssence &&
      m.match?.source !== 'influence'
  );
  if (cands.length < 1) return null;
  const costOne = ctx.costOne ?? ((m) => m.best?.expectedChaos ?? 10);
  const baseCtx = { ...ctx, costOne, mods };
  const vWithout = sequentialRemaining(
    (mods ?? []).filter((m) => m.fractured).map(modKey),
    baseCtx
  ).ev;
  return fractureByEv(cands, {
    vWithout,
    vWithFrac: (m) => {
      const fake = mods.map((x) => (x === m ? { ...x, fractured: true } : x));
      return sequentialRemaining(
        fake.filter((x) => x.fractured).map(modKey),
        { ...baseCtx, mods: fake }
      ).ev;
    },
    acquireCost: 0,
  });
}

/**
 * Main production optimizer (§1–5, §94 emerge — no hardcoded wand/chest recipes).
 */
export async function optimizeCraft(item, onProgress, opts = {}) {
  onProgress?.({ phase: 'loading-knowledge' });
  const kb = await loadKnowledgeBase();
  const planOpts = defaultPlanOptions(opts);
  const base = getBaseInfo(kb, item.baseName);
  if (base?.name && base.name !== item.baseName) {
    item = { ...item, baseName: base.name };
  }
  const baseTags = effectiveBaseTags(item, base, kb.cannotRoll);
  const cannotRoll = resolveCannotRoll(item, base, kb.cannotRoll);
  const itemClass = base?.item_class ?? normalizeItemClass(item.itemClass);

  onProgress?.({ phase: 'optimizing' });
  // Materialize sequential scaffold for steps + classified mods (not strategy)
  const scaffold = await materializeSequential(item, onProgress, { ...opts, ...planOpts });
  const seqBest = scaffold.best;
  const mods = seqBest.classified ?? [];
  const prices = kb.prices;
  const minIlvl = scaffold.minIlvl;
  const drivers = scaffold.drivers;

  const costOne = (m) => {
    if (m.fractured || m.crafted || m.method === 'bench') return 0;
    const divineSep = planOpts?.divineSeparate !== false;
    // Prefer cheapest candidate; strip divine from exalt bags when divineSeparate (matches sequentialRemaining).
    let bestC = null;
    for (const c of m.candidates ?? []) {
      if (c.expectedChaos == null || !Number.isFinite(c.expectedChaos)) continue;
      let chaos = c.expectedChaos;
      if (divineSep && c.type === 'exalt' && c.cost?.divine) {
        const { divine: _d, ...rest } = c.cost;
        const stripped = chaosCost(rest, prices);
        if (stripped != null && Number.isFinite(stripped)) chaos = stripped;
      }
      if (bestC == null || chaos < bestC) bestC = chaos;
    }
    if (bestC != null) return bestC;
    const c = m.best?.expectedChaos;
    return c != null && Number.isFinite(c) ? c : 8;
  };

  const itemMeta = {
    itemClass,
    baseType: item.baseName,
    itemLevel: minIlvl,
    influence: item.influenced ?? [],
    fracturedItem: mods.some((m) => m.fractured),
  };

  const baseOp = baseAcquisitionOp(itemMeta, prices, recommendInfluenceAcquisition);
  const fracPick = pickFractureByEv(mods, {
    kb,
    baseTags,
    prices,
    ilvl: minIlvl,
    itemMeta,
    costOne,
    planOpts,
  });

  const solved = solveValue({
    mods,
    sequentialCost: seqBest.totalCost,
    costOne,
    itemMeta,
    kb,
    prices,
    baseTags,
    ilvl: minIlvl,
    planOpts,
    displayedChance: opts.displayedChance ?? opts.predictableChance ?? null,
  });

  const recomb = considerRecombinator({
    mods,
    sequentialCost: seqBest.totalCost,
    sequentialName: seqBest.name,
    sequentialDescription: seqBest.description,
    sequentialSteps: seqBest.steps,
    sequentialCosts: seqBest.costs,
    fractureCost: fracPick && fracPick.value > 0 ? seqBest.totalCost - fracPick.value : null,
    fractureName: fracPick ? `Fracture ${fracPick.mod.short ?? fracPick.mod.text}` : null,
    costOne,
    itemMeta,
    kb,
    prices,
    baseTags,
    ilvl: minIlvl,
    planOpts,
    displayedChance: opts.displayedChance ?? opts.predictableChance ?? null,
  });

  const tips = [...(seqBest.tips ?? [])];
  const alternatives = [...(seqBest.alternatives ?? [])];
  if (recomb?.alternative) alternatives.unshift(recomb.alternative);

  const chains = discoverEntropyChains(
    mods.filter((m) => !m.fractured && !m.crafted),
    {}
  );
  const coupled = rankCoupledSubsystems(mods, costOne);

  const solverDebug = {
    memoSize: solved.memoSize,
    nodes: solved.nodes,
    macros: solved.best?.macros ?? solved.sequential?.macros,
    coupled: coupled.slice(0, 5).map((c) => ({
      mods: c.mods.map((m) => m.short ?? m.text),
      coupling: roundEv(c.coupling),
      cost: roundEv(c.cost),
    })),
    entropyChains: chains.slice(0, 6).map((c) => ({ id: c.id, why: c.why })),
    V: roundEv(solved.best?.ev),
    Qsequential: roundEv(solved.sequential?.ev ?? seqBest.totalCost),
    Qunpredictable: roundEv(
      solved.best?.method === 'recombine' ? solved.best.ev : solved.best?.recombAlt?.ev
    ),
    Qpredictable: roundEv(
      solved.best?.method === 'predictableRecombine'
        ? solved.best.ev
        : solved.best?.predictableAlt?.unranked
          ? null
          : solved.best?.predictableAlt?.ev
    ),
    operatorsCompeting: solved.operatorsCompeting,
    predictableUnranked: !!solved.best?.predictableAlt?.unranked || opts.displayedChance == null,
    baseAcquisition: baseOp,
    fractureByEv: fracPick
      ? { mod: fracPick.mod.short ?? fracPick.mod.text, value: roundEv(fracPick.value) }
      : null,
    planOpts,
    terminalCheck: 'family+tierMode+source',
    stateEvDebug: recomb?.economics?.stateEvDebug ?? solved.best?.stateEvDebug ?? null,
    outcomeMass: recomb?.economics?.outcomeMass ?? recomb?.outcomeMass ?? null,
    transitionDiagnostics: recomb?.economics?.stateEvDebug ?? null,
    economicsInvalid: recomb?.economics?.economicsInvalid ?? false,
    impracticalReason: recomb?.economics?.impracticalReason ?? null,
  };

  const rejectedStrategies = [];
  if (recomb?.comparison?.recombinator && recomb.comparison.winner !== 'recombinator') {
    rejectedStrategies.push({
      id: 'UnpredictableRecombine',
      whyLost: recomb.comparison.recombinator?.why,
      ev: recomb.comparison.recombinator?.cost,
    });
  }
  if (recomb?.comparison?.predictableRecombinator && recomb.comparison.winner !== 'predictableRecombinator') {
    rejectedStrategies.push({
      id: 'PredictableRecombine',
      whyLost: recomb.comparison.predictableRecombinator?.why,
      ev: recomb.comparison.predictableRecombinator?.cost,
      unranked: recomb.comparison.predictableRecombinator?.unranked,
    });
  }
  if (recomb?.won) {
    rejectedStrategies.push({
      id: 'sequential',
      whyLost: `Sequential ~${roundEv(seqBest.totalCost)}c lost to ${recomb.name}`,
      ev: seqBest.totalCost,
    });
  }

  let best;
  if (recomb?.won && recomb.steps?.length) {
    best = stampMeta(
      {
        experimental: true,
        id: 'recombinator',
        name: 'Recombinator',
        description: recomb.description,
        steps: annotateRisk(recomb.steps, recomb),
        costs: recomb.costs ?? {},
        totalCost: roundEv(recomb.totalCost),
        totalExpectedTradableCostChaos: recomb.totalExpectedTradableCostChaos ?? null,
        totalExpectedEconomicCostChaos: recomb.totalExpectedEconomicCostChaos ?? null,
        economics: recomb.economics ?? null,
        economicsDisplay: recomb.economicsDisplay ?? null,
        initialSetupCostChaos: recomb.initialSetupCostChaos,
        expectedDonorCostChaos: recomb.expectedDonorCostChaos,
        grossDonorConstructionEV: recomb.grossDonorConstructionEV,
        expectedSalvageCredit: recomb.expectedSalvageCredit,
        expectedNonRecombCraftingChaos: recomb.expectedNonRecombCraftingChaos,
        knownComponentEv: recomb.knownComponentEv,
        expectedRecombinationAttempts: recomb.expectedRecombinationAttempts,
        expectedTotalRecombinationsUntilFinished: recomb.expectedTotalRecombinationsUntilFinished,
        expectedFullDonorARebuilds: recomb.expectedFullDonorARebuilds,
        expectedFullDonorBRebuilds: recomb.expectedFullDonorBRebuilds,
        expectedPartialStateReuses: recomb.expectedPartialStateReuses,
        directFinalProbabilityPerRecombination: recomb.directFinalProbabilityPerRecombination,
        eventualCompletionProbability: recomb.eventualCompletionProbability,
        economicsBreakdown: recomb.economicsBreakdown,
        expectedRecombinationCurrencyChaos: recomb.expectedRecombinationCurrencyChaos,
        expectedDust: recomb.expectedDust,
        expectedGold: recomb.expectedGold,
        dustChaosEquivalent: recomb.dustChaosEquivalent,
        goldOpportunityChaosEquivalent: recomb.goldOpportunityChaosEquivalent,
        expectedFinishingCostChaos: recomb.expectedFinishingCostChaos,
        expectedSalvageChaos: recomb.expectedSalvageChaos,
        costBreakdown: formatCostBreakdown(recomb.costs ?? {}, prices),
        tips,
        classified: mods,
        alternatives,
        methodComparison: recomb.comparison,
        preferFractureAvailable: !!seqBest.preferFractureAvailable || !!fracPick,
        preferFractureEnabled:
          seqBest.preferFractureEnabled == null ? opts.preferFracture !== false : seqBest.preferFractureEnabled,
        priceStatus: kb.priceStatus,
        pricesTip: kb.pricesTip,
        solverDebug,
        rejectedStrategies,
        confidence: recomb.unranked ? 'low' : 'experimental',
        planOpts,
      },
      kb
    );
  } else {
    const why =
      recomb?.comparison?.recombinator?.why ??
      (chains.length
        ? `Entropy-reducing macros (${chains.map((c) => c.id).slice(0, 3).join(', ')}) beat recomb on EV.`
        : 'Lowest Q(S,O) among sequential macros and recombinator.');
    if (recomb?.comparison) tips.unshift(`Method: ${why}`);
    best = stampMeta(
      {
        ...seqBest,
        totalCost: roundEv(seqBest.totalCost),
        tips,
        alternatives,
        methodComparison: recomb?.comparison ?? seqBest.methodComparison ?? null,
        solverDebug,
        rejectedStrategies,
        confidence: 'expected-cost',
        planOpts,
        description: seqBest.description ?? why,
      },
      kb
    );
  }

  // Attach base acquisition as first conceptual op when influence/fracture needed
  if (baseOp && best.steps?.length && !best.steps.some((s) => s.operator === 'acquireBase')) {
    // Do not invent steps — scaffold already has buy/acquire; annotate only
    best.baseAcquisition = baseOp;
  }

  return {
    best,
    alternatives: best.alternatives ?? [],
    minIlvl,
    drivers,
    classified: best.classified,
    coverage: kb.coverage,
    cannotRoll,
    baseTags,
    solverDebug,
    planOpts,
    summary: planSummaryLine(best, { totalCost: best.totalCost, minIlvl, methodName: best.name }),
  };
}

function annotateRisk(steps, recomb) {
  return (steps ?? []).map((s) => {
    if (s.stage !== 'recombine' && s.operator !== 'unpredictableRecombine') return s;
    const pBrick = recomb?.comparison?.recombinator?.pBrick ?? s.recombMeta?.pBrick;
    return {
      ...s,
      risk: {
        canBrickKeeper: (pBrick ?? 0) > 0.05,
        canDestroyInputs: true,
        restartRequiredProbability: pBrick ?? null,
      },
      riskyFailures: pBrick != null ? Math.round(pBrick * 100) / 100 : undefined,
      restartProbability: pBrick ?? undefined,
    };
  });
}

/** Compatibility alias — production name. */
export async function planCraft(item, _index, onProgress, opts = {}) {
  const result = await optimizeCraft(item, onProgress, opts);
  return {
    best: result.best,
    alternatives: result.alternatives,
    minIlvl: result.minIlvl,
    drivers: result.drivers,
    classified: result.classified,
    coverage: result.coverage,
    baseTags: result.baseTags,
    solverDebug: result.solverDebug,
    planOpts: result.planOpts,
  };
}

export { terminalEquivalent, defaultPlanOptions, solveValue, roundEv };
