#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Волна — локальный сервер.

Отдаёт файлы сайта и проксирует поиск YouTube, чтобы браузеру не мешал CORS.
Никакие треки не скачиваются: воспроизведение идёт через официальный
встроенный плеер YouTube.
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("VOLNA_PORT", "8787"))
YT_SEARCH = "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%253D%253D"
YTM_SEARCH = "https://music.youtube.com/search?q={}&sp=EgWKAQIIAWoSEAUQCRAOEAMQChAEEBAQERAV"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
OEMBED_CACHE = {}


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
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Cache-Control", "no-store")
        else:
            # Во время работы сайта удобнее всегда видеть свежие JS/CSS.
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/yt/search":
            self.handle_search(parsed)
            return
        if parsed.path == "/api/health":
            self.send_json({"ok": True})
            return
        super().do_GET()

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
            if not items:
                html = http_get(YT_SEARCH.format(urllib.parse.quote(query)))
                items = extract_videos(html, query, limit)
            self.send_json({"query": query, "items": items})
        except Exception as error:  # noqa: BLE001 — прокси не должен падать
            self.send_json({"error": "YouTube недоступен: " + str(error)}, status=502)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write("[api] %s\n" % (fmt % args))


def main():
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("Волна запущена: http://localhost:%d/" % PORT)
    print("Для остановки закройте это окно или нажмите Ctrl+C.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
