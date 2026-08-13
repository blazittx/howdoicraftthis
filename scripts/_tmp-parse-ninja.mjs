import { readFileSync, writeFileSync } from 'fs';

const raw = readFileSync(
  'C:/Users/info/.cursor/projects/c-Users-info-Documents-GitHub-howdoicraftthis/agent-tools/c4809e99-881f-4409-8de5-953eed379d64.txt',
  'utf8'
);
const j = JSON.parse(raw);
const want = [
  'Divine Orb',
  'Exalted Orb',
  'Orb of Alteration',
  'Orb of Annulment',
  'Orb of Alchemy',
  'Orb of Augmentation',
  'Orb of Transmutation',
  'Orb of Scouring',
  'Regal Orb',
  'Veiled Exalted Orb',
  'Veiled Chaos Orb',
  'Wild Crystallised Lifeforce',
  'Vivid Crystallised Lifeforce',
  'Primal Crystallised Lifeforce',
  'Sacred Crystallised Lifeforce',
  'Eldritch Chaos Orb',
  'Eldritch Orb of Annulment',
  'Eldritch Exalted Orb',
  'Lesser Eldritch Ichor',
  'Lesser Eldritch Ember',
  'Deafening Essence of Woe',
  'Deafening Essence of Zeal',
  'Dense Fossil',
  'Hollow Fossil',
];
const out = [];
for (const n of want) {
  const line = j.lines.find((x) => x.currencyTypeName === n);
  out.push(line ? `${n}: ${line.chaosEquivalent}` : `MISSING: ${n}`);
}
out.push('--- related ---');
for (const line of j.lines) {
  if (/Lifeforce|Essence of|Eldritch|Fossil|Veiled/i.test(line.currencyTypeName)) {
    out.push(`${line.currencyTypeName}: ${line.chaosEquivalent}`);
  }
}
writeFileSync('scripts/_tmp-ninja-out.txt', out.join('\n'));
console.log(out.join('\n'));
