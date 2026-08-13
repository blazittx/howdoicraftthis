/**
 * Daily price snapshot helpers (poe.ninja → public/data/prices/daily.json).
 * Loaded once with the knowledge base — not fetched per craft query.
 */

import { formatMultiCost, multiDimensionCost } from './pricing/costs.js';

const STALE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIP = 'Run npm run fetch-prices to refresh public/data/prices/daily.json';

let pricesPromise = null;

export function pricesFetchTip() {
  return FETCH_TIP;
}

export function pricesAgeMs(snapshot) {
  if (!snapshot?.fetchedAt) return Infinity;
  const t = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

export function pricesStatus(snapshot) {
  if (!snapshot?.prices || typeof snapshot.prices !== 'object') {
    return { ok: false, stale: true, missing: true, tip: FETCH_TIP, message: `No price snapshot. ${FETCH_TIP}` };
  }
  const age = pricesAgeMs(snapshot);
  const stale = age > STALE_MS;
  const ageDays = age / (24 * 60 * 60 * 1000);
  const ageLabel =
    ageDays >= 1 ? `${Math.floor(ageDays)} day(s) old` : `${Math.max(1, Math.round(age / 3600000))}h old`;
  return {
    ok: true,
    stale,
    missing: false,
    ageMs: age,
    ageLabel,
    league: snapshot.league,
    fetchedAt: snapshot.fetchedAt,
    tip: stale ? `Price snapshot is ${ageLabel}. ${FETCH_TIP}` : null,
    message: stale ? `Prices are ${ageLabel}. Cost ranking may have changed. ${FETCH_TIP}` : null,
  };
}

async function fetchDailySnapshot() {
  const r = await fetch('/data/prices/daily.json');
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

/** Load once (or return cached). Never invents fake defaults. */
export async function loadDailyPrices() {
  if (!pricesPromise) {
    pricesPromise = fetchDailySnapshot().then((snap) => {
      if (!snap?.prices) return { snapshot: null, prices: null, status: pricesStatus(null) };
      return { snapshot: snap, prices: snap.prices, status: pricesStatus(snap) };
    });
  }
  return pricesPromise;
}

/** Test helper */
export function loadDailyPricesFrom(snapshot) {
  const status = pricesStatus(snapshot);
  pricesPromise = Promise.resolve({
    snapshot: snapshot ?? null,
    prices: snapshot?.prices ?? null,
    status,
  });
  return pricesPromise;
}

export function resetDailyPricesCache() {
  pricesPromise = null;
}

/** Chaos → Divines using snapshot `divine` chaos price. Null if rate missing. */
export function chaosToDivines(chaos, prices) {
  const rate = prices?.divine;
  if (chaos == null || rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round((chaos / rate) * 100) / 100;
}

/** Chaos → Mirrors using snapshot `mirror` chaos price. Null if rate missing. */
export function chaosToMirrors(chaos, prices) {
  const rate = prices?.mirror;
  if (chaos == null || rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round((chaos / rate) * 10000) / 10000;
}

/**
 * Primary total in Divines; hover details = chaos + mirror (needs prices.divine / prices.mirror).
 * @returns {{ primary: string, tipLines: string[], convertible: boolean }}
 */
export function formatCostCookie(chaosTotal, prices, dims = null) {
  if (dims) {
    const multi = formatMultiCost(dims);
    const div = chaosToDivines(dims.chaosEquivalent, prices);
    const tipLines = [multi];
    if (dims.chaosEquivalent != null) {
      const mir = chaosToMirrors(dims.chaosEquivalent, prices);
      if (mir != null) tipLines.push(`~${mir} Mirror`);
    }
    return {
      primary: div != null ? `~${div} Div` : multi,
      tipLines,
      convertible: div != null,
      multi,
    };
  }
  if (chaosTotal == null) {
    return { primary: 'unknown', tipLines: [], convertible: false };
  }
  const div = chaosToDivines(chaosTotal, prices);
  const mir = chaosToMirrors(chaosTotal, prices);
  const chaosLabel = `~${Math.round(chaosTotal * 100) / 100}c`;
  const tipLines = [chaosLabel];
  if (mir != null) tipLines.push(`~${mir} Mirror`);
  else tipLines.push('Mirror price missing from daily snapshot');

  if (div == null) {
    return {
      primary: chaosLabel,
      tipLines:
        prices?.divine == null
          ? ['Divine rate missing from daily snapshot', ...tipLines.slice(1)]
          : tipLines,
      convertible: false,
    };
  }
  return { primary: `~${div} Div`, tipLines, convertible: true };
}

export { multiDimensionCost, formatMultiCost };
