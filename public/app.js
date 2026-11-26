'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  chats: [],
  currentId: null,
  messages: [],
  tierModels: {},
  settings: null,
  hasKey: false,
  hint: null,
  adToken: null,
  streaming: false,
  controller: null
};

// Настройки интерфейса живут на устройстве: тема, размер текста, поведение.
const UI_KEY = 'photonn.ui';
const UI_DEFAULT = { theme: 'dark', size: 'md', enterSend: true, modelTag: true, compact: false, deep: false };
const ui = Object.assign({}, UI_DEFAULT, (() => {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch (e) { return {}; }
})());

function saveUi() {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) {}
}

function applyUi() {
  const theme = ui.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : (ui.theme === 'light' ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.size = ui.size || 'md';
  document.body.classList.toggle('compact', Boolean(ui.compact));
  document.body.classList.toggle('hide-model-tag', !ui.modelTag);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f7fa' : '#0a0b0e');
  renderSettingsState();
}

function renderSettingsState() {
  const theme = $('segTheme');
  if (theme) theme.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.theme === ui.theme));
  const size = $('segSize');
  if (size) size.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.size === (ui.size || 'md')));
  if ($('optEnter')) $('optEnter').checked = Boolean(ui.enterSend);
  if ($('optModelTag')) $('optModelTag').checked = Boolean(ui.modelTag);
  if ($('optCompact')) $('optCompact').checked = Boolean(ui.compact);
}

function openSettings() {
  renderSettingsState();
  $('settingsModal').classList.remove('hidden');
  document.body.classList.remove('side-open');
}

function closeSettings() {
  $('settingsModal').classList.add('hidden');
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isDigits(s) {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c < '0' || c > '9') return false;
  }
  return true;
}

function inline(text) {
  let src = String(text).split('\\(').join('').split('\\)').join('').split('\\[').join('').split('\\]').join('').split('$').join('');
  src = src
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
    .replace(/\\(text|mathrm)\{([^{}]*)\}/g, '$2')
    .replace(/\\cdot/g, '·')
    .replace(/\\times/g, '×')
    .replace(/\\approx/g, '≈')
    .replace(/\\le/g, '≤')
    .replace(/\\ge/g, '≥')
    .replace(/\^\{?2\}?/g, '²')
    .replace(/\^\{?3\}?/g, '³')
    .replace(/_0/g, '₀').replace(/_1/g, '₁').replace(/_2/g, '₂').replace(/_3/g, '₃').replace(/_4/g, '₄')
    .replace(/_5/g, '₅').replace(/_6/g, '₆').replace(/_7/g, '₇').replace(/_8/g, '₈').replace(/_9/g, '₉')
    .replace(/\\\s/g, ' ')
    .replace(/\\left|\\right/g, '')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}]/g, '');
  let out = '';
  const bold = src.split('**');
  bold.forEach((part, i) => { out += i % 2 === 1 ? '<strong>' + part + '</strong>' : part; });
  out = out.replace(/(^|[\s(])\*([^*\s][^*<>]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  const code = out.split('`');
  if (code.length > 1) {
    out = code.map((c, i) => (i % 2 === 1 ? '<code>' + c + '</code>' : c)).join('');
  }
  return out;
}

function md(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let inCode = false;
  let code = [];
  let para = [];
  let list = null;

  const closeList = () => {
    if (list) { out.push('</' + list + '>'); list = null; }
  };
  const closePara = () => {
    if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; }
  };
  const openList = (t) => {
    if (list !== t) { closeList(); out.push('<' + t + '>'); list = t; }
  };

  // Таблицы: набор строк вида |a|b|, шапка отделена |---|---|.
  let table = null;
  const isSepRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
  const flushTable = () => {
    if (!table) return;
    const rows = table;
    table = null;
    if (!rows.length) return;
    let head = null;
    let body = rows;
    if (rows.length > 1 && isSepRow(rows[1])) { head = rows[0]; body = rows.slice(2); }
    let html = '<table>';
    if (head) html += '<thead><tr>' + head.map((c) => '<th>' + inline(esc(c.trim())) + '</th>').join('') + '</tr></thead>';
    html += '<tbody>';
    for (const r of body) {
      if (isSepRow(r)) continue;
      html += '<tr>' + r.map((c) => '<td>' + inline(esc(c.trim())) + '</td>').join('') + '</tr>';
    }
    html += '</tbody></table>';
    out.push(html);
  };

  for (const raw of lines) {
    if (table && !raw.trim().startsWith('|')) flushTable();
    if (raw.trim().startsWith('```')) {
      if (!inCode) {
        closePara(); closeList();
        inCode = true; code = [];
      } else {
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        inCode = false;
      }
      continue;
    }
    if (inCode) { code.push(raw); continue; }

    const line = raw.trim();
    if (!line) { closePara(); closeList(); continue; }

    if (line.startsWith('|')) {
      closePara(); closeList();
      if (!table) table = [];
      table.push(line.replace(/^\|/, '').replace(/\|$/, '').split('|'));
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { closePara(); closeList(); out.push('<hr>'); continue; }

    if (line.startsWith('### ')) { closePara(); closeList(); out.push('<h3>' + inline(esc(line.slice(4))) + '</h3>'); continue; }
    if (line.startsWith('## ')) { closePara(); closeList(); out.push('<h2>' + inline(esc(line.slice(3))) + '</h2>'); continue; }
    if (line.startsWith('# ')) { closePara(); closeList(); out.push('<h1>' + inline(esc(line.slice(2))) + '</h1>'); continue; }

    if (line.startsWith('- ') || line.startsWith('• ') || line.startsWith('* ')) {
      closePara(); openList('ul');
      out.push('<li>' + inline(esc(line.slice(2))) + '</li>');
      continue;
    }

    const dot = line.indexOf('. ');
    if (dot > 0 && dot <= 3 && isDigits(line.slice(0, dot))) {
      closePara(); openList('ol');
      out.push('<li>' + inline(esc(line.slice(dot + 2))) + '</li>');
      continue;
    }

    closeList();
    para.push(esc(line));
  }

  if (inCode) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flushTable();
  closePara();
  closeList();
  return out.join('');
}

// Режимы модели: в меню три понятных варианта, оба реально влияют на запрос.
const MODES = {
  reasoning: { tier: 'pro', deep: true, label: 'Reasoning' },
  pro: { tier: 'pro', deep: false, label: 'Pro' },
  flash: { tier: 'easy', deep: false, label: 'Flash' }
};

function currentMode() {
  const tier = (state.settings && state.settings.tier) || 'pro';
  if (tier === 'easy') return 'flash';
  // medium — старый уровень из ранних версий; в новой модели это Pro.
  return state.deepMode ? 'reasoning' : 'pro';
}

function modeLabel() {
  return MODES[currentMode()].label;
}

function tierLabel(id) {
  const name = id || 'pro';
  if (name === 'easy') return 'Flash';
  if (name === 'pro' || name === 'medium') return 'Pro';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Выбранный режим сохраняется: уровень уходит на сервер, глубокое размышление — на устройство.
async function applyMode(mode) {
  const conf = MODES[mode];
  if (!conf || !state.settings) return;
  state.settings.tier = conf.tier;
  state.deepMode = conf.deep;
  ui.deep = conf.deep;
  saveUi();
  setToggle('btnDeep', 'deepMode', state.deepMode ? 'Глубокое размышление включено' : 'Глубокое размышление: максимум рассуждений');
  renderTierSelect();
  closeTierMenu();
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: conf.tier })
    });
  } catch (e) {}
}

