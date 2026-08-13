/**
 * Static craft knowledge — ONLY real in-game options.
 *
 * Harvest reforges sourced from Horticrafting Station / PoEDB:
 * https://poedb.tw/us/Horticrafting
 * Do not invent crafts (there is NO "Reforge Energy Shield" — ES falls under Defence).
 */

import {
  COST_LABELS,
  isNonTradableKey,
  tradableChaosCost,
  rawCostFormula,
} from './pricing/costs.js';

export { COST_LABELS, isNonTradableKey, rawCostFormula };

export const METACRAFT = {
  suffixesCannotBeChanged: {
    id: 'scbc',
    name: 'Suffixes Cannot Be Changed',
    cost: { divine: 2 },
    locks: 'suffix',
  },
  prefixesCannotBeChanged: {
    id: 'pcbc',
    name: 'Prefixes Cannot Be Changed',
    cost: { divine: 2 },
    locks: 'prefix',
  },
};

/** Harvest juice color → price key in daily.json (poe.ninja Crystallised Lifeforce). */
export const LIFEFORCE_PRICE_KEY = {
  wild: 'wild-lifeforce',
  vivid: 'vivid-lifeforce',
  primal: 'primal-lifeforce',
  sacred: 'sacred-lifeforce',
};

/**
 * Official harvest "Reforge … including a X modifier" crafts only.
 * Matching metadata lives here; lifeforce costs come from harvest-reforge-official.json
 * via applyOfficialHarvestCosts (do not duplicate juice amounts in JS).
 */
export const HARVEST_REFORGES = [
  {
    id: 'reforge-fire',
    name: 'Reforge Fire',
    detail: 'Reforge a Rare item with random modifiers, including a Fire modifier',
    tags: ['fire'],
    groups: ['FireResistance', 'FireDamage', 'FireDamagePercentage'],
    textHints: [/Fire Resistance/i, /Fire Damage/i, /to Level of all Fire/i],
    excludeText: [/Lightning Resistance/i, /Cold Resistance/i, /to all Elemental Resistances/i],
  },
  {
    id: 'reforge-cold',
    name: 'Reforge Cold',
    detail: 'Reforge a Rare item with random modifiers, including a Cold modifier',
    tags: ['cold'],
    groups: ['ColdResistance', 'ColdDamage', 'ColdDamagePercentage'],
    textHints: [/Cold Resistance/i, /Cold Damage/i, /to Level of all Cold/i],
    excludeText: [/Fire Resistance/i, /Lightning Resistance/i, /to all Elemental Resistances/i],
  },
  {
    id: 'reforge-lightning',
    name: 'Reforge Lightning',
    detail: 'Reforge a Rare item with random modifiers, including a Lightning modifier',
    tags: ['lightning'],
    groups: ['LightningResistance', 'LightningDamage', 'LightningDamagePercentage'],
    textHints: [/Lightning Resistance/i, /Lightning Damage/i, /to Level of all Lightning/i],
    excludeText: [/Fire Resistance/i, /Cold Resistance/i, /to all Elemental Resistances/i],
  },
  {
    id: 'reforge-physical',
    name: 'Reforge Physical',
    detail: 'Reforge a Rare item with random modifiers, including a Physical modifier',
    tags: ['physical'],
    groups: ['PhysicalDamage', 'LocalPhysicalDamagePercent', 'IncreasedPhysicalDamage'],
    textHints: [/Physical Damage/i, /physical damage/i],
  },
  {
    id: 'reforge-life',
    name: 'Reforge Life',
    detail: 'Reforge a Rare item with random modifiers, including a Life modifier',
    tags: ['life'],
    groups: ['IncreasedLife', 'Life', 'HybridLife'],
    textHints: [/maximum Life/i, /Regenerate .+ Life per second/i, /Life per second/i],
  },
  {
    // Official name is Defence — covers Armour / Evasion / Energy Shield / Ward (not Block/Spell Suppression)
    id: 'reforge-defence',
    name: 'Reforge Defence',
    detail: 'Reforge a Rare item with random modifiers, including a Defence modifier',
    tags: ['defences', 'defence', 'energy_shield', 'armour', 'evasion'],
    groups: [
      'DefencesPercent',
      'BaseLocalDefences',
      'LocalIncreasedEnergyShieldPercent',
      'IncreasedEnergyShield',
      'LocalIncreasedArmourPercent',
      'LocalIncreasedEvasionRatingPercent',
    ],
    textHints: [
      /increased (Armour|Evasion|Energy Shield)/i,
      /to (Armour|Evasion Rating|maximum Energy Shield|Ward)/i,
      /Energy Shield Recharge/i,
    ],
  },
  {
    id: 'reforge-chaos',
    name: 'Reforge Chaos',
    detail: 'Reforge a Rare item with random modifiers, including a Chaos modifier',
    tags: ['chaos'],
    groups: ['ChaosResistance', 'ChaosDamage'],
    textHints: [/Chaos Resistance/i, /Chaos Damage/i, /Penetrate .+ Chaos/i],
  },
  {
    id: 'reforge-attack',
    name: 'Reforge Attack',
    detail: 'Reforge a Rare item with random modifiers, including an Attack modifier',
    tags: ['attack'],
    groups: [],
    textHints: [/Attack Speed/i, /Accuracy Rating/i, /Adds .+ Physical Damage/i, /with this Weapon/i],
  },
  {
    id: 'reforge-caster',
    name: 'Reforge Caster',
    detail: 'Reforge a Rare item with random modifiers, including a Caster modifier',
    tags: ['caster'],
    groups: [],
    textHints: [/Cast Speed/i, /Spell Damage/i, /to Level of all .+ Spell/i],
  },
  {
    id: 'reforge-speed',
    name: 'Reforge Speed',
    detail: 'Reforge a Rare item with random modifiers, including a Speed modifier',
    tags: ['speed'],
    groups: ['IncreasedAttackSpeed', 'LocalIncreasedAttackSpeed', 'IncreasedCastSpeed', 'MovementVelocity'],
    textHints: [/Attack Speed/i, /Cast Speed/i, /Movement Speed/i],
  },
  {
    id: 'reforge-critical',
    name: 'Reforge Critical',
    detail: 'Reforge a Rare item with random modifiers, including a Critical modifier',
    tags: ['critical'],
    groups: [
      'CriticalStrikeChance',
      'CriticalStrikeMultiplier',
      'CriticalStrikeChanceLocal',
      'LocalCriticalStrikeChance',
      'CriticalStrikeMultiplierLocal',
      'GlobalCriticalStrikeMultiplier',
      'CriticalStrikeChanceWithSpells',
    ],
    textHints: [/critical strike chance/i, /critical strike multiplier/i],
  },
];

