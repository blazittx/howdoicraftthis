/**
 * Primitive mechanical transitions. Knows nothing about "good".
 * Each op returns { outcomes, cost } with Σp ≈ 1 (or illegal).
 */
import { cloneState, makeAffix, allAffixes } from '../craftState.js';
import { getEligibleMods, collectOccupiedGroups } from '../spawnWeights.js';
import { recombine } from '../recombinatorModel.js';
import { getRuleset } from '../ruleset.js';
import { normalizeItemClass } from '../itemClass.js';
import { normalizeOutcomes } from './prob.js';
import { side, setSide, openSlot } from './common.js';
import { benchBlockedTags } from './blockers.js';
import { annulRemove } from './remove.js';
import {
  harvestReforge as harvestReforgeImpl,
  harvestAugmentRemove,
  harvestRemoveTagged,
  harvestResistanceSwap,
  harvestCraft,
} from './harvest.js';
import {
  setupDominance,
  eldritchChaos as eldritchChaosImpl,
  eldritchAnnul,
  eldritchExalt,
} from './eldritch.js';
import { veiledExalt as veiledExaltImpl, veiledChaos, unveil, unveilOdds } from './unveil.js';
import { fossilCraft, fossilEligiblePool, findFossil } from './fossils.js';
import {
  beastAddPrefixRemoveSuffix,
  beastAddSuffixRemovePrefix,
  beastSplit,
  beastCraft,
} from './beasts.js';
import { methodAvailable, sourcesCompatibleWithMethod, checkPreconditions } from './availability.js';

export {
  annulRemove,
  harvestAugmentRemove,
  harvestRemoveTagged,
  harvestResistanceSwap,
  harvestCraft,
  setupDominance,
  eldritchAnnul,
  eldritchExalt,
  veiledChaos,
  unveil,
  unveilOdds,
  fossilCraft,
  fossilEligiblePool,
  findFossil,
  beastAddPrefixRemoveSuffix,
  beastAddSuffixRemovePrefix,
  beastSplit,
  beastCraft,
  methodAvailable,
  sourcesCompatibleWithMethod,
  checkPreconditions,
};

export function exalt(state, kb, opts = {}) {
  const gen = opts.generation ?? 'prefix';
  if (!openSlot(state, gen)) return { outcomes: [{ state, p: 1, blocked: true }], cost: {} };
  const occupied = collectOccupiedGroups(allAffixes(state));
  const { rows, total } = getEligibleMods(kb, state, {
    generation: gen,
    method: 'exalt',
    occupiedGroups: occupied,
    forbiddenTags: benchBlockedTags(state, kb),
    rules: opts.rules ?? getRuleset(),
  });
  const cost = { exalt: 1 };
  if (!(total > 0) || !rows.length) return { outcomes: [{ state, p: 1 }], cost };
  return {
    outcomes: normalizeOutcomes(
      rows.map((r) => ({
        state: setSide(state, gen, [...side(state, gen), makeAffix({ ...r, gen })]),
        p: r.weight / total,
      }))
    ),
    cost,
  };
}

/** §19 — Annul only (not veiled / harvest / beast remove). */
export function annul(state, opts = {}) {
  return annulRemove(state, opts);
}

/** §17 — Veiled Exalted (remove one + add veiled). */
export function veiledExalt(state, kb, opts = {}) {
  return veiledExaltImpl(state, kb, opts);
}

/** §8 — Harvest reforge with exact state pool + versioned cannot-roll. */
export function harvestReforge(state, kb, harvest, opts = {}) {
  return harvestReforgeImpl(state, kb, harvest, opts);
}

/** §83 — Essence after any metacraft is illegal. */
export function essence(state, kb, essenceName) {
  if ((state.metacrafts ?? []).length) {
    return { outcomes: [], cost: {}, illegal: 'essence after metamod' };
  }
  const ic = normalizeItemClass(state.itemClass);
  const ess = (kb.essences ?? []).find((e) => e.name === essenceName);
  const modId = ess?.mods_by_item_class?.[ic];
  const granted = modId && kb.modById?.get?.(modId);
  const cost = { [essenceName ?? 'essence']: 1 };
  if (!granted) return { outcomes: [{ state, p: 1, unmatched: true }], cost };
  const aff = makeAffix({
    id: granted.id,
    text: granted.text,
    gen: granted.generation,
    groups: granted.groups,
    ofEssence: true,
    essenceOnly: !!granted.is_essence_only,
    source: 'essence',
  });
  const next = setSide(state, aff.gen, [aff, ...side(state, aff.gen).filter((a) => a.fractured)]);
  return { outcomes: [{ state: next, p: 1 }], cost };
}

export function bench(state, mod) {
  const aff = makeAffix({ ...mod, crafted: true, source: 'crafted' });
  if (!openSlot(state, aff.gen)) {
    return { outcomes: [{ state, p: 1, blocked: true }], cost: {} };
  }
  return {
    outcomes: [{ state: setSide(state, aff.gen, [...side(state, aff.gen), aff]), p: 1 }],
    cost: { bench: 1 },
  };
}

export function eldritchChaos(state, kb, opts = {}) {
  return eldritchChaosImpl(state, kb, opts);
}

export function recombineOp(stateA, stateB, model) {
  const dist = recombine(stateA, stateB, model);
  return {
    outcomes: dist.outcomes.map((o) => ({ state: o.state, p: o.p })),
    cost: dist.cost ?? {},
  };
}

export function applyMetacraft(state, id) {
  const next = cloneState(state);
  next.metacrafts = [...new Set([...(next.metacrafts ?? []), id])];
  return { outcomes: [{ state: next, p: 1 }], cost: { divine: 2 } };
}
