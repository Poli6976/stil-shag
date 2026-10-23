/* ============================================================================
   /api/auth — вход по коду из письма и профиль (аватарка) — вместо Supabase
   Auth и прямой загрузки аватарки из браузера в Supabase Storage (2026-10-23).

   Действия:
     POST {action:'send-code', email}          — прислать 6-значный код на почту
     POST {action:'verify', email, code}       — проверить код → { session }
     GET  ?action=session  + Bearer            — текущая сессия (не истекла ли)
     POST {action:'logout'} + Bearer           — выйти (сессия удаляется)
     GET  ?action=profile  + Bearer            — { email, avatarUrl }
     POST {action:'set-avatar', image} + Bearer — image — data URL JPEG до 1 МБ
     POST {action:'remove-avatar'} + Bearer

   Сессия — { access_token, expires_at, user: { id, email } }, та же форма, что
   у Supabase: js/stil-auth.js кладёт её в браузер, остальные скрипты сайта
   шлют access_token в заголовке Authorization, как и раньше.

   Один файл на всё — лимит Vercel Hobby в 12 serverless-функций.
   ============================================================================ */

const auth = require('../lib/auth');
const db = require('../lib/db');
const storage = require('../lib/storage');
const { checkRateLimit } = require('../lib/rateLimit');

const AVATAR_BUCKET = 'avatars';
const MAX_AVATAR_BYTES = 1024 * 1024;

function readBody(req) {
  var body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return body;
}

function avatarUrl(row) {
  return row && row.avatar_path
    ? storage.publicUrl(AVATAR_BUCKET, row.avatar_path, new Date(row.updated_at).getTime())
    : null;
}

module.exports = async function handler(req, res) {
  if (!auth.isConfigured()) {
    res.status(503).json({ error: 'Вход пока не настроен на сервере.' });
    return;
  }
  var body = readBody(req);
  var action = (req.query && req.query.action) || body.action;

  try {
    if (req.method === 'POST' && action === 'send-code') {
      var sent = await auth.sendLoginCode(req, body.email);
      if (sent.error) { res.status(sent.status).json({ error: sent.error }); return; }
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'POST' && action === 'verify') {
      var allowed = await checkRateLimit(req, 'login-verify', { windowSeconds: 600, maxHits: 30 });
      if (!allowed) { res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 10 минут.' }); return; }
      var verified = await auth.verifyLoginCode(body.email, body.code);
      if (verified.error) { res.status(verified.status).json({ error: verified.error }); return; }
      res.status(200).json({ session: verified.session });
      return;
    }

    if (req.method === 'GET' && action === 'session') {
      var session = await auth.getSession(req);
      if (!session) { res.status(401).json({ error: 'Сессия истекла — войдите заново.' }); return; }
      res.status(200).json({ session: session });
      return;
    }

    if (req.method === 'POST' && action === 'logout') {
      await auth.logout(req);
      res.status(200).json({ ok: true });
      return;
    }

    var user = await auth.requireUser(req);
    if (!user) {
      res.status(401).json({ error: 'Нужно войти в личный кабинет.' });
      return;
    }

    if (req.method === 'GET' && action === 'profile') {
      var row = await db.one('select avatar_path, updated_at from wallets where user_id = $1', [user.id]);
      res.status(200).json({ email: user.email, avatarUrl: avatarUrl(row) });
      return;
    }

    if (req.method === 'POST' && action === 'set-avatar') {
      var match = typeof body.image === 'string' && body.image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      var buffer = match ? Buffer.from(match[1], 'base64') : null;
      if (!buffer || buffer.length < 100 || buffer.length > MAX_AVATAR_BYTES || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        res.status(400).json({ error: 'Не получилось прочитать фото — выберите другое.' });
        return;
      }
      var path = user.id + '/avatar.jpg';
      await storage.upload(AVATAR_BUCKET, path, buffer, 'image/jpeg');
      var updated = await db.one(
        'insert into wallets (user_id, avatar_path) values ($1, $2) on conflict (user_id) do update ' +
        'set avatar_path = excluded.avatar_path, updated_at = now() returning avatar_path, updated_at',
        [user.id, path]
      );
      res.status(200).json({ avatarUrl: avatarUrl(updated) });
      return;
    }

    if (req.method === 'POST' && action === 'remove-avatar') {
      await storage.remove(AVATAR_BUCKET, [user.id + '/avatar.jpg']);
      await db.query('update wallets set avatar_path = null, updated_at = now() where user_id = $1', [user.id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие.' });
  } catch (err) {
    console.error('auth ' + action + ' error:', err && err.message);
    res.status(500).json({ error: 'Что-то пошло не так. Попробуйте ещё раз.' });
  }
};
