/**
 * Market / trade pricing stub (§67, §81).
 *
 * Phase 1: currency EV only; item/base trade prices are unknown.
 * Phase 2: wire official PoE trade / public APIs with rate-limit compliance.
 *
 * NEVER invent a premium (e.g. 50c influenced base). Return unknown.
 */

export const TRADE_STATUS = {
  unknown: 'unknown',
  unsupported: 'unsupported',
  stub: 'stub',
};

/**
 * @param {{ baseName?: string, itemClass?: string, influences?: string[], fractured?: boolean, league?: string }} query
 * @returns {{ priceChaos: null, status: string, reason: string, phase: number }}
 */
export function lookupItemTradePrice(query = {}) {
  const bits = [];
  if (query.baseName) bits.push(query.baseName);
  if (query.influences?.length) bits.push(`influenced:${query.influences.join('+')}`);
  if (query.fractured) bits.push('fractured');
  return {
    priceChaos: null,
    status: TRADE_STATUS.unknown,
    reason: `Item trade price unknown until Phase 2 market integration${bits.length ? ` (${bits.join(', ')})` : ''}. Not inventing a premium.`,
    phase: 1,
    query,
  };
}

/** Influenced / fractured base acquisition — always unranked without trade. */
export function baseAcquisitionPrice(opts = {}) {
  const trade = lookupItemTradePrice(opts);
  return {
    ...trade,
    ranked: false,
    recommend: opts.influences?.length ? 'unranked-buy-or-orb' : 'unranked-buy',
  };
}
