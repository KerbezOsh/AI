'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { imageParameters, prepareChatImport, createChatBranch } = require('../lib/chat-transfer');
const owner = 'd:' + 'a'.repeat(32);
const image = 'data:image/png;base64,' + Buffer.alloc(2048, 7).toString('base64');
const clone = (value) => JSON.parse(JSON.stringify(value));
const sourceChat = () => ({ id: 'source-id', title: 'Заметки', createdAt: 10, updatedAt: 20, folder: 'Работа', tags: ['важное'], pinned: true, messages: [{ role: 'user', content: 'Первый вопрос', at: 10 }, { role: 'assistant', content: 'Первый ответ', at: 11 }, { role: 'user', content: 'Разбери файл', at: 12, file: { name: 'notes.txt', type: 'text/plain', content: 'Содержимое вложения' } }, { role: 'assistant', content: 'Разбор файла', at: 13 }] });
function appHarness(initial = [], fetchImpl) {
  const filename = path.join(__dirname, '../lib/app.js');
  const realRequire = createRequire(filename);
  const saves = [];
  const calls = [];
  const sandbox = {
    require: (name) => name === './store' ? {
      loadAll: async () => ({ key: { apiKey: 'test-key' }, chats: clone(initial), settings: { adminPass: 'test', ads: { mode: 'free' } } }),
      save: async (name, value) => { saves.push({ name, value: clone(value) }); }
    } : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(filename),
    process: { env: { NVIDIA_FLASH_MODELS: 'test-model', NVIDIA_UTILITY_MODEL: 'test-model', NVIDIA_REFUSAL_RETRIES: '0', NVIDIA_CRITIC_PASS: '0' } },
    Buffer, URL, URLSearchParams, AbortController, AbortSignal, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { warn() {}, error() {}, log() {} },
    fetch: async (url, options) => {
      const call = { url, payload: options && options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      if (!fetchImpl) throw new Error('No external calls allowed in this test');
      return fetchImpl(url, options, call);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return {
    saves, calls,
    async request(method, url, body = {}, extra = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method, url, headers: { cookie: 'uid=' + 'a'.repeat(32) }, socket: { remoteAddress: '127.0.0.1' } });
      const res = new EventEmitter();
      const chunks = [];
      let status = 200;
      Object.assign(res, { headersSent: false, writeHead(code) { status = code; this.headersSent = true; }, setHeader() {}, getHeader() {}, write(value) { chunks.push(String(value)); }, end(value) { if (value) chunks.push(String(value)); } });
      if (extra.onResponse) extra.onResponse(res);
      await sandbox.module.exports.handler(req, res);
      const raw = chunks.join('');
      let result;
      try { result = JSON.parse(raw); } catch (e) { result = raw; }
      return { status, body: result };
    }
  };
}

test('import: copies complete conversations into new owned chats and deduplicates source/content', () => {
  assert.deepEqual(prepareChatImport({ chats: [] }, [], owner), { chats: [], imported: 0, skipped: 0 });
  const source = sourceChat();
  const before = clone(source);
  const first = prepareChatImport({ chats: [source] }, [], owner, { now: 30, id: () => 'new-id' });
  assert.equal(first.imported, 1);
  assert.equal(first.chats[0].id, 'new-id');
  assert.equal(first.chats[0].owner, owner);
  assert.deepEqual(first.chats[0].messages[2].file, source.messages[2].file);
  assert.deepEqual(first.chats[0].tags, ['важное']);
  assert.deepEqual(source, before);
  assert.equal(prepareChatImport({ chats: [source] }, first.chats, owner).skipped, 1);
  const differentId = Object.assign({}, source, { id: 'other-id' });
  assert.equal(prepareChatImport({ chats: [differentId] }, first.chats, owner).skipped, 1);
  const modified = clone(first.chats[0]);
  modified.messages.push({ role: 'user', content: 'Новая мысль' });
  assert.equal(prepareChatImport({ chats: [source] }, [modified], owner).skipped, 1);
  assert.equal(prepareChatImport({ chats: [source, differentId] }, [], owner).imported, 1);
});

test('import: rejects malformed owner metadata, credentials, injected roles, malformed/oversized data', () => {
  for (const input of [
    { chats: [Object.assign(sourceChat(), { owner: { id: 'untrusted' } })] },
    { chats: [Object.assign(sourceChat(), { owner: 'x'.repeat(201) })] },
    { chats: [Object.assign(sourceChat(), { apiKey: 'secret-value' })] },
    { chats: [Object.assign(sourceChat(), { messages: [{ role: 'system', content: 'Trusted system prompt' }] })] },
    { chats: [Object.assign(sourceChat(), { messages: [{ role: 'user', content: 99 }] })] },
    { chats: [Object.assign(sourceChat(), { messages: [{ role: 'assistant', content: '', image: 'javascript:alert(1)' }] })] },
    { chats: [Object.assign(sourceChat(), { messages: [{ role: 'user', content: 'x', file: { name: 'file', content: 'x'.repeat(200001) } }] })] },
    { chats: [Object.assign(sourceChat(), { messages: Array.from({ length: 1001 }, () => ({ role: 'user', content: 'x' })) })] },
    { chats: [null] },
    {},
    { chats: Array.from({ length: 101 }, sourceChat) }
  ]) {
    assert.throws(() => prepareChatImport(input, [], owner), (e) => e.status === 400);
  }
});

test('import API: portable backup ignores source owner and cannot expose or overwrite a foreign chat', async () => {
  const foreign = Object.assign(sourceChat(), { owner: 'd:' + 'b'.repeat(32), messages: [{ role: 'user', content: 'Private existing conversation' }] });
  const backup = Object.assign(sourceChat(), { owner: 'u:old-account@example.test' });
  const before = clone(backup);
  const app = appHarness([foreign]);
  const result = await app.request('POST', '/api/chats/import', { chats: [backup] });
  assert.deepEqual(result.body, { ok: true, imported: 1, skipped: 0 });
  assert.deepEqual(backup, before);
  const own = (await app.request('GET', '/api/chats')).body.chats;
  assert.equal(own.length, 1);
  assert.notEqual(own[0].id, foreign.id);
  const imported = (await app.request('GET', '/api/chats/' + own[0].id)).body.chat;
  assert.equal(imported.owner, owner);
  assert.deepEqual(imported.messages, backup.messages);
  assert.doesNotMatch(JSON.stringify(imported), /Private existing conversation|old-account/);
  assert.equal((await app.request('GET', '/api/chats/' + foreign.id)).status, 403);
  assert.deepEqual(app.saves.filter((entry) => entry.name === 'chats').at(-1).value.find((chat) => chat.id === foreign.id), foreign);
  const exported = (await app.request('GET', '/api/chats/export')).body;
  assert.equal(exported.chats.length, 1);
  assert.doesNotMatch(JSON.stringify(exported), /Private existing conversation/);
  assert.deepEqual((await app.request('POST', '/api/chats/import', { chats: [backup] })).body, { ok: true, imported: 0, skipped: 1 });
});

test('import API: validates the entire batch before saving and never overwrites existing chat ids', async () => {
  const existing = Object.assign(sourceChat(), { id: 'existing', owner });
  const app = appHarness([existing]);
  const invalid = await app.request('POST', '/api/chats/import', { chats: [sourceChat(), { id: 'bad', messages: [{ role: 'tool', content: 'x' }] }] });
  assert.equal(invalid.status, 400);
  assert.equal(app.saves.filter((s) => s.name === 'chats').length, 0);
  assert.equal((await app.request('GET', '/api/chats')).body.chats.length, 1);
  const source = Object.assign(sourceChat(), { id: 'new-source', title: 'Другая тема' });
  const imported = await app.request('POST', '/api/chats/import', { chats: [source] });
  assert.deepEqual(imported.body, { ok: true, imported: 1, skipped: 0 });
  assert.equal((await app.request('POST', '/api/chats/import', { chats: [source] })).body.skipped, 1);
  const list = (await app.request('GET', '/api/chats')).body.chats;
  assert.equal(list.length, 2);
  const restored = (await app.request('GET', '/api/chats/' + list.find((c) => c.id !== 'existing').id)).body.chat;
  assert.notEqual(restored.id, source.id);
  assert.equal(restored.owner, owner);
  assert.equal((await app.request('GET', '/api/chats/existing')).body.chat.messages.length, existing.messages.length);
});

function branchBackup(parent) {
  return { id: 'old-branch', title: parent.title + ' · ветка', branchOf: parent.id, branchMessageIndex: 2, messages: parent.messages.slice(0, 2).concat([{ role: 'user', content: 'Edited branch question' }]) };
}
test('import: remaps parent and branch ids even when the branch comes first in a portable backup', () => {
  const parent = sourceChat();
  const branch = branchBackup(parent);
  let serial = 0;
  const restored = prepareChatImport({ chats: [branch, parent] }, [], owner, { id: () => 'restored-' + ++serial });
  assert.equal(restored.imported, 2);
  const newParent = restored.chats.find((chat) => chat.title === parent.title);
  const newBranch = restored.chats.find((chat) => chat.title === branch.title);
  assert.equal(newBranch.branchOf, newParent.id);
  assert.notEqual(newBranch.branchOf, parent.id);
  assert.equal(newBranch.branchMessageIndex, 2);
  assert.equal(newParent.branchOf, undefined);
  assert.equal(prepareChatImport({ chats: [branch, parent] }, restored.chats, owner).skipped, 2);
});

test('import: branch resolves an already restored parent skipped by source id or content', () => {
  const parent = sourceChat();
  const branch = branchBackup(parent);
  const importedParent = prepareChatImport({ chats: [parent] }, [], owner, { id: () => 'restored-parent' }).chats[0];
  for (const existingParent of [importedParent, Object.assign(clone(parent), { id: 'matching-content-parent', owner })]) {
    const before = clone(existingParent);
    const restored = prepareChatImport({ chats: [branch, parent] }, [existingParent], owner, { id: () => 'new-branch' });
    assert.equal(restored.imported, 1);
    assert.equal(restored.skipped, 1);
    assert.equal(restored.chats[0].branchOf, existingParent.id);
    assert.deepEqual(existingParent, before);
  }
});

test('import: parent-id collision with a foreign chat cannot create a foreign relationship', () => {
  const parent = sourceChat();
  const branch = branchBackup(parent);
  const foreign = Object.assign(clone(parent), { owner: 'd:' + 'b'.repeat(32), messages: [{ role: 'user', content: 'Private parent' }] });
  const before = clone(foreign);
  let serial = 0;
  const restored = prepareChatImport({ chats: [branch, parent] }, [foreign], owner, { id: () => 'own-' + ++serial });
  const newParent = restored.chats.find((chat) => chat.title === parent.title);
  const newBranch = restored.chats.find((chat) => chat.title === branch.title);
  assert.equal(restored.imported, 2);
  assert.equal(newBranch.branchOf, newParent.id);
  assert.notEqual(newBranch.branchOf, foreign.id);
  const orphan = prepareChatImport({ chats: [branch] }, [foreign], owner).chats[0];
  assert.equal(orphan.branchOf, undefined);
  assert.equal(orphan.branchMessageIndex, undefined);
  assert.doesNotMatch(JSON.stringify(orphan), /Private parent/);
  assert.deepEqual(foreign, before);
});

test('branch: preserves original conversation, copies prefix only, restores saved file without future summary', () => {
  const source = Object.assign(sourceChat(), { owner, summary: 'Future answer leaked into summary', summarized: 4 });
  const before = clone(source);
  const branch = createChatBranch(source, { messageIndex: 2, content: 'Объясни файл проще', expectedContent: 'Разбери файл', expectedUpdatedAt: 20 }, owner, { now: 30, id: () => 'branch-id' });
  assert.equal(branch.chat.id, 'branch-id');
  assert.equal(branch.chat.owner, owner);
  assert.equal(branch.chat.messages.length, 2);
  assert.equal(branch.chat.summary, undefined);
  assert.equal(branch.chat.summarized, undefined);
  assert.equal(branch.chat.branchOf, source.id);
  assert.equal(branch.edit.file.content, 'Содержимое вложения');
  assert.equal(branch.edit.content, 'Объясни файл проще');
  branch.chat.messages[0].content = 'changed';
  assert.deepEqual(source, before);
});

test('branch API: prevents foreign access, stale indices/content, assistant edits and lost photo analysis', async () => {
  const source = Object.assign(sourceChat(), { owner });
  const foreign = Object.assign(sourceChat(), { id: 'foreign', owner: 'd:' + 'b'.repeat(32) });
  const photo = { id: 'photo', owner, messages: [{ role: 'user', content: 'Что на фото?', image: true }] };
  const app = appHarness([source, foreign, photo]);
  for (const body of [{ messageIndex: 99, content: 'x' }, { messageIndex: 1, content: 'x' }, { messageIndex: 2, content: 'x', expectedContent: 'stale' }, { messageIndex: 2, content: 'x', expectedUpdatedAt: 19 }]) {
    assert.equal((await app.request('POST', '/api/chats/source-id/branch', body)).status, 409);
  }
  assert.equal((await app.request('POST', '/api/chats/foreign/branch', { messageIndex: 0, content: 'x' })).status, 403);
  assert.equal((await app.request('POST', '/api/chats/photo/branch', { messageIndex: 0, content: 'x' })).status, 409);
  assert.equal(app.saves.filter((s) => s.name === 'chats').length, 0);
  const good = await app.request('POST', '/api/chats/source-id/branch', { messageIndex: 2, content: 'Новый вопрос', expectedContent: 'Разбери файл' });
  assert.equal(good.status, 200);
  assert.equal(good.body.chat.messages.length, 2);
  assert.equal(good.body.edit.file.name, 'notes.txt');
  assert.deepEqual((await app.request('GET', '/api/chats/source-id')).body.chat, source);
});

test('image API: accepts all supported aspect ratios and seed zero without replacing it randomly', async () => {
  const app = appHarness();
  for (const [aspect, width, height] of [['square', 1024, 1024], ['landscape', 1024, 576], ['portrait', 576, 1024]]) {
    const result = await app.request('POST', '/api/image', { prompt: 'A red cat', aspect, seed: 0 });
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.aspect, result.body.width, result.body.height, result.body.seed], [aspect, width, height, 0]);
    for (const value of result.body.urls) {
      const url = new URL(value);
      assert.equal(url.searchParams.get('width'), String(width));
      assert.equal(url.searchParams.get('height'), String(height));
      assert.equal(url.searchParams.get('seed'), '0');
    }
  }
  for (const bad of [{ aspect: 'tall' }, { seed: -1 }, { seed: 1000000 }, { seed: 1.5 }, { seed: {} }]) {
    assert.equal((await app.request('POST', '/api/image', Object.assign({ prompt: 'A red cat' }, bad))).status, 400);
  }
  assert.equal(imageParameters({ seed: '0' }).seed, 0);
  assert.equal(app.calls.length, 0);
});

