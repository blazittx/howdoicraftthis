import { writeFileSync } from 'fs';

const league = 'Allflame';

// Exchange overview structure
{
  const url = `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`;
  const j = await (await fetch(url)).json();
  writeFileSync('scripts/_tmp-exchange.json', JSON.stringify(j, null, 2).slice(0, 8000));
  console.log('exchange keys', Object.keys(j));
  console.log('lines0 keys', j.lines?.[0] ? Object.keys(j.lines[0]) : j);
  const flat = JSON.stringify(j).match(/Veiled Exalted|Sacred Crystallised|Deafening|Dense Fossil|Eldritch Exalted|Wild Crystallised/g);
  console.log('exchange hits', flat);
}

// Try more item overview type names
const types = [
  'Essence',
  'Fossil',
  'UniqueWeapon',
  'SkillGem',
  'Oil',
  'DeliriumOrb',
  'Currency',
  'Fragment',
];
for (const type of types) {
  for (const path of [
    `https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=${encodeURIComponent(league)}&type=${type}`,
    `https://poe.ninja/poe1/api/economy/stash/current/overview?league=${encodeURIComponent(league)}&type=${type}`,
  ]) {
    const r = await fetch(path);
    if (r.ok) {
      const j = await r.json();
      console.log('OK', path, 'lines', j.lines?.length, 'sample', j.lines?.[0]?.name || j.lines?.[0]?.currencyTypeName);
    } else if (r.status !== 404) {
      console.log(r.status, path);
    }
  }
}

// Currency stash — look for veiled exalted by detailsId
{
  const url = `https://poe.ninja/poe1/api/economy/stash/current/currency/overview?league=${encodeURIComponent(league)}&type=Currency`;
  const j = await (await fetch(url)).json();
  for (const line of j.lines) {
    if (/veiled|sacred|eldritch-exalted|exalted-orb$/i.test(line.detailsId || '') || /Veiled Exalted|Sacred|Eldritch Exalted/i.test(line.currencyTypeName || '')) {
      console.log('currency hit', line.currencyTypeName, line.detailsId, line.chaosEquivalent);
    }
  }
  console.log('total currency lines', j.lines.length);
}
