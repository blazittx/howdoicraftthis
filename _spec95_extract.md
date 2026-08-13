# Goal

`howdoicraftthis` should answer one question:

> Given a finished Path of Exile 1 item, what is the lowest expected-cost realistic crafting strategy to produce an equivalent target item using currently valid crafting mechanics?

The solver must not merely find a legal recipe. It must compare realistic competing crafting routes and choose the one with the lowest expected total cost.

The current project already has strong foundations:

* in-game item parsing
* Advanced Mod Description parsing
* RePoE-based modifier data
* item/base/tag matching
* natural spawn weights
* Essence data
* Fossil data
* Harvest reforge data
* Bench crafting
* Influence mods
* Eldritch crafting
* Veiled mods
* daily price snapshots
* partial Recombinator support

However, the current planner architecture is still primarily a collection of handcrafted strategy generators and heuristics.

That needs to change.

---

# 1. Current architectural problem

The existing planner describes itself as:

> candidate methods → cheapest consistent combo

and the implementation explicitly groups things like Essence, Harvest, Unveil and Bench into one recipe. The current `deterministicPlanner.js` is over 120 KB and contains both:

* game-mechanics calculations
* craft-strategy decisions

inside the same planner.

This makes the solver brittle.

The planner currently asks questions like:

* Which target should Essence guarantee?
* Which Harvest family covers the most remaining mods?
* Should I fracture the rarest mod?
* Should I use a Recombinator?
* Which predefined side-completion pattern applies?

Instead, it needs to ask:

> From this exact current item state, which legal crafting operation has the minimum expected future cost?

This is the core architecture change.

---

# 2. Replace recipe selection with state-space optimization

Create a canonical `CraftState`.

Every intermediate item must be represented as a full state.

Suggested structure:

```js
{
  baseId,
  baseName,
  itemClass,
  itemLevel,
  rarity,

  influences: [],
  corrupted: false,
  mirrored: false,

  eldritch: {
    exarchTier: null,
    eaterTier: null,
    dominance: null
  },

  prefixes: [],
  suffixes: [],

  implicits: [],
  enchants: [],

  craftedMods: [],
  fracturedMods: [],

  activeMetamods: [],
  cannotRollTags: [],

  targetCoverage: {},

  provenance: {
    previousStateId,
    operationId
  }
}
```

Every explicit affix should contain:

```js
{
  modId,
  generation,
  groups,
  tags,
  tier,
  requiredLevel,
  weight,
  source,
  fractured,
  crafted,
  veiled,
  essenceOnly,
  influence,
  desired
}
```

Do not reduce state to:

```text
3 / 5 target mods obtained
```

Two items with the same number of desired mods can have completely different future crafting value.

Example:

```text
T1 % ES
T1 hybrid ES
```

is strategically much better than:

```text
T1 flat ES
T3 lightning resistance
```

for a triple-T1 ES chest even though both contain two desired mods.

The value of a state must therefore come from its cheapest continuation, not its number of matching affixes.

---

# 3. Define the solver mathematically

Use a value function:

```text
V(S) = minimum expected additional cost to reach the target from state S
```

For every legal operation `O`:

```text
Q(S, O) =
    operationCost(O)
    + Σ P(S' | S, O) × V(S')
```

Then:

```text
V(S) = min Q(S, O)
```

The planner should select the action with minimum `Q`.

This is the single most important architectural change.

Essence, Harvest, Recombinator, Annul, Veiled Chaos, Eldritch Chaos, Fossils, Bench, etc. all become competing transitions.

Recombinator does not get special preference.

Harvest does not get special preference.

Fracture does not get special preference.

---

# 4. Separate mechanics from strategy

Create two major layers.

## Layer A — mechanics engine

The mechanics layer answers:

> If I perform operation X on state S, what states can result and with what probabilities?

It must know nothing about whether an outcome is good.

Examples:

```js
applyExaltedOrb(state)
applyAnnul(state)
applyEssence(state, essence)
applyHarvestReforge(state, tag)
applyVeiledChaos(state)
applyVeiledExalted(state)
applyEldritchChaos(state)
applyRecombinator(stateA, stateB, mode)
```

Return:

```js
{
  outcomes: [
    {
      state,
      probability
    }
  ],
  cost
}
```

## Layer B — optimizer

The optimizer decides which outcome states are valuable relative to the target.

Do not mix these concerns.

This is especially important for Recombinators.

`recombine(A, B)` should produce mechanically correct outputs without knowing whether T1 Energy Shield or Fire Resistance is desirable.

The optimizer evaluates those results afterward.

---

# 5. Remove hardcoded craft recipes

The repository currently contains strategy-specific functions such as:

```text
recipeFractureEssenceHarvest
recipeSuffixThenHarvestPrefix
```

and recommended patterns such as:

```text
armour-defence-then-eldritch-suffixes
essence-fish-harvest-sibling
```

These are useful development heuristics, but they should not be the primary planner.

The current operator knowledge file literally contains recommended crafting sequences for armour and Essence/Harvest combinations.

Long term, those should become:

* regression fixtures
* search heuristics
* optional macro-actions

They should not decide the optimal route.

A good search engine should independently rediscover:

```text
Essence → lock suffixes → Reforge Critical → unveil → bench
```

because that chain has lower EV.

---

# 6. Implement exact modifier-pool recalculation after every operation

This is essential.

The project already has good groundwork in `spawnWeights.js`: it removes occupied mod groups and uses current eligible pool weights rather than blindly using full base weights.

Expand that into a universal API:

```js
getEligibleMods(state, {
  generation,
  requiredTags,
  forbiddenTags,
  method
})
```

This must account for:

