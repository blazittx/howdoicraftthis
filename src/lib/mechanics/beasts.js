/**
 * Beastcraft: Add Prefix Remove Suffix, Add Suffix Remove Prefix, Split.
 * Metamods respected for remove/add sides.
 */
import { cloneState, makeAffix, allAffixes } from '../craftState.js';
import { getEligibleMods, collectOccupiedGroups } from '../spawnWeights.js';
import { getRuleset } from '../ruleset.js';
import { normalizeOutcomes } from './prob.js';
import { side, setSide, openSlot, hasInfluence } from './common.js';
import { beastRemove } from './remove.js';
import { benchBlockedTags } from './blockers.js';

export function beastRecipes(kb) {
  return kb?.beastcraft?.recipes ?? [];
}

export function findBeastRecipe(kb, id) {
  return beastRecipes(kb).find((r) => r.id === id || r.kind === id);
}

function addFromPool(state, kb, gen, costExtra = {}) {
  if (!openSlot(state, gen)) {
    return { outcomes: [], cost: costExtra, illegal: `no open ${gen}` };
  }
  const occupied = collectOccupiedGroups(allAffixes(state));
  const { rows: allRows, total: allTotal } = getEligibleMods(kb, state, {
    generation: gen,
    method: 'beast',
    occupiedGroups: occupied,
    forbiddenTags: benchBlockedTags(state, kb),
    rules: getRuleset(),
  });
  if (!(allTotal > 0)) return { outcomes: [], cost: costExtra, illegal: `empty ${gen} pool` };
  const rows = allRows.slice(0, 24);
  const t = rows.reduce((s, r) => s + r.weight, 0);
  return {
    outcomes: normalizeOutcomes(
      rows.map((r) => ({
        state: setSide(state, gen, [...side(state, gen), makeAffix({ ...r, gen })]),
        p: r.weight / t,
      }))
    ),
    cost: { beast: 1, ...costExtra },
  };
}

/** Farric Wolf Alpha: remove random suffix, add prefix. */
export function beastAddPrefixRemoveSuffix(state, kb, opts = {}) {
  if (String(state.rarity ?? 'Rare') !== 'Rare' && (state.prefixes?.length ?? 0) + (state.suffixes?.length ?? 0) > 2) {
    // still allow rare-like
  }
  if (!openSlot(state, 'prefix')) {
    return { outcomes: [], cost: {}, illegal: 'beast AddP/RemS requires open prefix' };
  }
  const rem = beastRemove(state, 'suffix');
  if (rem.illegal) return rem;
  const outcomes = [];
  for (const o of rem.outcomes) {
    const add = addFromPool(o.state, kb, 'prefix');
    if (add.illegal) continue;
    for (const a of add.outcomes) outcomes.push({ state: a.state, p: o.p * a.p });
  }
  if (!outcomes.length) return { outcomes: [], cost: {}, illegal: 'beast AddP/RemS produced no outcomes' };
  return { outcomes: normalizeOutcomes(outcomes), cost: { beast: 1, 'farric-wolf-alpha': 1 } };
}

/** Farric Lynx Alpha: remove random prefix, add suffix. */
export function beastAddSuffixRemovePrefix(state, kb, opts = {}) {
  if (!openSlot(state, 'suffix')) {
    return { outcomes: [], cost: {}, illegal: 'beast AddS/RemP requires open suffix' };
  }
  const rem = beastRemove(state, 'prefix');
  if (rem.illegal) return rem;
  const outcomes = [];
  for (const o of rem.outcomes) {
    const add = addFromPool(o.state, kb, 'suffix');
    if (add.illegal) continue;
    for (const a of add.outcomes) outcomes.push({ state: a.state, p: o.p * a.p });
  }
  if (!outcomes.length) return { outcomes: [], cost: {}, illegal: 'beast AddS/RemP produced no outcomes' };
  return { outcomes: normalizeOutcomes(outcomes), cost: { beast: 1, 'farric-lynx-alpha': 1 } };
}

/**
 * Split rare into `parts` items. Mods partitioned; each part gets Split flag.
 * parts=2: half each (even split of affix list). parts=3: requires 6 mods → 2 each.
 */
