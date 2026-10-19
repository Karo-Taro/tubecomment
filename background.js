// Фоновый service worker: расписание проверок, автоотправка и обработка команд из панели и со страниц YouTube.
import * as store from './lib/storage.js';
import * as engine from './lib/engine.js';
import { listModels, bridgePing } from './lib/ai.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function syncAlarms() {
  const s = await store.getSettings();
  await chrome.alarms.clearAll();
  if (s.mode !== 'off') chrome.alarms.create('check', { periodInMinutes: Math.max(5, +s.schedule.intervalMin || 15), delayInMinutes: 1 });
  if (s.mode === 'auto') chrome.alarms.create('tick', { periodInMinutes: 1 });
}

// Если браузер закрылся посреди работы — возвращаем «зависшие» элементы
async function recover() {
  const q = await store.getQueue();
  const stuck = Object.values(q).filter((i) => i.status === 'drafting' || i.status === 'sending');
  if (stuck.length) await store.putItems(stuck.map((i) => ({ id: i.id, status: i.draft ? 'ready' : 'error', error: i.draft ? '' : 'Черновик не дописан — нажмите «Переписать»' })));
  await store.setStatus({ checking: false });
  await engine.refreshBadge();
}

chrome.runtime.onInstalled.addListener(() => { syncAlarms(); recover(); });
chrome.runtime.onStartup.addListener(() => { syncAlarms(); recover(); });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'check') engine.check().catch(() => {});
  if (a.name === 'tick') engine.tick().catch(() => {});
});

const handlers = {
  async check() {
    return engine.check();
  },
  async draft({ id, hint }) {
    return engine.draftItem(id, null, { hint });
  },
  async send({ id, text }) {
    return engine.send(id, text);
  },
  async skip({ id }) {
    return engine.skip(id);
  },
  async saveDraft({ id, text }) {
    return store.updateItem(id, { draft: text });
  },
  async setMode({ mode }) {
    await store.saveSettings({ mode });
    if (mode === 'auto') await engine.scheduleReady();
    else await engine.unscheduleAll();
    await syncAlarms();
    if (mode !== 'off') engine.check().catch(() => {});
    return mode;
  },
  async saveSettings({ patch }) {
    const s = await store.saveSettings(patch);
    if (patch.schedule) await syncAlarms();
    return s;
  },
  // Кнопка ✦ на youtube.com: черновик для конкретного комментария, без очереди
  // channelHandle — автор видео со страницы, чтобы ответить голосом нужного канала
  async compose({ comment, author, videoTitle, parentText, channelHandle }) {
    const settings = await store.getSettings();
    const h = String(channelHandle || '').toLowerCase();
    const channel = settings.channels.find((c) => h && c.handle?.toLowerCase() === h) || null;
    const r = await engine.compose(settings, { text: comment, author, videoTitle, parentText }, { allowSkip: false, channel });
    return r.reply;
  },
  async testModel() {
    const settings = await store.getSettings();
    const r = await engine.compose(settings, {
      videoTitle: 'Как я собрал ПК за 50 000 ₽',
      author: '@viewer',
      text: 'А какой блок питания брал? Хватит его под апгрейд видеокарты?',
    }, { allowSkip: false });
    return r.reply;
  },
  async listModels({ cfg }) {
    return listModels(cfg);
  },
  async bridgePing() {
    return bridgePing();
  },
  async discoverChannels() {
    return engine.discoverChannels();
  },
  // включить/выключить канал, задать ему голос
  async updateChannel({ id, patch }) {
    const s = await store.getSettings();
    const allowed = ['enabled', 'persona', 'examples', 'signature'];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    return store.saveSettings({ channels: s.channels.map((c) => (c.id === id ? { ...c, ...clean } : c)) });
  },
  async clearLog() {
    await chrome.storage.local.set({ log: [] });
  },
  async clearQueue() {
    await chrome.storage.local.set({ queue: {} });
    await engine.refreshBadge();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  h(msg).then((data) => reply({ ok: true, data }), (e) => reply({ ok: false, error: e.message, code: e.code }));
  return true;
});
