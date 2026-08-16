/*
  Походка, смена нарядов/причёсок и разворот силуэта.
  Все состояния выводятся из единственного параметра — прогресса скролла (0..1),
  ходьба идёт по пройденной "дистанции" скролла, а не по времени, поэтому при
  остановке скролла походка замирает на текущем кадре.
*/
(function (NS) {
  'use strict';

  var U = NS.Utils;
  var reduceMotion = false;

  // контрольные точки прогресса (0..1)
  var CP = { s1: 0.28, t12: 0.40, s2: 0.58, turn: 0.72, s3: 0.86, t34: 0.96 };
  var LEG_AMP = 22;
  var ARM_AMP = 16;
  var STEPS_PER_PAGE = 46;

  var el = {};

  function init(reduce) {
    reduceMotion = reduce;

    el.stage = document.getElementById('silhouette-stage');
    el.rig = document.getElementById('rig');
    el.legL = document.getElementById('leg-left');
    el.legR = document.getElementById('leg-right');
    el.armL = document.getElementById('arm-left');
    el.armR = document.getElementById('arm-right');
    el.pelvis = document.getElementById('pelvis-group');

    el.bottoms = document.querySelectorAll('[data-slot="bottom"]');
    el.tops = document.querySelectorAll('[data-slot="top"]');
    el.sleevesL = el.armL.querySelectorAll('[data-slot="sleeve"]');
    el.sleevesR = el.armR.querySelectorAll('[data-slot="sleeve"]');
    el.trouserL = el.legL.querySelector('[data-slot="trouser"]');
    el.trouserR = el.legR.querySelector('[data-slot="trouser"]');
    el.hair = document.querySelectorAll('[data-slot="hair"]');

    update(0);
  }

  // непрерывная "позиция наряда" от 1 до 4 вдоль всего пути
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

  function setOpacityByState(list, op) {
    list.forEach(function (node) {
      var n = parseFloat(node.getAttribute('data-state'));
      node.style.opacity = stateOpacity(op, n);
    });
  }

  function applyOutfit(progress) {
    var op = outfitPosition(progress);

    setOpacityByState(el.bottoms, op);
    setOpacityByState(el.tops, op);
    setOpacityByState(el.sleevesL, op);
    setOpacityByState(el.sleevesR, op);

    var trousers = stateOpacity(op, 3);
    el.trouserL.style.opacity = trousers;
    el.trouserR.style.opacity = trousers;

    var toBob = U.mapRange(progress, CP.s1, CP.t12);
    var toPixie = U.mapRange(progress, CP.s3, CP.t34);
    var ponytail = 1 - toBob;
    var bob = U.clamp01(toBob - toPixie);
    var pixie = toPixie;

    el.hair.forEach(function (node) {
      var state = node.getAttribute('data-state');
      var v = state === 'ponytail' ? ponytail : state === 'bob' ? bob : pixie;
      node.style.opacity = v;
    });
  }

  var MIN_EDGE_SCALE = 0.1; // силуэт никогда не схлопывается в полный ноль на развороте

  function applyFlip(progress) {
    var flip;
    if (progress <= CP.s2) {
      flip = 1;
    } else if (progress >= CP.turn) {
      flip = -1;
    } else if (reduceMotion) {
      flip = progress > (CP.s2 + CP.turn) / 2 ? -1 : 1;
    } else {
      var local = U.mapRange(progress, CP.s2, CP.turn);
      var raw = Math.cos(Math.PI * local);
      var sign = raw < 0 ? -1 : 1;
      flip = Math.abs(raw) < MIN_EDGE_SCALE ? sign * MIN_EDGE_SCALE : raw;
    }
    el.rig.style.transform = 'scaleX(' + flip.toFixed(3) + ')';
  }

  function applyWalkCycle(progress) {
    if (reduceMotion) {
      el.legL.style.transform = 'rotate(0deg)';
      el.legR.style.transform = 'rotate(0deg)';
      el.armL.style.transform = 'rotate(0deg)';
      el.armR.style.transform = 'rotate(0deg)';
      el.pelvis.style.transform = 'translateY(0) rotate(0deg)';
      return;
    }
    var phase = (progress * STEPS_PER_PAGE) % 1;
    var t = phase * Math.PI * 2;
    var legL = LEG_AMP * Math.sin(t);
    var legR = LEG_AMP * Math.sin(t + Math.PI);
    var armL = ARM_AMP * Math.sin(t + Math.PI);
    var armR = ARM_AMP * Math.sin(t);
    var pelvisRot = 4 * Math.sin(t);
    var bob = Math.sin(t * 2) * 2.4;

    el.legL.style.transform = 'rotate(' + legL.toFixed(2) + 'deg)';
    el.legR.style.transform = 'rotate(' + legR.toFixed(2) + 'deg)';
    el.armL.style.transform = 'rotate(' + armL.toFixed(2) + 'deg)';
    el.armR.style.transform = 'rotate(' + armR.toFixed(2) + 'deg)';
    el.pelvis.style.transform = 'translateY(' + bob.toFixed(2) + 'px) rotate(' + pelvisRot.toFixed(2) + 'deg)';
  }

  function applyPosition(progress) {
    var mobile = window.innerWidth < 768;
    var startVW = mobile ? 74 : 88;
    var endVW = mobile ? 16 : 6;
    var eased = U.easeInOutCubic(progress);
    var x = U.lerp(startVW, endVW, eased);
    var scale = U.lerp(mobile ? 0.8 : 1, mobile ? 0.7 : 0.86, eased);

    el.stage.style.left = x.toFixed(2) + 'vw';
    el.stage.style.setProperty('--stage-scale', scale.toFixed(3));
  }

  function update(progress) {
    applyOutfit(progress);
    applyFlip(progress);
    applyWalkCycle(progress);
    applyPosition(progress);
  }

  NS.Silhouette = { init: init, update: update };
})(window.Style = window.Style || {});
