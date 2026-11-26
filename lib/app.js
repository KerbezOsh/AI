'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const API_BASE = process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com/v1';
const MAX_BODY = 12 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// Уровни моделей: кандидаты перечислены по приоритету — берётся первый доступный в каталоге NVIDIA.
const TIERS = [
  { id: 'easy', label: 'Easy', hint: 'быстрая', maxTokens: 2048, temperature: 0.3, models: ['nvidia/nemotron-3.5-lightning-30b-a3b', 'minimaxai/minimax-m3.1-flash'], vision: ['meta/llama-4-maverick-17b-128e-instruct', 'microsoft/phi-4-multimodal-instruct', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'] },
  { id: 'medium', label: 'Medium', hint: 'баланс', maxTokens: 4096, temperature: 0.4, models: ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'nvidia/nemotron-3.5-lightning-30b-a3b'], vision: ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'meta/llama-4-maverick-17b-128e-instruct', 'microsoft/phi-4-multimodal-instruct'] },
  { id: 'pro', label: 'Pro', hint: 'максимум качества', maxTokens: 6144, temperature: 0.4, models: ['nvidia/nemotron-3-ultra-550b-a55b', 'mistralai/mistral-large-4-1t-a52b'], vision: ['meta/llama-4-maverick-17b-128e-instruct', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'microsoft/phi-4-multimodal-instruct'] }
];

