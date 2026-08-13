/**
 * Recombinator physics (target-blind).
 * UnpredictableRecombine + PredictableRecombine.
 * No desired/scoring/salvage/EV floor — solver owns those.
 */
import {
  makeState,
  allAffixes,
  isExclusiveAffix,
  cannotNormallyRollOn,
  affixEligibleOnBase,
  sharesGroup,
  inferRarity,
  mergeOutcomeDist,
  statesEquivalent,
  affixKey,
} from './craftState.js';

export const OPERATOR_UNPREDICTABLE = 'UnpredictableRecombine';
export const OPERATOR_PREDICTABLE = 'PredictableRecombine';

/** §51 — Allflame / boat crafting intentionally unsupported. */
export const ALLFLAME_SUPPORTED = false;

export const DUST_KEY = 'thaumaturgic-dust';
export const COST_KEYS = ['gold', 'thaumaturgic-dust'];

/** Fallback if KB JSON is not loaded. Knowledge + empirical files are the sourced copies. */
const DEFAULT_MODEL = {
  version: '3.29',
  league: 'Curse of the Allflame',
  sampleSize: null,
  confidence: 'mixed',
  sources: [{ id: 'ggg-3.26.0' }, { id: 'poewiki-recombinator' }, { id: 'ggg-3.25-rarer' }],
  allflame: { supported: false },
  rules: {
    cannotNormallyRollFewerMods: { countWeight: 0.35 },
  },
  countDistribution: {
    byPool: {
      1: { 0: 0.41, 1: 0.59 },
      2: { 1: 0.667, 2: 0.333 },
      3: { 1: 0.4, 2: 0.5, 3: 0.1 },
      4: { 1: 0.1, 2: 0.6, 3: 0.3 },
      5: { 2: 0.43, 3: 0.57 },
      6: { 2: 0.3, 3: 0.7 },
    },
  },
  cost: {
    confidence: 'approximate',
    formula: null,
    currency: [...COST_KEYS],
    averageUnpredictable: {
      gold: 25000,
      goldBand: [15000, 35000],
      'thaumaturgic-dust': 85000,
      dustBand: [50000, 120000],
      confidence: 'approximate',
      source: 'user empirical band 2026-08',
    },
    opportunityCostChaos: {
      gold: 0.0002,
      'thaumaturgic-dust': 0.00005,
      confidence: 'approximate',
      source: 'user empirical band 2026-08',
    },
  },
};

export function getRecombinatorModel(kb) {
  return kb?.recombinator ?? DEFAULT_MODEL;
}

export function modelMeta(model = DEFAULT_MODEL) {
  return {
    version: model.version,
    league: model.league,
    source: model.sources,
    sampleSize: model.sampleSize ?? null,
    confidence: model.confidence,
    empiricalDataset: model.empiricalDataset ?? '/data/recombinator/3.29.json',
    allflameSupported: !!(model.allflame?.supported ?? ALLFLAME_SUPPORTED),
  };
}

/** Prefer averageUnpredictable midpoints; else best sample. Never invent closed-form; never 0. */
export function smashPhysicalAmounts(model = DEFAULT_MODEL, mode = 'unpredictable') {
  const avg = model?.cost?.averageUnpredictable;
  if (avg && ((avg.gold ?? 0) > 0 || (avg['thaumaturgic-dust'] ?? 0) > 0)) {
    return {
      gold: avg.gold ?? null,
      'thaumaturgic-dust': avg['thaumaturgic-dust'] ?? null,
      confidence: avg.confidence ?? 'approximate',
      source: avg.source ?? null,
      goldBand: avg.goldBand,
      dustBand: avg.dustBand,
    };
  }
  const samples = (model?.cost?.samples ?? []).filter(
    (s) =>
      (mode === 'predictable' ? s.mode === 'predictable' : s.mode !== 'predictable') &&
      ((s.gold ?? 0) > 0 || (s['thaumaturgic-dust'] ?? 0) > 0)
  );
  if (!samples.length) return null;
  // Prefer samples tagged for ranking defaults — never match on free-text "user" strings.
  const prefer =
    samples.find((s) => s.role === 'defaultAverage' || s.preferredForRanking === true) ?? samples[0];
  return {
    gold: prefer.gold ?? null,
    'thaumaturgic-dust': prefer['thaumaturgic-dust'] ?? null,
    confidence: prefer.confidence ?? 'anecdotal',
    source: prefer.source ?? null,
    goldBand: prefer.goldBand,
    dustBand: prefer.dustBand,
  };
}

