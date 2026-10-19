// Работа с YouTube без официального API: внутренний JSON-API сайта (InnerTube),
// запросы выполняются внутри открытой вкладки youtube.com под вашей обычной сессией.
// Формат ответов YouTube может меняться — все разборы собраны в этом файле.

const YT = 'https://www.youtube.com/';
const VIDEOS_TAB = 'EgZ2aWRlb3PyBgQKAjoA';
const SHORTS_TAB = 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D';

export class YTError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---- выполняется в мире страницы youtube.com (функция сериализуется, внешних ссылок быть не должно) ----
async function pageCall(endpoint, body) {
  const get = (k) => {
    const yc = window.ytcfg;
    if (!yc) return undefined;
    return yc.get ? yc.get(k) : yc.data_?.[k];
  };
  for (let i = 0; i < 40 && !get('INNERTUBE_CONTEXT'); i++) await new Promise((r) => setTimeout(r, 250));
  const context = get('INNERTUBE_CONTEXT');
  if (!context) return { error: 'NO_YTCFG' };
  const cookie = (n) => document.cookie.split('; ').find((c) => c.startsWith(n + '='))?.slice(n.length + 1);
  const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
  if (!sapisid || get('LOGGED_IN') === false) return { error: 'NOT_LOGGED_IN' };

  const origin = location.origin;
  const ts = Math.floor(Date.now() / 1000);
  const sha1 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const auth = [];
  for (const [name, value] of [['SAPISIDHASH', sapisid], ['SAPISID1PHASH', cookie('__Secure-1PAPISID')], ['SAPISID3PHASH', cookie('__Secure-3PAPISID')]]) {
    if (value) auth.push(`${name} ${ts}_${await sha1(`${ts} ${value} ${origin}`)}`);
  }
  const headers = {
    'content-type': 'application/json',
    authorization: auth.join(' '),
    'x-origin': origin,
    'x-goog-authuser': String(get('SESSION_INDEX') ?? 0),
    'x-youtube-client-name': String(get('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
    'x-youtube-client-version': context.client?.clientVersion || '',
  };
  const pageId = get('DELEGATED_SESSION_ID');
  if (pageId) headers['x-goog-pageid'] = pageId;
  // hl=en — даты приходят в разбираемом виде («2 hours ago»); текст комментариев не меняется
  const ctx = JSON.parse(JSON.stringify(context));
  ctx.client = { ...ctx.client, hl: 'en' };
  try {
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: ctx, ...body }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* пустой ответ */ }
    return { status: res.status, json };
  } catch (e) {
    return { error: 'NETWORK', message: String(e?.message || e) };
  }
}

// ---- вкладка-мост ----
const isYT = (t) => t.url?.startsWith(YT) && !t.discarded;

function waitComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(on); reject(new YTError('Вкладка YouTube не загрузилась за 30 секунд', 'TAB_TIMEOUT')); }, timeout);
    const on = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(on);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') on(tabId, { status: 'complete' }); }).catch(() => {});
  });
}

// Берёт уже открытую вкладку YouTube или открывает свою в фоне (и закрывает её после работы)
export async function withYouTube(fn) {
  const tabs = (await chrome.tabs.query({ url: YT + '*' })).filter(isYT);
  let tab = tabs.find((t) => t.status === 'complete') || tabs[0];
  let temp = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: YT, active: false });
    temp = true;
  }
  try {
    await waitComplete(tab.id);
    // YouTube мог перенаправить на страницу входа Google или согласия с cookie
    const url = (await chrome.tabs.get(tab.id)).url || '';
    if (!url.startsWith(YT)) {
      throw new YTError(/consent\./.test(url)
        ? 'YouTube просит принять условия использования cookie — откройте youtube.com и ответьте на запрос'
        : 'Войдите в свой аккаунт на youtube.com — ответы публикуются от вашего имени', 'NOT_LOGGED_IN');
    }
    const call = async (endpoint, body) => {
      let out;
      try {
        [out] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: pageCall, args: [endpoint, body] });
      } catch (e) {
        throw new YTError('Не удалось выполнить запрос во вкладке YouTube: ' + e.message, 'SCRIPT');
      }
      const r = out?.result;
      if (!r) throw new YTError('Вкладка YouTube не ответила', 'SCRIPT');
      if (r.error === 'NOT_LOGGED_IN') throw new YTError('Войдите в свой аккаунт на youtube.com — ответы публикуются от вашего имени', 'NOT_LOGGED_IN');
      if (r.error === 'NO_YTCFG') throw new YTError('Страница YouTube ещё не готова, попробуйте через минуту', 'NO_YTCFG');
      if (r.error) throw new YTError('Сеть: ' + (r.message || r.error), 'NETWORK');
      if (r.status === 429) throw new YTError('YouTube временно ограничил запросы (429). Увеличьте интервал проверки', 'RATE');
      if (r.status >= 400) {
        const msg = r.json?.error?.message || '';
        throw new YTError(`YouTube ответил ${r.status}${msg ? ': ' + msg : ''}`, 'HTTP');
      }
      return r.json || {};
    };
    return await fn(call);
  } finally {
    if (temp) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---- разбор ----
function findAll(node, key, out = []) {
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(cur, key)) out.push(cur[key]);
    const vals = Object.values(cur);
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] && typeof vals[i] === 'object') stack.push(vals[i]);
  }
  return out;
}

