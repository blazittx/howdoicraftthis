import {
  loadKnowledgeBase,
  matchModInKnowledge,
  getBaseInfo,
  itemArtUrl,
  effectiveBaseTags,
  resolveCannotRoll,
} from './knowledgeLoader.js';
import { planCraft, formatCostBreakdown } from './sideCompletionPlanner.js';

export const CURRENCY = {
  transmute: { name: 'Orb of Transmutation', short: 'Transmute', color: '#7eb8da' },
  alteration: { name: 'Orb of Alteration', short: 'Alteration', color: '#7eb8da' },
  augmentation: { name: 'Orb of Augmentation', short: 'Augmentation', color: '#7eb8da' },
  regal: { name: 'Regal Orb', short: 'Regal', color: '#d4af37' },
  exalt: { name: 'Exalted Orb', short: 'Exalt', color: '#d4af37' },
  annul: { name: 'Orb of Annulment', short: 'Annul', color: '#c9a0dc' },
  scour: { name: 'Orb of Scouring', short: 'Scour', color: '#aaa' },
  alchemy: { name: 'Orb of Alchemy', short: 'Alch', color: '#d4af37' },
  divine: { name: 'Divine Orb', short: 'Divine', color: '#ff9f43' },
  quality: { name: 'Base', short: 'Base', color: '#aaa' },
  bench: { name: 'Crafting Bench', short: 'Bench', color: '#6fcf97' },
  essence: { name: 'Essence', short: 'Essence', color: '#56ccf2' },
  harvest: { name: 'Harvest', short: 'Harvest', color: '#6fcf97' },
  'wild-lifeforce': { name: 'Wild Crystallised Lifeforce', short: 'Wild LF', color: '#c4a35a' },
  'vivid-lifeforce': { name: 'Vivid Crystallised Lifeforce', short: 'Vivid LF', color: '#6fcf97' },
  'primal-lifeforce': { name: 'Primal Crystallised Lifeforce', short: 'Primal LF', color: '#7eb8da' },
  'sacred-lifeforce': { name: 'Sacred Crystallised Lifeforce', short: 'Sacred LF', color: '#d4af37' },
  veiled: { name: 'Veiled Exalt', short: 'Veiled', color: '#c9a0dc' },
  'veiled-chaos': { name: 'Veiled Chaos', short: 'Veiled Chaos', color: '#c9a0dc' },
  fossil: { name: 'Fossil', short: 'Fossil', color: '#c4a35a' },
  'eldritch-chaos': { name: 'Eldritch Chaos Orb', short: 'Eldritch Chaos', color: '#e8a838' },
  'eldritch-annul': { name: 'Eldritch Annulment', short: 'Eldritch Annul', color: '#e8a838' },
  'eldritch-exalt': { name: 'Eldritch Exalt', short: 'Eldritch Exalt', color: '#e8a838' },
  'eldritch-ichor': { name: 'Eldritch Ichor', short: 'Ichor', color: '#7eb8da' },
  'eldritch-ember': { name: 'Eldritch Ember', short: 'Ember', color: '#e07a3d' },
  'warlord-exalt': { name: "Warlord's Exalted Orb", short: "Warlord's Exalt", color: '#c9a227' },
  'redeemer-exalt': { name: "Redeemer's Exalted Orb", short: "Redeemer's Exalt", color: '#6b9bd1' },
  'crusader-exalt': { name: "Crusader's Exalted Orb", short: "Crusader's Exalt", color: '#d4a84b' },
  'hunter-exalt': { name: "Hunter's Exalted Orb", short: "Hunter's Exalt", color: '#6fcf97' },
  'shaper-exalt': { name: "Shaper's Exalted Orb", short: "Shaper's Exalt", color: '#9b59b6' },
  'elder-exalt': { name: "Elder's Exalted Orb", short: "Elder's Exalt", color: '#8e44ad' },
  chaos: { name: 'Chaos Orb', short: 'Chaos', color: '#d4af37' },
};

function styleCurrency(key) {
  const k = String(key ?? '');
  let base;
  if (CURRENCY[k]) base = CURRENCY[k];
  else if (k.startsWith('essence')) base = CURRENCY.essence;
  else if (k.startsWith('eldritch')) base = CURRENCY['eldritch-chaos'];
  else if (k.endsWith('-lifeforce')) base = CURRENCY.harvest;
  else if (k.startsWith('fossil')) base = CURRENCY.fossil;
  else if (k.endsWith('-exalt')) base = CURRENCY.exalt;
  else base = { name: k, short: k, color: '#aaa' };
  return { ...base, key: k };
}

