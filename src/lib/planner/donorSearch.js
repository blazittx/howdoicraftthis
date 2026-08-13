/**
 * Recursive donor mini-plans (§12). Same optimizer shallowly — no synthetic costs.
 * Emits auditable recipe lines (base / method / P / attempts / currency EV).
 * Donor EV is a state machine when later ops can destroy prior mods.
 */
import { donorPartitions } from '../recombinatorModel.js';
import { discoverEntropyChains } from './macros.js';
import { donorKey } from './stateKey.js';
import { lowerBound } from './heuristics.js';

const REGAL = 0.2;

function notBench(m) {
  return !m.crafted && m.method !== 'bench' && m.match?.source !== 'crafted';
}

function genOf(m) {
  return m.gen === 'suffix' ? 'suffix' : 'prefix';
}

function isCheapMagic(mods) {
  const rng = mods.filter(notBench);
  const p = rng.filter((m) => genOf(m) === 'prefix' && !m.fractured).length;
  const s = rng.filter((m) => genOf(m) === 'suffix' && !m.fractured).length;
  return rng.length <= 2 && p <= 1 && s <= 1;
}

function manufactureCheap(mods, costOne) {
  const rng = mods.filter(notBench);
  if (!rng.length) return 0;
  const live = rng.filter((m) => !m.fractured);
  if (!live.length) return 0;
  if (live.length === 1) return costOne(live[0]);
  if (isCheapMagic(rng)) return live.reduce((s, m) => s + costOne(m), 0) + (live.length === 2 ? REGAL : 0);
  return Infinity;
}

