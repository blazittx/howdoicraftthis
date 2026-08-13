/**
 * Recombinator optimizer. Values model outcomes against target T.
 * Does not implement recombination physics — that is recombinatorModel.
 * V(state) lives in craftValue.
 */
import {
  getRecombinatorModel,
  modelMeta,
  OPERATOR_UNPREDICTABLE,
  OPERATOR_PREDICTABLE,
  predictableRecombine,
  ALLFLAME_SUPPORTED,
} from './recombinatorModel.js';
import { solveValue, evWithSalvage, roundEv, donorMiniPlan, sequentialRemaining } from './craftValue.js';
import {
  formatPctPrecise,
  buildRecombCostReport,
  formatRecombEconomicsDisplay,
} from './pricing/recombEconomics.js';

function notBench(m) {
  return !m.crafted && m.method !== 'bench' && m.match?.source !== 'crafted';
}

function genOf(m) {
  return m.gen === 'suffix' ? 'suffix' : 'prefix';
}

function donorLabel(mods) {
  return mods.map((m) => m.short ?? m.text).join(' · ');
}

function formatSmashAmount(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

function formatSmashBand(mid, band) {
  if (Array.isArray(band) && band.length === 2 && band.every((x) => Number.isFinite(x))) {
    return `${formatSmashAmount(band[0])}–${formatSmashAmount(band[1])}`;
  }
  return mid == null || !Number.isFinite(mid) ? '?' : `~${formatSmashAmount(mid)}`;
}

function smashDetailLine(bag) {
  const midG = bag?.gold != null && Number.isFinite(bag.gold) ? formatSmashAmount(bag.gold) : null;
  const midD =
    bag?.['thaumaturgic-dust'] != null && Number.isFinite(bag['thaumaturgic-dust'])
      ? formatSmashAmount(bag['thaumaturgic-dust'])
      : null;
  const g = midG != null ? `~${midG} Gold` : '? Gold';
  const d = midD != null ? `~${midD} Dust` : '? Dust';
  const range =
    Array.isArray(bag?.goldBand) && Array.isArray(bag?.dustBand)
      ? `; band ${formatSmashBand(bag.gold, bag.goldBand)} Gold · ${formatSmashBand(bag['thaumaturgic-dust'], bag.dustBand)} Dust`
      : '';
  const conf = bag?.confidence ? `; confidence=${bag.confidence}` : '';
  const src = bag?.source ? `; source=${bag.source}` : '';
  return `Pays Gold + Thaumaturgic Dust (${g} · ${d}${range}${conf}${src} — amounts from cost dataset, not a closed-form formula).`;
}

function recipeDetail(mini) {
  const r = mini?.recipe;
  if (!r?.lines?.length) {
    return `Mini-plan EV ~${roundEv(mini?.ev)}c (${(mini?.ops ?? []).join(' → ') || 'manufacture'}).`;
  }
  return r.lines
    .map((l) => {
      if (l.kind === 'total') return `${l.text}: ~${roundEv(l.chaos)}c`;
      if (l.chaos != null) return `${l.text} (~${roundEv(l.chaos)}c)${l.note ? ` — ${l.note}` : ''}`;
      return `${l.text}${l.note ? ` — ${l.note}` : ''}`;
    })
    .join(' | ');
}

function collectRecombBags(node, into = {}) {
  if (!node || (node.method !== 'recombine' && node.method !== 'predictableRecombine')) return into;
  collectRecombBags(node.left, into);
  collectRecombBags(node.right, into);
  for (const [k, n] of Object.entries(node.recombBag ?? {})) {
    if (k === 'confidence' || k === 'source' || k === 'goldBand' || k === 'dustBand') continue;
    if (n == null) {
      if (!(k in into)) into[k] = null;
      continue;
    }
    if (n > 0) into[k] = (into[k] ?? 0) + n;
  }
  return into;
}

function finishFromState(ctx, haveKeys) {
  if (!ctx?.sequentialRemaining) return { ev: 0, ops: [], detail: 'No finishing required.' };
  const rem = ctx.sequentialRemaining(haveKeys ?? [], ctx);
  const ops = rem.ops ?? [];
  return {
    ev: rem.ev ?? 0,
    ops,
    detail: ops.length
      ? `Finish from post-recomb state via ${ops.join(' → ')} (~${roundEv(rem.ev)}c). Simulated from open slots / keepers — not a blind Veiled Chaos loop.`
      : 'Target complete after recomb (bench only if reserved).',
  };
}

function donorStepFields(mini, fallbackEv) {
  const expectedCostChaos = mini?.expectedCostChaos ?? mini?.ev ?? fallbackEv;
  const successChancePerAttempt = mini?.successChancePerAttempt ?? mini?.recipe?.successChancePerAttempt ?? null;
  const expectedAttempts = mini?.expectedAttempts ?? mini?.recipe?.expectedAttempts ?? null;
  let chanceLabel = null;
  if (successChancePerAttempt != null && Number.isFinite(successChancePerAttempt)) {
    chanceLabel = `success ${formatPctPrecise(successChancePerAttempt)}/attempt`;
    if (expectedAttempts != null) chanceLabel += ` · ~${Math.round(expectedAttempts * 100) / 100} att`;
  }
  return {
    chance: successChancePerAttempt,
    chanceLabel,
    successChancePerAttempt,
    expectedAttempts,
    expectedCostChaos,
    expectedCost: expectedCostChaos,
  };
}

function donorSidePlan(sideNode, mods, fallbackEv, ctx) {
  // Prefer the scored donor EV/recipe so displayed total matches grossDonorConstructionEV
  if (sideNode?.recipe || sideNode?.mini?.recipe) {
    const recipe = sideNode.recipe ?? sideNode.mini?.recipe;
    const ev = sideNode.ev ?? sideNode.expectedCostChaos ?? recipe?.expectedCostChaos ?? fallbackEv;
    return {
      ev,
      expectedCostChaos: ev,
      ops: sideNode.ops ?? sideNode.mini?.ops ?? [],
      recipe,
      successChancePerAttempt: sideNode.successChancePerAttempt ?? recipe?.successChancePerAttempt,
      expectedAttempts: sideNode.expectedAttempts ?? recipe?.expectedAttempts,
      baseAcquisitionUnknown: !!(sideNode.baseAcquisitionUnknown || recipe?.baseAcquisitionUnknown),
    };
  }
  if (ctx && mods?.length) {
    const mini = donorMiniPlan(mods, ctx);
    return { ...mini, expectedCostChaos: mini.expectedCostChaos ?? mini.ev ?? fallbackEv };
  }
  return { ev: fallbackEv, expectedCostChaos: fallbackEv, ops: [], recipe: null };
}

function formatOutcomeProof(f) {
  const keep = `${f.have?.length ?? 0} desired`;
  const cost = f.ev != null && Number.isFinite(f.ev) ? `~${roundEv(f.ev)}c` : '?c';
  const rec = Array.isArray(f.recipe) ? f.recipe.join('→') : f.recipe;
  const un = (f.unwanted ?? []).length ? `, unwanted=${(f.unwanted ?? []).length}` : '';
  const fail =
    f.pFail > 0
      ? `, P(fail)=${formatPctPrecise(f.pFail)}→${f.recovery ?? 'restart'}`
      : '';
  return `${formatPctPrecise(f.p)} keep ${keep} (${cost}${rec ? `; ${rec}` : ''}${un}${fail})`;
}

function planFromNode(node, ctx) {
  if (!node || node.method === 'sequential' || node.method === 'manufacture') return null;
  const steps = [];
  const walk = (n) => {
    if (!n || (n.method !== 'recombine' && n.method !== 'predictableRecombine')) return;
    if (n.left) walk(n.left);
    if (n.right) walk(n.right);
    const aMods = n.partition[0];
    const bMods = n.partition[1];
    const d1 = n.left?.method === 'recombine' || n.left?.method === 'current' ? null : aMods;
    const d2 = n.right?.method === 'recombine' ? null : bMods;
    if (d1?.length && n.left?.method !== 'current') {
      const mini = donorSidePlan(n.left, d1, n.costA, ctx);
      steps.push({
        operator: 'recombDonor',
        currency: 'quality',
        action: `Donor A: ${donorLabel(d1)}`,
        detail: recipeDetail(mini),
        targetMods: d1.map((m) => m.short ?? m.text),
        cost: {},
        stage: 'donor',
        ...donorStepFields(mini, n.costA),
        miniPlan: mini,
        recipe: mini.recipe ?? null,
      });
    }
    if (d2?.length) {
      const mini = donorSidePlan(n.right, d2, n.costB, ctx);
      steps.push({
        operator: 'recombDonor',
        currency: 'quality',
        action: `Donor B: ${donorLabel(d2)}`,
        detail: recipeDetail(mini),
        targetMods: d2.map((m) => m.short ?? m.text),
        cost: {},
        stage: 'donor',
        ...donorStepFields(mini, n.costB),
        miniPlan: mini,
        recipe: mini.recipe ?? null,
      });
    }
    const nP = aMods.filter((m) => genOf(m) === 'prefix').length + bMods.filter((m) => genOf(m) === 'prefix').length;
    const nS = aMods.filter((m) => genOf(m) === 'suffix').length + bMods.filter((m) => genOf(m) === 'suffix').length;
    const craftFb = (n.craftOutcomes?.length ? n.craftOutcomes : n.fallbacks ?? []).filter(
      (f) => f.kind === 'CRAFT' || f.kind === 'BENCH' || f.finishKind === 'craftNoRecomb' || f.finishKind === 'bench'
    );
    const allFb = n.fallbacks?.length ? n.fallbacks : craftFb;
    const listedMass = allFb.reduce((s, f) => s + (f.p ?? 0), 0);
    const fbTop = allFb.slice(0, 8).map(formatOutcomeProof).join('; ');
    const fbMore =
      listedMass < 0.98
        ? ` [classes cover ${formatPctPrecise(listedMass)}]`
        : '';
    const eco = n.economics;
    const direct = n.directFinalProbabilityPerRecombination ?? n.pDone ?? 0;
    const E =
      eco?.expectedTotalRecombinationsUntilFinished ??
      n.expectedTotalRecombinationsUntilFinished ??
      eco?.expectedRecombinationAttempts;
    const restartP = n.outcomeMass?.brickRestart ?? n.pBrick ?? 0;
    const eLine =
      E != null
        ? restartP > 1e-6
          ? `Expected recombinations until finished ~${E} (bricks restart; salvage does not zero the count).`
          : `Expected recombinations until finished ~${E}.`
        : '';
    steps.push({
      operator: n.operator === OPERATOR_PREDICTABLE ? OPERATOR_PREDICTABLE : OPERATOR_UNPREDICTABLE,
      currency: 'gold',
      action:
        n.operator === OPERATOR_PREDICTABLE
          ? `Predictable Recombination (${nP}P + ${nS}S; displayed ${
              n.displayedChance != null ? formatPctPrecise(n.displayedChance) : '?'
            })`
          : `Unpredictable Recombination (${nP}P + ${nS}S pooled)`,
      detail: [
        n.operator === OPERATOR_PREDICTABLE
          ? `Uses displayed/empirical success only — never an invented formula.`
          : `Prefix/suffix counts rolled separately. Direct final/recomb ≈ ${formatPctPrecise(direct)}.`,
        fbTop ? `Outcome classes: ${fbTop}${fbMore}.` : '',
        `Salvage = V(outcome state), not donor rebuild cost.`,
        smashDetailLine(n.recombBag),
        eLine,
        n.eventualCompletionProbability != null
          ? `Eventual completion ≈ ${formatPctPrecise(n.eventualCompletionProbability)}.`
          : '',
        `Why this split: ${n.whySplit}`,
      ]
        .filter(Boolean)
        .join(' '),
      targetMods: [...aMods, ...bMods].map((m) => m.short ?? m.text),
      cost: {
        gold: n.recombBag?.gold ?? null,
        'thaumaturgic-dust': n.recombBag?.['thaumaturgic-dust'] ?? null,
      },
      stage: 'recombine',
      chance: direct,
      chanceLabel: `direct final/recomb ${formatPctPrecise(direct)}`,
      directFinalProbabilityPerRecombination: direct,
      eventualCompletionProbability: n.eventualCompletionProbability ?? null,
      expectedTotalRecombinationsUntilFinished: E ?? null,
      fallbacks: n.fallbacks,
      craftOutcomes: n.craftOutcomes,
      expectedCost: n.ev,
      recombMeta: {
        operator: n.operator === OPERATOR_PREDICTABLE ? OPERATOR_PREDICTABLE : OPERATOR_UNPREDICTABLE,
        prefixesPooled: nP,
        suffixesPooled: nS,
        pDone: n.pDone,
        pBrick: n.pBrick,
        directFinalProbabilityPerRecombination: direct,
        eventualCompletionProbability: n.eventualCompletionProbability ?? null,
        displayedChance: n.displayedChance ?? null,
        expectedAttempts: E ?? null,
        expectedTotalRecombinationsUntilFinished: E ?? null,
        expectedFullDonorARebuilds: eco?.expectedFullDonorARebuilds ?? n.expectedFullDonorARebuilds ?? null,
        expectedFullDonorBRebuilds: eco?.expectedFullDonorBRebuilds ?? n.expectedFullDonorBRebuilds ?? null,
        expectedPartialStateReuses: eco?.expectedPartialStateReuses ?? n.expectedPartialStateReuses ?? null,
      },
    });
  };
  walk(node);

  const finish = finishFromState(ctx, ctx.startHave ?? []);
  const leftover = (ctx.sequentialSteps ?? []).filter(
    (s) => s.operator === 'unveil' || s.operator === 'bench'
  );
  if (leftover.length) {
    for (const s of leftover) {
      steps.push({
        ...s,
        stage: s.operator === 'bench' ? 'bench' : 'unveil',
        detail:
          (s.detail ?? '') +
          (s.operator === 'unveil'
            ? ' Finish EV from post-recomb affix state (slots/metacraft/veiled side), not a fixed Veiled Chaos×N assumption.'
            : ''),
      });
    }
  } else if (ctx.benchMods?.length || (finish.ops ?? []).length) {
    steps.push({
      operator: 'recombFallback',
      currency: 'quality',
      action: 'Finish remaining from post-recomb state',
      detail: finish.detail,
      targetMods: (ctx.benchMods ?? []).map((m) => m.short ?? m.text),
      cost: {},
      stage: 'fallback',
      expectedCost: finish.ev,
      fallback: true,
    });
  }
  return steps;
}

function smashShort(bag) {
  const g =
    bag?.gold != null && Number.isFinite(bag.gold) ? `~${formatSmashAmount(bag.gold)} Gold` : '? Gold';
  const d =
    bag?.['thaumaturgic-dust'] != null && Number.isFinite(bag['thaumaturgic-dust'])
      ? `~${formatSmashAmount(bag['thaumaturgic-dust'])} Dust`
      : '? Dust';
  return `${g} · ${d}`;
}

function whyLost(seqEv, recombEv, seqOps, bag, report) {
  const chain = (seqOps ?? []).length ? seqOps.join(' → ') : 'entropy-reducing chain';
  const incomplete = report?.totalIncomplete;
  const rec = Number.isFinite(recombEv)
    ? incomplete
      ? `known-component ~${roundEv(recombEv)}c (base unknown; total >=${roundEv(recombEv)}c)`
      : `~${roundEv(recombEv)}c`
    : 'unranked';
  const eco =
    report?.impracticalReason ??
    (report?.totalExpectedTradableCostChaos != null
      ? incomplete
        ? `known-component ~${roundEv(report.totalExpectedTradableCostChaos)}c`
        : `tradable ~${roundEv(report.totalExpectedTradableCostChaos)}c`
      : '');
  return `Sequential ~${roundEv(seqEv)}c beats recombinator ${rec} (${chain}; smash ${smashShort(bag)} from cost dataset; ${eco}; full EV = donors + retries + finish − salvage). Recombinator EV is experimental.`;
}

function whyWin(recombEv, seqEv, pDone, bag, report) {
  const tradable = report?.totalExpectedTradableCostChaos ?? recombEv;
  const E = report?.expectedTotalRecombinationsUntilFinished ?? report?.expectedRecombinationAttempts;
  const direct = report?.directFinalDisplay ?? formatPctPrecise(pDone ?? 0);
  const incomplete = report?.totalIncomplete;
  const costBit = incomplete
    ? `known-component ~${roundEv(tradable)}c (base unknown; total >=${roundEv(tradable)}c; not a complete price vs sequential ~${roundEv(seqEv)}c)`
    : `full EV ~${roundEv(recombEv)}c (tradable ~${roundEv(tradable)}c) vs sequential ~${roundEv(seqEv)}c`;
  return `Recombinator ${costBit}. Direct final/recomb ≈ ${direct}${E != null ? `; E[recombs]≈${E}` : ''}. Smash ${smashShort(bag)} (dataset); gold/dust not silently 0c. Recombinator EV is experimental until the model is verified.`;
}

function attachEconomics(node, ctx, model) {
  if (!node || node.unranked || !Number.isFinite(node.ev)) return node;
  if (node.economics) return node;
  node.economics = buildRecombCostReport(node, {
    prices: ctx.prices,
    model,
    ...(ctx.planOpts ?? {}),
  });
  if (node.economics?.economicsInvalid || node.economics?.impractical) {
    node.unranked = true;
    node.ev = Infinity;
    node.reason = node.economics.impracticalReason ?? 'economics-invalid';
  }
  return node;
}

function spreadEconomicsFields(eco) {
  if (!eco) return {};
  return {
    initialSetupCostChaos: eco.initialSetupCostChaos,
    expectedDonorCostChaos: eco.expectedDonorCostChaos,
    grossDonorConstructionEV: eco.grossDonorConstructionEV,
    expectedSalvageCredit: eco.expectedSalvageCredit,
    grossCraftEV: eco.grossCraftEV,
    netCraftEV: eco.netCraftEV,
    expectedNonRecombCraftingChaos: eco.expectedNonRecombCraftingChaos,
    expectedRecombinationAttempts: eco.expectedRecombinationAttempts,
    expectedTotalRecombinationsUntilFinished: eco.expectedTotalRecombinationsUntilFinished,
    expectedFullDonorARebuilds: eco.expectedFullDonorARebuilds,
    expectedFullDonorBRebuilds: eco.expectedFullDonorBRebuilds,
    expectedPartialStateReuses: eco.expectedPartialStateReuses,
    expectedRecombinationCurrencyChaos: eco.expectedRecombinationCurrencyChaos,
    expectedDust: eco.expectedDust,
    expectedGold: eco.expectedGold,
    dustChaosEquivalent: eco.dustChaosEquivalent,
    goldOpportunityChaosEquivalent: eco.goldOpportunityChaosEquivalent,
    expectedFinishingCostChaos: eco.expectedFinishingCostChaos,
    expectedSalvageChaos: eco.expectedSalvageChaos,
    directFinalProbabilityPerRecombination: eco.directFinalProbabilityPerRecombination,
    eventualCompletionProbability: eco.eventualCompletionProbability,
    economicsBreakdown: eco.breakdown,
    invariantsOk: eco.invariantsOk,
    economicsInvalid: eco.economicsInvalid,
    totalIncomplete: eco.totalIncomplete,
    knownComponentEv: eco.knownComponentEv,
    outcomeMass: eco.outcomeMass,
    craftOutcomes: eco.craftOutcomes,
    impracticalReason: eco.impracticalReason,
  };
}

/**
 * @param {{
 *   mods: object[],
 *   sequentialCost: number,
 *   sequentialName?: string,
 *   sequentialDescription?: string,
 *   sequentialSteps?: object[],
 *   sequentialCosts?: object,
 *   fractureCost?: number|null,
 *   fractureName?: string,
 *   costOne: (mod) => number,
 *   itemMeta: object,
 *   kb?: object,
 *   prices?: object,
 *   baseTags?: string[],
 *   ilvl?: number,
 * }} ctx
 */
export function considerRecombinator(ctx) {
  const model = getRecombinatorModel(ctx.kb);
  const meta = modelMeta(model);
  const all = (ctx.mods ?? []).filter(notBench);
  const benchMods = (ctx.mods ?? []).filter((m) => !notBench(m));
  const live = all.filter((m) => !m.fractured);
  const sequentialCost = ctx.sequentialCost;
  if (live.length < 2 || sequentialCost == null || !Number.isFinite(sequentialCost)) {
    return null;
  }

  const solved = solveValue({
    ...ctx,
    benchMods,
  });
  const bestScratch = solved.best;
  const seqEv = sequentialCost;
  const isPred = bestScratch.method === 'predictableRecombine' || bestScratch.operator === OPERATOR_PREDICTABLE;
  const isUnpred = bestScratch.method === 'recombine' || bestScratch.operator === OPERATOR_UNPREDICTABLE;
  const unpredNode =
    isUnpred && Number.isFinite(bestScratch.ev)
      ? bestScratch
      : bestScratch.recombAlt && !bestScratch.recombAlt.unranked
        ? bestScratch.recombAlt
        : null;
  const predNode =
    isPred && Number.isFinite(bestScratch.ev)
      ? bestScratch
      : bestScratch.predictableAlt && !bestScratch.predictableAlt.unranked
        ? bestScratch.predictableAlt
        : bestScratch.predictableAlt ?? null;

  attachEconomics(unpredNode, ctx, model);
  attachEconomics(predNode, ctx, model);

  const recombNode = unpredNode;
  const recombEv = recombNode?.ev ?? Infinity;
  const predEv = predNode && !predNode.unranked ? predNode.ev : Infinity;
  const unranked =
    !Number.isFinite(recombEv) || !!recombNode?.economics?.impractical || !!recombNode?.unranked;
  const predUnranked =
    !predNode || !!predNode.unranked || !Number.isFinite(predEv) || !!predNode?.economics?.impractical;
  const bestRecombEv = Math.min(
    unranked ? Infinity : recombEv,
    predUnranked ? Infinity : predEv
  );
  const wonOp =
    Number.isFinite(bestRecombEv) && bestRecombEv < seqEv - 1
      ? !predUnranked && predEv < recombEv
        ? OPERATOR_PREDICTABLE
        : !unranked
          ? OPERATOR_UNPREDICTABLE
          : null
      : null;
  const won = !!wonOp;
  const winNode = wonOp === OPERATOR_PREDICTABLE ? predNode : recombNode;
  const work = {
    ...ctx,
    benchMods,
    sequentialSteps: ctx.sequentialSteps,
    startHave: solved.startHave,
    sequentialRemaining,
  };

  const recombSteps = won && winNode ? planFromNode(winNode, work) : null;
  const seqOps = bestScratch.seq?.ops ?? solved.sequential?.ops;
  const smashBag = winNode?.recombBag ?? recombNode?.recombBag ?? predNode?.recombBag;
  const winReport = winNode?.economics;
  const why = won
    ? whyWin(winNode.ev, seqEv, winNode.pDone, smashBag, winReport)
    : whyLost(
        seqEv,
        Number.isFinite(recombEv) ? recombEv : predEv,
        seqOps,
        smashBag,
        recombNode?.economics ?? predNode?.economics
      );

  const comparison = {
    winner: won ? (wonOp === OPERATOR_PREDICTABLE ? 'predictableRecombinator' : 'recombinator') : 'sequential',
    sequential: {
      cost: roundEv(seqEv),
      name: ctx.sequentialName ?? 'Sequential',
      why: won
        ? 'Existing essence / harvest / exalt / fracture path on one item.'
        : 'Cheapest single-item route: entropy-reducing chain (essence, protect+reforge, native unveil).',
    },
    fracture:
      ctx.fractureCost != null
        ? {
            cost: roundEv(ctx.fractureCost),
            name: ctx.fractureName ?? 'Fracture',
            why: 'Fracture by downstream EV, not rarity.',
          }
        : null,
    recombinator: {
      cost: Number.isFinite(recombEv) && !unranked ? roundEv(recombEv) : null,
      name: 'Unpredictable Recombinator',
      operator: OPERATOR_UNPREDICTABLE,
      why: wonOp === OPERATOR_UNPREDICTABLE ? why : whyLost(seqEv, recombEv, seqOps, smashBag, recombNode?.economics),
      selected: wonOp === OPERATOR_UNPREDICTABLE,
      experimental: true,
      unranked,
      pDone: recombNode?.pDone ?? null,
      pDoneDisplay: formatPctPrecise(recombNode?.pDone ?? 0),
      directFinalProbabilityPerRecombination:
        recombNode?.directFinalProbabilityPerRecombination ?? recombNode?.pDone ?? null,
      eventualCompletionProbability: recombNode?.eventualCompletionProbability ?? null,
      expectedTotalRecombinationsUntilFinished:
        recombNode?.expectedTotalRecombinationsUntilFinished ??
        recombNode?.economics?.expectedTotalRecombinationsUntilFinished ??
        null,
      economics: recombNode?.economics ?? null,
      partition: recombNode?.partition
        ? recombNode.partition.map((side) => (side ?? []).map((m) => m.short ?? m.text))
        : null,
    },
    predictableRecombinator: {
      cost: !predUnranked ? roundEv(predEv) : null,
      name: 'Predictable Recombinator',
      operator: OPERATOR_PREDICTABLE,
      why: predUnranked
        ? predNode?.reason === 'unknown-displayed-chance' || !ctx.displayedChance
          ? 'Predictable success % missing (displayed/empirical only) — unranked; no invented formula.'
          : predNode?.reason ?? 'unranked'
        : wonOp === OPERATOR_PREDICTABLE
          ? why
          : `Predictable EV ~${roundEv(predEv)}c vs sequential ~${roundEv(seqEv)}c.`,
      selected: wonOp === OPERATOR_PREDICTABLE,
      experimental: true,
      unranked: predUnranked,
      displayedChance: predNode?.displayedChance ?? ctx.displayedChance ?? null,
      pDone: predNode?.pDone ?? null,
      economics: predNode?.economics ?? null,
    },
    model: meta,
    operatorsCompeting: solved.operatorsCompeting ?? [OPERATOR_UNPREDICTABLE, OPERATOR_PREDICTABLE],
  };

  if (ctx.fractureCost != null && ctx.fractureCost < (won ? winNode.ev : sequentialCost)) {
    comparison.winner = 'fracture';
  }

  const costs = won ? collectRecombBags(winNode) : ctx.sequentialCosts;
  const steps = won && recombSteps?.length ? recombSteps : ctx.sequentialSteps;
  const economics = won ? winNode?.economics : null;
  const totalCost = won
    ? roundEv(winNode.ev)
    : Number.isFinite(bestRecombEv)
      ? roundEv(bestRecombEv)
      : sequentialCost;

  if (won && economics && (economics.expectedDonorCostChaos ?? 0) > 1 && !(totalCost > 0)) {
    return {
      won: false,
      experimental: true,
      unranked: true,
      operator: OPERATOR_UNPREDICTABLE,
      ev: null,
      comparison: {
        ...comparison,
        winner: 'sequential',
        recombinator: {
          ...comparison.recombinator,
          unranked: true,
          cost: null,
          why: 'Rejected: donor EV > 0 but total EV collapsed to ~0c (inconsistent).',
        },
      },
      model: meta,
      steps: ctx.sequentialSteps,
      costs: ctx.sequentialCosts,
      totalCost: sequentialCost,
      economics: null,
      name: ctx.sequentialName,
      description: ctx.sequentialDescription,
      alternative: null,
    };
  }

  return {
    won,
    experimental: true,
    unranked: wonOp === OPERATOR_PREDICTABLE ? predUnranked : unranked,
    operator: wonOp ?? OPERATOR_UNPREDICTABLE,
    ev: roundEv(won ? winNode.ev : bestRecombEv),
    comparison,
    model: meta,
    steps,
    costs,
    economics,
    economicsDisplay: economics ? formatRecombEconomicsDisplay(economics) : null,
    ...spreadEconomicsFields(economics),
    totalCost,
    totalExpectedTradableCostChaos:
      economics?.totalExpectedTradableCostChaos ??
      (won ? roundEv(winNode.evTradable ?? winNode.ev) : null),
    totalExpectedEconomicCostChaos:
      economics?.totalExpectedEconomicCostChaos ?? (won ? totalCost : null),
    name: won
      ? wonOp === OPERATOR_PREDICTABLE
        ? 'Predictable Recombinator'
        : 'Unpredictable Recombinator'
      : ctx.sequentialName,
    description: won ? why : ctx.sequentialDescription,
    alternative: won
      ? {
          id: 'sequential',
          name: ctx.sequentialName ?? 'Sequential',
          description: ctx.sequentialDescription ?? 'Single-item essence / harvest / exalt / fracture.',
          totalCost: roundEv(sequentialCost),
          costs: ctx.sequentialCosts,
        }
      : recombNode && !unranked
        ? {
            id: 'recombinator',
            name: 'Unpredictable Recombinator',
            description: why,
            totalCost: roundEv(recombEv),
            economics: recombNode.economics,
          }
        : null,
  };
}

/**
 * PredictableRecombine hook — displayed/empirical chance required.
 * Without it → unranked (never invent a formula). Scoring still lives in craftValue.
 */
export function considerPredictableRecombine(ctx) {
  const model = getRecombinatorModel(ctx.kb);
  const meta = modelMeta(model);
  if (!ALLFLAME_SUPPORTED && ctx.requireAllflame) {
    return {
      won: false,
      experimental: true,
      unranked: true,
      operator: OPERATOR_PREDICTABLE,
      reason: 'allflame-unsupported',
      model: meta,
    };
  }
  const chance = ctx.displayedChance ?? ctx.successChance;
  if (chance == null || !Number.isFinite(chance)) {
    return {
      won: false,
      experimental: true,
      unranked: true,
      operator: OPERATOR_PREDICTABLE,
      reason: 'unknown-displayed-chance',
      model: meta,
      comparison: {
        winner: 'sequential',
        recombinator: {
          name: 'Predictable Recombinator',
          cost: null,
          unranked: true,
          experimental: true,
          why: 'Predictable chance is UI/empirical only — no invented formula; plan unranked.',
        },
        model: meta,
      },
    };
  }
  const dist = predictableRecombine(
    ctx.stateA,
    ctx.stateB,
    {
      displayedChance: chance,
      selected: ctx.selected,
      baseChoice: ctx.baseChoice ?? 'either',
    },
    model
  );
  return {
    won: false,
    experimental: true,
    unranked: !!dist.unranked,
    operator: OPERATOR_PREDICTABLE,
    displayedChance: chance,
    distribution: dist,
    model: meta,
    comparison: {
      winner: 'unranked',
      recombinator: {
        name: 'Predictable Recombinator',
        cost: null,
        unranked: true,
        experimental: true,
        pDisplay: chance,
        why: 'Predictable operator hooked; EV ranking deferred to craftValue/planner.',
      },
      model: meta,
    },
  };
}

export { evWithSalvage, OPERATOR_UNPREDICTABLE, OPERATOR_PREDICTABLE, formatPctPrecise };