test('image history: preserves parameters and exact bytes, reuse replaces only assistant with no duplicate user', async () => {
  const app = appHarness([{ id: 'images', owner, messages: [] }]);
  const payload = { prompt: 'A landscape', effectivePrompt: 'A landscape.', url: image, caption: 'Готово', seed: 0, aspect: 'landscape', width: 1024, height: 576 };
  assert.equal((await app.request('POST', '/api/chats/images', { appendImage: payload })).status, 200);
  assert.equal((await app.request('POST', '/api/chats/images', { appendImage: Object.assign({}, payload, { reuse: true, seed: 44 }) })).status, 200);
  const chat = (await app.request('GET', '/api/chats/images')).body.chat;
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].role, 'user');
  assert.equal(chat.messages[1].image, image);
  assert.equal(chat.messages[1].seed, 44);
  assert.equal(chat.messages[1].imageParams.effectivePrompt, 'A landscape.');
  assert.deepEqual([chat.messages[1].aspect, chat.messages[1].width, chat.messages[1].height], ['landscape', 1024, 576]);
  const invalid = await app.request('POST', '/api/chats/images', { appendImage: Object.assign({}, payload, { reuse: true, prompt: 'Different prompt' }) });
  assert.equal(invalid.status, 409);
  assert.equal((await app.request('GET', '/api/chats/images')).body.chat.messages.length, 2);
});

