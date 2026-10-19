import { PROVIDERS, providerById } from '../lib/providers.js';
import { TONES } from '../lib/prompt.js';
import { ensureHostPermission } from '../lib/ai.js';
import { DEFAULTS } from '../lib/storage.js';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const S = { settings: null, queue: {}, log: [], stats: { sent: 0, byChannel: {} }, status: {}, tab: 'queue', logFilter: 'all', queueFilter: 'all' };

// ---------- утилиты ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

async function cmd(type, payload = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...payload });
  if (!r) throw new Error('Фоновый процесс не ответил. Перезагрузите расширение');
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
  return r.data;
}

let toastTimer;
function toast(text, isError = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2800);
}

// Кнопка с состоянием «идёт работа»
async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = old; }
}

const pad2 = (n) => String(Math.min(99, Math.max(0, n | 0))).padStart(2, '0');
const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '--:--');
const commentUrl = (it) => `https://www.youtube.com/${it.short ? 'shorts/' + it.videoId + '?' : 'watch?v=' + it.videoId + '&'}lc=${it.id}`;
const agoRu = (s) => {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(s || '');
  if (!m) return s || '';
  const u = { second: 'с', minute: 'мин', hour: 'ч', day: 'д', week: 'нед', month: 'мес', year: 'г' }[m[2].toLowerCase()];
  return `${m[1]} ${u} назад`;
};
const plural = (n, [one, few, many]) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const channelById = (id) => S.settings.channels.find((c) => c.id === id);
const enabledChannels = () => S.settings.channels.filter((c) => c.enabled);
const modelReady = (s) => !!(s.ai.baseUrl && s.ai.model && (s.ai.apiKey || providerById(s.ai.preset).local || s.ai.preset === 'custom'));

// ---------- данные ----------
async function load() {
  const d = await chrome.storage.local.get(['settings', 'queue', 'log', 'stats', 'status']);
  S.settings = mergeDefaults(d.settings);
  S.queue = d.queue || {};
  S.log = d.log || [];
  const today = new Date().toLocaleDateString('sv');
  S.stats = d.stats?.date === today && d.stats.byChannel ? d.stats : { sent: 0, byChannel: {} };
  S.status = d.status || {};
}

function mergeDefaults(s) {
  const out = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(s || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] ? { ...out[k], ...v } : v;
  return out;
}

// ---------- шапка ----------
async function renderHeader() {
  const { settings: s, status: st, stats } = S;
  const items = Object.values(S.queue);
  const waiting = items.filter((i) => i.status !== 'scheduled').length;

  const led = $('#led');
  led.className = 'led' + (st.checking ? ' busy' : waiting ? ' on blink' : '');
  $('#lcd-waiting').textContent = pad2(waiting);
  $('#lcd-sent').textContent = pad2(stats.sent);
  $('#lcd-sent-label').textContent = s.mode === 'auto' ? `отвечено · лимит ${s.schedule.dailyLimit} на канал` : 'отвечено сегодня';
  $('#lcd-time').textContent = hhmm(st.lastCheck);
  $('#tab-count').textContent = waiting ? String(waiting) : '';

  let line;
  if (st.checking) line = 'Проверяю новые комментарии…';
  else if (st.error) line = 'Ошибка: ' + st.error;
  else if (s.mode === 'off') line = 'Выключен · проверка по кнопке';
  else {
    const a = await chrome.alarms.get('check');
    const mins = a ? Math.max(0, Math.round((a.scheduledTime - Date.now()) / 60000)) : null;
    const next = mins == null ? '' : mins ? ` · следующая через ${mins} мин` : ' · проверка вот-вот';
    const sched = items.filter((i) => i.status === 'scheduled').length;
    line = s.mode === 'auto'
      ? (st.limitReached ? 'Дневной лимит исчерпан · продолжу завтра' : `Автоответ${sched ? ` · в очереди на отправку ${sched}` : ''}${next}`)
      : `Черновики${next}`;
  }
  $('#lcd-line').textContent = line;

  const mode = $('#mode');
  mode.dataset.mode = s.mode;
  for (const b of mode.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === s.mode));
  const sch = s.schedule;
  const notes = {
    off: [],
    drafts: [`Каждые ${sch.intervalMin} мин ищу новые комментарии и пишу черновики. Отправляете вы.`],
    auto: [h('strong', {}, 'Ответы уходят без проверки'), ` — по одному, с паузой ${sch.delayMin}–${sch.delayMax} с, не больше ${sch.dailyLimit} в день на канал. Ответы со ссылками и упоминаниями ждут вас.`],
  };
  $('#mode-note').replaceChildren(...notes[s.mode]);

  const on = enabledChannels();
  $('#account-name').textContent = on.length === 1 ? (on[0].handle || on[0].title)
    : on.length ? `${on.length} ${plural(on.length, ['канал', 'канала', 'каналов'])}`
      : s.channels.length ? 'Каналы выключены' : 'Каналы не найдены';
  $('#account-avatars').replaceChildren(...on.slice(0, 3).filter((c) => c.avatar).map((c) => h('img', { src: c.avatar, alt: '', referrerpolicy: 'no-referrer' })));
  $('#check').disabled = !!st.checking;
}