const DEEP_MODELS = ['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'deepseek-ai/deepseek-r1'];

const DEFAULT_SETTINGS = { tier: 'pro' };

const BASE_PROMPT = [
  'Ты — photonnAI, сильный ИИ-помощник. Отвечай по-русски.',
  '',
  'Правила:',
  '- Сразу по делу, без вступлений вроде «Конечно!» и без пересказа вопроса.',
  '- Не льсти и не хвали вопрос — отвечай по существу.',
  '- Сложную задачу разбирай по шагам и доводи до конкретного результата.',
  '- Код давай рабочий, в блоках, без заглушек; после кода — короткое объяснение.',
  '- Если не уверен или данных не хватает — скажи прямо, что именно неизвестно, и задай один короткий уточняющий вопрос. Не выдумывай факты, ссылки и числа.',
  '- Перед отправкой проверь арифметику, единицы измерения и логику вывода. Если нашёл ошибку в своём же ходе — исправь и покажи итоговый верный вариант.',
  '- Если вопрос содержит ловушку или ложную предпосылку — не подыгрывай: укажи на неё и дай правильный ответ.',
  '- Формулы пиши обычным текстом или простым Markdown (v², h = v₀²/(2g)). Никогда не используй LaTeX-команды и разделители \\( \\): вместо \\frac{400}{20} пиши 400/20.',
  '- Оформляй ответ Markdown: заголовки, списки и таблицы, когда это помогает читать.'
].join('\n');

const TIER_PROMPTS = {
  easy: 'Режим Easy: отвечай максимально коротко — 1–3 предложения или список из 2–3 пунктов. Без длинных объяснений, но без потери точности.',
  medium: 'Режим Medium: сначала продумай решение до конца, затем дай точный ответ с коротким объяснением и примером, если он помогает. Без лишней воды.',
  pro: 'Режим Pro: думай максимально глубоко. Порядок работы над любой задачей: (1) переформулируй задачу и выяви скрытые условия; (2) разбери решение по шагам; (3) рассмотри альтернативные подходы и выбери лучший; (4) проверь себя — выполни код мысленно, перепроверь арифметику и крайние случаи; (5) дай структурированный финальный ответ с примерами и конкретными числами. Если задача допускает несколько трактовок — разбери самую вероятную и укажи это одной строкой.'
};

// ── Состояние: в Postgres (Vercel, DATABASE_URL) или в файлах data/ (локально) ──
let apiKey = null;
let settings = { tier: DEFAULT_SETTINGS.tier, adminPass: 'photonn-admin', ads: { client: '', slot: '' } };
let learning = { feedback: [], profile: [] };
let profileBusy = false;
let chats = [];
let users = {};
let oauthCfg = {};
let sessions = {};    // token -> { email, expiresAt }
let oauthStates = {}; // state -> { provider, expiresAt }
let adminToken = null;
let promos = {};
let adTokens = {};
let adStats = { views: 0, tokens: 0 };

function pruneRuntime() {
  const now = Date.now();
  for (const t of Object.keys(sessions)) {
    if (sessions[t] && sessions[t].expiresAt && sessions[t].expiresAt < now) delete sessions[t];
  }
  for (const s of Object.keys(oauthStates)) {
    if (oauthStates[s] && oauthStates[s].expiresAt && oauthStates[s].expiresAt < now) delete oauthStates[s];
  }
}

async function loadState() {
  const d = await store.loadAll();
  const st = d.settings || {};
  if (TIERS.some((t) => t.id === st.tier)) settings.tier = st.tier;
  if (typeof st.adminPass === 'string' && st.adminPass) settings.adminPass = st.adminPass;
  if (st.ads && typeof st.ads === 'object') {
    if (typeof st.ads.client === 'string') settings.ads.client = st.ads.client;
    if (typeof st.ads.slot === 'string') settings.ads.slot = st.ads.slot;
  }
  if (d.learning && Array.isArray(d.learning.feedback) && Array.isArray(d.learning.profile)) {
    learning = { feedback: d.learning.feedback, profile: d.learning.profile };
  }
  if (Array.isArray(d.chats)) chats = d.chats;
  if (d.users && typeof d.users === 'object' && !Array.isArray(d.users)) users = d.users;
  if (d.oauth && typeof d.oauth === 'object') oauthCfg = d.oauth;
  if (d.promos && typeof d.promos === 'object' && !Array.isArray(d.promos)) promos = d.promos;
  if (d.adTokens && typeof d.adTokens === 'object' && !Array.isArray(d.adTokens)) adTokens = d.adTokens;
  if (d.adStats && typeof d.adStats === 'object') adStats = { views: Number(d.adStats.views) || 0, tokens: Number(d.adStats.tokens) || 0 };
  if (d.key && typeof d.key.apiKey === 'string' && d.key.apiKey) apiKey = d.key.apiKey;
  if (d.runtime && typeof d.runtime === 'object') {
    if (d.runtime.sessions && typeof d.runtime.sessions === 'object') sessions = d.runtime.sessions;
    if (d.runtime.oauthStates && typeof d.runtime.oauthStates === 'object') oauthStates = d.runtime.oauthStates;
    if (typeof d.runtime.adminToken === 'string') adminToken = d.runtime.adminToken;
  }
  pruneRuntime();
  if (!st.adminPass) saveSettings(); // первый запуск: фиксируем дефолтный пароль админки
}

let stateReady = null;
function ensureState() {
  if (!stateReady) stateReady = loadState().catch((e) => { stateReady = null; throw e; });
  return stateReady;
}

function saveSettings() { return store.save('settings', settings); }
function saveLearning() { return store.save('learning', learning); }
function saveChats() { return store.save('chats', chats); }
function saveUsers() { return store.save('users', users); }
function saveOauth() { return store.save('oauth', oauthCfg); }
function savePromos() { return store.save('promos', promos); }
function saveAdTokens() { return store.save('adTokens', adTokens); }
function saveAdStats() { return store.save('adStats', adStats); }
function saveKey() { return store.save('key', apiKey ? { apiKey, savedAt: new Date().toISOString() } : null); }
function saveRuntime() { return store.save('runtime', { sessions, oauthStates, adminToken }); }

function cut(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Долгая память: старую часть диалога сжимаем в конспект, чтобы модель не теряла контекст.
const summarizing = new Set();
const KEEP_RECENT = 12;

function buildHistory(chat, imageDataUrl) {
  const hist = [];
  const from = chat.summary ? (chat.summarized || 0) : Math.max(0, chat.messages.length - 40);
  const lastUser = (() => { for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === 'user') return i; return -1; })();
  for (let i = 0; i < chat.messages.slice(from).length; i++) {
    const m = chat.messages[from + i];
    const gi = from + i;
    if (gi === lastUser && m.image && imageDataUrl) {
      hist.push({ role: 'user', content: [
        { type: 'text', text: m.content },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      hist.push({ role: m.role, content: m.content + (gi === lastUser && m.image ? '\n(к сообщению приложено фото)' : '') });
    }
  }
  return hist;
}

async function callUpstream(tier, payload, opts) {
  let lastErr = null;
  for (const cand of tierCandidates(tier, opts)) {
    try {
      const r = await fetch(API_BASE + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(Object.assign({ model: cand }, payload))
      });
      if (r.ok) return { upstream: r, model: cand };
      const t = await r.text();
      lastErr = { status: r.status, text: t };
      if (isAuthError(r.status, t)) break;
    } catch (e) {
      lastErr = { status: 0, text: e.message };
    }
  }
  const st = (lastErr && lastErr.status) || 502;
  const err = new Error(friendly(lastErr ? lastErr.text : '', st));
  err.status = st;
  throw err;
}

// ── Аккаунты, сессии, VIP ─────────────────────────────────────────────
const PRICE_KGS = 49;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '')); }
function getUser(req) {
  const c = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith('sid='));
  if (!c) return null;
  const s = sessions[c.slice(4)];
  if (!s || !users[s.email]) return null;
  return { email: s.email, vip: Boolean(users[s.email].vip) };
}
function setSession(res, email) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { email, expiresAt: Date.now() + 30 * 86400000 };
  pruneRuntime();
  saveRuntime();
  res.setHeader('Set-Cookie', 'sid=' + token + '; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax');
}
function htmlPage(res, title, text) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>' + title + '</title>' +
    '<body style="background:#090a0c;color:#e9edf4;font-family:system-ui;display:grid;place-items:center;height:100vh;text-align:center">' +
    '<div><h2>' + title + '</h2><p style="color:#8b94a5;max-width:420px">' + text + '</p>' +
    '<p><a href="/" style="color:#7ba2ff">← вернуться в photonnAI</a></p></div>');
}

