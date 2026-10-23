/* ============================================================================
   Заказы и образы в запасе (ТЗ «Новые цены» v8, 2026-10-20) — вместо прежних
   lib/wallet.js (депозит) и lib/lookAccess.js (пунш-карта бесплатных образов).

   Всё, что двигает деньги и образы, — функции Postgres
   (db/postgres/schema.sql): каждая операция одной транзакцией БД, гонки
   двух параллельных запросов исключены на уровне базы.
   ============================================================================ */

const db = require('./db');
const PACKAGES = require('./packages');

function codedError(message) {
  var err = new Error(message);
  err.code = message;
  return err;
}

/* Функции базы сообщают об ожидаемых отказах через raise exception 'not_paid' и т. п. */
function rpcError(error) {
  var msg = (error && error.message) || '';
  ['not_paid', 'no_stock', 'amount_mismatch'].forEach(function (code) {
    if (msg.indexOf(code) !== -1) throw codedError(code);
  });
  throw error;
}

async function getStock(userId) {
  var row = await db.one('select looks_in_stock from wallets where user_id = $1', [userId]);
  return (row && row.looks_in_stock) || 0;
}

async function hasAvailableDiscount(userId) {
  var row = await db.one(
    "select exists (select 1 from discount_credits where user_id = $1 and status = 'available') as has",
    [userId]
  );
  return !!(row && row.has);
}

/* «Мои покупки»: только прошедшие оплаты (закрытая без оплаты форма заказа в список не попадает). */
async function listPurchases(userId, limit) {
  var result = await db.query(
    'select p.amount_kopecks, p.created_at, p.updated_at, o.package_code ' +
    'from payments p join orders o on o.id = p.order_id and o.user_id = p.user_id ' +
    "where p.user_id = $1 and p.status = 'succeeded' " +
    'order by p.created_at desc limit $2',
    [userId, limit || 50]
  );
  return result.rows.map(function (row) {
    var pkg = row.package_code && PACKAGES[row.package_code];
    return {
      title: pkg ? pkg.title : 'Покупка',
      amountKopecks: row.amount_kopecks,
      paidAt: row.updated_at || row.created_at
    };
  });
}

async function getOrderStatus(userId, orderId) {
  var row = await db.one('select id, status, package_code from orders where id = $1 and user_id = $2', [orderId, userId]);
  return row ? { id: row.id, status: row.status, packageCode: row.package_code } : null;
}

/* Номер платежа Robokassa (InvId) ещё не оплаченного заказа клиентки — для запасной проверки оплаты. */
async function getPendingInvId(userId, orderId) {
  var row = await db.one(
    "select provider_payment_id from payments where user_id = $1 and order_id = $2 and provider = 'robokassa' and status = 'pending'",
    [userId, orderId]
  );
  return row ? row.provider_payment_id : null;
}

async function createOrderWithPayment(userId, packageCode, answers, providerPaymentId) {
  var row = await db.one('select create_order_with_payment($1, $2, $3, $4::jsonb, $5) as id', [
    userId,
    packageCode,
    PACKAGES[packageCode].priceKopecks,
    answers ? JSON.stringify(answers) : null,
    providerPaymentId
  ]);
  return row.id;
}

/* 'ok' | 'already' | 'not_found' | 'no_order'; бросает amount_mismatch. */
async function finalizeOrderPayment(providerPaymentId, outSumKopecks) {
  try {
    var row = await db.one('select finalize_order_payment($1, $2) as result', [providerPaymentId, outSumKopecks]);
    return row.result;
  } catch (err) {
    rpcError(err);
  }
}

/* orderId — оплаченный заказ на один образ; null — образ из запаса. Бросает not_paid / no_stock. */
async function claimLook(userId, orderId) {
  try {
    var row = await db.one('select claim_look($1, $2) as id', [userId, orderId || null]);
    return row.id;
  } catch (err) {
    rpcError(err);
  }
}

async function returnLookToStock(userId, orderId) {
  var row = await db.one('select return_look_to_stock($1, $2) as ok', [userId, orderId]);
  return !!row.ok;
}

async function useRebuild(userId, orderId, undo) {
  var row = await db.one('select use_rebuild($1, $2, $3) as ok', [userId, orderId, !!undo]);
  return !!row.ok;
}

async function setOrderLook(userId, orderId, lookId) {
  await db.query('update orders set look_id = $1 where id = $2 and user_id = $3', [lookId, orderId, userId]);
}

module.exports = {
  getStock: getStock,
  hasAvailableDiscount: hasAvailableDiscount,
  listPurchases: listPurchases,
  getOrderStatus: getOrderStatus,
  getPendingInvId: getPendingInvId,
  createOrderWithPayment: createOrderWithPayment,
  finalizeOrderPayment: finalizeOrderPayment,
  claimLook: claimLook,
  returnLookToStock: returnLookToStock,
  useRebuild: useRebuild,
  setOrderLook: setOrderLook
};
