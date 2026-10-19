// Универсальный клиент: любой OpenAI-совместимый эндпоинт или Anthropic Messages API.

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

export function originPattern(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

// Разрешение на домен модели. Вызывать только из клика пользователя (из панели).
export async function ensureHostPermission(baseUrl) {
  const origins = [originPattern(baseUrl)];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

function headersFor(cfg) {
  if (cfg.format === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
  const h = { 'content-type': 'application/json' };
  if (cfg.apiKey) h.authorization = 'Bearer ' + cfg.apiKey;
  if (cfg.baseUrl.includes('openrouter.ai')) {
    h['HTTP-Referer'] = 'https://github.com/Karo-Taro/tubecomment';
    h['X-Title'] = 'TubeComment';
  }
  return h;
}

function buildRequest(cfg, system, messages, opts) {
  const base = trimSlash(cfg.baseUrl);
  const temperature = opts.temperature ?? cfg.temperature ?? 0.7;
  const max_tokens = opts.maxTokens ?? 600;
  if (cfg.format === 'anthropic') {
    return { url: base + '/messages', body: { model: cfg.model, max_tokens, temperature, system: system || undefined, messages } };
  }
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  return { url: base + '/chat/completions', body: { model: cfg.model, messages: msgs, temperature, max_tokens } };
}

function parseResponse(format, j) {
  if (format === 'anthropic') return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return j.choices?.[0]?.message?.content ?? '';
}

export async function chat(cfg, { system, messages, ...opts }) {
  if (!cfg.baseUrl) throw new Error('Модель не настроена: укажите адрес API на вкладке «Модель»');
  if (!cfg.model) throw new Error('Модель не настроена: укажите название модели на вкладке «Модель»');
  const req = buildRequest(cfg, system, messages, opts);
  let res;
  try {
    res = await fetch(req.url, { method: 'POST', headers: headersFor(cfg), body: JSON.stringify(req.body), signal: opts.signal });
  } catch (e) {
    throw new Error(`Нет связи с ${new URL(req.url).host}. Проверьте адрес и нажмите «Сохранить» на вкладке «Модель», чтобы выдать доступ к домену. (${e.message})`);
  }
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* не JSON */ }
  if (!res.ok) {
    const msg = j?.error?.message || j?.error || j?.message || text.slice(0, 300);
    throw new Error(`Модель ответила ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return parseResponse(cfg.format, j || {}).trim();
}

// Достаёт JSON из ответа модели (с ```json``` или без)
export function extractJSON(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(src.slice(start, end + 1)); } catch { return null; }
}

export async function listModels(cfg) {
  const base = trimSlash(cfg.baseUrl);
  const res = await fetch(base + '/models', { headers: headersFor(cfg) });
  if (!res.ok) throw new Error('Не удалось получить список моделей: HTTP ' + res.status);
  const j = await res.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}
