#!/usr/bin/env node
// photonnAI Agent bridge: локальный мост, через который веб-интерфейс photonnAI
// читает и правит файлы на этом компьютере. Запуск:
//   node photonn-agent.js --root ./my-project
// Токен печатается в консоли и вставляется в окно «Агент» на сайте.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { exec, spawn, execFileSync } = require('child_process');

const VERSION = '1.0.0';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_READ = 200 * 1024;
const MAX_LIST = 2000;
const MAX_OUT = 20000;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.indexOf('--' + name) >= 0;

if (flag('help')) {
  console.log('photonnAI Agent bridge ' + VERSION);
  console.log('');
  console.log('  node photonn-agent.js --root <папка> [--port 8787] [--token <токен>] [--allow-exec]');
  console.log('');
  console.log('  --root <папка>   что агент имеет право читать и менять (по умолчанию ./photonn-workspace)');
  console.log('  --port <n>       порт на 127.0.0.1, по умолчанию 8787');
  console.log('  --token <строка> свой токен; иначе сохраняется в рабочей папке и переживает перезапуск');
  console.log('  --pair <код>     свой код подключения; иначе случайный, печатается при старте');
  console.log('  --allow-exec     разрешить выполнение команд (по умолчанию выключено)');
  console.log('  --mcp <файл>     конфиг MCP-серверов (по умолчанию photonn-mcp.json в рабочей папке)');
  console.log('');
  console.log('  Обычный запуск: двойной клик по start-agent.cmd — код подключения будет в окне.');
  process.exit(0);
}

const PORT = Number(arg('port', process.env.AGENT_PORT || 8787));
const ALLOW_EXEC = flag('allow-exec');
let ROOT = path.resolve(arg('root', process.env.AGENT_ROOT || path.join(process.cwd(), 'photonn-workspace')));

fs.mkdirSync(ROOT, { recursive: true });
const BACKUP_DIR = path.join(ROOT, '.photonn-agent', 'backups');

// Токен переживает перезапуск: иначе после каждого старта сайт пришлось бы подключать заново.
function loadToken() {
  const fixed = arg('token', '');
  if (fixed) return fixed;
  const file = path.join(ROOT, '.photonn-agent', 'token');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 24) return saved;
  } catch (e) {}
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch (e) {}
  return token;
}
const TOKEN = loadToken();

