'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/workspace.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clock() {
  let sequence = 0;
  let now = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) {
      const id = ++sequence;
      pending.set(id, { at: now + Number(delay || 0), callback });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    tick(milliseconds) {
      const until = now + milliseconds;
      while (true) {
        const next = [...pending].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
      }
      now = until;
    }
  };
}

function harness(overrides = {}) {
  const timers = clock();
  const elements = {
    input: { value: '', style: {}, focus() {} },
    imageAspect: { value: 'square' },
    imageSeed: { value: '' }
  };
  const writes = [];
  const reads = [];
  const messages = [];
  const saved = new Map();
  const state = { currentId: null, user: { id: 'owner-A', email: 'a@example.test' }, pendingImage: null, pendingFile: null };
  const drafts = {
    persistent: true,
    get(chatId, scope) { reads.push({ chatId, scope }); return Promise.resolve(null); },
    set(chatId, draft, scope) { writes.push({ chatId, draft, scope }); return Promise.resolve(draft); },
    ...overrides.drafts
  };
  let context;
  const sandbox = {
    window: { PhotonnDrafts: drafts },
    state,
    uiLang: 'ru',
    pendingImageData: null,
    crypto: { randomUUID: () => 'guest-id' },
    localStorage: {
      getItem: (key) => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, String(value))
    },
    $: (id) => elements[id] || null,
    renderAttachment() {},
    // In the actual app resizeInput also schedules a draft. Keep that behavior
    // here to verify the restoringComposer guard prevents a save feedback loop.
    resizeInput() { context.scheduleComposerDraft(); },
    toast(message) { messages.push(message); },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    DOMException
  };
  context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return { api: context, state, drafts, elements, writes, reads, messages, saved, timers };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('workspace image options: seed zero and maximum seed are preserved; empty omits seed', () => {
  const h = harness();
  assert.deepEqual(plain(h.api.readImageOptions()), { aspect: 'square' });
  h.elements.imageAspect.value = 'landscape';
  h.elements.imageSeed.value = '0';
  assert.deepEqual(plain(h.api.readImageOptions()), { aspect: 'landscape', seed: 0 });
  h.elements.imageSeed.value = ' 999999 ';
  assert.equal(h.api.readImageOptions().seed, 999999);
  h.elements.imageAspect.value = 'invalid';
  assert.equal(h.api.readImageOptions().aspect, 'square');
  h.elements.imageSeed.value = '   ';
  assert.equal(Object.hasOwn(h.api.readImageOptions(), 'seed'), false);
});

test('workspace image options: invalid seed never silently becomes a random seed', () => {
  const h = harness();
  for (const invalid of ['-1', '1.5', '1e3', '1000000', 'Infinity', 'NaN', 'a', '3 4']) {
    h.elements.imageSeed.value = invalid;
    assert.throws(() => h.api.readImageOptions(), /Seed/);
  }
});

test('workspace restore: a late response from the old chat cannot overwrite the new chat', async () => {
  const old = deferred();
  const next = deferred();
  const h = harness({ drafts: { get: (id) => id === 'old' ? old.promise : next.promise } });
  const activatingOld = h.api.activateComposer('old', false);
  const activatingNext = h.api.activateComposer('next', false);
  next.resolve({ text: 'new chat draft', pendingFile: { name: 'new.txt', size: 1, content: 'b' } });
  await activatingNext;
  old.resolve({ text: 'old chat draft', pendingImage: 'data:image/png;base64,YQ==' });
  await activatingOld;
  assert.equal(h.elements.input.value, 'new chat draft');
  assert.equal(h.state.pendingFile.name, 'new.txt');
  assert.equal(h.state.pendingImage, null);
  assert.equal(h.writes.length, 0, 'restoring a draft must not immediately resave it');
  assert.equal(h.timers.pending.size, 0, 'resize during restore must not create a save loop');
});

test('workspace restore: typing while IndexedDB loads wins over the saved draft', async () => {
  const pending = deferred();
  const h = harness({ drafts: { get: () => pending.promise } });
  const activating = h.api.activateComposer('chat-A', false);
  h.elements.input.value = 'typed while loading';
  h.api.scheduleComposerDraft();
  pending.resolve({ text: 'stale stored text' });
  await activating;
  assert.equal(h.elements.input.value, 'typed while loading');
  h.timers.tick(180);
  await Promise.resolve();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].chatId, 'chat-A');
  assert.equal(h.writes[0].draft.text, 'typed while loading');
});

