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

   2026-10-06 — картинка возвращена (решение Андрея), но с другим смыслом:
   это рисованная модель ТИПАЖА клиентки (пол, цвет волос из анкеты, фигура
   по размеру), а не она сама — фото человека в этом продукте нет вообще,
   только фото вещи. Отличие от «Онлайн-стилиста» (образ на её собственном
   фото) остаётся. Картинка — best-effort, как в первой версии: если
   YandexART не настроен или не ответил, списываем и отдаём текст, как
   было до картинки. Одна попытка, без проверки и перерисовок — продукт
   дешёвый, YandexART стоит рубли.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { previewObrazPoFotoEntitlement, chargeForObrazPoFoto } = require('../../lib/lookAccess');
const { generateLookImage, buildLookImagePrompt } = require('../../lib/yandexart');
const { getAccessToken, uploadFile, chatWithImage } = require('../../lib/gigachat');
const { saveLook } = require('../../lib/savedLooks');

/* Цвет волос из анкеты (js/wizard.js, шаг "colors") — только из этого списка, свободный текст
   клиента в промпт картинки не попадает. */
const HAIR_PHRASES = {
  blond: 'светлые волосы, блонд',
  light_brown: 'русые волосы',
  brown: 'каштановые волосы',
  dark: 'тёмные волосы',
  red: 'рыжие волосы',
  grey: 'седые волосы'
};

/* Слои приходят от клиента — режем длину и количество, чтобы в промпт и в "Мои образы" не ушло
   что-то огромное. */
function sanitizeLayers(raw) {
  var out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).slice(0, 10).forEach(function (k) {
    if (typeof raw[k] !== 'string') return;
    out[String(k).slice(0, 40)] = raw[k].slice(0, 300);
  });
  return out;
}

/* Значения слоёв уже экранированы для innerHTML (escapeHtml в js/wizard.js) — для промпта картинки
   возвращаем обычные символы. */
