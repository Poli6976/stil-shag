/*
  Кометы на canvas. Независимый от скролла, времязависимый модуль:
  редкий рандомный спавн, полупрозрачный хвост-градиент, пауза на скрытой
  вкладке и полное отключение при prefers-reduced-motion.
*/
(function (NS) {
  'use strict';

  var canvas, ctx, w, h, dpr;
  var comets = [];
  var rafId = null;
  var running = false;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawnComet() {
    var fromLeft = Math.random() < 0.5;
    var startX = fromLeft ? -40 : w + 40;
    var startY = Math.random() * h * 0.55;
    var speed = 3.2 + Math.random() * 2.4;
    var baseAngle = 0.35 + Math.random() * 0.25;
    var angle = fromLeft ? baseAngle : Math.PI - baseAngle;

    comets.push({
      x: startX,
      y: startY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      len: 90 + Math.random() * 60,
      alpha: 0
    });
  }

  function scheduleSpawn() {
    var delay = 7000 + Math.random() * 8000;
    setTimeout(function () {
      if (running && comets.length < 2) spawnComet();
      scheduleSpawn();
    }, delay);
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (var i = comets.length - 1; i >= 0; i--) {
      var c = comets[i];
      c.x += c.vx;
      c.y += c.vy;
      c.alpha = Math.min(1, c.alpha + 0.04);

      var mag = Math.hypot(c.vx, c.vy) || 1;
      var tailX = c.x - (c.vx / mag) * c.len;
      var tailY = c.y - (c.vy / mag) * c.len;

      var grad = ctx.createLinearGradient(c.x, c.y, tailX, tailY);
      grad.addColorStop(0, 'rgba(244,242,251,' + (0.9 * c.alpha) + ')');
      grad.addColorStop(0.4, 'rgba(227,189,103,' + (0.32 * c.alpha) + ')');
      grad.addColorStop(1, 'rgba(227,189,103,0)');

      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,' + c.alpha + ')';
      ctx.arc(c.x, c.y, 1.7, 0, Math.PI * 2);
      ctx.fill();

      if (c.x < -80 || c.x > w + 80 || c.y > h + 80) {
        comets.splice(i, 1);
      }
    }
  }

  function loop() {
    if (!running) return;
    draw();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    loop();
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }

  function init(reduceMotion) {
    canvas = document.getElementById('comet-canvas');
    if (!canvas || reduceMotion) return;
    ctx = canvas.getContext('2d');
    resize();

    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    scheduleSpawn();
    start();
  }

  NS.Starfield = { init: init };
})(window.Style = window.Style || {});
