/**
 * Shared mechanical helpers for transitions. Target-blind.
 */
import { cloneState, allAffixes } from '../craftState.js';

export const CAP = { prefix: 3, suffix: 3 };

export function side(state, gen) {
  return gen === 'suffix' ? state.suffixes : state.prefixes;
}

export function setSide(state, gen, list) {
  const next = cloneState(state);
  if (gen === 'suffix') next.suffixes = list;
  else next.prefixes = list;
  return next;
}

/** Which generation is free to change under SCBC/PCBC. null = both. */
export function lockGen(state) {
  const meta = state.metacrafts ?? [];
  if (meta.some((m) => /suffixes cannot be changed/i.test(m))) return 'prefix';
  if (meta.some((m) => /prefixes cannot be changed/i.test(m))) return 'suffix';
  return null;
}

export function cannotRollForbiddenTags(state, rules) {
  const forbid = [];
  const map = rules?.harvest?.cannotRollTags ?? {
    'cannot-roll-attack': ['attack'],
    'cannot-roll-caster': ['caster'],
  };
  for (const m of state.metacrafts ?? []) {
    const s = String(m).toLowerCase();
    for (const [key, tags] of Object.entries(map)) {
      const needle = key.replace(/-/g, ' ');
      if (s.includes(needle) || s.includes(key)) forbid.push(...tags);
    }
    if (/cannot roll attack/i.test(m)) forbid.push('attack');
    if (/cannot roll caster/i.test(m)) forbid.push('caster');
  }
  return [...new Set(forbid.map((t) => String(t).toLowerCase()))];
}

export function removableAffixes(state, { respectMetamods = true, allowCrafted = true } = {}) {
  const unlocked = respectMetamods ? lockGen(state) : null;
  return allAffixes(state).filter((a) => {
    if (a.fractured) return false;
    if (!allowCrafted && a.crafted) return false;
    if (unlocked && a.gen !== unlocked) return false;
    return true;
  });
}

export function removeAffix(state, affix) {
  const next = cloneState(state);
  next.prefixes = (state.prefixes ?? []).filter((x) => x !== affix);
  next.suffixes = (state.suffixes ?? []).filter((x) => x !== affix);
  return next;
}

export function lifeforceCost(craft) {
  const bag = {};
  for (const [k, n] of Object.entries(craft?.lifeforce ?? {})) {
    if (n > 0) bag[`${k}-lifeforce`] = n;
  }
  return bag;
}

export function openSlot(state, gen) {
  return side(state, gen).length < CAP[gen];
}

export function hasInfluence(state) {
  return (state.influence ?? []).length > 0;
}
