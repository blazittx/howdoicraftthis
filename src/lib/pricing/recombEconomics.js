/**
 * Recombinator full-craft economics.
 * Tradable chaos, Gold, and Dust stay separate; opportunity conversions are labeled.
 */
import { isNonTradableKey, splitCostBag, tradableChaosCost } from './costs.js';

/** Default: Gold opportunity — not a market price. Overridable via opts/prices. */
export const DEFAULT_GOLD_PER_CHAOS_OPPORTUNITY = 50000;

/** Reject strategies below this direct-final P rather than showing ~0c. */
export const MIN_PRACTICAL_P_DONE = 1e-6;

/** Soft reject when expected recombinations explode. */
export const MAX_PRACTICAL_ATTEMPTS = 1e5;

const RECONCILE_TOL = 1.5;
const MASS_TOL = 0.02;

export function formatPctPrecise(p) {
  if (p == null || !Number.isFinite(p)) return '?';
  const pct = p * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(3)}%`;
  if (pct >= 0.001) return `${pct.toFixed(4)}%`;
  if (pct > 0) return `${pct.toFixed(4)}%`;
  return '0%';
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

function roundEv(n) {
  if (n == null || !Number.isFinite(n)) return n;
  return Math.round(n);
}

/** Physical smash counts from a bag (skip meta keys). */
export function physicalSmash(bag) {
  const gold = bag?.gold != null && Number.isFinite(bag.gold) ? bag.gold : null;
  const dustRaw =
    bag?.['thaumaturgic-dust'] ?? bag?.['recombinating-dust'] ?? bag?.dust ?? null;
  const dust = dustRaw != null && Number.isFinite(dustRaw) ? dustRaw : null;
  return { gold, dust };
}

/**
 * Dust → chaos via live prices when a dust unit exists; else opportunity from model.
 * Never silently 0. Tagged approximate when using opportunity.
 */
export function dustChaosEquivalent(dustAmount, prices, model) {
  if (dustAmount == null || !Number.isFinite(dustAmount) || dustAmount <= 0) {
    return { chaos: 0, rate: null, source: 'none', label: null };
  }
  const market =
    prices?.['thaumaturgic-dust'] ?? prices?.['recombinating-dust'] ?? prices?.dust ?? null;
  if (market != null && Number.isFinite(market) && market > 0) {
    return {
      chaos: round2(dustAmount * market),
      rate: market,
      source: 'market',
      label: `Dust equivalent: ~${roundEv(dustAmount * market)}c (market ${market}c/dust)`,
    };
  }
  const opp = model?.cost?.opportunityCostChaos?.['thaumaturgic-dust'];
  if (opp != null && Number.isFinite(opp) && opp > 0) {
    return {
      chaos: round2(dustAmount * opp),
      rate: opp,
      source: 'opportunityCostChaos',
      label: `Dust equivalent: ~${roundEv(dustAmount * opp)}c (approximate opportunity ${opp}c/dust — not market)`,
    };
  }
  return {
    chaos: null,
    rate: null,
    source: 'unknown',
    label: 'Dust equivalent: ?c (no market or opportunity rate)',
  };
}

/**
 * Gold → chaos opportunity only. Never pretend objective market price.
 * goldChaosEquivalent = gold / goldPerChaosOpportunityRate
 */
export function goldOpportunityChaos(goldAmount, prices, opts = {}) {
  if (goldAmount == null || !Number.isFinite(goldAmount) || goldAmount <= 0) {
    return { chaos: 0, rate: null, source: 'none', label: null };
  }
  const oppUnit = opts.model?.cost?.opportunityCostChaos?.gold;
  const rate =
    opts.goldPerChaosOpportunityRate ??
    prices?.goldPerChaosOpportunityRate ??
    (oppUnit != null && Number.isFinite(oppUnit) && oppUnit > 0 ? 1 / oppUnit : null) ??
    DEFAULT_GOLD_PER_CHAOS_OPPORTUNITY;
  if (!(rate > 0)) {
    return {
      chaos: null,
      rate: null,
      source: 'unknown',
      label: 'Gold opportunity cost: ?c (rate unset)',
    };
  }
  const chaos = goldAmount / rate;
  return {
    chaos: round2(chaos),
    rate,
    source: oppUnit > 0 && rate === 1 / oppUnit ? 'opportunityCostChaos' : 'opportunity',
    label: `Gold opportunity cost: ~${roundEv(chaos)}c (gold ÷ ${Math.round(rate)} gold/c — opportunity estimate, not market)`,
  };
}

/**
 * Smash attempt cost for ranking: donors stay in tradable; smash physical tracked apart.
 */
export function smashResourceEconomics(bag, prices, model, opts = {}) {
  const { gold, dust } = physicalSmash(bag);
  const dustEq = dustChaosEquivalent(dust ?? 0, prices, model);
  const goldEq = goldOpportunityChaos(gold ?? 0, prices, { ...opts, model });
  return {
    gold: gold ?? 0,
    dust: dust ?? 0,
    goldBand: bag?.goldBand ?? null,
    dustBand: bag?.dustBand ?? null,
    confidence: bag?.confidence ?? null,
    source: bag?.source ?? null,
    dustChaosEquivalent: dustEq.chaos,
    dustRate: dustEq.rate,
    dustSource: dustEq.source,
    dustLabel: dustEq.label,
    goldOpportunityChaosEquivalent: goldEq.chaos,
    goldRate: goldEq.rate,
    goldSource: goldEq.source,
    goldLabel: goldEq.label,
    smashTradableChaos: dustEq.source === 'market' ? dustEq.chaos ?? 0 : 0,
    smashEconomicChaos:
      (dustEq.chaos ?? 0) + (goldEq.chaos != null && Number.isFinite(goldEq.chaos) ? goldEq.chaos : 0),
  };
}

function donorComponentFailures(node) {
  const fails = [];
  const check = (side, cost, mini) => {
    if (!mini) return;
    if (mini?.invalid || mini?.recipe?.invalid) {
      fails.push(
        `Donor ${side} recipe invalid: ${(mini.recipe?.invariantFailures ?? ['unspecified']).join('; ')}`
      );
    }
    const total = mini?.expectedCostChaos ?? mini?.recipe?.expectedCostChaos ?? cost;
    const lines = mini?.recipe?.lines ?? [];
    for (const l of lines) {
      if (l.kind === 'total' || l.kind === 'base') continue;
      if (l.chaos != null && Number.isFinite(l.chaos) && Number.isFinite(total) && l.chaos > total + 0.05) {
        fails.push(`Donor ${side}: component ${l.chaos}c > totalDonorEV ${total}c`);
      }
    }
  };
  check('A', node?.costA, node?.left);
  check('B', node?.costB, node?.right);
  return fails;
}

/**
 * Invariant checks before ranking. Failures → strategy invalid / EV unresolved.
 */
export function assertRecombEconomicsInvariants(report, node = {}) {
  const fails = [];
  const E =
    report?.expectedTotalRecombinationsUntilFinished ?? report?.expectedRecombinationAttempts;
  const direct =
    report?.directFinalProbabilityPerRecombination ?? report?.pDone ?? node?.pDone ?? 0;
  const pBrick = report?.pBrick ?? node?.pBrick ?? 0;
  const mass = report?.outcomeMass ?? node?.outcomeMass;
  const recombAgain = mass?.salvageRequiringAnotherRecombination ?? 0;
  const restartMass = mass?.brickRestart ?? pBrick ?? 0;
  // Mass that still requires another recombination attempt (recomb-again or brick restart)
  const needsMoreRecombMass = (recombAgain ?? 0) + (restartMass ?? 0);

  if (!(E >= 1) || !Number.isFinite(E)) {
    fails.push(`expectedTotalRecombinations=${E} (need ≥ 1)`);
  }
  // Never clamp-to-1: if directFinal<1 and failure needs another recomb/brick restart → E>1
  if (direct < 1 - 1e-12 && needsMoreRecombMass > 1e-9 && Number.isFinite(E) && !(E > 1 + 1e-6)) {
    fails.push(
      `directFinal=${formatPctPrecise(direct)} with recomb-again/brick mass ${formatPctPrecise(needsMoreRecombMass)} but E_recombs=${E}`
    );
  }
  if (Number.isFinite(E) && Math.abs(E - 1) < 1e-6) {
    if ((recombAgain ?? 0) > 1e-6) {
      fails.push(`E_recombs=1 but recombAgain mass ${formatPctPrecise(recombAgain)}`);
    }
    if ((restartMass ?? 0) > 1e-6) {
      fails.push(`E_recombs=1 but restart mass ${formatPctPrecise(restartMass)}`);
    }
  }

  if (mass) {
    const sum =
      (mass.final ?? 0) +
      (mass.salvageBenchOnly ?? 0) +
      (mass.salvageCraftNoRecomb ?? 0) +
      (mass.salvageRequiringAnotherRecombination ?? 0) +
      (mass.brickRestart ?? 0);
    if (Math.abs(sum - 1) > MASS_TOL && Math.abs((mass.sum ?? sum) - 1) > MASS_TOL) {
      fails.push(`outcome mass Σ=${round2(sum)} (need ≈ 1)`);
    }
  }

  const craftWithoutPath = report?.craftWithoutPath ?? node?.craftWithoutPath ?? mass?.craftWithoutPath ?? 0;
  if (craftWithoutPath > 1e-6) {
    fails.push(`craft mass without path to exact target ${formatPctPrecise(craftWithoutPath)}`);
  }
  const craftMass = mass?.salvageCraftNoRecomb ?? 0;
  const craftOutcomes = report?.craftOutcomes ?? node?.craftOutcomes ?? [];
  if (craftMass > 1e-3) {
    const proven = (craftOutcomes ?? []).reduce((s, c) => s + (c.p ?? 0), 0);
    if (proven + 1e-3 < craftMass && !(report?.fallbacks?.length || node?.fallbacks?.length)) {
      fails.push(`craft mass ${formatPctPrecise(craftMass)} not fully listed in craftOutcomes`);
    }
  }

  const gross =
    report?.grossDonorConstructionEV ??
    report?.expectedDonorCostChaos ??
    null;
  const oneShot =
    (node?.donorAConstructionEv ?? node?.costA ?? 0) + (node?.donorBConstructionEv ?? node?.costB ?? 0);
  if (gross != null && Number.isFinite(gross) && oneShot > 0 && gross + 0.05 < oneShot) {
    fails.push(
      `grossDonorEV ${round2(gross)} < one-time donors ${round2(oneShot)}`
    );
  }

  const salvageCredit = report?.expectedSalvageCredit ?? 0;
  const net = report?.netCraftEV;
  const grossSpend = report?.grossCraftEV;
  if (
    net != null &&
    Number.isFinite(net) &&
    grossSpend != null &&
    Number.isFinite(grossSpend) &&
    Math.abs(net - (grossSpend - (salvageCredit ?? 0))) > RECONCILE_TOL
  ) {
    fails.push(`netEV ≠ grossEV − salvageCredit`);
  }

  const tradable = report?.totalExpectedTradableCostChaos;
  const economic = report?.totalExpectedEconomicCostChaos;
  const dustInTradable = report?.dustCountedInTradable === true;
  const dustAdd = dustInTradable ? 0 : report?.dustChaosEquivalent ?? 0;
  const goldAdd = report?.goldOpportunityChaosEquivalent ?? 0;
  if (
    tradable != null &&
    Number.isFinite(tradable) &&
    economic != null &&
    Number.isFinite(economic) &&
    Number.isFinite(dustAdd) &&
    Number.isFinite(goldAdd)
  ) {
    const rebuilt = tradable + dustAdd + goldAdd;
    if (Math.abs(economic - rebuilt) > RECONCILE_TOL) {
      fails.push(
        `economicEV ${roundEv(economic)} ≠ tradable ${roundEv(tradable)} + dust ${roundEv(dustAdd)} + gold ${roundEv(goldAdd)} (=${roundEv(rebuilt)})`
      );
    }
  }

  const smash = report?.smashPerAttempt ?? node?.smashEconomics;
  if (smash && Number.isFinite(E) && E > 0) {
    const gPer = smash.gold ?? 0;
    const dPer = smash.dust ?? 0;
    if (gPer > 0 && report.expectedGold != null) {
      const want = gPer * E;
      if (Math.abs(report.expectedGold - want) > Math.max(1, want * 1e-6)) {
        fails.push(`expectedGold ${report.expectedGold} ≠ ${gPer}×${E}`);
      }
    }
    if (dPer > 0 && report.expectedDust != null) {
      const want = dPer * E;
      if (Math.abs(report.expectedDust - want) > Math.max(1, want * 1e-6)) {
        fails.push(`expectedDust ${report.expectedDust} ≠ ${dPer}×${E}`);
      }
    }
  }

  fails.push(...donorComponentFailures(node));

  if (report?.totalIncomplete && report?.rankedAsComplete) {
    fails.push('total incomplete (base/market unknown) but ranked as precise complete EV');
  }

  return { ok: fails.length === 0, fails };
}

/**
 * Build §9 cost report from scored recomb node.
 * Scales gold/dust/donors by state-graph expectations — never forces attempts=1 because salvage exists.
 */
export function buildRecombCostReport(node, opts = {}) {
  const directFinal =
    node?.directFinalProbabilityPerRecombination ?? node?.pDone ?? 0;
  const pBrick = node?.pBrick ?? 0;
  const E =
    Number.isFinite(node?.expectedTotalRecombinationsUntilFinished) &&
    node.expectedTotalRecombinationsUntilFinished > 0
      ? node.expectedTotalRecombinationsUntilFinished
      : Number.isFinite(node?.expectedRecombinationAttempts) && node.expectedRecombinationAttempts > 0
        ? node.expectedRecombinationAttempts
        : pBrick >= 1
          ? Infinity
          : null;

  // Do not invent E=1 when the state graph did not provide E
  if (E == null || !(E >= 1) || !Number.isFinite(E)) {
    return {
      impractical: true,
      economicsInvalid: true,
      invariantsOk: false,
      invariantFailures: [`E_recombs unresolved (got ${E}) — invalid / EV unresolved`],
      impracticalReason: 'invalid / EV unresolved: E_recombs missing from state graph',
      directFinalProbabilityPerRecombination: directFinal,
      pBrick,
      outcomeMass: node?.outcomeMass ?? null,
      stateEvDebug: node?.stateEvDebug ?? null,
      totalIncomplete: true,
    };
  }

  const rebuildA =
    Number.isFinite(node?.expectedFullDonorARebuilds) && node.expectedFullDonorARebuilds > 0
      ? node.expectedFullDonorARebuilds
      : E;
  const rebuildB =
    Number.isFinite(node?.expectedFullDonorBRebuilds) && node.expectedFullDonorBRebuilds > 0
      ? node.expectedFullDonorBRebuilds
      : E;

  const donorA = node?.donorAConstructionEv ?? node?.costA ?? 0;
  const donorB = node?.donorBConstructionEv ?? node?.costB ?? 0;
  const expectedDonorCostA = round2(donorA * (Number.isFinite(rebuildA) ? rebuildA : 1));
  const expectedDonorCostB = round2(donorB * (Number.isFinite(rebuildB) ? rebuildB : 1));
  // Gross donor construction — never net of post-recomb salvage credit
  const grossDonorConstructionEV = round2(
    (Number.isFinite(expectedDonorCostA) ? expectedDonorCostA : 0) +
      (Number.isFinite(expectedDonorCostB) ? expectedDonorCostB : 0)
  );
  const expectedDonorCostChaos = grossDonorConstructionEV;

  const smash =
    node?.smashEconomics ?? smashResourceEconomics(node?.recombBag, opts.prices, opts.model, opts);
  const Esafe = Number.isFinite(E) ? E : 0;
  const expectedGold = round2((smash.gold ?? 0) * Esafe);
  const expectedDust = round2((smash.dust ?? 0) * Esafe);

  const dustScaled = dustChaosEquivalent(expectedDust, opts.prices, opts.model);
  const goldScaled = goldOpportunityChaos(expectedGold, opts.prices, opts);

  const finishing = node?.expectedFinishingCostChaos ?? node?.finishEv ?? 0;
  // expectedSalvageChaos in the solver is finishing-path cost mass, not a credit.
  // Salvage credit (value recovered vs ignore-partials) is tracked separately — default 0.
  const finishingPathCost = node?.expectedSalvageChaos ?? 0;
  const expectedSalvageCredit = round2(node?.expectedSalvageCredit ?? 0);
  const smashTradablePerAttempt = smash.smashTradableChaos ?? 0;
  const expectedRecombinationCurrencyChaos = round2(smashTradablePerAttempt * Esafe);

  const initialSetup = node?.initialSetupCostChaos ?? 0;
  const dustInTradable = smash.dustSource === 'market';
  const baseUnknown =
    opts.baseAcquisitionUnknown === true ||
    node?.left?.baseAcquisitionUnknown ||
    node?.right?.baseAcquisitionUnknown ||
    node?.baseAcquisitionUnknown === true;

  let totalExpectedTradableCostChaos = round2(node?.evTradable ?? node?.tradableEv ?? null);
  let totalExpectedEconomicCostChaos = round2(Number.isFinite(node?.ev) ? node.ev : null);

  const dustEq = dustScaled.chaos;
  const goldOpp = goldScaled.chaos;
  const dustAdd = dustInTradable ? 0 : dustEq ?? 0;
  const goldAdd = goldOpp != null && Number.isFinite(goldOpp) ? goldOpp : 0;

  if (
    (totalExpectedTradableCostChaos == null || !Number.isFinite(totalExpectedTradableCostChaos)) &&
    totalExpectedEconomicCostChaos != null &&
    Number.isFinite(totalExpectedEconomicCostChaos)
  ) {
    totalExpectedTradableCostChaos = round2(totalExpectedEconomicCostChaos - dustAdd - goldAdd);
  }

  const expectedNonRecombCraftingChaos = round2(finishing);
  const grossCraftEV = round2(
    (Number.isFinite(grossDonorConstructionEV) ? grossDonorConstructionEV : 0) +
      (Number.isFinite(expectedNonRecombCraftingChaos) ? expectedNonRecombCraftingChaos : 0) +
      (Number.isFinite(expectedRecombinationCurrencyChaos) ? expectedRecombinationCurrencyChaos : 0) +
      (Number.isFinite(initialSetup) ? initialSetup : 0)
  );
  const netCraftEV = round2(grossCraftEV - (expectedSalvageCredit ?? 0));

  const breakdown = {
    equationTradable:
      'grossDonorConstruction + expectedNonRecombCrafting + tradableRecombFees + bench/setup + base − salvageCredit ≈ totalTradableEV',
    equationEconomic: dustInTradable
      ? 'economicEV = totalTradableEV + goldOpportunity'
      : 'economicEV = totalTradableEV + dustOpportunity + goldOpportunity',
    grossDonorConstructionEV,
    expectedDonorCraftingChaos: expectedDonorCostChaos,
    expectedDonorCostA,
    expectedDonorCostB,
    expectedNonRecombCraftingChaos,
    tradableRecombCostsChaos: expectedRecombinationCurrencyChaos,
    expectedFinishingCostChaos: round2(finishing),
    expectedSalvageCredit,
    expectedSalvageChaos: round2(finishingPathCost),
    initialSetupCostChaos: round2(initialSetup),
    baseAcquisitionChaos: baseUnknown ? null : round2(opts.baseAcquisitionChaos ?? null),
    grossCraftEV,
    netCraftEV,
    totalTradableEV: totalExpectedTradableCostChaos,
    dustOpportunityChaos: dustInTradable ? 0 : dustEq,
    dustCountedInTradable: dustInTradable,
    goldOpportunityChaos: goldOpp,
    totalEconomicEV: totalExpectedEconomicCostChaos,
    directFinalProbabilityPerRecombination: directFinal,
    eventualCompletionProbability: node?.eventualCompletionProbability ?? null,
    expectedTotalRecombinationsUntilFinished: round2(E),
    expectedFullDonorARebuilds: Number.isFinite(rebuildA) ? round2(rebuildA) : null,
    expectedFullDonorBRebuilds: Number.isFinite(rebuildB) ? round2(rebuildB) : null,
    expectedPartialStateReuses: node?.expectedPartialStateReuses ?? null,
    outcomeMass: node?.outcomeMass ?? null,
    craftWithoutPath: node?.craftWithoutPath ?? 0,
    totalIncomplete: !!baseUnknown,
  };

  const report = {
    initialSetupCostChaos: round2(initialSetup),
    grossDonorConstructionEV,
    expectedDonorCostChaos,
    expectedDonorCostA,
    expectedDonorCostB,
    expectedSalvageCredit,
    grossCraftEV,
    netCraftEV,
    expectedNonRecombCraftingChaos,
    expectedRecombinationAttempts: round2(E),
    expectedTotalRecombinationsUntilFinished: round2(E),
    expectedFullDonorARebuilds: Number.isFinite(rebuildA) ? round2(rebuildA) : null,
    expectedFullDonorBRebuilds: Number.isFinite(rebuildB) ? round2(rebuildB) : null,
    expectedPartialStateReuses:
      node?.expectedPartialStateReuses != null ? round2(node.expectedPartialStateReuses) : null,
    expectedContinuationRecombMass: node?.expectedContinuationRecombMass ?? 0,
    expectedRecombinationCurrencyChaos,
    expectedDust,
    expectedGold,
    dustChaosEquivalent: dustEq,
    goldOpportunityChaosEquivalent: goldOpp,
    dustEquivalentLabel: dustScaled.label,
    goldOpportunityLabel: goldScaled.label,
    dustCountedInTradable: dustInTradable,
    expectedFinishingCostChaos: round2(finishing),
    expectedSalvageChaos: round2(finishingPathCost),
    totalExpectedTradableCostChaos,
    totalExpectedEconomicCostChaos,
    breakdown,
    directFinalProbabilityPerRecombination: directFinal,
    directFinalDisplay: formatPctPrecise(directFinal),
    eventualCompletionProbability: node?.eventualCompletionProbability ?? null,
    eventualCompletionDisplay:
      node?.eventualCompletionProbability != null
        ? formatPctPrecise(node.eventualCompletionProbability)
        : null,
    pDone: directFinal,
    pDoneDisplay: formatPctPrecise(directFinal),
    pBrick,
    smashPerAttempt: smash,
    stateEvDebug: node?.stateEvDebug ?? null,
    outcomeMass: node?.outcomeMass ?? null,
    craftWithoutPath: node?.craftWithoutPath ?? 0,
    craftOutcomes: node?.craftOutcomes ?? [],
    fallbacks: node?.fallbacks ?? [],
    totalIncomplete: !!baseUnknown,
    knownComponentEv: totalExpectedTradableCostChaos,
    // Currency EV may still be compared, but never claim a precise complete craft total when base is unknown.
    rankedAsComplete: false,
  };

  const inv = assertRecombEconomicsInvariants(report, node);
  report.invariantsOk = inv.ok;
  report.invariantFailures = inv.fails;

  const impractical =
    !(directFinal > MIN_PRACTICAL_P_DONE) ||
    !Number.isFinite(E) ||
    E > MAX_PRACTICAL_ATTEMPTS ||
    !Number.isFinite(totalExpectedEconomicCostChaos) ||
    (!(totalExpectedEconomicCostChaos > 0) &&
      (donorA + donorB > 0 || (smash.gold ?? 0) > 0 || (smash.dust ?? 0) > 0)) ||
    !inv.ok;

  report.impractical = impractical;
  report.economicsInvalid = !inv.ok;
  report.impracticalReason = impractical
    ? !inv.ok
      ? `invalid / EV unresolved: ${inv.fails[0]}`
      : !(directFinal > MIN_PRACTICAL_P_DONE)
        ? `Direct final/recomb ${formatPctPrecise(directFinal)} impractically low`
        : E > MAX_PRACTICAL_ATTEMPTS
          ? `Expected recombinations ${E} diverge`
          : !(totalExpectedEconomicCostChaos > 0) && donorA + donorB > 0
            ? 'EV ~0c with positive donor cost'
            : 'EV not finite'
    : null;

  return report;
}

/** Human display block for UI / dump. */
export function formatRecombEconomicsDisplay(report) {
  if (!report) return null;
  const lines = [];
  if (report.economicsInvalid || report.impractical) {
    lines.push(`Status: invalid / EV unresolved`);
    if (report.impracticalReason) lines.push(report.impracticalReason);
  }
  const tradable = report.totalExpectedTradableCostChaos;
  const incomplete = report.totalIncomplete;
  if (incomplete && tradable != null && Number.isFinite(tradable)) {
    lines.push(`Known-component EV: ~${roundEv(tradable).toLocaleString()}c`);
    lines.push(`Base acquisition: unknown`);
    lines.push(`Total EV: >=${roundEv(tradable).toLocaleString()}c`);
  } else {
    lines.push(
      `Expected tradable cost: ${
        tradable == null || !Number.isFinite(tradable)
          ? '?'
          : `${roundEv(tradable).toLocaleString()}c`
      }`
    );
  }
  if (report.grossDonorConstructionEV != null) {
    lines.push(
      `Gross donor construction: ~${roundEv(report.grossDonorConstructionEV).toLocaleString()}c` +
        (report.expectedSalvageCredit
          ? ` − salvage credit ~${roundEv(report.expectedSalvageCredit)}c`
          : '')
    );
  }
  if (report.expectedNonRecombCraftingChaos != null) {
    lines.push(
      `Expected non-recomb crafting: ~${roundEv(report.expectedNonRecombCraftingChaos).toLocaleString()}c`
    );
  }
  if (report.breakdown) {
    const b = report.breakdown;
    lines.push(
      `Audit: donors ${roundEv(b.grossDonorConstructionEV ?? 0)}c + craft ${roundEv(b.expectedNonRecombCraftingChaos ?? 0)}c + recomb fees ${roundEv(b.tradableRecombCostsChaos ?? 0)}c + setup ${roundEv(b.initialSetupCostChaos ?? 0)}c − salvage ${roundEv(b.expectedSalvageCredit ?? 0)}c`
    );
  }
  const g =
    report.expectedGold != null && Number.isFinite(report.expectedGold)
      ? report.expectedGold >= 1000
        ? `${Math.round(report.expectedGold / 1000)}k`
        : String(Math.round(report.expectedGold))
      : '?';
  const d =
    report.expectedDust != null && Number.isFinite(report.expectedDust)
      ? report.expectedDust >= 1000
        ? `${Math.round(report.expectedDust / 1000)}k`
        : String(Math.round(report.expectedDust))
      : '?';
  lines.push(`Expected recombination resources: ${g} Gold + ${d} Dust`);
  if (report.expectedTotalRecombinationsUntilFinished != null) {
    lines.push(
      `Expected recombinations until finished: ${report.expectedTotalRecombinationsUntilFinished}`
    );
  }
  if (report.outcomeMass) {
    const m = report.outcomeMass;
    lines.push(
      `Transitions: ${formatPctPrecise(m.final)} final · ${formatPctPrecise(m.salvageBenchOnly)} bench · ${formatPctPrecise(m.salvageCraftNoRecomb)} craft · ${formatPctPrecise(m.salvageRequiringAnotherRecombination)} recomb-again · ${formatPctPrecise(m.brickRestart)} restart`
    );
  }
  if (report.dustEquivalentLabel) lines.push(report.dustEquivalentLabel);
  if (report.goldOpportunityLabel) lines.push(report.goldOpportunityLabel);
  const eco = report.totalExpectedEconomicCostChaos;
  if (eco != null && Number.isFinite(eco) && !report.economicsInvalid) {
    lines.push(
      incomplete
        ? `Economic EV (currency only): ~${roundEv(eco).toLocaleString()}c — total incomplete`
        : `Economic EV: ~${roundEv(eco).toLocaleString()}c`
    );
  }
  if (report.breakdown && tradable != null && Number.isFinite(eco) && !report.economicsInvalid) {
    const dustAdd = report.dustCountedInTradable ? 0 : report.dustChaosEquivalent ?? 0;
    const goldAdd = report.goldOpportunityChaosEquivalent ?? 0;
    lines.push(
      `Reconcile: ${roundEv(tradable)}c tradable + ${roundEv(dustAdd)}c dust + ${roundEv(goldAdd)}c gold opp = ${roundEv(tradable + dustAdd + goldAdd)}c`
    );
  }
  if (report.directFinalDisplay) {
    lines.push(`Direct final/recomb: ${report.directFinalDisplay}`);
  }
  if (report.eventualCompletionDisplay) {
    lines.push(`Eventual completion: ${report.eventualCompletionDisplay}`);
  }
  return lines.join('\n');
}

/**
 * Prefer solver EV over bag-derived chaos when the bag is smash-only
 * (avoids 0c overwrite from empty tradable split).
 */
export function resolveTradableCost(plan, dims) {
  const fromSolver =
    plan?.totalExpectedTradableCostChaos ??
    plan?.economics?.totalExpectedTradableCostChaos ??
    null;
  if (fromSolver != null && Number.isFinite(fromSolver)) return fromSolver;

  const { tradable, nonTradable } = splitCostBag(plan?.costs ?? {});
  const onlySmash =
    Object.keys(tradable).length === 0 &&
    Object.keys(nonTradable).some((k) => isNonTradableKey(k));

  if (onlySmash) {
    if (plan?.totalCost != null && Number.isFinite(plan.totalCost) && plan.totalCost > 0) {
      return plan.totalCost;
    }
    if (dims?.chaosEquivalent === 0) return plan?.totalCost ?? null;
  }

  if (dims?.chaosEquivalent != null && Number.isFinite(dims.chaosEquivalent)) {
    if (dims.chaosEquivalent === 0 && plan?.totalCost != null && plan.totalCost > 0) {
      return plan.totalCost;
    }
    return dims.chaosEquivalent;
  }
  return plan?.totalCost ?? null;
}

export { tradableChaosCost, splitCostBag };
