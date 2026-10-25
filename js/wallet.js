/* ============ Вход и покупки (личный кабинет) — вход по коду из письма ============
   Отдельный файл от js/cabinet.js: гардероб в cabinet.js остаётся демо на
   localStorage — здесь только то, что требует настоящего аккаунта: вход,
   покупки, аватарка. Вход — свой (api/auth.js) с 2026-10-23, клиент —
   js/stil-auth.js (тот же интерфейс, что был у supabase-js); подключается
   на cabinet.html раньше этого файла. */

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

  async function initAuthClient() {
    return window.stilAuthClient || null;
  }

  async function authedFetch(session, path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, {
      'Authorization': 'Bearer ' + session.access_token
    });
    return fetch(path, options);
  }

  /* «Мои покупки» (ТЗ «Новые цены» v8): образы в запасе и список прошедших оплат — баланса больше нет. */
  async function loadWallet(session) {
    var stockEl = document.getElementById('walletStock');
    var historyEl = document.getElementById('walletHistory');
    try {
      var res = await authedFetch(session, 'api/wallet/summary');
      var data = await res.json();
      if (!res.ok) return;
      if (stockEl) stockEl.textContent = 'Образов в запасе: ' + (data.looksInStock || 0);
      if (historyEl) {
        historyEl.innerHTML = '';
        if (!data.purchases.length) historyEl.appendChild(el('li', 'wardrobe-empty', 'Оплат пока нет'));
        data.purchases.forEach(function (p) {
          historyEl.appendChild(el('li', 'wardrobe-item',
            new Date(p.paidAt).toLocaleDateString('ru-RU') + ' · ' + p.title + ' · ' + formatRub(p.amountKopecks)));
        });
      }
    } catch (e) {}
  }

  /* Пакет оплачен, а уведомление Robokassa не дошло (бывало: «timed out»)? Запоминаем заказ пакета перед
     уходом на оплату и после возврата спрашиваем его статус: api/wallet/summary?order= сам сверит оплату
     с Robokassa и начислит образы в запас — как анкета делает для одного образа (stil.pendingLook). */
  var PENDING_PACK_KEY = 'stil.pendingPack';
  var PENDING_PACK_TTL = 3 * 60 * 60 * 1000;

  function readPendingPack() {
    try {
      var p = JSON.parse(localStorage.getItem(PENDING_PACK_KEY) || 'null');
      if (p && p.orderId && Date.now() - p.at < PENDING_PACK_TTL) return p;
      localStorage.removeItem(PENDING_PACK_KEY);
    } catch (e) {}
    return null;
  }

  function checkPendingPack(session, attempt) {
    var pending = readPendingPack();
    if (!pending) return;
    var msg = document.getElementById('topupMsg');
    authedFetch(session, 'api/wallet/summary?order=' + encodeURIComponent(pending.orderId))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var status = data && data.order && data.order.status;
        if (status === 'done') {
          try { localStorage.removeItem(PENDING_PACK_KEY); } catch (e) {}
          showMsg(msg, 'Оплата пакета прошла — образы добавлены в запас.');
          loadWallet(session);
          return;
        }
        if (!data || status !== 'created') {
          try { localStorage.removeItem(PENDING_PACK_KEY); } catch (e) {}
          return;
        }
        if ((attempt || 0) < 12) {
          showMsg(msg, 'Проверяем оплату пакета…');
          setTimeout(function () { checkPendingPack(session, (attempt || 0) + 1); }, 5000);
        } else {
          showMsg(msg, 'Оплата пакета пока не подтверждена. Если вы оплатили — обновите страницу через пару минут.');
        }
      })
      .catch(function () {});
  }

  /* ---------- аватарка клиентки (api/auth.js, action=profile/set-avatar/remove-avatar) ---------- */

  function renderAvatar(url) {
    var img = document.getElementById('avatarImg');
    var placeholder = document.getElementById('avatarPlaceholder');
    var removeBtn = document.getElementById('avatarRemoveBtn');
    if (!img || !placeholder) return;
    if (url) {
      img.src = url; // в адресе — время последней замены, браузер не покажет старое фото из кэша
      img.style.display = '';
      placeholder.style.display = 'none';
      if (removeBtn) removeBtn.style.display = '';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      placeholder.style.display = '';
      if (removeBtn) removeBtn.style.display = 'none';
    }
  }

  function loadAvatar(session) {
    authedFetch(session, 'api/auth?action=profile')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { renderAvatar(data && data.avatarUrl); })
      .catch(function () {});
  }

  function avatarRequest(session, payload) {
    return authedFetch(session, 'api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Не получилось сохранить фото.');
        return data;
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Не получилось прочитать фото.')); };
      reader.readAsDataURL(blob);
    });
  }

  /* Ужимает фото до квадрата 320×320 (canvas, cover-обрезка по центру) —
     оригинал с телефона легко весит несколько МБ, а тут нужна просто
     маленькая круглая аватарка, не полноразмерное фото. */
  function resizeAvatarFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          var size = 320;
          var canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          var ctx = canvas.getContext('2d');
          var scale = Math.max(size / img.width, size / img.height);
          var w = img.width * scale;
          var h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          canvas.toBlob(function (blob) {
            if (!blob) { reject(new Error('Не получилось обработать фото.')); return; }
            resolve(blob);
          }, 'image/jpeg', 0.85);
        };
        img.onerror = function () { reject(new Error('Не получилось прочитать фото.')); };
        img.src = e.target.result;
      };
      reader.onerror = function () { reject(new Error('Не получилось прочитать файл.')); };
      reader.readAsDataURL(file);
    });
  }

  function initAvatarUpload() {
    var input = document.getElementById('avatarInput');
    var removeBtn = document.getElementById('avatarRemoveBtn');
    var msg = document.getElementById('avatarMsg');
    if (!input) return;

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file || !sb) return;
      if (!/^image\//.test(file.type)) {
        showMsg(msg, 'Нужен файл изображения.', true);
        return;
      }
      showMsg(msg, 'Загружаю…');

      sb.auth.getSession().then(function (r) {
        var session = r.data && r.data.session;
        if (!session) throw new Error('Сессия истекла — войдите заново.');
        return resizeAvatarFile(file).then(blobToDataUrl).then(function (dataUrl) {
          return avatarRequest(session, { action: 'set-avatar', image: dataUrl });
        }).then(function (data) {
          renderAvatar(data.avatarUrl);
          showMsg(msg, '');
        });
      }).catch(function (err) {
        showMsg(msg, err.message || 'Не получилось загрузить фото.', true);
      });
    });

    if (removeBtn) {
      removeBtn.addEventListener('click', function () {
        if (!sb) return;
        showMsg(msg, '');
        sb.auth.getSession().then(function (r) {
          var session = r.data && r.data.session;
          if (!session) throw new Error('Сессия истекла — войдите заново.');
          return avatarRequest(session, { action: 'remove-avatar' });
        }).then(function () {
          renderAvatar(null);
        }).catch(function (err) {
          showMsg(msg, err.message || 'Не получилось удалить фото.', true);
        });
      });
    }
  }

  function setLoggedInUI(session) {
    var loggedOut = document.getElementById('authLoggedOut');
    var loggedIn = document.getElementById('authLoggedIn');
    var walletSection = document.getElementById('walletSection');
    var reviewSection = document.getElementById('reviewSection');
    var emailEl = document.getElementById('authEmail');

    if (session) {
      if (loggedOut) loggedOut.style.display = 'none';
      if (loggedIn) loggedIn.style.display = 'block';
      if (walletSection) walletSection.style.display = 'block';
      if (reviewSection) reviewSection.style.display = 'block';
      if (emailEl) emailEl.textContent = session.user.email;
      loadWallet(session);
      checkPendingPack(session, 0);
      loadAvatar(session);
      if (window.stilSavedLooks) window.stilSavedLooks.load(session);
    } else {
      if (loggedOut) loggedOut.style.display = 'block';
      if (loggedIn) loggedIn.style.display = 'none';
      if (walletSection) walletSection.style.display = 'none';
      if (reviewSection) reviewSection.style.display = 'none';
      renderAvatar(null);
      var savedLooksSection = document.getElementById('savedLooksSection');
      if (savedLooksSection) savedLooksSection.style.display = 'none';
      var styleProfileSection = document.getElementById('styleProfileSection');
      if (styleProfileSection) styleProfileSection.style.display = 'none';
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

  /* Пакеты «3 образа» / «5 образов» — оплата картой, сумму считает сервер (api/payments/create.js). */
  function initCardPayButton() {
    var msg = document.getElementById('topupMsg');
    document.querySelectorAll('[data-pack]').forEach(function (btn) {
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
              body: JSON.stringify({ product: btn.getAttribute('data-pack') })
            });
          })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            if (!r.ok || !r.data.confirmationUrl) throw new Error((r.data && r.data.error) || 'Не получилось создать платёж.');
            try {
              localStorage.setItem(PENDING_PACK_KEY, JSON.stringify({ orderId: r.data.orderId, at: Date.now() }));
            } catch (e) {}
            window.location.href = r.data.confirmationUrl;
          })
          .catch(function (err) { showMsg(msg, err.message, true); })
          .then(function () { btn.removeAttribute('disabled'); });
      });
    });
  }

  async function init() {
    sb = await initAuthClient();
    initLoginForm();
    initLogout();
    initCardPayButton();
    initAvatarUpload();

    if (!sb) {
      showMsg(document.getElementById('loginMsg'), 'Вход и оплата пока не настроены на сервере.', true);
      var form = document.getElementById('loginForm');
      var btn = form && form.querySelector('button[type="submit"]');
      if (btn) btn.setAttribute('disabled', '');
      return;
    }

    /* Раньше здесь ещё был отдельный ручной sb.auth.getSession() +
       setLoggedInUI() перед подпиской — но onAuthStateChange (и в supabase-js v2,
       и в js/stil-auth.js) и так сразу стреляет текущей сессией при подписке
       (событие INITIAL_SESSION), поэтому ручной вызов дублировал его. Из-за этого
       setLoggedInUI (а с ней stilSavedLooks.load) срабатывала дважды подряд
       на каждой загрузке кабинета — два параллельных запроса «Моих образов»
       гонялись друг с другом и оба дорисовывали карточки в одну и ту же
       сетку, отсюда задвоенные образы в личном кабинете. */
    sb.auth.onAuthStateChange(function (_event, session) {
      setLoggedInUI(session);
    });
  }

  var sbReadyPromise = init();

  /* Маленький мост для js/cabinet.js: он погашает коды партнёра через
     api/redeem-code и api/wallet/summary, для чего ему нужен access_token
     залогиненного пользователя — а клиент входа (sb) живёт только здесь. */
  window.stilAuth = {
    getSession: function () {
      return sbReadyPromise.then(function () {
        if (!sb) return null;
        return sb.auth.getSession().then(function (r) { return (r.data && r.data.session) || null; });
      });
    }
  };
})();
