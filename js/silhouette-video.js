/*
  Силуэт из видео-клипов DaVinci (вариант 1). Четыре клипа "ходьба на месте"
  на сплошном хромакей-фоне (#FF00FF), фон вырезается на лету через canvas
  (getImageData/putImageData). Композиция и переходы между образами повторяют
  ту же checkpoint-математику, что и SVG-вариант в js/silhouette.js — только
  вместо переключения непрозрачности <g>-слоёв здесь смешиваются кадры видео.

  Ожидаемые файлы (кладутся пользователем в assets/silhouette/):
    state-1.mp4 — юбка-карандаш
    state-2.mp4 — костюм, юбка до середины бедра
    state-3.mp4 — брючный костюм, жакет без рукавов (после разворота)
    state-4.mp4 — плиссе, блузка, причёска "под мальчика"
  Пока файла нет/он не загрузился — соответствующий кадр просто не рисуется
  (без ошибок в консоли).
*/
(function (NS) {
  'use strict';

  var U = NS.Utils;

  var CP = { s1: 0.28, t12: 0.40, s2: 0.58, turn: 0.72, s3: 0.86, t34: 0.96 };
  var STATE_FILES = {
    1: 'assets/silhouette/state-1.mp4',
    2: 'assets/silhouette/state-2.mp4',
    3: 'assets/silhouette/state-3.mp4',
    4: 'assets/silhouette/state-4.mp4'
  };

  var KEY = { r: 255, g: 0, b: 255 }; // пурпурный хромакей
  var THRESHOLD = 90;
  var FEATHER = 40;
  var MIN_EDGE_SCALE = 0.08;

  var OFF_W = 240, OFF_H = 480;

  var reduceMotion = false;
  var stageEl, canvas, ctx;
  var videos = {}, offCanvases = {}, offCtx = {};
  var ready = {}, failed = {};
  var rafId = null;

  function outfitPosition(p) {
    if (p <= CP.s1) return 1;
    if (p <= CP.t12) return 1 + U.mapRange(p, CP.s1, CP.t12);
    if (p <= CP.s2) return 2;
    if (p <= CP.turn) return 2 + U.mapRange(p, CP.s2, CP.turn);
    if (p <= CP.s3) return 3;
    if (p <= CP.t34) return 3 + U.mapRange(p, CP.s3, CP.t34);
    return 4;
  }

  function stateOpacity(op, n) {
    return U.clamp01(1 - Math.abs(op - n));
  }

  function computeFlip(progress) {
    if (progress <= CP.s2) return 1;
    if (progress >= CP.turn) return -1;
    if (reduceMotion) return progress > (CP.s2 + CP.turn) / 2 ? -1 : 1;
    var local = U.mapRange(progress, CP.s2, CP.turn);
    var raw = Math.cos(Math.PI * local);
    var sign = raw < 0 ? -1 : 1;
    return Math.abs(raw) < MIN_EDGE_SCALE ? sign * MIN_EDGE_SCALE : raw;
  }

  function applyPosition(progress) {
    var mobile = window.innerWidth < 768;
    var startVW = mobile ? 74 : 88;
    var endVW = mobile ? 16 : 6;
    var eased = U.easeInOutCubic(progress);
    var x = U.lerp(startVW, endVW, eased);
    var scale = U.lerp(mobile ? 0.8 : 1, mobile ? 0.7 : 0.86, eased);

    stageEl.style.left = x.toFixed(2) + 'vw';
    stageEl.style.setProperty('--stage-scale', scale.toFixed(3));
  }

  function chromaKey(imageData) {
    var d = imageData.data;
    var t2 = THRESHOLD * THRESHOLD;
    var tf2 = (THRESHOLD + FEATHER) * (THRESHOLD + FEATHER);
    for (var i = 0; i < d.length; i += 4) {
      var dr = d[i] - KEY.r, dg = d[i + 1] - KEY.g, db = d[i + 2] - KEY.b;
      var distSq = dr * dr + dg * dg + db * db;
      if (distSq <= t2) {
        d[i + 3] = 0;
      } else if (distSq < tf2) {
        d[i + 3] = Math.round(d[i + 3] * ((distSq - t2) / (tf2 - t2)));
      }
    }
  }

  function setupVideo(n) {
    var v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    // видео должно быть частью документа, иначе браузер не станет
    // его декодировать - визуально прячем через position/opacity, не display:none
    v.style.position = 'absolute';
    v.style.width = '2px';
    v.style.height = '2px';
    v.style.opacity = '0';
    v.style.pointerEvents = 'none';
    document.body.appendChild(v);

    v.addEventListener('loadeddata', function () {
      ready[n] = true;
      v.play().catch(function () {});
    });
    v.addEventListener('error', function () {
      failed[n] = true;
    });

    v.src = STATE_FILES[n];
    videos[n] = v;

    var off = document.createElement('canvas');
    off.width = OFF_W;
    off.height = OFF_H;
    offCanvases[n] = off;
    offCtx[n] = off.getContext('2d', { willReadFrequently: true });
  }

  function render() {
    var progress = NS.ScrollEngine.getProgress();
    var op = outfitPosition(progress);
    var flip = computeFlip(progress);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, 0);
    ctx.scale(flip, 1);
    ctx.translate(-canvas.width / 2, 0);

    for (var n = 1; n <= 4; n++) {
      var weight = stateOpacity(op, n);
      if (weight <= 0.01 || !ready[n] || failed[n]) continue;

      var v = videos[n];
      if (v.readyState < 2) continue;

      var oc = offCtx[n];
      oc.drawImage(v, 0, 0, OFF_W, OFF_H);
      var frame = oc.getImageData(0, 0, OFF_W, OFF_H);
      chromaKey(frame);
      oc.putImageData(frame, 0, 0);

      ctx.globalAlpha = weight;
      ctx.drawImage(offCanvases[n], 0, 0, canvas.width, canvas.height);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(render);
  }

  function startLoop() {
    if (rafId) return;
    render();
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function scrollUpdate(progress) {
    applyPosition(progress);
  }

  function init(reduce) {
    reduceMotion = reduce;
    stageEl = document.getElementById('silhouette-stage');
    canvas = document.getElementById('silhouette-canvas');
    if (!stageEl || !canvas) return;

    canvas.width = OFF_W;
    canvas.height = OFF_H;
    ctx = canvas.getContext('2d');

    for (var n = 1; n <= 4; n++) setupVideo(n);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopLoop(); else startLoop();
    });

    applyPosition(0);
    startLoop();
  }

  NS.SilhouetteVideo = { init: init, update: scrollUpdate };
})(window.Style = window.Style || {});
