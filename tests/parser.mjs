/**
 * Parser unit tests (§40 / §41).
 */
import { parseItem, normalizeModText } from '../src/lib/itemParser.js';
import { assert } from './helpers/assert.js';

const WAND = `Item Class: Wands
Rarity: Rare
Cataclysm Needle
Kinetic Wand
--------
Item Level: 85
--------
{ Implicit Modifier }
Cannot roll Caster Modifiers
--------
{ Fractured Prefix Modifier "Zaffre" (Tier: 1) — Mana }
+156(140-159) to maximum Mana
{ Prefix Modifier "Chosen" (Tier: 1) — Damage, Chaos, Attack }
Attacks with this Weapon Penetrate 16(14-16)% Chaos Resistance
{ Master Crafted Prefix Modifier "Upgraded" — Damage, Chaos, Caster }
50(46-50)% increased Spell Damage
Gain 4% of Non-Chaos Damage as extra Chaos Damage
{ Suffix Modifier "of the Essence" — Attack, Speed }
18(17-18)% increased Attack Speed
{ Suffix Modifier "of Ferocity" (Tier: 2) — Damage, Critical }
+31(30-34)% to Global Critical Strike Multiplier
{ Suffix Modifier "of Incision" (Tier: 1) — Attack, Critical }
36(35-38)% increased Critical Strike Chance
--------
Fractured Item`;

export async function runParserTests() {
  assert(normalizeModText('+156(140-159) to maximum Mana') === '+156 to maximum Mana', 'rolled value kept');
  assert(normalizeModText('(16-17)% chance') === '17% chance', 'range-only uses max');

  const item = parseItem(WAND);
  assert(item.baseName === 'Kinetic Wand', 'base Kinetic Wand');
  assert(item.itemLevel === 85, 'ilvl 85');
  assert(item.fracturedItem === true, 'fracturedItem flag');
  const mods = item.explicitMods ?? [];
  assert(mods.length >= 5, `parsed ≥5 explicits, got ${mods.length}`);
  assert(mods.some((m) => m.fractured), 'fractured mod flagged');
  assert(mods.some((m) => m.crafted), 'crafted/bench mod');
  assert(mods.some((m) => m.ofEssence || /Essence/i.test(m.name ?? '')), 'essence suffix');
  assert((item.implicits ?? []).some((t) => /Cannot roll Caster/i.test(String(t.text ?? t))), 'implicit cannot-roll');

  console.log('OK: parser tests passed');
}
