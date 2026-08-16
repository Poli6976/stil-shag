/* ============================================================================
   POST /api/orders/create — оплатить пакетную услугу (см. lib/packages.js)
   списанием с депозита. Требует залогиненного пользователя.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { debitForPackage, debitForDiscountedPrimerka } = require('../../lib/wallet');
const PACKAGES = require('../../lib/packages');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет.' });
    return;
  }

  var packageCode = req.body && req.body.packageCode;
  var pkg = packageCode && PACKAGES[packageCode];
  if (!pkg) {
    res.status(400).json({ error: 'Неизвестный пакет услуги.' });
    return;
  }

  try {
    var result = packageCode === 'PRIMERKA_DISCOUNT'
      ? await debitForDiscountedPrimerka(user.id, packageCode, pkg.priceKopecks)
      : await debitForPackage(user.id, packageCode, pkg.priceKopecks);
    res.status(200).json({ orderId: result.orderId, balanceKopecks: result.newBalanceKopecks });
  } catch (err) {
    if (err.code === 'insufficient_funds') {
      res.status(402).json({ error: 'Недостаточно средств на балансе. Пополните депозит.' });
      return;
    }
    if (err.code === 'no_discount_available') {
      res.status(403).json({ error: 'Нет доступной скидки — сначала введите код партнёра в личном кабинете.' });
      return;
    }
    console.error('orders/create error:', err);
    res.status(500).json({ error: 'Не получилось оформить заказ. Попробуйте ещё раз.' });
  }
};
