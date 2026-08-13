/**
 * @deprecated §64 — legacy dual recipe/probability path. Production uses planner/optimizer + V(S).
 * Do not import for new code. Kept only for static regression scans.
 */
import {
  METACRAFT,
  DEFAULT_PRICES,
  chaosCost,
  formatCostBreakdown,
  minIlvlForMods,
  findHarvestForMods,
  groupModsByHarvest,
  findVeiledTarget,
  exaltWithAnnulEv,
  essencePriceKey,
  modMatchesHarvest,
} from './craftKnowledge.js';
import { getPoolWeights } from './modMatcher.js';
import { expectedAttempts, formatAttemptsDisplay } from './expected.js';

function short(mod) {
  return String(mod.text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' | ');
}

function genOf(mod) {
  return mod.gen ?? mod.meta?.gen ?? mod.type;
}

function mergeCost(into, add) {
  for (const [k, v] of Object.entries(add ?? {})) into[k] = (into[k] ?? 0) + v;
}

function renumber(steps) {
  return steps.map((s, i) => ({ ...s, step: i + 1 }));
}

function finalize(id, name, description, steps, costs, extras = {}) {
  return {
    id,
    name,
    description,
    steps: renumber(steps),
    costs,
    totalCost: chaosCost(costs),
    structured: true,
    ...extras,
  };
}

function buyBaseStep(enriched, minIlvl, drivers) {
  const why =
    drivers?.length > 0
      ? `Needed for: ${drivers.map((d) => `${d.text} (req ilvl ${d.req})`).join('; ')}.`
      : 'Matches highest tier you want.';
  return {
    operator: 'buyBase',
    currency: 'quality',
    action: `Acquire ${enriched.baseName} (ilvl ${minIlvl}+)`,
    detail: `Minimum ilvl ${minIlvl} from target mod tiers — not the pasted item's ilvl. ${why} Quality to 20% while white.`,
    targetMods: drivers?.map((d) => d.text) ?? [],
    cost: {},
  };
}

function altForMod(index, enriched, mod) {
  const tags = enriched.tags;
  const ilvl = enriched.itemLevel ?? 83;
  const pool = getPoolWeights(index, tags, ilvl, enriched.influenced ?? []);
  const w = mod.meta?.weight || 100;
  const p = pool.total > 0 ? w / pool.total : 0;
  const rolls = expectedAttempts(p);
  return {
    operator: 'altSpam',
    currency: 'alteration',
    action: `Alt spam for ${short(mod)}`,
    detail: `Transmute → Alteration until you hit this mod on magic (~${rolls} Alts at current pool weights). Augment if you need a second magic mod.`,
    targetMods: [short(mod)],
    cost: { transmute: 1, alteration: rolls },
  };
}

/**
 * After you already have mods to protect on lockSide, harvest-reforge the open side.
 */
function harvestFillStep(lockSide, harvest, targets, expectedAttempts) {
  const meta = lockSide === 'suffix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
  const attempts = Math.max(expectedAttempts, targets.length);
  return {
    operator: 'harvestReforge',
    currency: 'harvest',
    action: `${meta.name} → Harvest ${harvest.name}`,
    detail: [
      `Only after ${lockSide === 'suffix' ? 'suffixes' : 'prefixes'} you want to keep are already on the item.`,
      `Craft "${meta.name}" (${meta.cost.divine} Divine), then Harvest: ${harvest.detail}.`,
      `Target: ${targets.map(short).join(', ')}.`,
      `Re-apply metacraft each reforge. ~${attempts} harvest cycles expected (rough).`,
    ].join(' '),
    targetMods: targets.map(short),
    cost: { divine: meta.cost.divine * attempts, harvest: attempts },
  };
}

