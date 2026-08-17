/* ============================================================================
   Право на один "образ" (визард или "Образ по фото") — общая точка входа для
   обоих генераторов, чтобы бизнес-правило было в одном месте, а не в двух
   копиях: первый образ бесплатен, дальше — скидка по коду партнёра (499 ₽)
   или полная цена (998 ₽) с депозита, см. lib/packages.js.

   Два раздельных шага для дорогих генераторов (api/compose-look.js):
     previewLookEntitlement — только чтение, без списания. Вызывать ДО дорогого
       обращения к GigaChat/YandexART, чтобы не тратить деньги на генерацию
       для того, кому нечем платить.
     chargeForLook — реальное списание (атомарно на уровне БД). Вызывать
       ТОЛЬКО после того, как генерация реально удалась — иначе неудачная
       попытка съедает бесплатный образ или деньги пользователя ни за что.
   Для дешёвых генераторов без реального ИИ-вызова (js/wizard.js) можно сразу
   звать chargeForLook — там нет риска "заплатили, но ничего не получили".
   ============================================================================ */

const { getSupabaseAdmin } = require('./supabaseAdmin');
const { consumeFreeLook, hasAvailableDiscount, debitForPackage, debitForDiscountedPrimerka } = require('./wallet');
const PACKAGES = require('./packages');

async function previewLookEntitlement(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('wallets')
    .select('free_look_used, balance_kopecks')
    .eq('user_id', userId)
    .single();
  if (result.error) throw result.error;

  if (!result.data.free_look_used) return true;

  var discount = await hasAvailableDiscount(userId);
  if (discount) return true;

  return result.data.balance_kopecks >= PACKAGES.PRIMERKA.priceKopecks;
}

async function chargeForLook(userId) {
  var gotFree = await consumeFreeLook(userId);
  if (gotFree) return { method: 'free' };

  var discount = await hasAvailableDiscount(userId);
  if (discount) {
    var d = await debitForDiscountedPrimerka(userId, 'PRIMERKA_DISCOUNT', PACKAGES.PRIMERKA_DISCOUNT.priceKopecks);
    return { method: 'discount', orderId: d.orderId, balanceKopecks: d.newBalanceKopecks };
  }

  var full = await debitForPackage(userId, 'PRIMERKA', PACKAGES.PRIMERKA.priceKopecks);
  return { method: 'paid', orderId: full.orderId, balanceKopecks: full.newBalanceKopecks };
}

module.exports = {
  previewLookEntitlement: previewLookEntitlement,
  chargeForLook: chargeForLook
};
