/* ==========================================================================
   Волна — аудиодвижок, очередь, Web Audio визуализатор
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
      try { fn(data); } catch (err) { console.error('[volna] player listener', err); }
    });
  }

  function createAudio() {
    const el = new Audio();
    el.preload = 'metadata';
    el.volume = state.volume;
    el.muted = state.muted;
    el.hidden = true;
    el.setAttribute('playsinline', '');
    document.body.appendChild(el);
    wire(el);
    return el;
  }

  let audio = null;
  let ctx = null;
  let sourceNode = null;
  let analyser = null;
  let freqData = null;
  let graphBroken = false;
  let corsRetried = false;
  let queue = [];
  let currentIndex = -1;
  let tickId = 0;
  let tickTimeout = 0;
  let lastTickEmit = 0;
  let ytMode = false;
  let engineToken = 0;
  const shuffleHistory = [];

  const state = {
    current: null,
    playing: false,
    position: 0,
    duration: 0,
    buffered: 0,
    volume: Store.get('volume'),
    muted: !!Store.get('muted'),
    shuffle: !!Store.get('shuffle'),
    repeat: Store.get('repeat') || 'off',
    queueLength: 0,
    index: -1,
    graph: false
  };

  function wire(el) {
    el.addEventListener('loadedmetadata', onLoadedMeta);
    el.addEventListener('durationchange', onLoadedMeta);
    el.addEventListener('play', () => {
      state.playing = true;
      startTicker();
      emit('state');
    });
    el.addEventListener('pause', () => {
      state.playing = false;
      stopTicker();
      emit('state');
    });
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.addEventListener('timeupdate', () => {
      if (!state.playing) emitTime();
    });
    el.addEventListener('progress', () => emitTime());
    el.addEventListener('volumechange', () => {
      state.volume = el.volume;
      state.muted = el.muted;
      emit('volume');
    });
  }

  function isRemote(url) {
    return /^https?:/i.test(String(url || ''));
  }

  function isYouTube(track) {
    return !!(track && track.source === 'youtube' && track.videoId);
  }

  function bindYouTube() {
    if (!window.YouTube) return;
    YouTube.on('state', (code) => {
      if (!ytMode) return;
      if (code === 1) {
        state.playing = true;
        startTicker();
        emit('state');
        updateSession();
      } else if (code === 2) {
        state.playing = false;
        stopTicker();
        emit('state');
        updateSession();
      } else if (code === 0) {
        state.playing = false;
        stopTicker();
        emit('state');
        onEnded();
      }
    });
    YouTube.on('error', (code) => {
      if (!ytMode) return;
      state.playing = false;
      stopTicker();
      emit('state');
      emit('error', { track: state.current, code: code });
    });
  }

  function onLoadedMeta() {
    if (!audio) return;
    if (isFinite(audio.duration) && audio.duration > 0) {
      state.duration = audio.duration;
    }
    connectGraph();
    emit('time');
    emit('state');
  }

  function connectGraph() {
    if (graphBroken || sourceNode || !ctx || !audio) return;
    if (isRemote(audio.src) && !audio.hasAttribute('crossorigin')) return;
    try {
      sourceNode = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      sourceNode.connect(analyser);
      analyser.connect(ctx.destination);
      state.graph = true;
    } catch (e) {
      graphBroken = true;
      sourceNode = null;
      analyser = null;
    }
  }

  function ensureContext() {
    if (ctx || graphBroken) return;
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) { graphBroken = true; return; }
      ctx = new AudioCtor();
    } catch (e) {
      ctx = null;
      graphBroken = true;
    }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function startTicker() {
    stopTicker();
    if (ytMode) tickTimeout = setTimeout(tick, 0);
    else tickId = requestAnimationFrame(tick);
  }

  function stopTicker() {
    if (tickId) cancelAnimationFrame(tickId);
    tickId = 0;
    if (tickTimeout) clearTimeout(tickTimeout);
    tickTimeout = 0;
  }

  function tick() {
    if (!state.playing) { tickId = 0; return; }
    if (ytMode) {
      state.position = window.YouTube ? YouTube.time() : 0;
      const ytDuration = window.YouTube ? YouTube.duration() : 0;
      if (ytDuration > 0) state.duration = ytDuration;
      state.buffered = state.duration;
    } else {
      state.position = audio ? (audio.currentTime || 0) : 0;
      if (audio && isFinite(audio.duration) && audio.duration > 0) state.duration = audio.duration;
      state.buffered = bufferedEnd();
    }
    const now = performance.now();
    if (now - lastTickEmit > 60) {
      lastTickEmit = now;
      emit('time');
    }
    tickTimeout = 0;
    tickId = 0;
    if (ytMode) tickTimeout = setTimeout(tick, 250);
    else tickId = requestAnimationFrame(tick);
  }

  function emitTime() {
    if (ytMode) {
      state.position = window.YouTube ? YouTube.time() : 0;
      const ytDuration = window.YouTube ? YouTube.duration() : 0;
      if (ytDuration > 0) state.duration = ytDuration;
      state.buffered = state.duration;
      emit('time');
      return;
    }
    if (!audio) return;
    state.position = audio.currentTime || 0;
    if (isFinite(audio.duration) && audio.duration > 0) state.duration = audio.duration;
    state.buffered = bufferedEnd();
    emit('time');
  }

  function bufferedEnd() {
    if (!audio) return 0;
    try {
      const ranges = audio.buffered;
      if (ranges && ranges.length) return ranges.end(ranges.length - 1);
    } catch (e) { /* нет данных */ }
    return 0;
  }

  function updateSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      if (!state.current) {
        navigator.mediaSession.metadata = null;
        return;
      }
      const artwork = state.current.art ? [{ src: state.current.art, sizes: '512x512', type: 'image/jpeg' }] : [];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.current.title || 'Волна',
        artist: state.current.artist || '',
        album: state.current.album || '',
        artwork: artwork
      });
      navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    } catch (e) {
      // Media Session не критичен для работы плеера.
    }
  }

  function loadTrack(track, autoplay) {
    if (!track) return;
    if (!track.url && !isYouTube(track)) {
      emit('blocked', { track: track });
      return;
    }
    const token = ++engineToken;
    state.current = track;
    state.position = 0;
    state.buffered = 0;
    state.duration = track.duration || 0;
    corsRetried = false;

    if (isYouTube(track)) {
      ytMode = true;
      state.graph = false;
      stopTicker();
      state.playing = false;
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch (e) { /* пусто */ }
      updateSession();
      emit('track', track);
      emit('time');
      if (window.YouTube) {
        YouTube.load(track.videoId, autoplay !== false).then(() => {
          if (token !== engineToken) { YouTube.pause(); return; }
          if (autoplay === false) emitTime();
        }).catch((error) => {
          if (token !== engineToken) return;
          state.playing = false;
          stopTicker();
          emit('state');
          emit('play-error', error);
        });
      }
      return;
    }

    ytMode = false;
    if (window.YouTube) YouTube.pause();

    audio.pause();
    if (isRemote(track.url) && !graphBroken) audio.setAttribute('crossorigin', 'anonymous');
    else audio.removeAttribute('crossorigin');
    audio.src = track.url;
    audio.load();
    updateSession();
    emit('track', track);
    if (autoplay !== false) play();
    else emit('time');
  }

  function play() {
    if (!state.current || (!state.current.url && !isYouTube(state.current))) {
      emit('blocked', { track: state.current });
      return;
    }
    if (isYouTube(state.current)) {
      if (!window.YouTube) {
        emit('play-error', new Error('YouTube недоступен'));
        return;
      }
      YouTube.play().catch((error) => {
        emit('play-error', error);
      });
      return;
    }
    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    const promise = audio.play();
    if (promise && promise.catch) {
      promise.catch((err) => {
        if (!err || err.name === 'AbortError') return;
        if (err.name === 'NotAllowedError') emit('needs-gesture', err);
        else emit('play-error', err);
      });
    }
  }

  function pause() {
    if (ytMode) {
      if (window.YouTube) YouTube.pause();
      return;
    }
    if (!audio) return;
    audio.pause();
  }

  function toggle() {
    if (!state.current) return;
    if (ytMode) {
      if (state.playing) pause();
      else play();
      return;
    }
    if (audio.paused) play();
    else pause();
  }

  function seek(seconds) {
    if (!isFinite(seconds)) return;
    if (ytMode) {
      const max = (window.YouTube ? YouTube.duration() : 0) || state.duration || 0;
      const value = U.clamp(seconds, 0, max || 0);
      if (window.YouTube) YouTube.seek(value);
      state.position = value;
      emitTime();
      return;
    }
    if (!audio) return;
    const max = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : state.duration;
    const value = U.clamp(seconds, 0, max || 0);
    try { audio.currentTime = value; } catch (e) { /* ещё не загружено */ }
    state.position = value;
    emitTime();
  }

  function setVolume(value) {
    const v = U.clamp(Number(value) || 0, 0, 1);
    state.volume = v;
    state.muted = v === 0 ? state.muted : false;
    if (audio) {
      audio.volume = v;
      if (v > 0) audio.muted = false;
    }
    if (window.YouTube) {
      YouTube.setVolume(v);
      YouTube.setMuted(state.muted);
    }
    Store.set('volume', v);
    if (v > 0) Store.set('muted', false);
    emit('volume');
  }

  function toggleMute() {
    state.muted = !state.muted;
    if (audio) audio.muted = state.muted;
    if (window.YouTube) YouTube.setMuted(state.muted);
    Store.set('muted', state.muted);
    emit('volume');
  }

  function setShuffle(value) {
    state.shuffle = !!value;
    Store.set('shuffle', state.shuffle);
    emit('state');
  }

  function setRepeat(value) {
    state.repeat = ['off', 'all', 'one'].indexOf(value) >= 0 ? value : 'off';
    Store.set('repeat', state.repeat);
    emit('state');
  }

  function cycleRepeat() {
    setRepeat(state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off');
    emit('repeat', state.repeat);
  }

  function setIndex(index, autoplay) {
    if (index < 0 || index >= queue.length) return;
    if (shuffleHistory.length > 60) shuffleHistory.shift();
    if (currentIndex >= 0 && currentIndex !== index) shuffleHistory.push(currentIndex);
    currentIndex = index;
    state.index = index;
    emit('queue');
    emit('index', index);
    loadTrack(queue[index], autoplay !== false);
  }

  function next(auto) {
    if (!queue.length) return;
    if (auto && state.repeat === 'one') {
      seek(0);
      play();
      return;
    }
    let index;
    if (state.shuffle && queue.length > 1) {
      do { index = Math.floor(Math.random() * queue.length); } while (index === currentIndex);
      // не повторяем последние треки, если очередь большая
      if (queue.length > 4) {
        let guard = 0;
        while (shuffleHistory.slice(-3).indexOf(index) >= 0 && guard++ < 12) {
          index = Math.floor(Math.random() * queue.length);
        }
      }
    } else {
      index = currentIndex + 1;
    }
    if (index >= queue.length) {
      if (auto && state.repeat !== 'all') {
        state.playing = false;
        stopTicker();
        emit('state');
        return;
      }
      index = 0;
    }
    setIndex(index, true);
  }

  function prev() {
    if (!queue.length) return;
    const elapsed = ytMode ? (window.YouTube ? YouTube.time() : 0) : (audio ? audio.currentTime : 0);
    if (elapsed > 3) {
      seek(0);
      return;
    }
    if (state.shuffle && shuffleHistory.length) {
      const index = shuffleHistory.pop();
      currentIndex = index;
      state.index = index;
      emit('queue');
      loadTrack(queue[index], true);
      return;
    }
    const index = currentIndex <= 0 ? queue.length - 1 : currentIndex - 1;
    setIndex(index, true);
  }

  function onEnded() {
    if (state.repeat === 'one') {
      seek(0);
      play();
      return;
    }
    next(true);
  }

  function onError() {
    if (ytMode) return;
    if (!audio || !state.current) return;
    const error = audio.error;
    if (error && error.code === 1) return; // прервано сменой трека
    const url = state.current.url;
    if (!corsRetried && isRemote(url) && audio.hasAttribute('crossorigin')) {
      corsRetried = true;
      graphBroken = true;
      rebuildAudio();
      return;
    }
    state.playing = false;
    stopTicker();
    emit('state');
    emit('error', { track: state.current });
  }

  function rebuildAudio() {
    const track = state.current;
    try { audio.pause(); } catch (e) { /* уже остановлен */ }
    try { audio.removeAttribute('src'); audio.load(); } catch (e) { /* пусто */ }
    try { audio.remove(); } catch (e) { /* пусто */ }
    try { if (ctx) ctx.close(); } catch (e) { /* пусто */ }
    ctx = null;
    sourceNode = null;
    analyser = null;
    freqData = null;
    state.graph = false;
    audio = createAudio();
    emit('warn', 'Визуализатор отключён для этого источника');
    if (track) loadTrack(track, true);
  }

  function setQueue(tracks, startIndex, autoplay) {
    const source = (tracks || []).filter(Boolean);
    const target = source[startIndex || 0];
    queue = source.filter((t) => t && t.url);
    let index = 0;
    if (target && target.url) {
      const found = queue.findIndex((t) => t.id === target.id);
      index = found >= 0 ? found : 0;
    }
    state.queueLength = queue.length;
    currentIndex = -1;
    emit('queue');
    if (!queue.length) return;
    setIndex(index, autoplay !== false);
  }

  function addToQueue(track) {
    if (!track || !track.url) return false;
    queue.push(track);
    state.queueLength = queue.length;
    emit('queue');
    return true;
  }

  function enqueueNext(track) {
    if (!track || !track.url) return false;
    const at = currentIndex >= 0 ? currentIndex + 1 : queue.length;
    queue.splice(at, 0, track);
    state.queueLength = queue.length;
    emit('queue');
    return true;
  }

  function removeAt(index) {
    if (index < 0 || index >= queue.length) return;
    const wasCurrent = index === currentIndex;
    queue.splice(index, 1);
    state.queueLength = queue.length;
    if (index < currentIndex) currentIndex--;
    if (!queue.length) {
      currentIndex = -1;
      state.index = -1;
      state.current = null;
      state.playing = false;
      ytMode = false;
      if (window.YouTube) YouTube.stop();
      audio.pause();
      audio.removeAttribute('src');
      emit('queue');
      emit('track', null);
      return;
    }
    if (wasCurrent) {
      currentIndex = Math.min(currentIndex, queue.length - 1);
      emit('queue');
      loadTrack(queue[currentIndex], true);
    } else {
      state.index = currentIndex;
      emit('queue');
    }
  }

  function clearQueue() {
    queue = [];
    currentIndex = -1;
    state.index = -1;
    state.queueLength = 0;
    state.current = null;
    state.playing = false;
    ytMode = false;
    engineToken++;
    if (window.YouTube) YouTube.stop();
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (e) { /* пусто */ }
    emit('queue');
    emit('track', null);
    emit('state');
  }

  function shuffleQueue() {
    if (queue.length < 2) return;
    const current = queue[currentIndex] || null;
    const rest = queue.filter((t) => t !== current);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp;
    }
    queue = current ? [current].concat(rest) : rest;
    currentIndex = current ? 0 : -1;
    state.index = currentIndex;
    state.queueLength = queue.length;
    shuffleHistory.length = 0;
    emit('queue');
  }

  function getQueue() { return queue.slice(); }

  function spectrum() {
    if (!analyser || !freqData) return null;
    try {
      analyser.getByteFrequencyData(freqData);
      return freqData;
    } catch (e) {
      return null;
    }
  }

  function setMediaHandlers() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setActionHandler) return;
    const handlers = {
      play: () => play(),
      pause: () => pause(),
      previoustrack: () => prev(),
      nexttrack: () => next(false),
      seekto: (details) => { if (details && isFinite(details.seekTime)) seek(details.seekTime); }
    };
    Object.keys(handlers).forEach((name) => {
      try { navigator.mediaSession.setActionHandler(name, handlers[name]); } catch (e) { /* не поддерживается */ }
    });
  }

  function init() {
    audio = createAudio();
    bindYouTube();
    setMediaHandlers();
    if (window.YouTube) {
      YouTube.setVolume(state.volume);
      YouTube.setMuted(state.muted);
    }
    emit('state');
  }

  window.Player = {
    init,
    state,
    on,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    toggleMute,
    setShuffle,
    setRepeat,
    cycleRepeat,
    setQueue,
    addToQueue,
    enqueueNext,
    removeAt,
    clearQueue,
    shuffleQueue,
    getQueue,
    spectrum,
    loadTrack
  };
})();
