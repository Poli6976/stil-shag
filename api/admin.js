/* ============================================================================
   Единая точка для служебных действий владельца сайта — только для него,
   ни одна из веток не ссылается ниоткуда со страниц для покупателей.

   Раньше это было три отдельных файла (api/generate-code.js для кодов
   «Примерки», плюс два новых под ручное подтверждение СБП) — на Hobby-плане
   Vercel лимит 12 serverless-функций на деплой, и он уже был выбран целиком
   существующими api/*.js (см. .env.example). Три отдельных файла пробили бы
   лимит, поэтому все служебные действия сведены в один файл с action-роутингом
   вместо трёх маленьких. Если в будущем понадобится ещё одно админ-действие —
   добавлять веткой сюда же, не новым файлом.

   Все ветки требуют ADMIN_KEY (lib/adminAuth.js) — без него ничего не
   выполняется:
     POST body {action:'generate-code', adminKey, ref}
       — выдать код скидки программы «Примерка» (admin-generate-code.html)
     GET  query {action:'sbp-list'} + заголовок X-Admin-Key
       — список неподтверждённых ручных СБП-платежей (admin-sbp-orders.html)
     POST body {action:'sbp-confirm', adminKey, paymentId, orderCode}
       — подтвердить конкретный СБП-платёж, зачислить депозит
   ============================================================================ */

const { checkAdminKey } = require('../lib/adminAuth');
const { generateCode } = require('../lib/partnerCode');
const { getSupabaseAdmin } = require('../lib/supabaseAdmin');
const { finalizeTopup } = require('../lib/wallet');

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || (req.body && req.body.action);

  if (req.method === 'POST' && action === 'generate-code') {
    return handleGenerateCode(req, res);
  }
  if (req.method === 'GET' && action === 'sbp-list') {
    return handleSbpList(req, res);
  }
  if (req.method === 'POST' && action === 'sbp-confirm') {
    return handleSbpConfirm(req, res);
  }
  res.status(400).json({ error: 'Неизвестное действие.' });
};

async function handleGenerateCode(req, res) {
  if (!process.env.PARTNER_CODE_SECRET || !process.env.ADMIN_KEY) {
    res.status(503).json({ error: 'Генерация кодов пока не настроена на сервере.' });
    return;
  }
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }

  var code = generateCode(process.env.PARTNER_CODE_SECRET, req.body && req.body.ref);
  res.status(200).json({ code: code });
}

async function handleSbpList(req, res) {
  if (!checkAdminKey(req.headers && req.headers['x-admin-key'])) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Не настроено на сервере.' });
    return;
  }

  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase
      .from('payments')
      .select('id, provider_payment_id, amount_kopecks, user_id, created_at')
      .eq('provider', 'sbp')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (result.error) throw result.error;

    var orders = await Promise.all(result.data.map(async function (row) {
      var email = null;
      try {
        var userRes = await supabase.auth.admin.getUserById(row.user_id);
        email = (userRes.data && userRes.data.user && userRes.data.user.email) || null;
      } catch (e) {
        // Не критично — заявку всё равно можно сверить по сумме/коду.
      }
      return {
        paymentId: row.id,
        orderCode: row.provider_payment_id,
        amountKopecks: row.amount_kopecks,
        email: email,
        createdAt: row.created_at
      };
    }));

    res.status(200).json({ orders: orders });
  } catch (err) {
    console.error('admin sbp-list error:', err);
    res.status(500).json({ error: 'Не получилось загрузить заявки.' });
  }
}

async function handleSbpConfirm(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Не настроено на сервере.' });
    return;
  }

  var paymentId = req.body && req.body.paymentId;
  var orderCode = req.body && req.body.orderCode;
  if (!paymentId || !orderCode) {
    res.status(400).json({ error: 'Не хватает paymentId или orderCode.' });
    return;
  }

  try {
    var newBalance = await finalizeTopup(paymentId, orderCode);
    if (newBalance === null) {
      res.status(409).json({ error: 'Заявка уже обработана или не найдена.' });
      return;
    }
    res.status(200).json({ newBalanceKopecks: newBalance });
  } catch (err) {
    console.error('admin sbp-confirm error:', err);
    res.status(500).json({ error: 'Не получилось подтвердить платёж.' });
  }
}