function setStageEmpty(empty) {
  const stage = $('stage');
  if (stage) stage.classList.toggle('empty', !!empty);
}

function closeTierMenu() {
  const menu = $('tierSelect');
  const btn = $('tierBtn');
  if (menu) menu.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// «Скачать приложение»: установка PWA, если браузер её предлагает, иначе — подсказка.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (e) {}
    installPrompt = null;
    return;
  }
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  toast(standalone
    ? 'Приложение уже установлено'
    : 'Меню браузера → «Установить приложение». На iPhone: «Поделиться» → «На экран Домой»');
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 2800);
}

function avatar(role) {
  return el('div', 'avatar ' + role, role === 'user' ? 'Я' : 'φ');
}

function messageNode(msg, question) {
  const row = el('div', 'msg ' + (msg.role === 'user' ? 'user' : 'assistant'));
  row.appendChild(avatar(msg.role));
  const bubble = el('div', 'bubble');

  if (msg.role === 'assistant' && msg.reasoning) {
    const det = document.createElement('details');
    det.className = 'think';
    const sum = document.createElement('summary');
    sum.textContent = msg.deep ? 'Глубокие размышления' : 'Размышления';
    det.append(sum, el('div', 'think-body', msg.reasoning));
    bubble.appendChild(det);
  }

  if (msg.image) bubble.appendChild(el('div', 'msg-attach', '📷 фото приложено'));
  if (msg.search) bubble.appendChild(el('div', 'msg-attach', '🌐 поиск: ' + msg.search));

  const content = el('div', 'content');
  // Пустой ответ модели (например, весь бюджет ушёл в размышления) не должен
  // оставлять пустой бабл без объяснения.
  const body = msg.role === 'assistant' && !String(msg.content || '').trim()
    ? '_Модель не вернула текст ответа. Нажми «Ещё раз» или выбери другой режим._'
    : msg.content;
  content.innerHTML = md(body);
  bubble.appendChild(content);

  if (msg.role === 'assistant' && msg.content) {
    bubble.appendChild(el('div', 'model-tag', tierLabel(msg.tier || 'pro')));
  }

  if (msg.role === 'assistant' && msg.content) addActions(bubble, msg, question);

  row.appendChild(bubble);
  return row;
}

