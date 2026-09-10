/* ============================================================================
   Клиент генерации картинки образа (Yandex Cloud AI Studio) — ОДНА
   иллюстративная картинка на весь образ по текстовому описанию слоёв.

   2026-09-10 — переход с модели YandexART (async-эндпоинт
   /foundationModels/v1/imageGenerationAsync) на Alice AI ART (sync,
   OpenAI-совместимый /v1/images/generations): YandexART в этот день стала
   стабильно падать с "Access to model art://.../yandex-art/latest denied"
   (модель в каталоге переименовалась в yandex-art-2.0 — это чинилось
   отдельно), а после починки имени модели асинхронная генерация начала
   зависать на много минут без ответа (проверено напрямую через API —
   операция не завершалась и через 10+ минут, хотя биллинг/права/квоты в
   порядке). Alice AI ART — синхронный запрос-ответ без опроса статуса,
   проверено напрямую: устойчиво отвечает за 5-6 секунд.

   Нужны два значения в переменных окружения (Vercel → Settings → Environment Variables):
     YANDEX_API_KEY     — API-ключ сервисного аккаунта (роль ai.imageGeneration.user)
     YANDEX_FOLDER_ID    — ID каталога в Yandex Cloud (видно в адресной строке консоли)
   ============================================================================ */

const https = require('https');

const API_HOST = 'ai.api.cloud.yandex.net';

/* Реальный лимит — 500 символов на текст промпта (тот же лимит указан в
   AI Studio и для YandexART, и для Alice AI ART; проверено раньше по ответу
   API: "Prompt positive size 702 exceeds limit (500)"). 460, а не ровно
   500 — небольшой запас на случай, если код обрежет что-то ровно на границе
   символа UTF-16 суррогатной пары. */
const PROMPT_MAX_LENGTH = 460;

