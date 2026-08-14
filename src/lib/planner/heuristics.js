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

/**
 * Strategy-relevant mod tags for side-lock / cannot-roll planning.
 * Drawn from harvest families + cannot-roll constraints — not item recipes.
 */
export const SIDE_LOCK_TAGS = new Set([
  'attack',
  'caster',
  'critical',
  'defence',
  'defences',
  'life',
  'speed',
  'chaos',
  'fire',
  'cold',
  'lightning',
  'physical',
  'elemental',
]);

function sideLabel(side, { plural = false } = {}) {
  if (side === 'suffix') return plural ? 'suffixes' : 'suffix';
  if (side === 'prefix') return plural ? 'prefixes' : 'prefix';
  return String(side ?? '');
}

/** Normalize defence aliases; drop noise tags. */
export function normalizeStrategyTag(t) {
  const s = String(t ?? '')
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (s === 'defences') return 'defence';
  return SIDE_LOCK_TAGS.has(s) ? s : null;
}

function modStrategyTags(m) {
  const out = new Set();
  for (const t of m?.tags ?? []) {
    const n = normalizeStrategyTag(t);
    if (n) out.add(n);
  }
  for (const h of m?.harvests ?? []) {
    for (const t of h.tags ?? []) {
      const n = normalizeStrategyTag(t);
      if (n) out.add(n);
    }
  }
  return out;
}

/**
 * Detect natural tag clusters on desired affix sides (e.g. many suffixes share `attack`).
 * Used to prefer finish→protect (SCBC/PCBC) then cannot-roll on the open side.
 * Numbers still come from engine pools — this only ranks search / thought hints.
 */
export function analyzeTagSideClusters(mods) {
  const bySide = { prefix: [], suffix: [] };
  for (const m of mods ?? []) {
    if (m.crafted || m.method === 'bench') continue;
    const g = m.gen === 'suffix' ? 'suffix' : m.gen === 'prefix' ? 'prefix' : null;
    if (!g) continue;
    bySide[g].push(m);
  }

  const clusters = [];
  for (const side of ['suffix', 'prefix']) {
    const sideMods = bySide[side];
    if (sideMods.length < 2) continue;
    const tagMods = new Map();
    for (const m of sideMods) {
      for (const t of modStrategyTags(m)) {
        if (!tagMods.has(t)) tagMods.set(t, []);
        tagMods.get(t).push(m);
      }
    }
    for (const [tag, covered] of tagMods) {
      if (covered.length < 2) continue;
      const protect =
        side === 'suffix' ? 'suffixesCannotBeChanged' : 'prefixesCannotBeChanged';
      const opposite = side === 'suffix' ? 'prefix' : 'suffix';
      // Complementary cannot-roll tags often shrink the *other* pool (KB: attack↔caster).
      const complementHints =
        tag === 'attack' ? ['caster'] : tag === 'caster' ? ['attack'] : [];
      const lockShort = side === 'suffix' ? 'SCBC' : 'PCBC';
      const rollHints = complementHints
        .map((t) => t[0].toUpperCase() + t.slice(1))
        .join('/');
      clusters.push({
        side,
        tag,
        count: covered.length,
        fraction: covered.length / sideMods.length,
        mods: covered,
        labels: covered.map((m) => m.short ?? m.text),
        protectMetacraft: protect,
        oppositeSide: opposite,
        cannotRollHints: complementHints,
        thought: `Desired ${sideLabel(side, { plural: true })} share ${tag} tags → consider ${lockShort} after finishing them${
          rollHints
            ? `; Cannot Roll ${rollHints} may shrink ${sideLabel(opposite)} pool for remaining`
            : ''
        }…`,
      });
    }
  }
  clusters.sort((a, b) => b.count - a.count || b.fraction - a.fraction);
  const preferredLockSide = clusters[0]?.side ?? null;
  const sideOrder =
    preferredLockSide === 'prefix' ? ['prefix', 'suffix'] : ['suffix', 'prefix'];
  return { clusters, bySide, preferredLockSide, sideOrder };
}

/** One-line thought summaries for the live log (engine numbers not invented). */
export function tagClusterThoughtLines(analysis) {
  return (analysis?.clusters ?? []).slice(0, 4).map((c) => c.thought);
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