export function beastSplit(state, kb, opts = {}) {
  const parts = opts.parts ?? 2;
  if (hasInfluence(state)) return { outcomes: [], cost: {}, illegal: 'cannot split influenced' };
  if (state.split) return { outcomes: [], cost: {}, illegal: 'already split' };
  const mods = allAffixes(state).filter((a) => !a.crafted);
  if (parts === 3 && mods.length !== 6) {
    return { outcomes: [], cost: {}, illegal: 'split-three requires exactly 6 mods' };
  }
  if (mods.length < parts) {
    return { outcomes: [], cost: {}, illegal: 'not enough mods to split' };
  }

  const cost =
    parts === 3
      ? { beast: 1, 'fenumal-plagued-arachnid': 1, 'black-morrigan': 1 }
      : { beast: 1, 'fenumal-plagued-arachnid': 1 };

  // Enumerate partitions of mods into `parts` unlabeled buckets of equal size when possible
  const size = Math.floor(mods.length / parts);
  const outcomes = [];
  const partitions = partitionEqual(mods, parts, size);
  if (!partitions.length) {
    return { outcomes: [], cost, illegal: 'no legal split partition' };
  }
  const p = 1 / partitions.length;
  for (const buckets of partitions) {
    const items = buckets.map((bucket) => {
      const next = cloneState(state);
      next.prefixes = bucket.filter((a) => a.gen === 'prefix');
      next.suffixes = bucket.filter((a) => a.gen === 'suffix');
      next.split = true;
      next.metacrafts = [];
      return next;
    });
    outcomes.push({ state: items[0], parts: items, p });
  }
  return { outcomes: normalizeOutcomes(outcomes), cost, kind: 'split', parts };
}

function partitionEqual(mods, parts, size) {
  // For mechanics: generate a modest sample of combinations, not full factorial.
  if (parts === 2) {
    const n = mods.length;
    const half = Math.floor(n / 2);
    const out = [];
    const limit = 1 << n;
    const seen = new Set();
    for (let mask = 0; mask < limit; mask++) {
      const bits = bitCount(mask);
      if (bits !== half) continue;
      const A = [];
      const B = [];
      for (let i = 0; i < n; i++) (mask & (1 << i) ? A : B).push(mods[i]);
      const key = A.map(modKey).sort().join(',') + '|' + B.map(modKey).sort().join(',');
      const key2 = B.map(modKey).sort().join(',') + '|' + A.map(modKey).sort().join(',');
      if (seen.has(key) || seen.has(key2)) continue;
      seen.add(key);
      out.push([A, B]);
      if (out.length >= 64) break;
    }
    return out;
  }
  if (parts === 3 && mods.length === 6) {
    // Sample combinations of 2+2+2
    const out = [];
    const idx = [0, 1, 2, 3, 4, 5];
    for (let i = 0; i < idx.length && out.length < 40; i++) {
      for (let j = i + 1; j < idx.length; j++) {
        const first = [mods[i], mods[j]];
        const rest = mods.filter((_, k) => k !== i && k !== j);
        for (let a = 0; a < rest.length && out.length < 40; a++) {
          for (let b = a + 1; b < rest.length; b++) {
            const second = [rest[a], rest[b]];
            const third = rest.filter((_, k) => k !== a && k !== b);
            out.push([first, second, third]);
          }
        }
      }
    }
    return out;
  }
  return [];
}

function bitCount(x) {
  let n = 0;
  while (x) {
    n += x & 1;
    x >>= 1;
  }
  return n;
}

function modKey(a) {
  return a.id || a.text || '?';
}

export function beastCraft(state, kb, recipeId, opts = {}) {
  const recipe = findBeastRecipe(kb, recipeId);
  const kind = recipe?.kind ?? recipeId;
  if (kind === 'add-prefix-remove-suffix') return beastAddPrefixRemoveSuffix(state, kb, opts);
  if (kind === 'add-suffix-remove-prefix') return beastAddSuffixRemovePrefix(state, kb, opts);
  if (kind === 'split') return beastSplit(state, kb, { ...opts, parts: recipe?.parts ?? opts.parts ?? 2 });
  return { outcomes: [], cost: {}, illegal: `unknown beast recipe ${recipeId}` };
}
