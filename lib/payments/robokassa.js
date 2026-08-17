/* ============================================================================
   Тонкий клиент Robokassa (robokassa.ru) — без SDK, тем же стилем, что и
   остальные внешние интеграции в проекте (голый https не нужен вообще, вся
   работа — это построение ссылки и проверка подписи, оба — чистая математика).

   Нужны в переменных окружения:
     ROBOKASSA_MERCHANT_LOGIN — логин магазина (Личный кабинет → Настройки магазина)
     ROBOKASSA_PASSWORD1      — «Пароль #1», подписывает ссылку на оплату
     ROBOKASSA_PASSWORD2      — «Пароль #2», подписывает уведомление ResultURL
                                 (сознательно другой пароль — компрометация
                                 ссылки на оплату не даёт подделать вебхук)

   ВАЖНО: ResultURL/SuccessURL/FailURL в этом клиенте НЕ передаются параметрами
   запроса (в отличие от некоторых готовых плагинов Robokassa) — они настраиваются
   один раз статически в Личном кабинете → Настройки магазина, см. DEPLOY-payments.md.
   Формулы подписи — по официальной документации docs.robokassa.ru, названия
   полей ResultURL (OutSum/InvId/SignatureValue) не проверены вживую с реальным
   магазином — перед приёмом настоящих денег прогнать один тестовый платёж
   (ROBOKASSA_DEMO_MODE=1) и свериться с тем, что Robokassa реально прислала.
   ============================================================================ */

const crypto = require('crypto');

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/* InvId у Robokassa — обязательно число (32-битное), не UUID как у остальных
   провайдеров в проекте — поэтому генерируем отдельно, а не переиспользуем
   orderId. Случайное 31-битное число, коллизия статистически ничтожна для
   масштаба проекта; уникальность всё равно подстрахована constraint'ом
   `unique (provider, provider_payment_id)` в db/schema.sql. */
function generateInvId() {
  return crypto.randomInt(1, 2000000000);
}

function buildLinkSignature(merchantLogin, outSum, invId, password1) {
  return md5(merchantLogin + ':' + outSum + ':' + invId + ':' + password1);
}

function buildResultSignature(outSum, invId, password2) {
  return md5(outSum + ':' + invId + ':' + password2);
}

function verifySignature(outSum, invId, receivedSignature, password2) {
  if (!receivedSignature) return false;
  var expected = buildResultSignature(outSum, invId, password2);
  var a = Buffer.from(expected, 'utf8');
  var b = Buffer.from(String(receivedSignature).trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function createPaymentLink(opts) {
  var merchantLogin = process.env.ROBOKASSA_MERCHANT_LOGIN;
  var password1 = process.env.ROBOKASSA_PASSWORD1;
  if (!merchantLogin || !password1) {
    throw new Error('ROBOKASSA_MERCHANT_LOGIN/ROBOKASSA_PASSWORD1 не настроены на сервере.');
  }

  var outSum = (opts.amountKopecks / 100).toFixed(2);
  var invId = generateInvId();
  var signature = buildLinkSignature(merchantLogin, outSum, invId, password1);

  var params = new URLSearchParams();
  params.append('MerchantLogin', merchantLogin);
  params.append('OutSum', outSum);
  params.append('InvId', String(invId));
  params.append('Description', opts.description);
  params.append('SignatureValue', signature);
  params.append('Culture', 'ru');
  if (opts.customerEmail) params.append('Email', opts.customerEmail);
  if (process.env.ROBOKASSA_DEMO_MODE === '1') params.append('IsTest', '1');

  return {
    link: 'https://auth.robokassa.ru/Merchant/Index.aspx?' + params.toString(),
    orderId: String(invId)
  };
}

module.exports = {
  createPaymentLink: createPaymentLink,
  verifySignature: verifySignature,
  buildResultSignature: buildResultSignature
};
