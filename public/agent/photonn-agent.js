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
const { exec } = require('child_process');

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
  console.log('  --token <строка> свой токен; иначе случайный, печатается при старте');
  console.log('  --allow-exec     разрешить выполнение команд (по умолчанию выключено)');
  process.exit(0);
}

const PORT = Number(arg('port', process.env.AGENT_PORT || 8787));
const TOKEN = arg('token', crypto.randomBytes(16).toString('hex'));
const ALLOW_EXEC = flag('allow-exec');
let ROOT = path.resolve(arg('root', process.env.AGENT_ROOT || path.join(process.cwd(), 'photonn-workspace')));

fs.mkdirSync(ROOT, { recursive: true });
const BACKUP_DIR = path.join(ROOT, '.photonn-agent', 'backups');

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

const TOOLS = { list: doList, read: doRead, write: doWrite, patch: doPatch, exec: doExec };

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
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/health') return send(res, 200, { ok: true, version: VERSION, allowExec: ALLOW_EXEC });

  if (!sameToken(req.headers['x-agent-token'])) {
    return send(res, 401, { ok: false, error: 'неверный токен агента' });
  }

  if (url.pathname === '/info') {
    return send(res, 200, { ok: true, version: VERSION, root: ROOT, allowExec: ALLOW_EXEC, tools: Object.keys(TOOLS) });
  }

  if (url.pathname === '/workspace' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const next = path.resolve(String(body.root || ''));
      if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) throw new Error('папка не найдена');
      ROOT = next;
      console.log('[агент] рабочая папка:', ROOT);
      return send(res, 200, { ok: true, root: ROOT });
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

  return send(res, 404, { ok: false, error: 'нет такого пути' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  photonnAI Agent bridge ' + VERSION);
  console.log('  рабочая папка : ' + ROOT);
  console.log('  команды       : ' + (ALLOW_EXEC ? 'разрешены' : 'выключены (--allow-exec чтобы включить)'));
  console.log('  адрес         : http://127.0.0.1:' + PORT);
  console.log('');
  console.log('  ТОКЕН (вставь в окно «Агент» на сайте):');
  console.log('  ' + TOKEN);
  console.log('');
  console.log('  Остановить: Ctrl+C. Мост слушает только этот компьютер.');
});