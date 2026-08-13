/**
 * Scaffold planDeterministic entry + modStableKey.
 */
import {
  loadKnowledgeBase,
  getBaseInfo,
  effectiveBaseTags,
  resolveCannotRoll,
} from '../../knowledgeLoader.js';
import { normalizeItemClass } from '../../itemClass.js';
import { enrichMod, minIlvlFromMods } from './candidates.js';
import { assignAndBuild } from './assignAndBuild.js';
import { modStableKey } from './helpers.js';

export async function planDeterministic(item, onProgress, opts = {}) {
  onProgress?.({ phase: 'loading-knowledge' });
  const kb = await loadKnowledgeBase();
  const base = getBaseInfo(kb, item.baseName);
  if (base?.name && base.name !== item.baseName) {
    item = { ...item, baseName: base.name };
  }
  const baseTags = effectiveBaseTags(item, base, kb.cannotRoll);
  const cannotRoll = resolveCannotRoll(item, base, kb.cannotRoll);
  const itemClass = base?.item_class ?? normalizeItemClass(item.itemClass);

  onProgress?.({ phase: 'matching-knowledge' });
  const sourceMods =
    item.enrichedMods?.length || item.enrichedCrafted?.length
      ? [
          ...(item.enrichedMods ?? []),
          ...(item.enrichedCrafted ?? []).map((m) =>
            typeof m === 'string' ? { text: m, crafted: true } : { ...m, crafted: true }
          ),
        ]
      : [
          ...(item.explicitMods ?? [])
            .map((m) => (typeof m === 'string' ? { text: m } : m))
            .filter((m) => !m.crafted),
          ...(item.craftedMods ?? item.crafted ?? item.explicitMods?.filter((m) => m.crafted) ?? []).map(
            (m) => (typeof m === 'string' ? { text: m, crafted: true } : { ...m, crafted: true })
          ),
        ];

  const ilvl = Math.max(item.itemLevel ?? 1, 1);
  let mods = sourceMods.map((m) => enrichMod(kb, item, m, baseTags, Math.max(ilvl, 86)));
  const { minIlvl, drivers } = minIlvlFromMods(mods);
  // Odds use the higher of paste ilvl and required min (alts on an ilvl 15 flask ≠ ilvl 1 pool)
  const weightIlvl = Math.max(ilvl, minIlvl);
  mods = sourceMods.map((m) => enrichMod(kb, item, m, baseTags, weightIlvl));

  // §78: when preserveSpecialSources is false, treat paste as stats-only
  // (fracture / essence / veiled flags do not constrain the craft).
  if (opts.preserveSpecialSources === false) {
    mods = mods.map((m) => {
      if (m.crafted || m.method === 'bench') return m;
      return {
        ...m,
        fractured: false,
        ofEssence: false,
        veiled: false,
        preserveSpecialSources: false,
      };
    });
  }

  onProgress?.({ phase: 'building-plan' });
  const best = assignAndBuild(item, mods, kb, baseTags, weightIlvl, drivers, itemClass, {
    ...opts,
    preserveSpecialSources: opts.preserveSpecialSources !== false,
    tierMode: opts.tierMode ?? 'atLeast',
  });

  return {
    best,
    alternatives: best.alternatives ?? [],
    minIlvl,
    drivers,
    classified: best.classified,
    coverage: kb.coverage,
    cannotRoll,
    baseTags,
  };
}

export { modStableKey };
