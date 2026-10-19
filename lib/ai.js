// Универсальный клиент: любой OpenAI-совместимый эндпоинт или Anthropic Messages API.
import { BRIDGE } from './providers.js';

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const isBridge = (url) => String(url || '').startsWith(BRIDGE);

// Куда реально уходит запрос: напрямую или через мост (/forward + адрес провайдера в заголовке)
const bridgeHeaders = (cfg) => ({ 'x-tubecomment': '1', 'x-tubecomment-token': cfg.bridgeToken || '' });

function route(cfg, path) {
  const base = trimSlash(cfg.baseUrl);
  if (cfg.viaBridge && !isBridge(base)) return { url: BRIDGE + '/forward' + path, extra: { ...bridgeHeaders(cfg), 'x-tc-target': base } };
  return { url: base + path, extra: isBridge(base) ? bridgeHeaders(cfg) : {} };
}

export async function bridgePing(cfg) {
  const r = await fetch(BRIDGE + '/ping', { headers: bridgeHeaders(cfg), signal: AbortSignal.timeout(3000) });
  if (r.status === 401) throw Object.assign(new Error('Неверный токен моста'), { code: 'BAD_TOKEN' });
  if (!r.ok) throw new Error('Мост ответил ' + r.status);
  return r.json();
}

export function originPattern(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

// Разрешение на домен модели. Вызывать только из клика пользователя (из панели).
export async function ensureHostPermission(baseUrl, viaBridge = false) {
  const origins = [originPattern(baseUrl)];
  if (viaBridge) origins.push(originPattern(BRIDGE));
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
  const temperature = opts.temperature ?? cfg.temperature ?? 0.7;
  const max_tokens = opts.maxTokens ?? 600;
  if (cfg.format === 'anthropic') {
    return { ...route(cfg, '/messages'), body: { model: cfg.model, max_tokens, temperature, system: system || undefined, messages } };
  }
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  return { ...route(cfg, '/chat/completions'), body: { model: cfg.model, messages: msgs, temperature, max_tokens } };
}

function parseResponse(format, j) {
  if (format === 'anthropic') return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return j.choices?.[0]?.message?.content ?? '';
}

export async function chat(cfg, { system, messages, ...opts }) {
  if (!cfg.baseUrl) throw new Error('Модель не настроена: укажите адрес API на вкладке «Модель»');
  if (!cfg.model) throw new Error('Модель не настроена: укажите название модели на вкладке «Модель»');
  const req = buildRequest(cfg, system, messages, opts);
  // CLI-агенту через мост нужно больше времени, облачному API — меньше
  const timeout = AbortSignal.timeout(isBridge(req.url) ? 200_000 : 90_000);
  let res;
  try {
    res = await fetch(req.url, { method: 'POST', headers: { ...headersFor(cfg), ...req.extra }, body: JSON.stringify(req.body), signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error('Модель не ответила вовремя — попробуйте ещё раз или выберите модель быстрее');
    if (isBridge(req.url)) throw new Error('Мост TubeComment не запущен. Запустите bridge/start-bridge.bat (или node bridge/tubecomment-bridge.mjs) и повторите.');
    throw new Error(`Нет связи с ${new URL(req.url).host}. Проверьте адрес и нажмите «Сохранить» на вкладке «Модель», чтобы выдать доступ к домену. (${e.message})`);
  }
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* не JSON */ }
  if (res.status === 401 && isBridge(req.url)) throw new Error('Мост отклонил запрос: вставьте токен моста на вкладке «Модель»');
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
  const r = route(cfg, '/models');
  const res = await fetch(r.url, { headers: { ...headersFor(cfg), ...r.extra } });
  if (!res.ok) throw new Error('Не удалось получить список моделей: HTTP ' + res.status);
  const j = await res.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}
