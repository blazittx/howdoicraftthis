/**
 * Multi-dimension craft costs (§25–26).
 * Chaos is the ranked tradable EV. Gold / Thaumaturgic Dust stay separate —
 * never silently valued as 0c, never invented smash amounts.
 */

export const NON_TRADABLE_KEYS = new Set(['gold', 'thaumaturgic-dust', 'recombinating-dust', 'dust']);

export const COST_LABELS = {
  transmute: 'Transmute',
  alteration: 'Alteration',
  augmentation: 'Augmentation',
  regal: 'Regal',
  exalt: 'Exalt',
  annul: 'Annul',
  scour: 'Scour',
  alchemy: 'Alchemy',
  chaos: 'Chaos',
  gold: 'Gold',
  'thaumaturgic-dust': 'Thaumaturgic Dust',
  divine: 'Divine',
  veiled: 'Veiled Exalt',
  'veiled-chaos': 'Veiled Chaos',
  'wild-lifeforce': 'Wild Lifeforce',
  'vivid-lifeforce': 'Vivid Lifeforce',
  'primal-lifeforce': 'Primal Lifeforce',
  'sacred-lifeforce': 'Sacred Lifeforce',
  fossil: 'Fossil',
  'fossil-dense': 'Dense Fossil',
  'fossil-hollow': 'Hollow Fossil',
  essence: 'Essence',
  'essence-deafening': 'Deafening Essence',
  'essence-screaming': 'Screaming Essence',
  'essence-shrieking': 'Shrieking Essence',
  'essence-weeping': 'Weeping Essence',
  'essence-wailing': 'Wailing Essence',
  'essence-muttering': 'Muttering Essence',
  bench: 'Bench',
  'eldritch-chaos': 'Eldritch Chaos',
  'eldritch-annul': 'Eldritch Annul',
  'eldritch-exalt': 'Eldritch Exalt',
  'eldritch-ichor': 'Eldritch Ichor',
  'eldritch-ember': 'Eldritch Ember',
  'warlord-exalt': "Warlord's Exalt",
  'redeemer-exalt': "Redeemer's Exalt",
  'crusader-exalt': "Crusader's Exalt",
  'hunter-exalt': "Hunter's Exalt",
  'shaper-exalt': "Shaper's Exalt",
  'elder-exalt': "Elder's Exalt",
};

export function isNonTradableKey(key) {
  return NON_TRADABLE_KEYS.has(key) || /dust/i.test(String(key ?? ''));
}

export function splitCostBag(costs = {}) {
  const tradable = {};
  const nonTradable = {};
  for (const [k, n] of Object.entries(costs)) {
    if (k === 'bench') continue;
    if (isNonTradableKey(k)) nonTradable[k] = n;
    else tradable[k] = n;
  }
  return { tradable, nonTradable };
}

/** Tradable-only chaos EV. Skips gold/dust. Null if any used tradable key is unpriced. */
export function tradableChaosCost(costs, prices) {
  if (!prices) return null;
  let total = 0;
  let anyTradable = false;
  for (const [key, count] of Object.entries(costs ?? {})) {
    if (!count || key === 'bench' || isNonTradableKey(key)) continue;
    anyTradable = true;
    const unit = prices[key];
    if (unit == null || !Number.isFinite(unit)) return null;
    total += unit * count;
  }
  if (!anyTradable) {
    const { nonTradable } = splitCostBag(costs);
    // Only non-tradeable (possibly unknown) — do not pretend 0c ranked EV
    if (Object.keys(nonTradable).length) return null;
    return 0;
  }
  return Math.round(total * 100) / 100;
}

/**
 * @returns {{
 *   chaosEquivalent: number|null,
 *   gold: number|null,
 *   thaumaturgicDust: number|null,
 *   unknownKeys: string[],
 *   ranked: boolean
 * }}
 */