function toStep(raw) {
  return {
    step: raw.step,
    currency: styleCurrency(raw.currency),
    action: raw.action,
    detail: raw.detail,
    targetMods: raw.targetMods ?? [],
    targetMeta: raw.targetMeta,
    cost: raw.cost ?? {},
    operator: raw.operator,
    chance: raw.chance,
    chanceLabel: raw.chanceLabel,
    weightLine: raw.weightLine,
    fallback: raw.fallback,
    harvestOfficial: raw.harvestOfficial,
    hideWhenDone: raw.hideWhenDone,
    progressDone: raw.progressDone,
    preferEnabled: raw.preferEnabled,
    fractureSave: raw.fractureSave,
  };
}

export async function generateCraftSteps(item, onProgress, opts = {}) {
  onProgress?.({ phase: 'loading-knowledge' });
  const kb = await loadKnowledgeBase();
  const base = getBaseInfo(kb, item.baseName);
  // Magic names / fuzzy base resolve — keep planner + art on the real base
  if (base?.name && base.name !== item.baseName) {
    item = { ...item, baseName: base.name };
  }
  const art = itemArtUrl(base, item.influenced ?? []);
  const artUrl = art?.url ?? null;
  const artFallbackUrl = art?.fallbackUrl ?? null;
  const artFlags = art?.flags ?? {};
  const artGlow = !!art?.glow;

  if (item.rarity === 'Unique') {
    return {
      method: 'unique',
      methodName: 'Unique',
      summary: 'Unique items are obtained from drops, divination cards, or chance — not crafted with this pipeline.',
      artUrl,
      artFallbackUrl,
      artFlags,
      artGlow,
      steps: [
        toStep({
          step: 1,
          currency: 'alchemy',
          action: 'Obtain via drop or trade',
          detail: 'Uniques are not target-craftable with standard rare crafting.',
          targetMods: [],
          cost: {},
        }),
      ],
      costs: {},
      costBreakdown: [],
      totalCost: 0,
      alternatives: [],
      modAnalysis: [],
      tips: ['Buy from trade unless you enjoy gambling chance orbs.'],
    };
  }

  // Attach base tags/class for planner matching
  const craftedRaw = [
    ...(item.craftedMods ?? []),
    ...(item.crafted ?? []),
    ...(item.explicitMods ?? []).filter((m) => (typeof m === 'object' ? m.crafted : false)),
  ];
  // Dedupe by text — parser puts crafts in explicitMods and also exposes .crafted
  const seenCraft = new Set();
  const craftedList = [];
  for (const m of craftedRaw) {
    const raw = typeof m === 'string' ? { text: m, crafted: true } : { ...m, crafted: true };
    const key = raw.text;
    if (seenCraft.has(key)) continue;
    seenCraft.add(key);
    craftedList.push(raw);
  }
  const naturalExplicit = (item.explicitMods ?? []).filter((m) => {
    const raw = typeof m === 'string' ? { text: m } : m;
    return !raw.crafted && !seenCraft.has(raw.text);
  });

  const enrichedItem = {
    ...item,
    tags: effectiveBaseTags(item, base, kb.cannotRoll),
    cannotRoll: resolveCannotRoll(item, base, kb.cannotRoll),
    itemClass: base?.item_class ?? item.itemClass,
    enrichedMods: naturalExplicit.map((m) => {
      const raw = typeof m === 'string' ? { text: m } : m;
      const hints = {
        crafted: false,
        ofEssence: !!raw.ofEssence,
        veiled: !!raw.veiled,
        fractured: !!raw.fractured,
        name: raw.name || null,
      };
      const match = matchModInKnowledge(
        kb,
        raw.text,
        { ...item, itemClass: base?.item_class ?? item.itemClass },
        hints
      );
      return {
        ...raw,
        text: raw.text,
        meta: {
          matched: match.matched,
          gen: match.generation,
          weight: match.weight,
          reqLevel: match.required_level,
          groups: match.groups,
          essences: match.essences,
          influence: match.source === 'influence',
        },
        gen: match.generation ?? raw.type ?? raw.gen,
        tags: match.tags ?? raw.tags,
        ofEssence: raw.ofEssence || match.source === 'essence_only',
        crafted: false,
        veiled: raw.veiled || match.source === 'unveiled',
      };
    }),
    enrichedCrafted: craftedList.map((raw) => {
      const match = matchModInKnowledge(kb, raw.text, item, { crafted: true });
      const pasteGen = raw.gen === 'prefix' || raw.gen === 'suffix' ? raw.gen : null;
      const matchGen =
        match.generation === 'prefix' || match.generation === 'suffix' ? match.generation : null;
      return {
        ...raw,
        crafted: true,
        gen: pasteGen || matchGen || raw.type || 'prefix',
        tags: match.tags ?? raw.tags,
        meta: { matched: true, reqLevel: match.required_level, gen: pasteGen || matchGen },
      };
    }),
  };

  onProgress?.({ phase: 'planning' });
  const { best, alternatives, minIlvl, drivers, classified, coverage, baseTags } = await planCraft(
    enrichedItem,
    null,
    onProgress,
    opts
  );

  const unmatched = (classified ?? []).filter((m) => !m.match?.matched && m.method !== 'bench');

  const modAnalysis = (classified ?? []).map((m) => ({
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
    essence: m.essenceName ?? m.essences?.[0]?.name,
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
  }));

  // Attach KB tags for implicits / enchants (display only — never skip when text matches an explicit)
  for (const raw of [
    ...(item.enchants ?? []).map((m) => ({ ...(typeof m === 'string' ? { text: m } : m), enchant: true })),
    ...(item.implicits ?? []).map((m) => ({ ...(typeof m === 'string' ? { text: m } : m), implicit: true })),
  ]) {
    if (!raw.text) continue;
    const match = matchModInKnowledge(
      kb,
      raw.text,
      { ...item, itemClass: base?.item_class ?? item.itemClass },
      raw.enchant ? { enchant: true } : { implicit: true }
    );
    modAnalysis.push({
      text: raw.text,
      matched: !!match.matched,
      id: match.id ?? null,
      kbSource: match.source ?? null,
      kbText: match.matched ? match.text ?? null : null,
      min: match.matched ? match.min ?? match.stats?.[0]?.min ?? null : null,
      max: match.matched ? match.max ?? match.stats?.[0]?.max ?? null : null,
      type: raw.enchant ? 'enchant' : 'implicit',
      method: raw.enchant ? 'enchant' : 'implicit',
      tags: match.matched ? match.tags ?? [] : [],
      enchant: !!raw.enchant,
      implicit: !raw.enchant,
      source: raw.enchant ? 'enchant' : match.source === 'eldritch' ? 'eldritch' : 'implicit',
    });
  }

  return {
    method: best.id,
    methodName: best.name,
    summary:
      best.totalCost == null
        ? `Deterministic plan: ${best.name} — cost unknown (min base ilvl ${minIlvl}). Run npm run fetch-prices.`
        : `Deterministic plan: ${best.name} — ~${best.totalCost}c expected (min base ilvl ${minIlvl})`,
    artUrl,
    artFallbackUrl,
    artFlags,
    artGlow,
    steps: best.steps.map(toStep),
    costs: best.costs,
    costBreakdown: best.costBreakdown ?? formatCostBreakdown(best.costs, kb.prices),
    totalCost: best.totalCost,
    minIlvl,
    ilvlDrivers: drivers,
    baseTags,
    classified: (classified ?? []).map((m) => ({
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
    })),
    alternatives: (alternatives ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      totalCost: a.totalCost,
      costBreakdown: a.costBreakdown ?? formatCostBreakdown(a.costs ?? {}, kb.prices),
    })),
    modAnalysis,
    priceStatus: best.priceStatus ?? kb.priceStatus,
    pricesTip: best.pricesTip ?? kb.pricesTip,
    tips: [
      `Recommended base ilvl ${minIlvl}+ (from mod required_level in knowledge base${drivers?.[0] ? `: ${drivers[0].text}` : ''}).`,
      ...(best.tips ?? []).slice(0, 5),
      ...(unmatched.length ? [`${unmatched.length} mod(s) not matched in knowledge base — those steps are approximate.`] : []),
      ...(coverage?.missing_or_partial?.length
        ? [`KB gaps (not used): ${coverage.missing_or_partial.slice(0, 3).join('; ')}.`]
        : []),
    ],
    preferFractureAvailable: !!best.preferFractureAvailable,
    preferFractureEnabled:
      best.preferFractureEnabled == null ? opts.preferFracture !== false : best.preferFractureEnabled,
  };
}
