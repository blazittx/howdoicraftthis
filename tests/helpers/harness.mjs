/**
 * Shared Node harness: disk-backed fetch mock + KB load.
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const STUB_PRICES = {
  fetchedAt: new Date().toISOString(),
  league: 'test',
  prices: {
    chaos: 1,
    divine: 200,
    exalt: 15,
    alteration: 0.1,
    transmute: 0.01,
    annul: 0.5,
    alchemy: 0.05,
    regal: 0.15,
    'essence-deafening': 8,
    'essence-shrieking': 1.5,
    'eldritch-chaos': 25,
    harvest: 40,
    veiled: 50,
    'veiled-chaos': 40,
    'warlord-exalt': 180,
    'crusader-exalt': 180,
    'hunter-exalt': 180,
    'redeemer-exalt': 180,
    gold: 0.001,
    'thaumaturgic-dust': 0.001,
  },
};

export function installFetchMock() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/data/prices/daily.json')) {
      const path = join(ROOT, 'public/data/prices/daily.json');
      if (existsSync(path)) {
        return { ok: true, json: async () => JSON.parse(readFileSync(path, 'utf8')) };
      }
      return { ok: true, json: async () => STUB_PRICES };
    }
    if (u.includes('/data/prices/')) return { ok: false, status: 404 };
    const m = u.match(/\/data\/knowledge\/(.+)$/);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const path = join(ROOT, 'public/data/knowledge', m[1]);
    if (!existsSync(path)) {
      if (
        /mods-(jewels|flasks|remainder)\.json$/.test(m[1]) ||
        /beastcraft-official|affix-count-distributions|operators-preconditions|harvest-menu-official|operators\.json|craft-operators/.test(
          m[1]
        )
      ) {
        return { ok: false, status: 404 };
      }
      throw new Error(`missing ${path}`);
    }
    return { ok: true, json: async () => JSON.parse(readFileSync(path, 'utf8')) };
  };
}

let kbCache = null;

export async function loadTestKb() {
  if (kbCache) return kbCache;
  installFetchMock();
  const { loadKnowledgeBase } = await import('../../src/lib/knowledgeLoader.js');
  kbCache = await loadKnowledgeBase();
  return kbCache;
}

export function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

export function readSrc(...parts) {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}
