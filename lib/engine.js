// Движок автоответчика: найти новые комментарии → отфильтровать → написать черновик → (в режиме «Авто») отправить.
import * as store from './storage.js';
import * as yt from './youtube.js';
import { chat, extractJSON } from './ai.js';
import { buildSystem, buildUser, clampReply } from './prompt.js';

const MAX_DRAFTS_PER_CHECK = 20;
const rand = (a, b) => Math.round(a + Math.random() * Math.max(0, b - a));
const list = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);

// Почему комментарий не берём (или null, если берём)
export function prefilter(c, rules, me) {
  if (c.isCreator || c.isMine || (me && c.authorId === me.id)) return 'ваш комментарий';
  if (!c.replyParams) return 'нет кнопки «Ответить»';
  if (rules.maxAgeDays && yt.ageHours(c.published) > rules.maxAgeDays * 24) return 'старый';
  const t = c.text.trim();
  if (t.length < (rules.minLength || 0)) return 'слишком короткий';
  if (rules.skipLinks && /https?:\/\/|www\.|\.(com|ru|net|io)\b/i.test(t)) return 'со ссылкой';
  if (rules.onlyQuestions && !t.includes('?')) return 'не вопрос';
  const low = t.toLowerCase();
  const stop = list(rules.stopWords).find((w) => low.includes(w));
  if (stop) return `стоп-слово «${stop}»`;
  const blocked = list(rules.blockAuthors);
  if (blocked.includes(c.author.toLowerCase()) || blocked.includes(c.authorId.toLowerCase())) return 'автор в чёрном списке';
  return null;
}

const channelOf = (settings, id) => settings.channels.find((c) => c.id === id) || null;

// Chrome усыпляет service worker через ~30 с без событий расширения, даже если идёт fetch.
// Пока работа не закончена (CLI-агент может думать минуты), «пингуем» API раз в 20 с.
async function keepAlive(fn) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  try { return await fn(); } finally { clearInterval(timer); }
}

// Что в ответе модели не должно уходить без человека: ссылки, упоминания, остатки JSON
export function riskyReply(text) {
  if (/https?:\/\/|www\.|\b[\w-]+\.(com|ru|net|org|io|me|ly|gg|to|su|xyz)\b/i.test(text)) return 'в ответе есть ссылка';
  if (/(^|\s)@[\w.-]+/.test(text)) return 'в ответе есть упоминание';
  if (/[{}]/.test(text)) return 'модель ответила в неожиданном формате';
  return '';
}

// Черновик ответа: { reply } или { skip, reason }. channel — чьим голосом отвечать.
export async function compose(settings, input, { allowSkip = settings.rules.letModelSkip, channel = null } = {}) {
  const system = buildSystem(store.voiceFor(settings, channel), settings.rules, channel, { allowSkip });
  const raw = await chat(settings.ai, { system, messages: [{ role: 'user', content: buildUser(input) }] });
  if (allowSkip) {
    const j = extractJSON(raw);
    if (j?.skip) return { skip: true, reason: String(j.reason || 'модель решила не отвечать') };
    if (j?.reply) return { reply: clampReply(j.reply, settings.voice.maxChars) };
  }
  // модель вернула просто текст — годится для черновика, но сама такой ответ не уйдёт (unparsed)
  return { reply: clampReply(raw.replace(/^\{[\s\S]*"reply"\s*:\s*"|"\s*\}$/g, ''), settings.voice.maxChars), unparsed: allowSkip };
}

let checking = null;

// Одна проверка всех включённых каналов. Повторный вызов во время проверки ждёт ту же проверку.
export function check() {
  checking ??= keepAlive(runCheck).finally(() => { checking = null; });
  return checking;
}

