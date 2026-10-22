/* ==========================================================================
   Волна — YouTube: поиск полных треков и встроенный плеер
   Треки не скачиваются: играет официальный iframe-плеер YouTube.
   ========================================================================== */
(function () {
  'use strict';

  const listeners = new Map();

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => {
      const set = listeners.get(event);
      if (set) set.delete(fn);
    };
  }

  function emit(event, data) {
    const set = listeners.get(event);
    if (!set) return;
    set.forEach((fn) => {
      try { fn(data); } catch (e) { console.error('[volna] youtube listener', e); }
    });
  }

  /* ----------------------------- Поиск ---------------------------------- */

  function cleanTitle(title) {
    return String(title || '')
      .replace(/\s*[\[(](?:official\s*(?:music\s*)?(?:video|audio)|official\s*lyric\s*video|lyric\s*video|lyrics?|премьера|premiere|клип|video\s*clip|hd|4k|mv)[^\])]*[\])]/gi, ' ')
      .replace(/\s*[|•]\s*(?:official|премьера|premiere).*$/gi, ' ')
      .replace(/\s*\((?:19|20)\d{2}\)\s*$/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s*[-–—]\s*$/, '')
      .trim();
  }

  function cleanChannel(channel) {
    return String(channel || '')
      .replace(/\s*-\s*topic\s*$/i, '')
      .replace(/\s*(?:official|official channel|vevo)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function splitArtist(title, channel) {
    const clean = cleanTitle(title);
    const dash = clean.match(/^(.{2,60}?)\s+[-–—]\s+(.+)$/);
    if (!dash) return { title: clean, artist: cleanChannel(channel) || 'YouTube' };
    const left = dash[1].trim();
    const right = dash[2].trim();
    const channelName = cleanChannel(channel);
    const same = channelName && (U.norm(channelName) === U.norm(left) || U.norm(channelName).indexOf(U.norm(left)) === 0);
    if (same || !channelName || channelName.toLowerCase().indexOf('topic') >= 0) {
      return { title: right, artist: channelName || left };
    }
    // Канал вроде «Лучшая музыка» — исполнитель обычно указан в названии.
    if (left.length <= 42 && right.length >= 2) return { title: right, artist: left };
    return { title: clean, artist: channelName || 'YouTube' };
  }

  function mapItem(item) {
    const parsed = splitArtist(item.title, item.channel);
    return {
      id: 'youtube:' + item.videoId,
      source: 'youtube',
      title: parsed.title || item.title || 'Без названия',
      artist: parsed.artist || 'YouTube',
      album: 'YouTube',
      duration: Number(item.duration) || 0,
      art: item.thumb || '',
      url: item.url || ('https://www.youtube.com/watch?v=' + item.videoId),
      videoId: item.videoId,
      preview: false,
      full: true,
      views: item.views || ''
    };
  }

  async function fetchItems(query, limit) {
    const url = '/api/yt/search?q=' + encodeURIComponent(query) + '&limit=' + (limit || 24);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      let message = 'YouTube недоступен';
      try {
        const body = await res.json();
        if (body && body.error) message = body.error;
      } catch (e) { /* не JSON */ }
      throw new Error(message);
    }
    const data = await res.json();
    return (data.items || []).map(mapItem).filter((t) => t.videoId);
  }

  async function search(query, limit) {
    const q = String(query || '').trim();
    if (!q) return [];
    const base = await fetchItems(q, 24);
    const tracks = base.slice();
    const normQuery = U.norm(q);
    const artists = new Map();
    base.forEach((track) => {
      const key = U.norm(track.artist);
      artists.set(key, (artists.get(key) || 0) + 1);
    });
    let topArtist = '';
    let topCount = 0;
    artists.forEach((count, name) => {
      if (count > topCount) { topCount = count; topArtist = name; }
    });
    const artistLike = normQuery && topArtist && topArtist !== 'youtube music' && (
      topArtist === normQuery ||
      topArtist.indexOf(normQuery) >= 0 ||
      normQuery.indexOf(topArtist) >= 0
    ) && !/(хиты|песни|лучшие|songs|hits)/.test(normQuery);

    // Если ищем исполнителя, добираем популярные песни: одна страница
    // YouTube Music отдаёт только 10–15 треков.
    if (artistLike && tracks.length < 22) {
      const extras = await Promise.allSettled([
        fetchItems(q + ' хиты', 16),
        fetchItems(q + ' лучшие песни', 16)
      ]);
      extras.forEach((result) => {
        if (result.status === 'fulfilled') {
          result.value.forEach((track) => tracks.push(track));
        }
      });
    }

    const seen = new Set();
    const unique = [];
    const pool = artistLike
      ? tracks.filter((track) => {
          const artist = U.norm(track.artist);
          return !artist || artist.indexOf(topArtist) >= 0 || topArtist.indexOf(artist) >= 0;
        })
      : tracks;
    (pool.length >= 3 ? pool : tracks).forEach((track) => {
      const key = track.videoId;
      const key2 = U.norm(track.title) + '|' + U.norm(track.artist);
      if (seen.has(key) || seen.has(key2)) return;
      seen.add(key);
      seen.add(key2);
      unique.push(track);
    });
    return unique.slice(0, limit || 40);
  }

  /* ----------------------------- Плеер ---------------------------------- */

  let apiPromise = null;
  let player = null;
  let ready = false;
  let readyPromise = null;
  let host = null;
  let currentVideoId = '';
  let volume = 0.85;
  let muted = false;
  let wantPlay = false;
  let retryTimer = 0;

  function loadApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearInterval(check);
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof previous === 'function') {
          try { previous(); } catch (e) { /* чужой колбэк */ }
        }
        finish();
      };
      const check = setInterval(() => {
        if (window.YT && window.YT.Player) finish();
      }, 250);
      const timer = setTimeout(() => finish(new Error('YouTube не загрузился')), 15000);
      if (!document.querySelector('script[data-yt-api]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.dataset.ytApi = '1';
        script.onerror = () => finish(new Error('Не удалось загрузить YouTube'));
        document.head.appendChild(script);
      }
    });
    return apiPromise;
  }

  function applyVolume() {
    if (!player || !ready) return;
    try {
      player.setVolume(Math.round(volume * 100));
      if (muted || volume <= 0) player.mute();
      else if (wantPlay || isPlaying()) player.unMute();
    } catch (e) { /* плеер ещё не готов */ }
  }

  function ensure(videoId, autoplay) {
    if (ready && player) return Promise.resolve();
    if (readyPromise) return readyPromise;
    readyPromise = loadApi().then(() => new Promise((resolve, reject) => {
      if (!host) {
        host = document.createElement('div');
        host.id = 'yt-host';
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1;';
        document.body.appendChild(host);
      }
      const mount = document.createElement('div');
      mount.id = 'yt-mount';
      host.appendChild(mount);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('YouTube не ответил'));
      }, 15000);
      player = new window.YT.Player(mount, {
        width: '320',
        height: '180',
        videoId: videoId || '',
        playerVars: {
          autoplay: autoplay ? 1 : 0,
          mute: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          origin: location.origin
        },
        events: {
          onReady: () => {
            ready = true;
            applyVolume();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
            emit('ready');
          },
          onStateChange: (event) => {
            emit('state', event.data);
          },
          onError: (event) => {
            emit('error', event.data);
          }
        }
      });
    }));
    return readyPromise;
  }

  async function load(videoId, autoplay) {
    if (!videoId) throw new Error('Не указан ролик');
    autoplay = autoplay !== false;
    wantPlay = autoplay;
    clearTimeout(retryTimer);
    const first = !ready;
    await ensure(videoId, autoplay);
    currentVideoId = videoId;
    if (!first) {
      if (autoplay) player.loadVideoById({ videoId: videoId, startSeconds: 0 });
      else player.cueVideoById({ videoId: videoId, startSeconds: 0 });
    } else if (!autoplay) {
      try { player.pauseVideo(); } catch (e) { /* ещё стартует */ }
    }
    if (autoplay) {
      // Плеер стартует в mute-режиме, поэтому браузер не блокирует запуск.
      wantPlay = true;
      try { player.playVideo(); } catch (e) { /* подождём onReady */ }
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (wantPlay && player && ready && !isPlaying()) {
          try { player.playVideo(); } catch (e) { /* пусто */ }
        }
      }, 1200);
    }
    applyVolume();
  }

  function play() {
    if (!player || !ready) return Promise.reject(new Error('Плеер ещё не готов'));
    wantPlay = true;
    player.playVideo();
    applyVolume();
    return Promise.resolve();
  }

  function pause() {
    wantPlay = false;
    clearTimeout(retryTimer);
    if (!player || !ready) return;
    try { player.pauseVideo(); } catch (e) { /* пусто */ }
  }

  function stop() {
    wantPlay = false;
    clearTimeout(retryTimer);
    if (!player || !ready) return;
    try { player.stopVideo(); } catch (e) { /* пусто */ }
  }

  function seek(seconds) {
    if (!player || !ready || !isFinite(seconds)) return;
    try { player.seekTo(Math.max(0, seconds), true); } catch (e) { /* пусто */ }
  }

  function setVolume(value) {
    volume = Math.max(0, Math.min(1, Number(value) || 0));
    applyVolume();
  }

  function setMuted(value) {
    muted = !!value;
    applyVolume();
  }

  function time() {
    if (!player || !ready) return 0;
    try { return player.getCurrentTime() || 0; } catch (e) { return 0; }
  }

  function duration() {
    if (!player || !ready) return 0;
    try { return player.getDuration() || 0; } catch (e) { return 0; }
  }

  function isPlaying() {
    if (!player || !ready) return false;
    try { return player.getPlayerState() === 1; } catch (e) { return false; }
  }

  function currentId() { return currentVideoId; }

  window.YouTube = {
    search,
    on,
    load,
    play,
    pause,
    stop,
    seek,
    setVolume,
    setMuted,
    time,
    duration,
    isPlaying,
    currentId,
    isReady: () => ready
  };
})();