function unescapeHtml(str) {
  return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/* Вещь клиентки приходит обёрнутой ("Уже есть — это ваша вещь: «...»", js/wizard.js) — укорачиваем
   только текст внутри кавычек, обёртку оставляем: по ней lib/yandexart.js узнаёт главную вещь. */
var WRAPPED_ITEM_RE = /^(Уже есть — это ваша вещь: «)(.*)(».*)$/;
function shortenItemForImage(value) {
  var m = WRAPPED_ITEM_RE.exec(value);
  if (!m) return value;
  var text = m[2].split(/\.\s/)[0].replace(/\.$/, '');
  if (text.length > 60) text = text.slice(0, 60).replace(/[\s,]+\S*$/, '');
  return m[1] + text + m[3];
}

/* 2026-10-06 — живой тест: картинка обрезана по бедро. Обувь из картинки убрана с 2026-09-15 (там
   обувь описывал GigaChat и её цвет/тип часто не совпадал), и внизу кадра модели нечего рисовать.
   Здесь обувь — короткая строка шаблона ("Белые кроссовки или лоферы"), её возвращаем в картинку
   ТОЛЬКО для этого продукта; в api/compose-look.js решение 2026-09-15 не меняется. */
const IMAGE_SKIP_KEYS = ['Макияж', 'Уход', 'Аксессуары'];

/* Та же проверка кадра, что работала в api/compose-look.js для YandexART (2026-09-16), но один пункт
   и одна перерисовка — продукт дешёвый. */
const FRAMING_CHECK_PROMPT =
  'Ты — контролёр качества fashion-иллюстрации. Тебе показана рисованная картинка. Видна ли вся фигура ' +
  'человека от макушки до стоп — ноги и обувь целиком в кадре, картинка НЕ обрезана на бёдрах, коленях ' +
  'или голенях? Если да — ответь СТРОГО одним словом без знаков препинания: OK. Если нет — ответь: ОБРЕЗАНО';

async function framingOk(imageBase64) {
  if (!process.env.GIGACHAT_AUTH_KEY) return true;
  var token = await getAccessToken();
  var fileId = await uploadFile(token, Buffer.from(imageBase64, 'base64'), 'image/jpeg');
  var verdict = (await chatWithImage(token, FRAMING_CHECK_PROMPT, 'Проверь картинку.', fileId)).trim();
  console.log('looks/charge: проверка кадра —', verdict.slice(0, 100));
  return verdict.toUpperCase().indexOf('OK') === 0;
}

async function tryGenerateImage(layers, fit, gender, hair) {
  if (!process.env.YANDEX_API_KEY || !process.env.YANDEX_FOLDER_ID) return null;
  if (!Object.keys(layers).length) return null;
  /* Цвет волос ставим в начало слоя "Причёска": в промпте слой обрезается до ~36 символов
     (lib/yandexart.js, TEMPLATE_LAYER_MAX_WITH_ITEM), и так цвет переживёт обрезку. Отдельной
     фразой в гарантированную часть промпта НЕ добавляем — по истории yandexart.js любая добавка
     туда вытесняет "Низ". "Причёску" кладём раньше "Обуви": при нехватке места buildLookImagePrompt
     отбрасывает слои с конца, и цвет волос важнее обуви. */
  /* Бюджет промпта ~460 символов (lib/yandexart.js) — проверено node -e на "куртка + размер 62":
     полное описание вещи от GigaChat (2-4 предложения) и строки шаблона целиком вытесняли волосы и
     обувь. Поэтому для картинки: вещь — первая фраза до ~60 символов, причёска — только цвет волос
     (укладка остаётся в тексте карточки), обувь — до первого " — "/" или "/запятой. */
  var hairPhrase = HAIR_PHRASES[hair];
  var imageLayers = {};
  Object.keys(layers).forEach(function (k) {
    if (k === 'Обувь' || k === 'Причёска') return;
    imageLayers[k] = shortenItemForImage(unescapeHtml(layers[k]));
  });
  if (hairPhrase) imageLayers['Причёска'] = hairPhrase;
  else if (layers['Причёска']) imageLayers['Причёска'] = unescapeHtml(layers['Причёска']);
  if (layers['Обувь']) imageLayers['Обувь'] = unescapeHtml(layers['Обувь']).split(/ — |,| или /)[0];

  var prompt = buildLookImagePrompt(imageLayers, fit, IMAGE_SKIP_KEYS, gender);
  var image;
  try {
    console.log('looks/charge: промпт картинки —', prompt);
    image = await generateLookImage(prompt);
  } catch (err) {
    console.error('looks/charge: не удалось сгенерировать картинку:', err);
    return null;
  }
  /* Перерисовка — тем же промптом, без forceFraming: его длинная фраза про дальний план съедает весь
     "Остальной образ" (проверено node -e — пропадали даже джинсы). Новая случайная генерация и так
     часто ложится иначе. */
  try {
    if (await framingOk(image)) return image;
    console.warn('looks/charge: кадр обрезан — перерисовываю один раз');
    return await generateLookImage(prompt);
  } catch (retryErr) {
    console.error('looks/charge: проверка/перерисовка не удалась, оставляем первую картинку:', retryErr);
    return image;
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
  var layers = sanitizeLayers(body.layers);
  var why = typeof body.why === 'string' ? body.why.slice(0, 500) : '';
  var fit = typeof body.fit === 'string' ? body.fit.slice(0, 200) : '';
  var gender = body.gender === 'male' ? 'male' : 'female';
  var hair = typeof body.hair === 'string' ? body.hair : '';

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

  /* Картинку рисуем ДО списания (проверка баланса выше — чтобы не платить за картинку тому, кому
     нечем платить), списываем после — тот же порядок, что в api/compose-look.js. */
  var imageBase64 = await tryGenerateImage(layers, fit, gender, hair);

  try {
    var result = await chargeForObrazPoFoto(user.id);

    var savedLookId = null;
    try {
      var lookToSave = { layers: layers, why: why, fit: fit };
      if (imageBase64) lookToSave.imageBuffer = Buffer.from(imageBase64, 'base64');
      var saved = await saveLook(user.id, lookToSave);
      savedLookId = saved.id;
    } catch (saveErr) {
      console.error('looks/charge: не удалось сохранить образ в кабинет:', saveErr);
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
      res.status(402).json({ error: 'Недостаточно средств на балансе. Пополните баланс в личном кабинете, чтобы собрать образ.' });
      return;
    }
    console.error('looks/charge error:', err);
    res.status(500).json({ error: 'Не получилось оформить образ. Попробуйте ещё раз.' });
  }
};
