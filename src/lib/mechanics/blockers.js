/**
 * Universal bench blockers for additive ops.
 * Crafted / cannot-roll metacrafts shrink eligible pools for exalt, harvest add, fossils, etc.
 */
import { allAffixes } from '../craftState.js';

/** Tags blocked by active cannot-roll metacrafts / crafted blockers. */
export function benchBlockedTags(state, kb) {
  const out = new Set();
  for (const m of state.metacrafts ?? []) {
    if (/cannot roll attack/i.test(m)) out.add('attack');
    if (/cannot roll caster/i.test(m)) out.add('caster');
  }
  const constraints = kb?.cannotRoll ?? [];
  for (const c of constraints) {
    const detect = c.detect ?? [];
    const hit = detect.some((d) =>
      (state.metacrafts ?? []).some((m) => String(m).toLowerCase().includes(String(d).toLowerCase()))
    );
    if (hit) for (const t of c.blocked_tags ?? []) out.add(String(t).toLowerCase());
  }
  for (const a of allAffixes(state)) {
    if (!a.crafted) continue;
    for (const t of a.tags ?? []) {
      if (/block|cannot/i.test(t)) out.add(String(t).toLowerCase());
    }
  }
  return [...out];
}

/** Groups already occupied — additive ops must not re-roll them. */
export function additiveOccupied(state) {
  const g = new Set();
  for (const a of allAffixes(state)) {
    for (const x of a.groups ?? []) g.add(x);
  }
  return g;
}

/**
 * Whether an additive method can place a mod given current bench/metacraft blockers.
 */
export function additiveAllowed(mod, state, kb) {
  const blocked = new Set(benchBlockedTags(state, kb));
  const tags = (mod.tags ?? []).map((t) => String(t).toLowerCase().replace(/\s+/g, '_'));
  if (tags.some((t) => blocked.has(t))) return false;
  const occ = additiveOccupied(state);
  if ((mod.groups ?? []).some((g) => occ.has(g))) return false;
  return true;
}
