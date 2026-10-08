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

   2026-10-07 — если клиентка загрузила фото вещи и задан FLUX_API_KEY, картинку рисует FLUX.2 [pro]
   с этим фото как образцом вещи (решение Андрея). Живой тест: белый свитер-оверсайз с рисунком
   «штрихами» и накладными карманами YandexART нарисовал коротким свитером с косами — он видит только
   описание GigaChat, а в описании ни длины, ни карманов, ни рисунка. Модель по-прежнему рисованная
   (типаж из анкеты), с фото берётся только вещь. При любой ошибке FLUX.2 — прежний YandexART.
   ============================================================================ */

const { requireUser } = require('../../lib/auth');
const { previewObrazPoFotoEntitlement, chargeForObrazPoFoto } = require('../../lib/lookAccess');
const { generateLookImage, buildLookImagePrompt, extractClothingSize, stripQuotedText } = require('../../lib/yandexart');
const { generateLookImageFlux2 } = require('../../lib/flux');
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

/* Одна перерисовка тем же способом, если GigaChat увидел обрезанный кадр. Сбой проверки или
   перерисовки не превращает уже готовую картинку в ошибку. */
async function withFramingRetry(generate) {
  var image = await generate();
  try {
    if (await framingOk(image)) return image;
    console.warn('looks/charge: кадр обрезан — перерисовываю один раз');
    return await generate();
  } catch (retryErr) {
    console.error('looks/charge: проверка/перерисовка не удалась, оставляем первую картинку:', retryErr);
    return image;
  }
}

/* Фото вещи из js/wizard.js — data URL, уже сжатый до 1024px. Отдаём чистый base64 (так его ждёт
   lib/flux.js) или null, если пришло что-то не то. */
var ITEM_PHOTO_RE = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
function parseItemPhoto(raw) {
  if (typeof raw !== 'string') return null;
  var m = ITEM_PHOTO_RE.exec(raw);
  if (!m) return null;
  if (m[1].length > 5.6 * 1024 * 1024) return null; // ~4.2 МБ после декодирования
  return m[1];
}

/* 2026-10-08 — фигура для FLUX.2 буквенным размером, без российской цифры. Живые тесты (блузка на
   вешалке): «российский размер 48: плотнее среднего» и «50: плотнее среднего» дали фигуры плюс-сайз —
   похоже, модель читает «48/50» как европейский размер (EU 48 ≈ RU 54) и ещё усиливает «плотнее».
   52 («полная фигура») легло примерно верно. Ступени — по обычной таблице RU→буквенный; нежелательных
   слов («полная» для 48–50) не называем даже с «не» — модели цепляются за само слово. sizeToBodyPhrase
   (lib/yandexart.js) не трогаем: он подобран под YandexART, который рисует запасным. */
function fluxBodyPhrase(size, gender) {
  if (!size) return '';
  if (gender === 'male') {
    if (size <= 48) return 'размер M, стройное телосложение';
    if (size <= 50) return 'размер L, обычное среднее телосложение';
    if (size <= 52) return 'размер XL, плотное телосложение';
    if (size <= 56) return 'размер XXL–3XL, крупное телосложение';
    return 'размер 4XL и больше, очень крупное телосложение';
  }
  if (size <= 44) return 'размер S, стройная фигура';
  if (size <= 46) return 'размер M, стройная фигура';
  if (size <= 48) return 'размер L, обычная фигура среднего телосложения';
  if (size <= 50) return 'размер XL, среднее телосложение со слегка округлыми формами';
  if (size <= 52) return 'размер XXL, полная фигура';
  if (size <= 56) return 'размер 3XL–4XL, полная фигура, плюс-сайз';
  return 'размер 5XL и больше, крупная фигура, плюс-сайз';
}

/* Делит слои на вещь клиентки (обёрнута js/wizard.js в «Уже есть — это ваша вещь») и остальной образ.
   itemKey — слой вещи ('Верх', 'Низ', 'Верхняя одежда'); isDress — платье (обёрнуты и Верх, и Низ). */
