/* ==========================================================================
   Волна — приложение: маршруты, поиск, очередь, интерфейс
   ========================================================================== */
(function () {
  'use strict';

  const appEl = document.getElementById('app');
  const viewEl = document.getElementById('view');
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const searchClear = document.querySelector('.search__clear');
  const sourceSwitch = document.getElementById('source-switch');
  const queueListEl = document.getElementById('queue-list');
  const queueCountEl = document.getElementById('queue-count');
  const queueEmptyEl = document.getElementById('queue-empty');
  const nowArtEl = document.getElementById('now-art');
  const nowTitleEl = document.getElementById('now-title');
  const nowArtistEl = document.getElementById('now-artist');
  const pArtEl = document.getElementById('p-art');
  const pTitleEl = document.getElementById('p-title');
  const pArtistEl = document.getElementById('p-artist');
  const pBadgeEl = document.getElementById('p-badge');
  const pLikeEl = document.getElementById('p-like');
  const pPlayEl = document.getElementById('p-play');
  const pShuffleEl = document.getElementById('p-shuffle');
  const pRepeatEl = document.getElementById('p-repeat');
  const pCurEl = document.getElementById('p-cur');
  const pDurEl = document.getElementById('p-dur');
  const pFillEl = document.getElementById('p-fill');
  const pBufEl = document.getElementById('p-buf');
  const pFillMobileEl = document.getElementById('p-fill-mobile');
  const pMuteEl = document.getElementById('p-mute');
  const volumeEl = document.getElementById('p-volume');
  const seekEl = document.getElementById('seek');
  const countFavEl = document.getElementById('count-fav');
  const countFilesEl = document.getElementById('count-files');
  const themeIcoEl = document.getElementById('theme-ico');
  const themeIcoTopEl = document.getElementById('theme-ico-top');
  const themeLabelEl = document.getElementById('theme-label');
  const dialogShortcuts = document.getElementById('dlg-shortcuts');
  const fileInput = document.getElementById('file-input');
  const dropOverlay = document.getElementById('drop-overlay');
  const vizCanvas = document.getElementById('viz');

  const MIX_SEEDS = [
    'The Weeknd', 'Кино', 'Daft Punk', 'Lo-Fi', 'Molchat Doma',
    'Tame Impala', 'Джаз', 'Phonk', 'Классика', 'Инди', 'Ария', 'Fred again'
  ];

  const state = {
    route: { name: 'home', params: new URLSearchParams() },
    query: '',
    filter: 'all',
    source: ['all', 'youtube', 'itunes', 'deezer'].indexOf(Store.get('source')) >= 0 ? Store.get('source') : 'youtube',
    loading: false,
    error: '',
    results: null,
    localMatches: [],
    lists: {},
    tracks: new Map(),
    lastQuery: '',
    lastSource: '',
    album: null,
    albumId: '',
    albumSource: '',
    artistName: '',
    artistCache: new Map(),
    mix: null,
    mixKey: '',
    queueOpen: !!Store.get('queueOpen'),
    theme: Store.get('theme') === 'light' ? 'light' : 'dark',
    historyGuard: '',
    routeToken: 0,
    warned: new Set(),
    seeking: false
  };

  /* ------------------------------------------------------------------ */
  /*  Вспомогательные функции                                            */
  /* ------------------------------------------------------------------ */

  function reg(track) {
    if (track && track.id) state.tracks.set(track.id, track);
    return track;
  }

  function regAll(tracks) {
    (tracks || []).forEach(reg);
    return tracks;
  }

  function resolve(track) {
    if (!track) return null;
    return state.tracks.get(track.id) || track;
  }

  function resolveAll(list) {
    return (list || []).map(resolve).filter(Boolean);
  }

  function playable(track) {
    return !!(track && track.url);
  }

  function getFavorites() {
    return resolveAll(Store.get('favorites')).filter((t) => t && (t.source !== 'local' || Library.get(t.id)));
  }

  function getHistory() {
    return resolveAll(Store.get('history')).filter((t) => t && (t.source !== 'local' || Library.get(t.id)));
  }

  function searchLocal(query) {
    const q = U.norm(query);
    if (!q) return [];
    return Library.list().filter((t) => {
      return U.norm(t.title).indexOf(q) >= 0 || U.norm(t.artist).indexOf(q) >= 0 || U.norm(t.album).indexOf(q) >= 0;
    }).slice(0, 24);
  }

  function setInput(value) {
    if (searchInput.value !== value) searchInput.value = value;
    toggleClearButton();
  }

  function toggleClearButton() {
    searchClear.hidden = !searchInput.value;
  }

  function updateCounts() {
    countFavEl.textContent = String(Store.get('favorites').length);
    countFilesEl.textContent = String(Library.count());
  }

  /* ------------------------------------------------------------------ */
  /*  Тема, источник, панели                                             */
  /* ------------------------------------------------------------------ */

  function applyTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.theme;
    const iconName = state.theme === 'dark' ? 'sun' : 'moon';
    themeIcoEl.innerHTML = U.icon(iconName);
    themeIcoTopEl.innerHTML = U.icon(iconName);
    themeLabelEl.textContent = state.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#07070c' : '#f5f4fa');
    Store.set('theme', state.theme);
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    U.toast(state.theme === 'dark' ? 'Тёмная тема включена' : 'Светлая тема включена');
  }

  function updateSourceUI() {
    Array.from(sourceSwitch.querySelectorAll('[data-source]')).forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.source === state.source);
    });
  }

  function setSource(source) {
    if (['all', 'youtube', 'itunes', 'deezer'].indexOf(source) < 0 || source === state.source) return;
    state.source = source;
    Store.set('source', source);
    updateSourceUI();
    if (state.route.name === 'search' && state.query) {
      state.filter = 'all';
      const params = new URLSearchParams({ q: state.query });
      if (source !== 'all') params.set('src', source);
      const hash = '#/search?' + params.toString();
      history.replaceState(null, '', hash);
      state.route = parseHash();
      state.lastQuery = '';
      runSearch(++state.routeToken);
    } else if (state.route.name === 'mix') {
      state.mixKey = '';
      route();
    } else {
      U.toast(source === 'all' ? 'Ищем везде: полные треки и превью' : source === 'youtube' ? 'YouTube: полные треки' : 'Источник: ' + (source === 'itunes' ? 'iTunes' : 'Deezer'));
    }
  }

  function setQueueOpen(open) {
    state.queueOpen = !!open;
    appEl.classList.toggle('is-queue-open', state.queueOpen);
    Store.set('queueOpen', state.queueOpen);
    if (state.queueOpen) {
      renderQueue();
      updateNowPlaying();
    }
  }

  function toggleQueue() { setQueueOpen(!state.queueOpen); }

  function setSidebarOpen(open) {
    appEl.classList.toggle('is-sidebar-open', !!open);
  }

  function closePanels() {
    setSidebarOpen(false);
    if (window.innerWidth <= 1024 && state.queueOpen) setQueueOpen(false);
  }

  /* ------------------------------------------------------------------ */
  /*  Маршрутизация                                                      */
  /* ------------------------------------------------------------------ */

  function parseHash() {
    const raw = location.hash.replace(/^#/, '');
    const parts = raw.split('?');
    const segments = parts[0].split('/').filter(Boolean);
    return { name: segments[0] || 'home', params: new URLSearchParams(parts[1] || '') };
  }

  function setActiveNav(name) {
    const map = { home: 'home', search: 'home', mix: 'mix', favorites: 'favorites', history: 'history', files: 'files' };
    const active = map[name] || '';
    document.querySelectorAll('[data-nav]').forEach((el) => {
      el.classList.toggle('is-active', el.dataset.nav === active);
    });
  }

  async function route() {
    const token = ++state.routeToken;
    const parsed = parseHash();
    state.route = parsed;
    setActiveNav(parsed.name);
    if (window.innerWidth <= 1024) setSidebarOpen(false);
    viewEl.scrollTop = 0;

    if (parsed.name === 'home') {
      state.query = '';
      setInput('');
      renderHome();
      return;
    }

    if (parsed.name === 'search') {
      const q = (parsed.params.get('q') || '').trim();
      const filter = parsed.params.get('f');
      const source = parsed.params.get('src');
      state.filter = filter && ['all', 'tracks', 'albums', 'artists'].indexOf(filter) >= 0 ? filter : 'all';
      if (source && ['all', 'youtube', 'itunes', 'deezer'].indexOf(source) >= 0) {
        state.source = source;
        updateSourceUI();
      }
      if (!q) {
        history.replaceState(null, '', '#/');
        state.route = { name: 'home', params: new URLSearchParams() };
        setActiveNav('home');
        renderHome();
        return;
      }
      state.query = q;
      setInput(q);
      if (state.lastQuery === q && state.lastSource === state.source && state.results) {
        renderSearch();
        return;
      }
      await runSearch(token);
      return;
    }

    state.query = '';
    setInput('');

    if (parsed.name === 'favorites') { renderFavorites(); return; }
    if (parsed.name === 'history') { renderHistory(); return; }
    if (parsed.name === 'files') { renderFiles(); return; }

    if (parsed.name === 'album') {
      const id = parsed.params.get('id') || '';
      if (!id) { viewEl.innerHTML = UI.notFoundView(); return; }
      if (state.album && state.albumId === id && state.albumSource === state.source) { renderAlbum(); return; }
      state.albumId = id;
      state.albumSource = state.source;
      state.album = null;
      viewEl.innerHTML = UI.albumView({ loading: true });
      try {
        const data = await API.getAlbum(id, state.source);
        if (token !== state.routeToken) return;
        state.album = data;
        state.lists.album = data.tracks;
        regAll(data.tracks);
        renderAlbum();
      } catch (e) {
        if (token !== state.routeToken) return;
        viewEl.innerHTML = UI.albumView({ error: e && e.message ? e.message : 'Не удалось открыть альбом' });
      }
      return;
    }

    if (parsed.name === 'artist') {
      const name = (parsed.params.get('name') || '').trim();
      if (!name) { viewEl.innerHTML = UI.notFoundView(); return; }
      state.artistName = name;
      const key = state.source + '|' + name.toLowerCase();
      if (state.artistCache.has(key)) {
        const tracks = state.artistCache.get(key);
        state.lists.artist = tracks;
        regAll(tracks);
        viewEl.innerHTML = UI.artistView({ name: name, tracks: tracks });
        markCurrentTracks();
        return;
      }
      viewEl.innerHTML = UI.artistView({ name: name, loading: true });
      try {
        const data = await API.artistTracks(name, state.source);
        if (token !== state.routeToken) return;
        state.artistCache.set(key, data.tracks);
        state.lists.artist = data.tracks;
        regAll(data.tracks);
        viewEl.innerHTML = UI.artistView({ name: name, tracks: data.tracks });
        markCurrentTracks();
      } catch (e) {
        if (token !== state.routeToken) return;
        viewEl.innerHTML = UI.artistView({ name: name, error: e && e.message ? e.message : 'Не удалось загрузить исполнителя' });
      }
      return;
    }

    if (parsed.name === 'mix') {
      await loadMix(token);
      return;
    }

    viewEl.innerHTML = UI.notFoundView();
  }

  async function runSearch(token) {
    const q = state.query;
    const source = state.source;
    state.loading = true;
    state.error = '';
    state.results = null;
    state.localMatches = searchLocal(q);
    state.lists.search = state.localMatches.slice();
    renderSearch();

    let result;
    try {
      result = await API.search(q, source);
    } catch (e) {
      result = { tracks: [], albums: [], artists: [], errors: [{ message: e && e.message ? e.message : 'Ошибка сети' }] };
    }
    if (token !== state.routeToken) return;

    state.loading = false;
    state.results = result;
    state.lastQuery = q;
    state.lastSource = source;
    state.lists.search = state.localMatches.concat(result.tracks || []);
    regAll(result.tracks);
    regAll(result.albums);

    if (result.errors && result.errors.length) {
      if (!result.tracks.length && !state.localMatches.length) {
        state.error = state.source === 'youtube'
          ? 'YouTube не ответил. Проверьте, что сайт открыт через «Запустить.bat», и попробуйте ещё раз.'
          : 'Источники не ответили. Проверьте подключение к интернету и попробуйте ещё раз.';
      } else if (!state.warned.has(q)) {
        state.warned.add(q);
        U.toast('Один из источников не ответил — показываем остальное', 'error');
      }
    }

    if (result.tracks.length || state.localMatches.length) Store.addSearch(q);
    renderSearch();
  }

  function updateSearchHash(replace) {
    const params = new URLSearchParams();
    params.set('q', state.query);
    if (state.filter !== 'all') params.set('f', state.filter);
    if (state.source !== 'all') params.set('src', state.source);
    const hash = '#/search?' + params.toString();
    if (replace) {
      history.replaceState(null, '', hash);
      state.route = parseHash();
      setActiveNav('search');
    } else if (location.hash === hash) {
      state.route = parseHash();
      runSearch(++state.routeToken);
    } else {
      location.hash = hash;
    }
  }

  function navigateSearch(query, replace) {
    const q = String(query || '').trim();
    if (!q) { clearSearch(true); return; }
    setInput(q);
    const cached = state.lastQuery === q && state.lastSource === state.source && !!state.results;
    state.query = q;
    if (!cached) {
      state.filter = 'all';
      state.results = null;
    }
    const before = location.hash;
    updateSearchHash(replace);
    if (replace || location.hash === before) {
      if (cached) {
        state.route = parseHash();
        setActiveNav('search');
        renderSearch();
      } else {
        runSearch(++state.routeToken);
      }
    }
  }

  function clearSearch(keepFocus) {
    searchInput.value = '';
    toggleClearButton();
    state.query = '';
    history.replaceState(null, '', '#/');
    state.route = { name: 'home', params: new URLSearchParams() };
    setActiveNav('home');
    renderHome();
    if (keepFocus) {
      searchInput.focus();
      searchInput.select();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Рендер экранов                                                     */
  /* ------------------------------------------------------------------ */

  function renderHome() {
    const favorites = getFavorites();
    const recent = getHistory();
    state.lists.favorites = favorites;
    state.lists.recent = recent;
    regAll(favorites);
    regAll(recent);
    viewEl.innerHTML = UI.homeView({
      favorites: favorites,
      recent: recent,
      searches: Store.get('searches'),
      localCount: Library.count(),
      localSize: Library.totalSize()
    });
    markCurrentTracks();
  }

  function renderSearch() {
    const local = state.localMatches || [];
    if (state.lists.search.length !== local.length + ((state.results && state.results.tracks.length) || 0)) {
      state.lists.search = local.concat((state.results && state.results.tracks) || []);
    }
    viewEl.innerHTML = UI.searchView({
      query: state.query,
      filter: state.filter,
      source: state.source,
      results: state.results,
      local: local,
      loading: state.loading,
      error: state.error
    });
    markCurrentTracks();
  }

  function renderFavorites() {
    const tracks = getFavorites();
    state.lists.favorites = tracks;
    regAll(tracks);
    viewEl.innerHTML = UI.favoritesView({ tracks: tracks });
    markCurrentTracks();
  }

  function renderHistory() {
    const tracks = getHistory();
    state.lists.history = tracks;
    regAll(tracks);
    viewEl.innerHTML = UI.historyView({ tracks: tracks });
    markCurrentTracks();
  }

  function renderFiles() {
    const tracks = Library.list();
    state.lists.local = tracks;
    regAll(tracks);
    viewEl.innerHTML = UI.filesView({
      tracks: tracks,
      totalSize: Library.totalSize(),
      persistent: Library.isPersistent() && !Library.isBroken()
    });
    markCurrentTracks();
  }

  function renderAlbum() {
    if (!state.album) { viewEl.innerHTML = UI.albumView({ loading: true }); return; }
    state.lists.album = state.album.tracks;
    viewEl.innerHTML = UI.albumView({ album: state.album.album, tracks: state.album.tracks });
    markCurrentTracks();
  }

  function dailySeed() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const day = Math.floor((now - start) / 86400000);
    return MIX_SEEDS[day % MIX_SEEDS.length];
  }

  async function loadMix(token) {
    const seed = dailySeed();
    const dateLabel = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const key = new Date().toDateString() + '|' + seed + '|' + state.source;
    if (state.mix && state.mixKey === key) {
      state.lists.mix = state.mix;
      viewEl.innerHTML = UI.mixView({ seed: seed, tracks: state.mix, dateLabel: dateLabel });
      markCurrentTracks();
      return;
    }
    viewEl.innerHTML = UI.mixView({ seed: seed, tracks: [], loading: true, dateLabel: dateLabel });
    const res = await API.search(seed, state.source).catch(() => null);
    if (token !== state.routeToken) return;
    if (!res || (!res.tracks.length && !res.albums.length)) {
      viewEl.innerHTML = UI.mixView({ seed: seed, tracks: [], dateLabel: dateLabel, error: 'Не удалось собрать подборку. Проверьте интернет.' });
      return;
    }
    state.mix = res.tracks.filter(playable).slice(0, 24);
    state.mixKey = key;
    state.lists.mix = state.mix;
    regAll(state.mix);
    viewEl.innerHTML = UI.mixView({ seed: seed, tracks: state.mix, dateLabel: dateLabel });
    markCurrentTracks();
  }

  function renderNotFound() {
    viewEl.innerHTML = UI.notFoundView();
  }

  /* ------------------------------------------------------------------ */
  /*  Плеер: интерфейс                                                   */
  /* ------------------------------------------------------------------ */

  function updatePlayerUI() {
    const s = Player.state;
    const t = s.current;

    if (t) {
      pArtEl.style.cssText = UI.artBg(t);
      pArtEl.innerHTML = UI.art(t);
      pTitleEl.textContent = t.title;
      pArtistEl.textContent = t.artist;
      pBadgeEl.hidden = !(t.preview || t.source === 'youtube');
      pBadgeEl.textContent = t.source === 'youtube' ? 'ПОЛНЫЙ' : t.preview ? '30 сек' : '';
      pTitleEl.title = t.title;
      pArtistEl.title = t.artist;
      document.title = t.title + ' — ' + t.artist + ' · Волна';
    } else {
      pArtEl.style.cssText = '';
      pArtEl.innerHTML = '';
      pTitleEl.textContent = 'Ничего не играет';
      pArtistEl.textContent = 'Включите трек из поиска';
      pBadgeEl.hidden = true;
      document.title = 'Волна — музыкальный плеер';
    }

    pPlayEl.innerHTML = U.icon(s.playing ? 'pause' : 'play');
    pPlayEl.setAttribute('aria-label', s.playing ? 'Пауза' : 'Играть');
    pPlayEl.classList.toggle('is-playing', s.playing);

    const liked = t ? Store.isFavorite(t.id) : false;
    pLikeEl.classList.toggle('is-liked', liked);
    pLikeEl.disabled = !t;
    pLikeEl.setAttribute('aria-pressed', String(liked));
    pLikeEl.setAttribute('aria-label', liked ? 'Убрать из избранного' : 'В избранное');
    pLikeEl.title = liked ? 'Убрать из избранного' : 'В избранное';

    pShuffleEl.classList.toggle('is-active', s.shuffle);
    pRepeatEl.classList.toggle('is-active', s.repeat !== 'off');
    const repeatOne = pRepeatEl.querySelector('.repeat-one');
    if (repeatOne) repeatOne.hidden = s.repeat !== 'one';

    pDurEl.textContent = U.fmtTime(s.duration || (t && t.duration) || 0);
    updateVolumeUI();
    markCurrentTracks();
    updateNowPlaying();
  }

  function updateNowPlaying() {
    const t = Player.state.current;
    if (t) {
      nowArtEl.style.cssText = UI.artBg(t);
      nowArtEl.innerHTML = UI.art(t);
      nowTitleEl.textContent = t.title;
      nowArtistEl.textContent = t.artist;
    } else {
      nowArtEl.style.cssText = 'background:radial-gradient(120% 120% at 30% 20%, #1d2030, #0d0f17)';
      nowArtEl.innerHTML = '';
      nowTitleEl.textContent = 'Тишина';
      nowArtistEl.textContent = 'Выберите трек, чтобы начать';
    }
  }

  function updateVolumeUI() {
    const s = Player.state;
    const v = s.muted ? 0 : s.volume;
    volumeEl.value = String(v);
    volumeEl.style.setProperty('--vol', Math.round(v * 100) + '%');
    const name = s.muted || v === 0 ? 'volumeX' : v < 0.5 ? 'volumeLow' : 'volume';
    pMuteEl.innerHTML = U.icon(name);
    pMuteEl.classList.toggle('is-active', s.muted || v === 0);
  }

  let lastSecond = -1;
  function updateProgress() {
    const s = Player.state;
    const duration = s.duration || 0;
    const ratio = duration > 0 ? U.clamp(s.position / duration, 0, 1) : 0;
    const percent = (ratio * 100).toFixed(2) + '%';
    if (!state.seeking) {
      pFillEl.style.width = percent;
      pFillMobileEl.style.width = percent;
      if (seekEl) seekEl.querySelector('.seek__thumb').style.left = percent;
    }
    const bufRatio = duration > 0 ? U.clamp(s.buffered / duration, 0, 1) : 0;
    pBufEl.style.width = (bufRatio * 100).toFixed(2) + '%';
    const sec = Math.floor(s.position);
    if (sec !== lastSecond) {
      lastSecond = sec;
      if (!state.seeking) pCurEl.textContent = U.fmtTime(s.position);
      pDurEl.textContent = U.fmtTime(duration || (s.current && s.current.duration) || 0);
    }
  }

  function markCurrentTracks() {
    const current = Player.state.current;
    const id = current && current.id;
    const playing = Player.state.playing;
    document.querySelectorAll('.track[data-id]').forEach((el) => {
      const isCurrent = el.dataset.id === id;
      el.classList.toggle('is-current', isCurrent);
      el.classList.toggle('is-paused', isCurrent && !playing);
    });
    document.querySelectorAll('.q-item').forEach((el, index) => {
      el.classList.toggle('is-current', index === Player.state.index);
    });
  }

  function refreshLikes() {
    document.querySelectorAll('[data-action="like"][data-id]').forEach((btn) => {
      const liked = Store.isFavorite(btn.dataset.id);
      btn.classList.toggle('is-liked', liked);
      btn.setAttribute('aria-pressed', String(liked));
      btn.setAttribute('aria-label', liked ? 'Убрать из избранного' : 'В избранное');
      btn.title = liked ? 'Убрать из избранного' : 'В избранное';
    });
    const current = Player.state.current;
    const liked = !!(current && Store.isFavorite(current.id));
    pLikeEl.classList.toggle('is-liked', liked);
    pLikeEl.setAttribute('aria-pressed', String(liked));
    pLikeEl.setAttribute('aria-label', liked ? 'Убрать из избранного' : 'В избранное');
    pLikeEl.title = liked ? 'Убрать из избранного' : 'В избранное';
  }

  function renderQueue() {
    const queue = Player.getQueue();
    const current = Player.state.current;
    queueListEl.innerHTML = queue.map((t, i) => UI.queueItem(t, i, current && current.id)).join('');
    queueCountEl.textContent = U.fmtTracks(queue.length);
    queueEmptyEl.classList.toggle('is-visible', queue.length === 0);
    Store.set('queue', queue);
    Store.set('queueIndex', Player.state.index);
  }

  /* ------------------------------------------------------------------ */
  /*  Действия                                                           */
  /* ------------------------------------------------------------------ */

  function playTrackById(id, listName) {
    let track = state.tracks.get(id);
    if (!track && String(id).indexOf('local:') === 0) {
      track = Library.get(id);
      if (track) reg(track);
    }
    if (!track) { U.toast('Трек не найден', 'error'); return; }
    if (!track.url) { U.toast('Для этого трека нет доступного превью', 'error'); return; }
    const sourceList = state.lists[listName] || [track];
    const list = resolveAll(sourceList).filter(playable);
    let index = list.findIndex((t) => t.id === id);
    if (index < 0) { list.unshift(track); index = 0; }
    Player.setQueue(list, index, true);
  }

  function playCollection(listName, shuffle) {
    let list = resolveAll(state.lists[listName] || []).filter(playable);
    if (!list.length) { U.toast('Здесь пока нечего играть'); return; }
    if (shuffle) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      }
      Player.setShuffle(true);
    }
    Player.setQueue(list, 0, true);
    U.toast(shuffle ? 'Включаю вперемешку' : 'Играем');
  }

  function toggleLike(id) {
    let track = state.tracks.get(id);
    if (!track) { track = Library.get(id); if (track) reg(track); }
    if (!track) return;
    const added = Store.toggleFavorite(track);
    U.toast(added ? 'Добавлено в избранное' : 'Убрано из избранного', 'success');
    refreshLikes();
    updateCounts();
    if (state.route.name === 'favorites') renderFavorites();
    else if (state.route.name === 'home') renderHome();
    updatePlayerUI();
  }

  async function addToQueueById(id) {
    let track = state.tracks.get(id);
    if (!track) { track = Library.get(id); if (track) reg(track); }
    if (!track) return;
    if (!track.url) { U.toast('У этого трека нет превью', 'error'); return; }
    Player.addToQueue(track);
    U.toast('Добавлено в очередь', 'success');
  }

  async function openAlbumAndPlay(id) {
    U.toast('Загружаю альбом…');
    try {
      const data = await API.getAlbum(id, state.source);
      regAll(data.tracks);
      const tracks = data.tracks.filter(playable);
      if (!tracks.length) { U.toast('В этом альбоме нет доступных треков', 'error'); return; }
      state.lists['album-temp'] = tracks;
      Player.setQueue(tracks, 0, true);
    } catch (e) {
      U.toast('Не удалось загрузить альбом', 'error');
    }
  }

  async function deleteLocal(id) {
    const current = Player.state.current;
    if (current && current.id === id) {
      if (Player.getQueue().length > 1) Player.next(false);
      else Player.clearQueue();
    }
    await Library.remove(id.slice(6));
    Store.removeFavorite(id);
    refreshLikes();
    updateCounts();
    U.toast('Файл удалён из фонотеки', 'success');
  }

  async function clearLocal() {
    if (!Library.count()) return;
    if (!window.confirm('Удалить все файлы из фонотеки? Это действие нельзя отменить.')) return;
    const current = Player.state.current;
    if (current && current.source === 'local') Player.clearQueue();
    await Library.clear();
    updateCounts();
    renderFiles();
    U.toast('Фонотека очищена', 'success');
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const audioCount = files.filter(Library.isAudio).length;
    if (!audioCount) { U.toast('Среди файлов нет аудио', 'error'); return; }
    U.toast('Читаю теги и добавляю ' + U.fmtTracks(audioCount) + '…');
    const result = await Library.addFiles(files);
    if (result.added.length) {
      regAll(result.added);
      U.toast('Добавлено: ' + result.added.length + ' ' + U.plural(result.added.length, ['файл', 'файла', 'файлов']), 'success');
      updateCounts();
      if (state.route.name === 'files') renderFiles();
      else if (state.route.name === 'home') renderHome();
    }
    if (result.failed.length) {
      U.toast(result.failed.length + ' ' + U.plural(result.failed.length, ['файл не добавлен', 'файла не добавлено', 'файлов не добавлено']), 'error');
    }
    if (result.unsaved) {
      U.toast('Браузер не разрешил сохранить файлы — они доступны до перезагрузки', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /*  События плеера                                                     */
  /* ------------------------------------------------------------------ */

  function bindPlayerEvents() {
    Player.on('track', (track) => {
      if (track) reg(track);
      state.historyGuard = '';
      updatePlayerUI();
      renderQueue();
      updateProgress();
      markCurrentTracks();
    });

    Player.on('state', () => {
      updatePlayerUI();
      markCurrentTracks();
      const s = Player.state;
      pPlayEl.innerHTML = U.icon(s.playing ? 'pause' : 'play');
      if (s.playing && s.current && state.historyGuard !== s.current.id) {
        state.historyGuard = s.current.id;
        Store.addHistory(s.current);
      }
    });

    Player.on('time', updateProgress);
    Player.on('volume', updateVolumeUI);

    Player.on('queue', () => {
      renderQueue();
      if (state.queueOpen) updateNowPlaying();
    });

    Player.on('error', () => {
      U.toast('Не удалось включить трек. Возможно, превью больше недоступно.', 'error');
    });

    Player.on('blocked', () => {
      U.toast('У этого трека нет доступного превью', 'error');
    });

    Player.on('warn', (message) => {
      U.toast(message);
    });

    Player.on('needs-gesture', () => {
      U.toast('Нажмите «Играть» ещё раз — браузеру нужно ваше действие', 'error');
    });

    Player.on('play-error', () => {
      U.toast('Не удалось воспроизвести трек', 'error');
    });

    Player.on('repeat', (mode) => {
      U.toast(mode === 'off' ? 'Повтор выключен' : mode === 'all' ? 'Повтор очереди' : 'Повтор одного трека');
    });
  }

  /* ------------------------------------------------------------------ */
  /*  События интерфейса                                                 */
  /* ------------------------------------------------------------------ */

  document.addEventListener('click', (event) => {
    const sourceBtn = event.target.closest('[data-source]');
    if (sourceBtn) {
      setSource(sourceBtn.dataset.source);
      return;
    }

    const el = event.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {
      case 'play-track':
        playTrackById(el.dataset.id, el.dataset.list || 'search');
        break;
      case 'play-queue':
        Player.setQueue(Player.getQueue(), Number(el.dataset.index), true);
        break;
      case 'queue-remove':
        event.stopPropagation();
        Player.removeAt(Number(el.dataset.index));
        break;
      case 'queue-add':
        addToQueueById(el.dataset.id);
        break;
      case 'like':
        toggleLike(el.dataset.id);
        break;
      case 'like-current':
        if (Player.state.current) toggleLike(Player.state.current.id);
        break;
      case 'toggle-play':
        if (Player.state.current) Player.toggle();
        else {
          if (state.lists.search && state.lists.search.length) playCollection('search');
          else if (state.lists.favorites && state.lists.favorites.length) playCollection('favorites');
          else searchInput.focus();
        }
        break;
      case 'next': Player.next(false); break;
      case 'prev': Player.prev(); break;
      case 'shuffle': Player.setShuffle(!Player.state.shuffle); break;
      case 'repeat': Player.cycleRepeat(); break;
      case 'toggle-mute': Player.toggleMute(); break;
      case 'toggle-queue': toggleQueue(); break;
      case 'toggle-sidebar': setSidebarOpen(!appEl.classList.contains('is-sidebar-open')); break;
      case 'close-panels': closePanels(); break;
      case 'open-shortcuts': openShortcuts(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'search-filter':
        state.filter = el.dataset.filter || 'all';
        state.route = parseHash();
        history.replaceState(null, '', searchHash());
        renderSearch();
        break;
      case 'play-list':
        playCollection(el.dataset.list, false);
        break;
      case 'shuffle-list':
        playCollection(el.dataset.list, true);
        break;
      case 'shuffle-queue':
        Player.shuffleQueue();
        U.toast('Очередь перемешана', 'success');
        break;
      case 'clear-queue':
        if (!Player.getQueue().length) break;
        Player.clearQueue();
        U.toast('Очередь очищена');
        break;
      case 'clear-history':
        if (!window.confirm('Очистить историю прослушиваний?')) break;
        Store.clearHistory();
        renderHistory();
        updateCounts();
        break;
      case 'clear-files':
        clearLocal();
        break;
      case 'clear-searches':
        Store.clearSearches();
        renderHome();
        break;
      case 'local-delete':
        deleteLocal(el.dataset.id);
        break;
      case 'open-album':
        location.hash = '#/album?id=' + encodeURIComponent(el.dataset.id);
        break;
      case 'play-album':
        event.stopPropagation();
        openAlbumAndPlay(el.dataset.id);
        break;
      case 'open-artist':
        location.hash = '#/artist?name=' + encodeURIComponent(el.dataset.artist);
        break;
      case 'quick-search':
        navigateSearch(el.dataset.q, false);
        searchInput.blur();
        break;
      case 'focus-search':
        searchInput.focus();
        searchInput.select();
        break;
      case 'clear-search':
        clearSearch(true);
        break;
      case 'retry':
        state.lastQuery = '';
        state.lastSource = '';
        if (state.route.name === 'search') runSearch(++state.routeToken);
        else if (state.route.name === 'album') { state.album = null; route(); }
        else if (state.route.name === 'artist') { state.artistCache.clear(); route(); }
        else if (state.route.name === 'mix') { state.mixKey = ''; route(); }
        break;
      case 'pick-files':
        fileInput.click();
        break;
      case 'open-mix':
        location.hash = '#/mix';
        break;
      case 'go':
        if (el.dataset.href) location.hash = el.dataset.href;
        break;
      default:
        break;
    }
  });

  function searchHash() {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.filter !== 'all') params.set('f', state.filter);
    if (state.source !== 'all') params.set('src', state.source);
    return '#/search?' + params.toString();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (dialogShortcuts.open) return;
      if (document.activeElement === searchInput) {
        if (searchInput.value) clearSearch(true);
        else searchInput.blur();
        return;
      }
      closePanels();
      return;
    }

    const target = event.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable);

    if (!typing && (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (!typing && event.key === '?') {
      event.preventDefault();
      openShortcuts();
      return;
    }
    if (typing) return;

    if (event.code === 'Space') {
      if (target.closest && target.closest('button, a, input, textarea, select')) return;
      event.preventDefault();
      if (Player.state.current) Player.toggle();
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (event.shiftKey) Player.next(false);
      else Player.seek(Player.state.position + 5);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (event.shiftKey) Player.prev();
      else Player.seek(Player.state.position - 5);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      Player.setVolume(Player.state.volume + 0.05);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      Player.setVolume(Player.state.volume - 0.05);
    } else if (event.key === 'm' || event.key === 'M') {
      Player.toggleMute();
    } else if (event.key === 'l' || event.key === 'L') {
      if (Player.state.current) toggleLike(Player.state.current.id);
    } else if (event.key === 'q' || event.key === 'Q') {
      toggleQueue();
    } else if (event.key === 's' || event.key === 'S') {
      Player.setShuffle(!Player.state.shuffle);
      U.toast(Player.state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено');
    } else if (event.key === 'Enter') {
      const row = target.closest && target.closest('.track[data-action="play-track"], .q-item[data-action], .card[data-action]');
      if (row) {
        event.preventDefault();
        row.click();
      }
    }
  });

  function openShortcuts() {
    if (dialogShortcuts.showModal) {
      if (!dialogShortcuts.open) dialogShortcuts.showModal();
    }
  }

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = searchInput.value.trim();
    if (!q) { searchInput.focus(); return; }
    navigateSearch(q, false);
    searchInput.blur();
  });

  let typeTimer = 0;
  searchInput.addEventListener('input', () => {
    toggleClearButton();
    const q = searchInput.value.trim();
    clearTimeout(typeTimer);
    if (!q) {
      state.query = '';
      history.replaceState(null, '', '#/');
      state.route = { name: 'home', params: new URLSearchParams() };
      setActiveNav('home');
      renderHome();
      return;
    }
    typeTimer = setTimeout(() => {
      if (searchInput.value.trim() !== q) return;
      if (state.lastQuery === q && state.lastSource === state.source && state.results) {
        updateSearchHash(true);
        renderSearch();
        return;
      }
      state.query = q;
      state.filter = 'all';
      updateSearchHash(true);
      runSearch(++state.routeToken);
    }, 380);
  });

  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  /* --- перемотка --- */
  function seekRatio(event) {
    const rect = seekEl.getBoundingClientRect();
    return U.clamp((event.clientX - rect.left) / rect.width, 0, 1);
  }

  function previewSeek(ratio) {
    const duration = Player.state.duration || 0;
    state.seeking = true;
    pFillEl.style.width = (ratio * 100).toFixed(2) + '%';
    seekEl.querySelector('.seek__thumb').style.left = (ratio * 100).toFixed(2) + '%';
    pCurEl.textContent = U.fmtTime(ratio * duration);
  }

  seekEl.addEventListener('pointerdown', (event) => {
    if (!Player.state.duration) return;
    state.seeking = true;
    seekEl.classList.add('is-dragging');
    try { seekEl.setPointerCapture(event.pointerId); } catch (e) { /* не критично */ }
    previewSeek(seekRatio(event));
    event.preventDefault();
  });

  seekEl.addEventListener('pointermove', (event) => {
    if (!state.seeking) return;
    previewSeek(seekRatio(event));
  });

  function finishSeek(event) {
    if (!state.seeking) return;
    const ratio = seekRatio(event);
    state.seeking = false;
    seekEl.classList.remove('is-dragging');
    Player.seek(ratio * (Player.state.duration || 0));
  }

  seekEl.addEventListener('pointerup', finishSeek);
  seekEl.addEventListener('pointercancel', () => {
    state.seeking = false;
    seekEl.classList.remove('is-dragging');
    updateProgress();
  });

  volumeEl.addEventListener('input', () => {
    Player.setVolume(Number(volumeEl.value));
  });

  /* --- drag & drop --- */
  let dragDepth = 0;
  function hasFiles(event) {
    return event.dataTransfer && Array.from(event.dataTransfer.types || []).indexOf('Files') >= 0;
  }

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  });

  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    addFiles(event.dataTransfer.files);
  });

  if (dialogShortcuts) {
    dialogShortcuts.addEventListener('click', (event) => {
      const rect = dialogShortcuts.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) dialogShortcuts.close();
    });
  }

  window.addEventListener('hashchange', () => { route(); });

  /* --- визуализатор --- */
  const vizCtx = vizCanvas.getContext('2d');
  const VIZ_BARS = 46;
  const vizLevels = new Float32Array(VIZ_BARS);
  let vizPhase = 0;

  function vizLoop() {
    requestAnimationFrame(vizLoop);
    if (!state.queueOpen || document.hidden) return;
    const rect = vizCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = rect.width;
    const height = rect.height;
    if (vizCanvas.width !== Math.round(width * dpr) || vizCanvas.height !== Math.round(height * dpr)) {
      vizCanvas.width = Math.round(width * dpr);
      vizCanvas.height = Math.round(height * dpr);
    }
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vizCtx.clearRect(0, 0, width, height);

    const data = Player.spectrum();
    const playing = Player.state.playing;
    vizPhase += 0.04;

    for (let i = 0; i < VIZ_BARS; i++) {
      let target = 0;
      if (playing) {
        if (data && data.length) {
          const bin = Math.max(1, Math.floor(Math.pow(i / VIZ_BARS, 1.65) * (data.length * 0.74)));
          target = (data[Math.min(data.length - 1, bin)] / 255) * 1.08;
        } else {
          const wave = Math.abs(Math.sin(vizPhase * 1.35 + i * 0.36)) * (0.55 + 0.45 * Math.sin(i * 0.85 + vizPhase * 0.6));
          target = U.clamp(0.16 + wave * 0.68, 0.05, 0.96);
        }
      }
      vizLevels[i] += (target - vizLevels[i]) * (playing ? 0.2 : 0.1);
      if (!playing && vizLevels[i] < 0.012) vizLevels[i] = 0;
    }

    const gradient = vizCtx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#8b5cff');
    gradient.addColorStop(0.55, '#6d7dff');
    gradient.addColorStop(1, '#22d3ee');
    vizCtx.fillStyle = gradient;
    const gap = Math.max(2, (width / VIZ_BARS) * 0.36);
    const barWidth = Math.max(2, (width - gap * (VIZ_BARS - 1)) / VIZ_BARS);
    const middle = height / 2;

    for (let i = 0; i < VIZ_BARS; i++) {
      const amplitude = Math.max(0.012, vizLevels[i]);
      const barHeight = Math.max(2, amplitude * (height - 8));
      const x = i * (barWidth + gap);
      const y = middle - barHeight / 2;
      const radius = Math.min(barWidth / 2, 2.5);
      vizCtx.beginPath();
      if (vizCtx.roundRect) vizCtx.roundRect(x, y, barWidth, barHeight, radius);
      else vizCtx.rect(x, y, barWidth, barHeight);
      vizCtx.fill();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Запуск                                                             */
  /* ------------------------------------------------------------------ */

  async function boot() {
    document.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = U.icon(el.dataset.icon);
    });

    applyTheme(state.theme);
    updateSourceUI();
    setQueueOpen(state.queueOpen && window.innerWidth > 720);

    viewEl.innerHTML = '<div class="page">' + UI.skeletonTracks(8) + '</div>';

    bindPlayerEvents();
    Player.init();
    updatePlayerUI();
    updateVolumeUI();

    await Library.init();
    Library.onChange((list) => {
      regAll(list);
      updateCounts();
      if (state.route.name === 'files') renderFiles();
    });

    const localTracks = Library.list();
    regAll(localTracks);
    updateCounts();

    const savedQueue = Store.get('queue') || [];
    const savedIndex = Number(Store.get('queueIndex'));
    const queueTracks = savedQueue.map((item) => {
      const id = typeof item === 'string' ? item : item && item.id;
      if (!id) return null;
      if (String(id).indexOf('local:') === 0) return Library.get(id) || state.tracks.get(id) || null;
      return state.tracks.get(id) || (item && typeof item === 'object' ? item : null);
    }).filter((t) => t && t.url);
    if (queueTracks.length) {
      const index = savedIndex >= 0 && savedIndex < queueTracks.length ? savedIndex : 0;
      Player.setQueue(queueTracks, index, false);
    }

    updateCounts();
    renderQueue();
    updatePlayerUI();
    updateProgress();

    await route();

    requestAnimationFrame(vizLoop);
  }

  boot().catch((error) => {
    console.error('[volna] boot', error);
    viewEl.innerHTML = '<div class="page">' + UI.emptyBlock({
      icon: 'alert',
      title: 'Не удалось запустить плеер',
      text: 'Обновите страницу. Если не поможет — откройте её через «Запустить.bat».',
      action: 'go', attrs: ' data-href="#/"', actionLabel: 'На главную'
    }) + '</div>';
  });

  // Небольшой отладочный доступ: удобно проверять состояние из консоли.
  window.Volna = {
    state: state,
    search: (q, src) => { state.query = q; state.source = src || state.source; return API.search(q, state.source); },
    play: playTrackById,
    route: route,
    Player: Player
  };
})();