function httpsJson(hostname, method, requestPath, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port: 443, path: requestPath, method, headers, timeout: 30000 },
      (res) => {
        var chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          var raw = Buffer.concat(chunks).toString('utf8');
          var parsed;
          try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) { parsed = { raw: raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

/* Возвращает base64 JPEG (без data:-префикса) готовой картинки образа.
   opts.size — необязательно, по умолчанию портретный кадр: квадратный кадр
   физически не оставляет места нарисовать фигуру в полный рост с обувью,
   модель вынуждена обрезать по бёдра/колено независимо от текста промпта.
   Портретный даёт вертикальный запас под голову-плечи-ноги-обувь
   одновременно (1024×1536 ≈ 2:3, проверено — реальный ответ модели пришёл
   832×1280, тот же портретный характер). */
async function generateLookImage(prompt, opts) {
  opts = opts || {};
  var folderId = process.env.YANDEX_FOLDER_ID;
  var payload = JSON.stringify({
    model: 'art://' + folderId + '/aliceai-image-art-3.0/latest',
    prompt: prompt.slice(0, PROMPT_MAX_LENGTH),
    size: opts.size || '1024x1536'
  });
  var headers = {
    'Authorization': 'Bearer ' + process.env.YANDEX_API_KEY,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  var res = await httpsJson(API_HOST, 'POST', '/v1/images/generations', headers, payload);
  var image = res.body && res.body.data && res.body.data[0] && res.body.data[0].b64_json;
  if (res.status !== 200 || !image) {
    throw new Error('Alice AI ART: генерация не удалась: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return image;
}

/* Голая цифра российского размера ("размер 64") ничего не значит для модели,
   рисующей картинки — она не обучена на таблицах размеров одежды и без явных
   слов про телосложение почти всегда рисует типовую худую модель, даже если
   в промпте есть сам номер размера. Переводим размер в описательную фразу ДО
   того, как он попадёт в промпт. Пороги — стандартная российская сетка
   женской/унисекс одежды (округлённо, т.к. fit — свободный текст
   пользователя, а не строгий выбор из списка). Используется и
   api/compose-look.js (фото), и api/looks/charge.js (визард-анкета) — общее
   место, чтобы не держать логику в двух копиях.

   Границы сдвинуты 2026-08-28: при размере 56 картинка получалась похожа на
   64-й (модель явно перевыполняет словосочетание "плюс-сайз" даже на нижней
   границе диапазона) — расширили менее нагруженную формулировку "полная
   фигура" до 56 включительно, а "плюс-сайз" сдвинули на 57+. */
function sizeToBodyPhrase(size) {
  if (size === null || size <= 46) return null; // близко к типовой модельной фигуре — уточнять нечего
  if (size <= 50) return 'плотного телосложения, немного полнее среднего';
  if (size <= 56) return 'полная фигура';
  if (size <= 62) return 'крупная фигура, плюс-сайз';
  return 'очень крупная фигура, большой плюс-сайз';
}

function extractClothingSize(fit) {
  if (!fit) return null;
  var m = /размер\D{0,5}(\d{2})\b/i.exec(fit) || /\b(\d{2})\D{0,5}размер/i.exec(fit);
  if (m) return parseInt(m[1], 10);
  var nums = fit.match(/\b\d{2}\b/g); // рост обычно 3 цифры (140-200) — сюда не попадёт
  if (!nums) return null;
  for (var i = 0; i < nums.length; i++) {
    var n = parseInt(nums[i], 10);
    if (n >= 38 && n <= 72) return n;
  }
  return null;
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen).trim() + '…';
}

/* js/wizard.js оборачивает вещь пользователя в "Уже есть — это ваша вещь:
   «...»" (+ "(выполняет роль верха и низа)" для платьев) — эта фраза нужна
   только для текста на экране. Для картинки она бесполезна и, что важнее,
   вредна: сама обёртка уже занимает ~27 символов, и при обрезке слоя до
   32 символов (см. ниже) от реального описания вещи оставалось буквально
   пара слов — картинка рисовалась почти вслепую и получалась ближе к
   шаблонным соседним слоям (юбка/жакет повода), чем к самой вещи. */
var ITEM_WRAPPER_RE = /^Уже есть — это ваша вещь: «(.*)»(?:\s*\([^)]*\))?$/;
function stripItemWrapper(str) {
  if (!str) return str;
  var m = ITEM_WRAPPER_RE.exec(str.trim());
  return m ? m[1] : str;
}

/* В визарде (online-stylist.html) только ОДИН слой — реальная вещь
   пользователя (js/wizard.js оборачивает её в "Уже есть — это ваша вещь:
   «...»", см. ITEM_WRAPPER_RE выше), а остальные 4-5 слоёв — статичный
   шаблон повода ("Юбка-карандаш длины миди", "Туфли на каблуке" и т.п.),
   никак не связанный с реальной вещью. При равной обрезке (было — все слои
   по 50 символов) шаблонные слои численно перевешивали реальную вещь, и
   YandexART рисовал образ по шаблону повода (например «вечер» — приталенное
   платье/юбка-карандаш), а не по реальной вещи с фото — пользователь прислал
   пример: клетчатая рубашка с котом на кармане → картинка чёрно-белого
   платья, ничего общего. Даём реальной вещи больше символов и явный
   приоритет первой фразой промпта; в "Образе по фото" (api/compose-look.js)
   этот путь не задействуется — там ни один слой не обёрнут в ITEM_WRAPPER_RE
   (все слои одинаково реальные, из фото), и функция ведёт себя как раньше. */
var REAL_ITEM_MAX = 90;
var TEMPLATE_LAYER_MAX_WITH_ITEM = 36;
var TEMPLATE_LAYER_MAX_ALONE = 50;

/* Собирает промпт для картинки образа по слоям (порядок значения не важен —
   каждый слой уже готовая фраза). skipKeys — слои, не влияющие на внешний вид
   картинки (Причёска/Макияж/Уход подписываются текстом отдельно, но не
   рисуются заново на иллюстрации в полный рост, чтобы не путать модель).

   Каждый слой и fit урезаются ЗАРАНЕЕ (а не полагаемся на слепую обрезку
   всего промпта по PROMPT_MAX_LENGTH в конце) — иначе при длинном описании
   слоя (например, вставленное GigaChat-описание вещи из другого экрана)
   обрезка на границе лимита могла бы съесть инструкцию про телосложение или
   "без текста на картинке" в конце промпта, а не сам длинный слой. */
function buildLookImagePrompt(layers, fit, skipKeys, gender) {
  var skip = skipKeys || ['Причёска', 'Макияж', 'Уход'];
  var realItem = null;
  var rest = [];
  Object.keys(layers || {}).forEach(function (k) {
    if (skip.indexOf(k) !== -1) return;
    var raw = layers[k];
    var stripped = stripItemWrapper(raw);
    if (!stripped) return;
    if (ITEM_WRAPPER_RE.test(String(raw || '').trim())) {
      if (!realItem) realItem = stripped; // «Низ» дублирует «Верх» для платья — не повторять дважды
    } else {
      rest.push(stripped);
    }
  });

  /* Телосложение — глобальный признак всей картинки, а не детали кроя, ставим
     его В НАЧАЛЕ промпта сразу после формата кадра: генеративные модели
     заметнее следуют указаниям ближе к началу текста, а тег "не худая
     модель" в самом конце (как было раньше) слишком легко перевешивается
     общим fashion-lookbook стилем, который по умолчанию тяготеет к типовой
     стройной модели. */
  var bodyPhrase = fit ? sizeToBodyPhrase(extractClothingSize(fit)) : null;
  /* Без явного указания пола YandexART почти всегда рисует женщину — и это
     ломает мужские образы (визард для "мужа"/"сына", "Образ по фото" с
     мужчиной на снимке). Проговариваем пол явно в обоих направлениях, а не
     только для male, чтобы не полагаться на дефолт модели. */
  var genderPhrase = gender === 'male' ? 'Модель на фото — МУЖЧИНА, мужская фигура и мужская подача образа.'
    : gender === 'female' ? 'Модель на фото — женщина.'
    : '';
  var FULL_LENGTH = 'Fashion-лукбук, строго в полный рост: от макушки до обуви, ничего не обрезано кадром' +
    (genderPhrase ? '. ' + genderPhrase : '') +
    (bodyPhrase ? '. ОБЯЗАТЕЛЬНО: у модели ' + bodyPhrase + ', это не стройная модель, крупное телосложение должно быть чётко видно' : '');
  var prompt;
  if (realItem) {
    prompt = FULL_LENGTH + '. Главная вещь на картинке, нарисуй именно её: ' +
      truncate(realItem, REAL_ITEM_MAX) + '.';
    if (rest.length) {
      prompt += ' Остальной образ вокруг неё: ' +
        rest.map(function (s) { return truncate(s, TEMPLATE_LAYER_MAX_WITH_ITEM); }).join(', ') + '.';
    }
  } else {
    var parts = rest.map(function (s) { return truncate(s, TEMPLATE_LAYER_MAX_ALONE); });
    prompt = FULL_LENGTH + ': ' + parts.join(', ') + '.';
  }

  /* YandexART регулярно рисует куртку/жакет как безрукавку/жилет, даже когда
     текст слоя однозначно называет её курткой (проверено: GigaChat пишет
     "куртка джинсовая" правильно, картинка всё равно без рукавов) — модель,
     видимо, тянет короткую длину "ниже талии/оверсайз" в сторону жилета.
     Явно и отдельно проговариваем длину рукава, только когда это реально
     нужно (не раздуваем промпт на каждый образ). */
  var outerLayer = (layers && layers['Верхняя одежда']) || '';
  if (/куртк|жакет|пиджак|кардиган/i.test(outerLayer) && !/жилет|безрукав/i.test(outerLayer)) {
    prompt += ' Куртка/жакет — обязательно с длинными рукавами, не жилет и не безрукавка.';
  }

  if (fit) {
    prompt += ' Размер: «' + truncate(fit, 30) + '».';
  }
  prompt += ' Без текста на картинке.';
  return prompt;
}

module.exports = {
  generateLookImage: generateLookImage,
  buildLookImagePrompt: buildLookImagePrompt
};
