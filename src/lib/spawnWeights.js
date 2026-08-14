/**
 * Spawn-weight EV helpers aligned with Craft of Exile / PoE conventions:
 *
 * - Pool = sum of resolved spawn weights for eligible natural mods of that
 *   generation on the base (ilvl gate + tag weight > 0). Same denominator CoE
 *   shows as “total weight”. Cannot roll Caster/Attack excludes those tags.
 * - Mod groups are exclusive: occupied groups (already on the item) are removed
 *   from every “what can still roll” pool (generation, harvest, fish, exalt…).
 * - Per-mod weight = first matching spawn_weights tag on the base (0 excludes),
 *   then × first matching generation_weights/100 (PoECraft / RePoE / CoE).
 * - Desired “tier” = that tier and all better tiers (higher required_level), i.e.
 *   CoE when you click the pasted tier and every stronger tier as success.
 * - Multi-mod success (essence fish / Eldritch Chaos side): CoE G1∧G2∧G3 —
 *   separate columns must all appear. Modelled as `draws` sequential weighted
 *   picks without replacement (mod-line weights removed once taken).
 * - Unveil: each unveil rolls the same weighted chance `p = hit/pool` three times
 *   independently → P(hit) = 1 − (1−p)³. (Not combinatorial C(N,3) / “1 in 5”.)
 */

import { expectedAttempts } from './expected.js';
import { harvestRespectsCannotRoll, getRuleset } from './ruleset.js';

function toGroupSet(groups) {
  if (!groups) return new Set();
  return groups instanceof Set ? groups : new Set(groups);
}

function blockedByOccupied(mod, occupied) {
  return occupied.size > 0 && (mod.groups ?? []).some((g) => occupied.has(g));
}

/** True for base/eldritch implicits & enchants — they do NOT block explicit spawn groups. */
export function isNonOccupyingAffix(m) {
  if (!m) return false;
  if (m.implicit || m.enchant || m.eldritch) return true;
  const src = m.method ?? m.type ?? m.source ?? m.match?.source;
  return src === 'implicit' || src === 'enchant' || src === 'enchantment' || src === 'eldritch';
}

/** Collect exclusive mod groups from item / plan mods that already occupy slots.
 *  Implicits / enchants / eldritch implicits are excluded (PoE allows e.g. Heavy Belt
 *  implicit Str + explicit Str). */
export function collectOccupiedGroups(mods) {
  const g = new Set();
  for (const m of mods ?? []) {
    if (isNonOccupyingAffix(m)) continue;
    for (const x of m.groups ?? m.meta?.groups ?? m.match?.groups ?? []) g.add(x);
  }
  return g;
}

/** Natural + influence (+ flask/jewel only when those domains apply). */
function spawnableMods(kb, baseTags = []) {
  const list = [...(kb.natural ?? [])];
  if (kb.influence?.length) list.push(...kb.influence);
  const tags = baseTags ?? [];
  const jewelish = tags.some((t) => /jewel|abyss_jewel|cluster/i.test(t));
  const flaskish = tags.some((t) => /flask/i.test(t));
  if (jewelish && kb.jewels?.length) list.push(...kb.jewels);
  if (flaskish && kb.flasks?.length) list.push(...kb.flasks);
  return list;
}

export function generationPoolWeight(kb, baseTags, ilvl, generation, occupiedGroups = []) {
  const ban = toGroupSet(occupiedGroups);
  let total = 0;
  for (const mod of spawnableMods(kb, baseTags)) {
    if (mod.generation !== generation) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    if (blockedByOccupied(mod, ban)) continue;
    const w = kb.weightOnTags(mod, baseTags);
    if (w > 0) total += w;
  }
  return Math.max(total, 1);
}

/** Family key: prefer KB familyId (§35); else groups+text heuristics. */
export function modLineKey(mod) {
  if (mod.familyId) return mod.familyId;
  if (mod.match?.familyId) return mod.match.familyId;
  const text = (mod.text ?? '').toLowerCase();
  const groups = [...(mod.groups ?? [])].sort().join('+');
  const isPct = /\bincreased\b/.test(text);
  // Bleed chance+damage hybrid — line order differs (natural vs influence / paste).
  if (/chance to cause bleeding/.test(text) && /damage with bleeding/.test(text)) {
    return `${groups}|bleed-chance-dmg`;
  }
  if (/energy shield/.test(text) && /stun and block/.test(text)) return `${groups}|es-stun`;
  if (/armour and energy shield/.test(text)) return `${groups}|ar-es`;
  if (/evasion and energy shield/.test(text)) return `${groups}|ev-es`;
  if (/armour and evasion/.test(text)) return `${groups}|ar-ev`;
  if (/energy shield/.test(text) && !/armour|evasion/.test(text)) {
    return `${groups}|es-${isPct ? 'pct' : 'flat'}`;
  }
  if (/armour/.test(text) && !/evasion|energy shield/.test(text)) {
    return `${groups}|ar-${isPct ? 'pct' : 'flat'}`;
  }
  if (/evasion/.test(text) && !/armour|energy shield/.test(text)) {
    return `${groups}|ev-${isPct ? 'pct' : 'flat'}`;
  }
  if (/fire resistance/.test(text) && !/cold|lightning|chaos|all/.test(text)) return `${groups}|fire-res`;
  if (/cold resistance/.test(text) && !/fire|lightning|chaos|all/.test(text)) return `${groups}|cold-res`;
  if (/lightning resistance/.test(text) && !/fire|cold|chaos|all/.test(text)) return `${groups}|light-res`;
  if (/chaos resistance/.test(text) && !/penetrate/.test(text)) return `${groups}|chaos-res`;
  if (/to intelligence/.test(text)) return `${groups}|int`;
  if (/to strength/.test(text)) return `${groups}|str`;
  if (/to dexterity/.test(text)) return `${groups}|dex`;
  if (/movement speed/.test(text)) return `${groups}|ms`;
  if (/critical strike multiplier/.test(text)) return `${groups}|crit-multi`;
  if (/critical strike chance/.test(text)) return `${groups}|crit-chance`;
  if (/attack speed/.test(text)) return `${groups}|as`;
  return `${groups}|${text.split('\n')[0].replace(/\d+/g, '#')}`;
}

