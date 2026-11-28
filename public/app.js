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
  streaming: false,
  controller: null,
  user: null,
  plan: null,
  usage: null,
  banned: null,
  isAdmin: false,
  booted: false,
  pendingFile: null
};
// Агент: мост на компьютере пользователя (public/agent/photonn-agent.js).
// Токен и папка лежат в localStorage — без токена мост не отвечает.
const AGENT_STORE = 'photonn.agent';
const agent = { on: false, token: '', url: 'http://127.0.0.1:8787', root: '', connected: false, allowExec: false, autoApprove: false, busy: false };
try {
  const saved = JSON.parse(localStorage.getItem(AGENT_STORE) || '{}');
  agent.token = String(saved.token || '');
  agent.root = String(saved.root || '');
  agent.on = Boolean(saved.on);
} catch (e) {}
function saveAgent() {
  try { localStorage.setItem(AGENT_STORE, JSON.stringify({ token: agent.token, root: agent.root, on: agent.on })); } catch (e) {}
}

const PLANS_FALLBACK = {
  free: { id: 'free', label: 'Free', limit: 18, proTrial: 2, modes: ['flash', 'pro', 'reasoning'], price: 0 },
  pro: { id: 'pro', label: 'Pro', limit: 200, modes: ['flash', 'pro', 'reasoning'], price: 49 },
  ultra: { id: 'ultra', label: 'Ultra', limit: 1000, modes: ['flash', 'pro', 'reasoning'], price: 149 }
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

// Безопасная подсветка кода: HTML экранируется посимвольно, никакой innerHTML из ответа модели.
const CODE_KEYWORDS = new Set(('const let var function return if else for while do switch case break continue new class extends super this try catch finally throw typeof instanceof in of async await import export from default true false null undefined NaN Infinity interface type enum public private protected static readonly implements package namespace void yield delete with as get set').split(' '));
const PY_KEYWORDS = new Set(('def class return if elif else for while in not and or is None True False import from as try except finally raise with lambda yield async await pass break continue global nonlocal assert del print self').split(' '));
const SQL_KEYWORDS = new Set(('select from where insert into values update set delete create table drop alter join left right inner outer on group by order having limit offset and or not null is as distinct count sum avg min max case when then else end union all exists like in primary key foreign references index view database default').split(' '));

function codeLangLabel(lang) {
  const map = { js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', py: 'Python', python: 'Python', html: 'HTML', css: 'CSS', json: 'JSON', sql: 'SQL', bash: 'Bash', sh: 'Shell', shell: 'Shell', yml: 'YAML', yaml: 'YAML', md: 'Markdown', markdown: 'Markdown', java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go', rust: 'Rust', php: 'PHP', ruby: 'Ruby', kotlin: 'Kotlin', swift: 'Swift', xml: 'XML' };
  return map[String(lang || '').toLowerCase()] || (lang ? String(lang).slice(0, 20) : 'Код');
}

function highlightCode(src, lang) {
  const l = String(lang || '').toLowerCase();
  const kw = l === 'py' || l === 'python' ? PY_KEYWORDS : l === 'sql' ? SQL_KEYWORDS : CODE_KEYWORDS;
  const lineComment = (l === 'py' || l === 'python' || l === 'bash' || l === 'sh' || l === 'shell' || l === 'yml' || l === 'yaml' || l === 'ruby') ? '#' : l === 'sql' ? '--' : '//';
  let out = '';
  let i = 0;
  const text = String(src);
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);
    if (rest.startsWith('/*')) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += '<span class="tok-com">' + esc(text.slice(i, stop)) + '</span>';
      i = stop;
      continue;
    }
    if (rest.startsWith(lineComment)) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += '<span class="tok-com">' + esc(text.slice(i, stop)) + '</span>';
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === ch) { j++; break; }
        j++;
      }
      out += '<span class="tok-str">' + esc(text.slice(i, j)) + '</span>';
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z_$]/.test(text[i - 1]))) {
      const m = /^(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(rest);
      if (m) {
        out += '<span class="tok-num">' + esc(m[0]) + '</span>';
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
      const word = m[0];
      out += kw.has(word) ? '<span class="tok-kw">' + word + '</span>' : esc(word);
      i += word.length;
      continue;
    }
    out += esc(ch);
    i++;
  }
  return out;
}

// Если модель не указала язык у блока кода — определяем сами, чтобы подсветка работала.
function guessLang(code) {
  const s = String(code || '');
  if (!s.trim()) return '';
  if (/^\s*<!doctype html|<html[\s>]|<div[\s>]|<script[\s>]|<style[\s>]/i.test(s)) return 'html';
  if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(s) && /("[^"\n]+"\s*:)/.test(s)) return 'json';
  if (/\b(select|insert into|update|delete from|create table)\b/i.test(s) && /\bfrom\b|\bwhere\b/i.test(s)) return 'sql';
  if (/^\s*(def |class \w+[(:]|from \w+ import |import \w+\s*$|print\()/m.test(s)) return 'python';
  if (/\bfn\s+\w+\s*\(|\blet mut\b|\bimpl\b|\buse std::|println!/.test(s)) return 'rust';
  if (/\bfunc\s+(\([^)]*\)\s*)?\w+\s*\(|\bpackage\s+\w+/.test(s)) return 'go';
  if (/\b(public|private|protected)\s+(static\s+)?(class|interface|void|[A-Z]\w+)\b/.test(s)) return 'java';
  if (/\b(interface|type)\s+\w+\s*[={]|:\s*(string|number|boolean)\b/.test(s)) return 'ts';
  if (/\b(function|const|let|var|=>|console\.log)\b/.test(s)) return 'js';
  if (/^\s*#include|\bint\s+main\s*\(/m.test(s)) return 'c';
  if (/^\s*(FROM|RUN|COPY|ENTRYPOINT)\s/m.test(s)) return 'yaml';
  return '';
}

function codeBlockHtml(code, lang) {
  const detected = String(lang || '').trim() || guessLang(code);
  const safeLang = String(detected || '').replace(/[^A-Za-z0-9+#-]/g, '').slice(0, 20);
  return '<div class="code-block"><div class="code-head"><span class="code-lang">' + esc(codeLangLabel(detected || 'Код')) +
    '</span><button class="code-copy" type="button" aria-label="Скопировать код">Копировать</button></div><pre><code' +
    (safeLang ? ' class="language-' + esc(safeLang) + '"' : '') + '>' + highlightCode(code, detected) + '</code></pre></div>';
}

function bindCodeCopy(root) {
  if (!root) return;
  root.querySelectorAll('.code-copy').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const block = btn.closest('.code-block');
      const code = block && block.querySelector('code');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent);
        const old = btn.textContent;
        btn.textContent = 'Скопировано';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1400);
      } catch (err) {
        toast('Не удалось скопировать код');
      }
    });
  });
}

function isDigits(s) {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c < '0' || c > '9') return false;
  }
  return true;
}

// ── Формулы ──────────────────────────────────────────────────────────
// Маленький TeX-рендерер: \frac, \sqrt, степени/индексы, греческие буквы.
// Экранирование полное, поэтому HTML из ответа модели сюда не просочится.
const TEX_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡',
  propto: '∝', infty: '∞', sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇', to: '→', rightarrow: '→', leftarrow: '←',
  leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', implies: '⇒', forall: '∀', exists: '∃', in: '∈', notin: '∉',
  subset: '⊂', supset: '⊃', cup: '∪', cap: '∩', angle: '∠', degree: '°', ldots: '…', dots: '…', cdots: '⋯',
  sin: 'sin', cos: 'cos', tan: 'tan', log: 'log', ln: 'ln', lim: 'lim', max: 'max', min: 'min'
};

function texGroup(s, i) {
  if (s[i] !== '{') return { arg: s[i] || '', next: i + 1 };
  let depth = 0;
  const start = i;
  for (; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return { arg: s.slice(start + 1, i), next: i + 1 }; }
  }
  return { arg: s.slice(start + 1), next: s.length };
}

