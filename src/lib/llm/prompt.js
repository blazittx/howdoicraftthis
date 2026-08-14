/**
 * System + user prompts for the local craft advisor.
 * Model must cite only provided numbers; never invent mechanics or costs.
 */

/** Stable id + version for thought-log / debugging (bump when SYSTEM_PROMPT text changes). */
export const SYSTEM_PROMPT_ID = 'craft-advisor';
export const SYSTEM_PROMPT_VERSION = '1.1.0';

export const SYSTEM_PROMPT = `You are a Path of Exile crafting strategy planner for HowDoICraftThis.

You do not know exact crafting probabilities yourself.
Inspect the provided engine payload (candidates, rejected, economics, methodComparison, solverDebug V/Q, macros, entropyChains, tagClusters). Cite only numbers in that JSON — never invent p%, gold, dust, or costs.
(Future: crafting-engine tool calls may expose pools/outcomeMass live; until then use only this payload.)

Job: propose efficient strategies via allowed suggestion kinds. EV / V(S) / totalCost from the engine are authoritative — never replace them.

Rules:
- Never claim an operation is deterministic unless the engine reports probability 1 (or equivalent certainty in the payload).
- Preserve expensive completed states: prefer protecting finished sides; do not suggest reforging unprotected keepers.
- Prefer entropy-reducing sequences from tagClusters / entropyChains: finish a tag-clustered affix side, protect it (SCBC/PCBC), then work the open side (cannot-roll assist when the engine lists it).
- Compare deterministic / tag-forcing / entropy chains against Recombinator using methodComparison and Qsequential vs Qunpredictable/Qpredictable.
- Do not use unsupported mechanics (Allflame, boat, or anything not reflected in the payload).
- Allowed kinds only: explain | evFlag | searchHint | macroExpand (validated). searchHint = labels only, no costs. macroExpand = ids already in solverDebug.macros / entropyChains.

OUTPUT — JSON only:
{"summary":"one short sentence","items":[{"kind":"explain|evFlag|searchHint|macroExpand","text":"…","cited":{"solverDebug.Qsequential":120.5},"searchHint":{"type":"donorPartition","prefixes":["…"],"suffixes":["…"],"note":"…"},"macroId":"optional"}]}

If you cannot advise from the payload: {"summary":"No advisor notes — insufficient numeric context.","items":[]}.`;

/**
 * Compact payload for the model (strip huge arrays).
 */
export function buildAdvisePayload({ target, candidates, rejected, economics, best, solverDebug }) {
  const slimMods = (mods) =>
    (mods ?? []).slice(0, 16).map((m) => ({
      text: m.short ?? m.text,
      type: m.type,
      gen: m.gen ?? m.generation ?? m.type,
      fractured: !!m.fractured,
      crafted: !!m.crafted,
      method: m.method,
      tags: (m.tags ?? []).slice(0, 8),
    }));

  const slimCand = (c, i) => ({
    id: c.id ?? c.name ?? `alt-${i}`,
    name: c.name,
    totalCost: c.totalCost ?? c.ev ?? c.cost ?? null,
    description: c.description ? String(c.description).slice(0, 240) : undefined,
  });

  return {
    role: 'craft-advisor-request',
    prompt: { id: SYSTEM_PROMPT_ID, version: SYSTEM_PROMPT_VERSION },
    target: target
      ? {
          baseName: target.baseName,
          itemClass: target.itemClass,
          itemLevel: target.itemLevel,
          influenced: target.influenced ?? [],
          mods: slimMods(target.explicitMods ?? target.mods ?? target.enrichedMods),
        }
      : null,
    best: best
      ? {
          id: best.id,
          name: best.name,
          totalCost: best.totalCost,
          totalExpectedTradableCostChaos: best.totalExpectedTradableCostChaos ?? null,
          totalExpectedEconomicCostChaos: best.totalExpectedEconomicCostChaos ?? null,
          expectedGold: best.expectedGold ?? null,
          expectedDust: best.expectedDust ?? null,
          dustChaosEquivalent: best.dustChaosEquivalent ?? null,
          goldOpportunityChaosEquivalent: best.goldOpportunityChaosEquivalent ?? null,
          confidence: best.confidence,
          description: best.description ? String(best.description).slice(0, 320) : undefined,
          economics: economics ?? best.economics ?? null,
        }
      : null,
    candidates: (candidates ?? []).slice(0, 8).map(slimCand),
    rejected: (rejected ?? best?.rejectedStrategies ?? []).slice(0, 8).map((r, i) => ({
      id: r.id ?? r.name ?? `rej-${i}`,
      whyLost: r.whyLost ?? r.why,
      ev: r.ev ?? r.totalCost ?? r.cost ?? null,
      unranked: r.unranked,
    })),
    solverDebug: solverDebug
      ? {
          V: solverDebug.V,
          Qsequential: solverDebug.Qsequential,
          Qunpredictable: solverDebug.Qunpredictable,
          Qpredictable: solverDebug.Qpredictable,
          macros: solverDebug.macros,
          entropyChains: solverDebug.entropyChains,
          tagClusters: solverDebug.tagClusters,
          preferredLockSide: solverDebug.preferredLockSide,
          coupled: solverDebug.coupled,
          fractureByEv: solverDebug.fractureByEv,
          economicsInvalid: solverDebug.economicsInvalid,
          impracticalReason: solverDebug.impracticalReason,
          predictableUnranked: solverDebug.predictableUnranked,
        }
      : null,
    methodComparison: best?.methodComparison
      ? {
          winner: best.methodComparison.winner,
          sequential: best.methodComparison.sequential,
          recombinator: best.methodComparison.recombinator,
          predictableRecombinator: best.methodComparison.predictableRecombinator,
        }
      : null,
  };
}

/** Short honest summary for the thought log (full JSON is expandable). */
export function summarizeAdvisePayload(payload) {
  const bits = [];
  if (payload?.prompt) bits.push(`prompt ${payload.prompt.id}@${payload.prompt.version}`);
  if (payload?.target?.baseName) bits.push(payload.target.baseName);
  const nMods = payload?.target?.mods?.length ?? 0;
  if (nMods) bits.push(`${nMods} target mod${nMods === 1 ? '' : 's'}`);
  if (payload?.best?.name) {
    const c = payload.best.totalCost;
    bits.push(
      c != null && Number.isFinite(c) ? `best ${payload.best.name} ~${c}c` : `best ${payload.best.name}`
    );
  }
  const nCand = payload?.candidates?.length ?? 0;
  const nRej = payload?.rejected?.length ?? 0;
  if (nCand || nRej) bits.push(`${nCand} candidates / ${nRej} rejected`);
  const tc = payload?.solverDebug?.tagClusters?.length ?? 0;
  if (tc) bits.push(`${tc} tag cluster${tc === 1 ? '' : 's'}`);
  if (payload?.solverDebug?.preferredLockSide) {
    bits.push(`lock ${payload.solverDebug.preferredLockSide}es first`);
  }
  return bits.join(' · ') || 'empty payload';
}

export function buildUserPrompt(payload) {
  return `Advise on this craft plan. Cite only numbers from this JSON.\n\n${JSON.stringify(payload)}`;
}