* base tags
* item class
* item level
* prefix/suffix availability
* occupied mod groups
* fractured mods
* existing mods
* influence
* metamods
* cannot-roll tags
* method-specific restrictions
* Essence restrictions
* Harvest restrictions
* Fossil modifiers
* Veiled pool rules
* recombination validity

Then expose:

```js
getWeightedPool(...)
getTargetProbability(...)
```

The solver must never calculate:

```text
target weight / full base pool
```

when the state already blocks portions of that pool.

---

# 7. Add deterministic-chain discovery

The wand example demonstrates this perfectly.

The solver should be able to discover:

```text
fractured mana
↓
Essence of Zeal
↓
hit either desired Crit suffix
↓
Suffixes Cannot Be Changed
↓
Reforge Critical
↓
remaining eligible Crit pool collapses
↓
other desired Crit modifier
```

This must not be hardcoded for crit wands.

The general mechanic is:

```text
operation A
→ state constraints
→ operation B becomes much more deterministic
```

The optimizer should explicitly look for entropy reduction.

Useful entropy-reducing conditions include:

* occupied mod groups
* fractured affixes
* Essence-guaranteed affixes
* full opposite affix side
* metamods
* cannot-roll tags
* method-required tags
* bench blockers
* reduced unveil pools
* influence restrictions

A high-probability target after pool collapse is often much cheaper than combining donors.

---

# 8. Fix Harvest modelling

Current Harvest logic still contains dangerous heuristics.

For example, `craftOperators.js` currently says that when multiple crit targets exist:

> hitting crit chance or multi in-tier is effectively guaranteed each craft

That statement is not universally valid and should never be hardcoded.

Instead:

```js
const eligible = getEligibleMods(state, {
  requiredTags: ['critical']
})
```

Then compute exact weighted target probability from the actual resulting pool.

If only one valid Critical mod family remains:

```text
P(target) = 100%
```

If several remain:

calculate the actual probability.

Current PoE mechanics also changed in 3.27: guaranteed Harvest reforges now respect Cannot Roll Attack/Caster modifiers. The solver must version these interactions. The PoE Wiki metamod reference records that guaranteed Harvest reforges respect these restrictions as of 3.27.

Therefore mechanics need a version-aware rule table.

---

# 9. Implement a versioned mechanics ruleset

Do not scatter patch-specific assumptions across files.

Create:

```text
rules/
  3.26.json
  3.27.json
  3.28.json
  3.29.json
```

or an equivalent code module.

Example:

```js
{
  harvest: {
    reforgeRespectsCannotRollAttackCaster: true
  },

  recombinator: {
    unpredictableExclusivePenalty: true,
    corruptedAllowed: false
  },

  veiled: {
    veiledExaltedRemovesOneAddsOne: true
  }
}
```

The solver should always report which ruleset was used.

This prevents historical mechanics from silently contaminating current calculations.

---

# 10. Rebuild Recombinator support from real current data

This is a major priority.

Current repo coverage itself labels Recombinators as only partial.

The current operator file contains only:

```text
Combine two items; inherit mods by rules
```

with incomplete exclusive-mod tables.

That is not sufficient for EV optimization.

Current PoE has two Recombinator modes:

* Predictable Recombination
* Unpredictable Recombination

GGG introduced the selectable-mod Predictable mode in 3.26 while retaining Unpredictable Recombination. Current PoE Wiki documentation describes both modes and the current sequence for Unpredictable Recombination: choose final base, determine prefix/suffix counts, choose which side fills first, then select modifiers subject to restrictions.

GGG also explicitly changed Unpredictable Recombination in 3.26 so that inputs with many modifiers that cannot normally roll on the resulting item—such as Veiled or Essence modifiers—produce fewer output modifiers on average.

Do not use legacy Sentinel probabilities.

Do not assume 3.25 behavior.

Do not assume:

```text
50% chance per modifier
```

Implement a data object:

```js
{
  version: '3.29',

  source: {
    officialRules: [...],
    empiricalDataset: ...
  },

  baseSelectionModel: ...,

  affixCountDistribution: {
    prefix: ...,
    suffix: ...
  },

  modSelectionModel: ...,

  exclusivePenaltyModel: ...,

  restrictions: ...
}
```

Every uncertain empirical parameter should include:

```js
{
  estimate,
  sampleSize,
  confidence,
  source
}
```

If probability is not known:

mark it unknown.

Do not invent it.

---

# 11. Support both Predictable and Unpredictable Recombinators

The current examples only talk about Unpredictable Recombination.

That ignores an entire modern mechanic.

The optimizer should consider:

```text
PredictableRecombine(A,B,selections)
```

and:

```text
UnpredictableRecombine(A,B)
```

as separate operators.

Predictable Recombination allows the player to select modifiers they want transferred, with success chance displayed by the game; failure can destroy both items.

The solver needs an interface for empirical/displayed success probability until a complete formula is known.

If the exact formula is not publicly known, do not hallucinate one.

---

# 12. Donor generation must have real mini-plans

Current Recombinator output saying:

```text
Donor A expected cost ~6c
```

without showing how the donor is produced is unacceptable.

Every donor state must be generated by the same crafting optimizer.

Example:

```text
Target donor:
T1 flat ES
T3 lightning resistance
```

The solver should recursively calculate:

```text
best donor route:
Dense Fossil
or
Alteration + Regal
or
Essence
or
Chaos
...
```

and return:

```text
expected attempts
per-attempt cost
cleanup probability
resulting donor EV
```

No donor should have a magical synthetic cost.

---

# 13. Recombination should partition the target intelligently

For target set:

```text
T = {m1, m2, m3, m4, m5}
```

generate useful subsets:

```text
{m1}
{m2}
{m1,m2}
{m1,m3}
{m1,m2,m3}
...
```

But prune aggressively.

Do not force:

```text
prefix donor + suffix donor
```

Do not force:

