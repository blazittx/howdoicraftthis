/**
 * Canonical plan output assembly (§31–32, §52–53, §54, §60, §74, §78, §88–90).
 * Emits keys the Phase 6 UX expects; unknown values stay null — never invent Qs.
 */
import { classifyPlan, planSummaryLine } from './planClass.js';
import { rulesetVersion } from './ruleset.js';
import {
  multiDimensionCost,
  formatMultiCost,
  costFormulas,
  splitCostBag,
  buildSuccessProfile,
  resolveObjective,
  scoreUnderObjective,
  OBJECTIVE_PROFILES,
  resolveTradableCost,
  formatRecombEconomicsDisplay,
} from './pricing/index.js';
import { pricesStatus, pricesAgeMs } from './prices.js';

const CONF_LEVELS = ['high', 'medium', 'low', 'unknown'];

function worse(a, b) {
  return CONF_LEVELS.indexOf(a) > CONF_LEVELS.indexOf(b) ? a : b;
}

/** §31 confidence object on every plan. */
export function buildConfidence(plan, kb) {
  let mechanics = 'high';
  let probabilities = 'high';
  let prices = 'high';
  const sources = [];

  const priceSt = plan.priceStatus ?? kb?.priceStatus ?? pricesStatus(kb?.priceSnapshot);
  if (priceSt?.missing) prices = 'unknown';
  else if (priceSt?.stale) prices = worse(prices, 'medium');

  if (plan.unsupportedTargets?.length || plan.unsupported) {
    mechanics = worse(mechanics, 'low');
    probabilities = 'unknown';
  }

  const recomb = plan.methodComparison?.recombinator ?? plan.recombinator;
  if (plan.method === 'recombinator' || plan.id === 'recombinator' || recomb) {
    probabilities = worse(probabilities, recomb?.confidence === 'unknown' ? 'unknown' : 'medium');
    mechanics = worse(mechanics, 'medium');
    if (kb?.recombinator?.source || recomb?.source) {
      sources.push({
        topic: 'recombinator',
        ...(typeof (kb?.recombinator?.source ?? recomb?.source) === 'object'
          ? kb?.recombinator?.source ?? recomb?.source
          : { sourceType: 'empirical', note: String(kb?.recombinator?.source ?? recomb?.source) }),
      });
    }
  }

  if (plan.experimental) probabilities = worse(probabilities, 'medium');

  const cov = kb?.coverage ?? kb?.manifest;
  if (cov?.repoe?.hash == null && cov?.repoE_version_hint) {
    sources.push({
      topic: 'repoe',
      sourceType: 'datamine',
      url: 'https://repoe-fork.github.io/',
      versionVerified: cov.repoe?.gameVersion ?? null,
      retrievedAt: cov.built_at ?? null,
      note: 'Live export — pin snapshot for reproducible tests',
    });
  }

  return {
    mechanics,
    probabilities,
    prices,
    sources,
    summary: `mechanics=${mechanics}, probabilities=${probabilities}, prices=${prices}`,
  };
}

/** §32 mechanic provenance blob. */
export function mechanicProvenance({
  sourceType = 'community-doc',
  url = null,
  versionVerified = null,
  retrievedAt = null,
  note = null,
} = {}) {
  return { sourceType, url, versionVerified, retrievedAt, note };
}

function stageRisk(s, attempts) {
  const risky =
    s.riskyFailures ??
    s.risk?.riskyFailures ??
    (s.risk?.canBrickKeeper || s.risk?.canDestroyInputs || s.operator === 'recombine'
      ? attempts
      : null);
  const restart =
    s.restartProbability ??
    s.restartProb ??
    s.risk?.restartRequiredProbability ??
    null;
  return { riskyFailures: risky ?? null, restartProbability: restart };
}

