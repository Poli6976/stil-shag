/* ============================================================================
   GET /api/wallet/balance — текущий баланс залогиненного пользователя.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { getBalance } = require('../../lib/wallet');

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
    res.status(200).json(wallet);
  } catch (err) {
    console.error('wallet/balance error:', err);
    res.status(500).json({ error: 'Не получилось загрузить баланс.' });
  }
};
