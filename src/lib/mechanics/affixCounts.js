/**
 * Per-method affix-count distributions (§73). Data-driven from KB JSON.
 */
export function affixCountDistribution(kb, method) {
  const methods = kb?.affixCounts?.methods ?? {};
  return methods[method] ?? methods.chaos ?? { byTotal: [{ n: 4, p: 0.5 }, { n: 5, p: 0.33 }, { n: 6, p: 0.17 }] };
}

/**
 * Ways to split total affixes into (prefixes, suffixes) given already-kept counts.
 * Uniform among legal (p∈[0,3], s∈[0,3], p+s=n, p≥keptP, s≥keptS).
 */
export function sampleSideCounts(total, keptP = 0, keptS = 0) {
  const out = [];
  for (let p = keptP; p <= 3; p++) {
    const s = total - p;
    if (s < keptS || s > 3) continue;
    out.push({ prefixes: p, suffixes: s });
  }
  if (!out.length) return [{ prefixes: Math.min(3, keptP), suffixes: Math.min(3, keptS), p: 1 }];
  const p = 1 / out.length;
  return out.map((o) => ({ ...o, p }));
}

export function fossilAffixCounts(kb, sockets = 1) {
  const dist = affixCountDistribution(kb, 'fossil');
  const key = String(sockets);
  return dist.bySockets?.[key] ?? dist.byTotal ?? [{ n: 4, p: 1 }];
}

/**
 * Expected natural rolls on one side after `keptOnGen` already occupied (e.g. essence guarantee).
 * Uses §73 affix-count distribution — not a hardcoded "~2 extra".
 */
export function expectedExtraRolls(kb, method, gen, keptOnGen = 1) {
  const dist = affixCountDistribution(kb, method);
  const rows = dist.byTotal ?? [];
  if (!rows.length) return Math.max(0, 2 - Math.max(0, keptOnGen - 1));
  let exp = 0;
  let mass = 0;
  for (const row of rows) {
    const keptP = gen === 'prefix' ? keptOnGen : 0;
    const keptS = gen === 'suffix' ? keptOnGen : 0;
    const splits = sampleSideCounts(row.n, keptP, keptS);
    for (const s of splits) {
      const sideN = gen === 'prefix' ? s.prefixes : s.suffixes;
      const extra = Math.max(0, sideN - keptOnGen);
      exp += row.p * s.p * extra;
      mass += row.p * s.p;
    }
  }
  return mass > 0 ? exp / mass : 2;
}

/** Per-generation extra rolls for an essence fish (guarantee occupies essenceGen). */
export function essenceExtraRollsByGen(kb, essenceGen = 'prefix') {
  return {
    prefix: expectedExtraRolls(kb, 'essence', 'prefix', essenceGen === 'prefix' ? 1 : 0),
    suffix: expectedExtraRolls(kb, 'essence', 'suffix', essenceGen === 'suffix' ? 1 : 0),
  };
}