/** Cost to slam several mods with exalt+annul, protecting the other side. */
function exaltFillPlan(index, enriched, modsToFill, protectedSideHasMods) {
  const tags = enriched.tags;
  const ilvl = enriched.itemLevel ?? 83;
  const steps = [];
  const costs = {};
  let manageable = true;

  for (const mod of modsToFill) {
    const gen = genOf(mod);
    const pool = getPoolWeights(index, tags, ilvl, enriched.influenced ?? [], [], gen);
    const poolSize = gen === 'prefix' ? pool.prefixTotal : gen === 'suffix' ? pool.suffixTotal : pool.total;
    const w = mod.meta?.weight || 100;
    const ev = exaltWithAnnulEv(w, poolSize, protectedSideHasMods ? 2 : 0);
    if (!ev.manageable) manageable = false;
    mergeCost(costs, ev.cost);
    steps.push({
      operator: 'exalt',
      currency: 'exalt',
      action: `Exalt for ${short(mod)}`,
      detail: ev.detail,
      targetMods: [short(mod)],
      cost: ev.cost,
    });
  }

  return { steps, costs, manageable, totalCost: chaosCost(costs) };
}

/**
 * Recipe A: Fracture → Essence → Harvest (crit) → Veiled → Bench
 * Only when those signals exist. Metacraft only AFTER essence anchors exist.
 */
