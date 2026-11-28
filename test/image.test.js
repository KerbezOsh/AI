'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const path = require('node:path');
const { imageTranslationMessages, parseImageTranslation } = require('../lib/image-prompt');
const fields = 'Сгенерируй картинку с красивыми полями';

test('image prompt: fields are clarified, explicit margins and portraits are preserved', () => {
  assert.match(JSON.parse(imageTranslationMessages(fields)[1].content).clarification, /landscape fields/);
  for (const source of ['Сделай поля вокруг портрета', 'Поля страницы документа', 'Нарисуй футбольное поле', 'Нарисуй магнитные поля двух магнитов', 'Нарисуй шахматную доску с разноцветными полями']) {
    assert.equal(JSON.parse(imageTranslationMessages(source)[1].content).clarification, '');
  }
  assert.equal(parseImageTranslation(fields, 'A landscape with beautiful fields.', 'stop'), 'A landscape with beautiful fields.');
  assert.throws(() => parseImageTranslation(fields, 'A portrait with decorative margins.', 'stop'));
  assert.throws(() => parseImageTranslation(fields, 'A landscape with fields and decorative borders.', 'stop'));
});

test('image prompt: rejects empty, untranslated, truncated and reasoning-only responses', () => {
  for (const [content, reason] of [['', 'stop'], [fields, 'stop'], ['A landscape with fields', 'length'], ['<think>reasoning</think>', 'stop'], ['x'.repeat(501), 'stop']]) {
    assert.throws(() => parseImageTranslation(fields, content, reason));
  }
  const sign = 'A sign reading "Привет, мир".';
  assert.equal(parseImageTranslation('Нарисуй вывеску «Привет, мир»', sign, 'stop'), sign);
});

function appHarness(key, replies) {
  const filename = path.join(__dirname, '../lib/app.js');
  const realRequire = createRequire(filename);
  const calls = [];
  const saved = {};
  const chat = { id: 'image-test', title: 'Новый чат', messages: [], owner: 'd:' + 'a'.repeat(32) };
  const store = {
    loadAll: async () => ({ key: key ? { apiKey: 'test-key' } : null, chats: [chat], settings: { adminPass: 'test', ads: { mode: 'free' } } }),
    save: async (name, value) => { saved[name] = value; }
  };
  const sandbox = {
    require: (name) => name === './store' ? store : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(filename),
    process: { env: {} }, Buffer, URL, URLSearchParams, AbortController, AbortSignal,
    setTimeout, clearTimeout, console: { warn() {}, error() {}, log() {} },
    fetch: async (url, options) => {
      calls.push({ url, payload: JSON.parse(options.body) });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return { ok: true, json: async () => reply };
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return {
    calls, saved,
    post(url, body) { return this.request('POST', url, body); },
    async request(method, url, body = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method, url, headers: { cookie: 'uid=' + 'a'.repeat(32) }, socket: { remoteAddress: '127.0.0.1' } });
      let status, result;
      const res = { headersSent: false, writeHead(code) { status = code; }, setHeader() {}, getHeader() {}, end(value) { result = JSON.parse(value); } };
      await sandbox.module.exports.handler(req, res);
      return { status, body: result };
    }
  };
}
const completion = (content, finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }] });

test('image API: screenshot request uses faithful translation with enhancement disabled', async () => {
  const app = appHarness(true, [completion('A landscape with beautiful fields.')]);
  const r = await app.post('/api/image', { prompt: fields, seed: 123 });
  assert.equal(r.status, 200);
  assert.equal(r.body.effectivePrompt, 'A landscape with beautiful fields.');
  assert.equal(app.calls[0].payload.chat_template_kwargs.thinking, false);
  for (const url of r.body.urls) {
    const u = new URL(url);
    assert.equal(decodeURIComponent(u.pathname).includes(r.body.effectivePrompt), true);
    assert.equal(u.searchParams.get('enhance'), 'false');
  }
});

test('image API: invalid translation uses backup instead of sending Russian', async () => {
  const app = appHarness(true, [completion(''), completion('A landscape with beautiful fields.')]);
  const r = await app.post('/api/image', { prompt: fields });
  assert.equal(r.status, 200);
  assert.equal(app.calls.length, 2);
});

test('image API: failed translation never produces a generator URL', async () => {
  const app = appHarness(true, [completion(fields), completion('A portrait with margins.')]);
  const r = await app.post('/api/image', { prompt: fields });
  assert.equal(r.status, 502);
  assert.equal(r.body.urls, undefined);
});

test('image API: no-key Russian request fails clearly; English works without translation', async () => {
  const app = appHarness(false, []);
  const ru = await app.post('/api/image', { prompt: fields });
  assert.equal(ru.status, 503);
  const en = await app.post('/api/image', { prompt: 'A red cat' });
  assert.equal(en.status, 200);
  assert.equal(en.body.effectivePrompt, 'A red cat');
  assert.equal(app.calls.length, 0);
});


test('image history: persists and reloads the same large data URL without generator fallbacks', async () => {
  const app = appHarness(false, []);
  const dataUrl = 'data:image/jpeg;base64,' + Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
  const saved = await app.post('/api/chats/image-test', { appendImage: { prompt: 'A landscape', url: dataUrl, caption: 'Картинка готова.' } });
  assert.equal(saved.status, 200);
  const loaded = await app.request('GET', '/api/chats/image-test');
  assert.equal(loaded.status, 200);
  const image = loaded.body.chat.messages.at(-1);
  assert.equal(image.image, dataUrl);
  assert.equal(image.imageChain, undefined);
  const tooLarge = await app.post('/api/chats/image-test', { appendImage: { url: 'data:image/jpeg;base64,' + 'a'.repeat(6 * 1024 * 1024) } });
  assert.equal(tooLarge.status, 400);
});

test('browser generation: displayed bytes are saved instead of a generator URL', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('async function fetchImageObject(url, signal) {');
  const end = source.indexOf('async function exportChats()', start);
  const bytes = Buffer.alloc(4096, 42);
  const expected = 'data:image/jpeg;base64,' + bytes.toString('base64');
  let saved;
  const state = { currentId: 'image-test', messages: [{ role: 'user', content: fields }] };
  const node = () => ({ appendChild() {}, querySelector() { return { textContent: '' }; }, remove() {}, parentNode: null });
  const sandbox = {
    module: { exports: {} }, state, uiLang: 'ru', AbortController, DOMException, setTimeout, clearTimeout, readImageOptions: () => ({aspect:'square'}),
    FileReader: class {
      readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = 'data:' + blob.type + ';base64,' + Buffer.from(b).toString('base64'); this.onload(); }); }
    },
    $: () => node(), el: () => node(), setStreamingUI() {}, renderMessages() {},
    loadChats: async () => {}, toast(message) { throw new Error(message); },
    fetch: async (url, options) => {
      if (url === '/api/image') return { ok: true, json: async () => ({ urls: ['https://image.pollinations.ai/prompt/test'] }) };
      if (url.startsWith('/api/chats/')) { saved = JSON.parse(options.body).appendImage; return { ok: true }; }
      assert.equal(url, 'https://image.pollinations.ai/prompt/test');
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, blob: async () => new Blob([bytes], { type: 'image/jpeg' }) };
    }
  };
  vm.runInNewContext(source.slice(start, end) + '\nmodule.exports = { autoImage };', sandbox);
  await sandbox.module.exports.autoImage(fields);
  assert.ok(saved, 'image should be persisted');
  assert.equal(state.messages.at(-1).image, expected);
  assert.equal(saved.url, expected);
  assert.equal(saved.chain.length, 0);
});
