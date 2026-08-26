/* ============================================================================
   Проверка ADMIN_KEY — общая для всех служебных действий владельца сайта
   (генерация кодов «Примерки», подтверждение ручных СБП-платежей), см.
   api/admin.js. Раньше сравнение жило прямо внутри api/generate-code.js —
   вынесено сюда, когда появилось второе место, которому нужна та же проверка,
   чтобы не разойтись в двух копиях.
   ============================================================================ */

const crypto = require('crypto');

function checkAdminKey(given) {
  if (!process.env.ADMIN_KEY) return false;
  var a = Buffer.from(String(given || ''));
  var b = Buffer.from(process.env.ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { checkAdminKey: checkAdminKey };
