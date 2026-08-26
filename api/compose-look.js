/* ============================================================================
   POST /api/compose-look — собрать образ клиентки по фото, где на ней уже
   надета одна вещь ансамбля (платье, жакет, брюки и т.п.) — в отличие от
   api/analyze-item.js, здесь на фото человек, а не вещь на белом фоне.

   Один проход = один вызов GigaChat (описание вещи + образ по слоям текстом)
   + один вызов YandexART (ОДНА картинка на весь образ целиком, не по картинке
   на каждый слой) — так стоимость не зависит от того, сколько слоёв в
   ансамбле: топ+брюки и полный образ с аксессуарами стоят одинаково, потому
   что это всегда 1 регенерация.

   Картинку рисует YandexART, а не Kandinsky/FusionBrain — fusionbrain.ai был
   недоступен на момент подключения (сбой на стороне сервиса), YandexART
   делает то же самое и тоже оплачивается российской картой.

   Нужны все 3 секрета сразу — без любого из них эндпоинт вернёт понятную 503,
   а не тихо сломается на середине:
     GIGACHAT_AUTH_KEY, GIGACHAT_SCOPE   — см. api/analyze-item.js
     YANDEX_API_KEY, YANDEX_FOLDER_ID    — см. lib/yandexart.js

   Требует входа (Supabase JWT) и списывает право на образ — см.
   lib/lookAccess.js. Проверка платёжеспособности (previewLookEntitlement) —
   ДО вызова GigaChat/YandexART, чтобы не тратить деньги на генерацию для
   того, кому нечем платить. Само списание (chargeForLook) — ПОСЛЕ успешной
   генерации, чтобы неудачная попытка (например "нет человека на фото") не
   съедала бесплатный образ или деньги впустую.
   ============================================================================ */

const { checkRateLimit } = require('../lib/rateLimit');
const { requireUser } = require('../lib/auth');
const { previewLookEntitlement, chargeForLook } = require('../lib/lookAccess');
const { getAccessToken, uploadFile, chatWithImage } = require('../lib/gigachat');
const { generateLookImage } = require('../lib/yandexart');

const LAYER_KEYS = ['Верх', 'Низ', 'Верхняя одежда', 'Обувь', 'Аксессуары', 'Причёска', 'Макияж'];
const NO_PERSON_MARKER = 'ОШИБКА';

const SYSTEM_PROMPT =
  'Ты — ассистент стилиста. На фото должна быть клиентка, на которой уже надета одна вещь ансамбля ' +
  '(платье, жакет, брюки, юбка и т.п.) — вещь именно надета на человеке, а не сфотографирована ' +
  'отдельно (не лежит на кровати/столе, не висит на вешалке, не витрина магазина).\n\n' +
  'Если на фото НЕ видно человека, который её носит — ответь СТРОГО одной строкой без пояснений: ' +
  '"' + NO_PERSON_MARKER + ': нужно фото, где вещь надета на человеке, а не сфотографирована отдельно".\n\n' +
  'Если человек в вещи виден — определи эту вещь и собери вокруг неё полный образ по слоям. Ответь ' +
  'СТРОГО построчно, каждая строка в формате "Слой: значение", без вступлений и заключений, ровно ' +
  'в этом порядке и с этими названиями слоёв:\n' +
  LAYER_KEYS.join('\n') + '\n' +
  'Для слоя, который выполняет сама вещь с фото (например, это платье и роль "Низ" ему не нужна ' +
  'отдельно) — НЕ пиши "эта же вещь", а опиши эту вещь так же конкретно, как остальные слои (тип, ' +
  'цвет, узор, крой) — по этому описанию её должны будут нарисовать, не видя фото. Если пользователь ' +
  'указал рост и размер — учти их при выборе кроя и силуэта каждой вещи (посадка, длина, свободный ' +
  'или приталенный крой), но не обсуждай фигуру или тело в тексте ответа — это должно быть видно ' +
  'только в подобранном крое. После всех слоёв — ещё одна строка "Почему: " с 1-2 предложениями ' +
  'логики по силуэту и цвету. Конкретно, без оценочных слов вроде "прекрасно".';

function parseLayers(text) {
  var layers = {};
  var why = '';
  text.split('\n').forEach(function (line) {
    var idx = line.indexOf(':');
    if (idx === -1) return;
    var key = line.slice(0, idx).trim();
    var value = line.slice(idx + 1).trim();
    if (!value) return;
    if (key === 'Почему') { why = value; return; }
    if (LAYER_KEYS.indexOf(key) !== -1) layers[key] = value;
  });
  return { layers: layers, why: why };
}

