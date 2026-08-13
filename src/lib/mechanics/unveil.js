/**
 * Veiled Chaos ≠ Veiled Exalted. Unveil pools from RePoE (kb.unveiled) — never fake 1/13.
 */
import { cloneState, makeAffix, allAffixes } from '../craftState.js';
import { getEligibleMods, collectOccupiedGroups, unveilExpected, weightedHitInChoices } from '../spawnWeights.js';
import { getRuleset } from '../ruleset.js';
import { normalizeOutcomes } from './prob.js';
import { side, setSide, lockGen, CAP, openSlot } from './common.js';
import { veiledExaltRemove } from './remove.js';
import { affixCountDistribution, sampleSideCounts } from './affixCounts.js';
import { benchBlockedTags } from './blockers.js';

function veiledPlaceholder(gen) {
  return makeAffix({
    text: gen === 'suffix' ? 'Veiled Suffix' : 'Veiled Prefix',
    gen,
    veiled: true,
    source: 'veiled',
  });
}

/** Veiled Exalted: remove one + add veiled. Distinct from Annul. */
export function veiledExalt(state, kb, opts = {}) {
  const rules = opts.rules ?? getRuleset();
  const cost = { veiled: 1 };
  const genPref = opts.generation;
  const rem = veiledExaltRemove(state, opts);
  if (!rules.veiledExalted?.removesOneAddsOne || !rem.outcomes.length) {
    const gen = genPref ?? (openSlot(state, 'prefix') ? 'prefix' : 'suffix');
    if (!openSlot(state, gen)) return { outcomes: [{ state, p: 1, blocked: true }], cost };
    return {
      outcomes: [{ state: setSide(state, gen, [...side(state, gen), veiledPlaceholder(gen)]), p: 1 }],
      cost,
    };
  }
  const outcomes = [];
  for (const o of rem.outcomes) {
    const unlocked = lockGen(o.state);
    const gens = unlocked ? [unlocked] : ['prefix', 'suffix'].filter((g) => openSlot(o.state, g));
    if (!gens.length) {
      outcomes.push({ ...o, blocked: true });
      continue;
    }
    const gensUse = genPref && gens.includes(genPref) ? [genPref] : gens;
    const pGen = 1 / gensUse.length;
    for (const gen of gensUse) {
      outcomes.push({
        state: setSide(o.state, gen, [...side(o.state, gen), veiledPlaceholder(gen)]),
        p: o.p * pGen,
      });
    }
  }
  return { outcomes: normalizeOutcomes(outcomes), cost };
}

/**
 * Veiled Chaos: reforge rare with new random mods including a veiled.
 * Uses affix-count distribution; not the same as Veiled Exalt.
 */
export function veiledChaos(state, kb, opts = {}) {
  const rules = opts.rules ?? getRuleset();
  const cost = { 'veiled-chaos': 1 };
  const unlocked = lockGen(state);
  const dist = affixCountDistribution(kb, 'veiled-chaos');
  const fractured = allAffixes(state).filter((a) => a.fractured);
  const kept = unlocked
    ? unlocked === 'prefix'
      ? { prefixes: state.prefixes, suffixes: fractured.filter((a) => a.gen === 'suffix') }
      : { suffixes: state.suffixes, prefixes: fractured.filter((a) => a.gen === 'prefix') }
    : { prefixes: fractured.filter((a) => a.gen === 'prefix'), suffixes: fractured.filter((a) => a.gen === 'suffix') };

  const outcomes = [];
  const totals = dist.byTotal ?? [{ n: 4, p: 1 }];
  for (const row of totals) {
    const sides = sampleSideCounts(row.n, kept.prefixes.length, kept.suffixes.length);
    for (const sc of sides) {
      const pStruct = row.p * sc.p;
      // Build empty rare then fill — simplified: keep locked/fractured, fill other side(s) randomly + guarantee one veiled
      let base = cloneState(state);
      if (!unlocked) {
        base.prefixes = [...kept.prefixes];
        base.suffixes = [...kept.suffixes];
      } else if (unlocked === 'prefix') {
        base.prefixes = [...state.prefixes];
        base.suffixes = [...kept.suffixes];
      } else {
        base.suffixes = [...state.suffixes];
        base.prefixes = [...kept.prefixes];
      }

      const needP = Math.max(0, sc.prefixes - base.prefixes.length);
      const needS = Math.max(0, sc.suffixes - base.suffixes.length);
      // Guarantee veiled on an unlocked side that needs at least one roll
      const veiledGen =
        unlocked === 'prefix' ? 'suffix' : unlocked === 'suffix' ? 'prefix' : needS > 0 ? 'suffix' : 'prefix';

      const fill = (st, gen, n, withVeiled) => {
        if (n <= 0) return [{ state: st, p: 1 }];
        let frontier = [{ state: st, p: 1 }];
        for (let i = 0; i < n; i++) {
          const next = [];
          for (const f of frontier) {
            if (withVeiled && i === 0) {
              next.push({
                state: setSide(f.state, gen, [...side(f.state, gen), veiledPlaceholder(gen)]),
                p: f.p,
              });
              continue;
            }
            const occupied = collectOccupiedGroups(allAffixes(f.state));
            const pool = getEligibleMods(kb, f.state, {
              generation: gen,
              method: 'veiled-chaos',
              occupiedGroups: occupied,
              forbiddenTags: benchBlockedTags(f.state, kb),
              rules,
            });
            const rows = pool.rows.slice(0, 6);
            const total = rows.reduce((s, r) => s + r.weight, 0);
            if (!(total > 0)) {
              next.push(f);
              continue;
            }
            for (const r of rows) {
              next.push({
                state: setSide(f.state, gen, [...side(f.state, gen), makeAffix({ ...r, gen })]),
                p: f.p * (r.weight / total),
              });
            }
          }
          next.sort((a, b) => b.p - a.p);
          const top = next.slice(0, 24);
          const z = top.reduce((s, o) => s + o.p, 0) || 1;
          frontier = top.map((o) => ({ ...o, p: o.p / z }));
        }
        return frontier;
      };

      let afterP = fill(base, 'prefix', needP, veiledGen === 'prefix');
      for (const a of afterP) {
        const afterS = fill(a.state, 'suffix', needS, veiledGen === 'suffix');
        for (const b of afterS) {
          outcomes.push({ state: b.state, p: pStruct * a.p * b.p });
        }
      }
    }
  }
  if (!outcomes.length) return { outcomes: [{ state, p: 1 }], cost };
  outcomes.sort((a, b) => b.p - a.p);
  return { outcomes: normalizeOutcomes(outcomes.slice(0, 48)), cost };
}

