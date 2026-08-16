/* ============================================================================
   Формула кода программы «Примерка» — без базы данных.

   Код = REF (короткая метка, которую вводит владелец сайта при выдаче кода —
   например имя партнёра или дата) + подпись, где подпись = усечённый
   HMAC-SHA256(PARTNER_CODE_SECRET, REF), закодированный в Base32.

   Проверка — это пересчёт подписи по REF, который лежит прямо внутри кода
   открытым текстом, и сравнение с той частью, что уже записана в коде.
   Никакого хранилища не нужно ни для генерации, ни для проверки — код
   самодостаточен, вся логика — чистая функция от секрета.

   PARTNER_CODE_SECRET знает только сервер (переменная окружения). Если он
   утечёт — кто угодно сможет штамповать себе валидные коды, поэтому сама
   генерация вынесена в отдельный admin-only эндпоинт (api/generate-code.js)
   за ADMIN_KEY и никогда не выполняется в браузере.

   Эта функция только проверяет подпись — она не знает, погашен ли код уже.
   Отметка "код использован" хранится отдельно, в таблице discount_credits
   (db/schema.sql) с уникальным ограничением на code, и пишется в
   api/redeem-code.js после успешной проверки здесь. Так один код даёт ровно
   одну Примерку со скидкой (см. DEPLOY-partner-codes.md).
   ============================================================================ */

const crypto = require('crypto');

const PREFIX = 'STIL';
const MAC_BYTES = 5; // 40 бит подписи — без хранимого rate-limit'а этого достаточно против подбора для скидки, не для денег
const B32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford, без I/L/O/U — не спутать при вводе с телефона

function base32Encode(buffer) {
  var bits = '';
  for (var i = 0; i < buffer.length; i++) {
    bits += buffer[i].toString(2).padStart(8, '0');
  }
  var out = '';
  for (var j = 0; j + 5 <= bits.length; j += 5) {
    out += B32_ALPHABET[parseInt(bits.slice(j, j + 5), 2)];
  }
  return out;
}

function sanitizeRef(raw) {
  var cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) cleaned = base32Encode(crypto.randomBytes(4));
  return cleaned.slice(0, 12);
}

function sign(secret, ref) {
  var mac = crypto.createHmac('sha256', secret).update(ref).digest();
  return base32Encode(mac.slice(0, MAC_BYTES));
}

function generateCode(secret, rawRef) {
  var ref = sanitizeRef(rawRef);
  return PREFIX + '-' + ref + '-' + sign(secret, ref);
}

function verifyCode(secret, rawCode) {
  var code = String(rawCode || '').trim().toUpperCase();
  var parts = code.split('-');
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  var ref = parts[1];
  var mac = parts[2];
  if (!ref || !mac) return false;
  var expected = sign(secret, ref);
  if (expected.length !== mac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
}

module.exports = { generateCode: generateCode, verifyCode: verifyCode };