```text
3 mods + 2 mods
```

Mixed-side donor states are legal and sometimes optimal.

Let actual EV decide.

However, do not value states solely by number of desired mods.

---

# 14. Implement subsystem difficulty analysis

The ES chest example reveals another missing concept.

The difficult subsystem was:

```text
T1 hybrid ES
T1 % ES
T1 flat ES
```

The resistance suffixes were easy.

The solver instead mixed resistance mods into donor states because they were cheap additions.

Before planning, build a dependency/difficulty graph.

For each target mod calculate:

```text
C(mi) = expected standalone acquisition cost
```

For pairs:

```text
C(mi,mj)
```

For useful triples:

```text
C(mi,mj,mk)
```

Then estimate coupling:

```text
dependencyPenalty(A,B)
=
C(A ∪ B) - independentAssemblyValue(A,B)
```

High positive coupling is where Recombinators can be valuable.

This naturally identifies:

```text
triple-T1 ES prefixes = difficult coupled subsystem
resistance suffixes = cheap subsystem
```

without hardcoding “ES armour means prefixes first.”

---

# 15. Add completed-side valuation

A completed 3-prefix or 3-suffix side is strategically important.

If the current state contains:

```text
P1 target
P2 target
P3 target
```

the optimizer should immediately evaluate every operation that preserves prefixes:

* Prefixes Cannot Be Changed
* Eldritch suffix manipulation
* Harvest with prefix protection
* Veiled operations
* Bench finishing
* annul/block combinations

before exposing those prefixes to a destructive operation.

This should emerge from EV, not from a hardcoded prohibition.

---

# 16. Implement proper Eldritch search

The repo already contains Eldritch Chaos/Annul/Exalt knowledge and dominance rules.

But these should become generic operators.

Current mechanics:

* Searing Exarch dominant → Eldritch Chaos rerolls prefixes
* Eater dominant → rerolls suffixes

The wiki confirms the dominance-dependent behavior of Eldritch currency.

Create explicit transitions:

```js
setupEldritchDominance(state, desiredSide)
eldritchChaos(state)
eldritchAnnul(state)
eldritchExalt(state)
```

Then let the optimizer discover:

```text
complete prefixes
→ make Eater dominant
→ Eldritch Chaos suffixes
→ bench
```

when it is cheaper than recombination.

---

# 17. Veiled crafting needs a complete model

Current `craftKnowledge.js` has a tiny manually curated `VEILED_TARGETS` list with fallback probabilities for only a few cases.

That is insufficient.

The repo already downloads all unveiled mods through RePoE.

Build the unveil pool dynamically.

Need separate operators for:

```text
Veiled Chaos Orb
Veiled Exalted Orb
```

These are different mechanics.

Current PoE mechanics:

* Veiled Chaos rerolls the rare item and includes a Veiled modifier.
* Veiled Exalted removes a random modifier then adds a Veiled modifier.
* Veiled Exalted respects Prefixes/Suffixes Cannot Be Changed for removal.

The current knowledge file does encode these broad effects, but unveil probability still needs real eligible-pool construction.

Do not use:

```text
1 - (1 - 1/13)^3
```

unless 1/13 is actually derived from the valid unveil pool.

---

# 18. Bench blocking must be universal

The current code already has:

```text
bestBlockCraft
bestCannotRollAssist
```

and some temporary blocker logic.

That is good.

Turn blockers into a generic optimization action.

For every additive operation:

```text
Exalt
Eldritch Exalt
Harvest augment
Veiled
Influence Exalt
```

evaluate possible temporary bench blockers.

For blocker `b`:

```text
EV_without_block
EV_with_block
```

include:

* blocker cost
* reduced pool
* occupied affix slot
* required bench removal
* possibility blocker prevents the target

Choose whichever has lower EV.

No hardcoded “block X before Y.”

---

# 19. Fix Annul modelling

The solver must model actual Annul mechanics.

An Orb of Annulment removes a random explicit modifier, but Cannot Roll Attack/Caster can affect protection behavior specifically for Annul; other remove effects do not necessarily behave identically. The current PoE Wiki modifier documentation explicitly notes that the Cannot Roll behavior is specific to Orb of Annulment and does not generically protect against every removal mechanic.

Therefore:

```text
removeRandomModifier
```

cannot be one shared generic implementation for:

* Annul
* Veiled Exalted removal
* Harvest remove
* Beastcraft remove

Each needs separate rules.

---

# 20. Implement full Harvest menu before claiming universal optimization

Coverage currently says Harvest add/remove and non-reforge crafts are only partial.

This is a meaningful gap.

Import structured data for:

* augment X / remove random
* resistance swaps
* other current relevant Harvest crafting actions

Do not scrape assumptions manually if structured data is available from PoEDB or another reliable current source.

The optimizer cannot correctly compare routes if major core operators are absent.

---

# 21. Add Beastcrafting

Coverage also lists Beastcrafting as partial.

Important craft-relevant operations include generic transformations such as:

```text
Add Prefix, Remove Suffix
Add Suffix, Remove Prefix
Split
```

These should be modelled as transitions.

Be careful with metamod interactions. Different removal mechanics obey different restrictions.

Research current behavior individually.

---

# 22. Improve Fossil support

RePoE already provides full Fossil data, including positive/negative weighting, forced mods, forbidden tags and allowed tags. The project currently downloads all of this.

But solver support appears much narrower than the available data.

Build a generic fossil simulator:

```js
applyFossilCombination(state, fossils)
```

It should derive modified spawn weights from RePoE data.

Search reasonable resonator combinations.

Do not hardcode only Dense/Hollow.

Prune combinations that do not affect any desired mod or useful blocker.

---

# 23. Essence expected-value calculation should use full affix generation

The current operator helper contains fixed rough values like:

```text
40 essences expected
15 essences expected
```