/**
 * Unveil: 3 choices from dynamic RePoE unveiled pool. No fake 1/13.
 * If pool unknown / empty → illegal/unranked (unknown: true), never invent p.
 */
export function unveil(state, kb, opts = {}) {
  const veiled = allAffixes(state).filter((a) => a.veiled);
  if (!veiled.length) return { outcomes: [], cost: {}, illegal: 'no veiled mod to unveil' };
  const cost = {};
  const outcomes = [];
  for (const v of veiled) {
    const gen = v.gen;
    const occupied = collectOccupiedGroups(allAffixes(state).filter((a) => a !== v));
    const byKey = new Map();
    for (const mod of kb.unveiled ?? []) {
      if (mod.generation !== gen) continue;
      if ((mod.required_level ?? 0) > (state.itemLevel ?? 1)) continue;
      if ((mod.groups ?? []).some((g) => occupied.has(g))) continue;
      const w = kb.weightOnTags?.(mod, state.baseTags ?? []) ?? 0;
      if (!(w > 0)) continue;
      const key = mod.type || mod.groups?.[0] || mod.id;
      const cur = byKey.get(key);
      if (!cur || w > cur.weight) byKey.set(key, { key, weight: w, mod });
    }
    const pool = [...byKey.values()];
    if (!pool.length) {
      return {
        outcomes: [],
        cost,
        illegal: 'unveil pool empty or unweighted',
        unknown: true,
      };
    }
    const total = pool.reduce((s, o) => s + o.weight, 0);
    // Each unveil presents `choices` independent rolls; model final pick as weighted among pool
    // (player picks best). For mechanics distribution we emit each outcome weighted by appearance chance.
    const choices = opts.choices ?? 3;
    for (const o of pool) {
      const pAppear = weightedHitInChoices(pool, o.key, choices);
      if (!(pAppear > 0)) continue;
      const next = removeVeiled(state, v);
      const aff = makeAffix({
        id: o.mod.id,
        text: o.mod.text,
        gen,
        groups: o.mod.groups,
        tags: o.mod.tags,
        source: 'unveiled',
        veiled: false,
      });
      outcomes.push({
        state: setSide(next, gen, [...side(next, gen), aff]),
        p: (1 / veiled.length) * pAppear,
      });
    }
  }
  if (!outcomes.length) return { outcomes: [], cost, unknown: true, illegal: 'unveil probability unknown' };
  return { outcomes: normalizeOutcomes(outcomes), cost };
}

function removeVeiled(state, v) {
  const next = cloneState(state);
  next.prefixes = (state.prefixes ?? []).filter((x) => x !== v);
  next.suffixes = (state.suffixes ?? []).filter((x) => x !== v);
  return next;
}

/** Helper for optimizer: unveil EV from RePoE; never returns fake 1/13. */
export function unveilOdds(kb, state, goal) {
  const occupied = collectOccupiedGroups(allAffixes(state));
  const u = unveilExpected(kb, state.baseTags ?? [], state.itemLevel ?? 1, goal, occupied, 3);
  if (u.unknown) return { ...u, fakeUniform: false };
  // Guard: reject classic fake 1/13 style if someone hardcodes poolSize=13 with equal weights without KB hit
  if (u.approx && u.poolSize === 13 && !(u.hitWeight > 0)) {
    return { ...u, unknown: true, expected: Infinity, fakeUniform: true };
  }
  return { ...u, fakeUniform: false };
}
