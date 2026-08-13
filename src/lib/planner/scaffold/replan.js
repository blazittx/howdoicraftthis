/**
 * Scaffold replan — progress / option toggles.
 */
import {
  loadKnowledgeBase,
  getBaseInfo,
  effectiveBaseTags,
} from '../../knowledgeLoader.js';
import {
  harvestGoalOdds,
  essenceFishExpected,
  multiGenEssenceFishExpected,
  formatWeight,
  isNonOccupyingAffix,
  harvestEligiblePool,
  formatEligiblePool,
} from '../../spawnWeights.js';
import { planSummaryLine } from '../../planClass.js';
import { rulesetVersion } from '../../ruleset.js';
import {
  HARVEST_REFORGES,
  chaosCost,
  formatCostBreakdown,
  harvestWithMetacraftCost,
  harvestCostBag,
  modMatchesHarvest,
} from '../../craftKnowledge.js';
import {
  short,
  renumber,
  pct,
  formatAttempts,
  expectedAttemptsEv,
  clampRoll,
  ensureFinalBenchSteps,
  modStableKey,
} from './helpers.js';
import { planDeterministic } from './planDeterministic.js';
import { essenceExtraRollsByGen } from '../../mechanics/affixCounts.js';

function findClassifiedByLabel(classified, label) {
  const textKey = modStableKey(label);
  return (
    classified.find((m) => modStableKey(m.short ?? '') === textKey) ||
    classified.find((m) => modStableKey(m.text ?? '') === textKey) ||
    classified.find((m) => modStableKey(m) === textKey)
  );
}

function labelHit(hitKeys, text, mod) {
  if (mod && hitKeys.has(modStableKey(mod))) return true;
  if (hitKeys.has(modStableKey(text))) return true;
  if (mod?.short && hitKeys.has(modStableKey(mod.short))) return true;
  return false;
}

function occupiedFromHits(classified, hitKeys) {
  const occupied = new Set();
  for (const m of classified) {
    if (isNonOccupyingAffix(m)) continue;
    if (!labelHit(hitKeys, m.short ?? m.text, m)) continue;
    for (const g of m.groups ?? []) occupied.add(g);
  }
  return occupied;
}

/**
 * Rebuild plan when prefer-fracture toggles, then apply hit progress like replanFromProgress.
 * @param {object} item
 * @param {object} plan — prior UI plan (keeps art / display fields)
 * @param {{ preferFracture?: boolean, hitKeys?: Iterable<string> }} [options]
 */
