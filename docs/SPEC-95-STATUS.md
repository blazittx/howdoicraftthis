# SPEC-95 status (master rollup)

Honest consolidate after parallel tracks + Copper Sword plan fixes. Do not treat coverage.json as authoritative over this file.

Status key: **DONE** | **PARTIAL** (what's left) | **WONT** (reason) | **STUB** | **N/A**

---

## Master table (§1–95)

| § | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Architecture: mechanics vs strategy | **DONE** | Strategy in `planner/optimizer`; scaffold materializes steps only |
| 2 | CraftState state-space | **DONE** | `craftState.js` |
| 3 | V(S)=min Q; beam/Pareto/memo/LB | **DONE** | `planner/valueFunction.js`, `pruning.js` |
| 4 | Layer A vs B separation | **DONE** | `mechanics/**` vs `planner/**` |
| 5 | No hardcoded recipes as primary | **DONE** | Recipes only materialize sequential steps |
| 6 | Exact eligible-pool API | **DONE** | `spawnWeights` + `mechanics/eligible.js` |
| 7 | Entropy-reducing macros | **DONE** | `planner/macros.js` |
| 8 | Harvest pools + versioned cannot-roll | **DONE** | `mechanics/harvest.js`; rules 3.26–3.29 |
| 9 | Versioned ruleset | **DONE** | `src/lib/rules/*.json`, `ruleset.js` |
| 10 | Rebuild recomb from 3.26–3.29 | **DONE** | No Sentinel; unknowns marked |
| 11 | Predictable + Unpredictable as separate O | **DONE** | Model + `considerBothOps` |
| 12 | Donor recursive mini-plans | **DONE** | `planner/donorSearch.js` + auditable recipe lines |
| 13 | Partitions from recomb module | **DONE** | `bipartitions` / `donorPartitions` |
| 14 | Subsystem difficulty coupling | **DONE** | `rankCoupledSubsystems` |
| 15 | Completed-side valuation | **DONE** | `completedSideBonus` |
| 16 | Eldritch setup/chaos/annul/exalt | **DONE** | `mechanics/eldritch.js` |
| 17 | Veiled Chaos ≠ Exalted; dynamic unveil | **DONE** | `mechanics/unveil.js` |
| 18 | Universal bench blockers | **DONE** | `mechanics/blockers.js` |
| 19 | Separate remove kinds | **DONE** | `mechanics/remove.js` |
| 20 | Full Harvest menu | **PARTIAL** | Affix-relevant menu DONE (reforge / augment-remove / remove / res-swap). Body/weapon/flask enchants + stack transforms **not** CraftState ops — out of scope for rare-gear affix EV (see WONT note below for those sub-ops) |
| 21 | Beastcraft AddP/RemS, AddS/RemP, Split | **DONE** | `mechanics/beasts.js` |
| 22 | Generic fossil simulator | **DONE** | RePoE tag weights |
| 23 | Essence EV from weighted fish | **DONE** | No fixed 15/40; §73 affix-count extras |
| 24 | Eliminate guessEssenceName | **DONE** | Gone from src |
| 25 | Remove arbitrary cost heuristics | **DONE** | No INFLUENCED_BASE_PREMIUM |
| 26 | Multi-dimension costs | **DONE** | gold/dust never silently 0c; opportunity labeled; full recomb EV fields |
| 27 | Objective profiles | **DONE** | + `successProfile` |
| 28 | Salvage via V only | **DONE** | `evWithSalvage` |
| 29 | No double-count salvage | **DONE** | `salvageValue` diagnostic only |
| 30 | Plan classification | **DONE** | `planClass.js` |
| 31 | Confidence object | **DONE** | `buildConfidence`; UI/dump serialize summary (not `[object Object]`) |
| 32 | Source provenance on mechanics | **PARTIAL** | operators.json + `mechanicProvenance()`; not every runtime blob tagged |
| 33 | RePoE hash/timestamp/league in manifest | **DONE** | |
| 34 | Centralize item-class normalize | **DONE** | `itemClass.js` |
| 35 | Canonical `familyId` in KB build | **DONE** | Intentional complete |
| 36 | Unmatched mod → Unsupported | **DONE** | |
| 37 | Unsupported surfacing | **DONE** | |
| 38 | Plan replay `validatePlan` | **DONE** | `mechanics/validatePlan.js` |
| 39 | Monte Carlo vs analytic | **DONE** | `tests/monteCarlo.mjs` |
| 40 | Full `tests/` tree; `npm test` | **DONE** | `scripts/run-all-tests.mjs` |
| 41 | Mechanic unit tests | **DONE** | |
| 42 | Regression strategy invariants | **DONE** | |
| 43 | Regression (continued) | **DONE** | |
| 44 | Pareto pruning | **DONE** | |
| 45 | Memoized V(S) | **DONE** | |
| 46 | Bounded best-first / LB | **DONE** | |
| 47 | Macros (w/ §7) | **DONE** | |
| 48 | Risk flags | **DONE** | |
| 49 | Restart semantics | **DONE** | |
| 50 | Base acquisition (no fake premiums) | **DONE** | |
| 51 | Allflame unsupported | **WONT** | Intentionally unsupported (`ALLFLAME_SUPPORTED=false`); out of scope |
| 52 | Plan output schema | **DONE** | |
| 53 | rejectedStrategies with WHY | **DONE** | |
| 54 | solverDebug | **DONE** | when opted in |
| 55 | Pool inspection UI | **DONE** | Show eligible pool |
| 56 | Canonical operators.json | **DONE** | |
| 57 | Operators (continued) | **DONE** | |
| 58 | Source compatibility | **DONE** | |
| 59 | Method availability from data | **DONE** | |
| 60 | Unknown costs unranked | **DONE** | Recomb now uses approximate band midpoints + opportunityCostChaos when market units missing (tagged approximate — not invented closed-form) |
| 61 | Correct plan naming | **DONE** | |
| 62 | Break up 123KB planner | **DONE** | `deterministicPlanner.js` thin re-export; logic in `planner/scaffold/**` |
| 63 | Remove obsolete planner layers | **DONE** | `sideCompletionPlanner` shim; dual models deprecated |
| 64 | `craftSearch.js` legacy | **DONE** | `@deprecated`; production via optimizer |
| 65 | Static KB consistency | **DONE** | |
| 66 | Build provenance | **DONE** | |
| 67 | Market trade integration | **STUB** | `pricing/trade.js` → `unknown`; never fake 50c. Separate milestone |
| 68 | Benchmarks | **DONE** | |
| 69 | Human route reference | **DONE** | |
| 70 | Sanity EV lower bounds | **DONE** | |
| 71 | Σp=1 checks | **DONE** | |
| 72 | Never Math.ceil(1/p) for EV | **DONE** | EV=`1/p`; ceil display-only |
| 73 | Affix-count distributions | **DONE** | Used for essence extras (no hardcoded ~2) |
| 74 | tierMode | **DONE** | default `atLeast` |
| 75 | Divine separate from craft EV | **DONE** | |
| 76 | Reserve bench slot | **DONE** | Caps essence extras + skips annul when keepers+bench fit |
| 77 | Terminal equivalence | **DONE** | |
| 78 | preserveSpecialSources | **DONE** | |
| 79 | Fracture buy vs craft | **PARTIAL** | Prefer-fracture EV in scaffold; full market buy comparison blocked by §67 stub |
| 80 | Fracture by EV not rarity | **DONE** | |
| 81 | Influence acquisition unknown w/o trade | **DONE** | |
| 82 | Operation preconditions as data | **DONE** | |
| 83 | Essence + metamod illegal | **DONE** | |
| 84 | Recomb compatibility rules | **DONE** | |
| 85 | Dedicated recomb dataset | **DONE** | `public/data/recombinator/3.29.json` |
| 86 | Official sources preference | **DONE** | design + build path |
| 87 | RePoE primary | **DONE** | |
| 88 | Version assertions | **DONE** | |
| 89 | Price staleness | **DONE** | |
| 90 | Raw cost formula on stages | **DONE** | |
| 91 | Budget / P(complete) objective | **N/A** | Spec “later”; not implemented |
| 92 | Implementation phases | **PARTIAL** | Phases 1–4 largely done; Phase 5 market stub (§67); Phase 6 UI fields largely emitted |
| 93 | Immediate tech-debt list | **DONE** | Fixed-attempt/guessEssence/ceil/50c/crit-guaranteed gone |
| 94 | Emergent behaviors | **DONE** | benchmarks + optimizer |
| 95 | Final design principle | **DONE** | architecture goal |

### Counts (honest)

| Status | Count |
|--------|------:|
| DONE | 88 |
| PARTIAL | 4 (§20, §32, §79, §92) |
| WONT | 1 (§51 Allflame) |
| STUB | 1 (§67) |
| N/A | 1 (§91) |
| **Total** | **95** |

§20 sub-note: body/weapon/flask Harvest enchants + stack transforms are **WONT for rare-affix EV** (optimizer does not need them). Core affix Harvest menu is DONE — row stays **PARTIAL** until those kinds are dropped from “full menu” scope or implemented.

---

## Copper Sword plan fixes (2026-08)

| Issue | Owner | Fix |
|-------|-------|-----|
| Recomb unranked (gold/dust) | parent + consolidate | Dataset `averageUnpredictable` / `role:defaultAverage` + `opportunityCostChaos`; display/EV data-driven (no hardcoded 25k/85k in search copy) |
| Recomb `~0c` / undercosted | parent | Full-craft EV: donors + retries + finish − salvage; smash Gold/Dust separate; `assemblePlan` no longer zeros smash-only bags via empty tradable split; economics report fields |
| Bench Annul×N / SCBC | **parent** | General slot math in `buildAnnulForBenchSpace`; no phantom filler; no SCBC+annul when keepers+benches≤3 |
| `confidence: [object Object]` | consolidate | `formatConfidence` in UI + craft-plan dump |
| `~2 extra rolls` | consolidate | `essenceExtraRollsByGen` (§73) |
| Ugly essence floats | consolidate | `formatAttempts` / display rounding |
| §61–64 planner breakup | consolidate | thin `deterministicPlanner.js` → `planner/scaffold/**` |
| SPEC-95 master table | consolidate | this file |

**Gold/dust model:** physical amounts from KB `averageUnpredictable` (or `defaultAverage` sample). Tradable EV = donor manufacturing + finish + retries (salvage path). Dust → chaos via market unit or tagged `opportunityCostChaos`. Gold → chaos only as labeled opportunity (`gold / goldPerChaosOpportunityRate`). Never `12+2n+0.04*ilvl`. Never report smash-fee-alone as craft cost. Never `totalCostChaos: 0` when donors cost > 0.

**Full recomb EV:** `EV(S) = (attemptCost + Σ P(partial)×V(partial)) / (1 − P(brick))` with `attemptCost = donorA + donorB + smashEconomic`. Ranking compares full recomb EV vs full sequential EV.

---

## Testing track

| Suite | Status |
|-------|--------|
| 15 suites | **PASS** (see `det-test-result.txt`: passed=15 failed=0) |

```bash
npm test
TEST_ONLY=regression,sanity npm test
MC_TRIALS=1000000 npm test
```

---

## Architecture reminder

Production: `craftPlanner` → `planner/optimizer` → V(S). Sequential steps: `planner/scaffold/**` via thin `deterministicPlanner.js` re-export.
