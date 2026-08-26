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
const { consumeFreeLookSlot, incrementLooksCount, hasAvailableDiscount, debitForPackage, debitForDiscountedPrimerka } = require('./wallet');
const PACKAGES = require('./packages');

/* 1-й и 3-й образ бесплатны (looks_count считает уже ЗАВЕРШЁННЫЕ образы, так
   что 0 = про предстоящий 1-й, 2 = про предстоящий 3-й). Решение пользователя
   2026-08-26 — вместо скидки без кода партнёра (та осталась эксклюзивной для
   партнёрской программы), поощрение повторных визитов сделали через ещё один
   бесплатный образ. Если правило снова поменяется — менять только эту
   функцию, она же используется как источник истины в consume_free_look_slot
   на стороне БД (db/schema.sql) — держать оба места в согласии. */
function isFreeLookNumber(looksCount) {
  return looksCount === 0 || looksCount === 2;
}

async function previewLookEntitlement(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('wallets')
    .select('looks_count, balance_kopecks')
    .eq('user_id', userId)
    .single();
  if (result.error) throw result.error;

  if (isFreeLookNumber(result.data.looks_count)) return true;

  var discount = await hasAvailableDiscount(userId);
  if (discount) return true;

  return result.data.balance_kopecks >= PACKAGES.PRIMERKA.priceKopecks;
}

async function chargeForLook(userId) {
  var gotFree = await consumeFreeLookSlot(userId);
  if (gotFree) return { method: 'free' };

  var discount = await hasAvailableDiscount(userId);
  if (discount) {
    var d = await debitForDiscountedPrimerka(userId, 'PRIMERKA_DISCOUNT', PACKAGES.PRIMERKA_DISCOUNT.priceKopecks);
    await incrementLooksCount(userId);
    return { method: 'discount', orderId: d.orderId, balanceKopecks: d.newBalanceKopecks };
  }

  var full = await debitForPackage(userId, 'PRIMERKA', PACKAGES.PRIMERKA.priceKopecks);
  await incrementLooksCount(userId);
  return { method: 'paid', orderId: full.orderId, balanceKopecks: full.newBalanceKopecks };
}

module.exports = {
  previewLookEntitlement: previewLookEntitlement,
  chargeForLook: chargeForLook
};
