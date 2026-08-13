/**
 * Crafting-state representation. Mechanical properties only.
 * Desired / filler / salvage live in the solver, not here.
 */

export function affixKey(a) {
  if (a?.id) return `id:${a.id}`;
  const t = String(a?.text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return `t:${a?.gen ?? '?'}:${t}`;
}

export function makeAffix(raw) {
  const groups = [...new Set(raw.groups ?? raw.modGroups ?? [])].sort();
  return {
    id: raw.id ?? null,
    text: raw.text ?? raw.short ?? '',
    gen: raw.gen === 'suffix' ? 'suffix' : 'prefix',
    groups,
    tags: raw.tags ?? [],
    tier: raw.tier ?? null,
    spawnWeight: raw.spawnWeight ?? raw.hitWeight ?? raw.weight ?? 0,
    fractured: !!raw.fractured,
    crafted: !!raw.crafted,
    veiled: !!raw.veiled,
    ofEssence: !!raw.ofEssence,
    essenceOnly: !!raw.essenceOnly,
    source: raw.source ?? (raw.crafted ? 'crafted' : raw.veiled ? 'unveiled' : 'natural'),
    influence: raw.influence ?? null,
    canNaturallyRoll: raw.canNaturallyRoll !== false && !raw.crafted && !raw.veiled && !raw.essenceOnly,
    exclusive: raw.exclusive,
  };
}

export function makeState(raw) {
  const prefixes = (raw.prefixes ?? []).map(makeAffix);
  const suffixes = (raw.suffixes ?? []).map(makeAffix);
  return {
    itemClass: raw.itemClass ?? '',
    baseType: raw.baseType ?? raw.baseName ?? '',
    itemLevel: raw.itemLevel ?? 1,
    rarity: raw.rarity ?? inferRarity(prefixes.length, suffixes.length),
    prefixes,
    suffixes,
    influence: [...(raw.influence ?? raw.influenced ?? [])].map(String).sort(),
    fracturedItem: !!(raw.fracturedItem || prefixes.some((a) => a.fractured) || suffixes.some((a) => a.fractured)),
    corrupted: !!raw.corrupted,
    mirrored: !!raw.mirrored,
    metacrafts: [...(raw.metacrafts ?? [])].sort(),
    eldritchDominance: raw.eldritchDominance ?? null,
    baseTags: [...(raw.baseTags ?? [])],
  };
}

export function cloneState(state) {
  return {
    ...state,
    prefixes: [...(state.prefixes ?? [])],
    suffixes: [...(state.suffixes ?? [])],
    influence: [...(state.influence ?? [])],
    metacrafts: [...(state.metacrafts ?? [])],
    baseTags: [...(state.baseTags ?? [])],
  };
}

export function inferRarity(nP, nS) {
  if (nP + nS === 0) return 'Normal';
  if (nP <= 1 && nS <= 1) return 'Magic';
  return 'Rare';
}

export function allAffixes(state) {
  return [...(state.prefixes ?? []), ...(state.suffixes ?? [])];
}

export function stateHash(state) {
  const inf = (state.influence ?? []).join(',');
  const side = (list) =>
    list
      .map((a) => `${affixKey(a)}:${a.fractured ? 'F' : ''}${a.crafted ? 'C' : ''}`)
      .sort()
      .join(';');
  return [
    state.itemClass,
    state.baseType,
    state.itemLevel,
    inf,
    state.fracturedItem ? 'frac' : '',
    (state.metacrafts ?? []).join(','),
    state.eldritchDominance ?? '',
    `p:${side(state.prefixes ?? [])}`,
    `s:${side(state.suffixes ?? [])}`,
  ].join('|');
}

export const stateKey = stateHash;

export function statesEquivalent(a, b) {
  return (
    a.itemClass === b.itemClass &&
    a.baseType === b.baseType &&
    a.fracturedItem === b.fracturedItem &&
    (a.influence ?? []).join() === (b.influence ?? []).join()
  );
}

export function isExclusiveAffix(a) {
  if (a.exclusive === true) return true;
  if (a.exclusive === false) return false;
  if (a.crafted || a.veiled) return true;
  if (a.essenceOnly) return true;
  if (a.ofEssence && !a.canNaturallyRoll) return true;
  if (a.source === 'delve' || a.source === 'incursion' || a.source === 'unveiled') return true;
  return false;
}

/** Mechanical: cannot naturally appear on this output base (GGG 3.26 examples + NNN). */
export function cannotNormallyRollOn(affix, output) {
  if (!affixEligibleOnBase(affix, output)) return true;
  if (affix.crafted || affix.veiled || affix.essenceOnly) return true;
  if (affix.ofEssence && !affix.canNaturallyRoll) return true;
  if (affix.source === 'delve' || affix.source === 'incursion' || affix.source === 'unveiled') return true;
  if (affix.canNaturallyRoll === false) return true;
  return false;
}

export function affixEligibleOnBase(affix, output) {
  if (affix.fractured && !output.fracturedItem) return false;
  if (affix.influence) {
    const has = (output.influence ?? []).some((i) => i.toLowerCase() === String(affix.influence).toLowerCase());
    if (!has) return false;
  }
  if (affix.source === 'influence' && !(output.influence ?? []).length) return false;
  if (affix.canNaturallyRoll === false && affix.source === 'natural') return false;
  return true;
}

export function sharesGroup(a, b) {
  if (!a.groups?.length || !b.groups?.length) return affixKey(a) === affixKey(b);
  for (const g of a.groups) if (b.groups.includes(g)) return true;
  return false;
}

export function mergeOutcomeDist(outcomes, minP = 1e-8) {
  const map = new Map();
  for (const o of outcomes) {
    if (o.p < minP) continue;
    const h = stateHash(o.state);
    const prev = map.get(h);
    if (prev) prev.p += o.p;
    else map.set(h, { state: o.state, p: o.p });
  }
  const list = [...map.values()];
  const z = list.reduce((s, o) => s + o.p, 0);
  if (z > 0 && Math.abs(z - 1) > 1e-6) for (const o of list) o.p /= z;
  list.sort((a, b) => b.p - a.p);
  return list;
}