in `craftOperators.js`.

These must disappear from production EV.

The project already has stronger weighted functions such as:

```text
essenceFishExpected
multiGenEssenceFishExpected
jointAndInDraws
```

in `spawnWeights.js`.

All Essence planning should use those data-driven calculations.

No arbitrary 15/20/40 attempt values.

---

# 24. Eliminate guessEssenceName-style heuristics

`craftSearch.js` contains text-pattern guessing such as:

```text
attack speed → Deafening Essence of Zeal
Strength → Rage
Life → Greed
Fire Resistance → Anger
Energy Shield → Misery
```

This is unsafe.

The project already has RePoE Essence tables that map Essence to exact item-class granted mods.

Always resolve through data.

Do not infer mechanics from English strings if structured data exists.

---

# 25. Remove arbitrary cost heuristics

`craftKnowledge.js` contains:

```text
INFLUENCED_BASE_PREMIUM = 50
```

and uses that as a typical premium to compare buying influenced bases.

This is not acceptable for an EV planner.

The repo coverage itself says live trade prices are missing.

Until trade integration exists:

* mark base price as unknown
* show currency-only craft cost
* do not fabricate a 50c market premium

The official Path of Exile developer API exposes league, account, stash and currency-exchange resources, but full trade-market pricing requires using the appropriate trade/public data APIs with rate-limit compliance.

Implement market pricing separately rather than pretending a generic premium is data.

---

# 26. Price every meaningful input

Current daily pricing is useful, but recombination introduced Gold and Thaumaturgic Dust costs that were being shown with `nullc`.

Internal non-tradeable resources should not silently contribute zero chaos EV.

Represent costs as multiple dimensions:

```js
{
  chaosEquivalent: 120,
  gold: 3400,
  thaumaturgicDust: 800
}
```

Do not convert non-tradeable resources into chaos unless a defensible opportunity-cost model exists.

Display:

```text
120c + 3400 Gold + 800 Dust
```

instead of:

```text
120c
```

and pretending the rest is free.

---

# 27. Separate monetary EV from effort/resource EV

Add optional objective profiles:

```text
minChaos
minClicks
minExpensiveFailures
minGold
balanced
```

Default should remain:

```text
minimum expected tradable currency cost
```

but still display:

* expected attempts
* Gold
* Dust
* number of risky destructive attempts
* probability of total restart

Two routes with similar chaos EV can feel radically different.

---

# 28. Correct salvage value

This is likely the source of the absurdly cheap 97c recombination chest.

Do not value a fallback as:

```text
what it cost to manufacture
```

Do not value it as:

```text
sum of desired mods
```

Its value is only the reduction in future cost relative to starting over.

Conceptually:

```text
salvageValue(S)
=
max(0, V(start) - V(S))
```

Because `V(S)` is already the minimum expected future cost, recursive dynamic programming naturally handles salvage.

Do not separately subtract arbitrary salvage credits if the value function already includes fallback continuation.

Otherwise you double-count salvage.

---

# 29. Do not treat every failed recombination as reusable

Some failed outputs are technically usable but strategically awful.

A fallback should only retain value if there is a real low-EV path forward.

Examples:

```text
3 desired mods survived
```

does not automatically mean “valuable.”

If continuing requires reconstructing another 3-mod donor and another 3% recombination, it may be nearly worthless.

Use `V(fallback)`.

---

# 30. Stop labeling probabilistic plans deterministic

`craftPlanner.js` currently emits:

```text
Deterministic plan: ...
```

for every successful plan, even when the method contains recombination or other probabilistic operations.

Change plan classification to:

```text
Guaranteed finishing plan
Expected-cost optimized plan
Probabilistic recombination plan
High-variance plan
```

Never call a 3.3% recombination deterministic.

---

# 31. Build a strategy confidence system

Every plan should contain:

```js
confidence: {
  mechanics: 'high',
  probabilities: 'medium',
  prices: 'high'
}
```

For example:

```text
Recombinator output probability:
Medium confidence
Source: community empirical dataset
Sample size: 42,000
Game version: 3.29
```

This is much better than presenting uncertain recombinator data as exact.

---

# 32. Add source provenance to mechanics

The current knowledge metadata says some operators are curated from:

```text
PoE Wiki, PoEDB, Maxroll
```

which is too coarse.

Every mechanic should include source-level provenance:

```js
{
  sourceType: 'official' | 'datamine' | 'empirical' | 'community-doc',
  url,
  versionVerified,
  retrievedAt
}
```

Priority:

1. GGG patch notes / official documentation
2. current game data / RePoE
3. PoE Wiki documented mechanics
4. PoEDB
5. strong empirical community testing
6. guide sites only for strategy hints, never unseen mechanics

---

# 33. Improve RePoE version control

The repo currently builds from the live `repoe-fork.github.io` export.

RePoE is appropriate because it exposes mods, weights, base items, essences, fossils, crafting bench data and more.

But “live export” makes reproducing historical results difficult.

During build, save:

```text
source commit/hash
download timestamp
league/game version
```

into `manifest.json`.

Tests should run against a fixed known data snapshot.

---

# 34. Normalize item classes centrally

`deterministicPlanner.js` currently contains manual mappings:

```text
Wands → Wand
Belts → Belt
...
```

RePoE already has canonical item class data.

Create one canonical `normalizeItemClass()` module and use it everywhere.

Do not duplicate class normalization across planner files.

---

# 35. Remove text-based mod-family hacks where structured groups exist

`spawnWeights.js` currently contains manual text recognition for lines such as:

```text
energy shield + stun
fire resistance
critical strike multiplier
attack speed
```

to construct `modLineKey`.

Some text normalization will always be necessary, but prefer:

* stat IDs
* mod groups
* generation type
* canonical mod IDs
* tier series