function renderTex(src) {
  const s = String(src || '').trim();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      if (!m) { i++; continue; }
      const name = m[1];
      i += m[0].length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        while (s[i] === ' ') i++;
        const a = texGroup(s, i); i = a.next;
        while (s[i] === ' ') i++;
        const b = texGroup(s, i); i = b.next;
        out += '<span class="frac"><span class="frac-num">' + renderTex(a.arg) + '</span><span class="frac-den">' + renderTex(b.arg) + '</span></span>';
        continue;
      }
      if (name === 'sqrt') {
        let index = '';
        if (s[i] === '[') {
          const close = s.indexOf(']', i);
          if (close > 0) { index = s.slice(i + 1, close); i = close + 1; }
        }
        while (s[i] === ' ') i++;
        const a = texGroup(s, i); i = a.next;
        out += (index ? '<sup class="sqrt-index">' + renderTex(index) + '</sup>' : '') +
          '<span class="sqrt">√<span class="sqrt-body">' + renderTex(a.arg) + '</span></span>';
        continue;
      }
      if (name === 'text' || name === 'mathrm' || name === 'operatorname' || name === 'mathbf') {
        while (s[i] === ' ') i++;
        const a = texGroup(s, i); i = a.next;
        out += '<span class="tex-text">' + esc(a.arg) + '</span>';
        continue;
      }
      if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigl' || name === 'bigr' || name === 'displaystyle') continue;
      if (name === 'quad' || name === 'qquad' || name === ',' || name === ';' || name === ':' || name === '!' || name === ' ') { out += ' '; continue; }
      if (TEX_SYMBOLS[name]) { out += TEX_SYMBOLS[name]; continue; }
      out += esc(name);
      continue;
    }
    if (ch === '^' || ch === '_') {
      i++;
      while (s[i] === ' ') i++;
      let arg;
      if (s[i] === '{') { const a = texGroup(s, i); arg = a.arg; i = a.next; }
      else { arg = s[i] || ''; i++; }
      out += ch === '^' ? '<sup>' + renderTex(arg) + '</sup>' : '<sub>' + renderTex(arg) + '</sub>';
      continue;
    }
    if (ch === '{') { const a = texGroup(s, i); out += renderTex(a.arg); i = a.next; continue; }
    if (ch === '}') { i++; continue; }
    out += esc(ch);
    i++;
  }
  return out;
}

// Делим строку на обычный текст и формулы: $...$ и \( ... \).
// «$5» без TeX-признаков остаётся ценой, а не формулой.
function splitMath(text) {
  const s = String(text || '');
  const parts = [];
  let buf = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && s[i + 1] === '(') {
      const close = s.indexOf('\\)', i + 2);
      if (close > i + 2) {
        if (buf) { parts.push({ text: buf }); buf = ''; }
        parts.push({ tex: s.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    if (s[i] === '$' && s[i + 1] === '$') {
      const close = s.indexOf('$$', i + 2);
      if (close > i + 2) {
        const body = s.slice(i + 2, close);
        if (body.trim()) {
          if (buf) { parts.push({ text: buf }); buf = ''; }
          parts.push({ tex: body, display: true });
          i = close + 2;
          continue;
        }
      }
    }
    if (s[i] === '$' && s[i + 1] !== '$') {
      const close = s.indexOf('$', i + 1);
      if (close > i + 1) {
        const body = s.slice(i + 1, close);
        const texish = body.indexOf('\\') >= 0 || body.indexOf('^') >= 0 || body.indexOf('_') >= 0 ||
          body.indexOf('{') >= 0 || body.indexOf('=') >= 0;
        if (body.length <= 240 && body.indexOf('\n') < 0 && texish) {
          if (buf) { parts.push({ text: buf }); buf = ''; }
          parts.push({ tex: body });
          i = close + 1;
          continue;
        }
      }
    }
    buf += s[i];
    i++;
  }
  if (buf) parts.push({ text: buf });
  return parts;
}

// Дочитываем LaTeX, который модель забыла обернуть в формулу: без «сырых» команд.
function cleanTexText(src) {
  let t = String(src || '');
  for (let guard = 0; guard < 50; guard++) {
    const at = t.indexOf('\\frac{');
    if (at < 0) break;
    const a1 = t.indexOf('}', at + 6);
    const b0 = a1 >= 0 ? t.indexOf('{', a1) : -1;
    const b1 = b0 >= 0 ? t.indexOf('}', b0) : -1;
    if (a1 < 0 || b0 !== a1 + 1 || b1 < 0) break;
    t = t.slice(0, at) + '(' + t.slice(at + 6, a1) + ')/(' + t.slice(b0 + 1, b1) + ')' + t.slice(b1 + 1);
  }
  const map = [['\\sqrt{', '√('], ['\\cdot', '·'], ['\\times', '×'], ['\\approx', '≈'], ['\\le', '≤'], ['\\ge', '≥'], ['\\infty', '∞']];
  for (const pair of map) t = t.split(pair[0]).join(pair[1]);
  let out = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && /[A-Za-z]/.test(t[i + 1] || '')) {
      i++;
      while (i < t.length && /[A-Za-z]/.test(t[i])) i++;
      i--;
      continue;
    }
    if (t[i] === '{' || t[i] === '}') continue;
    out += t[i];
  }
  return out;
}

