export function probabilityMass(outcomes) {
  return (outcomes ?? []).reduce((s, o) => s + (Number(o.p) || 0), 0);
}

export function assertProbabilityMass(outcomes, eps = 1e-6) {
  const s = probabilityMass(outcomes);
  if (Math.abs(s - 1) > eps) throw new Error(`Σp=${s} ≠ 1`);
  return s;
}

export function normalizeOutcomes(outcomes, eps = 1e-12) {
  const list = (outcomes ?? []).filter((o) => o.p > eps && o.state);
  const z = probabilityMass(list);
  if (z <= 0) return list;
  if (Math.abs(z - 1) <= 1e-9) return list;
  return list.map((o) => ({ ...o, p: o.p / z }));
}
