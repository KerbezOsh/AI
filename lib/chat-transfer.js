'use strict';

const crypto = require('node:crypto');
const IMAGE_SIZES = Object.freeze({ square: [1024, 1024], landscape: [1024, 576], portrait: [576, 1024] });
const MAX_IMAGE_URL = 6 * 1024 * 1024;
const MAX_TEXT = 200000;
function problem(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function text(value, max, label, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) throw problem('Некорректное поле: ' + label);
  return value;
}
function timestamp(value, fallback) { return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback; }
function seedValue(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw problem('Seed должен быть целым числом от 0 до 999999');
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 999999) throw problem('Seed должен быть целым числом от 0 до 999999');
  return seed;
}
function imageParameters(input = {}) {
  const aspect = input.aspect === undefined ? 'square' : input.aspect;
  if (!has(IMAGE_SIZES, aspect)) throw problem('Неизвестный формат картинки');
  const [width, height] = IMAGE_SIZES[aspect];
  const seed = input.seed === undefined || input.seed === null || input.seed === '' ? Math.floor(Math.random() * 1000000) : seedValue(input.seed);
  return { aspect, width, height, seed };
}
function imageMetadata(input) {
  const src = record(input.imageParams) ? Object.assign({}, input, input.imageParams) : input;
  if (!['effectivePrompt', 'seed', 'aspect', 'width', 'height'].some((key) => has(src, key))) return null;
  let aspect = src.aspect;
  if (aspect === undefined && (src.width !== undefined || src.height !== undefined)) {
    aspect = Object.keys(IMAGE_SIZES).find((key) => IMAGE_SIZES[key][0] === src.width && IMAGE_SIZES[key][1] === src.height);
    if (!aspect) throw problem('Некорректный размер картинки');
  }
  const params = imageParameters({ aspect, seed: src.seed === undefined ? 0 : seedValue(src.seed) });
  if ((src.width !== undefined && src.width !== params.width) || (src.height !== undefined && src.height !== params.height)) throw problem('Размер картинки не соответствует формату');
  if (src.seed === undefined) delete params.seed;
  params.prompt = text(src.prompt, 500, 'prompt');
  params.effectivePrompt = text(src.effectivePrompt, 500, 'effectivePrompt');
  return params;
}
function safeImageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_IMAGE_URL) return '';
  if (/^data:image\/(?:webp|jpeg|png);base64,[a-z0-9+/]+={0,2}$/i.test(value)) {
    const encoded = value.slice(value.indexOf(',') + 1);
    return encoded.length % 4 === 0 && Buffer.byteLength(encoded, 'base64') <= 4 * 1024 * 1024 ? value : '';
  }
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password &&
      (host === 'image.pollinations.ai' || host === 'gen.pollinations.ai' || /^[a-z0-9-]+\.hf\.space$/i.test(host)) ? url.toString() : '';
  } catch (e) { return ''; }
}
function cleanFile(file) {
  if (!record(file)) throw problem('Некорректное текстовое вложение');
  const content = text(file.content, MAX_TEXT, 'file.content');
  if (!content.trim()) throw problem('Пустое текстовое вложение');
  return { name: text(file.name, 120, 'file.name', 'файл.txt'), type: text(file.type, 80, 'file.type', 'text/plain'), content };
}
function checkReserved(value, owner, depth = 0, count = { value: 0 }) {
  if (!value || typeof value !== 'object') return;
  if (depth > 12 || ++count.value > 25000) throw problem('Слишком сложная структура импорта');
  for (const key of Object.keys(value)) {
    if (/^(?:__proto__|prototype|constructor|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|adminPass|secret|token|key|oauth|cookie|session|credentials|users|settings)$/i.test(key)) throw problem('Файл содержит секреты или настройки, которые нельзя импортировать');
    // Backups are portable: source owners are untrusted metadata and never assigned to restored chats.
    if (key === 'owner' && (typeof value[key] !== 'string' || value[key].length > 200)) throw problem('Некорректное поле владельца в резервной копии');
    checkReserved(value[key], owner, depth + 1, count);
  }
}
function cleanMessage(source, now) {
  if (!record(source) || !['user', 'assistant'].includes(source.role)) throw problem('Допустимы только сообщения user и assistant');
  const msg = { role: source.role, content: text(source.content, MAX_TEXT, 'message.content'), at: timestamp(source.at, now) };
  if (source.hidden === true) msg.hidden = true;
  if (source.reasoning !== undefined) msg.reasoning = text(source.reasoning, MAX_TEXT, 'reasoning');
  if (source.model !== undefined) msg.model = text(source.model, 160, 'model');
  if (source.tier !== undefined) msg.tier = text(source.tier, 40, 'tier');
  if (source.fallback === true) msg.fallback = true;
  if (source.deep === true) msg.deep = true;
  if (source.search !== undefined) msg.search = text(source.search, 2000, 'search');
  if (source.file !== undefined) msg.file = cleanFile(source.file);
  if (source.image === true && source.role === 'user') msg.image = true;
  else if (typeof source.image === 'string') {
    msg.image = safeImageUrl(source.image);
    if (!msg.image) throw problem('Некорректная картинка в истории');
  } else if (source.image !== undefined && source.image !== false && source.image !== null) throw problem('Некорректная картинка в истории');
  if (source.imageChain !== undefined) {
    if (!Array.isArray(source.imageChain) || source.imageChain.length > 4) throw problem('Некорректная цепочка картинок');
    msg.imageChain = source.imageChain.map((url) => { const safe = safeImageUrl(url); if (!safe) throw problem('Некорректная ссылка картинки'); return safe; });
  }
  const params = imageMetadata(source);
  if (params) { msg.imageParams = params; for (const key of ['effectivePrompt', 'seed', 'aspect', 'width', 'height']) if (params[key] !== undefined) msg[key] = params[key]; }
  if (source.variants !== undefined) {
    if (source.role !== 'assistant' || !Array.isArray(source.variants) || source.variants.length > 100) throw problem('Слишком много вариантов ответа');
    msg.variants = source.variants.map((v) => {
      if (!record(v)) throw problem('Некорректный вариант ответа');
      return { content: text(v.content, MAX_TEXT, 'variant.content'), at: timestamp(v.at, now), model: text(v.model, 160, 'variant.model'), tier: text(v.tier, 40, 'variant.tier') };
    });
  }
  return msg;
}
function cleanChat(source, now) {
  if (!record(source) || !Array.isArray(source.messages) || source.messages.length > 1000) throw problem('Чат должен содержать массив не более 1000 сообщений');
  const chat = { title: text(source.title, 100, 'title', 'Без названия').trim() || 'Без названия', createdAt: timestamp(source.createdAt, now), updatedAt: timestamp(source.updatedAt, now), messages: source.messages.map((m) => cleanMessage(m, now)) };
  if (source.tier !== undefined && source.tier !== null) chat.tier = text(source.tier, 40, 'tier');
  if (source.folder !== undefined) chat.folder = text(source.folder, 60, 'folder');
  if (source.tags !== undefined) {
    if (!Array.isArray(source.tags) || source.tags.length > 10) throw problem('Допустимо не более 10 тегов');
    chat.tags = source.tags.map((tag) => text(tag, 30, 'tag'));
  }
  if (source.pinned === true) chat.pinned = true;
  if (source.archived === true) chat.archived = true;
  if (source.webSearch === true) chat.webSearch = true;
  if (source.deep === true) chat.deep = true;
  return chat;
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function chatFingerprint(chat) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!record(value)) return value;
    const out = {};
    for (const key of Object.keys(value).sort()) if (!['at', 'model', 'tier', 'fallback'].includes(key)) out[key] = stable(value[key]);
    return out;
  };
  return digest(JSON.stringify({ title: chat.title, messages: stable(chat.messages) }));
}
function prepareChatImport(payload, existing, owner, options = {}) {
  if (!record(payload) || !Array.isArray(payload.chats) || payload.chats.length > 100) throw problem('Нужен файл экспорта с массивом не более 100 чатов');
  checkReserved(payload, owner);
  const now = options.now || Date.now();
  let messageCount = 0;
  // Validate every chat before deciding what to append; invalid tails never cause a partial import.
  const validated = payload.chats.map((source) => {
    if (!record(source)) throw problem('Некорректный чат в файле импорта');
    messageCount += Array.isArray(source.messages) ? source.messages.length : 0;
    if (messageCount > 10000) throw problem('В одном файле допускается не более 10000 сообщений');
    const chat = cleanChat(source, now);
    const sourceId = text(source.id, 200, 'id');
    const parentId = text(source.branchOf, 200, 'branchOf');
    if (source.branchMessageIndex !== undefined && (!Number.isInteger(source.branchMessageIndex) || source.branchMessageIndex < 0 || source.branchMessageIndex > 1000)) throw problem('Некорректный индекс родительской ветки');
    return { chat, sourceHash: sourceId ? digest(sourceId) : '', parentHash: parentId ? digest(parentId) : '', branchMessageIndex: source.branchMessageIndex, fingerprint: chatFingerprint(chat) };
  });
  const sources = new Map();
  const fingerprints = new Map();
  for (const chat of existing) {
    if (chat.owner && chat.owner !== owner) continue;
    if (chat.id) sources.set(digest(String(chat.id)), chat);
    if (chat.importSourceHash) sources.set(chat.importSourceHash, chat);
    if (chat.importContentHash) fingerprints.set(chat.importContentHash, chat);
    try { fingerprints.set(chatFingerprint(cleanChat(chat, now)), chat); } catch (e) {}
  }
  const imported = [];
  const branches = [];
  let skipped = 0;
  for (const item of validated) {
    const target = (item.sourceHash && sources.get(item.sourceHash)) || fingerprints.get(item.fingerprint);
    if (target) {
      // Keep aliases even when the parent is skipped by content rather than by its source id.
      if (item.sourceHash) sources.set(item.sourceHash, target);
      skipped++;
      continue;
    }
    const chat = Object.assign(item.chat, { id: (options.id || crypto.randomUUID)(), owner, importContentHash: item.fingerprint });
    if (item.sourceHash) { chat.importSourceHash = item.sourceHash; sources.set(item.sourceHash, chat); }
    fingerprints.set(item.fingerprint, chat);
    imported.push(chat);
    if (item.parentHash) branches.push({ chat, parentHash: item.parentHash, index: item.branchMessageIndex });
  }
  // Resolve only known current-owner destinations, after every new id and skipped-parent alias exists.
  const destinations = new Map(existing.concat(imported).filter((chat) => chat.owner === owner).map((chat) => [chat.id, chat]));
  for (const branch of branches) {
    const parent = sources.get(branch.parentHash);
    if (!parent || parent.owner !== owner || parent.id === branch.chat.id) continue;
    let cursor = parent;
    const seen = new Set([branch.chat.id]);
    while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); cursor = destinations.get(cursor.branchOf); }
    if (cursor) continue; // A malformed backup must not introduce a cycle.
    branch.chat.branchOf = parent.id;
    if (branch.index !== undefined) branch.chat.branchMessageIndex = branch.index;
  }
  return { chats: imported, imported: imported.length, skipped };
}
function createChatBranch(source, body, owner, options = {}) {
  if (!record(body)) throw problem('Некорректный запрос редактирования');
  if (source.owner && source.owner !== owner) throw problem('Это чужой чат', 403);
  const index = body.messageIndex;
  if (!Number.isInteger(index) || index < 0 || !Array.isArray(source.messages) || index >= source.messages.length) throw problem('Сообщение уже недоступно. Обнови чат.', 409);
  const original = source.messages[index];
  if (!original || original.role !== 'user' || original.hidden) throw problem('Редактировать можно только видимое сообщение пользователя', 409);
  if ((body.expectedContent !== undefined && body.expectedContent !== original.content) ||
      (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== source.updatedAt)) throw problem('Чат изменился. Обнови его перед редактированием.', 409);
  if (original.image) throw problem('Исходное фото не сохранено. Прикрепи его заново в новом чате.', 409);
  const content = text(body.content, MAX_TEXT, 'content').trim();
  const file = original.file ? cleanFile(original.file) : null;
  if (!content && !file) throw problem('Сообщение не может быть пустым');
  const now = options.now || Date.now();
  const chat = { id: (options.id || crypto.randomUUID)(), owner, title: ((source.title || 'Чат') + ' · ветка').slice(0, 100), createdAt: now, updatedAt: now, messages: JSON.parse(JSON.stringify(source.messages.slice(0, index))), branchOf: source.id, branchMessageIndex: index };
  for (const key of ['tier', 'webSearch', 'deep', 'folder', 'tags']) if (source[key] !== undefined) chat[key] = JSON.parse(JSON.stringify(source[key]));
  const edit = { content, originalContent: original.content, messageIndex: index };
  if (file) edit.file = file;
  return { chat, edit };
}
module.exports = { imageParameters, imageMetadata, safeImageUrl, prepareChatImport, createChatBranch };