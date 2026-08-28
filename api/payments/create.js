/* ============================================================================
   POST /api/payments/create — начать оплату одной «Примерки» (полной или со
   скидкой по коду партнёра) картой через Robokassa.

   Требует залогиненного пользователя (Supabase JWT в Authorization: Bearer).
   Сумма НИКОГДА не берётся из тела запроса — сервер сам вычисляет её как
   ровно одну «Примерку» (998₽, или 499₽, если есть непогашенный код
   партнёра — см. hasAvailableDiscount в lib/wallet.js). Если в будущем
   понадобится отдельная оплата «Консультации виртуального стилиста» (другая
   цена) — это отдельный кейс, пока на сайте нет ни одной кнопки, которая её
   вызывает.

   Создаёт платёжную ссылку в Robokassa — окончательное зачисление на баланс
   происходит только в api/payments/webhook.js, после проверки подписи
   уведомления (см. lib/payments/robokassa.js).

   Раньше был и второй способ — временный ручной канал СБП с зачислением по
   честному слову владельца сайта (клиент переводил деньги лично ему, тот
   сверял поступление в банковском приложении и подтверждал вручную через
   admin-sbp-orders.html). Убран 2026-08-28 после того, как Robokassa
   заработала полностью — вместо честного слова теперь всегда автоматическая
   проверка подписи. Историю решения см. lib/payments/robokassa.js и
   DEPLOY-payments.md.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { createPaymentLink } = require('../../lib/payments/robokassa');
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
