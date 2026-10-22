/* ==========================================================================
   Волна — локальная фонотека (IndexedDB + ID3 + обложки)
   ========================================================================== */
(function () {
  'use strict';

  const DB_NAME = 'volna-library';
  const STORE = 'files';
  const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'webm', 'weba', 'aif', 'aiff', 'mp4'];

  let db = null;
  let dbBroken = false;
  const items = new Map();
  const listeners = [];

  function emit() {
    const tracks = list();
    listeners.forEach((fn) => {
      try { fn(tracks); } catch (e) { /* слушатель не должен ломать библиотеку */ }
    });
  }

  function onChange(fn) { listeners.push(fn); }

  function requestPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Ошибка базы'));
    });
  }

  function openDb() {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') { dbBroken = true; resolve(null); return; }
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (e) {
        dbBroken = true;
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => { dbBroken = true; resolve(null); };
      req.onblocked = () => { dbBroken = true; resolve(null); };
    });
  }

  function dbAll() {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error('База недоступна')); return; }
      try {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error || new Error('Не удалось прочитать файлы'));
      } catch (e) { reject(e); }
    });
  }

  function dbPut(record) {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error('База недоступна')); return; }
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Не удалось сохранить файл'));
        tx.onabort = () => reject(tx.error || new Error('Сохранение отменено'));
      } catch (e) { reject(e); }
    });
  }

  function dbDelete(id) {
    return new Promise((resolve, reject) => {
      if (!db) { resolve(); return; }
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Не удалось удалить файл'));
      } catch (e) { reject(e); }
    });
  }

  function toTrack(rec) {
    const entry = items.get(rec.id);
    return {
      id: 'local:' + rec.id,
      localId: rec.id,
      source: 'local',
      title: rec.title || rec.name || 'Без названия',
      artist: rec.artist || 'Моя фонотека',
      album: rec.album || 'Локальные файлы',
      duration: rec.duration || 0,
      art: entry ? entry.artUrl : '',
      url: entry ? entry.url : '',
      preview: false,
      playable: rec.playable !== false,
      fileName: rec.name,
      size: rec.size,
      year: rec.year || '',
      added: rec.added || 0
    };
  }

  function attach(rec) {
    const url = URL.createObjectURL(rec.blob);
    const artUrl = rec.art ? URL.createObjectURL(rec.art) : '';
    items.set(rec.id, { rec, url, artUrl });
    return toTrack(rec);
  }

  async function init() {
    await openDb();
    if (!db) return;
    try {
      const records = await dbAll();
      records.sort((a, b) => (a.added || 0) - (b.added || 0));
      records.forEach(attach);
      emit();
    } catch (e) {
      dbBroken = true;
    }
  }

  function isAudio(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('audio/') === 0) return true;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return AUDIO_EXT.indexOf(ext) >= 0;
  }

  function probeDuration(url) {
    return new Promise((resolve) => {
      const audio = new Audio();
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        audio.removeAttribute('src');
        audio.load();
        resolve(value);
      };
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => finish(isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => finish(-1);
      audio.src = url;
      setTimeout(() => finish(0), 12000);
    });
  }

  async function shrinkImage(blob, max) {
    max = max || 480;
    try {
      if (!blob || blob.size < 10 * 1024) return blob;
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && blob.size < 380 * 1024) {
        if (bitmap.close) bitmap.close();
        return blob;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      return out || blob;
    } catch (e) {
      return blob;
    }
  }

  async function addFiles(fileList, onProgress) {
    const files = Array.from(fileList || []);
    const added = [];
    const failed = [];
    let unsaved = false;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (onProgress) onProgress(i, files.length, file.name);
      if (!isAudio(file)) {
        failed.push({ name: file.name, reason: 'не аудиофайл' });
        continue;
      }
      try {
        const tags = await ID3.read(file);
        const url = URL.createObjectURL(file);
        const duration = await probeDuration(url);
        const art = tags.art ? await shrinkImage(tags.art) : null;
        const rec = {
          id: U.uid(),
          name: file.name,
          size: file.size,
          type: file.type || 'audio/mpeg',
          added: Date.now(),
          title: tags.title,
          artist: tags.artist,
          album: tags.album,
          year: tags.year,
          duration: duration > 0 ? duration : 0,
          playable: duration >= 0,
          art: art,
          blob: file
        };
        if (db) {
          try {
            await dbPut(rec);
          } catch (e) {
            unsaved = true;
          }
        } else {
          unsaved = true;
        }
        items.set(rec.id, { rec, url, artUrl: art ? URL.createObjectURL(art) : '' });
        added.push(toTrack(rec));
        if (onProgress) onProgress(i + 1, files.length, file.name);
      } catch (e) {
        failed.push({ name: file.name, reason: 'не удалось прочитать файл' });
      }
    }

    if (added.length) emit();
    return { added, failed, unsaved, persisted: !!db && !unsaved };
  }

  async function remove(id) {
    const entry = items.get(id);
    if (!entry) return;
    items.delete(id);
    try { URL.revokeObjectURL(entry.url); } catch (e) { /* уже освобождён */ }
    if (entry.artUrl) {
      try { URL.revokeObjectURL(entry.artUrl); } catch (e) { /* уже освобождён */ }
    }
    try { await dbDelete(id); } catch (e) { /* файл удалён только из памяти */ }
    emit();
  }

  async function clear() {
    for (const entry of items.values()) {
      try { URL.revokeObjectURL(entry.url); } catch (e) { /* пусто */ }
      if (entry.artUrl) {
        try { URL.revokeObjectURL(entry.artUrl); } catch (e) { /* пусто */ }
      }
    }
    items.clear();
    if (db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) { /* останется пустой список в памяти */ }
    }
    emit();
  }

  function list() {
    return Array.from(items.values())
      .sort((a, b) => (b.rec.added || 0) - (a.rec.added || 0))
      .map((entry) => toTrack(entry.rec));
  }

  function getByLocalId(id) {
    const entry = items.get(id);
    return entry ? toTrack(entry.rec) : null;
  }

  function get(id) {
    if (!id) return null;
    const clean = String(id).indexOf('local:') === 0 ? String(id).slice(6) : String(id);
    return getByLocalId(clean);
  }

  function totalSize() {
    let total = 0;
    items.forEach((entry) => { total += entry.rec.size || 0; });
    return total;
  }

  function count() { return items.size; }

  window.Library = {
    init,
    addFiles,
    remove,
    clear,
    list,
    get,
    getByLocalId,
    totalSize,
    count,
    onChange,
    isAudio,
    isPersistent: () => !!db,
    isBroken: () => dbBroken
  };
})();
