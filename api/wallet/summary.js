/* ============================================================================
   GET /api/wallet/summary — «Мои покупки» одним запросом (ТЗ «Новые цены» v8,
   2026-10-20): образы в запасе, есть ли непогашенный код партнёра, список
   прошедших оплат. Баланса (депозита) больше нет.

   GET ?order=<id> — статус одного заказа клиентки (created / paid / done /
   returned / canceled): анкета после возврата с оплаты ждёт, пока
   api/payments/webhook.js отметит заказ оплаченным, и только тогда собирает образ.

   Один файл вместо нескольких — лимит Vercel Hobby в 12 serverless-функций.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { getStock, hasAvailableDiscount, listPurchases, getOrderStatus, getPendingInvId, finalizeOrderPayment } = require('../../lib/orders');
const { fetchPaymentState } = require('../../lib/payments/robokassa');
const PACKAGES = require('../../lib/packages');

/* Уведомление Robokassa (ResultURL) может не дойти — 20.10.2026 она получила «timed out», а клиентка
   заплатила и осталась без образа. Пока заказ «created», спрашиваем Robokassa сами; оплаченный
   засчитывается тем же finalize_order_payment (идемпотентно, сумма сверяется с заказом).
   В тестовом режиме не спрашиваем: тестовые платежи у Robokassa в этом интерфейсе не видны. */
async function confirmWithRobokassa(userId, order) {
  if (process.env.ROBOKASSA_DEMO_MODE === '1' || order.status !== 'created') return order;
  var invId = await getPendingInvId(userId, order.id);
  if (!invId) return order;
  var state = await fetchPaymentState(invId);
  if (!state || !state.paid || !state.outSumKopecks) return order;
  try {
    var result = await finalizeOrderPayment(invId, state.outSumKopecks);
    console.warn('wallet/summary: оплата', invId, 'засчитана запасным путём —', result);
  } catch (err) {
    console.error('wallet/summary: запасное засчитывание оплаты', invId, err && err.message);
    return order;
  }
  return (await getOrderStatus(userId, order.id)) || order;
}

function isUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Только GET' });
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

  try {
    var orderParam = req.query && req.query.order;
    if (orderParam) {
      if (!isUuid(orderParam)) {
        res.status(400).json({ error: 'Некорректный номер заказа.' });
        return;
      }
      var order = await getOrderStatus(user.id, orderParam);
      if (!order) {
        res.status(404).json({ error: 'Заказ не найден.' });
        return;
      }
      res.status(200).json({ order: await confirmWithRobokassa(user.id, order) });
      return;
    }

    var stock = await getStock(user.id);
    var discount = await hasAvailableDiscount(user.id);
    var purchases = await listPurchases(user.id);
    res.status(200).json({
      looksInStock: stock,
      hasAvailableDiscount: discount,
      purchases: purchases,
      prices: {
        look: PACKAGES.OBRAZ_PO_FOTO.priceKopecks,
        partner: PACKAGES.OBRAZ_PARTNER.priceKopecks,
        pack3: PACKAGES.PACK_3.priceKopecks,
        pack5: PACKAGES.PACK_5.priceKopecks
      }
    });
  } catch (err) {
    console.error('wallet/summary error:', err);
    res.status(500).json({ error: 'Не получилось загрузить покупки.' });
  }
};