function recipeFractureEssenceHarvest(enriched, index, minIlvl, drivers) {
  const fractured = enriched.enrichedMods.filter((m) => m.fractured);
  const crafted = enriched.enrichedCrafted ?? [];
  const natural = enriched.enrichedMods.filter((m) => !m.fractured && !m.crafted);
  const essenceMods = natural.filter((m) => m.ofEssence || m.meta?.essenceOnly);
  const veiledMods = natural.filter((m) => findVeiledTarget(m) || m.veiled);

  if (!fractured.length && !essenceMods.length) return null;

  const steps = [];
  const costs = {};
  const parts = [];

  if (enriched.implicits?.length) {
    steps.push({
      operator: 'implicit',
      currency: 'quality',
      action: 'Base / crafted implicit',
      detail: `Implicits: ${enriched.implicits.map((i) => i.text).join('; ')}.`,
      targetMods: enriched.implicits.map((i) => i.text),
      cost: {},
    });
  }

  if (fractured.length) {
    parts.push('Fracture');
    steps.push({
      operator: 'buyFracturedBase',
      currency: 'quality',
      action: `Buy fractured ${enriched.baseName} (ilvl ${minIlvl}+)`,
      detail: `Anchors: ${fractured.map(short).join(', ')}. Min ilvl ${minIlvl}.`,
      targetMods: fractured.map(short),
      cost: {},
    });
  } else {
    steps.push(buyBaseStep(enriched, minIlvl, drivers));
  }

  const primary = essenceMods[0];
  let lockSide = 'suffix';

  if (primary) {
    parts.push('Essence');
    lockSide = genOf(primary) === 'prefix' ? 'prefix' : 'suffix';
    const name = primary.meta?.essences?.[0]?.name;
    if (!name) return null;
    const key = essencePriceKey(name);
    const sameSide = natural.filter(
      (m) => genOf(m) === genOf(primary) && m !== primary && !veiledMods.includes(m)
    );
    const harvestHit = findHarvestForMods(sameSide);
    const pFish = sameSide.reduce((acc, m) => {
      const hit = m.hitWeight ?? m.meta?.weight ?? 0;
      const pool = m.poolWeight ?? 1;
      return acc * (hit > 0 ? hit / pool : 1);
    }, 1);
    const attempts = sameSide.length ? expectedAttempts(pFish) : 1;
    mergeCost(costs, { [key]: attempts });
    steps.push({
      operator: 'essenceSpam',
      currency: 'essence',
      action: `Spam ${name}`,
      detail: [
        `Guarantees ${short(primary)}.`,
        harvestHit
          ? `Keep until you hit ${harvestHit.matched.map(short).join(' OR ')}, or open slots clean for harvest.`
          : 'Keep until open side is clean for the next step.',
        genOf(primary) === 'suffix'
          ? 'No unwanted prefixes (fractured prefixes OK).'
          : 'No unwanted suffixes.',
        `~${formatAttemptsDisplay(attempts)} essences expected.`,
      ].join(' '),
      targetMods: [short(primary), ...(harvestHit?.matched.map(short) ?? [])],
      cost: { [key]: attempts },
    });

    if (harvestHit?.matched?.length) {
      parts.push('Harvest');
      const hs = harvestFillStep(lockSide, harvestHit.harvest, harvestHit.matched, 3);
      mergeCost(costs, hs.cost);
      steps.push(hs);
    }
  }

  for (const vm of veiledMods) {
    parts.push('Veiled');
    const target = findVeiledTarget(vm);
    const meta = lockSide === 'suffix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
    const odds = target?.unveilOdds ?? 1 - (14 / 15) ** 3;
    const unveils = expectedAttempts(odds);
    // Metacraft locks the finished side → Veiled Chaos reforges the open side (standard).
    const c = { divine: meta.cost.divine * unveils, 'veiled-chaos': unveils };
    mergeCost(costs, c);
    steps.push({
      operator: 'veiledChaos',
      currency: 'veiled-chaos',
      action: `${meta.name} → Veiled Chaos → Unveil`,
      detail: `Protect finished ${lockSide}s, Veiled Chaos reforges the open side (guarantees veiled), unveil ${target?.label ?? short(vm)}: 3× p → ~${(odds * 100).toFixed(1)}%/unveil (~${unveils} expected).`,
      targetMods: [short(vm)],
      cost: c,
    });
  }

  const handled = new Set([
    ...fractured,
    primary,
    ...(findHarvestForMods(
      natural.filter((m) => genOf(m) === genOf(primary) && m !== primary && !veiledMods.includes(m))
    )?.matched ?? []),
    ...veiledMods,
  ].filter(Boolean));

  const leftover = natural.filter((m) => !handled.has(m));
  if (leftover.length) {
    const fill = exaltFillPlan(index, enriched, leftover, true);
    // Prefer harvest if leftover share a harvest tag
    const hg = groupModsByHarvest(leftover);
    if (hg.groups.length && hg.groups[0].matched.length >= leftover.length - 1) {
      const g = hg.groups[0];
      const otherLock = lockSide === 'suffix' ? 'prefix' : 'suffix';
      // Actually leftover is usually other side — lock finished side
      const hs = harvestFillStep(lockSide, g.harvest, g.matched, Math.max(4, g.matched.length * 2));
      if (chaosCost(hs.cost) <= fill.totalCost) {
        parts.push('Harvest');
        mergeCost(costs, hs.cost);
        steps.push(hs);
        for (const m of g.matched) handled.add(m);
      }
    }
    const still = natural.filter((m) => !handled.has(m));
    if (still.length) {
      const fill2 = exaltFillPlan(index, enriched, still, true);
      if (!fill2.manageable) {
        // Mark expensive — search will deprioritize
        mergeCost(costs, fill2.costs);
        steps.push(...fill2.steps);
      } else {
        mergeCost(costs, fill2.costs);
        steps.push(...fill2.steps);
      }
    }
  }

  for (const c of crafted) {
    parts.push('Bench');
    steps.push({
      operator: 'benchCraft',
      currency: 'bench',
      action: 'Crafting Bench',
      detail: `Craft: ${c.text.replace(/\n/g, ' + ')}.`,
      targetMods: [c.text.replace(/\n/g, ' / ')],
      cost: { bench: 1 },
    });
  }

  if (enriched.enchants?.length) {
    steps.push({
      operator: 'enchant',
      currency: 'quality',
      action: 'Apply enchants',
      detail: 'Lab / quality enchants after the craft is finished.',
      targetMods: enriched.enchants.map((e) => e.text),
      cost: {},
    });
  }

  return finalize(
    'fracture-essence-harvest',
    parts.join(' → ') || 'Essence path',
    'Anchors first (fracture/essence), then metacraft+harvest/veiled.',
    steps,
    costs
  );
}

/**
 * Recipe B: Suffixes first via alt, then harvest-reforge prefixes (ES/defence chests).
 * Never metacrafts on an empty item.
 */