export async function replanWithOptions(item, plan, options = {}) {
  const preferFracture = options.preferFracture !== false;
  const hitKeys = options.hitKeys ?? options.hitKeySet ?? [];
  const canPrefer =
    !!plan.preferFractureAvailable ||
    (plan.steps ?? []).some((s) => s.operator === 'preferFracture');

  let working = plan;
  if (canPrefer) {
    const result = await planDeterministic(item, null, { preferFracture });
    const best = result.best;
    const styleCurrency = (key) => {
      if (key && typeof key === 'object') return key;
      const CURRENCY = {
        quality: { name: 'Base', short: 'Base', color: '#aaa' },
        essence: { name: 'Essence', short: 'Essence', color: '#56ccf2' },
        harvest: { name: 'Harvest', short: 'Harvest', color: '#6fcf97' },
        bench: { name: 'Crafting Bench', short: 'Bench', color: '#6fcf97' },
        exalt: { name: 'Exalted Orb', short: 'Exalt', color: '#d4af37' },
        alteration: { name: 'Orb of Alteration', short: 'Alteration', color: '#7eb8da' },
        regal: { name: 'Regal Orb', short: 'Regal', color: '#d4af37' },
        veiled: { name: 'Veiled Exalt', short: 'Veiled', color: '#c9a0dc' },
        'veiled-chaos': { name: 'Veiled Chaos', short: 'Veiled Chaos', color: '#c9a0dc' },
        'eldritch-chaos': { name: 'Eldritch Chaos Orb', short: 'Eldritch Chaos', color: '#e8a838' },
        annul: { name: 'Orb of Annulment', short: 'Annul', color: '#c9a0dc' },
        gold: { name: 'Gold', short: 'Gold', color: '#c9a227' },
        'thaumaturgic-dust': { name: 'Thaumaturgic Dust', short: 'Dust', color: '#6b9bd1' },
      };
      const k = String(key ?? '');
      let base;
      if (CURRENCY[k]) base = CURRENCY[k];
      else if (k.startsWith('essence')) base = CURRENCY.essence;
      else if (k.startsWith('eldritch')) base = CURRENCY['eldritch-chaos'];
      else base = { name: k, short: k, color: '#aaa' };
      return { ...base, key: k };
    };
    const classified = (best.classified ?? []).map((m) => ({
      text: m.text,
      short: m.short,
      gen: m.gen,
      groups: m.groups ?? [],
      method: m.method,
      ofEssence: m.ofEssence,
      crafted: m.crafted,
      fractured: m.fractured,
      veiled: m.veiled,
      match: m.match?.id ? { id: m.match.id, source: m.match.source ?? null } : null,
      hitWeight: m.hitWeight,
      poolWeight: m.poolWeight,
      reqLevel: m.reqLevel,
      tags: m.tags,
      harvests: m.harvests,
      weight: m.weight,
      tier: m.tier,
    }));
    working = {
      ...plan,
      method: best.id,
      methodName: best.name,
      summary: planSummaryLine(
        { ...best, method: best.id, methodName: best.name },
        { totalCost: best.totalCost, minIlvl: result.minIlvl, methodName: best.name }
      ),
      rulesetVersion: rulesetVersion(),
      steps: best.steps.map((raw) => ({
        step: raw.step,
        currency: styleCurrency(raw.currency),
        action: raw.action,
        detail: raw.detail,
        targetMods: raw.targetMods ?? [],
        cost: raw.cost ?? {},
        operator: raw.operator,
        chance: raw.chance,
        chanceLabel: raw.chanceLabel,
        weightLine: raw.weightLine,
        fallback: raw.fallback,
        harvestOfficial: raw.harvestOfficial,
        preferEnabled: raw.preferEnabled,
        fractureSave: raw.fractureSave,
        stage: raw.stage,
        fallbacks: raw.fallbacks,
        recombMeta: raw.recombMeta,
      })),
      costs: best.costs,
      costBreakdown: best.costBreakdown ?? formatCostBreakdown(best.costs ?? {}, null),
      totalCost: best.totalCost,
      minIlvl: result.minIlvl,
      ilvlDrivers: result.drivers,
      baseTags: result.baseTags,
      classified,
      alternatives: (best.alternatives ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        totalCost: a.totalCost,
        costBreakdown: a.costBreakdown ?? [],
      })),
      tips: [
        `Recommended base ilvl ${result.minIlvl}+ (from mod required_level in knowledge base).`,
        ...(best.tips ?? []).slice(0, 4),
      ],
      preferFractureAvailable: true,
      preferFractureEnabled: preferFracture,
      methodComparison: best.methodComparison ?? null,
      priceStatus: best.priceStatus,
      pricesTip: best.pricesTip,
      modAnalysis: (best.classified ?? []).map((m) => ({
        text: m.text,
        matched: !!m.match?.matched,
        id: m.match?.id ?? null,
        kbSource: m.match?.source ?? null,
        kbText: m.match?.matched ? m.match?.text ?? null : null,
        min: m.match?.matched ? m.match?.min ?? m.match?.stats?.[0]?.min ?? null : null,
        max: m.match?.matched ? m.match?.max ?? m.match?.stats?.[0]?.max ?? null : null,
        type: m.gen,
        tier: m.match?.name,
        reqLevel: m.reqLevel,
        fractured: m.fractured,
        crafted: m.crafted,
        veiled: m.veiled,
        ofEssence: m.ofEssence,
        essence: m.essenceName,
        tags: m.match?.matched ? m.tags ?? m.match?.tags ?? [] : [],
        weight: m.weight,
        hitWeight: m.hitWeight,
        poolWeight: m.poolWeight,
        weightLine: m.weightLine,
        method: m.method,
        chance: m.chance,
        chanceLabel: m.weightLine
          ? m.weightLine
          : m.chance != null
            ? `${(m.chance * 100).toFixed(2)}%`
            : null,
        note: m.note,
        source: m.fractured
          ? 'fractured'
          : m.crafted
            ? 'crafted'
            : m.ofEssence
              ? 'essence'
              : m.veiled
                ? 'veiled'
                : m.match?.source === 'influence'
                  ? 'influence'
                  : m.match?.source === 'unveiled'
                    ? 'unveiled'
                    : m.method === 'harvest'
                      ? 'harvest'
                      : 'natural',
      })),
    };
  }

  const view = await replanFromProgress(item, working, hitKeys);
  return { ...view, plan: working };
}

