/* ============================================================================
   POST /api/payments/create — начать пополнение депозита.

   Требует залогиненного пользователя (Supabase JWT в Authorization: Bearer).
   Создаёт платёжную ссылку в Robokassa и сохраняет запись в таблице payments
   со статусом pending — окончательное зачисление на баланс происходит только
   в api/payments/webhook.js, и только после проверки подписи уведомления
   (см. lib/payments/robokassa.js).
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { createPaymentLink } = require('../../lib/payments/robokassa');

const MIN_TOPUP_KOPECKS = 10000;    // 100 ₽ — не пускаем совсем мелкие/тестовые платежи
const MAX_TOPUP_KOPECKS = 30000000; // 300 000 ₽ — разумный потолок за один платёж

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
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

  var amountKopecks = Math.round(Number(req.body && req.body.amountKopecks));
  if (!Number.isFinite(amountKopecks) || amountKopecks < MIN_TOPUP_KOPECKS || amountKopecks > MAX_TOPUP_KOPECKS) {
    res.status(400).json({
      error: 'Сумма пополнения должна быть от ' + (MIN_TOPUP_KOPECKS / 100) + ' до ' + (MAX_TOPUP_KOPECKS / 100) + ' ₽.'
    });
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
