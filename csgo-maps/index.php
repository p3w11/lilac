<?php
/**
 * CS:GO MAPS — каталог карт.
 *
 * Работает без базы данных: сканирует свою же папку, находит файлы карт
 * (*.bsp, *.bsp.zst) и показывает их списком с поиском.
 *
 * Куда класть файлы: в ту же папку, где лежит этот index.php.
 * На хостинге это htdocs/csgo/maps/ -> http://домен/csgo/maps/
 */

declare(strict_types=1);

/* ================= НАСТРОЙКИ ================= */

/** Какие файлы считать картами */
const MAP_PATTERNS = ['*.bsp', '*.bsp.zst', '*.bsp.bz2'];

/** Сколько файлов максимум показывать (защита от тысяч мусорных файлов) */
const MAPS_LIMIT = 2000;

/** Размер одного «а» на сервере: InfinityFree даёт 5 МБ на файл */
const MAP_SIZE_HINT = '5 МБ';

/* ================= СБОР ФАЙЛОВ ================= */

/**
 * Разбирает имя файла карты.
 * "3083967655_arcanum.bsp" -> workshop id + короткое имя
 */
function parse_map_name(string $file): array
{
    $stem = preg_replace('/\.(zst|bz2)$/i', '', $file) ?? $file;
    $stem = preg_replace('/\.bsp$/i', '', $stem) ?? $stem;

    $workshop = 0;
    if (preg_match('/^(\d{9,12})[_-](.+)$/', $stem, $m) === 1) {
        $workshop = (int)$m[1];
        $stem = $m[2];
    }

    return [
        'file'     => $file,
        'stem'     => $stem,
        'title'    => str_replace('_', ' ', $stem),
        'workshop' => $workshop,
    ];
}

/** Читает map_name.bsp.md5, если Valve положила его рядом */
function read_md5(string $dir, string $file): string
{
    $path = $dir . DIRECTORY_SEPARATOR . $file . '.md5';
    if (!is_file($path) || !is_readable($path)) {
        return '';
    }
    $raw = (string)@file_get_contents($path, false, null, 0, 512);
    return preg_match('/\b[a-f0-9]{32}\b/i', $raw, $m) === 1 ? strtolower($m[0]) : '';
}

/** Все карты в папке, готовые к выводу */
function collect_maps(string $dir): array
{
    $maps = [];

    foreach (MAP_PATTERNS as $pattern) {
        $found = glob($dir . DIRECTORY_SEPARATOR . $pattern, GLOB_NOSORT);
        if ($found === false) {
            continue;
        }
        foreach ($found as $path) {
            $file = basename($path);
            if ($file === '' || $file[0] === '.' || !is_file($path)) {
                continue;
            }
            $info = parse_map_name($file);
            $info['path'] = $path;
            $info['url']  = rawurlencode($file);
            $info['size'] = (int)@filesize($path);
            $info['time'] = (int)@filemtime($path);
            $info['md5']  = read_md5($dir, $file);
            $maps[] = $info;
        }
    }

    usort($maps, static function (array $a, array $b): int {
        return strcasecmp($a['stem'], $b['stem']);
    });

    if (count($maps) > MAPS_LIMIT) {
        $maps = array_slice($maps, 0, MAPS_LIMIT);
    }

    return $maps;
}

/* ================= ФИЛЬТРЫ И СОРТИРОВКА ================= */

function human_size(int $bytes): string
{
    if ($bytes <= 0) {
        return '—';
    }
    $units = ['Б', 'КБ', 'МБ', 'ГБ'];
    $i = 0;
    $v = (float)$bytes;
    while ($v >= 1024 && $i < count($units) - 1) {
        $v /= 1024;
        $i++;
    }
    return ($i === 0 ? (string)$bytes : number_format($v, $v < 10 ? 1 : 0, ',', ' ')) . ' ' . $units[$i];
}

function h(?string $s): string
{
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Регистронезависимое сравнение. На всякий случай без mbstring. */
function lower(string $s): string
{
    return function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s);
}

$dir  = __DIR__;
$maps = collect_maps($dir);

$q = trim((string)($_GET['q'] ?? ''));
$sort = (string)($_GET['sort'] ?? 'name');
if (!in_array($sort, ['name', 'size', 'date'], true)) {
    $sort = 'name';
}

$needle = lower($q);
$shown  = array_values(array_filter($maps, static function (array $m) use ($needle): bool {
    if ($needle === '') {
        return true;
    }
    $haystack = lower($m['title'] . ' ' . $m['stem'] . ' ' . $m['file'] . ' ' . $m['workshop']);
    return str_contains($haystack, $needle);
}));

usort($shown, static function (array $a, array $b) use ($sort): int {
    return match ($sort) {
        'size' => $b['size'] <=> $a['size'],
        'date' => $b['time'] <=> $a['time'],
        default => strcasecmp($a['stem'], $b['stem']),
    };
});

$total_size = 0;
foreach ($maps as $m) {
    $total_size += $m['size'];
}

$sort_links = static function (string $key, string $label) use ($sort, $q): string {
    $arrow = $sort === $key ? ' <span aria-hidden="true">▾</span>' : '';
    return '<a class="sort-chip' . ($sort === $key ? ' active' : '') . '"'
        . ' href="?sort=' . $key . '&amp;q=' . rawurlencode($q) . '">' . $label . $arrow . '</a>';
};

/**
 * Базовый адрес страницы. Нужен, чтобы ссылки на файлы работали
 * и при адресе без слеша в конце (http://домен/csgo/maps).
 */
