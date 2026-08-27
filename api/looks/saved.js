/* ============================================================================
   /api/looks/saved — «Мои образы» в личном кабинете.
     GET    — список сохранённых образов текущего пользователя; картинки —
              временными подписанными ссылками (истекают за несколько минут,
              см. lib/savedLooks.js), а не постоянными публичными URL.
     DELETE — удалить один образ по ?id=; сервер сам проверяет, что он
              принадлежит вызывающему, прежде чем стереть (id из тела/query
              никогда не доверяем напрямую).

   Оба действия — на одном маршруте, а не в двух файлах: на Vercel Hobby
   жёсткий лимит 12 serverless-функций на деплой (см. комментарий в
   api/config.js), он уже был исчерпан. Слот освобождён объединением
   api/wallet/balance.js + api/wallet/history.js в api/wallet/summary.js.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { listLooks, deleteLook } = require('../../lib/savedLooks');

function isUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    res.status(405).json({ error: 'Только GET или DELETE' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Вход пока не настроен на сервере.' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет.' });
    return;
  }

  if (req.method === 'GET') {
    try {
      var looks = await listLooks(user.id);
      res.status(200).json({ looks: looks });
    } catch (err) {
      console.error('looks/saved GET error:', err);
      res.status(500).json({ error: 'Не получилось загрузить сохранённые образы.' });
    }
    return;
  }

  var id = req.query && req.query.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Некорректный номер образа.' });
    return;
  }

  try {
    var removed = await deleteLook(user.id, id);
    if (!removed) {
      res.status(404).json({ error: 'Образ не найден.' });
      return;
    }
    res.status(200).json({ deleted: true });
  } catch (err) {
    console.error('looks/saved DELETE error:', err);
    res.status(500).json({ error: 'Не получилось удалить образ.' });
  }
};
