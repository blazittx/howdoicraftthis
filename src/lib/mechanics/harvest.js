/**
 * Full Harvest menu transitions from structured KB (harvest-menu-official.json).
 * Exact state pools — no "crit guaranteed". Target-blind.
 */
import { makeAffix, allAffixes } from '../craftState.js';
import { harvestEligiblePool, getEligibleMods, collectOccupiedGroups } from '../spawnWeights.js';
import { getRuleset } from '../ruleset.js';
import { modMatchesHarvest, harvestCostBag } from '../craftKnowledge.js';
import { normalizeOutcomes } from './prob.js';
import {
  side,
  setSide,
  lockGen,
  cannotRollForbiddenTags,
  removableAffixes,
  removeAffix,
  lifeforceCost,
  hasInfluence,
  CAP,
  openSlot,
} from './common.js';
import { harvestRemove } from './remove.js';
import { benchBlockedTags } from './blockers.js';
// removeAffix imported from common

export function harvestMenu(kb) {
  return kb?.harvestMenu?.crafts ?? kb?.harvest?.crafts ?? [];
}

export function findHarvestCraft(kb, idOrCraft) {
  if (idOrCraft && typeof idOrCraft === 'object') return idOrCraft;
  const id = String(idOrCraft ?? '');
  return harvestMenu(kb).find((c) => c.id === id) ?? null;
}

function asHarvestMatcher(craft) {
  return {
    id: craft.id,
    name: craft.name,
    tags: craft.tags ?? [],
    groups: craft.groups ?? [],
    textHints: craft.textHints ?? [],
    excludeText: craft.excludeText ?? [],
  };
}

function costOf(craft) {
  const bag = lifeforceCost(craft);
  if (Object.keys(bag).length) return bag;
  return harvestCostBag(craft, 1);
}

/** Harvest reforge including tag — pool from current occupied groups + cannot-roll. */
export function harvestReforge(state, kb, harvestOrId, opts = {}) {
  const rules = opts.rules ?? getRuleset();
  const craft = findHarvestCraft(kb, harvestOrId) ?? harvestOrId;
  if (!craft) return { outcomes: [], cost: {}, illegal: 'unknown harvest craft' };
  const harvest = asHarvestMatcher(craft);
  const gen = lockGen(state) ?? opts.generation ?? 'prefix';
  const fractured = side(state, gen).filter((a) => a.fractured);
  const keptOther = gen === 'prefix' ? state.suffixes : state.prefixes;
  const occupied = collectOccupiedGroups([...keptOther, ...fractured]);
  const pool = harvestEligiblePool(
    kb,
    state.baseTags ?? [],
    state.itemLevel ?? 1,
    gen,
    harvest,
    modMatchesHarvest,
    occupied
  );
  let rows = pool.rows;
  let total = pool.total;
  if (rules.harvest?.guaranteedReforgeRespectsCannotRoll) {
    const forbid = cannotRollForbiddenTags(state, rules);
    if (forbid.length) {
      rows = rows.filter((r) => !(r.tags ?? []).some((t) => forbid.includes(String(t).toLowerCase())));
      total = rows.reduce((s, r) => s + r.weight, 0);
    }
  }
  const cost = costOf(craft);
  if (!(total > 0) || !rows.length) {
    return { outcomes: [{ state: setSide(state, gen, fractured), p: 1 }], cost, pool: { total: 0, rows: [] } };
  }
  return {
    outcomes: normalizeOutcomes(
      rows.map((r) => ({
        state: setSide(state, gen, [...fractured, makeAffix({ ...r, gen })]),
        p: r.weight / total,
      }))
    ),
    cost,
    pool: { total, rows },
  };
}

/**
 * Add tagged mod + remove another random removable mod.
 * Remove ignores Cannot Roll Attack/Caster; add respects it (wiki).
 */
