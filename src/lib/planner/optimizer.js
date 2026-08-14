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
import { fractureByEv, defaultPlanOptions, baseAcquisitionOp, rankCoupledSubsystems, analyzeTagSideClusters, tagClusterThoughtLines } from './heuristics.js';
import { terminalEquivalent } from './stateKey.js';
import { discoverEntropyChains } from './macros.js';
import { reportProgress } from '../progress.js';
import { formatPctPrecise } from '../pricing/recombEconomics.js';

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
  await reportProgress(onProgress, {
    phase: 'loading-knowledge',
    message: 'Loading craft knowledge…',
  });
  const kb = await loadKnowledgeBase();
  const planOpts = defaultPlanOptions(opts);
  const base = getBaseInfo(kb, item.baseName);
  if (base?.name && base.name !== item.baseName) {
    item = { ...item, baseName: base.name };
  }
  const baseTags = effectiveBaseTags(item, base, kb.cannotRoll);
  const cannotRoll = resolveCannotRoll(item, base, kb.cannotRoll);
  const itemClass = base?.item_class ?? normalizeItemClass(item.itemClass);

  await reportProgress(onProgress, {
    phase: 'optimizing',
    message: 'Optimizing craft — sequential · fracture · recombinator…',
  });
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
  await reportProgress(onProgress, {
    phase: 'building-routes',
    message: 'Scoring fracture by downstream EV…',
  });
  const fracPick = pickFractureByEv(mods, {
    kb,
    baseTags,
    prices,
    ilvl: minIlvl,
    itemMeta,
    costOne,
    planOpts,
  });
  if (fracPick && fracPick.value > 0) {
    const fracMod = fracPick.mod.short ?? fracPick.mod.text;
    await reportProgress(onProgress, {
      phase: 'building-routes',
      message: `Fracture candidate: ${fracMod} · value ~${roundEv(fracPick.value)}c`,
      route: 'fracture',
      mod: fracMod,
      value: roundEv(fracPick.value),
    });
  } else {
    await reportProgress(onProgress, {
      phase: 'building-routes',
      message: 'No positive-EV fracture candidate',
      route: 'fracture',
    });
  }

  await reportProgress(onProgress, {
    phase: 'comparing-ev',
    message: 'Solving V(S) / Q(S,O) over sequential · recomb partitions…',
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

  const qSeq = roundEv(solved.sequential?.ev ?? seqBest.totalCost);
  const qUnpred = roundEv(
    solved.best?.method === 'recombine' ? solved.best.ev : solved.best?.recombAlt?.ev
  );
  const qPred = roundEv(
    solved.best?.method === 'predictableRecombine'
      ? solved.best.ev
      : solved.best?.predictableAlt?.unranked
        ? null
        : solved.best?.predictableAlt?.ev
  );
  const vBest = roundEv(solved.best?.ev);
  const qBits = [`sequential ~${qSeq}c`];
  if (qUnpred != null) qBits.push(`unpredictable recomb ~${qUnpred}c`);
  if (qPred != null) qBits.push(`predictable recomb ~${qPred}c`);
  if (vBest != null) qBits.unshift(`V ≈ ${vBest}c`);
  await reportProgress(onProgress, {
    phase: 'comparing-ev',
    message: `Q/EV: ${qBits.join(' · ')}`,
    V: vBest,
    Qsequential: qSeq,
    Qunpredictable: qUnpred,
    Qpredictable: qPred,
  });

  await reportProgress(onProgress, {
    phase: 'recomb',
    message: 'Evaluating recombinator economics & outcome mass…',
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

  const liveMods = mods.filter((m) => !m.fractured && !m.crafted);
  const tagClusters = analyzeTagSideClusters(liveMods);
  for (const line of tagClusterThoughtLines(tagClusters)) {
    await reportProgress(onProgress, { phase: 'building-routes', message: line });
  }
  const chains = discoverEntropyChains(liveMods, { tagClusters });
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
    entropyChains: chains.slice(0, 8).map((c) => ({
      id: c.id,
      why: c.why,
      side: c.side,
      tag: c.tag,
      searchHint: !!c.searchHint,
    })),
    tagClusters: (tagClusters.clusters ?? []).slice(0, 6).map((c) => ({
      side: c.side,
      tag: c.tag,
      count: c.count,
      protect: c.protectMetacraft,
      cannotRollHints: c.cannotRollHints,
      mods: c.labels,
    })),
    preferredLockSide: tagClusters.preferredLockSide,
    V: vBest,
    Qsequential: qSeq,
    Qunpredictable: qUnpred,
    Qpredictable: qPred,
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

  const mass =
    recomb?.economics?.outcomeMass ??
    recomb?.outcomeMass ??
    recomb?.comparison?.recombinator?.economics?.outcomeMass ??
    recomb?.comparison?.predictableRecombinator?.economics?.outcomeMass ??
    null;
  if (mass && typeof mass === 'object') {
    const parts = [];
    if (mass.final != null) parts.push(`${formatPctPrecise(mass.final)} final`);
    if (mass.salvageBenchOnly != null) parts.push(`${formatPctPrecise(mass.salvageBenchOnly)} bench`);
    if (mass.salvageCraftNoRecomb != null) {
      parts.push(`${formatPctPrecise(mass.salvageCraftNoRecomb)} craft`);
    }
    if (mass.salvageRequiringAnotherRecombination != null) {
      parts.push(`${formatPctPrecise(mass.salvageRequiringAnotherRecombination)} recomb-again`);
    }
    if (mass.brickRestart != null) parts.push(`${formatPctPrecise(mass.brickRestart)} restart`);
    if (mass.sum != null) parts.push(`sum ${formatPctPrecise(mass.sum)}`);
    if (parts.length) {
      await reportProgress(onProgress, {
        phase: 'recomb',
        message: `Outcome mass: ${parts.join(' · ')}`,
        outcomeMass: mass,
      });
    }
  }

  for (const s of recomb?.steps ?? []) {
    if (s.stage !== 'donor' && s.operator !== 'recombDonor') continue;
    await reportProgress(onProgress, {
      phase: 'donor',
      message: s.detail ? `${s.action} — ${s.detail}` : String(s.action ?? 'Donor mini-plan'),
      ev: s.expectedCostChaos ?? s.expectedCost ?? undefined,
    });
  }

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

  for (const r of rejectedStrategies) {
    const evBit = r.ev != null && Number.isFinite(r.ev) ? ` (EV ~${roundEv(r.ev)}c)` : '';
    const why = r.whyLost ? `: ${r.whyLost}` : '';
    await reportProgress(onProgress, {
      phase: 'rejected',
      message: `Rejected ${r.id}${evBit}${why}`,
      id: r.id,
      ev: r.ev,
      whyLost: r.whyLost,
    });
  }

  const winnerName = recomb?.won ? recomb.name : seqBest.name;
  const winnerEv = recomb?.won ? roundEv(recomb.totalCost) : roundEv(seqBest.totalCost);
  await reportProgress(onProgress, {
    phase: 'done',
    message:
      winnerEv != null
        ? `Winner: ${winnerName} · ~${winnerEv}c`
        : `Winner: ${winnerName}`,
    winner: winnerName,
    ev: winnerEv,
  });

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
