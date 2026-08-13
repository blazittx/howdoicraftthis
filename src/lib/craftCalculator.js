import { getPoolWeights, modWeightOnItem } from './modMatcher.js';

/**
 * @deprecated Legacy planner — not used by the app. Do not put fake DEFAULT_PRICES here for EV.
 * Live path: craftKnowledge.chaosCost + public/data/prices/daily.json via npm run fetch-prices.
 */
export const DEFAULT_PRICES = Object.freeze({});


export function expectedRolls(targetWeight, poolWeight) {
  if (!targetWeight || !poolWeight) return null;
  return Math.ceil(poolWeight / targetWeight);
}

export function calcAltRegalExaltPlan(enrichedItem, index) {
  const { tags, itemLevel: ilvl = 83, influenced = [], enrichedMods } = enrichedItem;
  const targets = enrichedMods.filter((m) => !m.crafted && !m.fractured);
  const crafted = enrichedItem.enrichedCrafted ?? [];

  const costs = {};
  const addCost = (key, count) => {
    costs[key] = (costs[key] ?? 0) + count;
  };

  const steps = [];
  let stepNum = 1;
  const blockedGroups = [];

  const byWeight = [...targets].sort((a, b) => (a.meta.weight ?? 9999) - (b.meta.weight ?? 9999));
  const influenceTargets = byWeight.filter((m) => m.meta.influence?.length);
  const normalTargets = byWeight.filter((m) => !m.meta.influence?.length);

  const prefixes = normalTargets.filter((m) => m.meta.gen === 'prefix');
  const suffixes = normalTargets.filter((m) => m.meta.gen === 'suffix');
  const unclassified = normalTargets.filter((m) => !m.meta.gen);

  const byWeightAsc = (a, b) => (a.meta.weight ?? 9999) - (b.meta.weight ?? 9999);
  const magicPrefix = [...prefixes].sort(byWeightAsc)[0] ?? [...unclassified].sort(byWeightAsc)[0];
  const magicSuffix =
    [...suffixes].sort(byWeightAsc)[0] ??
    [...unclassified].sort(byWeightAsc).find((m) => m !== magicPrefix);
  const magicTargets = [magicPrefix, magicSuffix].filter(Boolean).slice(0, 2);
  const postMagic = normalTargets.filter((m) => !magicTargets.includes(m));

  // Check if essence beats alt for any magic target
  let usedEssence = null;
  for (const t of magicTargets) {
    if (t.meta.essences?.length) {
      const bestEssence = t.meta.essences[0];
      const essenceKey = essencePriceKey(bestEssence.name);
      const altRolls = calcSingleModAltCost(index, t.meta, tags, ilvl, influenced, blockedGroups);
      const altTotal = altRolls * DEFAULT_PRICES.alteration + (altRolls > 0 ? DEFAULT_PRICES.transmute : 0);
      const essTotal = DEFAULT_PRICES[essenceKey] ?? DEFAULT_PRICES.essence;

      if (essTotal < altTotal * 0.8) {
        usedEssence = { target: t, essence: bestEssence, key: essenceKey };
        break;
      }
    }
  }

  steps.push({
    step: stepNum++,
    phase: 'setup',
    currency: 'quality',
    action: `Acquire ${enrichedItem.baseName} (ilvl ${ilvl}+)`,
    detail: influenced.length
      ? `Needs ${influenced.join(' + ')} influence on base.`
      : 'Use highest ilvl base available for tier access.',
    cost: {},
  });

  if (influenceTargets.length) {
    for (const inf of [...new Set(influenceTargets.flatMap((m) => m.meta.influence))]) {
      const infMods = influenceTargets.filter((m) => m.meta.influence?.includes(inf));
      steps.push({
        step: stepNum++,
        phase: 'influence',
        currency: 'exalt',
        action: `${inf} Conqueror Exalted Orb`,
        detail: `Influence mods only roll on ${inf} bases. Slam or alt on influenced item.`,
        targetMods: infMods.map((m) => m.text),
        cost: { exalt: infMods.length * 2 },
      });
      addCost('exalt', infMods.length * 2);
      for (const m of infMods) blockedGroups.push(...m.meta.groups);
    }
  }

  if (usedEssence) {
    addCost(usedEssence.key, 1);
    steps.push({
      step: stepNum++,
      phase: 'magic',
      currency: 'essence',
      action: `Apply ${usedEssence.essence.name}`,
      detail: `Guarantees: ${usedEssence.target.text}. Upgrades to rare if using tier 4+ essence.`,
      targetMods: [usedEssence.target.text],
      cost: { [usedEssence.key]: 1 },
    });
    blockedGroups.push(...usedEssence.target.meta.groups);
  } else {
    addCost('transmute', 1);
    steps.push({
      step: stepNum++,
      phase: 'magic',
      currency: 'transmute',
      action: 'Transmute to magic',
      detail: 'Start alt spam from magic rarity.',
      cost: { transmute: 1 },
    });

    for (let i = 0; i < magicTargets.length; i++) {
      const t = magicTargets[i];
      const rolls = calcSingleModAltCost(index, t.meta, tags, ilvl, influenced, blockedGroups);
      const augRolls = i > 0 ? 1 : 0;
      addCost('alteration', rolls);
      if (augRolls) addCost('augmentation', augRolls);

      steps.push({
        step: stepNum++,
        phase: 'magic',
        currency: 'alteration',
        action: i === 0 ? 'Alt spam first mod' : 'Alt spam second mod',
        detail: `~${rolls} Alterations expected (${formatChance(rolls)}).${augRolls ? ' Use 1 Augmentation first.' : ''}`,
        targetMods: [t.text],
        cost: { alteration: rolls, ...(augRolls ? { augmentation: augRolls } : {}) },
      });
      blockedGroups.push(...t.meta.groups);
    }
  }

  // Regal for 3rd mod, then exalt/essence the rest
  const regalTargets = postMagic.filter((m) => !m.crafted);
  if (regalTargets.length > 0 && magicTargets.length >= 1) {
    const regalTarget = regalTargets[0];
    const pool = getPoolWeights(index, tags, ilvl, influenced, blockedGroups, regalTarget.meta.gen);
    const poolSize = regalTarget.meta.gen === 'prefix' ? pool.prefixTotal : regalTarget.meta.gen === 'suffix' ? pool.suffixTotal : pool.total;
    const rolls = expectedRolls(regalTarget.meta.weight, poolSize) ?? 3;
    addCost('regal', rolls);

    steps.push({
      step: stepNum++,
      phase: 'regal',
      currency: 'regal',
      action: 'Regal to rare',
      detail: `~${rolls} Regals to hit target (scour + restart on brick).`,
      targetMods: [regalTarget.text],
      cost: { regal: rolls },
    });
    blockedGroups.push(...regalTarget.meta.groups);

    // Remaining exalt slams
    for (const t of regalTargets.slice(1)) {
      if (t.crafted) continue;
      if (t.meta.essences?.length) {
        const ess = t.meta.essences[0];
        const key = essencePriceKey(ess.name);
        addCost(key, 1);
        steps.push({
          step: stepNum++,
          phase: 'finish',
          currency: 'essence',
          action: `Essence slam: ${ess.name}`,
          detail: `Guaranteed mod on rare item.`,
          targetMods: [t.text],
          cost: { [key]: 1 },
        });
      } else {
        const pool = getPoolWeights(index, tags, ilvl, influenced, blockedGroups, t.meta.gen);
        const poolSize = t.meta.gen === 'prefix' ? pool.prefixTotal : t.meta.gen === 'suffix' ? pool.suffixTotal : pool.total;
        const exRolls = expectedRolls(t.meta.weight, poolSize) ?? 5;
        addCost('exalt', exRolls);
        steps.push({
          step: stepNum++,
          phase: 'finish',
          currency: 'exalt',
          action: 'Exalt slam',
          detail: `~${exRolls} Exalts expected per open slot.`,
          targetMods: [t.text],
          cost: { exalt: exRolls },
        });
      }
      blockedGroups.push(...t.meta.groups);
    }
  }

  for (const c of crafted) {
    steps.push({
      step: stepNum++,
      phase: 'bench',
      currency: 'bench',
      action: 'Crafting Bench',
      detail: `Add crafted mod (does not block exalt slot permanently if removed).`,
      targetMods: [c.text],
      cost: {},
    });
  }

  return { steps, costs, magicTargets: magicTargets.map((m) => m.text) };
}

