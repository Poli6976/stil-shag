/* ============================================================================
   GET /api/wallet/history — последние операции по кошельку (пополнения и
   списания) залогиненного пользователя.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { getHistory } = require('../../lib/wallet');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Только GET' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет.' });
    return;
  }

  try {
    var history = await getHistory(user.id, 50);
    res.status(200).json({ history: history });
  } catch (err) {
    console.error('wallet/history error:', err);
    res.status(500).json({ error: 'Не получилось загрузить историю операций.' });
  }
};