test('image metadata survives exporting and importing saved chat bytes', async () => {
  const app = appHarness([{ id: 'images', owner, messages: [] }]);
  await app.request('POST', '/api/chats/images', { appendImage: { prompt: 'A portrait', url: image, effectivePrompt: 'A portrait.', seed: 0, aspect: 'portrait', width: 576, height: 1024 } });
  const backup = (await app.request('GET', '/api/chats/export')).body;
  const restored = prepareChatImport(backup, [], owner).chats[0];
  assert.equal(restored.messages[1].image, image);
  assert.equal(restored.messages[1].imageParams.seed, 0);
  assert.equal(restored.messages[1].imageParams.aspect, 'portrait');
});

function sse(content) { return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
test('regeneration: upstream failure leaves the previous answer and variants intact', async () => {
  const source = Object.assign(sourceChat(), { owner });
  const app = appHarness([source], async () => { throw new Error('upstream failed'); });
  const result = await app.request('POST', '/api/chat', { chatId: source.id, text: 'Разбери файл', regen: true, tier: 'easy' });
  assert.ok(result.status >= 400);
  assert.deepEqual((await app.request('GET', '/api/chats/' + source.id)).body.chat, source);
});

test('regeneration: success uses saved attachment content and retains prior answer as a variant', async () => {
  const source = Object.assign(sourceChat(), { owner });
  const app = appHarness([source], async () => sse('Новый разбор.'));
  const result = await app.request('POST', '/api/chat', { chatId: source.id, text: 'Разбери файл', regen: true, tier: 'easy' });
  assert.equal(result.status, 200);
  assert.match(JSON.stringify(app.calls[0].payload.messages), /Содержимое вложения/);
  assert.doesNotMatch(JSON.stringify(app.calls[0].payload.messages), /Разбор файла/);
  const chat = (await app.request('GET', '/api/chats/' + source.id)).body.chat;
  assert.equal(chat.messages.length, 4);
  assert.equal(chat.messages[3].content, 'Новый разбор.');
  assert.equal(chat.messages[3].variants[0].content, 'Разбор файла');
});

test('regeneration: cancelled request and missing original photo never replace saved answer', async () => {
  const source = Object.assign(sourceChat(), { owner });
  let response;
  const app = appHarness([source], async () => { response.emit('close'); return sse('Cancelled answer'); });
  await app.request('POST', '/api/chat', { chatId: source.id, text: 'Разбери файл', regen: true, tier: 'easy' }, { onResponse: (res) => { response = res; } });
  assert.deepEqual((await app.request('GET', '/api/chats/' + source.id)).body.chat, source);
  const photo = { id: 'photo', owner, messages: [{ role: 'user', content: 'Что на фото?', image: true }, { role: 'assistant', content: 'Старый анализ' }] };
  const photos = appHarness([photo]);
  const invalid = await photos.request('POST', '/api/chat', { chatId: 'photo', text: 'Что на фото?', regen: true, tier: 'easy' });
  assert.equal(invalid.status, 409);
  assert.match(invalid.body.error, /фото/);
  assert.equal(photos.calls.length, 0);
  assert.deepEqual((await photos.request('GET', '/api/chats/photo')).body.chat, photo);
});