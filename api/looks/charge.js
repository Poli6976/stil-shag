/* ============================================================================
   POST /api/looks/charge — списать право на один "образ" у визарда
   (online-stylist.html) перед показом демо-шаблона результата.

   Сама генерация тут бесплатна для нас (шаблоны в js/wizard.js статичные,
   никакого внешнего API) — но по бизнес-правилу первый образ на сайте
   бесплатен для всех, а дальше платно/по коду партнёра одинаково для обоих
   генераторов (см. lib/lookAccess.js), поэтому учёт нужен и здесь.

   "Образ по фото" (api/compose-look.js) списывает точно так же, но по месту,
   там своя двухшаговая проверка из-за реальной стоимости вызова ИИ.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { chargeForLook } = require('../../lib/lookAccess');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Вход и оплата пока не настроены на сервере.' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти по email.' });
    return;
  }

  try {
    var result = await chargeForLook(user.id);
    res.status(200).json(result);
  } catch (err) {
    if (err.code === 'insufficient_funds') {
      res.status(402).json({ error: 'Первый образ уже использован. Пополните баланс в личном кабинете, чтобы получить ещё один.' });
      return;
    }
    console.error('looks/charge error:', err);
    res.status(500).json({ error: 'Не получилось оформить образ. Попробуйте ещё раз.' });
  }
};