// ---------- вкладка «Очередь» ----------
const ORDER = { error: 0, ready: 1, drafting: 2, new: 2, sending: 3, scheduled: 4 };

// Каналы, у которых есть комментарии в очереди; фильтр показываем, если их больше одного
const queueChannels = () => [...new Set(Object.values(S.queue).map((i) => i.channelId))];
const visibleItems = () => Object.values(S.queue)
  .filter((i) => S.queueFilter === 'all' || i.channelId === S.queueFilter)
  .sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5) || (a.sendAt || 0) - (b.sendAt || 0) || b.createdAt - a.createdAt);

function queueFilter() {
  const ids = queueChannels();
  if (ids.length < 2) { S.queueFilter = 'all'; return null; }
  if (S.queueFilter !== 'all' && !ids.includes(S.queueFilter)) S.queueFilter = 'all';
  const count = (id) => Object.values(S.queue).filter((i) => i.channelId === id && i.status !== 'scheduled').length;
  const chip = (id, label, img) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(S.queueFilter === id),
    onclick: () => { S.queueFilter = id; renderQueue(); },
  }, img ? h('img', { src: img, alt: '', referrerpolicy: 'no-referrer' }) : null, label, id !== 'all' && count(id) ? h('span', { class: 'n' }, count(id)) : null);
  return h('div', { class: 'chips filter' }, chip('all', 'Все'),
    ids.map((id) => { const c = channelById(id); return chip(id, c?.handle || c?.title || 'канал', c?.avatar); }));
}

function renderQueue() {
  const s = S.settings;
  const ready = enabledChannels().length > 0;
  const items = visibleItems();
  const frag = [];
  if (!ready || !modelReady(s)) frag.push(onboarding());
  const filter = queueFilter();
  if (filter) frag.push(filter);
  if (!items.length) {
    if (ready && modelReady(s)) {
      frag.push(h('div', { class: 'empty' },
        h('b', {}, 'Новых комментариев нет'),
        S.status.lastCheck ? `Последняя проверка в ${hhmm(S.status.lastCheck)}${S.status.filtered ? `, отфильтровано: ${S.status.filtered}` : ''}.` : 'Нажмите «Проверить», чтобы найти комментарии без ответа.'));
    }
  } else {
    frag.push(h('div', { id: 'cards' }, items.map(card)));
  }
  view.replaceChildren(...frag);
}

function onboarding() {
  const s = S.settings;
  const voiceSet = !!s.voice.persona.trim();
  return h('div', {},
    h('p', { class: 'section-title' }, 'Три шага до первого ответа'),
    h('ol', { class: 'steps' },
      h('li', { class: enabledChannels().length ? 'done' : '' },
        h('b', {}, enabledChannels().length ? `Каналы: ${enabledChannels().map((c) => c.handle || c.title).join(', ')}` : 'Подключите каналы'),
        h('p', {}, s.channels.length
          ? 'Каналы найдены — включите те, на комментарии которых нужно отвечать.'
          : 'Войдите на youtube.com: расширение найдёт все ваши каналы, включая brand-аккаунты. Ключи API YouTube не нужны.'),
        h('button', { class: 'btn', type: 'button', onclick: (e) => (s.channels.length ? go('channels') : discover(e.currentTarget)) }, s.channels.length ? 'Выбрать каналы' : 'Найти мои каналы')),
      h('li', { class: modelReady(s) ? 'done' : '' },
        h('b', {}, modelReady(s) ? `Модель: ${s.ai.model}` : 'Подключите модель'),
        h('p', {}, 'OpenAI, Claude, Gemini, OpenRouter, локальная Ollama — любая на выбор.'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('model') }, 'Выбрать модель')),
      h('li', { class: voiceSet ? 'done' : '' },
        h('b', {}, voiceSet ? 'Голос канала задан' : 'Расскажите о канале'),
        h('p', {}, 'Пара фраз о теме и манере общения — и ответы звучат как вы.'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('voice') }, 'Настроить голос'))));
}

