/* ============================================================================
   /api/looks/saved — «Мои образы» в личном кабинете.
     GET    — список сохранённых образов текущего пользователя; картинки —
              временными подписанными ссылками (истекают за несколько минут,
              см. lib/savedLooks.js), а не постоянными публичными URL.
     DELETE — удалить один образ по ?id=; сервер сам проверяет, что он
              принадлежит вызывающему, прежде чем стереть (id из тела/query
              никогда не доверяем напрямую).
              ?ids=a,b,c (до 100 шт.) — удаление группой (ТЗ v5, раздел 8);
              удаляются только образы этого пользователя.
     GET ?profile=1 — профиль стиля: согласие, прошлые ответы, подсказки,
              сводка оценок (ТЗ v5, разделы 7 и 10, lib/styleProfile.js).
     POST { action, ... } — оценка образа и управление профилем стиля:
              rate | remember | set-remember | forget-suggestion |
              clear-suggestions | forget-answer | reset-profile.

   Оба действия — на одном маршруте, а не в двух файлах: на Vercel Hobby
   жёсткий лимит 12 serverless-функций на деплой (см. комментарий в
   api/config.js), он уже был исчерпан. Слот освобождён объединением
   api/wallet/balance.js + api/wallet/history.js в api/wallet/summary.js.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { listLooks, deleteLook, deleteLooks } = require('../../lib/savedLooks');

const MAX_BULK_DELETE = 100;
const styleProfile = require('../../lib/styleProfile');
const { checkRateLimit } = require('../../lib/rateLimit');
const { isConfigured: isDbConfigured } = require('../../lib/db');

async function handlePost(req, res, user) {
  var allowed = await checkRateLimit(req, 'looks-profile', { windowSeconds: 600, maxHits: 120 });
  if (!allowed) {
    res.status(429).json({ error: 'Слишком много запросов подряд. Попробуйте через несколько минут.' });
    return;
  }
  var body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  try {
    switch (body.action) {
      case 'rate': {
        if (!isUuid(body.lookId) || [null, 'like', 'dislike'].indexOf(body.rating) === -1) {
          res.status(400).json({ error: 'Некорректная оценка.' });
          return;
        }
        var ok = await styleProfile.rateLook(user.id, body.lookId, body.rating, body.reasons, body.comment);
        if (!ok) { res.status(404).json({ error: 'Образ не найден.' }); return; }
        res.status(200).json({ saved: true });
        return;
      }
      case 'remember':
        res.status(200).json({ profile: await styleProfile.rememberAnswers(user.id, {
          fit: body.fit, fitConsent: body.fitConsent === true, isTeen: body.isTeen === true,
          item: body.item, answers: body.answers
        }) });
        return;
      case 'set-remember':
        res.status(200).json({ profile: await styleProfile.setRemember(user.id, body.value === true) });
        return;
      case 'forget-suggestion':
        if (body.kind !== 'fit' && body.kind !== 'item') { res.status(400).json({ error: 'Некорректный запрос.' }); return; }
        res.status(200).json({ profile: await styleProfile.forgetSuggestion(user.id, body.kind, body.value) });
        return;
      case 'clear-suggestions':
        res.status(200).json({ profile: await styleProfile.clearSuggestions(user.id) });
        return;
      case 'forget-answer':
        res.status(200).json({ profile: await styleProfile.forgetAnswer(user.id, body.key) });
        return;
      case 'reset-profile':
        res.status(200).json({ profile: await styleProfile.resetProfile(user.id) });
        return;
      default:
        res.status(400).json({ error: 'Неизвестное действие.' });
    }
  } catch (err) {
    console.error('looks/saved POST error:', err);
    res.status(500).json({ error: 'Не получилось сохранить. Попробуйте ещё раз.' });
  }
}

function isUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'POST') {
    res.status(405).json({ error: 'Только GET, POST или DELETE' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Вход пока не настроен на сервере.' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет.' });
    return;
  }

  if (req.method === 'POST') {
    await handlePost(req, res, user);
    return;
  }

  if (req.method === 'GET' && req.query && req.query.profile) {
    try {
      res.status(200).json(await styleProfile.getProfile(user.id));
    } catch (err) {
      console.error('looks/saved GET profile error:', err);
      res.status(500).json({ error: 'Не получилось загрузить профиль стиля.' });
    }
    return;
  }

  if (req.method === 'GET') {
    try {
      var looks = await listLooks(user.id);
      /* Оценки — дополнительно: если таблицы ещё нет (миграция не применена) или запрос упал,
         список образов всё равно отдаём. */
      try {
        var ratings = await styleProfile.ratingsForLooks(user.id, looks.map(function (l) { return l.id; }));
        looks.forEach(function (l) { l.rating = ratings[l.id] || null; });
      } catch (ratingErr) {
        console.error('looks/saved GET ratings error:', ratingErr);
      }
      res.status(200).json({ looks: looks });
    } catch (err) {
      console.error('looks/saved GET error:', err);
      res.status(500).json({ error: 'Не получилось загрузить сохранённые образы.' });
    }
    return;
  }

  var idsParam = req.query && req.query.ids;
  if (typeof idsParam === 'string' && idsParam) {
    var ids = idsParam.split(',');
    if (ids.length > MAX_BULK_DELETE || !ids.every(isUuid)) {
      res.status(400).json({ error: 'Некорректный список образов.' });
      return;
    }
    try {
      var deletedIds = await deleteLooks(user.id, ids);
      res.status(200).json({ deleted: deletedIds });
    } catch (err) {
      console.error('looks/saved bulk DELETE error:', err);
      res.status(500).json({ error: 'Не получилось удалить образы.' });
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
