/* ============================================================================
   Яндекс.Метрика — сколько людей заходит на сайт, откуда и на каком шаге уходят.
   Подключается на всех страницах для покупательниц (не на admin-*.html).

   Метрика ставит cookie, а это обработка персональных данных (152-ФЗ), поэтому
   счётчик загружается ТОЛЬКО после «Хорошо» в полоске внизу экрана. Полоска —
   короткая, как на большинстве сайтов (30.10.2026: большая плашка с пояснениями
   на телефоне закрывала пол-экрана, и люди уходили с сайта). Не нажали — Метрика
   не грузится, сайт работает как обычно.
   Выбор хранится в браузере (localStorage, ключ stil.analyticsConsent:
   'yes' / 'no'); изменить его можно на странице legal-privacy.html, п. 7
   (кнопка вызывает window.stilAnalyticsConsentReset).

   Вебвизор (запись действий на странице) выключен намеренно: он записывал бы
   ввод почты и другие поля.

   Цели (Метрика → Цели, тип «JavaScript-событие», идентификаторы как ниже)
   отправляются из кода сайта через window.stilGoal('…'):
     login          — вошла в кабинет по коду из письма (js/stil-auth.js)
     photo_uploaded — фото вещи загружено и распознано (js/wizard.js)
     pay_start      — нажала оплату, уходит на Robokassa (js/wizard.js, js/wallet.js)
     look_built     — образ собран и показан (js/wizard.js)
     partner_code   — код партнёра принят (js/cabinet.js)
   Точные деньги и заказы — не здесь, а на служебной странице admin-stats.html.

   Отдельно, ВНЕ согласия, — свой счётчик заходов без cookie (низ файла,
   lib/visits.js): сервер получает только «открыта такая-то страница» и откуда
   начался визит (тип сайта или метка ?from=… из ссылки). Ничего о человеке не
   хранится, поэтому согласие не нужно и в счёт попадают все. В браузере на время
   вкладки (sessionStorage) лежит только начало визита; localStorage stil.noCount
   = '1' — «не считать мои заходы» (переключатель на admin-stats.html).
   ============================================================================ */

(function () {
  var VISIT_KEY = 'stil.visit';

  function sendHit() {
    try { if (localStorage.getItem('stil.noCount') === '1') return; } catch (e) {}
    if (navigator.webdriver) return;

    var visit = null;
    try { visit = JSON.parse(sessionStorage.getItem(VISIT_KEY) || 'null'); } catch (e) { visit = null; }
    var first = !visit;
    if (first) {
      var params = new URLSearchParams(window.location.search);
      var refHost = '';
      try { refHost = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
      visit = {
        referrer: refHost ? 'https://' + refHost + '/' : '',
        tag: params.get('from') || params.get('utm_source') || ''
      };
      try { sessionStorage.setItem(VISIT_KEY, JSON.stringify(visit)); } catch (e) {}
    }

    var body = JSON.stringify({
      path: window.location.pathname,
      first: first,
      referrer: visit.referrer || '',
      tag: visit.tag || ''
    });
    var url = 'api/reviews?action=hit';
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
    } catch (e) {}
    try {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  sendHit();
})();

(function () {
  var COUNTER_ID = 113788092; // счётчик «Стиль» в Метрике; 0 — Метрика выключена
  var CONSENT_KEY = 'stil.analyticsConsent';

  var loaded = false;

  /* done — если сразу после цели страница уходит (на оплату): ждём, пока Метрика отправит
     цель, но не дольше 600 мс. Без согласия/счётчика done вызывается сразу. */
  window.stilGoal = function (name, done) {
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (done) done();
    }
    try {
      if (loaded && window.ym) {
        window.ym(COUNTER_ID, 'reachGoal', name, undefined, finish);
        setTimeout(finish, 600);
        return;
      }
    } catch (e) {}
    finish();
  };

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }

  function writeConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch (e) {}
  }

  function loadMetrika() {
    if (loaded || !COUNTER_ID) return;
    loaded = true;
    /* Стандартный код загрузки Метрики: ym() копит вызовы в очередь, пока tag.js не загрузится. */
    window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
    window.ym.l = Date.now();
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://mc.yandex.ru/metrika/tag.js';
    document.head.appendChild(script);
    window.ym(COUNTER_ID, 'init', {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: false
    });
  }

  function injectStyles() {
    if (document.getElementById('stilConsentStyles')) return;
    var style = document.createElement('style');
    style.id = 'stilConsentStyles';
    style.textContent =
      '.stil-consent{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:420px;margin:0 auto;' +
      'display:flex;align-items:center;gap:12px;padding:8px 8px 8px 16px;border-radius:999px;' +
      'background:rgba(20,17,44,.92);color:#f4f2fb;box-shadow:0 6px 20px rgba(0,0,0,.25);' +
      'font-family:"Montserrat","Segoe UI",sans-serif;font-size:.78rem;line-height:1.3}' +
      '.stil-consent__text{flex:1}' +
      '.stil-consent a{color:#f0cc7d}' +
      '.stil-consent__btn{font:inherit;font-size:.78rem;font-weight:600;padding:7px 16px;border-radius:999px;cursor:pointer;' +
      'border:0;background:#e3bd67;color:#201a3d;white-space:nowrap}';
    document.head.appendChild(style);
  }

  function showBanner() {
    if (document.getElementById('stilConsent')) return;
    injectStyles();
    var box = document.createElement('div');
    box.className = 'stil-consent';
    box.id = 'stilConsent';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Cookie');

    var text = document.createElement('div');
    text.className = 'stil-consent__text';
    var link = document.createElement('a');
    link.href = 'legal-privacy.html#analytics';
    link.textContent = 'cookie';
    text.appendChild(document.createTextNode('Сайт использует '));
    text.appendChild(link);
    box.appendChild(text);

    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'stil-consent__btn';
    yes.textContent = 'Хорошо';
    box.appendChild(yes);

    yes.addEventListener('click', function () {
      writeConsent('yes');
      box.remove();
      loadMetrika();
    });

    document.body.appendChild(box);
  }

  /* Кнопка «Изменить выбор» в политике конфиденциальности. Отзыв согласия вступает в силу
     с перезагрузки страницы — уже загруженную Метрику на открытой странице не выгрузить. */
  window.stilAnalyticsConsentReset = function () {
    try { localStorage.removeItem(CONSENT_KEY); } catch (e) {}
    if (loaded) {
      window.location.reload();
      return;
    }
    showBanner();
  };

  function bindResetButton() {
    var resetBtn = document.getElementById('stilAnalyticsReset');
    if (resetBtn) resetBtn.addEventListener('click', window.stilAnalyticsConsentReset);
  }
  if (document.body) bindResetButton();
  else document.addEventListener('DOMContentLoaded', bindResetButton);

  if (!COUNTER_ID) return;

  var consent = readConsent();
  if (consent === 'yes') {
    loadMetrika();
  } else if (consent !== 'no') {
    if (document.body) showBanner();
    else document.addEventListener('DOMContentLoaded', showBanner);
  }
})();