let fxCache = { at: 0, rates: {} };
async function fxRates() {
  if (fxCache.rates.KGS && Date.now() - fxCache.at < 6 * 3600 * 1000) return fxCache.rates;
  const r = await fetch('https://open.er-api.com/v6/latest/KGS', { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (j && j.rates && j.rates.KGS === 1) { fxCache = { at: Date.now(), rates: j.rates }; return fxCache.rates; }
  throw new Error('курсы недоступны');
}
async function priceFor(ip) {
  const out = { base: PRICE_KGS, currency: 'KGS', symbol: 'сом', price: PRICE_KGS, country: 'KG' };
  try {
    const r = await fetch('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j && j.country_code && j.currency) {
      out.country = j.country_code;
      out.currency = j.currency;
      const rates = await fxRates();
      const k = rates[j.currency];
      if (k) out.price = Math.max(1, Math.ceil(PRICE_KGS * k));
      out.symbol = j.currency;
    }
  } catch (e) { /* локальный или неизвестный IP — остаётся сом */ }
  if (out.currency === 'KGS') out.symbol = 'сом';
  return out;
}

async function handleChat(req, res, body) {
  if (!apiKey) return sendJson(res, 400, { error: 'Сначала добавь API-ключ NVIDIA в настройках.' });
  const chat = chats.find((c) => c.id === body.chatId);
  if (!chat) return sendJson(res, 404, { error: 'Чат не найден' });
  const text = String(body.text || '').trim();
  const rawImage = typeof body.image === 'string' && body.image.startsWith('data:image/') && body.image.length < 9 * 1024 * 1024 ? body.image : null;
  if (!text && !rawImage) return sendJson(res, 400, { error: 'Пустое сообщение' });
  const imageUrl = rawImage;
  const textFinal = text || 'Проанализируй это фото.';

  const tier = tierById(typeof body.tier === 'string' ? body.tier : settings.tier);
  const useWeb = body.web === true;
  const useDeep = body.deep === true;

  // Без регистрации — только Easy.
  const authUser = getUser(req);
  if (tier.id !== 'easy' && !authUser) {
    return sendJson(res, 401, { error: 'Medium и Pro доступны после входа — это бесплатно, зарегистрируйся или войди через Google.', needAuth: true });
  }

  // Pro и глубокий режим — для VIP или за 1 токен от рекламы; цена зависит от страны по IP.
  if ((tier.id === 'pro' || useDeep) && !body.vipOverride) {
    const tk = typeof body.adToken === 'string' ? body.adToken : '';
    const ad = tk ? adTokens[tk] : null;
    if (authUser && ad && ad.email === authUser.email) {
      delete adTokens[tk];
      saveAdTokens();
    } else if (!authUser || !authUser.vip) {
      return sendJson(res, 402, { error: 'Pro и глубокое размышление доступны в VIP или за просмотр рекламы (1 запрос).', needVip: true });
    }
  }
  chat.webSearch = useWeb;
  chat.deep = useDeep;
  const temperature = tier.temperature;

  chat.messages.push({ role: 'user', content: textFinal, at: Date.now(), image: Boolean(imageUrl) });
  if (!chat.title || chat.title === 'Новый чат') chat.title = textFinal.split('\n')[0].slice(0, 48) || 'Фото';
  chat.tier = tier.id;
  chat.updatedAt = Date.now();
  saveChats();

  // Конспект делаем в фоне: ответ не ждёт лишние секунды, а следующий ход уже видит итог.
  summarizeChat(chat).catch(() => {});
  const history = buildHistory(chat, imageUrl);
  const maxTokens = useDeep ? Math.min(8192, tier.maxTokens + 2048) : tier.maxTokens;
  const basePayload = {
    messages: [{ role: 'system', content: buildSystem(tier, chat) }].concat(history),
    temperature,
    top_p: 0.95,
    max_tokens: maxTokens,
    stream: true
  };
  const streamOpts = { vision: Boolean(imageUrl), deep: useDeep };

  let opened = false;
  let closed = false;
  res.on('close', () => { closed = true; });
  const write = (s) => { if (!closed) { if (!opened) { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); opened = true; res.write(': ok\n\n'); } res.write(s); } };
  const sendEvent = (obj) => write('data: ' + JSON.stringify(obj) + '\n\n');

  const decoder = new TextDecoder();
  let buffer = '';

  // Собираем текст из SSE-потока; onDelta вызывается для каждого куска.
  async function consumeStream(upstream, onDelta) {
    const reader = upstream.body.getReader();
    let content = '';
    let reasoning = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const d = j.choices && j.choices[0] && j.choices[0].delta;
            if (!d) continue;
            if (d.reasoning_content) { reasoning += d.reasoning_content; if (onDelta) onDelta({ reasoning: d.reasoning_content }); }
            if (d.content) { content += d.content; if (onDelta) onDelta({ content: d.content }); }
          } catch (e) {}
        }
      }
    } catch (e) {
      // поток прерван клиентом или сетью — сохраняем то, что успело прийти
    }
    return { content, reasoning };
  }

  let finalContent = '';
  let finalReasoning = '';
  let model = null;
  let usedSearch = null;

  try {
    const first = await callUpstream(tier, basePayload, streamOpts);
    model = first.model;

    if (useWeb) {
      // Фаза 1: молча читаем ответ — модель могла запросить поиск через [SEARCH: …].
      const p1 = await consumeStream(first.upstream, null);
      const m = SEARCH_RE.exec(p1.content);
      if (!m) {
        finalContent = p1.content;
        finalReasoning = p1.reasoning;
        if (p1.reasoning) sendEvent({ choices: [{ delta: { reasoning_content: p1.reasoning } }] });
        for (let i = 0; i < p1.content.length; i += 220) sendEvent({ choices: [{ delta: { content: p1.content.slice(i, i + 220) } }] });
      } else {
        const query = m[1].trim();
        usedSearch = query;
        sendEvent({ status: { search: query } });
        let block;
        try { block = searchBlock(await webSearch(query), query); }
        catch (e) { block = 'Веб-поиск не удался (' + e.message + '). Ответь без свежих данных и честно скажи об этом.'; }

        const p2messages = basePayload.messages
          .concat([{ role: 'assistant', content: m[0].trim() }])
          .concat([{ role: 'user', content: block }]);
        const second = await callUpstream(tier, Object.assign({}, basePayload, { messages: p2messages }), streamOpts);
        model = second.model;
        sendEvent({ meta: { model, tier: tier.id, search: query } });
        const p2 = await consumeStream(second.upstream, (d) => sendEvent({ choices: [{ delta: d }] }));
        finalContent = p2.content;
        finalReasoning = p2.reasoning;
      }
    } else {
      sendEvent({ meta: { model, tier: tier.id } });
      if (useDeep) {
        // Глубокий режим: собираем ответ целиком, проверяем, и только потом отдаём клиенту.
        const p = await consumeStream(first.upstream, null);
        if (p.reasoning) sendEvent({ choices: [{ delta: { reasoning_content: p.reasoning } }] });
        finalContent = p.content;
        finalReasoning = p.reasoning;
        if (finalContent.trim().length > 40) {
          sendEvent({ status: { checking: true } });
          try {
            const check = await callUpstream(tier, {
              messages: [
                { role: 'system', content: 'Ты — строгий проверяющий. Тебе дают ответ ассистента. Проверь арифметику, факты, логику и код. Если всё верно — верни ответ без изменений. Если есть ошибки — верни только исправленную финальную версию ответа, без комментариев о правках.' },
                { role: 'user', content: finalContent }
              ],
              temperature: 0.2, top_p: 0.95, max_tokens: maxTokens, stream: false
            }, streamOpts);
            const cj = await check.upstream.json();
            const fixed = cj.choices && cj.choices[0] && cj.choices[0].message && cj.choices[0].message.content;
            if (fixed && fixed.trim().length > 20) finalContent = fixed.trim();
          } catch (e) { /* проверка не удалась — остаётся первый ответ */ }
        }
        for (let i = 0; i < finalContent.length; i += 220) sendEvent({ choices: [{ delta: { content: finalContent.slice(i, i + 220) } }] });
      } else {
        // Обычный режим: стримим напрямую.
        const p = await consumeStream(first.upstream, (d) => sendEvent({ choices: [{ delta: d }] }));
        finalContent = p.content;
        finalReasoning = p.reasoning;
      }
    }
  } catch (e) {
    if (!opened) return sendJson(res, e.status || 502, { error: e.message });
    sendEvent({ choices: [{ delta: { content: '\n\n_Ошибка: ' + e.message + '_' } }] });
  }

  if (finalContent.trim() || finalReasoning.trim()) {
    const msg = { role: 'assistant', content: finalContent, at: Date.now(), model, tier: tier.id };
    if (finalReasoning) msg.reasoning = finalReasoning;
    if (usedSearch) msg.search = usedSearch;
    if (useDeep) msg.deep = true;
    chat.messages.push(msg);
    chat.updatedAt = Date.now();
    await saveChats();
  }

  try { if (!closed) res.end(); } catch (e) {}

  // Учимся на этом сообщении в фоне — следующий ответ станет точнее.
  learnProfile(textFinal).catch(() => {});
}

