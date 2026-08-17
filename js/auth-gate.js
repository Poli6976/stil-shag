/* ============ Общий вход по email (magic link) для страниц вне cabinet.html ============
   Та же схема Supabase Auth, что в js/wallet.js (там своя разметка кошелька,
   переиспользовать её напрямую нельзя) — здесь минимальная переносимая версия
   для visard'а и "Образа по фото": рисует форму входа в переданный контейнер,
   как только пользователь залогинен (сейчас или позже — после перехода по
   ссылке из письма) заменяет её на короткую строку и вызывает onReady(session).
   Требует <script src="https://unpkg.com/@supabase/supabase-js@2"> раньше себя. */

(function () {
  var sbReadyPromise = null;

  function getClient() {
    if (sbReadyPromise) return sbReadyPromise;
    sbReadyPromise = fetch('api/config')
      .then(function (res) { return res.json(); })
      .then(function (cfg) {
        if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) return null;
        return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      })
      .catch(function () { return null; });
    return sbReadyPromise;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* mountEl — куда рисовать гейт. onReady(session) вызывается один раз при
     входе и повторно НЕ вызывается при последующих сменах сессии на этой же
     загрузке страницы — вызывающий код сам решает, что делать (обычно просто
     один раз инициализирует форму/визард). */
  function renderGate(mountEl, onReady) {
    var readyFired = false;

    getClient().then(function (client) {
      if (!client) {
        mountEl.innerHTML = '';
        mountEl.appendChild(el('p', 'wizard-photo-status wizard-photo-status--error', 'Вход пока не настроен на сервере.'));
        return;
      }

      function fireReady(session) {
        mountEl.innerHTML = '';
        mountEl.appendChild(el('p', 'auth-gate__status', 'Вы вошли как ' + session.user.email));
        if (!readyFired) {
          readyFired = true;
          onReady(session);
        }
      }

      function showForm() {
        mountEl.innerHTML = '';

        var box = el('div', 'auth-gate');
        box.appendChild(el('p', 'auth-gate__lead',
          'Первый образ — бесплатно. Войдите по email, чтобы мы могли его засчитать и прислать ссылку для возврата к результату.'));

        var form = document.createElement('form');
        form.className = 'auth-gate__form';

        var input = document.createElement('input');
        input.type = 'email';
        input.required = true;
        input.placeholder = 'you@example.com';
        input.className = 'wizard-input';

        var btn = el('button', 'btn-3d btn-3d--rect', 'Получить ссылку для входа');
        btn.type = 'submit';

        var msg = el('p', 'wizard-photo-status');

        form.appendChild(input);
        form.appendChild(btn);
        box.appendChild(form);
        box.appendChild(msg);
        mountEl.appendChild(box);

        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var email = input.value.trim();
          if (!email) return;
          btn.setAttribute('disabled', '');
          msg.textContent = '';
          msg.className = 'wizard-photo-status';

          client.auth.signInWithOtp({ email: email, options: { emailRedirectTo: window.location.href.split('#')[0] } })
            .then(function (r) {
              if (r.error) throw r.error;
              form.style.display = 'none';
              msg.textContent = 'Ссылка для входа отправлена на ' + email + ' — проверьте почту.';
              msg.className = 'wizard-photo-status wizard-photo-status--ok';
            })
            .catch(function (err) {
              msg.textContent = (err && err.message) || 'Не получилось отправить ссылку.';
              msg.className = 'wizard-photo-status wizard-photo-status--error';
              btn.removeAttribute('disabled');
            });
        });
      }

      client.auth.getSession().then(function (r) {
        var session = r.data && r.data.session;
        if (session) { fireReady(session); } else { showForm(); }
      });

      client.auth.onAuthStateChange(function (_event, session) {
        if (session) fireReady(session);
      });
    });
  }

  window.stilAuthGate = { renderGate: renderGate };
})();
