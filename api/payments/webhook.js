/* ============================================================================
   POST /api/payments/webhook — приём уведомлений (ResultURL) от Robokassa.

   Доверие устанавливается подписью: MD5(OutSum:InvId:Пароль#2), сравнивается
   с параметром SignatureValue из уведомления (lib/payments/robokassa.js).
   Без верной подписи запрос отклоняется и деньги не зачисляются.

   ВАЖНО, отличие от остальных провайдеров в проекте: Robokassa ожидает ответ
   строго в виде текста "OK<InvId>" (не JSON) — иначе считает уведомление
   недоставленным и повторяет попытки по своему расписанию. При любой ошибке
   на нашей стороне — HTTP 5xx с обычным текстом, чтобы Robokassa повторила
   позже; проглатывать ошибку текстом "OK..." нельзя, иначе реальный сбой БД
   навсегда потеряет платёж.

   Идемпотентно: если платёж уже не в статусе pending (обработан раньше),
   отвечаем "OK<InvId>" и ничего не делаем — см. finalize_topup в db/schema.sql,
   та же проверка ещё раз, атомарно на уровне БД.

   ВАЖНО: названия полей тела (OutSum/InvId/SignatureValue) — по документации
   Robokassa, не проверены вживую. Перед реальным приёмом денег свериться с
   тем, что Robokassa реально присылает — см. DEPLOY-payments.md.
   ============================================================================ */

const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { verifySignature } = require('../../lib/payments/robokassa');
const { finalizeTopup } = require('../../lib/wallet');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  if (!process.env.ROBOKASSA_PASSWORD2) {
    console.error('payments/webhook: ROBOKASSA_PASSWORD2 не настроен на сервере.');
    res.status(500).send('internal');
    return;
  }

  var body = req.body || {};
  var outSum = body.OutSum;
  var invId = body.InvId;
  var receivedSignature = body.SignatureValue;

  if (!outSum || !invId || !verifySignature(outSum, invId, receivedSignature, process.env.ROBOKASSA_PASSWORD2)) {
    console.error('payments/webhook: неверная подпись Robokassa.');
    res.status(400).send('bad sign');
    return;
  }

  var orderId = String(invId);

  try {
    var supabase = getSupabaseAdmin();
    var found = await supabase
      .from('payments')
      .select('id, status')
      .eq('provider', 'robokassa')
      .eq('provider_payment_id', orderId)
      .maybeSingle();
    if (found.error) throw found.error;

    if (found.data && found.data.status === 'pending') {
      await finalizeTopup(found.data.id, orderId);
    }
    // Нет записи или уже не pending (обработано раньше) — просто подтверждаем
    // получение, ничего не трогаем: Robokassa на ResultURL всегда шлёт успешную
    // оплату (для отказов есть отдельные FailURL/SuccessURL — это редиректы
    // браузера, не серверные уведомления, здесь не обрабатываются).

    res.status(200).send('OK' + orderId);
  } catch (err) {
    console.error('payments/webhook error:', err);
    res.status(500).send('internal');
  }
};
