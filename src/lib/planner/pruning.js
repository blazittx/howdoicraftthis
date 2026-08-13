/**
 * Pareto pruning (§44), admissible lower bounds (§46), sanity EV floors (§70).
 */

import { strategySig } from './stateKey.js';

/** A dominates B on (sig, cost, free slots encoded in sig). */
export function dominates(a, b) {
  if (a.sig !== b.sig) return false;
  if (!(a.cost <= b.cost)) return false;
  if (a.lb != null && b.lb != null && a.lb > b.lb) return false;
  return a.cost < b.cost || (a.lb ?? 0) >= (b.lb ?? 0);
}

/** Keep only Pareto-optimal frontier entries. */
export function paretoPrune(entries) {
  const kept = [];
  for (const e of entries) {
    if (kept.some((k) => dominates(k, e))) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (dominates(e, kept[i])) kept.splice(i, 1);
    }
    kept.push(e);
  }
  return kept;
}

export function makeFrontierEntry(state, neededKeys, cost, lb = 0, extra = {}) {
  return {
    state,
    sig: strategySig(state, neededKeys),
    cost,
    lb,
    ...extra,
  };
}

/**
 * Beam: keep top `width` by (cost + lb), after Pareto.
 */
export function beamTrim(entries, width = 32) {
  const p = paretoPrune(entries);
  p.sort((a, b) => a.cost + (a.lb ?? 0) - (b.cost + (b.lb ?? 0)));
  return p.slice(0, width);
}

/**
 * §70: irrecoverable cost per attempt / successP is a hard floor.
 * Returns raised EV if suspicious under-count; else ev unchanged.
 */
export function sanityEvFloor(ev, { successP, irrecoverablePerAttempt, label } = {}) {
  if (!(ev >= 0) || !Number.isFinite(ev)) return ev;
  if (!(successP > 0) || successP >= 1) return ev;
  if (!(irrecoverablePerAttempt > 0)) return ev;
  const floor = irrecoverablePerAttempt / successP;
  if (ev + 1e-6 < floor * 0.85) {
    return {
      ev: floor,
      rejected: true,
      why: `EV ${Math.round(ev)}c below sanity floor ~${Math.round(floor)}c (${label ?? 'irrecoverable/p'})`,
    };
  }
  return { ev, rejected: false };
}

/** Best-first open set: min f = g + h. */
export function pushOpen(open, node) {
  open.push(node);
  open.sort((a, b) => a.f - b.f);
}

export function popOpen(open) {
  return open.shift();
}
