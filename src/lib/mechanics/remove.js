/**
 * Separate remove operators — Annul ≠ VeiledExalt remove ≠ Harvest remove ≠ Beast remove.
 * Each returns { outcomes, cost } with distinct cost keys / semantics.
 */
import { allAffixes } from '../craftState.js';
import { normalizeOutcomes } from './prob.js';
import { removableAffixes, removeAffix, lockGen } from './common.js';
import { modMatchesHarvest } from '../craftKnowledge.js';

/** Uniform annul among removable (fractured + metamod locked sides excluded). */
export function annulRemove(state, opts = {}) {
  const list = removableAffixes(state, { respectMetamods: opts.respectMetamods !== false });
  const cost = { annul: 1 };
  if (!list.length) return { outcomes: [{ state, p: 1 }], cost, kind: 'annul' };
  const p = 1 / list.length;
  return {
    outcomes: normalizeOutcomes(list.map((a) => ({ state: removeAffix(state, a), p }))),
    cost,
    kind: 'annul',
  };
}

/**
 * Veiled Exalted remove step alone (before veiled placeholder is added).
 * Does not respect the same removable set as Annul: crafted excluded; metamods optional.
 */
export function veiledExaltRemove(state, opts = {}) {
  const unlocked = lockGen(state);
  const list = allAffixes(state).filter((a) => {
    if (a.fractured || a.crafted) return false;
    if (unlocked && a.gen !== unlocked) return false;
    return true;
  });
  const cost = { veiled: 1 };
  if (!list.length) return { outcomes: [{ state, p: 1 }], cost, kind: 'veiled-exalt-remove' };
  const p = 1 / list.length;
  return {
    outcomes: normalizeOutcomes(list.map((a) => ({ state: removeAffix(state, a), p }))),
    cost,
    kind: 'veiled-exalt-remove',
  };
}

/** Harvest remove: uniform among mods matching harvest tag family. */
export function harvestRemove(state, harvest, opts = {}) {
  const unlocked = lockGen(state);
  const list = allAffixes(state).filter((a) => {
    if (a.fractured) return false;
    if (unlocked && a.gen !== unlocked) return false;
    if (opts.modMatches) return opts.modMatches(a, harvest);
    return modMatchesHarvest(a, harvest);
  });
  const cost = opts.cost ?? {};
  if (!list.length) {
    return { outcomes: [], cost, illegal: 'no harvest-tagged removable mod', kind: 'harvest-remove' };
  }
  const p = 1 / list.length;
  return {
    outcomes: normalizeOutcomes(list.map((a) => ({ state: removeAffix(state, a), p }))),
    cost,
    kind: 'harvest-remove',
  };
}

/** Beast remove: uniform among removable affixes of one generation. */
export function beastRemove(state, generation) {
  const unlocked = lockGen(state);
  if (unlocked && unlocked !== generation) {
    return { outcomes: [], cost: {}, illegal: 'metamod blocks beast remove side', kind: 'beast-remove' };
  }
  const list = removableAffixes(state).filter((a) => a.gen === generation);
  if (!list.length) {
    return { outcomes: [], cost: {}, illegal: `no removable ${generation}`, kind: 'beast-remove' };
  }
  const p = 1 / list.length;
  return {
    outcomes: normalizeOutcomes(list.map((a) => ({ state: removeAffix(state, a), p }))),
    cost: { beast: 1 },
    kind: 'beast-remove',
  };
}