over English regexes.

Create canonical mod-family IDs during the knowledge build.

Example:

```js
familyId = hash({
  generation,
  groups,
  statIds
})
```

Then tiers can be grouped without parsing displayed text.

---

# 36. Treat displayed item text as input, not source of mechanics

The parser should extract:

* values
* tier
* name
* tags
* type
* flags

but all actual mechanics should resolve to canonical KB mod IDs.

Once a mod is matched, downstream logic should avoid relying on regex text.

---

# 37. Improve unmatched-mod handling

If a target mod cannot be confidently matched:

do not continue with guessed probabilities.

Mark:

```text
Unsupported target modifier
```

and either:

* omit EV for that branch
* search routes that do not require rolling it
* require manual confirmation

The repository README already states the planner must not invent crafts.

Enforce that principle at runtime.

---

# 38. Add legality validation to every generated step

Before displaying a route, replay it through the mechanics engine.

Example:

```js
validatePlan(plan)
```

For each step verify:

* correct rarity
* required open affix
* valid item class
* correct influence
* no corrupted restriction
* metamod legality
* essence/metamod compatibility
* target mod actually eligible
* enough prefix/suffix slots
* recombinator input classes compatible
* bench craft can still fit

Any route that fails replay must be rejected.

---

# 39. Implement stochastic plan replay

For probability-heavy crafts, run Monte Carlo verification against analytic EV.

Example:

```text
analytic success: 3.34%
simulation 1M trials: 3.31%
```

If discrepancy exceeds tolerance:

fail tests.

This is especially valuable for:

* multi-mod Essence fishing
* Harvest
* Fossils
* Recombinators
* Annul recovery loops

---

# 40. Testing is currently far too small

`package.json` only exposes one test command:

```text
node scripts/test-deterministic.mjs
```

The current test script is mostly a smoke test containing hand-pasted sample items.

Convert to a real test hierarchy:

```text
tests/
  parser/
  knowledge/
  weights/
  mechanics/
  harvest/
  essence/
  fossils/
  unveil/
  eldritch/
  recombinator/
  optimizer/
  regression/
```

---

# 41. Add mechanic unit tests

Examples:

```text
occupied mod group cannot roll again
```

```text
full prefix side prevents prefix Exalt
```

```text
Suffixes Cannot Be Changed protects suffixes during supported reforge
```

```text
Veiled Exalted removal respects prefix/suffix lock
```

```text
Cannot Roll Attack affects guaranteed Harvest reforges under current ruleset
```

```text
Eldritch Chaos affects correct side based on dominance
```

```text
Essence guaranteed mod exists on correct item class
```

```text
Recombinator cannot increase fractured mod count under current rules
```

The current wiki documentation notes that modern Recombinators cannot increase the number of fractured modifiers on the result, unlike legacy Sentinel-era behavior.

---

# 42. Add regression items from real crafts

Maintain expected strategic behavior, not exact prices.

Examples:

## Kinetic Wand

Expected:

```text
fractured mana
→ Zeal
→ one crit
→ protect suffixes
→ targeted Crit
→ unveil chaos pen
→ bench
```

Recombinator should be considered but lose on EV if current prices/data support that.

## Triple-ES Regalia

Expected:

```text
solver identifies triple ES prefixes as primary difficult subsystem
```

It may choose:

* Fossil
* Essence
* Recombinator
* other valid current method

depending on current prices.

But it should not choose an absurd low-EV five-mod recombination merely because easy resistances increase desired-mod count.

## Five-natural-mod amulet

Expected:

Recombinator should be seriously explored because sequential Exalt/Annul accumulation becomes extremely expensive.

---

# 43. Regression tests should compare strategy invariants

Do not assert:

```text
must use exactly 37 Essences
```

because prices and data change.

Assert:

```text
does not raw-Exalt a 0.8% target hundreds of times when a lower-EV supported route exists
```

```text
does not call 3% plan deterministic
```

```text
does not value non-tradeable Gold as 0c silently
```

```text
does not use unknown Recombinator probability as exact
```

---

# 44. Introduce Pareto pruning

Full state search can explode.

Retain only Pareto-optimal states.

State A dominates B if:

* same strategically relevant affixes
* same or better free affix slots
* same/better constraints
* lower or equal accumulated cost
* no worse continuation options

Discard B.

---

# 45. Memoize state values

Canonicalize states:

```js
stateKey(state)
```

Include only future-relevant information.

Memoize:

```js
V(state)
```

Recombination donor costs should reuse the same cache.

---

# 46. Use bounded best-first search

A practical approach:

```text
A*
Dijkstra-like EV search
beam search with admissible lower bound
```

The heuristic lower bound could include:

```text
minimum standalone acquisition costs of unresolved hard modifier groups
```

Never use heuristic values as final EV.

They are only for pruning.

---

# 47. Generate macro-actions, but mechanically expand them

Some useful combinations should be searchable as macros:

```text
Suffixes Cannot Be Changed + Reforge Critical
```

```text
Prefixes Cannot Be Changed + Veiled Exalted
```

```text
bench blocker + Exalt
```

This reduces search depth.

But a macro-action must be decomposable into primitive game operations and validated exactly.

Do not encode special-case item recipes.

---

# 48. Distinguish irreversible and recoverable transitions

Mark operations:

```js
risk: {
  canBrickKeeper: true,
  canDestroyInputs: false,
  restartRequiredProbability: ...
}
```

This helps both:

* EV
* UI explanation

A 10% operation with reusable failures differs massively from a 10% operation that destroys two expensive donors.

---

# 49. Add restart-state semantics

For each operation, identify:

```text
success
useful fallback
restart donor A
restart whole craft
```

This simplifies expected-cost equations.

---

# 50. Model base acquisition independently

