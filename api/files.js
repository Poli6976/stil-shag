/* ============================================================================
   GET /api/files — картинки из хранилища в базе (lib/storage.js), вместо
   ссылок Supabase Storage (2026-10-23).
     ?b=looks&p=…&e=…&s=…   — картинка «Моих образов», только по подписанной
                              ссылке (выдаёт api/looks/saved.js, живёт 5 минут);
     ?b=avatars&p=…&v=…     — аватарка (публичная, как раньше);
     ?b=site-looks&p=…      — пример образа на сайте (публичный).

   GET ?action=cleanup — уборка по расписанию (Vercel Cron, vercel.json):
   старые коды входа, истёкшие сессии, счётчики лимитов. Если задан
   CRON_SECRET, выполняется только с ним (так его вызывает Vercel Cron).

   Отдельный файл (11-я функция из 12 возможных на Vercel Hobby) — картинки
   отдаются бинарно, а не JSON, и кэшируются браузером отдельно.
   ============================================================================ */

const auth = require('../lib/auth');
const db = require('../lib/db');
const storage = require('../lib/storage');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Только GET' });
    return;
  }
  if (!db.isConfigured()) {
    res.status(503).json({ error: 'Не настроено на сервере.' });
    return;
  }
  var q = req.query || {};

  if (q.action === 'cleanup') {
    if (process.env.CRON_SECRET) {
      var header = req.headers && (req.headers['authorization'] || req.headers['Authorization']);
      if (header !== 'Bearer ' + process.env.CRON_SECRET) {
        res.status(401).json({ error: 'Нет доступа.' });
        return;
      }
    }
    try {
      await auth.cleanup();
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('files cleanup error:', err && err.message);
      res.status(500).json({ error: 'Уборка не удалась.' });
    }
    return;
  }

  if (!storage.isAllowed(q.b, q.p, q.e, q.s)) {
    res.status(404).end();
    return;
  }

  try {
    var file = await storage.read(q.b, q.p);
    if (!file) {
      res.status(404).end();
      return;
    }
    var isPublic = storage.PUBLIC_BUCKETS.indexOf(q.b) !== -1;
    res.setHeader('Content-Type', file.content_type === 'image/png' ? 'image/png' : 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', isPublic ? 'public, max-age=86400' : 'private, max-age=300');
    res.status(200).send(file.data);
  } catch (err) {
    console.error('files read error:', err && err.message);
    res.status(500).end();
  }
};
