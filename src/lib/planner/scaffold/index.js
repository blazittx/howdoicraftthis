/**
 * Sequential scaffold materializer (legacy deterministic planner).
 */
export { planDeterministic, modStableKey } from './planDeterministic.js';
export { replanWithOptions, replanFromProgress } from './replan.js';
export { formatCostBreakdown, chaosCost } from '../../craftKnowledge.js';
export { assignAndBuild } from './assignAndBuild.js';
export {
  enrichMod,
  candidatesFor,
  minIlvlFromMods,
  essencesForTarget,
} from './candidates.js';
export {
  isBenchMod,
  isInfluenceGoal,
  stampPlan,
  renumber,
  short,
  mergeCost,
  occupiedGroupsNow,
  ensureFinalBenchSteps,
} from './helpers.js';