/**
 * Best natural mod for a goal: prefer KB match id, else closest numeric tier.
 * Values above the highest tier clamp to that tier (legacy / mirror pastes).
 */
export function resolveNaturalMod(kb, goal, generation) {
  if (goal.match?.matched && goal.match.id && kb.modById?.get(goal.match.id)) {
    const m = kb.modById.get(goal.match.id);
    if (m && !m.is_essence_only && m.source !== 'essence_only') return m;
  }
  if (goal.id && kb.modById?.get(goal.id)) {
    const m = kb.modById.get(goal.id);
    if (m && !m.is_essence_only) return m;
  }

  const gen = generation ?? goal.gen ?? goal.match?.generation;
  const text = (goal.text ?? goal.match?.text ?? '').split('\n')[0];
  if (!text) return goal.match || goal;

  const primary = kb.extractNumbers?.(text)?.[0] ?? null;
  let bestInRange = null;
  let bestInRangeScore = -Infinity;
  let bestBelowOrClamp = null;
  let bestClampScore = -Infinity;

  for (const m of spawnableMods(kb)) {
    if (gen && m.generation !== gen) continue;
    const pat = m.pattern || kb.textToPattern?.(m.text);
    if (!pat || !kb.patternMatch(pat, goal.text ?? text)) continue;

    if (primary != null && m.min != null && m.max != null) {
      if (primary >= m.min - 1 && primary <= m.max + 1) {
        const mid = (m.min + m.max) / 2;
        const score = 10000 - Math.abs(primary - mid) + (m.required_level ?? 0);
        if (score > bestInRangeScore) {
          bestInRangeScore = score;
          bestInRange = m;
        }
      } else if (primary > m.max) {
        const score = m.max * 10 + (m.required_level ?? 0);
        if (score > bestClampScore) {
          bestClampScore = score;
          bestBelowOrClamp = m;
        }
      }
    } else {
      const score = m.required_level ?? 0;
      if (score > bestClampScore) {
        bestClampScore = score;
        bestBelowOrClamp = m;
      }
    }
  }

  return bestInRange || bestBelowOrClamp || goal.match || goal;
}

/**
 * Among natural mods of the same line on this base, pick by PoE tier
 * (Tier 1 = highest required_level). CoE selects that tier as success floor.
 */
export function modForPoETier(kb, seedMod, baseTags, ilvl, poeTier) {
  if (!seedMod || poeTier == null || poeTier < 1) return seedMod;
  const line = modLineKey(seedMod);
  const gen = seedMod.generation;
  const ranked = [];
  for (const mod of spawnableMods(kb, baseTags)) {
    if (gen && mod.generation !== gen) continue;
    if (modLineKey(mod) !== line) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    const w = kb.weightOnTags(mod, baseTags);
    if (w <= 0) continue;
    ranked.push(mod);
  }
  ranked.sort((a, b) => (b.required_level ?? 0) - (a.required_level ?? 0));
  if (!ranked.length) return seedMod;
  return ranked[Math.min(poeTier - 1, ranked.length - 1)] || seedMod;
}

/**
 * Weight of this mod line at selected tier and all better tiers (higher required_level).
 * Matches CoE when those tiers are marked as success.
 */
export function weightTierAndAbove(kb, targetMod, baseTags, ilvl) {
  const line = modLineKey(targetMod);
  const minLvl = targetMod.required_level ?? 1;
  const generation = targetMod.generation;
  let weight = 0;
  const tiers = [];
  for (const mod of spawnableMods(kb, baseTags)) {
    if (generation && mod.generation !== generation) continue;
    if (modLineKey(mod) !== line) continue;
    if ((mod.required_level ?? 0) < minLvl) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    const w = kb.weightOnTags(mod, baseTags);
    if (w <= 0) continue;
    weight += w;
    tiers.push({
      id: mod.id,
      name: mod.name,
      required_level: mod.required_level,
      weight: w,
      text: (mod.text ?? '').split('\n')[0],
    });
  }
  return { weight: Math.max(weight, 0), tiers, line };
}

