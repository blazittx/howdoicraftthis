/**
 * §63: thin compatibility shim. Production path is planner/optimizer.
 * Prefer: import { planCraft, optimizeCraft } from './planner/index.js'
 */
export { planCraft, optimizeCraft } from './planner/optimizer.js';
export { formatCostBreakdown } from './craftKnowledge.js';
export { replanFromProgress, replanWithOptions, modStableKey } from './deterministicPlanner.js';
