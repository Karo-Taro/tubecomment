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

// Черновик ответа: { reply } или { skip, reason }
export async function compose(settings, input, { allowSkip = settings.rules.letModelSkip } = {}) {
  const system = buildSystem(settings.voice, settings.rules, settings.channel, { allowSkip });
  const raw = await chat(settings.ai, { system, messages: [{ role: 'user', content: buildUser(input) }] });
  if (allowSkip) {
    const j = extractJSON(raw);
    if (j?.skip) return { skip: true, reason: String(j.reason || 'модель решила не отвечать') };
    if (j?.reply) return { reply: clampReply(j.reply, settings.voice.maxChars) };
  }
  // модель вернула просто текст — тоже годится
  return { reply: clampReply(raw.replace(/^\{[\s\S]*"reply"\s*:\s*"|"\s*\}$/g, ''), settings.voice.maxChars) };
}

let checking = null;

// Одна проверка канала. Повторный вызов во время проверки ждёт ту же проверку.
export function check() {
  checking ??= runCheck().finally(() => { checking = null; });
  return checking;
}

async function runCheck() {
  const settings = await store.getSettings();
  await store.setStatus({ checking: true, error: '' });
  try {
    const seen = await store.getSeen();
    const queue = await store.getQueue();
    const found = [];
    let filtered = 0;

    const me = await yt.withYouTube(async (call) => {
      const me = await yt.whoAmI(call);
      const videos = await yt.recentVideos(call, me.id, { max: settings.rules.videos, shorts: settings.rules.includeShorts });
      for (const v of videos) {
        const { title, description, comments } = await yt.videoComments(call, v.id, { max: 60 });
        for (const c of comments) {
          if (seen[c.id] || queue[c.id]) continue;
          const why = prefilter(c, settings.rules, me);
          if (why) { filtered++; seen[c.id] = 1; continue; }
          if (settings.rules.skipReplied && c.replyCount > 0 && await yt.ownerReplied(call, c.repliesToken, me.id)) {
            filtered++; seen[c.id] = 1; continue;
          }
          found.push({ ...c, videoId: v.id, videoTitle: title || v.title, videoDescription: description, short: !!v.short });
        }
      }
      return me;
    });

    if (JSON.stringify(me) !== JSON.stringify(settings.channel)) await store.saveSettings({ channel: me });
    settings.channel = me;
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
    await store.setStatus({ checking: false, lastCheck: Date.now(), found: take.length, filtered, drafted, error: '' });
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
export async function draftItem(id, settings, { hint = '' } = {}) {
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
    }, { allowSkip: hint ? false : settings.rules.letModelSkip });
    if (r.skip) {
      // в режиме «Авто» пропускаем молча, иначе оставляем решение человеку
      if (settings.mode === 'auto') await store.archiveItem(id, { status: 'skipped', reason: r.reason });
      else await store.updateItem(id, { status: 'ready', draft: '', reason: r.reason, suggestSkip: true });
      return true;
    }
    await store.updateItem(id, { status: 'ready', draft: r.reply, reason: '', suggestSkip: false });
    if (settings.mode === 'auto') await schedule(id, settings);
    return true;
  } catch (e) {
    await store.updateItem(id, { status: 'error', error: e.message });
    return false;
  }
}

// Ставит ответ в очередь автоотправки со случайной задержкой после последнего запланированного
async function schedule(id, settings) {
  const queue = await store.getQueue();
  const last = Math.max(Date.now(), ...Object.values(queue).filter((i) => i.status === 'scheduled').map((i) => i.sendAt || 0));
  await store.updateItem(id, { status: 'scheduled', sendAt: last + rand(settings.schedule.delayMin, settings.schedule.delayMax) * 1000 });
}

export async function send(id, textOverride) {
  const item = (await store.getQueue())[id];
  if (!item) throw new Error('Комментарий уже убран из очереди');
  const replyText = (textOverride ?? item.draft ?? '').trim();
  if (!replyText) throw new Error('Пустой ответ — напишите текст или нажмите «Переписать»');
  await store.updateItem(id, { status: 'sending', draft: replyText, error: '' });
  try {
    const r = await yt.withYouTube((call) => yt.postReply(call, item.replyParams, replyText));
    await store.archiveItem(id, { status: 'sent', draft: replyText, replyId: r.replyId });
    await store.bumpSent();
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

// Раз в минуту: отправить один созревший ответ (режим «Авто»)
export async function tick() {
  const settings = await store.getSettings();
  if (settings.mode !== 'auto') return;
  const stats = await store.getStats();
  if (stats.sent >= settings.schedule.dailyLimit) {
    await store.setStatus({ limitReached: true });
    return;
  }
  await store.setStatus({ limitReached: false });
  const due = Object.values(await store.getQueue())
    .filter((i) => i.status === 'scheduled' && i.sendAt <= Date.now())
    .sort((a, b) => a.sendAt - b.sendAt)[0];
  if (due) await send(due.id).catch(() => {});
}

// При выключении «Авто» запланированное возвращается на ручное одобрение
export async function unscheduleAll() {
  const queue = await store.getQueue();
  const items = Object.values(queue).filter((i) => i.status === 'scheduled' || i.status === 'sending');
  await store.putItems(items.map((i) => ({ id: i.id, status: 'ready', sendAt: 0 })));
}

export async function scheduleReady() {
  const settings = await store.getSettings();
  for (const i of Object.values(await store.getQueue())) if (i.status === 'ready' && i.draft) await schedule(i.id, settings);
}

export async function refreshBadge() {
  const queue = await store.getQueue();
  const n = Object.values(queue).filter((i) => i.status !== 'scheduled').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#E5322D' });
  await chrome.action.setBadgeText({ text: n ? String(n > 99 ? '99+' : n) : '' });
}
