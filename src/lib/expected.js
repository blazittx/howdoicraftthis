/** Geometric mean attempts. Internal EV uses 1/p; ceil/format is display-only. */

export function expectedAttempts(p, cap = Infinity) {
  if (!(p > 0)) return cap === Infinity ? Infinity : cap;
  if (p >= 1) return 1;
  const e = 1 / p;
  return cap < Infinity ? Math.min(e, cap) : e;
}

export function expectedAttemptsDisplay(p, cap = Infinity) {
  const e = expectedAttempts(p, cap);
  if (!Number.isFinite(e)) return e;
  return Math.max(1, Math.ceil(e));
}

/** Round expected-attempt floats for UI / plan text (keep full float in EV math). */
export function formatAttemptsDisplay(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(3);
}