// Код подключения: короткий, одноразовый, живёт только этот запуск моста.
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makePairCode() {
  const b = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += PAIR_ALPHABET[b[i] % PAIR_ALPHABET.length];
  return s.slice(0, 3) + '-' + s.slice(3);
}
const PAIR_FIXED = String(arg('pair', '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
let PAIR_CODE = PAIR_FIXED || makePairCode();
let PAIR_USED = false;
let pairFails = 0;
let pairLockUntil = 0;

function sameToken(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function insideRoot(target) {
  const rel = path.relative(ROOT, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

// Резолвим путь внутри рабочей папки. Симлинки проверяем по реальному пути
// ближайшего существующего родителя — иначе через них можно выйти наружу.
function resolveInRoot(relPath) {
  const raw = String(relPath || '.').replace(/\\/g, '/');
  if (path.isAbsolute(raw)) throw new Error('абсолютный путь запрещён');
  const target = path.resolve(ROOT, raw);
  if (!insideRoot(target)) throw new Error('путь вне рабочей папки');
  let probe = target;
  while (!fs.existsSync(probe) && probe !== ROOT) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (!insideRoot(real)) throw new Error('путь ведёт за пределы рабочей папки через ссылку');
  return target;
}

function relOf(target) {
  const rel = path.relative(ROOT, target) || '.';
  return rel.split(path.sep).join('/');
}

async function backup(target) {
  if (!fs.existsSync(target)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, stamp + '__' + relOf(target).replace(/[\\/]/g, '__'));
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(target, dest);
  return dest;
}

async function doList(args) {
  const target = resolveInRoot(args.path || '.');
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const visible = entries.filter((e) => e.name !== '.photonn-agent');
  const out = visible.slice(0, MAX_LIST).map((e) => {
    const full = path.join(target, e.name);
    let size = 0;
    try { size = e.isFile() ? fs.statSync(full).size : 0; } catch (err) {}
    return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size };
  });
  return { path: relOf(target), entries: out, total: visible.length, truncated: visible.length > MAX_LIST };
}

async function doRead(args) {
  const target = resolveInRoot(args.path);
  const st = await fsp.stat(target);
  if (!st.isFile()) throw new Error('это не файл');
  if (st.size > MAX_READ * 8) throw new Error('файл слишком большой (' + st.size + ' байт)');
  const buf = await fsp.readFile(target);
  if (buf.includes(0)) throw new Error('бинарный файл, читать нельзя');
  const text = buf.subarray(0, MAX_READ).toString('utf8');
  return { path: relOf(target), size: st.size, truncated: st.size > MAX_READ, content: text };
}

async function doWrite(args) {
  const target = resolveInRoot(args.path);
  const content = String(args.content == null ? '' : args.content);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const saved = await backup(target);
  await fsp.writeFile(target, content, 'utf8');
  return { path: relOf(target), bytes: Buffer.byteLength(content), backup: saved ? relOf(saved) : null };
}

async function doPatch(args) {
  const target = resolveInRoot(args.path);
  const old = String(args.old == null ? '' : args.old);
  const neu = String(args.new == null ? '' : args.new);
  if (!old) throw new Error('пустой old');
  const text = await fsp.readFile(target, 'utf8');
  const first = text.indexOf(old);
  if (first < 0) throw new Error('фрагмент не найден');
  if (text.indexOf(old, first + 1) >= 0) throw new Error('фрагмент встречается больше одного раза — уточни old');
  const saved = await backup(target);
  const updated = text.slice(0, first) + neu + text.slice(first + old.length);
  await fsp.writeFile(target, updated, 'utf8');
  return { path: relOf(target), bytes: Buffer.byteLength(updated), backup: saved ? relOf(saved) : null };
}

function doExec(args) {
  if (!ALLOW_EXEC) throw new Error('выполнение команд выключено: перезапусти мост с --allow-exec');
  const cwd = args.cwd ? resolveInRoot(args.cwd) : ROOT;
  const cmd = String(args.cmd || '').trim();
  if (!cmd) throw new Error('пустая команда');
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '').slice(0, MAX_OUT);
      const errOut = String(stderr || '').slice(0, MAX_OUT);
      if (err && err.killed) return reject(new Error('команда не уложилась в 120 с'));
      resolve({ cmd, cwd: relOf(cwd), code: err && err.code != null ? err.code : 0, stdout: out, stderr: errOut });
    });
  });
}


// ── MCP: инструменты с локальных MCP-серверов пользователя ─────────
// Конфиг: photonn-mcp.json в рабочей папке (или --mcp <файл>).
// stdio-серверы: {command, args, env, cwd}; HTTP-серверы: {url, headers}.

const MCP_FILE = arg('mcp', '');
const MCP = { file: '', servers: new Map(), tools: [], errors: [] };

function mcpResult(result) {
  const parts = result && Array.isArray(result.content) ? result.content : [];
  const texts = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
  if (result && result.structuredContent) texts.push(JSON.stringify(result.structuredContent));
  const other = parts.filter((p) => p && p.type !== 'text').map((p) => '[' + p.type + ']');
  const text = texts.join('\n') || other.join(', ') || '(пусто)';
  return { text: text.slice(0, MAX_OUT), isError: Boolean(result && result.isError) };
}

