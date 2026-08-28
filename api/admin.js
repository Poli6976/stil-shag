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
     GET  query {action:'list-partners'} + заголовок X-Admin-Key
       — список партнёров со статистикой (admin-generate-code.html)
     POST body {action:'add-partner', adminKey, name, contact, notes}
       — завести нового партнёра
     POST body {action:'set-partner-status', adminKey, partnerId, status}
       — активировать/деактивировать партнёра (история кодов не удаляется)
     POST body {action:'generate-code', adminKey, partnerId, count, note}
       — выдать партнёру пачку кодов скидки программы «Примерка» (по умолчанию
       1, максимум 50 за раз)
     GET  query {action:'sbp-list'} + заголовок X-Admin-Key
       — список неподтверждённых ручных СБП-платежей (admin-sbp-orders.html)
     POST body {action:'sbp-confirm', adminKey, paymentId, orderCode}
       — подтвердить конкретный СБП-платёж, зачислить депозит
   ============================================================================ */

const crypto = require('crypto');
const { checkAdminKey } = require('../lib/adminAuth');
const { generateCode, sanitizeRef } = require('../lib/partnerCode');
const { getSupabaseAdmin } = require('../lib/supabaseAdmin');
const { finalizeTopup } = require('../lib/wallet');

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || (req.body && req.body.action);

  if (req.method === 'GET' && action === 'list-partners') {
    return handleListPartners(req, res);
  }
  if (req.method === 'POST' && action === 'add-partner') {
    return handleAddPartner(req, res);
  }
  if (req.method === 'POST' && action === 'set-partner-status') {
    return handleSetPartnerStatus(req, res);
  }
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

function requireSupabaseEnv(res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Не настроено на сервере.' });
    return false;
  }
  return true;
}

async function handleListPartners(req, res) {
  if (!checkAdminKey(req.headers && req.headers['x-admin-key'])) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireSupabaseEnv(res)) return;

  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase.from('partner_stats').select('*').order('created_at', { ascending: false });
    if (result.error) throw result.error;
    res.status(200).json({ partners: result.data });
  } catch (err) {
    console.error('admin list-partners error:', err);
    res.status(500).json({ error: 'Не получилось загрузить партнёров.' });
  }
}

async function handleAddPartner(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireSupabaseEnv(res)) return;

  var name = String((req.body && req.body.name) || '').trim();
  if (!name) {
    res.status(400).json({ error: 'Укажите название партнёра.' });
    return;
  }
  var contact = String((req.body && req.body.contact) || '').trim() || null;
  var notes = String((req.body && req.body.notes) || '').trim() || null;
  var baseSlug = sanitizeRef(name).slice(0, 6);

  try {
    var supabase = getSupabaseAdmin();
    // baseSlug почти всегда свободен — цикл только на случай совпадения с
    // уже существующим партнёром (например, два партнёра с похожим названием).
    for (var attempt = 0; attempt < 5; attempt++) {
      var trySlug = attempt === 0 ? baseSlug : baseSlug + crypto.randomBytes(1).toString('hex').toUpperCase();
      var insertResult = await supabase
        .from('partners')
        .insert({ name: name, slug: trySlug, contact: contact, status: 'active', notes: notes })
        .select()
        .single();
      if (!insertResult.error) {
        res.status(200).json({ partner: insertResult.data });
        return;
      }
      if (insertResult.error.code !== '23505') throw insertResult.error;
    }
    res.status(500).json({ error: 'Не получилось создать уникальную метку партнёра — попробуйте другое название.' });
  } catch (err) {
    console.error('admin add-partner error:', err);
    res.status(500).json({ error: 'Не получилось добавить партнёра.' });
  }
}

async function handleSetPartnerStatus(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireSupabaseEnv(res)) return;

  var partnerId = req.body && req.body.partnerId;
  var status = req.body && req.body.status;
  if (!partnerId || (status !== 'active' && status !== 'inactive')) {
    res.status(400).json({ error: 'Не хватает partnerId или status.' });
    return;
  }

  try {
    var supabase = getSupabaseAdmin();
    var result = await supabase.from('partners').update({ status: status }).eq('id', partnerId);
    if (result.error) throw result.error;
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin set-partner-status error:', err);
    res.status(500).json({ error: 'Не получилось изменить статус партнёра.' });
  }
}

async function handleGenerateCode(req, res) {
  if (!process.env.PARTNER_CODE_SECRET || !process.env.ADMIN_KEY) {
    res.status(503).json({ error: 'Генерация кодов пока не настроена на сервере.' });
    return;
  }
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireSupabaseEnv(res)) return;

  var partnerId = req.body && req.body.partnerId;
  if (!partnerId) {
    res.status(400).json({ error: 'Выберите партнёра.' });
    return;
  }
  var count = parseInt((req.body && req.body.count) || 1, 10);
  if (!count || count < 1) count = 1;
  if (count > 50) count = 50;
  var note = String((req.body && req.body.note) || '').trim() || null;

  try {
    var supabase = getSupabaseAdmin();
    var partnerResult = await supabase.from('partners').select('id, slug').eq('id', partnerId).single();
    if (partnerResult.error || !partnerResult.data) {
      res.status(404).json({ error: 'Партнёр не найден.' });
      return;
    }
    var slug = partnerResult.data.slug;

    var codes = [];
    var rows = [];
    for (var i = 0; i < count; i++) {
      // 3 случайных байта (6 hex-символов) поверх слага партнёра — коллизия
      // ref внутри одной пачки статистически ничтожна (< 1 на 16 млн), а без
      // уникального ref для каждого кода формула (lib/partnerCode.js) выдала
      // бы для всех кодов в пачке один и тот же код.
      var ref = (slug + crypto.randomBytes(3).toString('hex').toUpperCase()).slice(0, 12);
      var code = generateCode(process.env.PARTNER_CODE_SECRET, ref);
      codes.push(code);
      rows.push({ partner_id: partnerId, code: code, ref: ref, note: note });
    }

    var insertResult = await supabase.from('partner_codes').insert(rows);
    if (insertResult.error) throw insertResult.error;

    res.status(200).json({ codes: codes });
  } catch (err) {
    console.error('admin generate-code error:', err);
    res.status(500).json({ error: 'Не получилось выдать коды.' });
  }
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
