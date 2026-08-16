/* ============================================================================
   GET /api/config — публичные настройки для клиента (Supabase URL + anon key).

   Anon key — не секрет: он специально предназначен для браузера и защищён
   политиками RLS в базе (см. db/schema.sql), в отличие от
   SUPABASE_SERVICE_ROLE_KEY, который во фронтенд никогда не попадает.
   ============================================================================ */

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Только GET' });
    return;
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