/**
 * Lightweight progress replan: keep original steps, mark hits, and recalculate
 * remaining RNG steps (essence fish / harvest / eldritch) with occupied groups.
 */
export async function replanFromProgress(item, plan, hitKeySet) {
  const hitKeys = hitKeySet instanceof Set ? hitKeySet : new Set(hitKeySet ?? []);
  const classified = plan.classified ?? [];
  if (!classified.length || !hitKeys.size) {
    const annotated = annotatePlanHits(plan, hitKeys);
    return {
      ...annotated,
      steps: renumber(ensureFinalBenchSteps(classified.length ? classified : annotated.classified, annotated.steps)),
    };
  }

  const kb = await loadKnowledgeBase();
  const base = getBaseInfo(kb, item.baseName);
  const baseTags = plan.baseTags ?? effectiveBaseTags(item, base, kb.cannotRoll);
  const minIlvl = plan.minIlvl ?? Math.max(item.itemLevel ?? 1, 86);
  const occupied = occupiedFromHits(classified, hitKeys);
  // Essence guarantees always occupy their groups (locked present, not toggleable).
  for (const m of classified) {
    if (!(m.method === 'essence' || m.ofEssence) || isNonOccupyingAffix(m)) continue;
    for (const g of m.groups ?? []) occupied.add(g);
  }

  const steps = (plan.steps ?? []).map((s) => {
    const labels = s.targetMods ?? [];
    const targetMeta = labels.map((text, i) => {
      const mod = findClassifiedByLabel(classified, text);
      const key = mod ? modStableKey(mod) : modStableKey(text);
      const hit = labelHit(hitKeys, text, mod);
      const guaranteed =
        mod?.method === 'essence' ||
        (s.operator === 'essenceFish' && (i === 0 || !!mod?.ofEssence));
      return { text, key, hit, guaranteed: !!guaranteed, mod };
    });

    const remaining = targetMeta.filter((t) => !t.hit && !t.guaranteed);
    const allHit = labels.length > 0 && remaining.length === 0;

    if (s.operator === 'harvestFill' || (s.operator === 'exaltFallback' && s.harvestOfficial)) {
      // Crit fish "any of": harvest siblings = essence-fish secondaries ∪ harvest targets
      const ess = (plan.steps ?? []).find((x) => x.operator === 'essenceFish');
      const fishSiblings = (ess?.targetMods ?? []).slice(1); // skip essence guarantee
      const siblingLabels = [...new Set([...(s.targetMods ?? []), ...fishSiblings])];
      const siblingMeta = siblingLabels.map((text) => {
        const mod = findClassifiedByLabel(classified, text);
        const key = mod ? modStableKey(mod) : modStableKey(text);
        return {
          text,
          key,
          hit: labelHit(hitKeys, text, mod),
          guaranteed: false,
          mod,
        };
      });
      const remSiblings = siblingMeta.filter((t) => !t.hit);
      const allSibHit = siblingMeta.length > 0 && remSiblings.length === 0;
      return replanHarvestStep(
        s,
        remSiblings.length ? remSiblings : remaining,
        occupied,
        kb,
        baseTags,
        minIlvl,
        allSibHit,
        siblingMeta.length ? siblingMeta : targetMeta
      );
    }
    if (s.operator === 'essenceFish') {
      return replanEssenceFishStep(s, targetMeta, occupied, kb, baseTags, minIlvl, allHit);
    }
    if (s.operator === 'eldritchChaos') {
      return replanEldritchStep(s, remaining, occupied, kb, baseTags, minIlvl, allHit, targetMeta);
    }

    return {
      ...s,
      targetMeta,
      // Keep full target list for toggling on early steps; later steps filter below
      targetMods: labels,
      progressDone: allHit,
      chanceLabel: allHit ? 'hit ✓' : s.chanceLabel,
    };
  });

  // Keep every original step visible. Completed ones stay greyed (progressDone) with
  // full target lists so hits can be unchecked to undo. Bench always last.
  const viewSteps = steps.map((s) => {
    if (s.operator === 'bench') {
      const rem = (s.targetMeta ?? []).filter((t) => !t.hit);
      const done = (s.targetMeta ?? []).length > 0 && rem.length === 0;
      return {
        ...s,
        hideWhenDone: false,
        progressDone: done,
        targetMods: labelsFor(s),
        targetMeta: s.targetMeta ?? [],
        chanceLabel: done ? 'hit ✓' : s.chanceLabel,
      };
    }
    if (
      s.operator === 'harvestFill' ||
      s.operator === 'eldritchChaos' ||
      s.operator === 'unveil' ||
      s.operator === 'altSpam' ||
      s.operator === 'exaltFallback'
    ) {
      const meta = s.targetMeta ?? [];
      const rem = meta.filter((t) => !t.hit && !t.guaranteed);
      if (meta.length && !rem.length) {
        return {
          ...s,
          progressDone: true,
          hideWhenDone: false,
          targetMods: meta.map((t) => t.text),
          targetMeta: meta,
          chanceLabel: 'hit ✓',
        };
      }
    }
    return s;
  });

  const annotated = viewSteps;
  const finalSteps = renumber(ensureFinalBenchSteps(classified, annotated));
  // Keep summary EV in sync with replanned essence/harvest costs.
  const costs = {};
  for (const s of finalSteps) {
    if (s.progressDone) continue;
    for (const [k, n] of Object.entries(s.cost ?? {})) {
      if (!n) continue;
      costs[k] = (costs[k] ?? 0) + n;
    }
  }
  const totalCost = chaosCost(costs, kb.prices);
  return {
    ...plan,
    steps: finalSteps,
    costs,
    totalCost: totalCost ?? plan.totalCost,
    costBreakdown: totalCost != null ? formatCostBreakdown(costs, kb.prices) : plan.costBreakdown,
    summary: planSummaryLine(
      { ...plan, steps: finalSteps, totalCost: totalCost ?? plan.totalCost },
      { totalCost: totalCost ?? plan.totalCost, minIlvl: plan.minIlvl, methodName: plan.methodName }
    ),
    rulesetVersion: plan.rulesetVersion ?? rulesetVersion(),
  };
}

