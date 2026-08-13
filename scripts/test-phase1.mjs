import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/data/prices/daily.json')) {
    const path = join(root, 'public/data/prices/daily.json');
    if (existsSync(path)) {
      const body = readFileSync(path, 'utf8');
      return { ok: true, json: async () => JSON.parse(body) };
    }
    return {
      ok: true,
      json: async () => ({
        fetchedAt: new Date().toISOString(),
        league: 'test',
        prices: {
          chaos: 1,
          divine: 200,
          exalt: 15,
          'essence-deafening': 8,
          'eldritch-chaos': 25,
          'warlord-exalt': 180,
          gold: 0.001,
          'thaumaturgic-dust': 0.001,
        },
      }),
    };
  }
  if (u.includes('/data/prices/')) return { ok: false, status: 404 };
  const m = u.match(/\/data\/knowledge\/(.+)$/);
  if (!m) throw new Error(`unexpected fetch ${url}`);
  const path = join(root, 'public/data/knowledge', m[1]);
  if (!existsSync(path)) {
    if (/mods-(jewels|flasks|remainder)\.json$/.test(m[1])) return { ok: false, status: 404 };
    if (/harvest-menu-official|beastcraft-official|affix-count-distributions|operators-preconditions/.test(m[1])) {
      return { ok: true, json: async () => ({ crafts: [], recipes: [], methods: {}, operators: {}, sourceCompatibility: {} }) };
    }
    throw new Error(`missing ${path}`);
  }
  const body = readFileSync(path, 'utf8');
  return { ok: true, json: async () => JSON.parse(body) };
};

const { loadKnowledgeBase } = await import('../src/lib/knowledgeLoader.js');
const { runMechanicsTests } = await import('../tests/mechanics.mjs');
const { runPhase3MechanicsTests } = await import('../tests/mechanics-phase3.mjs');
const { runOptimizerTests } = await import('../tests/optimizer.mjs');

const kb = await loadKnowledgeBase();
await runMechanicsTests(kb);
await runPhase3MechanicsTests(kb);
await runOptimizerTests(kb);
console.log('OK: phase1+phase3 tests passed');
