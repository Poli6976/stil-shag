/* ============================================================================
   GET /api/config — публичные настройки для клиента (Supabase URL + anon key).

   Anon key — не секрет: он специально предназначен для браузера и защищён
   политиками RLS в базе (см. db/schema.sql), в отличие от
   SUPABASE_SERVICE_ROLE_KEY, который во фронтенд никогда не попадает.

   Этот же эндпоинт по расписанию дёргает Vercel Cron (см. vercel.json) —
   отдельного api/cron/*.js не заводили специально, чтобы не упереться в
   лимит Hobby-плана (не больше 12 serverless-функций на деплой, ровно
   столько их уже было). Когда приходит запрос с правильным CRON_SECRET,
   заодно делаем один реальный SELECT в Supabase — чтобы бесплатный тариф
   не поставил проект на паузу за 7 дней бездействия (уже случалось
   2026-08-26). Обычные вызовы с сайта (без секрета) этот SELECT не делают.
   ============================================================================ */

const { getSupabaseAdmin } = require('../lib/supabaseAdmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Только GET' });
    return;
  }

  if (process.env.CRON_SECRET) {
    var auth = req.headers && (req.headers['authorization'] || req.headers['Authorization']);
    if (auth === 'Bearer ' + process.env.CRON_SECRET) {
      try {
        var supabase = getSupabaseAdmin();
        await supabase.from('wallets').select('user_id').limit(1);
      } catch (err) {
        console.error('config cron keep-alive error:', err);
      }
    }
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    res.status(503).json({ error: 'Вход и оплата пока не настроены на сервере.' });
    return;
  }
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
};
