/* ============================================================================
   Тонкий клиент Prodamus (prodamus.ru) — без SDK, тем же стилем, что и
   остальные внешние интеграции в проекте (голый https, минимум зависимостей).
   Формула ссылки и подписи — по официальной документации:
   https://help.prodamus.ru/payform/integracii/rest-api/instrukcii-dlya-samostoyatelnaya-integracii-servisov

   Нужны два значения в переменных окружения:
     PRODAMUS_SHOP_URL    — адрес вашей платёжной формы, вида
                             https://ваш-магазин.payform.ru/
                             (Личный кабинет Prodamus → Настройки формы)
     PRODAMUS_SECRET_KEY  — секретный ключ формы (там же), используется
                             только для подписи и проверки подписи вебхука

   Про проверку вебхука: в отличие от ЮKassa (см. lib/payments/yookassa.js),
   у Prodamus нет отдельного API «перезапросить статус платежа» — доверие
   устанавливается самой подписью (заголовок Sign = HMAC-SHA256 секретным
   ключом от тела запроса, отсортированного рекурсивно по ключам). Поэтому
   api/payments/webhook.js для Prodamus доверяет телу запроса, но ТОЛЬКО
   после того, как подпись прошла проверку через verifySignature() ниже —
   без этого никакая подделанная нотификация не может зачислить деньги.

   ВАЖНО: точные названия полей тела уведомления (order_id/sum/payment_status)
   взяты из документации Prodamus, а не проверены вживую с реальным магазином.
   Перед приёмом настоящих денег обязательно прогнать один тестовый платёж
   (см. PRODAMUS_DEMO_MODE в .env.example) и свериться с тем, что Prodamus
   реально прислал — Личный кабинет → Настройки формы → Уведомления →
   отправленные запросы. Подробности — DEPLOY-payments.md.
   ============================================================================ */

const https = require('https');
const crypto = require('crypto');

function shopUrl() {
  var raw = process.env.PRODAMUS_SHOP_URL;
  if (!raw) throw new Error('PRODAMUS_SHOP_URL не настроен на сервере.');
  return raw.replace(/\/+$/, '') + '/';
}

/* Рекурсивно сортирует ключи объектов — как sort_keys=True в эталонной
   реализации подписи Prodamus. Массивы сохраняют порядок, сортируются
   только ключи вложенных объектов. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    var sorted = {};
    Object.keys(value).sort().forEach(function (key) {
      sorted[key] = sortKeysDeep(value[key]);
    });
    return sorted;
  }
  return value;
}

function sign(data, secret) {
  var json = JSON.stringify(sortKeysDeep(data)).replace(/\//g, '\\/');
  return crypto.createHmac('sha256', secret).update(json, 'utf8').digest('hex');
}

function verifySignature(body, receivedSign, secret) {
  if (!receivedSign) return false;
  var expected = sign(body, secret);
  var a = Buffer.from(expected, 'utf8');
  var b = Buffer.from(String(receivedSign).trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function buildLinkParams(opts) {
  var amountRub = (opts.amountKopecks / 100).toFixed(2);
  var params = new URLSearchParams();
  params.append('do', 'link');
  params.append('order_id', opts.orderId);
  params.append('products[0][name]', opts.description);
  params.append('products[0][price]', amountRub);
  params.append('products[0][quantity]', '1');
  if (opts.customerEmail) params.append('customer_email', opts.customerEmail);
  params.append('urlReturn', opts.returnUrl);
  params.append('urlSuccess', opts.returnUrl);
  if (opts.notificationUrl) params.append('urlNotification', opts.notificationUrl);
  if (process.env.PRODAMUS_DEMO_MODE === '1') params.append('demo_mode', '1');
  return params;
}

function requestLink(params) {
  return new Promise(function (resolve, reject) {
    var url = new URL(shopUrl());
    url.search = params.toString();
    https.get(url, { timeout: 15000 }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8').trim() });
      });
    })
      .on('timeout', function () { this.destroy(new Error('timeout')); })
      .on('error', reject);
  });
}

async function createPaymentLink(opts) {
  var res = await requestLink(buildLinkParams(opts));
  if (res.status !== 200) {
    throw new Error('Prodamus create payment link failed: ' + res.status + ' ' + res.raw);
  }
  var link = null;
  try {
    var parsed = JSON.parse(res.raw);
    link = parsed.link || parsed.url || null;
  } catch (e) {
    if (/^https?:\/\//.test(res.raw)) link = res.raw;
  }
  if (!link) {
    throw new Error('Prodamus create payment link: не удалось разобрать ответ — ' + res.raw);
  }
  return { link: link, orderId: opts.orderId };
}

module.exports = { createPaymentLink: createPaymentLink, verifySignature: verifySignature, sign: sign };