let officialHarvestById = new Map();

/** Bind generated harvest-reforge-official.json costs onto matching metadata. */
export function applyOfficialHarvestCosts(official) {
  officialHarvestById = new Map((official?.crafts ?? []).map((c) => [c.id, c]));
  for (const h of HARVEST_REFORGES) {
    const o = officialHarvestById.get(h.id);
    if (o?.lifeforce) h.lifeforce = o.lifeforce;
    if (o?.name) h.name = o.name;
    if (o?.detail) h.detail = o.detail;
  }
}

/** Cost bag for N harvest reforges of this craft (juice only; Divines separate). */
export function harvestCostBag(harvest, attempts = 1) {
  const bag = {};
  const lf = officialHarvestById.get(harvest?.id)?.lifeforce ?? harvest?.lifeforce ?? {};
  for (const [color, amount] of Object.entries(lf)) {
    const key = LIFEFORCE_PRICE_KEY[color] ?? `${color}-lifeforce`;
    bag[key] = (bag[key] ?? 0) + amount * attempts;
  }
  return bag;
}

/** Metacraft (2 Divines) + harvest juice × attempts. */
export function harvestWithMetacraftCost(harvest, attempts, divinePerCraft = 2) {
  return { divine: attempts * divinePerCraft, ...harvestCostBag(harvest, attempts) };
}
/** Known unveil targets (Jun / veiled orbs). Odds are fallbacks when KB pool
 *  is unavailable — prefer spawnWeights.unveilExpected (3× independent rolls). */
function unveilPAny(p, rolls = 3) {
  return 1 - (1 - p) ** rolls;
}