function card(it) {
  const max = S.settings.voice.maxChars;
  const el = h('article', { class: 'card', 'data-id': it.id, 'data-sig': sig(it) });
  const head = h('div', { class: 'card-head' },
    it.avatar ? h('img', { class: 'avatar', src: it.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar' }),
    h('div', { class: 'who' },
      h('b', {}, it.author || 'Зритель'),
      h('span', { class: 'meta' },
        `${agoRu(it.published)}${it.likes ? ` · ♥ ${it.likes}` : ''} · `,
        h('a', { href: commentUrl(it), target: '_blank', title: 'Открыть комментарий на YouTube' }, it.videoTitle || 'видео'))));
  el.append(head, h('p', { class: 'comment' }, it.text));

  const reply = h('div', { class: 'reply' });
  if (it.status === 'drafting' || it.status === 'new') {
    reply.append(h('div', { class: 'writing' }, 'Пишу ответ…'));
    el.append(reply);
    return el;
  }
  const ta = h('textarea', { class: 'textarea', rows: 3, 'aria-label': 'Текст ответа', placeholder: 'Текст ответа', value: it.draft || '' });
  const counter = h('span', {});
  const updateCount = () => {
    counter.textContent = `${ta.value.length} / ${max}`;
    counter.className = ta.value.length > max ? 'over' : '';
  };
  updateCount();
  let saveTimer;
  ta.addEventListener('input', () => {
    updateCount();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => cmd('saveDraft', { id: it.id, text: ta.value }).catch(() => {}), 600);
  });
  const ch = channelById(it.channelId);
  reply.append(ta, h('div', { class: 'reply-foot' }, h('span', {}, ch ? `Ответ от ${ch.handle || ch.title}` : 'Ответ от вашего имени'), counter));
  el.append(reply);

  if (it.suggestSkip) el.append(h('div', { class: 'note' }, `Модель советует пропустить: ${it.reason}`));
  if (it.review && it.status === 'ready') el.append(h('div', { class: 'note' }, `Проверьте перед отправкой: ${it.review}${S.settings.mode === 'auto' ? '. Сам такой ответ не отправлю' : ''}`));
  if (it.status === 'error') el.append(h('div', { class: 'note note-error' }, it.error || 'Что-то пошло не так'));
  if (it.status === 'scheduled') {
    el.append(h('div', { class: 'note note-sched' }, h('span', { class: 'led on' }), `Отправлю в ${hhmm(it.sendAt)}`));
  }

  const hintInput = h('input', { class: 'input grow', placeholder: 'Пожелание: короче, с юмором, упомяни плейлист…', 'aria-label': 'Пожелание к новому варианту' });
  const hintRow = h('div', { class: 'hint-row', hidden: true }, hintInput,
    h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, 'Пишу…', () => cmd('draft', { id: it.id, hint: hintInput.value.trim() })) }, 'Переписать'));
  hintInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') hintRow.querySelector('button').click(); });

  const sendBtn = h('button', {
    class: 'btn btn-ink', type: 'button',
    onclick: (e) => busy(e.currentTarget, 'Отправляю…', async () => { await cmd('send', { id: it.id, text: ta.value }); toast('Ответ опубликован'); }),
  }, it.status === 'error' ? 'Отправить снова' : 'Отправить');
  const skipBtn = (cls) => h('button', { class: cls, type: 'button', onclick: (e) => busy(e.currentTarget, '…', () => cmd('skip', { id: it.id })) }, 'Пропустить');
  // модель советует не отвечать и черновика нет: главное действие — пропустить
  if (it.suggestSkip && !it.draft && it.status === 'ready') {
    el.append(h('div', { class: 'actions' },
      skipBtn('btn btn-ink'),
      h('button', {
        class: 'btn', type: 'button',
        onclick: (e) => busy(e.currentTarget, 'Пишу…', () => cmd('draft', { id: it.id, hint: 'всё равно ответь коротко и вежливо' })),
      }, 'Всё равно ответить')));
    return el;
  }
  const actions = h('div', { class: 'actions' },
    it.status === 'sending' ? h('button', { class: 'btn btn-ink', disabled: true, type: 'button' }, 'Отправляю…') : sendBtn,
    h('button', { class: 'btn', type: 'button', onclick: () => { hintRow.hidden = !hintRow.hidden; if (!hintRow.hidden) hintInput.focus(); } }, 'Переписать'),
    h('span', { class: 'spacer' }),
    skipBtn('btn btn-ghost'));
  el.append(actions, hintRow);
  return el;
}

// Подпись элемента: карточка перерисовывается, только если что-то поменялось (и в ней не печатают)
const sig = (it) => JSON.stringify([it.status, it.error, it.sendAt, it.suggestSkip, it.review, it.status === 'ready' ? '' : it.draft, S.settings.voice.maxChars, S.settings.mode]);

