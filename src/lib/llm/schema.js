/**
 * Hand validation for LLM advisor output.
 * Rejects advice that invents gold/dust/p%/chaos contradicting payload invariants.
 */

const ALLOWED_KINDS = new Set([
  'searchHint', // donor partitions / search expansions for the optimizer to try
  'evFlag', // inconsistency between provided EV fields
  'explain', // why winner beat loser (cite provided numbers only)
  'macroExpand', // finishing macros to expand in search
]);

function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function approxEq(a, b, eps = 0.51) {
  if (!isFiniteNum(a) || !isFiniteNum(b)) return false;
  return Math.abs(a - b) <= eps;
}

/** Collect numeric invariants the model must not contradict. */
export function collectInvariants(payload) {
  const inv = new Map();
  const best = payload?.best ?? {};
  const dbg = payload?.solverDebug ?? best.solverDebug ?? {};
  const eco = best.economics ?? payload?.economics ?? {};

  const put = (key, val) => {
    if (isFiniteNum(val)) inv.set(key, val);
  };

  put('best.totalCost', best.totalCost);
  put('best.totalExpectedTradableCostChaos', best.totalExpectedTradableCostChaos);
  put('best.totalExpectedEconomicCostChaos', best.totalExpectedEconomicCostChaos);
  put('solverDebug.V', dbg.V);
  put('solverDebug.Qsequential', dbg.Qsequential);
  put('solverDebug.Qunpredictable', dbg.Qunpredictable);
  put('solverDebug.Qpredictable', dbg.Qpredictable);
  put('economics.expectedGold', best.expectedGold ?? eco.expectedGold);
  put('economics.expectedDust', best.expectedDust ?? eco.expectedDust);
  put('economics.dustChaosEquivalent', best.dustChaosEquivalent ?? eco.dustChaosEquivalent);
  put('economics.goldOpportunityChaosEquivalent', best.goldOpportunityChaosEquivalent ?? eco.goldOpportunityChaosEquivalent);

  for (const r of payload?.rejected ?? best.rejectedStrategies ?? []) {
    if (r?.id != null && isFiniteNum(r.ev)) inv.set(`rejected.${r.id}.ev`, r.ev);
  }
  for (const a of payload?.candidates ?? []) {
    if (a?.id != null && isFiniteNum(a.totalCost ?? a.ev)) {
      inv.set(`candidate.${a.id}.ev`, a.totalCost ?? a.ev);
    }
  }
  return inv;
}

/**
 * @param {unknown} raw
 * @param {{ invariants?: Map<string, number> }} [ctx]
 * @returns {{ ok: true, advice: object } | { ok: false, errors: string[] }}
 */
export function validateAdvice(raw, ctx = {}) {
  const errors = [];
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, errors: ['advice must be an object'] };
  }

  const notes = Array.isArray(raw.notes) ? raw.notes : [];
  const items = Array.isArray(raw.items) ? raw.items : notes.length ? notes.map((n) => ({ kind: 'explain', text: String(n) })) : [];

  if (!items.length && typeof raw.summary !== 'string') {
    return { ok: false, errors: ['advice needs items[] or summary'] };
  }

  const invariants = ctx.invariants ?? new Map();
  const cleaned = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      errors.push('item must be object');
      continue;
    }
    const kind = String(item.kind ?? 'explain');
    if (!ALLOWED_KINDS.has(kind)) {
      errors.push(`disallowed kind: ${kind}`);
      continue;
    }
    const text = String(item.text ?? item.message ?? '').trim();
    if (!text) {
      errors.push('empty text');
      continue;
    }

    // Reject invented numeric claims that contradict payload invariants.
    if (item.cited && typeof item.cited === 'object') {
      for (const [k, v] of Object.entries(item.cited)) {
        if (!isFiniteNum(v)) continue;
        if (invariants.has(k) && !approxEq(v, invariants.get(k))) {
          errors.push(`cited ${k}=${v} contradicts invariant ${invariants.get(k)}`);
          continue;
        }
      }
    }

    // Soft reject: bare invented cost claims without citation keys when inventing round chaos.
    if (/\b~?\d+(\.\d+)?c\b/i.test(text) && !(item.cited && Object.keys(item.cited).length)) {
      // Allow if the number appears in invariants values
      const nums = [...text.matchAll(/~?(\d+(?:\.\d+)?)c\b/gi)].map((m) => Number(m[1]));
      const invVals = [...invariants.values()];
      const allKnown = nums.every((n) => invVals.some((iv) => approxEq(n, iv) || approxEq(n, Math.round(iv))));
      if (!allKnown) {
        errors.push(`uncited cost claim rejected: ${text.slice(0, 80)}`);
        continue;
      }
    }

    cleaned.push({
      kind,
      text,
      cited: item.cited && typeof item.cited === 'object' ? item.cited : undefined,
      searchHint: kind === 'searchHint' ? sanitizeSearchHint(item.searchHint ?? item.hint) : undefined,
      macroId: kind === 'macroExpand' ? String(item.macroId ?? item.id ?? '').slice(0, 80) || undefined : undefined,
    });
  }

  if (!cleaned.length && !raw.summary) {
    return { ok: false, errors: errors.length ? errors : ['no valid advice items'] };
  }

  return {
    ok: true,
    advice: {
      summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 500) : undefined,
      items: cleaned.slice(0, 12),
      // Never trust model ranking — UI must ignore these if present
      doesNotOverrideEv: true,
    },
    warnings: errors,
  };
}

function sanitizeSearchHint(h) {
  if (!h || typeof h !== 'object') return undefined;
  return {
    type: String(h.type ?? 'donorPartition').slice(0, 40),
    prefixes: Array.isArray(h.prefixes) ? h.prefixes.map(String).slice(0, 6) : undefined,
    suffixes: Array.isArray(h.suffixes) ? h.suffixes.map(String).slice(0, 6) : undefined,
    note: h.note ? String(h.note).slice(0, 200) : undefined,
  };
}
