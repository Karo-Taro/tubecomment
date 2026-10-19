// Всё состояние расширения живёт в chrome.storage.local — на вашем компьютере, никуда не отправляется.

export const DEFAULTS = {
  // off — только ручная проверка; drafts — сам проверяет и пишет черновики; auto — ещё и отправляет
  mode: 'off',
  ai: {
    preset: 'openai',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    viaBridge: false, // слать запросы к провайдеру через мост TubeComment (и его прокси)
    bridgeToken: '', // токен моста из его окна или bridge.json
  },
  voice: {
    persona: '',
    tone: ['friendly'],
    language: 'auto', // auto — на языке комментатора
    maxChars: 280,
    emoji: true,
    signature: '',
    examples: '',
    avoid: '',
  },
  rules: {
    videos: 5,
    includeShorts: true,
    maxAgeDays: 7,
    onlyQuestions: false,
    skipLinks: true,
    minLength: 3,
    stopWords: '',
    blockAuthors: '',
    skipReplied: true,
    letModelSkip: true,
  },
  schedule: {
    intervalMin: 15,
    dailyLimit: 30,
    delayMin: 30, // секунды между автоотправками
    delayMax: 120,
  },
  // Каналы из вашей сессии на youtube.com (вкладка «Каналы»):
  // { id, handle, title, avatar, authUser, pageId, enabled, persona, examples, signature }
  // persona/examples/signature канала заменяют общие настройки голоса, если заполнены
  channels: [],
};

// Голос конкретного канала: общие настройки + то, что задано у канала
export function voiceFor(settings, channel) {
  const v = { ...settings.voice };
  for (const k of ['persona', 'examples', 'signature']) if (channel?.[k]?.trim()) v[k] = channel[k];
  return v;
}

// Заголовки, от имени какого канала идут запросы к YouTube
export const identOf = (ch) => (ch?.current ? null : { authUser: ch?.authUser ?? 0, pageId: ch?.pageId || '' });

// Записи идут строго по очереди: фоновая проверка и клики в панели не затирают друг друга
let chain = Promise.resolve();
const locked = (fn) => (...args) => {
  const p = chain.then(() => fn(...args));
  chain = p.catch(() => {});
  return p;
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  if (!isObj(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(base[k]) && isObj(v) ? merge(base[k], v) : v;
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return merge(DEFAULTS, settings);
}

// patch — частичный объект: { ai: { model: 'x' } } меняет только модель
export const saveSettings = locked(async (patch) => {
  const cur = await getSettings();
  const next = merge(cur, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
});

// Правка на основе текущих настроек целиком под блокировкой: fn(settings) → patch
export const updateSettings = locked(async (fn) => {
  const cur = await getSettings();
  const next = merge(cur, fn(cur));
  await chrome.storage.local.set({ settings: next });
  return next;
});

// Очистка ключей (журнал, очередь) — тоже по очереди с остальными записями
export const resetKeys = locked(async (values) => {
  await chrome.storage.local.set(values);
});

// ---- очередь ----
// item: { id, videoId, videoTitle, author, authorId, avatar, text, published, likes,
//         replyParams, draft, status, error, reason, createdAt, sendAt }
// status: new → drafting → ready (черновик есть) → scheduled (ждёт автоотправки) → sending → sent | skipped | error

export async function getQueue() {
  const { queue } = await chrome.storage.local.get('queue');
  return queue || {};
}

export const putItems = locked(async (items) => {
  const queue = await getQueue();
  for (const it of items) queue[it.id] = { ...queue[it.id], ...it };
  await chrome.storage.local.set({ queue });
  return queue;
});

export const updateItem = locked(async (id, patch) => {
  const queue = await getQueue();
  if (!queue[id]) return null;
  queue[id] = { ...queue[id], ...patch };
  await chrome.storage.local.set({ queue });
  return queue[id];
});

// Захват перед отправкой: только один отправитель может перевести элемент в «sending».
// Повторный клик, автоотправка и смена режима во время отправки второй ответ не создадут.
const SENDABLE = ['ready', 'scheduled', 'error'];
export const claimForSend = locked(async (id, draft) => {
  const queue = await getQueue();
  const it = queue[id];
  if (!it) throw new Error('Комментарий уже убран из очереди');
  if (!SENDABLE.includes(it.status)) throw new Error(it.status === 'sending' ? 'Ответ уже отправляется' : 'Ответ сейчас нельзя отправить');
  queue[id] = { ...it, status: 'sending', draft, error: '' };
  await chrome.storage.local.set({ queue });
  return queue[id];
});

// Автоотправка: случайная пауза после последнего запланированного ответа (расчёт под блокировкой)
export const scheduleItem = locked(async (id, delayMs) => {
  const queue = await getQueue();
  if (!queue[id]) return null;
  const last = Math.max(Date.now(), ...Object.values(queue).filter((i) => i.status === 'scheduled').map((i) => i.sendAt || 0));
  queue[id] = { ...queue[id], status: 'scheduled', sendAt: last + delayMs };
  await chrome.storage.local.set({ queue });
  return queue[id];
});

// Отправленные и пропущенные уезжают из очереди в журнал
export const archiveItem = locked(async (id, patch) => {
  const queue = await getQueue();
  const it = queue[id];
  if (!it) return null;
  delete queue[id];
  const entry = { ...it, ...patch, doneAt: Date.now() };
  delete entry.replyParams;
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift(entry);
  await chrome.storage.local.set({ queue, log: log.slice(0, 500) });
  return entry;
});

export async function getLog() {
  const { log } = await chrome.storage.local.get('log');
  return log || [];
}

// ---- что уже видели (чтобы не предлагать один комментарий дважды) ----
export async function getSeen() {
  const { seen } = await chrome.storage.local.get('seen');
  return seen || {};
}

export const markSeen = locked(async (ids) => {
  const seen = await getSeen();
  const now = Date.now();
  for (const id of ids) seen[id] = now;
  // дольше максимального «не старше» в правилах (365 дней), чтобы старые комментарии не вернулись
  const cutoff = now - 400 * 86400e3;
  for (const [id, t] of Object.entries(seen)) if (t < cutoff) delete seen[id];
  await chrome.storage.local.set({ seen });
});

// ---- счётчик за сегодня: всего и по каналам (лимит действует на каждый канал отдельно) ----
const today = () => new Date().toLocaleDateString('sv');

export async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  return stats?.date === today() && stats.byChannel ? stats : { date: today(), sent: 0, byChannel: {} };
}

export const bumpSent = locked(async (channelId) => {
  const s = await getStats();
  s.sent += 1;
  s.byChannel[channelId] = (s.byChannel[channelId] || 0) + 1;
  await chrome.storage.local.set({ stats: s });
  return s;
});

export const setStatus = locked(async (patch) => {
  const { status } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch } });
});
