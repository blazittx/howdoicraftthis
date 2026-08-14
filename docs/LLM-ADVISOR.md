# Local LLM advisor (optional)

Optional **critique / explain / search-hint** layer on top of the EV optimizer. It does **not** pick crafts, invent costs, or replace `V(S)` / recombinator physics.

## Recommended stack (Windows)

| Runtime | Verdict |
|---------|---------|
| **Ollama** (primary) | Best UX for low-GB Llama: install, `ollama pull`, HTTP on `127.0.0.1:11434`. No weights in git. |
| llama.cpp | More control / quantization knobs; worse product friction (paths, server flags). Use later if you need custom GGUF. |
| transformers.js | Runs in-renderer or worker; weak for multi-k context + reasoning, large downloads, fights sandbox. Avoid for this app. |

**Where it runs:** Electron **main process** IPC (`electron/llmBridge.js` + `preload.js`) → Ollama. Renderer stays `nodeIntegration: false` / `contextIsolation: true`. Browser-only Vite falls back to `fetch` (set `OLLAMA_ORIGINS=http://localhost:5173`).

## Role vs EV

```
optimizeCraft / V(S)  ──►  ranked plan (authoritative)
        │
    ──► Thought process: tag clusters / side-lock hints (engine)
        │
    ▼
  llmAdvise(payload)  ──►  explain / evFlag / searchHint / macroExpand
        │                   Thought process: collapsible “LLM input” (exact JSON)
        ▼
  validateAdvice()    ──►  drop uncited costs & invented numbers
        │
        ▼
  UI “Advisor notes”  (never changes totalCost / winner)
```

The system prompt (`src/lib/llm/prompt.js`, id `craft-advisor` + version) frames the model as a **crafting strategy planner**: it inspects the **engine payload** (no live tool-calls yet), cites only provided numbers, never claims deterministic unless the engine says so, prefers protecting expensive keepers / tag-clustered sides, compares tag-forcing / entropy vs Recombinator, and rejects unsupported mechanics. Allowed outputs only suggest **what to search next** or **explain provided numbers**. Never invent gold/dust/p%.

## What the model receives (LLM input)

Shown in **Thought process** as a collapsible **LLM input** block (summary line + full JSON). Built by `buildAdvisePayload`:

| Field | Contents |
|-------|----------|
| `prompt.id` / `prompt.version` | System prompt id (`craft-advisor`) + version |
| `target` | `baseName`, `itemClass`, `itemLevel`, influences, slim mods (`text`, `gen`, `tags`, flags) |
| `best` | Winner name, `totalCost`, economics fields (gold/dust/CE when present) |
| `candidates` | Top alternatives (id, name, totalCost, short description) |
| `rejected` | Why-lost + EV for strategies that lost |
| `solverDebug` | `V` / `Q*`, `macros`, `entropyChains`, **`tagClusters`**, `preferredLockSide`, coupling, fracture-by-EV |
| `methodComparison` | sequential vs recombinator winner summary |

Also sent (same block): **model name**, transport (`ipc` / `fetch`), and the exact `messages[]` (system + user JSON string).

If the advisor is **off** or there is **no plan**, Thought process logs `Advisor skipped (…)`. If Ollama is down, it logs unreachable and the EV plan still stands.

## Setup

1. Install [Ollama](https://ollama.com) for Windows.
2. Pull a small model, e.g. `ollama pull llama3.2:3b`
3. Run the app (`npm run electron:dev` preferred, or `npm run dev`).
4. Enable **Local LLM advisor (Ollama)** in plan options; set model name if needed.
5. Paste/plan an item → Thought process shows **LLM input**; **Advisor notes** appears when Ollama responds.

If Ollama is down, the advisor no-ops (plan still works).

## API shape

Conceptual `POST /advise` (implemented as IPC/`/api/chat` with JSON format):

```json
{
  "prompt": { "id": "craft-advisor", "version": "1.1.0" },
  "target": { "baseName": "…", "mods": [{ "text": "…", "gen": "suffix", "tags": ["attack"] }] },
  "best": { "name": "…", "totalCost": 123.4, "economics": {…} },
  "candidates": [{ "id": "…", "totalCost": … }],
  "rejected": [{ "id": "…", "whyLost": "…", "ev": … }],
  "solverDebug": {
    "V": …,
    "Qsequential": …,
    "tagClusters": [{ "side": "suffix", "tag": "attack", "count": 3 }],
    "entropyChains": [{ "id": "protect+reforgeTag", "why": "…" }]
  }
}
```

→ structured advice JSON validated by `src/lib/llm/schema.js`.

## Files

- `src/lib/llm/advisor.js` — client + settings + graceful no-op / skip logging
- `src/lib/llm/prompt.js` — system prompt id/version + payload slim
- `src/lib/llm/schema.js` — hand validation vs invariants
- `electron/llmBridge.js` — Ollama HTTP from main
- `electron/preload.js` — `window.llmBridge`
