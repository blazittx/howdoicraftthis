/**
 * Generic fossil simulator from RePoE fossils.json (positive/negative tag weights).
 * Not limited to Dense/Hollow.
 */
import { cloneState, makeAffix, allAffixes } from '../craftState.js';
import { collectOccupiedGroups } from '../spawnWeights.js';
import { normalizeOutcomes } from './prob.js';
import { side, setSide } from './common.js';
import { fossilAffixCounts, sampleSideCounts } from './affixCounts.js';
import { benchBlockedTags } from './blockers.js';

export function findFossil(kb, nameOrId) {
  const q = String(nameOrId ?? '').toLowerCase();
  return (kb.fossils ?? []).find(
    (f) => f.name?.toLowerCase() === q || f.id?.toLowerCase() === q || f.id?.toLowerCase().endsWith(q)
  );
}

/**
 * Effective spawn weight under a set of fossils.
 * RePoE: positive_mod_weights multiply/add tag weight; negative weight 0 = banned.
 */
export function fossilModWeight(mod, baseWeight, fossils) {
  if (!(baseWeight > 0)) return 0;
  const tags = new Set((mod.tags ?? []).map((t) => String(t).toLowerCase().replace(/\s+/g, '_')));
  let w = baseWeight;
  for (const f of fossils) {
    for (const n of f.negative_mod_weights ?? []) {
      const tag = String(n.tag).toLowerCase();
      if (tags.has(tag) && (n.weight === 0 || n.weight == null)) return 0;
    }
    for (const t of f.forbidden_tags ?? []) {
      if (tags.has(String(t).toLowerCase())) return 0;
    }
    const allowed = f.allowed_tags ?? [];
    if (allowed.length && !allowed.some((t) => tags.has(String(t).toLowerCase()))) return 0;
    for (const p of f.positive_mod_weights ?? []) {
      const tag = String(p.tag).toLowerCase();
      if (tags.has(tag) && p.weight > 0) w += baseWeight * (p.weight / 100);
    }
  }
  return w;
}

function spawnable(kb, baseTags) {
  return (kb.natural ?? []).filter((m) => (kb.weightOnTags?.(m, baseTags) ?? 0) > 0);
}

export function fossilEligiblePool(kb, state, fossils, opts = {}) {
  const gen = opts.generation;
  const occupied = opts.occupiedGroups ?? collectOccupiedGroups(allAffixes(state));
  const ban = occupied instanceof Set ? occupied : new Set(occupied);
  const forbid = new Set(benchBlockedTags(state, kb));
  const rows = [];
  for (const mod of spawnable(kb, state.baseTags ?? [])) {
    if (gen && mod.generation !== gen) continue;
    if ((mod.required_level ?? 0) > (state.itemLevel ?? 1)) continue;
    if ((mod.groups ?? []).some((g) => ban.has(g))) continue;
    const tags = (mod.tags ?? []).map((t) => String(t).toLowerCase());
    if (tags.some((t) => forbid.has(t))) continue;
    const base = kb.weightOnTags(mod, state.baseTags ?? []);
    const w = fossilModWeight(mod, base, fossils);
    if (!(w > 0)) continue;
    rows.push({
      id: mod.id,
      name: mod.name,
      text: (mod.text ?? '').split('\n')[0],
      generation: mod.generation,
      groups: mod.groups ?? [],
      tags: mod.tags ?? [],
      weight: w,
    });
  }
  const total = rows.reduce((s, r) => s + r.weight, 0);
  return { total, rows };
}

/**
 * Apply one or more fossils via resonator. Reforges to a new rare using fossil-weighted pools.
 * Forced mods from RePoE `forced_mods` / `added_mods` are attached when present in kb.modById.
 */
export function fossilCraft(state, kb, fossilNames, opts = {}) {
  const names = Array.isArray(fossilNames) ? fossilNames : [fossilNames];
  const fossils = names.map((n) => findFossil(kb, n)).filter(Boolean);
  if (!fossils.length) return { outcomes: [], cost: {}, illegal: 'unknown fossil' };
  const sockets = opts.sockets ?? Math.max(1, fossils.length);
  const cost = Object.fromEntries(fossils.map((f) => [`fossil-${slug(f.name)}`, 1]));
  cost.resonator = 1;

  const fractured = allAffixes(state).filter((a) => a.fractured);
  const keptP = fractured.filter((a) => a.gen === 'prefix');
  const keptS = fractured.filter((a) => a.gen === 'suffix');
  const counts = fossilAffixCounts(kb, sockets);

  // Forced mods
  const forced = [];
  for (const f of fossils) {
    for (const id of [...(f.forced_mods ?? []), ...(f.added_mods ?? [])]) {
      const mod = kb.modById?.get?.(id);
      if (mod) forced.push(mod);
    }
  }

  const outcomes = [];
  for (const c of counts) {
    const sides = sampleSideCounts(c.n, keptP.length + forced.filter((m) => m.generation === 'prefix').length, keptS.length);
    for (const sc of sides) {
      const p0 = c.p * sc.p;
      let base = cloneState(state);
      base.prefixes = [...keptP];
      base.suffixes = [...keptS];
      for (const mod of forced) {
        const gen = mod.generation === 'suffix' ? 'suffix' : 'prefix';
        base = setSide(base, gen, [...side(base, gen), makeAffix({ ...mod, gen, source: 'delve' })]);
      }
      const needP = Math.max(0, sc.prefixes - base.prefixes.length);
      const needS = Math.max(0, sc.suffixes - base.suffixes.length);
      const filled = fillSides(base, kb, fossils, needP, needS);
      for (const f of filled) outcomes.push({ state: f.state, p: p0 * f.p });
    }
  }
  if (!outcomes.length) return { outcomes: [{ state, p: 1 }], cost };
  outcomes.sort((a, b) => b.p - a.p);
  const capped = outcomes.slice(0, 48);
  return { outcomes: normalizeOutcomes(capped), cost, fossils: fossils.map((f) => f.name), truncated: outcomes.length > 48 };
}

function slug(name) {
  return String(name ?? 'fossil')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const ROW_CAP = 6;
const FRONTIER_CAP = 24;

function topRows(pool, cap = ROW_CAP) {
  if (!pool.rows.length) return { rows: [], total: 0 };
  const rows = [...pool.rows].sort((a, b) => b.weight - a.weight).slice(0, cap);
  const total = rows.reduce((s, r) => s + r.weight, 0);
  return { rows, total };
}

function fillSides(state, kb, fossils, needP, needS) {
  let frontier = [{ state, p: 1 }];
  const roll = (list, gen, n) => {
    for (let i = 0; i < n; i++) {
      const next = [];
      for (const f of list) {
        const raw = fossilEligiblePool(kb, f.state, fossils, {
          generation: gen,
          occupiedGroups: collectOccupiedGroups(allAffixes(f.state)),
        });
        const pool = topRows(raw);
        if (!(pool.total > 0)) {
          next.push(f);
          continue;
        }
        for (const r of pool.rows) {
          next.push({
            state: setSide(f.state, gen, [...side(f.state, gen), makeAffix({ ...r, gen, source: 'delve' })]),
            p: f.p * (r.weight / pool.total),
          });
        }
      }
      next.sort((a, b) => b.p - a.p);
      const top = next.slice(0, FRONTIER_CAP);
      const z = top.reduce((s, o) => s + o.p, 0) || 1;
      list = top.map((o) => ({ ...o, p: o.p / z }));
    }
    return list;
  };
  frontier = roll(frontier, 'prefix', needP);
  frontier = roll(frontier, 'suffix', needS);
  return frontier;
}