function patchQueue() {
  const box = $('#cards');
  const items = visibleItems();
  const filterShown = !!view.querySelector('.filter');
  if (!box || !items.length || box.children.length !== items.length || filterShown !== queueChannels().length > 1 || items.some((i) => !box.querySelector(`[data-id="${CSS.escape(i.id)}"]`))) {
    // состав очереди изменился — перерисовываем, если пользователь не печатает
    if (view.contains(document.activeElement) && document.activeElement.matches('textarea, input')) return;
    return renderQueue();
  }
  for (const it of items) {
    const old = box.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
    const draftChanged = it.status === 'ready' && old.querySelector('textarea') && old.querySelector('textarea').value !== it.draft && !old.contains(document.activeElement);
    if (old.dataset.sig !== sig(it) || draftChanged) {
      if (old.contains(document.activeElement)) continue;
      old.replaceWith(card(it));
    }
  }
}

async function discover(btn) {
  await busy(btn, 'Ищу каналы…', async () => {
    const list = await cmd('discoverChannels');
    const live = list.filter((c) => !c.lost).length;
    toast(`Найдено: ${live} ${plural(live, ['канал', 'канала', 'каналов'])}`);
    go('channels');
  });
}

// ---------- вкладка «Каналы» ----------
function renderChannels() {
  const s = S.settings;
  view.replaceChildren(
    h('p', { class: 'hint', style: 'margin:2px 0 10px' },
      'Все каналы, в которые вы вошли на youtube.com в этом браузере: основные и brand-аккаунты. Отвечаю только от включённых, у каждого свой дневной лимит.'),
    h('div', { class: 'row', style: 'margin-bottom:14px' },
      h('button', { class: 'btn btn-ink', type: 'button', onclick: (e) => discover(e.currentTarget) }, s.channels.length ? 'Обновить список' : 'Найти мои каналы')),
    s.channels.length
      ? h('div', {}, s.channels.map(channelRow))
      : h('div', { class: 'empty' }, h('b', {}, 'Каналов пока нет'),
        'Войдите на youtube.com и нажмите «Найти мои каналы». Каналы другого Google-аккаунта появятся, если войти в него на YouTube: аватар → «Сменить аккаунт» → «Добавить аккаунт».'));
}

function channelRow(c) {
  const sent = S.stats.byChannel?.[c.id] || 0;
  const v = { persona: c.persona || '', examples: c.examples || '', signature: c.signature || '' };
  const own = !!(v.persona.trim() || v.examples.trim() || v.signature.trim());
  const voice = h('details', { class: 'chan-voice' },
    h('summary', {}, own ? 'Голос канала: свой' : 'Голос канала: общий'),
    field('О канале', h('textarea', { class: 'textarea', rows: 3, value: v.persona, placeholder: 'Тема этого канала и манера общения. Пусто — берётся с вкладки «Голос»', oninput: (e) => { v.persona = e.target.value; } })),
    field('Примеры ответов', h('textarea', { class: 'textarea', rows: 3, value: v.examples, placeholder: '3–5 настоящих ответов с этого канала, каждый с новой строки', oninput: (e) => { v.examples = e.target.value; } })),
    field('Подпись', h('input', { class: 'input', value: v.signature, placeholder: 'Например: — команда канала', oninput: (e) => { v.signature = e.target.value; } })),
    h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, 'Сохраняю…', async () => { await cmd('updateChannel', { id: c.id, patch: v }); toast('Голос канала сохранён'); }) }, 'Сохранить голос'));
  const meta = [c.handle, c.pageId ? 'brand-аккаунт' : 'основной канал', `Google-аккаунт ${(c.authUser ?? 0) + 1}`, c.lost ? 'нет доступа' : ''].filter(Boolean).join(' · ');
  return h('div', { class: 'chan' + (c.enabled ? ' on' : '') + (c.lost ? ' lost' : ''), 'data-id': c.id },
    h('div', { class: 'chan-top' },
      c.avatar ? h('img', { class: 'avatar', src: c.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar' }),
      h('div', { class: 'who' }, h('b', {}, c.title || c.handle), h('span', { class: 'meta' }, meta)),
      h('label', { class: 'switch', title: c.enabled ? 'Отвечать от этого канала: да' : 'Отвечать от этого канала: нет' },
        h('input', {
          type: 'checkbox', role: 'switch', checked: c.enabled, disabled: c.lost, 'aria-label': `Отвечать от ${c.handle || c.title}`,
          onchange: (e) => cmd('updateChannel', { id: c.id, patch: { enabled: e.target.checked } }).catch((err) => toast(err.message, true)),
        }),
        h('span', { class: 'switch-track' }))),
    h('div', { class: 'chan-stats' }, `Сегодня отвечено: ${sent} из ${S.settings.schedule.dailyLimit}`),
    voice);
}

// ---------- вкладка «Журнал» ----------
function renderLog() {
  const f = S.logFilter;
  const rows = S.log.filter((l) => f === 'all' || l.status === f);
  const chip = (id, label) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f === id), onclick: () => { S.logFilter = id; renderLog(); } }, label);
  view.replaceChildren(
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('div', { class: 'chips grow' }, chip('all', 'Все'), chip('sent', 'Отправлено'), chip('skipped', 'Пропущено')),
      S.log.length ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => { await cmd('clearLog'); toast('Журнал очищен'); } }, 'Очистить') : null),
    rows.length
      ? h('div', {}, rows.map((l) => h('div', { class: 'log-item' },
        h('div', { class: 'log-top' },
          h('span', { class: 'tag tag-' + l.status }, l.status === 'sent' ? 'Отправлено' : 'Пропущено'),
          h('b', {}, l.author),
          channelById(l.channelId) && S.settings.channels.length > 1 ? h('span', { class: 'hint' }, '→ ' + (channelById(l.channelId).handle || channelById(l.channelId).title)) : null,
          h('time', {}, new Date(l.doneAt).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))),
        h('p', { class: 'log-comment' }, l.text),
        l.status === 'sent'
          ? h('p', { class: 'log-reply' }, l.draft, ' ', h('a', { href: commentUrl(l), target: '_blank' }, 'открыть'))
          : h('p', { class: 'log-reply' }, h('span', { class: 'hint' }, l.reason || 'пропущен')))))
      : h('div', { class: 'empty' }, h('b', {}, 'Здесь пока пусто'), 'Отправленные и пропущенные комментарии появятся в журнале.'));
}