export function multiDimensionCost(costs, prices) {
  const { tradable, nonTradable } = splitCostBag(costs);
  const unknownKeys = [];
  // Pass full costs so gold/dust-only bags return null (not 0 from empty tradable split).
  // Empty bag → 0; smash-only → null (solver EV must supply tradable cost).
  let chaosEquivalent = tradableChaosCost(costs, prices);
  if (
    chaosEquivalent === 0 &&
    Object.keys(tradable).length === 0 &&
    Object.keys(nonTradable).length > 0
  ) {
    chaosEquivalent = null;
  }
  if (chaosEquivalent == null && Object.keys(tradable).some((k) => tradable[k])) {
    for (const [k, n] of Object.entries(tradable)) {
      if (!n) continue;
      if (prices?.[k] == null || !Number.isFinite(prices[k])) unknownKeys.push(k);
    }
  }

  const goldRaw = Object.prototype.hasOwnProperty.call(nonTradable, 'gold')
    ? nonTradable.gold
    : undefined;
  const dustKey = ['thaumaturgic-dust', 'recombinating-dust', 'dust'].find((k) =>
    Object.prototype.hasOwnProperty.call(nonTradable, k)
  );
  const dustRaw = dustKey ? nonTradable[dustKey] : undefined;

  const gold = goldRaw === undefined ? 0 : goldRaw == null ? null : goldRaw;
  const thaumaturgicDust = dustRaw === undefined ? 0 : dustRaw == null ? null : dustRaw;

  if (gold == null) unknownKeys.push('gold');
  if (thaumaturgicDust == null) unknownKeys.push('thaumaturgic-dust');

  const hasUnknownAmt = gold == null || thaumaturgicDust == null;
  const ranked = chaosEquivalent != null && !hasUnknownAmt;

  return {
    chaosEquivalent,
    gold,
    thaumaturgicDust,
    unknownKeys,
    ranked: chaosEquivalent != null && unknownKeys.length === 0,
    // gold/dust unknown amounts do not block chaos ranking, but must display as ?
    displayRanked: chaosEquivalent != null,
    hasUnknownNonTradable: hasUnknownAmt,
  };
}

/** "120c + ~25k Gold + ~85k Dust" or "120c + ? Gold + ? Dust" */
export function formatMultiCost(dims) {
  if (!dims) return 'unknown';
  const parts = [];
  if (dims.chaosEquivalent == null) parts.push('?c');
  else parts.push(`${Math.round(dims.chaosEquivalent * 100) / 100}c`);

  const showGold = dims.gold == null || dims.gold > 0 || dims.unknownKeys?.includes('gold');
  const showDust =
    dims.thaumaturgicDust == null ||
    dims.thaumaturgicDust > 0 ||
    dims.unknownKeys?.includes('thaumaturgic-dust');

  const fmtNt = (n) => {
    if (n == null || !Number.isFinite(n)) return '?';
    if (n >= 1000) return `~${Math.round(n / 1000)}k`;
    return String(Math.round(n));
  };

  if (showGold) parts.push(`${fmtNt(dims.gold)} Gold`);
  if (showDust) parts.push(`${fmtNt(dims.thaumaturgicDust)} Dust`);
  return parts.join(' + ');
}

/** §90 raw formula for a single line item. */
export function rawCostFormula(label, count, unitChaos) {
  if (count == null || !Number.isFinite(count)) return `${label} × ? = ?`;
  const c = Math.round(count * 1000) / 1000;
  if (unitChaos == null || !Number.isFinite(unitChaos)) {
    return `${c} × ${label} × ?c = ?`;
  }
  const total = Math.round(c * unitChaos * 100) / 100;
  return `${c} × ${label} × ${unitChaos}c = ${total}c`;
}

/** Attach rawCostFormula strings onto a cost bag for stage display. */
export function costFormulas(costs, prices) {
  return Object.entries(costs ?? {})
    .filter(([, n]) => n == null || n > 0)
    .map(([key, count]) => {
      const label = COST_LABELS[key] ?? key;
      if (isNonTradableKey(key)) {
        return {
          key,
          label,
          formula:
            count == null
              ? `${label} amount unpublished (?)`
              : `${Math.round(count)} × ${label} (non-tradeable — approximate; not converted here)`,
          chaos: null,
          nonTradable: true,
        };
      }
      const unit = prices?.[key] ?? null;
      return {
        key,
        label,
        formula: rawCostFormula(label, count, unit),
        chaos:
          count != null && unit != null && Number.isFinite(unit)
            ? Math.round(count * unit * 100) / 100
            : null,
        nonTradable: false,
      };
    });
}
