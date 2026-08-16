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
      showMsg(document.getElementById('loginMsg'), '');
    }
  }

  function initLoginForm() {
    var form = document.getElementById('loginForm');
    var emailInput = document.getElementById('loginEmail');
    var msg = document.getElementById('loginMsg');
    if (!form || !emailInput) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!sb) return;
      var email = emailInput.value.trim();
      if (!email) return;

      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.setAttribute('disabled', '');
      showMsg(msg, '');

      sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: window.location.href.split('#')[0] } })
        .then(function (r) {
          if (r.error) throw r.error;
          form.style.display = 'none';
          showMsg(msg, 'Ссылка для входа отправлена на ' + email + ' — проверьте почту.');
        })
        .catch(function (err) {
          showMsg(msg, err.message || 'Не получилось отправить ссылку.', true);
          if (submitBtn) submitBtn.removeAttribute('disabled');
        });
    });
  }

  function initLogout() {
    var btn = document.getElementById('logoutBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (sb) sb.auth.signOut();
    });
  }

  function initTopupForm() {
    var form = document.getElementById('topupForm');
    var amountInput = document.getElementById('topupAmount');
    var msg = document.getElementById('topupMsg');
    if (!form || !amountInput) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!sb) return;

      var rub = parseFloat(amountInput.value);
      if (!rub || rub <= 0) {
        showMsg(msg, 'Введите сумму пополнения.', true);
        return;
      }

      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.setAttribute('disabled', '');
      showMsg(msg, '');

      sb.auth.getSession()
        .then(function (r) {
          var session = r.data && r.data.session;
          if (!session) throw new Error('Сессия истекла — войдите заново.');
          return authedFetch(session, 'api/payments/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amountKopecks: Math.round(rub * 100) })
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
          if (submitBtn) submitBtn.removeAttribute('disabled');
        });
    });
  }

  async function init() {
    sb = await initSupabase();
    initLoginForm();
    initLogout();
    initTopupForm();

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
