import { expectedAttempts, formatAttemptsDisplay } from './expected.js';
import {
  METACRAFT,
  essencePriceKey,
  findHarvestForMods,
  findVeiledTarget,
  DEFAULT_PRICES,
} from './craftKnowledge.js';
import { getPoolWeights } from './modMatcher.js';

function expectedRolls(targetWeight, poolWeight) {
  if (!targetWeight || !poolWeight) return null;
  return expectedAttempts(targetWeight / poolWeight);
}

function mergeCost(into, add) {
  for (const [k, v] of Object.entries(add ?? {})) {
    into[k] = (into[k] ?? 0) + v;
  }
}

/** Full hybrid / multi-line mod text for UI (join lines with " | "). */
function label(modOrText) {
  const t = typeof modOrText === 'string' ? modOrText : modOrText?.text;
  return String(t ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' | ');
}

export function stepBuyFractured(baseName, ilvl, fracturedMods) {
  const labels = fracturedMods.map((m) => {
    const tier = m.tier ? `T${m.tier} ` : '';
    return `${tier}${label(m)}`;
  });
  return {
    operator: 'buyFracturedBase',
    currency: 'quality',
    action: `Buy fractured ${baseName} (ilvl ${ilvl}+)`,
    detail: `Acquire the fractured base with locked mod(s). Do not roll for these — they are anchors.`,
    targetMods: labels,
    cost: {},
  };
}

export function stepEssenceSpam(essenceName, guaranteedMod, secondaryGoals, cleanSide, expected) {
  const key = essencePriceKey(essenceName);
  const secondary = secondaryGoals.map(label);
  const attempts = expected != null && Number.isFinite(expected) ? expected : null;
  return {
    operator: 'essenceSpam',
    currency: 'essence',
    action: `Spam ${essenceName}`,
    detail: [
      `Guarantees: ${label(guaranteedMod)}.`,
      secondary.length
        ? `Keep going until you also hit (or leave open for harvest): ${secondary.join(' OR ')}.`
        : 'Roll until the guaranteed mod is alone with clean open slots.',
      cleanSide === 'prefix'
        ? 'Make sure there are no unwanted prefixes (only fractured prefixes allowed).'
        : cleanSide === 'suffix'
          ? 'Make sure there are no unwanted suffixes.'
          : '',
      attempts != null
        ? `~${formatAttemptsDisplay(attempts)} essences expected (from spawn weights).`
        : 'Expected attempts from spawn-weight EV (not a fixed count).',
    ]
      .filter(Boolean)
      .join(' '),
    targetMods: [label(guaranteedMod), ...secondary],
    cost: attempts != null ? { [key]: attempts } : { [key]: null },
  };
}

export function stepHarvestWithMetacraft(lockSide, harvest, targetMods) {
  const meta = lockSide === 'suffix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
  const attempts = Math.max(1, targetMods.length);
  return {
    operator: 'harvestReforge',
    currency: 'harvest',
    action: `${meta.name} → Harvest ${harvest.name}`,
    detail: [
      `Craft "${meta.name}" (${meta.cost.divine} Divine), then use Harvest: ${harvest.detail}.`,
      `This reforges the unlocked side while protecting locked mods. Go for T1/T2 on: ${targetMods.map(label).join(', ')}.`,
      'Repeat until the target hits; re-apply metacraft after each reforge. Odds come from the current eligible harvest pool (occupied groups removed) — not a hardcoded guarantee.',
    ].join(' '),
    targetMods: targetMods.map(label),
    cost: {
      divine: meta.cost.divine * Math.max(attempts, 2),
      ...Object.fromEntries(
        Object.entries(harvest.lifeforce ?? {}).map(([color, amount]) => [
          `${color}-lifeforce`,
          amount * Math.max(attempts, 2),
        ])
      ),
    },
  };
}

export function stepVeiledWithMetacraft(lockSide, veiledTarget, mod, { useChaos = true } = {}) {
  const meta = lockSide === 'suffix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
  const odds = veiledTarget?.unveilOdds ?? 1 - (14 / 15) ** 3;
  const unveils = expectedAttempts(odds);
  const orbName = useChaos ? 'Veiled Chaos' : 'Veiled Exalt';
  const orbKey = useChaos ? 'veiled-chaos' : 'veiled';
  return {
    operator: useChaos ? 'veiledChaos' : 'veiledExalt',
    currency: orbKey,
    action: `${meta.name} → ${orbName} → Unveil`,
    detail: [
      `Craft "${meta.name}" again (${meta.cost.divine} Divine).`,
      useChaos
        ? `Apply a Veiled Chaos Orb to reforge the unlocked side (guarantees a veiled among new mods; fractured stays).`
        : `Apply a Veiled Exalted Orb (or Aisling) to add a veiled mod on the open side.`,
      `Unveil for: ${veiledTarget?.label ?? label(mod)} (3 rolls at single-option chance → ~${(odds * 100).toFixed(1)}%/unveil).`,
      `~${unveils} unveil attempts expected.`,
    ].join(' '),
    targetMods: [label(mod)],
    cost: {
      divine: meta.cost.divine * unveils,
      [orbKey]: unveils,
    },
  };
}