function splitItemLayers(layers) {
  var itemText = '';
  var itemKey = null;
  var wrappedCount = 0;
  var rest = [];
  ['Верх', 'Низ', 'Верхняя одежда', 'Обувь'].forEach(function (k) {
    if (!layers[k]) return;
    var value = unescapeHtml(layers[k]);
    var m = WRAPPED_ITEM_RE.exec(value);
    if (m) {
      wrappedCount++;
      /* 2026-10-07 — живой тест: «надписью "MOSCHINO"» в описании → BFL отклонил запрос
         ("Request Moderated: Protected Content") и картинку рисовал запасной YandexART. Надписи в
         кавычках и слова капсом (бренды) из текста убираем — принт FLUX.2 и так видит на фото. */
      if (!itemText) {
        itemKey = k;
        itemText = stripQuotedText(m[2]).replace(/\b[A-Z][A-Z0-9&.'-]{2,}\b/g, '')
          .replace(/\s{2,}/g, ' ').trim().replace(/\.$/, '');
      }
      return;
    }
    rest.push(k.toLowerCase() + ' — ' + value.split(/ — |,| или /)[0]);
  });
  return { itemText: itemText, itemKey: itemKey, isDress: wrappedCount > 1, rest: rest };
}

function modelTypeNote(fit, gender, hair) {
  var hairPhrase = HAIR_PHRASES[hair];
  var bodyPhrase = fluxBodyPhrase(extractClothingSize(fit), gender);
  return (gender === 'male' ? 'мужчина' : 'женщина') + (hairPhrase ? ', ' + hairPhrase : '') +
    (bodyPhrase ? ', ' + bodyPhrase : '');
}

var CATALOG_FRAME = 'Фотография для fashion-каталога на светлом однотонном фоне: одна модель в полный рост, ' +
  'от макушки до обуви, ноги и обувь целиком в кадре.';
/* Не «без текста на картинке», как у YandexART: так FLUX.2 стирает и надписи принта самой вещи. */
var NO_CAPTIONS = ' Не добавляй на картинку своих подписей — принт вещи оставь как на фото.';

/* 2026-10-08 — вещь без человека (на вешалке и т.п.) рисуем в ДВА шага. Живые тесты (серая блузка на
   вешалке, размеры 48/50/52/54): в один шаг FLUX.2 при любом описании размера рисовал полную фигуру —
   «тот же крой» широкой вещи он выполняет, подгоняя под её ширину тело. Шаг 1 — модель по анкете без
   фото вещи перед глазами (вещь описана словами, как ориентир), шаг 2 — переодеть ЭТУ модель в вещь
   с фото: фигура берётся с картинки шага 1. */
function buildModelStepPrompt(layers, fit, gender, hair) {
  var s = splitItemLayers(layers);
  var outfit = (s.itemText ? [s.itemText] : []).concat(s.rest);
  return CATALOG_FRAME + ' Модель — ' + modelTypeNote(fit, gender, hair) + '. Поза естественная, руки ' +
    'не закрывают одежду.' + (outfit.length ? ' Одежда: ' + outfit.join('; ') + '.' : '') +
    ' Без текста на картинке.';
}

function buildDressStepPrompt(layers) {
  var s = splitItemLayers(layers);
  var slot = s.isDress ? 'всю одежду, кроме обуви,'
    : s.itemKey === 'Низ' ? 'низ (брюки, юбку или шорты)'
    : s.itemKey === 'Верхняя одежда' ? 'верхнюю одежду (надень её поверх того, что на модели)'
    : 'верх (то, что надето на торс)';
  return 'Фото 1 — модель, фото 2 — вещь. Замени на модели с фото 1 ' + slot + ' на вещь с фото 2' +
    (s.itemText ? ' (' + s.itemText + ')' : '') + ': ровно та же вещь — тот же цвет, фактура и рисунок ' +
    'ткани, длина, крой, вырез, рукава, карманы и все детали. Вещь сидит по фигуре модели с фото 1. ' +
    'Модель с фото 1 не меняй: то же лицо, волосы, та же фигура и комплекция, поза, фон, остальная ' +
    'одежда и обувь. Кадр в полный рост, как на фото 1.' + NO_CAPTIONS;
}

/* Промпт для FLUX.2 с фото вещи как образцом, в один шаг — когда на фото вещи есть человек (или
   неизвестно, есть ли). Описание вещи от GigaChat (или слово клиентки) идёт подсказкой, но главное —
   «ровно та же вещь, что на фото». */
function buildItemPhotoPrompt(layers, fit, gender, hair) {
  var s = splitItemLayers(layers);
  var itemText = s.itemText;
  var rest = s.rest;
  /* 2026-10-07 — решение Андрея: если на фото вещи есть человек, рисуем ЕГО (лицо, фигура, цвет
     волос — как на фото; живой тест показал, что FLUX.2 и так тянет их с образца сильнее слов).
     Анкета (волосы, размер) — только когда вещь сфотографирована отдельно. Если это пойдёт хорошо —
     кандидат в новую схему «Онлайн-стилиста». */
  var prompt = CATALOG_FRAME + ' Если на исходном фото есть человек — модель это ' +
    'тот же самый человек: то же лицо, та же фигура и комплекция, тот же цвет волос. Если на исходном ' +
    'фото человека нет — модель: ' + modelTypeNote(fit, gender, hair) + '. ' +
    'На модели ровно та же вещь, что на исходном фото' + (itemText ? ' (' + itemText + ')' : '') +
    ': тот же цвет, фактура и рисунок ткани, длина, крой, вырез, рукава, карманы и все детали — без ' +
    'изменений. Надета так же, как на фото. Фон и поза — новые, как в каталоге; остальная одежда с ' +
    'фото не нужна.';
  if (rest.length) prompt += ' Остальной образ: ' + rest.join('; ') + '.';
  return prompt + NO_CAPTIONS;
}

var FLUX_SIZE = { width: 768, height: 1152 };

async function generateTwoStep(layers, fit, gender, hair, itemPhoto) {
  var modelPrompt = buildModelStepPrompt(layers, fit, gender, hair);
  var dressPrompt = buildDressStepPrompt(layers);
  console.log('looks/charge: шаг 1 (модель) —', modelPrompt);
  console.log('looks/charge: шаг 2 (одеть) —', dressPrompt);
  var model = await generateLookImageFlux2(modelPrompt, null, { textOnly: true, width: FLUX_SIZE.width, height: FLUX_SIZE.height });
  return generateLookImageFlux2(dressPrompt, model, { extraImages: [itemPhoto], width: FLUX_SIZE.width, height: FLUX_SIZE.height });
}

async function tryGenerateImage(layers, fit, gender, hair, itemPhoto, itemHasPerson) {
  if (!Object.keys(layers).length) return null;
  if (itemPhoto && process.env.FLUX_API_KEY) {
    if (itemHasPerson === false) {
      try {
        var twoStepImage = await withFramingRetry(function () {
          return generateTwoStep(layers, fit, gender, hair, itemPhoto);
        });
        console.log('looks/charge: картинка — FLUX.2 [pro] в два шага (модель по анкете + вещь с фото)');
        return twoStepImage;
      } catch (twoStepErr) {
        console.error('looks/charge: два шага FLUX.2 не сработали, пробую один шаг:', twoStepErr && twoStepErr.message);
      }
    }
    var fluxPrompt = buildItemPhotoPrompt(layers, fit, gender, hair);
    console.log('looks/charge: промпт FLUX.2 по фото вещи —', fluxPrompt);
    try {
      var fluxImage = await withFramingRetry(function () {
        return generateLookImageFlux2(fluxPrompt, itemPhoto, FLUX_SIZE);
      });
      console.log('looks/charge: картинка — FLUX.2 [pro] по фото вещи');
      return fluxImage;
    } catch (fluxErr) {
      console.error('looks/charge: FLUX.2 по фото вещи не сработал, рисую YandexART:', fluxErr && fluxErr.message);
    }
  }
  if (!process.env.YANDEX_API_KEY || !process.env.YANDEX_FOLDER_ID) return null;
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
  console.log('looks/charge: промпт картинки —', prompt);
  /* Перерисовка — тем же промптом, без forceFraming: его длинная фраза про дальний план съедает весь
     "Остальной образ" (проверено node -e — пропадали даже джинсы). Новая случайная генерация и так
     часто ложится иначе. */
  try {
    return await withFramingRetry(function () { return generateLookImage(prompt); });
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
  var layers = sanitizeLayers(body.layers);
  var why = typeof body.why === 'string' ? body.why.slice(0, 500) : '';
  var fit = typeof body.fit === 'string' ? body.fit.slice(0, 200) : '';
  var gender = body.gender === 'male' ? 'male' : 'female';
  var hair = typeof body.hair === 'string' ? body.hair : '';
  var itemPhoto = parseItemPhoto(body.itemPhoto);
  var itemHasPerson = typeof body.itemHasPerson === 'boolean' ? body.itemHasPerson : null;

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
  var imageBase64 = await tryGenerateImage(layers, fit, gender, hair, itemPhoto, itemHasPerson);

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