/** Mechanical Gold + Thaumaturgic Dust. Empirical midpoints when known; else null (display ?). Never 0. */
export function recombineCost(stateA, stateB, model = DEFAULT_MODEL, mode = 'unpredictable') {
  void stateA;
  void stateB;
  const phys = smashPhysicalAmounts(model, mode);
  if (phys) {
    return {
      gold: phys.gold,
      'thaumaturgic-dust': phys['thaumaturgic-dust'],
      confidence: phys.confidence,
      source: phys.source,
      goldBand: phys.goldBand,
      dustBand: phys.dustBand,
    };
  }
  const keys = model.cost?.currency ?? DEFAULT_MODEL.cost.currency;
  const bag = {};
  for (const k of keys) bag[k] = null;
  return bag;
}

/** Chaos of smash amounts via market units, else approximate opportunityCostChaos. Never 0 invented free. */
export function recombineCostChaos(stateA, stateB, prices, model = DEFAULT_MODEL) {
  const bag = recombineCost(stateA, stateB, model);
  let c = 0;
  let priced = false;
  let missingUnit = false;
  for (const [k, n] of Object.entries(bag)) {
    if (k === 'confidence' || k === 'source' || k === 'goldBand' || k === 'dustBand') continue;
    if (n == null || !(n > 0)) continue;
    const unit = prices?.[k];
    if (unit == null || !Number.isFinite(unit)) {
      missingUnit = true;
      continue;
    }
    c += unit * n;
    priced = true;
  }
  if (priced && !missingUnit) return c;
  const opp = model?.cost?.opportunityCostChaos;
  if (opp) {
    let o = 0;
    let ok = false;
    for (const [k, n] of Object.entries(bag)) {
      if (k === 'confidence' || k === 'source' || k === 'goldBand' || k === 'dustBand') continue;
      if (!(n > 0)) continue;
      const u = opp[k];
      if (u == null || !Number.isFinite(u)) continue;
      o += u * n;
      ok = true;
    }
    if (ok && o > 0) return o;
  }
  return priced && c > 0 ? c : null;
}

/**
 * §84 eligibility: class match, corrupt/mirror/unique.
 * Influence/fracture/exclusive apply during physics (chosen base / selection).
 */
export function recombineEligible(stateA, stateB, model = DEFAULT_MODEL) {
  void model;
  if (!stateA || !stateB) return { ok: false, reason: 'missing-input' };
  if (stateA.corrupted || stateB.corrupted) return { ok: false, reason: 'corrupted' };
  if (stateA.mirrored || stateB.mirrored) return { ok: false, reason: 'mirrored' };
  if (/unique/i.test(stateA.rarity ?? '') || /unique/i.test(stateB.rarity ?? '')) {
    return { ok: false, reason: 'unique' };
  }
  if (stateA.itemClass && stateB.itemClass && stateA.itemClass !== stateB.itemClass) {
    return { ok: false, reason: 'item-class' };
  }
  return { ok: true, reason: null };
}

function normRow(row) {
  const out = {};
  let z = 0;
  for (const [k, v] of Object.entries(row ?? {})) {
    const n = Number(v);
    if (n > 0) {
      out[Number(k)] = n;
      z += n;
    }
  }
  if (z > 0) for (const k of Object.keys(out)) out[k] /= z;
  return out;
}

