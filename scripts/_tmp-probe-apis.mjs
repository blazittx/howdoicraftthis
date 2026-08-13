const league = 'Allflame';
const urls = [
  `https://poe.ninja/api/data/itemoverview?league=${encodeURIComponent(league)}&type=Essence`,
  `https://poe.ninja/api/data/itemoverview?league=${encodeURIComponent(league)}&type=Fossil`,
  `https://poe.ninja/api/data/currencyoverview?league=${encodeURIComponent(league)}&type=Currency`,
  `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`,
  `https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=${encodeURIComponent(league)}&type=Essences`,
  `https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=${encodeURIComponent(league)}&type=Fossils`,
  `https://poe.ninja/poe1/economy/allflame/item-overview?type=Essence`,
];

for (const url of urls) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const ct = r.headers.get('content-type') || '';
    let info = '';
    if (r.ok && ct.includes('json')) {
      const j = await r.json();
      const lines = j.lines ?? [];
      info = `lines=${lines.length} sample=${(lines[0]?.name || lines[0]?.currencyTypeName || '?')}`;
      const hit = lines.find((x) => /Veiled Exalted|Sacred|Deafening Essence of Woe|Dense Fossil|Eldritch Exalted/i.test(x.name || x.currencyTypeName || ''));
      if (hit) info += ` HIT=${hit.name || hit.currencyTypeName}:${hit.chaosValue ?? hit.chaosEquivalent}`;
    } else {
      info = (await r.text()).slice(0, 80).replace(/\s+/g, ' ');
    }
    console.log(r.status, ct.slice(0, 30), url.slice(0, 100), info);
  } catch (e) {
    console.log('ERR', url.slice(0, 80), e.message);
  }
}
