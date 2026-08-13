/**
 * Fetch a daily economy snapshot from poe.ninja (PoE1).
 * Writes public/data/prices/daily.json — loaded once by the app (not per craft).
 *
 * Usage: npm run fetch-prices [--league=Allflame]
 * Env:   POE_LEAGUE=Allflame
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../public/data/prices/daily.json');

const leagueArg = process.argv.find((a) => a.startsWith('--league='));
const LEAGUE = leagueArg?.slice('--league='.length) || process.env.POE_LEAGUE || 'Allflame';

const EXCHANGE = 'https://poe.ninja/poe1/api/economy/exchange/current/overview';
const STASH_CURRENCY = 'https://poe.ninja/poe1/api/economy/stash/current/currency/overview';

/** poe.ninja exchange id → app price key */
const CURRENCY_MAP = {
  chaos: 'chaos',
  divine: 'divine',
  mirror: 'mirror',
  'mirror-of-kalandra': 'mirror',
  exalted: 'exalt',
  alt: 'alteration',
  annul: 'annul',
  alch: 'alchemy',
  aug: 'augmentation',
  scour: 'scour',
  regal: 'regal',
  transmute: 'transmute',
  'veiled-exalted-orb': 'veiled',
  'veiled-chaos-orb': 'veiled-chaos',
  'eldritch-chaos-orb': 'eldritch-chaos',
  'eldritch-orb-of-annulment': 'eldritch-annul',
  'eldritch-exalted-orb': 'eldritch-exalt',
  'lesser-eldritch-ichor': 'eldritch-ichor',
  'lesser-eldritch-ember': 'eldritch-ember',
  'crusaders-exalted-orb': 'crusader-exalt',
  'redeemers-exalted-orb': 'redeemer-exalt',
  'hunters-exalted-orb': 'hunter-exalt',
  'warlords-exalted-orb': 'warlord-exalt',
  'shapers-exalted-orb': 'shaper-exalt',
  'elders-exalted-orb': 'elder-exalt',
  // short exchange ids (current)
  'wild-lifeforce': 'wild-lifeforce',
  'vivid-lifeforce': 'vivid-lifeforce',
  'primal-lifeforce': 'primal-lifeforce',
  'sacred-lifeforce': 'sacred-lifeforce',
  // longer stash-style ids if present on exchange
  'wild-crystallised-lifeforce': 'wild-lifeforce',
  'vivid-crystallised-lifeforce': 'vivid-lifeforce',
  'primal-crystallised-lifeforce': 'primal-lifeforce',
  'sacred-crystallised-lifeforce': 'sacred-lifeforce',
  gold: 'gold',
  'thaumaturgic-dust': 'thaumaturgic-dust',
};

const STASH_NAME_MAP = {
  'Divine Orb': 'divine',
  'Mirror of Kalandra': 'mirror',
  'Wild Crystallised Lifeforce': 'wild-lifeforce',
  'Vivid Crystallised Lifeforce': 'vivid-lifeforce',
  'Primal Crystallised Lifeforce': 'primal-lifeforce',
  'Sacred Crystallised Lifeforce': 'sacred-lifeforce',
  Gold: 'gold',
  'Thaumaturgic Dust': 'thaumaturgic-dust',
};

const FOSSIL_MAP = {
  'dense-fossil': 'fossil-dense',
  'hollow-fossil': 'fossil-hollow',
};

const ESSENCE_TIER_PREFIX = [
  ['deafening-', 'essence-deafening'],
  ['screaming-', 'essence-screaming'],
  ['shrieking-', 'essence-shrieking'],
  ['wailing-', 'essence-wailing'],
  ['weeping-', 'essence-weeping'],
  ['muttering-', 'essence-muttering'],
];

