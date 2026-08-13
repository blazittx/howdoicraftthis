/**
 * Search heuristics: admissible LB (§46), subsystem coupling (§14),
 * fracture-by-EV (§80), completed-side bias (§15), tier/divine/bench (§74–76).
 */

/** Admissible lower bound: sum of cheapest unresolved standalone costs (never used as final EV). */
export function lowerBound(missing, costOne) {
  let s = 0;
  for (const m of missing ?? []) {
    const c = costOne?.(m);
    if (c != null && Number.isFinite(c) && c > 0) s += c;
  }
  return s;
}

/**
 * Subsystem difficulty / coupling (§14).
 * dependencyPenalty(A,B) = C(A∪B) - (C(A)+C(B))  — high positive ⇒ recomb-friendly.
 */
export function standaloneCost(mods, costOne) {
  return (mods ?? []).reduce((s, m) => s + (costOne?.(m) ?? 0), 0);
}

export function couplingPenalty(setA, setB, costUnion, costOne) {
  const indep = standaloneCost(setA, costOne) + standaloneCost(setB, costOne);
  const joint = typeof costUnion === 'number' ? costUnion : standaloneCost([...setA, ...setB], costOne);
  return joint - indep;
}

/**
 * Rank subsets by positive coupling (hard subsystems first). No item-class hardcoding.
 */
export function rankCoupledSubsystems(mods, costOne, { maxSize = 3 } = {}) {
  const live = (mods ?? []).filter((m) => !m.crafted && m.method !== 'bench');
  const out = [];
  const n = live.length;
  if (n < 2) return out;
  for (let size = 2; size <= Math.min(maxSize, n); size++) {
    const idxs = [...Array(size).keys()];
    const walk = (start, depth) => {
      if (depth === size) {
        const set = idxs.map((i) => live[i]);
        const c = standaloneCost(set, costOne);
        // Independence proxy: sum of singles vs joint (joint ≈ sum for now; donor EV fills later)
        const indep = standaloneCost(set, costOne);
        out.push({ mods: set, cost: c, coupling: Math.max(0, c - indep * 0.5) });
        return;
      }
      for (let i = start; i < n; i++) {
        idxs[depth] = i;
        walk(i + 1, depth + 1);
      }
    };
    walk(0, 0);
  }
  // Prefer same-generation clusters (coupled pool competition) without naming ES/crit.
  for (const e of out) {
    const gens = new Set(e.mods.map((m) => m.gen));
    if (gens.size === 1 && e.mods.length >= 2) e.coupling += e.cost * 0.25;
  }
  out.sort((a, b) => b.coupling - a.coupling || b.cost - a.cost);
  return out.slice(0, 12);
}

/**
 * Fracture choice by downstream EV (§80), not rarity.
 * value = V(without) - V(with) - acquireCost
 */
export function fractureByEv(candidates, { vWithout, vWithFrac, acquireCost }) {
  let best = null;
  for (const m of candidates ?? []) {
    const withV = typeof vWithFrac === 'function' ? vWithFrac(m) : vWithFrac;
    const acq = typeof acquireCost === 'function' ? acquireCost(m) : acquireCost ?? 0;
    if (!Number.isFinite(withV) || !Number.isFinite(vWithout)) continue;
    const value = vWithout - withV - (acq || 0);
    if (!best || value > best.value) best = { mod: m, value, vWith: withV, acquire: acq || 0 };
  }
  return best;
}

/** Prefer finishing a cheap completed affix side before exposing it (§15). */
export function completedSideBonus(state, neededByGen) {
  const nP = (neededByGen?.prefix ?? []).length;
  const nS = (neededByGen?.suffix ?? []).length;
  const haveP = state.prefixes?.filter((a) => !a.crafted).length ?? 0;
  const haveS = state.suffixes?.filter((a) => !a.crafted).length ?? 0;
  let bonus = 0;
  if (nP > 0 && haveP >= nP) bonus += 1;
  if (nS > 0 && haveS >= nS) bonus += 1;
  return bonus;
}

/** Planning options: tier / divine / bench reservation (§74–76). */
export function defaultPlanOptions(opts = {}) {
  return {
    tierMode: opts.tierMode ?? 'atLeast',
    divineSeparate: opts.divineSeparate !== false,
    reserveBenchSlot: opts.reserveBenchSlot !== false,
    preserveSpecialSources: opts.preserveSpecialSources !== false,
  };
}

/**
 * Base acquisition operator (§50) — no invented premiums.
 * Uses priced influence orbs when available; unknown buy → unranked.
 */
export function baseAcquisitionOp(meta, prices, recommendInfluenceAcquisition) {
  const influences = meta?.influence ?? meta?.influenced ?? [];
  const acq =
    influences.length && recommendInfluenceAcquisition
      ? recommendInfluenceAcquisition(influences, prices)
      : null;
  return {
    op: 'acquireBase',
    itemClass: meta?.itemClass,
    baseType: meta?.baseType ?? meta?.baseName,
    itemLevel: meta?.itemLevel,
    fracturedItem: !!meta?.fracturedItem,
    influences,
    acquisition: acq,
    cost: acq?.ranked ? acq.orbTotal : null,
    unranked: acq ? !acq.ranked : false,
    risk: { canBrickKeeper: false, canDestroyInputs: false },
  };
}
