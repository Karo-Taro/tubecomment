#!/usr/bin/env node
// Мост TubeComment: локальный сервер на 127.0.0.1, который даёт расширению две вещи.
//
// 1. CLI-агенты вместо API-ключа. OpenAI-совместимый /v1/chat/completions поверх установленных
//    claude (Claude Code), codex (Codex CLI), gemini (Gemini CLI) и ollama. Модель = имя CLI,
//    например «claude» или «claude:sonnet». Текст запроса уходит в stdin.
// 2. Прокси. /forward/* пересылает запрос расширения выбранному провайдеру (адрес — в заголовке
//    X-TC-Target), при желании через HTTP- или SOCKS5-прокси. Удобно, если API провайдера
//    недоступен напрямую: браузер настраивать не нужно.
//
// Без зависимостей, нужен Node.js 18+.  Запуск:  node bridge/tubecomment-bridge.mjs [--proxy socks5://host:1080]
// Автозапуск на Windows:  --install-autostart  /  --uninstall-autostart

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = '0.3.0';
const EXTENSION_ID = 'bdeekghlhecipdlkflmepindpmdnlkjj'; // закреплён ключом в manifest.json
const MAX_BODY = 4 * 1024 * 1024;
const MAX_PROMPT = 200_000;
const CLI_TIMEOUT = 180_000;
const MAX_PARALLEL_CLI = 2;
const isWin = process.platform === 'win32';

// ---------------------------------------------------------------- настройки
// Файл настроек: %LOCALAPPDATA%\TubeComment\bridge.json или ~/.config/tubecomment/bridge.json
//   { "token": "…", "port": 47331, "proxy": "socks5://user:pass@host:1080",
//     "allowToolAgents": ["codex", "gemini"], "allowedOrigins": ["chrome-extension://…"],
//     "cli": { "my-llm": { "cmd": ["llm", "-m", "gpt-4o"] } } }
// token создаётся при первом запуске; его нужно один раз вставить в расширение (вкладка «Модель»).
const CONFIG_DIR = isWin
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TubeComment')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tubecomment');
const CONFIG_FILE = path.join(CONFIG_DIR, 'bridge.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
const config = readConfig();

// Секретный токен: без него мостом не сможет пользоваться другая программа или другой пользователь компьютера
if (!config.token) {
  config.token = randomBytes(18).toString('base64url');
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('Не удалось сохранить токен в ' + CONFIG_FILE + ': ' + e.message);
  }
}
const TOKEN = Buffer.from(String(config.token));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PORT = +(arg('--port') || process.env.TUBECOMMENT_PORT || config.port || 47331);
const PROXY = arg('--proxy') || process.env.TUBECOMMENT_PROXY || config.proxy || '';
const ALLOWED_ORIGINS = new Set(config.allowedOrigins || [`chrome-extension://${EXTENSION_ID}`]);

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const maskProxy = (p) => p.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');

// ---------------------------------------------------------------- CLI-агенты
// В промпт попадают чужие комментарии, поэтому prompt-injection не должен суметь выполнить команду
// или прочитать ваши файлы. Claude Code запускается с полностью отключёнными инструментами и без MCP.
// У Codex CLI и Gemini CLI так отключить чтение файлов нельзя (песочница read-only всё равно читает
// диск), поэтому они работают, только если явно разрешить их в bridge.json: "allowToolAgents": ["codex"].
// Из запроса приходит только имя модели, поэтому произвольную программу через мост не запустить.
const CLI_PRESETS = {
  claude: { title: 'Claude Code', cmd: (m) => ['claude', '-p', '--output-format', 'text', '--tools', '', '--strict-mcp-config', ...(m ? ['--model', m] : [])] },
  codex: { title: 'OpenAI Codex CLI', unsafe: true, cmd: (m) => ['codex', 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', ...(m ? ['-m', m] : []), '-'] },
  gemini: { title: 'Gemini CLI', unsafe: true, cmd: (m) => ['gemini', ...(m ? ['-m', m] : [])] },
};
const toolAgentAllowed = (name) => config.allowToolAgents === true || (Array.isArray(config.allowToolAgents) && config.allowToolAgents.includes(name));
const SAFE_NAME = /^[A-Za-z0-9][\w.\-/]{0,79}$/;

function which(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext.toLowerCase());
      if (dir && fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    }
  }
  return null;
}

function cliCommands() {
  const out = {};
  for (const [name, p] of Object.entries(CLI_PRESETS)) if (!p.unsafe || toolAgentAllowed(name)) out[name] = p;
  for (const [name, c] of Object.entries(config.cli || {})) {
    if (Array.isArray(c?.cmd) && c.cmd.length) out[name] = { title: c.title || name, cmd: () => c.cmd.map(String), custom: true };
  }
  return out;
}

