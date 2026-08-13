const RECOMB_OPS = new Set(['recombine', 'recombDonor', 'predictableRecombine', 'unpredictableRecombine']);

function minChance(plan) {
  let min = null;
  for (const s of plan.steps ?? []) {
    const p = s.chance;
    if (p == null || !(p >= 0)) continue;
    if (min == null || p < min) min = p;
  }
  return min;
}

function hasRecomb(plan) {
  if (
    plan.method === 'recombinator' ||
    plan.id === 'recombinator' ||
    /recombinator/i.test(plan.methodName ?? plan.name ?? '')
  ) {
    return true;
  }
  return (plan.steps ?? []).some((s) => RECOMB_OPS.has(s.operator));
}

function allGuaranteed(plan) {
  const steps = (plan.steps ?? []).filter((s) => !s.progressDone);
  if (!steps.length) return false;
  return steps.every((s) => {
    if (s.chance == null) {
      return ['buyBase', 'buyFracturedBase', 'benchCraft', 'quality', 'enchant', 'implicit'].includes(
        s.operator
      );
    }
    return s.chance >= 0.999;
  });
}

/** Classify a plan. Never label recombination as deterministic (§30). */
export function classifyPlan(plan) {
  const experimental = !!(plan.experimental || plan.methodComparison?.recombinator?.experimental);
  if (hasRecomb(plan)) {
    return {
      id: 'probabilistic-recombination',
      label: 'Probabilistic recombination',
      experimental: true,
    };
  }
  const p = minChance(plan);
  if (p != null && p < 0.2) {
    return { id: 'high-variance', label: 'High-variance', experimental };
  }
  if (allGuaranteed(plan)) {
    return { id: 'guaranteed-finishing', label: 'Guaranteed finishing', experimental };
  }
  return { id: 'expected-cost-optimized', label: 'Expected-cost optimized', experimental };
}

export function planSummaryLine(plan, { totalCost, minIlvl, methodName, multiCost } = {}) {
  const kind = classifyPlan(plan);
  const name = methodName ?? plan.methodName ?? plan.name ?? 'Craft';
  const ilvl = minIlvl ?? plan.minIlvl;
  const costBit =
    multiCost ??
    (totalCost == null && plan.totalCost == null
      ? 'cost unknown'
      : `~${totalCost ?? plan.totalCost}c expected`);
  const exp = kind.experimental ? ' [experimental]' : '';
  const ilvlBit = ilvl != null ? ` (min base ilvl ${ilvl})` : '';
  return `${kind.label}: ${name} — ${costBit}${ilvlBit}${exp}`;
}