const text = (t) => (!t ? '' : t.simpleText ?? t.content ?? (t.runs || []).map((r) => r.text).join(''));

export function parseCount(s) {
  if (!s) return 0;
  const m = /([\d.,]+)\s*([KMB]\b)?/i.exec(String(s));
  if (!m) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return mult === 1 ? +m[1].replace(/[.,]/g, '') : Math.round(parseFloat(m[1].replace(/,/g, '')) * mult);
}

// «3 hours ago (edited)» → возраст в часах
export function ageHours(s) {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(s || '');
  if (!m) return 0;
  const h = { second: 1 / 3600, minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720, year: 8760 }[m[2].toLowerCase()];
  return +m[1] * h;
}

function entityMap(json) {
  const map = {};
  for (const m of json.frameworkUpdates?.entityBatchUpdate?.mutations || []) if (m.entityKey && m.payload) map[m.entityKey] = m.payload;
  return map;
}

// Элементы списка верхнего уровня (без вложенных ответов) из ответа-продолжения
function continuationItems(json) {
  const out = [];
  for (const ep of json.onResponseReceivedEndpoints || []) {
    const items = ep.reloadContinuationItemsCommand?.continuationItems || ep.appendContinuationItemsAction?.continuationItems || [];
    out.push(...items);
  }
  return out;
}

const nextToken = (items) => items.map((i) => i.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
  || i.continuationItemRenderer?.button?.buttonRenderer?.command?.continuationCommand?.token).filter(Boolean).pop();

function parseThread(t, map) {
  const vm = t.commentViewModel?.commentViewModel;
  if (vm) {
    const ce = map[vm.commentKey]?.commentEntityPayload;
    if (!ce) return null;
    const surface = map[vm.toolbarSurfaceKey];
    return {
      id: ce.properties?.commentId || vm.commentId,
      text: ce.properties?.content?.content || '',
      published: ce.properties?.publishedTime || '',
      author: ce.author?.displayName || '',
      authorId: ce.author?.channelId || '',
      avatar: ce.author?.avatarThumbnailUrl || '',
      isCreator: !!ce.author?.isCreator,
      isMine: !!ce.author?.isCurrentUser,
      likes: parseCount(ce.toolbar?.likeCountNotliked),
      replyCount: parseCount(ce.toolbar?.replyCount),
      hearted: map[vm.toolbarStateKey]?.engagementToolbarStateEntityPayload?.heartState === 'TOOLBAR_HEART_STATE_HEARTED',
      replyParams: findAll(surface, 'createReplyParams')[0] || findAll(t, 'createReplyParams')[0] || '',
      repliesToken: findAll(t.replies, 'continuationCommand')[0]?.token || '',
    };
  }
  // старый формат (commentRenderer) — на случай, если YouTube вернёт его некоторым аккаунтам
  const c = t.comment?.commentRenderer;
  if (!c) return null;
  return {
    id: c.commentId,
    text: text(c.contentText),
    published: text(c.publishedTimeText),
    author: text(c.authorText),
    authorId: c.authorEndpoint?.browseEndpoint?.browseId || '',
    avatar: c.authorThumbnail?.thumbnails?.[0]?.url || '',
    isCreator: !!c.authorIsChannelOwner,
    isMine: false,
    likes: parseCount(text(c.voteCount)),
    replyCount: c.replyCount || 0,
    hearted: !!c.actionButtons?.commentActionButtonsRenderer?.creatorHeart?.creatorHeartRenderer?.isHearted,
    replyParams: findAll(c, 'createReplyParams')[0] || '',
    repliesToken: findAll(t.replies, 'continuationCommand')[0]?.token || '',
  };
}

// ---- публичные функции ----

// Кто залогинен на youtube.com: канал, от имени которого пойдут ответы
export async function whoAmI(call) {
  const j = await call('account/account_menu', {});
  const h = findAll(j, 'activeAccountHeaderRenderer')[0];
  if (!h) throw new YTError('Не удалось определить ваш канал. Откройте youtube.com и проверьте, что вы вошли в аккаунт', 'NO_CHANNEL');
  const handle = text(h.channelHandle);
  // @handle однозначно указывает на текущий канал; ссылки меню — запасной вариант
  let id = '';
  if (handle) {
    const r = await call('navigation/resolve_url', { url: YT + handle }).catch(() => null);
    id = r?.endpoint?.browseEndpoint?.browseId || '';
  }
  if (!id) id = findAll(j, 'browseEndpoint').map((b) => b.browseId).find((x) => x?.startsWith('UC')) || '';
  if (!id) throw new YTError('У этого аккаунта нет YouTube-канала', 'NO_CHANNEL');
  return { id, handle, title: text(h.accountName), avatar: h.accountPhoto?.thumbnails?.slice(-1)[0]?.url || '' };
}

