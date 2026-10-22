/* ==========================================================================
   Волна — чтение ID3-тегов и обложек из локальных файлов
   ========================================================================== */
(function () {
  'use strict';

  function syncsafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
  }

  function readUint32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function deUnsync(bytes) {
    const out = new Uint8Array(bytes.length);
    let j = 0;
    for (let i = 0; i < bytes.length; i++) {
      out[j++] = bytes[i];
      if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }

  function clean(str) {
    return String(str || '')
      .replace(/\u0000+$/g, '')
      .split('\u0000')[0]
      .replace(/\s+/g, ' ')
      .trim();
  }

  function decodeText(bytes, encoding) {
    if (!bytes || !bytes.length) return '';
    try {
      if (encoding === 1 || encoding === 2) {
        let offset = 0;
        let bigEndian = encoding === 2;
        if (encoding === 1 && bytes.length >= 2) {
          if (bytes[0] === 0xff && bytes[1] === 0xfe) offset = 2;
          else if (bytes[0] === 0xfe && bytes[1] === 0xff) { offset = 2; bigEndian = true; }
        }
        return clean(new TextDecoder(bigEndian ? 'utf-16be' : 'utf-16le').decode(bytes.subarray(offset)));
      }
      if (encoding === 3) return clean(new TextDecoder('utf-8').decode(bytes));
      const cp = new TextDecoder('windows-1251').decode(bytes);
      const latin = new TextDecoder('iso-8859-1').decode(bytes);
      const cyrillic = (cp.match(/[А-Яа-яЁё]/g) || []).length;
      const controls = (latin.match(/[\u0080-\u00bf]/g) || []).length;
      return clean(cyrillic > 0 && cyrillic >= controls / 2 ? cp : latin);
    } catch (e) {
      return '';
    }
  }

  function guessImageType(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
    return 'image/jpeg';
  }

  function parsePicture(body) {
    try {
      const encoding = body[0];
      let i = 1;
      let mime = '';
      while (i < body.length && body[i] !== 0) {
        mime += String.fromCharCode(body[i]);
        i++;
      }
      i++; // нулевой байт mime
      if (i >= body.length) return null;
      i++; // тип изображения
      if (encoding === 1 || encoding === 2) {
        while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2;
        i += 2;
      } else {
        while (i < body.length && body[i] !== 0) i++;
        i++;
      }
      if (i >= body.length - 8) return null;
      const data = body.subarray(i);
      if (mime.indexOf('-->') === 0) return null; // ссылка, а не картинка
      if (!/^image\//i.test(mime)) mime = guessImageType(data);
      return new Blob([data], { type: mime });
    } catch (e) {
      return null;
    }
  }

  function parseId3v2(bytes, version) {
    const tags = {};
    let pos = 0;
    const isV4 = version === 4;

    while (pos + 10 <= bytes.length) {
      if (bytes[pos] === 0) break;
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      let size = isV4 ? syncsafe(bytes, pos + 4) : readUint32(bytes, pos + 4);
      if (size <= 0 || pos + 10 + size > bytes.length) {
        // некоторые кодировщики пишут обычный размер в v2.4
        if (isV4) {
          const alt = readUint32(bytes, pos + 4);
          if (alt > 0 && pos + 10 + alt <= bytes.length) size = alt;
          else break;
        } else break;
      }
      const body = bytes.subarray(pos + 10, pos + 10 + size);
      switch (id) {
        case 'TIT2': case 'TT2': tags.title = decodeText(body.subarray(1), body[0]); break;
        case 'TPE1': case 'TP1': tags.artist = decodeText(body.subarray(1), body[0]); break;
        case 'TALB': case 'TAL': tags.album = decodeText(body.subarray(1), body[0]); break;
        case 'TYER': case 'TDRC': case 'TYE': tags.year = decodeText(body.subarray(1), body[0]).slice(0, 4); break;
        case 'TRCK': case 'TRK': tags.track = parseInt(decodeText(body.subarray(1), body[0]), 10) || 0; break;
        case 'APIC': case 'PIC': {
          const art = parsePicture(body);
          if (art) tags.art = art;
          break;
        }
        default: break;
      }
      pos += 10 + size;
    }
    return tags;
  }

  function parseId3v1(bytes) {
    if (bytes.length < 128) return {};
    const start = bytes.length - 128;
    if (String.fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2]) !== 'TAG') return {};
    const field = (offset, length) => {
      let end = offset + length;
      while (end > offset && (bytes[end - 1] === 0 || bytes[end - 1] === 32)) end--;
      return decodeText(bytes.subarray(offset, end), 0);
    };
    return {
      title: field(start + 3, 30),
      artist: field(start + 33, 30),
      album: field(start + 63, 30),
      year: field(start + 93, 4)
    };
  }

  function fromFilename(name) {
    const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim();
    const match = base.match(/^(.{1,80}?)\s+[-–—]\s+(.{1,120})$/);
    if (match) return { artist: match[1].trim(), title: match[2].trim() };
    return { title: base };
  }

  async function read(file) {
    const tags = { title: '', artist: '', album: '', year: '', track: 0, art: null };
    try {
      if (file.size >= 10) {
        const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
        if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
          const version = header[3];
          const flags = header[5];
          const size = syncsafe(header, 6);
          if ((version === 3 || version === 4) && size > 0 && size < 32 * 1024 * 1024) {
            let body = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
            if (flags & 0x80) body = deUnsync(body);
            const parsed = parseId3v2(body, version);
            Object.keys(parsed).forEach((key) => { tags[key] = parsed[key]; });
          }
        }
      }
      if (!tags.title || !tags.artist) {
        try {
          const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 128)).arrayBuffer());
          const v1 = parseId3v1(tail);
          if (!tags.title && v1.title) tags.title = v1.title;
          if (!tags.artist && v1.artist) tags.artist = v1.artist;
          if (!tags.album && v1.album) tags.album = v1.album;
          if (!tags.year && v1.year) tags.year = v1.year;
        } catch (e) { /* нет v1 */ }
      }
    } catch (e) {
      // Повреждённые теги — не повод не добавить файл.
    }
    const fallback = fromFilename(file.name);
    if (!tags.title) tags.title = fallback.title || 'Без названия';
    if (!tags.artist) tags.artist = fallback.artist || '';
    return tags;
  }

  window.ID3 = { read, fromFilename };
})();
