/**
 * Scaffold assignAndBuild — sequential step materializer core.
 */
import {
  multiGenEssenceFishExpected,
  harvestGoalOdds,
  altExpected,
  exaltExpected,
  eldritchSideExpected,
  unveilExpected,
  formatWeight,
  collectOccupiedGroups,
  harvestEligiblePool,
  formatEligiblePool,
} from '../../spawnWeights.js';
import { normalizeItemClass } from '../../itemClass.js';
import { rulesetVersion } from '../../ruleset.js';
import {
  METACRAFT,
  chaosCost,
  formatCostBreakdown,
  harvestWithMetacraftCost,
  harvestCostBag,
  modMatchesHarvest,
  essencePriceKey,
  requiredInfluences,
  recommendInfluenceAcquisition,
  formatInfluenceBaseStep,
} from '../../craftKnowledge.js';
import { considerRecombinator } from '../../recombinatorSearch.js';
import {
  short,
  mergeCost,
  renumber,
  pct,
  formatAttempts,
  expectedAttemptsEv,
  clampRoll,
  stampPlan,
  step,
  pickSlamBlock,
  blockActionPrefix,
  blockDetail,
  preferVeiledChaos,
  veiledOrbCost,
  costOf,
  rankCost,
  bestSharedHarvest,
  harvestMetacraftSides,
  sideRerollGensAhead,
  unprotectedDoneKeepersOnSide,
  assignHarvestMethod,
  assignEssenceFishNatural,
  occupiedGroupsNow,
  isBenchMod,
  isInfluenceGoal,
  ensureFinalBenchSteps,
} from './helpers.js';
import { candidatesFor } from './candidates.js';
import {
  isFractureEligible,
  pickLeastWeightFractureMod,
  withInfluenceTags,
  pickInfluenceSlamTarget,
  pushInfluenceSlamPipeline,
} from './fractureInfluence.js';
import {
  applyCannotRollExaltAssist,
  pushSlamSideKeeperAlt,
  preferFractureWeightLine,
  buildAnnulForBenchSpace,
  exaltOpenSlotBag,
  exaltMetacraftBag,
  affixGen,
} from './exaltAnnul.js';
import { essenceExtraRollsByGen } from '../../mechanics/affixCounts.js';
import { analyzeTagSideClusters } from '../heuristics.js';