async function runCheck() {
  const settings = await store.getSettings();
  const channels = settings.channels.filter((c) => c.enabled);
  await store.setStatus({ checking: true, error: '' });
  try {
    if (!channels.length) {
      throw Object.assign(new Error('Нет включённых каналов — найдите и включите их на вкладке «Каналы»'), { code: 'NO_CHANNELS' });
    }
    const seen = await store.getSeen();
    const queue = await store.getQueue();
    const found = [];
    const errors = [];
    let filtered = 0;

    await yt.withYouTube(async (raw) => {
      for (const ch of channels) {
        const ident = store.identOf(ch);
        const call = (e, b) => raw(e, b, ident);
        try {
          const videos = await yt.recentVideos(call, ch.id, { max: settings.rules.videos, shorts: settings.rules.includeShorts });
          for (const v of videos) {
            const { title, description, comments } = await yt.videoComments(call, v.id, { max: 60 });
            for (const c of comments) {
              if (seen[c.id] || queue[c.id]) continue;
              const why = prefilter(c, settings.rules, ch);
              if (why) { filtered++; seen[c.id] = 1; continue; }
              if (settings.rules.skipReplied && c.replyCount > 0 && await yt.ownerReplied(call, c.repliesToken, ch.id)) {
                filtered++; seen[c.id] = 1; continue;
              }
              found.push({ ...c, channelId: ch.id, videoId: v.id, videoTitle: title || v.title, videoDescription: description, short: !!v.short });
            }
          }
        } catch (e) {
          // вход потерян — дальше проверять бессмысленно; иначе ошибка одного канала не мешает остальным
          if (e.code === 'NOT_LOGGED_IN') throw e;
          errors.push(`${ch.handle || ch.title}: ${e.message}`);
        }
      }
    });
    await store.markSeen(Object.keys(seen).filter((id) => seen[id] === 1));

    // сначала свежие, черновиков за раз — не больше лимита (экономим токены)
    found.sort((a, b) => yt.ageHours(a.published) - yt.ageHours(b.published));
    const take = found.slice(0, MAX_DRAFTS_PER_CHECK);
    await store.putItems(take.map((c) => toItem(c, 'new')));
    await store.markSeen(take.map((c) => c.id));

    let drafted = 0;
    for (const c of take) {
      if (await draftItem(c.id, settings)) drafted++;
    }
    await store.setStatus({ checking: false, lastCheck: Date.now(), found: take.length, filtered, drafted, error: errors.join(' · ') });
    await refreshBadge();
    return { found: take.length, filtered, drafted };
  } catch (e) {
    await store.setStatus({ checking: false, lastCheck: Date.now(), error: e.message, errorCode: e.code || '' });
    throw e;
  }
}

function toItem(c, status) {
  return {
    id: c.id,
    channelId: c.channelId,
    videoId: c.videoId,
    videoTitle: c.videoTitle,
    videoDescription: (c.videoDescription || '').slice(0, 600),
    short: c.short,
    author: c.author,
    authorId: c.authorId,
    avatar: c.avatar,
    text: c.text,
    published: c.published,
    likes: c.likes,
    replyParams: c.replyParams,
    draft: '',
    status,
    createdAt: Date.now(),
  };
}

// Пишет (или переписывает) черновик для элемента очереди
export function draftItem(id, settings, opts) {
  return keepAlive(() => runDraft(id, settings, opts));
}

async function runDraft(id, settings, { hint = '' } = {}) {
  settings ??= await store.getSettings();
  const item = (await store.getQueue())[id];
  if (!item) return false;
  await store.updateItem(id, { status: 'drafting', error: '' });
  try {
    const r = await compose(settings, {
      videoTitle: item.videoTitle,
      videoDescription: item.videoDescription,
      author: item.author,
      text: item.text + (hint ? `\n\n(Пожелание автора к ответу: ${hint})` : ''),
    }, { allowSkip: hint ? false : settings.rules.letModelSkip, channel: channelOf(settings, item.channelId) });
    if (r.skip) {
      // в режиме «Авто» пропускаем молча, иначе оставляем решение человеку
      if (settings.mode === 'auto') await store.archiveItem(id, { status: 'skipped', reason: r.reason });
      else await store.updateItem(id, { status: 'ready', draft: '', reason: r.reason, suggestSkip: true });
      return true;
    }
    // в «Авто» подозрительный ответ остаётся на ручную проверку
    const review = r.unparsed ? 'модель ответила в неожиданном формате' : riskyReply(r.reply);
    await store.updateItem(id, { status: 'ready', draft: r.reply, reason: '', suggestSkip: false, review });
    if (settings.mode === 'auto' && !review) await schedule(id, settings);
    return true;
  } catch (e) {
    await store.updateItem(id, { status: 'error', error: e.message });
    return false;
  }
}

// Ставит ответ в очередь автоотправки со случайной задержкой после последнего запланированного
async function schedule(id, settings) {
  await store.scheduleItem(id, rand(settings.schedule.delayMin, settings.schedule.delayMax) * 1000);
}

export function send(id, textOverride) {
  return keepAlive(() => runSend(id, textOverride));
}