// Последние видео (и Shorts) канала: [{ id, title }]
export async function recentVideos(call, channelId, { max = 5, shorts = true } = {}) {
  const out = [];
  const j = await call('browse', { browseId: channelId, params: VIDEOS_TAB });
  for (const l of findAll(j, 'lockupViewModel')) {
    if (l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && l.contentId) out.push({ id: l.contentId, title: text(l.metadata?.lockupMetadataViewModel?.title) });
  }
  for (const v of findAll(j, 'videoRenderer')) if (v.videoId) out.push({ id: v.videoId, title: text(v.title) });
  if (shorts) {
    try {
      const s = await call('browse', { browseId: channelId, params: SHORTS_TAB });
      for (const l of findAll(s, 'shortsLockupViewModel')) {
        const id = findAll(l, 'reelWatchEndpoint')[0]?.videoId;
        if (id) out.push({ id, title: l.overlayMetadata?.primaryText?.content || '', short: true });
      }
      for (const r of findAll(s, 'reelItemRenderer')) if (r.videoId) out.push({ id: r.videoId, title: text(r.headline), short: true });
    } catch { /* у канала нет Shorts */ }
  }
  const seen = new Set();
  const uniq = out.filter((v) => !seen.has(v.id) && seen.add(v.id));
  // даты у двух лент несравнимы — берём ~2/3 свежих видео и ~1/3 свежих Shorts, недостачу добираем из другой ленты
  const long = uniq.filter((v) => !v.short);
  const sh = uniq.filter((v) => v.short);
  const nLong = Math.min(long.length, Math.max(max - sh.length, Math.ceil((max * 2) / 3)));
  return [...long.slice(0, nLong), ...sh.slice(0, max - nLong)];
}

// Свежие комментарии к видео (сортировка «Сначала новые»)
export async function videoComments(call, videoId, { max = 60 } = {}) {
  const n = await call('next', { videoId });
  const title = text(findAll(n, 'videoPrimaryInfoRenderer')[0]?.title);
  const description = text(findAll(n, 'attributedDescription')[0]) || '';
  const sec = findAll(n, 'itemSectionRenderer').find((s) => s.targetId === 'comments-section');
  const first = sec && findAll(sec, 'continuationCommand')[0]?.token;
  if (!first) return { title, description, comments: [] }; // комментарии выключены

  let page = await call('next', { continuation: first });
  const sort = findAll(page, 'sortFilterSubMenuRenderer').find((s) => s.subMenuItems)?.subMenuItems?.[1];
  const newest = sort?.serviceEndpoint?.continuationCommand?.token;
  if (newest) page = await call('next', { continuation: newest });

  const comments = [];
  for (let guard = 0; guard < 10; guard++) {
    const map = entityMap(page);
    const items = continuationItems(page);
    for (const it of items) {
      if (!it.commentThreadRenderer) continue;
      const c = parseThread(it.commentThreadRenderer, map);
      if (c?.id) comments.push(c);
    }
    const tok = nextToken(items);
    if (comments.length >= max || !tok) break;
    page = await call('next', { continuation: tok });
  }
  return { title, description, comments: comments.slice(0, max) };
}

// Есть ли в ветке ответ автора канала
export async function ownerReplied(call, repliesToken, myChannelId) {
  if (!repliesToken) return false;
  let page = await call('next', { continuation: repliesToken });
  for (let guard = 0; guard < 5; guard++) {
    const map = entityMap(page);
    for (const p of Object.values(map)) {
      const a = p.commentEntityPayload?.author;
      if (a && (a.isCreator || a.isCurrentUser || a.channelId === myChannelId)) return true;
    }
    const tok = nextToken(continuationItems(page));
    if (!tok) return false;
    page = await call('next', { continuation: tok });
  }
  return false;
}

export async function postReply(call, replyParams, textValue) {
  if (!replyParams) throw new YTError('У комментария нет кнопки «Ответить» — возможно, ответы закрыты или вы не владелец видео', 'NO_PARAMS');
  const j = await call('comment/create_comment_reply', { createReplyParams: replyParams, commentText: textValue });
  const status = j.actionResult?.status;
  if (status && status !== 'STATUS_SUCCEEDED') {
    throw new YTError('YouTube не принял ответ: ' + (text(j.actionResult?.feedbackText) || status), 'REJECTED');
  }
  const created = findAll(j, 'commentEntityPayload')[0]?.properties?.commentId || findAll(j, 'commentId')[0] || '';
  return { ok: true, replyId: created };
}