async function summarizeChat(chat) {
  const folded = chat.summarized || 0;
  const foldTo = chat.messages.length - KEEP_RECENT;
  const pending = foldTo - folded;
  if (!apiKey || pending < 14 || summarizing.has(chat.id)) return;
  summarizing.add(chat.id);
  try {
    const slice = chat.messages.slice(folded, foldTo);
    const dialogue = slice.map((m) => (m.role === 'user' ? 'Пользователь: ' : 'Помощник: ') + cut(m.content, 500)).join('\n');
    const r = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        messages: [
          { role: 'system', content: 'Сожми диалог в конспект на русском до 900 символов: факты, договорённости, важные детали и предпочтения пользователя. Только конспект, без вступлений.' },
          { role: 'user', content: (chat.summary ? 'Предыдущий конспект:\n' + chat.summary + '\n\n' : '') + 'Новые сообщения:\n' + dialogue }
        ],
        max_tokens: 2500,
        temperature: 0.2
      })
    });
    if (!r.ok) return;
    const j = await r.json();
    const m = j.choices && j.choices[0] && j.choices[0].message;
    const content = String((m && m.content) || '').trim();
    if (!content) return;
    chat.summary = cut(content, 1400);
    chat.summarized = foldTo;
    await saveChats();
  } catch (e) {
    // конспект не критичен — чат продолжает работать
  } finally {
    summarizing.delete(chat.id);
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(PUBLIC_DIR, rel);
  const base = path.resolve(PUBLIC_DIR) + path.sep;
  if (!target.startsWith(base)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(target, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function isAuthError(status, text) {
  if (status === 401) return true;
  if (status === 403 && String(text).toLowerCase().includes('authorization failed')) return true;
  return false;
}

function friendly(text, status) {
  if (isAuthError(status, text)) return 'NVIDIA не принял ключ. Проверь, что скопировал его целиком и он активен.';
  if (status === 401) return 'NVIDIA не принял ключ (401). Проверь, что скопировал его целиком.';
  if (status === 402 || status === 403) return 'Доступ к модели закрыт или закончились кредиты (HTTP ' + status + '). Попробуй другую модель или новый ключ.';
  if (status === 410) return 'Модель больше не доступна у NVIDIA (410). Выбери другую в списке сверху.';
  if (status === 404) return 'Модель не найдена. Выбери другую в списке сверху.';
  if (status === 429) return 'Слишком много запросов (429). Подожди немного и повтори.';
  return 'Ошибка API (' + status + '): ' + String(text || '').slice(0, 400);
}

const BLOCK_WORDS = ['embed', 'nvclip', 'guard', 'safety', 'detector', 'pii', 'calibration', 'rerank', 'retriev', 'kimi', 'moonshot', 'gemma-3-12b', 'gemma-3-4b', 'starcoder', 'gliner'];

function isChatModel(id) {
  const s = String(id).toLowerCase();
  return !BLOCK_WORDS.some((w) => s.includes(w));
}

function tierById(id) {
  return TIERS.find((t) => t.id === id) || TIERS[2];
}

// Кандидаты уровня: сначала доступные в каталоге NVIDIA, затем остальные запасные.
function tierCandidates(tier, opts) {
  const o = opts || {};
  const base = o.vision && tier.vision ? tier.vision : (o.deep ? DEEP_MODELS.concat(tier.models) : tier.models);
  const known = modelsCache.list;
  const avail = known.length ? base.filter((m) => known.includes(m)) : base.slice();
  return avail.concat(base.filter((m) => !avail.includes(m)));
}

function resolvedTierModels() {
  const out = {};
  for (const t of TIERS) out[t.id] = tierCandidates(t)[0];
  return out;
}

async function pingModel(key, model) {
  const r = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      temperature: 0,
      stream: false
    })
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

let modelsCache = { at: 0, list: [] };

async function fetchModelsWith(key) {
  const r = await fetch(API_BASE + '/models', { headers: { Authorization: 'Bearer ' + key } });
  const text = await r.text();
  if (!r.ok) throw new Error(friendly(text, r.status));
  let j = {};
  try { j = JSON.parse(text); } catch (e) {}
  return (j.data || []).map((m) => m.id).filter(Boolean).sort();
}

async function listModels(force) {
  if (!apiKey) throw new Error('Ключ не задан');
  if (!force && modelsCache.list.length && Date.now() - modelsCache.at < 10 * 60 * 1000) return modelsCache.list.filter(isChatModel);
  const list = await fetchModelsWith(apiKey);
  modelsCache = { at: Date.now(), list };
  return list.filter(isChatModel);
}

function buildSystem(tier, chat) {
  const parts = [BASE_PROMPT, TIER_PROMPTS[tier.id] || TIER_PROMPTS.pro];

  if (chat && chat.summary) {
    parts.push('Конспект предыдущей части разговора (учитывай, но не пересказывай):\n' + chat.summary);
  }

  if (learning.profile.length) {
    parts.push('Что я знаю о пользователе (учитывай естественно, не пересказывай списком):\n- ' + learning.profile.slice(-25).join('\n- '));
  }

  const liked = learning.feedback.filter((f) => f.rating > 0 && f.tier === tier.id).slice(-2);
  if (liked.length) {
    parts.push('Примеры ответов, которые пользователь оценил хорошо (держи такой же стиль, не копируй дословно):\n' +
      liked.map((f) => 'Вопрос: ' + cut(f.question, 160) + '\nОтвет: ' + cut(f.answer, 420)).join('\n\n'));
  }

  const disliked = learning.feedback.filter((f) => f.rating < 0 && f.tier === tier.id).slice(-2);
  if (disliked.length) {
    parts.push('Эти ответы пользователю не понравились — не повторяй их стиль и ошибки:\n' +
      disliked.map((f) => '- ' + cut(f.question, 140)).join('\n'));
  }

  if (chat && chat.webSearch) {
    parts.push('Веб-поиск включён. Если для точного ответа нужны свежие данные (новости, цены, курсы, погода, события после твоего обучения, результаты матчей) — начни ответ РОВНО с тега вида [SEARCH: короткий запрос] на отдельной строке и больше ничего не пиши: тебе автоматически придут результаты поиска, после чего дай полный ответ со ссылками на источники. Если поисковый запрос уже был выполнен для этого сообщения (придут результаты поиска) — тег не используй, отвечай по результатам и указывай источники ссылками. Если свежие данные не нужны — отвечай сразу без тега.');
  }

  if (chat && chat.deep) {
    parts.push('Включён режим глубокого размышления: думай столько, сколько нужно, не экономь токены. Разбери задачу с разных сторон, рассмотри крайние случаи и подводные камни, перепроверь каждый шаг вывода и только потом формулируй финальный ответ. Точность важнее скорости.');
  }

  return parts.join('\n\n');
}

const SEARCH_RE = /^\s*\[SEARCH:\s*([^\]]{3,120})\]\s*/;

async function webSearch(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=ru-ru';
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'ru,en;q=0.8' },
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  const results = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < 6) {
    const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    let href = m[1];
    const udd = /uddg=([^&]+)/.exec(href);
    if (udd) href = decodeURIComponent(udd[1]);
    const title = strip(m[2]);
    const snippet = m[3] ? strip(m[3]) : '';
    if (!title || !/^https?:\/\//.test(href)) continue;
    results.push({ title, snippet, url: href });
  }
  if (!results.length) throw new Error('пусто');
  return results;
}

