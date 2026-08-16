/*
  Текст-эффект «точка -> надпись». Привязан к тому же окну прогресса, что и
  первая смена наряда (28-40% скролла), реализован через CSS custom property
  --reveal-progress и clip-path/opacity в css/home.css.
*/
(function (NS) {
  'use strict';

  var U = NS.Utils;
  var START = 0.28;
  var END = 0.40;

  function init() {}

  function update(progress) {
    var v = U.mapRange(progress, START, END);
    document.documentElement.style.setProperty('--reveal-progress', v.toFixed(4));
  }

  NS.TextReveal = { init: init, update: update };
})(window.Style = window.Style || {});
