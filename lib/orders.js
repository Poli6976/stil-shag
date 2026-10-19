/* ============================================================================
   Заказы и образы в запасе (ТЗ «Новые цены» v8, 2026-10-20) — вместо прежних
   lib/wallet.js (депозит) и lib/lookAccess.js (пунш-карта «2 / 1 в подарок»).

   Всё, что двигает деньги и образы, — SECURITY DEFINER функции Postgres
   (db/2026-10-20-new-prices.sql): каждая операция одной транзакцией БД, гонки
   двух параллельных запросов исключены на уровне базы.
   ============================================================================ */

const { getSupabaseAdmin } = require('./supabaseAdmin');
const PACKAGES = require('./packages');

function codedError(message) {
  var err = new Error(message);
  err.code = message;
  return err;
}

function rpcError(error) {
  var msg = (error && error.message) || '';
  ['not_paid', 'no_stock', 'amount_mismatch'].forEach(function (code) {
    if (msg.indexOf(code) !== -1) throw codedError(code);
  });
  throw error;
}

async function getStock(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.from('wallets').select('looks_in_stock').eq('user_id', userId).maybeSingle();
  if (result.error) throw result.error;
  return (result.data && result.data.looks_in_stock) || 0;
}

async function hasAvailableDiscount(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('discount_credits')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'available');
  if (result.error) throw result.error;
  return (result.count || 0) > 0;
}

/* «Мои покупки»: только прошедшие оплаты (закрытая без оплаты форма заказа в список не попадает). */
async function listPurchases(userId, limit) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('payments')
    .select('amount_kopecks, created_at, updated_at, order_id')
    .eq('user_id', userId)
    .eq('status', 'succeeded')
    .not('order_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit || 50);
  if (result.error) throw result.error;
  /* Два простых запроса вместо встроенного JOIN: между payments и orders две связи (order_id и
     payment_id), и PostgREST без явного имени связи не знает, по какой соединять. */
  var codes = {};
  var orderIds = result.data.map(function (row) { return row.order_id; });
  if (orderIds.length) {
    var ordersResult = await supabase.from('orders').select('id, package_code').eq('user_id', userId).in('id', orderIds);
    if (ordersResult.error) throw ordersResult.error;
    ordersResult.data.forEach(function (o) { codes[o.id] = o.package_code; });
  }
  return result.data.map(function (row) {
    var code = codes[row.order_id];
    var pkg = code && PACKAGES[code];
    return {
      title: pkg ? pkg.title : 'Покупка',
      amountKopecks: row.amount_kopecks,
      paidAt: row.updated_at || row.created_at
    };
  });
}

async function getOrderStatus(userId, orderId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('orders')
    .select('id, status, package_code')
    .eq('id', orderId)
    .eq('user_id', userId)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data ? { id: result.data.id, status: result.data.status, packageCode: result.data.package_code } : null;
}

async function createOrderWithPayment(userId, packageCode, answers, providerPaymentId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('create_order_with_payment', {
    p_user_id: userId,
    p_package_code: packageCode,
    p_price_kopecks: PACKAGES[packageCode].priceKopecks,
    p_answers: answers || null,
    p_provider_payment_id: providerPaymentId
  });
  if (result.error) throw result.error;
  return result.data;
}

/* 'ok' | 'already' | 'not_found' | 'no_order'; бросает amount_mismatch. */
async function finalizeOrderPayment(providerPaymentId, outSumKopecks) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('finalize_order_payment', {
    p_provider_payment_id: providerPaymentId,
    p_out_sum_kopecks: outSumKopecks
  });
  if (result.error) rpcError(result.error);
  return result.data;
}

/* orderId — оплаченный заказ на один образ; null — образ из запаса. Бросает not_paid / no_stock. */
async function claimLook(userId, orderId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('claim_look', { p_user_id: userId, p_order_id: orderId || null });
  if (result.error) rpcError(result.error);
  return result.data;
}

async function returnLookToStock(userId, orderId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('return_look_to_stock', { p_user_id: userId, p_order_id: orderId });
  if (result.error) throw result.error;
  return !!result.data;
}

async function useRebuild(userId, orderId, undo) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('use_rebuild', { p_user_id: userId, p_order_id: orderId, p_undo: !!undo });
  if (result.error) throw result.error;
  return !!result.data;
}

async function setOrderLook(userId, orderId, lookId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.from('orders').update({ look_id: lookId }).eq('id', orderId).eq('user_id', userId);
  if (result.error) throw result.error;
}

module.exports = {
  getStock: getStock,
  hasAvailableDiscount: hasAvailableDiscount,
  listPurchases: listPurchases,
  getOrderStatus: getOrderStatus,
  createOrderWithPayment: createOrderWithPayment,
  finalizeOrderPayment: finalizeOrderPayment,
  claimLook: claimLook,
  returnLookToStock: returnLookToStock,
  useRebuild: useRebuild,
  setOrderLook: setOrderLook
};
