const league = 'Allflame';
for (const type of ['Fossil', 'Currency', 'Essence']) {
  const url = `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=${league}&type=${type}`;
  const j = await (await fetch(url)).json();
  const ids = (j.lines || []).map((l) => l.id);
  console.log(type, 'count', ids.length);
  if (type === 'Fossil') console.log(ids.slice(0, 40));
  if (type === 'Essence') {
    const deaf = j.lines.filter((l) => l.id.startsWith('deafening-'));
    const scream = j.lines.filter((l) => l.id.startsWith('screaming-'));
    const shriek = j.lines.filter((l) => l.id.startsWith('shrieking-'));
    const weep = j.lines.filter((l) => l.id.startsWith('weeping-'));
    const wail = j.lines.filter((l) => l.id.startsWith('wailing-'));
    const mut = j.lines.filter((l) => l.id.startsWith('muttering-'));
    const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x.primaryValue, 0) / arr.length : null);
    console.log('deafening avg', avg(deaf), 'n', deaf.length, 'woe', j.lines.find((l) => l.id === 'deafening-essence-of-woe')?.primaryValue, 'zeal', j.lines.find((l) => l.id === 'deafening-essence-of-zeal')?.primaryValue);
    console.log('screaming avg', avg(scream), 'shrieking', avg(shriek), 'weeping', avg(weep), 'wailing', avg(wail), 'muttering', avg(mut));
  }
}
