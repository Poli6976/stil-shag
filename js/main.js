/*
  Точка входа: определяет prefers-reduced-motion и инициализирует
  независимый от скролла модуль звёздного фона.
*/
(function (NS) {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    NS.Starfield.init(reduceMotion);
  });
})(window.Style = window.Style || {});