function searchBlock(results, query) {
  return 'Результаты веб-поиска по запросу «' + query + '» (от ' + new Date().toLocaleDateString('ru-RU') + '):\n\n' +
    results.map((r, i) => '[' + (i + 1) + '] ' + r.title + '\n' + r.url + '\n' + cut(r.snippet, 300)).join('\n\n') +
    '\n\nИспользуй эти факты для ответа. Указывай источники ссылками в тексте ответа вида [1]. Если результатов мало — честно скажи.';
}

const PERSONAL_RE = /(^|[^а-яё])(я|меня|мне|мой|моя|моё|мое|зовут|учусь|работаю|живу|люблю|увлекаюсь|хочу)\s/i;

// Фоновое «обучение»: вытаскиваем из сообщения факты о пользователе и запоминаем их.
async function learnProfile(text) {
  if (!apiKey || profileBusy || !PERSONAL_RE.test(text)) return;
  profileBusy = true;
  try {
    const r = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: 'minimaxai/minimax-m3.1-flash',
        messages: [
          { role: 'system', content: 'Извлеки факты о пользователе из его сообщения. Верни ТОЛЬКО JSON-массив коротких фактов на русском (до 4). Только то, что пользователь явно сказал о себе. Если фактов нет — [].' },
          { role: 'user', content: String(text).slice(0, 2000) }
        ],
        max_tokens: 300,
        temperature: 0
      })
    });
    if (!r.ok) return;
    const j = await r.json();
    const raw = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;
    const facts = JSON.parse(match[0]);
    if (!Array.isArray(facts)) return;
    let changed = false;
    for (const f of facts) {
      const fact = cut(f, 140);
      if (!fact || fact.length < 4) continue;
      if (learning.profile.some((p) => p.toLowerCase() === fact.toLowerCase())) continue;
      learning.profile.push(fact);
      changed = true;
    }
    if (learning.profile.length > 40) learning.profile = learning.profile.slice(-40);
    if (changed) saveLearning();
  } catch (e) {
    // тихо: обучение не должно ломать чат
  } finally {
    profileBusy = false;
  }
}

