/* ============================================================================
   POST/GET /api/reviews — отзывы клиенток, показываются на how-it-works.html
   только после ручного одобрения владельцем (см. admin-reviews.html).

   Действия:
     POST body {action:'submit', text, age?} + Authorization: Bearer <jwt>
       — клиентка оставляет отзыв, сохраняется со статусом 'pending'.
     GET  query {action:'list-approved'}
       — публичный список одобренных отзывов, без авторизации (для
       how-it-works.html).
     GET  query {action:'list-pending'} + заголовок X-Admin-Key
       — очередь на модерацию (admin-reviews.html).
     POST body {action:'approve', adminKey, id}
       — одобрить отзыв, станет виден всем.
     POST body {action:'reject', adminKey, id}
       — отклонить и удалить отзыв безвозвратно.

   Один файл вместо нескольких — на Vercel Hobby жёсткий лимит 12
   serverless-функций на деплой, слот под этот файл освобождён слиянием
   api/discount/status.js в api/wallet/summary.js (см. его комментарий).
   ============================================================================ */

const { requireUser } = require('../lib/auth');
const { checkAdminKey } = require('../lib/adminAuth');
const { checkRateLimit } = require('../lib/rateLimit');
const { getSupabaseAdmin } = require('../lib/supabaseAdmin');

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || (req.body && req.body.action);

  if (req.method === 'GET' && action === 'list-approved') return handleListApproved(req, res);
  if (req.method === 'POST' && action === 'submit') return handleSubmit(req, res);
  if (req.method === 'GET' && action === 'list-pending') return handleListPending(req, res);
  if (req.method === 'POST' && action === 'approve') return handleApprove(req, res);
  if (req.method === 'POST' && action === 'reject') return handleReject(req, res);
  res.status(400).json({ error: 'Неизвестное действие.' });
};

function requireSupabaseEnv(res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Не настроено на сервере.' });
    return false;
  }
  return true;
}

async function handleListApproved(req, res) {
  if (!requireSupabaseEnv(res)) return;
  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase
      .from('reviews')
      .select('id, text, age, created_at')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(12);
    if (result.error) throw result.error;
    res.status(200).json({ reviews: result.data });
  } catch (err) {
    console.error('reviews list-approved error:', err);
    res.status(500).json({ error: 'Не получилось загрузить отзывы.' });
  }
}

async function handleSubmit(req, res) {
  if (!requireSupabaseEnv(res)) return;

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
    var supabase = getSupabaseAdmin();
    var result = await supabase
      .from('reviews')
      .insert({ user_id: user.id, text: text, age: age, status: 'pending' })
      .select('id')
      .single();
    if (result.error) throw result.error;
    res.status(200).json({ ok: true, id: result.data.id });
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
  if (!requireSupabaseEnv(res)) return;
  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase
      .from('reviews')
      .select('id, text, age, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (result.error) throw result.error;
    res.status(200).json({ reviews: result.data });
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
  if (!requireSupabaseEnv(res)) return;
  var id = req.body && req.body.id;
  if (!id) {
    res.status(400).json({ error: 'Не хватает id.' });
    return;
  }
  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase.from('reviews').update({ status: 'approved' }).eq('id', id);
    if (result.error) throw result.error;
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('reviews approve error:', err);
    res.status(500).json({ error: 'Не получилось одобрить отзыв.' });
  }
}

async function handleReject(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireSupabaseEnv(res)) return;
  var id = req.body && req.body.id;
  if (!id) {
    res.status(400).json({ error: 'Не хватает id.' });
    return;
  }
  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase.from('reviews').delete().eq('id', id);
    if (result.error) throw result.error;
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('reviews reject error:', err);
    res.status(500).json({ error: 'Не получилось отклонить отзыв.' });
  }
}
