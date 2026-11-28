'use strict';

// Быстрый бенчмарк photonnAI: прогоняет типовые задачи через локальный сервер
// и печатает latency/размер/простые маркеры качества.
// Запуск: node scripts/benchmark.js
// Переменные: PHOTONN_BASE=http://127.0.0.1:7331, PHOTONN_TIERS=easy,pro

const BASE = String(process.env.PHOTONN_BASE || 'http://127.0.0.1:7331').replace(/\/$/, '');
const TIERS = String(process.env.PHOTONN_TIERS || 'easy,pro').split(',').map((s) => s.trim()).filter(Boolean);

const TASKS = [
  { id: 'code-sort', tier: 'easy', text: 'Напиши функцию на Python для сортировки списка словарей по полю age и возвращай новый список.', must: [/python/i, /sorted|sort/i, /age/i] },
  { id: 'math-percent', tier: 'easy', text: 'Посчитай 17% от 43890 и покажи шаги расчёта.', must: [/746/i, /%|процент/i] },
  { id: 'logic', tier: 'pro', text: 'Объясни разницу между процессом и потоком и приведи пример на C++ без лишней воды.', must: [/процесс/i, /поток/i] },
  { id: 'factual', tier: 'pro', text: 'Какие модели используются в photonnAI? Ответь списком.', must: [/minimax/i, /nemotron/i] },
  { id: 'creative', tier: 'easy', text: 'Напиши короткий стих про осень из четырёх строк.', must: [/осен/i] },
  { id: 'analysis', tier: 'pro', text: 'Сравни PostgreSQL и SQLite для небольшого веб-приложения: когда что лучше и какие ограничения?', must: [/PostgreSQL/i, /SQLite/i] }
];

async function createChat() {
  const r = await fetch(BASE + '/api/chats', { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.chat) throw new Error('не удалось создать чат: ' + (j.error || r.status));
  return j.chat.id;
}

async function runTask(task) {
  const chatId = await createChat();
  const started = Date.now();
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, text: task.text, tier: task.tier, autoPro: false })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(task.id + ' HTTP ' + r.status + ' ' + body.slice(0, 200));
  }
  const raw = await r.text();
  let answer = '';
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try {
      const j = JSON.parse(line.slice(6));
      if (j.final && j.final.content) answer = j.final.content;
      else if (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) answer += j.choices[0].delta.content;
    } catch (e) {}
  }
  const ms = Date.now() - started;
  const missing = task.must.filter((re) => !re.test(answer));
  return {
    id: task.id,
    tier: task.tier,
    ms,
    chars: answer.length,
    ok: missing.length === 0,
    missing: missing.map(String)
  };
}

(async () => {
  const rows = [];
  for (const tier of TIERS) {
    for (const task of TASKS.filter((t) => t.tier === tier)) {
      try {
        rows.push(await runTask(task));
      } catch (e) {
        rows.push({ id: task.id, tier, ok: false, error: e.message });
      }
    }
  }
  console.log(JSON.stringify({ base: BASE, at: new Date().toISOString(), rows }, null, 2));
  const ok = rows.filter((r) => r.ok).length;
  console.log('OK ' + ok + '/' + rows.length);
  if (ok < rows.length) process.exitCode = 1;
})();
