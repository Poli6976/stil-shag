/* ============================================================================
   Серверный клиент Supabase (service-role ключ) — обходит RLS, поэтому
   используется ТОЛЬКО внутри api/*.js (никогда не отправляется в браузер).
   Проверка "кто звонит" остаётся на нашей стороне: см. lib/auth.js.
   ============================================================================ */

const { createClient } = require('@supabase/supabase-js');

let client = null;

function getSupabaseAdmin() {
  if (client) return client;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не настроены на сервере.');
  }
  client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return client;
}

module.exports = { getSupabaseAdmin };
