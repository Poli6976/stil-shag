/* ============================================================================
   Право на один "образ" (визард или "Образ по фото") — общая точка входа для
   обоих генераторов, чтобы бизнес-правило было в одном месте, а не в двух
   копиях: бесплатные образы — это пунш-карта, которая пополняется ТОЛЬКО
   после оплаты, а не аванс до неё. Полная цена (998 ₽) начисляет 2 следующих
   образа бесплатно, оплата по коду партнёра (499 ₽) — 1 следующий образ
   бесплатно, см. lib/packages.js.

   2026-09-06 — решение пользователя: раньше первый образ был бесплатен всем
   без оплаты вообще, из-за чего можно было бесконечно фармить бесплатные
   образы новыми аккаунтами (заплатить 0 раз, получить образ, завести новый
   email, повторить). Теперь бесплатный образ — это награда после реальной
   оплаты, платить всё равно нужно хотя бы один раз, чтобы вообще получить
   бесплатный слот. Суммарная щедрость не изменилась (2 бесплатных на 1
   платный при полной цене) — изменился только порядок.

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

async function previewLookEntitlement(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('wallets')
    .select('free_credits_remaining, balance_kopecks')
    .eq('user_id', userId)
    .single();
  if (result.error) throw result.error;

  if (result.data.free_credits_remaining > 0) return true;

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
