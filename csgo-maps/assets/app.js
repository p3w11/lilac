/* CS:GO MAPS — живой поиск по списку и копирование команды */
(function () {
  'use strict';

  var input = document.getElementById('q');
  var list = document.getElementById('maps');
  var emptyNote = document.getElementById('emptyFilter');

  /* Фильтр на лету. Страница уже отфильтрована на сервере,
     поэтому скрываем лишние строки, а не ищем заново. */
  if (input && list) {
    var items = Array.prototype.slice.call(list.querySelectorAll('.map'));

    var apply = function () {
      var q = input.value.trim().toLowerCase();
      var visible = 0;

      items.forEach(function (el) {
        var hit = q === '' || (el.dataset.search || '').indexOf(q) !== -1;
        el.hidden = !hit;
        if (hit) visible++;
      });

      if (emptyNote) emptyNote.hidden = visible !== 0;
    };

    input.addEventListener('input', apply);

    /* Enter без перезагрузки, если JS работает */
    var form = document.getElementById('searchForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        apply();
      });
    }

    /* / — фокус в поиск */
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  /* Кнопка «map <name>» копирует команду в буфер обмена */
  document.querySelectorAll('.copy').forEach(function (btn) {
    var flash = function () {
      var was = btn.textContent;
      btn.textContent = 'скопировано';
      btn.classList.add('done');
      setTimeout(function () {
        btn.textContent = was;
        btn.classList.remove('done');
      }, 1200);
    };

    /* execCommand — запасной путь. Нужен там, где navigator.clipboard
       есть, но отклоняет запрос (старый Firefox, закрытый документ,
       запрет на разрешения). */
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = btn.dataset.cmd || '';
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    };

    btn.addEventListener('click', function () {
      var cmd = btn.dataset.cmd || '';

      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        if (fallback()) flash();
        return;
      }

      navigator.clipboard.writeText(cmd).then(flash, function () {
        if (fallback()) flash();
      });
    });
  });
})();