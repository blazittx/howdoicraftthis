/** Canonical item-class keys (RePoE / essence tables use singular except Boots/Gloves). */

const PLURAL_TO_SINGULAR = {
  Wands: 'Wand',
  Belts: 'Belt',
  Rings: 'Ring',
  Amulets: 'Amulet',
  Quivers: 'Quiver',
  Claws: 'Claw',
  Daggers: 'Dagger',
  Sceptres: 'Sceptre',
  Bows: 'Bow',
  Staves: 'Staff',
  Shields: 'Shield',
  Helmets: 'Helmet',
};

export function normalizeItemClass(ic) {
  if (!ic) return null;
  const s = String(ic);
  if (s === 'Body Armours') return 'Body Armour';
  if (s === 'Boots' || s === 'Boot') return 'Boots';
  if (s === 'Gloves' || s === 'Glove') return 'Gloves';
  return PLURAL_TO_SINGULAR[s] ?? s;
}