export function harvestAugmentRemove(state, kb, harvestOrId, opts = {}) {
  const rules = opts.rules ?? getRuleset();
  const craft = findHarvestCraft(kb, harvestOrId) ?? harvestOrId;
  if (!craft) return { outcomes: [], cost: {}, illegal: 'unknown harvest craft' };
  if (craft.requiresNonInfluenced && hasInfluence(state)) {
    return { outcomes: [], cost: costOf(craft), illegal: 'harvest augment requires non-influenced' };
  }
  const harvest = asHarvestMatcher(craft);
  const forbidAdd = craft.addRespectsCannotRoll !== false ? cannotRollForbiddenTags(state, rules) : [];
  const benchForbid = benchBlockedTags(state, kb);
  const forbidden = [...new Set([...forbidAdd, ...benchForbid])];

  const outcomes = [];
  for (const gen of ['prefix', 'suffix']) {
    if (!openSlot(state, gen) && side(state, gen).length >= CAP[gen]) continue;
    // Need space: either open slot OR we will remove from same/other side first conceptually —
    // model as: pick add from pool for either gen with open capacity after remove.
  }

  // Build add candidates per generation with open slot (augment needs room for the new mod
  // after remove — net zero if full 6; if full, remove first then add).
  const occupied = collectOccupiedGroups(allAffixes(state));
  const addPools = [];
  for (const gen of ['prefix', 'suffix']) {
    const { rows, total } = getEligibleMods(kb, state, {
      generation: gen,
      method: 'harvest',
      requiredTags: harvest.tags,
      forbiddenTags: forbidden,
      occupiedGroups: occupied,
      rules,
    });
    const filtered = rows.filter((r) => modMatchesHarvest(r, harvest));
    const t = filtered.reduce((s, r) => s + r.weight, 0);
    if (t > 0) addPools.push({ gen, rows: filtered, total: t });
  }
  if (!addPools.length) {
    return { outcomes: [], cost: costOf(craft), illegal: 'empty harvest augment pool' };
  }

  const remBase = removableAffixes(state);
  if (!remBase.length && allAffixes(state).length >= 6) {
    return { outcomes: [], cost: costOf(craft), illegal: 'no removable mod for harvest augment' };
  }

  const addTotal = addPools.reduce((s, p) => s + p.total, 0);
  for (const pool of addPools) {
    for (const row of pool.rows) {
      const pAdd = row.weight / addTotal;
      const afterAdd = setSide(state, pool.gen, [...side(state, pool.gen), makeAffix({ ...row, gen: pool.gen })]);
      // If over cap, illegal path — skip unless we remove first
      if (side(afterAdd, pool.gen).length > CAP[pool.gen]) continue;
      const rem = removableAffixes(afterAdd).filter((a) => a !== side(afterAdd, pool.gen).at(-1));
      // Prefer remove something other than the just-added; if empty, remove any including other side
      let victims = rem.filter((a) => {
        // just-added is last on that side — exclude by identity after clone won't work; exclude by id+gen
        const added = side(afterAdd, pool.gen).at(-1);
        return a !== added && !(a.id && added.id && a.id === added.id && a.gen === added.gen);
      });
      if (!victims.length) victims = removableAffixes(afterAdd).filter((a) => a.gen !== pool.gen || a !== side(afterAdd, pool.gen).at(-1));
      if (!victims.length) {
        // item had open slot: add without remove is wrong for this craft; skip
        continue;
      }
      const pRem = 1 / victims.length;
      for (const v of victims) {
        outcomes.push({ state: removeAffix(afterAdd, v), p: pAdd * pRem });
      }
    }
  }

  // Alternate model when item is full: remove first then add
  if (!outcomes.length && allAffixes(state).length >= 6) {
    const victims = removableAffixes(state);
    for (const v of victims) {
      const afterRem = removeAffix(state, v);
      const occ = collectOccupiedGroups(allAffixes(afterRem));
      for (const gen of ['prefix', 'suffix']) {
        if (!openSlot(afterRem, gen)) continue;
        const { rows, total } = getEligibleMods(kb, afterRem, {
          generation: gen,
          method: 'harvest',
          requiredTags: harvest.tags,
          forbiddenTags: forbidden,
          occupiedGroups: occ,
          rules,
        });
        const filtered = rows.filter((r) => modMatchesHarvest(r, harvest));
        const t = filtered.reduce((s, r) => s + r.weight, 0);
        if (!(t > 0)) continue;
        for (const row of filtered) {
          outcomes.push({
            state: setSide(afterRem, gen, [...side(afterRem, gen), makeAffix({ ...row, gen })]),
            p: (1 / victims.length) * (row.weight / t),
          });
        }
      }
    }
  }

  if (!outcomes.length) {
    return { outcomes: [], cost: costOf(craft), illegal: 'harvest augment produced no outcomes' };
  }
  outcomes.sort((a, b) => b.p - a.p);
  return { outcomes: normalizeOutcomes(outcomes.slice(0, 64)), cost: costOf(craft) };
}

