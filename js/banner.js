/*
  Живые модели на главной.

  Силуэты (.fig-silhouette--1…4) стоят на своих местах, как раньше.
  При движении мыши они по очереди 1 → 2 → 3 → 4 «оживают»: силуэт плавно
  гаснет, поверх него проявляется видео с моделью, она делает проходку,
  затем видео гаснет и силуэт возвращается.
  На устройствах без мыши (телефон, планшет) проходка запускается сама,
  когда главная видна на экране.

  Режим окончания проходки (ещё не выбран окончательно):
    по умолчанию      — видео гаснет, силуэт возвращается;
    ?end=back         — модель «отматывается» назад к исходной точке
                        (файлы model-N-back.mp4), потом силуэт возвращается.
*/
(function () {
  'use strict';

  // Где в кадре видео стоит модель на первом кадре: доля высоты кадра
  // от верха до макушки (top) и до носков туфель (feet). По этим долям
  // видео подгоняется так, чтобы модель встала ровно на место силуэта.
  var FRAME = {
    1: { top: 0.14, feet: 0.85 },
    2: { top: 0.09, feet: 0.90 },
    3: { top: 0.22, feet: 0.84 },
    4: { top: 0.09, feet: 0.92, cx: 0.66 }
  };
  var VIDEO_RATIO = 9 / 16;     // ширина / высота ролика
  var STEP_DELAY = 1200;        // пауза между стартами моделей, мс
  var COOLDOWN = 1500;          // пауза после проходки до следующего запуска, мс

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;

  var params = new URLSearchParams(window.location.search);
  var endMode = params.get('end') === 'back' ? 'back' : 'fade';

  var slots = [];
  var running = false;
  var timers = [];

  function init() {
    var videos = document.querySelectorAll('.fig-live');
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var n = Number(video.getAttribute('data-fig'));
      var img = document.querySelector('.fig-silhouette--' + n);
      if (!img || !FRAME[n]) continue;
      if (endMode === 'back') {
        video.src = 'assets/banner/model-' + n + '-back.mp4?v=2';
      }
      video.muted = true;
      slots.push({ n: n, video: video, img: img });
    }
    if (!slots.length) return;

    layout();
    window.addEventListener('resize', layout);
    // силуэты-картинки могут догрузиться позже — пересчитать по ним
    slots.forEach(function (s) {
      if (!s.img.complete) s.img.addEventListener('load', layout);
    });

    var hasMouse = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (hasMouse) {
      window.addEventListener('mousemove', start, { passive: true });
    } else {
      watchVisibility();
    }
  }

  // Ставит каждое видео точно поверх его силуэта.
  function layout() {
    slots.forEach(function (s) {
      var r = s.img.getBoundingClientRect();
      var visible = r.width > 0 && r.height > 0 &&
        window.getComputedStyle(s.img).display !== 'none';
      s.visible = visible;
      if (!visible) {
        s.video.style.display = 'none';
        return;
      }
      var f = FRAME[s.n];
      var h = r.height / (f.feet - f.top);
      var w = h * VIDEO_RATIO;
      var top = r.bottom - f.feet * h;
      // cx — где по горизонтали в кадре стоит модель (0.5 — по центру)
      var left = r.left + r.width / 2 - w * (f.cx || 0.5);
      // в узком окне компьютера (около 768–1000 px) кадр уходил за край экрана и
      // модель обрезалась — прижимаем кадр к экрану. На телефоне (до 767 px) не трогаем.
      var vw = window.innerWidth;
      if (vw >= 768 && w < vw) left = Math.min(Math.max(left, 0), vw - w);
      s.video.style.display = '';
      s.video.style.width = w + 'px';
      s.video.style.height = h + 'px';
      s.video.style.top = top + 'px';
      s.video.style.left = left + 'px';
    });
  }

  function start() {
    if (running) return;
    running = true;
    var active = slots.filter(function (s) { return s.visible; });
    var left = active.length;
    if (!left) { running = false; return; }

    active.forEach(function (s, idx) {
      timers.push(setTimeout(function () {
        play(s).then(function () {
          left -= 1;
          if (left === 0) {
            timers.push(setTimeout(function () { running = false; }, COOLDOWN));
          }
        });
      }, idx * STEP_DELAY));
    });
  }

  function play(s) {
    return new Promise(function (resolve) {
      var v = s.video;
      var done = false;

      function finish() {
        if (done) return;
        done = true;
        v.removeEventListener('ended', finish);
        v.classList.remove('is-live');
        s.img.classList.remove('is-hidden');
        // вернуть ролик к первому кадру, когда он уже погас
        setTimeout(function () {
          try { v.pause(); v.currentTime = 0; } catch (e) { /* ничего */ }
          resolve();
        }, 650);
      }

      try { v.currentTime = 0; } catch (e) { /* ничего */ }
      v.addEventListener('ended', finish);
      var p = v.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          v.classList.add('is-live');
          s.img.classList.add('is-hidden');
        }).catch(finish);
      } else {
        v.classList.add('is-live');
        s.img.classList.add('is-hidden');
      }
    });
  }

  // Телефон/планшет: запуск, когда главная на экране и вкладка активна.
  function watchVisibility() {
    var scene = document.getElementById('scene');
    if (!scene || !('IntersectionObserver' in window)) {
      start();
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && !document.hidden) start();
      });
    }, { threshold: 0.3 });
    io.observe(scene);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) start();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