// ---------- формы настроек ----------
function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', {}, hint) : null);
}
function checkbox(label, hint, checked, onchange) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : null));
}
function num(value, min, max, onchange) {
  return h('input', { class: 'input', type: 'number', min, max, value, oninput: (e) => onchange(Math.min(max, Math.max(min, +e.target.value || min))) });
}
function savebar(note, onsave, extra) {
  return h('div', { class: 'savebar' }, h('span', { class: 'hint' }, note), extra, h('button', { class: 'btn btn-ink', type: 'button', onclick: (e) => busy(e.currentTarget, 'Сохраняю…', onsave) }, 'Сохранить'));
}

function renderVoice() {
  const v = structuredClone(S.settings.voice);
  const preview = h('div', { class: 'preview', hidden: true });
  const save = async () => { await cmd('saveSettings', { patch: { voice: v } }); toast('Голос сохранён'); };
  view.replaceChildren(
    S.settings.channels.length > 1 ? h('p', { class: 'hint', style: 'margin:2px 0 4px' }, 'Общие настройки для всех каналов. Тему, примеры и подпись отдельного канала можно задать на вкладке «Каналы».') : null,
    h('p', { class: 'section-title' }, 'Кто отвечает'),
    field('О канале и о вас', h('textarea', { class: 'textarea', rows: 5, value: v.persona, placeholder: 'Например: канал про сборку ПК и железо. Меня зовут Артём, общаюсь со зрителями на «ты», люблю пошутить, но по делу. Новичкам советую смотреть плейлист «Сборки до 60 000».', oninput: (e) => { v.persona = e.target.value; } }),
      'Тема канала, ваше имя, как вы обращаетесь к зрителям, что часто советуете.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Тон'),
      h('div', { class: 'chips' }, Object.entries(TONES).map(([id, label]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(v.tone.includes(id)),
        onclick: (e) => {
          v.tone = v.tone.includes(id) ? v.tone.filter((t) => t !== id) : [...v.tone, id];
          e.currentTarget.setAttribute('aria-pressed', String(v.tone.includes(id)));
        },
      }, label.split(',')[0])))),
    h('div', { class: 'grid2' },
      field('Язык ответа', h('select', { class: 'select', onchange: (e) => { v.language = e.target.value; } },
        [['auto', 'Как у комментатора'], ['русский', 'Русский'], ['English', 'English'], ['українська', 'Українська'], ['español', 'Español'], ['Deutsch', 'Deutsch']]
          .map(([val, label]) => h('option', { value: val, selected: v.language === val }, label)))),
      field('Длина, символов', num(v.maxChars, 40, 1000, (x) => { v.maxChars = x; }))),
    checkbox('Эмодзи', 'Не больше одного-двух в ответе', v.emoji, (x) => { v.emoji = x; }),
    field('Подпись', h('input', { class: 'input', value: v.signature, placeholder: 'Например: — Артём', oninput: (e) => { v.signature = e.target.value; } }), 'Добавляется в конце каждого ответа. Можно оставить пустой.'),
    h('p', { class: 'section-title' }, 'Точнее под вас'),
    field('Примеры ваших ответов', h('textarea', { class: 'textarea', rows: 4, value: v.examples, placeholder: 'Вставьте 3–5 своих настоящих ответов зрителям, каждый с новой строки', oninput: (e) => { v.examples = e.target.value; } }),
      'Лучший способ научить модель вашей манере.'),
    field('Чего никогда не делать', h('textarea', { class: 'textarea', rows: 2, value: v.avoid, placeholder: 'Например: не обсуждать политику, не называть цены, не обещать новые видео', oninput: (e) => { v.avoid = e.target.value; } })),
    preview,
    savebar('', save, h('button', {
      class: 'btn', type: 'button',
      onclick: (e) => busy(e.currentTarget, 'Пишу…', async () => {
        await save();
        preview.hidden = false;
        preview.textContent = 'Пример ответа на «А какой блок питания брал? Хватит его под апгрейд видеокарты?»\n\n' + await cmd('testModel');
      }),
    }, 'Пример ответа')));
}

