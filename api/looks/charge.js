/* ============================================================================
   POST /api/looks/charge — списать право на один "образ" у визарда
   (online-stylist.html) и, если получится, нарисовать картинку по уже
   готовому тексту образа (слои считает клиент из статичных шаблонов
   js/wizard.js — сюда приходит готовый результат, GigaChat не нужен, он
   только ОПИСЫВАЕТ фото, а тут и так уже есть текст).

   Картинка — best-effort: если ключи YandexART не настроены или генерация
   не удалась, всё равно списываем право и отдаём текстовый результат — как
   было раньше, до этой картинки. Не должны ронять уже рабочий текстовый
   визард из-за необязательного бонуса.

   По бизнес-правилу первый и третий образ на сайте бесплатны, а дальше
   платно/по коду партнёра — одинаково для визарда и "Образа по фото"
   (см. lib/lookAccess.js). Проверка платёжеспособности — ДО генерации
   картинки, чтобы не тратить деньги на YandexART для того, кому нечем
   платить. Само списание — ПОСЛЕ попытки генерации, тем же принципом, что
   в api/compose-look.js: неудачная генерация не должна съедать бесплатный
   образ или деньги впустую (хотя тут это мягче — картинка необязательна).
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { previewLookEntitlement, chargeForLook } = require('../../lib/lookAccess');
const { generateLookImage, buildLookImagePrompt } = require('../../lib/yandexart');
const { saveLook } = require('../../lib/savedLooks');

async function tryGenerateImage(layers, fit) {
  if (!process.env.YANDEX_API_KEY || !process.env.YANDEX_FOLDER_ID) return null;
  if (!layers || !Object.keys(layers).length) return null;
  try {
    return await generateLookImage(buildLookImagePrompt(layers, fit));
  } catch (err) {
    console.error('looks/charge: не удалось сгенерировать картинку:', err);
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Вход и оплата пока не настроены на сервере.' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти по email.' });
    return;
  }

  var body = req.body || {};
  var layers = (body.layers && typeof body.layers === 'object') ? body.layers : {};
  var why = typeof body.why === 'string' ? body.why.slice(0, 500) : '';
  var fit = typeof body.fit === 'string' ? body.fit.slice(0, 200) : '';

  try {
    var entitled = await previewLookEntitlement(user.id);
    if (!entitled) {
      res.status(402).json({ error: 'Первый образ уже использован. Пополните баланс в личном кабинете, чтобы получить ещё один.' });
      return;
    }
  } catch (err) {
    console.error('looks/charge entitlement check error:', err);
    res.status(500).json({ error: 'Не получилось проверить доступ. Попробуйте ещё раз.' });
    return;
  }

  var imageBase64 = await tryGenerateImage(layers, fit);

  try {
    var result = await chargeForLook(user.id);

    var savedLookId = null;
    if (imageBase64) {
      try {
        var saved = await saveLook(user.id, {
          layers: layers,
          why: why,
          fit: fit,
          imageBuffer: Buffer.from(imageBase64, 'base64')
        });
        savedLookId = saved.id;
      } catch (saveErr) {
        console.error('looks/charge: не удалось сохранить образ в кабинет:', saveErr);
      }
    }

    res.status(200).json({
      method: result.method,
      orderId: result.orderId,
      balanceKopecks: result.balanceKopecks,
      image: imageBase64 ? 'data:image/jpeg;base64,' + imageBase64 : null,
      savedLookId: savedLookId
    });
  } catch (err) {
    if (err.code === 'insufficient_funds') {
      res.status(402).json({ error: 'Первый образ уже использован. Пополните баланс в личном кабинете, чтобы получить ещё один.' });
      return;
    }
    console.error('looks/charge error:', err);
    res.status(500).json({ error: 'Не получилось оформить образ. Попробуйте ещё раз.' });
  }
};
