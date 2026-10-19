import { PROVIDERS, providerById } from '../lib/providers.js';
import { TONES } from '../lib/prompt.js';
import { ensureHostPermission } from '../lib/ai.js';
import { DEFAULTS } from '../lib/storage.js';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const S = { settings: null, queue: {}, log: [], stats: { sent: 0 }, status: {}, tab: 'queue', logFilter: 'all' };

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
const modelReady = (s) => !!(s.ai.baseUrl && s.ai.model && (s.ai.apiKey || providerById(s.ai.preset).local || s.ai.preset === 'custom'));

// ---------- данные ----------
async function load() {
  const d = await chrome.storage.local.get(['settings', 'queue', 'log', 'stats', 'status']);
  S.settings = mergeDefaults(d.settings);
  S.queue = d.queue || {};
  S.log = d.log || [];
  const today = new Date().toLocaleDateString('sv');
  S.stats = d.stats?.date === today ? d.stats : { sent: 0 };
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
  $('#lcd-sent-label').textContent = s.mode === 'auto' ? `отвечено · лимит ${s.schedule.dailyLimit}` : 'отвечено сегодня';
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
    off: '',
    drafts: `Каждые ${sch.intervalMin} мин ищу новые комментарии и пишу черновики. Отправляете вы.`,
    auto: `<strong>Ответы уходят без проверки</strong> — по одному, с паузой ${sch.delayMin}–${sch.delayMax} с, не больше ${sch.dailyLimit} в день.`,
  };
  $('#mode-note').innerHTML = notes[s.mode];

  const ch = s.channel;
  $('#account-name').textContent = ch ? (ch.handle || ch.title) : 'Канал не подключён';
  const img = $('#account-avatar');
  img.hidden = !ch?.avatar;
  if (ch?.avatar) img.src = ch.avatar;
  $('#check').disabled = !!st.checking;
}

// ---------- вкладка «Очередь» ----------
const ORDER = { error: 0, ready: 1, drafting: 2, new: 2, sending: 3, scheduled: 4 };

function renderQueue() {
  const s = S.settings;
  const items = Object.values(S.queue).sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5) || (a.sendAt || 0) - (b.sendAt || 0) || b.createdAt - a.createdAt);
  const frag = [];
  if (!s.channel || !modelReady(s)) frag.push(onboarding());
  if (!items.length) {
    if (s.channel && modelReady(s)) {
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
      h('li', { class: s.channel ? 'done' : '' },
        h('b', {}, s.channel ? `Канал: ${s.channel.handle || s.channel.title}` : 'Войдите в YouTube'),
        h('p', {}, 'Ответы публикуются от аккаунта, в который вы вошли на youtube.com. Ключи API YouTube не нужны.'),
        h('button', { class: 'btn', type: 'button', onclick: (e) => connectChannel(e.currentTarget) }, 'Подключить канал')),
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
  reply.append(ta, h('div', { class: 'reply-foot' }, h('span', {}, 'Ответ от вашего имени'), counter));
  el.append(reply);

  if (it.suggestSkip) el.append(h('div', { class: 'note' }, `Модель советует пропустить: ${it.reason}`));
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
  const actions = h('div', { class: 'actions' },
    it.status === 'sending' ? h('button', { class: 'btn btn-ink', disabled: true, type: 'button' }, 'Отправляю…') : sendBtn,
    h('button', { class: 'btn', type: 'button', onclick: () => { hintRow.hidden = !hintRow.hidden; if (!hintRow.hidden) hintInput.focus(); } }, 'Переписать'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: (e) => busy(e.currentTarget, '…', () => cmd('skip', { id: it.id })) }, 'Пропустить'));
  el.append(actions, hintRow);
  return el;
}

// Подпись элемента: карточка перерисовывается, только если что-то поменялось (и в ней не печатают)
const sig = (it) => JSON.stringify([it.status, it.error, it.sendAt, it.suggestSkip, it.status === 'ready' ? '' : it.draft, S.settings.voice.maxChars]);

function patchQueue() {
  const box = $('#cards');
  const items = Object.values(S.queue);
  if (!box || !items.length || box.children.length !== items.length || items.some((i) => !box.querySelector(`[data-id="${CSS.escape(i.id)}"]`))) {
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

async function connectChannel(btn) {
  await busy(btn, 'Подключаю…', async () => {
    const me = await cmd('whoAmI');
    toast(`Подключено: ${me.handle || me.title}`);
  });
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
  const localHint = h('small', {});
  const formatSelect = h('select', { class: 'select', onchange: (e) => { ai.format = e.target.value; } },
    h('option', { value: 'openai' }, 'OpenAI-совместимый'), h('option', { value: 'anthropic' }, 'Anthropic Messages'));

  const syncProvider = () => {
    const pr = p();
    keyLink.hidden = !pr.keyUrl;
    if (pr.keyUrl) { keyLink.href = pr.keyUrl; keyLink.textContent = 'Где взять ключ'; }
    localHint.textContent = pr.id === 'ollama'
      ? 'Запустите Ollama с переменной OLLAMA_ORIGINS=chrome-extension://*, иначе она не примет запросы от расширения.'
      : pr.local ? 'В LM Studio включите сервер (Developer → Start server) и CORS.' : 'Ключ хранится только в этом браузере и уходит только выбранному провайдеру.';
    keyInput.placeholder = pr.local ? 'не нужен' : 'sk-…';
    formatSelect.value = ai.format;
  };

  const persist = async () => {
    if (!ai.baseUrl) throw new Error('Укажите адрес API');
    if (!(await ensureHostPermission(ai.baseUrl))) throw new Error('Без доступа к домену модели расширение не сможет отправлять запросы');
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
    h('label', { class: 'field' }, h('span', {}, 'API-ключ'),
      h('div', { class: 'row' }, keyInput,
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: (e) => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; e.currentTarget.textContent = keyInput.type === 'password' ? 'Показать' : 'Скрыть'; } }, 'Показать')),
      h('small', {}, localHint, ' ', keyLink)),
    h('label', { class: 'field' }, h('span', {}, 'Модель'),
      h('div', { class: 'row' }, modelInput, list,
        h('button', {
          class: 'btn', type: 'button',
          onclick: (e) => busy(e.currentTarget, 'Загружаю…', async () => {
            if (!(await ensureHostPermission(ai.baseUrl))) throw new Error('Нужен доступ к домену модели');
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
const VIEWS = { queue: renderQueue, log: renderLog, voice: renderVoice, rules: renderRules, model: renderModel };

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

$('#account').addEventListener('click', (e) => connectChannel(e.currentTarget));

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  await load();
  renderHeader();
  if (S.tab === 'queue' && (changes.queue || changes.status || changes.settings)) patchQueue();
  if (S.tab === 'log' && changes.log) renderLog();
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