$script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '/'));
$base   = rtrim(str_replace('/index.php', '', $script), '/');
$base   = $base === '' ? '' : $base;
?>
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="description" content="Каталог карт CS:GO — список карт с поиском и скачиванием напрямую с сервера.">
<title>Карты CS:GO — каталог</title>
<link rel="stylesheet" href="<?= h($base) ?>/assets/style.css">
</head>
<body>

<header class="topbar">
  <div class="wrap topbar-in">
    <a class="brand" href="<?= h($base) ?>/">
      <span class="brand-mark">M</span>
      <span class="brand-text">CS:GO MAPS<small>каталог карт</small></span>
    </a>
    <form class="search" id="searchForm" method="get" action="<?= h($base) ?>/" role="search">
      <input type="search" id="q" name="q" placeholder="Поиск карты: dust2, aim, bhop…" value="<?= h($q) ?>" maxlength="80" autocomplete="off" spellcheck="false">
      <?php if ($sort !== 'name'): ?>
        <input type="hidden" name="sort" value="<?= h($sort) ?>">
      <?php endif; ?>
      <button type="submit" title="Найти">🔍</button>
    </form>
  </div>
</header>

<main class="wrap page">

  <div class="page-head">
    <h1>Карты CS:GO</h1>
    <p class="page-sub">
      Файлы лежат прямо в папке <code>maps</code> на сервере. Скачивание идёт напрямую,
      без ссылок на сторонние хостинги.
    </p>
  </div>

  <section class="stats">
    <div class="stat"><b><?= count($maps) ?></b><span>карт всего</span></div>
    <div class="stat"><b><?= human_size($total_size) ?></b><span>весит всё вместе</span></div>
    <div class="stat"><b><?= count($shown) ?></b><span>по текущему поиску</span></div>
  </section>

  <div class="toolbar">
    <div class="sorts">
      <span class="sorts-label">Сортировка</span>
      <?= $sort_links('name', 'по названию') ?>
      <?= $sort_links('size', 'по размеру') ?>
      <?= $sort_links('date', 'по дате') ?>
    </div>
    <p class="hint">Фильтр работает сразу при вводе, Enter не нужен.</p>
  </div>

<?php if ($maps === []): ?>
  <section class="empty">
    <h2>Карт пока нет</h2>
    <p>Скопируй в эту папку файлы <code>.bsp</code> (или <code>.bsp.zst</code>) и обнови страницу.</p>
    <p class="muted small">На хостинге это папка <code>htdocs/csgo/maps/</code>. Локально — папка проекта.</p>
  </section>
<?php elseif ($shown === []): ?>
  <section class="empty">
    <h2>Ничего не нашлось</h2>
    <p>По запросу «<?= h($q) ?>» карт нет. Попробуй часть имени без префикса.</p>
  </section>
<?php else: ?>
  <ul class="maps" id="maps">
    <?php foreach ($shown as $m): ?>
      <li class="map"
          data-search="<?= h(lower($m['title'] . ' ' . $m['stem'] . ' ' . $m['file'] . ' ' . $m['workshop'])) ?>">
        <div class="map-main">
          <a class="map-name" href="<?= h($base . '/' . $m['url']) ?>" download><?= h($m['title']) ?></a>
          <code class="map-file"><?= h($m['file']) ?></code>
        </div>
        <div class="map-meta">
          <span title="Размер"><?= h(human_size($m['size'])) ?></span>
          <span title="Дата изменения"><?= h(date('d.m.Y', $m['time'])) ?></span>
          <?php if ($m['md5'] !== ''): ?>
            <span class="md5" title="MD5 из файла <?= h($m['file']) ?>.md5"><code><?= h($m['md5']) ?></code></span>
          <?php endif; ?>
        </div>
        <div class="map-actions">
          <button type="button" class="btn btn-ghost btn-sm copy" data-cmd="map <?= h($m['stem']) ?>">map <?= h($m['stem']) ?></button>
          <a class="btn btn-primary btn-sm" href="<?= h($base . '/' . $m['url']) ?>" download>Скачать</a>
          <?php if ($m['workshop'] > 0): ?>
            <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener"
               href="https://steamcommunity.com/sharedfiles/filedetails/?id=<?= (int)$m['workshop'] ?>">Workshop</a>
          <?php endif; ?>
        </div>
      </li>
    <?php endforeach; ?>
  </ul>

  <p class="empty-filter" id="emptyFilter" hidden>Ничего не нашлось по этому запросу.</p>
<?php endif; ?>

  <section class="help">
    <h2>Как закинуть карты</h2>
    <ol>
      <li>Скопируй файлы <code>.bsp</code> в папку проекта (или <code>htdocs/csgo/maps/</code> на хостинге).</li>
      <li>Обнови эту страницу — карты появятся сами, база не нужна.</li>
      <li>Удалил файл — он сразу пропадёт из списка.</li>
    </ol>
    <p class="muted small">
      Ограничение хостинга на файл: <?= h(MAP_SIZE_HINT) ?>. Если карта не грузится —
      скорее всего она весит больше. Файлы вида <code>*.bsp.zst</code> каталог тоже видит.
    </p>
  </section>

</main>

<footer class="footer">
  <div class="wrap footer-in">
    <p>CS:GO MAPS — простой каталог карт. Не связан с Valve и Steam.</p>
  </div>
</footer>

<script src="<?= h($base) ?>/assets/app.js" defer></script>
</body>
</html>