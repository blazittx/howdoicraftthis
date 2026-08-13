const league = 'Allflame';
const candidates = [
  `https://poe.ninja/poe1/api/economy/stash/current/essence/overview?league=${league}`,
  `https://poe.ninja/poe1/api/economy/stash/current/essences/overview?league=${league}`,
  `https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=${league}&type=Essence`,
  `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=${league}&type=Essence`,
  `https://poe.ninja/poe1/api/economy/stash/current/fossil/overview?league=${league}`,
  `https://poe.ninja/poe1/api/economy/stash/current/fossils/overview?league=${league}`,
  `https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=${league}&type=Fossil`,
  // try lowercase path segments from site
  `https://poe.ninja/poe1/api/economy/stash/current/overview?league=${league}&category=essences`,
  `https://poe.ninja/poe1/api/data/economy/stash/current/item/overview?league=${league}&type=Essence`,
];

for (const url of candidates) {
  const r = await fetch(url);
  let extra = '';
  if (r.ok) {
    const j = await r.json();
    extra = `lines=${j.lines?.length} sample=${j.lines?.[0]?.name || j.lines?.[0]?.currencyTypeName || Object.keys(j).join(',')}`;
  }
  console.log(r.status, url.replace('https://poe.ninja', ''), extra);
}

// Parse exchange for our keys
{
  const url = `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=${league}&type=Currency`;
  const j = await (await fetch(url)).json();
  const byId = Object.fromEntries(j.lines.map((l) => [l.id, l.primaryValue]));
  const want = [
    'divine',
    'exalted',
    'alt',
    'annul',
    'alch',
    'aug',
    'chance',
    'scour',
    'regal',
    'veiled-exalted-orb',
    'veiled-chaos-orb',
    'wild-crystallised-lifeforce',
    'vivid-crystallised-lifeforce',
    'primal-crystallised-lifeforce',
    'sacred-crystallised-lifeforce',
    'eldritch-chaos-orb',
    'eldritch-orb-of-annulment',
    'eldritch-exalted-orb',
    'lesser-eldritch-ichor',
    'lesser-eldritch-ember',
    'transmute',
  ];
  // also list all lifeforce / veiled / eldritch ids
  for (const id of Object.keys(byId).sort()) {
    if (/life|veiled|eldritch|divine|exalt|essence|fossil|alt|annul|woe|zeal|dense|hollow/i.test(id)) {
      console.log(id, byId[id]);
    }
  }
  console.log('---want---');
  for (const id of want) console.log(id, byId[id] ?? 'MISSING');
}
