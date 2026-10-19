/* ============================================================================
   POST /api/payments/webhook — приём уведомлений (ResultURL) от Robokassa.

   Доверие устанавливается подписью: MD5(OutSum:InvId:Пароль#2), сравнивается
   с параметром SignatureValue из уведомления (lib/payments/robokassa.js).
   Без верной подписи запрос отклоняется и заказ не считается оплаченным.

   Robokassa ожидает ответ строго текстом "OK<InvId>" (не JSON) — иначе считает
   уведомление недоставленным и повторяет. При ошибке на нашей стороне — HTTP 5xx,
   чтобы Robokassa повторила позже; проглатывать ошибку ответом "OK..." нельзя,
   иначе сбой БД навсегда потеряет оплату.

   2026-10-20 (ТЗ «Новые цены» v8): оплата больше не пополняет баланс — она
   подтверждает конкретный заказ (finalize_order_payment): образ → заказ
   «оплачен», пакет → +3 / +5 образов в запас. Идемпотентно: повторное
   уведомление об одной оплате ничего не начисляет второй раз. Сумма из
   уведомления сверяется с суммой заказа.
   ============================================================================ */

const { verifySignature } = require('../../lib/payments/robokassa');
const { finalizeOrderPayment } = require('../../lib/orders');

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
  var outSumKopecks = Math.round(parseFloat(String(outSum).replace(',', '.')) * 100);

  try {
    var result = await finalizeOrderPayment(orderId, outSumKopecks);
    if (result !== 'ok' && result !== 'already') {
      console.error('payments/webhook: оплата', orderId, '—', result);
    }
    res.status(200).send('OK' + orderId);
  } catch (err) {
    console.error('payments/webhook error:', err);
    res.status(500).send('internal');
  }
};