The target item base itself may have:

* fractured requirement
* influence requirement
* item-level requirement
* special implicit
* Synthesized state
* Eldritch eligibility

Represent base acquisition as its own operator.

Do not use hardcoded base premiums.

---

# 51. Do not attempt unsupported league mechanics

Do not implement Allflame / boat crafting right now.

The current coverage correctly marks it missing.

Leave it unsupported until:

* it is core
* mechanics are documented
* reliable structured data exists

Do not make strategy code depend on temporary league systems.

---

# 52. Improve output schema

A plan should contain:

```js
{
  method,
  expectedTradableCost,
  nonTradableCosts,
  successProfile,
  confidence,
  rulesVersion,
  dataVersion,

  stages: [...],

  alternatives: [...],

  rejectedStrategies: [...]
}
```

Each stage:

```js
{
  stateBefore,
  operation,
  stateGoal,
  successProbability,
  attemptsExpected,
  expectedCost,
  failureOutcomes,
  source
}
```

---

# 53. Show why alternatives lost

This is extremely valuable for debugging.

Example:

```text
Selected:
Zeal → Reforge Critical → Veiled Exalted
Expected: 18.2d
```

```text
Rejected:
Recombinator donor tree
Expected: 31.7d
Reason: 0.9% final merge and expensive donor rebuilds
```

```text
Rejected:
Raw Exalt
Expected: 96.4d
Reason: target share 0.82%
```

This lets users and developers catch bad assumptions quickly.

---

# 54. Add a solver-debug mode

Output:

```text
Current state
Eligible operations
Estimated Q-value of each operation
Pruning reason
Pool composition
```

For example:

```text
State: Mana fracture + Zeal AS + Crit Chance

Reforge Critical:
eligible crit mods:
  Global Crit Multi T1: 1000
  Global Crit Multi T2: 2000
target success: ...

Recombinator continuation:
expected: ...

Selected:
Reforge Critical
```

This is essential for tuning.

---

# 55. Add pool inspection UI

For any suggested operation:

```text
Show eligible pool
```

The user should be able to verify:

```text
Target weight: 1000
Pool: 6000
Chance: 16.67%
```

This makes incorrect group/tag handling visible immediately.

---

# 56. Fix source duplication

Currently game facts exist in multiple places:

* `craftKnowledge.js`
* generated `harvest-reforge-official.json`
* `craft-operators-official.json`
* code heuristics

Create one canonical mechanics dataset.

Prefer generated JSON for data.

Code should consume it.

Do not duplicate Harvest costs and effects in both JavaScript and JSON.

---

# 57. Make knowledge build produce normalized operators

`build-knowledge-base.mjs` should generate:

```text
operators.json
```

where every operation follows the same schema:

```js
{
  id,
  requirements,
  cost,
  effect,
  tags,
  respectsMetamods,
  sources,
  version
}
```

Then planner code does not need custom knowledge constants for each system.

---

# 58. Explicitly model modifier source compatibility

A mod can be:

```text
natural
essence-only
veiled
crafted
delve
influence
fractured copy
```

These sources matter for:

* whether it can naturally roll
* whether it can be recombined
* current recombinator exclusive penalty
* whether it can be unveiled
* whether a method can create it

Do not collapse source into just “desired prefix.”

---

# 59. Add method availability checks

Before assigning a mod method, verify:

```text
Can Essence actually produce it on this item class?
Can Harvest target its tag?
Can it naturally spawn?
Can it be unveiled?
Can an influence Exalt generate it?
```

Current code still has string-based helper logic that can guess method suitability.

Remove guesses.

---

# 60. Add confidence-aware unknown handling

If mechanic probability is unknown:

```text
expectedCost = unknown
```

Do not quietly assign a guessed percentage.

The planner can still show:

```text
Potential Recombinator route
Cost not ranked due to insufficient probability data
```

This is preferable to confidently wrong output.

---

# 61. Correct plan naming

Rename `deterministicPlanner.js`.

It is no longer conceptually deterministic.

Suggested modules:

```text
planner/
  optimizer.js
  state.js
  stateKey.js
  transitions.js
  heuristics.js
  pruning.js
```

Keep deterministic-only helpers separately if needed.

---

# 62. Break up the 123 KB planner

`deterministicPlanner.js` is currently 123,565 bytes.

This is a clear maintainability issue.

Suggested decomposition:

```text
mechanics/
  pool.js
  essence.js
  harvest.js
  fossil.js
  annul.js
  exalt.js
  veiled.js
  eldritch.js
  influence.js
  recombinator.js
  bench.js

planner/
  optimizer.js
  donorSearch.js
  macros.js
  pruning.js
  valueFunction.js

knowledge/
  loader.js
  normalization.js

pricing/
  currency.js
  trade.js
```

---

# 63. Remove obsolete planner layers

Current call chain is approximately:

```text
craftPlanner
→ sideCompletionPlanner
→ deterministicPlanner
```

`sideCompletionPlanner.js` is currently basically a thin forwarding wrapper around `planDeterministic`.

Remove unnecessary indirection unless it gains a real responsibility.

---

# 64. Decide whether old `craftSearch.js` is legacy

The project contains:

* `craftSearch.js`
* `craftPlanner.js`
* `deterministicPlanner.js`
* `craftCalculator.js`
* `craftOperators.js`

There is significant conceptual overlap.

Identify which path production UI actually uses.

Delete/deprecate old recipe code after migration.

Do not maintain two incompatible probability models.

---

# 65. Add static consistency tests across knowledge files

Examples:

```text
all Essence referenced mod IDs exist
all bench mod IDs exist
all Harvest IDs unique
all base tags resolve
all natural mods assigned canonical families
```

The current coverage build already tracks totals, which is a good start.

Expand this into CI validation.

---

# 66. Add build provenance

