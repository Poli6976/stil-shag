/* ============================================================================
   POST /api/compose-look — собрать образ клиентки по фото, где на ней уже
   надета одна вещь ансамбля (платье, жакет, брюки и т.п.) — в отличие от
   api/analyze-item.js, здесь на фото человек, а не вещь на белом фоне.

   Один проход = один вызов GigaChat (описание вещи + образ по слоям текстом)
   + один вызов YandexART (ОДНА картинка на весь образ целиком, не по картинке
   на каждый слой) — так стоимость не зависит от того, сколько слоёв в
   ансамбле: топ+брюки и полный образ с аксессуарами стоят одинаково, потому
   что это всегда 1 регенерация.

   Картинку рисует YandexART, а не Kandinsky/FusionBrain (lib/kandinsky.js
   оставлен в проекте неиспользуемым) — fusionbrain.ai был недоступен на
   момент подключения (сбой на стороне сервиса), YandexART делает то же самое
   и тоже оплачивается российской картой.

   Нужны все 3 секрета сразу — без любого из них эндпоинт вернёт понятную 503,
   а не тихо сломается на середине:
     GIGACHAT_AUTH_KEY, GIGACHAT_SCOPE   — см. api/analyze-item.js
     YANDEX_API_KEY, YANDEX_FOLDER_ID    — см. lib/yandexart.js
   ============================================================================ */

const { checkRateLimit } = require('../lib/rateLimit');
const { getAccessToken, uploadFile, chatWithImage } = require('../lib/gigachat');
const { generateLookImage } = require('../lib/yandexart');

const LAYER_KEYS = ['Верх', 'Низ', 'Верхняя одежда', 'Обувь', 'Аксессуары', 'Причёска', 'Макияж'];

const SYSTEM_PROMPT =
  'Ты — ассистент стилиста. На фото — клиентка, на которой уже надета одна вещь ансамбля ' +
  '(платье, жакет, брюки, юбка и т.п.). Определи эту вещь и собери вокруг неё полный образ по ' +
  'слоям. Ответь СТРОГО построчно, каждая строка в формате "Слой: значение", без вступлений и ' +
  'заключений, ровно в этом порядке и с этими названиями слоёв:\n' +
  LAYER_KEYS.join('\n') + '\n' +
  'Если слой уже выполняет вещь с фото (например, это платье и роль "Низ" ему не нужна отдельно) — ' +
  'напиши в этой строке "эта же вещь". После всех слоёв — ещё одна строка "Почему: " с 1-2 ' +
  'предложениями логики по силуэту и цвету. Конкретно, без оценочных слов вроде "прекрасно".';

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

function buildImagePrompt(layers) {
  var parts = Object.keys(layers)
    .filter(function (k) { return k !== 'Причёска' && k !== 'Макияж'; })
    .map(function (k) { return layers[k]; })
    .filter(function (v) { return v && v.toLowerCase().indexOf('эта же вещь') === -1; });
  return 'Модный лукбук, один цельный образ на модели в полный рост, fashion-иллюстрация: ' +
    parts.join(', ') + '. Без текста и надписей на картинке.';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
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

  var allowed = await checkRateLimit(req, 'compose-look', { windowSeconds: 600, maxHits: 3 });
  if (!allowed) {
    res.status(429).json({ error: 'Слишком много запросов подряд. Попробуйте через несколько минут.' });
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

    var token = await getAccessToken();
    var fileId = await uploadFile(token, imageBuffer, mime);
    var raw = await chatWithImage(token, SYSTEM_PROMPT, 'Собери образ по фото.', fileId);
    var parsed = parseLayers(raw);

    var imageBase64 = await generateLookImage(buildImagePrompt(parsed.layers));

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
