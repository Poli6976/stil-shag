/* ============ Вход и кошелёк (личный кабинет) — настоящий Supabase Auth ============
   Отдельный файл от js/cabinet.js: гардероб и коды "Примерки" в cabinet.js
   остаются демо на localStorage без изменений — это касается только того,
   что требует настоящего аккаунта: баланс, пополнение депозита, история
   операций. Подключается на cabinet.html после
   https://unpkg.com/@supabase/supabase-js@2. */

(function () {
  var sb = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatRub(kopecks) {
    return (kopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
  }

  function showMsg(root, text, isError) {
    if (!root) return;
    root.textContent = text || '';
    root.style.display = text ? 'block' : 'none';
    root.className = 'cabinet-status__msg' + (isError ? ' cabinet-status__msg--error' : '');
  }

  async function initSupabase() {
    try {
      var res = await fetch('api/config');
      if (!res.ok) return null;
      var cfg = await res.json();
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) return null;
      return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    } catch (e) {
      return null;
    }
  }

  async function authedFetch(session, path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, {
      'Authorization': 'Bearer ' + session.access_token
    });
    return fetch(path, options);
  }

  async function loadWallet(session) {
    var balanceEl = document.getElementById('walletBalance');
    var historyEl = document.getElementById('walletHistory');

    try {
      var balanceRes = await authedFetch(session, 'api/wallet/balance');
      var balanceData = await balanceRes.json();
      if (balanceRes.ok && balanceEl) balanceEl.textContent = formatRub(balanceData.balanceKopecks);
    } catch (e) {}

    try {
      var historyRes = await authedFetch(session, 'api/wallet/history');
      var historyData = await historyRes.json();
      if (historyRes.ok && historyEl) {
        historyEl.innerHTML = '';
        if (!historyData.history.length) {
          historyEl.appendChild(el('li', 'wardrobe-empty', 'Операций пока нет'));
        }
        historyData.history.forEach(function (tx) {
          var sign = tx.type === 'topup' ? '+ ' : '− ';
          var label = sign + formatRub(tx.amountKopecks) + ' · ' + new Date(tx.createdAt).toLocaleString('ru-RU');
          historyEl.appendChild(el('li', 'wardrobe-item', label));
        });
      }
    } catch (e) {}
  }

  function setLoggedInUI(session) {
    var loggedOut = document.getElementById('authLoggedOut');
    var loggedIn = document.getElementById('authLoggedIn');
    var walletSection = document.getElementById('walletSection');
    var emailEl = document.getElementById('authEmail');

    if (session) {
      if (loggedOut) loggedOut.style.display = 'none';
      if (loggedIn) loggedIn.style.display = 'block';
      if (walletSection) walletSection.style.display = 'block';
      if (emailEl) emailEl.textContent = session.user.email;
      loadWallet(session);
    } else {
      if (loggedOut) loggedOut.style.display = 'block';
      if (loggedIn) loggedIn.style.display = 'none';
      if (walletSection) walletSection.style.display = 'none';
      var loginForm = document.getElementById('loginForm');
      if (loginForm) loginForm.style.display = '';
      var codeForm = document.getElementById('loginCodeForm');
      if (codeForm) codeForm.style.display = 'none';
      var codeInput = document.getElementById('loginCode');
      if (codeInput) codeInput.value = '';
      showMsg(document.getElementById('loginMsg'), '');
    }
  }

  /* Письмо содержит только код (без кликабельной ссылки) — у некоторых почтовых
     провайдеров (замечено на list.ru) антифишинг-сканер сам переходит по ссылкам
     во входящих раньше реального клика пользователя, и одноразовый токен сгорает
     до того, как человек успевает им воспользоваться. Код, который вводят руками,
     сканеру взять неоткуда — в письме нет ссылок вообще. */
  function initLoginForm() {
    var form = document.getElementById('loginForm');
    var emailInput = document.getElementById('loginEmail');
    var msg = document.getElementById('loginMsg');
    if (!form || !emailInput) return;

    var codeForm = document.getElementById('loginCodeForm');
    var codeInput = document.getElementById('loginCode');
    var pendingEmail = null;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!sb) return;
      var email = emailInput.value.trim();
      if (!email) return;

      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.setAttribute('disabled', '');
      showMsg(msg, '');

      sb.auth.signInWithOtp({ email: email })
        .then(function (r) {
          if (r.error) throw r.error;
          form.style.display = 'none';
          pendingEmail = email;
          if (codeForm) codeForm.style.display = '';
          showMsg(msg, 'Мы отправили код на ' + email + ' — введите его ниже.');
        })
        .catch(function (err) {
          showMsg(msg, err.message || 'Не получилось отправить код.', true);
          if (submitBtn) submitBtn.removeAttribute('disabled');
        });
    });

    if (codeForm && codeInput) {
      codeForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!sb || !pendingEmail) return;
        var code = codeInput.value.trim();
        if (!code) return;

        var codeBtn = codeForm.querySelector('button[type="submit"]');
        if (codeBtn) codeBtn.setAttribute('disabled', '');
        showMsg(msg, '');

        sb.auth.verifyOtp({ email: pendingEmail, token: code, type: 'email' })
          .then(function (r) {
            if (r.error) throw r.error;
            /* setLoggedInUI придёт через onAuthStateChange автоматически */
          })
          .catch(function (err) {
            showMsg(msg, err.message || 'Код не подошёл — проверьте и попробуйте снова.', true);
            if (codeBtn) codeBtn.removeAttribute('disabled');
          });
      });
    }
  }

  function initLogout() {
    var btn = document.getElementById('logoutBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (sb) sb.auth.signOut();
    });
  }

  function initCardPayButton() {
    var btn = document.getElementById('cardPayBtn');
    var msg = document.getElementById('topupMsg');
    if (!btn) return;

    btn.addEventListener('click', function () {
      if (!sb) return;
      showMsg(msg, '');
      btn.setAttribute('disabled', '');

      sb.auth.getSession()
        .then(function (r) {
          var session = r.data && r.data.session;
          if (!session) throw new Error('Сессия истекла — войдите заново.');
          return authedFetch(session, 'api/payments/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'robokassa' })
          });
        })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (r) {
          if (!r.ok || !r.data.confirmationUrl) throw new Error((r.data && r.data.error) || 'Не получилось создать платёж.');
          window.location.href = r.data.confirmationUrl;
        })
        .catch(function (err) {
          showMsg(msg, err.message, true);
        })
        .then(function () {
          btn.removeAttribute('disabled');
        });
    });
  }

  function initSbpButton() {
    var btn = document.getElementById('sbpPayBtn');
    var resultBox = document.getElementById('sbpResult');
    var msg = document.getElementById('topupMsg');
    if (!btn || !resultBox) return;

    btn.addEventListener('click', function () {
      if (!sb) return;
      showMsg(msg, '');
      resultBox.style.display = 'none';
      btn.setAttribute('disabled', '');

      sb.auth.getSession()
        .then(function (r) {
          var session = r.data && r.data.session;
          if (!session) throw new Error('Сессия истекла — войдите заново.');
          return authedFetch(session, 'api/payments/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'sbp' })
          });
        })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error((r.data && r.data.error) || 'Не получилось создать заявку.');
          resultBox.innerHTML = '';
          resultBox.appendChild(el('div', 'cabinet-status__count', formatRub(r.data.amountKopecks)));
          if (r.data.discounted) {
            resultBox.appendChild(el('p', 'cabinet-status__msg', 'Сумма со скидкой по коду партнёра.'));
          }
          [
            ['Переведите на телефон', r.data.phone],
            ['Банк', r.data.bank],
            ['Получатель', r.data.recipientName],
            ['Код заказа (укажите в комментарии к переводу)', r.data.orderCode]
          ].forEach(function (pair) {
            var p = el('p', 'cabinet-status__msg');
            var strong = el('strong', null, pair[1]);
            p.appendChild(document.createTextNode(pair[0] + ': '));
            p.appendChild(strong);
            resultBox.appendChild(p);
          });
          resultBox.appendChild(el('p', 'cabinet-status__msg',
            'После перевода подтверждение придёт не сразу — владелец сайта сверяет заявки вручную, обычно в течение нескольких часов.'));
          resultBox.style.display = 'block';
        })
        .catch(function (err) {
          showMsg(msg, err.message, true);
        })
        .then(function () {
          btn.removeAttribute('disabled');
        });
    });
  }

  async function init() {
    sb = await initSupabase();
    initLoginForm();
    initLogout();
    initCardPayButton();
    initSbpButton();

    if (!sb) {
      showMsg(document.getElementById('loginMsg'), 'Вход и оплата пока не настроены на сервере.', true);
      var form = document.getElementById('loginForm');
      var btn = form && form.querySelector('button[type="submit"]');
      if (btn) btn.setAttribute('disabled', '');
      return;
    }

    var initial = await sb.auth.getSession();
    setLoggedInUI(initial.data && initial.data.session);

    sb.auth.onAuthStateChange(function (_event, session) {
      setLoggedInUI(session);
    });
  }

  var sbReadyPromise = init();

  /* Маленький мост для js/cabinet.js: он погашает коды партнёра через
     api/redeem-code и api/discount/status, для чего ему нужен access_token
     залогиненного пользователя — а клиент Supabase (sb) живёт только здесь. */
  window.stilAuth = {
    getSession: function () {
      return sbReadyPromise.then(function () {
        if (!sb) return null;
        return sb.auth.getSession().then(function (r) { return (r.data && r.data.session) || null; });
      });
    }
  };
})();