function applyEmphasis(src) {
  let out = '';
  const bold = String(src || '').split('**');
  for (let i = 0; i < bold.length; i++) out += i % 2 === 1 ? '<strong>' + bold[i] + '</strong>' : bold[i];
  out = out.replace(/(^|[\s(])\*([^*\s][^*<>]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  const tick = String.fromCharCode(96);
  const code = out.split(tick);
  if (code.length > 1) out = code.map((c, i) => (i % 2 === 1 ? '<code>' + c + '</code>' : c)).join('');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return out;
}

function inline(text) {
  let out = '';
  for (const part of splitMath(text)) {
    if (part.tex !== undefined) {
      out += '<span class="' + (part.display ? 'math-block' : 'math-inline') + '">' + renderTex(part.tex) + '</span>';
    } else {
      out += applyEmphasis(cleanTexText(part.text));
    }
  }
  return out;
}
function mathBlock(src) {
  return '<div class="math-block">' + renderTex(src) + '</div>';
}

function md(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const FENCE = String.fromCharCode(96, 96, 96);
  const out = [];
  let inCode = false;
  let code = [];
  let codeLang = '';
  let para = [];
  let lists = [];
  let table = null;

  const closePara = () => {
    if (!para.length) return;
    out.push('<p>' + inline(para.join('<br>')) + '</p>');
    para = [];
  };
  const isSep = (cells) => cells.length > 1 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
  const closeList = () => {
    while (lists.length) {
      const it = lists.pop();
      if (it.open) out.push('</li>');
      out.push('</' + it.type + '>');
    }
  };
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter((r) => !isSep(r));
    table = null;
    if (!rows.length) return;
    const head = rows.shift();
    let html = '<div class="table-wrap"><table><thead><tr>';
    for (const c of head) html += '<th>' + inline(esc(c.trim())) + '</th>';
    html += '</tr></thead><tbody>';
    for (const row of rows) {
      html += '<tr>';
      for (const c of row) html += '<td>' + inline(esc(c.trim())) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    out.push(html);
  };
  const listItem = (raw) => {
    const m = /^([ \t]*)([-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    if (!m) return false;
    const indent = m[1].replace(/\t/g, '    ').length;
    const type = m[2] === '-' || m[2] === '*' || m[2] === '•' ? 'ul' : 'ol';
    let text = m[3];
    let task = false;
    if (type === 'ul') {
      const box = /^\[([ xX])\]\s+/.exec(text);
      if (box) {
        task = true;
        text = (box[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') + text.slice(box[0].length);
      }
    }
    while (lists.length && indent < lists[lists.length - 1].indent) {
      const it = lists.pop();
      if (it.open) out.push('</li>');
      out.push('</' + it.type + '>');
    }
    if (!lists.length || indent > lists[lists.length - 1].indent) {
      lists.push({ type, indent, open: false });
      out.push('<' + type + '>');
    } else {
      const top = lists[lists.length - 1];
      if (top.type !== type) {
        if (top.open) { out.push('</li>'); top.open = false; }
        out.push('</' + top.type + '>');
        top.type = type;
        out.push('<' + type + '>');
      }
      if (top.open) out.push('</li>');
    }
    out.push('<li' + (task ? ' class="task"' : '') + '>' + inline(esc(text)));
    lists[lists.length - 1].open = true;
    return true;
  };

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const trimmed = raw.trim();

    if (table && !trimmed.startsWith('|')) flushTable();

    if (trimmed.startsWith(FENCE)) {
      if (!inCode) {
        closePara(); closeList();
        inCode = true;
        code = [];
        codeLang = trimmed.slice(3).trim().split(/\s+/)[0] || '';
      } else {
        out.push(codeBlockHtml(code.join('\n'), codeLang));
        inCode = false;
        codeLang = '';
      }
      continue;
    }
    if (inCode) { code.push(raw); continue; }
    if (!trimmed) { closePara(); closeList(); continue; }

    if (trimmed.startsWith('$$')) {
      closePara(); closeList(); flushTable();
      let body = trimmed.slice(2);
      if (body.endsWith('$$')) { out.push(mathBlock(body.slice(0, -2))); continue; }
      while (n + 1 < lines.length) {
        n++;
        const l2 = lines[n].trim();
        if (l2.endsWith('$$')) { body += '\n' + l2.slice(0, -2); break; }
        body += '\n' + l2;
      }
      out.push(mathBlock(body));
      continue;
    }

    if (trimmed.startsWith('|')) {
      closePara(); closeList();
      if (!table) table = [];
      let row = trimmed;
      if (row.startsWith('|')) row = row.slice(1);
      if (row.endsWith('|')) row = row.slice(0, -1);
      table.push(row.split('|'));
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closePara(); closeList();
      out.push('<hr>');
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      closePara(); closeList();
      const lvl = h[1].length;
      out.push('<h' + lvl + '>' + inline(esc(h[2])) + '</h' + lvl + '>');
      continue;
    }

    if (trimmed.startsWith('> ')) {
      closePara(); closeList();
      let q = trimmed.slice(2);
      while (n + 1 < lines.length && lines[n + 1].trim().startsWith('> ')) {
        n++;
        q += '\n' + lines[n].trim().slice(2);
      }
      out.push('<blockquote>' + inline(esc(q)).replace(/\n/g, '<br>') + '</blockquote>');
      continue;
    }

    if (listItem(raw)) { closePara(); continue; }

    closeList();
    para.push(esc(trimmed));
  }

  if (inCode) out.push(codeBlockHtml(code.join('\n'), codeLang));
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
  if (state.deepMode) return 'reasoning';
  // medium — старый уровень из ранних версий; в новой модели это Pro.
  return tier === 'easy' || tier === 'flash' ? 'flash' : 'pro';
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
async function applyMode(mode, silent) {
  const conf = MODES[mode];
  if (!conf || !state.settings) return;
  const planId = (state.plan && state.plan.id) || 'free';
  if (!state.isAdmin && planId === 'free' && mode !== 'flash') {
    if (!state.user) {
      toast('Войди в аккаунт, чтобы попробовать Pro');
      $('authModal').classList.remove('hidden');
      return;
    }
    const trial = Number(state.plan && state.plan.proTrial) || 2;
    const used = Number(state.usage && state.usage.proUsed) || 0;
    const left = Math.max(0, trial - used);
    if (left <= 0) {
      toast('Пробные Pro на сегодня закончились — подключи Pro или Ultra');
      if (!silent) openVip();
      return;
    }
    if (!silent) toast('Пробный Pro: ' + left + ' из ' + trial + ' запросов на сегодня');
  }
  state.settings.tier = conf.tier;
  state.deepMode = conf.deep;
  ui.deep = conf.deep;
  saveUi();
  setToggle('btnDeep', 'deepMode', state.deepMode ? 'Глубокое размышление включено' : 'Глубокое размышление: максимум рассуждений');
  renderTierSelect();
  closeTierMenu();
  if (silent) return;
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: conf.tier })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      if (j && j.needPlan) openVip();
    }
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

// Модель может вернуть рассуждения прямо в тексте — выносим их в отдельный спойлер.
function splitThinking(content, reasoning) {
  let body = String(content || '');
  let think = String(reasoning || '');
  const open = /<thinking[^>]*>/i.exec(body);
  if (open) {
    const rest = body.slice(open.index + open[0].length);
    const close = /<\/thinking\s*>/i.exec(rest);
    const inner = close ? rest.slice(0, close.index) : rest;
    if (inner.trim()) think = think ? think.trim() + '\n\n' + inner.trim() : inner.trim();
    body = (body.slice(0, open.index) + (close ? rest.slice(close.index + close[0].length) : '')).trim();
  }
  return { content: body, reasoning: think.trim() };
}

// Не показываем пользователю недописанный тег <thinking> посреди потока.
function partialTagTail(text, re) {
  const limit = Math.min(text.length, 40);
  for (let n = limit; n > 0; n--) {
    if (re.test(text.slice(-n))) return n;
  }
  return 0;
}

function createThinkFilter() {
  let mode = 'undecided';
  let buf = '';
  const OPEN = /^\s*<thinking[^>]*>/i;
  const OPEN_PREFIX = /^<\s*(?:t|th|thi|thin|think|thinking)?\s*>?$/i;
  const CLOSE = /<\/thinking\s*>/i;
  const CLOSE_PREFIX = /^<\/\s*(?:t|th|thi|thin|think|thinking)?\s*>?$/i;
  return {
    push(chunk) {
      const out = { reasoning: '', content: '' };
      buf += String(chunk || '');
      if (mode === 'undecided') {
        const m = OPEN.exec(buf);
        if (!m) {
          if (OPEN_PREFIX.test(buf.trim())) return out;
          out.content = buf;
          buf = '';
          mode = 'answer';
          return out;
        }
        buf = buf.slice(m[0].length);
        mode = 'thinking';
      }
      if (mode === 'thinking') {
        const m = CLOSE.exec(buf);
        if (!m) {
          const tail = partialTagTail(buf, CLOSE_PREFIX);
          out.reasoning = tail ? buf.slice(0, -tail) : buf;
          buf = tail ? buf.slice(-tail) : '';
          return out;
        }
        out.reasoning = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        mode = 'answer';
      }
      out.content = buf;
      buf = '';
      return out;
    },
    finish() {
      const out = { reasoning: '', content: '' };
      if (mode === 'thinking') out.reasoning = buf;
      else out.content = buf;
      buf = '';
      return out;
    }
  };
}

function messageNode(msg, question) {
  const row = el('div', 'msg ' + (msg.role === 'user' ? 'user' : 'assistant'));
  row.appendChild(avatar(msg.role));
  const bubble = el('div', 'bubble');

  const parsed = msg.role === 'assistant' ? splitThinking(msg.content, msg.reasoning) : { content: msg.content, reasoning: '' };
  if (msg.role === 'assistant' && /```photonn-tool/.test(String(parsed.content || ''))) {
    parsed.content = stripToolCalls(parsed.content) || '_Агент выполнял действия с файлами._';
  }
  const body = msg.role === 'assistant' && !String(parsed.content || '').trim()
    ? (parsed.reasoning ? '_Ответа нет — смотри «Ход мыслей»._' : '_Модель не вернула текст ответа. Нажми «Ещё раз» или выбери другой режим._')
    : parsed.content;

  if (msg.role === 'assistant' && parsed.reasoning) {
    const det = document.createElement('details');
    det.className = 'think';
    const sum = document.createElement('summary');
    sum.textContent = 'Ход мыслей';
    const thinkBody = el('div', 'think-body');
    thinkBody.innerHTML = md(parsed.reasoning);
    bindCodeCopy(thinkBody);
    det.append(sum, thinkBody);
    bubble.appendChild(det);
  }

  if (msg.image) bubble.appendChild(el('div', 'msg-attach', '📷 фото приложено'));
  if (msg.file && msg.file.name) bubble.appendChild(el('div', 'msg-attach', '📄 ' + msg.file.name));
  if (msg.search) bubble.appendChild(el('div', 'msg-attach', '🌐 поиск: ' + msg.search));

  const content = el('div', 'content');
  content.innerHTML = md(body);
  bindCodeCopy(content);
  bubble.appendChild(content);

  if (msg.role === 'assistant' && parsed.content) {
    bubble.appendChild(el('div', 'model-tag', tierLabel(msg.tier || 'pro') + (msg.fallback ? ' · резерв' : '')));
  }

  if (msg.role === 'assistant' && parsed.content) addActions(bubble, msg, question);

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
    if (m.role === 'user' && !m.hidden) question = m.content;
    if (m.hidden) continue;
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
  sum.textContent = 'Ход мыслей';
  const thinkBody = el('div', 'think-body streaming');
  det.append(sum, thinkBody);
  let userToggled = false;
  sum.addEventListener('click', () => { userToggled = true; });

  const content = el('div', 'content streaming');
  const typing = el('div', 'typing');
  typing.append(el('span'), el('span'), el('span'));
  // Счётчик секунд ожидания: видно, что запрос жив, а не повис.
  const startedAt = Date.now();
  const elapsed = el('span', 'typing-elapsed');
  typing.appendChild(elapsed);
  let tick = setInterval(() => {
    elapsed.textContent = Math.round((Date.now() - startedAt) / 1000) + ' с';
  }, 1000);
  const stopWait = () => { if (tick) { clearInterval(tick); tick = 0; } };
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
  let gotContent = false;
  let raf = 0;

  const paint = () => {
    raf = 0;
    stopWait();
    content.textContent = msg.content;
    scrollIfNear();
  };

  return {
    msg,
    row,
    setReasoning(text) {
      if (!text) return;
      msg.reasoning = text;
      if (typing.parentNode) typing.remove();
      det.classList.remove('hidden');
      if (!userToggled) det.open = true;
      thinkBody.textContent = text;
      scrollIfNear();
    },
    setModel(tier, model, fallback) {
      msg.tier = tier;
      msg.model = model;
      msg.fallback = Boolean(fallback);
      tag.textContent = tierLabel(tier || 'pro') + (fallback ? ' · резерв' : '');
      tag.classList.remove('hidden');
    },
    setSearch(query, found, failed, reason) {
      msg.search = query;
      searchNote.textContent = typeof found === 'number' && found >= 0
        ? (failed
          ? '🌐 поиск: «' + query + '» — не удалось (' + (reason || 'сервис недоступен') + ')'
          : '🌐 поиск: «' + query + '» — ' + (found ? 'найдено ' + found + ' источников' : 'ничего не найдено'))
        : '🌐 ищу в интернете: «' + query + '»…';
      searchNote.classList.remove('hidden');
      scrollIfNear();
    },
    noteRetry(n) {
      const note = el('div', 'retry-note');
      note.style.cssText = 'font-size:12px;color:#7d889c;margin:2px 0 5px';
      note.textContent = 'Модель отказалась отвечать — переспрашиваю другую (попытка ' + n + ')…';
      if (typing.parentNode) content.insertBefore(note, typing);
      else content.appendChild(note);
    },
    noteAutoPro() {
      const note = el('div', 'retry-note');
      note.style.cssText = 'font-size:12px;color:#7d889c;margin:2px 0 5px';
      note.textContent = 'Задача сложная — включил Pro, отвечает флагманская модель.';
      if (typing.parentNode) content.insertBefore(note, typing);
      else content.appendChild(note);
    },
    setContent(text) {
      msg.content = text;
      gotContent = Boolean(String(text).trim());
      // Как только пошёл ответ, спойлер размышлений сворачивается (если его не открыли вручную).
      if (gotContent && !userToggled) det.open = false;
      if (!raf) raf = requestAnimationFrame(paint);
    },
    fail(text) {
      failed = true;
      stopWait();
      content.classList.remove('streaming');
      content.innerHTML = '<p class="error-text">' + esc(text) + '</p>';
      det.open = false;
      row.classList.add('error');
    },
    finish() {
      stopWait();
      if (failed) { scrollIfNear(); return; }
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const parsed = splitThinking(msg.content, msg.reasoning);
      msg.content = parsed.content;
      msg.reasoning = parsed.reasoning;
      content.classList.remove('streaming');
      content.innerHTML = md(msg.content || (msg.reasoning ? '_Ответа нет — смотри «Ход мыслей»._' : '_Модель не вернула текст ответа._'));
      bindCodeCopy(content);
      if (msg.reasoning) {
        det.classList.remove('hidden');
        thinkBody.classList.remove('streaming');
        thinkBody.innerHTML = md(msg.reasoning);
        bindCodeCopy(thinkBody);
        det.open = false;
      }
      tag.textContent = tierLabel(msg.tier || 'pro') + (msg.fallback ? ' · резерв' : '');
      tag.classList.remove('hidden');
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
        file: opts && opts.file ? opts.file : undefined,
        web: opts && opts.agent ? false : state.webSearch,
        deep: state.deepMode,
        regen: Boolean(opts && opts.regen),
        agent: Boolean(opts && opts.agent),
        agentStep: Boolean(opts && opts.agentStep),
        hidden: Boolean(opts && opts.hidden)
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      let message = 'Ошибка ' + res.status;
      let j = null;
      try {
        j = await res.json();
        if (j && j.error) message = j.error;
      } catch (e) {}
      if (j && j.banned) { showBan(j.ban); throw new Error(message); }
      if (j && j.needPlan) openVip();
      else if (j && j.limitReached) openVip();
      if (j && j.needAuth) { $('authModal').classList.remove('hidden'); }
      throw new Error(message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const filter = createThinkFilter();

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
        if (j.meta) {
          view.setModel(j.meta.tier, j.meta.model, j.meta.fallback);
          if (j.meta.autoPro) view.noteAutoPro();
          if (j.meta.search) msg.search = j.meta.search;
          continue;
        }
        if (j.status && j.status.retry) {
          view.noteRetry(j.status.retry);
          continue;
        }
        if (j.status && j.status.search) {
          view.setSearch(j.status.search, typeof j.status.found === 'number' ? j.status.found : undefined, Boolean(j.status.failed), j.status.reason);
          continue;
        }
        if (j.error) throw new Error(j.error);
        if (j.final) {
          // Сервер досочинил текст после потока — заменяем пузырь целиком.
          msg.content = j.final.content || '';
          msg.reasoning = j.final.reasoning || '';
          if (msg.content) view.setContent(msg.content);
          if (msg.reasoning) view.setReasoning(msg.reasoning);
          continue;
        }
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (!d) continue;
        if (d.reasoning_content) {
          msg.reasoning += d.reasoning_content;
          view.setReasoning(msg.reasoning);
        }
        if (d.content) {
          const part = filter.push(d.content);
          if (part.reasoning) { msg.reasoning += part.reasoning; view.setReasoning(msg.reasoning); }
          if (part.content) { msg.content += part.content; view.setContent(msg.content); }
        }
      }
    }
    const tail = filter.finish();
    if (tail.reasoning) { msg.reasoning += tail.reasoning; view.setReasoning(msg.reasoning); }
    if (tail.content) { msg.content += tail.content; view.setContent(msg.content); }
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
    await refreshAccount();
  }
  return msg.content;
}

// ── Агент: мост на компьютере, подтверждения, цикл инструментов ─────
const AGENT_MAX_STEPS = 6;
const AGENT_ICONS = { list: '📁', read: '📄', write: '✏️', patch: '🩹', exec: '⌘' };

function shortPath(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || p || '.';
}

function agentStatus(text, kind) {
  const n = $('agentStatus');
  if (!n) return;
  n.textContent = text;
  n.className = 'agent-status' + (kind ? ' ' + kind : '');
}

function openAgentModal() {
  const m = $('agentModal');
  if (!m) return;
  if (agent.token) $('agentToken').value = agent.token;
  if (agent.root) $('agentRoot').value = agent.root;
  agentStatus(agent.connected ? 'Подключено: ' + agent.root : 'Мост не подключён', agent.connected ? 'ok' : '');
  m.classList.remove('hidden');
  setTimeout(() => { try { $('agentToken').focus(); } catch (e) {} }, 40);
}

function closeAgentModal() {
  const m = $('agentModal');
  if (m) m.classList.add('hidden');
}

function applyAgentUI() {
  const b = $('btnAgent');
  if (b) {
    b.classList.toggle('on', agent.on);
    b.title = agent.on
      ? (agent.connected ? 'Агент подключён: ' + agent.root : 'Агент включён, мост не подключён')
      : 'Агент: доступ к файлам на компьютере';
  }
  const strip = $('agentStrip');
  if (strip) {
    strip.classList.toggle('hidden', !agent.on);
    const t = strip.querySelector('.agent-strip-text');
    if (t) t.textContent = agent.connected
      ? (shortPath(agent.root) + (agent.allowExec ? ' · файлы и команды' : ' · только файлы'))
      : 'мост не подключён';
  }
  const input = $('input');
  if (input) input.placeholder = agent.on ? 'Задача агенту: что изменить в проекте…' : 'Спросить photonnAI';
}

async function agentBridge(pathname, body) {
  const headers = { 'X-Agent-Token': agent.token };
  if (body) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(agent.url + pathname, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('мост не отвечает на ' + agent.url.replace('http://', '') + ' — он запущен?');
  }
  if (r.status === 401) throw new Error('токен не совпал — скопируй его из консоли моста');
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || ('мост вернул ' + r.status));
  return j || {};
}

// Молчаливое переподключение при загрузке: токен уже сохранён, мост мог остаться запущенным.
async function autoConnectAgent() {
  if (!agent.token) return;
  try {
    const info = await agentBridge('/info');
    agent.connected = true;
    agent.root = info.root || agent.root;
    agent.allowExec = Boolean(info.allowExec);
    applyAgentUI();
  } catch (e) {
    agent.connected = false;
    applyAgentUI();
  }
}

async function connectAgent() {
  const btn = $('agentConnect');
  agent.token = $('agentToken').value.trim();
  const root = $('agentRoot').value.trim();
  if (!agent.token) { agentStatus('Вставь токен из консоли моста', 'err'); return; }
  btn.disabled = true;
  agentStatus('Подключаюсь…');
  try {
    if (root) await agentBridge('/workspace', { root });
    const info = await agentBridge('/info');
    agent.connected = true;
    agent.root = info.root || root;
    agent.allowExec = Boolean(info.allowExec);
    agent.on = true;
    saveAgent();
    applyAgentUI();
    agentStatus('Подключено: ' + agent.root, 'ok');
    closeAgentModal();
    toast('Агент подключён · ' + shortPath(agent.root));
  } catch (e) {
    agent.connected = false;
    applyAgentUI();
    agentStatus(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function extractToolCalls(text) {
  const out = [];
  const src = String(text || '');
  const re = /```photonn-tool\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(src))) {
    try { const j = JSON.parse(m[1].trim()); if (j && j.tool) out.push(j); } catch (e) {}
  }
  if (!out.length) {
    // Модель иногда кладёт вызов в обычный json-блок — принимаем и такой вариант.
    const anyFence = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g;
    let f;
    while ((f = anyFence.exec(src))) {
      try {
        const j = JSON.parse(f[1].trim());
        if (j && j.tool) out.push(j);
      } catch (e) {}
    }
  }
  if (!out.length) {
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{') || !t.endsWith('}')) continue;
      try { const j = JSON.parse(t); if (j && j.tool) out.push(j); } catch (e) {}
    }
  }
  return out.slice(0, 4);
}

function stripToolCalls(text) {
  return String(text || '')
    .replace(/```photonn-tool[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizeToolResult(call, res) {
  if (res && res.skipped) return 'ОТКЛОНЕНО пользователем: действие НЕ выполнено, файл не изменён. Не утверждай, что оно выполнено.';
  if (!res) return 'пусто';
  const clamp = (s, n) => String(s == null ? '' : s).slice(0, n || 4000);
  if (call.tool === 'list') {
    const items = (res.entries || []).map((e) => (e.type === 'dir' ? e.name + '/' : e.name)).join('\n');
    return items ? clamp(items, 4000) : '(пусто)';
  }
  if (call.tool === 'read') return clamp(res.content, 6000) + (res.truncated ? '\n…(файл обрезан)' : '');
  if (call.tool === 'write') return 'записано ' + res.bytes + ' байт' + (res.backup ? ' · бэкап ' + res.backup : '');
  if (call.tool === 'patch') return 'правка применена, ' + res.bytes + ' байт' + (res.backup ? ' · бэкап ' + res.backup : '');
  if (call.tool === 'exec') return 'код ' + res.code + '\nstdout:\n' + clamp(res.stdout, 2500) + (res.stderr ? '\nstderr:\n' + clamp(res.stderr, 2500) : '');
  return clamp(JSON.stringify(res), 3000);
}

function briefTool(call, res) {
  if (call.tool === 'list') return (res.entries || []).length + ' объектов';
  if (call.tool === 'read') return res.size + ' байт';
  if (call.tool === 'write' || call.tool === 'patch') return res.bytes + ' байт' + (res.backup ? ' · бэкап' : '');
  if (call.tool === 'exec') return 'код ' + res.code;
  return 'готово';
}

function agentOp(call) {
  const box = $('messages');
  const card = el('div', 'agent-op run');
  const head = el('div', 'agent-op-head');
  head.append(el('span', 'agent-op-ico', AGENT_ICONS[call.tool] || '⚙'), el('b', '', String(call.tool || '')));
  head.appendChild(el('code', '', call.path || call.cmd || '.'));
  const detail = el('div', 'agent-op-detail', 'выполняю…');
  card.append(head, detail);
  box.appendChild(card);
  box.scrollTop = box.scrollHeight;
  return card;
}

function paintAgentOp(card, call, res, err) {
  const detail = card.querySelector('.agent-op-detail');
  if (err) { card.className = 'agent-op err'; detail.textContent = err; return; }
  if (res && res.skipped) { card.className = 'agent-op skip'; detail.textContent = 'отклонено пользователем'; return; }
  card.className = 'agent-op ok';
  detail.textContent = briefTool(call, res);
}

function agentNote(text) {
  const box = $('messages');
  const n = el('div', 'agent-note', String(text).slice(0, 500));
  box.appendChild(n);
  box.scrollTop = box.scrollHeight;
}

function agentConfirm(call) {
  return new Promise((resolve) => {
    const back = $('agentConfirm');
    const title = $('agentConfirmTitle');
    const pathEl = $('agentConfirmPath');
    const bodyEl = $('agentConfirmBody');
    const allowAll = $('agentApproveAll');
    const allow = $('agentAllow');
    const deny = $('agentDeny');
    if (!back || !title || !allow || !deny) return resolve(false);
    const titles = { write: 'Записать файл', patch: 'Изменить файл', exec: 'Выполнить команду' };
    title.textContent = titles[call.tool] || 'Действие агента';
    pathEl.textContent = call.tool === 'exec'
      ? (call.cwd ? call.cwd + ' › ' : '') + (call.cmd || '')
      : (call.path || '.');
    if (call.tool === 'write') {
      bodyEl.textContent = String(call.content == null ? '' : call.content).slice(0, 1600) || '(пустой файл)';
    } else if (call.tool === 'patch') {
      bodyEl.textContent = '− ' + String(call.old || '').slice(0, 700) + '\n\n+ ' + String(call.new || '').slice(0, 700);
    } else {
      bodyEl.textContent = call.tool === 'exec' ? 'Выполнится в папке ' + (call.cwd || '.') : '';
    }
    allowAll.checked = false;
    back.classList.remove('hidden');
    allowAll.disabled = false;
    const done = (ok) => {
      back.classList.add('hidden');
      allow.onclick = null;
      deny.onclick = null;
      if (ok && allowAll.checked) agent.autoApprove = true;
      resolve(ok);
    };
    allow.onclick = () => done(true);
    deny.onclick = () => done(false);
  });
}

async function runAgentTool(call) {
  const tool = String(call.tool || '');
  if (!['list', 'read', 'write', 'patch', 'exec'].includes(tool)) throw new Error('неизвестный инструмент: ' + tool);
  if (tool === 'exec' && !agent.allowExec) throw new Error('выполнение команд выключено в мосту (--allow-exec)');
  if ((tool === 'write' || tool === 'patch' || tool === 'exec') && !agent.autoApprove) {
    const ok = await agentConfirm(call);
    if (!ok) return { skipped: true };
  }
  const args = { path: call.path, content: call.content, old: call.old, new: call.new, cmd: call.cmd, cwd: call.cwd };
  const j = await agentBridge('/call', { tool, args });
  return j.result || {};
}

async function revealAgentAnswer() {
  if (!state.currentId) return;
  try {
    await fetch('/api/chats/' + encodeURIComponent(state.currentId) + '/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reveal: true })
    });
  } catch (e) {}
}

async function agentRun(text) {
  if (!agent.connected) { openAgentModal(); toast('Сначала подключи мост агента'); return; }
  agent.busy = true;
  let results = '';
  let finalSeen = false;
  try {
    for (let step = 0; step < AGENT_MAX_STEPS; step++) {
      const prompt = step === 0 ? text : 'Результаты инструментов:\n' + results;
      const msg = { role: 'assistant', content: '', reasoning: '' };
      state.messages.push(msg);
      const view = appendStreamingMessage(msg);
      const out = await streamReply(view, prompt, { agent: true, hidden: step > 0, agentStep: step > 0 });
      const calls = extractToolCalls(out);
      if (!calls.length) { finalSeen = true; break; }
      view.row.remove();
      const at = state.messages.indexOf(msg);
      if (at >= 0) state.messages.splice(at, 1);
      const plan = stripToolCalls(out);
      if (plan) agentNote(plan);
      results = '';
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const card = agentOp(call);
        let res = null;
        let err = '';
        try { res = await runAgentTool(call); } catch (e) { err = e.message || 'ошибка инструмента'; }
        paintAgentOp(card, call, res, err);
        results += '[' + (i + 1) + '] ' + call.tool + '(' + (call.path || call.cmd || '') + ')\n'
          + (err ? 'ОШИБКА: ' + err : summarizeToolResult(call, res)) + '\n\n';
      }
    }
    if (!finalSeen) toast('Агент остановился на ' + AGENT_MAX_STEPS + ' шагах — уточни задачу');
  } finally {
    agent.busy = false;
    setStreamingUI(false);
  }
  if (finalSeen) await revealAgentAnswer();
  await loadChats();
  await refreshAccount();
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
  const attachedFile = state.pendingFile;
  if ((!text && !state.pendingImage && !attachedFile) || state.streaming || agent.busy) return;
  if (state.banned) { showBan(state.banned); return; }
  if (!state.hasKey) { renderMessages(); toast('Сначала добавь API-ключ NVIDIA'); return; }
  if (agent.on && !state.pendingImage && !attachedFile) {
    if (!state.user) { $('authModal').classList.remove('hidden'); toast('Агент доступен после входа в аккаунт'); return; }
    if (!agent.connected) { openAgentModal(); toast('Мост агента не подключён'); return; }
  }
  if (!state.currentId) await newChat(true);
  if (state.pendingImage && !text) text = 'Проанализируй это фото.';
  if (state.pendingImage) text += '\n(приложено фото — проанализируй его)';
  if (attachedFile && !text) text = 'Проанализируй приложенный файл.';

  input.value = '';
  resizeInput();

  const userMsg = {
    role: 'user',
    content: text.trim(),
    image: Boolean(state.pendingImage),
    file: attachedFile ? { name: attachedFile.name, type: attachedFile.type } : undefined
  };
  state.messages.push(userMsg);
  const box = $('messages');
  const welcome = box.querySelector('.welcome');
  if (welcome) welcome.remove();
  setStageEmpty(false);
  box.appendChild(messageNode(userMsg));
  box.scrollTop = box.scrollHeight;

  if (agent.on && agent.connected && !state.pendingImage && !attachedFile) {
    try {
      await agentRun(text);
    } finally {
      clearPendingImage();
    }
    return;
  }

  const msg = { role: 'assistant', content: '', reasoning: '' };
  state.messages.push(msg);
  const view = appendStreamingMessage(msg);
  try {
    await streamReply(view, userMsg.content, { file: attachedFile || undefined });
  } finally {
    clearPendingImage();
  }
}

let pendingImageData = null;
function formatBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return size + ' Б';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1).replace('.0', '') + ' КБ';
  return (size / (1024 * 1024)).toFixed(1) + ' МБ';
}

function renderAttachment() {
  const wrap = $('imgPreview');
  if (!wrap) return;
  const hasImage = Boolean(state.pendingImage);
  const hasFile = Boolean(state.pendingFile);
  wrap.classList.toggle('hidden', !hasImage && !hasFile);
  $('previewThumb').classList.toggle('hidden', !hasImage);
  $('previewFile').classList.toggle('hidden', !hasFile);
  if (hasImage) $('previewThumb').src = state.pendingImage;
  if (hasFile) {
    $('previewName').textContent = state.pendingFile.name;
    $('previewMeta').textContent = formatBytes(state.pendingFile.size) + ' · текст';
    $('previewIcon').textContent = '📄';
  }
}

function setPendingImage(dataUrl) {
  pendingImageData = dataUrl;
  state.pendingImage = dataUrl || null;
  if (dataUrl) state.pendingFile = null;
  renderAttachment();
}

function setPendingFile(file) {
  state.pendingFile = file || null;
  if (file) {
    state.pendingImage = null;
    pendingImageData = null;
  }
  renderAttachment();
}

function clearPendingImage() {
  state.pendingImage = null;
  state.pendingFile = null;
  pendingImageData = null;
  renderAttachment();
  ['fileInput', 'cameraInput', 'anyFileInput'].forEach((id) => { if ($(id)) $(id).value = ''; });
}

function setToggle(id, key, title) {
  const b = $(id);
  b.classList.toggle('on', state[key]);
  b.title = title;
}

function currentPlanData() {
  const plans = state.plans || PLANS_FALLBACK;
  const id = (state.plan && state.plan.id) || 'free';
  return plans[id] || PLANS_FALLBACK[id] || PLANS_FALLBACK.free;
}

function formatPlanUntil(ts) {
  if (!ts) return 'бессрочно';
  try {
    return 'до ' + new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (e) { return ''; }
}

const AD_UNIT_HTML = `
  <input autocomplete="off" type="checkbox" id="aadsstickymwxj8cwh" hidden>
  <div style="padding-top:0;padding-bottom:0">
    <div style="width:15%;height:100%;position:fixed;text-align:center;font-size:0;top:50%;transform:translateY(-50%);right:0;min-width:100px">
      <label for="aadsstickymwxj8cwh" style="bottom:24px;margin:0 auto;right:0;left:0;max-width:24px;position:absolute;border-radius:4px;background:rgba(248,248,249,.7);padding:4px;z-index:99999;cursor:pointer">
        <svg fill="#000000" height="16px" width="16px" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 490 490"><polygon points="456.851,0 245,212.564 33.149,0 0.708,32.337 212.669,245.004 0.708,457.678 33.149,490 245,277.443 456.851,490 489.292,457.678 277.331,245.004 489.292,32.337"/></svg>
      </label>
      <div id="frame" style="width:100%;margin:auto;position:relative;z-index:99998;height:100%;display:flex;flex-direction:column;justify-content:center">
        <iframe data-aa="2463382" src="//acceptable.a-ads.com/2463382/?size=Adaptive" style="border:0;padding:0;width:70%;height:70%;overflow:hidden;margin:0 auto"></iframe>
      </div>
    </div>
    <style>#aadsstickymwxj8cwh:checked + div{display:none}</style>
  </div>`;

function applyAdVisibility() {
  if (!state.booted) return;
  const ads = state.settings && state.settings.ads ? state.settings.ads : { mode: 'free' };
  const plan = (state.plan && state.plan.id) || 'free';
  const show = ads.mode !== 'off' && ads.show !== false && plan === 'free' && !state.banned && !state.isAdmin;
  let unit = $('adUnit');
  if (show && !unit) {
    unit = document.createElement('div');
    unit.id = 'adUnit';
    unit.className = 'ad-unit';
    unit.style.position = 'absolute';
    unit.style.zIndex = '99999';
    unit.innerHTML = AD_UNIT_HTML;
    document.body.appendChild(unit);
  } else if (!show && unit) {
    unit.remove();
  }
  document.body.classList.toggle('ads-off', !show);
}


function updatePlanUI() {
  const plan = (state.plan && state.plan.id) || 'free';
  const label = (state.plan && state.plan.label) || (PLANS_FALLBACK[plan] && PLANS_FALLBACK[plan].label) || 'Free';
  const limit = (state.plan && state.plan.limit) || (PLANS_FALLBACK[plan] && PLANS_FALLBACK[plan].limit) || 18;
  const used = state.usage ? Number(state.usage.used) || 0 : 0;
  const proTrial = Number(state.plan && state.plan.proTrial) || 2;
  const proUsed = Number(state.usage && state.usage.proUsed) || 0;
  const trialLeft = Math.max(0, proTrial - proUsed);

  // На Free Pro доступен только как 2 пробных запроса; когда они кончились — Flash.
  if (!state.isAdmin && plan === 'free' && trialLeft <= 0 && currentMode() !== 'flash') {
    state.deepMode = false;
    state.settings.tier = 'easy';
    ui.deep = false;
    saveUi();
  }

  const meter = $('planMeter');
  if (meter) {
    meter.textContent = label + ' · ' + used + ' / ' + limit;
    meter.className = 'plan-meter plan-' + plan + (used >= limit ? ' limit' : '');
    meter.title = 'Тариф ' + label + ': ' + used + ' из ' + limit + ' запросов сегодня' +
      (plan === 'free' ? ' · Pro пробно: ' + trialLeft + ' из ' + proTrial : '');
  }
  const avatar = $('railAvatar');
  if (avatar) avatar.className = 'rail-avatar plan-' + plan;
}

async function refreshAccount() {
  try {
    const j = await (await fetch('/api/state')).json();
    state.hasKey = Boolean(j.hasKey);
    state.hint = j.hint || null;
    state.settings = j.settings || state.settings;
    state.plans = j.plans || state.plans;
    state.user = j.user || null;
    state.plan = j.plan || null;
    state.usage = j.usage || null;
    state.isAdmin = Boolean(j.isAdmin);
    state.banned = j.banned || null;
    if (state.banned) showBan(state.banned);
    else hideBan();
    if (ui.deep && !state.deepMode) {
      state.deepMode = true;
      setToggle('btnDeep', 'deepMode', 'Глубокое размышление включено');
    }
    updatePlanUI();
    applyAdVisibility();
    renderTierSelect();
    renderAuth();
    if (!$('vipModal').classList.contains('hidden')) renderPlanModal();
  } catch (e) {}
}

async function initAuth() {
  // Не обнуляем state до ответа сервера: init() стартует параллельно и иначе
  // принимает залогиненного пользователя за гостя и сбрасывает Pro-режим.
  await refreshAccount();
}

function renderAuth() {
  const box = $('sideAuth');
  box.innerHTML = '';
  const av = $('railAvatar');
  const initial = state.user && (state.user.name || state.user.email) ? String(state.user.name || state.user.email).trim().charAt(0) : '?';
  if (av) {
    av.textContent = (initial || '?').toUpperCase();
    av.title = state.user ? state.user.email : 'Войти или создать аккаунт';
    av.className = 'rail-avatar plan-' + ((state.plan && state.plan.id) || 'free');
  }
  if (!state.user) {
    const b = document.createElement('button');
    b.className = 'auth-btn';
    b.textContent = 'Войти или создать аккаунт';
    b.addEventListener('click', () => $('authModal').classList.remove('hidden'));
    box.appendChild(b);
    return;
  }
  const plan = (state.plan && state.plan.id) || 'free';
  const planLabel = (state.plan && state.plan.label) || PLANS_FALLBACK[plan].label;
  const limit = (state.plan && state.plan.limit) || PLANS_FALLBACK[plan].limit;
  const used = state.usage ? Number(state.usage.used) || 0 : 0;
  const proTrial = Number(state.plan && state.plan.proTrial) || 2;
  const proUsed = Number(state.usage && state.usage.proUsed) || 0;
  const card = el('div', 'profile-card');
  const head = el('div', 'profile-head');
  const portrait = el('div', 'profile-avatar plan-' + plan, String(state.user.name || state.user.email).charAt(0).toUpperCase());
  const info = el('div', 'profile-info');
  info.append(el('b', 'profile-name', state.user.name || state.user.email.split('@')[0]), el('small', 'profile-email', state.user.email));
  const badge = el('span', 'plan-badge plan-' + plan, planLabel);
  head.append(portrait, info, badge);
  card.appendChild(head);
  const meter = el('div', 'profile-meter');
  const bar = el('span');
  bar.style.width = Math.min(100, limit ? (used / limit) * 100 : 0) + '%';
  const track = el('div', 'profile-meter-track');
  track.appendChild(bar);
  meter.append(track, el('small', null, used + ' / ' + limit + ' запросов сегодня'));
  card.appendChild(meter);
  if (plan !== 'free') {
    card.appendChild(el('small', 'profile-until', 'Подписка ' + formatPlanUntil(state.user.planExpiresAt)));
  } else {
    card.appendChild(el('small', 'profile-until', 'Пробный Pro: ' + Math.max(0, proTrial - proUsed) + ' из ' + proTrial + ' на сегодня'));
  }
  const actions = el('div', 'profile-actions');
  const planBtn = el('button', 'profile-btn primary-soft', 'Сменить план');
  planBtn.onclick = openVip;
  actions.appendChild(planBtn);
  if (state.isAdmin || state.user.role === 'admin') {
    const adminLink = document.createElement('a');
    adminLink.href = '/admin';
    adminLink.className = 'profile-btn';
    adminLink.textContent = 'Админка';
    actions.appendChild(adminLink);
  }
  const logout = el('button', 'profile-btn danger-soft', 'Выйти');
  logout.onclick = logoutUser;
  actions.appendChild(logout);
  card.appendChild(actions);
  box.appendChild(card);
}

async function logoutUser() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
  // Если открыта админ-сессия, выходим и из неё: иначе гость остаётся с правами админа.
  if (state.isAdmin) {
    try { await fetch('/api/admin/logout', { method: 'POST' }); } catch (e) {}
  }
  state.user = null;
  state.plan = null;
  state.usage = null;
  state.isAdmin = false;
  state.banned = null;
  hideBan();
  renderAuth();
  updatePlanUI();
  location.href = '/';
}

function showBan(ban) {
  if (!ban) return hideBan();
  state.banned = ban;
  applyAdVisibility();
  $('banReason').textContent = 'Причина: ' + (ban.reason || 'не указана');
  $('banUntil').textContent = ban.forever || !ban.until
    ? 'Блокировка бессрочная.'
    : 'До: ' + new Date(ban.until).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('banScreen').classList.remove('hidden');
  document.body.classList.add('banned');
}

function hideBan() {
  const screen = $('banScreen');
  if (screen) screen.classList.add('hidden');
  document.body.classList.remove('banned');
}

function openVip() {
  $('vipModal').classList.remove('hidden');
  renderPlanModal();
}

function renderPlanModal() {
  const plans = state.plans || PLANS_FALLBACK;
  const active = currentPlanData();
  const activeId = active.id || 'free';
  const used = state.usage ? Number(state.usage.used) || 0 : 0;
  const limit = active.limit || 18;
  const proTrial = Number(active.proTrial) || 2;
  const proUsed = Number(state.usage && state.usage.proUsed) || 0;
  $('planCurrent').textContent = active.label || 'Free';
  $('planCurrentMeta').textContent = activeId === 'free'
    ? limit + ' запросов в день · Flash + ' + proTrial + ' пробных Pro'
    : (limit + ' запросов в день · ' + formatPlanUntil(state.user && state.user.planExpiresAt));
  $('planUsage').textContent = activeId === 'free'
    ? 'Сегодня использовано ' + used + ' из ' + limit + ' · Pro ' + Math.min(proUsed, proTrial) + ' из ' + proTrial
    : 'Сегодня использовано ' + used + ' из ' + limit;

  const grid = $('planGrid');
  grid.innerHTML = '';
  ['free', 'pro', 'ultra'].forEach((id) => {
    const p = plans[id] || PLANS_FALLBACK[id];
    const card = el('div', 'plan-card plan-' + id + (id === activeId ? ' active' : ''));
    if (id === 'ultra') card.classList.add('featured');
    const top = el('div', 'plan-card-top');
    top.append(el('span', 'plan-card-name', p.label));
    if (id === 'pro') top.append(el('span', 'plan-pop', 'популярный'));
    if (id === 'ultra') top.append(el('span', 'plan-pop', 'максимум'));
    card.appendChild(top);
    const price = el('div', 'plan-price');
    if (p.price) {
      price.append(el('b', null, String(p.price)), el('small', null, ' сом / мес'));
    } else {
      price.append(el('b', null, '0'), el('small', null, ' сом'));
    }
    card.appendChild(price);
    const list = el('ul', 'plan-features');
    if (id === 'free') {
      list.append(el('li', null, p.limit + ' запросов в день'), el('li', null, 'Flash — быстрые ответы'), el('li', null, (p.proTrial || 2) + ' пробных Pro и Reasoning в день'), el('li', null, 'Веб-поиск, фото и файлы'));
    } else {
      list.append(el('li', null, p.limit + ' запросов в день'), el('li', null, 'Flash, Pro и Reasoning'), el('li', null, 'Без рекламы'));
    }
    card.appendChild(list);
    const btn = el('button', 'plan-select' + (id === activeId ? ' current' : ''));
    if (id === activeId) {
      btn.textContent = 'Текущий тариф';
      btn.disabled = true;
    } else if (id === 'free') {
      btn.textContent = 'Базовый';
      btn.disabled = true;
    } else if (!state.user) {
      btn.textContent = 'Войти в аккаунт';
      btn.onclick = () => {
        $('vipModal').classList.add('hidden');
        $('authModal').classList.remove('hidden');
      };
    } else {
      btn.textContent = 'Выбрать ' + p.label;
      btn.onclick = () => {
        $('vipCode').focus();
        $('vipNote').textContent = 'Оплата по договорённости с Photonn: получи промокод у администратора и активируй его ниже.';
      };
    }
    card.appendChild(btn);
    grid.appendChild(card);
  });

  const promo = document.querySelector('.plan-promo');
  const code = $('vipCode');
  const submit = $('vipActivate');
  const note = $('vipNote');
  if (!state.user) {
    if (promo) promo.classList.add('hidden');
    submit.textContent = 'Войти в аккаунт';
    if (note) note.textContent = 'Войди или создай бесплатный аккаунт — после этого можно активировать промокод.';
  } else {
    if (promo) promo.classList.remove('hidden');
    submit.textContent = 'Активировать';
    if (note) note.textContent = activeId === 'free'
      ? 'Оплата по договорённости с Photonn. Введи промокод, чтобы открыть Pro или Ultra.'
      : 'Подписка активна. Промокод продлит текущий тариф.';
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
      $('authModal').classList.add('hidden');
      $('authPass').value = '';
      await refreshAccount();
      // У гостя и аккаунта разные владельцы чатов: после входа показываем историю аккаунта.
      state.currentId = null;
      state.messages = [];
      await loadChats();
      if (state.chats.length) await openChat(state.chats[0].id);
      else { renderMessages(); updateCrumb(); }
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
    const code = $('vipCode').value.trim();
    if (!code) { toast('Введи промокод'); $('vipCode').focus(); return; }
    const btn = $('vipActivate');
    btn.disabled = true;
    try {
      const r = await fetch('/api/vip/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const j = await r.json();
      if (!r.ok) { toast(j.error || 'Ошибка'); return; }
      $('vipCode').value = '';
      await refreshAccount();
      $('vipModal').classList.add('hidden');
      toast('Тариф ' + (j.plan && j.plan.planLabel ? j.plan.planLabel : 'активирован') + ' активирован ✨');
    } catch (e) { toast('Сеть недоступна'); }
    finally { btn.disabled = false; }
  });
  $('banLogout').addEventListener('click', logoutUser);
}
initAuthUI();
initAuth();

function initTools() {
  state.pendingImage = null;
  state.pendingFile = null;
  state.webSearch = false;
  const planId = (state.plan && state.plan.id) || 'free';
  state.deepMode = Boolean(ui.deep) && (planId !== 'free' || state.isAdmin);

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

  // Голосовой ввод: там, где Web Speech API нет, работает понятная демо-подстановка.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('btnMic');
  if (SR) {
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
        else if (ev.error === 'network') toast('Голосовой ввод недоступен без сети');
      };
      rec.onend = () => { rec = null; mic.classList.remove('on'); $('input').focus(); };
      try { rec.start(); } catch (e) { rec = null; mic.classList.remove('on'); }
    });
  } else {
    mic.title = 'Голосовой ввод (демо)';
    mic.addEventListener('click', () => {
      const input = $('input');
      if (input.value.trim()) { toast('Очисти поле, чтобы попробовать демо-ввод'); return; }
      toast('Браузер не поддерживает распознавание — подставляю демо-фразу');
      setTimeout(() => {
        input.value = 'Помоги составить план на день и выделить главное';
        resizeInput();
        input.focus();
      }, 450);
    });
  }

  const readImage = (inp) => {
    const f = $(inp).files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast('Выбери изображение PNG, JPEG или WebP'); $(inp).value = ''; return; }
    if (f.size > 6 * 1024 * 1024) { toast('Фото больше 6 МБ — выбери поменьше'); $(inp).value = ''; return; }
    const r = new FileReader();
    r.onload = () => setPendingImage(String(r.result));
    r.readAsDataURL(f);
    $(inp).value = '';
  };
  $('fileInput').addEventListener('change', () => readImage('fileInput'));
  $('cameraInput').addEventListener('change', () => readImage('cameraInput'));
  $('anyFileInput').addEventListener('change', () => {
    const inp = $('anyFileInput');
    const f = inp.files[0];
    if (!f) return;
    if (f.size > 512 * 1024) { toast('Текстовый файл больше 512 КБ — выбери поменьше'); inp.value = ''; return; }
    const okExt = /\.(txt|md|markdown|csv|json|js|ts|css|html|py|java|sql|log|xml|ya?ml)$/i.test(f.name);
    if (!okExt && !/^text\//.test(f.type) && f.type !== 'application/json') {
      toast('Поддерживаются текстовые файлы: TXT, MD, CSV, JSON, код');
      inp.value = '';
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      const content = String(r.result || '');
      if (!content.trim()) { toast('Файл пустой'); return; }
      setPendingFile({ name: f.name, size: f.size, type: f.type || 'text/plain', content: content.slice(0, 200000) });
    };
    r.onerror = () => toast('Не удалось прочитать файл');
    r.readAsText(f);
    inp.value = '';
  });
  $('imgRemove').addEventListener('click', clearPendingImage);
  $('btnWeb').addEventListener('click', () => {
    state.webSearch = !state.webSearch;
    setToggle('btnWeb', 'webSearch', state.webSearch ? 'Веб-поиск включён' : 'Веб-поиск: модель найдёт свежие данные');
  });
  $('btnDeep').addEventListener('click', () => {
    if (!state.isAdmin && ((state.plan && state.plan.id) || 'free') === 'free') {
      toast('Reasoning доступен на тарифе Pro или Ultra');
      openVip();
      return;
    }
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
    if (!r.ok || !j.chat) {
      if (j && j.banned) showBan(j.ban);
      toast((j && j.error) || 'Не удалось создать чат');
      return null;
    }
    state.currentId = j.chat.id;
    state.messages = [];
    await loadChats();
    if (!silent) renderMessages();
    $('input').focus();
    return j.chat.id;
  } catch (e) { toast('Нет связи с сервером'); return null; }
}

async function openChat(id) {
  const r = await fetch('/api/chats/' + id);
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    if (j && j.banned) showBan(j.ban);
    return;
  }
  const j = await r.json();
  state.currentId = id;
  state.messages = j.chat.messages || [];
  // Режим выбирает пользователь, а не история: переключение чата не должно
  // незаметно менять Flash/Pro. Ограничения тарифа проверяет updatePlanUI().
  updatePlanUI();
  renderTierSelect();
  renderMessages();
  renderChatList();
  document.body.classList.remove('side-open');
}

async function loadChats() {
  try {
    const r = await fetch('/api/chats');
    const j = await r.json();
    if (!r.ok) {
      if (j && j.banned) showBan(j.ban);
      state.chats = [];
      renderChatList();
      return;
    }
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
    const title = el('div', 'chat-title', c.title || 'Без названия');
    const tools = el('div', 'chat-tools');

    const rename = el('button', 'chat-tool', '✎');
    rename.title = 'Переименовать чат';
    rename.setAttribute('aria-label', 'Переименовать чат');
    rename.onclick = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'chat-rename';
      input.value = c.title || 'Без названия';
      input.maxLength = 100;
      title.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const restore = () => { if (!finished) { finished = true; input.replaceWith(title); } };
      const commit = async () => {
        if (finished) return;
        const value = input.value.replace(/\s+/g, ' ').trim();
        if (!value || value === c.title) { finished = true; input.replaceWith(title); return; }
        finished = true;
        try {
          const r = await fetch('/api/chats/' + encodeURIComponent(c.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: value })
          });
          if (!r.ok) throw new Error();
          c.title = value;
          title.textContent = value;
          input.replaceWith(title);
          updateCrumb();
        } catch (err) {
          input.replaceWith(title);
          toast('Не удалось переименовать чат');
        }
      };
      input.onclick = (ev) => ev.stopPropagation();
      input.onblur = commit;
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        else if (ev.key === 'Escape') { finished = true; input.replaceWith(title); }
      };
    };

    const del = el('button', 'chat-tool danger', '✕');
    del.title = 'Удалить чат';
    del.setAttribute('aria-label', 'Удалить чат');
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Удалить этот чат?')) return;
      await fetch('/api/chats/' + encodeURIComponent(c.id), { method: 'DELETE' });
      if (state.currentId === c.id) { state.currentId = null; state.messages = []; }
      await loadChats();
      if (state.chats.length) await openChat(state.chats[0].id);
      else renderMessages();
    };

    tools.append(rename, del);
    item.append(title, tools);
    item.onclick = () => { openChat(c.id); document.body.classList.remove('side-open'); };
    box.appendChild(item);
  }
}

function renderTierSelect() {
  const mode = currentMode();
  const plan = (state.plan && state.plan.id) || 'free';
  const free = plan === 'free' && !state.isAdmin;
  const proTrial = Number(state.plan && state.plan.proTrial) || 2;
  const proUsed = Number(state.usage && state.usage.proUsed) || 0;
  const trialLeft = Math.max(0, proTrial - proUsed);
  document.querySelectorAll('#tierSelect button').forEach((b) => {
    const isPro = b.dataset.mode !== 'flash';
    const locked = free && isPro && (!state.user || trialLeft <= 0);
    b.classList.toggle('on', b.dataset.mode === mode);
    b.classList.toggle('locked', locked);
    b.setAttribute('aria-disabled', locked ? 'true' : 'false');
    const hint = b.querySelector('small');
    if (hint) {
      if (b.dataset.mode === 'flash') hint.textContent = 'быстро';
      else if (free) hint.textContent = !state.user ? 'нужен вход' : (trialLeft > 0 ? 'пробно · ' + trialLeft + ' запр.' : 'нужен Pro');
      else hint.textContent = b.dataset.mode === 'pro' ? 'максимум' : 'думает дольше';
    }
  });
  const label = $('tierLabel');
  if (label) label.textContent = modeLabel();
  const btn = $('tierBtn');
  if (btn) btn.classList.toggle('is-free', free);
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
on('mMenu', () => document.body.classList.toggle('side-open'));
  on('newChatRail', () => newChat(false));
on('mNew', () => newChat(false));
  on('drawerClose', () => document.body.classList.remove('side-open'));
  on('railAvatar', () => {
    if (state.user) document.body.classList.add('side-open');
    else $('authModal').classList.remove('hidden');
  });
  on('btnAgent', () => {
    if (!state.user) { $('authModal').classList.remove('hidden'); toast('Агент доступен после входа в аккаунт'); return; }
    if (agent.connected) {
      agent.on = !agent.on;
      saveAgent();
      applyAgentUI();
      return;
    }
    openAgentModal();
  });
  on('agentClose', closeAgentModal);
  on('agentSetup', openAgentModal);
  on('agentOff', () => { agent.on = false; saveAgent(); applyAgentUI(); });
  on('agentConnect', connectAgent);
  on('btnInstall', openInstall);
  on('installClose', () => $('installModal').classList.add('hidden'));
  on('installNow', installApp);
  on('btnPlan', openVip);
  on('planMeter', openVip);
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
    if (!$('agentConfirm').classList.contains('hidden')) {
      const d = $('agentDeny');
      if (d && d.onclick) d.onclick();
    }
    closeSettings();
    closeTierMenu();
    closeAttachMenu();
    $('installModal').classList.add('hidden');
    $('agentModal').classList.add('hidden');
    $('vipModal').classList.add('hidden');
    $('authModal').classList.add('hidden');
    document.body.classList.remove('side-open');
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (ui.theme === 'system') applyUi(); });
  tap('tierSelect', 'click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    if (b.getAttribute('aria-disabled') === 'true') { openVip(); return; }
    applyMode(b.dataset.mode);
  });
}

async function init() {
  applyUi();
  bind();
  applyAgentUI();
  autoConnectAgent();
  try {
    const st = await (await fetch('/api/state')).json();
    state.hasKey = st.hasKey;
    state.hint = st.hint;
    state.settings = st.settings;
    state.plans = st.plans || PLANS_FALLBACK;
    state.user = st.user || state.user;
    state.plan = st.plan || state.plan;
    state.usage = st.usage || state.usage;
    state.isAdmin = Boolean(st.isAdmin || state.isAdmin);
    state.banned = st.banned || state.banned;
    if (state.banned) showBan(state.banned);
    const planId = (state.plan && state.plan.id) || 'free';
    const trial = Number(state.plan && state.plan.proTrial) || 0;
    const proUsed = Number(state.usage && state.usage.proUsed) || 0;
    const canPro = state.isAdmin || (Boolean(state.user) && (planId !== 'free' || trial - proUsed > 0));
    if (!canPro) {
      state.deepMode = false;
      applyMode('flash', true);
    } else if (ui.deep) {
      state.deepMode = true;
    }
    applyTierModels(st);
    updateLearnState();
    state.booted = true;
    updatePlanUI();
    applyAdVisibility();
    renderAuth();
    renderTierSelect();
    if (state.banned) { renderMessages(); return; }
    await loadChats();
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