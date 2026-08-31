/* ============================================================================
   GET /api/wallet/summary — баланс + история операций + статус скидки одним
   запросом. Раньше были отдельными api/wallet/balance.js и
   api/wallet/history.js — объединены, чтобы освободить слот в лимите Vercel
   Hobby (12 serverless-функций на деплой) под api/looks/saved.js. 2026-08-31 —
   сюда же вписан бывший api/discount/status.js, чтобы освободить ещё один
   слот под api/reviews.js (отзывы клиенток).
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { getBalance, getHistory, hasAvailableDiscount } = require('../../lib/wallet');

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
    var wallet = await getBalance(user.id);
    var history = await getHistory(user.id);
    var discount = await hasAvailableDiscount(user.id);
    res.status(200).json({
      balanceKopecks: wallet.balanceKopecks,
      currency: wallet.currency,
      history: history,
      hasAvailableDiscount: discount
    });
  } catch (err) {
    console.error('wallet/summary error:', err);
    res.status(500).json({ error: 'Не получилось загрузить кошелёк.' });
  }
};