function labelsFor(s) {
  if (s.targetMods?.length) return s.targetMods;
  return (s.targetMeta ?? []).map((t) => t.text).filter(Boolean);
}

function annotatePlanHits(plan, hitKeys) {
  const classified = plan.classified ?? [];
  const steps = (plan.steps ?? []).map((s) => {
    const targetMeta = (s.targetMods ?? []).map((text, i) => {
      const mod = findClassifiedByLabel(classified, text);
      const key = mod ? modStableKey(mod) : modStableKey(text);
      const guaranteed =
        mod?.method === 'essence' ||
        (s.operator === 'essenceFish' && (i === 0 || !!mod?.ofEssence)) ||
        !!mod?.ofEssence;
      return {
        text,
        key,
        hit: labelHit(hitKeys, text, mod),
        guaranteed: !!guaranteed,
        softHit: false,
        mod,
      };
    });
    const need = targetMeta.filter((t) => !t.guaranteed);
    const done = need.length > 0 && need.every((t) => t.hit);
    return {
      ...s,
      targetMeta,
      progressDone: done,
      hideWhenDone: false,
      chanceLabel: done ? 'hit ✓' : s.chanceLabel,
    };
  });
  return { ...plan, steps: ensureFinalBenchSteps(classified, steps) };
}

function replanHarvestStep(s, remaining, occupied, kb, baseTags, minIlvl, allHit, targetMeta) {
  const fullMods = (targetMeta ?? []).map((t) => t.text);
  if (allHit || !remaining.length) {
    return {
      ...s,
      targetMeta,
      targetMods: fullMods,
      progressDone: true,
      hideWhenDone: false,
      chanceLabel: 'hit ✓',
      weightLine: '',
      detail: 'All harvest targets hit — skip this step.',
    };
  }

  const harvest =
    HARVEST_REFORGES.find((h) => h.id === s.harvestOfficial) ||
    HARVEST_REFORGES.find((h) => (s.action ?? '').includes(h.name));
  if (!harvest) {
    return {
      ...s,
      targetMeta,
      targetMods: fullMods,
      progressDone: false,
    };
  }

  // Occupied = hits on same generation as remaining goals (siblings already on item)
  const gen = remaining[0]?.mod?.gen;
  const sideOcc = new Set(occupied);
  for (const t of targetMeta) {
    if (!t.hit || !t.mod) continue;
    if (gen && t.mod.gen !== gen) continue;
    for (const g of t.mod.groups ?? []) sideOcc.add(g);
  }

  const chances = remaining.map((t) => {
    const m = t.mod;
    const o = harvestGoalOdds(kb, baseTags, minIlvl, m || { text: t.text }, harvest, modMatchesHarvest, sideOcc);
    return {
      t,
      p: clampRoll(o.pRoll),
      hitWeight: o.hitWeight,
      poolWeight: o.poolWeight,
      weightLine: formatWeight(o.hitWeight, o.poolWeight),
    };
  });
  let attempts = 0;
  for (const { p } of [...chances].sort((a, b) => a.p - b.p)) attempts += expectedAttemptsEv(p);
  attempts = Math.max(1, Math.min(attempts, 200));
  const bag = harvestWithMetacraftCost(harvest, attempts);
  const weightLine = chances.map((c) => `${c.t.text}: ${c.weightLine}`).join('; ');
  const metaMatch = (s.action ?? '').match(/^(.+?)\s*→/);
  const metaName = metaMatch?.[1]?.trim() || 'Metacraft';
  const juiceLine = Object.entries(harvestCostBag(harvest, 1))
    .map(([k, n]) => `${n} ${k.replace('-lifeforce', '')}`)
    .join('+');

  const pool = harvestEligiblePool(kb, baseTags, minIlvl, gen, harvest, modMatchesHarvest, sideOcc);
  const poolNote = formatEligiblePool(pool, harvest.name);

  return {
    ...s,
    targetMeta,
    targetMods: fullMods,
    progressDone: false,
    action: `${metaName} → ${harvest.name} ×~${attempts}`,
    detail: [
      `Protect finished mods with metacraft, then ${harvest.name}.`,
      `Remaining: ${remaining.map((t) => t.text).join('; ')}.`,
      sideOcc.size ? `Pool excludes ${sideOcc.size} occupied group(s).` : '',
      `Harvest-tagged pool weights (tier+higher): ${weightLine}.`,
      poolNote,
      `~${attempts}× (${juiceLine} lifeforce each) + ${bag.divine} Divines expected.`,
    ]
      .filter(Boolean)
      .join(' '),
    cost: bag,
    chance: chances[0]?.p ?? 0.1,
    chanceLabel: `~${attempts} · ${chances.map((c) => c.weightLine).join(' / ')}`,
    weightLine,
    harvestOfficial: harvest.id,
    eligiblePool: pool.rows,
    eligiblePoolTotal: pool.total,
  };
}