export function stepBenchCraft(mod) {
  return {
    operator: 'benchCraft',
    currency: 'bench',
    action: 'Crafting Bench',
    detail: `Craft the remaining open affix on the bench: ${label(mod)}.`,
    targetMods: [label(mod)],
    cost: { bench: 1 },
  };
}

export function stepEnchant(enchants) {
  if (!enchants?.length) return null;
  return {
    operator: 'enchant',
    currency: 'quality',
    action: 'Apply lab / quality enchants',
    detail: 'Finish with the listed enchantments (labyrinth or quality craft) after the item is otherwise done.',
    targetMods: enchants.map((e) => e.text),
    cost: {},
  };
}

export function stepImplicitNote(implicits) {
  if (!implicits?.length) return null;
  return {
    operator: 'implicit',
    currency: 'quality',
    action: 'Base implicit / crafted implicit',
    detail: `Item has special implicit(s): ${implicits.map((i) => i.text).join('; ')}. Factor this into which mods can roll.`,
    targetMods: implicits.map((i) => i.text),
    cost: {},
  };
}

/** Fallback alt-regal when no advanced operators apply. */
export function planAltRegalExalt(enriched, index) {
  const costs = {};
  const steps = [];
  const mods = enriched.enrichedMods.filter((m) => !m.fractured && !m.crafted);
  const tags = enriched.tags;
  const ilvl = enriched.itemLevel ?? 83;
  const influenced = enriched.influenced ?? [];

  steps.push({
    operator: 'buyBase',
    currency: 'quality',
    action: `Acquire ${enriched.baseName} (ilvl ${ilvl}+)`,
    detail: 'High ilvl base for top-tier access. Quality to 20% while white.',
    targetMods: [],
    cost: {},
  });

  const prefixes = mods.filter((m) => (m.gen ?? m.meta?.gen) === 'prefix');
  const suffixes = mods.filter((m) => (m.gen ?? m.meta?.gen) === 'suffix');
  const magic = [prefixes[0], suffixes[0]].filter(Boolean).slice(0, 2);

  const essenceMod = mods.find((m) => m.ofEssence || m.meta?.essenceOnly);
  if (essenceMod?.meta?.essences?.length) {
    const ess = essenceMod.meta.essences[0];
    const key = essencePriceKey(ess.name);
    steps.push(stepEssenceSpam(ess.name, essenceMod, [], null, 1));
    mergeCost(costs, { [key]: 1 });
  } else {
    mergeCost(costs, { transmute: 1, alteration: 80 });
    steps.push({
      operator: 'altSpam',
      currency: 'alteration',
      action: 'Alt spam magic targets',
      detail: 'Transmute, then Alteration/Augmentation until two good magic mods.',
      targetMods: magic.map(label),
      cost: { transmute: 1, alteration: 80 },
    });
    mergeCost(costs, { regal: 10 });
    steps.push({
      operator: 'regal',
      currency: 'regal',
      action: 'Regal to rare',
      detail: 'Regal; scour and restart if the third mod bricks.',
      targetMods: mods.filter((m) => !magic.includes(m)).slice(0, 1).map(label),
      cost: { regal: 10 },
    });
  }

  const rest = mods.filter((m) => !magic.includes(m) && m !== essenceMod);
  for (const m of rest.slice(0, 3)) {
    const pool = getPoolWeights(index, tags, ilvl, influenced, [], m.meta?.gen);
    const size = m.meta?.gen === 'prefix' ? pool.prefixTotal : m.meta?.gen === 'suffix' ? pool.suffixTotal : pool.total;
    const rolls = expectedRolls(m.meta?.weight ?? 100, size) ?? 20;
    // Cap exalt spam display — prefer noting multimod over absurd counts
    const capped = Math.min(rolls, 50);
    mergeCost(costs, { exalt: capped });
    steps.push({
      operator: 'exalt',
      currency: 'exalt',
      action: 'Exalt / multimod finish',
      detail: `Fill remaining affix. Prefer multimod + targeted slam over raw exalt spam when odds are worse than ~1/${capped}.`,
      targetMods: [label(m)],
      cost: { exalt: capped },
    });
  }

  for (const c of enriched.enrichedCrafted ?? []) {
    steps.push(stepBenchCraft(c));
  }

  return { steps, costs };
}

export { mergeCost, DEFAULT_PRICES, findHarvestForMods, findVeiledTarget };