function welcomeNode() {
  const w = el('div', 'welcome');
  w.appendChild(el('h1', null, 'С чего начнём?'));

  if (!state.hasKey) {
    const p = el('p', 'hint', 'Один раз вставь API-ключ NVIDIA — дальше всё работает само.');
    const row = el('div', 'key-row');
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'nvapi-...';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const save = el('button', 'primary', 'Сохранить');
    const status = el('p', 'hint');
    save.onclick = () => saveInlineKey(input, status, save);
    row.append(input, save);
    w.append(p, row, status);
  }

  const cards = el('div', 'welcome-cards');
  [
    ['✎', 'Написать текст', 'Письмо клиенту о задержке, вежливо и коротко'],
    ['◇', 'Разобрать задачу', 'План подготовки к экзамену на 5 дней'],
    ['⌘', 'Объяснить код', 'Что делает эта функция и где в ней ошибка'],
    ['🌐', 'Сравнить и решить', 'Два подхода к задаче: плюсы, минусы, вывод']
  ].forEach(([ico, title, prompt]) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'wcard';
    card.append(el('span', 'wcard-ico', ico), el('b', null, title), el('small', null, prompt));
    card.onclick = () => usePrompt(prompt);
    cards.appendChild(card);
  });
  w.appendChild(cards);
  return w;
}

// Клик по подсказке сразу кладёт готовый промт в поле ввода и ставит курсор в конец.
function usePrompt(text) {
  const input = $('input');
  if (!input) return;
  input.value = text;
  resizeInput();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

function updateCrumb() {
  const box = $('crumb');
  if (!box) return;
  const chat = state.chats.find((c) => c.id === state.currentId);
  box.textContent = chat ? chat.title : 'Новый чат';
}

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  updateCrumb();
  setStageEmpty(!state.messages.length);
  if (!state.messages.length) { box.appendChild(welcomeNode()); return; }
  let question = '';
  for (const m of state.messages) {
    if (m.role === 'user') question = m.content;
    box.appendChild(messageNode(m, question));
  }
  box.scrollTop = box.scrollHeight;
}

