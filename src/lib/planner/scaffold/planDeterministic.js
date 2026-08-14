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
import { reportProgress } from '../../progress.js';

export async function planDeterministic(item, onProgress, opts = {}) {
  await reportProgress(onProgress, {
    phase: 'loading-knowledge',
    message: 'Loading craft knowledge…',
  });
  const kb = await loadKnowledgeBase();
  const base = getBaseInfo(kb, item.baseName);
  if (base?.name && base.name !== item.baseName) {
    item = { ...item, baseName: base.name };
  }
  const baseTags = effectiveBaseTags(item, base, kb.cannotRoll);
  const cannotRoll = resolveCannotRoll(item, base, kb.cannotRoll);
  const itemClass = base?.item_class ?? normalizeItemClass(item.itemClass);

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

  await reportProgress(onProgress, {
    phase: 'matching-knowledge',
    message: `Matching ${sourceMods.length} mod${sourceMods.length === 1 ? '' : 's'} against knowledge…`,
    current: 0,
    total: sourceMods.length,
  });

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

  const matched = mods.filter((m) => m.match?.matched || m.crafted || m.method === 'bench').length;
  const unmatched = mods.length - matched;
  await reportProgress(onProgress, {
    phase: 'matching-mods',
    message:
      unmatched > 0
        ? `Matched ${matched}/${mods.length} mods (${unmatched} unmatched)`
        : `Matched ${matched}/${mods.length} mods`,
    current: matched,
    total: mods.length,
  });

  for (const m of mods) {
    const label = m.short ?? m.text ?? '?';
    if (m.crafted || m.method === 'bench') {
      await reportProgress(onProgress, {
        phase: 'matching-mods',
        message: `  · ${label} — bench / crafted`,
        mod: label,
      });
      continue;
    }
    if (!m.match?.matched) {
      await reportProgress(onProgress, {
        phase: 'matching-mods',
        message: `  · ${label} — unmatched`,
        mod: label,
      });
      continue;
    }
    const src = m.match?.source ?? 'matched';
    await reportProgress(onProgress, {
      phase: 'matching-mods',
      message: `  · ${label} — ${src}`,
      mod: label,
      source: src,
    });
  }

  await reportProgress(onProgress, {
    phase: 'building-plan',
    message: 'Building sequential scaffold (essence / harvest / exalt / fracture)…',
  });
  const best = assignAndBuild(item, mods, kb, baseTags, weightIlvl, drivers, itemClass, {
    ...opts,
    preserveSpecialSources: opts.preserveSpecialSources !== false,
    tierMode: opts.tierMode ?? 'atLeast',
  });

  const classified = best.classified ?? mods;
  for (const m of classified) {
    if (m.crafted || m.method === 'bench') continue;
    const label = m.short ?? m.text ?? '?';
    const method = m.best?.type ?? m.method ?? null;
    const chaos = m.best?.expectedChaos;
    if (!method && !(chaos != null && Number.isFinite(chaos))) continue;
    const costBit =
      chaos != null && Number.isFinite(chaos) ? ` · ~${Math.round(chaos * 10) / 10}c` : '';
    await reportProgress(onProgress, {
      phase: 'building-routes',
      message: `  · ${label} → ${method ?? '?'}${costBit}`,
      mod: label,
      method: method ?? undefined,
      expectedChaos: chaos != null && Number.isFinite(chaos) ? chaos : undefined,
    });
  }

  const seqCost = best?.totalCost;
  await reportProgress(onProgress, {
    phase: 'building-routes',
    message:
      seqCost != null && Number.isFinite(seqCost)
        ? `Sequential route ready: ${best.name ?? 'Sequential'} · EV ~${Math.round(seqCost * 10) / 10}c`
        : `Sequential route ready: ${best.name ?? 'Sequential'}`,
    ev: seqCost != null && Number.isFinite(seqCost) ? seqCost : undefined,
    route: 'sequential',
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
