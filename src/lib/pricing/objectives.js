/**
 * Optional objective profiles (§27). Default ranking stays min expected tradable chaos.
 */

export const OBJECTIVE_PROFILES = {
  minChaos: {
    id: 'minChaos',
    label: 'Minimum expected tradable currency',
    default: true,
  },
  minClicks: {
    id: 'minClicks',
    label: 'Minimum expected attempts / clicks',
  },
  minExpensiveFailures: {
    id: 'minExpensiveFailures',
    label: 'Minimum expensive destructive failures',
  },
  minGold: {
    id: 'minGold',
    label: 'Minimum Gold spend',
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced chaos + effort + risk',
  },
};

export function resolveObjective(profileId) {
  return OBJECTIVE_PROFILES[profileId] ?? OBJECTIVE_PROFILES.minChaos;
}

/** Aggregate display metrics from steps / successProfile. */
export function buildSuccessProfile(plan) {
  const steps = plan.steps ?? [];
  let attemptsExpected = 0;
  let riskyDestructiveAttempts = 0;
  let restartProbability = 0;
  let clicks = 0;

  for (const s of steps) {
    const att =
      s.attemptsExpected ??
      (s.chance > 0 && s.chance < 1 ? 1 / s.chance : s.chance >= 1 ? 1 : null);
    if (att != null && Number.isFinite(att)) {
      attemptsExpected += att;
      clicks += att;
    } else {
      clicks += 1;
    }
    if (s.risk?.canBrickKeeper || s.risk?.canDestroyInputs || s.operator === 'recombine') {
      riskyDestructiveAttempts += att != null && Number.isFinite(att) ? att : 1;
    }
    const rp = s.risk?.restartRequiredProbability ?? s.restartProbability;
    if (rp != null && rp > restartProbability) restartProbability = rp;
  }

  if (plan.methodComparison?.recombinator?.pDone != null) {
    const p = plan.methodComparison.recombinator.pDone;
    if (p > 0 && p < 1) restartProbability = Math.max(restartProbability, 1 - p);
  }

  return {
    attemptsExpected: attemptsExpected > 0 ? Math.round(attemptsExpected * 100) / 100 : null,
    clicksExpected: clicks > 0 ? Math.round(clicks * 100) / 100 : null,
    riskyDestructiveAttempts:
      riskyDestructiveAttempts > 0 ? Math.round(riskyDestructiveAttempts * 100) / 100 : 0,
    restartProbability: restartProbability > 0 ? Math.round(restartProbability * 10000) / 10000 : 0,
  };
}

/**
 * Score for comparing alternatives under a profile. Lower is better.
 * Unknown required dimensions → Infinity (unranked).
 */
export function scoreUnderObjective(plan, profileId = 'minChaos') {
  const id = resolveObjective(profileId).id;
  const chaos = plan.expectedTradableCost ?? plan.totalCost;
  const gold = plan.nonTradableCosts?.gold;
  const success = plan.successProfile ?? buildSuccessProfile(plan);
  const risk = success.riskyDestructiveAttempts ?? 0;
  const clicks = success.clicksExpected ?? success.attemptsExpected ?? Infinity;
  const restart = success.restartProbability ?? 0;

  if (id === 'minChaos') {
    return chaos == null || !Number.isFinite(chaos) ? Infinity : chaos;
  }
  if (id === 'minClicks') {
    return !Number.isFinite(clicks) ? Infinity : clicks;
  }
  if (id === 'minExpensiveFailures') {
    return risk + restart * 100;
  }
  if (id === 'minGold') {
    if (gold == null) return Infinity;
    return gold;
  }
  // balanced: chaos + soft effort + risk penalty
  if (chaos == null || !Number.isFinite(chaos)) return Infinity;
  return chaos + (clicks || 0) * 0.5 + risk * 5 + restart * (chaos || 0);
}
