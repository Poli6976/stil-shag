/* ============ Подсветка текущей страницы в шапке и футере ============ */
(function () {
  var path = location.pathname.split('/').pop() || 'index.html';
  var links = document.querySelectorAll('.page-header__nav a, .site-footer a');
  links.forEach(function (a) {
    if (a.getAttribute('href') === path) a.classList.add('is-active');
  });
})();
