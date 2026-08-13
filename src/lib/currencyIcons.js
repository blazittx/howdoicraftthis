/**
 * Cost / step currency key → poecdn inventory icon (CDN only, no local assets).
 * Prefer Art/2DItems paths; onerror in UI falls back to text.
 */
const CDN = 'https://web.poecdn.com/image/Art/2DItems';

/** Relative path under Art/2DItems (no .png). */
const ICONS = {
  chaos: 'Currency/CurrencyRerollRare',
  divine: 'Currency/CurrencyModValues',
  mirror: 'Currency/CurrencyDuplicate',
  exalt: 'Currency/CurrencyAddModToRare',
  annul: 'Currency/AnnullOrb',
  alchemy: 'Currency/CurrencyUpgradeToRare',
  alteration: 'Currency/CurrencyRerollMagic',
  regal: 'Currency/CurrencyUpgradeMagicToRare',
  transmute: 'Currency/CurrencyUpgradeToMagic',
  augmentation: 'Currency/CurrencyAddModToMagic',
  scour: 'Currency/CurrencyConvertToNormal',
  veiled: 'Currency/VeiledExaltedOrb',
  'veiled-chaos': 'Currency/VeiledChaosOrb',
  'eldritch-chaos': 'Currency/EldritchChaosOrb',
  'eldritch-annul': 'Currency/EldritchAnnulmentOrb',
  'eldritch-exalt': 'Currency/EldritchExaltedOrb',
  'eldritch-ichor': 'Currency/TangleOrbRank1',
  'eldritch-ember': 'Currency/CleansingFireOrbRank1',
  'warlord-exalt': 'Currency/Influence Exalts/ConquerorOrb',
  'redeemer-exalt': 'Currency/Influence Exalts/EyrieOrb',
  'crusader-exalt': 'Currency/Influence Exalts/CrusaderOrb',
  'hunter-exalt': 'Currency/Influence Exalts/BasiliskOrb',
  'shaper-exalt': 'Currency/SecretsoftheAtlas/ShaperExaltedOrb',
  'elder-exalt': 'Currency/SecretsoftheAtlas/ElderExaltedOrb',
  'wild-lifeforce': 'Currency/Harvest/WildLifeforce',
  'vivid-lifeforce': 'Currency/Harvest/VividLifeforce',
  'primal-lifeforce': 'Currency/Harvest/PrimalLifeforce',
  'sacred-lifeforce': 'Currency/Harvest/SacredLifeforce',
  harvest: 'Currency/Harvest/WildLifeforce',
  fossil: 'Currency/Delve/DenseFossil',
  'fossil-dense': 'Currency/Delve/DenseFossil',
  'fossil-hollow': 'Currency/Delve/AmberEye',
  essence: 'Currency/Essence/Anger6',
  'essence-muttering': 'Currency/Essence/Anger2',
  'essence-weeping': 'Currency/Essence/Anger3',
  'essence-wailing': 'Currency/Essence/Anger4',
  'essence-screaming': 'Currency/Essence/Anger5',
  'essence-shrieking': 'Currency/Essence/Anger6',
  'essence-deafening': 'Currency/Essence/Anger7',
  bench: 'Currency/CurrencyImplicitMod',
  quality: 'Currency/CurrencyArmourQuality',
};

export function currencyIconUrl(key) {
  if (!key) return null;
  const k = String(key);
  let path = ICONS[k];
  if (!path && k.startsWith('essence')) path = ICONS.essence;
  if (!path && k.startsWith('fossil')) path = ICONS.fossil;
  if (!path && k.endsWith('-lifeforce')) path = ICONS.harvest;
  if (!path && k.endsWith('-exalt') && !k.startsWith('eldritch')) path = ICONS.exalt;
  if (!path) return null;
  return `${CDN}/${path.split('/').map(encodeURIComponent).join('/')}.png`;
}
