/* ============================================================================
   POST /api/redeem-code — погашение кода программы «Примерка».

   Код самодостаточен (формула — см. lib/partnerCode.js): сервер пересчитывает
   подпись по метке внутри кода и сравнивает, без обращения к хранилищу.

   Но чтобы скидка была именно одноразовой (один код — одна Примерка со
   скидкой, см. db/schema.sql), успешно проверенный код записывается в
   таблицу discount_credits на аккаунт залогиненного пользователя —
   уникальный индекс на code не даёт погасить один и тот же код дважды, даже
   в другом браузере или на другом аккаунте.
   ============================================================================ */

const { verifyCode } = require('../lib/partnerCode');
const { requireUser } = require('../lib/auth');
const db = require('../lib/db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!db.isConfigured()) {
    res.status(503).json({ error: 'Вход и оплата пока не настроены на сервере.' });
    return;
  }
  if (!process.env.PARTNER_CODE_SECRET) {
    res.status(503).json({ error: 'Проверка кодов пока не настроена на сервере.' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти в личный кабинет, чтобы ввести код.' });
    return;
  }

  var code = req.body && req.body.code;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Нет кода в запросе.' });
    return;
  }
  code = code.trim().toUpperCase();

  if (!verifyCode(process.env.PARTNER_CODE_SECRET, code)) {
    res.status(200).json({ valid: false });
    return;
  }

  try {
    await db.query('insert into discount_credits (user_id, code) values ($1, $2)', [user.id, code]);
    res.status(200).json({ valid: true });
  } catch (err) {
    if (err && err.code === '23505') {
      // code уже есть в таблице — кто-то (возможно, этот же пользователь) уже погасил его раньше.
      res.status(200).json({ valid: false, error: 'Этот код уже был погашен раньше.' });
      return;
    }
    console.error('redeem-code error:', err);
    res.status(500).json({ error: 'Не получилось сохранить код. Попробуйте ещё раз.' });
  }
};