function renderRules() {
  const r = structuredClone(S.settings.rules);
  const sc = structuredClone(S.settings.schedule);
  view.replaceChildren(
    h('p', { class: 'section-title' }, 'Где искать'),
    h('div', { class: 'grid2' },
      field('Последних видео', num(r.videos, 1, 30, (x) => { r.videos = x; })),
      field('Не старше, дней', num(r.maxAgeDays, 1, 365, (x) => { r.maxAgeDays = x; }))),
    checkbox('Включая Shorts', 'Комментарии под короткими видео тоже попадут в очередь', r.includeShorts, (x) => { r.includeShorts = x; }),
    checkbox('Пропускать, если вы уже ответили', 'Ветки, где есть ваш ответ, не попадают в очередь', r.skipReplied, (x) => { r.skipReplied = x; }),
    h('p', { class: 'section-title' }, 'На что не отвечать'),
    checkbox('Модель сама отсеивает спам и грубость', 'Такие комментарии помечаются «советую пропустить», в режиме «Авто» пропускаются', r.letModelSkip, (x) => { r.letModelSkip = x; }),
    checkbox('Только вопросы', 'Берём комментарии, где есть знак «?»', r.onlyQuestions, (x) => { r.onlyQuestions = x; }),
    checkbox('Пропускать комментарии со ссылками', 'Чаще всего это реклама', r.skipLinks, (x) => { r.skipLinks = x; }),
    field('Минимум символов', num(r.minLength, 0, 200, (x) => { r.minLength = x; })),
    field('Стоп-слова', h('textarea', { class: 'textarea', rows: 2, value: r.stopWords, placeholder: 'через запятую: заработок, telegram, крипта', oninput: (e) => { r.stopWords = e.target.value; } }), 'Комментарий с любым из этих слов пропускается.'),
    field('Чёрный список авторов', h('textarea', { class: 'textarea', rows: 2, value: r.blockAuthors, placeholder: '@handle или ID канала, через запятую', oninput: (e) => { r.blockAuthors = e.target.value; } })),
    h('p', { class: 'section-title' }, 'Расписание'),
    h('div', { class: 'grid2' },
      field('Проверять раз в, мин', num(sc.intervalMin, 5, 720, (x) => { sc.intervalMin = x; })),
      field('Ответов в день, не больше', num(sc.dailyLimit, 1, 300, (x) => { sc.dailyLimit = x; }))),
    h('div', { class: 'grid2' },
      field('Пауза от, сек', num(sc.delayMin, 10, 3600, (x) => { sc.delayMin = x; })),
      field('Пауза до, сек', num(sc.delayMax, 10, 7200, (x) => { sc.delayMax = x; }))),
    h('p', { class: 'hint' }, 'Лимит и паузы действуют в режиме «Авто»: ответы уходят по одному, как будто вы отвечаете сами. Слишком частые ответы YouTube может принять за спам.'),
    savebar('', async () => {
      if (sc.delayMax < sc.delayMin) sc.delayMax = sc.delayMin;
      await cmd('saveSettings', { patch: { rules: r, schedule: sc } });
      toast('Правила сохранены');
    }));
}