async function runSend(id, textOverride) {
  const item = (await store.getQueue())[id];
  if (!item) throw new Error('Комментарий уже убран из очереди');
  const replyText = (textOverride ?? item.draft ?? '').trim();
  if (!replyText) throw new Error('Пустой ответ — напишите текст или нажмите «Переписать»');
  const channel = channelOf(await store.getSettings(), item.channelId);
  if (!channel) throw new Error('Канал этого комментария удалён из списка — найдите каналы заново на вкладке «Каналы»');
  await store.claimForSend(id, replyText); // бросит ошибку, если ответ уже отправляется
  try {
    const ident = store.identOf(channel);
    const r = await yt.withYouTube(async (raw) => {
      const call = (e, b) => raw(e, b, ident);
      // номера Google-аккаунтов сдвигаются, если выйти из одного из них: проверяем, от кого уйдёт ответ
      const me = await yt.whoAmI(call);
      if (me.id !== channel.id) {
        throw new Error(`Сейчас запрос шёл бы от ${me.handle || me.title}, а не от ${channel.handle || channel.title}. Аккаунты в браузере поменялись — нажмите «Обновить список» на вкладке «Каналы»`);
      }
      return yt.postReply(call, item.replyParams, replyText);
    });
    await store.archiveItem(id, { status: 'sent', draft: replyText, replyId: r.replyId });
    await store.bumpSent(item.channelId);
    await refreshBadge();
    return r;
  } catch (e) {
    await store.updateItem(id, { status: 'error', error: e.message });
    throw e;
  }
}

export async function skip(id) {
  const item = (await store.getQueue())[id];
  await store.archiveItem(id, { status: 'skipped', reason: item?.suggestSkip && item.reason ? item.reason : 'пропущен вручную' });
  await refreshBadge();
}

// Раз в 30 секунд: отправить один созревший ответ (режим «Авто»)
export async function tick() {
  const settings = await store.getSettings();
  if (settings.mode !== 'auto') return;
  const stats = await store.getStats();
  const underLimit = (i) => (stats.byChannel[i.channelId] || 0) < settings.schedule.dailyLimit;
  const scheduled = Object.values(await store.getQueue()).filter((i) => i.status === 'scheduled');
  const due = scheduled.filter((i) => i.sendAt <= Date.now() && underLimit(i)).sort((a, b) => a.sendAt - b.sendAt)[0];
  // все ожидающие упёрлись в дневной лимит своих каналов
  await store.setStatus({ limitReached: scheduled.length > 0 && !scheduled.some(underLimit) });
  if (due) await send(due.id).catch(() => {});
}

// При выключении «Авто» запланированное возвращается на ручное одобрение
// (то, что уже отправляется, не трогаем — иначе можно отправить второй раз)
export async function unscheduleAll() {
  const queue = await store.getQueue();
  const items = Object.values(queue).filter((i) => i.status === 'scheduled');
  await store.putItems(items.map((i) => ({ id: i.id, status: 'ready', sendAt: 0 })));
}

export async function scheduleReady() {
  const settings = await store.getSettings();
  for (const i of Object.values(await store.getQueue())) if (i.status === 'ready' && i.draft && !i.review) await schedule(i.id, settings);
}

export async function refreshBadge() {
  const queue = await store.getQueue();
  const n = Object.values(queue).filter((i) => i.status !== 'scheduled').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#E5322D' });
  await chrome.action.setBadgeText({ text: n ? String(n > 99 ? '99+' : n) : '' });
}

// Найти все каналы в сессии youtube.com и слить со списком: включённость и голос уже известных сохраняются
export async function discoverChannels() {
  const fresh = await keepAlive(() => yt.withYouTube((call) => yt.listChannels(call)));
  // слияние — под блокировкой: переключатели и голос, изменённые за время поиска, не потеряются
  const next = await store.updateSettings((settings) => {
    const known = new Map(settings.channels.map((c) => [c.id, c]));
    const first = !settings.channels.length;
    const channels = fresh.map((c) => {
      const old = known.get(c.id);
      return { persona: '', examples: '', signature: '', ...old, ...c, lost: false, enabled: old ? old.enabled : first && fresh.length === 1 };
    });
    // каналы, к которым пропал доступ, оставляем выключенными — вдруг вход вернётся
    for (const old of settings.channels) if (!channels.some((c) => c.id === old.id)) channels.push({ ...old, enabled: false, lost: true });
    return { channels };
  });
  return next.channels;
}