function recipeSuffixThenHarvestPrefix(enriched, index, minIlvl, drivers) {
  const crafted = enriched.enrichedCrafted ?? [];
  const natural = enriched.enrichedMods.filter((m) => !m.fractured && !m.crafted);
  const prefixes = natural.filter((m) => genOf(m) === 'prefix');
  const suffixes = natural.filter((m) => genOf(m) === 'suffix' && !findVeiledTarget(m));

  if (!prefixes.length || !suffixes.length) return null;

  const prefixHarvest = findHarvestForMods(prefixes);
  // Need a shared harvest for most prefixes (e.g. all ES)
  if (!prefixHarvest || prefixHarvest.matched.length < Math.ceil(prefixes.length * 0.5)) return null;

  const steps = [];
  const costs = {};
  const parts = ['Alt suffixes', 'Harvest prefixes'];

  steps.push(buyBaseStep(enriched, minIlvl, drivers));

  // 1) Establish suffix anchors with alts — cheapest suffix first
  const suffixesByEase = [...suffixes].sort(
    (a, b) => (b.meta?.weight ?? 100) - (a.meta?.weight ?? 100)
  );
  const firstSuffix = suffixesByEase[0];
  const alt = altForMod(index, enriched, firstSuffix);
  mergeCost(costs, alt.cost);
  steps.push(alt);

  const otherSuffixes = suffixes.filter((m) => m !== firstSuffix);
  if (otherSuffixes.length) {
    // Augment / regal into rare, then harvest OR alt for second resist
    const second = otherSuffixes[0];
    const alt2 = altForMod(index, enriched, second);
    // Cheaper to harvest lightning separately? For two resists, alt both on magic is fine
    mergeCost(costs, { augmentation: 1, regal: 5, alteration: Math.ceil(alt2.cost.alteration / 2) });
    steps.push({
      operator: 'altSpam',
      currency: 'alteration',
      action: `Finish suffixes (${short(firstSuffix)} + ${otherSuffixes.map(short).join(', ')})`,
      detail: [
        'On magic: Augment / Alt until you have the resist suffixes you want (or one good suffix + open).',
        'Regal to rare when magic suffixes are acceptable.',
        'Do NOT craft Suffixes Cannot Be Changed until these suffixes already exist on the item.',
      ].join(' '),
      targetMods: suffixes.map(short),
      cost: { augmentation: 1, regal: 5, alteration: Math.ceil(alt2.cost.alteration / 2) },
    });
  } else {
    mergeCost(costs, { regal: 3 });
    steps.push({
      operator: 'regal',
      currency: 'regal',
      action: 'Regal to rare',
      detail: 'With your suffix anchor on magic, Regal to rare. Scour+restart if the regal bricks badly.',
      targetMods: [],
      cost: { regal: 3 },
    });
  }

  // 2) Now SCBC + harvest prefixes (ES)
  const attempts = Math.max(6, prefixHarvest.matched.length * 3);
  const hs = harvestFillStep('suffix', prefixHarvest.harvest, prefixHarvest.matched, attempts);
  mergeCost(costs, hs.cost);
  steps.push(hs);

  // Unmatched prefixes → exalt with protection (expensive — will lose to harvest if possible)
  const unmatchedPrefixes = prefixes.filter((m) => !prefixHarvest.matched.includes(m));
  if (unmatchedPrefixes.length) {
    const fill = exaltFillPlan(index, enriched, unmatchedPrefixes, true);
    mergeCost(costs, fill.costs);
    steps.push(...fill.steps);
  }

  for (const c of crafted) {
    parts.push('Bench');
    steps.push({
      operator: 'benchCraft',
      currency: 'bench',
      action: 'Crafting Bench',
      detail: `Craft: ${c.text.replace(/\n/g, ' + ')}.`,
      targetMods: [c.text.replace(/\n/g, ' / ')],
      cost: { bench: 1 },
    });
  }

  return finalize(
    'suffix-alt-harvest-prefix',
    parts.join(' → '),
    'Roll suffixes first, then metacraft+harvest the prefix pool (ES/defence).',
    steps,
    costs
  );
}

/**
 * Recipe C: Prefixes first (alt/harvest ES), then suffixes.
 */