function scrollIfNear() {
  const box = $('messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (near) box.scrollTop = box.scrollHeight;
}

function appendStreamingMessage(msg) {
  const row = el('div', 'msg assistant');
  row.appendChild(avatar('assistant'));
  const bubble = el('div', 'bubble');

  const det = document.createElement('details');
  det.className = 'think hidden';
  const sum = document.createElement('summary');
  sum.textContent = 'Размышления';
  const thinkBody = el('div', 'think-body');
  det.append(sum, thinkBody);

  const content = el('div', 'content streaming');
  const typing = el('div', 'typing');
  typing.append(el('span'), el('span'), el('span'));
  content.appendChild(typing);

  const tag = el('div', 'model-tag hidden');
  const searchNote = el('div', 'msg-attach hidden');

  bubble.append(det, searchNote, content, tag);
  row.appendChild(bubble);

  const box = $('messages');
  const welcome = box.querySelector('.welcome');
  if (welcome) welcome.remove();
  setStageEmpty(false);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;

  let failed = false;

  return {
    msg,
    setReasoning(text) {
      if (det.classList.contains('hidden')) det.classList.remove('hidden');
      thinkBody.textContent = text;
      scrollIfNear();
    },
    setModel(tier, model) {
      msg.tier = tier;
      msg.model = model;
      tag.textContent = tierLabel(tier || 'pro');
      tag.classList.remove('hidden');
    },
    setSearch(query) {
      msg.search = query;
      searchNote.textContent = '🌐 ищу в интернете: ' + query;
      searchNote.classList.remove('hidden');
      scrollIfNear();
    },
    setContent(text) {
      content.classList.add('streaming');
      content.textContent = text;
      scrollIfNear();
    },
    fail(text) {
      failed = true;
      content.classList.remove('streaming');
      content.innerHTML = '<p class=\'error-text\'>' + esc(text) + '</p>';
      det.open = false;
      row.classList.add('error');
    },
    finish() {
      if (failed) { scrollIfNear(); return; }
      content.classList.remove('streaming');
      content.innerHTML = md(msg.content);
      det.open = false;
      addActions(bubble, msg, lastUserText());
      scrollIfNear();
    }
  };
}

function setStreamingUI(on) {
  state.streaming = on;
  $('send').hidden = on;
  $('stop').hidden = !on;
}

async function streamReply(view, text, opts) {
  setStreamingUI(true);
  const controller = new AbortController();
  state.controller = controller;
  const msg = view.msg;

  try {
    const mode = MODES[currentMode()] || MODES.pro;
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: state.currentId,
        text,
        tier: mode.tier,
        temperature: state.settings.temperature,
        image: state.pendingImage,
        web: state.webSearch,
        deep: state.deepMode,
        adToken: state.adToken || undefined,
        regen: Boolean(opts && opts.regen)
      }),
      signal: controller.signal
    });

    // Токен тратится только на Pro/глубокий режим — при обычном Easy он не должен пропадать.
    const usedToken = Boolean(state.adToken) && (mode.tier === 'pro' || state.deepMode);
    if (res.ok && usedToken) state.adToken = null;

    if (!res.ok) {
      let message = 'Ошибка ' + res.status;
      let needVip = false;
      // j объявлен снаружи try: раньше он был виден только внутри и обращение
      // к j.needAuth падало с ReferenceError — окно входа не открывалось.
      let j = null;
      try {
        j = await res.json();
        if (j && j.error) message = j.error;
        needVip = Boolean(j && j.needVip);
      } catch (e) {}
      if (needVip) handleNeedVip();
      if (j && j.needAuth) { $('authModal').classList.remove('hidden'); }
      throw new Error(message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.meta) { view.setModel(j.meta.tier, j.meta.model); continue; }
        if (j.status && j.status.search) { view.setSearch && view.setSearch(j.status.search); continue; }
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (!d) continue;
        if (d.reasoning_content) {
          msg.reasoning += d.reasoning_content;
          view.setReasoning(msg.reasoning);
        }
        if (d.content) {
          msg.content += d.content;
          view.setContent(msg.content);
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      msg.content += (msg.content ? '\n\n' : '') + '_Остановлено._';
      view.setContent(msg.content);
    } else {
      view.fail(e.message || 'Не удалось получить ответ');
      msg.content = '';
      const at = state.messages.indexOf(msg);
      if (at >= 0) state.messages.splice(at, 1);
    }
  } finally {
    state.controller = null;
    // Если поток закрылся без единого символа ответа — показываем понятную подсказку.
    if (!msg.content.trim() && state.messages.indexOf(msg) >= 0) {
      msg.content = '_Модель не вернула текст ответа. Нажми «Ещё раз» или выбери другой режим._';
      view.setContent(msg.content);
    }
    setStreamingUI(false);
    view.finish();
    await loadChats();
  }
}

// «Ещё раз»: заново генерируем ответ на последний вопрос, не дублируя его.
async function retryLast() {
  if (state.streaming) return;
  const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) { toast('Нет вопроса, на который отвечать'); return; }
  if (state.messages.length && state.messages[state.messages.length - 1].role === 'assistant') state.messages.pop();
  renderMessages();
  const msg = { role: 'assistant', content: '', reasoning: '' };
  state.messages.push(msg);
  const view = appendStreamingMessage(msg);
  await streamReply(view, lastUser.content, { regen: true });
  loadChats();
}

async function send() {
  const input = $('input');
  let text = input.value.trim();
  if ((!text && !state.pendingImage) || state.streaming) return;
  if (!state.hasKey) { renderMessages(); toast('Сначала добавь API-ключ NVIDIA'); return; }
  if (!state.currentId) await newChat(true);
  if (state.pendingImage && !text) text = 'Проанализируй это фото.';
  if (state.pendingImage) text += '\n(приложено фото — проанализируй его)';

  input.value = '';
  resizeInput();

  const userMsg = { role: 'user', content: text.trim(), image: Boolean(state.pendingImage) };
  state.messages.push(userMsg);
  const box = $('messages');
  const welcome = box.querySelector('.welcome');
  if (welcome) welcome.remove();
  setStageEmpty(false);
  box.appendChild(messageNode(userMsg));
  box.scrollTop = box.scrollHeight;

  const msg = { role: 'assistant', content: '', reasoning: '' };
  state.messages.push(msg);
  const view = appendStreamingMessage(msg);
  await streamReply(view, userMsg.content);
  clearPendingImage();
}

let pendingImageData = null;
function setPendingImage(dataUrl) {
  pendingImageData = dataUrl;
  state.pendingImage = dataUrl;
  const wrap = $('imgPreview');
  if (dataUrl) { $('previewThumb').src = dataUrl; wrap.classList.remove('hidden'); }
  else wrap.classList.add('hidden');
}
function clearPendingImage() { setPendingImage(null); $('fileInput').value = ''; $('cameraInput').value = ''; }

