/* ============================================================================
   POST/GET /api/reviews — отзывы клиенток, показываются на how-it-works.html
   только после ручного одобрения владельцем (см. admin-reviews.html).

   Действия:
     POST body {action:'submit', text, age?} + Authorization: Bearer <jwt>
       — клиентка оставляет отзыв, сохраняется со статусом 'pending'.
     GET  query {action:'list-approved'}
       — публичный список одобренных отзывов, без авторизации (для
       how-it-works.html).
     GET  query {action:'list-looks'}
       — публичный список примеров образов, без авторизации (блок «Примеры
       готовых образов» на how-it-works.html). Управление образами —
       admin-looks.html / api/admin.js (action=list-site-looks/add-site-look/
       delete-site-look), не здесь — сюда сведено только публичное чтение,
       чтобы не заводить под него отдельный serverless-файл (см. комментарий
       в api/admin.js про лимит 12 функций на Vercel Hobby).
     GET  query {action:'list-pending'} + заголовок X-Admin-Key
       — очередь на модерацию (admin-reviews.html).
     POST body {action:'approve', adminKey, id}
       — одобрить отзыв, станет виден всем.
     POST body {action:'reject', adminKey, id}
       — отклонить и удалить отзыв безвозвратно.
     POST ?action=hit body {path, first, referrer, tag}
       — свой счётчик заходов без cookie (lib/visits.js, js/metrika.js). Сюда, а не
       в отдельный файл, — по той же причине лимита функций.

   Один файл вместо нескольких — на Vercel Hobby жёсткий лимит 12
   serverless-функций на деплой, слот под этот файл освобождён слиянием
   api/discount/status.js в api/wallet/summary.js (см. его комментарий).
   ============================================================================ */

const { requireUser } = require('../lib/auth');
const { checkAdminKey } = require('../lib/adminAuth');
const { checkRateLimit } = require('../lib/rateLimit');
const db = require('../lib/db');
const storage = require('../lib/storage');
const visits = require('../lib/visits');

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || (req.body && req.body.action);

  if (req.method === 'GET' && action === 'list-approved') return handleListApproved(req, res);
  if (req.method === 'POST' && action === 'submit') return handleSubmit(req, res);
  if (req.method === 'GET' && action === 'list-pending') return handleListPending(req, res);
  if (req.method === 'POST' && action === 'approve') return handleApprove(req, res);
  if (req.method === 'POST' && action === 'reject') return handleReject(req, res);
  if (req.method === 'GET' && action === 'list-looks') return handleListLooks(req, res);
  if (req.method === 'POST' && action === 'hit') return handleHit(req, res);
  res.status(400).json({ error: 'Неизвестное действие.' });
};

const SITE_LOOKS_BUCKET = 'site-looks';

/* Ответ всегда 204 и без подробностей: страница ответ не читает (sendBeacon), а сбой
   счётчика не должен ничего ломать на сайте. */
async function handleHit(req, res) {
  if (db.isConfigured()) {
    try {
      var body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      await visits.recordHit(body || {}, req.headers && req.headers['user-agent']);
    } catch (err) {
      console.error('reviews hit error:', err && err.message);
    }
  }
  res.status(204).end();
}

function requireDbEnv(res) {
  if (!db.isConfigured()) {
    res.status(503).json({ error: 'Не настроено на сервере.' });
    return false;
  }
  return true;
}

async function handleListApproved(req, res) {
  if (!requireDbEnv(res)) return;
  try {
    var result = await db.query(
      "select id, text, age, created_at from reviews where status = 'approved' order by created_at desc limit 12"
    );
    res.status(200).json({ reviews: result.rows });
  } catch (err) {
    console.error('reviews list-approved error:', err);
    res.status(500).json({ error: 'Не получилось загрузить отзывы.' });
  }
}

async function handleSubmit(req, res) {
  if (!requireDbEnv(res)) return;

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет, чтобы оставить отзыв.' });
    return;
  }

  // Отзыв ничего не стоит вызвать (нет платного внешнего API), но лимит всё
  // равно нужен — иначе один аккаунт может завалить очередь модерации.
  var allowed = await checkRateLimit(req, 'reviews-submit', { windowSeconds: 3600, maxHits: 5 });
  if (!allowed) {
    res.status(429).json({ error: 'Слишком много отзывов подряд. Попробуйте позже.' });
    return;
  }

  var text = typeof (req.body && req.body.text) === 'string' ? req.body.text.trim().slice(0, 600) : '';
  if (text.length < 10) {
    res.status(400).json({ error: 'Отзыв слишком короткий — напишите пару предложений.' });
    return;
  }
  var age = null;
  if (req.body && req.body.age != null && req.body.age !== '') {
    var n = parseInt(req.body.age, 10);
    if (n >= 10 && n <= 100) age = n;
  }

  try {
    var row = await db.one(
      "insert into reviews (user_id, text, age, status) values ($1, $2, $3, 'pending') returning id",
      [user.id, text, age]
    );
    res.status(200).json({ ok: true, id: row.id });
  } catch (err) {
    console.error('reviews submit error:', err);
    res.status(500).json({ error: 'Не получилось отправить отзыв. Попробуйте ещё раз.' });
  }
}

async function handleListPending(req, res) {
  if (!checkAdminKey(req.headers && req.headers['x-admin-key'])) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;
  try {
    var result = await db.query(
      "select id, text, age, created_at from reviews where status = 'pending' order by created_at asc"
    );
    res.status(200).json({ reviews: result.rows });
  } catch (err) {
    console.error('reviews list-pending error:', err);
    res.status(500).json({ error: 'Не получилось загрузить отзывы.' });
  }
}

async function handleApprove(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;
  var id = req.body && req.body.id;
  if (!id) {
    res.status(400).json({ error: 'Не хватает id.' });
    return;
  }
  try {
    await db.query("update reviews set status = 'approved' where id = $1", [id]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('reviews approve error:', err);
    res.status(500).json({ error: 'Не получилось одобрить отзыв.' });
  }
}

async function handleListLooks(req, res) {
  if (!requireDbEnv(res)) return;
  try {
    var result = await db.query('select id, image_path, caption from site_looks order by sort_order asc, created_at desc');

    var looks = result.rows.map(function (row) {
      /* Образ из папки сайта (assets/…) отдаём как есть; остальные — из публичного хранилища site-looks. */
      var publicUrl = /^assets\//.test(row.image_path)
        ? '/' + row.image_path
        : storage.publicUrl(SITE_LOOKS_BUCKET, row.image_path);
      return { id: row.id, caption: row.caption, imageUrl: publicUrl };
    });
    res.status(200).json({ looks: looks });
  } catch (err) {
    console.error('reviews list-looks error:', err);
    res.status(500).json({ error: 'Не получилось загрузить образы.' });
  }
}

async function handleReject(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;
  var id = req.body && req.body.id;
  if (!id) {
    res.status(400).json({ error: 'Не хватает id.' });
    return;
  }
  try {
    await db.query('delete from reviews where id = $1', [id]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('reviews reject error:', err);
    res.status(500).json({ error: 'Не получилось отклонить отзыв.' });
  }
}