export const VEILED_TARGETS = [
  {
    id: 'chaos-pen',
    label: 'Chaos Resistance Penetration',
    textHints: [/Penetrate .+% Chaos Resistance/i, /Attacks with this Weapon Penetrate .+ Chaos/i],
    // uniform p≈1/13 on wand-ish prefix pool → 1−(1−p)³; real EV uses weighted table
    unveilOdds: unveilPAny(1 / 13),
    gen: 'prefix',
  },
  {
    id: 'phys-as-extra',
    label: 'Physical as Extra Chaos / Fire',
    textHints: [/Gain .+ of Physical Damage as Extra/i],
    unveilOdds: unveilPAny(0.05),
    gen: 'prefix',
  },
];

/**
 * @deprecated Do not use for EV. Prices come from public/data/prices/daily.json
 * via loadKnowledgeBase / loadDailyPrices. Kept empty so accidental fallbacks fail loud.
 */
export const DEFAULT_PRICES = Object.freeze({});

/** Influenced base trade price is unknown until a trade quote exists. Never invent a premium for ranked EV. */

export const INFLUENCE_EXALTS = {
  Warlord: { key: 'warlord-exalt', name: "Warlord's Exalted Orb" },
  Redeemer: { key: 'redeemer-exalt', name: "Redeemer's Exalted Orb" },
  Crusader: { key: 'crusader-exalt', name: "Crusader's Exalted Orb" },
  Hunter: { key: 'hunter-exalt', name: "Hunter's Exalted Orb" },
  Shaper: { key: 'shaper-exalt', name: "Shaper's Exalted Orb" },
  Elder: { key: 'elder-exalt', name: "Elder's Exalted Orb" },
};

export function normalizeInfluence(name) {
  const key = String(name ?? '').trim().toLowerCase();
  return Object.keys(INFLUENCE_EXALTS).find((n) => n.toLowerCase() === key) ?? null;
}

/**
 * Influences required for the craft (paste flags and/or influence-only mods).
 * Eldritch (Exarch/Eater) is separate — never inferred as Conqueror influence.
 */
export function requiredInfluences(item, mods = []) {
  const set = new Set();
  for (const inf of item?.influenced ?? []) {
    const n = normalizeInfluence(inf);
    if (n) set.add(n);
  }
  for (const m of mods) {
    if (m.match?.source !== 'influence' && m.meta?.source !== 'influence') continue;
    const list = m.match?.influences ?? m.match?.influence ?? m.meta?.influences ?? [];
    for (const inf of Array.isArray(list) ? list : [list]) {
      const n = normalizeInfluence(inf);
      if (n) set.add(n);
    }
  }
  return [...set];
}

/**
 * Buy influenced base vs slam influence exalt.
 * Ranked EV never invents an influenced-base premium — that price is unknown until trade exists.
 * Prefer known-cost orbs when priced. Multi-influence stays buy (unranked).
 */
export function recommendInfluenceAcquisition(influences, prices, opts = {}) {
  const list = (influences ?? []).map(normalizeInfluence).filter(Boolean);
  if (!list.length) return null;
  const orbs = list.map((inf) => {
    const meta = INFLUENCE_EXALTS[inf];
    const unit = prices?.[meta.key];
    return { influence: inf, ...meta, unit: unit ?? null };
  });
  const orbTotal = orbs.every((o) => o.unit != null) ? orbs.reduce((s, o) => s + o.unit, 0) : null;

  if (opts.preferMidCraftSlam && list.length === 1) {
    return {
      influences: list,
      orbs,
      orbTotal,
      premiumTotal: null,
      ranked: orbTotal != null,
      recommend: 'slam',
      reason:
        'hard influence goal — mid-craft influence exalt after opposite-side fill (avoid buying influenced / influenced-fractured)',
    };
  }

  if (list.length > 1) {
    return {
      influences: list,
      orbs,
      orbTotal,
      premiumTotal: null,
      ranked: false,
      recommend: 'buy',
      reason: 'multiple influences — buy influenced (orbs only add one each); influenced base unpriced until trade exists',
    };
  }

  if (orbTotal == null) {
    return {
      influences: list,
      orbs,
      orbTotal: null,
      premiumTotal: null,
      ranked: false,
      recommend: 'orb',
      reason: 'influence exalt price missing — cannot rank buy vs slam; influenced base unpriced until trade exists',
    };
  }

  return {
    influences: list,
    orbs,
    orbTotal,
    premiumTotal: null,
    ranked: true,
    recommend: 'orb',
    reason: `ranked EV uses ${orbs.map((o) => o.name).join(' + ')} (~${Math.round(orbTotal)}c); influenced base unpriced until trade exists`,
  };
}