function renderModel() {
  const ai = structuredClone(S.settings.ai);
  const p = () => providerById(ai.preset);
  const result = h('div', { class: 'preview', hidden: true });
  const list = h('datalist', { id: 'models' });
  const baseInput = h('input', { class: 'input', value: ai.baseUrl, placeholder: 'https://…/v1', oninput: (e) => { ai.baseUrl = e.target.value.trim(); } });
  const modelInput = h('input', { class: 'input grow', value: ai.model, list: 'models', placeholder: 'название модели', oninput: (e) => { ai.model = e.target.value.trim(); } });
  const keyInput = h('input', { class: 'input grow', type: 'password', value: ai.apiKey, autocomplete: 'off', spellcheck: 'false', placeholder: p().local ? 'не нужен' : 'sk-…', oninput: (e) => { ai.apiKey = e.target.value.trim(); } });
  const keyLink = h('a', { target: '_blank' });
  const keyLabel = h('span', {}, 'API-ключ');
  const localHint = h('small', {});
  const bridgeStatus = h('div', { class: 'note', style: 'margin:0 0 14px', hidden: true });
  const viaRow = h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: ai.viaBridge, onchange: (e) => { ai.viaBridge = e.target.checked; syncProvider(); } }),
    h('span', {},
      h('b', {}, 'Через мост TubeComment'),
      h('small', {}, 'Запросы к провайдеру идут через мост на этом компьютере и дальше через его прокси (HTTP или SOCKS5). Нужно, если API провайдера недоступен напрямую.')));
  let tokenTimer;
  const tokenInput = h('input', {
    class: 'input', type: 'password', value: ai.bridgeToken, autocomplete: 'off', spellcheck: 'false', placeholder: 'из окна моста',
    oninput: (e) => { ai.bridgeToken = e.target.value.trim(); clearTimeout(tokenTimer); tokenTimer = setTimeout(checkBridge, 400); },
  });
  const tokenField = field('Токен моста', tokenInput, 'Мост показывает его при запуске. Нужен один раз: без токена мостом не сможет пользоваться другая программа на компьютере.');
  let pingSeq = 0;
  const checkBridge = async () => {
    const usesBridge = p().bridge || ai.viaBridge;
    bridgeStatus.hidden = !usesBridge;
    tokenField.hidden = !usesBridge;
    if (!usesBridge) return;
    const seq = ++pingSeq;
    bridgeStatus.className = 'note';
    bridgeStatus.textContent = 'Проверяю мост…';
    try {
      const r = await cmd('bridgePing', { token: ai.bridgeToken });
      if (seq !== pingSeq) return;
      const clis = (r.clis || []).map((c) => c.id).join(', ');
      bridgeStatus.textContent = `Мост ${r.version} работает · CLI: ${clis || 'не найдены'} · прокси: ${r.proxy || 'нет'}`;
    } catch (e) {
      if (seq !== pingSeq) return;
      bridgeStatus.className = 'note note-error';
      bridgeStatus.textContent = e.code === 'BAD_TOKEN'
        ? 'Мост работает, но токен не подходит. Скопируйте его из окна моста (или: node bridge/tubecomment-bridge.mjs --show-token).'
        : 'Мост не запущен. Откройте папку расширения и запустите bridge/start-bridge.bat (macOS/Linux: node bridge/tubecomment-bridge.mjs).';
    }
  };
  const formatSelect = h('select', { class: 'select', onchange: (e) => { ai.format = e.target.value; } },
    h('option', { value: 'openai' }, 'OpenAI-совместимый'), h('option', { value: 'anthropic' }, 'Anthropic Messages'));

  const syncProvider = () => {
    const pr = p();
    keyLink.hidden = !pr.keyUrl;
    if (pr.keyUrl) { keyLink.href = pr.keyUrl; keyLink.textContent = 'Где взять ключ'; }
    viaRow.hidden = !!pr.bridge || !!pr.local;
    // CLI-агенту через мост ключ не нужен — оставляем только подсказку
    keyInput.parentElement.hidden = !!pr.bridge;
    keyLabel.textContent = pr.bridge ? 'Как это работает' : 'API-ключ';
    if (pr.bridge) ai.apiKey = '';
    if (viaRow.hidden) ai.viaBridge = false;
    localHint.textContent = pr.bridge
      ? 'Ключ не нужен: отвечает CLI, в который вы уже вошли. Модель — имя CLI: claude, codex, gemini, ollama/llama3.1; можно уточнить, например claude:sonnet.'
      : pr.id === 'ollama'
      ? 'Запустите Ollama с переменной OLLAMA_ORIGINS=chrome-extension://*, иначе она не примет запросы от расширения.'
      : pr.local ? 'В LM Studio включите сервер (Developer → Start server) и CORS.' : 'Ключ хранится только в этом браузере и уходит только выбранному провайдеру.';
    keyInput.placeholder = pr.local ? 'не нужен' : 'sk-…';
    formatSelect.value = ai.format;
    checkBridge();
  };

  const persist = async () => {
    if (!ai.baseUrl) throw new Error('Укажите адрес API');
    if (!(await ensureHostPermission(ai.baseUrl, ai.viaBridge))) throw new Error('Без доступа к домену модели расширение не сможет отправлять запросы');
    await cmd('saveSettings', { patch: { ai } });
  };

  view.replaceChildren(
    h('p', { class: 'section-title' }, 'Провайдер'),
    field('Сервис', h('select', {
      class: 'select',
      onchange: (e) => {
        const pr = providerById(e.target.value);
        const changed = pr.id !== ai.preset;
        ai.preset = pr.id;
        ai.format = pr.format;
        if (pr.baseUrl) ai.baseUrl = pr.baseUrl;
        if (changed) { ai.model = pr.model; ai.apiKey = ''; }
        baseInput.value = ai.baseUrl;
        modelInput.value = ai.model;
        keyInput.value = ai.apiKey;
        syncProvider();
      },
    }, PROVIDERS.map((pr) => h('option', { value: pr.id, selected: pr.id === ai.preset }, pr.name)))),
    h('label', { class: 'field' }, keyLabel,
      h('div', { class: 'row' }, keyInput,
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: (e) => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; e.currentTarget.textContent = keyInput.type === 'password' ? 'Показать' : 'Скрыть'; } }, 'Показать')),
      h('small', {}, localHint, ' ', keyLink)),
    viaRow,
    tokenField,
    bridgeStatus,
    h('label', { class: 'field' }, h('span', {}, 'Модель'),
      h('div', { class: 'row' }, modelInput, list,
        h('button', {
          class: 'btn', type: 'button',
          onclick: (e) => busy(e.currentTarget, 'Загружаю…', async () => {
            if (!(await ensureHostPermission(ai.baseUrl, ai.viaBridge))) throw new Error('Нужен доступ к домену модели');
            const models = await cmd('listModels', { cfg: ai });
            list.replaceChildren(...models.map((m) => h('option', { value: m })));
            toast(`Моделей доступно: ${models.length}. Начните вводить название`);
            modelInput.focus();
          }),
        }, 'Список'))),
    h('p', { class: 'section-title' }, 'Дополнительно'),
    field('Адрес API', baseInput, 'Подставляется из пресета. Для своего сервера укажите адрес, оканчивающийся на /v1.'),
    h('div', { class: 'grid2' },
      field('Формат', formatSelect),
      field('Температура', h('input', { class: 'input', type: 'number', min: 0, max: 2, step: 0.1, value: ai.temperature, oninput: (e) => { ai.temperature = Math.min(2, Math.max(0, +e.target.value)); } }))),
    result,
    savebar('', async () => { await persist(); toast('Модель сохранена'); },
      h('button', {
        class: 'btn', type: 'button',
        onclick: (e) => busy(e.currentTarget, 'Проверяю…', async () => {
          await persist();
          result.hidden = false;
          result.textContent = 'Модель отвечает:\n\n' + await cmd('testModel');
        }),
      }, 'Проверить')));
  syncProvider();
}

