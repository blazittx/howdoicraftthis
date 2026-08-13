/**
 * Replay a plan through mechanics. Rejects illegal routes (essence after metamod, etc.).
 */
import { makeState, cloneState } from '../craftState.js';
import { rulesetVersion, getRuleset } from '../ruleset.js';
import * as T from './transitions.js';

const ESSENCE_OPS = new Set(['essenceFish', 'essenceSpam', 'essence']);
const HARVEST_OPS = new Set(['harvestFill', 'harvestReforge', 'harvest', 'harvestAugmentRemove', 'harvestRemove']);
const META_OPS = new Set(['metacraft', 'prefixesCannotBeChanged', 'suffixesCannotBeChanged']);
const ELDRITCH_OPS = new Set(['eldritchChaos', 'eldritchAnnul', 'eldritchExalt']);

function startState(plan) {
  if (plan.initialState) return cloneState(plan.initialState);
  return makeState({
    itemClass: plan.itemClass ?? '',
    baseType: plan.baseType ?? plan.baseName ?? '',
    itemLevel: plan.minIlvl ?? plan.itemLevel ?? 1,
    prefixes: plan.startPrefixes ?? [],
    suffixes: plan.startSuffixes ?? [],
    metacrafts: [],
    baseTags: plan.baseTags ?? [],
    eldritchDominance: plan.eldritchDominance ?? null,
  });
}

export function validatePlan(plan, kb, opts = {}) {
  const rules = opts.rules ?? getRuleset();
  let state = startState(plan);
  const errors = [];
  for (let i = 0; i < (plan.steps ?? []).length; i++) {
    const s = plan.steps[i];
    const op = s.operator;

    if (ESSENCE_OPS.has(op) && (state.metacrafts ?? []).length) {
      errors.push({ step: i + 1, operator: op, reason: 'essence after metamod' });
      return { ok: false, errors, state, ruleset: rulesetVersion() };
    }

    if (META_OPS.has(op) || /cannot be changed/i.test(s.action ?? '')) {
      const id = /suffixes cannot be changed/i.test(s.action ?? '')
        ? 'Suffixes Cannot Be Changed'
        : /prefixes cannot be changed/i.test(s.action ?? '')
          ? 'Prefixes Cannot Be Changed'
          : s.operator;
      state = T.applyMetacraft(state, id).outcomes[0].state;
    }

    if (HARVEST_OPS.has(op) && /cannot be changed/i.test(s.action ?? '')) {
      const id = /suffixes cannot be changed/i.test(s.action ?? '')
        ? 'Suffixes Cannot Be Changed'
        : 'Prefixes Cannot Be Changed';
      state = T.applyMetacraft(state, id).outcomes[0].state;
    }

    if (op === 'setupDominance' || op === 'eldritchDominance') {
      const r = T.setupDominance(state, {
        emberTier: s.emberTier ?? (s.dominance === 'exarch' ? 1 : 0),
        ichorTier: s.ichorTier ?? (s.dominance === 'eater' ? 1 : 0),
      });
      if (r.illegal) errors.push({ step: i + 1, operator: op, reason: r.illegal });
      else if (r.outcomes[0]) state = r.outcomes[0].state;
    }

    if (ELDRITCH_OPS.has(op) && !state.eldritchDominance && !s.dominance) {
      errors.push({ step: i + 1, operator: op, reason: 'eldritch currency without dominance' });
    }

    if (s.illegal) {
      errors.push({ step: i + 1, operator: op, reason: s.illegal });
    }
  }
  return { ok: errors.length === 0, errors, state, ruleset: rules.version ?? rulesetVersion() };
}
