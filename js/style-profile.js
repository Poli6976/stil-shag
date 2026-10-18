/* ============ Профиль стиля: подсказки в полях, оценки образов, блок «Мой стиль» ============
   ТЗ v5, разделы 7 и 10 (2026-10-18). Общий модуль для obraz-po-foto.html (js/wizard.js) и
   cabinet.html (js/saved-looks.js). Сервер — api/looks/saved.js (GET ?profile=1, POST {action}),
   хранение — lib/styleProfile.js. Все данные клиентки выводятся через textContent.
   Если таблицы профиля ещё не созданы (SQL из db/2026-10-18-style-profile.sql не запущен),
   запросы просто не удаются, и анкета с кабинетом работают как раньше — без подсказок. */

(function () {
  var REASONS = ['Цвет', 'Фасон', 'Не мой стиль', 'Не под повод', 'Слишком смело', 'Слишком скучно', 'Другое'];
  var ANSWER_LABELS = {
    hair: { title: 'Цвет волос', values: { blond: 'блонд', light_brown: 'русый', brown: 'каштановый', dark: 'тёмный', red: 'рыжий', grey: 'седой' } },
    metal: { title: 'Металл', values: { gold: 'золото', silver: 'серебро', both: 'и то и другое', unknown: 'не знаю' } },
    sun: { title: 'Кожа на солнце', values: { tan: 'быстро загораю', burn: 'скорее обгораю', unknown: 'не знаю' } },
    style: { title: 'Стиль', values: { classic: 'классика', casual: 'кэжуал', bold: 'смелые эксперименты' } }
  };

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

  function request(session, method, path, body) {
    var opts = { method: method, headers: { 'Authorization': 'Bearer ' + session.access_token } };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts)
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Не получилось.');
        return r.data;
      });
  }

  function getProfile(session) {
    return request(session, 'GET', 'api/looks/saved?profile=1');
  }

  function action(session, body) {
    return request(session, 'POST', 'api/looks/saved', body);
  }

  /* ---------- подсказки под полем (раздел 7) ----------
     options: getItems() → массив строк; onRemove(value) → Promise; onPick(value). */
  function attachSuggestions(input, options) {
    input.setAttribute('autocomplete', 'off');
    var wrap = input.parentNode;
    wrap.classList.add('sp-suggest-wrap');
    var list = el('ul', 'sp-suggest');
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);
    var activeIndex = -1;

    function items() { return (options.getItems() || []).slice(0, 5); }

    function render() {
      var values = items();
      list.innerHTML = '';
      activeIndex = -1;
      if (!values.length) { list.hidden = true; return; }
      values.forEach(function (value) {
        var li = el('li', 'sp-suggest__item');
        li.setAttribute('role', 'option');
        var pick = button('sp-suggest__pick', value);
        pick.addEventListener('mousedown', function (e) { e.preventDefault(); });
        pick.addEventListener('click', function () { choose(value); });
        var remove = button('sp-suggest__remove', '×');
        remove.setAttribute('aria-label', 'Убрать из подсказок: ' + value);
        remove.title = 'Убрать из подсказок';
        remove.addEventListener('mousedown', function (e) { e.preventDefault(); });
        remove.addEventListener('click', function () {
          li.remove();
          Promise.resolve(options.onRemove(value)).then(render, render);
        });
        li.appendChild(pick);
        li.appendChild(remove);
        list.appendChild(li);
      });
      list.hidden = false;
    }

    function choose(value) {
      input.value = value;
      list.hidden = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (options.onPick) options.onPick(value);
    }

    function highlight(i) {
      var nodes = list.querySelectorAll('.sp-suggest__item');
      if (!nodes.length) return;
      activeIndex = (i + nodes.length) % nodes.length;
      Array.prototype.forEach.call(nodes, function (n, idx) { n.classList.toggle('is-active', idx === activeIndex); });
    }

    input.addEventListener('focus', render);
    input.addEventListener('click', function () { if (list.hidden) render(); });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 120); });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(activeIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(activeIndex - 1); }
      else if (e.key === 'Enter' && activeIndex >= 0) { e.preventDefault(); choose(items()[activeIndex]); }
      else if (e.key === 'Escape') { list.hidden = true; }
    });
    return { refresh: render };
  }

  /* ---------- оценка образа (раздел 10, п. 1) ---------- */
  function renderRating(container, session, lookId, initial) {
    var box = el('div', 'sp-rate');
    var current = initial || null;
    var title = el('div', 'sp-rate__title', 'Как вам образ?');
    var row = el('div', 'sp-rate__row');
    var likeBtn = button('sp-rate__btn', '♥ Нравится');
    var dislikeBtn = button('sp-rate__btn', 'Не моё');
    row.appendChild(likeBtn);
    row.appendChild(dislikeBtn);
    var details = el('div', 'sp-rate__details');
    details.hidden = true;
    var status = el('p', 'sp-rate__status');
    status.setAttribute('aria-live', 'polite');

    var reasons = (current && current.reasons) ? current.reasons.slice() : [];
    details.appendChild(el('p', 'sp-rate__hint', 'Что не так? Можно отметить несколько.'));
    var chips = el('div', 'sp-rate__chips');
    REASONS.forEach(function (reason) {
      var chip = button('sp-rate__chip' + (reasons.indexOf(reason) !== -1 ? ' is-selected' : ''), reason, function () {
        var i = reasons.indexOf(reason);
        if (i === -1) reasons.push(reason); else reasons.splice(i, 1);
        chip.classList.toggle('is-selected', i === -1);
        chip.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
        commentInput.hidden = reasons.indexOf('Другое') === -1;
      });
      chip.setAttribute('aria-pressed', reasons.indexOf(reason) !== -1 ? 'true' : 'false');
      chips.appendChild(chip);
    });
    details.appendChild(chips);
    var commentInput = el('input', 'sp-rate__comment');
    commentInput.type = 'text';
    commentInput.maxLength = 300;
    commentInput.placeholder = 'Коротко, что не так';
    commentInput.hidden = reasons.indexOf('Другое') === -1;
    details.appendChild(commentInput);
    var saveBtn = button('sp-rate__save', 'Сохранить', function () { send('dislike'); });
    details.appendChild(saveBtn);

    function paint() {
      likeBtn.classList.toggle('is-selected', !!current && current.rating === 'like');
      dislikeBtn.classList.toggle('is-selected', !!current && current.rating === 'dislike');
      likeBtn.setAttribute('aria-pressed', current && current.rating === 'like' ? 'true' : 'false');
      dislikeBtn.setAttribute('aria-pressed', current && current.rating === 'dislike' ? 'true' : 'false');
    }

    function send(rating) {
      var payload = { action: 'rate', lookId: lookId, rating: rating };
      if (rating === 'dislike') { payload.reasons = reasons; payload.comment = commentInput.value; }
      status.textContent = 'Сохраняем…';
      return action(session, payload)
        .then(function () {
          current = rating ? { rating: rating, reasons: rating === 'dislike' ? reasons.slice() : [] } : null;
          paint();
          details.hidden = true;
          status.textContent = rating ? 'Спасибо, учтём в следующих образах.' : 'Оценка снята.';
          if (container.__onRated) container.__onRated(current);
        })
        .catch(function (err) { status.textContent = err.message || 'Не получилось сохранить оценку.'; });
    }

    likeBtn.addEventListener('click', function () {
      send(current && current.rating === 'like' ? null : 'like');
    });
    dislikeBtn.addEventListener('click', function () {
      details.hidden = !details.hidden;
      if (!details.hidden) status.textContent = '';
    });

    box.appendChild(title);
    box.appendChild(row);
    box.appendChild(details);
    box.appendChild(status);
    container.appendChild(box);
    paint();
    return box;
  }

  /* ---------- блок «Мой стиль» в кабинете (раздел 10, п. 6) ---------- */
  function renderCabinet(session) {
    var section = document.getElementById('styleProfileSection');
    var root = document.getElementById('styleProfileRoot');
    if (!section || !root) return;
    section.style.display = 'block';
    root.innerHTML = '';
    root.appendChild(el('p', 'wardrobe-empty', 'Загружаем…'));

    function draw(data) {
      var profile = data.profile || {};
      var ratings = data.ratings || { likes: 0, dislikes: 0, reasons: {} };
      root.innerHTML = '';

      var consentWrap = el('label', 'sp-consent');
      var consent = document.createElement('input');
      consent.type = 'checkbox';
      consent.checked = !!profile.remember;
      consentWrap.appendChild(consent);
      consentWrap.appendChild(el('span', null,
        'Запоминать мои ответы и подсказки, чтобы следующие образы собирались быстрее и точнее. ' +
        'Если снять галочку, сохранённые ответы и подсказки удалятся.'));
      consent.addEventListener('change', function () {
        consent.disabled = true;
        action(session, { action: 'set-remember', value: consent.checked })
          .then(function () { return getProfile(session); })
          .then(draw)
          .catch(function () { consent.checked = !consent.checked; consent.disabled = false; });
      });
      root.appendChild(consentWrap);

      var grid = el('div', 'sp-cabinet');

      var likes = el('div', 'sp-card');
      likes.appendChild(el('h3', 'sp-card__title', 'Ваши оценки'));
      if (!ratings.likes && !ratings.dislikes) {
        likes.appendChild(el('p', 'sp-card__empty', 'Пока нет оценок. Отмечайте «Нравится» или «Не моё» под образами — так сервис запоминает ваш вкус.'));
      } else {
        likes.appendChild(el('p', 'sp-card__line', 'Понравилось: ' + ratings.likes + ' · Не моё: ' + ratings.dislikes));
        var top = Object.keys(ratings.reasons || {}).sort(function (a, b) { return ratings.reasons[b] - ratings.reasons[a]; });
        if (top.length) {
          likes.appendChild(el('p', 'sp-card__line', 'Чаще всего не нравится: ' + top.slice(0, 3).map(function (r) {
            return r.toLowerCase() + ' (' + ratings.reasons[r] + ')';
          }).join(', ')));
        }
      }
      grid.appendChild(likes);

      var answersCard = el('div', 'sp-card');
      answersCard.appendChild(el('h3', 'sp-card__title', 'Ответы с прошлого раза'));
      var answers = profile.answers || {};
      var keys = Object.keys(ANSWER_LABELS).filter(function (k) { return answers[k]; });
      if (!keys.length) {
        answersCard.appendChild(el('p', 'sp-card__empty', profile.remember
          ? 'Появятся после следующего образа — и анкета будет заполняться сама.'
          : 'Включите запоминание выше, чтобы не отвечать на одни и те же вопросы каждый раз.'));
      } else {
        var ul = el('ul', 'sp-list');
        keys.forEach(function (k) {
          var li = el('li', 'sp-list__item');
          li.appendChild(el('span', null, ANSWER_LABELS[k].title + ': ' + (ANSWER_LABELS[k].values[answers[k]] || answers[k])));
          var x = button('sp-list__remove', '×', function () {
            action(session, { action: 'forget-answer', key: k }).then(function () { return getProfile(session); }).then(draw);
          });
          x.setAttribute('aria-label', 'Забыть: ' + ANSWER_LABELS[k].title);
          li.appendChild(x);
          ul.appendChild(li);
        });
        answersCard.appendChild(ul);
      }
      grid.appendChild(answersCard);

      var sugg = el('div', 'sp-card');
      sugg.appendChild(el('h3', 'sp-card__title', 'Подсказки в полях анкеты'));
      var all = (profile.fitHistory || []).map(function (v) { return { kind: 'fit', value: v, label: 'Рост и размер' }; })
        .concat((profile.itemHistory || []).map(function (v) { return { kind: 'item', value: v, label: 'Вещь' }; }));
      if (!all.length) {
        sugg.appendChild(el('p', 'sp-card__empty', 'Пока пусто. После каждого образа здесь сохраняются последние значения полей «Рост и размер» и «Вещь».'));
      } else {
        var sl = el('ul', 'sp-list');
        all.forEach(function (s) {
          var li = el('li', 'sp-list__item');
          li.appendChild(el('span', null, s.label + ': ' + s.value));
          var x = button('sp-list__remove', '×', function () {
            action(session, { action: 'forget-suggestion', kind: s.kind, value: s.value }).then(function () { return getProfile(session); }).then(draw);
          });
          x.setAttribute('aria-label', 'Убрать из подсказок: ' + s.value);
          li.appendChild(x);
          sl.appendChild(li);
        });
        sugg.appendChild(sl);
        sugg.appendChild(button('sp-link', 'Очистить подсказки', function () {
          action(session, { action: 'clear-suggestions' }).then(function () { return getProfile(session); }).then(draw);
        }));
      }
      grid.appendChild(sugg);
      root.appendChild(grid);

      root.appendChild(button('sp-link sp-link--danger', 'Сбросить всё: ответы, подсказки и оценки', function () {
        var ask = window.stilSavedLooks && window.stilSavedLooks.confirmDialog
          ? window.stilSavedLooks.confirmDialog('Сбросить «Мой стиль»?', 'Удалятся сохранённые ответы, подсказки и все оценки образов. Сами образы останутся.', 'Сбросить')
          : Promise.resolve(window.confirm('Сбросить ответы, подсказки и оценки?'));
        ask.then(function (yes) {
          if (!yes) return;
          action(session, { action: 'reset-profile' }).then(function () { return getProfile(session); }).then(draw);
        });
      }));
    }

    getProfile(session).then(draw).catch(function () {
      root.innerHTML = '';
      root.appendChild(el('p', 'wardrobe-empty', 'Раздел «Мой стиль» пока недоступен.'));
    });
  }

  window.stilStyleProfile = {
    getProfile: getProfile,
    action: action,
    attachSuggestions: attachSuggestions,
    renderRating: renderRating,
    renderCabinet: renderCabinet
  };
})();
