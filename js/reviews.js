/* ============ Отзывы на how-it-works.html — подменяем примеры реальными ============
   Пока одобренных отзывов нет, в HTML остаются 3 статичных примера, честно
   подписанные «Пример» (см. api/reviews.js — отправка через личный кабинет,
   публикация только после ручного одобрения владельцем). Как только
   появляется хотя бы один реальный — подменяем всю сетку целиком, чтобы не
   мешать настоящие отзывы с примерами в одном ряду. При сбое запроса просто
   остаются примеры — ничего не ломается. */
(function () {
  var grid = document.querySelector('.review-grid');
  if (!grid) return;

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  fetch('api/reviews?action=list-approved')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.reviews || !data.reviews.length) return;

      var note = grid.parentElement.querySelector('.note');
      grid.innerHTML = '';
      data.reviews.forEach(function (r) {
        var card = document.createElement('div');
        card.className = 'review-card';
        card.innerHTML =
          '<blockquote>«' + escapeHtml(r.text) + '»</blockquote>' +
          '<cite>' + (r.age ? 'Клиентка, ' + parseInt(r.age, 10) + ' лет' : 'Клиентка') + '</cite>';
        grid.appendChild(card);
      });
      if (note) note.remove();
    })
    .catch(function () {});
})();