let modelsCache = { t: 0, v: [] };
function cliModels() {
  if (Date.now() - modelsCache.t < 60_000) return modelsCache.v;
  const v = [];
  for (const [name, c] of Object.entries(cliCommands())) if (which(c.cmd('')[0])) v.push({ id: name, title: c.title });
  if (which('ollama')) {
    const r = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false });
    for (const line of (r.stdout || '').split('\n').slice(1)) {
      const m = line.trim().split(/\s+/)[0];
      if (m) v.push({ id: 'ollama/' + m, title: 'Ollama ' + m });
    }
  }
  modelsCache = { t: Date.now(), v };
  return v;
}

function resolveCli(model) {
  model = String(model || '').trim();
  let argv;
  if (model.startsWith('ollama/')) {
    const name = model.slice(7);
    if (!SAFE_NAME.test(name) || name.includes('..')) throw new Error('Некорректное имя модели Ollama');
    argv = ['ollama', 'run', name];
  } else {
    const [base, sub = ''] = model.split(':');
    const c = cliCommands()[base];
    if (!c && CLI_PRESETS[base]?.unsafe) {
      throw new Error(`${CLI_PRESETS[base].title} выключен: у него нельзя отключить чтение файлов, и вредный комментарий может заставить его прочитать ваши данные. Включить на свой риск: "allowToolAgents": ["${base}"] в ${CONFIG_FILE}`);
    }
    if (!c) throw new Error(`Неизвестный CLI «${model}». Доступно: ${cliModels().map((m) => m.id).join(', ') || 'ничего не найдено'}`);
    if (sub && (!SAFE_NAME.test(sub) || c.custom)) throw new Error('Некорректное имя модели после двоеточия');
    argv = c.cmd(sub);
  }
  const exe = which(argv[0]);
  if (!exe) throw new Error(`«${argv[0]}» не найден в PATH. Установите его, выполните вход и перезапустите мост.`);
  return [exe, ...argv.slice(1)];
}

function messagesToPrompt(messages) {
  if (!Array.isArray(messages)) throw new Error('messages должен быть списком');
  const parts = messages.filter((m) => m && typeof m === 'object').map((m) => {
    const content = Array.isArray(m.content) ? m.content.map((p) => p?.text || '').join('\n') : String(m.content ?? '');
    if (m.role === 'system') return `[Инструкции]\n${content}`;
    if (m.role === 'assistant') return `[Ответ ассистента]\n${content}`;
    return messages.length === 1 ? content : `[Пользователь]\n${content}`;
  });
  const prompt = parts.join('\n\n');
  if (prompt.length > MAX_PROMPT) throw new Error(`Слишком длинный запрос: ${prompt.length} символов`);
  return prompt;
}

// .cmd/.bat на Windows запускаются только через cmd.exe; аргументы у нас фиксированные или проверенные
const quoteWin = (a) => (a === '' ? '""' : /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
function spawnCli([exe, ...args], cwd) {
  const opts = { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWin };
  if (isWin && /\.(cmd|bat)$/i.test(exe)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[exe, ...args].map(quoteWin).join(' ')}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(exe, args, opts);
}

function killTree(p) {
  try {
    if (isWin) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-p.pid, 'SIGKILL');
  } catch { /* уже завершился */ }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
let running = 0;

async function runCli(model, messages) {
  const argv = resolveCli(model);
  const prompt = messagesToPrompt(messages);
  if (running >= MAX_PARALLEL_CLI) throw new Error('CLI занят другими запросами — повторите через минуту');
  running++;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tubecomment-cli-'));
  try {
    return await new Promise((resolve, reject) => {
      const p = spawnCli(argv, cwd);
      let out = '';
      let err = '';
      const timer = setTimeout(() => { killTree(p); reject(new Error(`CLI не ответил за ${CLI_TIMEOUT / 1000} с`)); }, CLI_TIMEOUT);
      p.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
      p.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        const text = out.replace(ANSI, '').trim();
        if (code !== 0 && !text) reject(new Error((err.replace(ANSI, '').trim() || `${path.basename(argv[0])} завершился с кодом ${code}`).slice(-800)));
        else resolve(text);
      });
      p.stdin.on('error', () => {});
      p.stdin.end(prompt, 'utf8');
    });
  } finally {
    running--;
    fs.rm(cwd, { recursive: true, force: true }, () => {});
  }
}