/** §52 stages from steps — UI reads name/rawCostFormula/attempts/risk. */
export function stepsToStages(steps = [], prices = null) {
  return steps.map((s, i) => {
    const formulas = costFormulas(s.cost ?? {}, prices);
    const attempts =
      s.attemptsExpected ??
      s.attempts ??
      (s.chance > 0 && s.chance < 1 ? 1 / s.chance : s.chance >= 1 ? 1 : null);
    const attemptsN = attempts != null && Number.isFinite(attempts) ? attempts : null;
    const { riskyFailures, restartProbability } = stageRisk(s, attemptsN);
    const formulaParts = formulas.map((f) => f.formula).filter(Boolean);
    const rawCostFormula = s.rawCostFormula ?? (formulaParts.length ? formulaParts.join('; ') : null);
    return {
      index: i,
      id: s.operator ?? `step-${i + 1}`,
      name: s.action ?? s.operator ?? `Stage ${i + 1}`,
      summary: s.detail ?? null,
      stateBefore: s.stateBefore ?? null,
      operation: s.operator ?? s.action,
      stateGoal: s.stateGoal ?? s.targetMods ?? [],
      successProbability: s.chance ?? null,
      attemptsExpected: attemptsN,
      attempts: attemptsN,
      riskyFailures,
      restartProbability,
      expectedCost: s.expectedCost ?? null,
      costBag: s.cost ?? {},
      costFormulas: formulas,
      rawCostFormula,
      formula: rawCostFormula,
      failureOutcomes: s.fallbacks ?? s.failureOutcomes ?? null,
      source: s.source ?? null,
      eligiblePool: s.eligiblePool ?? null,
      eligiblePoolTotal: s.eligiblePoolTotal ?? null,
      risk: s.risk ?? null,
      detail: s.detail,
      action: s.action,
    };
  });
}

/** §53 rejected strategies with WHY (reason / why / whyLost for UI). */
export function buildRejectedStrategies(plan) {
  const out = [];
  const alts = plan.alternatives ?? [];
  const winnerCost = plan.expectedTradableCost ?? plan.totalCost;

  for (const a of alts) {
    const cost = a.totalCost ?? a.expectedTradableCost;
    let why = a.whyLost ?? a.why ?? a.reason ?? a.description ?? 'Higher or unranked expected cost';
    if (a.unranked || cost == null) {
      why = a.whyLost ?? a.why ?? a.reason ?? 'Cost not ranked due to insufficient price or probability data';
    } else if (winnerCost != null && cost != null && cost > winnerCost) {
      const delta = Math.round((cost - winnerCost) * 100) / 100;
      why = a.whyLost ?? a.why ?? a.reason ?? `Lost by ~${delta}c vs selected route`;
    }
    out.push({
      id: a.id,
      name: a.name,
      expectedTradableCost: cost,
      totalCost: cost,
      why,
      reason: why,
      whyLost: why,
      unranked: !!(a.unranked || cost == null),
    });
  }

  const cmp = plan.methodComparison;
  if (cmp?.recombinator && cmp.winner !== 'recombinator') {
    const why = cmp.recombinator.why ?? 'Lost on expected cost vs sequential';
    out.push({
      id: 'recombinator',
      name: 'Recombinator',
      expectedTradableCost: cmp.recombinator.ev ?? cmp.recombinator.totalCost ?? null,
      totalCost: cmp.recombinator.ev ?? cmp.recombinator.totalCost ?? null,
      why,
      reason: why,
      whyLost: why,
      unranked: !!cmp.recombinator.unranked,
      experimental: !!cmp.recombinator.experimental,
    });
  }
  if (cmp?.sequential && cmp.winner === 'recombinator') {
    const why = cmp.sequential.why ?? 'Lost on expected cost vs recombinator';
    out.push({
      id: 'sequential',
      name: cmp.sequential.name ?? 'Sequential',
      expectedTradableCost: cmp.sequential.ev ?? cmp.sequential.totalCost ?? null,
      totalCost: cmp.sequential.ev ?? cmp.sequential.totalCost ?? null,
      why,
      reason: why,
      whyLost: why,
      unranked: false,
    });
  }

  return out;
}

