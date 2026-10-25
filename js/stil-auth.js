/* ============ Вход по коду из письма — клиентская часть (вместо supabase-js) ============
   С 2026-10-23 сайт не пользуется Supabase: вход и сессии — свои (api/auth.js,
   lib/auth.js). Этот файл повторяет ту маленькую часть интерфейса supabase-js,
   которой пользовались js/wallet.js и js/auth-gate.js:
     stilAuthClient.auth.signInWithOtp({ email })          → { error }
     stilAuthClient.auth.verifyOtp({ email, token })       → { data: { session }, error }
     stilAuthClient.auth.getSession()                      → { data: { session } }
     stilAuthClient.auth.onAuthStateChange(cb)             — cb(event, session), сразу и при входе/выходе
     stilAuthClient.auth.signOut()
   Сессия — { access_token, expires_at, user: { id, email } } — хранится в
   localStorage этого браузера; остальные скрипты шлют access_token в
   заголовке Authorization, как раньше.
   Подключать раньше js/wallet.js / js/auth-gate.js. */

(function () {
  var STORAGE_KEY = 'stil.session';
  var listeners = [];
  var current;

  function readStored() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (s && s.access_token && s.user && s.expires_at * 1000 > Date.now()) return s;
    } catch (e) { /* localStorage недоступен или испорчен */ }
    return null;
  }

  function store(session) {
    try {
      if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* приватный режим: сессия проживёт до закрытия вкладки */ }
  }

  function emit(event, session) {
    listeners.slice().forEach(function (cb) {
      try { cb(event, session); } catch (e) { console.error(e); }
    });
  }

  function setSession(session, event) {
    current = session;
    store(session);
    emit(event, session);
  }

  function post(action, payload, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch('api/auth', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Что-то пошло не так. Попробуйте ещё раз.');
        return data;
      });
    }, function () {
      throw new Error('Нет связи с сайтом — проверьте интернет и попробуйте ещё раз.');
    });
  }

  current = readStored();

  /* Сессию могли закрыть на сервере (выход на другом устройстве, срок) — проверяем один раз. */
  if (current) {
    fetch('api/auth?action=session', { headers: { 'Authorization': 'Bearer ' + current.access_token } })
      .then(function (res) {
        if (res.status === 401 && current) setSession(null, 'SIGNED_OUT');
      })
      .catch(function () { /* нет сети — оставляем как есть */ });
  }

  /* Вход или выход в другой вкладке. */
  window.addEventListener('storage', function (e) {
    if (e.key !== STORAGE_KEY) return;
    var next = readStored();
    var was = current;
    current = next;
    if (next && (!was || was.access_token !== next.access_token)) emit('SIGNED_IN', next);
    if (!next && was) emit('SIGNED_OUT', null);
  });

  var authApi = {
    getSession: function () {
      if (current && current.expires_at * 1000 <= Date.now()) setSession(null, 'SIGNED_OUT');
      return Promise.resolve({ data: { session: current || null } });
    },

    signInWithOtp: function (params) {
      return post('send-code', { email: params && params.email })
        .then(function () { return { error: null }; }, function (err) { return { error: err }; });
    },

    verifyOtp: function (params) {
      return post('verify', { email: params && params.email, code: params && params.token })
        .then(function (data) {
          setSession(data.session, 'SIGNED_IN');
          if (window.stilGoal) window.stilGoal('login'); // js/metrika.js
          return { data: { session: data.session }, error: null };
        }, function (err) {
          return { data: { session: null }, error: err };
        });
    },

    signOut: function () {
      var token = current && current.access_token;
      setSession(null, 'SIGNED_OUT');
      if (!token) return Promise.resolve({ error: null });
      return post('logout', {}, token).then(function () { return { error: null }; }, function (err) { return { error: err }; });
    },

    onAuthStateChange: function (cb) {
      listeners.push(cb);
      /* Как в supabase-js: сразу сообщаем текущее состояние (асинхронно). */
      setTimeout(function () { cb('INITIAL_SESSION', current || null); }, 0);
      return {
        data: {
          subscription: {
            unsubscribe: function () { listeners = listeners.filter(function (x) { return x !== cb; }); }
          }
        }
      };
    }
  };

  window.stilAuthClient = { auth: authApi };
})();
