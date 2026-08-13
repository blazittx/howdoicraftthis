/**
 * Eldritch currency transitions + dominance setup. Target-blind.
 */
import { cloneState, makeAffix, allAffixes } from '../craftState.js';
import { getEligibleMods, collectOccupiedGroups } from '../spawnWeights.js';
import { getRuleset } from '../ruleset.js';
import { normalizeOutcomes } from './prob.js';
import { CAP, side, setSide, openSlot } from './common.js';
import { benchBlockedTags } from './blockers.js';

const ELDRITCH_SLOTS = new Set(['Helmet', 'Gloves', 'Boots', 'Body Armour', 'Body Armours']);

export function isEldritchSlot(itemClass) {
  return ELDRITCH_SLOTS.has(String(itemClass ?? ''));
}

/**
 * Apply Ember/Ichor tiers → dominance.
 * Higher Ember → Exarch (prefixes); higher Ichor → Eater (suffixes); tie → none.
 */
export function setupDominance(state, { emberTier = 0, ichorTier = 0 } = {}) {
  if (!isEldritchSlot(state.itemClass)) {
    return { outcomes: [], cost: {}, illegal: 'eldritch dominance only on armour slots' };
  }
  const next = cloneState(state);
  if (emberTier > ichorTier) next.eldritchDominance = 'exarch';
  else if (ichorTier > emberTier) next.eldritchDominance = 'eater';
  else next.eldritchDominance = null;
  next.eldritchEmberTier = emberTier;
  next.eldritchIchorTier = ichorTier;
  const cost = {};
  if (emberTier > 0) cost['eldritch-ember'] = 1;
  if (ichorTier > 0) cost['eldritch-ichor'] = 1;
  return { outcomes: [{ state: next, p: 1 }], cost };
}

function dominanceGen(state, rules) {
  const dom = String(state.eldritchDominance ?? '').toLowerCase();
  if (dom === 'eater') return rules.eldritch?.eater ?? 'suffix';
  if (dom === 'exarch') return rules.eldritch?.exarch ?? 'prefix';
  return null;
}

function weightedReplaceSide(state, kb, gen, cost, method, rules) {
  const other = gen === 'suffix' ? state.prefixes : state.suffixes;
  const occupied = collectOccupiedGroups(other);
  const forbid = benchBlockedTags(state);
  const { rows, total } = getEligibleMods(kb, state, {
    generation: gen,
    method,
    occupiedGroups: occupied,
    forbiddenTags: forbid,
    rules,
  });
  const fractured = side(state, gen).filter((a) => a.fractured);
  if (!(total > 0) || !rows.length) {
    return { outcomes: [{ state: setSide(state, gen, fractured), p: 1 }], cost };
  }
  const outcomes = rows.map((r) => ({
    state: setSide(state, gen, [...fractured, makeAffix({ ...r, gen })]),
    p: r.weight / total,
  }));
  return { outcomes: normalizeOutcomes(outcomes), cost };
}

export function eldritchChaos(state, kb, opts = {}) {
  const rules = opts.rules ?? getRuleset();
  const gen = dominanceGen(state, rules);
  const cost = { 'eldritch-chaos': 1 };
  if (!isEldritchSlot(state.itemClass)) return { outcomes: [], cost, illegal: 'wrong item class for eldritch' };
  if (!gen) return { outcomes: [], cost, illegal: 'eldritch chaos requires dominance' };
  return weightedReplaceSide(state, kb, gen, cost, 'eldritch-chaos', rules);
}

export function eldritchAnnul(state, opts = {}) {
  const rules = opts.rules ?? getRuleset();
  const gen = dominanceGen(state, rules);
  const cost = { 'eldritch-annul': 1 };
  if (!isEldritchSlot(state.itemClass)) return { outcomes: [], cost, illegal: 'wrong item class for eldritch' };
  if (!gen) return { outcomes: [], cost, illegal: 'eldritch annul requires dominance' };
  const list = side(state, gen).filter((a) => !a.fractured);
  if (!list.length) return { outcomes: [{ state, p: 1 }], cost };
  const p = 1 / list.length;
  return {
    outcomes: normalizeOutcomes(
      list.map((a) => ({
        state: setSide(
          state,
          gen,
          side(state, gen).filter((x) => x !== a)
        ),
        p,
      }))
    ),
    cost,
  };
}

export function eldritchExalt(state, kb, opts = {}) {
  const rules = opts.rules ?? getRuleset();
  const gen = dominanceGen(state, rules);
  const cost = { 'eldritch-exalt': 1 };
  if (!isEldritchSlot(state.itemClass)) return { outcomes: [], cost, illegal: 'wrong item class for eldritch' };
  if (!gen) return { outcomes: [], cost, illegal: 'eldritch exalt requires dominance' };
  if (!openSlot(state, gen)) return { outcomes: [{ state, p: 1, blocked: true }], cost };
  const occupied = collectOccupiedGroups(allAffixes(state));
  const forbid = benchBlockedTags(state);
  const { rows, total } = getEligibleMods(kb, state, {
    generation: gen,
    method: 'eldritch-exalt',
    occupiedGroups: occupied,
    forbiddenTags: forbid,
    rules,
  });
  if (!(total > 0)) return { outcomes: [{ state, p: 1, blocked: true }], cost };
  return {
    outcomes: normalizeOutcomes(
      rows.map((r) => ({
        state: setSide(state, gen, [...side(state, gen), makeAffix({ ...r, gen })]),
        p: r.weight / total,
      }))
    ),
    cost,
  };
}
