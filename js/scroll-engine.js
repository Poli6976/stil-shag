/*
  Ядро синхронизации со скроллом. Единственный источник прогресса прокрутки
  (0..1) для всей сцены. Другие модули подписываются через onUpdate и получают
  вызов на каждый анимационный кадр во время скролла (rAF-throttled).
*/
(function (NS) {
  'use strict';

  var listeners = [];
  var ticking = false;
  var progress = 0;

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function mapRange(p, a, b) {
    if (a === b) return p >= b ? 1 : 0;
    return clamp01((p - a) / (b - a));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function computeProgress() {
    var scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? clamp01(scrollTop / max) : 0;
  }

  function notify() {
    progress = computeProgress();
    document.documentElement.style.setProperty('--scroll-progress', progress.toFixed(4));
    for (var i = 0; i < listeners.length; i++) {
      listeners[i](progress);
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      notify();
      ticking = false;
    });
  }

  function init() {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    notify();
  }

  NS.Utils = { clamp01: clamp01, mapRange: mapRange, lerp: lerp, easeInOutCubic: easeInOutCubic };

  NS.ScrollEngine = {
    init: init,
    onUpdate: function (fn) { listeners.push(fn); },
    getProgress: function () { return progress; }
  };
})(window.Style = window.Style || {});
