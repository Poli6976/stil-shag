/* ============================================================================
   POST /api/payments/create — оплатить картой (Robokassa) один заказ из прайса
   (ТЗ «Новые цены» v8, 2026-10-20). Баланса на сайте больше нет: либо заказ
   оплачен и выполнен, либо ничего не произошло.

   Тело: { product: 'LOOK' | 'PACK_3' | 'PACK_5', answers?: {...} }
     LOOK — один образ: сервер сам выбирает цену — 370 ₽, если у клиентки есть
       непогашенный код партнёра (OBRAZ_PARTNER), иначе 590 ₽ (OBRAZ_PO_FOTO).
       Если в запасе есть образы из пакета — платить не нужно (409, useStock),
       сначала тратится запас. answers — ответы анкеты без фото, для истории
       заказа (сам образ собирает api/looks/charge.js после оплаты).
     PACK_3 / PACK_5 — пакет; код партнёра на пакеты не действует.
   Сумма НИКОГДА не берётся из запроса — только из lib/packages.js.

   Заказ и ожидающий платёж создаются одной транзакцией (create_order_with_payment);
   оплата подтверждается только в api/payments/webhook.js после проверки подписи.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { createPaymentLink } = require('../../lib/payments/robokassa');
const { getStock, hasAvailableDiscount, createOrderWithPayment } = require('../../lib/orders');
const PACKAGES = require('../../lib/packages');
const { isConfigured: isDbConfigured } = require('../../lib/db');

/* Ответы анкеты — только простые значения, без фото и не больше 4 КБ. */
function sanitizeAnswers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var out = {};
  Object.keys(raw).slice(0, 30).forEach(function (k) {
    if (k === 'itemPhoto') return;
    var v = raw[k];
    if (typeof v === 'string') out[String(k).slice(0, 40)] = v.slice(0, 500);
    else if (typeof v === 'boolean' || typeof v === 'number') out[String(k).slice(0, 40)] = v;
  });
  return JSON.stringify(out).length <= 4096 ? out : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Вход и оплата пока не настроены на сервере.' });
    return;
  }
  if (!process.env.ROBOKASSA_MERCHANT_LOGIN || !process.env.ROBOKASSA_PASSWORD1) {
    res.status(503).json({ error: 'Оплата пока не настроена на сервере.' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет.' });
    return;
  }

  var body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  var product = body.product;
  if (product !== 'LOOK' && product !== 'PACK_3' && product !== 'PACK_5') {
    res.status(400).json({ error: 'Неизвестный товар.' });
    return;
  }

  try {
    var packageCode = product;
    var answers = null;
    if (product === 'LOOK') {
      if ((await getStock(user.id)) > 0) {
        res.status(409).json({ useStock: true, error: 'У вас есть образы в запасе — этот образ соберём без оплаты.' });
        return;
      }
      packageCode = (await hasAvailableDiscount(user.id)) ? 'OBRAZ_PARTNER' : 'OBRAZ_PO_FOTO';
      answers = sanitizeAnswers(body.answers);
    }
    var pkg = PACKAGES[packageCode];

    var payment = await createPaymentLink({
      amountKopecks: pkg.priceKopecks,
      description: pkg.title,
      customerEmail: user.email
    });
    var orderId = await createOrderWithPayment(user.id, packageCode, answers, payment.orderId);

    res.status(200).json({
      confirmationUrl: payment.link,
      orderId: orderId,
      packageCode: packageCode,
      amountKopecks: pkg.priceKopecks
    });
  } catch (err) {
    console.error('payments/create error:', err);
    res.status(502).json({ error: 'Не получилось создать платёж. Попробуйте ещё раз.' });
  }
};
