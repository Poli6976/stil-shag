/* ============ Примеры готовых образов (how-it-works.html) ============
   Тянет список из api/reviews.js (action=list-looks) — публично, без входа.
   Управляются образы через admin-looks.html. Пока образов нет, весь блок
   прячем, а не показываем пустую сетку. */

(function () {
  var section = document.getElementById('looksSection');
  var grid = document.getElementById('looksGrid');
  if (!section || !grid) return;

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  fetch('api/reviews?action=list-looks')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var looks = (data && data.looks) || [];
      if (!looks.length) return;

      looks.forEach(function (look) {
        var figure = el('figure', 'look-card');
        var img = document.createElement('img');
        img.src = look.imageUrl;
        img.alt = look.caption;
        img.loading = 'lazy';
        var caption = el('figcaption');
        caption.textContent = look.caption;
        figure.appendChild(img);
        figure.appendChild(caption);
        grid.appendChild(figure);
      });

      section.style.display = '';
    })
    .catch(function (err) {
      console.error('looks-gallery: не удалось загрузить образы:', err);
    });
})();
