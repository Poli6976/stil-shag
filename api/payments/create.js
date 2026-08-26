/* ============================================================================
   POST /api/payments/create — начать оплату одной «Примерки» (полной или со
   скидкой по коду партнёра), картой через Robokassa или переводом по СБП.

   Требует залогиненного пользователя (Supabase JWT в Authorization: Bearer).
   Сумма НИКОГДА не берётся из тела запроса — сервер сам вычисляет её как
   ровно одну «Примерку» (998₽, или 499₽, если есть непогашенный код
   партнёра — см. hasAvailableDiscount в lib/wallet.js). Раньше клиент вводил
   сумму пополнения вручную (свободный депозит) — убрано по прямой просьбе
   пользователя: сумму приходилось гадать что при оплате картой, что при СБП,
   а неверная сумма особенно мешала владельцу сайта вручную сверять СБП-заявки
   на admin-sbp-orders.html. Если в будущем понадобится отдельная оплата
   «Консультации виртуального стилиста» (другая цена) — это отдельный кейс,
   пока на сайте нет ни одной кнопки, которая её вызывает.

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
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { createPaymentLink } = require('../../lib/payments/robokassa');
const { generateOrderCode } = require('../../lib/payments/sbp');
const { hasAvailableDiscount } = require('../../lib/wallet');
const PACKAGES = require('../../lib/packages');

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

  var discounted = await hasAvailableDiscount(user.id);
  var amountKopecks = discounted ? PACKAGES.PRIMERKA_DISCOUNT.priceKopecks : PACKAGES.PRIMERKA.priceKopecks;

  var provider = (req.body && req.body.provider) === 'sbp' ? 'sbp' : 'robokassa';

  if (provider === 'sbp') {
    if (!process.env.SBP_PHONE || !process.env.SBP_BANK || !process.env.SBP_RECIPIENT_NAME) {
      res.status(503).json({ error: 'Оплата по СБП пока не настроена на сервере.' });
      return;
    }
    try {
      var orderCode = generateOrderCode();
      var supabaseSbp = getSupabaseAdmin();
      var sbpInsert = await supabaseSbp.from('payments').insert({
        user_id: user.id,
        provider: 'sbp',
        provider_payment_id: orderCode,
        amount_kopecks: amountKopecks,
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
        amountKopecks: amountKopecks,
        discounted: discounted
      });
    } catch (err) {
      console.error('payments/create (sbp) error:', err);
      res.status(502).json({ error: 'Не получилось создать заявку на оплату. Попробуйте ещё раз.' });
    }
    return;
  }

  if (!process.env.ROBOKASSA_MERCHANT_LOGIN || !process.env.ROBOKASSA_PASSWORD1) {
    res.status(503).json({ error: 'Оплата пока не настроена на сервере.' });
    return;
  }

  try {
    var payment = await createPaymentLink({
      amountKopecks: amountKopecks,
      description: discounted ? PACKAGES.PRIMERKA_DISCOUNT.title : PACKAGES.PRIMERKA.title,
      customerEmail: user.email
    });

    var supabase = getSupabaseAdmin();
    var insertResult = await supabase.from('payments').insert({
      user_id: user.id,
      provider: 'robokassa',
      provider_payment_id: payment.orderId,
      amount_kopecks: amountKopecks,
      status: 'pending',
      raw_payload: { orderId: payment.orderId, link: payment.link, discounted: discounted }
    });
    if (insertResult.error) throw insertResult.error;

    res.status(200).json({ confirmationUrl: payment.link, amountKopecks: amountKopecks, discounted: discounted });
  } catch (err) {
    console.error('payments/create error:', err);
    res.status(502).json({ error: 'Не получилось создать платёж. Попробуйте ещё раз.' });
  }
};
