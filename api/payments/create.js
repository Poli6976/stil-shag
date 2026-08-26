/* ============================================================================
   POST /api/payments/create — начать пополнение депозита.

   Требует залогиненного пользователя (Supabase JWT в Authorization: Bearer).
   По умолчанию (или body.provider === 'robokassa') создаёт платёжную ссылку
   в Robokassa — окончательное зачисление на баланс происходит только в
   api/payments/webhook.js, после проверки подписи уведомления (см.
   lib/payments/robokassa.js).

   При body.provider === 'sbp' — временный ручной канал (см. lib/payments/sbp.js
   и api/admin.js, action=sbp-confirm): вместо ссылки возвращает номер телефона
   для перевода и короткий код заказа, зачисление подтверждает вручную владелец
   сайта. Обе ветки пишут в одну и ту же таблицу payments (provider различает),
   поэтому api/admin.js может завершить платёж той же функцией finalizeTopup,
   что и вебхук Robokassa.

   Сумма для СБП НЕ берётся из тела запроса — сервер сам вычисляет её как
   ровно одну «Примерку» (полную или со скидкой, если есть непогашенный код
   партнёра), см. lib/lookAccess.js/hasAvailableDiscount. Иначе покупателю
   пришлось бы самому гадать, сколько переводить, а неверная сумма усложнила
   бы ручную сверку платежа владельцем сайта на admin-sbp-orders.html.
   Свободная сумма пополнения (amountKopecks из тела) остаётся только у
   Robokassa — это отдельный полноценный депозит, а не разовая оплата.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { createPaymentLink } = require('../../lib/payments/robokassa');
const { generateOrderCode } = require('../../lib/payments/sbp');
const { hasAvailableDiscount } = require('../../lib/wallet');
const PACKAGES = require('../../lib/packages');

const MIN_TOPUP_KOPECKS = 10000;    // 100 ₽ — не пускаем совсем мелкие/тестовые платежи
const MAX_TOPUP_KOPECKS = 30000000; // 300 000 ₽ — разумный потолок за один платёж

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Вход и оплата пока не настроены на сервере.' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет.' });
    return;
  }

  var provider = (req.body && req.body.provider) === 'sbp' ? 'sbp' : 'robokassa';

  if (provider === 'sbp') {
    if (!process.env.SBP_PHONE || !process.env.SBP_BANK || !process.env.SBP_RECIPIENT_NAME) {
      res.status(503).json({ error: 'Оплата по СБП пока не настроена на сервере.' });
      return;
    }
    try {
      var discounted = await hasAvailableDiscount(user.id);
      var sbpAmountKopecks = discounted ? PACKAGES.PRIMERKA_DISCOUNT.priceKopecks : PACKAGES.PRIMERKA.priceKopecks;
      var orderCode = generateOrderCode();
      var supabaseSbp = getSupabaseAdmin();
      var sbpInsert = await supabaseSbp.from('payments').insert({
        user_id: user.id,
        provider: 'sbp',
        provider_payment_id: orderCode,
        amount_kopecks: sbpAmountKopecks,
        status: 'pending',
        raw_payload: { orderCode: orderCode, discounted: discounted }
      });
      if (sbpInsert.error) throw sbpInsert.error;

      res.status(200).json({
        method: 'sbp',
        orderCode: orderCode,
        phone: process.env.SBP_PHONE,
        bank: process.env.SBP_BANK,
        recipientName: process.env.SBP_RECIPIENT_NAME,
        amountKopecks: sbpAmountKopecks,
        discounted: discounted
      });
    } catch (err) {
      console.error('payments/create (sbp) error:', err);
      res.status(502).json({ error: 'Не получилось создать заявку на оплату. Попробуйте ещё раз.' });
    }
    return;
  }

  var amountKopecks = Math.round(Number(req.body && req.body.amountKopecks));
  if (!Number.isFinite(amountKopecks) || amountKopecks < MIN_TOPUP_KOPECKS || amountKopecks > MAX_TOPUP_KOPECKS) {
    res.status(400).json({
      error: 'Сумма пополнения должна быть от ' + (MIN_TOPUP_KOPECKS / 100) + ' до ' + (MAX_TOPUP_KOPECKS / 100) + ' ₽.'
    });
    return;
  }

  if (!process.env.ROBOKASSA_MERCHANT_LOGIN || !process.env.ROBOKASSA_PASSWORD1) {
    res.status(503).json({ error: 'Оплата пока не настроена на сервере.' });
    return;
  }

  try {
    var payment = await createPaymentLink({
      amountKopecks: amountKopecks,
      description: 'Пополнение баланса — Стиль',
      customerEmail: user.email
    });

    var supabase = getSupabaseAdmin();
    var insertResult = await supabase.from('payments').insert({
      user_id: user.id,
      provider: 'robokassa',
      provider_payment_id: payment.orderId,
      amount_kopecks: amountKopecks,
      status: 'pending',
      raw_payload: { orderId: payment.orderId, link: payment.link }
    });
    if (insertResult.error) throw insertResult.error;

    res.status(200).json({ confirmationUrl: payment.link });
  } catch (err) {
    console.error('payments/create error:', err);
    res.status(502).json({ error: 'Не получилось создать платёж. Попробуйте ещё раз.' });
  }
};
