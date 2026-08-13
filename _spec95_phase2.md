# Phase 2 / Optimizer-related extracts from 95-point architecture spec

## Source note

Extracted top-level sections: §1–5, §7, §12–15, §28–29, §44–50, §61–64, §70, §74–77, §80, §94

---

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
