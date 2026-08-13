/**
 * Canonical future-relevant state keys for V(S) memoization (§45).
 */
import { affixKey, allAffixes, stateHash } from '../craftState.js';

/** Full craft-state hash (mechanics + affixes). */
export function stateKey(state) {
  return stateHash(state);
}

/** Have-set key: sorted desired-affix keys only. */
export function haveKey(keys) {
  return [...(keys ?? [])].map(String).sort().join('\u001f');
}

/** Donor / subset manufacture key. */
export function donorKey(mods) {
  return haveKey(
    (mods ?? []).map((m) => {
      if (m.match || m.short || m.best || m.method) {
        return m.match?.id ? `id:${m.match.id}` : affixKey({ id: m.id, text: m.short ?? m.text, gen: m.gen });
      }
      return affixKey(m);
    })
  );
}

/** Strategically relevant signature for Pareto (§44). */
export function strategySig(state, neededKeys) {
  const need = new Set(neededKeys ?? []);
  const have = allAffixes(state)
    .filter((a) => need.has(affixKey(a)))
    .map((a) => `${affixKey(a)}${a.fractured ? 'F' : ''}`)
    .sort();
  const nP = state.prefixes?.length ?? 0;
  const nS = state.suffixes?.length ?? 0;
  const freeP = Math.max(0, 3 - nP);
  const freeS = Math.max(0, 3 - nS);
  const meta = (state.metacrafts ?? []).join(',');
  const cr = (state.cannotRollTags ?? []).join(',');
  return [
    have.join(';'),
    `fp${freeP}`,
    `fs${freeS}`,
    state.fracturedItem ? 'F' : '',
    (state.influence ?? []).join(','),
    meta,
    cr,
    state.eldritchDominance ?? '',
  ].join('|');
}

/** Terminal equivalence (§77): same families / tiers / sources — not name or order. */
export function terminalEquivalent(state, target, opts = {}) {
  const tierMode = opts.tierMode ?? target?.tierMode ?? 'atLeast';
  const want = target?.affixes ?? target?.mods ?? [];
  if (!want.length) return false;
  const have = allAffixes(state);
  for (const t of want) {
    const hit = have.find((a) => matchesTargetAffix(a, t, tierMode));
    if (!hit) return false;
  }
  if (opts.reserveBenchSlot) {
    const crafted = want.filter((t) => t.crafted || t.source === 'crafted');
    if (crafted.length) {
      const used = have.filter((a) => !a.crafted).length;
      if (used > 6 - crafted.length) return false;
    }
  }
  return true;
}

function matchesTargetAffix(have, target, tierMode) {
  const idOk = target.id && have.id && target.id === have.id;
  const famOk =
    idOk ||
    (target.groups?.length && have.groups?.some((g) => target.groups.includes(g))) ||
    affixKey(have) === affixKey(target);
  if (!famOk) return false;
  if (target.source && target.requireSource && have.source !== target.source) return false;
  if (target.crafted && !have.crafted) return false;
  if (target.tier == null || have.tier == null) return true;
  if (tierMode === 'exact') return have.tier === target.tier;
  return Number(have.tier) <= Number(target.tier);
}
