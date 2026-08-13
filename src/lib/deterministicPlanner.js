/**
 * Legacy sequential step materializer (§61–62).
 * Strategy / V(S) decisions live in `planner/optimizer` — not here.
 * Kept for classify/enrich + step lists when sequential wins on EV.
 *
 * Implementation lives in planner/scaffold/; this file re-exports the public API.
 */
export {
  planDeterministic,
  modStableKey,
  replanWithOptions,
  replanFromProgress,
  formatCostBreakdown,
  chaosCost,
} from './planner/scaffold/index.js';
