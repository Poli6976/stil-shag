/* ============================================================================
   Простой rate-limit на Postgres (функция check_rate_limit, см.
   db/postgres/schema.sql, секция "Rate-limit"). Нужен там, где эндпоинт стоит денег
   за вызов, но не требует входа в личный кабинет — сейчас это только
   api/analyze-item.js (платный вызов GigaChat, доступен анонимно). Без этого
   любой мог бы дёргать эндпоинт напрямую (в обход сайта) сколько угодно раз
   и накручивать чужой счёт за внешний API. Ещё — вход по коду (lib/auth.js):
   там же лимит на один email, тогда req = null, а bucket — готовый ключ.

   Ключ — хэш IP-адреса (не сам IP: не храним его в открытом виде без нужды).
   При сбое самого лимитера — пропускаем запрос (fail open), чтобы поломка
   в этом коде не роняла рабочую функцию сайта.
   ============================================================================ */

const crypto = require('crypto');
const db = require('./db');

function clientKey(req) {
  var header = (req.headers && req.headers['x-forwarded-for']) || '';
  var ip = String(header).split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex');
}

async function checkRateLimit(req, bucket, opts) {
  var key = req ? bucket + ':' + clientKey(req) : bucket;
  try {
    var row = await db.one('select check_rate_limit($1, $2, $3) as allowed', [key, opts.windowSeconds, opts.maxHits]);
    return !!(row && row.allowed);
  } catch (err) {
    console.error('rateLimit check failed, failing open:', err);
    return true;
  }
}

module.exports = { checkRateLimit };
