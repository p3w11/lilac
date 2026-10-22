/* ==========================================================================
   Волна — утилиты, иконки, тосты
   ========================================================================== */
(function () {
  'use strict';

  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
    sparkles: '<path d="M12 3.2l1.75 5.05L18.8 10l-5.05 1.75L12 16.8l-1.75-5.05L5.2 10l5.05-1.75L12 3.2Z"/><path d="M18.6 14.6l.95 2.45 2.45.95-2.45.95-.95 2.45-.95-2.45L15.2 18l2.45-.95.95-2.45Z"/>',
    heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>',
    menu: '<path d="M3.5 7h17M3.5 12h17M3.5 17h17"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    play: '<path d="M8 5.3v13.4c0 .87.96 1.4 1.7.94l10.6-6.7a1.1 1.1 0 0 0 0-1.88L9.7 4.36A1.1 1.1 0 0 0 8 5.3Z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.6" y="4.6" width="3.7" height="14.8" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.7" y="4.6" width="3.7" height="14.8" rx="1.2" fill="currentColor" stroke="none"/>',
    next: '<path d="M6 5.4v13.2c0 .88 1 1.4 1.72.9l9.1-6.6V18a1 1 0 0 0 1 1h.92a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-.92a1 1 0 0 0-1 1v5.1l-9.1-6.6A1.05 1.05 0 0 0 6 5.4Z" fill="currentColor" stroke="none"/>',
    prev: '<g transform="rotate(180 12 12)"><path d="M6 5.4v13.2c0 .88 1 1.4 1.72.9l9.1-6.6V18a1 1 0 0 0 1 1h.92a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-.92a1 1 0 0 0-1 1v5.1l-9.1-6.6A1.05 1.05 0 0 0 6 5.4Z" fill="currentColor" stroke="none"/></g>',
    shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
    repeat: '<path d="m17 1 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 23-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    volumeLow: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
    volumeX: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="m16 9 5 6M21 9l-5 6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    alert: '<path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    wifiOff: '<path d="m2 2 20 20"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 3-1.9"/><path d="M14.5 10.6a10 10 0 0 1 4.5 2.3"/><path d="M2.5 8.6A15 15 0 0 1 7 6.2"/><path d="M17 6.2a15 15 0 0 1 4.5 2.4"/><path d="M12 20h.01"/>',
    spark: '<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'
  };

  function icon(name, cls) {
    const body = ICONS[name] || ICONS.info;
    return '<svg class="ico ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function fmtTracks(n) { return n + ' ' + plural(n, ['трек', 'трека', 'треков']); }
  function fmtAlbums(n) { return n + ' ' + plural(n, ['альбом', 'альбома', 'альбомов']); }

  function fmtSize(bytes) {
    if (!bytes) return '0 МБ';
    const mb = bytes / 1048576;
    if (mb < 1) return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' МБ';
    return (mb / 1024).toFixed(2) + ' ГБ';
  }

  function fmtCount(num) {
    if (!num) return '0';
    if (num >= 1e9) return (num / 1e9).toFixed(1).replace('.0', '') + ' млрд';
    if (num >= 1e6) return (num / 1e6).toFixed(1).replace('.0', '') + ' млн';
    if (num >= 1e3) return (num / 1e3).toFixed(1).replace('.0', '') + ' тыс.';
    return String(num);
  }

  function norm(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^0-9a-zа-я]+/g, ' ')
      .trim();
  }

  function hashString(str) {
    let h = 2166136261;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function hues(str) {
    const h = hashString(str);
    const h1 = h % 360;
    const h2 = (h1 + 45 + (h % 70)) % 360;
    return { h1, h2 };
  }

  function initials(str) {
    const s = String(str || '').trim();
    if (!s) return '∿';
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function gradientStyle(seed) {
    const { h1, h2 } = hues(seed || 'volna');
    return '--g1:hsl(' + h1 + ' 72% 55%);--g2:hsl(' + h2 + ' 78% 46%)';
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function debounce(fn, wait) {
    let t = 0;
    return function () {
      const args = arguments;
      const self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), wait);
    };
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  let toastSeq = 0;
  function toast(text, type) {
    type = type || 'info';
    const host = document.getElementById('toasts');
    if (!host) return;
    while (host.children.length >= 3) host.removeChild(host.firstChild);
    const el = document.createElement('div');
    el.className = 'toast toast--' + (type === 'success' ? 'ok' : type);
    el.dataset.toast = String(++toastSeq);
    const name = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
    el.innerHTML = '<span class="toast__ico">' + icon(name) + '</span><span>' + esc(text) + '</span>';
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 260);
    }, 3400);
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.U = {
    ICONS, icon, esc, fmtTime, plural, fmtTracks, fmtAlbums, fmtSize, fmtCount,
    norm, hashString, hues, initials, gradientStyle, clamp, debounce, uid, toast,
    downloadText
  };
})();