function chatSummary(c) {
  return { id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length };
}

function protoBase(req) {
  return (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || '127.0.0.1:7331');
}

const handler = async (req, res) => {
  await ensureState();
  const url = new URL(req.url, 'http://127.0.0.1');
  let p = url.pathname;
  // Vercel-rewrite подменяет путь на /api/index; настоящий путь приходит в ?p= (см. vercel.json)
  const forced = url.searchParams.get('p');
  if (forced && !forced.includes(':')) {
    const clean = '/' + forced.replace(/^\/+|\/+$/g, '');
    if (clean !== '/') p = clean;
  }
  const parts = p.split('/');
  try {
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        hasKey: Boolean(apiKey),
        hint: apiKey ? apiKey.slice(0, 7) + '…' + apiKey.slice(-4) : null,
        settings,
        tiers: TIERS.map((t) => ({ id: t.id, label: t.label, hint: t.hint })),
        tierModels: resolvedTierModels(),
        chatCount: chats.length,
        modelCount: modelsCache.list.length,
        learning: { feedbackCount: learning.feedback.length, profileCount: learning.profile.length }
      });
    }

    // ── Настройка Google-входа прямо из приложения ──
    if (p === '/api/oauth/setup' && req.method === 'POST') {
      const body = await readBody(req);
      const clientId = String(body.client_id || '').trim();
      const clientSecret = String(body.client_secret || '').trim();
      if (clientId.length < 20 || !clientId.endsWith('.apps.googleusercontent.com')) return sendJson(res, 400, { error: 'Это не похоже на Client ID Google (должен заканчиваться на .apps.googleusercontent.com)' });
      if (clientSecret.length < 10) return sendJson(res, 400, { error: 'Client Secret слишком короткий — скопируй его целиком.' });
      oauthCfg.google = { client_id: clientId, client_secret: clientSecret };
      await saveOauth();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/oauth/status' && req.method === 'GET') {
      return sendJson(res, 200, { googleConfigured: Boolean(oauthCfg.google && oauthCfg.google.client_id) });
    }

    if (p === '/api/key' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body.key || '').trim();
      if (key.length < 20) return sendJson(res, 400, { error: 'Ключ слишком короткий — скопируй его целиком.' });

      let list;
      try { list = await fetchModelsWith(key); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      const chatModels = list.filter(isChatModel);
      const candidates = tierCandidates(tierById(settings.tier)).slice(0, 3);

      let good = false;
      let authFailed = false;
      let lastStatus = 0;
      for (const m of candidates) {
        try {
          const ping = await pingModel(key, m);
          if (ping.ok) { good = true; break; }
          lastStatus = ping.status;
          if (isAuthError(ping.status, ping.text)) { authFailed = true; break; }
        } catch (e) {}
      }

      if (!good && authFailed) {
        return sendJson(res, 400, { error: 'NVIDIA не принял ключ. Проверь, что скопировал его целиком и он активен.' });
      }

      apiKey = key;
      saveKey();
      modelsCache = { at: Date.now(), list };
      saveSettings();

      return sendJson(res, 200, {
        ok: true,
        count: chatModels.length,
        hint: key.slice(0, 7) + '…' + key.slice(-4),
        tierModels: resolvedTierModels(),
        warning: good ? null : 'Ключ сохранён, но проверочный запрос не прошёл (HTTP ' + lastStatus + '). Если чат не отвечает — проверь доступ к модели.'
      });
    }

    if (p === '/api/key' && req.method === 'DELETE') {
      apiKey = null;
      saveKey();
      modelsCache = { at: 0, list: [] };
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/models' && req.method === 'GET') {
      if (!apiKey) return sendJson(res, 400, { error: 'Ключ не задан' });
      try { return sendJson(res, 200, { models: await listModels(false) }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.tier === 'string' && TIERS.some((t) => t.id === body.tier)) settings.tier = body.tier;
      saveSettings();
      return sendJson(res, 200, { ok: true, settings });
    }

    if (p === '/api/feedback' && req.method === 'POST') {
      const body = await readBody(req);
      const rating = body.rating === 1 ? 1 : body.rating === -1 ? -1 : 0;
      const answer = String(body.answer || '').slice(0, 8000);
      if (!rating || !answer.trim()) return sendJson(res, 400, { error: 'Нужна оценка и текст ответа' });
      const tier = tierById(body.tier);
      const question = String(body.question || '').slice(0, 2000);
      const existing = learning.feedback.find((f) => f.tier === tier.id && f.answer === answer);
      if (existing) existing.rating = rating;
      else learning.feedback.push({ tier: tier.id, question, answer, rating, at: Date.now() });
      if (learning.feedback.length > 200) learning.feedback = learning.feedback.slice(-200);
      saveLearning();
      return sendJson(res, 200, { ok: true, feedbackCount: learning.feedback.length });
    }

    if (p === '/api/learning' && req.method === 'GET') {
      return sendJson(res, 200, {
        feedbackCount: learning.feedback.length,
        profileCount: learning.profile.length,
        profile: learning.profile
      });
    }

    if (p === '/api/chats' && req.method === 'GET') {
      const list = chats.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(chatSummary);
      return sendJson(res, 200, { chats: list });
    }

    if (p === '/api/chats' && req.method === 'POST') {
      const now = Date.now();
      const chat = { id: crypto.randomUUID(), title: 'Новый чат', createdAt: now, updatedAt: now, messages: [] };
      chats.push(chat);
      saveChats();
      return sendJson(res, 200, { chat });
    }

    if (parts[1] === 'api' && parts[2] === 'chats' && parts[3]) {
      const id = parts[3];
      const chat = chats.find((c) => c.id === id);
      if (!chat) return sendJson(res, 404, { error: 'Чат не найден' });
      if (req.method === 'GET') return sendJson(res, 200, { chat });
      if (req.method === 'DELETE') {
        chats = chats.filter((c) => c.id !== id);
        saveChats();
        return sendJson(res, 200, { ok: true });
      }
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      return handleChat(req, res, body);
    }

    // ── Аккаунты ──
    if (p === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!validEmail(email)) return sendJson(res, 400, { error: 'Некорректная почта' });
      if (password.length < 6) return sendJson(res, 400, { error: 'Пароль минимум 6 символов' });
      if (users[email]) return sendJson(res, 400, { error: 'Такая почта уже зарегистрирована — войдите' });
      const salt = crypto.randomBytes(16).toString('hex');
      users[email] = { salt, hash: hashPassword(password, salt), vip: false, createdAt: Date.now() };
      saveUsers();
      setSession(res, email);
      return sendJson(res, 200, { ok: true, email, vip: false });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const u = users[email];
      if (!u) return sendJson(res, 400, { error: 'Аккаунт не найден — зарегистрируйтесь' });
      const hash = hashPassword(body.password || '', u.salt);
      if (hash !== u.hash) return sendJson(res, 400, { error: 'Неверный пароль' });
      setSession(res, email);
      return sendJson(res, 200, { ok: true, email, vip: Boolean(u.vip) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const c = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith('sid='));
      if (c) { delete sessions[c.slice(4)]; saveRuntime(); }
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/me' && req.method === 'GET') {
      const u = getUser(req);
      return sendJson(res, 200, { user: u });
    }

    if (p === '/api/price' && req.method === 'GET') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        (req.socket.remoteAddress || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
      const isLocal = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
      try { return sendJson(res, 200, await priceFor(isLocal ? '' : ip)); }
      catch (e) { return sendJson(res, 200, { base: PRICE_KGS, currency: 'KGS', symbol: 'сом', price: PRICE_KGS, country: 'KG' }); }
    }

    if (p === '/api/vip/activate' && req.method === 'POST') {
      const u = getUser(req);
      if (!u) return sendJson(res, 401, { error: 'Сначала войдите в аккаунт' });
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      const promo = promos[code];
      if (!promo) return sendJson(res, 400, { error: 'Промокод не действует' });
      if (promo.expiresAt && Date.now() > promo.expiresAt) return sendJson(res, 400, { error: 'Срок действия промокода истёк' });
      if (promo.maxUses > 0 && (promo.uses || 0) >= promo.maxUses) return sendJson(res, 400, { error: 'Лимит активаций промокода исчерпан' });
      promo.uses = (promo.uses || 0) + 1;
      users[u.email].vip = true;
      saveUsers();
      savePromos();
      return sendJson(res, 200, { ok: true, vip: true });
    }

    // ── Админка: промокоды ──
    function isAdmin(req) {
      const c = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith('admin='));
      return Boolean(c && adminToken && c.slice(6) === adminToken);
    }
    if (p === '/api/admin/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (String(body.password || '') !== settings.adminPass) return sendJson(res, 401, { error: 'Неверный пароль администратора' });
      adminToken = crypto.randomBytes(24).toString('hex');
      saveRuntime();
      res.setHeader('Set-Cookie', 'admin=' + adminToken + '; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/pass' && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Нет доступа' });
      const body = await readBody(req);
      const pw = String(body.password || '');
      if (pw.length < 6) return sendJson(res, 400, { error: 'Пароль минимум 6 символов' });
      settings.adminPass = pw;
      saveSettings();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/promos' && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Нет доступа' });
      return sendJson(res, 200, { promos });
    }
    if (p === '/api/admin/promos' && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Нет доступа' });
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,32}$/.test(code)) return sendJson(res, 400, { error: 'Код: 4–32 символа — латиница, цифры, дефис' });
      const maxUses = Math.max(0, Math.floor(Number(body.maxUses) || 0));
      const days = Math.max(0, Math.floor(Number(body.expiresDays) || 0));
      const old = promos[code];
      promos[code] = { maxUses, uses: old ? old.uses || 0 : 0, createdAt: old ? old.createdAt : Date.now(), expiresAt: days > 0 ? Date.now() + days * 86400000 : 0 };
      savePromos();
      return sendJson(res, 200, { ok: true, promos });
    }
    if (p === '/api/admin/promos/edit' && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Нет доступа' });
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      if (!promos[code]) return sendJson(res, 404, { error: 'Промокод не найден' });
      if (body.maxUses !== undefined) promos[code].maxUses = Math.max(0, Math.floor(Number(body.maxUses) || 0));
      if (body.expiresDays !== undefined) {
        const days = Math.max(0, Math.floor(Number(body.expiresDays) || 0));
        promos[code].expiresAt = days > 0 ? Date.now() + days * 86400000 : 0;
      } else if (body.expiresAt !== undefined) {
        promos[code].expiresAt = Math.max(0, Math.floor(Number(body.expiresAt) || 0));
      }
      savePromos();
      return sendJson(res, 200, { ok: true, promos });
    }
    // ── Реклама: токен на 1 запрос Pro ──
    if (p === '/api/ads/config' && req.method === 'GET') {
      const enabled = Boolean(settings.ads.client);
      return sendJson(res, 200, { enabled, client: settings.ads.client, slot: settings.ads.slot });
    }
    if (p === '/api/admin/ads' && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Нет доступа' });
      return sendJson(res, 200, { ads: settings.ads, stats: adStats });
    }
    if (p === '/api/admin/ads' && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Нет доступа' });
      const body = await readBody(req);
      settings.ads.client = String(body.client || '').trim();
      settings.ads.slot = String(body.slot || '').trim();
      saveSettings();
      return sendJson(res, 200, { ok: true, ads: settings.ads, stats: adStats });
    }
    if (p === '/api/ad/earn' && req.method === 'POST') {
      const u = getUser(req);
      if (!u) return sendJson(res, 401, { error: 'Сначала войдите в аккаунт' });
      adStats.views += 1;
      adStats.tokens += 1;
      saveAdStats();
      const token = crypto.randomBytes(16).toString('hex');
      adTokens[token] = { email: u.email, createdAt: Date.now() };
      saveAdTokens();
      return sendJson(res, 200, { ok: true, token });
    }

    if (p === '/api/admin/promos/delete' && req.method === 'POST') {      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Нет доступа' });
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      delete promos[code];
      savePromos();
      return sendJson(res, 200, { ok: true, promos });
    }

    // ── OAuth ──
    if ((p === '/auth/google' || p === '/api/auth/google') && req.method === 'GET') {
      const cfg = oauthCfg.google;
      if (!cfg || !cfg.client_id || !cfg.client_secret) return htmlPage(res, 'Google-вход не настроен', 'Нужно создать OAuth-клиент в Google Cloud Console и вписать client_id и client_secret в data/oauth.json. Инструкция есть у твоего ассистента.');
      const state = crypto.randomBytes(16).toString('hex');
      oauthStates[state] = { provider: 'google', expiresAt: Date.now() + 600000 };
      pruneRuntime();
      saveRuntime();
      const redirect = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      redirect.searchParams.set('client_id', cfg.client_id);
      redirect.searchParams.set('redirect_uri', protoBase(req) + '/auth/google/callback');
      redirect.searchParams.set('response_type', 'code');
      redirect.searchParams.set('scope', 'openid email');
      redirect.searchParams.set('state', state);
      res.writeHead(302, { Location: redirect.toString() });
      return res.end();
    }

    if ((p === '/auth/google/callback' || p === '/api/auth/google/callback') && req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      const code = q.get('code');
      const state = q.get('state');
      if (!code || !oauthStates[state]) return htmlPage(res, 'Ошибка входа', 'Ссылка устарела — попробуй войти заново.');
      delete oauthStates[state];
      saveRuntime();
      const cfg = oauthCfg.google;
      try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, client_id: cfg.client_id, client_secret: cfg.client_secret,
            redirect_uri: 'http://' + (req.headers.host || '127.0.0.1:7331') + '/auth/google/callback',
            grant_type: 'authorization_code'
          }), signal: AbortSignal.timeout(10000)
        });
        const j = await r.json();
        if (!j.id_token) throw new Error(j.error_description || 'нет id_token');
        const payload = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString());
        const email = String(payload.email || '').toLowerCase();
        if (!validEmail(email)) throw new Error('Google не вернул почту');
        if (!users[email]) users[email] = { salt: '', hash: '', vip: false, createdAt: Date.now(), via: 'google' };
        saveUsers();
        setSession(res, email);
        res.writeHead(302, { Location: '/' });
        return res.end();
      } catch (e) { return htmlPage(res, 'Ошибка входа через Google', e.message); }
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Неизвестный запрос' });

    return serveStatic(res, p);
  } catch (e) {
    if (!res.headersSent) return sendJson(res, 500, { error: e.message || 'Ошибка сервера' });
    try { res.end(); } catch (x) {}
  }
};

module.exports = { handler };