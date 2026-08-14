/**
 * Ollama HTTP client for Electron main process.
 * Models stay on disk via Ollama — never bundle weights in this repo.
 */

const DEFAULT_HOST = 'http://127.0.0.1:11434';

export function ollamaHost() {
  return process.env.OLLAMA_HOST || DEFAULT_HOST;
}

export async function ollamaPing(host = ollamaHost()) {
  try {
    const res = await fetch(`${host}/api/tags`, { method: 'GET' });
    return { ok: res.ok, status: res.status, host };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), host };
  }
}

/**
 * Non-streaming /api/chat — returns Ollama JSON body.
 */
export async function ollamaChat({ model, messages, format = 'json', host = ollamaHost() }) {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Streaming /api/chat — NDJSON tokens. Calls onToken(accumulatedContent).
 * Returns a final chat-shaped object with full message.content.
 */
export async function ollamaChatStream({
  model,
  messages,
  format = 'json',
  host = ollamaHost(),
  onToken,
}) {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      format,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.body?.getReader) {
    return ollamaChat({ model, messages, format, host });
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
      /* ignore */
    }
  }
  if (last?.message) {
    return { ...last, message: { ...last.message, content: content || last.message.content } };
  }
  return { message: { role: 'assistant', content } };
}