function labelOf(m) {
  return m.short ?? m.text ?? m.match?.id ?? '?';
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

/** Cheapest priced candidate on a mod (alt/harvest/essence/exalt/…); never invent market buy. */
function cheapestModAcquisition(m, costOne) {
  const candidates = (m.candidates ?? []).filter(
    (c) => c.expectedChaos != null && Number.isFinite(c.expectedChaos) && c.expectedChaos >= 0
  );
  let best = null;
  for (const c of candidates) {
    if (!best || c.expectedChaos < best.expectedChaos) best = c;
  }
  const viaCostOne = costOne?.(m);
  if (viaCostOne != null && Number.isFinite(viaCostOne)) {
    if (!best || viaCostOne < best.expectedChaos) {
      return { expectedChaos: viaCostOne, type: m.best?.type ?? m.method ?? 'costOne', label: m.best?.label ?? 'costOne' };
    }
  }
  if (best) return { expectedChaos: best.expectedChaos, type: best.type, label: best.label };
  return { expectedChaos: viaCostOne, type: 'unknown', label: 'unknown' };
}

/**
 * Invariant: totalDonorEV >= every mandatory priced component.
 * Failures → recipe invalid (caller must not trust/rank).
 */
export function assertDonorRecipeInvariants(recipe) {
  const fails = [];
  const total = recipe?.expectedCostChaos ?? recipe?.totalEv;
  const comps = (recipe?.lines ?? []).filter(
    (l) =>
      l.kind !== 'total' &&
      l.kind !== 'base' &&
      l.chaos != null &&
      Number.isFinite(l.chaos) &&
      l.chaos > 0
  );
  if (total == null || !Number.isFinite(total)) {
    if (comps.length) fails.push('totalDonorEV missing while components priced');
  } else {
    for (const c of comps) {
      if (c.chaos > total + 0.05) {
        fails.push(`component "${c.text}" ${round2(c.chaos)}c > totalDonorEV ${round2(total)}c`);
      }
    }
  }
  if (recipe?.baseAcquisitionUnknown && recipe?.claimCompleteTotal) {
    fails.push('base acquisition unknown but total claimed complete');
  }
  return { ok: fails.length === 0, fails };
}

/**
 * Full-sequence donor recipe. Multi-step plans must not advertise a single
 * next-mod P/attempt as P(FULL donor).
 * totalDonorEV = sum of required operation EVs (consistent with shown lines).
 */
export function buildDonorRecipe(mods, seq, costOne) {
  const lines = [];
  const live = (mods ?? []).filter((m) => notBench(m) && !m.fractured);
  const fractured = (mods ?? []).filter((m) => m.fractured);
  let baseAcquisitionUnknown = false;

  if (fractured.length) {
    baseAcquisitionUnknown = true;
    lines.push({
      kind: 'base',
      text: `Buy fractured base with: ${fractured.map(labelOf).join(', ')}`,
      chaos: null,
      note: 'Fractured base market price unknown without trade API',
    });
  } else {
    baseAcquisitionUnknown = true;
    lines.push({
      kind: 'base',
      text: 'Buy rare/magic base (or white → transmute)',
      chaos: null,
      note: 'Base acquisition — market unknown without trade',
    });
  }

  const ops = seq?.ops ?? [];
  const pools = seq?.pools ?? [];
  const method = ops.length ? ops.join(' → ') : 'manufacture';
  const stepPs = pools.map((p) => p?.p).filter((p) => p != null && Number.isFinite(p) && p > 0);
  const multiStep = ops.length > 1 || stepPs.length > 1 || live.length > 1;
  const stateMachine = pools.some((p) => p?.stateMachine);

  const pFullDonorFirstTry =
    stepPs.length > 0 ? stepPs.reduce((a, p) => a * p, 1) : ops.length === 0 && live.length <= 1 ? 1 : null;

  let successChancePerAttempt = null;
  let expectedAttempts = null;
  let pAttemptNote = null;
  let methodChaos = null;

  if (!multiStep && stepPs.length === 1) {
    successChancePerAttempt = stepPs[0];
    expectedAttempts =
      successChancePerAttempt > 0 && successChancePerAttempt < 1
        ? 1 / successChancePerAttempt
        : successChancePerAttempt >= 1
          ? 1
          : null;
    pAttemptNote = `successChancePerAttempt ${((successChancePerAttempt ?? 0) * 100).toFixed(
      successChancePerAttempt < 0.01 ? 3 : 2
    )}%; expectedAttempts ~${expectedAttempts != null ? round2(expectedAttempts) : '?'}`;
  } else if (multiStep || stateMachine) {
    for (let i = 0; i < Math.max(ops.length, pools.length); i++) {
      const op = ops[i];
      const pool = pools[i];
      const p = pool?.p;
      const att = p > 0 && p < 1 ? 1 / p : p >= 1 ? 1 : null;
      if (op || p != null) {
        lines.push({
          kind: 'step',
          text: op ? `Step: ${op}` : `Step ${i + 1}`,
          chaos: null,
          successChancePerAttempt: p ?? null,
          expectedAttempts: att != null ? round2(att) : null,
          note: pool?.stateMachine
            ? `Joint state-machine P ${((p ?? 0) * 100).toFixed(p < 0.01 ? 3 : 2)}% (same-side reforge wipes prior hits — not Σ independent geometrics)`
            : p > 0
              ? `successChancePerAttempt ${((p ?? 0) * 100).toFixed(p < 0.01 ? 3 : 2)}%; expectedAttempts ~${
                  att != null ? round2(att) : '?'
                }`
              : 'Step in full-sequence donor simulation',
        });
      }
    }
    pAttemptNote = stateMachine
      ? `State-machine donor EV ~${round2(seq?.ev)}c (joint P ${
          pFullDonorFirstTry != null
            ? `${(pFullDonorFirstTry * 100).toFixed(pFullDonorFirstTry < 0.01 ? 3 : 2)}%`
            : '?'
        }; not summed independent geometrics)`
      : pFullDonorFirstTry != null
        ? `Full-sequence first-try joint P ${((pFullDonorFirstTry ?? 0) * 100).toFixed(
            pFullDonorFirstTry < 0.01 ? 3 : 2
          )}% (diagnostic); EV uses state-consistent simulation ~${round2(seq?.ev)}c`
        : `Multi-step full-sequence donor EV ~${round2(seq?.ev)}c (not a single P/attempt)`;
    successChancePerAttempt = null;
    expectedAttempts = null;
  }

  // Priced components — must agree with totalDonorEV
  const componentChaos = [];
  if (ops.length && Number.isFinite(seq?.ev)) {
    methodChaos = round2(seq.ev);
    lines.push({
      kind: 'method',
      text: `Method: ${method}`,
      chaos: methodChaos,
      successChancePerAttempt,
      expectedAttempts: expectedAttempts != null ? round2(expectedAttempts) : null,
      pFullDonorFirstTry: pFullDonorFirstTry != null ? round2(pFullDonorFirstTry) : null,
      note: pAttemptNote ?? `Currency EV ~${methodChaos}c`,
    });
    componentChaos.push(methodChaos);
  } else {
    for (const m of live) {
      const acq = cheapestModAcquisition(m, costOne);
      const c = round2(acq.expectedChaos);
      lines.push({
        kind: 'mod',
        text: `Acquire ${labelOf(m)} via ${acq.label ?? acq.type}`,
        chaos: c,
        note:
          c != null
            ? `Cheapest acquisition ~${c}c (${acq.type})`
            : 'No priced acquisition — market buy unknown (do not invent)',
      });
      if (c != null && Number.isFinite(c)) componentChaos.push(c);
    }
  }

  const summed = componentChaos.length ? componentChaos.reduce((a, b) => a + b, 0) : null;
  // Prefer consistent method/seq EV; never show total below a mandatory component.
  let totalEv = Number.isFinite(seq?.ev) ? round2(seq.ev) : summed;
  if (summed != null && Number.isFinite(summed)) {
    if (totalEv == null || !Number.isFinite(totalEv)) totalEv = round2(summed);
    else if (summed > totalEv + 0.05) totalEv = round2(summed);
  }

  lines.push({
    kind: 'total',
    text: 'Total donor EV',
    chaos: totalEv,
    note: baseAcquisitionUnknown
      ? 'Currency EV only — base buy unknown; craft total incomplete'
      : 'Includes method currency EV',
  });

  const recipe = {
    lines,
    method,
    successChancePerAttempt,
    expectedAttempts: expectedAttempts != null ? round2(expectedAttempts) : null,
    expectedCostChaos: totalEv,
    pFullDonorFirstTry: pFullDonorFirstTry != null ? round2(pFullDonorFirstTry) : null,
    multiStep: !!multiStep,
    stateMachine: !!stateMachine,
    pAttempt: successChancePerAttempt,
    totalEv,
    baseAcquisitionUnknown,
    claimCompleteTotal: false,
    summary: lines
      .map((l) => (l.chaos != null ? `${l.text}: ~${l.chaos}c` : l.text))
      .join(' · '),
  };
  const inv = assertDonorRecipeInvariants(recipe);
  recipe.invariantsOk = inv.ok;
  recipe.invariantFailures = inv.fails;
  recipe.invalid = !inv.ok;
  return recipe;
}

/**
 * @param {object[]} mods donor goals
 * @param {object} ctx must provide costOne, sequentialRemaining (or seqFn)
 */
export function donorMiniPlan(mods, ctx) {
  const seqFn = ctx.sequentialRemaining ?? ctx.seqFn;
  const costOne = ctx.costOne;
  const fracKeys = (mods ?? []).filter((m) => m.fractured).map((m) => ctx.modKey?.(m) ?? m.match?.id ?? m.text);
  if (seqFn) {
    const sub = { ...ctx, mods, sequentialCost: undefined, startKey: '\x00donor' };
    const seq = seqFn(fracKeys, sub);
    if (Number.isFinite(seq?.ev)) {
      const recipe = buildDonorRecipe(mods, seq, costOne);
      // Align EV with recipe total (never below components)
      const ev = recipe.expectedCostChaos ?? seq.ev;
      return {
        ev,
        ops: seq.ops ?? [],
        pools: seq.pools ?? [],
        method: 'sequential',
        chains: discoverEntropyChains((mods ?? []).filter((m) => !m.fractured), ctx),
        recipe,
        successChancePerAttempt: recipe.successChancePerAttempt,
        expectedAttempts: recipe.expectedAttempts,
        expectedCostChaos: recipe.expectedCostChaos,
        invalid: !!recipe.invalid,
        baseAcquisitionUnknown: !!recipe.baseAcquisitionUnknown,
      };
    }
  }

  const live = (mods ?? []).filter((m) => notBench(m) && !m.fractured);
  const mfg = manufactureCheap(mods, costOne);
  const sum = live.reduce((s, m) => {
    const acq = cheapestModAcquisition(m, costOne);
    return s + (Number.isFinite(acq.expectedChaos) ? acq.expectedChaos : costOne(m) ?? 0);
  }, 0);
  const ev = Number.isFinite(mfg) ? Math.min(mfg, sum) : sum;
  const recipe = buildDonorRecipe(mods, { ev, ops: [], pools: [] }, costOne);
  return {
    ev: recipe.expectedCostChaos ?? ev,
    ops: ['manufacture'],
    pools: [],
    method: 'manufacture',
    lb: lowerBound(live, costOne),
    recipe,
    successChancePerAttempt: recipe.successChancePerAttempt,
    expectedAttempts: recipe.expectedAttempts,
    expectedCostChaos: recipe.expectedCostChaos,
    invalid: !!recipe.invalid,
    baseAcquisitionUnknown: !!recipe.baseAcquisitionUnknown,
  };
}

/**
 * Recursive donor value with optional re-partition of expensive donors.
 */
export function donorSearch(mods, ctx, depth = 0, memo = new Map()) {
  const key = donorKey(mods);
  if (memo.has(key)) return memo.get(key);
  const mini = donorMiniPlan(mods, ctx);
  let best = { ...mini, mods, partition: null };
  memo.set(key, best);
  if (depth >= (ctx.donorDepth ?? 2) || (mods?.length ?? 0) < 3) return best;

  for (const [A, B] of donorPartitions(mods.filter(notBench))) {
    if (A.length + B.length < 2) continue;
    const vA = donorSearch(A, ctx, depth + 1, memo);
    const vB = donorSearch(B, ctx, depth + 1, memo);
    const ev = vA.ev + vB.ev;
    if (ev < best.ev) {
      best = {
        ev,
        ops: ['donorSplit', ...(vA.ops ?? []), ...(vB.ops ?? [])],
        pools: [],
        method: 'split',
        partition: [A, B],
        left: vA,
        right: vB,
        mods,
        expectedCostChaos: Math.round(ev * 100) / 100,
        invalid: !!(vA.invalid || vB.invalid),
        baseAcquisitionUnknown: !!(vA.baseAcquisitionUnknown || vB.baseAcquisitionUnknown),
        recipe: {
          lines: [
            ...(vA.recipe?.lines ?? []),
            ...(vB.recipe?.lines ?? []),
            { kind: 'total', text: 'Split-donor total EV', chaos: Math.round(ev * 100) / 100 },
          ],
          summary: `Split: A ~${Math.round(vA.ev)}c + B ~${Math.round(vB.ev)}c`,
          totalEv: Math.round(ev * 100) / 100,
          expectedCostChaos: Math.round(ev * 100) / 100,
          multiStep: true,
          invariantsOk: !(vA.invalid || vB.invalid),
        },
      };
      memo.set(key, best);
    }
  }
  return best;
}

export { manufactureCheap, isCheapMagic, cheapestModAcquisition };
