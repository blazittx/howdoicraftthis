/**
 * §39 Monte Carlo helpers — sample analytic outcome dists and compare frequencies.
 * Default trials: 100_000 (documented). Override with MC_TRIALS (e.g. 1_000_000).
 */

export function mcTrials(defaultN = 100_000) {
  const env = Number(process.env.MC_TRIALS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return defaultN;
}

/** Sample one outcome index from {p} rows using CDF. */
export function sampleIndex(outcomes, rng = Math.random) {
  let r = rng();
  for (let i = 0; i < outcomes.length; i++) {
    r -= outcomes[i].p;
    if (r <= 0) return i;
  }
  return outcomes.length - 1;
}

/**
 * Run n trials; return empirical frequency per outcome index + max |emp-analytic|.
 */
export function monteCarloFrequencies(outcomes, n, rng = Math.random) {
  const counts = new Float64Array(outcomes.length);
  for (let t = 0; t < n; t++) counts[sampleIndex(outcomes, rng)]++;
  let maxAbs = 0;
  const freqs = [];
  for (let i = 0; i < outcomes.length; i++) {
    const emp = counts[i] / n;
    freqs.push(emp);
    maxAbs = Math.max(maxAbs, Math.abs(emp - outcomes[i].p));
  }
  return { freqs, maxAbs, n };
}

/**
 * Hoeffding-style absolute-error bound for multinomial frequencies.
 * With n trials, P(max_i |ê_i - p_i| > eps) is small for eps ≈ sqrt(ln(2k/δ)/(2n)).
 */
export function mcTolerance(n, k, delta = 1e-3) {
  const kk = Math.max(k, 1);
  return Math.sqrt(Math.log((2 * kk) / delta) / (2 * n)) + 2 / n;
}