/**
 * §54 solver debug — only real planner data. Never invent Q-values.
 * Returns null when debug flag is off.
 */
export function buildSolverDebug(plan, opts = {}) {
  const want = !!(opts.solverDebug || opts.debug || plan.solverDebug);
  if (!want) return null;

  const provided = plan.solverDebug && typeof plan.solverDebug === 'object' ? plan.solverDebug : {};
  const pools = (plan.steps ?? [])
    .filter((s) => s.eligiblePool?.length)
    .map((s) => ({
      step: s.step ?? s.action,
      operator: s.operator,
      total: s.eligiblePoolTotal ?? null,
      rows: s.eligiblePool,
    }));

  const state =
    provided.state ??
    (plan.classified
      ? {
          method: plan.method ?? plan.id,
          methodName: plan.methodName ?? plan.name,
          mods: (plan.classified ?? []).map((m) => ({
            text: m.short ?? m.text,
            gen: m.gen,
            method: m.method,
            fractured: !!m.fractured,
            matched: !!m.match?.id,
          })),
        }
      : null);

  return {
    state,
    // Only pass through real Qs from optimizer — never fabricate
    qValues: provided.qValues ?? null,
    pruneReasons:
      provided.pruneReasons ??
      (plan.rejectedStrategies?.length
        ? plan.rejectedStrategies.map((r) => `${r.name ?? r.id}: ${r.whyLost ?? r.reason ?? r.why}`)
        : null),
    poolComposition: provided.poolComposition ?? (pools.length ? pools : null),
    stateEvDebug:
      provided.stateEvDebug ??
      plan.economics?.stateEvDebug ??
      plan.solverDebug?.stateEvDebug ??
      null,
    recombEconomics: plan.economicsBreakdown ?? plan.economics?.breakdown ?? null,
  };
}

/** §88 version assertions. */
export function versionAssertions(kb, expectedGameVersion = '3.29') {
  const warnings = [];
  const manifest = kb?.manifest ?? {};
  const coverage = kb?.coverage ?? {};
  const dataVersion =
    manifest.dataVersion ??
    coverage.dataVersion ??
    kb?.dataVersion ??
    coverage.built_at ??
    null;
  const repoeVersion = manifest.repoe?.gameVersion ?? coverage.repoe?.gameVersion ?? null;
  const rules = rulesetVersion();

  if (!repoeVersion) {
    warnings.push(
      'RePoE snapshot game version not verified — do not mix unknown data age with planner rules silently'
    );
  } else if (repoeVersion !== expectedGameVersion && !String(repoeVersion).startsWith(expectedGameVersion)) {
    warnings.push(`RePoE data version ${repoeVersion} ≠ expected ${expectedGameVersion}`);
  }
  if (rules !== expectedGameVersion) {
    warnings.push(`Ruleset ${rules} ≠ expected ${expectedGameVersion}`);
  }
  return {
    expectedGameVersion,
    rulesVersion: rules,
    dataVersion,
    repoeVersion,
    pricesFetchedAt: kb?.priceSnapshot?.fetchedAt ?? null,
    ok: warnings.length === 0,
    warnings,
  };
}

/**
 * Assemble the §52 plan schema from a planner best plan + context.
 */
