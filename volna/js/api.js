/* ==========================================================================
   Волна — поиск музыки: iTunes Search API + Deezer API
   ========================================================================== */
(function () {
  'use strict';

  const ITUNES = 'https://itunes.apple.com';
  const DEEZER = 'https://api.deezer.com';
  const TIMEOUT = 13000;

  let jsonpSeq = 0;

  function jsonp(url, timeout) {
    timeout = timeout || TIMEOUT;
    return new Promise((resolve, reject) => {
      const name = '__volna_jsonp_' + Date.now().toString(36) + '_' + (++jsonpSeq);
      const script = document.createElement('script');
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error('Превышено время ожидания'));
      }, timeout);

      function cleanup() {
        clearTimeout(timer);
        script.remove();
        try { delete window[name]; } catch (e) { window[name] = undefined; }
      }

      window[name] = (payload) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(payload);
      };
      script.onerror = () => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error('Не удалось загрузить ответ'));
      };
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + name;
      document.head.appendChild(script);
    });
  }

  async function fetchJSON(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctrl.signal, mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function once(fn) {
    let called = false;
    return function () {
      if (called) return undefined;
      called = true;
      return fn.apply(this, arguments);
    };
  }

  async function itunesGet(path, params) {
    const url = ITUNES + path + '?' + new URLSearchParams(params).toString();
    try {
      return await fetchJSON(url);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('iTunes не ответил вовремя');
      return jsonp(url);
    }
  }

  function upgradeArt(url) {
    if (!url) return '';
    return String(url).replace(/\/\d+x\d+bb\.(jpg|png)$/i, '/600x600bb.$1');
  }

  function mapItunesTrack(r) {
    if (!r || !r.trackId) return null;
    const preview = r.previewUrl || '';
    return {
      id: 'itunes:' + r.trackId,
      source: 'itunes',
      title: r.trackName || 'Без названия',
      artist: r.artistName || 'Неизвестный исполнитель',
      album: r.collectionName || '',
      duration: Math.round((r.trackTimeMillis || 0) / 1000),
      art: upgradeArt(r.artworkUrl100),
      url: preview,
      preview: !!preview,
      albumId: r.collectionId ? 'itunes:' + r.collectionId : '',
      artistId: r.artistId ? 'itunes:' + r.artistId : '',
      year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : '',
      trackNumber: r.trackNumber || 0,
      discNumber: r.discNumber || 0,
      explicit: r.trackExplicitness === 'explicit'
    };
  }

  function mapDeezerTrack(r) {
    if (!r || !r.id) return null;
    const preview = r.preview || '';
    return {
      id: 'deezer:' + r.id,
      source: 'deezer',
      title: r.title || r.title_short || 'Без названия',
      artist: (r.artist && r.artist.name) || 'Неизвестный исполнитель',
      album: (r.album && r.album.title) || '',
      duration: Math.round(r.duration || 0),
      art: (r.album && (r.album.cover_big || r.album.cover_medium || r.album.cover)) || '',
      url: preview,
      preview: !!preview,
      albumId: r.album && r.album.id ? 'deezer:' + r.album.id : '',
      artistId: r.artist && r.artist.id ? 'deezer:' + r.artist.id : '',
      year: r.release_date ? String(r.release_date).slice(0, 4) : '',
      explicit: !!r.explicit_lyrics
    };
  }

  function mapItunesAlbum(r) {
    if (!r || !r.collectionId) return null;
    return {
      id: 'itunes:' + r.collectionId,
      source: 'itunes',
      title: r.collectionName || 'Без названия',
      artist: r.artistName || '',
      art: upgradeArt(r.artworkUrl100),
      trackCount: r.trackCount || 0,
      year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : ''
    };
  }

  function mapDeezerAlbum(r) {
    if (!r || !r.id) return null;
    return {
      id: 'deezer:' + r.id,
      source: 'deezer',
      title: r.title || 'Без названия',
      artist: (r.artist && r.artist.name) || '',
      art: r.cover_big || r.cover_medium || r.cover || '',
      trackCount: r.nb_tracks || 0,
      year: r.release_date ? String(r.release_date).slice(0, 4) : ''
    };
  }

  function trackKey(t) {
    const title = U.norm(t.title)
      .replace(/\b(?:19|20)\d{2}\b/g, ' ')
      .replace(/\b(feat|ft|featuring|remaster(ed)?|version|edit|mix)\b.*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return title + '|' + U.norm(t.artist);
  }

  function relevance(t, query, position) {
    const q = U.norm(query);
    const title = U.norm(t.title);
    const artist = U.norm(t.artist);
    let score = 0;
    if (title === q) score += 120;
    else if (title.indexOf(q) === 0) score += 70;
    else if (title.indexOf(q) >= 0) score += 46;
    if (artist === q) score += 145;
    else if (artist.indexOf(q) >= 0) score += 38;
    q.split(' ').forEach((word) => {
      if (word.length < 2) return;
      if (title.indexOf(word) >= 0) score += 9;
      if (artist.indexOf(word) >= 0) score += 11;
    });
    if (t.url) score += 8;
    if (t.art) score += 3;
    if (t.full) score += 45;
    score += Math.max(0, 24 - position) * 0.7;
    return score;
  }

  function mergeTracks(lists, query) {
    const seen = new Map();
    lists.forEach((list, listIndex) => {
      (list || []).forEach((t, i) => {
        if (!t) return;
        const key = trackKey(t);
        const scored = Object.assign({}, t, { _score: relevance(t, query, i) + (listIndex === 0 ? 1.5 : 0) });
        const prev = seen.get(key);
        if (!prev) {
          seen.set(key, scored);
          return;
        }
        // Дубликат из другого сервиса: оставляем более релевантный,
        // но подтягиваем недостающие данные.
        if (scored._score > prev._score) {
          scored.art = scored.art || prev.art;
          scored.url = scored.url || prev.url;
          seen.set(key, scored);
        } else {
          prev.art = prev.art || scored.art;
          prev.url = prev.url || scored.url;
        }
      });
    });
    return Array.from(seen.values())
      .sort((a, b) => b._score - a._score)
      .slice(0, 60)
      .map((t) => { delete t._score; return t; });
  }

  function mergeAlbums(lists) {
    const seen = new Map();
    lists.forEach((list) => {
      (list || []).forEach((a) => {
        if (!a) return;
        const key = U.norm(a.title) + '|' + U.norm(a.artist);
        const prev = seen.get(key);
        if (!prev) {
          seen.set(key, a);
        } else {
          if ((a.trackCount || 0) > (prev.trackCount || 0)) prev.trackCount = a.trackCount;
          if (!prev.art && a.art) prev.art = a.art;
        }
      });
    });
    return Array.from(seen.values()).slice(0, 14);
  }

  function deriveArtists(tracks, limit) {
    const map = new Map();
    (tracks || []).forEach((t) => {
      let name = String(t.artist || '').split(/\s+(?:feat\.?|ft\.?|featuring|&|,|vs\.?)\s+/i)[0].trim();
      if (!name) return;
      const key = U.norm(name);
      if (!key) return;
      const cur = map.get(key);
      if (cur) {
        cur.count++;
        if (!cur.art && t.art) cur.art = t.art;
      } else {
        map.set(key, { name, art: t.art || '', count: 1 });
      }
    });
    return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, limit || 12);
  }

  async function itunesSearch(q) {
    const base = { term: q, media: 'music', limit: 40, country: 'RU' };
    const [songsRes, albumsRes] = await Promise.allSettled([
      itunesGet('/search', Object.assign({}, base, { entity: 'song' })),
      itunesGet('/search', Object.assign({}, base, { entity: 'album', limit: 14 }))
    ]);

    let songs = songsRes.status === 'fulfilled' && songsRes.value ? songsRes.value.results : [];
    let albums = albumsRes.status === 'fulfilled' && albumsRes.value ? albumsRes.value.results : [];

    // В российском каталоге иногда нет исполнителя — пробуем мировой.
    if (!songs.length) {
      try {
        const fallback = await itunesGet('/search', Object.assign({}, base, { entity: 'song', country: 'US' }));
        songs = (fallback && fallback.results) || [];
      } catch (e) { /* ничего страшного */ }
    }
    if (!albums.length) {
      try {
        const fallback = await itunesGet('/search', Object.assign({}, base, { entity: 'album', country: 'US', limit: 14 }));
        albums = (fallback && fallback.results) || [];
      } catch (e) { /* ничего страшного */ }
    }

    return {
      source: 'itunes',
      tracks: (songs || []).map(mapItunesTrack).filter(Boolean),
      albums: (albums || []).map(mapItunesAlbum).filter(Boolean)
    };
  }

  async function deezerSearch(q) {
    const params = new URLSearchParams({ q: q, limit: '40' });
    const albumParams = new URLSearchParams({ q: q, limit: '14' });
    const [tracksRes, albumsRes] = await Promise.allSettled([
      jsonp(DEEZER + '/search?' + params.toString() + '&output=jsonp'),
      jsonp(DEEZER + '/search/album?' + albumParams.toString() + '&output=jsonp')
    ]);
    if (tracksRes.status === 'rejected' && albumsRes.status === 'rejected') {
      throw tracksRes.reason || new Error('Deezer недоступен');
    }
    const tracks = tracksRes.status === 'fulfilled' && tracksRes.value ? tracksRes.value.data : [];
    const albums = albumsRes.status === 'fulfilled' && albumsRes.value ? albumsRes.value.data : [];
    return {
      source: 'deezer',
      tracks: (tracks || []).map(mapDeezerTrack).filter(Boolean),
      albums: (albums || []).map(mapDeezerAlbum).filter(Boolean)
    };
  }

  async function youtubeSearch(q) {
    if (!window.YouTube || !window.YouTube.search) throw new Error('YouTube недоступен');
    const tracks = await window.YouTube.search(q, 40);
    return { source: 'youtube', tracks: tracks, albums: [] };
  }

  const cache = new Map();
  const CACHE_TTL = 5 * 60 * 1000;

  async function search(query, source) {
    const q = String(query || '').trim();
    source = source || 'all';
    if (!q) return { tracks: [], albums: [], artists: [], errors: [], query: q };
    const key = source + '|' + q.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

    const jobs = [];
    if (source === 'youtube') {
      jobs.push(youtubeSearch(q));
    } else {
      if (source !== 'deezer') jobs.push(itunesSearch(q));
      if (source !== 'itunes') jobs.push(deezerSearch(q));
      if (source === 'all') {
        // YouTube — источник полных треков. Если локальный прокси не запущен,
        // молча продолжаем с превью, чтобы поиск не ломался.
        jobs.push(youtubeSearch(q).catch(() => ({ source: 'youtube', tracks: [], albums: [] })));
      }
    }

    const settled = await Promise.allSettled(jobs);
    const errors = [];
    const trackLists = [];
    const albumLists = [];

    settled.forEach((result) => {
      if (result.status === 'fulfilled') {
        trackLists.push(result.value.tracks);
        albumLists.push(result.value.albums);
      } else {
        const reason = result.reason;
        errors.push({
          message: reason && reason.message ? reason.message : 'Сервис недоступен',
          source: source
        });
      }
    });

    const tracks = mergeTracks(trackLists, q);
    const albums = mergeAlbums(albumLists);
    const value = { tracks, albums, artists: deriveArtists(tracks, 12), errors, query: q };
    if (!errors.length) {
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 60) {
        const first = cache.keys().next().value;
        cache.delete(first);
      }
    }
    return value;
  }

  async function fullVersions(tracks, query) {
    if (!window.YouTube || !window.YouTube.search || !tracks.length) return tracks;
    let found = [];
    try {
      found = await window.YouTube.search(query, 24);
    } catch (e) {
      return tracks;
    }
    if (!found.length) return tracks;
    return tracks.map((track) => {
      const title = U.norm(track.title).replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
      const artist = U.norm(track.artist);
      const match = found.find((item) => {
        const itemTitle = U.norm(item.title).replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (!itemTitle || itemTitle !== title) return false;
        const itemArtist = U.norm(item.artist);
        return !artist || !itemArtist || itemArtist.indexOf(artist) >= 0 || artist.indexOf(itemArtist) >= 0;
      });
      if (!match) return track;
      return Object.assign({}, match, {
        album: track.album,
        trackNumber: track.trackNumber,
        art: track.art || match.art,
        duration: match.duration || track.duration,
        explicit: track.explicit
      });
    });
  }

  async function getAlbum(id, source) {
    if (!id) throw new Error('Альбом не указан');
    if (id.indexOf('itunes:') === 0) {
      const num = id.slice(7);
      const data = await itunesGet('/lookup', { id: num, entity: 'song', limit: 60, country: 'RU' });
      const results = (data && data.results) || [];
      const collection = results.find((r) => r.wrapperType === 'collection') || results[0] || {};
      let tracks = results.map(mapItunesTrack).filter(Boolean);
      const album = mapItunesAlbum(collection) || {
        id: id, source: 'itunes', title: 'Альбом', artist: '', art: (tracks[0] && tracks[0].art) || '', trackCount: tracks.length, year: ''
      };
      if (source === 'all') {
        tracks = await fullVersions(tracks, (album.artist + ' ' + album.title).trim());
      }
      return { album, tracks };
    }
    if (id.indexOf('deezer:') === 0) {
      const num = id.slice(7);
      const data = await jsonp(DEEZER + '/album/' + encodeURIComponent(num) + '?output=jsonp');
      const album = mapDeezerAlbum(data) || { id: id, source: 'deezer', title: 'Альбом', artist: '', art: '', trackCount: 0, year: '' };
      let tracks = ((data && data.tracks && data.tracks.data) || []).map(mapDeezerTrack).filter(Boolean);
      if (source === 'all') {
        tracks = await fullVersions(tracks, (album.artist + ' ' + album.title).trim());
      }
      return { album, tracks };
    }
    throw new Error('Неизвестный источник альбома');
  }

  async function artistTracks(name, source) {
    const q = String(name || '').trim();
    if (!q) return { tracks: [], errors: [] };
    const jobs = [];
    if (source === 'youtube') {
      jobs.push(youtubeSearch(q).then((r) => r.tracks));
    } else {
      if (source !== 'deezer') {
        jobs.push(itunesGet('/search', { term: q, media: 'music', entity: 'song', attribute: 'artistTerm', limit: 40, country: 'RU' })
          .then((data) => (data.results || []).map(mapItunesTrack).filter(Boolean)));
      }
      if (source !== 'itunes') {
        jobs.push(jsonp(DEEZER + '/search?' + new URLSearchParams({ q: q, limit: '40' }).toString() + '&output=jsonp')
          .then((data) => ((data && data.data) || []).map(mapDeezerTrack).filter(Boolean)));
      }
      if (source === 'all') {
        jobs.push(youtubeSearch(q).then((r) => r.tracks).catch(() => []));
      }
    }
    const settled = await Promise.allSettled(jobs);
    const lists = [];
    settled.forEach((r) => { if (r.status === 'fulfilled') lists.push(r.value); });
    const merged = mergeTracks(lists, q).sort((a, b) => {
      const aExact = U.norm(a.artist) === U.norm(q) ? 1 : 0;
      const bExact = U.norm(b.artist) === U.norm(q) ? 1 : 0;
      return bExact - aExact;
    });
    return { tracks: merged, errors: [] };
  }

  window.API = {
    search,
    getAlbum,
    artistTracks,
    deriveArtists,
    upgradeArt,
    jsonp
  };
})();