/** Affix-count P(n) for one side. Independent of the other side. Not 50% per mod. */
export function affixCountDistribution(effectiveSize, model = DEFAULT_MODEL) {
  if (effectiveSize <= 0) return { 0: 1 };
  const byPool = model.countDistribution?.byPool ?? {};
  const clamp = (n) => Math.min(6, Math.max(1, n));
  const lo = Math.floor(effectiveSize);
  const hi = Math.ceil(effectiveSize);
  const tLo = normRow(byPool[String(clamp(lo))] ?? { 0: 1 });
  if (lo === hi || lo < 1) return tLo;
  const tHi = normRow(byPool[String(clamp(hi))] ?? tLo);
  const f = effectiveSize - lo;
  const keys = new Set([...Object.keys(tLo), ...Object.keys(tHi)].map(Number));
  const out = {};
  for (const k of keys) out[k] = (1 - f) * (tLo[k] ?? 0) + f * (tHi[k] ?? 0);
  return normRow(out);
}

export function effectivePoolSize(affixes, output, model = DEFAULT_MODEL) {
  const w = model.rules?.cannotNormallyRollFewerMods?.countWeight ?? 0.35;
  let s = 0;
  for (const a of affixes) s += cannotNormallyRollOn(a, output) ? w : 1;
  return s;
}

function selectionWeight(a) {
  const sw = a.spawnWeight ?? 0;
  if (sw > 0) return 1 / Math.sqrt(sw);
  return 1;
}

function ilvlOut(a, b) {
  const ia = a.itemLevel ?? 1;
  const ib = b.itemLevel ?? 1;
  const cap = Math.max(ia, ib);
  const avg = Math.floor((ia + ib) / 2) + 2;
  return Math.min(cap, avg);
}

function outputFromBase(base, prefixes, suffixes, other) {
  return makeState({
    itemClass: base.itemClass,
    baseType: base.baseType,
    itemLevel: ilvlOut(base, other),
    rarity: inferRarity(prefixes.length, suffixes.length),
    prefixes,
    suffixes,
    influence: base.influence,
    fracturedItem: base.fracturedItem,
  });
}

function enumeratePick(pool, k, exclusiveUsed) {
  if (k <= 0) return [{ picked: [], p: 1, exclusiveUsed }];
  const eligible = pool.filter((a) => a._ok && (!exclusiveUsed || !a._ex));
  if (!eligible.length) return [{ picked: [], p: 1, exclusiveUsed }];
  const W = eligible.reduce((s, a) => s + a._w, 0);
  const acc = new Map();
  for (const a of eligible) {
    const pPick = a._w / W;
    const restPool = pool.filter((x) => x !== a && !sharesGroup(x, a));
    const nextEx = exclusiveUsed || a._ex;
    for (const r of enumeratePick(restPool, k - 1, nextEx)) {
      const picked = [a, ...r.picked];
      const key = picked.map(affixKey).sort().join('+') + `|${r.exclusiveUsed || nextEx ? 1 : 0}`;
      const prev = acc.get(key);
      const p = pPick * r.p;
      if (prev) prev.p += p;
      else acc.set(key, { picked, p, exclusiveUsed: r.exclusiveUsed || nextEx });
    }
  }
  return [...acc.values()];
}

function fillSides(prefixPool, suffixPool, nP, nS, first) {
  const firstPool = first === 'prefix' ? prefixPool : suffixPool;
  const firstK = first === 'prefix' ? nP : nS;
  const secondPool = first === 'prefix' ? suffixPool : prefixPool;
  const secondK = first === 'prefix' ? nS : nP;
  const out = [];
  for (const a of enumeratePick(firstPool, firstK, false)) {
    const pool2 = a.exclusiveUsed ? secondPool.map((x) => (x._ex ? { ...x, _ok: false } : x)) : secondPool;
    for (const b of enumeratePick(pool2, secondK, a.exclusiveUsed)) {
      const prefixes = first === 'prefix' ? a.picked : b.picked;
      const suffixes = first === 'prefix' ? b.picked : a.picked;
      out.push({ prefixes, suffixes, p: a.p * b.p });
    }
  }
  return out;
}

function annotatePool(affixes, output) {
  return affixes.map((a) => ({
    ...a,
    _ex: isExclusiveAffix(a),
    _ok: affixEligibleOnBase(a, output),
    _w: selectionWeight(a),
  }));
}

