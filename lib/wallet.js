/* ============================================================================
   Операции с кошельком. Всё, что двигает деньги (finalizeTopup,
   debitForPackage), делегируется в SECURITY DEFINER функции Postgres
   (db/schema.sql) — там вся операция выполняется одной транзакцией БД,
   поэтому гонки при параллельных запросах и рассинхрон между таблицами
   исключены на уровне базы, а не понадеждой на порядок вызовов в JS.
   ============================================================================ */

const { getSupabaseAdmin } = require('./supabaseAdmin');

async function getBalance(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('wallets')
    .select('balance_kopecks, currency')
    .eq('user_id', userId)
    .single();
  if (result.error) throw result.error;
  return { balanceKopecks: result.data.balance_kopecks, currency: result.data.currency };
}

async function getHistory(userId, limit) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('wallet_transactions')
    .select('id, type, amount_kopecks, balance_after_kopecks, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit || 50);
  if (result.error) throw result.error;
  return result.data.map(function (row) {
    return {
      id: row.id,
      type: row.type,
      amountKopecks: row.amount_kopecks,
      balanceAfterKopecks: row.balance_after_kopecks,
      createdAt: row.created_at
    };
  });
}

async function finalizeTopup(paymentId, providerPaymentId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('finalize_topup', {
    p_payment_id: paymentId,
    p_provider_payment_id: providerPaymentId
  });
  if (result.error) throw result.error;
  return result.data; // новый баланс в копейках, либо null если уже обработан ранее
}

async function debitForPackage(userId, packageCode, priceKopecks) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('debit_wallet_for_package', {
    p_user_id: userId,
    p_package_code: packageCode,
    p_price_kopecks: priceKopecks
  });
  if (result.error) {
    if (result.error.message && result.error.message.indexOf('insufficient_funds') !== -1) {
      var err = new Error('insufficient_funds');
      err.code = 'insufficient_funds';
      throw err;
    }
    throw result.error;
  }
  var row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { orderId: row.order_id, newBalanceKopecks: row.new_balance };
}

async function debitForDiscountedPrimerka(userId, packageCode, priceKopecks) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('debit_wallet_for_discounted_primerka', {
    p_user_id: userId,
    p_package_code: packageCode,
    p_price_kopecks: priceKopecks
  });
  if (result.error) {
    var msg = result.error.message || '';
    if (msg.indexOf('no_discount_available') !== -1) {
      var noDiscountErr = new Error('no_discount_available');
      noDiscountErr.code = 'no_discount_available';
      throw noDiscountErr;
    }
    if (msg.indexOf('insufficient_funds') !== -1) {
      var fundsErr = new Error('insufficient_funds');
      fundsErr.code = 'insufficient_funds';
      throw fundsErr;
    }
    throw result.error;
  }
  var row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { orderId: row.order_id, newBalanceKopecks: row.new_balance };
}

/* Атомарно проверяет и занимает бесплатный слот (1-й или 3-й образ).
   Возвращает true, если именно этот вызов его занял (образ бесплатный),
   false — если этот номер образа платный (нужно платить/списывать скидку). */
async function consumeFreeLookSlot(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('consume_free_look_slot', { p_user_id: userId });
  if (result.error) throw result.error;
  return !!result.data;
}

/* Продвигает счётчик образов после ПЛАТНОГО образа (полная цена или скидка)
   — для бесплатного слота счётчик уже продвинут внутри consume_free_look_slot. */
async function incrementLooksCount(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase.rpc('increment_looks_count', { p_user_id: userId });
  if (result.error) throw result.error;
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

module.exports = {
  getBalance: getBalance,
  getHistory: getHistory,
  finalizeTopup: finalizeTopup,
  debitForPackage: debitForPackage,
  debitForDiscountedPrimerka: debitForDiscountedPrimerka,
  hasAvailableDiscount: hasAvailableDiscount,
  consumeFreeLookSlot: consumeFreeLookSlot,
  incrementLooksCount: incrementLooksCount
};