function setToggle(id, key, title) {
  const b = $(id);
  b.classList.toggle('on', state[key]);
  b.title = title;
}

async function initAuth() {
  state.user = null;
  try { const j = await (await fetch('/api/me')).json(); state.user = j.user; } catch (e) {}
  renderAuth();
}

function renderAuth() {
  const box = $('sideAuth');
  box.innerHTML = '';
  const av = $('railAvatar');
  if (av) {
    const first = state.user && state.user.email ? state.user.email.trim().charAt(0) : 'К';
    av.textContent = (first || 'К').toUpperCase();
    av.title = state.user ? state.user.email : 'Войти или создать аккаунт';
  }
  if (state.user) {
    const b = document.createElement('button');
    b.className = 'auth-btn' + (state.user.vip ? ' vip-on' : '');
    b.textContent = state.user.vip
      ? 'VIP активен · ' + state.user.email
      : 'Аккаунт: ' + state.user.email + ' · VIP ✨';
    b.addEventListener('click', () => openVip());
    box.appendChild(b);
  } else {
    const b = document.createElement('button');
    b.className = 'auth-btn';
    b.textContent = 'Войти или создать аккаунт';
    b.addEventListener('click', () => $('authModal').classList.remove('hidden'));
    box.appendChild(b);
  }
}

function openVip() {
  // «Сменить план» всегда показывает тарифы. Если гость — предлагаем войти
  // прямо из окна, а не подменяем его формой входа.
  $('vipModal').classList.remove('hidden');
  const priceEl = $('vipPrice');
  const cEl = $('vipCountry');
  const note = $('vipNote');
  priceEl.textContent = '49 сом / мес';
  cEl.textContent = '';
  fetch('/api/price').then((r) => r.json()).then((j) => {
    priceEl.textContent = j.price + ' ' + j.symbol + ' / мес';
    cEl.textContent = j.country && j.country !== 'KG' ? 'цена для твоей страны (' + j.country + ')' : '';
  }).catch(() => {});
  if (!state.user) {
    $('vipCode').hidden = true;
    $('vipActivate').textContent = 'Войти и активировать';
    note.textContent = 'Войди или создай бесплатный аккаунт — после этого можно ввести промокод.';
  } else if (state.user.vip) {
    $('vipCode').hidden = true;
    $('vipActivate').textContent = 'VIP уже активен ✓';
    note.textContent = 'Подписка активна: Pro и глубокие размышления доступны.';
  } else {
    $('vipCode').hidden = false;
    $('vipActivate').textContent = 'Активировать промокод';
    note.textContent = 'Оплата пока по договорённости с Photonn — введи полученный промокод.';
  }
}

