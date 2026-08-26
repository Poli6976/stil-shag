/* ============ Личный кабинет: демо на localStorage (гардероб) + реальный статус скидки ============
   Реальной авторизации у гардероба и счётчика образов по-прежнему нет (это
   демо на localStorage под ключами "stil.*", пропадёт при очистке браузера).
   Счётчик "stil.styleCount" растёт в js/wizard.js при каждом завершении визарда.

   Код от партнёра — НЕ демо: POST на /api/redeem-code (проверка подписи —
   lib/partnerCode.js) требует входа через настоящий аккаунт (js/wallet.js,
   Supabase) и записывает погашение в таблицу discount_credits (см.
   db/schema.sql) с уникальным индексом на код. Поэтому один код даёт ровно
   одну Примерку со скидкой — повторно погасить его (в том числе в другом
   браузере) нельзя, а сама скидка списывается атомарно вместе с оплатой в
   api/orders/create.js. Статус скидки ниже запрашивается у сервера
   (api/discount/status), а не хранится в localStorage. */

(function () {
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

    if (count === 0) {
      msg.innerHTML = 'Первый образ — бесплатно для всех, без покупки. <a href="online-stylist.html">Собрать сейчас →</a>';
      return;
    }

    var fallbackMsg = 'Первый бесплатный образ уже использован. ' +
      '<a href="online-stylist.html">Собрать ещё один образ →</a> (спишется с депозита, если хватает баланса). ' +
      'Получили код от продавца при покупке? Введите его ниже — и следующая примерка будет со скидкой 50%.';
    msg.innerHTML = fallbackMsg;

    if (!window.stilAuth) return;
    window.stilAuth.getSession()
      .then(function (session) {
        if (!session) return null;
        return fetch('api/discount/status', {
          headers: { 'Authorization': 'Bearer ' + session.access_token }
        }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); });
      })
      .then(function (r) {
        if (r && r.ok && r.data.hasAvailableDiscount) {
          msg.innerHTML = 'Код принят — следующая примерка со скидкой 50%. ' +
            '<a href="online-stylist.html">Собрать образ →</a>';
        }
      })
      .catch(function () {});
  }

  function initCodeForm() {
    var form = document.getElementById('codeForm');
    var input = document.getElementById('codeInput');
    var submitBtn = form ? form.querySelector('button[type="submit"]') : null;
    var msgBox = document.getElementById('codeMsg');
    if (!form || !input) return;

    function showCodeMsg(text, isError) {
      if (!msgBox) return;
      msgBox.textContent = text || '';
      msgBox.className = 'cabinet-status__msg' + (isError ? ' cabinet-status__msg--error' : '');
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
          input.value = '';
          showCodeMsg('Код принят — скидка 50% доступна на следующую примерку.');
          renderStatus();
        })
        .catch(function (err) {
          showCodeMsg(err.message, true);
        })
        .then(function () {
          if (submitBtn) submitBtn.removeAttribute('disabled');
        });
    });
  }

  function renderWardrobe() {
    var haveList = document.getElementById('wardrobeHave');
    var needList = document.getElementById('wardrobeNeed');
    if (!haveList || !needList) return;

    var items = readWardrobe();
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

  renderStatus();
  renderWardrobe();
  initAddForm();
  initCodeForm();
})();
