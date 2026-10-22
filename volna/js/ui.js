/* ==========================================================================
   Волна — разметка всех экранов
   ========================================================================== */
(function () {
  'use strict';

  const GENRES = [
    'Русский рэп', 'Кино', 'The Weeknd', 'Lo-Fi', 'Джаз', 'Рок',
    'Классика', 'Phonk', 'Электроника', 'Инди', 'Хип-хоп', 'Шансон'
  ];

  function artBg(t) {
    const seed = (t && (t.album || t.title || t.artist)) || 'volna';
    const hues = U.hues(seed);
    return '--g1:hsl(' + hues.h1 + ' 70% 52%);--g2:hsl(' + hues.h2 + ' 76% 44%);background:linear-gradient(135deg,var(--g1),var(--g2))';
  }

  function art(t, cls) {
    if (t && t.art) {
      return '<img class="' + (cls || '') + '" src="' + U.esc(t.art) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">';
    }
    const label = U.initials(t && (t.title || t.artist || t.album));
    return '<div class="art-fallback ' + (cls || '') + '">' + U.esc(label) + '</div>';
  }

  function badge(t) {
    if (!t) return '';
    if (t.source === 'local') return '<span class="badge badge--local">файл</span>';
    if (t.source === 'youtube') return '<span class="badge badge--full" title="Полный трек из YouTube">полный</span>';
    if (t.preview) return '<span class="badge badge--preview" title="Сервис отдаёт 30-секундный фрагмент">30 сек</span>';
    return '';
  }

  function trackRow(t, index, opts) {
    opts = opts || {};
    const list = opts.list || 'search';
    const liked = Store.isFavorite(t.id);
    const num = opts.number != null ? opts.number : index + 1;
    return '' +
      '<div class="track" role="button" tabindex="0" data-action="play-track" data-id="' + U.esc(t.id) + '" data-list="' + U.esc(list) + '" aria-label="Включить ' + U.esc(t.title) + ' — ' + U.esc(t.artist) + '">' +
        '<div class="track__idx">' +
          '<span class="track__num">' + num + '</span>' +
          '<span class="track__eq"><i></i><i></i><i></i></span>' +
        '</div>' +
        '<div class="track__art" style="' + artBg(t) + '">' + art(t) + '</div>' +
        '<div class="track__main">' +
          '<div class="track__title"><span class="track__name">' + U.esc(t.title) + '</span>' + badge(t) +
            (t.explicit ? '<span class="badge">18+</span>' : '') +
          '</div>' +
          '<div class="track__artist"><span class="track__artist-link" data-action="open-artist" data-artist="' + U.esc(t.artist) + '">' + U.esc(t.artist) + '</span></div>' +
        '</div>' +
        '<div class="track__album">' + U.esc(t.album || '—') + '</div>' +
        '<div class="track__time">' + (t.duration ? U.fmtTime(t.duration) : '—') + '</div>' +
        '<div class="track__actions">' +
          '<button class="icon-btn" type="button" data-action="queue-add" data-id="' + U.esc(t.id) + '" title="Добавить в очередь" aria-label="Добавить в очередь">' + U.icon('plus') + '</button>' +
          '<button class="icon-btn like ' + (liked ? 'is-liked' : '') + '" type="button" data-action="like" data-id="' + U.esc(t.id) + '" title="' + (liked ? 'Убрать из избранного' : 'В избранное') + '" aria-label="' + (liked ? 'Убрать из избранного' : 'В избранное') + '" aria-pressed="' + liked + '">' + U.icon('heart') + '</button>' +
          (t.source === 'local' && list === 'local'
            ? '<button class="icon-btn" type="button" data-action="local-delete" data-id="' + U.esc(t.id) + '" title="Удалить из фонотеки" aria-label="Удалить из фонотеки">' + U.icon('trash') + '</button>'
            : '') +
        '</div>' +
      '</div>';
  }

  function trackList(tracks, opts) {
    opts = opts || {};
    if (!tracks || !tracks.length) return '';
    const head = opts.head === false ? '' :
      '<div class="tracks__head"><span>#</span><span></span><span>Трек</span><span>Альбом</span><span>Время</span><span></span></div>';
    const rows = tracks.map((t, i) => trackRow(t, i, Object.assign({}, opts, {
      number: opts.numbers && t.trackNumber ? t.trackNumber : null
    }))).join('');
    return '<div class="tracks" data-list="' + U.esc(opts.list || 'search') + '">' + head + rows + '</div>';
  }

  function trackCard(t, list) {
    return '<div class="card" role="button" tabindex="0" data-action="play-track" data-id="' + U.esc(t.id) + '" data-list="' + U.esc(list || 'search') + '" aria-label="Включить ' + U.esc(t.title) + '">' +
      '<div class="card__art" style="' + artBg(t) + '">' + art(t) +
        '<span class="card__play">' + U.icon('play') + '</span>' +
      '</div>' +
      '<div class="card__title">' + U.esc(t.title) + '</div>' +
      '<div class="card__sub">' + U.esc(t.artist) + '</div>' +
    '</div>';
  }

  function albumCard(a) {
    const sub = U.esc(a.artist) + (a.year ? ' · ' + U.esc(a.year) : '');
    return '<div class="card" role="button" tabindex="0" data-action="open-album" data-id="' + U.esc(a.id) + '" aria-label="Открыть альбом ' + U.esc(a.title) + '">' +
      '<div class="card__art" style="' + artBg(a) + '">' + art(a) +
        '<span class="card__play" data-action="play-album" data-id="' + U.esc(a.id) + '" title="Играть альбом">' + U.icon('play') + '</span>' +
      '</div>' +
      '<div class="card__title">' + U.esc(a.title) + '</div>' +
      '<div class="card__sub">' + sub + '</div>' +
    '</div>';
  }

  function artistCard(a) {
    return '<div class="card card--artist" role="button" tabindex="0" data-action="open-artist" data-artist="' + U.esc(a.name) + '" aria-label="Открыть исполнителя ' + U.esc(a.name) + '">' +
      '<div class="card__art" style="' + artBg({ artist: a.name, art: a.art }) + '">' + art({ artist: a.name, art: a.art }) +
        '<span class="card__play">' + U.icon('play') + '</span>' +
      '</div>' +
      '<div class="card__title">' + U.esc(a.name) + '</div>' +
      '<div class="card__sub">' + U.fmtTracks(a.count || 0) + '</div>' +
    '</div>';
  }

  function skeletonTracks(n) {
    let rows = '';
    for (let i = 0; i < (n || 6); i++) {
      rows += '<div class="sk-row"><div class="sk-art skeleton"></div><div class="sk-lines"><div class="sk-line skeleton w40"></div><div class="sk-line skeleton w20"></div></div><div class="sk-line skeleton w20"></div></div>';
    }
    return '<div class="tracks">' + rows + '</div>';
  }

  function sectionHead(title, sub, actions) {
    return '<div class="section__head">' +
      '<div><div class="section__title">' + U.esc(title) + '</div>' + (sub ? '<div class="section__sub">' + U.esc(sub) + '</div>' : '') + '</div>' +
      (actions || '') +
    '</div>';
  }

  function playAllButtons(list, label) {
    return '<div class="page-head__actions">' +
      '<button class="btn btn--sm btn--primary" data-action="play-list" data-list="' + U.esc(list) + '">' + U.icon('play') + ' ' + U.esc(label || 'Играть') + '</button>' +
      '<button class="btn btn--sm" data-action="shuffle-list" data-list="' + U.esc(list) + '">' + U.icon('shuffle') + ' Вперемешку</button>' +
    '</div>';
  }

  function emptyBlock(o) {
    o = o || {};
    return '<div class="empty">' +
      '<div class="empty__ico">' + U.icon(o.icon || 'music') + '</div>' +
      '<h3>' + U.esc(o.title || 'Пока пусто') + '</h3>' +
      '<p>' + U.esc(o.text || '') + '</p>' +
      (o.action ? '<button class="btn btn--sm" data-action="' + U.esc(o.action) + '"' + (o.attrs || '') + '>' + U.icon(o.actionIcon || 'plus') + ' ' + U.esc(o.actionLabel || 'Добавить') + '</button>' : '') +
    '</div>';
  }

  function errorBlock(message, retry) {
    return '<div class="error-box">' + U.icon('wifiOff') +
      '<div class="error-box__body"><b>Не удалось получить музыку</b>' + U.esc(message || 'Проверьте подключение к интернету и попробуйте ещё раз.') + '</div>' +
      (retry === false ? '' : '<button class="btn btn--sm" data-action="retry">Повторить</button>') +
    '</div>';
  }

  function homeView(ctx) {
    const favorites = ctx.favorites || [];
    const recent = ctx.recent || [];
    const searches = ctx.searches || [];
    const localCount = ctx.localCount || 0;
    const localSize = ctx.localSize || 0;

    let html = '<div class="page">';

    html += '<section class="hero">' +
      '<div class="hero__content">' +
        '<span class="hero__eyebrow">музыка без лишних кнопок</span>' +
        '<h1>Вся музыка<br>в одном <em>поиске</em></h1>' +
        '<p>Три каталога, полные треки из YouTube, честная очередь, избранное и ваша собственная фонотека. Без регистрации и подписок.</p>' +
        '<div class="hero__actions">' +
          '<button class="btn btn--primary" data-action="open-mix">' + U.icon('sparkles') + ' Волна дня</button>' +
          '<button class="btn btn--ghost" data-action="focus-search">' + U.icon('search') + ' Найти трек</button>' +
        '</div>' +
        '<div class="hero__stats">' +
          '<div class="hero__stat"><b>' + favorites.length + '</b><span>в избранном</span></div>' +
          '<div class="hero__stat"><b>' + localCount + '</b><span>своих файлов</span></div>' +
          '<div class="hero__stat"><b>3</b><span>каталога</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="hero__visual" aria-hidden="true">' +
        '<div class="vinyl"><span class="vinyl__label"></span></div>' +
        '<div class="hero-card">' +
          '<div class="hero-card__art"></div>' +
          '<div class="hero-card__meta"><b>Волна дня</b><span>подборка уже готова</span></div>' +
          '<div class="eq"><i></i><i></i><i></i><i></i></div>' +
        '</div>' +
      '</div>' +
    '</section>';

    html += '<div class="chips">' + GENRES.map((g) =>
      '<button class="chip" data-action="quick-search" data-q="' + U.esc(g) + '">' + U.esc(g) + '</button>'
    ).join('') + '</div>';

    if (searches.length) {
      html += '<section class="section">' + sectionHead('Вы искали', '', '<button class="section__link" data-action="clear-searches">Очистить</button>') +
        '<div class="chips" style="margin-top:0">' + searches.slice(0, 8).map((q) =>
          '<button class="chip" data-action="quick-search" data-q="' + U.esc(q) + '">' + U.icon('clock', '') + U.esc(q) + '</button>'
        ).join('') + '</div></section>';
    }

    if (recent.length) {
      html += '<section class="section">' +
        sectionHead('Недавно слушали', 'Продолжите с того же места', '<button class="section__link" data-action="go" data-href="#/history">Вся история</button>') +
        '<div class="grid-cards">' + recent.slice(0, 6).map((t) => trackCard(t, 'recent')).join('') + '</div>' +
      '</section>';
    }

    if (favorites.length) {
      html += '<section class="section">' +
        sectionHead('Избранное', U.fmtTracks(favorites.length), '<button class="section__link" data-action="go" data-href="#/favorites">Показать все</button>') +
        '<div class="grid-cards">' + favorites.slice(0, 6).map((t) => trackCard(t, 'favorites')).join('') + '</div>' +
      '</section>';
    } else {
      html += '<section class="section">' +
        sectionHead('Избранное', 'Треки, к которым хочется вернуться') +
        emptyBlock({
          icon: 'heart',
          title: 'Здесь будет ваша музыка',
          text: 'Нажмите на сердечко рядом с треком — и он останется в избранном, даже если закрыть браузер.',
          action: 'focus-search', actionLabel: 'Найти музыку', actionIcon: 'search'
        }) +
      '</section>';
    }

    html += '<section class="section">' +
      '<div class="dropzone" data-action="pick-files" role="button" tabindex="0">' +
        '<div class="dropzone__ico">' + U.icon('upload') + '</div>' +
        '<b>Своя музыка — тоже музыка</b>' +
        '<span>Перетащите файлы в окно или нажмите, чтобы выбрать. Теги и обложки читаются автоматически.</span>' +
        '<span class="dropzone__formats">' + (localCount
          ? U.fmtTracks(localCount) + ' · ' + U.fmtSize(localSize)
          : 'MP3 · FLAC · M4A · OGG · WAV — хранятся только в вашем браузере') + '</span>' +
      '</div>' +
    '</section>';

    html += '<p class="page-foot">Полные треки — YouTube и «Мои файлы». iTunes и Deezer дают 30-секундные превью.</p>';
    html += '</div>';
    return html;
  }

  function searchView(d) {
    const query = d.query || '';
    let filter = d.filter || 'all';
    const results = d.results || { tracks: [], albums: [], artists: [] };
    const local = d.local || [];
    const tracks = local.concat(results.tracks || []);
    const albums = results.albums || [];
    const artists = results.artists || [];
    if (filter === 'albums' && !albums.length) filter = 'all';
    if (filter === 'artists' && !artists.length) filter = 'all';
    const sourceLabel = d.source === 'youtube' ? 'YouTube — полные треки'
      : d.source === 'itunes' ? 'iTunes'
      : d.source === 'deezer' ? 'Deezer'
      : 'YouTube + iTunes + Deezer';

    let html = '<div class="page">';
    html += '<div class="page-head">' +
      '<div class="eyebrow">поиск · ' + U.esc(sourceLabel) + '</div>' +
      '<div class="page-head__row">' +
        '<div><h1>«' + U.esc(query) + '»</h1>' +
          '<div class="page-head__meta">' +
            (d.loading ? '<span class="loading-inline"><span class="spinner"></span> Ищем в каталогах…</span>' :
              (tracks.length ? U.fmtTracks(tracks.length) + (albums.length ? ' · ' + U.fmtAlbums(albums.length) : '') : 'Ничего не найдено')) +
          '</div>' +
        '</div>' +
        (tracks.length ? playAllButtons('search') : '') +
      '</div>' +
    '</div>';

    html += '<div class="filters">' +
      filterChip('all', 'Всё', filter, tracks.length + albums.length + artists.length) +
      filterChip('tracks', 'Треки', filter, tracks.length) +
      (albums.length ? filterChip('albums', 'Альбомы', filter, albums.length) : '') +
      (artists.length ? filterChip('artists', 'Исполнители', filter, artists.length) : '') +
    '</div>';

    if (d.error) html += '<div style="margin-bottom:18px">' + errorBlock(d.error) + '</div>';

    if (d.loading) {
      html += '<div class="section">' + sectionHead('Треки', '') + skeletonTracks(7) + '</div>';
      html += '<p class="page-foot">Обычно поиск занимает меньше секунды.</p></div>';
      return html;
    }

    const showTracks = filter === 'all' || filter === 'tracks';
    const showAlbums = (filter === 'all' || filter === 'albums') && albums.length;
    const showArtists = (filter === 'all' || filter === 'artists') && artists.length;

    if (showTracks && tracks.length) {
      const localCount = local.length;
      html += '<section class="section">' +
        sectionHead('Треки', localCount ? localCount + ' ' + U.plural(localCount, ['совпадение', 'совпадения', 'совпадений']) + ' в ваших файлах' : 'Нажмите на строку, чтобы включить') +
        trackList(tracks, { list: 'search' }) +
      '</section>';
    }

    if (showAlbums) {
      html += '<section class="section">' +
        sectionHead('Альбомы', U.fmtAlbums(albums.length)) +
        '<div class="row-scroll">' + albums.map(albumCard).join('') + '</div>' +
      '</section>';
    }

    if (showArtists) {
      html += '<section class="section">' +
        sectionHead('Исполнители', 'Собранные из результатов поиска') +
        '<div class="row-scroll">' + artists.map(artistCard).join('') + '</div>' +
      '</section>';
    }

    if (!tracks.length && !albums.length) {
      html += emptyBlock({
        icon: 'search',
        title: 'Ничего не нашлось',
        text: 'Проверьте написание, попробуйте другой язык запроса или переключите источник вверху. Можно искать по названию, исполнителю и альбому.',
        action: 'focus-search', actionLabel: 'Изменить запрос', actionIcon: 'search'
      });
    }

    html += '<p class="page-foot">' + (d.source === 'youtube'
      ? 'Полные треки играют через встроенный плеер YouTube. Свои файлы тоже звучат целиком.'
      : 'Полные треки приходят из YouTube и «Моих файлов». iTunes и Deezer отдают 30-секундные превью.') + '</p>';
    html += '</div>';
    return html;
  }

  function filterChip(value, label, active, count) {
    return '<button class="chip ' + (active === value ? 'is-active' : '') + '" data-action="search-filter" data-filter="' + value + '">' +
      U.esc(label) + (count != null ? '<span>' + count + '</span>' : '') + '</button>';
  }

  function favoritesView(d) {
    const tracks = d.tracks || [];
    let html = '<div class="page"><div class="page-head">' +
      '<div class="eyebrow">коллекция</div>' +
      '<div class="page-head__row"><div><h1>Избранное</h1>' +
        '<div class="page-head__meta">' + (tracks.length ? U.fmtTracks(tracks.length) : 'Пока ни одного трека') + '</div>' +
      '</div>' + (tracks.length ? playAllButtons('favorites') : '') + '</div>' +
    '</div>';

    if (tracks.length) {
      html += trackList(tracks, { list: 'favorites' });
    } else {
      html += emptyBlock({
        icon: 'heart',
        title: 'Сердечко — и трек здесь',
        text: 'Избранное хранится в браузере. Добавляйте музыку из поиска или из своей фонотеки.',
        action: 'focus-search', actionLabel: 'Найти музыку', actionIcon: 'search'
      });
    }
    html += '</div>';
    return html;
  }

  function historyView(d) {
    const tracks = d.tracks || [];
    let html = '<div class="page"><div class="page-head">' +
      '<div class="eyebrow">история</div>' +
      '<div class="page-head__row"><div><h1>Недавние</h1>' +
        '<div class="page-head__meta">' + (tracks.length ? U.fmtTracks(tracks.length) + ' · последние прослушивания' : 'Вы ещё ничего не включали') + '</div>' +
      '</div>' +
      '<div class="page-head__actions">' +
        (tracks.length ? '<button class="btn btn--sm btn--primary" data-action="play-list" data-list="history">' + U.icon('play') + ' Играть</button>' +
          '<button class="btn btn--sm btn--danger" data-action="clear-history">' + U.icon('trash') + ' Очистить</button>' : '') +
      '</div>' +
      '</div></div>';

    if (tracks.length) {
      html += trackList(tracks, { list: 'history' });
    } else {
      html += emptyBlock({
        icon: 'clock',
        title: 'История пуста',
        text: 'Включите любой трек — он появится здесь, чтобы можно было быстро вернуться.',
        action: 'focus-search', actionLabel: 'Найти музыку', actionIcon: 'search'
      });
    }
    html += '</div>';
    return html;
  }

  function filesView(d) {
    const tracks = d.tracks || [];
    const count = tracks.length;
    const totalSize = d.totalSize || 0;
    let html = '<div class="page"><div class="page-head">' +
      '<div class="eyebrow">локальная фонотека</div>' +
      '<div class="page-head__row"><div><h1>Мои файлы</h1>' +
        '<div class="page-head__meta">' + (count
          ? U.fmtTracks(count) + ' · ' + U.fmtSize(totalSize) + ' · ' + (d.persistent ? 'сохраняются в браузере' : 'только в памяти')
          : 'MP3, FLAC, M4A, OGG, WAV') + '</div>' +
      '</div>' +
      '<div class="page-head__actions">' +
        (count ? '<button class="btn btn--sm btn--primary" data-action="play-list" data-list="local">' + U.icon('play') + ' Играть всё</button>' +
          '<button class="btn btn--sm" data-action="pick-files">' + U.icon('plus') + ' Добавить</button>' +
          '<button class="btn btn--sm btn--danger" data-action="clear-files">' + U.icon('trash') + '</button>' : '') +
      '</div>' +
      '</div></div>';

    if (!d.persistent) {
      html += '<div class="error-box" style="margin-bottom:18px">' + U.icon('info') +
        '<div class="error-box__body"><b>Файлы не сохранятся после перезагрузки</b>' +
        'Браузер ограничил локальное хранилище. Запустите сайт через «Запустить.bat» — тогда фонотека будет сохраняться.</div></div>';
    }

    html += '<div class="dropzone" data-action="pick-files" role="button" tabindex="0">' +
      '<div class="dropzone__ico">' + U.icon('upload') + '</div>' +
      '<b>' + (count ? 'Добавить ещё музыку' : 'Перетащите музыку сюда') + '</b>' +
      '<span>Файлы не загружаются в интернет — они лежат в вашем браузере. Теги и обложки читаются из ID3.</span>' +
      '<span class="dropzone__formats">MP3 · FLAC · M4A · AAC · OGG · OPUS · WAV</span>' +
    '</div>';

    if (count) {
      html += '<section class="section">' + sectionHead('Фонотека', U.fmtSize(totalSize)) +
        trackList(tracks, { list: 'local' }) + '</section>';
    } else {
      html += '<div class="section">' + emptyBlock({
        icon: 'folder',
        title: 'Пока нет своих файлов',
        text: 'Добавьте пару любимых альбомов — они будут доступны мгновенно, даже без интернета.'
      }) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function albumView(d) {
    const album = d.album || {};
    const tracks = d.tracks || [];
    if (d.loading) {
      return '<div class="page"><div class="skeleton" style="height:190px;max-width:640px;margin-bottom:24px"></div>' + skeletonTracks(8) + '</div>';
    }
    if (d.error) {
      return '<div class="page"><div class="page-head"><div class="eyebrow">альбом</div><h1>Не удалось открыть</h1></div>' + errorBlock(d.error) + '</div>';
    }
    const meta = [album.artist, album.year, U.fmtTracks(tracks.length || album.trackCount || 0)].filter(Boolean).join(' · ');
    let html = '<div class="page">' +
      '<div class="hero-entity">' +
        '<div class="hero-entity__art" style="' + artBg(album) + '">' + art(album) + '</div>' +
        '<div class="hero-entity__body">' +
          '<div class="eyebrow">альбом</div>' +
          '<h1>' + U.esc(album.title || 'Альбом') + '</h1>' +
          '<div class="hero-entity__meta">' + U.esc(meta) + '</div>' +
          (tracks.length ? playAllButtons('album') : '') +
        '</div>' +
      '</div>';
    if (tracks.length) {
      html += trackList(tracks, { list: 'album', numbers: true, head: true });
    } else {
      html += emptyBlock({ icon: 'disc', title: 'Треки недоступны', text: 'Сервис не вернул треки этого альбома. Попробуйте открыть его заново.' });
    }
    html += '</div>';
    return html;
  }

  function artistView(d) {
    const tracks = d.tracks || [];
    const first = tracks[0] || {};
    const name = d.name || 'Исполнитель';
    if (d.loading) {
      return '<div class="page"><div class="skeleton" style="height:190px;max-width:640px;margin-bottom:24px"></div>' + skeletonTracks(8) + '</div>';
    }
    if (d.error) {
      return '<div class="page"><div class="page-head"><div class="eyebrow">исполнитель</div><h1>' + U.esc(name) + '</h1></div>' + errorBlock(d.error) + '</div>';
    }
    const artTrack = { artist: name, art: first.art || '' };
    let html = '<div class="page">' +
      '<div class="hero-entity hero-entity--artist">' +
        '<div class="hero-entity__art" style="' + artBg(artTrack) + '">' + art(artTrack) + '</div>' +
        '<div class="hero-entity__body">' +
          '<div class="eyebrow">исполнитель</div>' +
          '<h1>' + U.esc(name) + '</h1>' +
          '<div class="hero-entity__meta">' + (tracks.length ? U.fmtTracks(tracks.length) + ' · лучшее в каталогах' : 'Треки не найдены') + '</div>' +
          (tracks.length ? playAllButtons('artist') : '') +
        '</div>' +
      '</div>';
    if (tracks.length) {
      html += trackList(tracks, { list: 'artist' });
    } else {
      html += emptyBlock({ icon: 'user', title: 'Ничего не нашлось', text: 'Попробуйте найти этого исполнителя через поиск.', action: 'focus-search', actionLabel: 'К поиску', actionIcon: 'search' });
    }
    html += '</div>';
    return html;
  }

  function mixView(d) {
    const tracks = d.tracks || [];
    const dateLabel = d.dateLabel || '';
    let html = '<div class="page"><div class="page-head">' +
      '<div class="eyebrow">подборка · ' + U.esc(dateLabel) + '</div>' +
      '<div class="page-head__row"><div>' +
        '<h1>Волна дня</h1>' +
        '<div class="page-head__meta">' + U.esc(d.seed || '') + ' · ' + (tracks.length ? U.fmtTracks(tracks.length) : 'собираем…') + '</div>' +
      '</div>' + (tracks.length ? playAllButtons('mix', 'Играть подборку') : '') + '</div>' +
    '</div>';

    if (d.loading) {
      html += skeletonTracks(9);
    } else if (d.error) {
      html += errorBlock(d.error);
    } else if (tracks.length) {
      html += trackList(tracks, { list: 'mix' });
      html += '<p class="page-foot">Подборка меняется каждый день. Обновите страницу — и услышите новое.</p>';
    } else {
      html += emptyBlock({ icon: 'sparkles', title: 'Подборка собирается', text: 'Попробуйте обновить страницу через минуту.', action: 'go', attrs: ' data-href="#/mix"', actionLabel: 'Обновить', actionIcon: 'sparkles' });
    }
    html += '</div>';
    return html;
  }

  function notFoundView() {
    return '<div class="page"><div class="page-head"><div class="eyebrow">404</div><h1>Страница уплыла</h1></div>' +
      emptyBlock({ icon: 'music', title: 'Здесь ничего нет', text: 'Возможно, ссылка устарела. Вернитесь на главную и начните поиск.', action: 'go', attrs: ' data-href="#/"', actionLabel: 'На главную', actionIcon: 'arrowLeft' }) +
      '</div>';
  }

  function queueItem(t, index, currentId) {
    return '<div class="q-item ' + (t.id === currentId ? 'is-current' : '') + '" role="button" tabindex="0" data-action="play-queue" data-index="' + index + '">' +
      '<div class="q-item__art" style="' + artBg(t) + '">' + art(t) + '</div>' +
      '<div class="q-item__main">' +
        '<div class="q-item__title">' + U.esc(t.title) + '</div>' +
        '<div class="q-item__artist">' + U.esc(t.artist) + '</div>' +
      '</div>' +
      '<button class="q-item__del" type="button" data-action="queue-remove" data-index="' + index + '" title="Убрать из очереди" aria-label="Убрать из очереди">' + U.icon('x') + '</button>' +
    '</div>';
  }

  window.UI = {
    GENRES,
    art, artBg, badge,
    trackRow, trackList, trackCard,
    albumCard, artistCard,
    skeletonTracks, sectionHead, playAllButtons,
    emptyBlock, errorBlock,
    homeView, searchView, favoritesView, historyView, filesView,
    albumView, artistView, mixView, notFoundView,
    queueItem
  };
})();
