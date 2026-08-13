/**
 * Layer B planner package — strategy / V(S) only.
 * Mechanics stay in mechanics/ + recombinatorModel (target-blind).
 */
export { stateKey, haveKey, donorKey, strategySig, terminalEquivalent } from './stateKey.js';
export { ENTROPY_MACROS, MACRO_IDS, expandMacro, discoverEntropyChains } from './macros.js';
export { paretoPrune, beamTrim, sanityEvFloor, dominates } from './pruning.js';
export {
  lowerBound,
  couplingPenalty,
  rankCoupledSubsystems,
  fractureByEv,
  completedSideBonus,
  defaultPlanOptions,
  baseAcquisitionOp,
} from './heuristics.js';
export { donorMiniPlan, donorSearch } from './donorSearch.js';
export {
  solveValue,
  sequentialRemaining,
  evWithSalvage,
  salvageValue,
  partitions,
  roundEv,
  modKey,
  keyStr,
  nativeFinish,
  recombTransferable,
  smashFloorBag,
  pricedRecombBag,
  modsToState,
  classifyVsTarget,
  OPERATOR_UNPREDICTABLE,
  OPERATOR_PREDICTABLE,
} from './valueFunction.js';
export { optimizeCraft, planCraft } from './optimizer.js';

// Sequential scaffold (legacy materializer)
export {
  planDeterministic,
  modStableKey,
  replanWithOptions,
  replanFromProgress,
} from './scaffold/index.js';
