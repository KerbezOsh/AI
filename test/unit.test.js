'use strict';

const { checkMathAnswer, verifyCodeSyntax, retrieveContext, taskProfile, hashedEmbedding, cosineSim, tokenizeForRag, chunkText } = require('../lib/app');
const assert = require('assert');
const test = require('node:test');

test('taskProfile: coding/complex classification', () => {
  const p = taskProfile('Напиши функцию сортировки списка на Python с объяснением каждого шага');
  assert.equal(p.coding, true);
  assert.equal(p.complex, true);
});

test('checkMathAnswer: percent correct and wrong', () => {
  const q = 'Посчитай 17% от 43890';
  assert.deepEqual(checkMathAnswer(q, 'Итого: 7461,3'), []);
  assert.ok(checkMathAnswer(q, 'Ответ: 100').length > 0);
});

test('checkMathAnswer: no false positive on dates', () => {
  assert.deepEqual(checkMathAnswer('Что было 28 ноября 2026 года?', 'Сегодня 28 ноября 2026 года.'), []);
});

test('checkMathAnswer: simple expression', () => {
  assert.deepEqual(checkMathAnswer('Сколько будет 5 + 3?', 'Ответ: 8'), []);
  assert.ok(checkMathAnswer('Сколько будет 5 + 3?', 'Ответ: 10').length > 0);
});

test('verifyCodeSyntax: JS ok / syntax error / runtime error / TS skipped', async () => {
  assert.deepEqual(await verifyCodeSyntax('```js\nconst x = 1 + 2;\nconsole.log(x);\n```'), []);
  const syn = await verifyCodeSyntax('```js\nconst = ;\n```');
  assert.ok(syn.some((s) => s.includes('JS')));
  const rt = await verifyCodeSyntax('```js\nthrow new Error("boom");\n```');
  assert.ok(rt.some((s) => s.includes('boom')));
  assert.deepEqual(await verifyCodeSyntax('```ts\nconst x: number = 1;\n```'), []);
  assert.deepEqual(await verifyCodeSyntax('```js\ndocument.querySelector(".a").textContent = "hi";\n```'), []);
  assert.deepEqual(await verifyCodeSyntax('```js\nasync function f(){ await fetch("/"); }\n```'), []);
  assert.deepEqual(await verifyCodeSyntax('```js\nawait fetch("/");\n```'), []);
});

test('verifyCodeSyntax: JSON', async () => {
  assert.deepEqual(await verifyCodeSyntax('```json\n{"a":1}\n```'), []);
  assert.ok((await verifyCodeSyntax('```json\n{a:1}\n```')).length > 0);
});

test('RAG helpers: embedding cosine and retrieval', () => {
  const a = hashedEmbedding('кот собака пет');
  const b = hashedEmbedding('кот собака');
  const c = hashedEmbedding('квантовый физик');
  assert.ok(cosineSim(a, b) > cosineSim(a, c));
  assert.ok(tokenizeForRag('Привет, Мир!').includes('мир'));
  assert.ok(chunkText('a'.repeat(2000), 900).length >= 2);
  const chat = { messages: [
    { role: 'user', content: 'Как настроить PostgreSQL для веб приложения?' },
    { role: 'assistant', content: 'PostgreSQL настраивается через конфиг и пул соединений.' },
    { role: 'user', content: 'расскажи про кошек' }
  ] };
  const ctx = retrieveContext(chat, 'как настроить postgresql');
  assert.ok(ctx.includes('PostgreSQL') || ctx.includes('конфиг'));
});