let authMode = 'login';
function initAuthUI() {
  $('authClose').addEventListener('click', () => $('authModal').classList.add('hidden'));
  $('vipClose').addEventListener('click', () => $('vipModal').classList.add('hidden'));
  $('authSwitch').addEventListener('click', () => {
    authMode = authMode === 'login' ? 'register' : 'login';
    $('authTitle').textContent = authMode === 'login' ? 'Вход в photonnAI' : 'Регистрация photonnAI';
    $('authSubmit').textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    $('authSwitch').textContent = authMode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти';
  });
  $('authSubmit').addEventListener('click', async () => {
    const email = $('authEmail').value.trim();
    const password = $('authPass').value;
    try {
      const r = await fetch('/api/' + authMode, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const j = await r.json();
      if (!r.ok) { toast(j.error || 'Ошибка'); return; }
      state.user = { email: j.email, vip: j.vip };
      $('authModal').classList.add('hidden');
      $('authPass').value = '';
      renderAuth();
      toast(authMode === 'register' ? 'Аккаунт создан' : 'Вход выполнен');
    } catch (e) { toast('Сеть недоступна'); }
  });
  // Клик по затемнению закрывает окно — привычное поведение модалок.
  for (const id of ['authModal', 'vipModal']) {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).classList.add('hidden'); });
  }
  $('vipActivate').addEventListener('click', async () => {
    if (!state.user) {
      $('vipModal').classList.add('hidden');
      $('authModal').classList.remove('hidden');
      return;
    }
    if (state.user.vip) { $('vipModal').classList.add('hidden'); return; }
    const code = $('vipCode').value.trim();
    if (!code) { toast('Введи промокод'); return; }
    try {
      const r = await fetch('/api/vip/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const j = await r.json();
      if (!r.ok) { toast(j.error || 'Ошибка'); return; }
      state.user.vip = true;
      renderAuth();
      $('vipModal').classList.add('hidden');
      toast('VIP активирован ✨');
    } catch (e) { toast('Сеть недоступна'); }
  });
  $('adEarn').addEventListener('click', async () => {
    if (!state.user) { toast('Сначала войди в аккаунт — это бесплатно'); return; }
    const btn = $('adEarn');
    const box = $('adBox');
    let adConf = null;
    try { adConf = await (await fetch('/api/ads/config')).json(); } catch (e) {}
    if (adConf && adConf.enabled && adConf.client) {
      // Настоящий блок AdSense: скрипт подключается один раз за страницу.
      box.classList.remove('hidden');
      box.innerHTML = '';
      if (!window.adsbygoogle) {
        const s = document.createElement('script');
        s.async = true;
        s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(adConf.client);
        s.crossOrigin = 'anonymous';
        document.head.appendChild(s);
        window.adsbygoogle = [];
      }
      const ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.style.minHeight = '110px';
      if (adConf.slot) ins.setAttribute('data-ad-slot', adConf.slot);
      ins.setAttribute('data-ad-client', adConf.client);
      ins.setAttribute('data-ad-format', 'auto');
      ins.setAttribute('data-full-width-responsive', 'true');
      box.appendChild(ins);
      try { window.adsbygoogle.push({}); } catch (e) {}
    } else {
      box.classList.add('hidden');
    }
    let left = adConf && adConf.enabled ? 15 : 10;
    btn.disabled = true;
    const t = setInterval(() => { btn.textContent = '🎬 Реклама… ' + left; left--; }, 1000);
    await new Promise((r) => setTimeout(r, (adConf && adConf.enabled ? 15 : 10) * 1000 + 500));
    clearInterval(t);
    btn.textContent = '🎬 Смотреть рекламу → 1 запрос Pro';
    btn.disabled = false;
    box.classList.add('hidden');
    box.innerHTML = '';
    try {
      const r = await fetch('/api/ad/earn', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) { toast(j.error || 'Ошибка'); return; }
      state.adToken = j.token;
      $('vipModal').classList.add('hidden');
      toast('Готово: следующий запрос Pro — бесплатно ✓');
    } catch (e) { toast('Сеть недоступна'); }
  });
}
initAuthUI();
initAuth();

const VIP_HINT = 'Pro и 🧠 глубокое размышление — в VIP (49 сом/мес, цена в твоей валюте в VIP-панели).';
function handleNeedVip() {
  openVip();
  toast(VIP_HINT);
}

function initTools() {
  state.pendingImage = null;
  state.webSearch = false;
  state.deepMode = Boolean(ui.deep);

  $('btnPhoto').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTierMenu();
    const menu = $('attachMenu');
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    $('btnPhoto').setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  $('attachMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-attach]');
    if (!b) return;
    closeAttachMenu();
    if (b.dataset.attach === 'file') $('anyFileInput').click();
    else if (b.dataset.attach === 'image') $('fileInput').click();
    else $('cameraInput').click();
  });
  $('btnCamera').addEventListener('click', () => $('cameraInput').click());

  // Голосовой ввод: Web Speech API есть в Chrome, Edge и Safari — где нет, кнопку не показываем.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const mic = $('btnMic');
    mic.hidden = false;
    let rec = null;
    mic.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'ru-RU';
      rec.interimResults = true;
      rec.continuous = false;
      const base = $('input').value.trim();
      mic.classList.add('on');
      rec.onresult = (ev) => {
        let said = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) said += ev.results[i][0].transcript;
        $('input').value = (base ? base + ' ' : '') + said.trim();
        resizeInput();
      };
      rec.onerror = (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('Браузер не дал доступ к микрофону');
      };
      rec.onend = () => { rec = null; mic.classList.remove('on'); $('input').focus(); };
      try { rec.start(); } catch (e) { rec = null; mic.classList.remove('on'); }
    });
  }
  for (const inp of ['fileInput', 'cameraInput', 'anyFileInput']) {
    $(inp).addEventListener('change', () => {
      const f = $(inp).files[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) {
        toast('Сейчас модель читает только изображения: PNG, JPEG или WebP');
        $(inp).value = '';
        return;
      }
      if (f.size > 6 * 1024 * 1024) { toast('Фото больше 6 МБ — выбери поменьше'); $(inp).value = ''; return; }
      const r = new FileReader();
      r.onload = () => setPendingImage(String(r.result));
      r.readAsDataURL(f);
      $(inp).value = '';
    });
  }
  $('imgRemove').addEventListener('click', clearPendingImage);
  $('btnWeb').addEventListener('click', () => {
    state.webSearch = !state.webSearch;
    setToggle('btnWeb', 'webSearch', state.webSearch ? 'Веб-поиск включён' : 'Веб-поиск: модель найдёт свежие данные');
  });
  $('btnDeep').addEventListener('click', () => {
    state.deepMode = !state.deepMode;
    ui.deep = state.deepMode;
    saveUi();
    setToggle('btnDeep', 'deepMode', state.deepMode ? 'Глубокое размышление включено' : 'Глубокое размышление: максимум рассуждений');
    renderTierSelect();
  });
  setToggle('btnWeb', 'webSearch', 'Веб-поиск: модель найдёт свежие данные');
  setToggle('btnDeep', 'deepMode', state.deepMode ? 'Глубокое размышление включено' : 'Глубокое размышление: максимум рассуждений');
}

