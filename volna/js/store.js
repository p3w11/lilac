/* ==========================================================================
   Волна — локальное хранилище настроек, избранного и истории
   ========================================================================== */
(function () {
  'use strict';

  const NS = 'volna.v1.';
  const DEFAULTS = {
    favorites: [],
    history: [],
    searches: [],
    queue: [],
    queueIndex: -1,
    theme: 'dark',
    volume: 0.5,
    muted: false,
    shuffle: false,
    repeat: 'off',
    source: 'youtube',
    queueOpen: false,
    sidebarOpen: false
  };

  let available = true;
  try {
    const probe = '__volna_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
  } catch (e) {
    available = false;
  }

  const data = Object.assign({}, DEFAULTS);

  function readAll() {
    if (!available) return;
    Object.keys(DEFAULTS).forEach((key) => {
      try {
        const raw = localStorage.getItem(NS + key);
        if (raw != null) data[key] = JSON.parse(raw);
      } catch (e) { /* повреждённое значение игнорируем */ }
    });
  }

  function save(key) {
    if (!available) return;
    try {
      localStorage.setItem(NS + key, JSON.stringify(data[key]));
    } catch (e) {
      // Например, закончилось место под избранное — не роняем плеер.
    }
  }

  readAll();
  if (!Array.isArray(data.favorites)) data.favorites = [];
  if (!Array.isArray(data.history)) data.history = [];
  if (!Array.isArray(data.searches)) data.searches = [];
  if (!Array.isArray(data.queue)) data.queue = [];
  data.volume = Math.min(1, Math.max(0, Number(data.volume) || DEFAULTS.volume));

  function get(key) { return data[key]; }

  function set(key, value) {
    data[key] = value;
    save(key);
    return value;
  }

  function isFavorite(id) {
    if (!id) return false;
    return data.favorites.some((t) => t && t.id === id);
  }

  function toggleFavorite(track) {
    if (!track || !track.id) return false;
    const i = data.favorites.findIndex((t) => t && t.id === track.id);
    if (i >= 0) {
      data.favorites.splice(i, 1);
      save('favorites');
      return false;
    }
    data.favorites.unshift(track);
    if (data.favorites.length > 500) data.favorites.length = 500;
    save('favorites');
    return true;
  }

  function removeFavorite(id) {
    const i = data.favorites.findIndex((t) => t && t.id === id);
    if (i >= 0) {
      data.favorites.splice(i, 1);
      save('favorites');
    }
  }

  function addHistory(track) {
    if (!track || !track.id) return;
    const i = data.history.findIndex((t) => t && t.id === track.id);
    if (i >= 0) data.history.splice(i, 1);
    data.history.unshift({
      id: track.id, source: track.source, title: track.title, artist: track.artist,
      album: track.album, duration: track.duration, art: track.art, url: track.url,
      preview: track.preview, albumId: track.albumId, artistId: track.artistId
    });
    if (data.history.length > 80) data.history.length = 80;
    save('history');
  }

  function clearHistory() {
    data.history = [];
    save('history');
  }

  function addSearch(query) {
    const q = String(query || '').trim();
    if (q.length < 2) return;
    const key = q.toLowerCase();
    data.searches = data.searches.filter((s) => String(s).toLowerCase() !== key);
    data.searches.unshift(q);
    if (data.searches.length > 12) data.searches.length = 12;
    save('searches');
  }

  function clearSearches() {
    data.searches = [];
    save('searches');
  }

  function resetAll() {
    Object.keys(DEFAULTS).forEach((key) => {
      data[key] = DEFAULTS[key];
      save(key);
    });
  }

  window.Store = {
    available,
    get, set,
    isFavorite, toggleFavorite, removeFavorite,
    addHistory, clearHistory,
    addSearch, clearSearches,
    resetAll
  };
})();
