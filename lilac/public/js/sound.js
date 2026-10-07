'use strict';

/**
 * Звуки сайта.
 *
 * Файлы не храним — короткие сигналы собираем прямо в браузере через Web Audio.
 * Это работает одинаково везде, не грузит страницу и не требуетmp3 рядом с проектом.
 */

const Sound = (() => {
  const KEY = 'lilac.sound';

  let ctx = null;
  let enabled = localStorage.getItem(KEY) !== 'off';
  let ringTimer = null;

  /** Контекст создаём только после первого клика: иначе браузер молчит. */
  function ac() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /** Один короткий тон с мягким нарастанием и затуханием. */
  function tone(freq, start, dur, gainPeak, type = 'sine') {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + start;

    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);

    const gain = c.createGain();
    // мягкая атака и хвост — сигнал не щёлкает
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(gainPeak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  const SOUNDS = {
    // пришло сообщение: две ноты вверх, тихо и не раздражающе
    message() {
      tone(784, 0, 0.13, 0.06);
      tone(1046, 0.09, 0.17, 0.05);
    },

    // твоё сообщение ушло: один короткий щелчок
    send() {
      tone(660, 0, 0.07, 0.03, 'triangle');
    },

    // вызов отклонён или сброшен
    busy() {
      tone(420, 0, 0.14, 0.05, 'triangle');
      tone(320, 0.13, 0.22, 0.05, 'triangle');
    },

    // разговор соединился
    connected() {
      tone(660, 0, 0.11, 0.05);
      tone(880, 0.1, 0.16, 0.05);
    },

    // что-то не получилось
    error() {
      tone(300, 0, 0.18, 0.05, 'sawtooth');
    },
  };

  return {
    get enabled() {
      return enabled;
    },

    /** Включить или выключить; запоминаем выбор. */
    toggle() {
      enabled = !enabled;
      localStorage.setItem(KEY, enabled ? 'on' : 'off');
      if (!enabled) this.stopRing();
      else ac(); // сразу создаём контекст, раз пользователь нажал кнопку
      return enabled;
    },

    play(name) {
      if (!enabled) return;
      const fn = SOUNDS[name];
      if (!fn) return;
      try {
        fn();
      } catch {
        /* звук не критичен, тихо игнорируем */
      }
    },

    /** Гудок входящего звонка: повторяется, пока не ответят. */
    startRing() {
      if (!enabled || ringTimer) return;
      if (!ac()) return;

      // первый гудок — сразу, иначе пришлось бы ждать целый цикл
      this.ringOnce();

      ringTimer = setInterval(() => {
        if (!enabled) return this.stopRing();
        this.ringOnce();
      }, 10000);
    },

    /** Один круг гудка: пять пар «зубцов», как у телефона. */
    ringOnce() {
      for (let i = 0; i < 5; i++) {
        tone(440, i * 2, 0.42, 0.07);
        tone(480, i * 2 + 0.45, 0.42, 0.07);
      }
    },

    stopRing() {
      clearInterval(ringTimer);
      ringTimer = null;
    },
  };
})();

// Любое первое касание страницы снимает браузерный запрет на автозвук
window.addEventListener('pointerdown', () => ac(), { once: true });