function closeAttachMenu() {
  const menu = $('attachMenu');
  const btn = $('btnPhoto');
  if (menu) menu.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function openInstall() {
  const modal = $('installModal');
  if (modal) modal.classList.remove('hidden');
}
try { initTools(); } catch (e) { console.warn('initTools:', e); }

async function newChat(silent) {
  try {
    const r = await fetch('/api/chats', { method: 'POST' });
    const j = await r.json();
    if (!r.ok || !j.chat) { toast((j && j.error) || 'Не удалось создать чат'); return null; }
    state.currentId = j.chat.id;
    state.messages = [];
    await loadChats();
    if (!silent) renderMessages();
    return j.chat.id;
  } catch (e) { toast('Нет связи с сервером'); return null; }
  $('input').focus();
}

async function openChat(id) {
  const r = await fetch('/api/chats/' + id);
  if (!r.ok) return;
  const j = await r.json();
  state.currentId = id;
  state.messages = j.chat.messages || [];
  if (j.chat.tier) state.settings.tier = j.chat.tier;
  renderTierSelect();
  renderMessages();
  renderChatList();
  document.body.classList.remove('side-open');
}

async function loadChats() {
  try {
    const r = await fetch('/api/chats');
    const j = await r.json();
    state.chats = j.chats || [];
    renderChatList();
  } catch (e) {}
}

function renderChatList() {
  const box = $('chatList');
  box.innerHTML = '';
  if (!state.chats.length) { box.appendChild(el('div', 'empty-list', 'Пока нет чатов')); return; }

  for (const c of state.chats) {
    const item = el('div', 'chat-item' + (c.id === state.currentId ? ' active' : ''));
    item.appendChild(el('div', 'chat-title', c.title || 'Без названия'));

    const del = el('button', 'chat-del', '✕');
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Удалить этот чат?')) return;
      await fetch('/api/chats/' + c.id, { method: 'DELETE' });
      if (state.currentId === c.id) { state.currentId = null; state.messages = []; }
      await loadChats();
      if (state.chats.length) await openChat(state.chats[0].id);
      else renderMessages();
    };

    item.append(del);
    item.onclick = () => { openChat(c.id); document.body.classList.remove('side-open'); };
    box.appendChild(item);
  }
}

function renderTierSelect() {
  const mode = currentMode();
  document.querySelectorAll('#tierSelect button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
  });
  const label = $('tierLabel');
  if (label) label.textContent = modeLabel();
}

function applyTierModels(j) {
  if (j && j.tierModels) state.tierModels = j.tierModels;
}

function resizeInput() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

function lastUserText() {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].role === 'user') return state.messages[i].content;
  }
  return '';
}

function addActions(bubble, msg, question) {
  if (!msg.content) return;
  const actions = el('div', 'msg-actions');
  const copy = el('button', 'mini', 'Копировать');
  copy.onclick = () => { navigator.clipboard.writeText(msg.content); toast('Скопировано'); };
  actions.appendChild(copy);

  // «Ещё раз» — только у последнего ответа: сервер заменяет его, а не добавляет новый.
  const isLast = state.messages[state.messages.length - 1] === msg;
  if (msg.role === 'assistant' && isLast) {
    const again = el('button', 'mini', 'Ещё раз');
    again.title = 'Сгенерировать ответ заново';
    again.onclick = () => retryLast();
    actions.appendChild(again);
  }

  if (msg.role === 'assistant') {
    const like = el('button', 'mini rate', '👍');
    const dislike = el('button', 'mini rate', '👎');
    like.title = 'Хороший ответ — буду отвечать так же';
    dislike.title = 'Плохой ответ — так больше не надо';
    const rate = async (value) => {
      like.classList.toggle('on', value === 1);
      dislike.classList.toggle('on', value === -1);
      try {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tier: msg.tier || (state.settings && state.settings.tier) || 'pro',
            question: question || '',
            answer: msg.content,
            rating: value
          })
        });
        toast(value === 1 ? 'Запомнил: так лучше' : 'Понял, так не надо');
        updateLearnState();
      } catch (e) {
        toast('Не удалось сохранить оценку');
      }
    };
    like.onclick = () => rate(1);
    dislike.onclick = () => rate(-1);
    actions.append(like, dislike);
  }

  bubble.appendChild(actions);
}

