/* ============================================================================
   Яндекс.Метрика — сколько людей заходит на сайт, откуда и на каком шаге уходят.
   Подключается на всех страницах для покупательниц (не на admin-*.html).

   Метрика ставит cookie, а это обработка персональных данных (152-ФЗ), поэтому
   счётчик загружается ТОЛЬКО после согласия посетителя в плашке внизу экрана.
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
   ============================================================================ */

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
      '.stil-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;' +
      'padding:16px 18px;border-radius:16px;background:rgba(20,17,44,.96);color:#f4f2fb;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.35);font-family:"Montserrat","Segoe UI",sans-serif;font-size:.85rem;line-height:1.5}' +
      '.stil-consent a{color:#f0cc7d}' +
      '.stil-consent__actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}' +
      '.stil-consent__btn{font:inherit;font-size:.82rem;padding:9px 16px;border-radius:999px;cursor:pointer;border:1px solid rgba(195,203,230,.5);background:transparent;color:#f4f2fb}' +
      '.stil-consent__btn--yes{background:#e3bd67;border-color:#e3bd67;color:#201a3d;font-weight:600}';
    document.head.appendChild(style);
  }

  function showBanner() {
    if (document.getElementById('stilConsent')) return;
    injectStyles();
    var box = document.createElement('div');
    box.className = 'stil-consent';
    box.id = 'stilConsent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Статистика посещений');

    var text = document.createElement('div');
    text.appendChild(document.createTextNode(
      'Разрешите нам считать посещения сайта через Яндекс.Метрику — так мы поймём, что сделать удобнее. ' +
      'Метрика использует cookie; фото и ответы анкеты она не получает. '
    ));
    var link = document.createElement('a');
    link.href = 'legal-privacy.html#analytics';
    link.textContent = 'Подробнее';
    text.appendChild(link);
    box.appendChild(text);

    var actions = document.createElement('div');
    actions.className = 'stil-consent__actions';
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'stil-consent__btn stil-consent__btn--yes';
    yes.textContent = 'Разрешить';
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'stil-consent__btn';
    no.textContent = 'Не надо';
    actions.appendChild(yes);
    actions.appendChild(no);
    box.appendChild(actions);

    yes.addEventListener('click', function () {
      writeConsent('yes');
      box.remove();
      loadMetrika();
    });
    no.addEventListener('click', function () {
      writeConsent('no');
      box.remove();
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
