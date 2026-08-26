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
const { getSupabaseAdmin } = require('../lib/supabaseAdmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
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
    var supabase = getSupabaseAdmin();
    var insertResult = await supabase.from('discount_credits').insert({ user_id: user.id, code: code });
    if (insertResult.error) {
      if (insertResult.error.code === '23505') {
        // code уже есть в таблице — кто-то (возможно, этот же пользователь) уже погасил его раньше.
        res.status(200).json({ valid: false, error: 'Этот код уже был погашен раньше.' });
        return;
      }
      throw insertResult.error;
    }
    res.status(200).json({ valid: true });
  } catch (err) {
    console.error('redeem-code error:', err);
    res.status(500).json({ error: 'Не получилось сохранить код. Попробуйте ещё раз.' });
  }
};
