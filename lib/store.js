'use strict';

// Хранилище состояния photonnAI.
// - На Vercel (задан DATABASE_URL) — Postgres, таблица photonn_state (ключ -> JSONB).
// - Локально (нет DATABASE_URL) — файлы в data/, как раньше.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const FILES = {
  users: 'users.json',
  settings: 'settings.json',
  chats: 'chats.json',
  learning: 'learning.json',
  promos: 'promos.json',
  adTokens: 'adtokens.json',
  adStats: 'adstats.json',
  key: 'key.json',
  oauth: 'oauth.json',
  runtime: 'runtime.json'
};

const useDb = Boolean(process.env.DATABASE_URL);

let pool = null;
function db() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    const isLocal = /@localhost|@127\.0\.0\.1|sslmode=disable/i.test(url);
    pool = new (require('pg').Pool)({
      connectionString: url,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      max: 3
    });
  }
  return pool;
}

let writeChain = Promise.resolve();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return undefined; }
}

function readLocalFiles() {
  const out = {};
  for (const key of Object.keys(FILES)) {
    const v = readJson(path.join(DATA_DIR, FILES[key]));
    if (v !== undefined) out[key] = v;
  }
  return out;
}

async function loadAll() {
  if (!useDb) return readLocalFiles();
  await db().query('CREATE TABLE IF NOT EXISTS photonn_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const r = await db().query('SELECT key, value FROM photonn_state');
  if (r.rows.length) {
    const out = {};
    for (const row of r.rows) out[row.key] = row.value;
    return out;
  }
  // База пустая: если рядом лежат старые data/*.json — разово переносим их в базу.
  const seed = readLocalFiles();
  for (const key of Object.keys(seed)) {
    await db().query(
      'INSERT INTO photonn_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, JSON.stringify(seed[key])]
    );
  }
  return seed;
}

function save(key, value) {
  writeChain = writeChain.then(async () => {
    if (!useDb) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const file = path.join(DATA_DIR, FILES[key]);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, file);
      return;
    }
    await db().query(
      'INSERT INTO photonn_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [key, JSON.stringify(value)]
    );
  }).catch((e) => console.error('save ' + key + ':', e.message));
  return writeChain;
}

module.exports = { loadAll, save, useDb };
