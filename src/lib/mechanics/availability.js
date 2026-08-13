/**
 * Method availability + source compatibility + operation preconditions (§58–59, §82).
 * Data-driven from operators-preconditions.json when present on kb.
 */
import { allAffixes } from '../craftState.js';
import { CAP, openSlot, lockGen, hasInfluence, removableAffixes } from './common.js';
import { isEldritchSlot } from './eldritch.js';

const DEFAULT_SOURCE_COMPAT = {
  natural: ['exalt', 'chaos', 'harvest-reforge', 'fossil', 'eldritch-chaos', 'eldritch-exalt', 'essence'],
  essence: ['essence'],
  essence_only: ['essence'],
  crafted: ['bench'],
  unveiled: ['unveil', 'veiled-exalt', 'veiled-chaos'],
  veiled: ['unveil'],
  delve: ['fossil'],
  influence: ['influence-exalt', 'exalt'],
  bestiary: ['beast-add-prefix-remove-suffix', 'beast-add-suffix-remove-prefix', 'beast-split'],
};

export function sourceCompatibility(kb) {
  return kb?.preconditions?.sourceCompatibility ?? DEFAULT_SOURCE_COMPAT;
}

export function sourcesCompatibleWithMethod(source, method, kb) {
  const map = sourceCompatibility(kb);
  const src = String(source ?? 'natural').toLowerCase();
  const methods = map[src] ?? map.natural ?? [];
  return methods.includes(method);
}

export function operatorPreconditions(kb) {
  return kb?.preconditions?.operators ?? {};
}

function checkReq(req, state, kb, ctx = {}) {
  switch (req) {
    case 'rareOrMagicWithOpenAffix':
      return openSlot(state, 'prefix') || openSlot(state, 'suffix');
    case 'hasRemovableAffix':
      return removableAffixes(state).length > 0;
    case 'itemClassInEssenceTable':
      return true;
    case 'rarityRare':
      return (state.prefixes?.length ?? 0) + (state.suffixes?.length ?? 0) >= 2 || state.rarity === 'Rare';
    case 'nonInfluenced':
      return !hasInfluence(state);
    case 'hasTaggedRemovable':
      return removableAffixes(state).length > 0;
    case 'hasVeiledAffix':
      return allAffixes(state).some((a) => a.veiled);
    case 'eldritchDominance':
      return !!state.eldritchDominance;
    case 'eldritchSlot':
      return isEldritchSlot(state.itemClass);
    case 'openDominanceSide': {
      const gen = state.eldritchDominance === 'eater' ? 'suffix' : 'prefix';
      return openSlot(state, gen);
    }
    case 'resonatorSockets':
      return true;
    case 'openPrefix':
      return openSlot(state, 'prefix');
    case 'openSuffix':
      return openSlot(state, 'suffix');
    case 'hasRemovableSuffix':
      return removableAffixes(state).some((a) => a.gen === 'suffix');
    case 'hasRemovablePrefix':
      return removableAffixes(state).some((a) => a.gen === 'prefix');
    case 'notSplit':
      return !state.split;
    case 'notInfluenced':
      return !hasInfluence(state);
    case 'openCraftedSlot':
      return openSlot(state, 'prefix') || openSlot(state, 'suffix');
    default:
      return true;
  }
}

function checkBlocked(flag, state) {
  switch (flag) {
    case 'corrupted':
      return !!state.corrupted;
    case 'mirrored':
      return !!state.mirrored;
    case 'fullSide':
      return !openSlot(state, 'prefix') && !openSlot(state, 'suffix');
    case 'influenced':
      return hasInfluence(state);
    default:
      return false;
  }
}

/**
 * Is this method available on the current mechanical state?
 * Uses structured preconditions when present — not string matching on action text.
 */
export function methodAvailable(state, method, kb, ctx = {}) {
  const id = String(method ?? '');
  const spec = operatorPreconditions(kb)[id] ?? {};
  const reasons = [];

  if (spec.illegalWith?.includes('anyMetacraft') && (state.metacrafts ?? []).length) {
    return { ok: false, reasons: [spec.reasonIllegal ?? 'illegal with metacraft'], illegal: true };
  }
  for (const req of spec.requires ?? []) {
    if (!checkReq(req, state, kb, ctx)) reasons.push(`missing:${req}`);
  }
  for (const b of spec.blockedBy ?? []) {
    if (checkBlocked(b, state)) reasons.push(`blocked:${b}`);
  }
  if (spec.slots?.length && !spec.slots.some((s) => String(state.itemClass).includes(s.replace(/s$/, '')))) {
    // soft: eldritch slots checked via eldritchSlot req
  }
  return { ok: reasons.length === 0, reasons };
}

/** Evaluate preconditions for an operator id. */
export function checkPreconditions(state, operatorId, kb, ctx = {}) {
  return methodAvailable(state, operatorId, kb, ctx);
}
