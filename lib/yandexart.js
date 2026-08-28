/* ============================================================================
   Клиент YandexART (Yandex Cloud) — генерация ОДНОЙ иллюстративной картинки
   на весь образ по текстовому описанию слоёв. Пришли сюда вместо Kandinsky/
   FusionBrain — сайт fusionbrain.ai был недоступен на момент подключения
   (503/502 у самого сервиса), YandexART работает так же (генерация картинки
   по тексту) и тоже оплачивается российской картой через Yandex Cloud.

   Генерация асинхронная: сначала POST запускает операцию, потом нужно
   опрашивать её статус, пока не появится готовая картинка.

   Нужны три значения в переменных окружения (Vercel → Settings → Environment Variables):
     YANDEX_API_KEY     — API-ключ сервисного аккаунта (роль yc.ai.imageGeneration.execute)
     YANDEX_FOLDER_ID    — ID каталога в Yandex Cloud (видно в адресной строке консоли)
   ============================================================================ */

const https = require('https');

const API_HOST = 'llm.api.cloud.yandex.net';
const OPERATION_HOST = 'operation.api.cloud.yandex.net';

/* Реальный лимит YandexART — 500 символов на текст промпта (проверено по
   ответу API: "Prompt positive size 702 exceeds limit (500)"). Раньше здесь
   стояло 900 — "с запасом", но не по факту — из-за этого промпты с длинным
   описанием слоя (например, вставленное GigaChat-описание вещи) превышали
   лимит и генерация тихо падала (400, не показывалось никакой картинки).
   460, а не ровно 500 — небольшой запас на случай, если код обрежет
   что-то ровно на границе символа UTF-16 суррогатной пары. */
const PROMPT_MAX_LENGTH = 460;

function httpsJson(hostname, method, requestPath, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port: 443, path: requestPath, method, headers, timeout: 20000 },
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

function runGeneration(prompt, opts) {
  opts = opts || {};
  var folderId = process.env.YANDEX_FOLDER_ID;
  var payload = JSON.stringify({
    modelUri: 'art://' + folderId + '/yandex-art/latest',
    messages: [{ text: prompt.slice(0, PROMPT_MAX_LENGTH), weight: 1 }],
    generationOptions: {
      mimeType: 'image/jpeg',
      aspectRatio: { widthRatio: opts.widthRatio || 1, heightRatio: opts.heightRatio || 1 }
    }
  });
  var headers = {
    'Authorization': 'Api-Key ' + process.env.YANDEX_API_KEY,
    'x-folder-id': folderId,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  return httpsJson(API_HOST, 'POST', '/foundationModels/v1/imageGenerationAsync', headers, payload)
    .then(function (res) {
      if (res.status !== 200 || !res.body.id) {
        throw new Error('YandexART: запуск генерации не удался: ' + res.status + ' ' + JSON.stringify(res.body));
      }
      return res.body.id;
    });
}

function checkOperation(operationId) {
  return httpsJson(OPERATION_HOST, 'GET', '/operations/' + operationId, {
    'Authorization': 'Api-Key ' + process.env.YANDEX_API_KEY
  }).then(function (res) {
    if (res.status !== 200) {
      throw new Error('YandexART: проверка операции не удалась: ' + res.status + ' ' + JSON.stringify(res.body));
    }
    return res.body;
  });
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

/* Опрашивает операцию, пока не done — обычно занимает несколько секунд, максимум
   до 30 (15 попыток × 2с). Укладывается в лимит функции даже на Vercel Hobby —
   с включённым Fluid Compute там 300с и по умолчанию, и максимум (проверено
   2026-08-26 в дашборде проекта и в актуальной документации Vercel). */
async function waitForResult(operationId, maxAttempts) {
  maxAttempts = maxAttempts || 15;
  for (var i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    var op = await checkOperation(operationId);
    if (op.done) {
      if (op.error) throw new Error('YandexART: ошибка генерации: ' + JSON.stringify(op.error));
      var image = op.response && op.response.image;
      if (!image) throw new Error('YandexART: операция завершена без картинки');
      return image; // base64 jpeg, без префикса data:
    }
  }
  throw new Error('YandexART: не дождались результата генерации');
}

/* Возвращает base64 JPEG (без data:-префикса) готовой картинки образа. */
async function generateLookImage(prompt, opts) {
  opts = opts || {};
  var operationId = await runGeneration(prompt, opts);
  return waitForResult(operationId, opts.maxAttempts);
}

/* Голая цифра российского размера ("размер 64") ничего не значит для модели,
   рисующей картинки — она не обучена на таблицах размеров одежды и без явных
   слов про телосложение почти всегда рисует типовую худую модель, даже если
   в промпте есть сам номер размера. Переводим размер в описательную фразу ДО
   того, как он попадёт в промпт. Пороги — стандартная российская сетка
   женской/унисекс одежды (округлённо, т.к. fit — свободный текст
   пользователя, а не строгий выбор из списка). Используется и
   api/compose-look.js (фото), и api/looks/charge.js (визард-анкета) — общее
   место, чтобы не держать логику в двух копиях. */
function sizeToBodyPhrase(size) {
  if (size === null || size <= 46) return null; // близко к типовой модельной фигуре — уточнять нечего
  if (size <= 50) return 'плотного телосложения, немного полнее среднего';
  if (size <= 54) return 'полная фигура';
  if (size <= 60) return 'крупная фигура, плюс-сайз';
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
function buildLookImagePrompt(layers, fit, skipKeys) {
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

  var prompt;
  if (realItem) {
    prompt = 'Fashion-лукбук, образ в полный рост. Главная вещь на картинке, нарисуй именно её: ' +
      truncate(realItem, REAL_ITEM_MAX) + '.';
    if (rest.length) {
      prompt += ' Остальной образ вокруг неё: ' +
        rest.map(function (s) { return truncate(s, TEMPLATE_LAYER_MAX_WITH_ITEM); }).join(', ') + '.';
    }
  } else {
    var parts = rest.map(function (s) { return truncate(s, TEMPLATE_LAYER_MAX_ALONE); });
    prompt = 'Fashion-лукбук, образ в полный рост: ' + parts.join(', ') + '.';
  }
  if (fit) {
    var shortFit = truncate(fit, 30);
    var bodyPhrase = sizeToBodyPhrase(extractClothingSize(fit));
    prompt += ' Размер: «' + shortFit + '».';
    if (bodyPhrase) {
      prompt += ' Телосложение модели — ' + bodyPhrase + ', НЕ худая модель.';
    }
  }
  prompt += ' Без текста на картинке.';
  return prompt;
}

module.exports = {
  generateLookImage: generateLookImage,
  buildLookImagePrompt: buildLookImagePrompt
};