/** One goal's hit weight vs a pool (pool should already exclude occupied groups). */
export function goalOdds(kb, baseTags, ilvl, goal, poolWeight, generation, occupiedGroups = []) {
  const ban = toGroupSet(occupiedGroups);
  let kbMod = resolveNaturalMod(kb, goal, generation) || goal.match || goal;
  if (!kbMod) {
    const pool = Math.max(poolWeight, 1);
    return {
      short: goal.short ?? String(goal.text ?? '').split('\n')[0],
      hitWeight: 0,
      poolWeight: pool,
      pRoll: 0,
      tiers: [],
      line: '',
      kbMod: null,
    };
  }
  if (goal.tier != null) {
    kbMod = modForPoETier(kb, kbMod, baseTags, ilvl, goal.tier) || kbMod;
  }
  // Wrong generation (e.g. suffix Str scored against prefix pool) → impossible.
  const resolvedGen = kbMod?.generation ?? generation ?? goal.gen;
  if (generation && kbMod?.generation && kbMod.generation !== generation) {
    const pool = Math.max(poolWeight, 1);
    return {
      short: goal.short ?? String(goal.text ?? '').split('\n')[0],
      hitWeight: 0,
      poolWeight: pool,
      pRoll: 0,
      tiers: [],
      line: '',
      kbMod,
    };
  }
  // Floor = selected PoE tier's required_level (tier+better). Don't max with a
  // stale lower/higher match or T2 goals get clamped to T1-only.
  const floor =
    goal.tier != null
      ? kbMod.required_level ?? 1
      : Math.max(kbMod.required_level ?? 0, goal.reqLevel ?? 0, goal.match?.required_level ?? 0, 1);
  const seed = {
    generation: resolvedGen,
    groups: kbMod.groups ?? goal.groups ?? goal.match?.groups ?? [],
    required_level: floor,
    text: kbMod.text ?? goal.text,
  };
  // Occupied exclusive group → cannot roll this line (hit 0).
  if (blockedByOccupied(seed, ban) || blockedByOccupied(kbMod ?? {}, ban)) {
    const pool = Math.max(poolWeight, 1);
    return {
      short:
        goal.short ??
        String(goal.text ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .join(' | '),
      hitWeight: 0,
      poolWeight: pool,
      pRoll: 0,
      tiers: [],
      line: modLineKey(seed),
      kbMod,
    };
  }
  const { weight, tiers, line } = weightTierAndAbove(kb, seed, baseTags, ilvl);
  const pool = Math.max(poolWeight, 1);
  const pRoll = weight / pool;
  return {
    short:
      goal.short ??
      String(goal.text ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' | '),
    hitWeight: weight,
    poolWeight: pool,
    pRoll,
    tiers,
    line,
    kbMod,
  };
}

export function formatWeight(hit, pool) {
  const p = pool > 0 ? (hit / pool) * 100 : 0;
  const pct = p >= 1 ? p.toFixed(2) : p >= 0.01 ? p.toFixed(3) : p.toFixed(4);
  return `hit ${hit} / pool ${pool} (${pct}%)`;
}

export function formatGoalsWeights(goals) {
  return goals.map((g) => `${g.short}: ${formatWeight(g.hitWeight ?? g.weight, g.poolWeight ?? g.pool)}`).join('; ');
}

/**
 * CoE G1∧G2∧… : probability that every goal weight appears in `draws`
 * sequential weighted picks without replacement.
 */
export function jointAndInDraws(hitWeights, pool, draws) {
  // Zero-weight goals are impossible — never treat as free success (was claiming 100%).
  if ((hitWeights ?? []).some((w) => !(w > 0))) return 0;
  const weights = hitWeights.map((w) => Math.max(w, 0)).filter((w) => w > 0);
  const k = weights.length;
  if (k === 0) return 1;
  if (draws < k) return 0;
  const W = Math.max(pool, 1);

  if (draws === k) {
    let total = 0;
    const rec = (left, poolLeft, p) => {
      if (!left.length) {
        total += p;
        return;
      }
      for (let i = 0; i < left.length; i++) {
        const w = left[i];
        const next = left.slice(0, i).concat(left.slice(i + 1));
        rec(next, Math.max(poolLeft - w, 1), p * (w / Math.max(poolLeft, 1)));
      }
    };
    rec(weights, W, 1);
    return Math.max(total, 1e-15);
  }

  // DP over bitset of collected goals
  const N = 1 << k;
  let dp = new Float64Array(N);
  dp[0] = 1;
  for (let t = 0; t < draws; t++) {
    const next = new Float64Array(N);
    for (let mask = 0; mask < N; mask++) {
      const prev = dp[mask];
      if (prev === 0) continue;
      let used = 0;
      for (let i = 0; i < k; i++) if (mask & (1 << i)) used += weights[i];
      const rem = Math.max(W - used, 1);
      let missing = 0;
      for (let i = 0; i < k; i++) {
        if (mask & (1 << i)) continue;
        missing += weights[i];
        next[mask | (1 << i)] += prev * (weights[i] / rem);
      }
      next[mask] += prev * (Math.max(rem - missing, 0) / rem);
    }
    dp = next;
  }
  return Math.max(dp[N - 1], 1e-15);
}

/**
 * Harvest-tagged subset of a generation pool (for Reforge X odds).
 * Excludes mods sharing a group with `occupiedGroups` (already on the item).
 */
export function harvestPoolWeight(kb, baseTags, ilvl, generation, harvest, modMatchesHarvest, occupiedGroups = []) {
  const ban = toGroupSet(occupiedGroups);
  let total = 0;
  for (const mod of spawnableMods(kb, baseTags)) {
    if (mod.generation !== generation) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    if (blockedByOccupied(mod, ban)) continue;
    if (!modMatchesHarvest(mod, harvest)) continue;
    const w = kb.weightOnTags(mod, baseTags);
    if (w > 0) total += w;
  }
  return Math.max(total, 1);
}

/**
 * Currently eligible Harvest-tagged mods (state-dependent): groups, tags, ilvl, base weights.
 * Occupied / blocked groups are removed. Used to discover pool collapse (not hardcoded 100%).
 */
export function harvestEligiblePool(kb, baseTags, ilvl, generation, harvest, modMatchesHarvest, occupiedGroups = []) {
  const ban = toGroupSet(occupiedGroups);
  const rows = [];
  for (const mod of spawnableMods(kb, baseTags)) {
    if (mod.generation !== generation) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    if (blockedByOccupied(mod, ban)) continue;
    if (!modMatchesHarvest(mod, harvest)) continue;
    const w = kb.weightOnTags(mod, baseTags);
    if (!(w > 0)) continue;
    rows.push({
      id: mod.id,
      name: mod.name,
      text: (mod.text ?? '').split('\n')[0],
      weight: w,
      groups: mod.groups ?? [],
      tags: mod.tags ?? [],
      required_level: mod.required_level ?? 0,
    });
  }
  rows.sort((a, b) => b.weight - a.weight || (b.required_level ?? 0) - (a.required_level ?? 0));
  const total = rows.reduce((s, r) => s + r.weight, 0);
  return { total, rows };
}

/**
 * Currently eligible mods for a mechanical state. Occupied groups, ilvl, tags, cannot-roll.
 * `desired` is not an input — optimizer-only.
 */
export function getEligibleMods(kb, state, opts = {}) {
  const generation = opts.generation;
  const requiredTags = (opts.requiredTags ?? []).map((t) => String(t).toLowerCase().replace(/\s+/g, '_'));
  const forbiddenTags = (opts.forbiddenTags ?? []).map((t) => String(t).toLowerCase().replace(/\s+/g, '_'));
  const method = opts.method ?? 'natural';
  const rules = opts.rules ?? getRuleset();
  const baseTags = state?.baseTags ?? opts.baseTags ?? [];
  const ilvl = state?.itemLevel ?? opts.ilvl ?? 1;
  const occupied = toGroupSet(
    opts.occupiedGroups ?? collectOccupiedGroups([...(state?.prefixes ?? []), ...(state?.suffixes ?? [])])
  );
  if (harvestRespectsCannotRoll(rules) && (method === 'harvest' || method === 'harvest-reforge')) {
    for (const m of state?.metacrafts ?? []) {
      const s = String(m).toLowerCase();
      if (s.includes('cannot roll attack')) forbiddenTags.push('attack');
      if (s.includes('cannot roll caster')) forbiddenTags.push('caster');
    }
  }
  const rows = [];
  for (const mod of spawnableMods(kb, baseTags)) {
    if (generation && mod.generation !== generation) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    if (blockedByOccupied(mod, occupied)) continue;
    const tags = (mod.tags ?? []).map((t) => String(t).toLowerCase().replace(/\s+/g, '_'));
    if (requiredTags.length && !requiredTags.some((t) => tags.includes(t))) continue;
    if (forbiddenTags.some((t) => tags.includes(t))) continue;
    const w = kb.weightOnTags?.(mod, baseTags) ?? 0;
    if (!(w > 0)) continue;
    rows.push({
      id: mod.id,
      name: mod.name,
      text: (mod.text ?? '').split('\n')[0],
      generation: mod.generation,
      groups: mod.groups ?? [],
      tags: mod.tags ?? [],
      weight: w,
      required_level: mod.required_level ?? 0,
    });
  }
  rows.sort((a, b) => b.weight - a.weight || (b.required_level ?? 0) - (a.required_level ?? 0));
  const total = rows.reduce((s, r) => s + r.weight, 0);
  return { total, rows };
}

export function formatEligiblePool(pool, harvestName = 'Harvest', limit = 12) {
  if (!pool?.rows?.length) return `Eligible ${harvestName} pool (current state): empty.`;
  const show = pool.rows.slice(0, limit);
  const more = pool.rows.length > limit ? `; +${pool.rows.length - limit} more` : '';
  const lines = show.map((r) => `${r.text} ${r.weight}`).join('; ');
  return `Eligible ${harvestName} pool (current state, weight ${pool.total}): ${lines}${more}.`;
}

/**
 * Odds that a harvest-forced tagged roll is this goal (tier+higher) among the harvest tag pool.
 * `occupiedGroups` excludes already-filled affix groups from the pool.
 */
export function harvestGoalOdds(kb, baseTags, ilvl, goal, harvest, modMatchesHarvest, occupiedGroups = []) {
  const gen = goal.gen ?? goal.match?.generation ?? 'prefix';
  const ban = toGroupSet(occupiedGroups);
  const tagPool = harvestPoolWeight(kb, baseTags, ilvl, gen, harvest, modMatchesHarvest, occupiedGroups);
  const odds = goalOdds(kb, baseTags, ilvl, goal, tagPool, gen, occupiedGroups);
  const kbMod = odds.kbMod || resolveNaturalMod(kb, goal, gen);
  if (blockedByOccupied(kbMod ?? goal, ban)) {
    return { ...odds, hitWeight: 0, poolWeight: tagPool, pRoll: 0, poolLabel: `${harvest.name} pool` };
  }
  const line = modLineKey({
    generation: gen,
    groups: kbMod.groups ?? goal.groups ?? [],
    text: kbMod.text ?? goal.text,
    required_level: kbMod.required_level ?? goal.reqLevel ?? 1,
  });
  let hit = 0;
  const minLvl = Math.max(kbMod.required_level ?? 0, goal.reqLevel ?? 0, 1);
  for (const mod of spawnableMods(kb, baseTags)) {
    if (mod.generation !== gen) continue;
    if ((mod.required_level ?? 0) < minLvl || (mod.required_level ?? 0) > ilvl) continue;
    if (modLineKey(mod) !== line) continue;
    if (blockedByOccupied(mod, ban)) continue;
    if (!modMatchesHarvest(mod, harvest)) continue;
    hit += kb.weightOnTags(mod, baseTags);
  }
  const pRoll = hit / tagPool;
  return {
    ...odds,
    hitWeight: hit,
    poolWeight: tagPool,
    pRoll,
    poolLabel: `${harvest.name} pool`,
  };
}

export function essenceFishExpected(kb, baseTags, ilvl, generation, goalMods, extraRolls = 2, occupiedGroups = []) {
  const pool = poolWeightMinusGroups(kb, baseTags, ilvl, generation, occupiedGroups);
  const goals = goalMods.map((g) => {
    const o = goalOdds(kb, baseTags, ilvl, g, pool, generation, occupiedGroups);
    return {
      ...o,
      weight: o.hitWeight,
      pool,
      pHave: jointAndInDraws([o.hitWeight], pool, extraRolls),
    };
  });

  // Zero-weight goals are impossible — exclude from joint success (never treat as free).
  const positive = goals.filter((g) => (g.hitWeight ?? 0) > 0);
  const pAll =
    goals.length === 0
      ? 1
      : positive.length < goals.length
        ? 0
        : jointAndInDraws(
            positive.map((g) => g.hitWeight),
            pool,
            extraRolls
          );

  return {
    pool,
    extraRolls,
    goals,
    zeroWeight: goals.filter((g) => !(g.hitWeight > 0)),
    pAll: goals.length && positive.length < goals.length ? 0 : Math.max(pAll, 1e-15),
    expected: goals.length && positive.length < goals.length ? 5000 : expectedAttempts(pAll, 5000),
    weightSummary: formatGoalsWeights(goals),
  };
}

/**
 * Combine independent prefix/suffix essence-fish maths (sides roll separately on a rare).
 * `parts` = essenceFishExpected results per generation.
 */
export function combineEssenceFishParts(parts) {
  const list = (parts ?? []).filter(Boolean);
  if (!list.length) return null;
  const goals = list.flatMap((p) => p.goals ?? []);
  const zeroWeight = list.flatMap((p) => p.zeroWeight ?? []);
  const pAll = list.reduce((acc, p) => acc * (p.pAll ?? 0), 1);
  const impossible = list.some((p) => (p.goals ?? []).some((g) => !(g.hitWeight > 0)));
  return {
    pool: list[0].pool,
    extraRolls: list[0].extraRolls,
    goals,
    zeroWeight,
    parts: list,
    pAll: impossible ? 0 : Math.max(pAll, 1e-15),
    expected: impossible ? 5000 : expectedAttempts(pAll, 5000),
    weightSummary: formatGoalsWeights(goals),
  };
}

/** Fish goals grouped by generation, each against its own pool.
 * `extraRolls` may be a number or `{ prefix, suffix }` from affix-count distributions.
 */
export function multiGenEssenceFishExpected(kb, baseTags, ilvl, goalMods, extraRolls = 2, occupiedGroups = []) {
  const byGen = { prefix: [], suffix: [] };
  for (const g of goalMods ?? []) {
    const gen = g.gen ?? g.match?.generation;
    if (gen === 'prefix' || gen === 'suffix') byGen[gen].push(g);
  }
  const rollsOf = (gen) =>
    typeof extraRolls === 'object' && extraRolls
      ? Number(extraRolls[gen] ?? 2)
      : Number(extraRolls ?? 2);
  const parts = [];
  for (const gen of ['prefix', 'suffix']) {
    if (!byGen[gen].length) continue;
    parts.push(essenceFishExpected(kb, baseTags, ilvl, gen, byGen[gen], rollsOf(gen), occupiedGroups));
  }
  return combineEssenceFishParts(parts);
}

/** Alt/aug on magic: one roll per alt from generation pool. */
export function altExpected(kb, baseTags, ilvl, goal, occupiedGroups = []) {
  const gen = goal.gen ?? goal.match?.generation ?? 'prefix';
  const pool = generationPoolWeight(kb, baseTags, ilvl, gen, occupiedGroups);
  const o = goalOdds(kb, baseTags, ilvl, goal, pool, gen);
  const expected = expectedAttempts(o.pRoll, 5000);
  return {
    ...o,
    expected: Number.isFinite(expected) ? expected : 5000,
    weightSummary: formatWeight(o.hitWeight, o.poolWeight),
  };
}

/**
 * Eldritch Chaos side reforge: CoE AND-columns on one side.
 * Assumes a full rare side (3 draws) so multi-mod finishes are possible —
 * same closed form CoE uses when the side has three affix slots.
 */
export function eldritchSideExpected(kb, baseTags, ilvl, generation, goalMods, rolls, occupiedGroups = []) {
  const n = Math.max(rolls ?? 0, goalMods.length, 3);
  const math = essenceFishExpected(kb, baseTags, ilvl, generation, goalMods, n, occupiedGroups);
  return {
    ...math,
    rolls: n,
    expected: Math.min(math.expected, 50000),
    weightSummary: math.weightSummary,
  };
}

export function exaltExpected(kb, baseTags, ilvl, goal, occupiedGroups = []) {
  const gen = goal.gen ?? goal.match?.generation ?? 'prefix';
  const pool = generationPoolWeight(kb, baseTags, ilvl, gen, occupiedGroups);
  const o = goalOdds(kb, baseTags, ilvl, goal, pool, gen);
  const expected = expectedAttempts(o.pRoll, 5000);
  return {
    ...o,
    expected: Number.isFinite(expected) ? expected : 5000,
    weightSummary: formatWeight(o.hitWeight, o.poolWeight),
  };
}

/** Influence-only generation pool (Conqueror / Shaper / Elder exalt slam). */
export function influenceGenerationPoolWeight(
  kb,
  baseTags,
  ilvl,
  generation,
  influence,
  occupiedGroups = []
) {
  const ban = toGroupSet(occupiedGroups);
  const infKey = String(influence ?? '').toLowerCase();
  let total = 0;
  for (const mod of kb.influence ?? []) {
    if (mod.generation !== generation) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    if (blockedByOccupied(mod, ban)) continue;
    if (!(mod.influences ?? []).some((i) => String(i).toLowerCase() === infKey)) continue;
    const w = kb.weightOnTags(mod, baseTags);
    if (w > 0) total += w;
  }
  return Math.max(total, 1);
}

/**
 * Odds for an influence Exalted Orb slam into an open affix slot.
 * Pool = influence mods of that influence + generation only (not natural).
 */
export function influenceSlamExpected(kb, baseTags, ilvl, goal, influence, occupiedGroups = []) {
  const gen = goal.gen ?? goal.match?.generation ?? 'suffix';
  const pool = influenceGenerationPoolWeight(kb, baseTags, ilvl, gen, influence, occupiedGroups);
  const seed = goal.match?.id ? goal.match : goal;
  const line = modLineKey(seed);
  const minLvl = seed.required_level ?? goal.reqLevel ?? 1;
  const infKey = String(influence ?? '').toLowerCase();
  let hitWeight = 0;
  for (const mod of kb.influence ?? []) {
    if (mod.generation !== gen) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    if ((mod.required_level ?? 0) < minLvl) continue;
    if (modLineKey(mod) !== line) continue;
    if (!(mod.influences ?? []).some((i) => String(i).toLowerCase() === infKey)) continue;
    if (blockedByOccupied(mod, toGroupSet(occupiedGroups))) continue;
    const w = kb.weightOnTags(mod, baseTags);
    if (w > 0) hitWeight += w;
  }
  const pRoll = hitWeight > 0 ? hitWeight / pool : 0;
  const expected = expectedAttempts(pRoll, 500);
  return {
    hitWeight,
    poolWeight: pool,
    pRoll,
    expected,
    generation: gen,
    weightSummary: formatWeight(hitWeight, pool),
  };
}

/** Outcome key for one unveil line (type / exclusive group). */
function unveilOutcomeKey(mod) {
  return mod.type || mod.groups?.[0] || mod.id;
}

/**
 * P(desired appears in `choices` independent rolls at p = hitWeight/poolWeight).
 * P = 1 − (1−p)^choices. Uniform equal weights ⇒ p = 1/N.
 */
export function weightedHitInChoices(outcomes, hitKey, choices = 3) {
  const items = (outcomes ?? []).filter((o) => o.weight > 0 && o.key != null);
  const hit = items.find((o) => o.key === hitKey);
  if (!hit) return 0;
  const totalW = items.reduce((s, o) => s + o.weight, 0);
  if (!(totalW > 0)) return 0;
  const p = hit.weight / totalW;
  return Math.max(0, Math.min(1, 1 - (1 - p) ** choices));
}

function matchUnveilHitKey(outcomes, goal) {
  const gId = goal.match?.id ?? goal.id;
  const gType = goal.match?.type ?? goal.type;
  const gGroups = new Set(goal.groups ?? goal.match?.groups ?? []);
  for (const o of outcomes) {
    if (gId && o.mod?.id === gId) return o.key;
  }
  for (const o of outcomes) {
    if (gType && o.mod?.type === gType) return o.key;
  }
  for (const o of outcomes) {
    if (gGroups.size && (o.mod?.groups ?? []).some((g) => gGroups.has(g))) return o.key;
  }
  const text = String(goal.text ?? goal.match?.text ?? '').toLowerCase();
  if (text) {
    for (const o of outcomes) {
      if (String(o.mod?.text ?? '').toLowerCase() === text) return o.key;
    }
  }
  return null;
}

/**
 * Unveil EV: 3 independent rolls at p = hit/pool → P = 1 − (1−p)³.
 * Fallback when the target is missing from KB pool: uniform p = 1/N (N≥15).
 */
export function unveilExpected(kb, baseTags, ilvl, goal, occupiedGroups = [], choices = 3) {
  const gen = goal.gen ?? goal.match?.generation ?? 'prefix';
  const ban = toGroupSet(occupiedGroups);
  const byKey = new Map();
  for (const mod of kb.unveiled ?? []) {
    if (mod.generation !== gen) continue;
    if ((mod.required_level ?? 0) > ilvl) continue;
    if (blockedByOccupied(mod, ban)) continue;
    const w = kb.weightOnTags(mod, baseTags);
    if (!(w > 0)) continue;
    const key = unveilOutcomeKey(mod);
    const cur = byKey.get(key);
    if (!cur || w > cur.weight) byKey.set(key, { key, weight: w, mod });
  }
  const outcomes = [...byKey.values()];
  const hitKey = matchUnveilHitKey(outcomes, goal);
  const hit = hitKey ? outcomes.find((o) => o.key === hitKey) : null;
  const hitWeight = hit?.weight ?? 0;
  const poolWeight = outcomes.reduce((s, o) => s + o.weight, 0);
  const poolSize = outcomes.length;

  let p = 0;
  let pRoll = 0;
  let approx = false;
  let unknown = false;
  if (hitWeight > 0 && poolWeight > 0) {
    p = hitWeight / poolWeight;
    pRoll = weightedHitInChoices(outcomes, hitKey, choices);
  } else {
    unknown = true;
    approx = true;
  }

  const expected = unknown ? Infinity : expectedAttempts(pRoll, 200);
  const anyPct = unknown ? '?' : (pRoll * 100).toFixed(pRoll >= 0.1 ? 1 : 2);
  const frac = unknown ? 'unranked' : `${hitWeight}/${poolWeight}`;
  const weightSummary = unknown
    ? `unveil probability unknown — unranked`
    : `${choices}× (${frac}) → ~${anyPct}%/unveil (~${expected} expected)`;

  return {
    pRoll,
    pSingle: p,
    hitWeight,
    poolWeight: Math.max(poolWeight, 1),
    poolSize,
    choices,
    expected,
    approx,
    unknown,
    weightSummary,
    weightLine: weightSummary,
  };
}

/** Natural pool for a generation, excluding mods whose groups intersect `blocked`. */
export function poolWeightMinusGroups(kb, baseTags, ilvl, generation, blocked = []) {
  return generationPoolWeight(kb, baseTags, ilvl, generation, blocked);
}

/**
 * Pick a cannot-roll metacraft (attack/caster/…) that shrinks the exalt pool without
 * zeroing any remaining goal. Score = absolute weight removed; require ≥ minFraction.
 * Generic over KB constraints — not hardcoded to attack.
 */
export function bestCannotRollAssist(kb, baseTags, ilvl, generation, goals, opts = {}) {
  const minFraction = opts.minFraction ?? 0.25;
  const occupied = opts.occupiedGroups ?? [];
  const preferBlocked = new Set(
    (opts.preferBlockedTags ?? []).map((t) => String(t).toLowerCase().replace(/\s+/g, '_'))
  );
  const list = (goals ?? []).filter(Boolean);
  if (!list.length || !generation) return null;

  const poolBefore = generationPoolWeight(kb, baseTags, ilvl, generation, occupied);
  if (!(poolBefore > 0)) return null;

  let best = null;
  for (const c of kb.cannotRoll ?? []) {
    if (c.legacy) continue;
    const blocked = c.blocked_tags ?? [];
    if (!blocked.length) continue;
    // Skip constraints that are not bench/metacraft tag blocks (e.g. level-28 only).
    if (c.max_required_level != null && !blocked.length) continue;

    const tagged = [
      ...(baseTags ?? []),
      ...blocked.map((t) => `__block_tag__:${t}`),
    ];
    let ok = true;
    for (const g of list) {
      const seed = g.match?.id ? g.match : g.match?.matched ? g.match : g;
      const tw = weightTierAndAbove(
        kb,
        {
          generation: seed.generation ?? g.gen ?? generation,
          groups: seed.groups ?? g.groups,
          // Prefer KB tier floor + KB text so paste "50%" matches "(43-50)%" line keys.
          required_level: seed.required_level ?? g.reqLevel ?? 1,
          text: seed.text ?? g.text,
        },
        tagged,
        ilvl
      );
      if (!(tw.weight > 0)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const poolAfter = generationPoolWeight(kb, tagged, ilvl, generation, occupied);
    const removed = Math.max(0, poolBefore - poolAfter);
    const fraction = removed / poolBefore;
    if (fraction < minFraction - 1e-12) continue;
    const preferBoost = blocked.some((t) => preferBlocked.has(String(t).toLowerCase())) ? 1 : 0;
    if (
      !best ||
      preferBoost > best.preferBoost ||
      (preferBoost === best.preferBoost &&
        (removed > best.removedWeight + 1e-9 ||
          (Math.abs(removed - best.removedWeight) < 1e-9 && fraction > best.fraction)))
    ) {
      best = {
        id: c.id,
        name: c.name || c.detect?.[0] || c.id,
        metacraftId: c.metacraft_id || c.id,
        blockedTags: blocked,
        poolBefore,
        poolAfter: Math.max(poolAfter, 1),
        removedWeight: removed,
        fraction,
        tags: tagged,
        preferBoost,
      };
    }
  }
  return best;
}

/** Infer prefix/suffix for crafted mods (RePoE marks many as generation "unique"). */
export function inferCraftGeneration(kb, mod) {
  const groups = new Set(mod?.groups ?? []);
  if (!groups.size) return null;
  let p = 0;
  let s = 0;
  for (const n of kb.natural) {
    if (!(n.groups ?? []).some((g) => groups.has(g))) continue;
    if (n.generation === 'prefix') p++;
    else if (n.generation === 'suffix') s++;
  }
  if (p === 0 && s === 0) return null;
  return p >= s ? 'prefix' : 'suffix';
}

/**
 * Best bench craft to occupy a high-weight natural group before an open-slot slam.
 * Picks the craftable mod on this item class / generation whose groups are disjoint
 * from `avoidGroups` and remove the most weight from the current slam pool.
 */
export function bestBlockCraft(kb, itemClass, baseTags, ilvl, generation, avoidGroups = [], occupiedGroups = []) {
  if (!itemClass || !generation) return null;
  const avoid = avoidGroups instanceof Set ? avoidGroups : new Set(avoidGroups);
  const occupied = occupiedGroups instanceof Set ? occupiedGroups : new Set(occupiedGroups);
  const poolBefore = poolWeightMinusGroups(kb, baseTags, ilvl, generation, occupied);
  let best = null;

  for (const opt of kb.bench ?? []) {
    const add = opt.add_explicit_mod;
    if (!add?.modId) continue;
    if (!(opt.item_classes ?? []).includes(itemClass)) continue;
    const mod = kb.modById?.get(add.modId);
    if (!mod?.groups?.length) continue;
    const text = shortText(add.text || mod.text);
    if (!text || isMetaOrUtilityCraft(text)) continue;
    const gen = add.generation === 'prefix' || add.generation === 'suffix'
      ? add.generation
      : inferCraftGeneration(kb, mod);
    if (gen !== generation) continue;
    if (mod.groups.some((g) => avoid.has(g))) continue;

    let blockedWeight = 0;
    const gset = new Set(mod.groups);
    for (const n of kb.natural) {
      if (n.generation !== generation) continue;
      if ((n.required_level ?? 0) > ilvl) continue;
      if ((n.groups ?? []).some((g) => occupied.has(g))) continue;
      if (!(n.groups ?? []).some((g) => gset.has(g))) continue;
      const w = kb.weightOnTags(n, baseTags);
      if (w > 0) blockedWeight += w;
    }
    if (blockedWeight <= 0) continue;
    if (!best || blockedWeight > best.blockedWeight) {
      best = {
        text,
        groups: mod.groups,
        blockedWeight,
        poolBefore,
        poolAfter: Math.max(poolBefore - blockedWeight, 1),
        modId: add.modId,
      };
    }
  }
  return best;
}

function shortText(t) {
  return String(t ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' | ');
}

function isMetaOrUtilityCraft(text) {
  return /cannot be changed|multiple crafted|sockets?|quality|to level of|trigger|curse skills|brand skills|remove crafted/i.test(
    text
  );
}
