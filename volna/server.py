#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Волна — локальный сервер.

Отдаёт файлы сайта и проксирует поиск YouTube, чтобы браузеру не мешал CORS.
Никакие треки не скачиваются: воспроизведение идёт через официальный
встроенный плеер YouTube.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT") or os.environ.get("VOLNA_PORT") or "8787")
HOST = os.environ.get("VOLNA_HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
DB_PATH = os.environ.get("VOLNA_DB") or os.path.join(ROOT, "data", "volna.db")
YOUTUBE_API_KEY = (os.environ.get("YOUTUBE_API_KEY") or "").strip()
YT_SEARCH = "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%253D%253D"
YTM_SEARCH = "https://music.youtube.com/search?q={}&sp=EgWKAQIIAWoSEAUQCRAOEAMQChAEEBAQERAV"
YT_API_SEARCH = "https://www.googleapis.com/youtube/v3/search"
YT_API_VIDEOS = "https://www.googleapis.com/youtube/v3/videos"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
OEMBED_CACHE = {}
SESSION_COOKIE = "volna_session"
SESSION_TTL = 30 * 24 * 60 * 60
PBKDF2_ITERATIONS = 260000
AUTH_HITS = {}
AUTH_LOCK = threading.Lock()


def db_connect():
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db():
    directory = os.path.dirname(os.path.abspath(DB_PATH))
    if directory:
        os.makedirs(directory, exist_ok=True)
    connection = db_connect()
    try:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS user_data (
                user_id INTEGER PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
            """
        )
        connection.commit()
    finally:
        connection.close()


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256$%d$%s$%s" % (
        PBKDF2_ITERATIONS,
        salt.hex(),
        digest.hex(),
    )


def verify_password(password, stored):
    try:
        algorithm, iterations, salt_hex, digest_hex = str(stored).split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, int(iterations)
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(connection, user_id):
    now = int(time.time())
    token = secrets.token_urlsafe(32)
    connection.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    connection.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token_hash(token), user_id, now, now + SESSION_TTL),
    )
    return token


def session_token(handler):
    try:
        cookie = SimpleCookie(handler.headers.get("Cookie", ""))
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else ""
    except Exception:
        return ""


def session_user(handler):
    token = session_token(handler)
    if not token:
        return None
    connection = db_connect()
    try:
        row = connection.execute(
            """
            SELECT u.id, u.email, u.name, s.expires_at
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            """,
            (token_hash(token),),
        ).fetchone()
        if not row:
            return None
        if int(row["expires_at"]) < int(time.time()):
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
            connection.commit()
            return None
        return {"id": int(row["id"]), "email": row["email"], "name": row["name"]}
    finally:
        connection.close()


def client_ip(handler):
    forwarded = handler.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return handler.client_address[0]


def rate_limited(handler):
    now = time.time()
    key = client_ip(handler)
    with AUTH_LOCK:
        hits = [stamp for stamp in AUTH_HITS.get(key, []) if now - stamp < 600]
        if len(hits) >= 30:
            AUTH_HITS[key] = hits
            return True
        hits.append(now)
        AUTH_HITS[key] = hits
        if len(AUTH_HITS) > 5000:
            AUTH_HITS.clear()
    return False


def valid_email(email):
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email)) and len(email) <= 254


def public_user(user):
    return {"id": user["id"], "email": user["email"], "name": user["name"]}


def clean_track(item):
    if not isinstance(item, dict) or item.get("source") == "local":
        return None
    allowed = (
        "id", "source", "title", "artist", "album", "duration", "art", "url",
        "preview", "full", "videoId", "albumId", "artistId", "year", "explicit",
    )
    result = {}
    for key in allowed:
        if key not in item:
            continue
        value = item[key]
        if isinstance(value, (str, int, float, bool)) or value is None:
            result[key] = value
    if not result.get("id") or not result.get("title"):
        return None
    return result


def clean_cloud_data(value):
    if not isinstance(value, dict):
        raise ValueError("Некорректный формат данных")
    result = {}
    favorites = []
    for item in value.get("favorites") or []:
        track = clean_track(item)
        if track and all(existing.get("id") != track.get("id") for existing in favorites):
            favorites.append(track)
        if len(favorites) >= 500:
            break
    result["favorites"] = favorites

    history = []
    for item in value.get("history") or []:
        track = clean_track(item)
        if track and all(existing.get("id") != track.get("id") for existing in history):
            history.append(track)
        if len(history) >= 80:
            break
    result["history"] = history

    searches = []
    for item in value.get("searches") or []:
        text = str(item or "").strip()[:100]
        if text and text.lower() not in [existing.lower() for existing in searches]:
            searches.append(text)
        if len(searches) >= 12:
            break
    result["searches"] = searches

    theme = value.get("theme")
    result["theme"] = theme if theme in ("dark", "light") else "dark"
    try:
        result["volume"] = max(0.0, min(1.0, float(value.get("volume", 0.5))))
    except (TypeError, ValueError):
        result["volume"] = 0.5
    result["muted"] = bool(value.get("muted", False))
    result["shuffle"] = bool(value.get("shuffle", False))
    repeat = value.get("repeat")
    result["repeat"] = repeat if repeat in ("off", "all", "one") else "off"
    source = value.get("source")
    result["source"] = source if source in ("all", "youtube", "itunes", "deezer") else "youtube"

    encoded = json.dumps(result, ensure_ascii=False).encode("utf-8")
    if len(encoded) > 512 * 1024:
        raise ValueError("Слишком много данных для сохранения")
    return result


def http_get(url, timeout=20):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            # Обходим страницу согласия YouTube, если она вдруг откроется.
            "Cookie": "CONSENT=YES+cb.20210328-17-p0.ru+FX+917; SOCS=CAI",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def oembed(video_id):
    """Название канала для треков, у которых YouTube Music его не показал."""
    if video_id in OEMBED_CACHE:
        return OEMBED_CACHE[video_id]
    result = None
    try:
        url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(
            "https://www.youtube.com/watch?v=" + video_id
        )
        result = json.loads(http_get(url, timeout=8))
    except Exception:
        result = None
    OEMBED_CACHE[video_id] = result
    return result


def parse_iso_duration(text):
    match = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", str(text or ""))
    if not match:
        return 0
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    return hours * 3600 + minutes * 60 + seconds


def youtube_api_search(query, limit):
    """Поиск через официальный YouTube Data API (если задан YOUTUBE_API_KEY)."""
    if not YOUTUBE_API_KEY:
        return []
    search_params = urllib.parse.urlencode({
        "part": "snippet",
        "type": "video",
        "videoCategoryId": "10",
        "maxResults": str(max(1, min(25, limit))),
        "q": query,
        "hl": "ru",
        "regionCode": "RU",
        "key": YOUTUBE_API_KEY,
    })
    search_data = json.loads(http_get(YT_API_SEARCH + "?" + search_params, timeout=20))
    rows = search_data.get("items") or []
    ids = []
    snippets = {}
    for row in rows:
        video_id = ((row.get("id") or {}).get("videoId") or "").strip()
        if not video_id or video_id in snippets:
            continue
        snippet = row.get("snippet") or {}
        if snippet.get("liveBroadcastContent") == "live":
            continue
        snippets[video_id] = snippet
        ids.append(video_id)
    if not ids:
        return []

    video_params = urllib.parse.urlencode({
        "part": "contentDetails,snippet",
        "id": ",".join(ids[:50]),
        "key": YOUTUBE_API_KEY,
    })
    video_data = json.loads(http_get(YT_API_VIDEOS + "?" + video_params, timeout=20))
    details = {}
    for row in video_data.get("items") or []:
        details[row.get("id") or ""] = row

    q_norm = query.lower().strip()
    items = []
    for position, video_id in enumerate(ids):
        row = details.get(video_id) or {}
        snippet = row.get("snippet") or snippets.get(video_id) or {}
        duration = parse_iso_duration((row.get("contentDetails") or {}).get("duration"))
        if duration <= 0 or duration < 45 or duration > 20 * 60:
            continue
        title = str(snippet.get("title") or "").strip()
        channel = str(snippet.get("channelTitle") or "").strip()
        if not title:
            continue
        thumbs = ((snippet.get("thumbnails") or {}).get("high")
                  or (snippet.get("thumbnails") or {}).get("medium")
                  or (snippet.get("thumbnails") or {}).get("default") or {})
        low_title = title.lower()
        low_channel = channel.lower()
        score = max(0, 30 - position) * 1.6
        if low_channel.endswith("- topic") or low_channel.endswith("- тема"):
            score += 42
        if q_norm and q_norm in low_title:
            score += 10
        if q_norm and q_norm in low_channel:
            score += 14
        if 60 <= duration <= 600:
            score += 6
        if "live" in low_title or "концерт" in low_title:
            score -= 14
        if any(word in low_title for word in ("cover", "кавер", "remix", "ремикс", "slowed", "nightcore")):
            score -= 10
        items.append({
            "videoId": video_id,
            "title": title,
            "channel": channel or "YouTube",
            "duration": duration,
            "durationText": "%d:%02d" % (duration // 60, duration % 60),
            "thumb": thumbs.get("url") or ("https://i.ytimg.com/vi/%s/hqdefault.jpg" % video_id),
            "views": "",
            "score": score,
            "url": "https://www.youtube.com/watch?v=" + video_id,
        })
    items.sort(key=lambda item: item["score"], reverse=True)
    return items[:limit]


def walk(node, key, found):
    """Рекурсивно собирает все словари с нужным ключом."""
    if isinstance(node, dict):
        value = node.get(key)
        if isinstance(value, dict):
            found.append(value)
        for child in node.values():
            walk(child, key, found)
    elif isinstance(node, list):
        for child in node:
            walk(child, key, found)


def parse_duration(text):
    if not text:
        return 0
    parts = str(text).strip().split(":")
    try:
        parts = [int(p) for p in parts]
    except ValueError:
        return 0
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + part
    return seconds


def text_of(node):
    if not node:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        if "simpleText" in node:
            return str(node.get("simpleText") or "")
        runs = node.get("runs") or []
        return "".join(str(r.get("text") or "") for r in runs)
    return ""


def js_unescape(value):
    r"""Разбирает JS-строку с \xNN-экранированием, не ломая UTF-8."""
    out = bytearray()
    i = 0
    while i < len(value):
        char = value[i]
        if char == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            if nxt == "x" and i + 3 < len(value):
                out.append(int(value[i + 2:i + 4], 16))
                i += 4
                continue
            if nxt == "u" and i + 5 < len(value):
                out.extend(chr(int(value[i + 2:i + 6], 16)).encode("utf-8"))
                i += 6
                continue
            if nxt in "/\\'\"":
                out.extend(nxt.encode("utf-8"))
                i += 2
                continue
            if nxt == "n":
                out.extend(b"\n")
                i += 2
                continue
            out.extend(nxt.encode("utf-8"))
            i += 2
            continue
        out.extend(char.encode("utf-8"))
        i += 1
    return out.decode("utf-8", errors="replace")


def extract_ytm(html, query, limit):
    """Разбирает выдачу YouTube Music (полные песни, а не случайные видео)."""
    blocks = re.findall(
        r"initialData\.push\(\{path:\s*'([^']*)'[^}]*?data:\s*'((?:\\.|[^'])*)'\}\)",
        html,
        re.S,
    )
    data = None
    for _path, raw in blocks:
        if "musicResponsiveListItemRenderer" in raw:
            data = json.loads(js_unescape(raw))
            break
    if data is None:
        raise ValueError("YouTube Music не вернул результаты")

    raw_items = []
    walk(data, "musicResponsiveListItemRenderer", raw_items)
    q_norm = query.lower().strip()
    items = []
    seen = set()

    # Служебные подписи YouTube Music, которые не являются исполнителем.
    type_labels = {
        "композиция", "видео", "альбом", "сингл", "плейлист", "исполнитель",
        "профиль", "подкаст", "выпуск", "song", "video", "album", "single",
        "playlist", "artist", "profile", "podcast", "episode",
        "плейлисты youtube music", "пользовательские плейлисты",
    }
    skip_labels = {
        "альбом", "сингл", "плейлист", "исполнитель", "профиль", "подкаст",
        "выпуск", "album", "single", "playlist", "artist", "profile",
        "podcast", "episode",
        "плейлисты youtube music", "пользовательские плейлисты",
    }

    for position, item in enumerate(raw_items):
        video_id = ""
        try:
            video_id = (
                item["overlay"]["musicItemThumbnailOverlayRenderer"]["content"]
                ["musicPlayButtonRenderer"]["playNavigationEndpoint"]["watchEndpoint"]["videoId"]
            )
        except (KeyError, TypeError):
            pass
        if not video_id:
            try:
                video_id = item["flexColumns"][0]["musicResponsiveListItemFlexColumnRenderer"]["text"]["runs"][0]["navigationEndpoint"]["watchEndpoint"]["videoId"]
            except (KeyError, TypeError, IndexError):
                pass
        if not video_id or video_id in seen:
            continue

        title = ""
        runs_all = []
        for column in item.get("flexColumns") or []:
            renderer = column.get("musicResponsiveListItemFlexColumnRenderer") if isinstance(column, dict) else None
            runs = ((renderer or {}).get("text") or {}).get("runs") or []
            runs_all.append(runs)
            if not title:
                title = text_of((renderer or {}).get("text")).strip()
        if not title:
            continue

        meta_runs = runs_all[1] if len(runs_all) > 1 else []
        meta = [str(run.get("text") or "").strip() for run in meta_runs]
        meta = [text for text in meta if text and text not in ("•", "·")]

        item_type = ""
        artist = ""
        duration_text = ""
        views = ""
        for text in meta:
            low = text.lower()
            if not item_type and low in type_labels:
                item_type = low
                continue
            if re.fullmatch(r"\d{1,2}:\d{2}(?::\d{2})?", text):
                duration_text = text
                continue
            if "просмотр" in low or "прослушиван" in low or "view" in low:
                views = text
                continue
            if not artist:
                artist = text

        if item_type in skip_labels:
            continue
        # «Композиция» и «Видео» — это треки. Всё остальное (альбомы,
        # плейлисты, подкасты) в очередь не кладём.
        if item_type and item_type not in ("композиция", "видео", "song", "video"):
            continue

        duration = parse_duration(duration_text)
        if duration > 20 * 60:
            continue
        if 0 < duration < 40:
            continue

        video_type = ""
        try:
            video_type = (
                item["overlay"]["musicItemThumbnailOverlayRenderer"]["content"]
                ["musicPlayButtonRenderer"]["playNavigationEndpoint"]["watchEndpoint"]
                ["watchEndpointMusicSupportedConfigs"]["watchEndpointMusicConfig"]["musicVideoType"]
            )
        except (KeyError, TypeError):
            pass
        if video_type == "MUSIC_VIDEO_TYPE_PODCAST_EPISODE":
            continue
        # Без длительности пропускаем только явно официальные аудио/клипы:
        # у них плеер сам сообщит длительность после загрузки.
        if duration <= 0 and video_type not in ("MUSIC_VIDEO_TYPE_ATV", "MUSIC_VIDEO_TYPE_OMV"):
            continue

        low_title = title.lower()
        low_artist = artist.lower()
        if any(word in low_title for word in ("подкаст", "интервью", "новости", "трейлер")):
            continue

        score = max(0, 30 - position) * 1.6
        if video_type == "MUSIC_VIDEO_TYPE_ATV":
            score += 42
        elif video_type == "MUSIC_VIDEO_TYPE_OMV":
            score += 22
        elif video_type == "MUSIC_VIDEO_TYPE_UGC":
            score += 6
        if q_norm and q_norm in low_title:
            score += 10
        if q_norm and q_norm in low_artist:
            score += 14
        if 60 <= duration <= 600:
            score += 6
        if not artist:
            score -= 8
        if "live" in low_title or "концерт" in low_title:
            score -= 14
        if any(word in low_title for word in ("cover", "кавер", "remix", "ремикс", "slowed", "nightcore")):
            score -= 10

        seen.add(video_id)
        items.append({
            "videoId": video_id,
            "title": title,
            "channel": artist or "YouTube Music",
            "duration": duration,
            "durationText": duration_text,
            "thumb": "https://i.ytimg.com/vi/%s/hqdefault.jpg" % video_id,
            "views": views,
            "score": score,
            "url": "https://www.youtube.com/watch?v=" + video_id,
        })

    missing_artist = [item for item in items if item["channel"] == "YouTube Music"][:6]
    for item in missing_artist:
        info = oembed(item["videoId"])
        if info and info.get("author_name"):
            item["channel"] = str(info["author_name"])
            item["score"] += 10

    items.sort(key=lambda item: item["score"], reverse=True)
    return items[:limit]


def extract_videos(html, query, limit):
    match = re.search(r"(?:var\s+ytInitialData\s*=\s*|window\[\"ytInitialData\"\]\s*=\s*)(\{.*?\});", html, re.S)
    if not match:
        raise ValueError("YouTube не вернул данные поиска")
    data = json.loads(match.group(1))
    raw = []
    walk(data, "videoRenderer", raw)

    items = []
    seen = set()
    q_norm = query.lower().strip()
    for video in raw:
        video_id = video.get("videoId")
        if not video_id or video_id in seen:
            continue
        title = text_of(video.get("title")).strip()
        channel = text_of(video.get("ownerText")).strip()
        if not title:
            continue
        duration_text = text_of(video.get("lengthText")).strip()
        # Прямые эфиры и ролики без длительности не подходят для очереди.
        if not duration_text:
            continue
        duration = parse_duration(duration_text)
        if duration <= 0 or duration > 20 * 60:
            continue
        # Короткие ролики и Shorts — это обычно не песни.
        if duration < 45:
            continue
        badges = json.dumps(video.get("badges") or [], ensure_ascii=False)
        if "LIVE" in badges.upper():
            continue
        thumb = ""
        thumbs = ((video.get("thumbnail") or {}).get("thumbnails") or [])
        if thumbs:
            thumb = thumbs[-1].get("url") or ""
        views = text_of(video.get("viewCountText")).strip()
        seen.add(video_id)

        low_title = title.lower()
        low_channel = channel.lower()
        score = 0
        if low_channel.endswith("- topic"):
            score += 34
        if "official audio" in low_title or "official music video" in low_title:
            score += 18
        if "official" in low_channel or "official" in low_title:
            score += 10
        if "audio" in low_title:
            score += 8
        if q_norm and q_norm in low_title:
            score += 6
        if q_norm and q_norm in low_channel:
            score += 8
        if "live" in low_title or "concert" in low_title:
            score -= 12
        if any(word in low_title for word in ("cover", "кавер", "remix", "ремикс", "slowed", "nightcore", "8d audio")):
            score -= 8

        items.append({
            "videoId": video_id,
            "title": title,
            "channel": channel,
            "duration": duration,
            "durationText": duration_text,
            "thumb": thumb,
            "views": views,
            "score": score,
            "url": "https://www.youtube.com/watch?v=" + video_id,
        })

    # Сначала более «музыкальные» результаты, но общий порядок YouTube сохраняем.
    items.sort(key=lambda item: item["score"], reverse=True)
    return items[:limit]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        if self.path.startswith("/api/"):
            origin = os.environ.get("VOLNA_CORS_ORIGIN", "").strip()
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Cache-Control", "no-store")
        else:
            # Во время работы сайта удобнее всегда видеть свежие JS/CSS.
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "auth": True})
            return
        if parsed.path == "/api/auth/me":
            user = session_user(self)
            self.send_json({"user": public_user(user) if user else None})
            return
        if parsed.path == "/api/user/data":
            self.handle_get_data()
            return
        if parsed.path == "/api/yt/search":
            self.handle_search(parsed)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/auth/register":
            self.handle_register()
            return
        if parsed.path == "/api/auth/login":
            self.handle_login()
            return
        if parsed.path == "/api/auth/logout":
            self.handle_logout()
            return
        self.send_json({"error": "Метод не найден"}, status=404)

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/user/data":
            self.handle_put_data()
            return
        self.send_json({"error": "Метод не найден"}, status=404)

    def read_json(self):
        if "application/json" not in self.headers.get("Content-Type", "").lower():
            raise ValueError("Ожидается JSON")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Некорректная длина запроса")
        if length <= 0:
            raise ValueError("Пустой запрос")
        if length > 1024 * 1024:
            raise ValueError("Слишком большой запрос")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Некорректный JSON")
        if not isinstance(value, dict):
            raise ValueError("Ожидается объект JSON")
        return value

    def secure_cookies(self):
        return (
            os.environ.get("VOLNA_SECURE_COOKIES") == "1"
            or self.headers.get("X-Forwarded-Proto", "").lower() == "https"
        )

    def session_cookie(self, token, max_age=SESSION_TTL):
        parts = [
            SESSION_COOKIE + "=" + token,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=" + str(max_age),
        ]
        if self.secure_cookies():
            parts.append("Secure")
        return "; ".join(parts)

    def handle_register(self):
        if rate_limited(self):
            self.send_json({"error": "Слишком много попыток. Попробуйте позже."}, status=429)
            return
        try:
            payload = self.read_json()
            email = str(payload.get("email") or "").strip().lower()
            password = str(payload.get("password") or "")
            name = str(payload.get("name") or "").strip() or email.split("@")[0]
            if not valid_email(email):
                self.send_json({"error": "Введите корректный email"}, status=400)
                return
            if len(password) < 8:
                self.send_json({"error": "Пароль должен быть не короче 8 символов"}, status=400)
                return
            if len(password) > 200:
                self.send_json({"error": "Слишком длинный пароль"}, status=400)
                return
            if len(name) > 60:
                self.send_json({"error": "Имя должно быть короче 60 символов"}, status=400)
                return
            connection = db_connect()
            try:
                cursor = connection.execute(
                    "INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (email, name, hash_password(password), int(time.time())),
                )
                user_id = int(cursor.lastrowid)
                token = create_session(connection, user_id)
                connection.commit()
            except sqlite3.IntegrityError:
                self.send_json({"error": "Пользователь с таким email уже зарегистрирован"}, status=409)
                return
            finally:
                connection.close()
            self.send_json(
                {"user": {"id": user_id, "email": email, "name": name}},
                status=201,
                headers=[("Set-Cookie", self.session_cookie(token))],
            )
        except ValueError as error:
            self.send_json({"error": str(error)}, status=400)
        except Exception as error:  # noqa: BLE001
            sys.stderr.write("[auth] register: %s\n" % error)
            self.send_json({"error": "Не удалось создать аккаунт"}, status=500)

    def handle_login(self):
        if rate_limited(self):
            self.send_json({"error": "Слишком много попыток. Попробуйте позже."}, status=429)
            return
        try:
            payload = self.read_json()
            email = str(payload.get("email") or "").strip().lower()
            password = str(payload.get("password") or "")
            if not email or not password:
                self.send_json({"error": "Введите email и пароль"}, status=400)
                return
            connection = db_connect()
            try:
                row = connection.execute(
                    "SELECT id, email, name, password_hash FROM users WHERE email = ? COLLATE NOCASE",
                    (email,),
                ).fetchone()
                if not row or not verify_password(password, row["password_hash"]):
                    self.send_json({"error": "Неверный email или пароль"}, status=401)
                    return
                token = create_session(connection, int(row["id"]))
                connection.commit()
                user = {"id": int(row["id"]), "email": row["email"], "name": row["name"]}
            finally:
                connection.close()
            self.send_json(
                {"user": user},
                status=200,
                headers=[("Set-Cookie", self.session_cookie(token))],
            )
        except ValueError as error:
            self.send_json({"error": str(error)}, status=400)
        except Exception as error:  # noqa: BLE001
            sys.stderr.write("[auth] login: %s\n" % error)
            self.send_json({"error": "Не удалось войти"}, status=500)

    def handle_logout(self):
        token = session_token(self)
        if token:
            connection = db_connect()
            try:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
                connection.commit()
            finally:
                connection.close()
        self.send_json(
            {"ok": True},
            status=200,
            headers=[("Set-Cookie", self.session_cookie("", 0))],
        )

    def handle_get_data(self):
        user = session_user(self)
        if not user:
            self.send_json({"error": "Нужно войти в аккаунт"}, status=401)
            return
        connection = db_connect()
        try:
            row = connection.execute(
                "SELECT data, updated_at FROM user_data WHERE user_id = ?", (user["id"],)
            ).fetchone()
        finally:
            connection.close()
        data = None
        updated_at = 0
        if row:
            updated_at = int(row["updated_at"])
            try:
                data = json.loads(row["data"])
            except json.JSONDecodeError:
                data = None
        self.send_json({"data": data, "updatedAt": updated_at})

    def handle_put_data(self):
        user = session_user(self)
        if not user:
            self.send_json({"error": "Нужно войти в аккаунт"}, status=401)
            return
        try:
            payload = self.read_json()
            data = clean_cloud_data(payload.get("data"))
            encoded = json.dumps(data, ensure_ascii=False)
            now = int(time.time())
            connection = db_connect()
            try:
                connection.execute(
                    """
                    INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
                    """,
                    (user["id"], encoded, now),
                )
                connection.commit()
            finally:
                connection.close()
            self.send_json({"ok": True, "updatedAt": now})
        except ValueError as error:
            self.send_json({"error": str(error)}, status=400)
        except Exception as error:  # noqa: BLE001
            sys.stderr.write("[auth] save: %s\n" % error)
            self.send_json({"error": "Не удалось сохранить данные"}, status=500)

    def handle_search(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        query = (params.get("q") or [""])[0].strip()
        if not query:
            self.send_json({"error": "Пустой запрос"}, status=400)
            return
        try:
            limit = max(1, min(30, int((params.get("limit") or ["24"])[0])))
        except ValueError:
            limit = 24

        try:
            items = []
            try:
                html = http_get(YTM_SEARCH.format(urllib.parse.quote(query)))
                items = extract_ytm(html, query, limit)
            except Exception:
                items = []
            if not items and YOUTUBE_API_KEY:
                try:
                    items = youtube_api_search(query, limit)
                except Exception as error:  # noqa: BLE001
                    sys.stderr.write("[yt-api] %s\n" % error)
                    items = []
            if not items:
                html = http_get(YT_SEARCH.format(urllib.parse.quote(query)))
                items = extract_videos(html, query, limit)
            self.send_json({"query": query, "items": items})
        except Exception as error:  # noqa: BLE001 — прокси не должен падать
            self.send_json({"error": "YouTube недоступен: " + str(error)}, status=502)

    def send_json(self, payload, status=200, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers or []:
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write("[api] %s\n" % (fmt % args))


class VolnaServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    os.chdir(ROOT)
    init_db()
    server = VolnaServer((HOST, PORT), Handler)
    print("Волна запущена: http://localhost:%d/" % PORT)
    print("База данных: %s" % DB_PATH)
    print("Для остановки закройте это окно или нажмите Ctrl+C.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
