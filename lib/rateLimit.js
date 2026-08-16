/* ============================================================================
   Простой rate-limit на Postgres (через SECURITY DEFINER функцию, см.
   db/schema.sql, секция "Rate-limit"). Нужен там, где эндпоинт стоит денег
   за вызов, но не требует входа в личный кабинет — сейчас это только
   api/analyze-item.js (платный вызов GigaChat, доступен анонимно). Без этого
   любой мог бы дёргать эндпоинт напрямую (в обход сайта) сколько угодно раз
   и накручивать чужой счёт за внешний API.

   Ключ — хэш IP-адреса (не сам IP: не храним его в открытом виде без нужды).
   При сбое самого лимитера — пропускаем запрос (fail open), чтобы поломка
   в этом коде не роняла рабочую функцию сайта.
   ============================================================================ */

const crypto = require('crypto');
const { getSupabaseAdmin } = require('./supabaseAdmin');

function clientKey(req) {
  var header = (req.headers && req.headers['x-forwarded-for']) || '';
  var ip = String(header).split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex');
}

async function checkRateLimit(req, bucket, opts) {
  var key = bucket + ':' + clientKey(req);
  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase.rpc('check_rate_limit', {
      p_bucket: key,
      p_window_seconds: opts.windowSeconds,
      p_max_hits: opts.maxHits
    });
    if (result.error) throw result.error;
    return !!result.data;
  } catch (err) {
    console.error('rateLimit check failed, failing open:', err);
    return true;
  }
}

module.exports = { checkRateLimit };