/** Keys the planner needs for EV — fetch fails if any are missing. */
const REQUIRED = [
  'chaos',
  'divine',
  'mirror',
  'exalt',
  'alteration',
  'annul',
  'alchemy',
  'augmentation',
  'scour',
  'regal',
  'transmute',
  'veiled',
  'veiled-chaos',
  'eldritch-chaos',
  'eldritch-annul',
  'eldritch-exalt',
  'eldritch-ichor',
  'eldritch-ember',
  'warlord-exalt',
  'redeemer-exalt',
  'crusader-exalt',
  'hunter-exalt',
  'shaper-exalt',
  'elder-exalt',
  'wild-lifeforce',
  'vivid-lifeforce',
  'primal-lifeforce',
  'essence-deafening',
  'essence-screaming',
  'essence-shrieking',
];

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function avg(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

async function main() {
  const prices = { chaos: 1, bench: 0, fossil: null };

  const currencyUrl = `${EXCHANGE}?league=${encodeURIComponent(LEAGUE)}&type=Currency`;
  const currency = await fetchJson(currencyUrl);
  const byId = Object.fromEntries((currency.lines ?? []).map((l) => [l.id, l.primaryValue]));

  for (const [id, key] of Object.entries(CURRENCY_MAP)) {
    const v = byId[id];
    if (v != null && Number.isFinite(v)) prices[key] = round4(v);
  }

  // Stash overview often has clearer chaosEquivalent for juice
  try {
    const stashUrl = `${STASH_CURRENCY}?league=${encodeURIComponent(LEAGUE)}&type=Currency`;
    const stash = await fetchJson(stashUrl);
    for (const line of stash.lines ?? []) {
      const key = STASH_NAME_MAP[line.currencyTypeName];
      if (!key) continue;
      const v = line.chaosEquivalent;
      if (v != null && Number.isFinite(v)) prices[key] = round4(v);
    }
  } catch (e) {
    console.warn('stash currency fallback skipped:', e.message);
  }

  const essence = await fetchJson(`${EXCHANGE}?league=${encodeURIComponent(LEAGUE)}&type=Essence`);
  for (const [prefix, key] of ESSENCE_TIER_PREFIX) {
    const vals = (essence.lines ?? [])
      .filter((l) => l.id?.startsWith(prefix))
      .map((l) => l.primaryValue)
      .filter((v) => Number.isFinite(v));
    const a = avg(vals);
    if (a != null) prices[key] = round4(a);
  }
  // Generic "essence" ≈ shrieking mid-tier stand-in for unknown tier
  if (prices['essence-shrieking'] != null) prices.essence = prices['essence-shrieking'];
  else if (prices['essence-deafening'] != null) prices.essence = prices['essence-deafening'];

  try {
    const fossil = await fetchJson(`${EXCHANGE}?league=${encodeURIComponent(LEAGUE)}&type=Fossil`);
    for (const [id, key] of Object.entries(FOSSIL_MAP)) {
      const line = (fossil.lines ?? []).find((l) => l.id === id);
      if (line?.primaryValue != null) prices[key] = round4(line.primaryValue);
    }
    if (prices['fossil-dense'] != null) prices.fossil = prices['fossil-dense'];
  } catch (e) {
    console.warn('fossil fetch skipped:', e.message);
  }

  const missing = REQUIRED.filter((k) => prices[k] == null || !Number.isFinite(prices[k]));
  if (missing.length) {
    console.error('Missing required prices:', missing.join(', '));
    console.error('Got keys:', Object.keys(prices).sort().join(', '));
    process.exit(1);
  }

  const snapshot = {
    league: LEAGUE,
    fetchedAt: new Date().toISOString(),
    source: 'poe.ninja',
    endpoints: {
      currency: currencyUrl,
      essence: `${EXCHANGE}?league=${encodeURIComponent(LEAGUE)}&type=Essence`,
      fossil: `${EXCHANGE}?league=${encodeURIComponent(LEAGUE)}&type=Fossil`,
    },
    note:
      'Unit prices in chaos. Harvest reforge EV = lifeforce amount × wild/vivid/primal-lifeforce. Metacraft Divines separate.',
    prices,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${OUT}`);
  console.log(`League ${LEAGUE} @ ${snapshot.fetchedAt}`);
  console.log(
    [
      `divine=${prices.divine}`,
      `mirror=${prices.mirror}`,
      `veiled=${prices.veiled}`,
      `wild=${prices['wild-lifeforce']}`,
      `vivid=${prices['vivid-lifeforce']}`,
      `primal=${prices['primal-lifeforce']}`,
      `deafening≈${prices['essence-deafening']}`,
      `eldritch-chaos=${prices['eldritch-chaos']}`,
    ].join('  ')
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