function assignAndBuild(item, mods, kb, baseTags, minIlvl, drivers, itemClass, opts = {}) {
  const preferFractureEnabled = opts.preferFracture !== false;
  const prices = kb.prices;
  const tagClusters = analyzeTagSideClusters(mods);
  const costs = {};
  let steps = [];
  const tips = [];
  const alternatives = [];
  let preferFracture = null;

  for (const m of mods) {
    m.candidates = candidatesFor(kb, itemClass, baseTags, minIlvl, m, occupiedGroupsNow(mods), mods);
    m.best = m.candidates[0];
  }

  for (const c of (tagClusters.clusters ?? []).slice(0, 3)) {
    tips.push(c.thought);
  }

  const fractured = mods.filter((m) => m.fractured);
  // Crafted/bench mods are reserved until the end so RNG steps keep a free slot.
  const benchMods = mods.filter(isBenchMod);
  const unveilMods = mods.filter((m) => m.veiled || m.best?.type === 'unveil');
  const open = () =>
    mods.filter((m) => !m._done && !m.fractured && !isBenchMod(m) && !unveilMods.includes(m));

  // 1. Base (+ influence: mid-craft slam for hard influence goals, else buy-vs-orb)
  const needInf = requiredInfluences(item, mods);
  const influenceSlam =
    needInf.length === 1 && !fractured.some((m) => isInfluenceGoal(m))
      ? pickInfluenceSlamTarget(mods, kb, baseTags, minIlvl)
      : null;
  // Prefer fracturing rarest natural on the slam side (keepers allowed; influence exalt needs open slots, not empty side).
  const fracOpts = influenceSlam ? { preferSlamGen: influenceSlam.mod.gen } : {};
  const infAcq = recommendInfluenceAcquisition(needInf, prices, {
    preferMidCraftSlam: !!influenceSlam,
  });
  const infStep = formatInfluenceBaseStep(item.baseName, minIlvl, infAcq, {
    fractured: fractured.length > 0,
    fracturedMods: fractured.map((m) => m.short),
  });
  if (infAcq && infStep?.cost) mergeCost(costs, infStep.cost);

  if (fractured.length) {
    for (const m of fractured) {
      m._done = true;
      m.method = 'fractured';
      m.chance = 1;
      m.weightLine = 'N/A (fractured)';
      m.note = 'Buy fractured.';
    }
    steps.push(
      step(
        'buyFractured',
        'quality',
        infStep?.action ??
          `Buy fractured ${item.baseName} (ilvl ${minIlvl}+) with: ${fractured.map((m) => m.short).join(', ')}`,
        [
          `Fractured anchors. ${drivers.map((d) => `${d.text} needs ilvl ${d.req}`).join('; ')}`,
          infStep?.detail,
        ]
          .filter(Boolean)
          .join(' '),
        fractured.map((m) => m.short),
        infStep?.cost ?? {},
        { chance: 1, chanceLabel: '100% (trade)', influence: infAcq?.influences }
      )
    );
  } else {
    steps.push(
      step(
        'buyBase',
        'quality',
        infStep?.action ?? `Acquire ${item.baseName} (ilvl ${minIlvl}+)`,
        infStep?.detail ?? `Min ilvl from knowledge-base required_level.`,
        drivers.map((d) => d.text),
        infStep?.cost ?? {},
        { chance: 1, chanceLabel: '100%', influence: influenceSlam ? [] : infAcq?.influences }
      )
    );
  }

  // Influence slam runs AFTER pre-influence essence/alt (essence remakes rares and wipes influence).
  // Pipeline is pushed later — see post-essence block.

  // 2. Choose at most ONE essence — the one that saves the most vs next-best non-essence option
  let chosenEssence = null;
  let essenceTarget = null;
  {
    const canEldritchArmour = ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(
      normalizeItemClass(itemClass)
    );
    const defenceEssAvailable =
      canEldritchArmour &&
      open().some((m) =>
        m.candidates.some(
          (c) =>
            c.type === 'essence' &&
            /Woe|Doubt|Dread|Loathing|Spite|Misery|Envy/i.test(c.essenceName ?? '')
        )
      );
    let bestSave = 0;
    for (const m of open()) {
      if (isInfluenceGoal(m)) continue; // influence = slam/exalt after influence exists
      if (influenceSlam) {
        const slamGen = influenceSlam.mod.gen;
        const fillGen = slamGen === 'suffix' ? 'prefix' : 'suffix';
        // Clean scours the fill side — don't essence keepers there before slam.
        if (m.gen === fillGen) continue;
        // Slam-side naturals are fracture/alt keepers, not essence lead
        if (m.gen === slamGen && isFractureEligible(m, null, fracOpts)) continue;
      }
      const ess = m.candidates.find((c) => c.type === 'essence');
      if (!ess) continue;
      // Don't burn the single essence slot on a resist/attribute filler
      const isFiller =
        (/Resistance/i.test(m.text) && !/Penetrate/i.test(m.text) && !m.ofEssence) ||
        (/to (Strength|Dexterity|Intelligence)\b/i.test(m.text) && !m.ofEssence);
      if (isFiller) continue;
      // Armour with Woe/Doubt/Dread available: never burn the slot on Greed — fish life instead
      if (defenceEssAvailable && /Greed/i.test(ess.essenceName ?? '')) continue;

      const alt =
        m.candidates.find((c) => c.type === 'harvest' || c.type === 'exalt' || c.type === 'unveil') ??
        m.candidates.find((c) => c.type !== 'essence') ?? { expectedChaos: 99999 };
      let save = alt.expectedChaos - ess.expectedChaos;
      // Prefer essence on harvestable hard mods (MS, ES, crit, etc.)
      if (m.harvests.length) save += 2000;
      // Prefer defence guarantees (enables fish-all) over other harvest families
      if (canEldritchArmour && m.harvests.some((h) => h.id === 'reforge-defence')) save += 800;
      if (save > bestSave && save > 20) {
        bestSave = save;
        chosenEssence = ess;
        essenceTarget = m;
      }
    }
    // Also: if paste marked ofEssence, force that essence
    const forced = open().find((m) => m.ofEssence);
    if (forced) {
      const ess = forced.candidates.find((c) => c.type === 'essence') || {
        type: 'essence',
        essenceName: forced.candidates.find((c) => c.essenceName)?.essenceName || 'Deafening Essence',
        essenceKey: 'essence-deafening',
        expectedChaos: 8,
        chance: 1,
        cost: { 'essence-deafening': 1 },
      };
      if (!ess.essenceName && /attack speed|movement speed/i.test(forced.text)) {
        ess.essenceName = 'Deafening Essence of Zeal';
        ess.essenceKey = essencePriceKey(ess.essenceName);
      }
      chosenEssence = { ...ess, essenceName: ess.essenceName || 'Deafening Essence of Zeal' };
      if (!chosenEssence.essenceKey) chosenEssence.essenceKey = essencePriceKey(chosenEssence.essenceName);
      essenceTarget = forced;
    }
  }

  if (chosenEssence && essenceTarget) {
    const others = open().filter((m) => m !== essenceTarget);
    const sameSideHarv = others.filter((m) => m.gen === essenceTarget.gen && m.harvests.length);
    const fishShared = bestSharedHarvest(sameSideHarv);
    let fishSet = fishShared?.covered?.length ? [...fishShared.covered] : [...sameSideHarv];
    const canEldritch = ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(
      normalizeItemClass(itemClass)
    );
    // Defence essence on armour: also fish same-side life (and other harvest prefixes)
    if (
      canEldritch &&
      fishShared?.harvest?.id === 'reforge-defence'
    ) {
      for (const m of others) {
        if (m.gen === essenceTarget.gen && m.harvests.length && !fishSet.includes(m)) {
          fishSet.push(m);
        }
      }
    }
    // Same-side attr/resist fillers: fold into essence fish (item becomes rare — no late alts).
    // Opposite-side fillers: also fish during essence on non-armour (Eldritch covers armour).
    if (!canEldritch) {
      for (const m of others) {
        if (
          m.gen === essenceTarget.gen &&
          !fishSet.includes(m) &&
          m.candidates.some((c) => c.type === 'alt')
        ) {
          fishSet.push(m);
        }
      }
    }
    let fishAlts = canEldritch
      ? []
      : others.filter(
          (m) => m.gen !== essenceTarget.gen && m.candidates.some((c) => c.type === 'alt')
        );

    // Defence on armour: fish ALL targets during essence (weight math). Crit weapons: fish one + harvest.
    const fishAllFamily =
      fishSet.length >= 1 && fishShared && fishShared.harvest.id === 'reforge-defence';

    // Never fish mods with no spawn weight on this base (influence mismatch, etc.).
    // Never fish influence goals during essence — they need an influenced item.
    // Never fish keepers on a side a later harvest/eldritch will wipe (finish those after).
    // Skip essence-fish goals: they are not harvested, so they must not imply a wipe.
    const wipeGens = sideRerollGensAhead(mods, {
      essenceTarget,
      chosenEssence,
      itemClass,
      skipMods: [...fishSet, ...fishAlts],
    });
    fishSet = fishSet.filter(
      (m) =>
        (m.hitWeight ?? m.weight ?? 0) > 0 &&
        !isInfluenceGoal(m) &&
        !wipeGens.has(m.gen)
    );
    fishAlts = fishAlts.filter(
      (m) =>
        (m.hitWeight ?? m.weight ?? 0) > 0 &&
        !isInfluenceGoal(m) &&
        !wipeGens.has(m.gen)
    );
    // Keepers deferred off a wiped side finish after the reforge (open-slot exalt / cannot-roll).
    for (const m of mods) {
      if (m._done || m.fractured || isBenchMod(m) || !wipeGens.has(m.gen)) continue;
      if (m.harvests?.length && !m._skipHarvest && !isInfluenceGoal(m)) continue;
      m._openSlotExalt = true;
      m._finishAfterReroll = true;
    }

    const essGen = essenceTarget.gen || 'prefix';
    const reserveBench = opts.reserveBenchSlot !== false;
    const benchSlots = (gen) =>
      reserveBench ? benchMods.filter((b) => affixGen(b) === gen).length : 0;
    // §73 affix-count dist; §76 cap extras so bench craft slots stay free.
    const distRolls = essenceExtraRollsByGen(kb, essGen);
    const EXTRA_ROLLS = {
      prefix: Math.max(0, Math.min(distRolls.prefix, 3 - benchSlots('prefix') - (essGen === 'prefix' ? 1 : 0))),
      suffix: Math.max(0, Math.min(distRolls.suffix, 3 - benchSlots('suffix') - (essGen === 'suffix' ? 1 : 0))),
    };
    // If fish goals + guarantee + bench would overflow a side, drop lowest-weight fish goals.
    const maxFishOnGen = (gen) =>
      Math.max(0, 3 - benchSlots(gen) - (essGen === gen ? 1 : 0) - mods.filter((m) => m.gen === gen && m.fractured).length);
    if (fishSet.length) {
      const byGen = { prefix: [], suffix: [] };
      for (const m of fishSet) {
        if (m.gen === 'prefix' || m.gen === 'suffix') byGen[m.gen].push(m);
      }
      fishSet = [];
      for (const gen of ['prefix', 'suffix']) {
        const room = maxFishOnGen(gen);
        const ranked = byGen[gen].slice().sort((a, b) => (b.hitWeight ?? b.weight ?? 0) - (a.hitWeight ?? a.weight ?? 0));
        fishSet.push(...ranked.slice(0, room));
      }
    }
    let fishMath = null;
    let fishPoolGen = essenceTarget.gen || 'prefix';
    let fishP = 0.05;
    let attempts = 2;
    let fullFishAttempts = 0;
    let fullFishChaos = 0;
    // Essence guarantee + fractured/done occupy groups; fish goals stay eligible.
    // Implicits/enchants never occupy (handled inside collectOccupiedGroups).
    const fishOccupied = collectOccupiedGroups([
      ...mods.filter((m) => m.fractured || m._done),
      essenceTarget,
    ]);

    const fishGoalsAll = () => [...fishSet, ...fishAlts];
    const computeFishMath = (goals, occupied) => {
      if (!goals?.length) return { expected: 2, pAll: 1, goals: [], pool: 0, weightSummary: '' };
      const math = multiGenEssenceFishExpected(kb, baseTags, minIlvl, goals, EXTRA_ROLLS, occupied);
      if (!math) return { expected: 2, pAll: 1, goals: [], pool: 0, weightSummary: '' };
      // Drop zero-weight goals (occupied group / wrong gen / unmatched) and recompute.
      if ((math.goals ?? []).some((g) => !(g.hitWeight > 0))) {
        const keep = goals.filter((m) => {
          const g = math.goals.find(
            (x) => x.short === m.short || x.short === short(m.text) || x.short === m.text
          );
          return g && g.hitWeight > 0;
        });
        // Nothing left to fish → guarantee-only essence (not 5000 @ 0%).
        if (!keep.length) return { expected: 2, pAll: 1, goals: [], pool: math.pool, weightSummary: '' };
        return multiGenEssenceFishExpected(kb, baseTags, minIlvl, keep, EXTRA_ROLLS, occupied);
      }
      return math;
    };

    fishMath = computeFishMath(fishGoalsAll(), fishOccupied);
    if (fishMath) {
      fishPoolGen = fishSet[0]?.gen || fishAlts[0]?.gen || essenceTarget.gen || 'prefix';
      fishP = fishMath.pAll;
      attempts = Math.min(Math.max(fishMath.expected, 1), 5000);
    }

    const key = chosenEssence.essenceKey || essencePriceKey(chosenEssence.essenceName);
    const essUnit = prices?.[key] ?? 8;
    fullFishAttempts = attempts;
    fullFishChaos = attempts * essUnit;

    // Prefer fractured base locking the lowest-weight natural goal (not essence guarantee).
    if (!fractured.length) {
      let fracMod = pickLeastWeightFractureMod(mods, essenceTarget, fracOpts);
      // Armour + defence essence: keep fishable prefixes free — fracture a low-weight suffix instead
      // (Eldritch savings) when it's not much rarer than the prefix pick.
      if (canEldritch && fishSet.length && fracMod && fishSet.includes(fracMod)) {
        const suffixFrac = pickLeastWeightFractureMod(
          mods.filter((m) => m.gen === 'suffix'),
          essenceTarget,
          fracOpts
        );
        const pw = fracMod.hitWeight ?? fracMod.weight ?? Infinity;
        const sw = suffixFrac?.hitWeight ?? suffixFrac?.weight ?? Infinity;
        if (suffixFrac && sw <= pw * 1.5) fracMod = suffixFrac;
      }
      if (fracMod) {
        let saveEss = 0;
        let saveChaos = 0;
        let withFishSet = fishSet;
        let withFishAlts = fishAlts;
        let withFishMath = fishMath;
        let withFishP = fishP;
        let withAttempts = attempts;
        if (fishSet.includes(fracMod)) {
          withFishSet = fishSet.filter((m) => m !== fracMod);
        } else if (fishAlts.includes(fracMod)) {
          withFishAlts = fishAlts.filter((m) => m !== fracMod);
        }
        if (fishSet.includes(fracMod) || fishAlts.includes(fracMod)) {
          const fracOccupied = collectOccupiedGroups([
            ...mods.filter((m) => m.fractured || m._done),
            essenceTarget,
            fracMod,
          ]);
          const remaining = [...withFishSet, ...withFishAlts];
          // Also drop fish goals that share an exclusive group with the fracture lock.
          const fracGroups = new Set(fracMod.groups ?? []);
          const remainingOpen = remaining.filter(
            (m) => m === fracMod || !(m.groups ?? []).some((g) => fracGroups.has(g))
          );
          withFishSet = withFishSet.filter((m) => remainingOpen.includes(m));
          withFishAlts = withFishAlts.filter((m) => remainingOpen.includes(m));
          withFishMath = remainingOpen.length ? computeFishMath(remainingOpen, fracOccupied) : null;
          withFishP = remainingOpen.length ? withFishMath?.pAll ?? 1 : 1;
          withAttempts = remainingOpen.length
            ? Math.min(Math.max(withFishMath?.expected ?? 2, 1), 5000)
            : 2;
          saveEss = fullFishAttempts - withAttempts;
          saveChaos = saveEss * essUnit;
        }
        preferFracture = {
          mod: fracMod,
          saveEss,
          saveChaos,
          weightLine: preferFractureWeightLine(fracMod),
          fishAllFamily,
          essName: chosenEssence.essenceName,
        };

        // If fracture wasn't in the essence fish set, estimate Eldritch Chaos savings when useful.
        if (saveChaos <= 0 && canEldritch && (fracMod.gen === 'prefix' || fracMod.gen === 'suffix')) {
          const gen = fracMod.gen;
          const sideGoals = mods.filter(
            (m) =>
              m.gen === gen &&
              !m.fractured &&
              !isBenchMod(m) &&
              m !== essenceTarget &&
              ((/Resistance/i.test(m.text) && !/Penetrate/i.test(m.text)) ||
                /to (Strength|Dexterity|Intelligence)\b/i.test(m.text) ||
                m.candidates.some((c) => c.type === 'alt'))
          );
          if (sideGoals.includes(fracMod) && sideGoals.length >= 2) {
            const without = sideGoals.filter((m) => m !== fracMod);
            const occFull = collectOccupiedGroups([
              ...mods.filter((m) => m.fractured || m._done),
              essenceTarget,
            ]);
            const occFrac = collectOccupiedGroups([
              ...mods.filter((m) => m.fractured || m._done),
              essenceTarget,
              fracMod,
            ]);
            const mathFull = eldritchSideExpected(kb, baseTags, minIlvl, gen, sideGoals, undefined, occFull);
            const mathFrac = eldritchSideExpected(kb, baseTags, minIlvl, gen, without, undefined, occFrac);
            const unit = prices?.['eldritch-chaos'];
            const saveEc = Math.max(0, mathFull.expected - mathFrac.expected);
            const saveEcChaos = unit != null ? saveEc * unit : 0;
            if (unit != null && (saveEc >= 10 || saveEcChaos >= 150)) {
              preferFracture.saveEldritch = saveEc;
              preferFracture.saveChaos = saveEcChaos;
              preferFracture.eldritchFull = mathFull.expected;
              preferFracture.eldritchWith = mathFrac.expected;
              preferFracture.saveKind = 'eldritch';
            }
          }
        }

        if (preferFractureEnabled) {
          fishSet = withFishSet;
          fishAlts = withFishAlts;
          fishMath = withFishMath;
          fishP = withFishP;
          attempts = withAttempts;
        }
      }
    }

    const fishLabels = [...fishSet, ...fishAlts].map((m) => m.short);
    const needFish = fishLabels.length > 0;
    if (!needFish) attempts = 2;

    // Crit harvest siblings: only need ANY one before harvest. Mixed fish (fillers) → fish all.
    const harvestOnlyFish = fishSet.length >= 2 && fishSet.every((m) => m.harvests.length);
    if (!fishAllFamily && harvestOnlyFish && fishMath) {
      const easiest = [...fishMath.goals].sort((a, b) => (b.hitWeight ?? b.weight) - (a.hitWeight ?? a.weight))[0];
      fishP = easiest.pHave;
      attempts = Math.min(Math.max(expectedAttemptsEv(fishP), 1), 500);
    }

    if (preferFracture) {
      const fm = preferFracture.mod;
      const wl = preferFracture.weightLine;
      const withAttempts =
        preferFracture.saveEss > 0 ? Math.max(1, fullFishAttempts - preferFracture.saveEss) : attempts;
      if (preferFractureEnabled) {
        fm._done = true;
        fm.method = 'fractured';
        fm.chance = 1;
        fm.weightLine = wl;
        fm.note = 'Prefer buy fractured (lowest natural weight).';
      }
      const buyIdx = steps.findIndex((s) => s.operator === 'buyBase');
      const infOnFracture = infAcq
        ? formatInfluenceBaseStep(item.baseName, minIlvl, infAcq, {
            fractured: true,
            fracturedMods: [fm.short],
          })
        : null;
      const saveLines =
        preferFracture.saveEss > 0
          ? [
              `Without fracture: ~${fullFishAttempts} ess (~${fullFishChaos != null ? Math.round(fullFishChaos) : '?'}c) fishing the same goals.`,
              `With fracture: ~${withAttempts} ess (~${essUnit != null ? Math.round(withAttempts * essUnit) : '?'}c) — saves ~${preferFracture.saveEss} ess (~${Math.round(preferFracture.saveChaos)}c EV).`,
              'Fractured base premium is not priced here; EV is craft-currency delta only.',
            ]
          : preferFracture.saveKind === 'eldritch' && preferFracture.saveChaos > 0
            ? [
                `Without fracture: ~${preferFracture.eldritchFull} Eldritch Chaos for this side.`,
                `With fracture: ~${preferFracture.eldritchWith} Eldritch Chaos — saves ~${preferFracture.saveEldritch} (~${Math.round(preferFracture.saveChaos)}c EV).`,
                'Fractured base premium is not priced here; EV is craft-currency delta only.',
              ]
            : [];
      const fracAction = preferFractureEnabled
        ? (infOnFracture?.action ?? `Prefer fractured ${item.baseName} (ilvl ${minIlvl}+) with: ${fm.short}`)
        : (infStep?.action ?? `Acquire ${item.baseName} (ilvl ${minIlvl}+) — optional fracture: ${fm.short}`);
      const fracDetail = preferFractureEnabled
        ? [
            `Lowest natural spawn weight among goals: ${fm.short} (${wl} tier+higher).`,
            `Fracture locks ${fm.short} so craft skips rolling it.`,
            fishSet.length || fishAlts.length
              ? `${chosenEssence.essenceName.replace('Deafening Essence of ', '')} then still needs: ${[
                  ...fishSet,
                  ...fishAlts,
                ]
                  .map((m) => m.short)
                  .join(' + ') || 'essence guarantee only'}.`
              : `${chosenEssence.essenceName} guarantee covers ${essenceTarget.short}; fracture holds the rarest other natural.`,
            ...saveLines,
            infOnFracture?.detail,
          ]
            .filter(Boolean)
            .join(' ')
        : [
            `Prefer fracture is off — craft rolls ${fm.short} (${wl} tier+higher) instead of locking it.`,
            ...saveLines,
            infStep?.detail,
          ]
            .filter(Boolean)
            .join(' ');
      const fracStep = step(
        'preferFracture',
        'quality',
        fracAction,
        fracDetail,
        [fm.short],
        preferFractureEnabled ? (infOnFracture?.cost ?? {}) : (infStep?.cost ?? {}),
        {
          chance: 1,
          chanceLabel: 'fracture alt',
          fractureSave: preferFracture.saveChaos,
          weightLine: wl,
          influence: infAcq?.influences,
          preferEnabled: preferFractureEnabled,
        }
      );
      if (buyIdx >= 0) steps[buyIdx] = fracStep;
      else steps.unshift(fracStep);
    }

    mergeCost(costs, { [key]: attempts });

    const weightDetail = fishMath
      ? fishMath.goals
          .map((g) => `${g.short}: ${formatWeight(g.hitWeight ?? g.weight, g.poolWeight ?? g.pool)} tier+higher`)
          .join('; ')
      : '';
    const weightLine = fishMath ? `pool ${fishMath.pool} · ${weightDetail}` : '';

    steps.push(
      step(
        'essenceFish',
        key,
        `Spam ${chosenEssence.essenceName} until ${essenceTarget.short}${
          fishSet.length
            ? fishAllFamily || !harvestOnlyFish
              ? ` + ${[...fishSet, ...fishAlts].map((m) => m.short).join(' + ')}`
              : ` + any of: ${fishSet.map((m) => m.short).join(' OR ')}`
            : fishAlts.length
              ? ` + ${fishAlts.map((m) => m.short).join(' + ')}`
              : ''
        }`,
        [
          `${chosenEssence.essenceName} always grants ${essenceTarget.short}.`,
          preferFracture && preferFractureEnabled
            ? `${preferFracture.mod.short} is fractured — not fished.`
            : preferFracture && !preferFractureEnabled
              ? `Prefer fracture off — fishing includes ${preferFracture.mod.short}.`
              : '',
          fishMath
            ? `Fish goals use natural spawn weights on this base at ilvl ${minIlvl}+. Extra rolls from essence affix-count distribution (§73): ~${formatAttempts(EXTRA_ROLLS.prefix)}P / ~${formatAttempts(EXTRA_ROLLS.suffix)}S${benchSlots(essGen) ? ` (bench reserves ${benchSlots(essGen)} ${essGen} slot)` : ''}.`
            : '',
          weightDetail,
          fishMath && needFish
            ? `P(all fish goals on one essence) ≈ ${(fishMath.pAll * 100).toFixed(3)}% → expected ~${formatAttempts(attempts)} Deafening essences.`
            : needFish
              ? `Expected ~${formatAttempts(attempts)} essences (${(fishP * 100).toFixed(2)}% per essence for the fish goal).`
              : `~${formatAttempts(attempts)} applications.`,
          canEldritch ? 'Then Eldritch Chaos (Eater dominant) for suffixes.' : '',
          attempts > 150 ? 'Exact-tier multi-prefix essence fish is expensive — fracture a hard prefix when possible.' : '',
        ]
          .filter(Boolean)
          .join(' '),
        [essenceTarget.short, ...fishLabels],
        { [key]: attempts },
        {
          chance: needFish ? fishP : 1,
          chanceLabel: needFish
            ? `~${formatAttempts(attempts)} ess · ${pct(fishP)}/hit · ${weightDetail || weightLine}`
            : '100% guarantee',
          weightLine,
          weightMath: fishMath,
        }
      )
    );

    essenceTarget._done = true;
    essenceTarget.method = 'essence';
    essenceTarget.chance = 1;
    essenceTarget.note = `${chosenEssence.essenceName} on ${itemClass}.`;
    essenceTarget.essenceName = chosenEssence.essenceName;

    if (fishAllFamily) {
      for (const m of fishSet) {
        m._done = true;
        const g = fishMath?.goals?.find((x) => x.short === m.short);
        assignEssenceFishNatural(
          m,
          g?.pRoll ?? fishP,
          fishMath
            ? `Natural weight tier+: see essence step (${m.short}).`
            : `Fished during ${chosenEssence.essenceName}.`,
          g ? formatWeight(g.hitWeight, g.poolWeight) : null
        );
      }
    } else if (harvestOnlyFish) {
      const caught = [...fishSet].sort((a, b) => (b.weight || 0) - (a.weight || 0))[0];
      caught._done = true;
      caught._fished = true;
      const g = fishMath?.goals?.find((x) => x.short === caught.short);
      assignEssenceFishNatural(
        caught,
        fishP,
        `Fished during essence; sibling via harvest.`,
        g ? formatWeight(g.hitWeight, g.poolWeight) : fishMath ? `pool ${fishMath.pool}` : null
      );
    } else {
      for (const m of fishSet) {
        m._done = true;
        const g = fishMath?.goals?.find((x) => x.short === m.short);
        assignEssenceFishNatural(
          m,
          g?.pRoll ?? fishP,
          `Fished during ${chosenEssence.essenceName}.`,
          g ? formatWeight(g.hitWeight, g.poolWeight) : null
        );
      }
    }
    for (const m of fishAlts) {
      m._done = true;
      const g = fishMath?.goals?.find((x) => x.short === m.short);
      assignEssenceFishNatural(
        m,
        m.poolShare,
        `Fished during ${chosenEssence.essenceName}.`,
        g ? formatWeight(g.hitWeight, g.poolWeight) : null
      );
    }

    if (preferFracture) {
      const fm = preferFracture.mod;
      const hasEssSave = preferFracture.saveEss > 0;
      const hasEldSave = preferFracture.saveKind === 'eldritch' && preferFracture.saveChaos > 0;
      if (preferFractureEnabled) {
        alternatives.push({
          id: 'no-fracture-essence-fish',
          name: hasEssSave
            ? `No fracture → full ${chosenEssence.essenceName.replace('Deafening Essence of ', '')} fish`
            : hasEldSave
              ? `No fracture → full Eldritch ${fm.gen} fish`
              : `No fracture → normal ${item.baseName}`,
          description: hasEssSave
            ? `Fish without locking ${fm.short} (~${fullFishAttempts} ess). Fracture saves ~${preferFracture.saveEss} ess (~${Math.round(preferFracture.saveChaos)}c).`
            : hasEldSave
              ? `Eldritch Chaos without locking ${fm.short} (~${preferFracture.eldritchFull}). Fracture saves ~${preferFracture.saveEldritch} (~${Math.round(preferFracture.saveChaos)}c).`
              : `Craft on a non-fractured base; roll ${fm.short} instead of locking it (${preferFracture.weightLine}).`,
          totalCost: null,
          _extraChaos: hasEssSave || hasEldSave ? preferFracture.saveChaos : 0,
          costs: hasEssSave
            ? { [key]: fullFishAttempts }
            : hasEldSave
              ? { 'eldritch-chaos': preferFracture.eldritchFull }
              : { ...costs },
        });
      } else if (hasEssSave || hasEldSave) {
        alternatives.push({
          id: 'with-fracture-essence-fish',
          name: hasEssSave
            ? `Prefer fracture → lock ${fm.short}`
            : `Prefer fracture → lock ${fm.short} (Eldritch)`,
          description: hasEssSave
            ? `Lock ${fm.short}; fish drops to ~${Math.max(1, fullFishAttempts - preferFracture.saveEss)} ess (saves ~${preferFracture.saveEss} / ~${Math.round(preferFracture.saveChaos)}c).`
            : `Lock ${fm.short}; Eldritch drops to ~${preferFracture.eldritchWith} (saves ~${preferFracture.saveEldritch} / ~${Math.round(preferFracture.saveChaos)}c).`,
          totalCost: null,
          _extraChaos: -(preferFracture.saveChaos || 0),
          costs: hasEssSave
            ? { [key]: Math.max(1, fullFishAttempts - preferFracture.saveEss) }
            : { 'eldritch-chaos': preferFracture.eldritchWith },
        });
      }
    }
  }

  // Non-essence plans: still propose lowest-weight fracture when nothing is fractured yet.
  if (!fractured.length && !preferFracture) {
    const fracMod = pickLeastWeightFractureMod(mods, null, fracOpts);
    if (fracMod) {
      const wl = preferFractureWeightLine(fracMod);
      preferFracture = { mod: fracMod, saveEss: 0, saveChaos: 0, weightLine: wl };
      if (preferFractureEnabled) {
        fracMod._done = true;
        fracMod.method = 'fractured';
        fracMod.chance = 1;
        fracMod.weightLine = wl;
        fracMod.note = 'Prefer buy fractured (lowest natural weight).';
      }
      const buyIdx = steps.findIndex((s) => s.operator === 'buyBase');
      const infOnFracture = infAcq
        ? formatInfluenceBaseStep(item.baseName, minIlvl, infAcq, {
            fractured: true,
            fracturedMods: [fracMod.short],
          })
        : null;
      const fracAction = preferFractureEnabled
        ? (infOnFracture?.action ?? `Prefer fractured ${item.baseName} (ilvl ${minIlvl}+) with: ${fracMod.short}`)
        : (infStep?.action ?? `Acquire ${item.baseName} (ilvl ${minIlvl}+) — optional fracture: ${fracMod.short}`);
      const fracDetail = preferFractureEnabled
        ? [
            `Lowest natural spawn weight among goals: ${fracMod.short} (${wl} tier+higher).`,
            `Fracture locks ${fracMod.short} so later steps skip rolling it.`,
            infOnFracture?.detail,
          ]
            .filter(Boolean)
            .join(' ')
        : [
            `Prefer fracture is off — craft rolls ${fracMod.short} (${wl} tier+higher) instead of locking it.`,
            infStep?.detail,
          ]
            .filter(Boolean)
            .join(' ');
      const fracStep = step(
        'preferFracture',
        'quality',
        fracAction,
        fracDetail,
        [fracMod.short],
        preferFractureEnabled ? (infOnFracture?.cost ?? {}) : (infStep?.cost ?? {}),
        {
          chance: 1,
          chanceLabel: 'fracture alt',
          weightLine: wl,
          influence: infAcq?.influences,
          preferEnabled: preferFractureEnabled,
        }
      );
      if (buyIdx >= 0) steps[buyIdx] = fracStep;
      else steps.unshift(fracStep);
      if (preferFractureEnabled) {
        alternatives.push({
          id: 'no-fracture-base',
          name: `No fracture → normal ${item.baseName}`,
          description: `Craft on a non-fractured base; roll ${fracMod.short} instead of locking it (${wl}).`,
          totalCost: null,
          _extraChaos: 0,
          costs: {},
        });
      } else {
        alternatives.push({
          id: 'with-fracture-base',
          name: `Prefer fracture → lock ${fracMod.short}`,
          description: `Buy fractured ${fracMod.short} (${wl}); later steps skip rolling it.`,
          totalCost: null,
          _extraChaos: 0,
          costs: {},
        });
      }
    }
  }

  // Mid-craft influence exalt AFTER any essence/fracture prep (essence remakes rares → wipes influence).
  if (influenceSlam) {
    pushSlamSideKeeperAlt(
      steps,
      costs,
      kb,
      baseTags,
      minIlvl,
      mods,
      influenceSlam,
      preferFracture,
      preferFractureEnabled
    );
    pushInfluenceSlamPipeline(steps, costs, influenceSlam);
  }

  // Alterations only work on magic — strip once essence/rare path is chosen
  const itemIsRare = !!(
    chosenEssence ||
    steps.some((s) =>
      ['essenceFish', 'harvestFill', 'eldritchChaos', 'alchemy', 'regal', 'influencePrep', 'influenceSlam'].includes(
        s.operator
      )
    )
  );
  if (itemIsRare || chosenEssence) {
    for (const m of mods) {
      if (!m.candidates?.length) continue;
      m.candidates = m.candidates.filter((c) => c.type !== 'alt');
      if (m.best?.type === 'alt') m.best = m.candidates[0] ?? null;
    }
  }

  // 3. Eldritch Chaos suffix (or prefix) finish — armour only, cheap vs metacraft
  {
    const canEldritch = ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(
      normalizeItemClass(itemClass)
    );
    const prefOff = !!(preferFracture && !preferFractureEnabled);
    // All open natural suffixes (resists, life regen, attrs, …) — not only alt-fillers
    const suffixLeft = open().filter((m) => m.gen === 'suffix');
    const prefixAnchor =
      !!(chosenEssence || fractured.length || mods.some((m) => m._done && m.gen === 'prefix')) ||
      (prefOff && preferFracture.mod.gen === 'prefix');

    if (
      canEldritch &&
      suffixLeft.length &&
      (prefixAnchor || (prefOff && preferFracture.mod.gen === 'suffix'))
    ) {
      const wiped = unprotectedDoneKeepersOnSide(mods, 'suffix', suffixLeft);
      if (wiped.length) {
        tips.push(
          `Skipped Eldritch Chaos suffixes — would wipe: ${wiped.map((m) => m.short).join('; ')}.`
        );
      } else {
        const occupied = occupiedGroupsNow(mods, 'suffix');
        const math = eldritchSideExpected(kb, baseTags, minIlvl, 'suffix', suffixLeft, undefined, occupied);
        const attempts = Math.max(math.expected, 1);
        mergeCost(costs, { 'eldritch-ichor': 1, 'eldritch-chaos': attempts });
        steps.push(
          step(
            'eldritchChaos',
            'eldritch-chaos',
            `Eater dominant → Eldritch Chaos ×~${attempts} for suffixes`,
            [
              'Apply Eldritch Ichor so Eater of Worlds is dominant (higher tier than Exarch).',
              'Eldritch Chaos Orb then rerolls SUFFIXES only — defence prefixes stay.',
              `Target: ${suffixLeft.map((m) => m.short).join('; ')}.`,
              `Suffix pool = ${math.pool}. CoE AND-columns (tier+higher): ${math.weightSummary}.`,
              `Model: ${math.rolls} sequential suffix draws without replacement. P(all) ≈ ${pct(math.pAll)} → ~${attempts} expected.`,
              'Source: craft-operators-official.json / PoE Wiki Eldritch Chaos Orb; weights = RePoE first-match tags.',
            ].join(' '),
            suffixLeft.map((m) => m.short),
            { 'eldritch-ichor': 1, 'eldritch-chaos': attempts },
            {
              chance: math.pAll,
              chanceLabel: `~${attempts} Eldritch Chaos · ${pct(math.pAll)}/hit · ${math.weightSummary}`,
              weightLine: `pool ${math.pool} · ${math.weightSummary}`,
              combo: 'eldritch-suffix-finish',
              rerollSide: 'suffix',
            }
          )
        );
        for (const m of suffixLeft) {
          m._done = true;
          m.method = 'natural';
          m.chance = math.goals.find((g) => g.short === m.short)?.pRoll ?? math.pAll;
          m.note = 'Eldritch Chaos (Eater dominant) suffix finish.';
        }
      }
    }

    const prefixLeftNow = open().filter(
      (m) => m.gen === 'prefix' && m.harvests.length === 0 && m.candidates.some((c) => c.type === 'alt')
    );
    const suffixDone = mods.some((m) => m._done && m.gen === 'suffix');
    // Prefix eldritch when suffixes anchored; skip if we already used prefix-anchor→suffix path
    // (those prefixes finish via harvest). Prefer-off + suffix fracture target does both sides.
    if (canEldritch && prefixLeftNow.length && suffixDone && !prefixAnchor) {
      const wiped = unprotectedDoneKeepersOnSide(mods, 'prefix', prefixLeftNow);
      if (wiped.length) {
        tips.push(
          `Skipped Eldritch Chaos prefixes — would wipe: ${wiped.map((m) => m.short).join('; ')}.`
        );
      } else {
        const occupied = occupiedGroupsNow(mods, 'prefix');
        const math = eldritchSideExpected(kb, baseTags, minIlvl, 'prefix', prefixLeftNow, undefined, occupied);
        const attempts = Math.max(math.expected, 1);
        mergeCost(costs, { 'eldritch-ember': 1, 'eldritch-chaos': attempts });
        steps.push(
          step(
            'eldritchChaos',
            'eldritch-chaos',
            `Exarch dominant → Eldritch Chaos ×~${attempts} for prefixes`,
            [
              'Ember dominant → Eldritch Chaos rerolls prefixes only; suffixes safe.',
              `Prefix pool = ${math.pool}. Weights: ${math.weightSummary}.`,
              `Model: ~${math.rolls} prefix rolls per Chaos. P(all) ≈ ${pct(math.pAll)} → ~${attempts} expected.`,
            ].join(' '),
            prefixLeftNow.map((m) => m.short),
            { 'eldritch-ember': 1, 'eldritch-chaos': attempts },
            {
              chance: math.pAll,
              chanceLabel: `~${attempts} Eldritch Chaos · ${pct(math.pAll)}/hit · ${math.weightSummary}`,
              weightLine: `pool ${math.pool} · ${math.weightSummary}`,
              rerollSide: 'prefix',
            }
          )
        );
        for (const m of prefixLeftNow) {
          m._done = true;
          m.method = 'natural';
          m.chance = math.goals.find((g) => g.short === m.short)?.pRoll ?? math.pAll;
          m.note = 'Eldritch Chaos (Exarch dominant) prefix finish.';
        }
      }
    }
  }

  // 4. Cannot-roll + exalt when cheaper than harvest (before harvest commits).
  if (influenceSlam || open().some((m) => m.candidates?.some((c) => c.type === 'exalt'))) {
    applyCannotRollExaltAssist(
      kb,
      influenceSlam ? withInfluenceTags(baseTags, influenceSlam.influence) : baseTags,
      minIlvl,
      open(),
      influenceSlam?.influence ?? null,
      steps,
      costs,
      prices,
      mods,
      tagClusters
    );
  }

  // 5. Harvest fills — ONLY when Eldritch/essence-fish-all cannot finish (e.g. weapons)
  // Prefer finishing a tag-clustered side first so SCBC/PCBC can lock it.
  const harvestSides = tagClusters.preferredLockSide
    ? tagClusters.sideOrder
    : ['suffix', 'prefix'];
  for (const side of harvestSides) {
    const sideMods = open().filter(
      (m) => m.gen === side && m.harvests.length && !isInfluenceGoal(m) && !m._skipHarvest
    );
    if (!sideMods.length) continue;
    const shared = bestSharedHarvest(sideMods);
    if (!shared) continue;
    const { harvest, covered } = shared;
    const remaining = covered.filter((m) => !m._done);
    if (!remaining.length) continue;

    // Never metacraft-hunt exact T1 defence/life after essence on armour — Eldritch is the cheap path
    if (
      (harvest.id === 'reforge-defence' || harvest.id === 'reforge-life') &&
      chosenEssence &&
      ['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(normalizeItemClass(itemClass))
    ) {
      tips.push(
        `Skipped Prefixes Cannot Be Changed → ${harvest.name} for exact tiers — that is often 50–100+ Divines. Prefer essence fish-all / Eldritch Chaos or buy the item.`
      );
      for (const m of remaining) {
        m._done = true;
        assignEssenceFishNatural(
          m,
          m.poolShare,
          'Accept from essence fish / Eldritch / buy — exact harvest skipped.'
        );
      }
      continue;
    }

    const other = side === 'prefix' ? 'suffix' : 'prefix';
    const lockNats = open().filter(
      (m) => m.gen === other && !m.harvests.length && m.candidates.some((c) => c.type === 'alt')
    );
    if (lockNats.length && !chosenEssence) {
      const occupied = occupiedGroupsNow(mods);
      const altMaths = lockNats.map((m) => altExpected(kb, baseTags, minIlvl, m, occupied));
      const hardest = [...altMaths].sort((a, b) => a.pRoll - b.pRoll)[0];
      const attempts = Math.min(
        hardest.expected * Math.min(1 + lockNats.length, 5),
        1500
      );
      const weightLine = altMaths.map((a) => `${a.short}: ${a.weightSummary}`).join('; ');
      mergeCost(costs, { transmute: 1, alteration: attempts });
      steps.push(
        step(
          'altSpam',
          'alteration',
          `Alt for (${other}): ${lockNats.map((m) => m.short).join(' + ')}`,
          `Lock ${other}s before Harvest ${harvest.name}. ${weightLine}. ~${attempts} alts.`,
          lockNats.map((m) => m.short),
          { transmute: 1, alteration: attempts },
          {
            chance: hardest.pRoll,
            chanceLabel: `~${attempts} alts · ${hardest.weightSummary}`,
            weightLine,
          }
        )
      );
      for (const m of lockNats) {
        m._done = true;
        m.method = 'natural';
        m.chance = m.poolShare;
      }
    }

    // Same side as essence keepers → lock THAT side so harvest can fill an open slot (wand crits).
    // Opposite side → lock the essence side (protect finished prefixes/suffixes; reforge the harvest side).
    const { meta: metaFinal, rerollSide } = harvestMetacraftSides(remaining, essenceTarget);
    const wouldWipe = unprotectedDoneKeepersOnSide(mods, rerollSide, remaining);
    if (wouldWipe.length) {
      tips.push(
        `Skipped ${harvest.name} — would wipe unprotected ${rerollSide}s already obtained: ${wouldWipe
          .map((m) => m.short)
          .join('; ')}. Finish harvest goals without reforging that side (exalt / cannot-roll), or obtain those keepers after the reforge.`
      );
      continue;
    }

    const occupied = occupiedGroupsNow(mods);
    const chances = remaining.map((m) => {
      const o = harvestGoalOdds(kb, baseTags, minIlvl, m, harvest, modMatchesHarvest, occupied);
      return {
        m,
        p: clampRoll(o.pRoll),
        hitWeight: o.hitWeight,
        poolWeight: o.poolWeight,
        weightLine: formatWeight(o.hitWeight, o.poolWeight),
      };
    });
    let attempts = 0;
    for (const { p } of [...chances].sort((a, b) => a.p - b.p)) attempts += expectedAttemptsEv(p);
    attempts = Math.max(1, Math.min(attempts, 200));
    const bag = harvestWithMetacraftCost(harvest, attempts);
    mergeCost(costs, bag);
    const weightLine = chances.map((c) => `${c.m.short}: ${c.weightLine}`).join('; ');
    const juiceLine = Object.entries(harvestCostBag(harvest, 1))
      .map(([k, n]) => `${n} ${k.replace('-lifeforce', '')}`)
      .join('+');
    const pool = harvestEligiblePool(
      kb,
      baseTags,
      minIlvl,
      remaining[0]?.gen ?? rerollSide,
      harvest,
      modMatchesHarvest,
      occupied
    );
    const poolNote = formatEligiblePool(pool, harvest.name);

    steps.push(
      step(
        'harvestFill',
        'harvest',
        `${metaFinal.name} → ${harvest.name} ×~${attempts}`,
        [
          `Protect finished mods with metacraft, then ${harvest.name} (reforges ${rerollSide === 'prefix' ? 'prefixes' : 'suffixes'} only).`,
          `Targets: ${remaining.map((m) => m.short).join('; ')}.`,
          `Non-fractured ${rerollSide} keepers other than these targets are finished after this step.`,
          `Harvest-tagged pool weights (tier+higher): ${weightLine}.`,
          poolNote,
          `~${attempts}× (${juiceLine} lifeforce each) + ${bag.divine} Divines expected.`,
        ].join(' '),
        remaining.map((m) => m.short),
        bag,
        {
          chance: chances[0]?.p ?? 0.1,
          chanceLabel: `~${attempts} · ${chances.map((c) => c.weightLine).join(' / ')}`,
          weightLine,
          harvestOfficial: harvest.id,
          rerollSide,
          eligiblePool: pool.rows,
          eligiblePoolTotal: pool.total,
        }
      )
    );
    for (const m of remaining) {
      const c = chances.find((x) => x.m === m);
      m._done = true;
      assignHarvestMethod(m, harvest, {
        hitWeight: c?.hitWeight ?? m.hitWeight,
        poolWeight: c?.poolWeight ?? m.poolWeight,
        pRoll: c?.p ?? 0.1,
      });
      m.note = `${harvest.name}; ${c?.weightLine ?? pct(m.chance)}.`;
    }
  }

  // 6. Unveil — metacraft-lock other side; prefer Veiled Chaos when unlock side can be reforged
  for (const m of unveilMods) {
    if (m._done) continue;
    const lockMeta =
      m.gen === 'prefix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
    const useChaos = preferVeiledChaos(mods, m);
    const block = useChaos ? null : pickSlamBlock(kb, itemClass, baseTags, minIlvl, mods, benchMods, m);
    const occupied = occupiedGroupsNow(mods, m.gen);
    const u = unveilExpected(kb, baseTags, minIlvl, m, occupied);
    const attempts = u.expected;
    const p = u.pRoll;
    const bag = veiledOrbCost(attempts, useChaos);
    mergeCost(costs, bag);
    const orbName = useChaos ? 'Veiled Chaos' : 'Veiled Exalt';
    const detail = useChaos
      ? `${lockMeta.name} locks finished ${m.gen === 'prefix' ? 'suffixes' : 'prefixes'}. ${orbName} reforges ${m.gen}es (fractured stays; guarantees a veiled). Unveil ${m.short}: ${u.weightLine}.`
      : `${blockDetail(block, true)}${u.weightLine}. Free ${m.gen} slot required (adds without reforging keepers).`;
    steps.push(
      step(
        'unveil',
        useChaos ? 'veiled-chaos' : 'veiled',
        `${lockMeta.name} → ${blockActionPrefix(block)}${orbName} → unveil ${m.short}`,
        detail,
        [m.short],
        bag,
        {
          chance: p,
          chanceLabel: u.weightLine,
          weightLine: u.weightLine,
        }
      )
    );
    m._done = true;
    m.method = 'unveil';
    m.chance = p;
    m.weightLine = u.weightLine;
    m.note = useChaos ? 'Veiled Chaos unveil (3 rolls).' : 'Veiled Exalt unveil (3 rolls).';
  }

  // 7. Leftovers — cheapest remaining candidate (never bench; crafts stay free until the end)
  // Never altSpam here if item is already rare (essence / harvest / eldritch).
  const rareNow = !!(
    chosenEssence ||
    steps.some((s) =>
      [
        'essenceFish',
        'harvestFill',
        'eldritchChaos',
        'alchemy',
        'regal',
        'influencePrep',
        'influenceSlam',
        'altSpam',
        'cannotRollAssist',
      ].includes(s.operator)
    )
  );
  for (const m of open()) {
    const gen = affixGen(m);
    // Reserve final bench-craft slots — never exalt into the craft's last open affix.
    const claimed = mods.filter(
      (x) => affixGen(x) === gen && !isBenchMod(x) && (x._done || x.fractured || x === m)
    ).length;
    const craftSlots = benchMods.filter((b) => affixGen(b) === gen).length;
    if (gen && claimed + craftSlots > 3) {
      m._done = true;
      m.method = 'unfittable';
      m.chance = 0;
      m.note = `No free ${gen} slot — reserved for bench craft.`;
      tips.push(`Skipped ${m.short}: ${gen}s full once bench craft is reserved.`);
      continue;
    }

    const exaltTags =
      m._exaltTags ||
      (isInfluenceGoal(m) && influenceSlam
        ? withInfluenceTags(baseTags, influenceSlam.influence)
        : baseTags);
    const occupied = occupiedGroupsNow(mods);
    const openSlot = !!m._openSlotExalt || !!m._cannotRollAssist || !!influenceSlam;

    // Score harvest vs exalt (blocked tags if assist) vs alt — pick cheapest.
    const options = [];
    if (!rareNow && m.candidates.some((c) => c.type === 'alt') && !m._skipHarvest) {
      const alt = altExpected(kb, baseTags, minIlvl, m, occupied);
      const attempts = Math.min(alt.expected, 1200);
      const cost = { transmute: 1, alteration: attempts };
      options.push({
        type: 'alt',
        chance: alt.pRoll,
        attempts,
        cost,
        expectedChaos: costOf(cost, prices),
        weightLine: alt.weightSummary,
        hitWeight: alt.hitWeight,
        poolWeight: alt.poolWeight,
        label: `Alt spam (${alt.weightSummary})`,
      });
    }
    if (!m._skipHarvest) {
      for (const h of m.harvests ?? []) {
        const odds = harvestGoalOdds(kb, exaltTags, minIlvl, m, h, modMatchesHarvest, occupied);
        if (!(odds.hitWeight > 0)) continue;
        const p = clampRoll(odds.pRoll);
        const attempts = Math.min(expectedAttemptsEv(p), 200);
        const cost = harvestWithMetacraftCost(h, attempts);
        options.push({
          type: 'harvest',
          harvest: h,
          chance: p,
          attempts,
          cost,
          expectedChaos: costOf(cost, prices),
          weightLine: formatWeight(odds.hitWeight, odds.poolWeight),
          hitWeight: odds.hitWeight,
          poolWeight: odds.poolWeight,
          label: `${h.name} (${formatWeight(odds.hitWeight, odds.poolWeight)})`,
        });
      }
    }
    {
      const exalt = exaltExpected(kb, exaltTags, minIlvl, m, occupied);
      const cost = openSlot ? exaltOpenSlotBag(exalt) : exaltMetacraftBag(exalt);
      options.push({
        type: 'exalt',
        chance: exalt.pRoll,
        attempts: exalt.expected,
        cost,
        expectedChaos: costOf(cost, prices),
        weightLine: exalt.weightSummary,
        hitWeight: exalt.hitWeight,
        poolWeight: exalt.poolWeight,
        detail: `~${exalt.expected} Exalts. ${exalt.weightSummary} tier+higher vs open ${m.gen} pool${m._cannotRollAssist ? ' (cannot-roll reduced)' : ''}.`,
        label: `Exalt (${exalt.weightSummary})`,
      });
    }
    // Drop harvest options that would wipe already-obtained unprotected keepers on the reroll side.
    const safeOptions = options.filter((o) => {
      if (o.type !== 'harvest') return true;
      const meta = m.gen === 'prefix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
      const rerollSide = meta.locks === 'prefix' ? 'suffix' : 'prefix';
      return unprotectedDoneKeepersOnSide(mods, rerollSide, [m]).length === 0;
    });
    safeOptions.sort((a, b) => rankCost(a.expectedChaos) - rankCost(b.expectedChaos));
    const c = safeOptions[0];
    if (!c || c.type === 'bench' || isBenchMod(m)) continue;

    if (c.type === 'alt') {
      mergeCost(costs, c.cost);
      steps.push(
        step('altSpam', 'alteration', `Alt for ${m.short}`, c.label, [m.short], c.cost, {
          chance: c.chance,
          chanceLabel: `~${c.attempts} alts · ${c.weightLine || formatWeight(m.hitWeight, m.poolWeight)}`,
          weightLine: c.weightLine || m.weightLine,
        })
      );
      m.method = 'natural';
      m.chance = c.chance;
      m.note = c.label;
    } else if (c.type === 'harvest') {
      mergeCost(costs, c.cost);
      const meta = m.gen === 'prefix' ? METACRAFT.suffixesCannotBeChanged : METACRAFT.prefixesCannotBeChanged;
      const rerollSide = meta.locks === 'prefix' ? 'suffix' : 'prefix';
      const pool = harvestEligiblePool(kb, exaltTags, minIlvl, m.gen, c.harvest, modMatchesHarvest, occupied);
      const poolNote = formatEligiblePool(pool, c.harvest.name);
      steps.push(
        step(
          'harvestFill',
          'harvest',
          `${meta.name} → ${c.harvest.name} ×~${c.attempts}`,
          `${c.label}. ${c.weightLine || ''} (reforges ${rerollSide}s). ${poolNote}`,
          [m.short],
          c.cost,
          {
            chance: c.chance,
            chanceLabel: `~${c.attempts} · ${c.weightLine || pct(c.chance)}`,
            weightLine: c.weightLine,
            rerollSide,
            harvestOfficial: c.harvest.id,
            eligiblePool: pool.rows,
            eligiblePoolTotal: pool.total,
          }
        )
      );
      assignHarvestMethod(m, c.harvest, {
        hitWeight: c.hitWeight ?? m.hitWeight,
        poolWeight: c.poolWeight ?? m.poolWeight,
        pRoll: c.chance,
      });
      m.note = c.label;
    } else {
      mergeCost(costs, c.cost);
      const assistNote = m._cannotRollAssist ? ' (cannot-roll pool)' : '';
      steps.push(
        step(
          'exaltFallback',
          'exalt',
          `${m._cannotRollAssist || openSlot ? 'Exalt' : 'LAST RESORT: Exalt'} for ${m.short}${assistNote}`,
          c.detail || c.label,
          [m.short],
          c.cost,
          {
            chance: c.chance,
            chanceLabel: c.weightLine || pct(c.chance),
            weightLine: c.weightLine,
            fallback: !m._cannotRollAssist,
          }
        )
      );
      m.method = 'natural';
      m.chance = c.chance;
      if (!m._cannotRollAssist) tips.push(`Exalt fallback on ${m.short} — consider relaxing tier.`);
    }
    m._done = true;
  }

  // 8. Free a slot if needed, then Bench ALWAYS last
  for (const m of [...benchMods, ...mods.filter(isBenchMod)]) {
    if (m.fractured || m._done) continue;
    m._done = true;
    m.method = 'bench';
    m.chance = 1;
    m.weightLine = 'N/A (bench)';
    m.note = 'Bench last — keeps affix slot free for earlier RNG.';
  }
  const annulSpace = buildAnnulForBenchSpace(item, mods, benchMods, steps, costs, itemClass);
  if (annulSpace.length) steps = [...steps, ...annulSpace];
  steps = ensureFinalBenchSteps(mods, steps);

  tips.push(
    'Each mod is scored against KB forces (essence-by-class, harvest, eldritch, unveil, bench).',
    'Armour: defence prefixes via Woe/Dense fish-all, then Eldritch Chaos (Eater) for suffixes — not metacraft harvest for exact T1.',
    ...mods
      .filter((m) => m.candidates?.length)
      .slice(0, 3)
      .map((m) => `${m.short}: best=${m.best?.label ?? '?'} (${Math.round(m.best?.expectedChaos ?? 0)}c)`)
  );

  const nameParts = [];
  if (preferFracture && preferFractureEnabled) nameParts.push(`Fracture ${preferFracture.mod.short.slice(0, 28)}`);
  else if (fractured.length) nameParts.push('Fracture buy');
  if (influenceSlam) {
    nameParts.push(
      `${influenceSlam.influence} Exalt ${String(influenceSlam.mod.short).slice(0, 24)}`
    );
  }
  if (chosenEssence) nameParts.push(chosenEssence.essenceName.replace('Deafening Essence of ', ''));
  if (steps.some((s) => s.operator === 'eldritchChaos')) nameParts.push('Eldritch Chaos');
  if (steps.some((s) => s.operator === 'harvestFill')) nameParts.push('Harvest');
  if (unveilMods.length) nameParts.push('Unveil');
  if (benchMods.length) nameParts.push('Bench');

  const totalCost = chaosCost(costs, prices);
  for (const a of alternatives) {
    if (a._extraChaos != null && totalCost != null) {
      a.totalCost = Math.round((totalCost + a._extraChaos) * 100) / 100;
      delete a._extraChaos;
    } else if (a._extraChaos != null) {
      a.totalCost = null;
      delete a._extraChaos;
    }
    a.costBreakdown = formatCostBreakdown(a.costs ?? {}, prices);
  }
  if (kb.priceStatus?.missing || !prices) {
    tips.unshift(kb.pricesTip || 'Run npm run fetch-prices — EV needs a daily price snapshot.');
  } else if (kb.priceStatus?.stale && kb.priceStatus?.message) {
    tips.unshift(kb.priceStatus.message);
  } else if (totalCost == null) {
    tips.unshift(`Price snapshot incomplete for this craft's currencies. ${kb.pricesTip || 'Run npm run fetch-prices'}`);
  }
  if (preferFracture && preferFractureEnabled) {
    const tip =
      preferFracture.saveEss > 0
        ? `Fracture ${preferFracture.mod.short} (${preferFracture.weightLine}) — lowest natural weight; saves ~${preferFracture.saveEss} ess (~${Math.round(preferFracture.saveChaos)}c) vs rolling it.`
        : preferFracture.saveKind === 'eldritch' && preferFracture.saveChaos > 0
          ? `Fracture ${preferFracture.mod.short} (${preferFracture.weightLine}) — lowest natural weight; saves ~${preferFracture.saveEldritch} Eldritch Chaos (~${Math.round(preferFracture.saveChaos)}c).`
          : `Fracture ${preferFracture.mod.short} (${preferFracture.weightLine}) — lowest natural spawn weight among goals.`;
    tips.unshift(tip);
  } else if (preferFracture && !preferFractureEnabled) {
    tips.unshift(
      `Prefer fracture off — rolling ${preferFracture.mod.short} (${preferFracture.weightLine}) in craft instead of locking it.`
    );
  }
  if (infAcq) {
    tips.unshift(
      `${infAcq.influences.join('+')} influence: ${
        infAcq.recommend === 'buy'
          ? 'buy influenced base'
          : infAcq.recommend === 'slam'
            ? 'mid-craft influence exalt slam (uninfluenced base)'
            : 'apply influence exalt'
      } (${infAcq.reason}).`
    );
  }

  const seqName = nameParts.length ? nameParts.join(' → ') : 'KB candidate plan';
  const seqDesc =
    preferFracture && preferFractureEnabled
      ? preferFracture.saveChaos > 0
        ? `Fractured ${preferFracture.mod.short} (lowest weight) + KB combo (saves ~${Math.round(preferFracture.saveChaos)}c vs non-fractured).`
        : `Prefer fractured ${preferFracture.mod.short} (lowest natural weight: ${preferFracture.weightLine}) + cheapest KB combo.`
      : 'Cheapest consistent combo from per-mod KB candidates + Eldritch operators.';
  const seqSteps = renumber(steps);

  if (opts.skipRecombinator) {
    return stampPlan({
      id: 'candidate-search',
      name: seqName,
      description: seqDesc,
      steps: seqSteps,
      costs,
      totalCost,
      costBreakdown: formatCostBreakdown(costs, prices),
      tips,
      classified: mods,
      alternatives,
      methodComparison: null,
      preferFractureAvailable: !!preferFracture,
      preferFractureEnabled: preferFracture ? preferFractureEnabled : null,
      priceStatus: kb.priceStatus,
      pricesTip: kb.pricesTip,
      rulesetVersion: rulesetVersion(),
    }, kb);
  }

  const costOne = (m) => {
    if (m.fractured || isBenchMod(m)) return 0;
    return rankCost(m.best?.expectedChaos);
  };

  const recomb = considerRecombinator({
    mods,
    sequentialCost: totalCost,
    sequentialName: seqName,
    sequentialDescription: seqDesc,
    sequentialSteps: seqSteps,
    sequentialCosts: costs,
    fractureCost: preferFracture && preferFractureEnabled ? totalCost : null,
    fractureName: preferFracture ? `Fracture ${preferFracture.mod.short}` : null,
    costOne,
    itemMeta: {
      itemClass,
      baseType: item.baseName,
      itemLevel: minIlvl,
      influence: item.influenced ?? [],
      fracturedItem: fractured.length > 0,
    },
    kb,
    prices,
    baseTags,
    ilvl: minIlvl,
  });

  if (recomb?.alternative) alternatives.unshift(recomb.alternative);
  if (recomb?.comparison) {
    const w = recomb.comparison.winner;
    const line =
      w === 'recombinator' || w === 'predictableRecombinator'
        ? `Method: ${recomb.name} wins vs sequential (~${Math.round(recomb.ev)}c vs ~${Math.round(totalCost)}c). ${recomb.comparison.recombinator?.why ?? ''}`
        : `Method: Sequential wins vs recombinator (~${Math.round(totalCost)}c vs ~${Math.round(recomb.ev)}c). ${recomb.comparison.recombinator?.why ?? ''}`;
    tips.unshift(line);
  }

  if (recomb?.won && recomb.steps?.length) {
    return stampPlan({
      experimental: true,
      rulesetVersion: rulesetVersion(),
      id: 'recombinator',
      name: 'Recombinator',
      description: recomb.description,
      steps: renumber(ensureFinalBenchSteps(mods, recomb.steps)),
      costs: recomb.costs ?? {},
      totalCost: recomb.totalCost,
      totalExpectedTradableCostChaos: recomb.totalExpectedTradableCostChaos ?? null,
      totalExpectedEconomicCostChaos: recomb.totalExpectedEconomicCostChaos ?? null,
      economics: recomb.economics ?? null,
      economicsDisplay: recomb.economicsDisplay ?? null,
      initialSetupCostChaos: recomb.initialSetupCostChaos,
      expectedDonorCostChaos: recomb.expectedDonorCostChaos,
      expectedRecombinationAttempts: recomb.expectedRecombinationAttempts,
      expectedTotalRecombinationsUntilFinished: recomb.expectedTotalRecombinationsUntilFinished,
      expectedFullDonorARebuilds: recomb.expectedFullDonorARebuilds,
      expectedFullDonorBRebuilds: recomb.expectedFullDonorBRebuilds,
      expectedPartialStateReuses: recomb.expectedPartialStateReuses,
      directFinalProbabilityPerRecombination: recomb.directFinalProbabilityPerRecombination,
      eventualCompletionProbability: recomb.eventualCompletionProbability,
      economicsBreakdown: recomb.economicsBreakdown,
      expectedRecombinationCurrencyChaos: recomb.expectedRecombinationCurrencyChaos,
      expectedDust: recomb.expectedDust,
      expectedGold: recomb.expectedGold,
      dustChaosEquivalent: recomb.dustChaosEquivalent,
      goldOpportunityChaosEquivalent: recomb.goldOpportunityChaosEquivalent,
      expectedFinishingCostChaos: recomb.expectedFinishingCostChaos,
      expectedSalvageChaos: recomb.expectedSalvageChaos,
      costBreakdown: formatCostBreakdown(recomb.costs ?? {}, prices),
      tips,
      classified: mods,
      alternatives,
      methodComparison: recomb.comparison,
      preferFractureAvailable: !!preferFracture,
      preferFractureEnabled: preferFracture ? preferFractureEnabled : null,
      priceStatus: kb.priceStatus,
      pricesTip: kb.pricesTip,
    }, kb);
  }

  return stampPlan({
    id: 'candidate-search',
    name: seqName,
    description: seqDesc,
    steps: seqSteps,
    costs,
    totalCost,
    costBreakdown: formatCostBreakdown(costs, prices),
    tips,
    classified: mods,
    alternatives,
    methodComparison: recomb?.comparison ?? null,
    preferFractureAvailable: !!preferFracture,
    preferFractureEnabled: preferFracture ? preferFractureEnabled : null,
    priceStatus: kb.priceStatus,
    pricesTip: kb.pricesTip,
    rulesetVersion: rulesetVersion(),
  }, kb);
}

export { assignAndBuild };
