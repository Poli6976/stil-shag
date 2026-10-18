/* ============ «Мои образы» — сохранённые результаты "Образа по фото" ============
   Загружается и удаляется через api/looks/saved.js. Сессию не запрашивает сама —
   её передаёт js/wallet.js через window.stilSavedLooks.load(session) при каждом
   входе/выходе (setLoggedInUI в wallet.js), поэтому раздел всегда актуален,
   а не только на первой загрузке страницы.

   2026-10-17 (ТЗ v5):
   - раздел 8 — удаление группой: галочка в левом верхнем углу фото, группы по месяцам
     («Выбрать все за месяц»), панель «Выбрано: N · Выбрать все · Снять выбор · Удалить
     выбранные», подтверждение в окне на странице (не window.confirm), один запрос
     DELETE api/looks/saved?ids=… ;
   - раздел 9 — по нажатию на фото оно открывается крупно (лайтбокс) с датой и слоями,
     листается стрелками/клавишами/смахиванием, закрывается крестиком/Esc/фоном/смахиванием вниз.
   Все данные клиентки выводятся через textContent. */

(function () {
  var LAYER_LABELS = ['Верх', 'Низ', 'Верхняя одежда', 'Обувь', 'Аксессуары', 'Причёска', 'Макияж'];
  /* Причёску и макияж в подпись для Telegram не берём — для поста это
     наименее интересные слои, а длинная простыня из всех 7 плохо читается
     как соцсеть-контент (см. обсуждение с пользователем). */
  var TELEGRAM_LAYER_LABELS = ['Верх', 'Низ', 'Верхняя одежда', 'Обувь', 'Аксессуары'];

  var state = {
    session: null,
    looks: [],
    selected: {},
    grid: null,
    toolbar: null
  };

  function buildTelegramCaption(look) {
    var layers = look.layers || {};
    var lines = TELEGRAM_LAYER_LABELS
      .filter(function (key) { return layers[key]; })
      .map(function (key) { return key + ': ' + layers[key]; });
    return 'Новый образ 👇\n' + lines.join('\n') +
      '\n\nСвою вещь разберём точно так же — 998 ₽, и два следующих образа бесплатно → https://stil-shag.ru/how-it-works.html';
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    var b = el('button', className, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
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

  function monthKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'unknown';
    return d.getFullYear() + '-' + (d.getMonth() + 1);
  }

  function monthTitle(iso) {
    try {
      var s = new Date(iso).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
      s = s.replace(/\s*г\.?$/, '');
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch (e) {
      return 'Без даты';
    }
  }

  /* «3 образа», «5 образов», «1 образ» */
  function looksWord(n) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return n + ' образ';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return n + ' образа';
    return n + ' образов';
  }

  /* «· прогулка, осень» — служебный слой «Сезон» из анкеты (2026-10-19). */
  function seasonSuffix(look) {
    var s = look && look.layers && look.layers['Сезон'];
    return s ? ' · ' + s : '';
  }

  function layersText(look) {
    var layers = look.layers || {};
    return LAYER_LABELS
      .filter(function (key) { return layers[key]; })
      .map(function (key) { return key + ': ' + layers[key]; })
      .join(' · ');
  }

  /* ---------- тост внизу экрана ---------- */
  var toastTimer = null;
  function toast(text) {
    var node = document.getElementById('stilToast');
    if (!node) {
      node = el('div', 'stil-toast');
      node.id = 'stilToast';
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('is-visible'); }, 3500);
  }

  /* ---------- окно подтверждения на странице ---------- */
  function confirmDialog(title, text, confirmLabel) {
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var overlay = el('div', 'stil-modal');
      var box = el('div', 'stil-modal__box');
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      var h = el('h3', 'stil-modal__title', title);
      h.id = 'stilModalTitle';
      box.setAttribute('aria-labelledby', 'stilModalTitle');
      box.appendChild(h);
      box.appendChild(el('p', 'stil-modal__text', text));
      var actions = el('div', 'stil-modal__actions');
      var cancel = button('stil-modal__cancel', 'Отмена');
      var ok = button('stil-modal__ok', confirmLabel || 'Удалить');
      actions.appendChild(cancel);
      actions.appendChild(ok);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      document.body.classList.add('stil-no-scroll');

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (!document.querySelector('.stil-lightbox')) document.body.classList.remove('stil-no-scroll');
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(false); }
        if (e.key === 'Tab') {
          e.preventDefault();
          (document.activeElement === ok ? cancel : ok).focus();
        }
      }
      cancel.addEventListener('click', function () { close(false); });
      ok.addEventListener('click', function () { close(true); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', onKey, true);
      cancel.focus();
    });
  }

  /* ---------- удаление ---------- */
  function deleteIds(ids) {
    var path = ids.length === 1
      ? 'api/looks/saved?id=' + encodeURIComponent(ids[0])
      : 'api/looks/saved?ids=' + ids.map(encodeURIComponent).join(',');
    return authedFetch(state.session, path, { method: 'DELETE' })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Не получилось удалить.');
        if (ids.length === 1) return ids;
        return Array.isArray(r.data.deleted) ? r.data.deleted : [];
      });
  }

  function askAndDelete(ids) {
    if (!ids.length) return Promise.resolve(false);
    var title = ids.length === 1 ? 'Удалить образ?' : 'Удалить ' + looksWord(ids.length) + '?';
    return confirmDialog(title, 'Фото, иллюстрации и описания удалятся безвозвратно.', 'Удалить')
      .then(function (yes) {
        if (!yes) return false;
        return deleteIds(ids).then(function (deleted) {
          var gone = {};
          deleted.forEach(function (id) { gone[id] = true; });
          state.looks = state.looks.filter(function (l) { return !gone[l.id]; });
          deleted.forEach(function (id) { delete state.selected[id]; });
          renderAll();
          if (deleted.length === ids.length) {
            toast(deleted.length === 1 ? 'Образ удалён' : 'Удалено образов: ' + deleted.length);
          } else {
            toast('Удалено образов: ' + deleted.length + ' из ' + ids.length + '. Остальные не удалось удалить — попробуйте ещё раз.');
          }
          return true;
        }).catch(function (err) {
          toast(err.message || 'Не получилось удалить. Попробуйте ещё раз.');
          return false;
        });
      });
  }

  /* ---------- выбор ---------- */
  function selectedIds() {
    return state.looks.filter(function (l) { return state.selected[l.id]; }).map(function (l) { return l.id; });
  }
  function selectionActive() { return selectedIds().length > 0; }

  function setSelected(ids, value) {
    ids.forEach(function (id) {
      if (value) state.selected[id] = true; else delete state.selected[id];
    });
    syncSelectionUI();
  }

  function syncSelectionUI() {
    var count = selectedIds().length;
    if (state.grid) {
      state.grid.classList.toggle('is-selecting', count > 0);
      Array.prototype.forEach.call(state.grid.querySelectorAll('.saved-look-card'), function (card) {
        var on = !!state.selected[card.getAttribute('data-id')];
        card.classList.toggle('is-selected', on);
        var cb = card.querySelector('.saved-look-card__check');
        if (cb) cb.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      Array.prototype.forEach.call(state.grid.querySelectorAll('.saved-looks-month'), function (group) {
        var ids = (group.getAttribute('data-ids') || '').split(',').filter(Boolean);
        var all = ids.length && ids.every(function (id) { return state.selected[id]; });
        var btn = group.querySelector('.saved-looks-month__select');
        if (btn) btn.textContent = all ? 'Снять выбор за месяц' : 'Выбрать все за месяц';
      });
    }
    if (state.toolbar) {
      state.toolbar.classList.toggle('is-active', count > 0);
      var label = state.toolbar.querySelector('.saved-looks-toolbar__count');
      if (label) label.textContent = count ? 'Выбрано: ' + count : 'Отметьте образы галочкой, чтобы удалить несколько сразу';
      var del = state.toolbar.querySelector('.saved-looks-toolbar__delete');
      var clear = state.toolbar.querySelector('.saved-looks-toolbar__clear');
      if (del) del.hidden = count === 0;
      if (clear) clear.hidden = count === 0;
      var all = state.toolbar.querySelector('.saved-looks-toolbar__all');
      if (all) all.textContent = count && count === state.looks.length ? 'Снять выбор со всех' : 'Выбрать все';
    }
  }

  function renderToolbar() {
    var bar = el('div', 'saved-looks-toolbar');
    bar.appendChild(el('span', 'saved-looks-toolbar__count'));
    var actions = el('div', 'saved-looks-toolbar__actions');
    actions.appendChild(button('saved-looks-toolbar__btn saved-looks-toolbar__all', 'Выбрать все', function () {
      var ids = state.looks.map(function (l) { return l.id; });
      var allOn = ids.every(function (id) { return state.selected[id]; });
      setSelected(ids, !allOn);
    }));
    actions.appendChild(button('saved-looks-toolbar__btn saved-looks-toolbar__clear', 'Снять выбор', function () {
      state.selected = {};
      syncSelectionUI();
    }));
    actions.appendChild(button('saved-looks-toolbar__btn saved-looks-toolbar__delete', 'Удалить выбранные', function () {
      askAndDelete(selectedIds());
    }));
    bar.appendChild(actions);
    return bar;
  }

  /* ---------- карточка ---------- */
  function renderCard(look, index) {
    var card = el('div', 'saved-look-card');
    card.setAttribute('data-id', look.id);

    var media = el('div', 'saved-look-card__media');
    var check = button('saved-look-card__check', '');
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', 'false');
    check.setAttribute('aria-label', 'Выбрать образ от ' + formatDate(look.createdAt));
    check.addEventListener('click', function (e) {
      e.stopPropagation();
      setSelected([look.id], !state.selected[look.id]);
    });
    media.appendChild(check);

    if (look.imageUrl) {
      var img = document.createElement('img');
      img.className = 'saved-look-card__image';
      img.src = look.imageUrl;
      img.alt = 'Образ от ' + formatDate(look.createdAt);
      img.loading = 'lazy';
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', 'Открыть фото крупно');
      function onActivate() {
        /* В режиме выбора нажатие на фото ставит/снимает галочку (ТЗ, раздел 9, п. 8). */
        if (selectionActive()) { setSelected([look.id], !state.selected[look.id]); return; }
        openLightbox(index);
      }
      img.addEventListener('click', onActivate);
      img.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
      });
      media.appendChild(img);
    } else {
      media.appendChild(el('div', 'saved-look-card__noimage', 'Без картинки'));
    }
    card.appendChild(media);

    var body = el('div', 'saved-look-card__body');
    var dateLine = el('div', 'saved-look-card__date', formatDate(look.createdAt) + seasonSuffix(look));
    if (look.rating) {
      dateLine.appendChild(el('span', 'saved-look-card__rating' + (look.rating.rating === 'like' ? ' is-like' : ''),
        look.rating.rating === 'like' ? ' · ♥ нравится' : ' · не моё'));
    }
    body.appendChild(dateLine);
    var text = layersText(look);
    if (text) body.appendChild(el('p', 'saved-look-card__layers', text));

    var actions = el('div', 'saved-look-card__actions');
    actions.appendChild(telegramButton(look, 'saved-look-card__copy'));
    actions.appendChild(button('saved-look-card__delete', 'Удалить', function () { askAndDelete([look.id]); }));
    body.appendChild(actions);

    card.appendChild(body);
    return card;
  }

  function telegramButton(look, className) {
    var copyBtn = button(className, 'Для Telegram');
    copyBtn.addEventListener('click', function () {
      var caption = buildTelegramCaption(look);
      copyToClipboard(caption)
        .then(function () {
          var original = copyBtn.textContent;
          copyBtn.textContent = 'Скопировано — сохраните фото ↑';
          setTimeout(function () { copyBtn.textContent = original; }, 3000);
        })
        .catch(function () {
          toast('Не получилось скопировать автоматически — выделите текст образа вручную.');
        });
    });
    return copyBtn;
  }

  function renderEmpty(grid) {
    grid.innerHTML = '';
    grid.appendChild(el('p', 'wardrobe-empty', 'Сохранённых образов пока нет — соберите первый на странице «Образ по фото».'));
  }

  function renderAll() {
    var grid = state.grid;
    if (!grid) return;
    grid.innerHTML = '';
    if (state.toolbar) { state.toolbar.remove(); state.toolbar = null; }
    if (!state.looks.length) { renderEmpty(grid); return; }

    state.toolbar = renderToolbar();
    grid.parentNode.insertBefore(state.toolbar, grid);

    var groups = [];
    var byKey = {};
    state.looks.forEach(function (look, i) {
      var key = monthKey(look.createdAt);
      if (!byKey[key]) {
        byKey[key] = { title: monthTitle(look.createdAt), items: [] };
        groups.push(byKey[key]);
      }
      byKey[key].items.push({ look: look, index: i });
    });

    groups.forEach(function (g) {
      var section = el('div', 'saved-looks-month');
      section.setAttribute('data-ids', g.items.map(function (it) { return it.look.id; }).join(','));
      var head = el('div', 'saved-looks-month__head');
      head.appendChild(el('h3', 'saved-looks-month__title', g.title + ' · ' + looksWord(g.items.length)));
      head.appendChild(button('saved-looks-month__select', 'Выбрать все за месяц', function () {
        var ids = g.items.map(function (it) { return it.look.id; });
        var allOn = ids.every(function (id) { return state.selected[id]; });
        setSelected(ids, !allOn);
      }));
      section.appendChild(head);
      var cards = el('div', 'saved-looks-month__grid');
      g.items.forEach(function (it) { cards.appendChild(renderCard(it.look, it.index)); });
      section.appendChild(cards);
      grid.appendChild(section);
    });

    syncSelectionUI();
  }

  /* ---------- лайтбокс (ТЗ, раздел 9) ---------- */
  function openLightbox(startIndex) {
    var withImages = state.looks.filter(function (l) { return l.imageUrl; });
    if (!withImages.length) return;
    var current = withImages.indexOf(state.looks[startIndex]);
    if (current < 0) current = 0;
    var prevFocus = document.activeElement;

    var overlay = el('div', 'stil-lightbox');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Образ крупно');

    var closeBtn = button('stil-lightbox__close', '×');
    closeBtn.setAttribute('aria-label', 'Закрыть');
    var prevBtn = button('stil-lightbox__nav stil-lightbox__nav--prev', '‹');
    prevBtn.setAttribute('aria-label', 'Предыдущий образ');
    var nextBtn = button('stil-lightbox__nav stil-lightbox__nav--next', '›');
    nextBtn.setAttribute('aria-label', 'Следующий образ');

    var stage = el('div', 'stil-lightbox__stage');
    var figure = el('div', 'stil-lightbox__figure');
    var img = document.createElement('img');
    img.className = 'stil-lightbox__image';
    figure.appendChild(img);
    stage.appendChild(figure);

    var info = el('div', 'stil-lightbox__info');
    var date = el('div', 'stil-lightbox__date');
    var counter = el('div', 'stil-lightbox__counter');
    var list = el('dl', 'stil-lightbox__layers');
    var why = el('p', 'stil-lightbox__why');
    var rateBox = el('div', 'stil-lightbox__rate');
    var actions = el('div', 'stil-lightbox__actions');
    info.appendChild(date);
    info.appendChild(counter);
    info.appendChild(list);
    info.appendChild(why);
    info.appendChild(rateBox);
    info.appendChild(actions);

    var panel = el('div', 'stil-lightbox__panel');
    panel.appendChild(stage);
    panel.appendChild(info);

    overlay.appendChild(panel);
    overlay.appendChild(prevBtn);
    overlay.appendChild(nextBtn);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);
    document.body.classList.add('stil-no-scroll');

    function show(i) {
      current = (i + withImages.length) % withImages.length;
      var look = withImages[current];
      figure.classList.remove('is-zoomed');
      img.src = look.imageUrl;
      img.alt = 'Образ от ' + formatDate(look.createdAt);
      date.textContent = formatDate(look.createdAt) + seasonSuffix(look);
      counter.textContent = withImages.length > 1 ? (current + 1) + ' из ' + withImages.length : '';
      list.innerHTML = '';
      var layers = look.layers || {};
      LAYER_LABELS.forEach(function (key) {
        if (!layers[key]) return;
        list.appendChild(el('dt', null, key));
        list.appendChild(el('dd', null, layers[key]));
      });
      why.textContent = look.why || '';
      why.hidden = !look.why;
      rateBox.innerHTML = '';
      if (window.stilStyleProfile) {
        rateBox.__onRated = function (rating) { look.rating = rating; renderAll(); };
        window.stilStyleProfile.renderRating(rateBox, state.session, look.id, look.rating || null);
      }
      actions.innerHTML = '';
      actions.appendChild(telegramButton(look, 'saved-look-card__copy'));
      actions.appendChild(button('saved-look-card__delete', 'Удалить', function () {
        askAndDelete([look.id]).then(function (done) {
          if (!done) return;
          withImages = withImages.filter(function (l) { return l.id !== look.id; });
          if (!withImages.length) { close(); return; }
          show(current);
        });
      }));
      prevBtn.hidden = nextBtn.hidden = withImages.length < 2;
    }

    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (!document.querySelector('.stil-modal')) document.body.classList.remove('stil-no-scroll');
      if (prevFocus && prevFocus.focus && document.body.contains(prevFocus)) prevFocus.focus();
    }

    function onKey(e) {
      if (document.querySelector('.stil-modal')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') show(current - 1);
      else if (e.key === 'ArrowRight') show(current + 1);
    }

    closeBtn.addEventListener('click', close);
    prevBtn.addEventListener('click', function () { show(current - 1); });
    nextBtn.addEventListener('click', function () { show(current + 1); });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target === panel || e.target === stage) close();
    });
    /* Клик по фото на компьютере — приближение в 2 раза и обратно. */
    img.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
      figure.classList.toggle('is-zoomed');
      if (figure.classList.contains('is-zoomed')) {
        var r = img.getBoundingClientRect();
        img.style.transformOrigin = ((e.clientX - r.left) / r.width * 100) + '% ' + ((e.clientY - r.top) / r.height * 100) + '%';
      }
    });

    /* Смахивания на телефоне: влево/вправо — листать, вниз — закрыть. Двумя пальцами — штатное
       приближение браузера, его не перехватываем. */
    var touchStart = null;
    stage.addEventListener('touchstart', function (e) {
      touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (!touchStart || !e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - touchStart.x;
      var dy = e.changedTouches[0].clientY - touchStart.y;
      touchStart = null;
      if (window.visualViewport && window.visualViewport.scale > 1.05) return;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(current + (dx < 0 ? 1 : -1));
      else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) close();
    }, { passive: true });

    document.addEventListener('keydown', onKey);
    show(current);
    closeBtn.focus();
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
    state.session = session;
    state.grid = grid;
    state.looks = [];
    state.selected = {};
    if (state.toolbar) { state.toolbar.remove(); state.toolbar = null; }

    var myToken = ++loadToken;

    authedFetch(session, 'api/looks/saved')
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (myToken !== loadToken) return;
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Не получилось загрузить образы.');
        state.looks = r.data.looks || [];
        renderAll();
        if (window.stilStyleProfile) window.stilStyleProfile.renderCabinet(session);
      })
      .catch(function () {
        if (myToken !== loadToken) return;
        grid.innerHTML = '';
        grid.appendChild(el('p', 'wardrobe-empty', 'Не получилось загрузить сохранённые образы.'));
      });
  }

  window.stilSavedLooks = { load: load, confirmDialog: confirmDialog, toast: toast };
})();