function recipePrefixThenSuffix(enriched, index, minIlvl, drivers) {
  const crafted = enriched.enrichedCrafted ?? [];
  const natural = enriched.enrichedMods.filter((m) => !m.fractured && !m.crafted);
  const prefixes = natural.filter((m) => genOf(m) === 'prefix');
  const suffixes = natural.filter((m) => genOf(m) === 'suffix');
  if (!prefixes.length) return null;

  const prefixHarvest = findHarvestForMods(prefixes);
  const steps = [];
  const costs = {};

  steps.push(buyBaseStep(enriched, minIlvl, drivers));

  // Start with densest/easiest prefix via alt
  const easyPrefix = [...prefixes].sort((a, b) => (b.meta?.weight ?? 0) - (a.meta?.weight ?? 0))[0];
  const alt = altForMod(index, enriched, easyPrefix);
  mergeCost(costs, alt.cost);
  steps.push(alt);
  mergeCost(costs, { regal: 5 });
  steps.push({
    operator: 'regal',
    currency: 'regal',
    action: 'Regal to rare',
    detail: 'Regal once magic prefix is acceptable. Prefer open suffixes for later.',
    targetMods: [],
    cost: { regal: 5 },
  });

  if (prefixHarvest && prefixHarvest.matched.length >= 2) {
    // Need at least one prefix locked — PCBC + harvest fills other prefixes... wait PCBC locks prefixes and reforges suffixes.
    // To fill MORE prefixes while keeping existing prefix: you cannot harvest-reforge prefixes with PCBC.
    // Harvest reforge with SCBC locks suffixes and reforges prefixes — so you need suffixes first!
    // So prefix-first harvest for more prefixes requires having suffixes (filler) OR using fossils/essences.
    // If we have no suffixes yet, use harvest without metacraft (full reforge) — risky — or fossiles.

    if (suffixes.length) {
      // Get cheap filler suffixes first then SCBC harvest prefixes
      const easySuf = suffixes[0];
      const altS = altForMod(index, enriched, easySuf);
      // Actually we're already rare with a prefix — exalt/alt path messy. Skip this recipe complexity.
    }
  }

  // Fossils / harvest without lock: full reforge until ES prefixes — expensive chaos-like
  if (prefixHarvest) {
    const attempts = 25;
    mergeCost(costs, { harvest: attempts });
    steps.push({
      operator: 'harvestReforge',
      currency: 'harvest',
      action: `Harvest ${prefixHarvest.harvest.name} (no metacraft yet)`,
      detail: [
        'Without suffixes to protect, harvest reforge rerolls the whole rare.',
        `Repeat until you land: ${prefixHarvest.matched.map(short).join(', ')}.`,
        'Then alt/harvest suffixes separately. Usually worse than suffixes-first — listed for comparison.',
        `~${attempts} harvests expected (rough).`,
      ].join(' '),
      targetMods: prefixHarvest.matched.map(short),
      cost: { harvest: attempts },
    });
  }

  for (const s of suffixes) {
    const fill = exaltFillPlan(index, enriched, [s], true);
    mergeCost(costs, fill.costs);
    steps.push(...fill.steps);
  }

  for (const c of crafted) {
    steps.push({
      operator: 'benchCraft',
      currency: 'bench',
      action: 'Crafting Bench',
      detail: `Craft: ${c.text.replace(/\n/g, ' + ')}.`,
      targetMods: [c.text.replace(/\n/g, ' / ')],
      cost: { bench: 1 },
    });
  }

  return finalize(
    'prefix-harvest-yolo',
    'Harvest prefixes (unlocked) → suffixes',
    'Full harvest reforge without metacraft — usually expensive; comparison only.',
    steps,
    costs
  );
}

/**
 * Recipe D: Pure exalt+annul with metacraft protection (honest EV — often loses).
 */
