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
const UI_DEFAULT = { theme: 'dark', size: 'md', enterSend: true, modelTag: true, compact: false };
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

function tierLabel(id) {
  const name = id || 'pro';
  return name.charAt(0).toUpperCase() + name.slice(1);
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
  content.innerHTML = md(msg.content);
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
  const tier = (state.settings && state.settings.tier) || 'pro';
  w.appendChild(el('div', 'kicker', 'photonnAI · уровень ' + tierLabel(tier)));
  w.appendChild(el('h1', null, 'Чем помочь?'));
  w.appendChild(el('p', null, 'Опишите задачу — я разберу её по шагам, проверю себя и дам конкретный результат. Для сложных вопросов выбирайте Pro.'));

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
  } else {
    const tips = el('div', 'tips');
    [
      ['⌘', 'Код', 'Написать, объяснить, найти ошибку'],
      ['◇', 'Учёба', 'Экзамены, задачи, конспекты'],
      ['✎', 'Тексты', 'Письма, планы, редактура']
    ].forEach(([ico, title, sub]) => {
      const card = el('div', 'tip');
      card.append(el('span', 'tip-ico', ico), el('b', null, title), el('span', null, sub));
      tips.appendChild(card);
    });
    w.appendChild(tips);
  }
  return w;
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
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: state.currentId,
        text,
        tier: state.settings.tier,
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
    const usedToken = Boolean(state.adToken) && (state.settings.tier === 'pro' || state.deepMode);
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
  if (!state.user) { $('authModal').classList.remove('hidden'); return; }
  $('vipModal').classList.remove('hidden');
  const priceEl = $('vipPrice');
  const cEl = $('vipCountry');
  priceEl.textContent = '49 сом / мес';
  cEl.textContent = '';
  fetch('/api/price').then((r) => r.json()).then((j) => {
    priceEl.textContent = j.price + ' ' + j.symbol + ' / мес';
    cEl.textContent = j.country && j.country !== 'KG' ? 'цена для твоей страны (' + j.country + ')' : '';
  }).catch(() => {});
  if (state.user.vip) { $('vipCode').hidden = true; $('vipActivate').textContent = 'VIP уже активен ✓'; }
  else { $('vipCode').hidden = false; $('vipActivate').textContent = 'Активировать промокод'; }
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
  $('vipActivate').addEventListener('click', async () => {
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
  state.deepMode = false;

  $('btnPhoto').addEventListener('click', () => $('fileInput').click());
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
  for (const inp of ['fileInput', 'cameraInput']) {
    $(inp).addEventListener('change', () => {
      const f = $(inp).files[0];
      if (!f) return;
      if (f.size > 6 * 1024 * 1024) { toast('Фото больше 6 МБ — выбери поменьше'); return; }
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
    setToggle('btnDeep', 'deepMode', state.deepMode ? 'Глубокое размышление включено' : 'Глубокое размышление: максимум рассуждений');
  });
  setToggle('btnWeb', 'webSearch', 'Веб-поиск: модель найдёт свежие данные');
  setToggle('btnDeep', 'deepMode', 'Глубокое размышление: максимум рассуждений');
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
  const current = (state.settings && state.settings.tier) || 'pro';
  document.querySelectorAll('#tierSelect button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tier === current);
  });

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
    document.body.classList.remove('side-open');
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (ui.theme === 'system') applyUi(); });
  tap('tierSelect', 'click', async (e) => {
    const b = e.target.closest('button[data-tier]');
    if (!b || !state.settings) return;
    state.settings.tier = b.dataset.tier;
    renderTierSelect();
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: state.settings.tier })
    });
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