export function harvestRemoveTagged(state, kb, harvestOrId) {
  const craft = findHarvestCraft(kb, harvestOrId) ?? harvestOrId;
  if (!craft) return { outcomes: [], cost: {}, illegal: 'unknown harvest craft' };
  return harvestRemove(state, asHarvestMatcher(craft), { cost: costOf(craft) });
}

const RES_GROUP = {
  fire: ['FireResistance'],
  cold: ['ColdResistance'],
  lightning: ['LightningResistance'],
};

/**
 * Resistance swap: replace a from-element resist with similar-tier to-element resist.
 */
export function harvestResistanceSwap(state, kb, craftOrId, opts = {}) {
  const craft = findHarvestCraft(kb, craftOrId) ?? craftOrId;
  if (!craft) return { outcomes: [], cost: {}, illegal: 'unknown harvest craft' };
  const from = craft.from;
  const to = craft.to;
  const fromGroups = new Set(RES_GROUP[from] ?? []);
  const candidates = allAffixes(state).filter((a) => {
    if (a.fractured) return false;
    if ((a.groups ?? []).some((g) => fromGroups.has(g))) return true;
    const t = String(a.text ?? '').toLowerCase();
    return t.includes(`${from} resistance`) && !/all elemental/i.test(t);
  });
  if (!candidates.length) {
    return { outcomes: [], cost: costOf(craft), illegal: `no ${from} resistance to swap` };
  }

  const outcomes = [];
  for (const victim of candidates) {
    const gen = victim.gen;
    const pool = getEligibleMods(kb, state, {
      generation: gen,
      method: 'harvest',
      requiredTags: [to],
      occupiedGroups: collectOccupiedGroups(allAffixes(state).filter((a) => a !== victim)),
      rules: opts.rules ?? getRuleset(),
    });
    const rows = pool.rows.filter((r) => {
      const groups = r.groups ?? [];
      return (RES_GROUP[to] ?? []).some((g) => groups.includes(g)) || /resistance/i.test(r.text ?? '');
    });
    const total = rows.reduce((s, r) => s + r.weight, 0);
    if (!(total > 0)) continue;
    const pPick = 1 / candidates.length;
    for (const row of rows) {
      const next = removeAffix(state, victim);
      outcomes.push({
        state: setSide(next, gen, [...side(next, gen), makeAffix({ ...row, gen })]),
        p: pPick * (row.weight / total),
      });
    }
  }
  if (!outcomes.length) {
    return { outcomes: [], cost: costOf(craft), illegal: 'resistance swap pool empty' };
  }
  return { outcomes: normalizeOutcomes(outcomes), cost: costOf(craft) };
}

/**
 * Dispatch any harvest menu craft by kind.
 * §20 WONT: body/weapon/flask enchants + stack transforms — not CraftState ops
 * (rare-affix EV optimizer does not need them).
 */
export function harvestCraft(state, kb, craftOrId, opts = {}) {
  const craft = findHarvestCraft(kb, craftOrId) ?? craftOrId;
  if (!craft) return { outcomes: [], cost: {}, illegal: 'unknown harvest craft' };
  switch (craft.kind) {
    case 'reforge':
      return harvestReforge(state, kb, craft, opts);
    case 'augment-remove':
      return harvestAugmentRemove(state, kb, craft, opts);
    case 'remove':
      return harvestRemoveTagged(state, kb, craft);
    case 'resistance-swap':
      return harvestResistanceSwap(state, kb, craft, opts);
    case 'enchant':
    case 'flask-enchant':
    case 'weapon-enchant':
    case 'body-enchant':
    case 'stack-transform':
    case 'transform':
      return {
        outcomes: [],
        cost: {},
        illegal: `harvest kind '${craft.kind}' out of scope (§20 WONT — rare affix EV)`,
        unsupported: true,
      };
    default:
      return {
        outcomes: [],
        cost: {},
        illegal: `unknown harvest kind '${craft.kind}'`,
        unsupported: true,
      };
  }
}