// ---------- навигация ----------
const VIEWS = { queue: renderQueue, channels: renderChannels, log: renderLog, voice: renderVoice, rules: renderRules, model: renderModel };

function go(tab) {
  S.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  VIEWS[tab]();
  window.scrollTo(0, 0);
  try { localStorage.setItem('tab', tab); } catch { /* приватный режим */ }
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) go(b.dataset.tab);
});

$('#mode').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === S.settings.mode) return;
  const mode = b.dataset.mode;
  if (mode !== 'off' && !modelReady(S.settings)) { toast('Сначала подключите модель', true); return go('model'); }
  try { await cmd('setMode', { mode }); } catch (err) { toast(err.message, true); }
});

$('#check').addEventListener('click', (e) => {
  if (!modelReady(S.settings)) { toast('Сначала подключите модель', true); return go('model'); }
  busy(e.currentTarget, 'Проверяю…', async () => {
    const r = await cmd('check');
    toast(r.found ? `Новых комментариев: ${r.found}` : 'Новых комментариев нет');
    if (S.tab !== 'queue') go('queue');
  });
});

$('#account').addEventListener('click', () => go('channels'));

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  await load();
  renderHeader();
  if (S.tab === 'queue' && (changes.queue || changes.status || changes.settings)) patchQueue();
  if (S.tab === 'log' && changes.log) renderLog();
  // список каналов перерисовываем, только если в нём ничего не редактируют
  if (S.tab === 'channels' && (changes.settings || changes.stats) && !view.querySelector('details[open]')) renderChannels();
});

// LCD-строка показывает «через N мин» — обновляем раз в 30 секунд
setInterval(renderHeader, 30000);

(async () => {
  await load();
  await renderHeader();
  let tab = 'queue';
  try { tab = localStorage.getItem('tab') || 'queue'; } catch { /* приватный режим */ }
  go(VIEWS[tab] ? tab : 'queue');
})();
