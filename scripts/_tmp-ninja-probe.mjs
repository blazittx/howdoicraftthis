const urls = [
  ["1-exchange-currency", "https://poe.ninja/poe1/api/economy/exchange/current/overview?league=Allflame&type=Currency"],
  ["2-stash-currency", "https://poe.ninja/poe1/api/economy/stash/current/currency/overview?league=Allflame&type=Currency"],
  ["3-stash-item-currency", "https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=Allflame&type=Currency"],
  ["5-legacy-currencyoverview", "https://poe.ninja/api/data/currencyoverview?league=Allflame&type=Currency"],
];
const exchangeTypes = ["Harvest", "Lifeforce", "Fragment", "Oil", "Fossil", "Scarab"];
const re = /life|harvest|juice|force|wild|vivid|primal|sacred/i;
const fossilRe = /dense|hollow/i;
const lifeRe = /life|wild|vivid|primal|crystall/i;

function pickLines(data) {
  if (!data) return [];
  if (Array.isArray(data.lines)) return data.lines;
  if (Array.isArray(data)) return data;
  return [];
}

function summarizeLine(l) {
  return {
    id: l.id ?? l.currencyTypeName ?? l.name ?? l.detailsId ?? null,
    name: l.currencyTypeName ?? l.name ?? l.id ?? null,
    chaos: l.chaosEquivalent ?? l.chaosValue ?? null,
    pay: l.pay ?? undefined,
    receive: l.receive ?? undefined,
    detailsId: l.detailsId ?? undefined,
  };
}

async function fetchOne(label, url) {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "howdoicraftthis-probe" } });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const lines = pickLines(data);
  return { label, url, status: res.status, ok: res.ok, lineCount: lines.length, data, lines, rawPreview: text.slice(0, 300) };
}

function filterIds(lines, pattern) {
  return lines.filter(l => {
    const s = JSON.stringify(l);
    return pattern.test(s) || pattern.test(String(l.id||"")) || pattern.test(String(l.currencyTypeName||"")) || pattern.test(String(l.name||"")) || pattern.test(String(l.detailsId||""));
  });
}

(async () => {
  const results = {};
  for (const [label, url] of urls) {
    try { results[label] = await fetchOne(label, url); }
    catch (e) { results[label] = { label, url, error: String(e) }; }
  }
  for (const t of exchangeTypes) {
    const url = `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=Allflame&type=${encodeURIComponent(t)}`;
    const label = `4-exchange-${t}`;
    try { results[label] = await fetchOne(label, url); }
    catch (e) { results[label] = { label, url, error: String(e) }; }
  }

  for (const [label, r] of Object.entries(results)) {
    console.log("\n==== " + label + " ====");
    if (r.error) { console.log("ERROR", r.error); continue; }
    console.log("status:", r.status, "lines:", r.lineCount, "url:", r.url);
    if (!r.ok && r.lineCount === 0) { console.log("body:", r.rawPreview); continue; }
    const lines = r.lines || [];

    if (label === "1-exchange-currency") {
      const idHits = lines.filter(l => re.test(String(l.id||"")) || re.test(String(l.currencyTypeName||"")) || re.test(String(l.name||"")) || re.test(String(l.detailsId||"")));
      console.log("ALL keyword line ids (" + idHits.length + "):");
      for (const l of idHits) {
        console.log(JSON.stringify({ id: l.id, name: l.currencyTypeName||l.name, detailsId: l.detailsId, chaosEquivalent: l.chaosEquivalent, pay: l.pay, receive: l.receive }));
      }
    }

    if (label === "2-stash-currency" || label === "5-legacy-currencyoverview") {
      const hits = filterIds(lines, lifeRe);
      console.log("lifeforce-ish:", hits.length);
      for (const l of hits) {
        console.log(JSON.stringify({ currencyTypeName: l.currencyTypeName, name: l.name, id: l.id, detailsId: l.detailsId, chaosEquivalent: l.chaosEquivalent, chaosValue: l.chaosValue }));
      }
    }

    if (label === "3-stash-item-currency") {
      const hits = filterIds(lines, lifeRe);
      console.log("lifeforce-ish:", hits.length);
      for (const l of hits) console.log(JSON.stringify(summarizeLine(l)));
      if (!hits.length && lines[0]) {
        console.log("sample keys:", Object.keys(lines[0]));
        console.log("sample names:", lines.slice(0,5).map(l => l.currencyTypeName||l.name||l.id));
      }
    }

    if (label.startsWith("4-exchange-")) {
      const life = filterIds(lines, lifeRe);
      if (life.length) {
        console.log("LIFEFORCE LINES:");
        for (const l of life) console.log(JSON.stringify(summarizeLine(l)));
      }
    }

    const fossils = filterIds(lines, /dense fossil|hollow fossil/i);
    if (fossils.length) {
      console.log("FOSSIL dense/hollow:");
      for (const l of fossils) console.log(JSON.stringify(summarizeLine(l)));
    }
  }

  const extra = [
    ["stash-fossil", "https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=Allflame&type=Fossil"],
    ["legacy-fragment", "https://poe.ninja/api/data/currencyoverview?league=Allflame&type=Fragment"],
    ["exchange-Currency-dump-lifeforce-ids", "https://poe.ninja/poe1/api/economy/exchange/current/overview?league=Allflame&type=Currency"],
  ];
  for (const [label, url] of extra) {
    console.log("\n==== EXTRA " + label + " ====");
    try {
      const r = await fetchOne(label, url);
      console.log("status:", r.status, "lines:", r.lineCount);
      const life = filterIds(r.lines, lifeRe);
      const fossils = filterIds(r.lines, fossilRe);
      if (life.length) { console.log("LIFE:"); for (const l of life) console.log(JSON.stringify(summarizeLine(l))); }
      if (fossils.length) { console.log("FOSSILS:"); for (const l of fossils) console.log(JSON.stringify(summarizeLine(l))); }
      if (label === "stash-fossil") {
        const dh = r.lines.filter(l => /dense|hollow/i.test(String(l.name||"")) || /dense|hollow/i.test(String(l.id||"")));
        console.log("dense/hollow count:", dh.length);
        for (const l of dh) console.log(JSON.stringify(summarizeLine(l)));
      }
    } catch (e) { console.log("ERROR", e); }
  }
})();