export function formatInfluenceBaseStep(baseName, minIlvl, acquisition, opts = {}) {
  if (!acquisition) return null;
  const { influences, orbs, recommend, reason, orbTotal } = acquisition;
  const label = influences.join(' + ');
  const fracturedMods = opts.fracturedMods ?? [];
  const fracSuffix = fracturedMods.length ? ` with: ${fracturedMods.join(', ')}` : '';
  const orbNames = orbs.map((o) => o.name).join(' + ');

  if (recommend === 'slam') {
    const whiteNoun = opts.fractured ? 'fractured uninfluenced' : 'uninfluenced';
    const verb = opts.fractured ? 'Prefer' : 'Acquire';
    return {
      action: `${verb} ${whiteNoun} ${baseName} (ilvl ${minIlvl}+)${fracSuffix}`,
      detail: `Hard influence goal: do not buy influenced${opts.fractured ? ' / influenced-fractured' : ''} up front. Mid-craft ${orbNames} after filling the opposite side. ${reason}.`,
      cost: {},
      recommend: 'slam',
    };
  }

  const buyNoun = opts.fractured ? `fractured ${label}` : label;
  const buyAction = `Buy ${buyNoun} ${baseName} (ilvl ${minIlvl}+)${fracSuffix}`;
  const whiteNoun = opts.fractured ? `fractured uninfluenced` : 'uninfluenced';
  const orbAction = `Buy ${whiteNoun} ${baseName} (ilvl ${minIlvl}+)${fracSuffix} → apply ${orbNames} once`;

  const optionA = `Option A: Buy ${label} ${baseName} ilvl ${minIlvl}+ (influenced base price unknown — unranked)`;
  const optionB =
    orbTotal != null
      ? `Option B: Buy uninfluenced ${baseName} → apply ${orbNames} once (~${Math.round(orbTotal)}c)`
      : `Option B: Buy uninfluenced ${baseName} → apply ${orbNames} once (orb price unknown)`;
  const recLine =
    recommend === 'buy'
      ? `Recommended: Option A — ${reason}.`
      : `Recommended: Option B — ${reason}.`;

  const cost =
    recommend === 'orb'
      ? Object.fromEntries(orbs.map((o) => [o.key, 1]))
      : {};

  return {
    action: recommend === 'buy' ? `${buyAction} [recommended]` : `${orbAction} [recommended]`,
    detail: `${recLine} ${optionA}. ${optionB}.`,
    cost,
    recommend,
  };
}

export function essencePriceKey(name) {
  const n = (name ?? '').toLowerCase();
  if (n.startsWith('deafening')) return 'essence-deafening';
  if (n.startsWith('screaming')) return 'essence-screaming';
  if (n.startsWith('shrieking')) return 'essence-shrieking';
  if (n.startsWith('weeping')) return 'essence-weeping';
  if (n.startsWith('wailing')) return 'essence-wailing';
  if (n.startsWith('muttering')) return 'essence-muttering';
  return 'essence';
}

export function modMatchesHarvest(mod, harvest) {
  const text = mod.text ?? '';
  if (harvest.excludeText?.some((r) => r.test(text))) return false;

  const tags = (mod.tags ?? []).map((t) => t.toLowerCase().replace(/\s+/g, '_'));
  const groups = [...(mod.meta?.groups ?? []), ...(mod.groups ?? [])];

  if (harvest.tags.some((t) => tags.includes(t.replace(/\s+/g, '_')))) return true;
  if (harvest.groups?.some((g) => groups.includes(g))) return true;
  if (harvest.textHints.some((r) => r.test(text))) return true;
  return false;
}

/** Best harvest that matches the most mods (strict, official crafts only). */
export function findHarvestForMods(mods) {
  let best = null;
  for (const harvest of HARVEST_REFORGES) {
    const matched = mods.filter((m) => modMatchesHarvest(m, harvest));
    if (!matched.length) continue;
    const score = matched.length * 10 + (harvest.priority ?? 0);
    if (!best || score > best.score) best = { harvest, matched, score };
  }
  return best ? { harvest: best.harvest, matched: best.matched } : null;
}