function calcSingleModAltCost(index, meta, tags, ilvl, influence, blockedGroups) {
  const pool = getPoolWeights(index, tags, ilvl, influence, blockedGroups);
  return expectedRolls(meta.weight || 100, pool.total) ?? 10;
}

function formatChance(rolls) {
  if (!rolls) return 'unknown odds';
  const pct = ((1 / rolls) * 100).toFixed(2);
  return `~${pct}% per try`;
}

function essencePriceKey(name) {
  const n = name.toLowerCase();
  if (n.startsWith('deafening')) return 'essence-deafening';
  if (n.startsWith('screaming')) return 'essence-screaming';
  if (n.startsWith('shrieking')) return 'essence-shrieking';
  if (n.startsWith('weeping')) return 'essence-weeping';
  if (n.startsWith('muttering')) return 'essence-muttering';
  if (n.startsWith('wailing')) return 'essence-wailing';
  return 'essence';
}

export function compareStrategies(enrichedItem, index) {
  const altPlan = calcAltRegalExaltPlan(enrichedItem, index);

  const strategies = [
    {
      id: 'alt-regal-exalt',
      name: 'Alt → Regal → Exalt',
      description: 'Standard universal crafting — cheapest for most generic mod combos.',
      ...altPlan,
    },
  ];

  // Essence-first strategy: essence the hardest mod upfront
  const hardMod = [...enrichedItem.enrichedMods]
    .filter((m) => m.meta.essences?.length)
    .sort((a, b) => (a.meta.weight ?? 9999) - (b.meta.weight ?? 9999))[0];

  if (hardMod && !strategies[0].steps.some((s) => s.currency === 'essence')) {
    const essPlan = calcEssenceFirstPlan(enrichedItem, index, hardMod);
    strategies.push({
      id: 'essence-first',
      name: 'Essence First',
      description: `Start with ${hardMod.meta.essences[0]?.name} for guaranteed ${hardMod.text}.`,
      ...essPlan,
    });
  }

  // Chaos spam only if 4+ mods and no special requirements — usually expensive
  if (enrichedItem.enrichedMods.length >= 4) {
    const pool = getPoolWeights(
      index,
      enrichedItem.tags,
      enrichedItem.itemLevel ?? 83,
      enrichedItem.influenced
    );
    const chaosRolls = Math.ceil(pool.total / 50) * 20;
    strategies.push({
      id: 'chaos-spam',
      name: 'Chaos Spam',
      description: 'Alch + chaos until all mods hit. Usually most expensive — listed for comparison.',
      steps: [
        {
          step: 1,
          phase: 'setup',
          currency: 'alchemy',
          action: 'Alchemy to rare',
          detail: 'Full reroll each chaos — low control.',
          cost: { alchemy: 1 },
        },
        {
          step: 2,
          phase: 'finish',
          currency: 'alchemy',
          action: `Chaos spam (~${chaosRolls} chaos)`,
          detail: 'Not recommended for targeted crafts.',
          cost: { chaos: chaosRolls },
        },
      ],
      costs: { alchemy: 1, chaos: chaosRolls },
      magicTargets: [],
    });
  }

  for (const s of strategies) {
    s.totalCost = chaosCost(s.costs, DEFAULT_PRICES);
  }

  strategies.sort((a, b) => a.totalCost - b.totalCost);
  return strategies;
}

