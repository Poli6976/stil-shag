/* ============ «Мои образы» — сохранённые результаты "Образа по фото" ============
   Загружается и удаляется через api/looks/saved.js. Сессию не запрашивает сама —
   её передаёт js/wallet.js через window.stilSavedLooks.load(session) при каждом
   входе/выходе (setLoggedInUI в wallet.js), поэтому раздел всегда актуален,
   а не только на первой загрузке страницы. */

(function () {
  var LAYER_LABELS = ['Верх', 'Низ', 'Верхняя одежда', 'Обувь', 'Аксессуары', 'Причёска', 'Макияж'];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function authedFetch(session, path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, {
      'Authorization': 'Bearer ' + session.access_token
    });
    return fetch(path, options);
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function renderEmpty(grid) {
    grid.innerHTML = '';
    grid.appendChild(el('p', 'wardrobe-empty', 'Сохранённых образов пока нет — соберите первый на странице «Образ по фото».'));
  }

  function renderCard(session, grid, look) {
    var card = el('div', 'saved-look-card');

    if (look.imageUrl) {
      var img = document.createElement('img');
      img.className = 'saved-look-card__image';
      img.src = look.imageUrl;
      img.alt = 'Сохранённый образ';
      card.appendChild(img);
    }

    var body = el('div', 'saved-look-card__body');
    body.appendChild(el('div', 'saved-look-card__date', formatDate(look.createdAt)));

    var layers = look.layers || {};
    var layersText = LAYER_LABELS
      .filter(function (key) { return layers[key]; })
      .map(function (key) { return key + ': ' + layers[key]; })
      .join(' · ');
    if (layersText) body.appendChild(el('p', 'saved-look-card__layers', layersText));

    var deleteBtn = el('button', 'saved-look-card__delete', 'Удалить');
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', function () {
      if (!window.confirm('Удалить этот образ безвозвратно? Отменить это действие нельзя.')) return;
      deleteBtn.setAttribute('disabled', '');
      authedFetch(session, 'api/looks/saved?id=' + encodeURIComponent(look.id), { method: 'DELETE' })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error((r.data && r.data.error) || 'Не получилось удалить образ.');
          card.remove();
          if (!grid.children.length) renderEmpty(grid);
        })
        .catch(function (err) {
          window.alert(err.message || 'Не получилось удалить образ. Попробуйте ещё раз.');
          deleteBtn.removeAttribute('disabled');
        });
    });
    body.appendChild(deleteBtn);

    card.appendChild(body);
    grid.appendChild(card);
  }

  /* Растёт при каждом вызове load() — если пока летит старый запрос придёт
     новый (например, повторное срабатывание onAuthStateChange), ответ
     устаревшего запроса не должен дорисовывать карточки поверх свежего —
     раньше оба ответа просто накладывались друг на друга в одну сетку. */
  var loadToken = 0;

  function load(session) {
    var section = document.getElementById('savedLooksSection');
    var grid = document.getElementById('savedLooksGrid');
    if (!section || !grid) return;
    section.style.display = 'block';
    grid.innerHTML = '';

    var myToken = ++loadToken;

    authedFetch(session, 'api/looks/saved')
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (myToken !== loadToken) return;
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Не получилось загрузить образы.');
        var looks = r.data.looks || [];
        if (!looks.length) { renderEmpty(grid); return; }
        looks.forEach(function (look) { renderCard(session, grid, look); });
      })
      .catch(function () {
        if (myToken !== loadToken) return;
        grid.innerHTML = '';
        grid.appendChild(el('p', 'wardrobe-empty', 'Не получилось загрузить сохранённые образы.'));
      });
  }

  window.stilSavedLooks = { load: load };
})();