class StdioMcp {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.proc = null;
    this.buf = '';
    this.id = 0;
    this.pending = new Map();
    this.tools = [];
  }
  onData(chunk) {
    this.buf += chunk.toString('utf8');
    if (this.buf.length > 8 * 1024 * 1024) {
      this.buf = '';
      for (const p of this.pending.values()) p.reject(new Error('MCP-сервер прислал слишком большой ответ'));
      this.pending.clear();
      killTree(this.proc);
      return;
    }
    let cut;
    while ((cut = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg && msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'ошибка MCP'));
        else p.resolve(msg.result || {});
      }
    }
  }
  send(obj) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('MCP-процесс не запущен');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }
  request(method, params, timeout) {
    const ms = timeout || 45000;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP: нет ответа на ' + method + ' за ' + Math.round(ms / 1000) + ' с'));
      }, ms);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try { this.send({ jsonrpc: '2.0', id: id, method: method, params: params || {} }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  notify(method, params) {
    try { this.send({ jsonrpc: '2.0', method: method, params: params || {} }); } catch (e) {}
  }
  async start() {
    try {
      return await this.boot(this.cfg.shell != null ? Boolean(this.cfg.shell) : false);
    } catch (e) {
      // На Windows npx/команды из PATH запускаются только через shell.
      if (process.platform === 'win32' && this.cfg.shell == null && /ENOENT|не найден/i.test(e.message)) {
        return await this.boot(true);
      }
      throw e;
    }
  }
  async boot(shell) {
    const env = Object.assign({}, process.env, this.cfg.env || {});
    this.pending.clear();
    this.buf = '';
    this.proc = spawn(String(this.cfg.command), Array.isArray(this.cfg.args) ? this.cfg.args.map(String) : [], {
      cwd: this.cfg.cwd ? resolveInRoot(this.cfg.cwd) : ROOT,
      env: env,
      shell: shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => { if (process.env.AGENT_DEBUG) console.log('[mcp:' + this.name + '] ' + String(d).trim().slice(0, 400)); });
    this.proc.on('error', (e) => { for (const p of this.pending.values()) p.reject(new Error('MCP не запустился: ' + e.message)); this.pending.clear(); });
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error('MCP-сервер завершился (код ' + code + ')'));
      this.pending.clear();
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'photonn-agent', version: VERSION }
    }, 60000);
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {}, 60000);
    this.tools = (list && Array.isArray(list.tools)) ? list.tools : [];
    return this.tools;
  }
  async call(name, args) {
    const r = await this.request('tools/call', { name: name, arguments: args || {} }, 120000);
    return mcpResult(r);
  }
  stop() { killTree(this.proc); }
}

class HttpMcp {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.id = 0;
    this.sessionId = '';
    this.tools = [];
  }
  headers() {
    return Object.assign({
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }, this.cfg.headers || {}, this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {});
  }
  async request(method, params, timeout) {
    const ms = timeout || 45000;
    const id = ++this.id;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(String(this.cfg.url), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }),
        signal: ctrl.signal
      });
      if (!r.ok) throw new Error('MCP HTTP ' + r.status + ' ' + (r.statusText || ''));
      const sid = r.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const ct = String(r.headers.get('content-type') || '');
      let msg = null;
      if (ct.indexOf('text/event-stream') >= 0) {
        const txt = await r.text();
        for (const line of txt.split('\n')) {
          if (line.indexOf('data:') !== 0) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const o = JSON.parse(raw);
            if (o && (o.id === id || o.result || o.error)) { msg = o; break; }
          } catch (e) {}
        }
      } else {
        msg = await r.json();
      }
      if (!msg) throw new Error('MCP HTTP: пустой ответ');
      if (msg.error) throw new Error(msg.error.message || 'ошибка MCP');
      return msg.result || {};
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('MCP HTTP: нет ответа за ' + Math.round(ms / 1000) + ' с');
      throw e;
    } finally { clearTimeout(timer); }
  }
  notify(method, params) {
    fetch(String(this.cfg.url), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} })
    }).catch(() => {});
  }
  async start() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'photonn-agent', version: VERSION }
    }, 60000);
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {}, 60000);
    this.tools = (list && Array.isArray(list.tools)) ? list.tools : [];
    return this.tools;
  }
  async call(name, args) {
    const r = await this.request('tools/call', { name: name, arguments: args || {} }, 120000);
    return mcpResult(r);
  }
  stop() {}
}