// ---------------------------------------------------------------- прокси (HTTP CONNECT и SOCKS5)
function readExactly(sock, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) {
        sock.off('data', onData); sock.off('error', reject);
        sock.pause(); // иначе байты, пришедшие до следующего слушателя (начало TLS), потеряются
        const rest = buf.subarray(n);
        if (rest.length) sock.unshift(rest);
        resolve(buf.subarray(0, n));
      }
    };
    sock.on('data', onData);
    sock.once('error', reject);
    sock.resume(); // после pause() подписка на 'data' сама поток не возобновляет
  });
}

async function socks5Tunnel(proxy, host, port) {
  const sock = net.connect(+proxy.port || 1080, proxy.hostname);
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  const user = decodeURIComponent(proxy.username || '');
  const pass = decodeURIComponent(proxy.password || '');
  sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
  const [, method] = await readExactly(sock, 2);
  if (method === 2) {
    const u = Buffer.from(user), p = Buffer.from(pass);
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const [, ok] = await readExactly(sock, 2);
    if (ok !== 0) throw new Error('SOCKS5: неверный логин или пароль прокси');
  } else if (method !== 0) throw new Error('SOCKS5: прокси не принял способ входа');
  const h = Buffer.from(host);
  const pb = Buffer.alloc(2); pb.writeUInt16BE(port);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, pb]));
  const head = await readExactly(sock, 4);
  if (head[1] !== 0) throw new Error('SOCKS5: прокси не смог подключиться к ' + host + ' (код ' + head[1] + ')');
  const skip = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readExactly(sock, 1))[0];
  await readExactly(sock, skip + 2);
  return sock;
}

function httpConnectTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    const mod = proxy.protocol === 'https:' ? https : http;
    const req = mod.request({ host: proxy.hostname, port: +proxy.port || (proxy.protocol === 'https:' ? 443 : 8080), method: 'CONNECT', path: `${host}:${port}`, headers });
    req.once('connect', (res, sock) => (res.statusCode === 200 ? resolve(sock) : reject(new Error(`Прокси ответил ${res.statusCode} на CONNECT`))));
    req.once('error', reject);
    req.end();
  });
}

async function tunnel(host, port) {
  const proxy = new URL(PROXY);
  if (/^socks5h?:$/.test(proxy.protocol)) return socks5Tunnel(proxy, host, port);
  if (/^https?:$/.test(proxy.protocol)) return httpConnectTunnel(proxy, host, port);
  throw new Error('Неподдерживаемый прокси: ' + proxy.protocol + ' (нужен http://, https:// или socks5://)');
}

const PASS_HEADERS = ['content-type', 'accept', 'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access', 'http-referer', 'x-title'];

async function forward(req, res, body) {
  const target = String(req.headers['x-tc-target'] || '').replace(/\/+$/, '');
  let base;
  try { base = new URL(target); } catch { return send(res, 400, { error: { message: 'Нет или неверный заголовок X-TC-Target' } }); }
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    return send(res, 400, { error: { message: 'Через мост можно ходить только на https-адреса' } });
  }
  const url = new URL(base.pathname.replace(/\/$/, '') + req.url.slice('/forward'.length), base);
  const headers = {};
  for (const h of PASS_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  if (body.length) headers['content-length'] = body.length;
  const isHttps = url.protocol === 'https:';
  const port = +url.port || (isHttps ? 443 : 80);
  const opts = { method: req.method, host: url.hostname, port, path: url.pathname + url.search, headers: { ...headers, host: url.host }, timeout: 180_000 };
  try {
    if (PROXY) {
      const raw = await tunnel(url.hostname, port);
      const sock = isHttps ? tls.connect({ socket: raw, servername: url.hostname }) : raw;
      opts.createConnection = () => sock;
      opts.agent = false;
    }
    const up = (isHttps ? https : http).request(opts, (r) => {
      res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json', ...cors(req) });
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('провайдер не ответил за 3 минуты')));
    up.on('error', (e) => { if (!res.headersSent) send(res, 502, { error: { message: `Мост не достучался до ${url.host}${PROXY ? ' через прокси' : ''}: ${e.message}` } }, req); });
    up.end(body);
  } catch (e) {
    send(res, 502, { error: { message: `Прокси: ${e.message}` } }, req);
  }
}

