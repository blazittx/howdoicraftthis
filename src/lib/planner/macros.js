/**
 * Entropy-reducing macro-actions (§7, §47).
 * Mechanically expandable — never item-specific recipes (§5, §94).
 */
import { analyzeTagSideClusters } from './heuristics.js';

export const ENTROPY_MACROS = [
  {
    id: 'protect+reforgeTag',
    risk: { canBrickKeeper: false, canDestroyInputs: false },
    expand(side, harvestId) {
      const lock = side === 'suffix' ? 'suffixesCannotBeChanged' : 'prefixesCannotBeChanged';
      return [
        { op: 'metacraft', id: lock },
        { op: 'harvestReforge', id: harvestId },
      ];
    },
  },
  {
    id: 'protect+unveil',
    risk: { canBrickKeeper: false, canDestroyInputs: false },
    expand(side) {
      const lock = side === 'suffix' ? 'suffixesCannotBeChanged' : 'prefixesCannotBeChanged';
      return [
        { op: 'metacraft', id: lock },
        { op: 'veiledExalt' },
        { op: 'unveil' },
      ];
    },
  },
  {
    id: 'cannotRoll+exalt',
    risk: { canBrickKeeper: false, canDestroyInputs: false },
    expand(tag) {
      return [
        { op: 'metacraft', id: 'cannotRoll', tag },
        { op: 'exalt' },
      ];
    },
  },
  {
    id: 'essenceFish+protect+reforge',
    risk: { canBrickKeeper: true, canDestroyInputs: false, restartRequiredProbability: null },
    expand(essenceKey, side, harvestId) {
      return [
        { op: 'essence', key: essenceKey },
        ...ENTROPY_MACROS[0].expand(side, harvestId),
      ];
    },
  },
];

export const MACRO_IDS = ENTROPY_MACROS.map((m) => m.id);

/** Expand a macro id into primitive ops; null if unknown. */
export function expandMacro(id, ...args) {
  const m = ENTROPY_MACROS.find((x) => x.id === id);
  return m ? m.expand(...args) : null;
}

/**
 * Discover entropy-reducing chain candidates from remaining goals.
 * Generic: shared harvest family + protect, unveil+protect, cannot-roll+exalt,
 * plus tag-overlap side-lock hints (finish clustered side → protect → open other).
 */
export function discoverEntropyChains(rem, ctx = {}) {
  const chains = [];
  const tagAnalysis = ctx.tagClusters ?? analyzeTagSideClusters(rem);
  const sideOrder = tagAnalysis.sideOrder ?? ['suffix', 'prefix'];
  const bySide = { prefix: [], suffix: [] };
  for (const m of rem ?? []) {
    const g = m.gen === 'suffix' ? 'suffix' : 'prefix';
    bySide[g].push(m);
  }
  for (const side of sideOrder) {
    const mods = bySide[side];
    if (mods.length < 2) continue;
    const harvests = new Map();
    for (const m of mods) {
      for (const h of m.harvests ?? []) {
        const id = h.id ?? h;
        if (!harvests.has(id)) harvests.set(id, []);
        harvests.get(id).push(m);
      }
    }
    for (const [hid, covered] of harvests) {
      if (covered.length < 2) continue;
      const tagHit = (tagAnalysis.clusters ?? []).find(
        (c) => c.side === side && covered.some((m) => (c.mods ?? []).includes(m))
      );
      chains.push({
        id: 'protect+reforgeTag',
        side,
        harvestId: hid,
        covered,
        tag: tagHit?.tag,
        ops: expandMacro('protect+reforgeTag', side, hid),
        why: tagHit
          ? `Tag cluster (${tagHit.tag}) on ${side}s → finish + protect, then ${hid}`
          : `Occupied groups + ${side} protect collapses ${hid} pool`,
      });
    }
  }
  for (const m of rem ?? []) {
    if (m.veiled || m.match?.source === 'unveiled') {
      const side = m.gen === 'prefix' ? 'suffix' : 'prefix';
      chains.push({
        id: 'protect+unveil',
        side,
        target: m,
        ops: expandMacro('protect+unveil', side),
        why: 'Native unveil under opposite-side protect',
      });
    }
  }
  if (ctx.cannotRollAssist) {
    chains.push({
      id: 'cannotRoll+exalt',
      ops: expandMacro('cannotRoll+exalt', ctx.cannotRollAssist),
      why: 'Cannot-roll assist then exalt',
    });
  }
  // Tag-overlap search hints: expand cannot-roll+exalt when a complement tag may shrink the open side.
  for (const c of (tagAnalysis.clusters ?? []).slice(0, 4)) {
    for (const blockTag of c.cannotRollHints ?? []) {
      const openGoals = bySide[c.oppositeSide] ?? [];
      if (!openGoals.length) continue;
      chains.push({
        id: 'cannotRoll+exalt',
        side: c.oppositeSide,
        tag: blockTag,
        fromCluster: { side: c.side, tag: c.tag },
        ops: expandMacro('cannotRoll+exalt', blockTag),
        why: `${c.side} ${c.tag} cluster locked → try cannot-roll ${blockTag} while exalting ${c.oppositeSide === 'suffix' ? 'suffixes' : 'prefixes'}`,
        searchHint: true,
      });
    }
  }
  return chains;
}