/** Fractured stays on the chosen base: does not transfer or increase. */
function fracturedOnChosenBase(affix, base) {
  if (!affix.fractured) return true;
  return allAffixes(base).includes(affix);
}

function poolForChosenBase(affixes, base) {
  return affixes.filter((a) => fracturedOnChosenBase(a, base));
}

function fracturedKeys(state) {
  return allAffixes(state)
    .filter((a) => a.fractured)
    .map(affixKey)
    .sort()
    .join('\0');
}

function distForBase(base, other, prefixAffixes, suffixAffixes, model, pBase) {
  const prefixes = poolForChosenBase(prefixAffixes, base);
  const suffixes = poolForChosenBase(suffixAffixes, base);
  const prefixPool = annotatePool(prefixes, base);
  const suffixPool = annotatePool(suffixes, base);
  const cP = affixCountDistribution(effectivePoolSize(prefixes, base, model), model);
  const cS = affixCountDistribution(effectivePoolSize(suffixes, base, model), model);
  const outcomes = [];
  for (const first of ['prefix', 'suffix']) {
    for (const [np, pNP] of Object.entries(cP)) {
      for (const [ns, pNS] of Object.entries(cS)) {
        const pHead = pBase * 0.5 * pNP * pNS;
        if (pHead < 1e-12) continue;
        for (const pick of fillSides(prefixPool, suffixPool, Number(np), Number(ns), first)) {
          outcomes.push({
            state: outputFromBase(base, pick.prefixes, pick.suffixes, other),
            p: pHead * pick.p,
          });
        }
      }
    }
  }
  return outcomes;
}

function emptyResult(operator, model, ineligible, extra = {}) {
  return {
    operator,
    outcomes: [],
    cost: recombineCost(null, null, model),
    meta: modelMeta(model),
    ineligible,
    unranked: false,
    ...extra,
  };
}

/**
 * Unpredictable: probability distribution over output item states.
 * Ignores any target flags on the inputs.
 */
export function recombine(stateA, stateB, model = DEFAULT_MODEL) {
  const meta = modelMeta(model);
  const gate = recombineEligible(stateA, stateB, model);
  if (!gate.ok) {
    return {
      operator: OPERATOR_UNPREDICTABLE,
      outcomes: [],
      cost: recombineCost(stateA, stateB, model),
      meta,
      ineligible: gate.reason,
      unranked: false,
    };
  }

  const prefixes = [...(stateA.prefixes ?? []), ...(stateB.prefixes ?? [])];
  const suffixes = [...(stateA.suffixes ?? []), ...(stateB.suffixes ?? [])];

  let raw;
  if (statesEquivalent(stateA, stateB) && fracturedKeys(stateA) === fracturedKeys(stateB)) {
    raw = distForBase(stateA, stateB, prefixes, suffixes, model, 1);
  } else {
    raw = [
      ...distForBase(stateA, stateB, prefixes, suffixes, model, 0.5),
      ...distForBase(stateB, stateA, prefixes, suffixes, model, 0.5),
    ];
  }
  return {
    operator: OPERATOR_UNPREDICTABLE,
    outcomes: mergeOutcomeDist(raw),
    cost: recombineCost(stateA, stateB, model, 'unpredictable'),
    meta,
    ineligible: null,
    unranked: false,
  };
}

export function unpredictableRecombine(stateA, stateB, model = DEFAULT_MODEL) {
  return recombine(stateA, stateB, model);
}

/**
 * Enforce exclusive-at-most-one on a chosen list (physics constraint).
 * If multiple exclusives selected, keep first in list order — caller should not pick multiples.
 */
function applyExclusiveCap(affixes) {
  let saw = false;
  const out = [];
  for (const a of affixes) {
    if (isExclusiveAffix(a)) {
      if (saw) continue;
      saw = true;
    }
    out.push(a);
  }
  return out;
}

