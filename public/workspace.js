'use strict';

let composerContext = null;
let composerRevision = 0;
let composerRestore = 0;
let composerTimer = null;
let restoringComposer = false;
let draftWarningShown = false;

function lockComposerNavigation(locked) {
  if ($('input')) $('input').readOnly = locked;
  for (const id of ['btnPhoto', 'btnCamera', 'btnMic']) if ($(id)) $(id).disabled = locked;
}

function composerScope() {
  if (state.user) return 'user:' + (state.user.id || state.user.email);
  let guest = '';
  try {
    guest = localStorage.getItem('photonn.draftGuest') || '';
    if (!guest) { guest = crypto.randomUUID(); localStorage.setItem('photonn.draftGuest', guest); }
  } catch (e) { guest = 'local-guest'; }
  return 'guest:' + guest;
}

function composerSnapshot() {
  return { text: $('input').value, pendingImage: state.pendingImage || null,
    pendingFile: state.pendingFile ? { ...state.pendingFile } : null, updatedAt: Date.now() };
}

function draftWarning() {
  if (draftWarningShown) return;
  draftWarningShown = true;
  toast(uiLang === 'en' ? 'Drafts are kept in memory only: browser storage is unavailable.' : 'Хранилище браузера недоступно: черновики сохраняются только до закрытия страницы.');
}

async function saveComposerDraft() {
  clearTimeout(composerTimer);
  composerTimer = null;
  if (!composerContext || restoringComposer) return true;
  if (!window.PhotonnDrafts) { draftWarning(); return false; }
  const context = { ...composerContext };
  const snapshot = composerSnapshot();
  try {
    await window.PhotonnDrafts.set(context.chatId, snapshot, context.scope);
    if (!window.PhotonnDrafts.persistent) draftWarning();
    return true;
  } catch (e) { toast(e.message || 'Не удалось сохранить черновик'); return false; }
}

function scheduleComposerDraft() {
  if (restoringComposer) return;
  composerRevision++;
  clearTimeout(composerTimer);
  composerTimer = setTimeout(() => { saveComposerDraft(); }, 180);
}

function setComposerSnapshot(draft) {
  restoringComposer = true;
  try {
    const d = draft || {};
    $('input').value = d.text || '';
    state.pendingImage = d.pendingImage || null;
    state.pendingFile = d.pendingFile || null;
    pendingImageData = state.pendingImage;
    renderAttachment();
    resizeInput();
  } finally { restoringComposer = false; }
}

async function activateComposer(chatId, preserve) {
  clearTimeout(composerTimer);
  const token = ++composerRestore;
  const next = { chatId: chatId || '__new__', scope: composerScope() };
  composerContext = next;
  try { localStorage.setItem('photonn.lastChat.' + next.scope, chatId || ''); } catch (e) {}
  if (preserve) return saveComposerDraft();
  setComposerSnapshot(null);
  const revision = composerRevision;
  try {
    const draft = window.PhotonnDrafts ? await window.PhotonnDrafts.get(next.chatId, next.scope) : null;
    if (token !== composerRestore || revision !== composerRevision) return;
    setComposerSnapshot(draft);
    if (draft) {
      const badge = $('draftStatus');
      if (badge) { badge.textContent = uiLang === 'en' ? 'Draft restored' : 'Черновик восстановлен'; setTimeout(() => { badge.textContent = ''; }, 3000); }
    }
  } catch (e) { toast(e.message || 'Не удалось открыть черновик'); }
}

function lastOpenedChat() {
  try { return localStorage.getItem('photonn.lastChat.' + composerScope()); } catch (e) { return null; }
}

function clearSentComposer() {
  setComposerSnapshot(null);
  scheduleComposerDraft();
  saveComposerDraft();
}

function restoreFailedComposer(snapshot) {
  if (!$('input').value && !state.pendingImage && !state.pendingFile) {
    setComposerSnapshot(snapshot);
    scheduleComposerDraft();
  }
}

function readImageOptions() {
  const aspect = $('imageAspect') ? $('imageAspect').value : 'square';
  const raw = $('imageSeed') ? $('imageSeed').value.trim() : '';
  if (raw && (!/^\d+$/.test(raw) || Number(raw) > 999999)) throw new Error('Seed — целое число от 0 до 999999 или пустое поле.');
  return { aspect: ['square', 'landscape', 'portrait'].includes(aspect) ? aspect : 'square', ...(raw ? { seed: Number(raw) } : {}) };
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal && signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', stop); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', stop, { once: true });
  });
}

async function downloadGeneratedImage(msg) {
  try {
    let url = msg.image;
    if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) {
      const result = await fetchImageObject(url);
      url = result.obj;
      if (!url) { const prox = await renderViaServer(msg.image); url = prox.dataUrl; }
    }
    if (!url) throw new Error('Не удалось загрузить оригинал картинки');
    const mime = /^data:image\/(\w+)/.exec(url);
    const extension = mime && mime[1] === 'jpeg' ? 'jpg' : (mime && mime[1]) || 'png';
    const a = document.createElement('a');
    a.href = url;
    a.download = 'photonn-' + (msg.seed ?? (msg.imageParams && msg.imageParams.seed) ?? Date.now()) + '.' + extension;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) { toast(e.message || 'Не удалось скачать картинку'); }
}

