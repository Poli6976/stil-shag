/* ============================================================================
   POST /api/looks/charge — списать право на один "образ" у визарда
   (obraz-po-foto.html) — слои считает клиент из статичных шаблонов
   js/wizard.js, сюда приходит готовый текст образа, GigaChat не нужен, он
   только ОПИСЫВАЕТ вещь на предыдущем шаге (api/analyze-item.js), а тут
   всё уже есть.

   2026-09-13 — «Образ по фото» стал отдельным дешёвым продуктом (299 ₽,
   см. lib/packages.js) БЕЗ картинки, а не облегчённой «Примеркой»: раньше
   этот эндпоинт по цене «Примерки» (998 ₽/499 ₽ через lib/lookAccess.js)
   ещё и пытался нарисовать иллюстрацию через YandexART/Alice AI ART — то
   есть тратил на дешёвый шаблонный текст ту же дорогую картинку, что и
   полноценный разбор реального фото на "Онлайн-стилисте" (api/compose-
   look.js), и при этом даже не показывал цену на сайте ("Цена уточняется").
   Убрали генерацию картинки совсем — экономит основную часть себестоимости
   и делает разницу между продуктами понятной посетительнице (дешевле =
   без иллюстрации, не "то же самое, но случайно дешевле"). Текстовый
   результат всё равно сохраняется в «Мои образы» (см. saveLook ниже —
   без imageBuffer это просто текстовая карточка).
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { previewObrazPoFotoEntitlement, chargeForObrazPoFoto } = require('../../lib/lookAccess');
const { saveLook } = require('../../lib/savedLooks');

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
    var entitled = await previewObrazPoFotoEntitlement(user.id);
    if (!entitled) {
      res.status(402).json({ error: 'Недостаточно средств на балансе. Пополните баланс в личном кабинете, чтобы собрать образ.' });
      return;
    }
  } catch (err) {
    console.error('looks/charge entitlement check error:', err);
    res.status(500).json({ error: 'Не получилось проверить доступ. Попробуйте ещё раз.' });
    return;
  }

  try {
    var result = await chargeForObrazPoFoto(user.id);

    var savedLookId = null;
    try {
      var saved = await saveLook(user.id, { layers: layers, why: why, fit: fit });
      savedLookId = saved.id;
    } catch (saveErr) {
      console.error('looks/charge: не удалось сохранить образ в кабинет:', saveErr);
    }

    res.status(200).json({
      method: result.method,
      orderId: result.orderId,
      balanceKopecks: result.balanceKopecks,
      savedLookId: savedLookId
    });
  } catch (err) {
    if (err.code === 'insufficient_funds') {
      res.status(402).json({ error: 'Недостаточно средств на балансе. Пополните баланс в личном кабинете, чтобы собрать образ.' });
      return;
    }
    console.error('looks/charge error:', err);
    res.status(500).json({ error: 'Не получилось оформить образ. Попробуйте ещё раз.' });
  }
};
