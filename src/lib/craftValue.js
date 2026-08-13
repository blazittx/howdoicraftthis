/**
 * V(state) façade — implementation lives in planner/valueFunction (§3, §45).
 * Recombination physics stay in recombinatorModel (target-blind).
 */
export { ENTROPY_MACROS, MACRO_IDS } from './planner/macros.js';
export {
  roundEv, modKey, keyStr, nativeFinish, recombTransferable,
  smashFloorBag, pricedRecombBag, salvageValue, partitions,
  sequentialRemaining, evWithSalvage, solveValue, modsToState,
  classifyVsTarget, donorMiniPlan, recombCompatibility, annulClearRisk,
  OPERATOR_UNPREDICTABLE, OPERATOR_PREDICTABLE,
} from './planner/valueFunction.js';
