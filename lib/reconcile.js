/* ============================================================================
   Сверка «зависших» оплат с Robokassa (2026-10-25).

   Уведомление Robokassa (ResultURL → api/payments/webhook.js) до сайта не
   доходило уже дважды (20.10 и 25.10, «timed out»), и оплата засчитывалась,
   только если клиентка возвращалась на сайт (анкета и кабинет сами спрашивают
   api/wallet/summary?order=). Эта сверка не зависит от клиентки: по расписанию
   (каждые 5 минут, cron на нашем сервере в Москве — см. scripts/setup-server.sh)
   берём платежи «pending» за последние сутки и спрашиваем Robokassa
   (OpStateExt). Оплаченные засчитываются тем же finalize_order_payment —
   идемпотентно, с проверкой суммы, повторы безопасны.

   Оплаченный, но не собранный за PAID_TO_STOCK_HOURS образ (клиентка оплатила и
   не вернулась — анкета помнит заказ только 3 часа, поэтому ждём 4) переходит в «образы в запасе»:
   его видно в кабинете, собрать можно в любой момент.
   ============================================================================ */

const db = require('./db');
const { fetchPaymentState } = require('./payments/robokassa');
const { finalizeOrderPayment } = require('./orders');

const WINDOW_HOURS = 24;
const MAX_PER_RUN = 20;
const PAID_TO_STOCK_HOURS = 4; // больше, чем анкета помнит неоплаченный заказ (3 ч), чтобы не пересечься с ней

/* Сколько образов перенесено в запас. Одним запросом: заказ «returned» + запас +1. */
async function moveStalePaidLooksToStock() {
  var result = await db.query(
    'with moved as (' +
    "  update orders set status = 'returned' where status = 'paid' " +
    "  and package_code in ('OBRAZ_PO_FOTO', 'OBRAZ_PARTNER') " +
    "  and created_at < now() - ($1 || ' hours')::interval returning user_id" +
    '), per_user as (select user_id, count(*)::int as n from moved group by user_id) ' +
    'update wallets w set looks_in_stock = w.looks_in_stock + p.n, updated_at = now() ' +
    'from per_user p where w.user_id = p.user_id returning p.n',
    [String(PAID_TO_STOCK_HOURS)]
  );
  return result.rows.reduce(function (sum, row) { return sum + row.n; }, 0);
}

/* { checked, credited, movedToStock } */
async function reconcilePendingPayments() {
  if (process.env.ROBOKASSA_DEMO_MODE === '1') return { checked: 0, credited: 0, movedToStock: 0 };

  var result = await db.query(
    "select provider_payment_id from payments where provider = 'robokassa' and status = 'pending' " +
    "and created_at > now() - ($1 || ' hours')::interval and created_at < now() - interval '1 minute' " +
    'order by created_at desc limit $2',
    [String(WINDOW_HOURS), MAX_PER_RUN]
  );

  var credited = 0;
  for (var i = 0; i < result.rows.length; i++) {
    var invId = result.rows[i].provider_payment_id;
    var state = await fetchPaymentState(invId);
    if (!state || !state.paid || !state.outSumKopecks) continue;
    try {
      var status = await finalizeOrderPayment(invId, state.outSumKopecks);
      if (status === 'ok') {
        credited++;
        console.warn('reconcile: оплата', invId, 'засчитана сверкой');
      }
    } catch (err) {
      console.error('reconcile: оплата', invId, err && err.message);
    }
  }
  var movedToStock = await moveStalePaidLooksToStock();
  if (movedToStock) console.warn('reconcile: оплаченных несобранных образов перенесено в запас:', movedToStock);
  return { checked: result.rows.length, credited: credited, movedToStock: movedToStock };
}

module.exports = { reconcilePendingPayments };
