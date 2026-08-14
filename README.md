# How Do I Craft This

Paste a Path of Exile item (Ctrl+C in game) and get step-by-step universal crafting instructions.

Inspired by [Craft of Exile](https://www.craftofexile.com) — this tool works **backwards**: you paste a finished item and it tells you how to craft something like it using the Alt → Regal → Exalt method.

## Quick start

```bash
npm install
npm run build:data   # downloads RePoE mod data (first time / after updates)
npm run dev
```

Opens at `http://localhost:5173`.

## Electron (optional)

```bash
npm run electron:dev
```

Runs Vite + Electron desktop window.

## Local LLM advisor (optional)

EV ranking stays authoritative. An optional Ollama-backed advisor can **explain** plans, flag inconsistent provided fields, and suggest search expansions — it never invents gold/dust/p% or replaces `V(S)`.

See [docs/LLM-ADVISOR.md](docs/LLM-ADVISOR.md): install Ollama → `ollama pull llama3.2:3b` → enable **Local LLM advisor** in plan options.

## Knowledge base (PoE1 only)

```bash
npm run build:knowledge
```

Writes `public/data/knowledge/` from RePoE + official Harvest/metacraft lists. See [public/data/knowledge/README.md](public/data/knowledge/README.md) and `coverage.json` for what is fully covered vs still missing (recombinators, allflames, beasts, …).

The planner must only recommend crafts that exist in this knowledge base — no invented methods.

1. **Parse** — Supports Advanced Mod Descriptions (fractured / crafted / essence / tags / tiers) and simple Ctrl+C text.
2. **Classify** — Matches mods to RePoE (weights, groups, essences).
3. **Plan** — Side-completion recipe builder:
   - Fractured buy targets
   - Essence spam
   - Metacraft + Harvest reforge (e.g. Reforge Critical)
   - Metacraft + Veiled Exalt → unveil
   - Bench craft finishers
4. **Cost** — Expected currency counts from a daily poe.ninja snapshot (`npm run fetch-prices` → `public/data/prices/daily.json`). Harvest uses Wild/Vivid/Primal lifeforce × juice price; no hardcoded EV fallbacks.

Simple items without fracture/essence/veiled still use Alt → Regal → Exalt.

## Supported formats

- **PoE 1** in-game Ctrl+C text (primary)
- **PoE 2** items (basic detection)

Trade site and Path of Building copy formats are **not** supported — copy directly from the game client.

## Roadmap

- [ ] Full mod database (tiers, groups) via RePoE
- [ ] Essence / Fossil / Harvest method suggestions
- [ ] Craft of Exile deep-link with pre-filled mods
- [ ] Metacrafting paths for 5–6 mod items
