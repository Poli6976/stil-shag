/* ============================================================================
   POST /api/payments/create — начать пополнение депозита.

   Требует залогиненного пользователя (Supabase JWT в Authorization: Bearer).
   Создаёт платёжную ссылку в Prodamus и сохраняет запись в таблице payments
   со статусом pending — окончательное зачисление на баланс происходит только
   в api/payments/webhook.js, и только после проверки подписи уведомления
   (см. lib/payments/prodamus.js).
   ============================================================================ */

const crypto = require('crypto');
const { requireUser } = require('../../lib/auth');
const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { createPaymentLink } = require('../../lib/payments/prodamus');

const MIN_TOPUP_KOPECKS = 10000;    // 100 ₽ — не пускаем совсем мелкие/тестовые платежи
const MAX_TOPUP_KOPECKS = 30000000; // 300 000 ₽ — разумный потолок за один платёж

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!process.env.PRODAMUS_SHOP_URL || !process.env.PRODAMUS_SECRET_KEY) {
    res.status(503).json({ error: 'Оплата пока не настроена на сервере.' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет.' });
    return;
  }

  var amountKopecks = Math.round(Number(req.body && req.body.amountKopecks));
  if (!Number.isFinite(amountKopecks) || amountKopecks < MIN_TOPUP_KOPECKS || amountKopecks > MAX_TOPUP_KOPECKS) {
    res.status(400).json({
      error: 'Сумма пополнения должна быть от ' + (MIN_TOPUP_KOPECKS / 100) + ' до ' + (MAX_TOPUP_KOPECKS / 100) + ' ₽.'
    });
    return;
  }

  try {
    var returnUrl = (process.env.SITE_URL || ('https://' + req.headers.host)) + '/cabinet.html';
    var notificationUrl = (process.env.SITE_URL || ('https://' + req.headers.host)) + '/api/payments/webhook';
    var orderId = crypto.randomUUID();

    var payment = await createPaymentLink({
      orderId: orderId,
      amountKopecks: amountKopecks,
      description: 'Пополнение баланса — Стиль',
      returnUrl: returnUrl,
      notificationUrl: notificationUrl,
      customerEmail: user.email
    });

    var supabase = getSupabaseAdmin();
    var insertResult = await supabase.from('payments').insert({
      user_id: user.id,
      provider: 'prodamus',
      provider_payment_id: orderId,
      amount_kopecks: amountKopecks,
      status: 'pending',
      raw_payload: { orderId: orderId, link: payment.link }
    });
    if (insertResult.error) throw insertResult.error;

    res.status(200).json({ confirmationUrl: payment.link });
  } catch (err) {
    console.error('payments/create error:', err);
    res.status(502).json({ error: 'Не получилось создать платёж. Попробуйте ещё раз.' });
  }
};
