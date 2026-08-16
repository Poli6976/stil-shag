/* ============================================================================
   POST /api/payments/webhook — приём уведомлений от Prodamus.

   В отличие от ЮKassa, у Prodamus нет отдельного API «перезапросить статус
   платежа» — доверие устанавливается самой подписью запроса (заголовок Sign,
   HMAC-SHA256 секретным ключом от тела, отсортированного рекурсивно по
   ключам — см. lib/payments/prodamus.js). Поэтому здесь, в отличие от старой
   версии на ЮKassa, тело запроса используется напрямую как источник истины —
   но ТОЛЬКО после того, как подпись прошла проверку. Без верной подписи
   запрос отклоняется и деньги не зачисляются.

   Идемпотентно: если платёж уже не в статусе pending (обработан раньше),
   просто отвечаем 200 и ничего не делаем — см. finalize_topup в
   db/schema.sql, там та же проверка ещё раз, атомарно на уровне БД.

   На ошибку — HTTP 5xx, чтобы Prodamus повторил вебхук позже; проглатывать
   ошибку и отвечать 200 нельзя, иначе реальный сбой БД навсегда потеряет
   платёж.

   ВАЖНО: названия полей тела (order_id/sum/payment_status) — по документации
   Prodamus, не проверены вживую. Перед реальным приёмом денег свериться с
   тем, что Prodamus реально присылает (Личный кабинет → Настройки формы →
   Уведомления → отправленные запросы) — см. DEPLOY-payments.md.
   ============================================================================ */

const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { verifySignature } = require('../../lib/payments/prodamus');
const { finalizeTopup } = require('../../lib/wallet');

function extractOrderId(body) {
  return body.order_id || body.orderId || null;
}

function extractStatus(body) {
  var raw = body.payment_status || body.status || '';
  return String(raw).toLowerCase();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  if (!process.env.PRODAMUS_SECRET_KEY) {
    console.error('payments/webhook: PRODAMUS_SECRET_KEY не настроен на сервере.');
    res.status(500).json({ error: 'internal' });
    return;
  }

  var body = req.body || {};
  var receivedSign = req.headers['sign'] || req.headers['Sign'];

  if (!verifySignature(body, receivedSign, process.env.PRODAMUS_SECRET_KEY)) {
    console.error('payments/webhook: неверная подпись Prodamus.');
    res.status(400).json({ error: 'invalid signature' });
    return;
  }

  var orderId = extractOrderId(body);
  if (!orderId) {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    var supabase = getSupabaseAdmin();
    var found = await supabase
      .from('payments')
      .select('id, status')
      .eq('provider', 'prodamus')
      .eq('provider_payment_id', orderId)
      .maybeSingle();
    if (found.error) throw found.error;

    if (!found.data || found.data.status !== 'pending') {
      res.status(200).json({ ok: true });
      return;
    }

    var status = extractStatus(body);
    if (status === 'success' || status === 'succeeded' || status === 'paid' || status === '1') {
      await finalizeTopup(found.data.id, orderId);
    } else if (status === 'fail' || status === 'failed' || status === 'canceled' || status === 'cancelled') {
      await supabase
        .from('payments')
        .update({ status: 'failed', raw_payload: body, updated_at: new Date().toISOString() })
        .eq('id', found.data.id)
        .eq('status', 'pending');
    }
    // Любой другой/неизвестный статус — ничего не делаем, ждём следующее уведомление.

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('payments/webhook error:', err);
    res.status(500).json({ error: 'internal' });
  }
};