`coverage.json` already records:

```text
built_at
RePoE version hint
counts
```

Good.

Add:

```text
RePoE commit SHA
ruleset version
operator dataset version
Git commit
price snapshot timestamp
```

Every plan should expose this in debug mode.

---

# 67. Market integration should be a separate milestone

Current prices are currency snapshots.

Do not block optimizer architecture on live item trade pricing.

Phase 1:

```text
currency EV only
base acquisition unknown if trade-specific
```

Phase 2:

integrate live or cached item trade prices.

The official PoE developer docs should be the source for API policy, auth and rate-limit behavior.

---

# 68. Introduce benchmark crafts

Maintain a folder:

```text
benchmarks/
```

Each benchmark stores:

```js
{
  itemPaste,
  expectedBehavior,
  knownHumanRoute,
  source,
  notes
}
```

Examples should cover:

* triple defence prefixes
* Essence + Harvest crit
* unveil blocker
* influence slam
* 5-mod Recombinator project
* fracture craft
* Eldritch suffix finish

Run these in CI.

---

# 69. Human routes are test references, not hardcoded recipes

For known crafts, store:

```text
A competent human route exists around X–Y cost
```

Then detect solver regressions such as:

```text
solver proposes 250d route
```

Do not force the human sequence if the optimizer finds something cheaper with valid mechanics.

---

# 70. Add sanity bounds

Reject suspicious EV outputs.

Examples:

If:

```text
final merge success = 3%
```

and:

```text
fresh input reconstruction = 20c
```

a total plan EV of 25c is impossible unless fallback reuse is nearly complete.

Implement mathematical lower-bound checks.

Example:

```text
expectedCost >= irrecoverableCostPerAttempt / successProbability
```

for paths with mandatory irrecoverable costs.

This would have caught the 97c chest.

---

# 71. Add probability mass validation

Every stochastic operator must satisfy:

```text
Σ probabilities = 1
```

within tolerance.

For pruned outcome classes:

```text
success
useful fallback
other
```

still retain total probability mass.

---

# 72. Never use `Math.ceil(1/p)` as the EV

Several helpers use:

```text
ceil(1 / p)
```

for expected attempts.

The expected number of independent Bernoulli attempts is:

```text
1 / p
```

Do not ceil for EV.

Only ceil when displaying a human-friendly integer estimate.

Keep internal EV floating-point.

This alone can bias route comparisons.

---

# 73. Use probability distributions for affix counts

Do not approximate:

```text
~2 extra rolls per affix side
```

when exact or empirically measured affix-count distributions are required.

Each crafting method should have its own affix-count model.

Examples:

```text
Chaos
Essence
Harvest reforge
Fossil
Recombinator
```

Do not share a generic “two rolls per side” approximation.

---

# 74. Separate tier success definition from exact target

The current system often treats:

```text
selected tier and better
```

as success.

That is useful and should remain configurable.

But the target item may require:

```text
exact T2
```

or:

```text
T2 or better
```

Define:

```js
target.tierMode = 'exact' | 'atLeast'
```

Default copied items should probably mean “same tier or better” unless the item requires exact tier interactions.

---

# 75. Separate stat-roll value from tier

The solver currently targets tier, not exact roll.

That is correct for most crafting.

Keep Divine Orb optimization separate.

Do not mix:

```text
hit T1 affix
```

with:

```text
perfect roll within T1
```

unless the user requests exact numerical rolls.

---

# 76. Bench craft should be reserved during planning

The current system correctly tends to bench last.

Generalize this:

If the target has a bench-crafted prefix:

```text
reserve one prefix slot in terminal state
```

unless the route intentionally crafts/removes temporary blockers.

Do not reach a six-natural-affix state and then discover no bench slot exists.

---

# 77. Add terminal-state equivalence

The finished target should not require identical item name or mod order.

Target match should support:

```text
same desired mod family
same or better tier
required source when relevant
required crafted status when relevant
```

For example, an Essence-only affix may need exact source semantics.

---

# 78. Distinguish immutable target properties

Properties like:

```text
fractured T1 mana
```

can mean two different user intents:

1. They specifically want a fractured item.
2. They pasted a finished item and only care about the resulting stats.

The UI should allow:

```text
preserve special source properties
```

Default probably should preserve fracture/essence/veiled status when the stat cannot otherwise be reproduced equivalently.

---

# 79. Add acquisition-vs-crafting comparison for fractured bases

When a target contains a fracture:

consider:

```text
buy fractured base
```

versus:

```text
craft mod and fracture it
```

only if both are mechanically possible and prices exist.

Do not automatically choose the lowest spawn-weight mod for fracture.

---

# 80. Remove rarity-based fracture heuristic

The prior behavior:

```text
rarest desired mod → fracture
```

is not economically sound.

Fracture value should be:

```text
downstream EV without fracture
-
downstream EV with fracture
-
fracture acquisition cost
```

---

# 81. Influence acquisition must use real market data or remain unknown

Current fixed 50c influenced premium is particularly problematic.

Until trade pricing exists:

```text
Buy influenced base: market price unknown
```

should remain an unranked alternative.

Do not fake precision.

---

# 82. Add operation preconditions as data

Every operator should define:

```js
requirements: {
  rarity,
  itemClasses,
  influenced,
  corrupted,
  openPrefix,
  openSuffix,
  eldritchDominance,
  noVeiledMod,
  etc
}
```

The mechanics engine checks this before transition generation.

---

# 83. Add interaction tests for Essence + metamods

PoE Wiki notes Essences and fossil resonators cannot be used while metamods are present in the same way as many ordinary currencies.

The solver must not suggest illegal Essence-after-metamod states.

---

# 84. Add recombination compatibility rules

Current Recombinators require appropriate item-class compatibility.

Encode actual class rules.