/** Group mods into per-harvest buckets (strict, no cross-contamination). */
export function groupModsByHarvest(mods) {
  const used = new Set();
  const groups = [];
  const ordered = [...HARVEST_REFORGES].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const harvest of ordered) {
    const matched = mods.filter((m) => !used.has(m) && modMatchesHarvest(m, harvest));
    if (!matched.length) continue;
    for (const m of matched) used.add(m);
    groups.push({ harvest, matched });
  }
  return { groups, unmatched: mods.filter((m) => !used.has(m)) };
}

export function findVeiledTarget(mod) {
  return VEILED_TARGETS.find((v) => v.textHints.some((r) => r.test(mod.text ?? ''))) ?? null;
}

/** Minimum item level needed for all target mods (from RePoE reqLevel). */
export function minIlvlForMods(mods) {
  let min = 1;
  const drivers = [];
  for (const m of mods) {
    const req = m.meta?.reqLevel ?? m.reqLevel ?? 1;
    if (req > min) {
      min = req;
      drivers.length = 0;
      drivers.push({
        text: String(m.text ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .join(' | '),
        req,
      });
    } else if (req === min && req > 1) {
      drivers.push({
        text: String(m.text ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .join(' | '),
        req,
      });
    }
  }
  return { minIlvl: min, drivers };
}

/**
 * Expected tradable chaos EV from a cost bag (§25–26).
 * Gold / dust are excluded (non-tradeable dimensions) — never valued as 0c silently.
 * Returns null if prices missing or any used tradable key has no unit price.
 */
export function chaosCost(costs, prices) {
  return tradableChaosCost(costs, prices);
}

export function formatCostBreakdown(costs, prices) {
  return Object.entries(costs ?? {})
    .filter(([, n]) => n == null || n > 0)
    .map(([key, count]) => {
      const unknownAmt = count == null || !Number.isFinite(count);
      const nonTradable = isNonTradableKey(key);
      const unit = nonTradable ? null : prices?.[key];
      const chaos =
        !nonTradable && !unknownAmt && unit != null && Number.isFinite(unit)
          ? Math.round(count * unit * 100) / 100
          : null;
      return {
        key,
        label: COST_LABELS[key] ?? key,
        count: unknownAmt ? null : Math.ceil(count),
        chaos,
        unknown: unknownAmt || (!nonTradable && chaos == null),
        nonTradable,
        formula: nonTradable
          ? unknownAmt
            ? `${COST_LABELS[key] ?? key} amount unpublished (?)`
            : rawCostFormula(COST_LABELS[key] ?? key, count, null).replace(' × ?c = ?', ' (non-tradeable)')
          : rawCostFormula(COST_LABELS[key] ?? key, count, unit),
      };
    })
    .sort((a, b) => (b.chaos ?? -1) - (a.chaos ?? -1));
}

/**
 * Expected cost to slam one specific mod onto an open slot.
 * If protectSide has valuable mods, each miss requires metacraft+annul loop.
 */
export function exaltWithAnnulEv(targetWeight, poolWeight, openModsOnProtectedSide = 0) {
  const p = targetWeight > 0 && poolWeight > 0 ? targetWeight / poolWeight : 0.01;
  const expectedExalts = 1 / p;

  if (openModsOnProtectedSide <= 0) {
    return {
      expectedExalts: Math.ceil(expectedExalts),
      expectedAnnuls: Math.ceil(expectedExalts - 1),
      expectedDivines: 0,
      detail: `~${Math.ceil(expectedExalts)} Exalts (${(p * 100).toFixed(2)}% per slam). Misses annul'd without metacraft.`,
      cost: {
        exalt: Math.ceil(expectedExalts),
        annul: Math.ceil(Math.max(0, expectedExalts - 1)),
      },
      manageable: expectedExalts < 80,
    };
  }

  const expectedDivines = Math.ceil(expectedExalts) * 2;
  const expectedAnnuls = Math.ceil(expectedExalts * 2);
  return {
    expectedExalts: Math.ceil(expectedExalts),
    expectedAnnuls,
    expectedDivines,
    detail: `~${Math.ceil(expectedExalts)} Exalts at ${(p * 100).toFixed(2)}%/slam. Protect other side with metacraft before annulling misses (~${expectedDivines} Divines + ${expectedAnnuls} Annuls expected).`,
    cost: {
      exalt: Math.ceil(expectedExalts),
      annul: expectedAnnuls,
      divine: expectedDivines,
    },
    manageable: expectedExalts < 40 && expectedDivines < 100,
  };
}