// Последовательные перезагрузки: иначе два reload подряд могут поднять серверы дважды.
let mcpLoading = Promise.resolve();
function loadMcpServers() {
  mcpLoading = mcpLoading.then(loadMcpServersNow, loadMcpServersNow);
  return mcpLoading;
}

async function loadMcpServersNow() {
  for (const s of MCP.servers.values()) { try { s.stop(); } catch (e) {} }
  MCP.servers.clear();
  MCP.tools = [];
  MCP.errors = [];
  const file = MCP_FILE ? path.resolve(MCP_FILE) : path.join(ROOT, 'photonn-mcp.json');
  MCP.file = file;
  if (!fs.existsSync(file)) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { MCP.errors.push('photonn-mcp.json: ' + e.message); return; }
  const list = cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mcp';
  for (const name of Object.keys(list).slice(0, 20)) {
    const sc = list[name] || {};
    try {
      const client = sc.url ? new HttpMcp(name, sc) : sc.command ? new StdioMcp(name, sc) : null;
      if (!client) throw new Error('нужен command или url');
      const tools = await client.start();
      MCP.servers.set(name, client);
      const prefix = safe(name);
      for (const t of tools.slice(0, 200)) {
        if (!t || !t.name) continue;
        MCP.tools.push({
          server: name,
          name: prefix + '__' + safe(t.name),
          orig: String(t.name),
          description: String(t.description || '').slice(0, 600),
          inputSchema: t.inputSchema || null
        });
      }
      console.log('[mcp] ' + name + ': ' + tools.length + ' инстр.');
    } catch (e) {
      MCP.errors.push(name + ': ' + e.message);
      console.log('[mcp] ' + name + ': ошибка — ' + e.message);
    }
  }
}

function mcpState() {
  return {
    ok: true,
    file: MCP.file,
    errors: MCP.errors.slice(0, 20),
    servers: [...MCP.servers.keys()].map((name) => ({ name: name, tools: (MCP.servers.get(name).tools || []).length })),
    tools: MCP.tools.map((t) => ({ name: t.name, server: t.server, description: t.description, inputSchema: t.inputSchema }))
  };
}

function doMcp(args) {
  const name = String(args.name || '');
  const tool = MCP.tools.find((t) => t.name === name);
  if (!tool) throw new Error('MCP-инструмент не найден: ' + name + ' (перезагрузи MCP в окне агента)');
  const client = MCP.servers.get(tool.server);
  if (!client) throw new Error('MCP-сервер не подключён: ' + tool.server);
  const params = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
  return client.call(tool.orig, params);
}

const TOOLS = { list: doList, read: doRead, write: doWrite, patch: doPatch, exec: doExec, mcp: doMcp };