test('workspace save: snapshots the old chat, owner and file before awaiting persistence', async () => {
  const storing = deferred();
  const calls = [];
  const h = harness({ drafts: { set: (chatId, draft, scope) => { calls.push({ chatId, draft, scope }); return storing.promise; } } });
  await h.api.activateComposer('chat-A', false);
  h.elements.input.value = 'owner A text';
  h.state.pendingFile = { name: 'a.txt', size: 1, content: 'a', type: 'text/plain' };
  const saving = h.api.saveComposerDraft();
  h.state.pendingFile.content = 'mutated later';
  h.state.user = { id: 'owner-B' };
  await h.api.activateComposer('chat-B', false);
  h.elements.input.value = 'owner B text';
  storing.resolve();
  await saving;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, 'chat-A');
  assert.equal(calls[0].scope, 'user:owner-A');
  assert.equal(calls[0].draft.text, 'owner A text');
  assert.equal(calls[0].draft.pendingFile.content, 'a');
  assert.equal(h.elements.input.value, 'owner B text');
});

test('workspace preserve: first send moves the composed text into the newly created chat', async () => {
  const h = harness();
  await h.api.activateComposer(null, false);
  h.elements.input.value = 'first message';
  h.state.pendingImage = 'data:image/png;base64,YQ==';
  await h.api.activateComposer('new-id', true);
  assert.equal(h.elements.input.value, 'first message');
  assert.equal(h.state.pendingImage, 'data:image/png;base64,YQ==');
  assert.equal(h.reads.length, 1, 'preserving input must not restore an unrelated saved draft');
  assert.equal(h.writes.at(-1).chatId, 'new-id');
  assert.equal(h.writes.at(-1).scope, 'user:owner-A');
  assert.equal(h.writes.at(-1).draft.text, 'first message');
});

test('workspace scopes: last opened chats and draft reads remain isolated between users and guest', async () => {
  const h = harness();
  await h.api.activateComposer('chat-A', false);
  assert.equal(h.api.lastOpenedChat(), 'chat-A');
  h.state.user = { id: 'owner-B' };
  assert.equal(h.api.lastOpenedChat(), null);
  await h.api.activateComposer('chat-B', false);
  assert.equal(h.api.lastOpenedChat(), 'chat-B');
  h.state.user = null;
  assert.equal(h.api.composerScope(), 'guest:guest-id');
  assert.equal(h.api.composerScope(), 'guest:guest-id');
  assert.equal(h.api.lastOpenedChat(), null);
  h.state.user = { id: 'owner-A' };
  assert.equal(h.api.lastOpenedChat(), 'chat-A');
  assert.deepEqual(h.reads.map((read) => read.scope), ['user:owner-A', 'user:owner-B']);
});

test('workspace send lifecycle: clearing a sent draft invalidates a late restore and persists empty input', async () => {
  const pending = deferred();
  const h = harness({ drafts: { get: () => pending.promise } });
  const activating = h.api.activateComposer('chat', false);
  h.elements.input.value = 'sent message';
  h.api.clearSentComposer();
  pending.resolve({ text: 'old stored message' });
  await activating;
  assert.equal(h.elements.input.value, '');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].draft.text, '');
  assert.equal(h.timers.pending.size, 0, 'immediate save should cancel the scheduled duplicate');
});

test('workspace failed send: restores attachments when empty and never overwrites newer typing', () => {
  const h = harness();
  h.api.restoreFailedComposer({ text: 'failed', pendingFile: { name: 'a.txt', size: 1, content: 'a' } });
  assert.equal(h.elements.input.value, 'failed');
  assert.equal(h.state.pendingFile.content, 'a');
  h.elements.input.value = 'newer input';
  h.state.pendingFile = null;
  h.api.restoreFailedComposer({ text: 'stale failed message' });
  assert.equal(h.elements.input.value, 'newer input');
});

test('workspace delay: cancellation rejects immediately and clears its pending timer', async () => {
  const h = harness();
  const controller = new AbortController();
  const waiting = h.api.abortableDelay(45000, controller.signal);
  assert.equal(h.timers.pending.size, 1);
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  assert.equal(h.timers.pending.size, 0);
});

test('workspace delay: an already cancelled operation schedules no work; normal completion removes listener', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.api.abortableDelay(45000, controller.signal), (error) => error.name === 'AbortError');
  assert.equal(h.timers.pending.size, 0);
  const listeners = new Set();
  const signal = { aborted: false, addEventListener: (name, callback) => listeners.add(callback), removeEventListener: (name, callback) => listeners.delete(callback) };
  const waiting = h.api.abortableDelay(100, signal);
  h.timers.tick(100);
  await waiting;
  assert.equal(listeners.size, 0);
  assert.equal(h.timers.pending.size, 0);
});