Do not simply compare display names.

Also model:

* influence transfer restrictions
* fractured-mod count restrictions
* corrupted restrictions
* exclusive/source-specific modifiers
* invalid-on-output-base modifiers

Current PoE Wiki documents that corrupted items can no longer be recombined under modern rules.

---

# 85. Build a dedicated Recombinator research dataset

Do not bury empirical values in JS constants.

Create:

```text
public/data/recombinator/
  3.29.json
```

Example:

```js
{
  sourceUrl,
  authors,
  retrievedAt,
  patch,
  observations: [...],
  fittedModel: {...}
}
```

If community testing changes:

replace the data file.

Do not rewrite planner logic.

---

# 86. Prefer official mechanics over community strategy guides

For implementation decisions:

* GGG says what changed
* RePoE says what mods/data exist
* PoE Wiki explains current mechanics
* empirical community datasets estimate hidden probabilities

Do not use a build guide as evidence that a mechanic is guaranteed.

---

# 87. RePoE should remain the primary item-data source

This is a good decision already.

RePoE provides:

* mods
* spawn weights
* base items
* bench
* essences
* fossils
* item classes
* mod types

and is explicitly designed as structured Path of Exile data for developers.

Keep it.

Do not replace it with HTML scraping.

---

# 88. Add current-version assertions

When loading data:

```text
expected game version: 3.29
```

If RePoE snapshot version cannot be verified:

show warning.

Do not silently mix 3.29 planner rules with unknown game-data age.

---

# 89. Pricing should include timestamp staleness

Every plan should know:

```text
pricesFetchedAt
```

If snapshot is old:

```text
Prices are 3 days old
```

Cost ranking may have changed.

---

# 90. Expose raw cost formula

For every stage:

```text
81 × Essence of Woe × 3.5c = 283.5c
```

not only:

```text
283c
```

This makes debugging much easier.

---

# 91. Add alternate objective: probability of completion under budget

Later, support:

```text
I have 20 divines
```

Then optimize:

```text
maximum probability of reaching target within budget
```

This can reuse the state engine.

Do not build this until baseline EV is correct.

---

# 92. Implementation phases

## Phase 1 — correctness foundation

Implement:

* canonical CraftState
* canonical eligible-pool API
* primitive operation transitions
* exact metamod interactions
* versioned rules
* plan replay validator
* proper tests

Do not change UI significantly yet.

## Phase 2 — optimizer

Implement:

* state keys
* memoized `V(state)`
* best-first search
* pruning
* macro-actions
* completed-side valuation

Replace recipe selection gradually.

## Phase 3 — full core crafting operators

Add:

* generic Fossils
* full Harvest
* Beastcraft
* complete Veiled modelling
* influence operations
* Eldritch operations

## Phase 4 — Recombinators

Implement:

* current rules
* Predictable mode
* Unpredictable mode
* donor recursive planning
* real empirical data
* fallback-state valuation

Do not enable Recombinator route ranking until probability tests are trustworthy.

## Phase 5 — market pricing

Add:

* base prices
* fractured bases
* influenced bases
* possibly finished-item comparison

Use official API constraints and rate limits.

## Phase 6 — UX/debugging

Add:

* alternative routes
* why chosen
* why rejected
* pool inspector
* probability source
* confidence
* data version

---

# 93. Immediate bugs/technical debt to fix before the rewrite

1. Remove fixed attempt counts such as 15/20/40 Essence estimates.
2. Remove `guessEssenceName`.
3. Replace `Math.ceil(1/p)` internal EV with `1/p`.
4. Stop labeling every plan deterministic.
5. Remove `INFLUENCED_BASE_PREMIUM = 50` from ranked EV.
6. Do not treat unknown Gold/Dust cost as zero.
7. Remove hardcoded “crit effectively guaranteed” statements.
8. Require donor mini-plans before assigning donor cost.
9. Validate every plan by replay.
10. Stop double-counting fallback salvage.
11. Add probability-mass assertions.
12. Centralize item-class normalization.
13. Consolidate duplicate mechanics sources.
14. Version Harvest metamod behavior.
15. Mark Recombinator EV experimental until model is verified.

---

# 94. Target behavior after overhaul

For the Kinetic Wand, the solver should reason approximately:

```text
T1 mana fracture already solved.

Zeal guarantees attack speed.

Fishing either Crit suffix has moderate EV.

After one Crit family is occupied, evaluate:
Suffixes Cannot Be Changed + Reforge Critical.

Recalculate exact current eligible Critical pool.

If the second target is highly likely or forced:
finish suffixes deterministically.

Then protect suffixes and solve Chaos Pen unveil.

Bench final Spell Damage prefix.
```

It should compare this against Recombinator and reject Recombinator if more expensive.

For the Regalia, it should reason approximately:

```text
Triple T1 ES prefixes dominate craft difficulty.

Evaluate:
Dense/Fossil route
Essence route
Recombinator assembly route
other supported prefix-generation routes

Once 3 ES prefixes are complete:
protect them.

Solve easy resistance suffixes using the cheapest safe side manipulation.

Bench final resistance.
```

For the five-natural-mod amulet:

```text
No strong deterministic chain exists.

Sequential late Exalt slams have huge EV.

Generate donor subsets.

Evaluate recombination trees.

Use Recombinator if actual current probabilities and donor costs beat sequential construction.
```

These behaviors should emerge from the optimizer.

They should not be three hardcoded recipes.

---

# 95. Final design principle

The planner should not learn:

```text
How to craft an ES chest.
How to craft a crit wand.
How to craft this specific amulet.
```

It should learn:

```text
What every crafting action does to an exact item state.
```

Then the optimizer discovers the craft.

That is what will make `How Do I Craft This` genuinely universal rather than an expanding collection of special cases.
