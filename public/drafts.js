(function (root) {
  'use strict';

  const DB_NAME = 'photonn-drafts';
  const STORE_NAME = 'drafts';
  const MAX_TEXT = 200000;
  const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
  const MAX_FILE_BYTES = 512 * 1024;
  const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
  const memory = new Map();
  const queues = new Map();
  let memoryBytes = 0;
  let database = null;
  let opening = null;
  let disabled = false;
  let persistent = false;
  let lastError = null;

  function fail(message, code) {
    const error = new Error(message);
    error.name = code === 'DRAFT_STORAGE_UNAVAILABLE' ? 'DraftStorageError' : 'DraftValidationError';
    error.code = code;
    return error;
  }

  function clone(value) {
    return value === null ? null : {
      text: value.text,
      pendingImage: value.pendingImage,
      pendingFile: value.pendingFile ? Object.assign({}, value.pendingFile) : null,
      updatedAt: value.updatedAt
    };
  }

  function recordKey(chatId, ownerScope) {
    if (typeof chatId !== 'string' || !chatId || chatId.length > 256 ||
        typeof ownerScope !== 'string' || !ownerScope || ownerScope.length > 320) {
      throw fail('Для черновика нужны идентификаторы чата и владельца.', 'DRAFT_INVALID_KEY');
    }
    return JSON.stringify([ownerScope, chatId]);
  }

  function normalize(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw fail('Некорректный черновик.', 'DRAFT_INVALID_VALUE');
    }
    const text = draft.text == null ? '' : draft.text;
    if (typeof text !== 'string' || text.length > MAX_TEXT) {
      throw fail('Черновик слишком длинный: максимум 200 000 символов.', 'DRAFT_TOO_LARGE');
    }
    const image = draft.pendingImage || null;
    if (image !== null) {
      if (typeof image !== 'string' || image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 160) {
        throw fail('Фото в черновике больше 6 МБ.', 'DRAFT_TOO_LARGE');
      }
      const comma = image.indexOf(',');
      const payloadLength = image.length - comma - 1;
      const padding = image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0;
      if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(image) || payloadLength <= 0 ||
          payloadLength % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(image.slice(comma + 1)) ||
          payloadLength / 4 * 3 - padding > MAX_IMAGE_BYTES) {
        throw fail('Некорректное фото в черновике.', 'DRAFT_INVALID_IMAGE');
      }
    }
    let file = null;
    if (draft.pendingFile != null) {
      const source = draft.pendingFile;
      if (typeof source !== 'object' || Array.isArray(source) ||
          typeof source.name !== 'string' || !source.name || source.name.length > 1024 ||
          typeof source.content !== 'string' || source.content.length > MAX_TEXT ||
          (source.type != null && (typeof source.type !== 'string' || source.type.length > 255))) {
        throw fail('Некорректный текстовый файл в черновике.', 'DRAFT_INVALID_FILE');
      }
      const size = source.size == null ? source.content.length * 2 : Number(source.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
        throw fail('Текстовый файл в черновике больше 512 КБ.', 'DRAFT_TOO_LARGE');
      }
      file = { name: source.name, size, type: source.type || 'text/plain', content: source.content };
    }
    if (image && file) throw fail('Прикрепи к черновику фото или текстовый файл.', 'DRAFT_MULTIPLE_ATTACHMENTS');
    if (!text && !image && !file) return null;
    return { text, pendingImage: image, pendingFile: file, updatedAt: Date.now() };
  }

  // Keep unsaved records in memory when private mode, quota limits or an
  // unavailable browser database prevent persistence. Never evict unsaved text.
  function remember(key, value, dirty) {
    const bytes = value === null ? key.length * 2 : (key.length + JSON.stringify(value).length) * 2;
    const previous = memory.get(key);
    let total = memoryBytes - (previous ? previous.bytes : 0) + bytes;
    if (total > MAX_MEMORY_BYTES) {
      for (const [otherKey, entry] of memory) {
        if (otherKey === key || entry.dirty) continue;
        memory.delete(otherKey);
        memoryBytes -= entry.bytes;
        total -= entry.bytes;
        if (total <= MAX_MEMORY_BYTES) break;
      }
    }
    if (total > MAX_MEMORY_BYTES) {
      if (!dirty) return;
      throw fail('Черновики заняли 64 МБ памяти. Отправь или очисти часть черновиков.', 'DRAFT_MEMORY_LIMIT');
    }
    memory.delete(key);
    memory.set(key, { value: clone(value), bytes, dirty });
    memoryBytes = total;
  }

  function useMemory() {
    // Preserve every cached record while the disk store is inaccessible.
    for (const entry of memory.values()) entry.dirty = true;
    disabled = true;
    persistent = false;
    lastError = fail('Черновики сохраняются только до закрытия вкладки: локальная база недоступна.', 'DRAFT_STORAGE_UNAVAILABLE');
    if (database) {
      try { database.close(); } catch (error) { /* Already closed. */ }
    }
    database = null;
  }

  function openDatabase() {
    if (disabled) return Promise.resolve(null);
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = new Promise((resolve) => {
      let request;
      let settled = false;
      const timer = setTimeout(() => finish(null), 4000);
      function finish(db) {
        if (settled) {
          if (db) { try { db.close(); } catch (error) { /* No active handle. */ } }
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (db) {
          database = db;
          persistent = true;
          lastError = null;
          db.onversionchange = () => {
            db.close();
            database = null;
            opening = null;
            persistent = false;
          };
        } else useMemory();
        resolve(db);
      }
      try {
        if (!root.indexedDB) return finish(null);
        request = root.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        };
        request.onsuccess = () => finish(request.result);
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
      } catch (error) { finish(null); }
    });
    return opening;
  }

  function transact(db, mode, action) {
    return new Promise((resolve, reject) => {
      let request;
      try {
        const transaction = db.transaction(STORE_NAME, mode);
        transaction.oncomplete = () => resolve(request && request.result);
        transaction.onabort = () => reject(transaction.error || fail('Не удалось сохранить черновик.', 'DRAFT_STORAGE_UNAVAILABLE'));
        transaction.onerror = () => reject(transaction.error || fail('Не удалось сохранить черновик.', 'DRAFT_STORAGE_UNAVAILABLE'));
        request = action(transaction.objectStore(STORE_NAME));
      } catch (error) { reject(error); }
    });
  }

  function enqueue(key, action) {
    const previous = queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    queues.set(key, operation);
    const clean = () => { if (queues.get(key) === operation) queues.delete(key); };
    operation.then(clean, clean);
    return operation;
  }

  function get(chatId, ownerScope) {
    let key;
    try { key = recordKey(chatId, ownerScope); } catch (error) { return Promise.reject(error); }
    return enqueue(key, async () => {
      const cached = memory.get(key);
      if (cached && cached.dirty) return clone(cached.value);
      const db = await openDatabase();
      if (db) {
        try {
          const record = await transact(db, 'readonly', (store) => store.get(key));
          const value = record && record.value ? record.value : null;
          remember(key, value, false);
          return clone(value);
        } catch (error) { useMemory(); }
      }
      return clone(memory.has(key) ? memory.get(key).value : null);
    });
  }

  function set(chatId, draft, ownerScope) {
    let key, value;
    // Snapshot before queueing, so later edits to the caller's state cannot
    // change which draft this particular save was asked to persist.
    try { key = recordKey(chatId, ownerScope); value = normalize(draft); } catch (error) { return Promise.reject(error); }
    return enqueue(key, async () => {
      remember(key, value, true);
      const db = await openDatabase();
      if (db) {
        try {
          await transact(db, 'readwrite', (store) => value === null ? store.delete(key) : store.put({ key, value }));
          const entry = memory.get(key);
          if (entry) entry.dirty = false;
        } catch (error) { useMemory(); }
      }
      return clone(value);
    });
  }

  function remove(chatId, ownerScope) {
    return set(chatId, { text: '' }, ownerScope).then(() => undefined);
  }

  async function flush() {
    while (queues.size) await Promise.all(Array.from(queues.values()));
  }

  root.PhotonnDrafts = Object.freeze(Object.defineProperties({ get, set, remove, flush }, {
    persistent: { enumerable: true, get: () => persistent },
    error: { enumerable: true, get: () => lastError }
  }));
})(typeof window === 'object' ? window : globalThis);
