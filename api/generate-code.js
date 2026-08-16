/* ============================================================================
   POST /api/generate-code — выдаёт код программы «Примерка».

   Только для владельца сайта — форма admin-generate-code.html. Требует
   ADMIN_KEY (отдельный секрет, не тот же самый, что PARTNER_CODE_SECRET) —
   без него сгенерировать код нельзя, иначе любой человек с этим URL мог бы
   штамповать себе бесконечные скидки. Партнёры кодов сами не генерируют:
   владелец сайта минтит код по запросу партнёра/покупателя и передаёт его.
   ============================================================================ */

const crypto = require('crypto');
const { generateCode } = require('../lib/partnerCode');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!process.env.PARTNER_CODE_SECRET || !process.env.ADMIN_KEY) {
    res.status(503).json({ error: 'Генерация кодов пока не настроена на сервере.' });
    return;
  }

  var given = Buffer.from(String((req.body && req.body.adminKey) || ''));
  var expected = Buffer.from(process.env.ADMIN_KEY);
  var authorized = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!authorized) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }

  var ref = req.body && req.body.ref;
  var code = generateCode(process.env.PARTNER_CODE_SECRET, ref);
  res.status(200).json({ code: code });
};
