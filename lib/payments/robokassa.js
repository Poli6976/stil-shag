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

/* Чек для «Робочеков СМЗ» (магазин самозанятого): одна позиция — название услуги и сумма заказа, без НДС.
   Без Receipt Robokassa пишет в операции «не передали номенклатуру товаров в чеке» (20.10.2026) и чек в «Мой налог»
   остаётся без названия услуги. Возвращает JSON, уже закодированный encodeURIComponent, либо '' —
   если выключен переменной ROBOKASSA_RECEIPT=0 (аварийный выключатель, если Robokassa вдруг не принимает чек). */
function buildReceipt(name, outSum) {
  if (process.env.ROBOKASSA_RECEIPT === '0' || !name) return '';
  var receipt = {
    items: [{
      name: String(name).slice(0, 128),
      quantity: 1,
      sum: Number(outSum),
      payment_method: 'full_payment',
      payment_object: 'service',
      tax: 'none'
    }]
  };
  return encodeURIComponent(JSON.stringify(receipt));
}

/* receipt — результат buildReceipt (или '' без чека): с чеком он входит в подпись между InvId и паролем. */
function buildLinkSignature(merchantLogin, outSum, invId, receipt, password1) {
  return md5(merchantLogin + ':' + outSum + ':' + invId + ':' + (receipt ? receipt + ':' : '') + password1);
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
  /* Тестовый режим (ROBOKASSA_DEMO_MODE=1): у Robokassa для тестовых платежей свои «Пароль #1/#2»
     (Технические настройки → Параметры проведения тестовых платежей) — если они заданы, подписываем ими. */
  var demo = process.env.ROBOKASSA_DEMO_MODE === '1';
  var password1 = (demo && process.env.ROBOKASSA_TEST_PASSWORD1) || process.env.ROBOKASSA_PASSWORD1;
  if (!merchantLogin || !password1) {
    throw new Error('ROBOKASSA_MERCHANT_LOGIN/ROBOKASSA_PASSWORD1 не настроены на сервере.');
  }

  var outSum = (opts.amountKopecks / 100).toFixed(2);
  var invId = generateInvId();
  var receipt = buildReceipt(opts.description, outSum);
  var signature = buildLinkSignature(merchantLogin, outSum, invId, receipt, password1);

  var params = new URLSearchParams();
  params.append('MerchantLogin', merchantLogin);
  params.append('OutSum', outSum);
  params.append('InvId', String(invId));
  params.append('Description', opts.description);
  /* Receipt в подписи — один раз закодированный (encodeURIComponent), а в ссылку URLSearchParams кодирует его
     второй раз — так требует Robokassa (docs.robokassa.ru/ru/fiscalization). */
  if (receipt) params.append('Receipt', receipt);
  params.append('SignatureValue', signature);
  params.append('Culture', 'ru');
  if (opts.customerEmail) params.append('Email', opts.customerEmail);
  if (demo) params.append('IsTest', '1');

  return {
    link: 'https://auth.robokassa.ru/Merchant/Index.aspx?' + params.toString(),
    orderId: String(invId)
  };
}

/* Запасной путь, если уведомление ResultURL до нас не дошло (20.10.2026 Robokassa получила
   «timed out» и сайт не засчитал оплату): спрашиваем у Robokassa сами — интерфейс OpStateExt,
   подпись MD5(MerchantLogin:InvoiceID:Пароль#2). Состояние 100 — оплачено.
   Возвращает { paid, outSumKopecks } или null, если ответ не получен или не разобран. */
function parseOpState(xml) {
  var result = /<Result>\s*<Code>(\d+)<\/Code>/.exec(xml);
  var state = /<State>\s*<Code>(\d+)<\/Code>/.exec(xml);
  var outSum = /<OutSum>([\d.,]+)<\/OutSum>/.exec(xml);
  if (!result || result[1] !== '0' || !state) return null;
  return {
    paid: state[1] === '100',
    outSumKopecks: outSum ? Math.round(parseFloat(outSum[1].replace(',', '.')) * 100) : null
  };
}

async function fetchPaymentState(invId) {
  var merchantLogin = process.env.ROBOKASSA_MERCHANT_LOGIN;
  var password2 = process.env.ROBOKASSA_PASSWORD2;
  if (!merchantLogin || !password2) return null;

  var params = new URLSearchParams();
  params.append('MerchantLogin', merchantLogin);
  params.append('InvoiceID', String(invId));
  params.append('Signature', md5(merchantLogin + ':' + invId + ':' + password2));

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 6000);
  try {
    var res = await fetch('https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt?' + params.toString(), {
      signal: controller.signal
    });
    if (!res.ok) {
      console.error('robokassa/fetchPaymentState: HTTP', res.status);
      return null;
    }
    return parseOpState(await res.text());
  } catch (err) {
    console.error('robokassa/fetchPaymentState:', err && err.name);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  createPaymentLink: createPaymentLink,
  verifySignature: verifySignature,
  buildResultSignature: buildResultSignature,
  fetchPaymentState: fetchPaymentState,
  parseOpState: parseOpState
};
