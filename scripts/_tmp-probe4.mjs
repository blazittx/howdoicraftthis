const league = 'Allflame';

// Essence exchange — dump ids containing essence/woe/zeal
{
  const url = `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=${league}&type=Essence`;
  const j = await (await fetch(url)).json();
  console.log('essence exchange lines', j.lines?.length, 'items', j.items?.length ?? typeof j.items);
  const ids = j.lines.map((l) => l.id);
  console.log('has deafening?', ids.filter((id) => /deafening|woe|zeal|essence/i.test(id)).slice(0, 30));
  console.log('first 20 ids', ids.slice(0, 20));
}

// Try stash item types that might work for essences
const types = [
  'Oil',
  'Incubator',
  'Resonator',
  'Fossil',
  'Essence',
  'DivinationCard',
  'UniqueArmour',
  'UniqueAccessory',
  'BaseType',
  'HelmetEnchant',
  'Map',
  'Scaraba',
  'Scarab',
  'Artifact',
  'Invitation',
  'Memory',
  'Beast',
];
for (const type of types) {
  const url = `https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=${league}&type=${type}`;
  const r = await fetch(url);
  if (!r.ok) continue;
  const j = await r.json();
  const sample = j.lines?.[0]?.name;
  console.log('OK item', type, j.lines?.length, sample);
}
