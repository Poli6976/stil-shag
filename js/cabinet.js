/* ============ Личный кабинет: демо на localStorage (гардероб) + статус кода партнёра ============
   Реальной авторизации у гардероба и счётчика образов по-прежнему нет (это
   демо на localStorage под ключами "stil.*", пропадёт при очистке браузера).
   Счётчик "stil.styleCount" растёт в js/wizard.js при каждом завершении визарда.

   Код от партнёра — НЕ демо: POST на /api/redeem-code (проверка подписи —
   lib/partnerCode.js) требует входа через настоящий аккаунт (js/wallet.js,
   Supabase) и записывает погашение в таблицу discount_credits (см.
   db/schema.sql) с уникальным индексом на код. Поэтому один код даёт ровно
   один образ за 370 ₽ вместо 590 ₽ — повторно погасить его (в том числе в другом
   браузере) нельзя, а сам код гасится при оплате образа (api/payments/webhook.js,
   ТЗ «Новые цены» v8). Статус кода ниже запрашивается у сервера
   (api/wallet/summary), а не хранится в localStorage. */

(function () {
  /* Robokassa после оплаты (или отказа) возвращает в личный кабинет (SuccessURL/FailURL настроены
     статично). Если анкета «Образа по фото» ждёт этой оплаты — сразу продолжаем её там
     (js/wizard.js, ключ stil.pendingLook, срок — 3 часа). */
  try {
    var pendingLook = JSON.parse(localStorage.getItem('stil.pendingLook') || 'null');
    if (pendingLook && pendingLook.orderId && Date.now() - (pendingLook.at || 0) < 3 * 60 * 60 * 1000) {
      window.location.replace('obraz-po-foto.html');
      return;
    }
  } catch (e) {}

  var WARDROBE_KEY = 'stil.wardrobe';
  var COUNT_KEY = 'stil.styleCount';

  function readWardrobe() {
    try {
      var raw = localStorage.getItem(WARDROBE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeWardrobe(items) {
    try { localStorage.setItem(WARDROBE_KEY, JSON.stringify(items)); } catch (e) {}
  }

  function readCount() {
    try { return parseInt(localStorage.getItem(COUNT_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderStatus() {
    var root = document.getElementById('cabinetStatus');
    if (!root) return;
    var count = readCount();
    root.innerHTML = '';

    var countLine = el('div', 'cabinet-status__count', count === 0
      ? 'Вы ещё не собирали образ'
      : 'Образов собрано: ' + count);
    root.appendChild(countLine);

    var msg = el('p', 'cabinet-status__msg');
    root.appendChild(msg);

    msg.innerHTML = 'Образ — 590 ₽, в пакете — от 370 ₽. <a href="obraz-po-foto.html">Собрать образ →</a>';

    if (!window.stilAuth) return;
    window.stilAuth.getSession()
      .then(function (session) {
        if (!session) return null;
        return fetch('api/wallet/summary', {
          headers: { 'Authorization': 'Bearer ' + session.access_token }
        }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); });
      })
      .then(function (r) {
        if (!r || !r.ok) return;
        if (r.data.looksInStock > 0) {
          msg.innerHTML = 'Образов в запасе: ' + r.data.looksInStock + '. <a href="obraz-po-foto.html">Собрать образ →</a>';
        } else if (r.data.hasAvailableDiscount) {
          msg.innerHTML = 'Код принят — следующий образ обойдётся в 370 ₽ вместо 590 ₽. ' +
            '<a href="obraz-po-foto.html">Собрать образ →</a>';
        }
      })
      .catch(function () {});
  }

  function initCodeForm() {
    var form = document.getElementById('codeForm');
    var input = document.getElementById('codeInput');
    var submitBtn = form ? form.querySelector('button[type="submit"]') : null;
    var msgBox = document.getElementById('codeMsg');
    var consentLabel = document.querySelector('#partnerCodeSection .wizard-consent');
    if (!form || !input) return;

    function showCodeMsg(text, variant) {
      if (!msgBox) return;
      msgBox.textContent = text || '';
      msgBox.className = 'cabinet-status__msg' + (variant ? ' cabinet-status__msg--' + variant : '');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = input.value.trim();
      if (!code) return;

      showCodeMsg('');
      if (submitBtn) submitBtn.setAttribute('disabled', '');

      Promise.resolve(window.stilAuth ? window.stilAuth.getSession() : null)
        .then(function (session) {
          if (!session) throw new Error('Сначала войдите в личный кабинет выше — код погашается на ваш аккаунт.');
          return fetch('api/redeem-code', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + session.access_token
            },
            body: JSON.stringify({ code: code })
          });
        })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error(r.data.error || 'Не получилось проверить код.');
          if (!r.data.valid) {
            throw new Error(r.data.error || 'Такой код не распознан — проверьте, что он введён без опечаток.');
          }
          /* Прячем саму форму (и чекбокс согласия) — клиентка вводит код один
             раз, дальше поле ввода уже не нужно, а его исчезновение вместе с
             явным «Код принят» — самый однозначный сигнал, что всё сработало,
             без необходимости приглядываться к мелкому статусу. */
          form.style.display = 'none';
          if (consentLabel) consentLabel.style.display = 'none';
          showCodeMsg('✓ Код принят — следующий образ обойдётся в 370 ₽ вместо 590 ₽.', 'success');
          renderStatus();
          if (window.stilGoal) window.stilGoal('partner_code'); // js/metrika.js
        })
        .catch(function (err) {
          showCodeMsg(err.message, 'error');
        })
        .then(function () {
          if (submitBtn) submitBtn.removeAttribute('disabled');
        });
    });
  }

  /* 2026-10-17 (ТЗ v5, раздел 8): выбор нескольких вещей галочками и удаление группой. */
  var wardrobeSelected = {};

  function renderWardrobeBulk(items) {
    var haveList = document.getElementById('wardrobeHave');
    var columns = haveList && haveList.closest('.wardrobe-columns');
    if (!columns) return;
    var bar = document.getElementById('wardrobeBulk');
    if (!bar) {
      bar = el('div', 'wardrobe-bulk');
      bar.id = 'wardrobeBulk';
      columns.parentNode.insertBefore(bar, columns);
    }
    bar.innerHTML = '';
    var ids = items.map(function (it) { return it.id; });
    var chosen = ids.filter(function (id) { return wardrobeSelected[id]; });
    bar.hidden = !items.length;
    bar.appendChild(el('span', null, chosen.length ? 'Выбрано: ' + chosen.length : 'Отметьте вещи, чтобы удалить несколько сразу'));
    var all = el('button', 'saved-looks-toolbar__btn', chosen.length === ids.length && ids.length ? 'Снять выбор' : 'Выбрать все');
    all.type = 'button';
    all.addEventListener('click', function () {
      var allOn = chosen.length === ids.length;
      wardrobeSelected = {};
      if (!allOn) ids.forEach(function (id) { wardrobeSelected[id] = true; });
      renderWardrobe();
    });
    bar.appendChild(all);
    if (chosen.length) {
      var del = el('button', 'saved-looks-toolbar__btn saved-looks-toolbar__delete', 'Удалить выбранные');
      del.type = 'button';
      del.addEventListener('click', function () {
        var ask = window.stilSavedLooks && window.stilSavedLooks.confirmDialog
          ? window.stilSavedLooks.confirmDialog('Удалить вещи из гардероба?', 'Выбрано: ' + chosen.length + '. Отменить это действие нельзя.', 'Удалить')
          : Promise.resolve(window.confirm('Удалить выбранные вещи?'));
        ask.then(function (yes) {
          if (!yes) return;
          writeWardrobe(readWardrobe().filter(function (it) { return !wardrobeSelected[it.id]; }));
          wardrobeSelected = {};
          renderWardrobe();
        });
      });
      bar.appendChild(del);
    }
  }

  function renderWardrobe() {
    var haveList = document.getElementById('wardrobeHave');
    var needList = document.getElementById('wardrobeNeed');
    if (!haveList || !needList) return;

    var items = readWardrobe();
    renderWardrobeBulk(items);
    haveList.innerHTML = '';
    needList.innerHTML = '';

    var have = items.filter(function (it) { return it.status === 'have'; });
    var need = items.filter(function (it) { return it.status === 'need'; });

    if (!have.length) haveList.appendChild(el('li', 'wardrobe-empty', 'Пока пусто'));
    have.forEach(function (it) { haveList.appendChild(renderItem(it)); });

    if (!need.length) needList.appendChild(el('li', 'wardrobe-empty', 'Пока пусто'));
    need.forEach(function (it) { needList.appendChild(renderItem(it)); });
  }

  function renderItem(item) {
    var li = el('li', 'wardrobe-item');
    var check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'wardrobe-item__check';
    check.checked = !!wardrobeSelected[item.id];
    check.setAttribute('aria-label', 'Выбрать: ' + item.text);
    check.addEventListener('change', function () {
      if (check.checked) wardrobeSelected[item.id] = true; else delete wardrobeSelected[item.id];
      renderWardrobe();
    });
    li.appendChild(check);
    li.appendChild(el('span', null, item.text));

    var toggle = el('button', 'wardrobe-item__toggle', item.status === 'have' ? 'Нужно докупить' : 'Уже есть');
    toggle.type = 'button';
    toggle.title = 'Переключить статус';
    toggle.addEventListener('click', function () {
      var items = readWardrobe();
      var target = items.find(function (it) { return it.id === item.id; });
      if (target) target.status = target.status === 'have' ? 'need' : 'have';
      writeWardrobe(items);
      renderWardrobe();
    });

    var remove = el('button', 'wardrobe-item__remove', '×');
    remove.type = 'button';
    remove.title = 'Удалить';
    remove.addEventListener('click', function () {
      writeWardrobe(readWardrobe().filter(function (it) { return it.id !== item.id; }));
      renderWardrobe();
    });

    li.appendChild(toggle);
    li.appendChild(remove);
    return li;
  }

  function initAddForm() {
    var form = document.getElementById('wardrobeAddForm');
    var input = document.getElementById('wardrobeInput');
    if (!form || !input) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      var items = readWardrobe();
      items.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), text: text, status: 'need' });
      writeWardrobe(items);
      input.value = '';
      renderWardrobe();
    });
  }

  function initReviewForm() {
    var form = document.getElementById('reviewForm');
    var textInput = document.getElementById('reviewText');
    var ageInput = document.getElementById('reviewAge');
    var msgBox = document.getElementById('reviewMsg');
    var submitBtn = form ? form.querySelector('button[type="submit"]') : null;
    if (!form || !textInput) return;

    function showReviewMsg(text, variant) {
      if (!msgBox) return;
      msgBox.style.display = text ? 'block' : 'none';
      msgBox.textContent = text || '';
      msgBox.className = 'cabinet-status__msg' + (variant ? ' cabinet-status__msg--' + variant : '');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = textInput.value.trim();
      if (text.length < 10) {
        showReviewMsg('Напишите чуть подробнее — пару предложений.', 'error');
        return;
      }
      showReviewMsg('');
      if (submitBtn) submitBtn.setAttribute('disabled', '');

      Promise.resolve(window.stilAuth ? window.stilAuth.getSession() : null)
        .then(function (session) {
          if (!session) throw new Error('Сначала войдите в личный кабинет выше.');
          return fetch('api/reviews', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + session.access_token
            },
            body: JSON.stringify({ action: 'submit', text: text, age: ageInput ? ageInput.value : '' })
          });
        })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error(r.data.error || 'Не получилось отправить отзыв.');
          form.reset();
          showReviewMsg('Спасибо! Отзыв отправлен на проверку.', 'success');
        })
        .catch(function (err) {
          showReviewMsg(err.message, 'error');
        })
        .then(function () {
          if (submitBtn) submitBtn.removeAttribute('disabled');
        });
    });
  }

  renderStatus();
  renderWardrobe();
  initAddForm();
  initCodeForm();
  initReviewForm();
})();