// ---------------------------------------------------------------- HTTP-сервер
// Защита: слушаем только 127.0.0.1; Host должен быть localhost (DNS-rebinding);
// Origin — только расширение TubeComment; заголовок X-TubeComment заставляет сайты делать
// preflight, который мы им не разрешаем. Запросы без Origin (curl от вашего же пользователя) допускаются.
function hostOk(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}
const originOf = (req) => String(req.headers.origin || '').replace(/\/$/, '');
const cors = (req) => (ALLOWED_ORIGINS.has(originOf(req)) ? { 'access-control-allow-origin': originOf(req) } : {});
function allowed(req) {
  if (!hostOk(req)) return false;
  const o = originOf(req);
  if (o && !ALLOWED_ORIGINS.has(o)) return false;
  return req.headers['x-tubecomment'] === '1';
}
function tokenOk(req) {
  const got = Buffer.from(String(req.headers['x-tubecomment-token'] || ''));
  return got.length === TOKEN.length && timingSafeEqual(got, TOKEN);
}

function send(res, code, obj, req) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...(req ? cors(req) : {}) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    if (!hostOk(req) || !ALLOWED_ORIGINS.has(originOf(req))) { res.writeHead(403); return res.end(); }
    res.writeHead(204, {
      ...cors(req),
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type, authorization, x-api-key, x-tubecomment, x-tubecomment-token, x-tc-target, anthropic-version, anthropic-dangerous-direct-browser-access, http-referer, x-title',
      'access-control-allow-private-network': 'true',
    });
    return res.end();
  }
  if (!allowed(req)) return send(res, 403, { error: { message: 'forbidden' } });
  if (!tokenOk(req)) return send(res, 401, { error: { message: 'Неверный токен моста. Скопируйте его из окна моста во вкладку «Модель» расширения' } }, req);
  try {
    const body = await readBody(req);
    if (req.url.startsWith('/forward/')) return forward(req, res, body);
    if (req.method === 'GET' && req.url === '/ping') {
      return send(res, 200, { ok: true, app: 'tubecomment-bridge', version: VERSION, proxy: PROXY ? maskProxy(PROXY) : '', clis: cliModels() }, req);
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(res, 200, { object: 'list', data: cliModels().map((m) => ({ id: m.id, object: 'model', owned_by: m.title })) }, req);
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const j = JSON.parse(body.toString('utf8') || '{}');
      const started = Date.now();
      try {
        const text = await runCli(j.model, j.messages);
        log(`CLI ${j.model}: ${text.length} симв. за ${((Date.now() - started) / 1000).toFixed(1)} с`);
        return send(res, 200, { id: 'cli-' + started, object: 'chat.completion', model: j.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }, req);
      } catch (e) {
        log(`CLI ${j.model}: ошибка — ${e.message}`);
        return send(res, 400, { error: { message: e.message } }, req);
      }
    }
    send(res, 404, { error: { message: 'not found' } }, req);
  } catch (e) {
    send(res, 500, { error: { message: e.message } }, req);
  }
});

// ---------------------------------------------------------------- автозапуск (Windows)
function autostart(install) {
  if (!isWin) {
    console.log('Автозапуск настраивается вручную: systemd --user (Linux) или LaunchAgent (macOS). Пример — в README.');
    return;
  }
  const dir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const file = path.join(dir, 'TubeComment Bridge.vbs');
  if (!install) {
    fs.rmSync(file, { force: true });
    console.log('Автозапуск выключен: ' + file);
    return;
  }
  const script = fileURLToPath(import.meta.url);
  const extra = PROXY ? ` --proxy ""${PROXY}""` : '';
  // VBS запускает node без окна консоли
  fs.writeFileSync(file, `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${script}""${extra}", 0, False\r\n`);
  console.log('Автозапуск включён: мост будет стартовать при входе в Windows.\n' + file);
}

if (process.argv.includes('--install-autostart')) autostart(true);
else if (process.argv.includes('--uninstall-autostart')) autostart(false);
else if (process.argv.includes('--show-token')) console.log(config.token);
else {
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Порт ${PORT} занят — мост уже запущен или порт занят другой программой.` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const clis = cliModels().map((m) => m.id);
    console.log(`TubeComment bridge ${VERSION} — http://127.0.0.1:${PORT}`);
    console.log(`  CLI-агенты: ${clis.length ? clis.join(', ') : 'не найдены (установите claude, codex, gemini или ollama)'}`);
    console.log(`  Прокси: ${PROXY ? maskProxy(PROXY) : 'нет (запросы к провайдерам идут напрямую)'}`);
    console.log(`  Настройки: ${CONFIG_FILE}`);
    console.log('');
    console.log(`  Токен для расширения (вкладка «Модель» → «Токен моста»):  ${config.token}`);
    console.log('');
    console.log('  Окно можно свернуть. Остановить — Ctrl+C.');
  });
}