async function updateLearnState() {
  try {
    const j = await (await fetch('/api/learning')).json();
    const badge = $('learnState');
    if (badge) badge.textContent = 'Оценок: ' + j.feedbackCount + ' · фактов: ' + j.profileCount;
  } catch (e) {}
}

async function saveInlineKey(input, status, button) {
  const key = input.value.trim();
  if (!key) { status.textContent = 'Вставь ключ в поле выше.'; return; }
  status.textContent = 'Проверяю ключ…';
  button.disabled = true;
  try {
    const r = await fetch('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const j = await r.json();
    if (!r.ok) { status.textContent = j.error || 'Ключ не принят'; button.disabled = false; return; }
    state.hasKey = true;
    state.hint = j.hint;
    applyTierModels(j);
    updateLearnState();
    renderTierSelect();
    renderMessages();
    toast(j.warning ? 'Ключ сохранён с предупреждением' : 'Ключ сохранён');
  } catch (e) {
    status.textContent = 'Ошибка: ' + e.message;
    button.disabled = false;
  }
}

function bind() {
  const on = (id, fn) => { const n = $(id); if (n) n.onclick = fn; };
  const tap = (id, ev, fn) => { const n = $(id); if (n) n.addEventListener(ev, fn); };
  on('newChat', () => newChat(false));
  on('send', send);
  on('stop', () => { if (state.controller) state.controller.abort(); });
  tap('input', 'keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && ui.enterSend) { e.preventDefault(); send(); }
  });
  tap('input', 'input', resizeInput);
  on('toggleSidebar', () => document.body.classList.toggle('side-open'));
  on('newChatRail', () => newChat(false));
  on('drawerClose', () => document.body.classList.remove('side-open'));
  on('railAvatar', () => {
    if (state.user) document.body.classList.add('side-open');
    else $('authModal').classList.remove('hidden');
  });
  on('btnInstall', openInstall);
  on('installClose', () => $('installModal').classList.add('hidden'));
  on('installNow', installApp);
  on('btnPlan', openVip);
  on('tierBtn', () => {
    const menu = $('tierSelect');
    if (!menu) return;
    closeAttachMenu();
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    $('tierBtn').setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tier-wrap')) closeTierMenu();
    if (!e.target.closest('.attach-wrap')) closeAttachMenu();
    if (document.body.classList.contains('side-open') &&
        !e.target.closest('#sidebar') && !e.target.closest('.rail')) {
      document.body.classList.remove('side-open');
    }
  });

  // Настройки интерфейса
  on('btnSettings', openSettings);
  on('sideSettings', openSettings);
  on('settingsClose', closeSettings);
  on('settingsDone', closeSettings);
  tap('settingsModal', 'click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  tap('segTheme', 'click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (!b) return;
    ui.theme = b.dataset.theme;
    saveUi(); applyUi();
  });
  tap('segSize', 'click', (e) => {
    const b = e.target.closest('button[data-size]');
    if (!b) return;
    ui.size = b.dataset.size;
    saveUi(); applyUi();
  });
  tap('optEnter', 'change', (e) => { ui.enterSend = e.target.checked; saveUi(); });
  tap('optModelTag', 'change', (e) => { ui.modelTag = e.target.checked; saveUi(); applyUi(); });
  tap('optCompact', 'change', (e) => { ui.compact = e.target.checked; saveUi(); applyUi(); });
  on('settingsReset', () => { Object.assign(ui, UI_DEFAULT); saveUi(); applyUi(); toast('Настройки сброшены'); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeSettings();
    closeTierMenu();
    closeAttachMenu();
    $('installModal').classList.add('hidden');
    $('vipModal').classList.add('hidden');
    $('authModal').classList.add('hidden');
    document.body.classList.remove('side-open');
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (ui.theme === 'system') applyUi(); });
  tap('tierSelect', 'click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    applyMode(b.dataset.mode);
  });
}

async function init() {
  applyUi();
  bind();
  try {
    const st = await (await fetch('/api/state')).json();
    state.hasKey = st.hasKey;
    state.hint = st.hint;
    state.settings = st.settings;
    applyTierModels(st);
    updateLearnState();
    await loadChats();
    renderTierSelect();
    if (state.chats.length) await openChat(state.chats[0].id);
    else renderMessages();
  } catch (e) {
    toast('Сервер не отвечает: ' + e.message);
    renderMessages();
  }
  $('input').focus();
}

init();

// Ставим сайт как приложение: service worker держит каркас для офлайна.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}