/* ============================================================================
   GET /api/cron/keep-alive — раз в сутки трогает Supabase реальным запросом,
   чтобы бесплатный тариф не поставил проект на паузу за 7 дней бездействия
   (уже случалось 2026-08-26 — пришлось восстанавливать вручную и чинить
   вслед за этим сломавшийся вход/кошелёк на проде). Вызывается Vercel Cron
   (см. vercel.json), не предназначен для ручных вызовов.
   ============================================================================ */

const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Только GET' });
    return;
  }
  if (process.env.CRON_SECRET) {
    var auth = req.headers && (req.headers['authorization'] || req.headers['Authorization']);
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) {
      res.status(401).json({ error: 'Не авторизовано' });
      return;
    }
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Supabase не настроен на сервере' });
    return;
  }

  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase.from('wallets').select('user_id').limit(1);
    if (result.error) throw result.error;
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('cron/keep-alive error:', err);
    res.status(500).json({ error: 'Не получилось выполнить пинг.' });
  }
};
