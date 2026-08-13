import { planDeterministic, formatCostBreakdown, replanFromProgress, replanWithOptions, modStableKey } from './deterministicPlanner.js';

/**
 * Async craft planner — deterministic knowledge-base algorithm.
 */
export async function planCraft(item, _index, onProgress, opts = {}) {
  const result = await planDeterministic(item, onProgress, opts);
  return {
    best: result.best,
    alternatives: result.alternatives,
    minIlvl: result.minIlvl,
    drivers: result.drivers,
    classified: result.classified,
    coverage: result.coverage,
    baseTags: result.baseTags,
  };
}

export { formatCostBreakdown, replanFromProgress, replanWithOptions, modStableKey };
