let indexPromise = null;

export function loadCraftIndex() {
  if (!indexPromise) {
    indexPromise = fetch('/data/craft-index.json').then((r) => {
      if (!r.ok) throw new Error('Craft data not found. Run npm run build:data');
      return r.json();
    });
  }
  return indexPromise;
}

/** Node/test helper */
export function loadCraftIndexFrom(data) {
  indexPromise = Promise.resolve(data);
  return indexPromise;
}

export function getBaseTags(index, baseName) {
  const base = index.baseByName[baseName];
  return base?.tags ?? ['default'];
}

export function getItemClass(index, baseName) {
  const base = index.baseByName[baseName];
  return base?.itemClass ?? null;
}

function extractNumbers(text) {
  return [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
}

function patternMatch(pattern, text) {
  const parts = pattern.split('|');
  const lines = text.split('\n');
  // Match first line if multi-line crafted hybrid
  const useLines = parts.length === 1 ? [lines[0]] : lines;
  const useParts = parts.length === 1 ? parts : parts;

  if (useParts.length !== useLines.length && useParts.length > 1) {
    // try first line only
    return patternMatchSingle(useParts[0], lines[0]);
  }

  for (let i = 0; i < useParts.length; i++) {
    if (!patternMatchSingle(useParts[i] ?? useParts[0], useLines[i] ?? useLines[0])) return false;
  }
  return true;
}

function patternMatchSingle(p, line) {
  const regex = new RegExp(
    '^' +
      p
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\#/g, '__NUM__')
        .replace(/#/g, '(\\+?\\d+(?:\\.\\d+)?)')
        .replace(/__NUM__/g, '#') +
      '$',
    'i'
  );
  return regex.test((line ?? '').trim());
}

function modWeightOnItem(mod, tags, ilvl, influence) {
  if (mod.reqLevel > ilvl) return 0;
  let total = 0;
  const infList = Array.isArray(influence) ? influence : influence ? [influence] : [];

  for (const [tag, weight] of Object.entries(mod.weights ?? {})) {
    if (tags.includes(tag)) total += weight;
    for (const inf of infList) {
      const key = inf.toLowerCase();
      const mapped =
        { shaper: 'shaper', elder: 'elder', crusader: 'crusader', hunter: 'basilisk', redeemer: 'eyrie', warlord: 'adjudicator' }[
          key
        ] ?? key;
      if (tag.includes(mapped)) total += weight;
    }
  }
  // default tag catch-all
  if (total === 0 && mod.weights?.default > 0 && tags.includes('default')) {
    total = mod.weights.default;
  }
  // Many life mods only have default weight — count if any base tag matches OR default
  if (total === 0 && mod.weights?.default > 0) {
    total = mod.weights.default;
  }
  return total;
}

function modAppliesToItem(mod, tags, ilvl, influence) {
  if (mod.reqLevel > ilvl) return false;
  return modWeightOnItem(mod, tags, ilvl, influence) > 0;
}

export function matchMod(index, modText, item) {
  const tags = getBaseTags(index, item.baseName);
  const ilvl = item.itemLevel ?? 83;
  const nums = extractNumbers(modText);
  const primaryVal = nums[0] ?? null;
  const itemClass = item.itemClass?.replace(/s$/, '') || getItemClass(index, item.baseName);

  let best = null;
  for (const mod of index.mods) {
    if (!patternMatch(mod.pattern, modText)) continue;
    if (primaryVal != null && mod.min != null && mod.max != null) {
      if (primaryVal < mod.min - 1 || primaryVal > mod.max + 1) continue;
    }
    if (!modAppliesToItem(mod, tags, ilvl, item.influenced)) continue;

    const score = modWeightOnItem(mod, tags, ilvl, item.influenced);
    if (!best || score > best.weight) best = { ...mod, weight: score };
  }

  // Also try essence-only mods for of-the-essence text matches
  if (!best) {
    for (const mod of index.mods) {
      if (!mod.essenceOnly) continue;
      if (!patternMatch(mod.pattern, modText)) continue;
      if (primaryVal != null && mod.min != null && mod.max != null) {
        if (primaryVal < mod.min - 1 || primaryVal > mod.max + 1) continue;
      }
      best = { ...mod, weight: mod.weight ?? 100 };
      break;
    }
  }

  if (!best) {
    return {
      text: modText,
      matched: false,
      gen: null,
      groups: [],
      tags: [],
      weight: 100,
      essenceOnly: false,
      influence: [],
      essences: [],
    };
  }

  let essences = index.essences.filter(
    (e) =>
      e.modId === best.id &&
      (e.itemClass === item.itemClass ||
        e.itemClass === itemClass ||
        e.itemClass === getItemClass(index, item.baseName) ||
        // Wands vs Wand
        e.itemClass + 's' === item.itemClass ||
        e.itemClass === item.itemClass?.replace(/s$/, ''))
  );

  // Broader essence lookup by scanning all essences whose mod matches text
  if (!essences.length) {
    const byMod = index.essences.filter((e) => e.modId === best.id);
    essences = byMod;
  }

  return {
    text: modText,
    matched: true,
    id: best.id,
    gen: best.gen,
    groups: best.groups,
    tags: best.tags ?? [],
    weight: best.weight,
    reqLevel: best.reqLevel ?? 1,
    essenceOnly: best.essenceOnly,
    influence: best.influence,
    tierName: best.name,
    essences: essences.sort((a, b) => b.level - a.level),
    benchCraft: false,
  };
}

export function enrichItemMods(index, item) {
  const tags = getBaseTags(index, item.baseName);

  const enrich = (mod) => {
    const meta = matchMod(index, mod.text, item);
    const gen = mod.gen ?? meta.gen ?? mod.type;
    return {
      ...mod,
      gen,
      type: gen,
      tags: [...new Set([...(mod.tags ?? []), ...(meta.tags ?? []), ...(meta.groups ?? [])])],
      meta,
    };
  };

  const enrichedMods = item.explicitMods.filter((m) => !m.crafted).map(enrich);
  const enrichedCrafted = item.explicitMods.filter((m) => m.crafted).map(enrich);

  const inferredInfluence = [
    ...new Set([
      ...(item.influenced ?? []),
      ...enrichedMods.flatMap((m) => m.meta.influence ?? []),
    ]),
  ];

  return {
    ...item,
    tags,
    influenced: inferredInfluence,
    enrichedMods,
    enrichedCrafted,
  };
}

export function getPoolWeights(index, tags, ilvl, influence, blockedGroups = [], genType = null) {
  let prefixTotal = 0;
  let suffixTotal = 0;

  for (const mod of index.mods) {
    if (blockedGroups.some((g) => mod.groups.includes(g))) continue;
    if (genType && mod.gen !== genType) continue;
    const w = modWeightOnItem(mod, tags, ilvl, influence);
    if (w <= 0) continue;
    if (mod.gen === 'prefix') prefixTotal += w;
    else suffixTotal += w;
  }

  return { prefixTotal, suffixTotal, total: prefixTotal + suffixTotal };
}

export { modWeightOnItem, extractNumbers };
