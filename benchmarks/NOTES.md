# Benchmark notes (§68–69, §94)

Human routes are **references**, not golden recipes. Benchmarks assert strategy *signals*
(fracture / essence / harvest / unveil / eldritch / bench / experimental recomb) and
invariants (no chaos-spam, recomb never “deterministic”), not exact step wording or
essence attempt counts.

## Cases

### Kinetic Wand (Cataclysm Needle)
- **Human route:** Fracture T1 mana → Deafening Zeal until AS + crit family → SCBC →
  Reforge Critical → SCBC → Veiled → unveil chaos pen → bench hybrid.
- **Expected emergent behaviors:**
  - Prefer fracture lock over rolling T1 mana.
  - Essence of Zeal for attack speed (class-guaranteed), not alt for AS.
  - Harvest Crit covers both crit chance + multi rather than two independent exalts.
  - Unveil for chaos pen (not natural slam).
  - Bench last so the craft slot stays free.
  - Implicit “Cannot roll Caster” should shrink caster-tagged pools.

### Triple-ES Twilight Regalia
- **Human route:** Fracture hybrid %ES → Woe for flat ES → Eldritch Chaos for resists → bench.
- **Expected emergent behaviors:**
  - Multiple ES prefixes: fracture the awkward hybrid; essence for flat.
  - Eldritch dominance used to fish the open side without wiping the finished side.
  - Bench finisher after open slot.

### 5-mod amulet
- **Human route:** Cheap sequential (alt/regal/exalt/essence) *or* experimental recomb.
- **Expected emergent behaviors:**
  - Solver may pick sequential when donors are not cheaper.
  - If recomb wins, plan is `probabilistic-recombination` + `experimental`.
  - Never treat unpublished gold/dust smash cost as 0c exact.

## Running

```bash
npm test                 # full suite including benchmarks
npm run test:benchmarks  # benchmarks only
```

Set `MC_TRIALS=1000000` for 1M Monte Carlo trials (§39).
