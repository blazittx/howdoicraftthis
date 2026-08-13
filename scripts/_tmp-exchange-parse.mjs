import { writeFileSync } from 'fs';

const league = 'Allflame';
const url = `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`;
const j = await (await fetch(url)).json();
writeFileSync('scripts/_tmp-exchange-full-meta.json', JSON.stringify({ core: j.core, items: j.items }, null, 2));

// items is probably id -> name map
const items = j.items;
console.log('items type', typeof items, Array.isArray(items) ? items.length : Object.keys(items || {}).slice(0, 5));
if (Array.isArray(items)) {
  console.log('item0', items[0]);
  const hits = items.filter((x) => /Veiled Exalted|Sacred Crystallised|Deafening|Dense Fossil|Eldritch Exalted|Lifeforce|Divine/i.test(JSON.stringify(x)));
  console.log('hits', hits.slice(0, 20));
} else if (items && typeof items === 'object') {
  const vals = Object.entries(items).slice(0, 5);
  console.log('sample entries', vals);
}

// Resolve lines via items
function nameOf(id) {
  if (Array.isArray(items)) {
    const it = items.find((x) => x.id === id || x === id);
    return it?.name || it?.text || it?.currencyTypeName || String(id);
  }
  const it = items?.[id];
  return it?.name || it?.text || it || String(id);
}

for (const line of j.lines.slice(0, 5)) {
  console.log('line', line.id, nameOf(line.id), 'primary', line.primaryValue, line);
}

// Find interesting by scanning items
const want = /Veiled Exalted|Sacred Crystallised|Eldritch Exalted|Wild Crystallised|Vivid Crystallised|Primal Crystallised|Divine Orb|Deafening Essence of Woe|Dense Fossil/i;
if (Array.isArray(items)) {
  for (const it of items) {
    const n = it.name || it.text || '';
    if (want.test(n)) {
      const line = j.lines.find((l) => l.id === it.id);
      console.log('FOUND', n, 'id', it.id, 'line', line);
    }
  }
}
