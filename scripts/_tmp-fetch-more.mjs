import { writeFileSync } from 'fs';

const league = 'Allflame';
const urls = [
  `https://poe.ninja/poe1/api/economy/stash/current/currency/overview?league=${encodeURIComponent(league)}&type=Currency`,
  `https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=${encodeURIComponent(league)}&type=Essence`,
  `https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=${encodeURIComponent(league)}&type=Fossil`,
];

const names = [];
for (const url of urls) {
  const r = await fetch(url);
  console.log(r.status, url);
  const j = await r.json();
  for (const line of j.lines ?? []) {
    const name = line.currencyTypeName ?? line.name;
    const chaos = line.chaosEquivalent ?? line.chaosValue;
    names.push({ name, chaos, src: url.includes('Essence') ? 'essence' : url.includes('Fossil') ? 'fossil' : 'currency' });
  }
}

const interesting = names.filter((x) =>
  /Divine|Veiled|Lifeforce|Eldritch|Exalted Orb$|Alteration|Annulment|Essence of (Woe|Zeal|Anger|Hatred|Wrath|Sorrow|Envy|Dread|Fear|Greed|Contempt|Misery|Loathing|Suffering|Torment|Rage|Scorn|Spite|Doubt|Anguish|Delirium|Horror|Insanity|Hysteria)|Dense Fossil|Hollow Fossil|Alchemy|Augmentation|Transmutation|Scouring|Regal/i.test(
    x.name
  )
);
writeFileSync('scripts/_tmp-ninja-out2.txt', interesting.map((x) => `${x.src}\t${x.name}\t${x.chaos}`).join('\n'));
console.log(interesting.map((x) => `${x.src}\t${x.name}\t${x.chaos}`).join('\n'));
