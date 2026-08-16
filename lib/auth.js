/* ============================================================================
   Проверка залогиненного пользователя по Supabase JWT из заголовка
   Authorization: Bearer <token>. Id пользователя ВСЕГДА берётся отсюда, а не
   из тела запроса — иначе клиент мог бы подставить чужой userId и залезть в
   чужой кошелёк.
   ============================================================================ */

const { getSupabaseAdmin } = require('./supabaseAdmin');

async function requireUser(req) {
  var header = req.headers && (req.headers['authorization'] || req.headers['Authorization']);
  var token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : null;
  if (!token) return null;

  var supabase = getSupabaseAdmin();
  var result = await supabase.auth.getUser(token);
  if (result.error || !result.data || !result.data.user) return null;
  return result.data.user;
}

module.exports = { requireUser };