function replanEssenceFishStep(s, targetMeta, occupied, kb, baseTags, minIlvl, allHit) {
  const isGuarantee = (t) => t.guaranteed || t.mod?.method === 'essence';
  // Essence guarantee always occupies its groups once on this path (not toggleable).
  const occ = new Set(occupied);
  for (const t of targetMeta) {
    if (!isGuarantee(t) || !t.mod || isNonOccupyingAffix(t.mod)) continue;
    for (const g of t.mod.groups ?? []) occ.add(g);
  }

  if (allHit) {
    return {
      ...s,
      targetMeta,
      targetMods: targetMeta.map((t) => t.text),
      progressDone: true,
      chanceLabel: 'hit ✓',
    };
  }

  const fishSlots = targetMeta.filter((t) => !isGuarantee(t));
  const anyOf = /any of:/i.test(s.action ?? '') || /\bOR\b/.test(s.action ?? '');
  const fishHit = fishSlots.some((t) => t.hit);

  // Crit-style "any of": one fished sibling is enough — harvest covers the rest
  if (anyOf && fishHit) {
    return {
      ...s,
      targetMeta,
      targetMods: targetMeta.map((t) => t.text),
      progressDone: true,
      chanceLabel: 'fish done ✓',
      weightLine: '',
      detail: `${(s.detail ?? '').split('.')[0]}. Fish goal hit — continue to harvest/unveil for remaining mods.`,
    };
  }

  const fishGoals = fishSlots.filter((t) => !t.hit);
  const guarantor = targetMeta.find((t) => isGuarantee(t))?.mod;
  const EXTRA_ROLLS = essenceExtraRollsByGen(kb, guarantor?.gen || 'prefix');

  if (!fishGoals.length) {
    return {
      ...s,
      targetMeta,
      targetMods: targetMeta.map((t) => t.text),
      progressDone: true,
      chanceLabel: 'hit ✓',
      weightLine: '',
    };
  }

  const fishMods = fishGoals.map((t) => t.mod).filter(Boolean);
  if (!fishMods.length) {
    return { ...s, targetMeta, targetMods: targetMeta.map((t) => t.text), progressDone: false };
  }

  // Per-generation pools — never score suffix Str against the prefix pool.
  let fishMath = multiGenEssenceFishExpected(kb, baseTags, minIlvl, fishMods, EXTRA_ROLLS, occ);
  const zero = (fishMath?.goals ?? []).filter((g) => !(g.hitWeight > 0));
  if (zero.length) {
    const keep = fishMods.filter((m) => {
      const g = fishMath.goals.find((x) => x.short === m.short || x.short === short(m.text));
      return g && g.hitWeight > 0;
    });
    if (!keep.length) {
      return {
        ...s,
        targetMeta,
        targetMods: targetMeta.map((t) => t.text),
        progressDone: true,
        chanceLabel: 'guarantee only ✓',
        weightLine: '',
        detail: `${(s.detail ?? '').split('.')[0]}. Remaining fish goals have hit weight 0 (blocked/unmatched) — essence guarantee only.`,
        cost: { [Object.keys(s.cost ?? {}).find((k) => k.startsWith('essence')) || 'essence-deafening']: 2 },
      };
    }
    fishMath = multiGenEssenceFishExpected(kb, baseTags, minIlvl, keep, EXTRA_ROLLS, occ);
  }
  const useAny = anyOf || /any of:/i.test(s.action ?? '');
  const positiveGoals = (fishMath?.goals ?? []).filter((g) => (g.hitWeight ?? 0) > 0);
  if (!positiveGoals.length) {
    return {
      ...s,
      targetMeta,
      targetMods: targetMeta.map((t) => t.text),
      progressDone: true,
      chanceLabel: 'guarantee only ✓',
      weightLine: '',
      detail: `${(s.detail ?? '').split('.')[0]}. No positive-weight fish goals left.`,
      cost: { [Object.keys(s.cost ?? {}).find((k) => k.startsWith('essence')) || 'essence-deafening']: 2 },
    };
  }
  const easiest = [...positiveGoals].sort((a, b) => (b.hitWeight ?? b.weight) - (a.hitWeight ?? a.weight))[0];
  const fishP = useAny || positiveGoals.length === 1 ? easiest?.pHave ?? fishMath.pAll : fishMath.pAll;
  const attempts = Math.min(Math.max(expectedAttemptsEv(fishP), 1), 5000);
  const weightDetail = positiveGoals
    .map((g) => `${g.short}: ${formatWeight(g.hitWeight ?? g.weight, g.poolWeight ?? g.pool)} tier+higher`)
    .join('; ');
  const weightLine = `pool · ${weightDetail}`;
  const essKey = Object.keys(s.cost ?? {}).find((k) => k.startsWith('essence')) || 'essence-deafening';
  const needLabel = anyOf
    ? fishGoals.map((t) => t.text).join(' OR ')
    : fishGoals.map((t) => t.text).join(' + ');

  return {
    ...s,
    targetMeta,
    targetMods: targetMeta.map((t) => t.text),
    progressDone: false,
    cost: { [essKey]: attempts },
    chance: fishP,
    chanceLabel: `~${formatAttempts(attempts)} ess · ${pct(fishP)}/hit · still need: ${needLabel}`,
    weightLine,
    weightMath: fishMath,
    detail: [
      (s.detail ?? '').split('.')[0] + '.',
      `Still missing: ${needLabel}.`,
      occ.size ? `Occupied groups excluded from pool.` : '',
      weightDetail,
      zero.length ? `Skipped zero-weight: ${zero.map((g) => g.short).join(', ')}.` : '',
      `Expected ~${formatAttempts(attempts)} essences (${pct(fishP)} per essence).`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function replanEldritchStep(s, remaining, occupied, kb, baseTags, minIlvl, allHit, targetMeta) {
  const fullMods = (targetMeta ?? []).map((t) => t.text);
  if (allHit || !remaining.length) {
    return {
      ...s,
      targetMeta,
      targetMods: fullMods,
      progressDone: true,
      hideWhenDone: false,
      chanceLabel: 'hit ✓',
    };
  }
  const mods = remaining.map((t) => t.mod).filter(Boolean);
  if (!mods.length) {
    return { ...s, targetMeta, targetMods: fullMods };
  }
  const gen = mods[0].gen || 'suffix';
  const withOcc = essenceFishExpected(kb, baseTags, minIlvl, gen, mods, Math.max(3, mods.length), occupied);
  const attempts = Math.max(expectedAttemptsEv(withOcc.pAll), 1);
  const weightSummary = withOcc.weightSummary;
  return {
    ...s,
    targetMeta,
    targetMods: fullMods,
    progressDone: false,
    action: s.action.replace(/×~\d+/, `×~${attempts}`),
    cost: { ...(s.cost ?? {}), 'eldritch-chaos': attempts },
    chance: withOcc.pAll,
    chanceLabel: `~${attempts} Eldritch Chaos · ${pct(withOcc.pAll)}/hit · ${weightSummary}`,
    weightLine: `pool ${withOcc.pool} · ${weightSummary}`,
    detail: [
      `Remaining: ${remaining.map((t) => t.text).join('; ')}.`,
      `Pool ${withOcc.pool}. Weights: ${weightSummary}.`,
      `P(all) ≈ ${pct(withOcc.pAll)} → ~${attempts} expected.`,
    ].join(' '),
  };
}