function recipeHonestExalt(enriched, index, minIlvl, drivers) {
  const crafted = enriched.enrichedCrafted ?? [];
  const natural = enriched.enrichedMods.filter((m) => !m.fractured && !m.crafted);
  if (!natural.length) return null;

  const steps = [buyBaseStep(enriched, minIlvl, drivers)];
  const costs = {};

  // Alt one easy mod first so item isn't grey
  const easy = [...natural].sort((a, b) => (b.meta?.weight ?? 0) - (a.meta?.weight ?? 0))[0];
  const alt = altForMod(index, enriched, easy);
  mergeCost(costs, alt.cost);
  steps.push(alt);
  mergeCost(costs, { regal: 5 });
  steps.push({
    operator: 'regal',
    currency: 'regal',
    action: 'Regal to rare',
    detail: 'Get to rare before any metacraft or exalt slamming.',
    targetMods: [],
    cost: { regal: 5 },
  });

  const rest = natural.filter((m) => m !== easy);
  const fill = exaltFillPlan(index, enriched, rest, true);
  mergeCost(costs, fill.costs);
  steps.push(...fill.steps);

  for (const c of crafted) {
    steps.push({
      operator: 'benchCraft',
      currency: 'bench',
      action: 'Crafting Bench',
      detail: `Craft: ${c.text.replace(/\n/g, ' + ')}.`,
      targetMods: [c.text.replace(/\n/g, ' / ')],
      cost: { bench: 1 },
    });
  }

  return finalize(
    'honest-exalt',
    'Alt → Regal → Exalt/Annul (metacrafted)',
    'Honest exalt EV with metacraft protection — often not manageable for multiple T1s.',
    steps,
    costs,
    { manageable: fill.manageable }
  );
}

/**
 * Heuristic recipe generators (fixtures / macros). Not the ranked planner —
 * generateCraftSteps uses deterministicPlanner + V(state).
 */
export async function searchCraftPlans(enriched, index, onProgress) {
  const allMods = [
    ...enriched.enrichedMods.filter((m) => !m.crafted),
    ...enriched.enrichedCrafted,
  ];
  const { minIlvl, drivers } = minIlvlForMods(enriched.enrichedMods.filter((m) => !m.crafted));
  // Prefer computed min over pasted ilvl for the buy step; keep pasted for pool calcs
  const effectiveMin = Math.max(minIlvl, 1);

  const generators = [
    ['fracture-essence', () => recipeFractureEssenceHarvest(enriched, index, effectiveMin, drivers)],
    ['suffix-then-harvest', () => recipeSuffixThenHarvestPrefix(enriched, index, effectiveMin, drivers)],
    ['prefix-harvest-yolo', () => recipePrefixThenSuffix(enriched, index, effectiveMin, drivers)],
    ['honest-exalt', () => recipeHonestExalt(enriched, index, effectiveMin, drivers)],
  ];

  const plans = [];
  for (let i = 0; i < generators.length; i++) {
    const [label, gen] = generators[i];
    onProgress?.({ phase: 'searching', current: i + 1, total: generators.length, label });
    // Allow UI paint
    await new Promise((r) => setTimeout(r, 30));
    try {
      const plan = gen();
      if (plan && plan.steps?.length) {
        plan.minIlvl = effectiveMin;
        plan.ilvlDrivers = drivers;
        plans.push(plan);
      }
    } catch (e) {
      console.warn('recipe failed', label, e);
    }
  }

  // Prefer manageable plans; strongly prefer fracture/essence structured paths when present
  const signalBonus = (p) => {
    let b = 0;
    if (p.id === 'fracture-essence-harvest') b -= 1e9; // always win when available
    if (p.manageable === false) b += 1e8;
    return b;
  };

  plans.sort((a, b) => {
    const sa = signalBonus(a) + a.totalCost;
    const sb = signalBonus(b) + b.totalCost;
    return sa - sb;
  });

  onProgress?.({ phase: 'done', current: generators.length, total: generators.length });

  if (!plans.length) {
    const fallback = recipeHonestExalt(enriched, index, effectiveMin, drivers);
    return { best: fallback, alternatives: [], minIlvl: effectiveMin, drivers };
  }

  return {
    best: plans[0],
    alternatives: plans.slice(1, 4).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      totalCost: p.totalCost,
      costBreakdown: formatCostBreakdown(p.costs),
    })),
    minIlvl: effectiveMin,
    drivers,
    allPlans: plans,
  };
}

export { formatCostBreakdown, chaosCost, DEFAULT_PRICES, minIlvlForMods };
