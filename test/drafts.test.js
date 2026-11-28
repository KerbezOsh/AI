'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/drafts.js'), 'utf8');

function harness(indexedDB) {
  const window = { indexedDB };
  vm.runInNewContext(source, { window, setTimeout, clearTimeout });
  return window.PhotonnDrafts;
}

function json(value) { return JSON.parse(JSON.stringify(value)); }

// A small transaction mock preserves IndexedDB's important distinction:
// a successful request is not durable until the enclosing transaction commits.
function databaseFactory() {
  const records = new Map();
  let created = false;
  const control = { records, failTransactions: false, failOpen: false, hangOpen: false, opens: 0, closed: 0 };
  control.open = () => {
    control.opens++;
    const request = {};
    if (control.hangOpen) return request;
    setTimeout(() => {
      if (control.failOpen) { request.onerror(); return; }
      const db = {
        objectStoreNames: { contains: () => created },
        createObjectStore() { created = true; },
        close() { control.closed++; },
        transaction() {
          const transaction = {};
          transaction.objectStore = () => {
            function operation(kind, value) {
              const itemRequest = {};
              setTimeout(() => {
                if (control.failTransactions) {
                  transaction.error = new Error('Quota exceeded');
                  if (transaction.onabort) transaction.onabort();
                  return;
                }
                if (kind === 'get') itemRequest.result = records.has(value) ? structuredClone(records.get(value)) : undefined;
                if (kind === 'put') records.set(value.key, structuredClone(value));
                if (kind === 'delete') records.delete(value);
                if (transaction.oncomplete) transaction.oncomplete();
              }, 2);
              return itemRequest;
            }
            return { get: (key) => operation('get', key), put: (value) => operation('put', value), delete: (key) => operation('delete', key) };
          };
          return transaction;
        }
      };
      request.result = db;
      if (!created && request.onupgradeneeded) request.onupgradeneeded();
      if (request.onsuccess) request.onsuccess();
    }, 1);
    return request;
  };
  return control;
}

test('drafts: memory fallback preserves text and attachments, isolated by chat and owner', async () => {
  const drafts = harness();
  const file = { name: 'notes.txt', size: 5, type: 'text/plain', content: 'hello' };
  await drafts.set('chat-1', { text: 'unfinished', pendingFile: file }, 'user:a');
  assert.equal(drafts.persistent, false);
  assert.equal(drafts.error.code, 'DRAFT_STORAGE_UNAVAILABLE');
  assert.equal((await drafts.get('chat-1', 'user:a')).text, 'unfinished');
  assert.deepEqual(json((await drafts.get('chat-1', 'user:a')).pendingFile), file);
  assert.equal(await drafts.get('chat-1', 'user:b'), null);
  assert.equal(await drafts.get('chat-2', 'user:a'), null);
  await drafts.remove('chat-1', 'user:a');
  assert.equal(await drafts.get('chat-1', 'user:a'), null);
});

test('drafts: invocation-order queues prevent save/delete/load races', async () => {
  const drafts = harness(databaseFactory());
  const saved = drafts.set('chat', { text: 'first' }, 'owner');
  const loaded = drafts.get('chat', 'owner');
  const removed = drafts.remove('chat', 'owner');
  const afterRemoval = drafts.get('chat', 'owner');
  const newer = drafts.set('chat', { text: 'newer' }, 'owner');
  await drafts.flush();
  assert.equal((await saved).text, 'first');
  assert.equal((await loaded).text, 'first');
  assert.equal(await removed, undefined);
  assert.equal(await afterRemoval, null);
  assert.equal((await newer).text, 'newer');
  assert.equal((await drafts.get('chat', 'owner')).text, 'newer');
});