/* fit передаётся в промпт картинки, а не только в текст GigaChat — без этого
   YandexART рисует типовую худую модель независимо от указанного размера. */
function buildImagePrompt(layers, fit) {
  var parts = Object.keys(layers)
    .filter(function (k) { return k !== 'Причёска' && k !== 'Макияж'; })
    .map(function (k) { return layers[k]; })
    .filter(Boolean);
  var prompt = 'Модный лукбук, один цельный образ на модели в полный рост, fashion-иллюстрация: ' +
    parts.join(', ') + '.';
  if (fit) {
    prompt += ' Пропорции и телосложение модели должны соответствовать параметрам «' + fit +
      '» — не рисуй типовую худую модель, если это не соответствует этим параметрам.';
  }
  prompt += ' Без текста и надписей на картинке.';
  return prompt;
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

  var missing = [];
  if (!process.env.GIGACHAT_AUTH_KEY) missing.push('GIGACHAT_AUTH_KEY');
  if (!process.env.YANDEX_API_KEY) missing.push('YANDEX_API_KEY');
  if (!process.env.YANDEX_FOLDER_ID) missing.push('YANDEX_FOLDER_ID');
  if (missing.length) {
    res.status(503).json({ error: 'Сборка образа пока не настроена на сервере (нет ' + missing.join(', ') + ').' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти по email, чтобы собрать образ.' });
    return;
  }

  var allowed = await checkRateLimit(req, 'compose-look', { windowSeconds: 600, maxHits: 3 });
  if (!allowed) {
    res.status(429).json({ error: 'Слишком много запросов подряд. Попробуйте через несколько минут.' });
    return;
  }

  try {
    var entitled = await previewLookEntitlement(user.id);
    if (!entitled) {
      res.status(402).json({ error: 'Первый образ уже использован. Пополните баланс в личном кабинете, чтобы получить ещё один.' });
      return;
    }
  } catch (err) {
    console.error('compose-look entitlement check error:', err);
    res.status(500).json({ error: 'Не получилось проверить доступ. Попробуйте ещё раз.' });
    return;
  }

  try {
    var body = req.body || {};
    var dataUrl = body.image;
    if (!dataUrl || typeof dataUrl !== 'string') {
      res.status(400).json({ error: 'Нет фото в запросе.' });
      return;
    }
    var match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      res.status(400).json({ error: 'Некорректный формат фото.' });
      return;
    }
    var mime = match[1];
    var imageBuffer = Buffer.from(match[2], 'base64');
    if (imageBuffer.length > 4.2 * 1024 * 1024) {
      res.status(413).json({ error: 'Фото слишком большое — попробуйте другое или сожмите его.' });
      return;
    }

    var fit = typeof body.fit === 'string' ? body.fit.trim().slice(0, 200) : '';
    var userText = fit
      ? 'Собери образ по фото. Рост и размер: ' + fit
      : 'Собери образ по фото.';

    var token = await getAccessToken();
    var fileId = await uploadFile(token, imageBuffer, mime);
    var raw = await chatWithImage(token, SYSTEM_PROMPT, userText, fileId);

    if (raw.trim().indexOf(NO_PERSON_MARKER) === 0) {
      res.status(422).json({ error: 'На фото не видно вещь, надетую на человеке — сфотографируйте себя в ней и загрузите ещё раз.' });
      return;
    }

    var parsed = parseLayers(raw);
    var imageBase64 = await generateLookImage(buildImagePrompt(parsed.layers, fit));

    /* Списываем только сейчас, когда генерация реально удалась. Если это
       спишет неудачно (крайне редкая гонка — баланс успели потратить между
       previewLookEntitlement выше и этим моментом), картинка уже нарисована
       и деньги за GigaChat/YandexART потрачены нами в любом случае — честнее
       всё равно отдать результат пользователю, чем показать ошибку после
       успешной генерации. Ошибку списания в этом случае просто логируем. */
    try {
      await chargeForLook(user.id);
    } catch (chargeErr) {
      console.error('compose-look: списание после успешной генерации не удалось:', chargeErr);
    }

    res.status(200).json({
      layers: parsed.layers,
      why: parsed.why,
      image: 'data:image/jpeg;base64,' + imageBase64
    });
  } catch (err) {
    console.error('compose-look error:', err);
    res.status(502).json({ error: 'Не получилось собрать образ. Попробуйте ещё раз.' });
  }
};