function calcEssenceFirstPlan(enrichedItem, index, hardMod) {
  const plan = calcAltRegalExaltPlan(enrichedItem, index);
  const key = essencePriceKey(hardMod.meta.essences[0].name);
  // Prefer essence on the hardest mod during magic phase
  if (!plan.steps.some((s) => s.currency === 'essence')) {
    plan.costs[key] = (plan.costs[key] ?? 0) + 1;
    plan.totalCost = chaosCost(plan.costs);
  }
  return plan;
}

export function chaosCost(costs, prices = DEFAULT_PRICES) {
  let total = 0;
  for (const [key, count] of Object.entries(costs ?? {})) {
    total += (prices[key] ?? prices[key.replace(/-.+$/, '')] ?? 0.1) * count;
  }
  return Math.round(total * 100) / 100;
}

export function formatCostBreakdown(costs, prices = DEFAULT_PRICES) {
  const labels = {
    transmute: 'Transmute',
    alteration: 'Alteration',
    augmentation: 'Augmentation',
    regal: 'Regal',
    exalt: 'Exalt',
    annul: 'Annul',
    scour: 'Scour',
    alchemy: 'Alchemy',
    chaos: 'Chaos',
    divine: 'Divine',
    essence: 'Essence',
    'essence-deafening': 'Deafening Essence',
    'essence-screaming': 'Screaming Essence',
    'essence-shrieking': 'Shrieking Essence',
    'essence-weeping': 'Weeping Essence',
    'essence-muttering': 'Muttering Essence',
    bench: 'Bench',
  };

  return Object.entries(costs ?? {})
    .filter(([, n]) => n > 0)
    .map(([key, count]) => {
      const unit = prices[key] ?? 0.1;
      const chaos = Math.round(count * unit * 100) / 100;
      return {
        key,
        label: labels[key] ?? key,
        count: Math.ceil(count),
        chaos,
      };
    })
    .sort((a, b) => b.chaos - a.chaos);
}