test('drafts: callers cannot mutate queued, returned or previously loaded records', async () => {
  const drafts = harness(databaseFactory());
  const original = { text: 'snapshot', pendingFile: { name: 'a.txt', size: 1, content: 'a' } };
  const saving = drafts.set('chat', original, 'owner');
  original.text = 'changed too late';
  original.pendingFile.content = 'changed too late';
  const saved = await saving;
  saved.pendingFile.content = 'mutated return';
  const loaded = await drafts.get('chat', 'owner');
  assert.equal(loaded.text, 'snapshot');
  assert.equal(loaded.pendingFile.content, 'a');
  loaded.text = 'mutated read';
  assert.equal((await drafts.get('chat', 'owner')).text, 'snapshot');
});

test('drafts: committed records survive reload and empty drafts delete them durably', async () => {
  const database = databaseFactory();
  const original = harness(database);
  const image = 'data:image/png;base64,' + Buffer.from('image bytes').toString('base64');
  await original.set('chat', { text: 'caption', pendingImage: image }, 'owner');
  assert.equal(original.persistent, true);
  assert.equal(original.error, null);
  const reloaded = harness(database);
  assert.equal((await reloaded.get('chat', 'owner')).pendingImage, image);
  await reloaded.set('chat', { text: '' }, 'owner');
  assert.equal(await harness(database).get('chat', 'owner'), null);
});

test('drafts: a failed write retains the latest draft and failed removal leaves a tombstone', async () => {
  const database = databaseFactory();
  const drafts = harness(database);
  await drafts.set('chat', { text: 'old' }, 'owner');
  database.failTransactions = true;
  await drafts.set('chat', { text: 'new unsaved text' }, 'owner');
  assert.equal(drafts.persistent, false);
  assert.equal(drafts.error.code, 'DRAFT_STORAGE_UNAVAILABLE');
  assert.equal((await drafts.get('chat', 'owner')).text, 'new unsaved text');
  await drafts.remove('chat', 'owner');
  assert.equal(await drafts.get('chat', 'owner'), null);
  assert.equal(database.opens, 1, 'unavailable storage should not be retried on every keystroke');
});

test('drafts: opening failures gracefully fall back without hanging or losing subsequent saves', async () => {
  const database = databaseFactory();
  database.failOpen = true;
  const drafts = harness(database);
  await drafts.set('chat', { text: 'one' }, 'owner');
  await drafts.set('chat', { text: 'two' }, 'owner');
  assert.equal((await drafts.get('chat', 'owner')).text, 'two');
  await drafts.flush();
  assert.equal(drafts.persistent, false);
});

test('drafts: oversized or malformed records reject without destroying an existing draft', async () => {
  const drafts = harness();
  await drafts.set('chat', { text: 'keep me' }, 'owner');
  const bad = [
    { text: 'x'.repeat(200001) },
    { pendingImage: 'https://example.com/image.png' },
    { pendingFile: { name: 'too-big.txt', size: 512 * 1024 + 1, content: '' } },
    { pendingFile: { name: 'x.txt', size: 1.5, content: 'x' } },
    { pendingImage: 'data:image/png;base64,YQ==', pendingFile: { name: 'x', size: 1, content: 'x' } }
  ];
  for (const draft of bad) await assert.rejects(drafts.set('chat', draft, 'owner'));
  assert.equal((await drafts.get('chat', 'owner')).text, 'keep me');
  await assert.rejects(drafts.get('chat', ''), (error) => error.code === 'DRAFT_INVALID_KEY');
});

test('drafts: keys cannot collide across owner/chat separators and data never includes extra properties', async () => {
  const drafts = harness(databaseFactory());
  await drafts.set('b:c', { text: 'one', token: 'ignored', extra: true }, 'a');
  await drafts.set('c', { text: 'two' }, 'a:b');
  const one = await drafts.get('b:c', 'a');
  assert.equal(one.text, 'one');
  assert.equal((await drafts.get('c', 'a:b')).text, 'two');
  assert.deepEqual(Object.keys(one).sort(), ['pendingFile', 'pendingImage', 'text', 'updatedAt']);
});
