<?php
/* =========================================================
   FLUX — мост к базе пользователей flux_users.

   Нужен, когда MySQL на хостинге закрыт снаружи: портал (Node.js)
   обращается к этому файлу по HTTP, а тот — к MySQL через mysqli.

   УСТАНОВКА
   1. Залей этот файл на хостинг рядом со старым сайтом.
   2. Впиши доступы к базе (или подключи свой конфиг) и СЕКРЕТНЫЙ КЛЮЧ.
   3. В админке портала: «Пользователи» -> «Источник базы пользователей»
      -> режим «через PHP-мост», адрес = https://сайт/flux_users.php,
      ключ = тот же, что здесь.

   КЛЮЧ ОБЯЗАТЕЛЕН: без него файл не отвечает никому.
   ========================================================= */
declare(strict_types=1);

/* --- доступы к базе --- */
const FLUX_DB_HOST   = 'CHANGE_ME';      // например sql123.ds-host.su
const FLUX_DB_PORT   = 3306;
const FLUX_DB_NAME   = 'CHANGE_ME';      // например if0_12345678_flux
const FLUX_DB_USER   = 'CHANGE_ME';
const FLUX_DB_PASS   = 'CHANGE_ME';
const FLUX_DB_TABLE  = 'flux_users';

/* --- секретный ключ: длинная случайная строка --- */
const FLUX_TOKEN = 'CHANGE_ME_TOKEN';

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

if (($_SERVER['HTTP_X_FLUX_TOKEN'] ?? '') !== FLUX_TOKEN) {
    http_response_code(403);
    echo json_encode(['error' => 'неверный ключ']);
    exit;
}

$raw = file_get_contents('php://input') ?: '';
$in  = json_decode($raw, true);
if (!is_array($in)) { $in = $_GET; }
$action = (string)($in['action'] ?? 'ping');

/* --- соединение --- */
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
try {
    $db = new mysqli(FLUX_DB_HOST, FLUX_DB_USER, FLUX_DB_PASS, FLUX_DB_NAME, (int)FLUX_DB_PORT);
    $db->set_charset('utf8mb4');
} catch (Throwable $e) {
    http_response_code(502);
    echo json_encode(['error' => 'нет связи с базой: ' . $e->getMessage()]);
    exit;
}

function out(array $d): void {
    echo json_encode($d, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

switch ($action) {
    case 'ping':
        $r = $db->query('SELECT VERSION() AS v, DATABASE() AS d');
        $row = $r->fetch_assoc();
        out(['ok' => true, 'info' => ['server' => $row['v'], 'database' => $row['d']]]);
        // no break

    case 'tables':
        $r = $db->query('SHOW TABLES');
        $t = [];
        while ($row = $r->fetch_array(MYSQLI_NUM)) { $t[] = $row[0]; }
        out(['tables' => $t]);
        // no break

    case 'describe':
        $t = preg_replace('/[^A-Za-z0-9_]/', '', (string)($in['table'] ?? FLUX_DB_TABLE));
        $r = $db->query('SHOW COLUMNS FROM `' . $t . '`');
        $cols = [];
        while ($row = $r->fetch_assoc()) {
            $cols[] = [
                'field' => $row['Field'],
                'type'  => $row['Type'],
                'null'  => $row['Null'],
                'key'   => $row['Key'],
                'def'   => $row['Default'],
                'extra' => $row['Extra'],
            ];
        }
        out(['columns' => $cols]);
        // no break

    case 'all':
    case 'one':
        $sql = (string)($in['sql'] ?? '');
        if (!preg_match('/^\s*(SELECT|SHOW)\b/i', $sql)) {
            http_response_code(400);
            out(['error' => 'мост выполняет только SELECT/SHOW']);
        }
        $params = $in['params'] ?? [];
        $st = $db->prepare($sql);
        if (!$st) { http_response_code(400); out(['error' => 'ошибка запроса: ' . $db->error]); }
        if (is_array($params) && $params) {
            $types = '';
            foreach ($params as $p) {
                if (is_int($p))      { $types .= 'i'; }
                elseif (is_float($p)){ $types .= 'd'; }
                else                 { $types .= 's'; }
            }
            $st->bind_param($types, ...$params);
        }
        $st->execute();
        $rows = $st->get_result()->fetch_all(MYSQLI_ASSOC);
        if ($action === 'one') out(['row' => $rows[0] ?? null]);
        out(['rows' => $rows]);
        // no break

    case 'run':
        $sql = (string)($in['sql'] ?? '');
        if (!preg_match('/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i', $sql)) {
            http_response_code(400);
            out(['error' => 'мост выполняет только INSERT/UPDATE/DELETE/REPLACE']);
        }
        $params = $in['params'] ?? [];
        $st = $db->prepare($sql);
        if (!$st) { http_response_code(400); out(['error' => 'ошибка запроса: ' . $db->error]); }
        if (is_array($params) && $params) {
            $types = '';
            foreach ($params as $p) {
                if (is_int($p))      { $types .= 'i'; }
                elseif (is_float($p)){ $types .= 'd'; }
                else                 { $types .= 's'; }
            }
            $st->bind_param($types, ...$params);
        }
        $st->execute();
        out(['insertId' => $db->insert_id, 'affectedRows' => $st->affected_rows]);
        // no break
}

http_response_code(404);
out(['error' => 'неизвестное действие: ' . $action]);
