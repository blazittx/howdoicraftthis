/**
 * Local LLM craft advisor — critique / explain / search hints only.
 * Never overrides EV ranking. Graceful no-op if Ollama is down.
 */
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_ID,
  SYSTEM_PROMPT_VERSION,
  buildAdvisePayload,
  buildUserPrompt,
  summarizeAdvisePayload,
} from './prompt.js';
import { collectInvariants, validateAdvice } from './schema.js';

const DEFAULT_MODEL = 'llama3.2:3b';
const STORAGE_KEY = 'hdic_llm_advisor';

export function loadAdvisorSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: false, model: DEFAULT_MODEL };
    const o = JSON.parse(raw);
    return {
      enabled: !!o.enabled,
      model: typeof o.model === 'string' && o.model.trim() ? o.model.trim() : DEFAULT_MODEL,
    };
  } catch {
    return { enabled: false, model: DEFAULT_MODEL };
  }
}

export function saveAdvisorSettings(s) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ enabled: !!s.enabled, model: s.model || DEFAULT_MODEL })
  );
}

async function chatStreamFetch({ model, messages, format, onToken }) {
  const base = 'http://127.0.0.1:11434';
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages,
      stream: true,
      format: format || 'json',
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  if (!res.body?.getReader) {
    const json = await res.json();
    return json;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let last = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      last = obj;
      const piece = obj?.message?.content;
      if (typeof piece === 'string' && piece) {
        content += piece;
        onToken?.(content);
      }
    }
  }
  if (buf.trim()) {
    try {
      const obj = JSON.parse(buf.trim());
      last = obj;
      const piece = obj?.message?.content;
      if (typeof piece === 'string' && piece) {
        content += piece;
        onToken?.(content);
      }
    } catch {
      /* ignore trailing partial */
    }
  }
  if (last?.message) {
    return { ...last, message: { ...last.message, content: content || last.message.content } };
  }
  return { message: { content }, response: content };
}

function transport() {
  // Electron preload bridge (preferred — renderer stays sandboxed)
  if (typeof window !== 'undefined' && window.llmBridge?.chat) {
    const bridge = window.llmBridge;
    return {
      kind: 'ipc',
      stream: typeof bridge.chatStream === 'function',
      chat: (body) => bridge.chat(body),
      chatStream: bridge.chatStream
        ? (body, onToken) => bridge.chatStream(body, onToken)
        : null,
      ping: () => bridge.ping(),
    };
  }
  // Browser / Vite: direct Ollama (needs OLLAMA_ORIGINS)
  const base = 'http://127.0.0.1:11434';
  return {
    kind: 'fetch',
    stream: true,
    async chat({ model, messages, format }) {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          messages,
          stream: false,
          format: format || 'json',
        }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      return res.json();
    },
    chatStream: (body, onToken) =>
      chatStreamFetch({ ...body, onToken }),
    async ping() {
      try {
        const res = await fetch(`${base}/api/tags`, { method: 'GET' });
        return { ok: res.ok, status: res.status };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
  };
}

function parseJsonContent(content) {
  if (content && typeof content === 'object') return content;
  const s = String(content ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Optional advisor pass after optimizeCraft.
 * @returns {Promise<null | { status: string, advice?: object, error?: string, warnings?: string[] }>}
 */
export async function llmAdvise({
  target,
  candidates,
  rejected,
  economics,
  best,
  solverDebug,
  model,
  onProgress,
}) {
  const settings = loadAdvisorSettings();
  if (!settings.enabled) {
    onProgress?.({
      phase: 'advisor',
      message: 'Advisor skipped (disabled in settings)',
      skipped: true,
    });
    return { status: 'skipped', reason: 'disabled', advice: null };
  }

  const t = transport();
  onProgress?.({ message: 'Advisor: pinging Ollama…' });
  const ping = await t.ping().catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (!ping?.ok) {
    onProgress?.({ message: 'Advisor: Ollama not reachable' });
    return { status: 'unavailable', error: ping?.error || 'Ollama not reachable', advice: null };
  }

  const useModel = model || settings.model || DEFAULT_MODEL;
  const payload = buildAdvisePayload({
    target,
    candidates: candidates ?? best?.alternatives,
    rejected: rejected ?? best?.rejectedStrategies,
    economics: economics ?? best?.economics,
    best,
    solverDebug: solverDebug ?? best?.solverDebug,
  });
  const invariants = collectInvariants(payload);
  const userPrompt = buildUserPrompt(payload);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  // Exact input the model receives — thought process shows summary + expandable JSON
  onProgress?.({
    message: `LLM input · ${useModel} · ${SYSTEM_PROMPT_ID}@${SYSTEM_PROMPT_VERSION} · ${summarizeAdvisePayload(payload)}`,
    llmInput: {
      model: useModel,
      systemPromptId: SYSTEM_PROMPT_ID,
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      transport: t.kind,
      summary: summarizeAdvisePayload(payload),
      payload,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    },
  });

  try {
    let raw;
    if (t.stream && t.chatStream) {
      onProgress?.({ message: `Advisor: streaming ${useModel}…` });
      let lastLen = 0;
      raw = await t.chatStream({ model: useModel, format: 'json', messages }, (acc) => {
        // Throttle thought-log updates to avoid flooding
        if (acc.length - lastLen < 24 && acc.length < 400) return;
        lastLen = acc.length;
        const preview = acc.length > 280 ? `${acc.slice(0, 280)}…` : acc;
        onProgress?.({ message: `Advisor ≫ ${preview}`, stream: true });
      });
    } else {
      onProgress?.({ message: `Advisor: waiting on ${useModel}…` });
      raw = await t.chat({
        model: useModel,
        format: 'json',
        messages,
      });
      onProgress?.({ message: 'Advisor: response received' });
    }
    const content = raw?.message?.content ?? raw?.response ?? raw?.content;
    const parsed = parseJsonContent(content);
    const validated = validateAdvice(parsed, { invariants });
    if (!validated.ok) {
      onProgress?.({ message: 'Advisor: response rejected by validator' });
      return { status: 'rejected', error: validated.errors?.join('; '), advice: null, warnings: validated.errors };
    }
    return {
      status: 'ok',
      advice: validated.advice,
      warnings: validated.warnings,
      model: useModel,
      transport: t.kind,
      input: {
        systemPromptId: SYSTEM_PROMPT_ID,
        systemPromptVersion: SYSTEM_PROMPT_VERSION,
        payload,
      },
    };
  } catch (e) {
    onProgress?.({ message: `Advisor error: ${String(e?.message ?? e)}` });
    return { status: 'error', error: String(e?.message ?? e), advice: null };
  }
}

export {
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_ID,
  SYSTEM_PROMPT_VERSION,
};