// Убиваем всё дерево: на Windows shell-обёртка оставляет дочерний процесс жить.
function killTree(proc) {
  if (!proc || proc.killed || !proc.pid) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    return;
  }
  try { proc.kill('SIGTERM'); } catch (e) {}
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('невалидный JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
  res.setHeader('Access-Control-Max-Age', '600');
  // Chrome спрашивает разрешение на запрос к 127.0.0.1 с публичного сайта (Private Network Access).
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Защита от DNS rebinding: мост отвечает только на своё имя.
  const host = String(req.headers.host || '');
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
    return send(res, 403, { ok: false, error: 'мост принимает запросы только на 127.0.0.1' });
  }

  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/health') return send(res, 200, { ok: true, version: VERSION, allowExec: ALLOW_EXEC, pairAvailable: !PAIR_USED });

  // Подключение по короткому коду: токен отдаётся один раз и только за правильный код.
  if (url.pathname === '/pair' && req.method === 'POST') {
    if (Date.now() < pairLockUntil) return send(res, 429, { ok: false, error: 'слишком много попыток — подожди 10 минут' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    const got = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const want = PAIR_CODE.replace(/[^A-Z0-9]/g, '');
    const ok = !PAIR_USED && got.length > 0 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!ok) {
      pairFails++;
      if (pairFails >= 10) { pairLockUntil = Date.now() + 10 * 60000; pairFails = 0; }
      return send(res, 403, { ok: false, error: PAIR_USED ? 'код уже использован — перезапусти мост' : 'код не подошёл' });
    }
    PAIR_USED = true;
    PAIR_CODE = '';
    console.log('[агент] сайт подключён по коду');
    return send(res, 200, { ok: true, token: TOKEN, root: ROOT, allowExec: ALLOW_EXEC });
  }

  if (!sameToken(req.headers['x-agent-token'])) {
    return send(res, 401, { ok: false, error: 'неверный токен агента' });
  }

  if (url.pathname === '/info') {
    return send(res, 200, { ok: true, version: VERSION, root: ROOT, allowExec: ALLOW_EXEC, tools: Object.keys(TOOLS), mcpServers: MCP.servers.size, mcpTools: MCP.tools.length, mcpFile: MCP.file });
  }

  if (url.pathname === '/workspace' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const next = path.resolve(String(body.root || ''));
      if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) throw new Error('папка не найдена');
      ROOT = next;
      console.log('[агент] рабочая папка:', ROOT);
      await loadMcpServers();
      return send(res, 200, { ok: true, root: ROOT, mcpTools: MCP.tools.length });
    } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
  }

  if (url.pathname === '/call' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const fn = TOOLS[String(body.tool || '')];
      if (!fn) throw new Error('неизвестный инструмент: ' + body.tool);
      const result = await fn(body.args && typeof body.args === 'object' ? body.args : {});
      return send(res, 200, { ok: true, result });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  if (url.pathname === '/undo' && req.method === 'POST') {
    try {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      const files = await fsp.readdir(BACKUP_DIR).catch(() => []);
      if (!files.length) return send(res, 200, { ok: false, error: 'нет резервных копий' });
      const sorted = files.sort();
      const latest = sorted[sorted.length - 1];
      const backupPath = path.join(BACKUP_DIR, latest);
      const content = await fsp.readFile(backupPath, 'utf8');
      const target = resolveInRoot(latest.replace(/^\d+-/, ''));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, 'utf8');
      await fsp.unlink(backupPath).catch(() => {});
      return send(res, 200, { ok: true, restored: relOf(target) });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  if (url.pathname === '/mcp' && req.method === 'GET') {
    return send(res, 200, mcpState());
  }

  if (url.pathname === '/mcp/reload' && req.method === 'POST') {
    try {
      await loadMcpServers();
      return send(res, 200, mcpState());
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  return send(res, 404, { ok: false, error: 'нет такого пути' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  photonnAI Agent bridge ' + VERSION);
  console.log('  рабочая папка : ' + ROOT);
  console.log('  команды       : ' + (ALLOW_EXEC ? 'разрешены' : 'выключены (--allow-exec чтобы включить)'));
  console.log('  адрес         : http://127.0.0.1:' + PORT);
  console.log('');
  const code = PAIR_CODE || '(код уже использован)';
  const line = '  КОД ПОДКЛЮЧЕНИЯ:  ' + code;
  console.log('  ' + '-'.repeat(line.length));
  console.log(line);
  console.log('  ' + '-'.repeat(line.length));
  console.log('');
  console.log('  Открой сайт photonnAI → кнопка «Агент» → введи этот код.');
  console.log('  Код одноразовый; токен сохраняется в папке и переживает перезапуск.');
  console.log('  Токен для ручного режима: ' + TOKEN);
  console.log('');
  console.log('  Остановить: Ctrl+C. Мост слушает только этот компьютер.');
  loadMcpServers().then(() => {
    if (!MCP.tools.length && !MCP.errors.length) return;
    console.log('');
    console.log('  MCP: ' + MCP.servers.size + ' сервер(ов), ' + MCP.tools.length + ' инструмент(ов)');
    if (MCP.errors.length) console.log('  MCP ошибки: ' + MCP.errors.join(' | '));
  });
});

process.on('SIGINT', () => {
  for (const s of MCP.servers.values()) { try { s.stop(); } catch (e) {} }
  process.exit(0);
});