function addImageTools(bubble, msg) {
  const params = msg.imageParams || msg;
  const tools = el('div', 'image-tools');
  const download = el('button', 'mini', uiLang === 'en' ? 'Download original' : 'Скачать оригинал');
  download.type = 'button';
  download.onclick = () => downloadGeneratedImage(msg);
  tools.appendChild(download);
  if (params.effectivePrompt || params.seed != null) {
    const details = el('details', 'image-details');
    details.appendChild(el('summary', '', uiLang === 'en' ? 'Generation settings' : 'Параметры генерации'));
    const text = [params.width && params.height ? params.width + ' × ' + params.height : '', params.seed != null ? 'Seed: ' + params.seed : '', params.effectivePrompt || ''].filter(Boolean).join('\n');
    details.appendChild(el('pre', '', text));
    const use = el('button', 'mini', uiLang === 'en' ? 'Use this prompt and seed' : 'Использовать запрос и seed');
    use.type = 'button';
    use.onclick = () => {
      if (state.streaming || state.startingSend) { toast('Дождись завершения ответа'); return; }
      const prompt = params.prompt || params.effectivePrompt || '';
      $('input').value = wantsImage(prompt) ? prompt : (uiLang === 'en' ? 'Draw: ' : 'Нарисуй: ') + prompt;
      if ($('imageAspect')) $('imageAspect').value = params.aspect || 'square';
      if ($('imageSeed')) $('imageSeed').value = params.seed ?? '';
      if ($('imageSettings')) $('imageSettings').open = true;
      resizeInput(); scheduleComposerDraft(); $('input').focus();
    };
    details.appendChild(use);
    tools.appendChild(details);
  }
  bubble.appendChild(tools);
}

function addUserEditAction(bubble, msg) {
  const actions = el('div', 'msg-actions user-actions');
  const edit = el('button', 'mini', uiLang === 'en' ? 'Edit in a new branch' : 'Изменить · новая ветка');
  edit.type = 'button';
  edit.onclick = () => {
    if (state.streaming || state.startingSend || state.navigationBusy || agent.busy) { toast('Дождись завершения текущего действия'); return; }
    if (bubble.querySelector('.message-editor')) return;
    const sourceId = state.currentId;
    const messageIndex = state.messages.indexOf(msg);
    const editor = el('div', 'message-editor');
    const input = el('textarea', 'field');
    input.value = msg.content || '';
    input.rows = 4;
    input.setAttribute('aria-label', 'Изменённый запрос');
    const controls = el('div', 'edit-controls');
    const submit = el('button', 'secondary', uiLang === 'en' ? 'Create branch and send' : 'Создать ветку и отправить');
    const cancel = el('button', 'mini', uiLang === 'en' ? 'Cancel' : 'Отмена');
    cancel.type = submit.type = 'button';
    cancel.onclick = () => editor.remove();
    submit.onclick = async () => {
      const content = input.value.trim();
      if (!content) { toast('Введи текст запроса'); return; }
      if (state.currentId !== sourceId || state.streaming || state.startingSend || state.navigationBusy) return;
      submit.disabled = cancel.disabled = true;
      state.navigationBusy = true;
      lockComposerNavigation(true);
      try {
        if (!(await saveComposerDraft())) throw new Error('Сначала сократи или сохрани черновик: хранилище недоступно');
        const r = await fetch('/api/chats/' + encodeURIComponent(sourceId) + '/branch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageIndex, content, expectedContent: msg.content }) });
        const j = await r.json();
        if (!r.ok || !j.chat) throw new Error(j.error || 'Не удалось создать ветку');
        await loadChats();
        state.navigationBusy = false;
        lockComposerNavigation(false);
        if (!(await openChat(j.chat.id))) throw new Error('Ветка создана, но не удалось её открыть');
        setComposerSnapshot({ text: j.edit.content, pendingFile: j.edit.file || null, pendingImage: j.edit.image || null });
        await saveComposerDraft();
        await send();
      } catch (e) { toast(e.message || 'Не удалось создать ветку'); }
      finally { state.navigationBusy = false; lockComposerNavigation(false); submit.disabled = cancel.disabled = false; }
    };
    controls.append(submit, cancel);
    editor.append(input, controls);
    bubble.appendChild(editor);
    input.focus();
  };
  actions.appendChild(edit);
  bubble.appendChild(actions);
}

async function importChatsFile(file) {
  if (!file || state.importing) return;
  if (state.streaming || state.startingSend || state.navigationBusy || agent.busy) { toast('Дождись завершения текущего действия'); return; }
  state.importing = true;
  const button = $('importChats');
  if (button) button.disabled = true;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Файл истории больше 10 МБ');
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.chats)) throw new Error('Нужен JSON-файл экспорта photonnAI с массивом chats');
    const r = await fetch('/api/chats/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chats: data.chats }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Не удалось импортировать историю');
    await loadChats();
    toast('Импортировано: ' + j.imported + ' · уже есть: ' + j.skipped);
  } catch (e) { toast(e instanceof SyntaxError ? 'Файл содержит некорректный JSON' : e.message || 'Не удалось прочитать файл'); }
  finally { state.importing = false; if (button) button.disabled = false; if ($('importChatsInput')) $('importChatsInput').value = ''; }
}

function initWorkspaceTools() {
  const importButton = $('importChats');
  if (importButton) importButton.onclick = () => $('importChatsInput').click();
  if ($('importChatsInput')) $('importChatsInput').addEventListener('change', (e) => importChatsFile(e.target.files[0]));
  $('input').addEventListener('input', scheduleComposerDraft);
  $('input').addEventListener('blur', () => saveComposerDraft());
  window.addEventListener('pagehide', () => { saveComposerDraft(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveComposerDraft(); });
  if ($('imageAspect')) {
    $('imageAspect').value = ui.imageAspect || 'square';
    $('imageAspect').onchange = () => { ui.imageAspect = $('imageAspect').value; saveUi(); };
  }
}
