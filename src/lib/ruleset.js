/** Versioned crafting rules. Source files: src/lib/rules/3.26.json … 3.29.json (kept in sync). */

export const RULES_326 = {
  version: '3.26',
  league: '3.26',
  notes: 'Pre-3.27: guaranteed Harvest reforges do NOT respect Cannot Roll Attack/Caster.',
  harvest: {
    guaranteedReforgeRespectsCannotRoll: false,
    since: null,
    cannotRollTags: {
      'cannot-roll-attack': ['attack'],
      'cannot-roll-caster': ['caster'],
    },
  },
  recombinator: { exclusivePenalty: true, cannotIncreaseFractured: true, ev: 'experimental' },
  veiledExalted: { removesOneAddsOne: true },
  annul: { uniformAmongRemovable: true, respectsFractured: true },
  eldritch: { chaosSideFromDominance: true, exarch: 'prefix', eater: 'suffix' },
};

export const RULES_327 = {
  version: '3.27',
  league: '3.27',
  notes: '3.27+: guaranteed Harvest reforges respect Cannot Roll Attack/Caster.',
  harvest: {
    guaranteedReforgeRespectsCannotRoll: true,
    since: '3.27',
    cannotRollTags: {
      'cannot-roll-attack': ['attack'],
      'cannot-roll-caster': ['caster'],
    },
  },
  recombinator: { exclusivePenalty: true, cannotIncreaseFractured: true, ev: 'experimental' },
  veiledExalted: { removesOneAddsOne: true },
  annul: { uniformAmongRemovable: true, respectsFractured: true },
  eldritch: { chaosSideFromDominance: true, exarch: 'prefix', eater: 'suffix' },
};

export const RULES_328 = {
  ...RULES_327,
  version: '3.28',
  league: '3.28',
  notes: 'Inherits 3.27 harvest cannot-roll behaviour.',
};

export const RULES_329 = {
  ...RULES_327,
  version: '3.29',
  league: '3.29',
  notes: 'Versioned crafting ruleset. Harvest cannot-roll behaviour is 3.27+.',
};

const BY_VERSION = {
  '3.26': RULES_326,
  '3.27': RULES_327,
  '3.28': RULES_328,
  '3.29': RULES_329,
};

let active = RULES_329;

export function getRuleset() {
  return active;
}

export function rulesetVersion() {
  return active?.version ?? '3.29';
}

export function setRuleset(versionOrRules) {
  if (versionOrRules && typeof versionOrRules === 'object') {
    active = versionOrRules;
    return active;
  }
  const v = String(versionOrRules ?? '3.29');
  active = BY_VERSION[v] ?? RULES_329;
  return active;
}

export function listRulesets() {
  return Object.keys(BY_VERSION);
}

export function harvestRespectsCannotRoll(rules = active) {
  return !!rules?.harvest?.guaranteedReforgeRespectsCannotRoll;
}