function predictableOutput(base, other, selected) {
  const prefixes = [];
  const suffixes = [];
  for (const a of selected) {
    if (!fracturedOnChosenBase(a, base)) continue;
    if (!affixEligibleOnBase(a, base) && a.influence) continue;
    if (a.gen === 'suffix') suffixes.push(a);
    else prefixes.push(a);
  }
  return outputFromBase(base, applyExclusiveCap(prefixes), applyExclusiveCap(suffixes), other);
}

/**
 * PredictableRecombine — chance from UI / empirical sample only.
 * Do not invent a formula. Missing chance → unranked (§60).
 *
 * @param {object} opts
 * @param {number|null} [opts.displayedChance] in-game or empirical (0–1); alias opts.pDisplay
 * @param {object[]} [opts.selected] affixes to keep when craft completes
 * @param {'A'|'B'|'either'} [opts.baseChoice='either']
 */
export function predictableRecombine(stateA, stateB, opts = {}, model = DEFAULT_MODEL) {
  const gate = recombineEligible(stateA, stateB, model);
  if (!gate.ok) return emptyResult(OPERATOR_PREDICTABLE, model, gate.reason);

  const pRaw = opts.displayedChance ?? opts.pDisplay;
  if (pRaw == null || !Number.isFinite(pRaw)) {
    return {
      operator: OPERATOR_PREDICTABLE,
      outcomes: [],
      cost: recombineCost(stateA, stateB, model, 'predictable'),
      meta: modelMeta(model),
      ineligible: null,
      unranked: true,
      reason: 'unknown-displayed-chance',
    };
  }

  const p = Math.min(1, Math.max(0, Number(pRaw)));
  const selected = opts.selected ?? [
    ...(stateA.prefixes ?? []),
    ...(stateA.suffixes ?? []),
    ...(stateB.prefixes ?? []),
    ...(stateB.suffixes ?? []),
  ];
  const choice = opts.baseChoice ?? 'either';
  const cost = recombineCost(stateA, stateB, model, 'predictable');
  const meta = modelMeta(model);

  const keepStates = [];
  if (choice === 'A') keepStates.push({ state: predictableOutput(stateA, stateB, selected), p: 1 });
  else if (choice === 'B') keepStates.push({ state: predictableOutput(stateB, stateA, selected), p: 1 });
  else {
    keepStates.push({ state: predictableOutput(stateA, stateB, selected), p: 0.5 });
    keepStates.push({ state: predictableOutput(stateB, stateA, selected), p: 0.5 });
  }

  const outcomes = [];
  for (const s of keepStates) {
    if (p > 0) outcomes.push({ state: s.state, p: p * s.p, destroyed: false });
  }
  if (1 - p > 1e-12) outcomes.push({ state: null, p: 1 - p, destroyed: true });

  return {
    operator: OPERATOR_PREDICTABLE,
    outcomes,
    cost,
    meta,
    ineligible: null,
    unranked: false,
    displayedChance: p,
  };
}

/**
 * §13 pure set math: unordered bipartitions into two non-empty complementary subsets.
 * No EV / salvage — solver decides which partition to value.
 */
export function bipartitions(items) {
  const list = items ?? [];
  const n = list.length;
  const out = [];
  if (n < 2) return out;
  const limit = 1 << n;
  for (let mask = 1; mask < limit - 1; mask++) {
    const A = [];
    const B = [];
    for (let i = 0; i < n; i++) (mask & (1 << i) ? A : B).push(list[i]);
    const ka = A.map((x) => (typeof x === 'object' ? affixKey(x) : String(x))).sort().join('\0');
    const kb = B.map((x) => (typeof x === 'object' ? affixKey(x) : String(x))).sort().join('\0');
    if (ka > kb) continue;
    out.push([A, B]);
  }
  return out;
}

/** Split fractured anchors onto side A; bipartition the live remainder. */
export function donorPartitions(mods) {
  const frac = (mods ?? []).filter((m) => m.fractured);
  const rest = (mods ?? []).filter((m) => !m.fractured);
  const out = [];
  for (const [A0, B0] of bipartitions(rest)) {
    out.push([[...frac, ...A0], B0]);
  }
  if (frac.length && rest.length) out.push([frac, rest]);
  return out;
}