export function assemblePlan(plan, ctx = {}) {
  const {
    kb = null,
    opts = {},
    unmatched = [],
    alternatives = plan.alternatives ?? [],
    minIlvl = plan.minIlvl,
    methodName = plan.methodName ?? plan.name,
  } = ctx;

  const prices = kb?.prices ?? null;
  const dims = multiDimensionCost(plan.costs ?? {}, prices);
  const { nonTradable } = splitCostBag(plan.costs ?? {});
  const objective = resolveObjective(opts.objective ?? opts.objectiveProfile ?? 'minChaos');

  const unsupportedTargets = (unmatched.length ? unmatched : plan.unsupportedTargets ?? []).map((m) =>
    typeof m === 'string'
      ? { text: m, reason: 'Unsupported target modifier — not matched in knowledge base' }
      : {
          text: m.text,
          reason: m.reason ?? 'Unsupported target modifier — not matched in knowledge base',
        }
  );

  // §36–37: unmatched → no guessed EV
  // Smash-only cost bags must not overwrite solver EV with 0c (empty tradable split).
  const blockedByUnsupported = unsupportedTargets.length > 0;
  const expectedTradableCost = blockedByUnsupported
    ? null
    : resolveTradableCost(plan, dims);

  const classification = plan.classification ?? classifyPlan(plan);
  const confidence = buildConfidence(
    {
      ...plan,
      unsupportedTargets,
      unsupported: blockedByUnsupported,
      priceStatus: plan.priceStatus ?? kb?.priceStatus,
    },
    kb
  );

  const successProfile = plan.successProfile ?? buildSuccessProfile(plan);
  const versions = versionAssertions(kb);
  const priceSt = plan.priceStatus ?? kb?.priceStatus;
  const pricesFetchedAt = kb?.priceSnapshot?.fetchedAt ?? priceSt?.fetchedAt ?? null;
  const ageMs = kb?.priceSnapshot ? pricesAgeMs(kb.priceSnapshot) : priceSt?.ageMs ?? null;

  const stages = stepsToStages(plan.steps ?? [], prices);
  const rejectedStrategies = buildRejectedStrategies({
    ...plan,
    alternatives,
    expectedTradableCost,
    totalCost: expectedTradableCost,
  });

  const tierMode = opts.tierMode ?? plan.tierMode ?? 'atLeast';
  const preserveSpecialSources =
    opts.preserveSpecialSources ?? plan.preserveSpecialSources ?? true;

  const summaryBase = planSummaryLine(
    { ...plan, methodName },
    { totalCost: expectedTradableCost, minIlvl, methodName }
  );

  // Always expose gold/dust keys (null = unknown/unpublished amount)
  const goldAmt = Object.prototype.hasOwnProperty.call(nonTradable, 'gold')
    ? nonTradable.gold
    : plan.costs && ('gold' in (plan.costs ?? {}))
      ? plan.costs.gold
      : null;
  const dustAmt = Object.prototype.hasOwnProperty.call(nonTradable, 'thaumaturgic-dust')
    ? nonTradable['thaumaturgic-dust']
    : plan.costs && ('thaumaturgic-dust' in (plan.costs ?? {}))
      ? plan.costs['thaumaturgic-dust']
      : null;

  // If recomb path may need smash, surface ? rather than omitting keys
  const mayNeedSmash =
    plan.method === 'recombinator' ||
    plan.id === 'recombinator' ||
    !!(plan.methodComparison?.recombinator);

  const nonTradableCosts = {
    gold: goldAmt != null ? goldAmt : mayNeedSmash ? null : goldAmt,
    thaumaturgicDust: dustAmt != null ? dustAmt : mayNeedSmash ? null : dustAmt,
    display: null,
  };
  // Normalize: when smash may apply and amounts unknown → null (UI shows ?)
  if (mayNeedSmash) {
    if (nonTradableCosts.gold === undefined) nonTradableCosts.gold = null;
    if (nonTradableCosts.thaumaturgicDust === undefined) nonTradableCosts.thaumaturgicDust = null;
  } else {
    if (nonTradableCosts.gold == null && !('gold' in (plan.costs ?? {}))) nonTradableCosts.gold = 0;
    if (nonTradableCosts.thaumaturgicDust == null && !('thaumaturgic-dust' in (plan.costs ?? {}))) {
      nonTradableCosts.thaumaturgicDust = 0;
    }
  }

  const multiLabel = formatMultiCost({
    chaosEquivalent: expectedTradableCost,
    gold: nonTradableCosts.gold,
    thaumaturgicDust: nonTradableCosts.thaumaturgicDust,
    unknownKeys: [
      ...(nonTradableCosts.gold == null && mayNeedSmash ? ['gold'] : []),
      ...(nonTradableCosts.thaumaturgicDust == null && mayNeedSmash ? ['thaumaturgic-dust'] : []),
      ...dims.unknownKeys.filter((k) => k !== 'gold' && k !== 'thaumaturgic-dust'),
    ],
  });
  nonTradableCosts.display = multiLabel;

  const planForDebug = { ...plan, rejectedStrategies, stages, method: plan.method ?? plan.id };
  const solverDebug = buildSolverDebug(planForDebug, opts);

  const eco = plan.economics ?? plan.methodComparison?.recombinator?.economics ?? null;
  const economicsDisplay =
    plan.economicsDisplay ?? (eco ? formatRecombEconomicsDisplay(eco) : null);
  const ecoInvalid = !!(eco?.economicsInvalid || eco?.impractical || plan.economicsInvalid);
  const totalIncomplete = !!(eco?.totalIncomplete || plan.totalIncomplete);
  let summary =
    (blockedByUnsupported
      ? `Unsupported target modifier(s) — EV omitted. ${summaryBase}`
      : summaryBase) +
    (expectedTradableCost == null && !blockedByUnsupported ? '. Run npm run fetch-prices.' : '');
  if (ecoInvalid) {
    summary = `invalid / EV unresolved — ${summary}`;
  } else if (totalIncomplete) {
    const known = expectedTradableCost ?? plan.totalExpectedTradableCostChaos ?? plan.totalCost;
    if (known != null && Number.isFinite(known)) {
      summary = summary
        .replace(/~\d[\d,.]*c expected(?:\s*\(incomplete[^)]*\))?/, `known-component ~${Math.round(known)}c (base unknown; total >=${Math.round(known)}c)`)
        .replace(/\d[\d,.]*c expected(?:\s*\(incomplete[^)]*\))?/, `known-component ~${Math.round(known)}c (base unknown; total >=${Math.round(known)}c)`);
      if (!/known-component|base unknown/i.test(summary)) {
        summary += ` [Known-component EV ~${Math.round(known)}c; Base acquisition: unknown; Total EV: >=${Math.round(known)}c]`;
      }
    } else if (!/incomplete/i.test(summary)) {
      summary += ' [total incomplete — base/market unknown]';
    }
  }

  return {
    ...plan,
    method: plan.method ?? plan.id,
    methodName,
    summary,
    expectedTradableCost: ecoInvalid ? null : expectedTradableCost,
    totalCost: ecoInvalid ? null : expectedTradableCost,
    economicsInvalid: ecoInvalid,
    totalIncomplete,
    outcomeMass: plan.outcomeMass ?? eco?.outcomeMass ?? null,
    impracticalReason: plan.impracticalReason ?? eco?.impracticalReason ?? null,
    // §9 recomb cost report (null when not a recomb plan)
    initialSetupCostChaos: plan.initialSetupCostChaos ?? eco?.initialSetupCostChaos ?? null,
    expectedDonorCostChaos: plan.expectedDonorCostChaos ?? eco?.expectedDonorCostChaos ?? null,
    grossDonorConstructionEV: plan.grossDonorConstructionEV ?? eco?.grossDonorConstructionEV ?? null,
    expectedSalvageCredit: plan.expectedSalvageCredit ?? eco?.expectedSalvageCredit ?? null,
    grossCraftEV: plan.grossCraftEV ?? eco?.grossCraftEV ?? null,
    netCraftEV: plan.netCraftEV ?? eco?.netCraftEV ?? null,
    expectedNonRecombCraftingChaos:
      plan.expectedNonRecombCraftingChaos ?? eco?.expectedNonRecombCraftingChaos ?? null,
    knownComponentEv: plan.knownComponentEv ?? eco?.knownComponentEv ?? null,
    expectedRecombinationAttempts:
      plan.expectedRecombinationAttempts ?? eco?.expectedRecombinationAttempts ?? null,
    expectedTotalRecombinationsUntilFinished:
      plan.expectedTotalRecombinationsUntilFinished ??
      eco?.expectedTotalRecombinationsUntilFinished ??
      plan.expectedRecombinationAttempts ??
      eco?.expectedRecombinationAttempts ??
      null,
    expectedFullDonorARebuilds:
      plan.expectedFullDonorARebuilds ?? eco?.expectedFullDonorARebuilds ?? null,
    expectedFullDonorBRebuilds:
      plan.expectedFullDonorBRebuilds ?? eco?.expectedFullDonorBRebuilds ?? null,
    expectedPartialStateReuses:
      plan.expectedPartialStateReuses ?? eco?.expectedPartialStateReuses ?? null,
    directFinalProbabilityPerRecombination:
      plan.directFinalProbabilityPerRecombination ??
      eco?.directFinalProbabilityPerRecombination ??
      null,
    eventualCompletionProbability:
      plan.eventualCompletionProbability ?? eco?.eventualCompletionProbability ?? null,
    economicsBreakdown: plan.economicsBreakdown ?? eco?.breakdown ?? null,
    expectedRecombinationCurrencyChaos:
      plan.expectedRecombinationCurrencyChaos ?? eco?.expectedRecombinationCurrencyChaos ?? null,
    expectedDust: plan.expectedDust ?? eco?.expectedDust ?? nonTradableCosts.thaumaturgicDust,
    expectedGold: plan.expectedGold ?? eco?.expectedGold ?? nonTradableCosts.gold,
    dustChaosEquivalent: plan.dustChaosEquivalent ?? eco?.dustChaosEquivalent ?? null,
    goldOpportunityChaosEquivalent:
      plan.goldOpportunityChaosEquivalent ?? eco?.goldOpportunityChaosEquivalent ?? null,
    expectedFinishingCostChaos:
      plan.expectedFinishingCostChaos ?? eco?.expectedFinishingCostChaos ?? null,
    expectedSalvageChaos: plan.expectedSalvageChaos ?? eco?.expectedSalvageChaos ?? null,
    totalExpectedTradableCostChaos:
      plan.totalExpectedTradableCostChaos ?? eco?.totalExpectedTradableCostChaos ?? expectedTradableCost,
    totalExpectedEconomicCostChaos:
      plan.totalExpectedEconomicCostChaos ?? eco?.totalExpectedEconomicCostChaos ?? null,
    economics: eco,
    economicsDisplay,
    nonTradableCosts,
    multiCostDisplay: multiLabel,
    successProfile,
    // Flatten risk fields for UI (§27)
    attemptsExpected: successProfile.attemptsExpected,
    riskyDestructiveAttempts: successProfile.riskyDestructiveAttempts,
    riskyFailures: successProfile.riskyDestructiveAttempts,
    restartProbability: successProfile.restartProbability,
    confidence,
    rulesVersion: versions.rulesVersion,
    rulesetVersion: versions.rulesVersion,
    dataVersion: versions.dataVersion,
    pricesFetchedAt,
    priceStaleness: {
      fetchedAt: pricesFetchedAt,
      ageMs,
      stale: !!priceSt?.stale,
      missing: !!priceSt?.missing,
      message: priceSt?.message ?? null,
    },
    stages,
    alternatives,
    rejectedStrategies,
    solverDebug,
    classification,
    unsupported: blockedByUnsupported,
    unsupportedTargets,
    tierMode,
    preserveSpecialSources,
    objective: objective.id,
    objectiveScore: scoreUnderObjective(
      { expectedTradableCost, nonTradableCosts, successProfile },
      objective.id
    ),
    objectiveProfiles: Object.keys(OBJECTIVE_PROFILES),
    versionAssertions: versions,
    ranked: !blockedByUnsupported && expectedTradableCost != null,
  };
}

export { OBJECTIVE_PROFILES, resolveObjective, scoreUnderObjective };
