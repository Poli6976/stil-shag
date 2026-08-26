/* ============================================================================
   GET /api/discount/status — есть ли у залогиненного пользователя
   непотраченный скидочный кредит (погашенный, но ещё не использованный код
   партнёра). Используется в cabinet.html, чтобы показать реальный статус
   скидки вместо локального списка кодов в браузере.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { hasAvailableDiscount } = require('../../lib/wallet');

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
    var available = await hasAvailableDiscount(user.id);
    res.status(200).json({ hasAvailableDiscount: available });
  } catch (err) {
    console.error('discount/status error:', err);
    res.status(500).json({ error: 'Не получилось проверить скидку.' });
  }
};
